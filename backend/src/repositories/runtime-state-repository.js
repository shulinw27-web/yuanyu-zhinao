import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const requestedDriver = String(process.env.RUNTIME_STORE_DRIVER || 'sqlite').trim().toLowerCase();
const driver = requestedDriver === 'memory' ? 'memory' : 'sqlite';
const defaultDatabasePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../.data/runtime.db');
const databasePath = resolve(process.env.RUNTIME_SQLITE_PATH || defaultDatabasePath);
const CURRENT_SCHEMA_VERSION = 1;
const memoryRows = new Map();
let database = null;

if (driver === 'sqlite') {
  mkdirSync(dirname(databasePath), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  database = new DatabaseSync(databasePath);
  // Apply the lock wait before WAL/schema setup so concurrent process startup does not fail immediately.
  database.exec('PRAGMA busy_timeout = 5000;');
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS runtime_state (
      namespace TEXT NOT NULL,
      state_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, state_key)
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_state_namespace
      ON runtime_state(namespace, updated_at DESC);
  `);
  const schemaVersion = Number(database.prepare('PRAGMA user_version').get().user_version || 0);
  if (schemaVersion > CURRENT_SCHEMA_VERSION) throw new Error(`Runtime database schema ${schemaVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}.`);
  if (schemaVersion < 1) database.exec('PRAGMA user_version = 1');
}

const rowKey = (namespace, key) => `${namespace}\u0000${key}`;
const encode = (value) => JSON.stringify(value);
const decode = (value) => JSON.parse(value);
const now = () => new Date().toISOString();

const getRow = (namespace, key) => {
  if (driver === 'memory') return memoryRows.get(rowKey(namespace, key)) || null;
  const row = database.prepare('SELECT value_json, version, updated_at FROM runtime_state WHERE namespace = ? AND state_key = ?').get(namespace, key);
  return row ? { value: decode(row.value_json), version: row.version, updatedAt: row.updated_at } : null;
};

const putRow = (namespace, key, value, version = 1) => {
  const updatedAt = now();
  if (driver === 'memory') {
    memoryRows.set(rowKey(namespace, key), { value: clone(value), version, updatedAt });
    return;
  }
  database.prepare(`
    INSERT INTO runtime_state(namespace, state_key, value_json, version, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(namespace, state_key) DO UPDATE SET
      value_json = excluded.value_json,
      version = excluded.version,
      updated_at = excluded.updated_at
  `).run(namespace, key, encode(value), version, updatedAt);
};

export function readState(namespace, key, initialValue) {
  const row = getRow(namespace, key);
  if (row) return clone(row.value);
  if (initialValue === undefined) return null;
  const seeded = typeof initialValue === 'function' ? initialValue() : clone(initialValue);
  putRow(namespace, key, seeded, 1);
  return clone(seeded);
}

export function writeState(namespace, key, value) {
  const current = getRow(namespace, key);
  putRow(namespace, key, value, (current?.version || 0) + 1);
  return clone(value);
}

// The callback returns { value, result }. Returning { commit: false, result }
// aborts without writing. SQLite uses BEGIN IMMEDIATE so compare-and-set style
// transitions remain atomic across API processes sharing the same database.
export function mutateState(namespace, key, initialValue, callback) {
  const execute = () => {
    const row = getRow(namespace, key);
    const current = row ? clone(row.value) : (typeof initialValue === 'function' ? initialValue() : clone(initialValue));
    const outcome = callback(current, row?.version || 0) || {};
    if (outcome.commit === false) return outcome.result;
    const nextValue = Object.hasOwn(outcome, 'value') ? outcome.value : current;
    putRow(namespace, key, nextValue, (row?.version || 0) + 1);
    return Object.hasOwn(outcome, 'result') ? outcome.result : clone(nextValue);
  };

  if (driver === 'memory') return execute();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = execute();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// Atomically mutates multiple runtime rows. This is the local Demo equivalent
// of committing an aggregate and its outbox record in one database transaction.
export function mutateStates(entries, callback) {
  const normalized = entries.map((entry) => ({
    name: entry.name,
    namespace: entry.namespace,
    key: entry.key,
    initialValue: entry.initialValue
  }));
  if (!normalized.length || new Set(normalized.map((entry) => entry.name)).size !== normalized.length) {
    throw new Error('mutateStates requires uniquely named entries.');
  }

  const execute = () => {
    const rows = new Map();
    const values = {};
    const versions = {};
    normalized.forEach((entry) => {
      const row = getRow(entry.namespace, entry.key);
      rows.set(entry.name, row);
      values[entry.name] = row
        ? clone(row.value)
        : (typeof entry.initialValue === 'function' ? entry.initialValue() : clone(entry.initialValue));
      versions[entry.name] = row?.version || 0;
    });

    const outcome = callback(values, versions) || {};
    if (outcome.commit === false) return outcome.result;
    const nextValues = outcome.values || values;
    normalized.forEach((entry) => {
      if (!Object.hasOwn(nextValues, entry.name)) return;
      const row = rows.get(entry.name);
      putRow(entry.namespace, entry.key, nextValues[entry.name], (row?.version || 0) + 1);
    });
    return Object.hasOwn(outcome, 'result') ? outcome.result : clone(nextValues);
  };

  if (driver === 'memory') return execute();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = execute();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function listState(namespace) {
  if (driver === 'memory') {
    const prefix = `${namespace}\u0000`;
    return [...memoryRows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, row]) => ({ key: key.slice(prefix.length), value: clone(row.value), version: row.version, updatedAt: row.updatedAt }));
  }
  return database.prepare('SELECT state_key, value_json, version, updated_at FROM runtime_state WHERE namespace = ? ORDER BY updated_at DESC')
    .all(namespace)
    .map((row) => ({ key: row.state_key, value: decode(row.value_json), version: row.version, updatedAt: row.updated_at }));
}

export function deleteState(namespace, key) {
  if (driver === 'memory') return memoryRows.delete(rowKey(namespace, key));
  return database.prepare('DELETE FROM runtime_state WHERE namespace = ? AND state_key = ?').run(namespace, key).changes > 0;
}

export function resetRuntimeState(namespaces = []) {
  const selected = [...new Set((Array.isArray(namespaces) ? namespaces : [namespaces]).filter(Boolean))];
  if (driver === 'memory') {
    if (!selected.length) memoryRows.clear();
    else for (const key of [...memoryRows.keys()]) if (selected.some((namespace) => key.startsWith(`${namespace}\u0000`))) memoryRows.delete(key);
    return;
  }
  if (!selected.length) database.exec('DELETE FROM runtime_state');
  else {
    const statement = database.prepare('DELETE FROM runtime_state WHERE namespace = ?');
    database.exec('BEGIN IMMEDIATE');
    try {
      selected.forEach((namespace) => statement.run(namespace));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

export const getRuntimeStoreInfo = () => ({
  driver,
  persistence: driver === 'sqlite' ? 'durable_local' : 'process_memory',
  databasePath: driver === 'sqlite' ? databasePath : null,
  schemaVersion: CURRENT_SCHEMA_VERSION
});

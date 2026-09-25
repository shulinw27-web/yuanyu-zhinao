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

let createSqliteConnection = null;
if (driver === 'sqlite') {
  mkdirSync(dirname(databasePath), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  createSqliteConnection = () => {
    const connection = new DatabaseSync(databasePath);
    // Apply the lock wait before WAL/schema setup so concurrent process startup does not fail immediately.
    connection.exec('PRAGMA busy_timeout = 5000;');
    connection.exec(`
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
    const schemaVersion = Number(connection.prepare('PRAGMA user_version').get().user_version || 0);
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      connection.close();
      throw new Error(`Runtime database schema ${schemaVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}.`);
    }
    if (schemaVersion < 1) connection.exec('PRAGMA user_version = 1');
    return connection;
  };
  database = createSqliteConnection();
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

const TRANSIENT_SQLITE_ERRORCODES = new Set([5, 6, 8]); // BUSY / LOCKED / READONLY
const TRANSIENT_SQLITE_PATTERN = /SQLITE_(BUSY|LOCKED|READONLY)|database is locked|table is locked|readonly database/iu;
const MAX_TRANSACTION_ATTEMPTS = 6;

// 多进程各自打开同一个 runtime.db 时，Windows + WAL 下会偶发 SQLITE_READONLY
// （-shm 建立竞态）与 SQLITE_BUSY。这类错误是**暂时性文件锁竞争**，不是业务结论；
// 直接抛给调用方会让「今日配额已用尽」与「数据库恰好被别的进程占用」呈现成同一种失败，
// 多租户配额的结论就不再可信。实测基线：6 个并发 worker 下 12 次运行有 3 次出现
// 原始 SQLITE_READONLY（共 6 个 worker 失败）。故在事务层做**有界**重试。
//
// 安全性：失败点必定落在 BEGIN IMMEDIATE 之后、COMMIT 之前的写操作上，未提交即无副作用；
// 配额计数始终是「读-判-写」在同一个 IMMEDIATE 事务内完成，重试不会造成重复记账。
function isTransientSqliteError(error) {
  if (!error || typeof error !== 'object') return false;
  if (TRANSIENT_SQLITE_ERRORCODES.has(Number(error.errcode))) return true;
  return TRANSIENT_SQLITE_PATTERN.test(String(error.errstr || error.message || ''));
}

// 事务必须是同步的（调用方为同步契约），因此用 Atomics.wait 做同步退避。
const waitForLock = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 环境不支持时直接重试 */ } };

// SQLITE_READONLY 在 WAL 下可能让**这条连接**永久失效（-shm 被别的进程重建后映射已过期），
// 实测表现为同一个连接重试多次仍失败。因此命中该错误时先重开连接再重试，而不是原地重试。
const isReadonlyLockError = (error) => Number(error?.errcode) === 8 || /readonly database/iu.test(String(error?.errstr || error?.message || ''));
function reopenConnection() {
  if (!createSqliteConnection) return;
  try { database.close(); } catch { /* 连接可能已不可用 */ }
  database = createSqliteConnection();
}

function runTransaction(execute) {
  if (driver === 'memory') return execute();
  for (let attempt = 1; ; attempt += 1) {
    const retriable = (error) => isTransientSqliteError(error) && attempt < MAX_TRANSACTION_ATTEMPTS;
    try {
      database.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if (!retriable(error)) throw error;
      if (isReadonlyLockError(error)) reopenConnection();
      waitForLock(20 * attempt);
      continue;
    }
    try {
      const result = execute();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      // 事务可能已因该错误自动回滚；ROLLBACK 失败不应掩盖原始错误。
      try { database.exec('ROLLBACK'); } catch { /* 事务已结束 */ }
      if (!retriable(error)) throw error;
      if (isReadonlyLockError(error)) reopenConnection();
      waitForLock(20 * attempt);
    }
  }
}

/**
 * 原子修改单个运行时行。回调返回 { value, result }；返回 { commit: false, result } 表示
 * 放弃写入。SQLite 走 BEGIN IMMEDIATE，使「读-判-写」在多进程共享同一数据库时保持原子。
 */
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

  return runTransaction(execute);
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

  return runTransaction(execute);
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
    runTransaction(() => {
      const statement = database.prepare('DELETE FROM runtime_state WHERE namespace = ?');
      selected.forEach((namespace) => statement.run(namespace));
      return undefined;
    });
  }
}

export const getRuntimeStoreInfo = () => ({
  driver,
  persistence: driver === 'sqlite' ? 'durable_local' : 'process_memory',
  databasePath: driver === 'sqlite' ? databasePath : null,
  schemaVersion: CURRENT_SCHEMA_VERSION
});

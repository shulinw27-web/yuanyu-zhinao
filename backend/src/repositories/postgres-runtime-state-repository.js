const clone = (value) => value === undefined ? undefined : structuredClone(value);
const now = () => new Date().toISOString();

const validateIdentifier = (value, name, maximum) => {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${name} must contain 1-${maximum} characters.`);
  return normalized;
};

const valueOf = (initialValue) => typeof initialValue === 'function' ? initialValue() : clone(initialValue);

export class PostgresRuntimeStateRepository {
  constructor({ pool, clock = now } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('PostgreSQL runtime repository requires a pg-compatible Pool.');
    this.pool = pool;
    this.clock = clock;
    this.mutationQueues = new Map();
  }

  async initialize() {
    const result = await this.pool.query('SELECT version, name FROM platform_schema_migrations ORDER BY version');
    const latest = Number(result.rows.at(-1)?.version || 0);
    if (latest < 1) throw new Error('PostgreSQL runtime schema is not initialized. Run migrate:postgres first.');
    if (latest > 5) throw new Error(`PostgreSQL runtime schema ${latest} is newer than supported version 5.`);
    return this.getInfo();
  }

  async readState(namespace, key, initialValue) {
    const ns = validateIdentifier(namespace, 'namespace', 120);
    const stateKey = validateIdentifier(key, 'key', 240);
    const existing = await this.pool.query('SELECT value_json FROM platform_runtime_state WHERE namespace = $1 AND state_key = $2', [ns, stateKey]);
    if (existing.rowCount) return clone(existing.rows[0].value_json);
    if (initialValue === undefined) return null;
    const seeded = valueOf(initialValue);
    const inserted = await this.pool.query(`
      INSERT INTO platform_runtime_state(namespace, state_key, value_json, version, updated_at)
      VALUES ($1, $2, $3::jsonb, 1, $4)
      ON CONFLICT (namespace, state_key) DO NOTHING
      RETURNING value_json
    `, [ns, stateKey, JSON.stringify(seeded), this.clock()]);
    if (inserted.rowCount) return clone(inserted.rows[0].value_json);
    const concurrent = await this.pool.query('SELECT value_json FROM platform_runtime_state WHERE namespace = $1 AND state_key = $2', [ns, stateKey]);
    return clone(concurrent.rows[0].value_json);
  }

  async writeState(namespace, key, value) {
    const ns = validateIdentifier(namespace, 'namespace', 120);
    const stateKey = validateIdentifier(key, 'key', 240);
    const result = await this.pool.query(`
      INSERT INTO platform_runtime_state(namespace, state_key, value_json, version, updated_at)
      VALUES ($1, $2, $3::jsonb, 1, $4)
      ON CONFLICT (namespace, state_key) DO UPDATE SET
        value_json = EXCLUDED.value_json,
        version = platform_runtime_state.version + 1,
        updated_at = EXCLUDED.updated_at
      RETURNING value_json
    `, [ns, stateKey, JSON.stringify(value), this.clock()]);
    return clone(result.rows[0].value_json);
  }

  async mutateState(namespace, key, initialValue, callback) {
    if (typeof callback !== 'function') throw new TypeError('mutateState callback is required.');
    return this.#mutateEntries([{ name: 'state', namespace, key, initialValue }], async (values, versions) => {
      const outcome = await callback(values.state, versions.state) || {};
      const nextValue = Object.hasOwn(outcome, 'value') ? outcome.value : values.state;
      return outcome.commit === false
        ? { commit: false, result: outcome.result }
        : { values: { state: nextValue }, result: Object.hasOwn(outcome, 'result') ? outcome.result : clone(nextValue), hasResult: true };
    });
  }

  async mutateStates(entries, callback) {
    if (typeof callback !== 'function') throw new TypeError('mutateStates callback is required.');
    return this.#mutateEntries(entries, async (values, versions) => {
      const outcome = await callback(values, versions) || {};
      if (outcome.commit === false) return { commit: false, result: outcome.result };
      return { values: outcome.values || values, result: outcome.result, hasResult: Object.hasOwn(outcome, 'result') };
    });
  }

  async #mutateEntries(entries, callback) {
    const lockKeys = [...new Set(entries.map((entry) => `${validateIdentifier(entry.namespace, 'namespace', 120)}\u0000${validateIdentifier(entry.key, 'key', 240)}`))].sort();
    const predecessors = lockKeys.map((key) => this.mutationQueues.get(key) || Promise.resolve());
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tails = lockKeys.map((key, index) => predecessors[index].catch(() => {}).then(() => gate));
    lockKeys.forEach((key, index) => this.mutationQueues.set(key, tails[index]));
    await Promise.all(predecessors.map((pending) => pending.catch(() => {})));
    try {
      let attempt = 0;
      while (true) {
        try { return await this.#mutateEntriesLocked(entries, callback); }
        catch (error) {
          if (!['40001', '40P01'].includes(error?.code) || attempt >= 2) throw error;
          attempt += 1;
          await new Promise((resolveRetry) => setTimeout(resolveRetry, 10 * attempt));
        }
      }
    } finally {
      release();
      lockKeys.forEach((key, index) => {
        if (this.mutationQueues.get(key) === tails[index]) this.mutationQueues.delete(key);
      });
    }
  }

  async #mutateEntriesLocked(entries, callback) {
    const normalized = entries.map((entry) => ({
      name: validateIdentifier(entry.name, 'entry name', 120),
      namespace: validateIdentifier(entry.namespace, 'namespace', 120),
      key: validateIdentifier(entry.key, 'key', 240),
      initialValue: entry.initialValue
    }));
    if (!normalized.length || new Set(normalized.map((entry) => entry.name)).size !== normalized.length) throw new Error('mutateStates requires uniquely named entries.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rows = new Map();
      for (const entry of [...normalized].sort((left, right) => `${left.namespace}\u0000${left.key}`.localeCompare(`${right.namespace}\u0000${right.key}`))) {
        await client.query(`
          INSERT INTO platform_runtime_state(namespace, state_key, value_json, version, updated_at)
          VALUES ($1, $2, $3::jsonb, 0, $4)
          ON CONFLICT (namespace, state_key) DO NOTHING
        `, [entry.namespace, entry.key, JSON.stringify(valueOf(entry.initialValue)), this.clock()]);
        const locked = await client.query('SELECT value_json, version FROM platform_runtime_state WHERE namespace = $1 AND state_key = $2 FOR UPDATE', [entry.namespace, entry.key]);
        rows.set(entry.name, locked.rows[0]);
      }
      const values = Object.fromEntries(normalized.map((entry) => [entry.name, clone(rows.get(entry.name).value_json)]));
      const versions = Object.fromEntries(normalized.map((entry) => [entry.name, Number(rows.get(entry.name).version)]));
      const outcome = await callback(values, versions) || {};
      if (outcome.commit === false) {
        await client.query('ROLLBACK');
        return outcome.result;
      }
      for (const entry of normalized) {
        if (!Object.hasOwn(outcome.values || {}, entry.name)) continue;
        await client.query(`
          UPDATE platform_runtime_state
          SET value_json = $3::jsonb, version = version + 1, updated_at = $4
          WHERE namespace = $1 AND state_key = $2
        `, [entry.namespace, entry.key, JSON.stringify(outcome.values[entry.name]), this.clock()]);
      }
      await client.query('COMMIT');
      const fallback = clone(outcome.values || values);
      return outcome.hasResult ? outcome.result : fallback;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original transaction error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async listState(namespace) {
    const ns = validateIdentifier(namespace, 'namespace', 120);
    const result = await this.pool.query(`
      SELECT state_key, value_json, version, updated_at
      FROM platform_runtime_state WHERE namespace = $1
      ORDER BY updated_at DESC
    `, [ns]);
    return result.rows.map((row) => ({ key: row.state_key, value: clone(row.value_json), version: Number(row.version), updatedAt: new Date(row.updated_at).toISOString() }));
  }

  async deleteState(namespace, key) {
    const result = await this.pool.query('DELETE FROM platform_runtime_state WHERE namespace = $1 AND state_key = $2', [validateIdentifier(namespace, 'namespace', 120), validateIdentifier(key, 'key', 240)]);
    return result.rowCount > 0;
  }

  async resetRuntimeState(namespaces = []) {
    const selected = [...new Set((Array.isArray(namespaces) ? namespaces : [namespaces]).filter(Boolean).map((value) => validateIdentifier(value, 'namespace', 120)))];
    if (!selected.length) await this.pool.query('DELETE FROM platform_runtime_state');
    else await this.pool.query('DELETE FROM platform_runtime_state WHERE namespace = ANY($1::text[])', [selected]);
  }

  getInfo() {
    return { driver: 'postgres', persistence: 'durable_distributed', databasePath: null, schemaVersion: 3 };
  }

  async probe() {
    try {
      await this.pool.query('SELECT 1 AS ready');
      return { ready: true };
    } catch {
      return { ready: false };
    }
  }

  async close() { if (typeof this.pool.end === 'function') await this.pool.end(); }
}

export async function createPostgresRuntimeStateRepository({ connectionString = process.env.RUNTIME_POSTGRES_URL, pool, ...options } = {}) {
  let resolvedPool = pool;
  if (!resolvedPool) {
    if (!String(connectionString || '').trim()) throw new Error('RUNTIME_POSTGRES_URL is required.');
    const { Pool } = await import('pg');
    resolvedPool = new Pool({ connectionString, max: Number(process.env.RUNTIME_POSTGRES_POOL_MAX || 10), statement_timeout: Number(process.env.RUNTIME_POSTGRES_STATEMENT_TIMEOUT_MS || 5_000), application_name: 'healthcare-ai-runtime' });
  }
  const repository = new PostgresRuntimeStateRepository({ pool: resolvedPool, ...options });
  await repository.initialize();
  return repository;
}

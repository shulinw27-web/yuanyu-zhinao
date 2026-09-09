import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const connectionString = String(process.env.RUNTIME_POSTGRES_URL || '').trim();
const targetVersion = Number.parseInt(process.env.POSTGRES_ROLLBACK_TO_VERSION || '', 10);
if (!connectionString) throw new Error('RUNTIME_POSTGRES_URL is required.');
if (targetVersion !== 3) throw new Error('This release only supports an explicit rollback from version 4 to version 3. Set POSTGRES_ROLLBACK_TO_VERSION=3.');
const pool = new pg.Pool({ connectionString, max: 1, application_name: 'healthcare-ai-rollback' });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(7401202601)');
  const current = Number((await client.query('SELECT MAX(version) AS version FROM platform_schema_migrations')).rows[0].version || 0);
  if (current !== 4) throw new Error(`Rollback expects schema version 4, current version is ${current}.`);
  await client.query(await readFile(resolve(import.meta.dirname, '../migrations/postgres/rollback/004_production_hardening.sql'), 'utf8'));
  await client.query('DELETE FROM platform_schema_migrations WHERE version = 4');
  await client.query('COMMIT');
  process.stdout.write(`${JSON.stringify({ status: 'rolled_back', fromVersion: 4, toVersion: 3 })}\n`);
} catch (error) {
  try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
  throw error;
} finally { client.release(); await pool.end(); }

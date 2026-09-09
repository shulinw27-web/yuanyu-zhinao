import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';

const connectionString = String(process.env.RUNTIME_POSTGRES_URL || '').trim();
if (!connectionString) throw new Error('RUNTIME_POSTGRES_URL is required.');
const migrationDirectory = resolve(import.meta.dirname, '../migrations/postgres');
const migrationFiles = (await readdir(migrationDirectory)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(name)).sort();
if (!migrationFiles.length) throw new Error('No PostgreSQL migrations were found.');
const pool = new pg.Pool({ connectionString, max: 1, application_name: 'healthcare-ai-migrator' });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(7401202601)');
  for (const migrationFile of migrationFiles) {
    const sql = await readFile(resolve(migrationDirectory, migrationFile), 'utf8');
    const version = Number.parseInt(migrationFile.slice(0, 3), 10);
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query('SELECT version, name, checksum_sha256 FROM platform_schema_migrations WHERE version = $1', [version]).catch(() => ({ rowCount: 0, rows: [] }));
    if (existing.rowCount && existing.rows[0].checksum_sha256 && existing.rows[0].checksum_sha256 !== checksum) throw new Error(`Migration ${migrationFile} checksum changed after it was applied.`);
    await client.query(sql);
    await client.query('UPDATE platform_schema_migrations SET checksum_sha256 = $2 WHERE version = $1', [version, checksum]).catch((error) => {
      if (version >= 4) throw error;
    });
  }
  await client.query('COMMIT');
  const result = await client.query('SELECT version, name, applied_at FROM platform_schema_migrations ORDER BY version');
  process.stdout.write(`${JSON.stringify({ status: 'migrated', migrations: result.rows })}\n`);
} catch (error) {
  try { await client.query('ROLLBACK'); } catch { /* preserve migration failure */ }
  throw error;
} finally {
  client.release();
  await pool.end();
}

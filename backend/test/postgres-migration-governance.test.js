import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('production hardening migration defines normalized tenant tables, indexes and forced RLS', async () => {
  const sql = await readFile(resolve(import.meta.dirname, '../migrations/postgres/004_production_hardening.sql'), 'utf8');
  for (const table of ['agent_audit_export_requests', 'model_usage_ledger', 'connector_runtime_events']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /FORCE ROW LEVEL SECURITY/g);
  assert.match(sql, /current_setting\('app\.tenant_id', true\)/);
  assert.match(sql, /checksum_sha256/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA)/i);
});

test('version 4 has an explicit bounded rollback and migration verification command', async () => {
  const rollback = await readFile(resolve(import.meta.dirname, '../migrations/postgres/rollback/004_production_hardening.sql'), 'utf8');
  assert.match(rollback, /DROP TABLE IF EXISTS connector_runtime_events/);
  const backendPackage = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'));
  assert.match(backendPackage.scripts['migrate:verify'], /verify-postgres-migrations/);
  assert.match(backendPackage.scripts['rollback:postgres'], /rollback-postgres/);
});

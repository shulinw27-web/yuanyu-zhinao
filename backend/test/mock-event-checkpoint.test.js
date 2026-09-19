import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMockEventReplay } from '../../scripts/lib/mock-event-replay.mjs';
import { saveMockEventCheckpoint, loadMockEventCheckpoint } from '../../scripts/lib/mock-event-checkpoint.mjs';
const scope = { tenantId: 'synthetic-recovery', projectId: 'synthetic-project' };
const row = { tenantId: scope.tenantId, system: 'ERP', objectType: 'Order', id: 'order-one', payload: { amount: 10 } };
const deleted = { ...scope, system: row.system, objectType: row.objectType, id: row.id, eventId: 'deleted-v2', revision: 2, operation: 'delete' };
const fixture = () => { const replay = createMockEventReplay({ ...scope, records: [row] }); replay.apply([deleted]); return replay; };
async function temporary(work) {
  const directory = await mkdtemp(join(tmpdir(), 'yuanyu-checkpoint-test-'));
  const path = join(directory, 'checkpoint.json');
  try { await work(path); } finally { await unlink(path).catch(() => {}); await rmdir(directory); }
}
test('fresh Node process recovers file checkpoint with tombstones and duplicate receipts', async () => temporary(async path => {
  const replay = fixture(); await saveMockEventCheckpoint(path, replay);
  const result = spawnSync(process.execPath, ['scripts/mock-event-recovery-probe.mjs', path, scope.tenantId, scope.projectId], { windowsHide: true, timeout: 10000, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { recovered: true, synthetic: true, snapshotId: replay.snapshot().snapshotId, records: 0, tombstones: 1, duplicateReceipts: 1, unchanged: true });
  const restored = await loadMockEventCheckpoint(path, scope);
  const stale = { ...deleted, operation: 'upsert', revision: 1, eventId: 'late', record: row };
  assert.equal(restored.apply([stale])[0].status, 'stale'); assert.equal(restored.snapshot().records.length, 0);
}));
test('immutable save refuses overwrite and preserves original bytes', async () => temporary(async path => {
  await saveMockEventCheckpoint(path, fixture()); const before = await readFile(path);
  await assert.rejects(saveMockEventCheckpoint(path, fixture()), /EXISTS/); assert.deepEqual(await readFile(path), before);
}));
test('truncated, altered and oversized checkpoints are rejected without echoing contents', async () => temporary(async path => {
  await saveMockEventCheckpoint(path, fixture()); const original = JSON.parse(await readFile(path, 'utf8'));
  for (const bad of ['{"private-secret":', JSON.stringify({ ...original, payload: original.payload.replace('order-one', 'order-two') }), 'x'.repeat(2_100_001)]) {
    await writeFile(path, bad); await assert.rejects(loadMockEventCheckpoint(path, scope), { message: 'MOCK_CHECKPOINT_INVALID' });
  }
}));
test('recovery requires externally supplied matching scope and cannot run in production', async () => temporary(async path => {
  await saveMockEventCheckpoint(path, fixture());
  await assert.rejects(loadMockEventCheckpoint(path, { ...scope, tenantId: 'other' }), /SCOPE_MISMATCH/);
  await assert.rejects(loadMockEventCheckpoint(path, { ...scope, projectId: 'other' }), /SCOPE_MISMATCH/);
  await assert.rejects(loadMockEventCheckpoint(path, {}), /SCOPE_REQUIRED/);
  const result = spawnSync(process.execPath, ['scripts/mock-event-recovery-probe.mjs', path, scope.tenantId, scope.projectId], { windowsHide: true, timeout: 10000, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).code, 'MOCK_CHECKPOINT_TEST_ONLY');
}));

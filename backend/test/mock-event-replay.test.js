import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockEventReplay } from '../../scripts/lib/mock-event-replay.mjs';
const row = { tenantId: 'synthetic-a', system: 'ERP', objectType: 'Order', id: 'one', payload: { amount: 10 } };
const setup = () => createMockEventReplay({ tenantId: row.tenantId, projectId: 'project-a', records: [row] });
const event = (revision, amount = 20) => ({ tenantId: row.tenantId, projectId: 'project-a', system: row.system, objectType: row.objectType, id: row.id, eventId: `event-${revision}`, revision, operation: 'upsert', record: { ...row, payload: { amount } } });

test('mock events apply versions, ignore reordered old values and deduplicate exact deliveries', () => {
  const replay = setup();
  assert.equal(replay.apply([event(2)])[0].status, 'applied');
  const snapshot = replay.snapshot();
  assert.equal(replay.apply([event(1), event(2)])[0].status, 'stale');
  assert.deepEqual(replay.snapshot(), snapshot);
  assert.equal(replay.apply([{ ...event(2), eventId: 'another-id' }])[0].status, 'duplicate_version');
});
test('deletion tombstones survive JSON checkpoint recovery and prevent stale resurrection', () => {
  const replay = setup(); const deleted = { ...event(3), operation: 'delete' }; delete deleted.record;
  replay.apply([event(2), deleted]);
  const restored = createMockEventReplay(JSON.parse(JSON.stringify(replay.checkpoint())));
  restored.apply([event(1)]); assert.equal(restored.snapshot().records.length, 0); assert.equal(restored.snapshot().tombstones, 1);
  restored.apply([event(4)]); assert.equal(restored.snapshot().records[0].payload.amount, 20);
});
test('event id and revision conflicts roll back the entire batch', () => {
  const replay = setup(); replay.apply([event(1)]); const before = replay.checkpoint();
  assert.throws(() => replay.apply([event(2), event(1, 99)]), /ID_CONFLICT/);
  assert.deepEqual(replay.checkpoint(), before);
  assert.throws(() => replay.apply([{ ...event(1, 99), eventId: 'different' }]), /REVISION_CONFLICT/);
});
test('tenant, project and record namespace cannot be changed by an event or checkpoint', () => {
  for (const changed of [{ tenantId: 'other' }, { projectId: 'other' }, { record: { ...row, tenantId: 'other' } }, { id: 'another' }]) {
    const replay = setup(); assert.throws(() => replay.apply([{ ...event(1), ...changed }]), /EVENT_INVALID/);
    assert.equal(replay.snapshot().records[0].payload.amount, 10);
  }
  const checkpoint = setup().checkpoint(); checkpoint.tenantId = 'other';
  assert.throws(() => createMockEventReplay(checkpoint), /BASELINE_INVALID/);
});
test('snapshots, checkpoints and event inputs do not mutate captured state', () => {
  const replay = setup(); const input = event(1); replay.apply([input]); input.record.payload.amount = 999;
  replay.snapshot().records[0].payload.amount = 888; replay.checkpoint().journal.length = 0;
  assert.equal(replay.snapshot().records[0].payload.amount, 20); assert.equal(replay.checkpoint().journal.length, 1);
});
test('separate tenants with identical business ids never share mutable replay state', () => {
  const first = setup();
  const second = createMockEventReplay({ tenantId: 'synthetic-b', projectId: 'project-a', records: [{ ...row, tenantId: 'synthetic-b' }] });
  first.apply([event(1, 77)]);
  assert.equal(second.snapshot().records[0].payload.amount, 10);
  assert.notEqual(first.snapshot().snapshotId, second.snapshot().snapshotId);
  assert.throws(() => second.apply(first.checkpoint().journal), /EVENT_INVALID/);
});
test('malformed, oversized and non-test replay calls fail closed', () => {
  const replay = setup();
  for (const value of [{ ...event(1), revision: 0 }, { ...event(1), extra: true }, { ...event(1), record: { ...row, payload: [] } }]) assert.throws(() => replay.apply([value]), /EVENT_INVALID/);
  assert.throws(() => replay.apply(Array(1001).fill(event(1))), /BATCH_INVALID/);
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try { assert.throws(setup, /TEST_ONLY/); assert.throws(() => replay.snapshot(), /TEST_ONLY/); assert.throws(() => replay.apply([]), /TEST_ONLY/); }
  finally { process.env.NODE_ENV = previous; }
});
test('non-JSON values and cycles cannot silently change during checkpoint recovery', () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [NaN, Infinity, undefined, 1n, new Date(), cyclic, Array(2)]) {
    const replay = setup(); const bad = event(1); bad.record.payload.invalid = value;
    assert.throws(() => replay.apply([bad]), /BATCH_INVALID/);
    assert.equal(replay.snapshot().records[0].payload.amount, 10);
    assert.throws(() => createMockEventReplay({ tenantId: row.tenantId, projectId: 'project-a', records: [bad.record] }), /INPUT_INVALID/);
  }
});

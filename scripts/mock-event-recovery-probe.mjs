// A fresh-process test probe, never an application recovery endpoint.
import { loadMockEventCheckpoint } from './lib/mock-event-checkpoint.mjs';
try {
  const [path, tenantId, projectId] = process.argv.slice(2);
  const replay = await loadMockEventCheckpoint(path, { tenantId, projectId });
  const before = replay.snapshot();
  // Re-deliver the accepted journal to verify persisted idempotency metadata.
  const receipts = replay.apply(replay.checkpoint().journal);
  const after = replay.snapshot();
  console.log(JSON.stringify({ recovered: true, synthetic: true, snapshotId: after.snapshotId, records: after.records.length,
    tombstones: after.tombstones, duplicateReceipts: receipts.filter(item => item.status === 'duplicate').length,
    unchanged: before.snapshotId === after.snapshotId }));
} catch (error) {
  console.log(JSON.stringify({ recovered: false, code: /^MOCK_CHECKPOINT_[A-Z_]+$/.test(error.message) ? error.message : 'MOCK_CHECKPOINT_INVALID' }));
  process.exitCode = 1;
}

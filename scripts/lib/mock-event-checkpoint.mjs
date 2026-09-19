// Test artifact persistence only. A checksum detects corruption, not forgery.
import { open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createMockEventReplay } from './mock-event-replay.mjs';
const MAX_BYTES = 2_100_000;
const fail = code => { throw new Error(`MOCK_CHECKPOINT_${code}`); };
const guard = path => {
  if (process.env.NODE_ENV !== 'test') fail('TEST_ONLY');
  if (typeof path !== 'string' || !isAbsolute(path)) fail('PATH_INVALID');
};
const digest = value => createHash('sha256').update(value).digest('hex');

// Immutable destination: readers must be given a path only after this resolves.
// Interrupted writes may leave an invalid file, which readers reject, not repair.
export async function saveMockEventCheckpoint(path, replay) {
  guard(path);
  const checkpoint = replay.checkpoint();
  const validated = createMockEventReplay(checkpoint);
  const payload = JSON.stringify(validated.checkpoint());
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 'mock-event-checkpoint.v1', checksum: digest(payload), payload }));
  if (bytes.length > MAX_BYTES) fail('TOO_LARGE');
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes); await handle.sync();
  } catch (error) {
    if (handle) { await handle.close(); handle = null; await unlink(path).catch(() => {}); }
    if (error.code === 'EEXIST') fail('EXISTS');
    fail('WRITE_FAILED');
  } finally { await handle?.close(); }
  return { saved: true, synthetic: true, snapshotId: validated.snapshot().snapshotId };
}

export async function loadMockEventCheckpoint(path, { tenantId, projectId }) {
  guard(path);
  if (typeof tenantId !== 'string' || !tenantId || typeof projectId !== 'string' || !projectId) fail('SCOPE_REQUIRED');
  let handle;
  try {
    handle = await open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) fail('INVALID');
    // Bounded read also catches growth between stat and read.
    const bytes = Buffer.alloc(MAX_BYTES + 1); let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_BYTES) fail('INVALID');
    const envelope = JSON.parse(bytes.subarray(0, total).toString('utf8'));
    if (envelope?.schemaVersion !== 'mock-event-checkpoint.v1' || typeof envelope.payload !== 'string'
      || envelope.checksum !== digest(envelope.payload)) fail('INVALID');
    const checkpoint = JSON.parse(envelope.payload);
    if (checkpoint.tenantId !== tenantId || checkpoint.projectId !== projectId) fail('SCOPE_MISMATCH');
    return createMockEventReplay(checkpoint);
  } catch (error) {
    if (error.message === 'MOCK_CHECKPOINT_SCOPE_MISMATCH') throw error;
    fail('INVALID');
  } finally { await handle?.close(); }
}

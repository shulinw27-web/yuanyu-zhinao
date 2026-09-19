// Deterministic TEST harness, not a runtime authorization or production CDC API.
import { createHash } from 'node:crypto';
const fail = code => { throw new Error(`MOCK_EVENT_${code}`); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
// Checkpoint round-trips must not silently change undefined/NaN/Date values.
const jsonSafe = value => {
  const ancestors = new Set(); let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 100000 || depth > 40) return false;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    if (Reflect.ownKeys(item).some(key => typeof key !== 'string')) return false;
    ancestors.add(item);
    const valid = Array.isArray(item)
      ? Object.keys(item).length === item.length && Array.from(item).every(child => visit(child, depth + 1))
      : Object.values(item).every(child => visit(child, depth + 1));
    ancestors.delete(item); return valid;
  };
  return visit(value, 0);
};
const canonical = value => JSON.stringify(value, function (_key, item) {
  return plain(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
const guard = () => { if (process.env.NODE_ENV !== 'test') fail('TEST_ONLY'); };
const keyOf = row => JSON.stringify([row.system, row.objectType, row.id]);
const validRow = (row, tenantId) => plain(row) && text(row.id) && text(row.system) && text(row.objectType)
  && row.tenantId === tenantId && plain(row.payload);

export function createMockEventReplay({ tenantId, projectId, records, journal = [] }) {
  guard();
  if (!text(tenantId) || !text(projectId) || !Array.isArray(records) || records.length > 500
    || !Array.isArray(journal) || journal.length > 1000 || !jsonSafe({ records, journal }) || Buffer.byteLength(canonical({ records, journal })) > 2_000_000) fail('INPUT_INVALID');
  const initial = structuredClone(records);
  let state = new Map(); let seen = new Map(); let accepted = [];
  for (const row of initial) {
    if (!validRow(row, tenantId) || state.has(keyOf(row))) fail('BASELINE_INVALID');
    state.set(keyOf(row), { revision: 0, record: row });
  }
  function apply(events) {
    guard();
    if (!Array.isArray(events) || events.length > 1000 || !jsonSafe(events) || Buffer.byteLength(canonical(events)) > 2_000_000) fail('BATCH_INVALID');
    // Stage everything: a later conflict must not partially advance the batch.
    const next = new Map(state); const receipts = new Map(seen); const history = [...accepted]; const results = [];
    for (const event of events) {
      if (!plain(event) || Object.keys(event).some(key => !['eventId', 'tenantId', 'projectId', 'system', 'objectType', 'id', 'revision', 'operation', 'record'].includes(key))
        || !text(event.eventId) || event.tenantId !== tenantId || event.projectId !== projectId
        || !text(event.system) || !text(event.objectType) || !text(event.id)
        || !Number.isSafeInteger(event.revision) || event.revision < 1 || !['upsert', 'delete'].includes(event.operation)
        || (event.operation === 'delete' ? event.record !== undefined : !validRow(event.record, tenantId) || keyOf(event.record) !== keyOf(event))) fail('EVENT_INVALID');
      const signature = canonical(event); const existing = receipts.get(event.eventId);
      if (existing) {
        if (existing !== signature) fail('ID_CONFLICT');
        results.push({ eventId: event.eventId, status: 'duplicate' }); continue;
      }
      const key = keyOf(event); const previous = next.get(key);
      const content = event.operation === 'delete' ? null : structuredClone(event.record);
      if (previous?.revision === event.revision && canonical(previous.record) !== canonical(content)) fail('REVISION_CONFLICT');
      const status = previous?.revision > event.revision ? 'stale' : previous?.revision === event.revision ? 'duplicate_version' : 'applied';
      if (status === 'applied') next.set(key, { revision: event.revision, record: content });
      receipts.set(event.eventId, signature); history.push(structuredClone(event)); results.push({ eventId: event.eventId, status });
    }
    if (next.size > 500 || history.length > 1000 || Buffer.byteLength(canonical({ records: initial, journal: history })) > 2_000_000) fail('CAPACITY');
    state = next; seen = receipts; accepted = history;
    return results;
  }
  function snapshot() {
    guard();
    const entries = [...state.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return { tenantId, projectId, synthetic: true,
      snapshotId: `synthetic-events-${createHash('sha256').update(canonical({ tenantId, projectId, entries })).digest('hex')}`,
      records: structuredClone(entries.filter(([, item]) => item.record !== null).map(([, item]) => item.record)),
      tombstones: entries.filter(([, item]) => item.record === null).length };
  }
  apply(journal);
  return Object.freeze({ apply, snapshot, checkpoint() { guard(); return structuredClone({ tenantId, projectId, records: initial, journal: accepted }); } });
}

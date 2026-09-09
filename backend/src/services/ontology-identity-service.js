import { admitSemanticRecord } from './semantic-record-contract-service.js';

const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const refValid = ref => ref && text(ref.id) && text(ref.objectType) && text(ref.system);
const key = ref => JSON.stringify([ref.system, ref.objectType, ref.id]);
const canonicalKey = ref => JSON.stringify([ref.objectType, ref.id]);
export const identityOutcomes = ['same_entity', 'different_entity', 'unresolved', 'conflict', 'needs_review'];
export const identitySampleShapeValid = sample => Boolean(sample && time(sample.at) && time(sample.knownAt) && Date.parse(sample.at) <= Date.parse(sample.knownAt)
  && refValid(sample.query?.left) && refValid(sample.query?.right) && Array.isArray(sample.records) && sample.records.length > 0 && sample.records.length <= 200
  && Array.isArray(sample.mappings) && sample.mappings.length <= 500);
export const identitySampleAccessible = (sample, roleId, identityScope) => identitySampleShapeValid(sample)
  && [...sample.records, ...sample.mappings].every(row => admitSemanticRecord(row, roleId, identityScope, true));

// Explicit crosswalk verification only. No name similarity, inferred merge, or identity writeback.
export function evaluateIdentityMapping({ draft, sample, roleId, identityScope }) {
  const reject = code => ({ status: 'rejected', code, effects: [], executionStatus: 'not_requested' });
  if (!identitySampleShapeValid(sample)) return reject('IDENTITY_SAMPLE_INVALID');
  if (!identitySampleAccessible(sample, roleId, identityScope)) return reject('IDENTITY_SCOPE_INVALID');
  const objects = new Map((draft?.objectTypes || []).map(object => [object.id, object]));
  const records = new Map(); const histories = new Map(); const versions = new Set();
  for (const row of sample.records) {
    if (!refValid(row) || !objects.get(row.objectType)?.sourceSystems?.includes(row.system) || records.has(key(row))) return reject('IDENTITY_SOURCE_INVALID');
    records.set(key(row), row);
  }
  if (![sample.query.left, sample.query.right].every(ref => records.has(key(ref)))) return reject('IDENTITY_SOURCE_MISSING');
  for (const row of sample.mappings) {
    if (!text(row.id) || !text(row.version) || !refValid(row.source) || !text(row.canonical?.id) || !text(row.canonical?.objectType)
      || !time(row.validFrom) || !time(row.recordedAt) || (row.validTo != null && !time(row.validTo))
      || (row.validTo && Date.parse(row.validTo) <= Date.parse(row.validFrom)) || Date.parse(row.occurredAt) > Date.parse(row.recordedAt)
      || !['confirmed', 'observed', 'inferred', 'declared'].includes(row.provenanceType) || (row.retracted !== undefined && typeof row.retracted !== 'boolean')
      || !Array.isArray(row.evidenceIds) || !row.evidenceIds.length || row.evidenceIds.length > 30 || !row.evidenceIds.every(text)) return reject('IDENTITY_MAPPING_INVALID');
    const sourceRecord = records.get(key(row.source)); const object = objects.get(row.source.objectType);
    if (!sourceRecord || row.system !== row.source.system || row.organizationId !== sourceRecord.organizationId) return reject('IDENTITY_SOURCE_INVALID');
    if (row.canonical.objectType !== row.source.objectType || !object?.granularity || object.granularity === 'unspecified' || row.granularity !== object.granularity) return reject('IDENTITY_GRANULARITY_MISMATCH');
    const identity = JSON.stringify([row.system, row.id]); const versionKey = JSON.stringify([identity, row.version]);
    if (versions.has(versionKey)) return reject('IDENTITY_DUPLICATE_VERSION');
    versions.add(versionKey);
    const history = histories.get(identity) || [];
    if (history.length && (key(history[0].source) !== key(row.source) || canonicalKey(history[0].canonical) !== canonicalKey(row.canonical)
      || history[0].organizationId !== row.organizationId)) return reject('IDENTITY_REASSIGNMENT_REQUIRES_NEW_ASSERTION');
    history.push(row); histories.set(identity, history);
  }
  const known = Date.parse(sample.knownAt); const at = Date.parse(sample.at);
  const selected = new Map(); const ties = new Set();
  for (const history of histories.values()) {
    const visible = history.filter(row => Date.parse(row.recordedAt) <= known).sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
    if (!visible.length) continue;
    const row = visible[0]; const sourceKey = key(row.source);
    if (visible[1] && Date.parse(visible[1].recordedAt) === Date.parse(row.recordedAt)) { ties.add(sourceKey); continue; }
    if (!row.retracted && Date.parse(row.validFrom) <= at && (!row.validTo || at < Date.parse(row.validTo))) selected.set(sourceKey, [...(selected.get(sourceKey) || []), row]);
  }
  const resolve = ref => {
    const rows = selected.get(key(ref)) || [];
    if (ties.has(key(ref)) || new Set(rows.map(row => canonicalKey(row.canonical))).size > 1) return { status: 'conflict', count: rows.length };
    if (Date.parse(records.get(key(ref)).occurredAt) > known) return { status: 'needs_review', count: rows.length };
    if (!rows.length) return { status: 'unresolved', count: 0 };
    if (rows.some(row => row.provenanceType !== 'confirmed')) return { status: 'needs_review', count: rows.length };
    return { status: 'resolved', canonical: canonicalKey(rows[0].canonical), count: rows.length };
  };
  const left = resolve(sample.query.left); const right = resolve(sample.query.right);
  const states = [left.status, right.status];
  const outcome = states.includes('conflict') ? 'conflict' : states.includes('needs_review') ? 'needs_review' : states.includes('unresolved') ? 'unresolved'
    : left.canonical === right.canonical ? 'same_entity' : 'different_entity';
  return { status: 'evaluated', outcome, effects: [], executionStatus: 'not_requested', coverage: 'provided_crosswalk_only', verifiesLiveSystems: false,
    identity: { validAt: sample.at, knownAt: sample.knownAt, leftStatus: left.status, rightStatus: right.status, activeMappings: [...new Set([key(sample.query.left), key(sample.query.right)])].reduce((count, source) => count + (selected.get(source)?.length || 0), 0),
      authority: 'caller_supplied_confirmation_not_external_verification', writeback: 'not_requested' } };
}

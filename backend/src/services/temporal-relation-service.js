import { admitSemanticRecord } from './semantic-record-contract-service.js';

const text = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
const instant = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const refValid = (value) => value && text(value.objectType) && text(value.id);
const key = (ref) => JSON.stringify([ref.objectType, ref.id]);
const same = (a, b) => key(a) === key(b);
const signature = (edge) => JSON.stringify([key(edge.from), edge.predicate, key(edge.to)]);
export const temporalOutcomes = ['related', 'not_related', 'conflict', 'needs_review'];

export function temporalSampleShapeValid(sample) {
  return Boolean(sample && instant(sample.at) && instant(sample.knownAt) && Date.parse(sample.at) <= Date.parse(sample.knownAt)
    && refValid(sample.query?.from) && refValid(sample.query?.to) && text(sample.query?.predicate)
    && Array.isArray(sample.records) && sample.records.length > 0 && sample.records.length <= 200
    && Array.isArray(sample.relations) && sample.relations.length <= 500);
}

export function temporalSampleAccessible(sample, roleId, identityScope) {
  return temporalSampleShapeValid(sample) && [...sample.records, ...sample.relations].every(record => admitSemanticRecord(record, roleId, identityScope, true));
}

// Bounded, caller-supplied history. This never asserts complete enterprise history or writes facts.
export function evaluateTemporalRelations({ draft, sample, roleId, identityScope }) {
  const reject = (code) => ({ status: 'rejected', code, effects: [], executionStatus: 'not_requested' });
  if (!temporalSampleShapeValid(sample)) return reject('RELATION_SAMPLE_INVALID');
  if (!temporalSampleAccessible(sample, roleId, identityScope)) return reject('RELATION_SCOPE_INVALID');
  const known = Date.parse(sample.knownAt); const valid = Date.parse(sample.at);
  const objects = new Map((draft?.objectTypes || []).map(object => [object.id, object]));
  const records = new Map();
  for (const record of sample.records) {
    const object = objects.get(record.objectType);
    if (!refValid(record) || !object || !object.sourceSystems?.includes(record.system) || records.has(key(record))) return reject('RELATION_ENDPOINT_INVALID');
    records.set(key(record), record);
  }
  if (![sample.query.from, sample.query.to].every(ref => records.has(key(ref)))) return reject('RELATION_ENDPOINT_MISSING');
  const contracts = (draft.relationshipTypes || []).filter(edge => edge.from === sample.query.from.objectType && edge.to === sample.query.to.objectType && edge.predicate === sample.query.predicate);
  if (contracts.length !== 1) return reject('RELATION_CONTRACT_MISSING_OR_AMBIGUOUS');
  const contract = contracts[0];
  if (!['1:1', '1:n', 'n:1', 'n:n'].includes(contract.cardinality)) return reject('RELATION_CARDINALITY_INVALID');
  const versions = new Set(); const histories = new Map();
  for (const row of sample.relations) {
    if (!text(row.id) || !text(row.version) || !refValid(row.from) || !refValid(row.to) || !text(row.predicate)
      || !instant(row.recordedAt) || !instant(row.validFrom) || (row.validTo !== null && row.validTo !== undefined && !instant(row.validTo))
      || (row.validTo && Date.parse(row.validTo) <= Date.parse(row.validFrom))
      || Date.parse(row.occurredAt) > Date.parse(row.recordedAt)
      || !['observed', 'confirmed', 'inferred', 'declared'].includes(row.provenanceType)
      || (row.retracted !== undefined && typeof row.retracted !== 'boolean')
      || !Array.isArray(row.evidenceIds) || !row.evidenceIds.length || row.evidenceIds.length > 30 || !row.evidenceIds.every(text)) return reject('RELATION_REVISION_INVALID');
    if (![row.from, row.to].every(ref => records.has(key(ref))) || !objects.get(row.from.objectType)?.sourceSystems?.includes(row.system)) return reject('RELATION_ENDPOINT_INVALID');
    if (!(draft.relationshipTypes || []).some(edge => edge.from === row.from.objectType && edge.to === row.to.objectType && edge.predicate === row.predicate)) return reject('RELATION_CONTRACT_MISSING_OR_AMBIGUOUS');
    const identity = JSON.stringify([row.system, row.id]); const versionKey = JSON.stringify([identity, row.version]);
    if (versions.has(versionKey)) return reject('RELATION_DUPLICATE_VERSION');
    versions.add(versionKey);
    const history = histories.get(identity) || [];
    // Corrections update validity/provenance, not the identity or permission domain of an assertion.
    if (history.length && (signature(history[0]) !== signature(row) || history[0].organizationId !== row.organizationId)) return reject('RELATION_REVISION_IDENTITY_CHANGED');
    history.push(row); histories.set(identity, history);
  }
  const family = row => row.from.objectType === contract.from && row.to.objectType === contract.to && row.predicate === contract.predicate;
  const latest = []; let tied = false;
  for (const history of histories.values()) {
    const visible = history.filter(row => Date.parse(row.recordedAt) <= known).sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
    if (!visible.length || !family(visible[0])) continue;
    if (visible[1] && Date.parse(visible[0].recordedAt) === Date.parse(visible[1].recordedAt)) tied = true;
    else latest.push(visible[0]);
  }
  const active = latest.filter(row => !row.retracted && Date.parse(row.validFrom) <= valid && (!row.validTo || valid < Date.parse(row.validTo)));
  const inContractWindow = (!contract.validFrom || Date.parse(contract.validFrom) <= valid) && (!contract.validTo || valid < Date.parse(contract.validTo));
  const conflict = (side) => {
    const groups = new Map();
    for (const row of active) { const k = key(row[side]); const values = groups.get(k) || new Set(); values.add(key(row[side === 'from' ? 'to' : 'from'])); groups.set(k, values); }
    return [...groups.values()].some(values => values.size > 1);
  };
  const cardinalityConflict = (['1:1', 'n:1'].includes(contract.cardinality) && conflict('from')) || (['1:1', '1:n'].includes(contract.cardinality) && conflict('to'));
  const matched = active.filter(row => same(row.from, sample.query.from) && same(row.to, sample.query.to));
  const endpointsKnown = [sample.query.from, sample.query.to].every(ref => Date.parse(records.get(key(ref)).occurredAt) <= known);
  const outcome = tied || cardinalityConflict ? 'conflict' : !inContractWindow || !endpointsKnown ? 'needs_review'
    : matched.some(row => ['inferred', 'declared'].includes(row.provenanceType)) ? 'needs_review' : matched.length ? 'related' : 'not_related';
  return { status: 'evaluated', outcome, effects: [], executionStatus: 'not_requested', coverage: 'provided_history_only', verifiesLiveSystems: false,
    temporal: { validAt: sample.at, knownAt: sample.knownAt, visibleRevisions: latest.length, activeRelations: active.length, matchedRelations: matched.length,
      conflict: tied ? 'revision_time_tie' : cardinalityConflict ? 'cardinality' : null,
      reason: !endpointsKnown ? 'endpoint_not_known' : !inContractWindow ? 'outside_model_validity' : null } };
}

import { createHash } from 'node:crypto';
import { evaluateBusinessDecision, validateDecisionParameters, getBusinessDecisionDefinition } from './business-decision-service.js';
import { admitSemanticRecord } from './semantic-record-contract-service.js';
import { evaluateTemporalRelations, temporalOutcomes, temporalSampleAccessible, temporalSampleShapeValid } from './temporal-relation-service.js';
import { evaluateIdentityMapping, identityOutcomes, identitySampleAccessible, identitySampleShapeValid } from './ontology-identity-service.js';

const safeField = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const mappingFields = definition => definition.inputFields.filter(field => field !== 'evidenceIds');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function validValueMappings(mappings, definition) {
  if (mappings === undefined) return true;
  return Boolean(plain(mappings) && Object.entries(mappings).every(([field, entries]) => Object.hasOwn(definition.valueMappingTargets, field)
    && Array.isArray(entries) && entries.length > 0 && entries.length <= 100
    && entries.every(entry => plain(entry) && Object.keys(entry).length === 2 && typeof entry.from === 'string' && entry.from.length > 0 && entry.from.length <= 100
      && definition.valueMappingTargets[field].includes(entry.to)) && new Set(entries.map(entry => entry.from)).size === entries.length));
}
export const bindingFingerprint = (binding) => createHash('sha256').update(JSON.stringify(binding)).digest('hex').slice(0, 24);
export function validateDecisionBinding(binding, object) {
  const definition = getBusinessDecisionDefinition(binding?.capabilityId);
  if (!definition || binding.version !== definition.version || !object || !validateDecisionParameters(binding.parameters, binding.capabilityId) || !validValueMappings(binding.valueMappings, definition)) return false;
  const fields = mappingFields(definition);
  if (binding.inputMapping === undefined) return true; // Legacy declaration-only bindings remain editable.
  return Boolean(binding.inputMapping && typeof binding.inputMapping === 'object' && !Array.isArray(binding.inputMapping)
    && Object.keys(binding.inputMapping).length === fields.length
    && fields.every((field) => Object.hasOwn(binding.inputMapping, field) && safeField(binding.inputMapping[field]) && object.fields?.includes(binding.inputMapping[field])));
}

// Supplied records are only evidence for read-only evaluation; never an execution grant.
export function evaluateBoundDecision({ binding, object, record, roleId, identityScope, at = new Date().toISOString() }) {
  const reject = (code) => ({ status: 'rejected', code, effects: [], executionStatus: 'not_requested' });
  if (!validateDecisionBinding(binding, object) || !binding.inputMapping) return reject('DECISION_BINDING_NOT_EXECUTABLE');
  if (!admitSemanticRecord(record, roleId, identityScope, true)) return reject('DECISION_RECORD_NOT_ACCESSIBLE');
  if (record.objectType !== object.id || !object.sourceSystems?.includes(String(record.system || '').toUpperCase())) return reject('DECISION_SOURCE_MISMATCH');
  const instant = Date.parse(at); const observed = Date.parse(record.occurredAt);
  if (!Number.isFinite(instant) || observed > instant) return reject('DECISION_TIME_INVALID');
  const input = Object.fromEntries(mappingFields(getBusinessDecisionDefinition(binding.capabilityId)).map((field) => [field, record.payload && Object.hasOwn(record.payload, binding.inputMapping[field]) ? record.payload[binding.inputMapping[field]] : undefined]));
  let conversionMiss = false;
  for (const [field, entries] of Object.entries(binding.valueMappings || {})) {
    const entry = entries.find(item => item.from === input[field]);
    if (!entry) conversionMiss = true;
    input[field] = entry?.to;
  }
  input.evidenceIds = [record.id]; input.sourceMode = record.sourceMode === 'mock' ? 'mock' : 'governed_input';
  const stale = instant - observed > (binding.parameters?.maxEvidenceAgeMinutes || 60) * 60000;
  if (stale) input.evidenceIds = [];
  const result = evaluateBusinessDecision(binding.capabilityId, input, binding.parameters);
  return { ...result, status: 'evaluated', stale, conversionMiss, ...(conversionMiss ? { reason: '来源值没有显式转换项，不能猜测含义；请补充映射并重新回放。' } : {}), ...(stale ? { reason: '证据超过模型配置的新鲜度窗口，需重新取证或人工复核。' } : {}),
    bindingFingerprint: bindingFingerprint(binding), sourceVersion: record.version, evaluatedAt: new Date(instant).toISOString(),
    sourceAuthority: 'caller_supplied_scoped_record_not_live_verification' };
}

export function replayDecisionCases({ candidate, baseline = null, cases, roleId, identityScope }) {
  const reject = (code) => ({ status: 'failed', code, cases: [], effects: [] });
  if (!Array.isArray(cases) || !cases.length || cases.length > 100 || cases.some((item) => !item || typeof item.id !== 'string' || !item.id.trim()
    || (item.kind === 'identity_mapping' ? !identitySampleShapeValid(item) || !identityOutcomes.includes(item.expected)
      : item.kind === 'relation_history' ? !temporalSampleShapeValid(item) || !temporalOutcomes.includes(item.expected)
      : (item.kind !== undefined && item.kind !== 'decision') || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)) || typeof item.objectType !== 'string'
        || (item.capabilityId !== undefined && !getBusinessDecisionDefinition(item.capabilityId))
        || !['needs_review', 'closed', 'in_progress', 'investigation_recommended', 'review_recommended', 'sufficient_snapshot', 'insufficient_snapshot', 'inventory_blocked'].includes(item.expected)))) return reject('REPLAY_CASES_INVALID');
  if (new Set(cases.map((item) => item.id)).size !== cases.length) return reject('REPLAY_CASES_INVALID');
  if (cases.some((item) => item.kind === 'identity_mapping' ? !identitySampleAccessible(item, roleId, identityScope)
    : item.kind === 'relation_history' ? !temporalSampleAccessible(item, roleId, identityScope) : !admitSemanticRecord(item.record, roleId, identityScope, true))) return reject('REPLAY_SCOPE_INVALID');
  const run = (draft, item) => {
    if (item.kind === 'identity_mapping') return evaluateIdentityMapping({ draft, sample: item, roleId, identityScope });
    if (item.kind === 'relation_history') return evaluateTemporalRelations({ draft, sample: item, roleId, identityScope });
    const bindings = draft?.scenario?.decisionBindings?.filter((binding) => binding.objectType === item.objectType && (!item.capabilityId || binding.capabilityId === item.capabilityId)) || [];
    if (bindings.length !== 1) return { status: 'rejected', code: 'REPLAY_BINDING_AMBIGUOUS_OR_MISSING' };
    return evaluateBoundDecision({ binding: bindings[0], object: draft.objectTypes.find((object) => object.id === item.objectType), record: item.record, roleId, identityScope, at: item.at });
  };
  const results = cases.map((item) => {
    const result = run(candidate, item); const previous = baseline ? run(baseline, item) : null;
    return { id: item.id, expected: item.expected, actual: result.outcome || result.code, passed: result.status === 'evaluated' && result.outcome === item.expected,
      baseline: previous?.outcome || previous?.code || null, changed: previous ? result.outcome !== previous.outcome || result.code !== previous.code : null,
      bindingFingerprint: result.bindingFingerprint || null, sourceVersion: result.sourceVersion || null, stale: result.stale || false,
      ...(item.kind === 'identity_mapping' ? { kind: item.kind, identity: result.identity || null, baselineIdentity: previous?.identity || null } : {}),
      ...(item.kind === 'relation_history' ? { kind: item.kind, temporal: result.temporal || null, baselineTemporal: previous?.temporal || null } : {}) };
  });
  return { status: results.every((item) => item.passed) ? 'passed' : 'failed', coverage: 'provided_cases_only', verifiesLiveSystems: false,
    effects: [], cases: results, passed: results.filter((item) => item.passed).length, total: results.length, changed: results.filter((item) => item.changed).length };
}

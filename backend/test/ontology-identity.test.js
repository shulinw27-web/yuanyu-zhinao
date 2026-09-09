import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityScenarioDraft } from '../../frontend/src/features/meta-model/ontology-scenario.js';
import { evaluateIdentityMapping } from '../src/services/ontology-identity-service.js';
import { replayDecisionCases } from '../src/services/decision-binding-service.js';
import { runOntologyCaseReplay, getOntologyCaseReplay } from '../src/services/ontology-runtime-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft } from '../src/services/meta-model-service.js';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';

const scope = { tenantId: 'demo-enterprise', subjectId: 'admin@demo.local' };
const meta = { tenantId: scope.tenantId, organizationId: 'org-quality-dept', classification: '质量受限', version: '1', occurredAt: '2026-09-01T00:00:00Z' };
const left = { system: 'ERP', objectType: 'Material', id: 'M-01' }; const right = { system: 'WMS', objectType: 'Material', id: 'SKU-001' };
const draft = () => { const d = qualityScenarioDraft(); d.objectTypes[0].sourceSystems.push('WMS'); return d; };
const mapping = (source, id, canonicalId = 'CANON-M1') => ({ ...meta, id, system: source.system, source, canonical: { objectType: source.objectType, id: canonicalId }, granularity: 'master',
  validFrom: '2026-09-01T00:00:00Z', validTo: null, recordedAt: '2026-09-02T00:00:00Z', provenanceType: 'confirmed', evidenceIds: ['synthetic-confirmation'] });
const sample = () => ({ id: 'mapping-check', kind: 'identity_mapping', at: '2026-09-03T00:00:00Z', knownAt: '2026-09-03T00:00:00Z', expected: 'same_entity',
  query: { left, right }, records: [left, right].map(ref => ({ ...meta, ...ref, payload: { name: 'same display name', private: 'DO_NOT_PERSIST' } })), mappings: [mapping(left, 'map-1'), mapping(right, 'map-2')] });
const run = (s = sample(), d = draft(), identityScope = scope) => evaluateIdentityMapping({ draft: d, sample: s, roleId: 'executive', identityScope });

test('explicit confirmed mappings resolve different source identifiers without writeback', () => {
  const s = sample(); const before = structuredClone(s); const result = run(s);
  assert.equal(result.outcome, 'same_entity'); assert.deepEqual(result.effects, []); assert.equal(result.identity.writeback, 'not_requested');
  assert.equal(result.verifiesLiveSystems, false); assert.deepEqual(s, before);
  s.mappings[1].canonical.id = 'OTHER'; assert.equal(run(s).outcome, 'different_entity');
  s.query.right = s.query.left; assert.equal(run(s).identity.activeMappings, 1);
});

test('same name or source identifier never supplies missing mappings', () => {
  const s = sample(); s.query.right = { ...right, id: left.id }; s.records[1].id = left.id; s.mappings = [];
  assert.equal(run(s).outcome, 'unresolved');
  s.mappings = [mapping(left, 'map-1')]; assert.equal(run(s).outcome, 'unresolved');
});

test('unconfirmed observations and inferred mappings require review', () => {
  for (const provenanceType of ['observed', 'inferred', 'declared']) { const s = sample(); s.mappings[1].provenanceType = provenanceType; assert.equal(run(s).outcome, 'needs_review'); }
});

test('one source mapping to multiple canonical identities is a conflict independent of order', () => {
  const s = sample(); s.mappings.push(mapping(left, 'conflicting', 'CANON-M2'));
  const result = run(s); assert.equal(result.outcome, 'conflict'); s.mappings.reverse(); assert.deepEqual(run(s), result);
});

test('source system namespaces isolate identical assertion IDs and reject duplicate versions', () => {
  const s = sample(); s.mappings[1].id = s.mappings[0].id; assert.equal(run(s).outcome, 'same_entity');
  s.mappings.push(structuredClone(s.mappings[0])); assert.equal(run(s).code, 'IDENTITY_DUPLICATE_VERSION');
});

test('source type, canonical type and model granularity cannot silently collapse batches into master data', () => {
  const s = sample(); s.mappings[0].canonical.objectType = 'RawMaterialBatch'; assert.equal(run(s).code, 'IDENTITY_GRANULARITY_MISMATCH');
  s.mappings[0].canonical.objectType = 'Material'; s.mappings[0].granularity = 'batch'; assert.equal(run(s).code, 'IDENTITY_GRANULARITY_MISMATCH');
  const d = draft(); d.objectTypes[0].granularity = 'unspecified'; assert.equal(run(sample(), d).code, 'IDENTITY_GRANULARITY_MISMATCH');
});

test('late withdrawal respects knowledge time and mapping validity is end-exclusive', () => {
  const s = sample(); s.mappings.push({ ...s.mappings[0], version: '2', recordedAt: '2026-09-05T00:00:00Z', retracted: true });
  assert.equal(run(s).outcome, 'same_entity'); s.knownAt = '2026-09-06T00:00:00Z'; assert.equal(run(s).outcome, 'unresolved');
  const ended = sample(); ended.mappings[0].validTo = ended.at; assert.equal(run(ended).outcome, 'unresolved');
});

test('competing revisions conflict and identifier reassignment must use a new assertion', () => {
  const s = sample(); s.mappings.push({ ...s.mappings[0], version: '2', retracted: true }); assert.equal(run(s).outcome, 'conflict');
  s.mappings[2] = { ...s.mappings[0], version: '2', recordedAt: '2026-09-05T00:00:00Z', canonical: { objectType: 'Material', id: 'OTHER' } };
  assert.equal(run(s).code, 'IDENTITY_REASSIGNMENT_REQUIRES_NEW_ASSERTION');
});

test('all records and mappings are scoped before resolution, including future corrections', () => {
  for (const collection of ['records', 'mappings']) { const s = sample(); s[collection][0].tenantId = 'other'; assert.equal(run(s).code, 'IDENTITY_SCOPE_INVALID'); }
  const s = sample(); s.mappings.push({ ...s.mappings[0], version: 'future', recordedAt: '2027-01-01T00:00:00Z', organizationId: 'unknown' }); assert.equal(run(s).code, 'IDENTITY_SCOPE_INVALID');
  assert.equal(run(sample(), draft(), { ...scope, subjectId: 'unknown' }).code, 'IDENTITY_SCOPE_INVALID');
});

test('unknown sources, dangling references, malformed intervals and limits fail closed', () => {
  const missing = sample(); missing.records.pop(); assert.equal(run(missing).code, 'IDENTITY_SOURCE_MISSING');
  assert.equal(run(sample(), qualityScenarioDraft()).code, 'IDENTITY_SOURCE_INVALID');
  for (const patch of [{ evidenceIds: [] }, { retracted: 'false' }, { validTo: '2026-08-01T00:00:00Z' }, { recordedAt: 'yesterday' }]) { const s = sample(); Object.assign(s.mappings[0], patch); assert.equal(run(s).code, 'IDENTITY_MAPPING_INVALID'); }
  for (const patch of [{ knownAt: '2026-09-01' }, { records: [] }, { mappings: Array(501).fill({}) }]) assert.equal(run({ ...sample(), ...patch }).code, 'IDENTITY_SAMPLE_INVALID');
});

test('model version comparison detects changed granularity without retaining source identifiers', () => {
  const candidate = draft(); const baseline = draft(); baseline.objectTypes[0].granularity = 'batch';
  const report = replayDecisionCases({ candidate, baseline, cases: [sample()], roleId: 'executive', identityScope: scope });
  assert.equal(report.status, 'passed'); assert.equal(report.changed, 1); assert.equal(report.cases[0].baseline, 'IDENTITY_GRANULARITY_MISMATCH');
  for (const secret of ['DO_NOT_PERSIST', 'CANON-M1', 'SKU-001']) assert.equal(JSON.stringify(report).includes(secret), false);
  const s = sample(); s.records[0].tenantId = 'other'; assert.equal(replayDecisionCases({ candidate, cases: [s], roleId: 'executive', identityScope: scope }).code, 'REPLAY_SCOPE_INVALID');
});

test('mapping report is persisted in the existing scoped replay flow without source payloads', async () => {
  resetRuntimeState(['oa_meta_model_runtime', 'ontology_case_replay']); const role = getRole('executive'); saveOAMetaModelDraft(draft(), role);
  const result = await runOntologyCaseReplay({ role, identityScope: scope, body: { candidateFingerprint: getOAMetaModelDraft().fingerprint, cases: [sample()] } });
  assert.equal(result.status, 'passed'); const saved = await getOntologyCaseReplay({ role, identityScope: scope }); assert.equal(saved.rawRecordsStored, false);
  assert.equal(JSON.stringify(saved).includes('DO_NOT_PERSIST'), false);
});

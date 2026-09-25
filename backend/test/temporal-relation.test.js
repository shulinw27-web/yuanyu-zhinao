import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityScenarioDraft } from '@healthcare-ai/agent-ui/ontology-scenario';
import { evaluateTemporalRelations } from '../src/services/temporal-relation-service.js';
import { replayDecisionCases } from '../src/services/decision-binding-service.js';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { getRole } from '../src/services/authorization-service.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft } from '../src/services/meta-model-service.js';
import { runOntologyCaseReplay, getOntologyCaseReplay } from '../src/services/ontology-runtime-service.js';

const scope = { tenantId: 'demo-enterprise', subjectId: 'admin@demo.local' };
const meta = { tenantId: scope.tenantId, organizationId: 'org-quality-dept', classification: '质量受限', version: '1', occurredAt: '2026-09-01T00:00:00Z' };
const from = { objectType: 'Material', id: 'M1' }; const to = { objectType: 'RawMaterialBatch', id: 'B1' };
const record = (ref, system) => ({ ...meta, ...ref, system, payload: { private: 'DO_NOT_PERSIST' } });
const revision = (patch = {}) => ({ ...meta, id: 'link-1', system: 'ERP', from, to, predicate: 'hasBatch', validFrom: '2026-09-01T00:00:00Z', validTo: null,
  recordedAt: '2026-09-02T00:00:00Z', provenanceType: 'observed', evidenceIds: ['dictionary-v1'], ...patch });
const sample = () => ({ id: 'historical-1', kind: 'relation_history', at: '2026-09-03T00:00:00Z', knownAt: '2026-09-03T00:00:00Z', expected: 'related',
  query: { from, to, predicate: 'hasBatch' }, records: [record(from, 'ERP'), record(to, 'WMS')], relations: [revision()] });
const evaluate = (row = sample(), draft = qualityScenarioDraft(), identityScope = scope) => evaluateTemporalRelations({ draft, sample: row, roleId: 'executive', identityScope });

test('business time and knowledge time are separate; late corrections do not rewrite prior knowledge', () => {
  const row = sample(); row.relations.push(revision({ version: '2', recordedAt: '2026-09-05T00:00:00Z', validTo: '2026-09-03T00:00:00Z' }));
  assert.equal(evaluate(row).outcome, 'related');
  row.knownAt = '2026-09-06T00:00:00Z'; assert.equal(evaluate(row).outcome, 'not_related');
  row.at = '2026-09-02T23:59:59Z'; assert.equal(evaluate(row).outcome, 'related');
});

test('valid intervals are start-inclusive and end-exclusive; no version-order guessing', () => {
  const row = sample(); row.relations = [revision({ version: '99', validTo: row.at }), revision({ version: '2', recordedAt: '2026-09-04T00:00:00Z' })];
  assert.equal(evaluate(row).outcome, 'not_related');
  row.knownAt = '2026-09-04T00:00:00Z'; assert.equal(evaluate(row).outcome, 'related');
  row.at = '2026-09-01T00:00:00Z'; assert.equal(evaluate(row).outcome, 'related');
});

test('withdrawal applies only after its recorded time without deleting prior facts', () => {
  const row = sample(); row.relations.push(revision({ version: '2', recordedAt: '2026-09-04T00:00:00Z', retracted: true }));
  assert.equal(evaluate(row).outcome, 'related');
  row.knownAt = '2026-09-05T00:00:00Z'; assert.equal(evaluate(row).outcome, 'not_related');
  assert.equal(row.relations.length, 2); assert.deepEqual(evaluate(row).effects, []);
});

test('same-time revisions conflict deterministically regardless of input order', () => {
  const row = sample(); row.relations.push(revision({ version: '2', retracted: true }));
  const result = evaluate(row); assert.equal(result.outcome, 'conflict'); assert.equal(result.temporal.conflict, 'revision_time_tie');
  row.relations.reverse(); assert.deepEqual(evaluate(row), result);
});

test('cardinality conflicts are detected without merging endpoint identities', () => {
  const row = sample(); const second = { objectType: 'Material', id: 'M2' };
  row.records.push(record(second, 'ERP')); row.relations.push(revision({ id: 'link-2', from: second }));
  assert.equal(evaluate(row).outcome, 'conflict');
  const draft = qualityScenarioDraft(); draft.relationshipTypes[0].cardinality = 'n:n'; assert.equal(evaluate(row, draft).outcome, 'related');
  row.query.from = second; assert.equal(evaluate(row, draft).outcome, 'related');
});

test('inferred and declared relations cannot count as verified relationships', () => {
  for (const provenanceType of ['inferred', 'declared']) {
    const row = sample(); row.relations[0].provenanceType = provenanceType;
    assert.equal(evaluate(row).outcome, 'needs_review');
  }
  const row = sample(); row.relations[0].provenanceType = 'confirmed'; assert.equal(evaluate(row).outcome, 'related');
  row.relations[0].evidenceIds = []; assert.equal(evaluate(row).code, 'RELATION_REVISION_INVALID');
});

test('endpoints and assertions are all scoped, including invisible future revisions', () => {
  for (const collection of ['records', 'relations']) {
    const row = sample(); row[collection][0].tenantId = 'other'; assert.equal(evaluate(row).code, 'RELATION_SCOPE_INVALID');
  }
  const row = sample(); row.relations.push(revision({ version: 'future', recordedAt: '2026-12-01T00:00:00Z', organizationId: 'unknown' }));
  assert.equal(evaluate(row).code, 'RELATION_SCOPE_INVALID');
  assert.equal(evaluate(sample(), qualityScenarioDraft(), { ...scope, subjectId: 'unknown' }).code, 'RELATION_SCOPE_INVALID');
});

test('dangling endpoints, wrong source, duplicate versions and identity-changing corrections reject', () => {
  const missing = sample(); missing.records.pop(); assert.equal(evaluate(missing).code, 'RELATION_ENDPOINT_MISSING');
  const wrong = sample(); wrong.relations[0].system = 'QMS'; assert.equal(evaluate(wrong).code, 'RELATION_ENDPOINT_INVALID');
  const duplicate = sample(); duplicate.relations.push(revision()); assert.equal(evaluate(duplicate).code, 'RELATION_DUPLICATE_VERSION');
  const changed = sample(); const ref = { ...to, id: 'B2' }; changed.records.push(record(ref, 'WMS')); changed.relations.push(revision({ version: '2', to: ref }));
  assert.equal(evaluate(changed).code, 'RELATION_REVISION_IDENTITY_CHANGED');
});

test('time input, ranges and batch limits reject before query execution', () => {
  for (const patch of [{ knownAt: '2026-09-03' }, { knownAt: '2026-09-01T00:00:00Z' }, { relations: Array(501).fill(revision()) }, { records: [] }]) assert.equal(evaluate({ ...sample(), ...patch }).code, 'RELATION_SAMPLE_INVALID');
  for (const patch of [{ validTo: '2026-08-01T00:00:00Z' }, { recordedAt: 'yesterday' }, { retracted: 'false' }]) {
    const row = sample(); row.relations = [revision(patch)]; assert.equal(evaluate(row).code, 'RELATION_REVISION_INVALID');
  }
});

test('model validity and endpoint knowledge gaps require review instead of fabricated absence', () => {
  const draft = qualityScenarioDraft(); draft.relationshipTypes[0].validFrom = '2026-09-04T00:00:00Z';
  assert.equal(evaluate(sample(), draft).outcome, 'needs_review');
  const row = sample(); row.records[0].occurredAt = '2026-09-05T00:00:00Z'; assert.equal(evaluate(row).temporal.reason, 'endpoint_not_known');
  const empty = sample(); empty.relations = []; assert.equal(evaluate(empty).outcome, 'not_related'); assert.equal(evaluate(empty).coverage, 'provided_history_only');
});

test('existing case replay compares temporal outcomes and does not expose raw histories', () => {
  const row = sample(); const extra = { objectType: 'Material', id: 'M2' }; row.records.push(record(extra, 'ERP')); row.relations.push(revision({ id: 'link-2', from: extra })); row.expected = 'conflict';
  const candidate = qualityScenarioDraft(); const baseline = qualityScenarioDraft(); baseline.relationshipTypes[0].cardinality = 'n:n';
  const report = replayDecisionCases({ candidate, baseline, cases: [row], roleId: 'executive', identityScope: scope });
  assert.equal(report.status, 'passed'); assert.equal(report.changed, 1); assert.equal(report.cases[0].baseline, 'related');
  assert.equal(JSON.stringify(report).includes('DO_NOT_PERSIST'), false); assert.equal(JSON.stringify(report).includes('dictionary-v1'), false);
  row.records[0].tenantId = 'other'; assert.equal(replayDecisionCases({ candidate, cases: [row], roleId: 'executive', identityScope: scope }).code, 'REPLAY_SCOPE_INVALID');
});

test('temporal report uses existing authenticated replay persistence and fingerprint contract', async () => {
  resetRuntimeState(['oa_meta_model_runtime', 'ontology_case_replay']); const role = getRole('executive');
  saveOAMetaModelDraft(qualityScenarioDraft(getOAMetaModelDraft()), role);
  const result = await runOntologyCaseReplay({ role, identityScope: scope, body: { candidateFingerprint: getOAMetaModelDraft().fingerprint, cases: [sample()] } });
  assert.equal(result.status, 'passed'); assert.equal(result.cases[0].kind, 'relation_history');
  const stored = await getOntologyCaseReplay({ role, identityScope: scope }); assert.equal(stored.rawRecordsStored, false);
  assert.equal(JSON.stringify(stored).includes('DO_NOT_PERSIST'), false);
});

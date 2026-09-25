import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { getRole } from '../src/services/authorization-service.js';
import { getOAMetaModelDraft, getPublishedOntologyModel, saveOAMetaModelDraft, simulateBuildOAMetaModel } from '../src/services/meta-model-service.js';
import { evaluateBoundDecision, validateDecisionBinding, replayDecisionCases } from '../src/services/decision-binding-service.js';
import { runOntologyCaseReplay, getOntologyCaseReplay, publishGovernedOntology } from '../src/services/ontology-runtime-service.js';
import { qualityScenarioDraft } from '@healthcare-ai/agent-ui/ontology-scenario';
import { semanticFingerprint } from '../src/services/semantic-model-fingerprint.js';

const role = getRole('executive');
const identityScope = { tenantId: 'demo-enterprise', subjectId: 'admin@demo.local' };
const at = '2026-09-09T08:05:00Z';
const record = () => ({ id: 'evidence-1', tenantId: 'demo-enterprise', organizationId: 'org-quality-dept', classification: '质量受限',
  objectType: 'QualityEvent', system: 'QMS', version: 'v1', occurredAt: '2026-09-09T08:00:00Z', sourceMode: 'mock', payload: { risk_id: 'risk-1', severity: 'P1', status: '待确认', secret: 'DO_NOT_STORE' } });
const cases = () => [{ id: 'high', objectType: 'QualityEvent', at, expected: 'investigation_recommended', record: record() }];
const setup = () => {
  resetRuntimeState(['oa_meta_model_runtime', 'ontology_publication', 'ontology_case_replay']);
  const draft = qualityScenarioDraft(getOAMetaModelDraft());
  assert.equal(saveOAMetaModelDraft(draft, role).error, undefined);
  assert.equal(simulateBuildOAMetaModel(role).simulation.validation.status, 'passed');
  return getOAMetaModelDraft();
};
const evaluate = (draft, row = record(), time = at, scope = identityScope) => evaluateBoundDecision({ binding: draft.scenario.decisionBindings[0], object: draft.objectTypes.find(item => item.id === 'QualityEvent'), record: row, roleId: role.id, identityScope: scope, at: time });
const receipt = async (draft, version) => ({ status: 'published', deployment: { status: 'published', sourceFingerprint: semanticFingerprint(draft), version } });

test('field mapping and bounded parameters change recommendations without granting execution', () => {
  const draft = setup();
  assert.equal(evaluate(draft).outcome, 'investigation_recommended');
  draft.scenario.decisionBindings[0].parameters.investigationSeverities = ['P0'];
  const result = evaluate(draft);
  assert.equal(result.outcome, 'review_recommended'); assert.deepEqual(result.effects, []);
  assert.equal(result.executionStatus, 'not_requested');
  for (const parameters of [{ code: 'eval()' }, { maxEvidenceAgeMinutes: 0 }, { investigationSeverities: [] }, { investigationSeverities: ['P0', 'P0'] }]) {
    draft.scenario.decisionBindings[0].parameters = parameters;
    assert.equal(evaluate(draft).code, 'DECISION_BINDING_NOT_EXECUTABLE');
  }
});

test('unknown mappings, prototype paths and malformed model objects cannot execute', () => {
  const draft = setup(); const binding = draft.scenario.decisionBindings[0];
  for (const field of ['constructor', '__proto__', 'payload.severity', 'missing']) {
    binding.inputMapping.severity = field; assert.equal(evaluate(draft).code, 'DECISION_BINDING_NOT_EXECUTABLE');
  }
  assert.equal(validateDecisionBinding(binding, {}), false);
});

test('stale, future, wrong-system and unauthorized evidence fail safely', () => {
  const draft = setup();
  assert.equal(evaluate(draft, record(), '2026-09-10T08:00:00Z').outcome, 'needs_review');
  assert.equal(evaluate(draft, record(), '2026-09-08T08:00:00Z').code, 'DECISION_TIME_INVALID');
  assert.equal(evaluate(draft, { ...record(), system: 'ERP' }).code, 'DECISION_SOURCE_MISMATCH');
  for (const patch of [{ tenantId: 'other' }, { organizationId: 'unknown' }, { version: '' }, { classification: '' }]) assert.equal(evaluate(draft, { ...record(), ...patch }).code, 'DECISION_RECORD_NOT_ACCESSIBLE');
  assert.equal(evaluate(draft, record(), at, { ...identityScope, subjectId: 'unknown' }).code, 'DECISION_RECORD_NOT_ACCESSIBLE');
});

test('server-verified Demo identity preserves source context; an unverified Demo-like name is denied', () => {
  const draft = setup(); const scope = { tenantId: 'demo-enterprise', subjectId: 'demo:executive:replay-test', source: 'demo_header' };
  assert.equal(evaluate(draft, record(), at, scope).outcome, 'investigation_recommended');
  assert.equal(evaluate(draft, record(), at, { ...scope, source: 'user_input' }).code, 'DECISION_RECORD_NOT_ACCESSIBLE');
});

test('version comparison is deterministic and stores no raw payload', () => {
  const baseline = setup(); const candidate = structuredClone(baseline);
  candidate.scenario.decisionBindings[0].parameters.investigationSeverities = ['P0'];
  const samples = cases(); samples[0].expected = 'review_recommended';
  const args = { candidate, baseline, cases: samples, roleId: role.id, identityScope };
  const report = replayDecisionCases(args);
  assert.equal(report.status, 'passed'); assert.equal(report.changed, 1);
  assert.equal(report.cases[0].baseline, 'investigation_recommended');
  assert.deepEqual(report, replayDecisionCases(args)); assert.equal(JSON.stringify(report).includes('DO_NOT_STORE'), false);
});

test('invalid case collections and mixed-scope uploads never yield partial results', () => {
  const candidate = setup();
  for (const samples of [[], [null], Array(101).fill(cases()[0]), [...cases(), ...cases()]]) assert.equal(replayDecisionCases({ candidate, cases: samples, roleId: role.id, identityScope }).code, 'REPLAY_CASES_INVALID');
  const samples = cases(); samples.push({ ...samples[0], id: 'other', record: { ...record(), tenantId: 'other' } });
  const report = replayDecisionCases({ candidate, cases: samples, roleId: role.id, identityScope });
  assert.equal(report.code, 'REPLAY_SCOPE_INVALID'); assert.deepEqual(report.cases, []);
});

test('replay reports belong to the authenticated principal and exact draft fingerprint', async () => {
  const draft = setup(); const body = { candidateFingerprint: draft.fingerprint, cases: cases() };
  assert.equal((await runOntologyCaseReplay({ body, role, identityScope })).status, 'passed');
  assert.equal(JSON.stringify(await getOntologyCaseReplay({ role, identityScope })).includes('DO_NOT_STORE'), false);
  assert.equal(await getOntologyCaseReplay({ role, identityScope: { ...identityScope, subjectId: 'different' } }), null);
  body.candidateFingerprint = 'stale';
  assert.equal((await runOntologyCaseReplay({ body, role, identityScope })).code, 'REPLAY_DRAFT_STALE');
});

test('required replay gates publication and completed publication is not repeated', async () => {
  const draft = setup(); draft.scenario.requireCaseReplay = true;
  saveOAMetaModelDraft(draft, role); simulateBuildOAMetaModel(role);
  let calls = 0; const deploy = async (...args) => { calls++; return receipt(...args); };
  assert.equal((await publishGovernedOntology({ role, identityScope, deploy })).code, 'PUBLICATION_REPLAY_REQUIRED');
  assert.equal(calls, 0);
  await runOntologyCaseReplay({ role, identityScope, body: { candidateFingerprint: getOAMetaModelDraft().fingerprint, cases: cases() } });
  const result = await publishGovernedOntology({ role, identityScope, deploy });
  assert.equal(result.error, undefined); assert.equal(calls, 1);
  assert.equal((await publishGovernedOntology({ role, identityScope, deploy })).code, 'PUBLICATION_ALREADY_COMPLETED'); assert.equal(calls, 1);
});

test('uncertain publish is reconciled by read-only exact-version inspection, not redeployed', async () => {
  setup(); let savedReceipt; let calls = 0;
  const deploy = async (...args) => { calls++; savedReceipt = await receipt(...args); throw new Error('response lost'); };
  assert.equal((await publishGovernedOntology({ role, identityScope, deploy })).code, 'PUBLICATION_OUTCOME_UNKNOWN');
  assert.equal(getPublishedOntologyModel(), null);
  const retry = await publishGovernedOntology({ role, identityScope, deploy, inspect: async () => savedReceipt.deployment });
  assert.equal(retry.error, undefined); assert.equal(retry.semanticDeployment.reconciled, true); assert.equal(calls, 1);
});

test('unmatched receipts remain uncertain; wrong version or status cannot be reconciled', async () => {
  setup(); let savedReceipt;
  const deploy = async (...args) => { savedReceipt = await receipt(...args); return { ...savedReceipt, deployment: { ...savedReceipt.deployment, version: 'wrong' } }; };
  assert.equal((await publishGovernedOntology({ role, identityScope, deploy })).code, 'PUBLICATION_RECEIPT_UNCONFIRMED');
  for (const patch of [{ status: 'draft' }, { version: 'wrong' }, { sourceFingerprint: 'wrong' }]) {
    const result = await publishGovernedOntology({ role, identityScope, deploy: () => assert.fail('must not write again'), inspect: async () => ({ ...savedReceipt.deployment, ...patch }) });
    assert.equal(result.code, 'PUBLICATION_RECONCILIATION_REQUIRED');
  }
  assert.equal(getPublishedOntologyModel(), null);
});

test('draft mutation during external deployment cannot publish the wrong local model', async () => {
  setup();
  const deploy = async (...args) => {
    const draft = getOAMetaModelDraft(); draft.scenario.questions.push('changed during deploy'); saveOAMetaModelDraft(draft, role);
    return receipt(...args);
  };
  assert.equal((await publishGovernedOntology({ role, identityScope, deploy })).code, 'ONTOLOGY_PUBLICATION_STALE');
  assert.equal(getPublishedOntologyModel(), null);
});

test('parallel publication has one external writer', async () => {
  setup(); let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const first = publishGovernedOntology({ role, identityScope, deploy: async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return receipt(...args); } });
  await started;
  assert.equal((await publishGovernedOntology({ role, identityScope, deploy: () => assert.fail('second writer') })).code, 'PUBLICATION_BUSY');
  release(); assert.equal((await first).error, undefined);
});

test('instance preflight failures are retryable only when no publication request was sent', async () => {
  for (const reason of ['tenant_config_invalid', 'instance_identity_unverified', 'service_unavailable']) {
    setup();
    const blocked = await publishGovernedOntology({ role, identityScope,
      deploy: async () => ({ status: 'unavailable', reason, requestAttempted: false }) });
    assert.equal(blocked.code, 'PUBLICATION_NOT_ATTEMPTED');
    assert.equal(getPublishedOntologyModel(), null);
    assert.equal((await publishGovernedOntology({ role, identityScope, deploy: receipt })).error, undefined);
    setup();
    const uncertain = await publishGovernedOntology({ role, identityScope,
      deploy: async () => ({ status: 'unavailable', reason, requestAttempted: true }) });
    assert.equal(uncertain.code, 'PUBLICATION_RECEIPT_UNCONFIRMED');
    const retried = await publishGovernedOntology({ role, identityScope,
      deploy: () => assert.fail('uncertain write must not repeat'), inspect: async () => ({ status: 'not_published' }) });
    assert.equal(retried.code, 'PUBLICATION_RECONCILIATION_REQUIRED');
  }
});

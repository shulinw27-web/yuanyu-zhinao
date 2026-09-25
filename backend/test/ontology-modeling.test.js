import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { getRole } from '../src/services/authorization-service.js';
import { getOAMetaModelDraft, getPublishedDecisionContext, saveOAMetaModelDraft, validateOAMetaModelDraft, simulateBuildOAMetaModel, publishOAMetaModel } from '../src/services/meta-model-service.js';
import { evaluateBusinessDecision, replayBusinessDecision } from '../src/services/business-decision-service.js';
import { semanticFingerprint } from '../src/services/semantic-model-fingerprint.js';
import { qualityScenarioDraft, semanticSimulationMessage } from '@healthcare-ai/agent-ui/ontology-scenario';
import { launchProcurement, approveProcurement, getProcurementScenario } from '../src/services/procurement-service.js';
import { analyzeProductionImpact } from '../src/services/domain-analysis-service.js';
import { getRegisteredTools, validateToolInvocation } from '../src/services/agent-tool-registry.js';

const role = getRole('executive');
const reset = () => resetRuntimeState(['oa_meta_model_runtime', 'procurement_runtime', 'risk_runtime']);
const quality = () => qualityScenarioDraft(getOAMetaModelDraft());
const save = (draft) => { const result = saveOAMetaModelDraft(draft, role); assert.equal(result.error, undefined); return result.draft; };

test('single-object general scenario validates, builds and publishes without OA artifacts', () => {
  reset(); const draft = quality();
  draft.objectTypes = draft.objectTypes.filter((item) => item.id === 'QualityEvent');
  draft.relationshipTypes = [];
  for (const name of ['glossaryTerms', 'dataContracts', 'qualityRules', 'accessPolicies']) draft[name] = draft[name].filter((item) => item.objectType === 'QualityEvent');
  draft.lineageEdges = draft.lineageEdges.filter((item) => item.to === 'QualityEvent');
  save(draft);
  assert.equal(validateOAMetaModelDraft(role).draft.validation.status, 'passed');
  const built = simulateBuildOAMetaModel(role);
  assert.equal(built.simulation.validation.status, 'passed');
  assert.equal(built.simulation.instances.nodes.length, 1);
  assert.equal(built.simulation.instances.nodes[0].type, 'QualityEvent');
  assert.equal(built.simulation.verifiesLiveSystems, false);
  assert.equal(built.simulation.decisionReplay.results[0].cases.length, 9);
  assert.equal(publishOAMetaModel(role).simulation.status, 'published');
});

test('OA profile still requires its approval semantics and general still requires governance', () => {
  reset(); const draft = quality(); draft.modelingProfile = 'oa-approval'; save(draft);
  assert.equal(validateOAMetaModelDraft(role).draft.validation.checks.find((item) => item.name === '必备审批语义').status, 'failed');
  draft.modelingProfile = 'general'; draft.policies = []; save(draft);
  assert.equal(validateOAMetaModelDraft(role).draft.validation.status, 'failed');
  assert.ok(simulateBuildOAMetaModel(role).error);
  assert.ok(publishOAMetaModel(role).error);
});

test('business questions and known versioned decisions are required, never arbitrary code', () => {
  reset();
  for (const change of [
    (d) => { d.scenario.questions = []; },
    (d) => { d.scenario.objective = ''; },
    (d) => { d.scenario.decisionBindings[0].version = '999'; },
    (d) => { d.scenario.decisionBindings[0].capabilityId = 'eval'; },
    (d) => { d.scenario.actionBindings[0].toolId = 'approve_procurement'; },
    (d) => { d.scenario.actionBindings[0].objectType = 'Material'; },
    (d) => { d.stateMachines[0].initial = '不存在'; }
  ]) { const draft = quality(); change(draft); save(draft); assert.equal(validateOAMetaModelDraft(role).draft.validation.status, 'failed'); }
});

test('invalid payloads never silently replace keys, restore deleted objects or throw', () => {
  reset(); const base = getOAMetaModelDraft(); const fingerprint = semanticFingerprint(base);
  for (const input of [{ objectTypes: [] }, { objectTypes: [null] }, { objectTypes: [{ ...base.objectTypes[0], key: 'missing' }] },
    { scenario: [] }, { scenario: { objective: 'x', questions: [], decisionBindings: [null], actionBindings: [] } },
    { stateMachines: [null] }, { dataContracts: [null] }, { relationshipTypes: [null] }, { modelingProfile: 'unsafe' }]) {
    assert.ok(saveOAMetaModelDraft(input, role).error);
    assert.equal(semanticFingerprint(getOAMetaModelDraft()), fingerprint);
  }
});

test('granularity, relationship evidence and valid times survive save and invalid intervals fail', () => {
  reset(); const draft = quality();
  draft.relationshipTypes[0] = { ...draft.relationshipTypes[0], predicate: '包含批次', provenanceType: 'confirmed', evidence: '受控数据字典版本 v1', validFrom: '2026-09-01T00:00:00+08:00', validTo: '2026-10-01T00:00:00+08:00' };
  const saved = save(draft);
  assert.equal(saved.objectTypes[0].granularity, 'master');
  assert.deepEqual(saved.relationshipTypes[0], draft.relationshipTypes[0]);
  assert.equal(validateOAMetaModelDraft(role).draft.validation.status, 'passed');
  draft.relationshipTypes[0].validTo = '2026-08-01T00:00:00+08:00'; save(draft);
  assert.equal(validateOAMetaModelDraft(role).draft.validation.status, 'failed');
  draft.relationshipTypes[0].validTo = null; draft.relationshipTypes[0].evidence = ''; save(draft);
  assert.equal(validateOAMetaModelDraft(role).draft.validation.status, 'failed');
});

test('scenario, state and relation changes invalidate fingerprint and previous simulation', () => {
  reset(); const draft = save(quality()); simulateBuildOAMetaModel(role);
  for (const change of [(d) => { d.scenario.questions.push('新增验收问题'); }, (d) => { d.stateMachines[0].terminal = []; }, (d) => { d.relationshipTypes[0].provenanceType = 'inferred'; }]) {
    const changed = structuredClone(draft); change(changed);
    assert.notEqual(semanticFingerprint(changed), semanticFingerprint(draft));
  }
  draft.scenario.questions.push('不授权时是否保持只读？');
  const changed = save(draft);
  assert.ok(changed.dependencyImpact.affectedDecisions.includes('quality_disposition'));
  assert.ok(changed.dependencyImpact.affectedActions.includes('create_quality_investigation'));
  assert.ok(publishOAMetaModel(role).error);
});

test('unpublished drafts never replace the published decision context', () => {
  reset(); save(quality());
  assert.equal(getPublishedDecisionContext('quality_disposition'), null);
  simulateBuildOAMetaModel(role); publishOAMetaModel(role, { version: 'ontology-test-v1' });
  const published = getPublishedDecisionContext('quality_disposition');
  const changed = getOAMetaModelDraft(); changed.scenario.questions.push('下一版问题'); save(changed);
  assert.deepEqual(getPublishedDecisionContext('quality_disposition'), published);
  assert.equal(published.modelVersion, 'ontology-test-v1');
});

test('decision replay is deterministic, explicitly synthetic and entirely read-only', () => {
  const replay = replayBusinessDecision('quality_disposition');
  assert.equal(replay.status, 'passed'); assert.equal(replay.verifiesLiveSystems, false);
  for (const item of replay.cases) assert.equal(item.passed, true);
  assert.deepEqual(replayBusinessDecision('quality_disposition'), replay);
  assert.equal(evaluateBusinessDecision('arbitrary-code').code, 'DECISION_NOT_REGISTERED');
  assert.equal(evaluateBusinessDecision('quality_disposition', null).outcome, 'needs_review');
  assert.equal(evaluateBusinessDecision('quality_disposition', {}).recommendations.length, 0);
});

test('quality analysis uses the registered decision and never creates procurement or investigation', async () => {
  reset(); const before = await getProcurementScenario();
  const result = await analyzeProductionImpact('executive', { tenantId: 'demo-enterprise', subjectId: 'admin@demo.local' });
  assert.equal(result.decision.capabilityId, 'quality_disposition');
  assert.equal(result.decision.executionStatus, 'not_requested');
  assert.deepEqual(result.decision.effects, []);
  assert.match(result.summary, /本次仅分析/);
  const configured = quality(); configured.scenario.decisionBindings[0].parameters.investigationSeverities = ['P3'];
  save(configured); simulateBuildOAMetaModel(role); publishOAMetaModel(role);
  const publishedResult = await analyzeProductionImpact('executive', { tenantId: 'demo-enterprise', subjectId: 'admin@demo.local' });
  assert.equal(publishedResult.decision.outcome, 'review_recommended');
  assert.ok(publishedResult.decision.bindingFingerprint);
  assert.deepEqual(publishedResult.decision.effects, []);
  assert.deepEqual(await getProcurementScenario(), before);
});

test('model bindings do not add tools or bypass save and publish permissions', () => {
  reset(); const before = getRegisteredTools(); save(quality()); simulateBuildOAMetaModel(role);
  assert.ok(publishOAMetaModel(getRole('quality_manager')).error);
  assert.ok(saveOAMetaModelDraft(quality(), { id: 'unknown' }).error);
  assert.deepEqual(getRegisteredTools(), before);
  assert.equal(validateToolInvocation('freeze_arbitrary_batch').valid, false);
});

test('procurement mock receipts cannot claim ERP acceptance or completed business', async () => {
  reset(); const launched = await launchProcurement(role); const approved = await approveProcurement(role);
  for (const result of [launched, approved]) {
    assert.equal(result.execution.sourceMode, 'mock');
    assert.equal(result.execution.receiptStatus, 'simulated_only');
    assert.equal(result.execution.externalReceipt, null); assert.equal(result.execution.businessCompleted, false);
  }
  assert.match(approved.audit[0].detail, /未取得真实 ERP/);
});

test('live mode fails closed rather than writing mock procurement state', async () => {
  reset(); const previous = process.env.CONNECTOR_MOCK_MODE; const before = await getProcurementScenario();
  try {
    process.env.CONNECTOR_MOCK_MODE = 'disabled';
    assert.equal(launchProcurement(role).code, 'LIVE_PROCUREMENT_CONNECTOR_REQUIRED');
    assert.equal(approveProcurement(role).code, 'LIVE_PROCUREMENT_CONNECTOR_REQUIRED');
    assert.deepEqual(await getProcurementScenario(), before);
  } finally { if (previous === undefined) delete process.env.CONNECTOR_MOCK_MODE; else process.env.CONNECTOR_MOCK_MODE = previous; }
});

test('both modeler surfaces distinguish local simulation from unavailable semantic service', () => {
  const result = { simulation: { validation: { status: 'passed' } }, semanticValidation: { status: 'unavailable', detail: '服务未连接' } };
  assert.match(semanticSimulationMessage(result), /独立语义服务尚未验证/);
  assert.match(semanticSimulationMessage(result), /不能据此声称/);
  result.semanticValidation.status = 'passed';
  assert.match(semanticSimulationMessage(result), /不代表真实业务执行/);
  result.simulation.validation.status = 'failed';
  assert.match(semanticSimulationMessage(result), /未通过/);
});

test('unknown identity stays denied after subject forwarding fix', async () => {
  reset();
  const result = await analyzeProductionImpact('executive', { tenantId: 'demo-enterprise', subjectId: 'not-registered' });
  assert.equal(result.decision.objectId, null);
  assert.equal(result.decision.outcome, 'needs_review');
  assert.deepEqual(result.decision.recommendations, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMockAlignment, validateMockAlignment } from '../src/services/mock-onboarding-alignment.js';
import { onboardingAlignment } from '../../examples/mock-onboarding/alignment.mjs';
import { onboardingMaterials } from '../../examples/mock-onboarding/materials.mjs';
import { createMockOnboardingProject, saveMockOnboardingMaterial, testMockOnboardingConnection, saveMockOnboardingAlignment, getMockOnboardingAlignment, getMockOnboardingProject, handoffMockOnboardingModel, getMockOnboardingCalculations, previewMockOnboardingCalculation } from '../src/services/mock-onboarding-service.js';
import { getSemanticOperationsTask, getSemanticOperationsTaskTrace, issueSemanticOperationsTaskConfirmation, executeSemanticOperationsTask, semanticTaskStateFingerprint } from '../src/services/semantic-operations-task-service.js';
import { configureAgentEvidenceTraceRepository } from '../src/services/agent-evidence-trace-service.js';
import { asyncRuntimeStateRepository } from '../src/repositories/async-runtime-state-repository.js';
import { applySemanticOperationsProposal } from '../src/services/semantic-operations-agent-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft } from '../src/services/meta-model-service.js';
import { semanticFingerprint } from '../src/services/semantic-model-fingerprint.js';
import { resetRuntimeState, writeState, listState, deleteState } from '../src/repositories/runtime-state-repository.js';
import { createInitialIAMWorkspace, iamWorkspaceKey } from '../src/services/iam-workspace-model.js';
import { runWithIAMStoreContext } from '../src/services/iam-store.js';
import { createMockOnboardingOntologyAdapter } from '../src/services/mock-onboarding-ontology-adapter.js';
import { readMockOnboardingSource } from '../src/services/mock-onboarding-source-service.js';
import { executeOntologyReadPlan } from '../src/services/ontology-read-plan-service.js';
import { plan } from '../../examples/knowledge/dual-agent-mock/scenario.mjs';
import { semanticModelRegistry } from '../src/services/semantic-model-registry.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceState, configureSemanticGovernanceRepository } from '../src/services/semantic-governance-store.js';
import { expected, complexReplayCases } from '../../examples/knowledge/dual-agent-mock/expected.mjs';
import { handleGovernanceRoutes } from '../src/routes/governance-routes.js';
import { modelWorkspaces } from '../src/domains/governance/model-workspaces.js';

const tenantId = 'mock-onboarding-a';
const context = { identityScope: { tenantId, subjectId: 'alice' }, role: 'executive' };
const inside = work => runWithIAMStoreContext(work, tenantId);
const data = (scenarioId = 'fulfillment') => {
  const materials = onboardingMaterials(scenarioId, tenantId);
  return { config: onboardingAlignment(scenarioId), tables: JSON.parse(materials[2].text).tables, records: JSON.parse(materials[3].text).records, tenantId };
};
const saved = (project, config) => inside(() => saveMockOnboardingAlignment({ ...context, id: project.id, body: { expectedRevision: project.revision, config } }));
const connect = (project, extras) => inside(() => testMockOnboardingConnection({ ...context, id: project.id, body: { expectedRevision: project.revision, faultMode: 'none' } }, extras));
const read = project => inside(() => getMockOnboardingAlignment({ ...context, id: project.id }));
async function ready() {
  const state = createInitialIAMWorkspace(); state.users = [{ ...state.users[0], account: 'alice', id: 'alice', roleIds: ['executive'] }];
  writeState('iam', iamWorkspaceKey(tenantId), state);
  let project = (await inside(() => createMockOnboardingProject({ ...context, body: { name: '人工业务对齐测试', scenarioId: 'fulfillment' } }))).project;
  for (const material of onboardingMaterials('fulfillment', tenantId)) project = (await inside(() => saveMockOnboardingMaterial({ ...context, id: project.id, body: { ...material, expectedRevision: project.revision } }))).project;
  return project;
}
test.beforeEach(() => resetRuntimeState(['mock_onboarding_v1', 'iam', 'semantic_operations_agent_tasks', 'semantic_operations_agent_proposals', 'semantic_material_artifacts', 'oa_meta_model_runtime', 'ontology_publication', 'semantic_operations_agent_snapshots']));

async function handoffReady() {
  let project = await ready(); const source = (await read(project)).evidenceSources.find(source => source.kind === 'rules'); const config = data().config;
  for (const category of ['identities','units','states']) for (const rule of config[category]) rule.materialEvidence = { kind: 'rules', digest: source.digest, quote: source.text.slice(0, 80) };
  project = (await saved(project, config)).project; return (await connect(project)).project;
}
const handoff = (project, extra) => inside(() => handoffMockOnboardingModel({ ...context, id: project.id, body: { expectedRevision: project.revision } }, extra));
const draftFingerprint = () => inside(() => runWithSemanticTenant(context.identityScope, async () => semanticFingerprint(await getOAMetaModelDraft())));

test('registered models hand off actual scoped projects atomically; confirmation adopts only that model', async () => {
  resetRuntimeState(['semantic_model_registry']); await ready();
  await inside(() => runWithSemanticTenant(context.identityScope, async () => {
    const role = getRole('executive');
    for (const [expectedRevision, modelId] of ['fulfillment-model', 'finance-model'].entries()) {
      await semanticModelRegistry.register({ role, identityScope: context.identityScope, body: { id: modelId, label: modelId, expectedRevision } });
      await semanticModelRegistry.withWorkspace({ role, identityScope: context.identityScope, modelId, work: async () => {
        const project = await handoffReady(); assert.equal(project.modelId, modelId);
        const before = await draftFingerprint(); const result = await handoff(project);
        assert.equal(result.error, undefined, JSON.stringify(result)); assert.equal(result.project.modelId, modelId);
        assert.equal(await draftFingerprint(), before);
        const task = await getSemanticOperationsTask({ taskId: result.taskId, identityScope: context.identityScope });
        assert.equal(task.modelId, modelId); assert.equal(task.proposal.modelId, modelId); assert.equal(task.status, 'waiting_confirmation');
        const probe = () => modelWorkspaces.inspectTaskReferences({ modelId, identityScope: context.identityScope, taskId: task.id });
        assert.equal((await probe()).referenceState, 'valid', JSON.stringify(await probe()));
        const key = JSON.stringify(['principal-role-v1', tenantId, context.identityScope.subjectId, 'executive']);
        const original = (await readSemanticGovernanceState('mock_onboarding_v1', key, {}))[project.id];
        for (const patch of [{ modelId: 'foreign-model' }, { materialRevision: 0 }, { handoff: { ...original.handoff, taskId: 'wrong-task' } }, { owner: 'other' }]) {
          await mutateSemanticGovernanceState('mock_onboarding_v1', key, {}, index => { index[project.id] = { ...original, ...patch }; return { value: index }; });
          assert.equal((await probe()).code, 'MODEL_TASK_ONBOARDING_CHANGED');
        }
        await mutateSemanticGovernanceState('mock_onboarding_v1', key, {}, index => { index[project.id] = structuredClone(original); Object.values(index[project.id].materials)[0].text += '\n篡改'; return { value: index }; });
        assert.equal((await probe()).code, 'MODEL_TASK_ONBOARDING_CHANGED');
        await mutateSemanticGovernanceState('mock_onboarding_v1', key, {}, index => { index[project.id] = original; return { value: index }; });
        assert.equal((await probe()).referenceState, 'valid');
        let reads = 0;
        configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
          const value = await asyncRuntimeStateRepository.readState(...args);
          if (args[0] === 'mock_onboarding_v1' && ++reads >= 2) value[project.id].handoff.taskId = 'changed-during-read';
          return value;
        } });
        try { assert.equal((await probe()).code, 'MODEL_TASK_ONBOARDING_CHANGED'); }
        finally { configureSemanticGovernanceRepository(null); }
        const storedTask = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[task.id];
        for (const patch of [{ key: 'foreign-key' }, { basisRevision: original.revision }, { fingerprint: '0'.repeat(64) }]) {
          await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[task.id] = { ...storedTask, onboardingSource: { ...storedTask.onboardingSource, ...patch } }; return { value: index }; });
          assert.equal((await probe()).code, 'MODEL_TASK_ONBOARDING_CHANGED');
        }
        await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[task.id] = storedTask; return { value: index }; });
        const again = await handoff(result.project); assert.equal(again.reused, true); assert.equal(again.taskId, task.id);
        const confirmationOptions = { modelId, taskId: task.id, identityScope: context.identityScope };
        assert.equal((await modelWorkspaces.confirmTask({ ...confirmationOptions, body: { confirmed: false, expectedTaskFingerprint: '0'.repeat(24) } })).status, 400);
        const staleConfirmation = await modelWorkspaces.confirmTask({ ...confirmationOptions, body: { confirmed: true, expectedTaskFingerprint: '0'.repeat(24) } });
        assert.equal(staleConfirmation.code, 'SEMANTIC_TASK_CONFIRMATION_STATE_CHANGED');
        assert.equal((await getSemanticOperationsTask({ taskId: task.id, identityScope: context.identityScope })).confirmation.state, 'not_issued');
        const record = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[task.id];
        const confirmation = await modelWorkspaces.confirmTask({ ...confirmationOptions, body: { confirmed: true, expectedTaskFingerprint: semanticTaskStateFingerprint(record) } });
        assert.ok(confirmation.confirmationToken, JSON.stringify(confirmation));
        assert.equal(confirmation.confirmationEvidenceState, 'ready');
        const executed = await executeSemanticOperationsTask({ taskId: task.id, role, identityScope: context.identityScope, confirmationToken: confirmation.confirmationToken });
        assert.equal(executed.task?.status, 'completed', JSON.stringify(executed));
        assert.equal(executed.result.snapshot.modelId, modelId); assert.equal(executed.result.proposal.modelId, modelId);
        assert.equal((await probe()).referenceState, 'valid');
        const trace = await getSemanticOperationsTaskTrace({ taskId: task.id, identityScope: context.identityScope, accessContext: { roleIds: ['executive'], buttonPermissionIds: ['meta_model.draft.save', 'meta_model.draft.review'] } });
        assert.equal(trace.integrity.valid, true); assert.equal(trace.status, 'completed'); assert.equal(trace.modelId, modelId);
        assert.equal(trace.events.filter(event => event.type === 'onboarding_handoff').length, 1);
        assert.equal(trace.events.filter(event => event.type === 'semantic_confirmation_issued').length, 1);
        await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { delete index[task.id]; return { value: index }; });
        assert.equal((await handoff(result.project)).code, 'MOCK_HANDOFF_REFERENCE_STALE');
      } });
    }
    assert.equal((await getOAMetaModelDraft()).objectTypes.some(object => object.id === 'CustomerOrder'), false);
  }));
});

test('committed handoff evidence reply loss recovers the same trace and task without duplicate events', async () => {
  const project = await handoffReady(); let writes = 0;
  configureAgentEvidenceTraceRepository({ ...asyncRuntimeStateRepository, async mutateState(...args) {
    const result = await asyncRuntimeStateRepository.mutateState(...args);
    if (args[0] === 'agent_evidence_traces' && ++writes === 2) throw new Error('Synthetic reply loss after evidence commit');
    return result;
  } });
  let pending;
  try { pending = await handoff(project); }
  finally { configureAgentEvidenceTraceRepository(null); }
  assert.equal(pending.code, 'SEMANTIC_HANDOFF_EVIDENCE_PENDING'); assert.equal(pending.taskMayHaveCommitted, true);
  const pendingRequest = { taskId: pending.taskId, identityScope: context.identityScope };
  assert.equal((await inside(() => runWithSemanticTenant(context.identityScope, () => issueSemanticOperationsTaskConfirmation(pendingRequest)))).code, 'SEMANTIC_TASK_EVIDENCE_PENDING');
  assert.equal((await inside(() => runWithSemanticTenant(context.identityScope, () => executeSemanticOperationsTask({ ...pendingRequest, role: getRole('executive') })))).code, 'SEMANTIC_TASK_EVIDENCE_PENDING');
  const latest = await inside(() => getMockOnboardingProject({ ...context, id: project.id }));
  const recovered = await handoff(latest.project);
  assert.equal(recovered.reused, true); assert.equal(recovered.taskId, pending.taskId); assert.equal(recovered.evidenceState, 'ready');
  const trace = await inside(() => runWithSemanticTenant(context.identityScope, () => getSemanticOperationsTaskTrace({ taskId: recovered.taskId, identityScope: context.identityScope, accessContext: { roleIds: ['executive'], buttonPermissionIds: ['meta_model.draft.save', 'meta_model.draft.review'] } })));
  assert.equal(trace.integrity.valid, true); assert.equal(trace.eventCount, 2);
  assert.equal(trace.events.filter(event => event.type === 'onboarding_handoff').length, 1);
  const again = await handoff(recovered.project); assert.equal(again.traceId, recovered.traceId);
  assert.equal(Object.keys(listState('semantic_operations_agent_tasks')[0].value).length, 1);
});

test('legacy handoff without a trace receives an explicit backfill rather than invented execution history', async () => {
  const result = await handoff(await handoffReady());
  await inside(() => runWithSemanticTenant(context.identityScope, () => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => {
    index[result.taskId].traceId = null; delete index[result.taskId].traceProvisioning; return { value: index };
  })));
  const backfilled = await handoff(result.project); assert.equal(backfilled.reused, true); assert.notEqual(backfilled.traceId, result.traceId);
  const trace = await inside(() => runWithSemanticTenant(context.identityScope, () => getSemanticOperationsTaskTrace({ taskId: result.taskId, identityScope: context.identityScope,
    accessContext: { roleIds: ['executive'], buttonPermissionIds: ['meta_model.draft.save', 'meta_model.draft.review'] } })));
  assert.equal(trace.integrity.valid, true); assert.equal(trace.eventCount, 2);
  assert.equal(trace.events.find(event => event.type === 'onboarding_handoff').details.backfilled, true);
  assert.equal(trace.events.some(event => event.type === 'semantic_execution_completed'), false);
});

test('missing ready evidence blocks execution before token consumption and is never silently recreated', async () => {
  const result = await handoff(await handoffReady());
  const request = { taskId: result.taskId, identityScope: context.identityScope };
  const confirmation = await inside(() => runWithSemanticTenant(context.identityScope, () => issueSemanticOperationsTaskConfirmation(request)));
  assert.ok(confirmation.confirmationToken);
  deleteState('agent_evidence_traces', result.traceId);
  const execution = await inside(() => runWithSemanticTenant(context.identityScope, () => executeSemanticOperationsTask({ ...request, role: getRole('executive'), confirmationToken: confirmation.confirmationToken })));
  assert.equal(execution.code, 'SEMANTIC_TASK_EVIDENCE_PENDING');
  const task = await getSemanticOperationsTask(request); assert.equal(task.confirmation.state, 'issued');
  assert.equal((await handoff(result.project)).code, 'SEMANTIC_HANDOFF_EVIDENCE_PENDING');
  assert.equal(listState('agent_evidence_traces').some(row => row.key === result.traceId), false);
  assert.equal((await getSemanticOperationsTask(request)).evidenceState, 'missing');
});

test('model project material changes invalidate adoption; revoked model preflight never creates a handoff task', async () => {
  resetRuntimeState(['semantic_model_registry']); await ready();
  await inside(() => runWithSemanticTenant(context.identityScope, async () => {
    const role = getRole('executive');
    await semanticModelRegistry.register({ role, identityScope: context.identityScope, body: { id: 'fulfillment-model', label: '履约模型', expectedRevision: 0 } });
    await semanticModelRegistry.withWorkspace({ role, identityScope: context.identityScope, modelId: 'fulfillment-model', work: async () => {
      const project = await handoffReady(); const result = await handoff(project); assert.equal(result.error, undefined, JSON.stringify(result));
      const confirmation = await issueSemanticOperationsTaskConfirmation({ taskId: result.taskId, identityScope: context.identityScope });
      const material = onboardingMaterials('fulfillment', tenantId).find(item => item.kind === 'requirements');
      const changed = await saveMockOnboardingMaterial({ ...context, id: project.id, body: { expectedRevision: result.project.revision, kind: material.kind, name: material.name, text: `${material.text}\n新的合成需求修订，必须重新验证连接与对齐。` } });
      assert.equal(changed.error, undefined, JSON.stringify(changed));
      const before = await draftFingerprint();
      const execution = await executeSemanticOperationsTask({ taskId: result.taskId, role, identityScope: context.identityScope, confirmationToken: confirmation.confirmationToken });
      assert.ok(JSON.stringify(execution).includes('MODEL_ONBOARDING_BINDING_REQUIRED')); assert.equal(await draftFingerprint(), before);
      const second = await handoffReady();
      const denied = await handoff(second, { readSource: async request => {
        const source = await readMockOnboardingSource(request);
        await mutateSemanticGovernanceState('semantic_model_registry', 'index', null, state => ({ value: { ...state, models: [] } }));
        return source;
      } });
      assert.equal(denied.code, 'SEMANTIC_MODEL_WORKSPACE_REVOKED');
      const key = JSON.stringify(['principal-role-v1', tenantId, 'alice', 'executive']);
      const projects = await readSemanticGovernanceState('mock_onboarding_v1', key, {});
      assert.equal(projects[second.id].handoff, undefined);
    } });
  }));
});

test('handoff atomically creates a pending Agent task from fresh HTTP records and reuses unchanged input', async () => {
  const project = await handoffReady(); const before = await draftFingerprint(); const result = await handoff(project);
  assert.ok(!result.error, result.error); assert.equal(result.reused, false);
  const task = await getSemanticOperationsTask({ taskId: result.taskId, identityScope: context.identityScope });
  assert.equal(task.status, 'waiting_confirmation'); assert.equal(task.confirmation.state, 'not_issued');
  assert.equal(task.proposal.objectTypes.length, 18); assert.equal(task.proposal.critic.status, 'passed', JSON.stringify(task.proposal.critic));
  assert.equal(task.proposal.mappingValidation.status, 'passed', JSON.stringify(task.proposal.mappingValidation));
  assert.equal(task.onboardingSource.sourceKind, 'local_mock_http'); assert.equal(task.onboardingSource.materialRevision, 6);
  assert.equal(await draftFingerprint(), before); assert.equal(listState('ontology_publication').length, 0);
  const again = await handoff(result.project); assert.equal(again.reused, true); assert.equal(again.taskId, result.taskId);
  assert.equal(Object.keys(listState('semantic_operations_agent_tasks')[0].value).length, 1);
});

test('handoff blocks missing references, cross-subject access and source failure without creating a task', async () => {
  let project = await ready(); project = (await saved(project, data().config)).project; project = (await connect(project)).project;
  assert.equal((await handoff(project)).code, 'MOCK_HANDOFF_EVIDENCE_REQUIRED');
  project = await handoffReady();
  const denied = await inside(() => handoffMockOnboardingModel({ ...context, identityScope: { ...context.identityScope, subjectId: 'other' }, id: project.id, body: { expectedRevision: project.revision } }));
  assert.ok(denied.error);
  assert.equal((await handoff(project, { readSource: async () => { throw new Error('fault'); } })).code, 'MOCK_HANDOFF_SOURCE_FAILED');
  assert.equal(listState('semantic_operations_agent_tasks').length, 0);
});

test('task detail route preserves owner and access policy checks for direct handoff links', async () => {
  const result = await handoff(await handoffReady());
  const call = async (identityScope, buttonPermissionIds, id = result.taskId) => {
    let response;
    await inside(() => handleGovernanceRoutes({ req: { method: 'GET' }, res: {}, url: new URL(`http://test/api/semantic-operations/tasks/${encodeURIComponent(id)}`), role: 'executive', agentIdentity: identityScope,
      effectiveAccess: { buttonPermissionIds }, send: (_res, status, value) => { response = { status, value }; } }));
    return response;
  };
  const visible = await call(context.identityScope, ['meta_model.draft.save']);
  assert.equal(visible.status, 200); assert.equal(visible.value.task.id, result.taskId);
  for (const [identityScope, permissions, id] of [[context.identityScope, [], result.taskId], [{ ...context.identityScope, subjectId: 'other' }, ['meta_model.draft.save'], result.taskId], [context.identityScope, ['meta_model.draft.save'], 'missing']]) {
    const denied = await call(identityScope, permissions, id);
    assert.equal(denied.status, 404); assert.equal(denied.value.task, undefined); assert.equal(denied.value.code, 'SEMANTIC_TASK_NOT_FOUND');
  }
});

test('handoff task requires explicit confirmation and only applies a candidate draft, never publishes', async () => {
  const project = await handoffReady(); const result = await handoff(project);
  const withinTask = work => inside(() => runWithSemanticTenant(context.identityScope, work));
  const denied = await withinTask(() => executeSemanticOperationsTask({ taskId: result.taskId, role: getRole('executive'), identityScope: context.identityScope }));
  assert.equal(denied.code, 'SEMANTIC_TASK_CONFIRMATION_INVALID');
  const confirmation = await withinTask(() => issueSemanticOperationsTaskConfirmation({ taskId: result.taskId, identityScope: context.identityScope }));
  assert.ok(confirmation.confirmationToken, JSON.stringify(confirmation));
  const executed = await withinTask(() => executeSemanticOperationsTask({ taskId: result.taskId, role: getRole('executive'), identityScope: context.identityScope, confirmationToken: confirmation.confirmationToken }));
  assert.equal(executed.task?.status, 'completed', executed.error || executed.result?.error);
  assert.equal(executed.result.proposal.status, 'applied_to_draft');
  assert.ok(executed.result.proposal.objectTypes.every(object => executed.result.draft.objectTypes.some(item => item.id === object.id))); assert.equal(listState('ontology_publication').length, 0);
  // Deliberately HUMAN-authored plan and TEST-only grants; neither is generated
  // by the handoff nor persisted/published as a business-ready model.
  const priorGrants = process.env.ONTOLOGY_RUNTIME_GRANTS_JSON;
  try {
    const draft = structuredClone(executed.result.draft);
    draft.scenario = { objective: '合成跨系统试算', questions: ['履约和授信缺口是多少？'], actionBindings: [], requireCaseReplay: true, decisionBindings: [], readPlans: [plan] };
    const objects = draft.objectTypes.filter(type => executed.result.proposal.objectTypes.some(item => item.id === type.id));
    process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ [tenantId]: { executive: { objects: Object.fromEntries(objects.map(type => [type.id, { system: type.sourceSystems[0], fields: type.fields, classifications: ['internal'] }])) } } });
    const source = await readMockOnboardingSource({ scenarioId: 'fulfillment', tenantId, projectId: project.id });
    await assert.rejects(inside(() => executeOntologyReadPlan({ draft, plan, target: 'ORD-T900', roleId: 'executive', scope: context.identityScope, retrieve: async () => { throw new Error('must not read without model policy'); } })), { message: 'READ_OBJECT_FORBIDDEN' });
    draft.accessPolicies = objects.map(type => ({ objectType: type.id, roles: ['executive'], effect: 'allow', condition: 'iam_scope' }));
    const persisted = await withinTask(() => saveOAMetaModelDraft(draft, getRole('executive')));
    assert.equal(persisted.error, undefined, persisted.error);
    const metadata = await inside(() => getMockOnboardingCalculations({ ...context, id: result.project.id }));
    assert.equal(metadata.blockers.length, 0); assert.equal(metadata.plans[0].id, plan.id);
    const request = { expectedRevision: result.project.revision, candidateFingerprint: metadata.candidateFingerprint, planId: plan.id, target: 'ORD-T900' };
    const calculate = (body = request, extra) => inside(() => previewMockOnboardingCalculation({ ...context, id: result.project.id, body }, extra));
    const preview = await calculate();
    assert.equal(preview.status, 'calculated', preview.error);
    assert.deepEqual(Object.fromEntries(preview.results.map(output => [output.id, output.value])), expected);
    assert.equal(preview.published, false); assert.equal(preview.records, undefined); assert.equal(preview.datasets, undefined);
    assert.equal((await calculate({ ...request, candidateFingerprint: 'old' })).code, 'MOCK_CALCULATION_DRAFT_STALE');
    assert.equal((await calculate({ ...request, target: 'MISSING' })).code, 'MOCK_CALCULATION_REJECTED');
    assert.equal((await calculate({ ...request, grants: {} })).code, 'MOCK_CALCULATION_INPUT_INVALID');
    const savedGrants = process.env.ONTOLOGY_RUNTIME_GRANTS_JSON; process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = '{}';
    let sourceReads = 0;
    assert.equal((await calculate(request, { readSource: async () => { sourceReads++; return source; } })).status, 403); assert.equal(sourceReads, 0);
    process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = savedGrants;
    const changed = await calculate(request, { readSource: async args => {
      const value = await readMockOnboardingSource(args);
      await withinTask(() => saveOAMetaModelDraft({ ...draft, scenario: { ...draft.scenario, readPlans: [{ ...plan, label: 'Changed during source read' }] } }, getRole('executive')));
      return value;
    } });
    assert.equal(changed.code, 'MOCK_CALCULATION_DRAFT_STALE');
    const adapter = createMockOnboardingOntologyAdapter({ source, draft, scope: context.identityScope, roleId: 'executive' });
    const replay = await inside(() => executeOntologyReadPlan({ draft, plan, target: 'ORD-T900', roleId: 'executive', scope: context.identityScope, retrieve: adapter.retrieve }));
    assert.deepEqual(Object.fromEntries(replay.results.map(item => [item.id, item.value])), expected);
    assert.equal(replay.executionAuthorized, false); assert.equal(replay.coverage.globalEnterpriseCoverage, false);
    for (const item of complexReplayCases(plan.id, source.records)) {
      const replayAdapter = createMockOnboardingOntologyAdapter({ source: { ...source, records: item.records }, draft, scope: context.identityScope, roleId: 'executive' });
      const run = () => inside(() => executeOntologyReadPlan({ draft, plan, target: item.target, roleId: 'executive', scope: context.identityScope, retrieve: replayAdapter.retrieve }));
      if (item.expectedError) await assert.rejects(run, { message: item.expectedError }, item.label);
      else assert.deepEqual(Object.fromEntries((await run()).results.map(output => [output.id, output.value])), item.expected, item.label);
    }
    assert.equal(listState('ontology_publication').length, 0);
  } finally { if (priorGrants === undefined) delete process.env.ONTOLOGY_RUNTIME_GRANTS_JSON; else process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = priorGrants; }
});

test('material changes during handoff reject all task/proposal commits and invalidate older adoption', async () => {
  let project = await handoffReady(); const originalDraft = await draftFingerprint(); const result = await handoff(project); project = result.project;
  const material = onboardingMaterials('fulfillment', tenantId)[0];
  project = (await inside(() => saveMockOnboardingMaterial({ ...context, id: project.id, body: { ...material, text: material.text + '\n新的业务范围必须重新交接。', expectedRevision: project.revision } }))).project;
  const applied = await inside(() => runWithSemanticTenant(context.identityScope, () => applySemanticOperationsProposal({ proposalId: result.proposalId, role: getRole('executive'), identityScope: context.identityScope })));
  assert.equal(applied.code, 'SEMANTIC_ONBOARDING_SOURCE_STALE'); assert.equal(await draftFingerprint(), originalDraft);
  project = await handoffReady();
  const source = await import('../src/services/mock-onboarding-source-service.js');
  const before = listState('semantic_operations_agent_proposals').length;
  const late = await handoff(project, { readSource: async args => {
    await inside(() => saveMockOnboardingMaterial({ ...context, id: project.id, body: { ...material, expectedRevision: project.revision } }));
    return source.readMockOnboardingSource(args);
  } });
  assert.equal(late.code, 'MOCK_ONBOARDING_REVISION_CONFLICT'); assert.equal(listState('semantic_operations_agent_proposals').length, before);
});

test('editor separates whitelisted dictionary metadata and bounded evidence texts, never returning sample rows', async () => {
  const project = await ready();
  const result = await read(project);
  assert.equal(result.tables.length, data().tables.length);
  const line = result.tables.find(table => table.name === 'SalesOrderLine');
  assert.ok(line.fields.some(field => field.reference === 'ItemSKU'));
  assert.ok(result.tables.every(table => Object.keys(table).every(key => ['name','system','primaryKey','granularity','fields'].includes(key))));
  assert.ok(result.tables.flatMap(table => table.fields).every(field => Object.keys(field).every(key => ['name','type','unit','reference','referenceField'].includes(key))));
  assert.equal(result.config, null); assert.equal(result.report, null);
  assert.deepEqual(result.evidenceSources.map(source => source.kind).sort(), ['api', 'dictionary', 'requirements', 'rules']);
  assert.ok(result.evidenceSources.every(source => /^[a-f0-9]{64}$/u.test(source.digest) && typeof source.text === 'string'));
});

test('material quote must match current version; changed material invalidates referenced mapping until rebound', async () => {
  let project = await ready(); const current = await read(project); const source = current.evidenceSources.find(source => source.kind === 'rules');
  const config = data().config;
  for (const key of ['identities','units','states']) for (const rule of config[key]) rule.materialEvidence = { kind: source.kind, digest: source.digest, quote: source.text.slice(0, 80) };
  const bad = structuredClone(config); bad.units[0].materialEvidence.quote = '这段没有出现在文档中的伪造摘录必须被拒绝';
  assert.equal((await saved(project, bad)).code, 'EVIDENCE_QUOTE_NOT_FOUND');
  bad.units[0].materialEvidence = { ...config.units[0].materialEvidence, digest: '0'.repeat(64) };
  assert.equal((await saved(project, bad)).code, 'EVIDENCE_STALE');
  bad.units[0].materialEvidence = { ...config.units[0].materialEvidence, kind: 'samples' };
  assert.equal((await saved(project, bad)).code, 'EVIDENCE_INVALID');
  project = (await saved(project, config)).project; project = (await connect(project)).project;
  assert.equal((await read(project)).report.materialEvidence.status, 'quotes_verified');
  const material = onboardingMaterials('fulfillment', tenantId).find(material => material.kind === 'rules');
  project = (await inside(() => saveMockOnboardingMaterial({ ...context, id: project.id, body: { ...material, text: `${material.text}\n版本修订：新的业务范围需要重新人工核对。`, expectedRevision: project.revision } }))).project;
  assert.equal((await read(project)).report, null);
  project = (await connect(project)).project;
  const stale = (await read(project)).report;
  assert.equal(project.connection.status, 'verified'); assert.equal(stale.status, 'needs_review');
  assert.ok(stale.materialEvidence.issues.every(issue => issue.code === 'EVIDENCE_STALE')); assert.deepEqual(stale.previews.units, []);
  const latest = (await read(project)).evidenceSources.find(source => source.kind === 'rules');
  for (const key of ['identities','units','states']) for (const rule of config[key]) rule.materialEvidence.digest = latest.digest;
  project = (await saved(project, config)).project; project = (await connect(project)).project;
  assert.equal((await read(project)).report.materialEvidence.status, 'quotes_verified');
});

test('free text explanations remain allowed but cannot masquerade as verified material references', async () => {
  let project = await ready(); project = (await saved(project, data().config)).project; project = (await connect(project)).project;
  const report = (await read(project)).report;
  assert.equal(report.status, 'validated_scope'); assert.equal(report.materialEvidence.status, 'needs_review');
  assert.ok(report.materialEvidence.issues.every(issue => issue.code === 'EVIDENCE_REQUIRED'));
});

test('human alignment checks both fixture scopes with independent packaging and weight expectations', () => {
  const a = evaluateMockAlignment(data()); assert.equal(a.status, 'validated_scope');
  assert.deepEqual(a.previews.units.map(row => row.value), [230, 40]);
  assert.deepEqual(a.previews.units.map(row => row.factor), [10, 20]);
  assert.equal(a.previews.states.find(row => row.objectType === 'ControlApproval').target, 'approved');
  assert.ok(a.counts.links > 0); assert.ok(a.unconfiguredObjects.includes('StockPosition'));
  const b = evaluateMockAlignment(data('quality_incident')); assert.equal(b.status, 'validated_scope');
  assert.deepEqual(b.previews.units.map(row => row.value), [120000, 80000]);
  assert.equal(b.previews.states[0].target, 'needs_retest');
});

test('unknown fields, empty rules, missing evidence, dimensions and fixed packaging factors reject configuration', () => {
  const input = data();
  for (const mutate of [
    c => { c.url = 'https://invalid'; }, c => { c.identities = []; c.units = []; c.states = []; },
    c => { c.units[0].factor = 10; }, c => { delete c.units[0].lookup; },
    c => { c.units[0].targetUnit = 'kg'; }, c => { c.units[0].evidence = ''; },
    c => { c.identities[0].granularity = 'order_line'; }, c => { c.states[1].values[0].target = 'executed'; },
    c => { c.states[0].values.push({ source: 'open', target: 'completed' }); },
    c => { c.units[0].lookup.viaField = 'order_id'; }
  ]) { const c = structuredClone(input.config); mutate(c); assert.ok(validateMockAlignment(c, input.tables).length); }
  for (const config of [null, [], {}, { ...input.config, units: null }]) assert.ok(validateMockAlignment(config, input.tables).length);
});

test('changed quantities use source values and missing or ambiguous packaging data cannot become zero', () => {
  const input = data(); const order = input.records.find(row => row.objectType === 'SalesOrderLine'); order.payload.qty = 7;
  assert.equal(evaluateMockAlignment(input).previews.units[0].value, 70);
  const sku = input.records.find(row => row.objectType === 'ItemSKU'); sku.payload.pieces_per_case = 0;
  let report = evaluateMockAlignment(input); assert.equal(report.status, 'needs_review'); assert.ok(report.issues.some(i => i.code === 'UNIT_FACTOR_UNRESOLVED')); assert.deepEqual(report.previews.units, []);
  sku.payload.pieces_per_case = 10; input.records.push(structuredClone(sku));
  report = evaluateMockAlignment(input); assert.equal(report.status, 'needs_review'); assert.ok(report.issues.some(i => i.code === 'IDENTITY_COLLISION'));
});

test('unmapped states and mixed units reject whole configured output, including rows beyond preview limit', () => {
  const input = data();
  const line = input.records.find(row => row.objectType === 'SalesOrderLine');
  for (let i = 0; i < 12; i++) input.records.push({ ...structuredClone(line), payload: { ...line.payload, line_id: `EXTRA-${i}`, status: i === 11 ? 'unexpected' : 'open' } });
  let report = evaluateMockAlignment(input); assert.equal(report.status, 'needs_review'); assert.ok(report.issues.some(i => i.code === 'STATE_UNMAPPED')); assert.deepEqual(report.previews.identities, []);
  input.records.at(-1).payload.status = 'open'; line.payload.unit = 'piece';
  report = evaluateMockAlignment(input); assert.ok(report.issues.some(i => i.code === 'UNIT_UNMAPPED'));
  input.config.units.push({ objectType: 'SalesOrderLine', field: 'qty', unitField: 'unit', sourceUnit: 'piece', targetUnit: 'piece', evidence: '逐行单位为件时保持原值，不套用箱规。' });
  report = evaluateMockAlignment(input); assert.equal(report.status, 'validated_scope'); assert.equal(report.previews.units[0].value, 23); assert.equal(report.previews.units.length, 10); assert.equal(report.counts.units, 14);
});

test('explicit aliases preserve typed IDs, cross-system identity and tenant namespaces without fuzzy merges', () => {
  const tables = ['Legacy', 'Current'].map((name, i) => ({ name, system: i ? 'WMS' : 'ERP', primaryKey: 'id', granularity: 'master', fields: [{ name: 'id', type: 'string' }] }));
  const config = { version: 'mock-alignment.v1', units: [], states: [], identities: tables.map((table, i) => ({ objectType: table.name, canonicalType: 'Material', granularity: 'master', evidence: '人工核对编码对照表。', aliases: [{ source: i ? 'NEW-1' : 'OLD-1', target: 'M-1' }] })) };
  const records = tables.map((table, i) => ({ tenantId, objectType: table.name, payload: { id: i ? 'NEW-1' : 'OLD-1' } }));
  const report = evaluateMockAlignment({ config, tables, records, tenantId }); assert.equal(report.status, 'validated_scope');
  assert.equal(report.previews.identities[0].canonicalId, report.previews.identities[1].canonicalId);
  const typed = structuredClone(config); typed.identities[0].aliases[0].target = 1; typed.identities[1].aliases[0].target = '1';
  const typedReport = evaluateMockAlignment({ config: typed, tables, records, tenantId });
  assert.notEqual(typedReport.previews.identities[0].canonicalId, typedReport.previews.identities[1].canonicalId);
  const other = evaluateMockAlignment({ config, tables, records: records.map(row => ({ ...row, tenantId: 'other' })), tenantId: 'other' });
  assert.notEqual(other.previews.identities[0].canonicalId, report.previews.identities[0].canonicalId);
  records[0].payload.id = 'unlisted'; assert.equal(evaluateMockAlignment({ config, tables, records, tenantId }).status, 'needs_review');
  records[0].tenantId = 'other'; assert.equal(evaluateMockAlignment({ config, tables, records, tenantId }).issues[0].code, 'SOURCE_SCOPE_INVALID');
  config.identities[0].aliases.push({ source: 'OLD-2', target: 'M-1' }); assert.ok(validateMockAlignment(config, tables).length);
});

test('configuration save is revision bound and actual HTTP validation is separate from publication', async () => {
  let project = await ready(); assert.equal((await read(project)).config, null);
  project = (await saved(project, onboardingAlignment('fulfillment'))).project;
  assert.equal(project.alignment.status, 'pending'); assert.equal(project.connection, null);
  project = (await connect(project)).project; assert.equal(project.connection.status, 'verified'); assert.equal(project.alignment.status, 'validated_scope');
  const report = (await read(project)).report; assert.equal(report.revision, project.revision); assert.equal(report.previews.units[0].value, 230);
  assert.equal((await saved({ ...project, revision: project.revision - 1 }, onboardingAlignment('fulfillment'))).status, 409);
  const material = onboardingMaterials('fulfillment', tenantId)[0];
  project = (await inside(() => saveMockOnboardingMaterial({ ...context, id: project.id, body: { ...material, expectedRevision: project.revision } }))).project;
  assert.equal((await read(project)).report, null); assert.equal(project.alignment.status, 'pending');
  for (const namespace of ['ontology_publication', 'oa_meta_model_runtime']) assert.equal(listState(namespace).length, 0);
});

test('unmapped business values do not masquerade as failed transport or successful business alignment', async () => {
  let project = await ready(); const config = onboardingAlignment('fulfillment'); config.states[0].values = [{ source: 'open', target: 'pending' }];
  project = (await saved(project, config)).project; project = (await connect(project)).project;
  assert.equal(project.connection.status, 'verified'); assert.equal(project.alignment.status, 'needs_review');
  assert.ok((await read(project)).report.issues.some(i => i.code === 'STATE_UNMAPPED'));
  project = (await saved(project, onboardingAlignment('fulfillment'))).project; assert.equal((await read(project)).report, null);
  project = (await connect(project)).project; assert.equal(project.alignment.status, 'validated_scope');
});

test('another subject cannot read mapping evidence; late reads cannot overwrite a changed mapping', async () => {
  let project = await ready(); project = (await saved(project, onboardingAlignment('fulfillment'))).project;
  const denied = await inside(() => getMockOnboardingAlignment({ ...context, identityScope: { tenantId, subjectId: 'other' }, id: project.id })); assert.equal(denied.status, 403);
  let unblock; let started; const entered = new Promise(resolve => { started = resolve; });
  const pending = connect(project, { readSource: async () => { started(); await new Promise(resolve => { unblock = resolve; }); throw new Error('discard this source'); } });
  await entered; const changed = await saved(project, onboardingAlignment('fulfillment')); unblock();
  assert.equal((await pending).status, 409); assert.equal((await read(changed.project)).report, null);
  const current = await inside(() => getMockOnboardingProject({ ...context, id: project.id })); assert.equal(current.project.revision, changed.project.revision);
});

test('dictionary revision cannot revive an incompatible mapping and production cannot read its evidence', async () => {
  let project = await ready(); project = (await saved(project, onboardingAlignment('fulfillment'))).project; project = (await connect(project)).project;
  const material = onboardingMaterials('fulfillment', tenantId)[2]; const dictionary = JSON.parse(material.text);
  dictionary.tables.find(table => table.name === 'ItemSKU').granularity = 'event'; material.text = JSON.stringify(dictionary);
  project = (await inside(() => saveMockOnboardingMaterial({ ...context, id: project.id, body: { ...material, expectedRevision: project.revision } }))).project;
  project = (await connect(project)).project; assert.equal(project.connection.status, 'verified'); assert.equal(project.alignment.status, 'needs_review');
  assert.ok((await read(project)).report.issues.some(issue => issue.code === 'MAPPING_INVALID'));
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production'; assert.equal((await read(project)).status, 403);
    assert.equal((await saved(project, onboardingAlignment('fulfillment'))).status, 403);
  } finally { process.env.NODE_ENV = previous; }
});

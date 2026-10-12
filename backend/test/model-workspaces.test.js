import test from 'node:test';
import assert from 'node:assert/strict';
import { modelWorkspaces } from '../src/domains/governance/model-workspaces.js';
import { semanticPreviewRequests } from '../src/domains/governance/model-preview-requests.js';
import { runWithSemanticTenant, semanticTenantStateKey } from '../src/services/semantic-tenant-context.js';
import { configureIAMRepository, runWithIAMStoreContext } from '../src/services/iam-store.js';
import { resetRuntimeState, writeState, deleteState } from '../src/repositories/runtime-state-repository.js';
import { iamWorkspaceKey } from '../src/services/iam-workspace-model.js';
import { asyncRuntimeStateRepository } from '../src/repositories/async-runtime-state-repository.js';
import { seedTenantIAM } from './helpers/tenant-iam-fixture.js';
import { createSemanticOperationsClient } from '../../packages/semantic-operations-sdk/src/index.js';
import { configureSemanticGovernanceRepository, mutateSemanticGovernanceState, readSemanticGovernanceState } from '../src/services/semantic-governance-store.js';
import { semanticModelRegistry } from '../src/services/semantic-model-registry.js';
import { extendSemanticMaterials, loadSemanticMaterials, discoverWorkspaceSchemas } from '../src/services/semantic-material-workspace-service.js';
import { semanticModelEvidence } from '../src/domains/governance/model-evidence.js';
import { modelSystemMaterials } from '../src/domains/governance/model-system-materials.js';
import { createSemanticOperationsTask, issueSemanticOperationsTaskConfirmation, executeSemanticOperationsTask, reviseSemanticOperationsTaskProposal, getSemanticOperationsTaskTrace, prepareOnboardingSemanticTask, semanticTaskStateFingerprint } from '../src/services/semantic-operations-task-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { createMockOnboardingProject, getMockOnboardingProject, listMockOnboarding, saveMockOnboardingMaterial, handoffMockOnboardingModel } from '../src/services/mock-onboarding-service.js';
import { mockOnboardingBasis } from '../src/services/mock-onboarding-basis.js';
import { createSemanticOperationsProposal, createSemanticOperationsProposalFromRequest, inspectSemanticOperationsObjectDependencies, applySemanticOperationsProposal, updateSemanticOperationsProposal, listSemanticOperationsSnapshots, rollbackSemanticOperationsSnapshot } from '../src/services/semantic-operations-agent-service.js';
import { getAgentEvidenceTrace, getAgentEvidenceTraceInternal, appendAgentEvidenceEvent, setAgentEvidenceTraceStatus, bindAgentEvidenceTraceRun, verifyAgentEvidenceTrace, configureAgentEvidenceTraceRepository } from '../src/services/agent-evidence-trace-service.js';

const identity = { tenantId: 'workspace-tests', subjectId: 'admin@demo.local' };
const within = work => runWithSemanticTenant(identity, work);

test('preview request status SDK validates selectors before IO and only sends an explicit model GET', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ state: 'reserved' }) }; };
  try {
    const client = createSemanticOperationsClient({ baseUrl: 'http://127.0.0.1:3001/api' });
    assert.throws(() => client.getPreviewRequestStatus('../foreign', '12345678-1234-4123-8123-123456789abc'), TypeError);
    assert.throws(() => client.getPreviewRequestStatus('model-a', 'bad'), TypeError); assert.equal(calls.length, 0);
    assert.throws(() => client.recoverPreviewEvidence('model-a', 'task-a', { confirmed: false, expectedTaskFingerprint: 'a'.repeat(24) }), TypeError);
    assert.throws(() => client.recoverPreviewEvidence('model-a', 'task-a', { confirmed: true, expectedTaskFingerprint: 'bad' }), TypeError); assert.equal(calls.length, 0);
    assert.equal((await client.getPreviewRequestStatus('model-a', '12345678-1234-4123-8123-123456789abc')).state, 'reserved');
    assert.equal(calls.length, 1); assert.match(calls[0].url, /\/models\/model-a\/preview-requests\/12345678-1234-4123-8123-123456789abc$/u);
    assert.equal(calls[0].options.body, undefined); assert.equal(calls[0].options.headers['x-semantic-model'], undefined);
    await client.recoverPreviewEvidence('model-a', 'task-a', { confirmed: true, expectedTaskFingerprint: 'a'.repeat(24) });
    assert.equal(calls.length, 2); assert.equal(calls[1].options.method, 'POST'); assert.match(calls[1].url, /\/preview-evidence-recover$/u);
    const body = { confirmed: true, requestId: '12345678-1234-4123-8123-123456789abc', text: '根据WMS接口建立库存语义模型', systemCodes: ['WMS'], expectedDraftFingerprint: 'a'.repeat(24) };
    assert.throws(() => client.createStructuredPreview('model-a', { ...body, provider: 'foreign' }), TypeError);
    assert.throws(() => client.createStructuredPreview('model-a', { ...body, attachments: {} }), TypeError);
    assert.throws(() => client.createStructuredPreview('model-a', { ...body, systemCodes: ['WMS', 'WMS'] }), TypeError); assert.equal(calls.length, 2);
    await client.createStructuredPreview('model-a', body); assert.equal(calls.length, 3); assert.equal(calls[2].options.method, 'POST');
    assert.match(calls[2].url, /\/structured-preview-tasks$/u);
    assert.throws(() => client.inspectModelSources('oa-governance', { systemCodes: ['WMS'] }), TypeError);
    assert.throws(() => client.bindModelSources('model-a', { systemCodes: ['WMS'], confirmed: false, expectedRevision: 0, expectedSourceFingerprint: 'a'.repeat(64) }), TypeError);
    assert.throws(() => client.inspectModelSources('model-a', { systemCodes: ['WMS'], endpoint: 'foreign' }), TypeError); assert.equal(calls.length, 3);
    await client.inspectModelSources('model-a', { systemCodes: ['WMS'] });
    await client.bindModelSources('model-a', { systemCodes: ['WMS'], confirmed: true, expectedRevision: 0, expectedSourceFingerprint: 'a'.repeat(64) });
    assert.equal(calls.length, 5); assert.ok(calls.slice(3).every(call => call.options.method === 'POST'));
    const recovery = { confirmed: true, inputFingerprint: 'a'.repeat(64), expectedCheckpointFingerprint: 'b'.repeat(64), expectedDraftFingerprint: 'c'.repeat(24) };
    for (const name of ['inspectPreparedPreview', 'resumePreparedPreview', 'recoverPreviewCommit']) {
      assert.throws(() => client[name]('model-a', body.requestId, { ...recovery, requestId: body.requestId }), TypeError);
      assert.throws(() => client[name]('model-a', 'bad', recovery), TypeError);
      assert.throws(() => client[name]('model-a', body.requestId, { ...recovery, confirmed: false }), TypeError);
    }
    assert.equal(calls.length, 5);
    await client.inspectPreparedPreview('model-a', body.requestId, recovery); await client.resumePreparedPreview('model-a', body.requestId, recovery); await client.recoverPreviewCommit('model-a', body.requestId, recovery);
    assert.equal(calls.length, 8); assert.ok(calls.slice(5).every(call => call.options.method === 'POST'));
  } finally { globalThis.fetch = original; }
});

test('preview request reservations isolate models and owners, reject changed input and never restart an occupied slot', async () => {
  await within(async () => {
    for (const [expectedRevision, id] of ['preview-reservation-a', 'preview-reservation-b'].entries()) await modelWorkspaces.register({ identityScope: identity, body: { id, label: id, expectedRevision } });
    const args = { identityScope: identity, roleId: 'executive', requestId: '12345678-1234-4123-8123-123456789abc', inputFingerprint: 'a'.repeat(64) };
    const workspace = (modelId, work) => semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: identity, modelId, work });
    let firstKey;
    await workspace('preview-reservation-a', async () => {
      const results = await Promise.all([semanticPreviewRequests.reserve(args), semanticPreviewRequests.reserve(args)]);
      assert.equal(results.filter(result => result.preparationAllowed).length, 1); assert.equal(results.filter(result => result.reused).length, 1);
      firstKey = results[0].requestKey; assert.equal(results[1].requestKey, firstKey);
      const pendingStatus = await modelWorkspaces.previewRequestStatus({ identityScope: identity, modelId: 'preview-reservation-a', requestId: args.requestId });
      assert.equal(pendingStatus.state, 'reserved'); assert.equal(pendingStatus.blocker, 'preparation_checkpoint_absent'); assert.equal(pendingStatus.automaticTakeoverAllowed, false);
      assert.equal((await modelWorkspaces.previewRequestStatus({ identityScope: identity, modelId: 'preview-reservation-a', requestId: '52345678-1234-4123-8123-123456789abc' })).status, 404);
      assert.equal((await semanticPreviewRequests.inspectStatus({ ...args, identityScope: { ...identity, subjectId: 'other@demo.local' } })).status, 404);
      assert.equal((await semanticPreviewRequests.reserve({ ...args, inputFingerprint: 'b'.repeat(64) })).code, 'MODEL_PREVIEW_REQUEST_CONFLICT');
      assert.equal((await semanticPreviewRequests.reserve({ ...args, requestId: 'bad' })).status, 400);
      const other = await semanticPreviewRequests.reserve({ ...args, identityScope: { ...identity, subjectId: 'other@demo.local' } });
      assert.equal(other.preparationAllowed, true); assert.notEqual(other.requestKey, firstKey);
      const prepared = { id: 'preview-atomic-task', modelId: 'preview-reservation-a', owner: JSON.stringify([identity.tenantId, identity.subjectId]), originRoleId: 'executive',
        creationMode: 'structured_preview', planning: { provider: 'none' }, status: 'waiting_confirmation', confirmation: { state: 'not_issued' }, traceId: 'synthetic-reserved-trace' };
      const checkpoint = await semanticPreviewRequests.checkpointPreparedTask({ ...args, task: prepared });
      assert.equal(checkpoint.state, 'prepared'); assert.equal(checkpoint.reused, false);
      const preparedStatus = await semanticPreviewRequests.inspectStatus(args);
      assert.equal(preparedStatus.state, 'prepared'); assert.equal(preparedStatus.checkpointFingerprint, checkpoint.checkpointFingerprint);
      assert.doesNotMatch(JSON.stringify(preparedStatus), /preparedTask|materialContext|objectTypes|owner|traceId/);
      const loadArgs = { ...args, expectedCheckpointFingerprint: checkpoint.checkpointFingerprint };
      const loaded = await semanticPreviewRequests.loadPreparedTask(loadArgs);
      assert.equal(loaded.state, 'prepared'); assert.deepEqual(loaded.task, prepared); assert.equal(loaded.executionEnabled, false);
      loaded.task.title = '返回值不能改写检查点';
      assert.deepEqual((await semanticPreviewRequests.loadPreparedTask(loadArgs)).task, prepared);
      assert.equal((await semanticPreviewRequests.loadPreparedTask({ ...loadArgs, expectedCheckpointFingerprint: '0'.repeat(64) })).code, 'MODEL_PREVIEW_PREPARED_INVALID');
      assert.equal((await semanticPreviewRequests.loadPreparedTask({ ...loadArgs, identityScope: { ...identity, subjectId: 'other@demo.local' } })).code, 'MODEL_PREVIEW_PREPARED_INVALID');
      const slotOwner = JSON.stringify([identity.tenantId, identity.subjectId]);
      await mutateSemanticGovernanceState('semantic_preview_requests', slotOwner, {}, slots => { slots[firstKey].preparedTask.title = '篡改'; return { value: slots }; });
      assert.equal((await semanticPreviewRequests.loadPreparedTask(loadArgs)).code, 'MODEL_PREVIEW_PREPARED_INVALID');
      await mutateSemanticGovernanceState('semantic_preview_requests', slotOwner, {}, slots => { slots[firstKey].preparedTask = prepared; return { value: slots }; });
      let checkpointStoreKey;
      configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, async readState(...settings) {
        const value = await asyncRuntimeStateRepository.readState(...settings);
        if (settings[0] === 'semantic_preview_requests') checkpointStoreKey = settings[1];
        if (settings[0] === 'semantic_operations_agent_tasks' && checkpointStoreKey) await asyncRuntimeStateRepository.mutateState('semantic_preview_requests', checkpointStoreKey, {}, slots => {
          slots[firstKey].preparedTask.title = '读取等待后修改'; return { value: slots };
        });
        return value;
      } });
      try { assert.equal((await semanticPreviewRequests.loadPreparedTask(loadArgs)).code, 'MODEL_PREVIEW_CHECKPOINT_CHANGED'); }
      finally {
        configureSemanticGovernanceRepository(null);
        await mutateSemanticGovernanceState('semantic_preview_requests', slotOwner, {}, slots => { slots[firstKey].preparedTask = prepared; return { value: slots }; });
      }
      assert.equal((await semanticPreviewRequests.checkpointPreparedTask({ ...args, task: prepared })).reused, true);
      assert.equal((await semanticPreviewRequests.reserve(args)).state, 'prepared');
      assert.equal((await semanticPreviewRequests.reserve(args)).preparationAllowed, false);
      assert.equal((await semanticPreviewRequests.checkpointPreparedTask({ ...args, task: { ...prepared, title: 'modified' } })).code, 'MODEL_PREVIEW_CHECKPOINT_CONFLICT');
      assert.equal((await semanticPreviewRequests.checkpointPreparedTask({ ...args, task: { ...prepared, materialContext: 'x'.repeat(256 * 1024) } })).code, 'MODEL_PREVIEW_CHECKPOINT_INPUT_INVALID');
      assert.equal((await semanticPreviewRequests.commitPreparedTask({ ...args, task: { ...prepared, title: 'modified' } })).code, 'MODEL_PREVIEW_CHECKPOINT_CONFLICT');
      const committed = await semanticPreviewRequests.commitPreparedTask({ ...args, task: prepared });
      assert.equal(committed.state, 'committed'); assert.equal(committed.evidenceState, 'pending');
      assert.equal((await semanticPreviewRequests.inspectStatus(args)).taskId, prepared.id);
      assert.equal((await semanticPreviewRequests.loadPreparedTask(loadArgs)).code, 'MODEL_PREVIEW_PREPARED_INVALID');
      const stored = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[prepared.id];
      assert.equal(stored.creationRequestId, args.requestId); assert.equal(stored.traceProvisioning, 'pending');
      assert.equal((await readSemanticGovernanceState('semantic_preview_requests', JSON.stringify([identity.tenantId, identity.subjectId]), {}))[committed.requestKey].preparedTask, undefined);
      assert.equal(await semanticPreviewRequests.verifyCommittedTask(stored), true);
      const receiptOwner = JSON.stringify([identity.tenantId, identity.subjectId]);
      await mutateSemanticGovernanceState('semantic_preview_requests', receiptOwner, {}, slots => { slots[committed.requestKey].taskId = 'foreign-task'; return { value: slots }; });
      assert.equal(await semanticPreviewRequests.verifyCommittedTask(stored), false);
      await mutateSemanticGovernanceState('semantic_preview_requests', receiptOwner, {}, slots => { slots[committed.requestKey].taskId = stored.id; return { value: slots }; });
      let receiptReads = 0;
      configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, async readState(...settings) {
        const value = await asyncRuntimeStateRepository.readState(...settings);
        if (settings[0] === 'semantic_preview_requests' && ++receiptReads === 1) await asyncRuntimeStateRepository.mutateState(settings[0], settings[1], {}, slots => {
          slots[committed.requestKey].inputFingerprint = 'b'.repeat(64); return { value: slots };
        });
        return value;
      } });
      try { assert.equal(await semanticPreviewRequests.verifyCommittedTask(stored), false); }
      finally {
        configureSemanticGovernanceRepository(null);
        await mutateSemanticGovernanceState('semantic_preview_requests', receiptOwner, {}, slots => { slots[committed.requestKey].inputFingerprint = args.inputFingerprint; return { value: slots }; });
      }
      assert.equal((await semanticPreviewRequests.reserve(args)).taskId, prepared.id);
      assert.equal((await semanticPreviewRequests.commitPreparedTask({ ...args, task: { ...prepared, id: 'second-task' } })).code, 'MODEL_PREVIEW_REQUEST_ALREADY_COMMITTED');
      const collisionArgs = { ...args, requestId: '32345678-1234-4123-8123-123456789abc' };
      await semanticPreviewRequests.reserve(collisionArgs);
      assert.equal((await semanticPreviewRequests.commitPreparedTask({ ...collisionArgs, task: prepared })).code, 'MODEL_PREVIEW_TASK_COLLISION');
      assert.equal((await semanticPreviewRequests.reserve(collisionArgs)).state, 'reserved');
      const requests = await readSemanticGovernanceState('semantic_preview_requests', JSON.stringify([identity.tenantId, identity.subjectId]), {});
      assert.doesNotMatch(JSON.stringify(requests), /requestText|attachments|confirmationToken/);
      // Fill this owner's isolated slot collection through the storage port;
      // existing reservations still resolve without evicting audit history.
      await mutateSemanticGovernanceState('semantic_preview_requests', JSON.stringify([identity.tenantId, identity.subjectId]), {}, slots => {
        for (let n = Object.keys(slots).length; n < 200; n++) slots[`synthetic-${n}`] = { state: 'reserved' };
        return { value: slots };
      });
      assert.equal((await semanticPreviewRequests.reserve({ ...args, requestId: '22345678-1234-4123-8123-123456789abc' })).code, 'MODEL_PREVIEW_REQUEST_CAPACITY');
      assert.equal((await semanticPreviewRequests.reserve(args)).preparationAllowed, false);
    });
    await workspace('preview-reservation-b', async () => {
      const second = await semanticPreviewRequests.reserve(args); assert.equal(second.preparationAllowed, true); assert.notEqual(second.requestKey, firstKey);
    });
  });
});

test('Mock projects are model scoped from creation and reject forged records without copying default projects', async () => {
  await runWithIAMStoreContext(() => within(async () => {
    const options = { identityScope: identity, role: getRole('executive') };
    const legacy = await createMockOnboardingProject({ ...options, body: { scenarioId: 'fulfillment', name: '默认合成项目' } });
    assert.equal(legacy.project.modelId, 'oa-governance');
    for (const [expectedRevision, id] of ['warehouse-model', 'finance-model'].entries()) await modelWorkspaces.register({ identityScope: identity, body: { id, label: id, expectedRevision } });
    const workspace = (modelId, work) => semanticModelRegistry.withWorkspace({ role: options.role, identityScope: identity, modelId, work });
    let created;
    await workspace('warehouse-model', async () => {
      assert.equal((await listMockOnboarding(options)).projects.length, 0);
      assert.equal((await getMockOnboardingProject({ ...options, id: legacy.project.id })).code, 'MOCK_ONBOARDING_NOT_FOUND');
      created = await createMockOnboardingProject({ ...options, body: { scenarioId: 'fulfillment', name: '仓储合成项目' } });
      assert.equal(created.project.modelId, 'warehouse-model');
      const saved = await saveMockOnboardingMaterial({ ...options, id: created.project.id, body: { expectedRevision: 1, kind: 'requirements', name: '需求.txt', text: '仅模拟企业订单缺货风险分析、库存范围与数量核对，不使用真实企业信息，不自动执行业务写入。' } });
      assert.equal(saved.project.revision, 2);
      assert.equal((await handoffMockOnboardingModel({ ...options, id: created.project.id, body: { expectedRevision: 2 } })).code, 'MOCK_HANDOFF_NOT_READY');
      const key = JSON.stringify(['principal-role-v1', identity.tenantId, identity.subjectId, 'executive']);
      await mutateSemanticGovernanceState('mock_onboarding_v1', key, {}, index => { index[created.project.id].modelId = 'finance-model'; return { value: index }; });
      assert.equal((await getMockOnboardingProject({ ...options, id: created.project.id })).code, 'MOCK_ONBOARDING_NOT_FOUND');
    });
    await workspace('finance-model', async () => {
      assert.equal((await listMockOnboarding(options)).projects.length, 0);
      assert.equal((await getMockOnboardingProject({ ...options, id: created.project.id })).code, 'MOCK_ONBOARDING_NOT_FOUND');
    });
    assert.equal((await listMockOnboarding(options)).projects.length, 1);
    const basis = { materialRevision: 1, materials: {} };
    assert.equal(mockOnboardingBasis(basis), mockOnboardingBasis({ ...basis, modelId: 'oa-governance' }));
    assert.notEqual(mockOnboardingBasis({ ...basis, modelId: 'warehouse-model' }), mockOnboardingBasis({ ...basis, modelId: 'finance-model' }));
  }), identity.tenantId);
});

test('Mock project reads discard results when registration disappears during storage lookup', async () => {
  await runWithIAMStoreContext(() => within(async () => {
    await modelWorkspaces.register({ identityScope: identity, body: { id: 'warehouse-model', label: '仓储模型', expectedRevision: 0 } });
    const options = { identityScope: identity, role: getRole('executive') };
    const workspace = work => semanticModelRegistry.withWorkspace({ role: options.role, identityScope: identity, modelId: 'warehouse-model', work });
    const created = await workspace(() => createMockOnboardingProject({ ...options, body: { scenarioId: 'fulfillment', name: '隔离项目' } }));
    configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
      const value = await asyncRuntimeStateRepository.readState(...args);
      if (args[0] === 'mock_onboarding_v1') await mutateSemanticGovernanceState('semantic_model_registry', 'index', null, state => ({ value: { ...state, models: [] } }));
      return value;
    } });
    const result = await workspace(() => getMockOnboardingProject({ ...options, id: created.project.id }));
    assert.equal(result.code, 'SEMANTIC_MODEL_WORKSPACE_REVOKED'); assert.equal(result.project, undefined);
  }), identity.tenantId);
});

test('request proposal creation rejects registration revoked after asynchronous proposal storage', async () => {
  await within(async () => {
    await modelWorkspaces.register({ identityScope: identity, body: { id: 'warehouse-model', label: '仓储模型', expectedRevision: 0 } });
    let writes = 0;
    configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, async mutateState(...args) {
      const result = await asyncRuntimeStateRepository.mutateState(...args);
      if (args[0] === 'semantic_operations_agent_proposals') {
        writes++;
        await mutateSemanticGovernanceState('semantic_model_registry', 'index', null, state => ({ value: { ...state, models: [] } }));
      }
      return result;
    } });
    const specification = { openapi: '3.0.0', 'x-source-system': 'WMS', components: { schemas: { InventoryLot: { type: 'object', properties: { inventoryLotId: { type: 'string', 'x-primary-key': true } } } } } };
    await assert.rejects(semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: identity, modelId: 'warehouse-model', work: () => createSemanticOperationsProposalFromRequest({
      body: { text: '根据WMS接口建立模型' }, role: getRole('executive'), identityScope: identity, scopeSystems: ['WMS'], workspaceDocuments: [{ name: 'wms.json', mimeType: 'application/json', text: JSON.stringify(specification) }]
    }) }), error => error.code === 'SEMANTIC_MODEL_WORKSPACE_REVOKED');
    assert.equal(writes, 1);
  });
});

test('registered model cannot adopt or prepare a legacy onboarding project without model binding', async () => {
  await within(async () => {
    await modelWorkspaces.register({ identityScope: identity, body: { id: 'warehouse-model', label: '仓储模型', expectedRevision: 0 } });
    await semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: identity, modelId: 'warehouse-model', work: async () => {
      assert.equal((await prepareOnboardingSemanticTask({ identityScope: identity })).code, 'MODEL_ONBOARDING_BINDING_REQUIRED');
      const proposal = await createSemanticOperationsProposal({ input: '建立供应商模型', roleId: 'executive', identityScope: identity, scopeSystems: ['ERP'] });
      await mutateSemanticGovernanceState('semantic_operations_agent_proposals', `proposal-${proposal.id}`, null, stored => ({ value: { ...stored, onboardingBasis: { projectId: 'legacy-project' } } }));
      assert.equal((await applySemanticOperationsProposal({ proposalId: proposal.id, identityScope: identity, role: getRole('executive') })).code, 'MODEL_ONBOARDING_BINDING_REQUIRED');
    } });
  });
});

test('complete bound Mock API model supports human revision, confirmation, adoption, snapshot and evidence', async () => {
  const previous = { mode: process.env.AGENT_RUNTIME_MODE, source: process.env.AGENT_MODEL_CONFIG_SOURCE };
  process.env.AGENT_RUNTIME_MODE = 'mock'; process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
  try { await within(async () => {
    await modelWorkspaces.register({ identityScope: identity, body: { id: 'warehouse-model', label: '仓储模型', expectedRevision: 0 } });
    const specification = { openapi: '3.0.0', 'x-source-system': 'WMS', paths: {}, components: { schemas: {
      InventoryLot: { type: 'object', required: ['inventoryLotId'], properties: {
        inventoryLotId: { type: 'string', 'x-primary-key': true }, warehouseCode: { type: 'string' }, quantity: { type: 'number' }
      } }
    } } };
    writeState('system_access_runtime', semanticTenantStateKey('system_documents'), { WMS: { documents: [{ name: 'wms-openapi.json', mimeType: 'application/json', text: JSON.stringify(specification) }], warnings: [] } });
    const options = { identityScope: identity, modelId: 'warehouse-model' };
    const preview = await modelSystemMaterials.inspect({ ...options, body: { systemCodes: ['WMS'] } });
    assert.equal((await modelSystemMaterials.bind({ ...options, body: { systemCodes: ['WMS'], confirmed: true, expectedRevision: 0, expectedSourceFingerprint: preview.sourceFingerprint } })).error, undefined);
    await semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: identity, modelId: 'warehouse-model', work: async () => {
      const role = getRole('executive'); const accessContext = { roleIds: ['executive'], buttonPermissionIds: ['meta_model.draft.save', 'meta_model.draft.review'] };
      const task = await createSemanticOperationsTask({ identityScope: identity, role, accessContext, body: { text: '根据WMS接口建立库存批次语义模型', systemCodes: ['WMS'] } });
      assert.equal(task.error, undefined, JSON.stringify(task)); assert.equal(task.proposal.critic.status, 'passed', JSON.stringify(task.proposal.critic));
      const objects = structuredClone(task.proposal.objectTypes); objects[0].label = '经人工确认的库存批次';
      const revised = await reviseSemanticOperationsTaskProposal({ taskId: task.id, identityScope: identity, role,
        body: { revision: task.proposal.revision, objectTypes: objects, relationshipTypes: task.proposal.relationshipTypes } });
      assert.equal(revised.error, undefined, JSON.stringify(revised));
      const confirmation = await issueSemanticOperationsTaskConfirmation({ taskId: task.id, identityScope: identity, accessContext });
      assert.equal(confirmation.error, undefined, JSON.stringify(confirmation));
      const executed = await executeSemanticOperationsTask({ taskId: task.id, identityScope: identity, role, accessContext, confirmationToken: confirmation.confirmationToken });
      assert.equal(executed.error, undefined, JSON.stringify(executed));
      const draft = (await modelWorkspaces.draft(options)).draft;
      assert.equal(draft.objectTypes.find(object => object.id === 'InventoryLot').label, objects[0].label);
      const snapshots = await listSemanticOperationsSnapshots({ identityScope: identity });
      assert.ok(snapshots.some(snapshot => snapshot.proposalId === task.proposal.id && snapshot.modelId === 'warehouse-model'));
      const evidence = await getSemanticOperationsTaskTrace({ taskId: task.id, identityScope: identity, accessContext });
      assert.equal(evidence.modelId, 'warehouse-model'); assert.equal(evidence.integrity.valid, true); assert.equal(evidence.status, 'completed');
    } });
    assert.equal((await modelWorkspaces.draft({ ...options, modelId: 'oa-governance' })).draft.objectTypes.some(object => object.id === 'InventoryLot'), false);
  }); } finally {
    if (previous.mode === undefined) delete process.env.AGENT_RUNTIME_MODE; else process.env.AGENT_RUNTIME_MODE = previous.mode;
    if (previous.source === undefined) delete process.env.AGENT_MODEL_CONFIG_SOURCE; else process.env.AGENT_MODEL_CONFIG_SOURCE = previous.source;
    resetRuntimeState(['system_access_runtime', 'semantic_model_system_materials']);
  }
});

test('registered task consumes only explicit sources, never persists system documents as inherited uploads', async () => {
  const priorMode = process.env.AGENT_RUNTIME_MODE; const priorSource = process.env.AGENT_MODEL_CONFIG_SOURCE;
  process.env.AGENT_RUNTIME_MODE = 'mock'; process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
  try { await within(async () => {
    await modelWorkspaces.register({ identityScope: identity, body: { id: 'quality-model', label: '质量模型', expectedRevision: 0 } });
    const doc = (system, objectId) => ({ name: `${system}.json`, mimeType: 'application/json', text: JSON.stringify({ openapi: '3.0.0', 'x-source-system': system,
      components: { schemas: { [objectId]: { type: 'object', 'x-primary-key': 'id', properties: { id: { type: 'string' }, name: { type: 'string' } } } } } }) });
    writeState('system_access_runtime', semanticTenantStateKey('system_documents'), { ERP: { documents: [doc('ERP', 'RawMaterial')], warnings: [] }, QMS: { documents: [doc('QMS', 'QualityEvent')], warnings: [] } });
    const options = { identityScope: identity, modelId: 'quality-model' };
    const preview = await modelSystemMaterials.inspect({ ...options, body: { systemCodes: ['ERP', 'QMS'] } });
    await modelSystemMaterials.bind({ ...options, body: { systemCodes: ['ERP', 'QMS'], confirmed: true, expectedRevision: 0, expectedSourceFingerprint: preview.sourceFingerprint } });
    const selected = await modelSystemMaterials.consume({ ...options, body: { systemCodes: ['ERP'] } });
    assert.deepEqual(selected.systemCodes, ['ERP']); assert.equal(selected.documents.length, 1);
    assert.equal((await modelSystemMaterials.consume({ ...options, body: { systemCodes: ['WMS'] } })).code, 'MODEL_SOURCE_SCOPE_NOT_BOUND');
    await semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: identity, modelId: 'quality-model', work: async () => {
      const task = await createSemanticOperationsTask({ identityScope: identity, role: { id: 'executive' }, accessContext: { roleIds: ['executive'], buttonPermissionIds: ['meta_model.draft.save'] },
        body: { text: '根据ERP接口建立原料语义模型', systemCodes: ['ERP'] } });
      assert.equal(task.error, undefined, JSON.stringify(task));
      assert.deepEqual(task.sourceDiscovery.sources.map(source => source.code), ['ERP']);
      assert.ok(task.proposal.objectTypes.some(object => object.id === 'RawMaterial'));
      assert.equal(task.proposal.objectTypes.some(object => object.id === 'QualityEvent'), false);
      const uploaded = await loadSemanticMaterials(task.materialRefs, identity, 'executive');
      assert.equal(uploaded.some(document => document.mimeType === 'application/json'), false);
      const accessContext = { roleIds: ['executive'], buttonPermissionIds: ['meta_model.draft.save', 'meta_model.draft.review', 'meta_model.draft.validate'] };
      assert.equal((await issueSemanticOperationsTaskConfirmation({ taskId: task.id, identityScope: identity, accessContext })).code, 'SEMANTIC_TASK_PROPOSAL_BLOCKED');
      // Isolated execution fixture: a validate task carrying the actual consumed
      // source binding, not a fabricated successful proposal/schema review.
      const validationTask = await createSemanticOperationsTask({ identityScope: identity, role: { id: 'executive' }, accessContext, body: { text: '校验当前草稿' } });
      await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => {
        index[validationTask.id].systemMaterialBinding = { revision: selected.revision, sourceFingerprint: selected.sourceFingerprint, systemCodes: selected.systemCodes };
        return { value: index };
      });
      const confirmation = await issueSemanticOperationsTaskConfirmation({ taskId: validationTask.id, identityScope: identity, accessContext });
      assert.equal(confirmation.error, undefined, JSON.stringify(confirmation));
      assert.equal((await modelWorkspaces.inspectTaskReferences({ ...options, taskId: validationTask.id })).referenceState, 'valid');
      await modelSystemMaterials.bind({ ...options, body: { systemCodes: ['ERP', 'QMS'], confirmed: true, expectedRevision: 1, expectedSourceFingerprint: preview.sourceFingerprint } });
      assert.equal((await modelWorkspaces.inspectTaskReferences({ ...options, taskId: validationTask.id })).code, 'MODEL_TASK_SOURCE_CHANGED');
      const before = (await modelWorkspaces.draft(options)).draft.fingerprint;
      const executed = await executeSemanticOperationsTask({ taskId: validationTask.id, identityScope: identity, role: { id: 'executive' }, accessContext, confirmationToken: confirmation.confirmationToken });
      assert.ok(JSON.stringify(executed).includes('MODEL_SOURCE_TASK_BINDING_CHANGED'));
      assert.equal((await modelWorkspaces.draft(options)).draft.fingerprint, before);
    } });
  }); } finally {
    if (priorMode === undefined) delete process.env.AGENT_RUNTIME_MODE; else process.env.AGENT_RUNTIME_MODE = priorMode;
    if (priorSource === undefined) delete process.env.AGENT_MODEL_CONFIG_SOURCE; else process.env.AGENT_MODEL_CONFIG_SOURCE = priorSource;
    resetRuntimeState(['system_access_runtime', 'semantic_model_system_materials']);
  }
});

test('system documents require explicit model binding and fresh source fingerprints; no legacy pool fallback', async () => {
  await within(async () => {
    for (const [expectedRevision, id] of ['quality-model', 'stock-model'].entries()) await modelWorkspaces.register({ identityScope: identity, body: { id, label: id, expectedRevision } });
    const key = semanticTenantStateKey('system_documents');
    const source = { ERP: { documents: [{ name: 'mock-api.json', mimeType: 'application/json', text: '{"synthetic":true}' }], warnings: [] } };
    writeState('system_access_runtime', key, source);
    try {
      const options = { identityScope: identity, modelId: 'quality-model' };
      assert.equal((await modelSystemMaterials.load(options)).code, 'MODEL_SOURCE_NOT_BOUND');
      const preview = await modelSystemMaterials.inspect({ ...options, body: { systemCodes: ['ERP'] } });
      assert.equal(preview.documentCount, 1); assert.equal(preview.documents, undefined);
      const body = { systemCodes: ['ERP'], confirmed: true, expectedRevision: 0, expectedSourceFingerprint: preview.sourceFingerprint };
      const bound = await modelSystemMaterials.bind({ ...options, body }); assert.equal(bound.revision, 1); assert.equal(bound.documents, undefined);
      assert.equal((await modelSystemMaterials.load(options)).documents[0].text, source.ERP.documents[0].text);
      assert.equal((await modelSystemMaterials.load({ ...options, modelId: 'stock-model' })).code, 'MODEL_SOURCE_NOT_BOUND');
      assert.equal((await modelSystemMaterials.bind({ ...options, body })).code, 'MODEL_SOURCE_REVISION_CONFLICT');
      source.ERP.documents[0].text = '{"synthetic":"changed"}'; writeState('system_access_runtime', key, source);
      assert.equal((await modelSystemMaterials.load(options)).code, 'MODEL_SOURCE_STALE');
      assert.equal((await modelSystemMaterials.bind({ ...options, body: { ...body, expectedRevision: 1 } })).code, 'MODEL_SOURCE_STALE');
      assert.equal((await modelSystemMaterials.inspect({ ...options, body: { systemCodes: [] } })).code, 'MODEL_SOURCE_INPUT_INVALID');
      assert.equal((await modelSystemMaterials.inspect({ ...options, body: { systemCodes: ['UNKNOWN'] } })).code, 'MODEL_SOURCE_FORBIDDEN');
    } finally { resetRuntimeState(['system_access_runtime', 'semantic_model_system_materials']); }
  });
});

test('system-material preparation refuses fresh IAM revocation without returning documents or granting a binding', async () => {
  await within(async () => {
    await modelWorkspaces.register({ identityScope: identity, body: { id: 'quality-model', label: '质量模型', expectedRevision: 0 } });
    let reads = 0;
    configureIAMRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
      const state = await asyncRuntimeStateRepository.readState(...args);
      if (args[0] === 'iam' && ++reads > 1) { state.configurationVersion++; state.users[0].roleIds = []; }
      return state;
    } });
    const result = await modelSystemMaterials.inspect({ identityScope: identity, modelId: 'quality-model', body: { systemCodes: ['ERP'] } });
    assert.equal(result.code, 'MODEL_SOURCE_FORBIDDEN'); assert.equal(result.documents, undefined); assert.equal(result.sourceFingerprint, undefined);
  });
});

test('proposal records bind models and reject foreign or unstamped records even in the selected namespace', async () => {
  await within(async () => {
    await modelWorkspaces.register({ identityScope: identity, body: { id: 'quality-model', label: '质量模型', expectedRevision: 0 } });
    await semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: identity, modelId: 'quality-model', work: async () => {
      const proposal = await createSemanticOperationsProposal({ input: '建立供应商模型', roleId: 'executive', identityScope: identity, scopeSystems: ['ERP'] });
      assert.equal(proposal.modelId, 'quality-model');
      for (const foreignModel of ['stock-model', undefined]) {
        await mutateSemanticGovernanceState('semantic_operations_agent_proposals', `proposal-${proposal.id}`, null, stored => ({ value: { ...stored, modelId: foreignModel } }));
        const options = { proposalId: proposal.id, revision: proposal.revision, role: { id: 'executive' }, identityScope: identity, accessContext: { buttonPermissionIds: ['meta_model.draft.save', 'meta_model.draft.review'] } };
        assert.equal((await inspectSemanticOperationsObjectDependencies({ ...options, objectId: 'Supplier' })).code, 'SEMANTIC_PROPOSAL_NOT_FOUND');
        assert.equal((await updateSemanticOperationsProposal(options)).code, 'SEMANTIC_PROPOSAL_NOT_FOUND');
        assert.equal((await applySemanticOperationsProposal(options)).code, 'SEMANTIC_PROPOSAL_NOT_FOUND');
      }
    } });
  });
});

test('snapshot records bind model and cannot be listed or rolled back through a forged model marker', async () => {
  await within(async () => {
    await modelWorkspaces.register({ identityScope: identity, body: { id: 'quality-model', label: '质量模型', expectedRevision: 0 } });
    const before = await modelWorkspaces.draft({ identityScope: identity, modelId: 'quality-model' });
    const saved = await modelWorkspaces.saveDraft({ identityScope: identity, modelId: 'quality-model', body: { confirmed: true, expectedFingerprint: before.draft.fingerprint, input: { policies: ['隔离合成快照'] } } });
    await semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: identity, modelId: 'quality-model', work: async () => {
      const snapshots = await listSemanticOperationsSnapshots({ identityScope: identity });
      assert.equal(snapshots[0].modelId, 'quality-model');
      for (const modelId of ['stock-model', undefined]) {
        await mutateSemanticGovernanceState('semantic_operations_agent_snapshots', 'index', {}, index => { index[saved.snapshot.id].modelId = modelId; return { value: index }; });
        assert.equal((await listSemanticOperationsSnapshots({ identityScope: identity })).length, 0);
        assert.equal((await rollbackSemanticOperationsSnapshot({ snapshotId: saved.snapshot.id, identityScope: identity, role: { id: 'executive' } })).code, 'SEMANTIC_SNAPSHOT_NOT_FOUND');
      }
    } });
    assert.equal((await modelWorkspaces.draft({ identityScope: identity, modelId: 'quality-model' })).draft.fingerprint, saved.draft.fingerprint);
  });
});

test('semantic evidence is model-bound for read, append and status; generic recovery cannot bypass it', async () => {
  await within(async () => {
    for (const [revision, modelId] of ['quality-model', 'stock-model'].entries()) await modelWorkspaces.register({ identityScope: identity, body: { id: modelId, label: modelId, expectedRevision: revision } });
    const workspace = (modelId, work) => semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: identity, modelId, work });
    const trace = await workspace('quality-model', () => semanticModelEvidence.create({ identityScope: identity, roleId: 'executive', input: '仅合成验证' }));
    assert.equal(trace.modelId, 'quality-model'); assert.equal(verifyAgentEvidenceTrace(trace).valid, true);
    assert.equal(await getAgentEvidenceTraceInternal(trace.id), null);
    assert.equal(await getAgentEvidenceTrace(trace.id, ['executive'], identity), null);
    assert.equal(await appendAgentEvidenceEvent(trace.id, { type: 'forged' }), null);
    assert.equal(await setAgentEvidenceTraceStatus(trace.id, 'forged'), null);
    assert.equal(await bindAgentEvidenceTraceRun(trace.id, { runId: 'legacy-global-index' }), null);
    await workspace('stock-model', async () => {
      assert.equal(await semanticModelEvidence.get(trace.id, ['executive'], identity), null);
      assert.equal(await semanticModelEvidence.append(trace.id, { type: 'forged' }), null);
      assert.equal(await semanticModelEvidence.status(trace.id, 'forged'), null);
    });
    await workspace('quality-model', async () => {
      await semanticModelEvidence.append(trace.id, { type: 'reviewed', summary: '合成记录' });
      await semanticModelEvidence.status(trace.id, 'completed', { completed: true });
      const result = await semanticModelEvidence.get(trace.id, ['executive'], identity);
      assert.equal(result.status, 'completed'); assert.equal(result.eventCount, 2); assert.equal(result.integrity.valid, true);
      const tampered = structuredClone(result); tampered.modelId = 'stock-model'; assert.equal(verifyAgentEvidenceTrace(tampered).valid, false);
    });
    writeState('agent_evidence_traces', trace.id, { ...trace, modelId: 'stock-model' });
    await workspace('stock-model', async () => {
      assert.equal(await semanticModelEvidence.get(trace.id, ['executive'], identity), null);
      assert.equal(await semanticModelEvidence.append(trace.id, { type: 'tampered' }), null);
    });
  });
});

test('semantic evidence cannot be mutated from another tenant with the same model ID', async () => {
  let trace;
  for (const tenant of [identity.tenantId, 'foreign-evidence-tests']) {
    const principal = { ...identity, tenantId: tenant };
    await runWithSemanticTenant(principal, async () => {
      await semanticModelRegistry.register({ role: { id: 'executive' }, identityScope: principal, body: { id: 'quality-model', label: '质量模型', expectedRevision: 0 } });
      await semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: principal, modelId: 'quality-model', work: async () => {
        if (!trace) trace = await semanticModelEvidence.create({ identityScope: principal, roleId: 'executive', input: '合成' });
        else {
          assert.equal(await semanticModelEvidence.append(trace.id, { type: 'foreign' }), null);
          assert.equal(await semanticModelEvidence.status(trace.id, 'foreign'), null);
          assert.equal(await semanticModelEvidence.get(trace.id, ['executive'], principal), null);
        }
      } });
    });
  }
});

test('semantic evidence read rejects model registration removed during asynchronous storage', async () => {
  await within(async () => {
    await modelWorkspaces.register({ identityScope: identity, body: { id: 'quality-model', label: '质量模型', expectedRevision: 0 } });
    const workspace = work => semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: identity, modelId: 'quality-model', work });
    const trace = await workspace(() => semanticModelEvidence.create({ identityScope: identity, roleId: 'executive', input: '合成' }));
    configureAgentEvidenceTraceRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
      const result = await asyncRuntimeStateRepository.readState(...args);
      if (args[0] === 'agent_evidence_traces') await mutateSemanticGovernanceState('semantic_model_registry', 'index', null, state => ({ value: { ...state, models: [] } }));
      return result;
    } });
    try { await assert.rejects(workspace(() => semanticModelEvidence.get(trace.id, ['executive'], identity)), error => error.code === 'SEMANTIC_MODEL_WORKSPACE_REVOKED'); }
    finally { configureAgentEvidenceTraceRepository(null); }
  });
});

test('registered model schema discovery never auto-imports the legacy system document pool', async () => {
  await within(async () => {
    await modelWorkspaces.register({ identityScope: identity, body: { id: 'quality-model', label: '质量模型', expectedRevision: 0 } });
    const document = { attachmentId: 'isolated-system-doc', name: 'erp-api.json', mimeType: 'application/json', text: JSON.stringify({ openapi: '3.0.0', 'x-source-system': 'ERP',
      components: { schemas: { IsolatedAsset: { type: 'object', 'x-primary-key': 'id', properties: { id: { type: 'string' }, name: { type: 'string' } } } } } }) };
    writeState('system_access_runtime', semanticTenantStateKey('system_documents'), { ERP: { documents: [document] } });
    try {
      assert.ok(discoverWorkspaceSchemas([], '').objectTypes.some(object => object.id === 'IsolatedAsset'));
      await semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: identity, modelId: 'quality-model', work: () => {
        assert.equal(discoverWorkspaceSchemas([], '').objectTypes.some(object => object.id === 'IsolatedAsset'), false);
        assert.ok(discoverWorkspaceSchemas([document], '').objectTypes.some(object => object.id === 'IsolatedAsset'));
      } });
    } finally { resetRuntimeState(['system_access_runtime']); }
  });
});

test('same-owner same-document materials are model scoped; references cannot switch models or revive legacy artifacts', async () => {
  await within(async () => {
    for (const [revision, modelId] of ['quality-model', 'stock-model'].entries()) await modelWorkspaces.register({ identityScope: identity, body: { id: modelId, label: modelId, expectedRevision: revision } });
    const workspace = (modelId, work) => semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: identity, modelId, work });
    const content = { documents: [{ name: '合成字典', mimeType: 'text/plain', text: '独立模型合成内容' }] };
    const create = () => extendSemanticMaterials({ identityScope: identity, roleId: 'executive', content });
    const legacy = await create(); const quality = await workspace('quality-model', create); const stock = await workspace('stock-model', create);
    assert.equal(new Set([legacy.refs[0], quality.refs[0], stock.refs[0]]).size, 3);
    assert.equal((await workspace('quality-model', () => loadSemanticMaterials(quality.refs, identity, 'executive')))[0].text, content.documents[0].text);
    await assert.rejects(workspace('stock-model', () => loadSemanticMaterials(quality.refs, identity, 'executive')), /ACCESS_DENIED/u);
    await assert.rejects(workspace('quality-model', () => loadSemanticMaterials(legacy.refs, identity, 'executive')), /ACCESS_DENIED/u);
    await assert.rejects(workspace('quality-model', () => loadSemanticMaterials(quality.refs, identity, 'quality')), /ACCESS_DENIED/u);
    await workspace('quality-model', () => mutateSemanticGovernanceState('semantic_material_artifacts', quality.refs[0], null, artifact => ({ value: { ...artifact, modelId: 'stock-model' } })));
    await assert.rejects(workspace('quality-model', () => loadSemanticMaterials(quality.refs, identity, 'executive')), /ACCESS_DENIED/u);
    await mutateSemanticGovernanceState('semantic_material_artifacts', legacy.refs[0], null, artifact => { delete artifact.modelId; return { value: artifact }; });
    assert.equal((await loadSemanticMaterials(legacy.refs, identity, 'executive')).length, 1);
    await assert.rejects(loadSemanticMaterials(['../foreign'], identity, 'executive'), /REFERENCE_INVALID/u);
  });
});

test('material reads recheck model admission after asynchronous storage returns', async () => {
  await within(async () => {
    await modelWorkspaces.register({ identityScope: identity, body: { id: 'quality-model', label: '质量模型', expectedRevision: 0 } });
    const workspace = work => semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: identity, modelId: 'quality-model', work });
    const saved = await workspace(() => extendSemanticMaterials({ identityScope: identity, roleId: 'executive', content: { documents: [{ name: '合成', mimeType: 'text/plain', text: '不可泄漏' }] } }));
    configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
      const value = await asyncRuntimeStateRepository.readState(...args);
      if (args[0] === 'semantic_material_artifacts') await mutateSemanticGovernanceState('semantic_model_registry', 'index', null, state => ({ value: { ...state, models: [] } }));
      return value;
    } });
    await assert.rejects(workspace(() => loadSemanticMaterials(saved.refs, identity, 'executive')), error => error.code === 'SEMANTIC_MODEL_WORKSPACE_REVOKED');
  });
});

test('SDK scoped publication is explicitly confirmed, rejects selectors with zero IO and never retries uncertain POST', async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++; assert.match(url, /\/models\/quality-model\/publish$/u); assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-semantic-model'], undefined);
    return new Response(JSON.stringify({ code: 'LOCAL_PUBLICATION_AUTHORITY_CHANGED', publicationMayHaveCommitted: true }), { status: 409 });
  };
  try {
    const client = createSemanticOperationsClient({ baseUrl: 'http://127.0.0.1:9999/api' });
    const body = { confirmed: true, expectedFingerprint: 'a'.repeat(24) };
    for (const id of ['oa-governance', '../foreign', '']) assert.throws(() => client.publishModelWorkspace(id, body));
    for (const payload of [{ ...body, confirmed: false }, { ...body, tenantId: 'other' }, { ...body, expectedFingerprint: 'stale' }]) assert.throws(() => client.publishModelWorkspace('quality-model', payload));
    assert.equal(calls, 0);
    await assert.rejects(client.publishModelWorkspace('quality-model', body), error => error.payload.publicationMayHaveCommitted === true);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
test.beforeEach(() => {
  configureIAMRepository(null);
  configureSemanticGovernanceRepository(null);
  resetRuntimeState(['iam', 'semantic_model_registry', 'domain_event_outbox', 'oa_meta_model_runtime', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks']);
  seedTenantIAM(identity.tenantId, ['admin@demo.local', 'quality@demo.local']);
});
test.afterEach(() => { configureIAMRepository(null); configureSemanticGovernanceRepository(null); });

test('model facade denies unresolved, non-admin and foreign principals without registering', async () => {
  await within(async () => {
    for (const identityScope of [undefined, { ...identity, subjectId: 'unknown' }, { ...identity, subjectId: 'quality@demo.local' }, { ...identity, tenantId: 'foreign' }]) {
      assert.equal((await modelWorkspaces.register({ identityScope, body: { id: 'denied-model', label: '禁止注册', expectedRevision: 0 } })).code, 'MODEL_WORKSPACE_FORBIDDEN');
    }
    assert.equal((await modelWorkspaces.list({ identityScope: identity })).revision, 0);
  });
});

test('register captures input before asynchronous IAM load; inspection does not expose draft content or activate routes', async () => {
  configureIAMRepository(asyncRuntimeStateRepository);
  await within(async () => {
    const body = { id: 'captured-model', label: '原始模型', expectedRevision: 0 };
    const pending = modelWorkspaces.register({ identityScope: identity, body });
    body.id = 'changed-model'; body.label = '篡改模型';
    const result = await pending;
    assert.equal(result.model.id, 'captured-model');
    const summary = await modelWorkspaces.inspect({ identityScope: identity, modelId: 'captured-model' });
    assert.equal(summary.selectionScope, 'request_only');
    assert.equal(summary.runtimeReadEnabled, false);
    assert.equal(summary.draft.objectTypes, undefined);
    assert.deepEqual(Object.keys(summary.draft).sort(), ['fingerprint', 'objectCount', 'relationshipCount']);
    assert.equal((await modelWorkspaces.inspect({ identityScope: identity, modelId: 'changed-model' })).status, 404);
  });
});

for (const write of [false, true]) test(`fresh post-operation IAM rejects revoked authority (write=${write})`, async () => {
  let reads = 0;
  configureIAMRepository({
    ...asyncRuntimeStateRepository,
    async readState(...args) {
      const state = await asyncRuntimeStateRepository.readState(...args);
      if (args[0] === 'iam' && ++reads >= 2) {
        state.configurationVersion++;
        state.users.find(user => user.account === identity.subjectId).roleIds = [];
      }
      return state;
    }
  });
  await within(async () => {
    const result = write
      ? await modelWorkspaces.register({ identityScope: identity, body: { id: 'uncertain-model', label: '已提交待核验', expectedRevision: 0 } })
      : await modelWorkspaces.list({ identityScope: identity });
    assert.equal(result.code, 'MODEL_WORKSPACE_AUTHORITY_CHANGED');
    assert.equal(result.models, undefined);
    assert.equal(result.registrationMayHaveCommitted, write ? true : undefined);
    configureIAMRepository(null);
    assert.equal((await modelWorkspaces.list({ identityScope: identity })).revision, write ? 1 : 0);
  });
});

test('SDK registry and inspection are request scoped; invalid model IDs never fetch', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response('{}'); };
  try {
    const client = createSemanticOperationsClient({ baseUrl: 'http://127.0.0.1:9999/api', platform: 'isolated-test' });
    await client.modelWorkspaces();
    const payload = { id: 'quality-model', label: '质量模型', expectedRevision: 4 };
    await client.registerModelWorkspace(payload);
    await client.inspectModelWorkspace('quality-model');
    await client.modelWorkspaces();
    assert.deepEqual(calls.map(call => call.url), [
      'http://127.0.0.1:9999/api/semantic-operations/models',
      'http://127.0.0.1:9999/api/semantic-operations/models',
      'http://127.0.0.1:9999/api/semantic-operations/models/quality-model/workspace',
      'http://127.0.0.1:9999/api/semantic-operations/models'
    ]);
    assert.deepEqual(JSON.parse(calls[1].options.body), payload);
    assert.equal(calls[1].options.method, 'POST');
    for (const call of calls) {
      assert.equal(call.options.headers['x-semantic-model'], undefined);
      assert.equal(call.options.headers['x-tenant-id'], undefined);
    }
    for (const invalid of ['../escape', 'one?tenant=foreign', ['quality-model'], '', 'a']) {
      assert.throws(() => client.inspectModelWorkspace(invalid), TypeError);
    }
    assert.equal(calls.length, 4);
  } finally { globalThis.fetch = originalFetch; }
});

test('post-write IAM storage failure reports uncertain commit instead of suggesting safe retry', async () => {
  let reads = 0;
  configureIAMRepository({
    ...asyncRuntimeStateRepository,
    async readState(...args) {
      if (args[0] === 'iam' && ++reads === 2) throw new Error('Synthetic IAM unavailable');
      return asyncRuntimeStateRepository.readState(...args);
    }
  });
  await within(async () => {
    const result = await modelWorkspaces.register({ identityScope: identity, body: { id: 'storage-failure', label: '待核验模型', expectedRevision: 0 } });
    assert.equal(result.code, 'MODEL_WORKSPACE_UNAVAILABLE');
    assert.equal(result.registrationMayHaveCommitted, true);
    configureIAMRepository(null);
    assert.equal((await modelWorkspaces.list({ identityScope: identity })).revision, 1);
  });
});

test('model-scoped draft saves preserve other models and legacy; stale and concurrent CAS do not overwrite', async () => {
  configureIAMRepository(asyncRuntimeStateRepository);
  configureSemanticGovernanceRepository(asyncRuntimeStateRepository);
  await within(async () => {
    for (const [expectedRevision, id] of ['quality-model', 'stock-model'].entries()) {
      assert.equal((await modelWorkspaces.register({ identityScope: identity, body: { id, label: id, expectedRevision } })).revision, expectedRevision + 1);
    }
    const read = modelId => modelWorkspaces.draft({ identityScope: identity, modelId });
    const save = (modelId, body) => modelWorkspaces.saveDraft({ identityScope: identity, modelId, body });
    const [quality, stock, legacy] = await Promise.all(['quality-model', 'stock-model', 'oa-governance'].map(read));
    assert.equal(quality.draft.worldModel, undefined); assert.equal(quality.draft.audit, undefined);
    const body = { confirmed: true, expectedFingerprint: quality.draft.fingerprint, input: { policies: ['合成质量模型独立规则'] } };
    const saved = await save('quality-model', body);
    assert.equal(saved.modelId, 'quality-model'); assert.ok(saved.snapshot);
    assert.notEqual(saved.draft.fingerprint, quality.draft.fingerprint);
    assert.equal((await read('stock-model')).draft.fingerprint, stock.draft.fingerprint);
    assert.equal((await read('oa-governance')).draft.fingerprint, legacy.draft.fingerprint);
    assert.equal((await save('quality-model', body)).code, 'MODEL_DRAFT_FINGERPRINT_CONFLICT');
    const concurrent = await Promise.all(['甲', '乙'].map(label => save('quality-model', {
      confirmed: true, expectedFingerprint: saved.draft.fingerprint, input: { policies: [`并发规则${label}`] }
    })));
    assert.equal(concurrent.filter(result => !result.error).length, 1);
    assert.equal(concurrent.filter(result => result.code === 'MODEL_DRAFT_FINGERPRINT_CONFLICT').length, 1);
    const current = await read('quality-model');
    for (const invalid of [{ ...body, confirmed: false }, { ...body, tenantId: 'foreign' }, { ...body, input: { modelId: 'stock-model' } }, { ...body, expectedFingerprint: null },
      { ...body, input: { metrics: new Array(51).fill({ id: 'oversized' }) } }, { ...body, input: { policies: [{}] } }, { ...body, input: { dataContracts: 'invalid' } }]) {
      assert.equal((await save('quality-model', invalid)).code, 'MODEL_DRAFT_INPUT_INVALID');
    }
    assert.equal((await read('quality-model')).draft.fingerprint, current.draft.fingerprint);
    assert.equal((await read('not-registered')).status, 404);
    assert.equal((await save('not-registered', body)).status, 404);
  });
});

test('SDK explicit draft methods retain confirmation/CAS and reject invalid selectors without I/O', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response('{}'); };
  try {
    const client = createSemanticOperationsClient({ baseUrl: 'http://127.0.0.1:9999/api', platform: 'isolated-draft-test' });
    const payload = { confirmed: true, expectedFingerprint: 'a'.repeat(24), input: { policies: ['合成规则'] } };
    await client.modelDraft('quality-model'); await client.saveModelDraft('quality-model', payload);
    assert.equal(calls[0].url, 'http://127.0.0.1:9999/api/semantic-operations/models/quality-model/draft');
    assert.equal(calls[1].options.method, 'POST'); assert.deepEqual(JSON.parse(calls[1].options.body), payload);
    for (const invalid of ['../other', '', ['quality-model']]) {
      assert.throws(() => client.modelDraft(invalid), TypeError);
      assert.throws(() => client.saveModelDraft(invalid, payload), TypeError);
    }
    assert.equal(calls.length, 2);
    let writes = 0;
    globalThis.fetch = async () => { writes++; throw new Error('Synthetic reply lost'); };
    await assert.rejects(client.saveModelDraft('quality-model', payload), /Synthetic reply lost/);
    assert.equal(writes, 1);
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'MODEL_WORKSPACE_AUTHORITY_CHANGED', workspaceWriteMayHaveCommitted: true }), { status: 409 });
    await assert.rejects(client.saveModelDraft('quality-model', payload), error => error.code === 'MODEL_WORKSPACE_AUTHORITY_CHANGED' && error.payload.workspaceWriteMayHaveCommitted === true);
  } finally { globalThis.fetch = original; }
});

test('draft post-write authority loss uses workspace uncertainty flag and does not return draft content', async () => {
  await within(async () => {
    await modelWorkspaces.register({ identityScope: identity, body: { id: 'draft-model', label: '草稿模型', expectedRevision: 0 } });
    const previous = await modelWorkspaces.draft({ identityScope: identity, modelId: 'draft-model' });
    let reads = 0;
    configureIAMRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
      const state = await asyncRuntimeStateRepository.readState(...args);
      if (args[0] === 'iam' && ++reads >= 3) { state.configurationVersion++; state.users.find(user => user.account === identity.subjectId).roleIds = []; }
      return state;
    } });
    const result = await modelWorkspaces.saveDraft({ identityScope: identity, modelId: 'draft-model', body: {
      confirmed: true, expectedFingerprint: previous.draft.fingerprint, input: { policies: ['保存后撤权合成规则'] }
    } });
    assert.equal(result.code, 'MODEL_WORKSPACE_AUTHORITY_CHANGED');
    assert.equal(result.workspaceWriteMayHaveCommitted, true);
    assert.equal(result.registrationMayHaveCommitted, undefined);
    assert.equal(result.draft, undefined);
    configureIAMRepository(null);
    assert.notEqual((await modelWorkspaces.draft({ identityScope: identity, modelId: 'draft-model' })).draft.fingerprint, previous.draft.fingerprint);
  });
});

test('scoped validation and synthetic simulation enforce CAS, never affect another model and clear stale simulation on save', async () => {
  configureIAMRepository(asyncRuntimeStateRepository); configureSemanticGovernanceRepository(asyncRuntimeStateRepository);
  await within(async () => {
    for (const [expectedRevision, id] of ['analysis-model', 'untouched-model'].entries()) await modelWorkspaces.register({ identityScope: identity, body: { id, label: id, expectedRevision } });
    const modelId = 'analysis-model'; const options = { identityScope: identity, modelId };
    const original = await modelWorkspaces.draft(options);
    const body = { confirmed: true, expectedFingerprint: original.draft.fingerprint };
    const validation = await modelWorkspaces.validate({ ...options, body });
    assert.equal(validation.validation.status, 'passed');
    assert.equal(validation.sourceFingerprint, original.draft.fingerprint);
    assert.ok(validation.validation.checks.length > 0);
    assert.ok(validation.validation.checks.every(check => Object.keys(check).length === 2));
    const simulated = await modelWorkspaces.simulate({ ...options, body });
    assert.equal(simulated.simulation.status, 'simulated'); assert.equal(simulated.simulation.sourceMode, 'synthetic');
    assert.equal(simulated.simulation.verifiesLiveSystems, false); assert.equal(simulated.runtimeReadEnabled, false);
    assert.equal(simulated.simulation.sourceFingerprint, body.expectedFingerprint);
    assert.equal(simulated.simulation.instances, undefined); assert.equal(simulated.simulation.decisionReplay, undefined);
    assert.ok(simulated.simulation.nodeCount > 0);
    assert.deepEqual((await modelWorkspaces.simulation(options)).simulation, simulated.simulation);
    for (const id of ['untouched-model', 'oa-governance']) assert.equal((await modelWorkspaces.simulation({ identityScope: identity, modelId: id })).simulation, null);
    const saved = await modelWorkspaces.saveDraft({ ...options, body: { ...body, input: { policies: [] } } });
    assert.equal((await modelWorkspaces.simulation(options)).simulation, null);
    for (const operation of ['validate', 'simulate']) {
      assert.equal((await modelWorkspaces[operation]({ ...options, body })).code, 'MODEL_DRAFT_FINGERPRINT_CONFLICT');
      assert.equal((await modelWorkspaces[operation]({ ...options, body: { ...body, confirmed: false } })).code, 'MODEL_ANALYSIS_INPUT_INVALID');
      assert.equal((await modelWorkspaces[operation]({ ...options, body: { ...body, tenantId: 'foreign' } })).status, 400);
    }
    const currentBody = { confirmed: true, expectedFingerprint: saved.draft.fingerprint };
    assert.equal((await modelWorkspaces.validate({ ...options, body: currentBody })).validation.status, 'failed');
    const failed = await modelWorkspaces.simulate({ ...options, body: currentBody });
    assert.equal(failed.status, 422); assert.equal(failed.draft, undefined);
    assert.equal((await modelWorkspaces.simulation(options)).simulation, null);
  });
});

test('validation and simulation use their own permissions rather than draft save authority', async () => {
  await within(async () => {
    const options = { identityScope: identity, modelId: 'permission-model' };
    await modelWorkspaces.register({ identityScope: identity, body: { id: options.modelId, label: '权限模型', expectedRevision: 0 } });
    const original = await modelWorkspaces.draft(options);
    const body = { confirmed: true, expectedFingerprint: original.draft.fingerprint };
    const iam = seedTenantIAM(identity.tenantId, ['admin@demo.local']);
    iam.rolePolicies.executive.buttonPermissionIds = iam.rolePolicies.executive.buttonPermissionIds.filter(id => !['meta_model.draft.validate', 'meta_model.simulate'].includes(id));
    writeState('iam', iamWorkspaceKey(identity.tenantId), iam);
    for (const operation of ['validate', 'simulate']) assert.equal((await modelWorkspaces[operation]({ ...options, body })).code, 'MODEL_WORKSPACE_FORBIDDEN');
    assert.equal((await modelWorkspaces.simulation(options)).simulation, null);
    assert.equal((await modelWorkspaces.draft(options)).draft.fingerprint, original.draft.fingerprint);
  });
});

test('analysis SDK uses explicit model paths; POST failure is not retried or downgraded', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response('{}'); };
  try {
    const client = createSemanticOperationsClient({ baseUrl: 'http://127.0.0.1:9999/api', platform: 'isolated-analysis-test' });
    const body = { confirmed: true, expectedFingerprint: 'a'.repeat(24) };
    await client.validateModelDraft('test-model', body); await client.simulateModelDraft('test-model', body); await client.modelSimulation('test-model');
    assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['validate', 'simulate', 'simulation']);
    assert.deepEqual(JSON.parse(calls[1].options.body), body);
    for (const method of ['validateModelDraft', 'simulateModelDraft', 'modelSimulation']) assert.throws(() => client[method]('../other', body), TypeError);
    assert.equal(calls.length, 3);
    let writes = 0; globalThis.fetch = async () => { writes++; throw new Error('Synthetic lost response'); };
    await assert.rejects(client.simulateModelDraft('test-model', body), /lost response/); assert.equal(writes, 1);
  } finally { globalThis.fetch = original; }
});

test('analysis post-mutation revocation withholds results and reports possible local side effect', async () => {
  await within(async () => {
    const options = { identityScope: identity, modelId: 'revoked-analysis' };
    await modelWorkspaces.register({ identityScope: identity, body: { id: options.modelId, label: '分析撤权模型', expectedRevision: 0 } });
    const draft = await modelWorkspaces.draft(options);
    for (const operation of ['validate', 'simulate']) {
      let reads = 0;
      configureIAMRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
        const state = await asyncRuntimeStateRepository.readState(...args);
        if (args[0] === 'iam' && ++reads >= 3) { state.configurationVersion++; state.users.find(user => user.account === identity.subjectId).roleIds = []; }
        return state;
      } });
      const result = await modelWorkspaces[operation]({ ...options, body: { confirmed: true, expectedFingerprint: draft.draft.fingerprint } });
      assert.equal(result.code, 'MODEL_WORKSPACE_AUTHORITY_CHANGED');
      assert.equal(result.workspaceWriteMayHaveCommitted, true);
      assert.equal(result.validation, undefined); assert.equal(result.simulation, undefined);
      configureIAMRepository(null);
    }
    assert.equal((await modelWorkspaces.simulation(options)).simulation.status, 'simulated');
  });
});

test('scoped task metadata enforces model, owner, reviewer and task-specific permissions without returning content', async () => {
  configureIAMRepository(asyncRuntimeStateRepository); configureSemanticGovernanceRepository(asyncRuntimeStateRepository);
  await within(async () => {
    for (const [expectedRevision, id] of ['tasks-quality', 'tasks-stock'].entries()) {
      await modelWorkspaces.register({ identityScope: identity, body: { id, label: id, expectedRevision } });
      await semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: identity, modelId: id, work: () => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, () => {
        const base = { modelId: id, owner: JSON.stringify([identity.tenantId, identity.subjectId]), createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z', status: 'waiting_confirmation',
          requiredPermission: 'meta_model.draft.save', confirmationRequired: true, title: 'PRIVATE-TITLE', request: 'PRIVATE-MATERIAL', response: 'PRIVATE-RESPONSE', messages: [{ content: 'PRIVATE-MESSAGE' }], events: [{ detail: 'PRIVATE-EVIDENCE' }] };
        const tasks = {
          'same-task': { ...base, id: 'same-task' },
          'archived-task': { ...base, id: 'archived-task', archivedAt: base.createdAt },
          'foreign-owner': { ...base, id: 'foreign-owner', owner: JSON.stringify([identity.tenantId, 'other']) },
          'wrong-model': { ...base, id: 'wrong-model', modelId: 'unregistered-model' },
          'reviewable-task': { ...base, id: 'reviewable-task', owner: JSON.stringify([identity.tenantId, 'other']), command: 'apply_proposal', reviewPermission: 'meta_model.draft.review', proposal: { id: 'review-proposal', revision: 2, status: 'pending_review', documents: ['PRIVATE-DOCUMENT'] } },
          'assigned-away': { ...base, id: 'assigned-away', owner: JSON.stringify([identity.tenantId, 'other']), command: 'apply_proposal', reviewPermission: 'meta_model.draft.review', reviewAssignment: { subjectId: 'another-reviewer' }, proposal: {} }
        };
        return { value: tasks, result: true };
      }) });
    }
    const options = { identityScope: identity, modelId: 'tasks-quality' };
    const result = await modelWorkspaces.tasks(options);
    assert.deepEqual(result.tasks.map(task => task.id).sort(), ['reviewable-task', 'same-task']);
    assert.equal(result.contentScope, 'task_metadata_only'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE-/);
    assert.equal((await modelWorkspaces.tasks({ ...options, filters: { includeArchived: true } })).tasks.length, 3);
    assert.equal((await modelWorkspaces.tasks({ ...options, filters: { offset: 1, limit: 1 } })).tasks.length, 1);
    const detail = await modelWorkspaces.task({ ...options, taskId: 'reviewable-task' });
    assert.equal(detail.task.reviewerAccess, true); assert.deepEqual(detail.task.proposal, { id: 'review-proposal', revision: 2, status: 'pending_review' });
    assert.equal((await modelWorkspaces.task({ identityScope: identity, modelId: 'tasks-stock', taskId: 'same-task' })).task.modelId, 'tasks-stock');
    assert.equal((await modelWorkspaces.tasks({ identityScope: identity, modelId: 'oa-governance' })).tasks.length, 0);
    for (const taskId of ['foreign-owner', 'wrong-model', 'assigned-away', 'missing-task']) assert.equal((await modelWorkspaces.task({ ...options, taskId })).status, 404);
    assert.equal((await modelWorkspaces.task({ ...options, taskId: '../escape' })).status, 400);
    for (const filters of [{ limit: 0 }, { offset: -1 }, { includeArchived: 'true' }, { tenantId: 'foreign' }, { limit: 101 }]) assert.equal((await modelWorkspaces.tasks({ ...options, filters })).status, 400);
    configureIAMRepository(null);
    const state = seedTenantIAM(identity.tenantId, ['admin@demo.local']);
    state.rolePolicies.executive.buttonPermissionIds = state.rolePolicies.executive.buttonPermissionIds.filter(id => id !== 'meta_model.draft.save');
    writeState('iam', iamWorkspaceKey(identity.tenantId), state);
    assert.equal((await modelWorkspaces.tasks(options)).tasks.length, 0);
    assert.equal((await modelWorkspaces.task({ ...options, taskId: 'same-task' })).status, 404);
  });
});

test('internal task reference probe rejects cross-model ancestry, forged proposals, cycles and lost ready evidence', async () => {
  await within(async () => {
    const options = { identityScope: identity, modelId: 'task-proof' };
    await modelWorkspaces.register({ ...options, body: { id: options.modelId, label: '任务引用模型', expectedRevision: 0 } });
    const workspace = work => semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, ...options, work });
    const owner = JSON.stringify([identity.tenantId, identity.subjectId]);
    const base = { modelId: options.modelId, owner, originRoleId: 'executive', createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z',
      status: 'waiting_confirmation', requiredPermission: 'meta_model.draft.save', request: 'PRIVATE-REQUEST', threadId: 'root-task' };
    const seed = async () => workspace(async () => {
      await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, () => ({ value: {
        'root-task': { ...base, id: 'root-task' },
        'child-task': { ...base, id: 'child-task', parentTaskId: 'root-task', proposal: { id: 'candidate', revision: 1 }, traceProvisioning: 'pending' }
      } }));
      await mutateSemanticGovernanceState('semantic_operations_agent_proposals', 'proposal-candidate', null, () => ({ value: { id: 'candidate', modelId: options.modelId, owner, revision: 1, documents: ['PRIVATE-SOURCE'] } }));
    });
    const probe = () => modelWorkspaces.inspectTaskReferences({ ...options, taskId: 'child-task' });
    await seed();
    const valid = await probe();
    assert.equal(valid.referenceState, 'valid'); assert.equal(valid.ancestorCount, 1); assert.equal(valid.evidenceState, 'pending');
    assert.doesNotMatch(JSON.stringify(valid), /PRIVATE/); assert.equal(valid.contentReturned, false);
    await workspace(async () => {
      const trace = await semanticModelEvidence.create({ identityScope: identity, roleId: 'executive', requestId: 'child-task', input: base.request });
      await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index['child-task'].traceProvisioning = 'ready'; index['child-task'].traceId = trace.id; return { value: index }; });
    });
    assert.equal((await probe()).evidenceState, 'ready');
    for (const patch of [{ modelId: 'another-model' }, { owner: 'foreign' }, { parentTaskId: 'child-task' }, { threadId: 'wrong-root' }]) {
      await seed(); await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { Object.assign(index['root-task'], patch); return { value: index }; }));
      assert.equal((await probe()).code, 'MODEL_TASK_REFERENCE_INVALID');
    }
    for (const patch of [{ modelId: 'another-model' }, { owner: 'foreign' }, { revision: 2 }, { id: 'wrong-id' }]) {
      await seed(); await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_proposals', 'proposal-candidate', null, proposal => ({ value: { ...proposal, ...patch } })));
      assert.equal((await probe()).code, 'MODEL_TASK_REFERENCE_INVALID');
    }
    await seed(); await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index['child-task'].traceProvisioning = 'ready'; index['child-task'].traceId = 'trace-missing'; return { value: index }; }));
    assert.equal((await probe()).code, 'MODEL_TASK_EVIDENCE_INVALID');
    await seed(); await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => {
      for (let i = 0; i < 33; i++) index[`long-${i}`] = { ...base, id: `long-${i}`, threadId: 'long-0', ...(i ? { parentTaskId: `long-${i - 1}` } : {}) };
      return { value: index };
    }));
    assert.equal((await modelWorkspaces.inspectTaskReferences({ ...options, taskId: 'long-32' })).code, 'MODEL_TASK_REFERENCE_INVALID');
    assert.equal((await modelWorkspaces.inspectTaskReferences({ ...options, taskId: 'unknown' })).status, 404);
  });
});

test('task reference probe validates material content hashes without exposing or inheriting private documents', async () => {
  await within(async () => {
    const options = { identityScope: identity, modelId: 'material-proof' };
    await modelWorkspaces.register({ ...options, body: { id: options.modelId, label: '材料完整性', expectedRevision: 0 } });
    const workspace = work => semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, ...options, work });
    let refs;
    await workspace(async () => {
      ({ refs } = await extendSemanticMaterials({ identityScope: identity, roleId: 'executive', content: { documents: [{ name: '字典.txt', mimeType: 'text/plain', text: 'PRIVATE-DOCUMENT' }] } }));
      await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, () => ({ value: { 'material-task': {
        id: 'material-task', modelId: options.modelId, owner: JSON.stringify([identity.tenantId, identity.subjectId]), originRoleId: 'executive',
        status: 'waiting_confirmation', requiredPermission: 'meta_model.draft.save', materialRefs: refs
      } } }));
    });
    const probe = () => modelWorkspaces.inspectTaskReferences({ ...options, taskId: 'material-task' });
    assert.equal((await probe()).referenceState, 'valid'); assert.doesNotMatch(JSON.stringify(await probe()), /PRIVATE/);
    await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => {
      Object.assign(index['material-task'], { owner: JSON.stringify([identity.tenantId, 'other-author']), command: 'apply_proposal', proposal: { id: 'another-proposal' } }); return { value: index };
    }));
    assert.equal((await modelWorkspaces.task({ ...options, taskId: 'material-task' })).task.reviewerAccess, true);
    assert.equal((await probe()).code, 'MODEL_TASK_MATERIAL_INVALID');
    await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index['material-task'].owner = JSON.stringify([identity.tenantId, identity.subjectId]); delete index['material-task'].proposal; return { value: index }; }));
    await workspace(() => mutateSemanticGovernanceState('semantic_material_artifacts', refs[0], null, artifact => ({ value: { ...artifact, document: { ...artifact.document, text: 'TAMPERED-DOCUMENT' } } })));
    await workspace(() => assert.rejects(loadSemanticMaterials(refs, identity, 'executive'), /SEMANTIC_MATERIAL_INTEGRITY_INVALID/));
    assert.equal((await probe()).code, 'MODEL_TASK_MATERIAL_INVALID');
    await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index['material-task'].originRoleId = 'finance'; return { value: index }; }));
    assert.equal((await probe()).code, 'MODEL_TASK_MATERIAL_INVALID');
    await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index['material-task'].materialRefs = {}; return { value: index }; }));
    assert.equal((await probe()).code, 'MODEL_TASK_MATERIAL_INVALID');
  });
});

test('internal reference probe withholds result after task mutation or fresh IAM revocation during lookup', async () => {
  await within(async () => {
    const options = { identityScope: identity, modelId: 'task-race' };
    await modelWorkspaces.register({ ...options, body: { id: options.modelId, label: '引用复验', expectedRevision: 0 } });
    await semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, ...options, work: () => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, () => ({ value: {
      'race-task': { id: 'race-task', modelId: options.modelId, owner: JSON.stringify([identity.tenantId, identity.subjectId]), status: 'waiting_confirmation', requiredPermission: 'meta_model.draft.save' }
    } })) });
    let reads = 0;
    configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
      const value = await asyncRuntimeStateRepository.readState(...args);
      if (args[0] === 'semantic_operations_agent_tasks' && ++reads >= 3) value['race-task'].updatedAt = 'changed';
      return value;
    } });
    assert.equal((await modelWorkspaces.inspectTaskReferences({ ...options, taskId: 'race-task' })).code, 'MODEL_TASK_REFERENCE_CHANGED');
    configureSemanticGovernanceRepository(null); reads = 0;
    configureIAMRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
      const value = await asyncRuntimeStateRepository.readState(...args);
      if (args[0] === 'iam' && ++reads >= 2) { value.configurationVersion++; value.users.find(user => user.account === identity.subjectId).roleIds = []; }
      return value;
    } });
    assert.equal((await modelWorkspaces.inspectTaskReferences({ ...options, taskId: 'race-task' })).code, 'MODEL_WORKSPACE_AUTHORITY_CHANGED');
  });
});

test('task metadata read drops results when authority changes across async lookup', async () => {
  await within(async () => {
    await modelWorkspaces.register({ identityScope: identity, body: { id: 'task-change', label: '任务权限模型', expectedRevision: 0 } });
    let reads = 0;
    configureIAMRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
      const value = await asyncRuntimeStateRepository.readState(...args);
      if (args[0] === 'iam' && ++reads >= 2) { value.configurationVersion++; value.users.find(user => user.account === identity.subjectId).roleIds = []; }
      return value;
    } });
    const result = await modelWorkspaces.tasks({ identityScope: identity, modelId: 'task-change' });
    assert.equal(result.code, 'MODEL_WORKSPACE_AUTHORITY_CHANGED'); assert.equal(result.tasks, undefined);
    assert.equal(result.workspaceWriteMayHaveCommitted, undefined);
  });
});

test('task metadata SDK encodes explicit pagination and never adds a global model selector', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response('{}'); };
  try {
    const client = createSemanticOperationsClient({ baseUrl: 'http://127.0.0.1:9999/api', platform: 'isolated-task-test' });
    await client.modelTasks('tasks-model', { offset: 2, limit: 10, includeArchived: false });
    await client.modelTask('tasks-model', 'same-task');
    await client.modelTaskDialogue('tasks-model', 'same-task');
    assert.match(calls[0].url, /\/tasks\?offset=2&limit=10&includeArchived=false$/u);
    assert.match(calls[1].url, /\/tasks-model\/tasks\/same-task$/u);
    assert.match(calls[2].url, /\/tasks-model\/tasks\/same-task\/dialogue$/u);
    for (const call of calls) { assert.equal(call.options.headers['x-semantic-model'], undefined); assert.equal(call.options.method, undefined); }
    assert.throws(() => client.modelTasks('../escape'), TypeError); assert.throws(() => client.modelTask('tasks-model', '../escape'), TypeError);
    assert.throws(() => client.modelTaskDialogue('tasks-model', '../escape'), TypeError);
    assert.throws(() => client.modelTasks('tasks-model', { tenantId: 'foreign' }), TypeError);
    for (const filters of [{ limit: 101 }, { offset: -1 }, { includeArchived: 'true' }, { offset: {} }]) assert.throws(() => client.modelTasks('tasks-model', filters), TypeError);
    assert.equal(calls.length, 3);
  } finally { globalThis.fetch = original; }
});

test('internal confirmation pins the entire task state and rechecks authority before issuing a token', async () => {
  await within(async () => {
    const options = { identityScope: identity, modelId: 'confirm-task', taskId: 'confirm-local' };
    await modelWorkspaces.register({ identityScope: identity, body: { id: options.modelId, label: '确认测试', expectedRevision: 0 } });
    const workspace = work => semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, ...options, work });
    const draft = await modelWorkspaces.draft(options);
    let record;
    await workspace(async () => {
      const trace = await semanticModelEvidence.create({ identityScope: identity, roleId: 'executive', requestId: options.taskId, input: '合成校验' });
      record = { id: options.taskId, modelId: options.modelId, owner: JSON.stringify([identity.tenantId, identity.subjectId]), originRoleId: 'executive', request: '合成校验',
        traceId: trace.id, traceProvisioning: 'ready', status: 'waiting_confirmation', requiredPermission: 'meta_model.draft.validate', confirmationRequired: true,
        reviewContext: { draftFingerprint: draft.draft.fingerprint }, confirmation: { state: 'not_issued' }, events: [] };
      await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, () => ({ value: { [record.id]: record } }));
    });
    const fingerprint = semanticTaskStateFingerprint(record);
    assert.notEqual(fingerprint, semanticTaskStateFingerprint({ ...record, traceId: 'changed' }));
    assert.notEqual(fingerprint, semanticTaskStateFingerprint({ ...record, updatedAt: 'changed' }));
    const body = { confirmed: true, expectedTaskFingerprint: fingerprint };
    const raced = await workspace(() => issueSemanticOperationsTaskConfirmation({ taskId: options.taskId, identityScope: identity,
      accessContext: { buttonPermissionIds: ['meta_model.draft.validate'] }, expectedTaskFingerprint: fingerprint, beforeCommit: async () => {
        await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[record.id].updatedAt = 'changed'; return { value: index }; }); return true;
      } }));
    assert.equal(raced.code, 'SEMANTIC_TASK_CONFIRMATION_STATE_CHANGED'); assert.equal(raced.confirmationToken, undefined);
    await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, () => ({ value: { [record.id]: record } })));
    let reads = 0;
    configureIAMRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
      const value = await asyncRuntimeStateRepository.readState(...args);
      if (args[0] === 'iam' && ++reads >= 2) { value.configurationVersion++; value.users.find(user => user.account === identity.subjectId).roleIds = []; } return value;
    } });
    const denied = await modelWorkspaces.confirmTask({ ...options, body });
    assert.equal(denied.code, 'MODEL_WORKSPACE_AUTHORITY_CHANGED'); assert.equal(denied.confirmationToken, undefined);
    configureIAMRepository(null);
    await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[record.id].traceProvisioning = 'pending'; return { value: index }; }));
    assert.equal((await modelWorkspaces.confirmTask({ ...options, body })).code, 'MODEL_TASK_EVIDENCE_NOT_READY');
    await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, () => ({ value: { [record.id]: record } })));
    const originalIAM = await asyncRuntimeStateRepository.readState('iam', iamWorkspaceKey(identity.tenantId));
    configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, async mutateState(...args) {
      const result = await asyncRuntimeStateRepository.mutateState(...args);
      if (args[0] === 'semantic_operations_agent_tasks') {
        const changed = structuredClone(originalIAM); changed.configurationVersion++;
        changed.users.find(user => user.account === identity.subjectId).roleIds = []; writeState('iam', iamWorkspaceKey(identity.tenantId), changed);
      }
      return result;
    } });
    try {
      const uncertain = await modelWorkspaces.confirmTask({ ...options, body });
      assert.equal(uncertain.code, 'MODEL_WORKSPACE_AUTHORITY_CHANGED'); assert.equal(uncertain.taskMayHaveCommitted, true); assert.equal(uncertain.confirmationToken, undefined);
    } finally { configureSemanticGovernanceRepository(null); writeState('iam', iamWorkspaceKey(identity.tenantId), originalIAM); }
    await workspace(async () => assert.equal((await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[record.id].confirmation.state, 'issued'));
    await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, () => ({ value: { [record.id]: record } })));
    let evidenceWrites = 0;
    configureAgentEvidenceTraceRepository({ ...asyncRuntimeStateRepository, async mutateState(...args) {
      const result = await asyncRuntimeStateRepository.mutateState(...args);
      if (++evidenceWrites === 1) throw new Error('Synthetic response loss after evidence commit'); return result;
    } });
    try {
      const pending = await modelWorkspaces.confirmTask({ ...options, body });
      assert.equal(pending.code, 'SEMANTIC_CONFIRMATION_EVIDENCE_PENDING'); assert.equal(pending.taskMayHaveCommitted, true); assert.equal(pending.confirmationToken, undefined);
      await workspace(async () => {
        const stored = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[record.id];
        assert.equal(stored.confirmation.evidenceState, 'pending');
        const blocked = await executeSemanticOperationsTask({ taskId: record.id, role: { id: 'executive' }, identityScope: identity, accessContext: { buttonPermissionIds: ['meta_model.draft.validate'] }, confirmationToken: 'unreturned-token' });
        assert.equal(blocked.code, 'SEMANTIC_CONFIRMATION_EVIDENCE_PENDING');
        assert.equal((await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[record.id].confirmation.state, 'issued');
      });
    } finally { configureAgentEvidenceTraceRepository(null); }
    const recovery = await modelWorkspaces.recoverConfirmationEvidence(options);
    assert.equal(recovery.confirmationEvidenceState, 'ready'); assert.equal(recovery.confirmationTokenReturned, false);
    await workspace(async () => {
      const before = await semanticModelEvidence.get(record.traceId, ['executive'], identity);
      assert.equal(before.integrity.valid, true);
      await modelWorkspaces.recoverConfirmationEvidence(options);
      const after = await semanticModelEvidence.get(record.traceId, ['executive'], identity);
      assert.equal(after.events.length, before.events.length);
      assert.equal(after.status, 'confirmed_pending_execution');
    });
  });
});

test('internal execution allows only confirmed local validation and never consumes stale, unsupported or revoked tasks', async () => {
  await within(async () => {
    const options = { identityScope: identity, modelId: 'local-execution' };
    await modelWorkspaces.register({ identityScope: identity, body: { id: options.modelId, label: '本地执行', expectedRevision: 0 } });
    const workspace = work => semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, ...options, work });
    const draft = await modelWorkspaces.draft(options);
    async function readyTask(id) {
      let record;
      await workspace(async () => {
        const trace = await semanticModelEvidence.create({ identityScope: identity, roleId: 'executive', requestId: id, input: '本机合成校验' });
        record = { id, modelId: options.modelId, owner: JSON.stringify([identity.tenantId, identity.subjectId]), originRoleId: 'executive', request: '本机合成校验', command: 'validate_model',
          traceId: trace.id, traceProvisioning: 'ready', status: 'waiting_confirmation', requiredPermission: 'meta_model.draft.validate', confirmationRequired: true,
          reviewContext: { draftFingerprint: draft.draft.fingerprint }, confirmation: { state: 'not_issued' }, events: [] };
        await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[id] = record; return { value: index }; });
      });
      const confirmation = await modelWorkspaces.confirmTask({ ...options, taskId: id, body: { confirmed: true, expectedTaskFingerprint: semanticTaskStateFingerprint(record) } });
      assert.ok(confirmation.confirmationToken, JSON.stringify(confirmation));
      const stored = await workspace(async () => (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[id]);
      return { taskId: id, body: { confirmed: true, expectedTaskFingerprint: semanticTaskStateFingerprint(stored), confirmationToken: confirmation.confirmationToken } };
    }
    const request = await readyTask('local-task');
    const stale = await modelWorkspaces.executeTask({ ...options, ...request, body: { ...request.body, expectedTaskFingerprint: '0'.repeat(24) } });
    assert.equal(stale.code, 'SEMANTIC_TASK_EXECUTION_STATE_CHANGED');
    const originalTask = await workspace(async () => (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[request.taskId]);
    const raced = await workspace(() => executeSemanticOperationsTask({ taskId: request.taskId, identityScope: identity, role: { id: 'executive' }, accessContext: { buttonPermissionIds: ['meta_model.draft.validate'] },
      confirmationToken: request.body.confirmationToken, expectedTaskFingerprint: request.body.expectedTaskFingerprint, executionAdmission: async stage => {
        if (stage === 'reserve') await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[request.taskId].updatedAt = 'changed-in-flight'; return { value: index }; }); return true;
      } }));
    assert.equal(raced.code, 'SEMANTIC_TASK_EXECUTION_STATE_CHANGED');
    await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[request.taskId] = originalTask; return { value: index }; }));
    await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[request.taskId].command = 'publish_model'; return { value: index }; }));
    assert.equal((await modelWorkspaces.executeTask({ ...options, ...request })).code, 'MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED');
    await workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[request.taskId].command = 'validate_model'; return { value: index }; }));
    let reads = 0;
    configureIAMRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
      const value = await asyncRuntimeStateRepository.readState(...args);
      if (args[0] === 'iam' && ++reads >= 4) { value.configurationVersion++; value.users.find(user => user.account === identity.subjectId).roleIds = []; } return value;
    } });
    const revoked = await modelWorkspaces.executeTask({ ...options, ...request });
    assert.equal(revoked.code, 'MODEL_WORKSPACE_AUTHORITY_CHANGED'); assert.equal(revoked.validation, undefined);
    configureIAMRepository(null);
    await workspace(async () => assert.equal((await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[request.taskId].confirmation.state, 'issued'));
    const success = await modelWorkspaces.executeTask({ ...options, ...request });
    assert.equal(success.task.status, 'completed', JSON.stringify(success)); assert.equal(success.validation.status, 'passed'); assert.equal(success.executedCommand, 'validate_model');
    assert.doesNotMatch(JSON.stringify(success), /confirmationToken|tokenHash|leaseToken|objectTypes/);
    const late = await readyTask('late-revocation');
    const originalIAM = await asyncRuntimeStateRepository.readState('iam', iamWorkspaceKey(identity.tenantId));
    configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, async mutateState(...args) {
      const result = await asyncRuntimeStateRepository.mutateState(...args);
      if (args[0] === 'oa_meta_model_runtime') {
        const changed = structuredClone(originalIAM); changed.configurationVersion++; changed.users.find(user => user.account === identity.subjectId).roleIds = [];
        writeState('iam', iamWorkspaceKey(identity.tenantId), changed);
      } return result;
    } });
    try {
      const uncertain = await modelWorkspaces.executeTask({ ...options, ...late });
      assert.equal(uncertain.code, 'MODEL_WORKSPACE_AUTHORITY_CHANGED'); assert.equal(uncertain.taskMayHaveCommitted, true); assert.equal(uncertain.workspaceWriteMayHaveCommitted, true); assert.equal(uncertain.validation, undefined);
    } finally { configureSemanticGovernanceRepository(null); writeState('iam', iamWorkspaceKey(identity.tenantId), originalIAM); }
    await workspace(async () => assert.equal((await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[late.taskId].confirmation.state, 'consumed'));
  });
});

test('local validation creation is idempotent, model isolated and completes explicit confirmation and execution without a provider', async () => {
  await within(async () => {
    const options = { identityScope: identity, modelId: 'created-local' };
    await modelWorkspaces.register({ identityScope: identity, body: { id: options.modelId, label: '创建本地任务', expectedRevision: 0 } });
    const draft = await modelWorkspaces.draft(options);
    const body = { confirmed: true, kind: 'validate_model', requestId: 'a11ce000-0000-4000-8000-000000000001', expectedDraftFingerprint: draft.draft.fingerprint };
    for (const invalid of [{ ...body, confirmed: false }, { ...body, text: '隐式调用模型' }, { ...body, kind: 'publish_model' }]) assert.equal((await modelWorkspaces.createLocalTask({ ...options, body: invalid })).status, 400);
    assert.equal((await modelWorkspaces.createLocalTask({ ...options, body: { ...body, expectedDraftFingerprint: '0'.repeat(24) } })).code, 'MODEL_DRAFT_FINGERPRINT_CONFLICT');
    const task = await modelWorkspaces.createLocalTask({ ...options, body });
    assert.equal(task.evidenceState, 'ready', JSON.stringify(task)); assert.equal(task.executionEnabled, false);
    assert.equal(task.task.status, 'waiting_confirmation');
    const duplicate = await modelWorkspaces.createLocalTask({ ...options, body });
    assert.equal(duplicate.reused, true); assert.equal(duplicate.task.id, task.task.id); assert.equal(duplicate.traceId, task.traceId);
    const confirmation = await modelWorkspaces.confirmTask({ ...options, taskId: task.task.id, body: { confirmed: true, expectedTaskFingerprint: task.taskFingerprint } });
    assert.ok(confirmation.confirmationToken, JSON.stringify(confirmation));
    const workspace = work => semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, ...options, work });
    const record = await workspace(async () => (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[task.task.id]);
    const execution = await modelWorkspaces.executeTask({ ...options, taskId: task.task.id, body: { confirmed: true, confirmationToken: confirmation.confirmationToken, expectedTaskFingerprint: semanticTaskStateFingerprint(record) } });
    assert.equal(execution.task.status, 'completed', JSON.stringify(execution));
    assert.equal((await modelWorkspaces.createLocalTask({ ...options, body })).reused, true);
    await workspace(async () => {
      const trace = await semanticModelEvidence.get(task.traceId, ['executive'], identity);
      assert.equal(trace.events.filter(event => event.type === 'local_validation_task_created').length, 1); assert.equal(trace.status, 'completed');
    });
    assert.equal((await modelWorkspaces.tasks({ identityScope: identity, modelId: 'oa-governance' })).tasks.length, 0);
  });
});

test('local creation evidence response loss retains one pending task and recovers without duplicate events', async () => {
  await within(async () => {
    const options = { identityScope: identity, modelId: 'local-loss' };
    await modelWorkspaces.register({ identityScope: identity, body: { id: options.modelId, label: '创建响应丢失', expectedRevision: 0 } });
    const draft = await modelWorkspaces.draft(options);
    const body = { confirmed: true, kind: 'validate_model', requestId: 'a11ce000-0000-4000-8000-000000000002', expectedDraftFingerprint: draft.draft.fingerprint };
    let writes = 0;
    configureAgentEvidenceTraceRepository({ ...asyncRuntimeStateRepository, async mutateState(...args) {
      const result = await asyncRuntimeStateRepository.mutateState(...args); if (++writes === 2) throw new Error('Synthetic evidence reply loss'); return result;
    } });
    let pending;
    try { pending = await modelWorkspaces.createLocalTask({ ...options, body }); } finally { configureAgentEvidenceTraceRepository(null); }
    assert.equal(pending.code, 'SEMANTIC_LOCAL_TASK_EVIDENCE_PENDING'); assert.equal(pending.taskMayHaveCommitted, true);
    assert.equal((await modelWorkspaces.confirmTask({ ...options, taskId: pending.taskId, body: { confirmed: true, expectedTaskFingerprint: '0'.repeat(24) } })).code, 'MODEL_TASK_EVIDENCE_NOT_READY');
    const recovered = await modelWorkspaces.createLocalTask({ ...options, body });
    assert.equal(recovered.reused, true); assert.equal(recovered.task.id, pending.taskId); assert.equal(recovered.evidenceState, 'ready');
    assert.equal((await modelWorkspaces.tasks(options)).tasks.length, 1);
    await semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, ...options, work: async () => {
      const trace = await semanticModelEvidence.get(recovered.traceId, ['executive'], identity);
      assert.equal(trace.integrity.valid, true); assert.equal(trace.events.length, 2);
    } });
    deleteState('agent_evidence_traces', recovered.traceId);
    assert.equal((await modelWorkspaces.createLocalTask({ ...options, body })).code, 'SEMANTIC_LOCAL_TASK_EVIDENCE_PENDING');
    assert.equal((await modelWorkspaces.createLocalTask({ ...options, body })).code, 'SEMANTIC_LOCAL_TASK_EVIDENCE_PENDING');
    assert.equal((await modelWorkspaces.tasks(options)).tasks.length, 1);
  });
});

test('local task SDK validates strict bodies before IO and never retries uncertain writes', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ message: '合成未知回执', code: 'PENDING', taskMayHaveCommitted: true, evidencePending: true }), { status: 503 }); };
  try {
    const client = createSemanticOperationsClient({ baseUrl: 'http://127.0.0.1:9999/api', platform: 'isolated-local-tasks' });
    const fp = 'a'.repeat(24); const body = { confirmed: true, kind: 'validate_model', requestId: 'a11ce000-0000-4000-8000-000000000003', expectedDraftFingerprint: fp };
    assert.throws(() => client.createLocalValidationTask('../escape', body), TypeError);
    assert.throws(() => client.createLocalValidationTask('model-a', { ...body, tenantId: 'foreign' }), TypeError);
    assert.throws(() => client.confirmLocalValidationTask('model-a', 'task-a', { confirmed: false, expectedTaskFingerprint: fp }), TypeError);
    assert.throws(() => client.executeLocalValidationTask('model-a', 'task-a', { confirmed: true, expectedTaskFingerprint: fp, confirmationToken: 'bad' }), TypeError);
    assert.equal(calls.length, 0);
    const methods = [() => client.createLocalValidationTask('model-a', body), () => client.confirmLocalValidationTask('model-a', 'task-a', { confirmed: true, expectedTaskFingerprint: fp }),
      () => client.executeLocalValidationTask('model-a', 'task-a', { confirmed: true, expectedTaskFingerprint: fp, confirmationToken: 'a'.repeat(43) }), () => client.recoverLocalConfirmationEvidence('model-a', 'task-a', { confirmed: true })];
    for (const method of methods) await assert.rejects(method(), error => error.payload.taskMayHaveCommitted && error.payload.evidencePending);
    assert.equal(calls.length, 4); assert.ok(calls.every(call => call.options.method === 'POST' && !call.options.headers['x-semantic-model']));
  } finally { globalThis.fetch = original; }
});

test('server-only structured preview builds scoped candidates with zero provider IO and refuses non-schema or side-effecting requests', async () => {
  const originalFetch = globalThis.fetch; const originalMode = process.env.AGENT_RUNTIME_MODE; const originalSource = process.env.AGENT_MODEL_CONFIG_SOURCE;
  let providerIO = 0; globalThis.fetch = async () => { providerIO++; throw new Error('Provider calls forbidden in isolated preview'); };
  process.env.AGENT_RUNTIME_MODE = 'local'; process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
  try { await within(async () => {
    const options = { identityScope: identity, modelId: 'structured-preview' };
    await modelWorkspaces.register({ identityScope: identity, body: { id: options.modelId, label: '结构化候选预览', expectedRevision: 0 } });
    writeState('system_access_runtime', semanticTenantStateKey('system_documents'), { WMS: { warnings: [], documents: [{ name: 'WMS.openapi.json', mimeType: 'application/json', text: JSON.stringify({ openapi: '3.0.0', 'x-source-system': 'WMS', components: { schemas: { StockRecord: { type: 'object', 'x-primary-key': 'id', properties: { id: { type: 'string' }, quantity: { type: 'number' } } } } } }) }] } });
    const sources = await modelSystemMaterials.inspect({ ...options, body: { systemCodes: ['WMS'] } });
    await modelSystemMaterials.bind({ ...options, body: { systemCodes: ['WMS'], confirmed: true, expectedRevision: 0, expectedSourceFingerprint: sources.sourceFingerprint } });
    await semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, ...options, work: async () => {
      const base = { identityScope: identity, role: { id: 'executive' }, accessContext: { roleIds: ['executive'], buttonPermissionIds: ['meta_model.draft.save'] }, structuredPreview: true };
      for (const text of ['你好', '发布当前模型', '校验当前模型']) assert.equal((await createSemanticOperationsTask({ ...base, body: { text } })).code, 'SEMANTIC_STRUCTURED_PREVIEW_BUILD_ONLY');
      assert.equal((await createSemanticOperationsTask({ ...base, body: { text: '根据WMS接口建立库存语义模型', parentTaskId: 'old-task' } })).code, 'SEMANTIC_STRUCTURED_PREVIEW_BUILD_ONLY');
      const reservationArgs = { identityScope: identity, roleId: 'executive', requestId: '12345678-1234-4123-8123-123456789abc', inputFingerprint: 'a'.repeat(64) };
      await semanticPreviewRequests.reserve(reservationArgs);
      const task = await createSemanticOperationsTask({ ...base, body: { text: '根据WMS接口建立库存语义模型', systemCodes: ['WMS'] },
        checkpointPreparedTask: prepared => semanticPreviewRequests.checkpointPreparedTask({ ...reservationArgs, task: prepared }),
        commitPreparedTask: prepared => semanticPreviewRequests.commitPreparedTask({ ...reservationArgs, task: prepared }) });
      assert.equal((await semanticPreviewRequests.reserve(reservationArgs)).taskId, task.id);
      assert.equal(task.error, undefined, JSON.stringify(task)); assert.equal(task.creationMode, 'structured_preview'); assert.equal(task.planning.mode, 'deterministic_preview');
      assert.equal(task.modelUnavailable, null); assert.ok(task.proposal.objectTypes.some(object => object.id === 'StockRecord')); assert.equal(task.status, 'waiting_confirmation');
      const stopped = await createSemanticOperationsTask({ ...base, body: { text: '根据WMS接口建立库存语义模型', systemCodes: ['WMS'] }, beforeTaskCommit: async () => false });
      assert.equal(stopped.code, 'SEMANTIC_TASK_CREATION_ADMISSION_CHANGED'); assert.equal(stopped.preparationMayHaveCommitted, true);
      assert.equal((await modelWorkspaces.tasks(options)).tasks.length, 1);
      const draft = (await modelWorkspaces.draft(options)).draft;
      const interruptedArgs = { ...reservationArgs, requestId: '42345678-1234-4123-8123-123456789abc' };
      await semanticPreviewRequests.reserve(interruptedArgs);
      let preparedCheckpoint;
      const interrupted = await createSemanticOperationsTask({ ...base, body: { text: '根据WMS接口建立库存语义模型', systemCodes: ['WMS'] },
        checkpointPreparedTask: async prepared => { preparedCheckpoint = await semanticPreviewRequests.checkpointPreparedTask({ ...interruptedArgs, task: prepared }); return preparedCheckpoint; },
        commitPreparedTask: async () => ({ code: 'SYNTHETIC_COMMIT_INTERRUPTED', status: 409 }) });
      assert.equal(interrupted.code, 'SYNTHETIC_COMMIT_INTERRUPTED'); assert.equal((await modelWorkspaces.tasks(options)).tasks.length, 1);
      const preparedBody = { confirmed: true, requestId: interruptedArgs.requestId, inputFingerprint: interruptedArgs.inputFingerprint,
        expectedCheckpointFingerprint: preparedCheckpoint.checkpointFingerprint, expectedDraftFingerprint: draft.fingerprint };
      const probe = await modelWorkspaces.inspectPreparedPreview({ ...options, body: preparedBody });
      assert.equal(probe.referenceState, 'valid', JSON.stringify(probe)); assert.equal(probe.contentReturned, false); assert.equal(probe.executionEnabled, false);
      assert.doesNotMatch(JSON.stringify(probe), /objectTypes|materialRefs|systemMaterialBinding/);
      assert.equal((await modelWorkspaces.inspectPreparedPreview({ ...options, body: { ...preparedBody, expectedDraftFingerprint: '0'.repeat(24) } })).code, 'MODEL_PREVIEW_PREPARED_REFERENCE_INVALID');
      const preparedTask = (await semanticPreviewRequests.loadPreparedTask({ ...interruptedArgs, expectedCheckpointFingerprint: preparedCheckpoint.checkpointFingerprint })).task;
      const proposalKey = `proposal-${preparedTask.proposal.id}`;
      const actualProposal = await readSemanticGovernanceState('semantic_operations_agent_proposals', proposalKey, null);
      await mutateSemanticGovernanceState('semantic_operations_agent_proposals', proposalKey, null, value => ({ value: { ...value, revision: value.revision + 1 } }));
      assert.equal((await modelWorkspaces.inspectPreparedPreview({ ...options, body: preparedBody })).code, 'MODEL_PREVIEW_PREPARED_REFERENCE_INVALID');
      await mutateSemanticGovernanceState('semantic_operations_agent_proposals', proposalKey, null, () => ({ value: actualProposal }));
      configureAgentEvidenceTraceRepository({ ...asyncRuntimeStateRepository, async readState(...settings) {
        if (settings[0] === 'agent_evidence_traces' && settings[1] === preparedTask.traceId) return null;
        return asyncRuntimeStateRepository.readState(...settings);
      } });
      try { assert.equal((await modelWorkspaces.inspectPreparedPreview({ ...options, body: preparedBody })).code, 'MODEL_TASK_EVIDENCE_INVALID'); }
      finally { configureAgentEvidenceTraceRepository(null); }
      assert.equal((await modelWorkspaces.tasks(options)).tasks.length, 1);
      const previewBody = { confirmed: true, requestId: '22345678-1234-4123-8123-123456789abc', text: '根据WMS接口建立库存语义模型', systemCodes: ['WMS'], expectedDraftFingerprint: draft.fingerprint };
      const concurrent = await Promise.all([modelWorkspaces.previewModelTask({ ...options, body: previewBody }), modelWorkspaces.previewModelTask({ ...options, body: previewBody })]);
      const preview = concurrent.find(result => !result.error && !result.reused);
      assert.ok(preview, JSON.stringify(concurrent));
      assert.equal(concurrent.filter(result => !result.error && !result.reused).length, 1);
      assert.ok(concurrent.every(result => result.code === 'MODEL_PREVIEW_REQUEST_PENDING' || result.task?.id === preview.task.id));
      assert.equal(preview.error, undefined, JSON.stringify(preview)); assert.equal(preview.creationMode, 'structured_preview'); assert.equal(preview.evidenceState, 'ready');
      assert.equal(preview.executionEnabled, false); assert.equal((await modelWorkspaces.draft(options)).draft.fingerprint, draft.fingerprint);
      assert.doesNotMatch(JSON.stringify(preview), /objectTypes|systemMaterialBinding|materialRefs/);
      const duplicate = await modelWorkspaces.previewModelTask({ ...options, body: previewBody });
      assert.equal(duplicate.task.id, preview.task.id); assert.equal(duplicate.traceId, preview.traceId); assert.equal(duplicate.reused, true);
      assert.equal((await modelWorkspaces.previewModelTask({ ...options, body: { ...previewBody, text: '根据WMS接口建立库存和仓库语义模型' } })).code, 'MODEL_PREVIEW_REQUEST_CONFLICT');
      const recoveryBody = { confirmed: true, expectedTaskFingerprint: preview.taskFingerprint };
      assert.equal((await modelWorkspaces.recoverPreviewEvidence({ ...options, taskId: preview.task.id, body: { ...recoveryBody, confirmed: false } })).status, 400);
      assert.equal((await modelWorkspaces.recoverPreviewEvidence({ ...options, taskId: preview.task.id, body: { ...recoveryBody, expectedTaskFingerprint: '0'.repeat(24) } })).code, 'MODEL_TASK_FINGERPRINT_CONFLICT');
      const receipt = await modelWorkspaces.recoverPreviewEvidence({ ...options, taskId: preview.task.id, body: recoveryBody });
      assert.equal(receipt.error, undefined, JSON.stringify(receipt)); assert.equal(receipt.confirmationTokenReturned, false);
      await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[preview.task.id].traceProvisioning = 'pending'; return { value: index }; });
      const pending = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[preview.task.id];
      const recovered = await modelWorkspaces.recoverPreviewEvidence({ ...options, taskId: preview.task.id, body: { confirmed: true, expectedTaskFingerprint: semanticTaskStateFingerprint(pending) } });
      assert.equal(recovered.evidenceState, 'ready', JSON.stringify(recovered)); assert.equal(recovered.traceId, preview.traceId);
      assert.equal((await modelWorkspaces.tasks(options)).tasks.length, 2);
      const completedRecord = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[preview.task.id];
      const requestOwner = JSON.stringify([identity.tenantId, identity.subjectId]);
      const originalReceipts = await readSemanticGovernanceState('semantic_preview_requests', requestOwner, {});
      await mutateSemanticGovernanceState('semantic_preview_requests', requestOwner, {}, () => ({ value: {} }));
      assert.equal((await modelWorkspaces.inspectTaskReferences({ ...options, taskId: preview.task.id })).code, 'MODEL_PREVIEW_RECEIPT_INVALID');
      assert.equal((await modelWorkspaces.recoverPreviewEvidence({ ...options, taskId: preview.task.id, body: { confirmed: true, expectedTaskFingerprint: semanticTaskStateFingerprint(completedRecord) } })).code, 'MODEL_PREVIEW_RECEIPT_INVALID');
      await mutateSemanticGovernanceState('semantic_preview_requests', requestOwner, {}, () => ({ value: originalReceipts }));
      await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { delete index[preview.task.id]; return { value: index }; });
      assert.equal((await modelWorkspaces.previewModelTask({ ...options, body: previewBody })).code, 'MODEL_PREVIEW_RECEIPT_INVALID');
      await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[preview.task.id] = completedRecord; return { value: index }; });
      await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[preview.task.id].traceProvisioning = 'pending'; return { value: index }; });
      const beforeRace = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[preview.task.id];
      const originalComplete = semanticModelEvidence.completePreviewCreation;
      semanticModelEvidence.completePreviewCreation = async args => {
        await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[preview.task.id].title = '等待后任务被改动'; return { value: index }; });
        return originalComplete(args);
      };
      try {
        const raced = await modelWorkspaces.recoverPreviewEvidence({ ...options, taskId: preview.task.id, body: { confirmed: true, expectedTaskFingerprint: semanticTaskStateFingerprint(beforeRace) } });
        assert.equal(raced.code, 'SEMANTIC_PREVIEW_EVIDENCE_INCOMPLETE'); assert.equal(raced.taskMayHaveCommitted, true);
        assert.equal((await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[preview.task.id].traceProvisioning, 'pending');
      } finally {
        semanticModelEvidence.completePreviewCreation = originalComplete;
        await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[preview.task.id] = beforeRace; return { value: index }; });
      }
      await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[preview.task.id].traceProvisioning = 'pending'; index[preview.task.id].traceId = task.traceId; return { value: index }; });
      const mismatched = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[preview.task.id];
      const rejectedReceipt = await modelWorkspaces.recoverPreviewEvidence({ ...options, taskId: preview.task.id, body: { confirmed: true, expectedTaskFingerprint: semanticTaskStateFingerprint(mismatched) } });
      assert.equal(rejectedReceipt.code, 'SEMANTIC_PENDING_PREVIEW_RECOVERY_INCOMPLETE'); assert.equal(rejectedReceipt.taskMayHaveCommitted, true);
      assert.equal((await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[preview.task.id].traceId, task.traceId);
      await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { index[preview.task.id].traceProvisioning = 'ready'; index[preview.task.id].traceId = preview.traceId; return { value: index }; });
      assert.equal((await modelWorkspaces.previewModelTask({ ...options, body: { ...previewBody, parentTaskId: task.id } })).status, 400);
      let reads = 0;
      configureIAMRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
        const value = await asyncRuntimeStateRepository.readState(...args);
        if (args[0] === 'iam' && ++reads >= 3) { value.configurationVersion++; value.users.find(user => user.account === identity.subjectId).roleIds = []; } return value;
      } });
      const revoked = await modelWorkspaces.previewModelTask({ ...options, body: previewBody });
      assert.equal(revoked.code, 'MODEL_WORKSPACE_AUTHORITY_CHANGED'); assert.equal(revoked.task, undefined);
      configureIAMRepository(null);
      assert.equal((await modelWorkspaces.tasks(options)).tasks.length, 2);
      const originalIAM = await asyncRuntimeStateRepository.readState('iam', iamWorkspaceKey(identity.tenantId));
      configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, async mutateState(...args) {
        const result = await asyncRuntimeStateRepository.mutateState(...args);
        if (args[0] === 'semantic_operations_agent_proposals') {
          const changed = structuredClone(originalIAM); changed.configurationVersion++;
          changed.users.find(user => user.account === identity.subjectId).roleIds = []; writeState('iam', iamWorkspaceKey(identity.tenantId), changed);
        } return result;
      } });
      try {
        const denied = await modelWorkspaces.previewModelTask({ ...options, body: { ...previewBody, requestId: '32345678-1234-4123-8123-123456789abc' } });
        assert.equal(denied.code, 'MODEL_WORKSPACE_AUTHORITY_CHANGED'); assert.equal(denied.preparationMayHaveCommitted, true); assert.equal(denied.task, undefined);
      } finally { configureSemanticGovernanceRepository(null); writeState('iam', iamWorkspaceKey(identity.tenantId), originalIAM); }
      assert.equal((await modelWorkspaces.tasks(options)).tasks.length, 2);
      const pendingRequest = await modelWorkspaces.previewModelTask({ ...options, body: { ...previewBody, requestId: '32345678-1234-4123-8123-123456789abc' } });
      assert.equal(pendingRequest.code, 'MODEL_PREVIEW_REQUEST_PENDING'); assert.equal(pendingRequest.preparationMayHaveCommitted, true);
      deleteState('agent_evidence_traces', preview.traceId);
      const lostEvidence = await modelWorkspaces.previewModelTask({ ...options, body: previewBody });
      assert.equal(lostEvidence.code, 'MODEL_TASK_EVIDENCE_INVALID'); assert.equal(lostEvidence.taskMayHaveCommitted, true);
      const quarantined = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[preview.task.id];
      assert.equal(quarantined.traceProvisioning, 'missing');
      assert.equal((await modelWorkspaces.recoverPreviewEvidence({ ...options, taskId: preview.task.id, body: { confirmed: true, expectedTaskFingerprint: semanticTaskStateFingerprint(quarantined) } })).code, 'MODEL_PREVIEW_RECOVERY_FORBIDDEN');
      assert.equal(await getAgentEvidenceTraceInternal(preview.traceId, { expectedModelId: options.modelId }), null);
      assert.equal((await issueSemanticOperationsTaskConfirmation({ taskId: preview.task.id, identityScope: identity, accessContext: { ...base.accessContext, buttonPermissionIds: [...base.accessContext.buttonPermissionIds, 'meta_model.draft.review'] } })).code, 'SEMANTIC_TASK_EVIDENCE_PENDING');
      assert.equal((await modelWorkspaces.resumePreparedPreview({ ...options, body: { ...preparedBody, confirmed: false } })).status, 400);
      assert.equal((await modelWorkspaces.resumePreparedPreview({ ...options, body: { ...preparedBody, expectedDraftFingerprint: '0'.repeat(24) } })).code, 'MODEL_PREVIEW_PREPARED_REFERENCE_INVALID');
      let commitReceiptLost = false;
      configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, async mutateStates(...settings) {
        const result = await asyncRuntimeStateRepository.mutateStates(...settings);
        if (!commitReceiptLost && settings[0].some(entry => entry.namespace === 'semantic_preview_requests') && settings[0].some(entry => entry.namespace === 'semantic_operations_agent_tasks')) {
          commitReceiptLost = true; throw new Error('SYNTHETIC_COMMIT_RECEIPT_LOST');
        }
        return result;
      } });
      try {
        const lostCommit = await modelWorkspaces.resumePreparedPreview({ ...options, body: preparedBody });
        assert.equal(lostCommit.code, 'MODEL_WORKSPACE_UNAVAILABLE'); assert.equal(lostCommit.taskMayHaveCommitted, true); assert.equal(lostCommit.task, undefined);
      } finally { configureSemanticGovernanceRepository(null); }
      const resumed = await modelWorkspaces.recoverPreviewCommit({ ...options, body: preparedBody });
      assert.equal(resumed.error, undefined, JSON.stringify(resumed)); assert.equal(resumed.task.id, preparedTask.id);
      assert.equal(resumed.recoveredCommit, true);
      assert.equal((await modelWorkspaces.recoverPreviewCommit({ ...options, body: { ...preparedBody, inputFingerprint: 'b'.repeat(64) } })).code, 'MODEL_PREVIEW_RECEIPT_INVALID');
      assert.equal((await modelWorkspaces.recoverPreviewCommit({ ...options, body: { ...preparedBody, confirmed: false } })).status, 400);
      assert.equal(resumed.evidenceState, 'pending'); assert.equal(resumed.confirmationEnabled, false); assert.equal(resumed.executionEnabled, false);
      assert.equal((await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[preparedTask.id].traceId, preparedTask.traceId);
      assert.equal((await modelWorkspaces.resumePreparedPreview({ ...options, body: preparedBody })).code, 'MODEL_PREVIEW_PREPARED_INVALID');
      assert.equal((await modelWorkspaces.tasks(options)).tasks.length, 3);
      assert.equal((await issueSemanticOperationsTaskConfirmation({ taskId: preparedTask.id, identityScope: identity, accessContext: { ...base.accessContext, buttonPermissionIds: [...base.accessContext.buttonPermissionIds, 'meta_model.draft.review'] } })).code, 'SEMANTIC_TASK_EVIDENCE_PENDING');
      let receiptLost = false;
      configureAgentEvidenceTraceRepository({ ...asyncRuntimeStateRepository, async mutateState(...settings) {
        const result = await asyncRuntimeStateRepository.mutateState(...settings);
        if (!receiptLost && settings[0] === 'agent_evidence_traces' && settings[1] === preparedTask.traceId) { receiptLost = true; throw new Error('SYNTHETIC_RECOVERY_EVENT_RESPONSE_LOST'); }
        return result;
      } });
      try {
        const lost = await modelWorkspaces.recoverPreviewEvidence({ ...options, taskId: preparedTask.id, body: { confirmed: true, expectedTaskFingerprint: resumed.taskFingerprint } });
        assert.equal(lost.code, 'SEMANTIC_PENDING_PREVIEW_RECOVERY_INCOMPLETE'); assert.equal(lost.evidencePending, true); assert.equal(lost.taskMayHaveCommitted, true);
        assert.equal((await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[preparedTask.id].traceProvisioning, 'pending');
      } finally { configureAgentEvidenceTraceRepository(null); }
      const completed = await modelWorkspaces.recoverPreviewEvidence({ ...options, taskId: preparedTask.id, body: { confirmed: true, expectedTaskFingerprint: resumed.taskFingerprint } });
      assert.equal(completed.error, undefined, JSON.stringify(completed)); assert.equal(completed.evidenceState, 'ready'); assert.equal(completed.traceId, preparedTask.traceId);
      assert.equal(completed.confirmationTokenReturned, false); assert.equal(completed.executionEnabled, false);
      const recoveredTask = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[preparedTask.id];
      const recoveredTrace = await getAgentEvidenceTraceInternal(preparedTask.traceId, { expectedModelId: options.modelId });
      assert.equal(recoveredTrace.events.filter(event => event.type === 'semantic_preview_receipt_recovered').length, 1);
      assert.ok(recoveredTrace.events.filter(event => ['semantic_intent_routed', 'semantic_proposal_generated'].includes(event.type)).every(event => event.details.recoveryObservation === true));
      assert.equal((await modelWorkspaces.recoverPreviewEvidence({ ...options, taskId: preparedTask.id, body: { confirmed: true, expectedTaskFingerprint: semanticTaskStateFingerprint(recoveredTask) } })).evidenceState, 'ready');
      assert.equal((await getAgentEvidenceTraceInternal(preparedTask.traceId, { expectedModelId: options.modelId })).events.length, recoveredTrace.events.length);
    } });
    writeState('system_access_runtime', semanticTenantStateKey('system_documents'), { WMS: { warnings: [], documents: [{ name: '说明.txt', mimeType: 'text/plain', text: '人工描述的库存范围，没有结构化字段字典或API Schema。' }] } });
    const changed = await modelSystemMaterials.inspect({ ...options, body: { systemCodes: ['WMS'] } });
    await modelSystemMaterials.bind({ ...options, body: { systemCodes: ['WMS'], confirmed: true, expectedRevision: 1, expectedSourceFingerprint: changed.sourceFingerprint } });
    await semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, ...options, work: async () => {
      const result = await createSemanticOperationsTask({ identityScope: identity, role: { id: 'executive' }, accessContext: { roleIds: ['executive'], buttonPermissionIds: ['meta_model.draft.save'] }, structuredPreview: true,
        body: { text: '根据WMS接口建立库存语义模型', systemCodes: ['WMS'] } });
      assert.equal(result.code, 'SEMANTIC_STRUCTURED_PREVIEW_SCHEMA_REQUIRED');
    } });
    assert.equal(providerIO, 0);
  }); } finally {
    globalThis.fetch = originalFetch;
    if (originalMode === undefined) delete process.env.AGENT_RUNTIME_MODE; else process.env.AGENT_RUNTIME_MODE = originalMode;
    if (originalSource === undefined) delete process.env.AGENT_MODEL_CONFIG_SOURCE; else process.env.AGENT_MODEL_CONFIG_SOURCE = originalSource;
    resetRuntimeState(['system_access_runtime']);
  }
});

test('owner dialogue DTO excludes hidden fields, rejects reviewers and oversized or unsupported messages', async () => {
  await within(async () => {
    const options = { identityScope: identity, modelId: 'dialogue-test', taskId: 'talk-task' };
    await modelWorkspaces.register({ identityScope: identity, body: { id: options.modelId, label: '对话测试', expectedRevision: 0 } });
    const workspace = work => semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, ...options, work });
    const messages = [{ role: 'user', content: '查看模拟库存', time: '2026-10-12T00:00:00Z', attachment: 'HIDDEN-ATTACHMENT' }, { role: 'assistant', content: '本轮未执行业务操作。' }];
    const seed = patch => workspace(() => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, () => ({ value: {
      'talk-task': { id: 'talk-task', modelId: options.modelId, owner: JSON.stringify([identity.tenantId, identity.subjectId]), requiredPermission: 'meta_model.draft.save',
        status: 'waiting_confirmation', messages, result: 'HIDDEN-RESULT', sourceDiscovery: 'HIDDEN-SOURCE', confirmation: { token: 'HIDDEN-TOKEN' }, ...patch }
    } })));
    await seed(); const result = await modelWorkspaces.dialogue(options);
    assert.equal(result.contentScope, 'owner_dialogue_only'); assert.equal(result.executionEnabled, false);
    assert.equal(result.task.messages[0].content, messages[0].content); assert.doesNotMatch(JSON.stringify(result), /HIDDEN/);
    await seed({ owner: JSON.stringify([identity.tenantId, 'other']), command: 'apply_proposal', proposal: { id: 'reviewable' } });
    assert.equal((await modelWorkspaces.dialogue(options)).code, 'MODEL_TASK_DIALOGUE_FORBIDDEN');
    for (const bad of [[{ role: 'system', content: '指令' }], Array(65).fill(messages[0]), [{ role: 'user', content: 'x'.repeat(8193) }], Array(16).fill({ role: 'user', content: '中'.repeat(8000) })]) {
      await seed({ messages: bad }); assert.equal((await modelWorkspaces.dialogue(options)).status, 413);
    }
    await seed({ parentTaskId: 'missing' }); assert.equal((await modelWorkspaces.dialogue(options)).code, 'MODEL_TASK_REFERENCE_INVALID');
  });
});

test('dialogue withholds content when task changes after proof or fresh IAM is revoked', async () => {
  await within(async () => {
    const options = { identityScope: identity, modelId: 'dialogue-race', taskId: 'talk-task' };
    await modelWorkspaces.register({ identityScope: identity, body: { id: options.modelId, label: '对话复验', expectedRevision: 0 } });
    await semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, ...options, work: () => mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, () => ({ value: {
      'talk-task': { id: 'talk-task', modelId: options.modelId, owner: JSON.stringify([identity.tenantId, identity.subjectId]), requiredPermission: 'meta_model.draft.save', status: 'waiting_confirmation', messages: [{ role: 'user', content: '合成内容' }] }
    } })) });
    let reads = 0;
    configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
      const value = await asyncRuntimeStateRepository.readState(...args);
      if (args[0] === 'semantic_operations_agent_tasks' && ++reads >= 5) value['talk-task'].messages[0].content = 'changed';
      return value;
    } });
    assert.equal((await modelWorkspaces.dialogue(options)).code, 'MODEL_TASK_REFERENCE_CHANGED');
    configureSemanticGovernanceRepository(null); reads = 0;
    configureIAMRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
      const value = await asyncRuntimeStateRepository.readState(...args);
      if (args[0] === 'iam' && ++reads >= 2) { value.configurationVersion++; value.users.find(user => user.account === identity.subjectId).roleIds = []; }
      return value;
    } });
    const result = await modelWorkspaces.dialogue(options); assert.equal(result.code, 'MODEL_WORKSPACE_AUTHORITY_CHANGED'); assert.equal(result.task, undefined);
  });
});

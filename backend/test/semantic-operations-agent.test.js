import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { getRole } from '../src/services/authorization-service.js';
import { applySemanticOperationsProposal, createSemanticOperationsProposal, createSemanticOperationsProposalFromRequest, listSemanticOperationsSnapshots, rollbackSemanticOperationsSnapshot, updateSemanticOperationsProposal } from '../src/services/semantic-operations-agent-service.js';
import { archiveSemanticOperationsTask, classifySemanticOperationsIntent, createSemanticOperationsTask, executeSemanticOperationsTask, getSemanticOperationsTaskTrace, issueSemanticOperationsTaskConfirmation, listSemanticOperationsTasks, reviseSemanticOperationsTaskProposal } from '../src/services/semantic-operations-task-service.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft, validateOAMetaModelDraft } from '../src/services/meta-model-service.js';
import { detectRequestedSemanticSystems, discoverSemanticSources } from '../src/services/semantic-source-discovery-service.js';
import { getMockConnectorCatalog, getMockSystemRecords } from '../src/services/mock-scenario-service.js';
import { buildSemanticMappingContract, validateSemanticMappingContract, validateGovernedSemanticSamples } from '../src/services/semantic-mapping-validation-service.js';
import { resolveSemanticOperationsPlanSystems } from '../src/services/semantic-operations-planner-service.js';

const identity = { tenantId: 'semantic-test', subjectId: 'architect-01', deviceId: 'device-01' };

test('adoption mode is explicit: merge preserves objects, replace shows removals and remains recoverable', async () => {
  for (const adoptionMode of ['merge', 'replace']) {
    resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'oa_meta_model_runtime']);
    const before = await getOAMetaModelDraft();
    const proposal = await createSemanticOperationsProposal({ input: '建立供应商和原料批次的语义模型。', identityScope: identity, adoptionMode });
    assert.equal(proposal.adoptionMode, adoptionMode);
    const applied = await applySemanticOperationsProposal({ proposalId: proposal.id, role: getRole('executive'), identityScope: identity });
    assert.ok(!applied.error, applied.error);
    assert.equal(applied.draft.objectTypes.some(o => o.id === 'Organization'), adoptionMode === 'merge');
    if (adoptionMode === 'replace') {
      assert.ok(proposal.diff.summary.removedObjects > 0);
      assert.ok(applied.draft.accessPolicies.every(p => p.effect === 'deny'));
      assert.match(applied.message, /替换/);
    }
    const restored = await rollbackSemanticOperationsSnapshot({ snapshotId: applied.snapshot.id, role: getRole('executive'), identityScope: identity });
    assert.deepEqual(restored.draft.objectTypes.map(o => o.id), before.objectTypes.map(o => o.id));
  }
  assert.equal((await createSemanticOperationsProposal({ input: '建立供应商模型', identityScope: identity })).adoptionMode, 'merge');
  assert.equal((await createSemanticOperationsProposal({ input: '建立供应商模型', identityScope: identity, adoptionMode: 'new-workspace' })).code, 'SEMANTIC_ADOPTION_MODE_INVALID');
});

const governedMappingFixture = () => ({
  draft: { objectTypes: [{ id: 'InventoryLot', sourceSystems: ['WMS'], key: 'inventoryLotId', classification: 'internal', fieldDefinitions: [
    { name: 'inventoryLotId', type: 'string', required: true, primaryKey: true, sourceField: 'inventoryLotId', mappingStatus: 'mapped' },
    { name: 'quantity', type: 'number', sourceField: 'quantity', mappingStatus: 'mapped' }
  ] }] },
  options: { roleId: 'executive', identityScope: { tenantId: 'demo-enterprise', subjectId: 'admin@demo.local' } },
  row: { id: 'INV-SAMPLE-1', system: 'WMS', objectType: 'InventoryLot', tenantId: 'demo-enterprise', organizationId: 'org-market-dept', classification: 'internal', version: 'sample-v1', occurredAt: '2026-08-17T01:00:00Z', payload: { inventoryLotId: 'LOT-SAMPLE-1', quantity: 12 } }
});

test('governed mapping validates supplied bounded samples without claiming whole-source coverage', () => {
  const { draft, options, row } = governedMappingFixture();
  const result = validateGovernedSemanticSamples(draft, new Map([['wms', [row, { ...row, id: 'INV-SAMPLE-2', payload: { inventoryLotId: 'LOT-SAMPLE-2', quantity: 8 } }]]]), { ...options, sampleLimit: 1 });
  assert.equal(result.status, 'passed');
  assert.equal(result.blocked, false);
  assert.equal(result.contract.sourceMode, 'governed_sample_input');
  assert.deepEqual(result.coverage, { scope: 'bounded_samples_only', providedRecords: 2, testedRecords: 1, verifiesAllSourceData: false });
  const fact = result.objects[0].transformedSamples[0].canonicalFact;
  assert.equal(fact.fields.quantity, 12);
  assert.equal(fact.source.version, 'sample-v1');
  assert.equal(fact.source.simulated, false);
});

test('governed mapping rejects entire batch for cross-scope, missing-version or malformed rows', () => {
  const { draft, options, row } = governedMappingFixture();
  for (const invalid of [null, { ...row, system: 42 }, { ...row, tenantId: 'secret-tenant' }, { ...row, version: undefined }, { ...row, organizationId: 'unregistered-org' }]) {
    const result = validateGovernedSemanticSamples(draft, new Map([['wms', [row, invalid]]]), { ...options, sampleLimit: 1 });
    assert.equal(result.code, 'MAPPING_SAMPLE_SCOPE_OR_VERSION_INVALID');
    assert.equal(result.blocked, true);
    assert.deepEqual(result.objects, []);
    assert.doesNotMatch(JSON.stringify(result), /INV-SAMPLE|secret-tenant/);
  }
  assert.equal(validateGovernedSemanticSamples(draft, new Map(), {}).code, 'MAPPING_IDENTITY_REQUIRED');
  assert.equal(validateGovernedSemanticSamples(draft, new Map([['unknown', [row]]]), options).code, 'MAPPING_SAMPLES_INVALID');
});

test('governed mapping leaves missing sources unverified and blocks unexecuted derived fields', () => {
  const { draft, options, row } = governedMappingFixture();
  const missing = validateGovernedSemanticSamples(draft, new Map(), options);
  assert.equal(missing.blocked, true);
  assert.equal(missing.objects[0].status, 'unverified');
  assert.equal(missing.issues[0].code, 'SCOPED_SAMPLE_UNAVAILABLE');
  draft.objectTypes[0].fieldDefinitions[1].mappingStatus = 'derived';
  const derived = validateGovernedSemanticSamples(draft, new Map([['wms', [row]]]), options);
  assert.equal(derived.blocked, true);
  assert.equal(derived.objects[0].status, 'failed');
});

test('governed mapping catches source type, duplicate keys and prototype lookup', () => {
  const { draft, options, row } = governedMappingFixture();
  const mismatch = validateGovernedSemanticSamples(draft, new Map([['wms', [{ ...row, payload: { ...row.payload, quantity: 'twelve' } }]]]), options);
  assert.equal(mismatch.blocked, true);
  assert.equal(mismatch.issues[0].code, 'SOURCE_TYPE_MISMATCH');
  const duplicate = validateGovernedSemanticSamples(draft, new Map([['wms', [row, { ...row, id: 'INV-SAMPLE-2' }]]]), options);
  assert.equal(duplicate.blocked, true);
  assert.equal(duplicate.issues[0].code, 'DUPLICATE_PRIMARY_KEY');
  draft.objectTypes[0].fieldDefinitions[0].sourceField = 'constructor.name';
  const prototype = validateGovernedSemanticSamples(draft, new Map([['wms', [row]]]), options);
  assert.equal(prototype.blocked, true);
  assert.equal(prototype.issues[0].code, 'REQUIRED_SOURCE_VALUE_MISSING');
});

test('governed mapping rejects invalid schemas instead of passing an empty or undefined model', () => {
  const { draft, options, row } = governedMappingFixture();
  for (const bad of [null, {}, { objectTypes: [] }, { objectTypes: [null] }]) assert.equal(validateGovernedSemanticSamples(bad, new Map([['wms', [row]]]), options).code, 'MAPPING_SCHEMA_INVALID');
  draft.objectTypes[0].fieldDefinitions[1].type = 'unsupported';
  assert.equal(validateGovernedSemanticSamples(draft, new Map([['wms', [row]]]), options).code, 'MAPPING_SCHEMA_INVALID');
});

test('governed mapping does not substitute envelope fields for a missing payload key', () => {
  const { draft, options, row } = governedMappingFixture();
  draft.objectTypes[0].fieldDefinitions[0].sourceField = 'id';
  const result = validateGovernedSemanticSamples(draft, new Map([['wms', [row]]]), options);
  assert.equal(result.blocked, true);
  assert.equal(result.issues[0].code, 'REQUIRED_SOURCE_VALUE_MISSING');
});

test('model planning cannot invent enterprise system scope for non-source tasks', () => {
  const statusPlan = resolveSemanticOperationsPlanSystems({ authoritativeIntent: 'inspect_status', requestedSystems: [], discoveredSystems: [], suggestedSystems: ['ERP'] });
  assert.deepEqual(statusPlan.systems, []);
  assert.equal(statusPlan.systemConflict, true);
  const buildPlan = resolveSemanticOperationsPlanSystems({ authoritativeIntent: 'build_model', requestedSystems: ['ERP'], discoveredSystems: ['ERP', 'WMS'], suggestedSystems: ['ERP', 'QMS'] });
  assert.deepEqual(buildPlan.systems, ['ERP', 'WMS']);
  assert.equal(buildPlan.systemConflict, true);
});

test('source detection distinguishes procurement orders from OMS customer orders', () => {
  assert.deepEqual(detectRequestedSemanticSystems('建立供应商和采购订单语义模型'), ['ERP']);
  assert.deepEqual(detectRequestedSemanticSystems('建立客户订单与门店履约模型'), ['OMS']);
});

test('Supplier and PurchaseOrder remain independent types and malformed relations cannot disappear on save', () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'oa_meta_model_runtime']);
  const role = getRole('executive');
  const proposal = createSemanticOperationsProposal({ input: '根据 ERP 建立供应商和采购订单模型', role, identityScope: identity });
  const serialized = JSON.stringify(proposal);
  assert.match(serialized, /"coreObject":"Supplier"/);
  assert.match(serialized, /"coreObject":"PurchaseOrder"/);
  const base = getOAMetaModelDraft();
  const malformed = saveOAMetaModelDraft({ ...base, relationshipTypes: [...base.relationshipTypes, { from: 'MissingObject', to: 'Person', predicate: 'relates', cardinality: '1:n' }] }, role);
  assert.match(malformed.error, /不会静默丢弃/);
  const custom = saveOAMetaModelDraft({ ...base, objectTypes: [...base.objectTypes, { id: 'CustomerAccount', label: '客户账户', fields: ['id', 'status'], key: 'id', source: 'erp.customer' }] }, role);
  assert.equal(custom.draft.objectTypes.find((item) => item.id === 'CustomerAccount').coreObject, 'CustomerAccount');
});

test('semantic operations agent turns natural language into a reviewable draft without publishing', () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const proposal = createSemanticOperationsProposal({
    input: '建立供应商、原料批次、来料检验和生产批次的语义模型，来源是 ERP、WMS、LIMS、MES。',
    multimodalContent: { modelContext: '', evidence: [] }, attachments: [], identityScope: identity
  });
  assert.equal(proposal.status, 'pending_review');
  assert.ok(proposal.objectTypes.some((item) => item.id === 'Supplier'));
  assert.ok(proposal.objectTypes.some((item) => item.id === 'RawMaterialBatch'));
  assert.ok(proposal.relationshipTypes.some((item) => item.from === 'RawMaterialBatch' && item.to === 'TestResult'));
  assert.ok(proposal.reviewNotes.some((item) => item.includes('尚未写入')));
  assert.equal(proposal.critic.status, 'passed');
  assert.ok(proposal.diff.summary.addedObjects >= 4);
});

test('semantic operations proposal can only be applied by its owner and remains a draft', () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const proposal = createSemanticOperationsProposal({ input: '建立供应商和原料批次的语义模型。', multimodalContent: { modelContext: '', evidence: [] }, attachments: [], identityScope: identity });
  const denied = applySemanticOperationsProposal({ proposalId: proposal.id, role: getRole('executive'), identityScope: { ...identity, subjectId: 'other-user' } });
  assert.equal(denied.code, 'SEMANTIC_PROPOSAL_NOT_FOUND');
  const applied = applySemanticOperationsProposal({ proposalId: proposal.id, role: getRole('executive'), identityScope: identity });
  assert.equal(applied.proposal.status, 'applied_to_draft');
  assert.ok(applied.draft.objectTypes.some((item) => item.id === 'Supplier'));
  assert.equal(applied.draft.validation, null);
  assert.equal(applied.snapshot.status, 'active');
  assert.equal(listSemanticOperationsSnapshots({ identityScope: identity }).length, 1);
  const rolledBack = rollbackSemanticOperationsSnapshot({ snapshotId: applied.snapshot.id, role: getRole('executive'), identityScope: identity });
  assert.equal(rolledBack.snapshot.status, 'rolled_back');
  assert.ok(!rolledBack.draft.objectTypes.some((item) => item.id === 'Supplier'));
});

test('semantic operations task binds natural-language intent to one reviewable server-side command', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const task = await createSemanticOperationsTask({
    body: { text: '建立供应商、采购订单和原料批次的语义模型。' },
    role: getRole('executive'),
    identityScope: identity
  });
  assert.equal(task.intent, 'build_model');
  assert.equal(task.command, 'apply_proposal');
  assert.equal(task.status, 'waiting_confirmation');
  assert.equal(task.proposal.critic.status, 'passed');
  assert.equal(task.planning.authoritativeIntent, 'build_model');
  assert.ok(['deterministic', 'local_model_advisory'].includes(task.planning.mode));
  const hidden = listSemanticOperationsTasks({ identityScope: { ...identity, subjectId: 'other-user' } });
  assert.equal(hidden.length, 0);
  const confirmation = issueSemanticOperationsTaskConfirmation({ taskId: task.id, identityScope: identity });
  const executed = await executeSemanticOperationsTask({ taskId: task.id, role: getRole('executive'), identityScope: identity, confirmationToken: confirmation.confirmationToken });
  assert.equal(executed.task.status, 'completed');
  assert.equal(executed.task.command, 'apply_proposal');
  assert.ok(executed.result.draft.objectTypes.some((item) => item.id === 'Supplier'));
  const replay = await executeSemanticOperationsTask({ taskId: task.id, role: getRole('executive'), identityScope: identity });
  assert.equal(replay.code, 'SEMANTIC_TASK_NOT_CONFIRMABLE');
});

test('semantic operations status task is read-only and completes without confirmation', async () => {
  resetRuntimeState(['semantic_operations_agent_tasks', 'semantic_operations_agent_snapshots', 'oa_meta_model_runtime']);
  const task = await createSemanticOperationsTask({ body: { text: '检查当前语义模型状态和快照情况。' }, role: getRole('executive'), identityScope: identity });
  assert.equal(task.intent, 'inspect_status');
  assert.equal(task.status, 'completed');
  assert.equal(task.confirmationRequired, false);
  assert.ok(task.result.objectCount >= 10);
  const second = await createSemanticOperationsTask({ body: { text: '再检查一次，并告诉我与上一轮相比是否变化', parentTaskId: task.id }, role: getRole('executive'), identityScope: identity });
  const third = await createSemanticOperationsTask({ body: { text: '再检查一次', parentTaskId: second.id }, role: getRole('executive'), identityScope: identity });
  assert.equal(second.intent, 'inspect_status');
  assert.equal(third.intent, 'inspect_status');
  assert.equal(third.threadId, task.id);
  assert.equal(third.turn, 3);
  assert.match(second.response, /与上一轮检查结果一致/);
  assert.equal(third.messages.length, 6);
  const trace = await getSemanticOperationsTaskTrace({ taskId: third.id, identityScope: identity, accessContext: { roleIds: ['executive'], buttonPermissionIds: [] } });
  assert.ok(trace.eventCount >= 4);
  assert.ok(trace.events.every((event, index) => index === 0 || event.previousHash === trace.events[index - 1].hash));
});

test('semantic operations confirmation is one-time, atomic, and resumes across devices', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const role = getRole('executive');
  const task = await createSemanticOperationsTask({ body: { text: '建立供应商和采购订单语义模型。' }, role, identityScope: identity });
  const missing = await executeSemanticOperationsTask({ taskId: task.id, role, identityScope: identity });
  assert.equal(missing.code, 'SEMANTIC_TASK_CONFIRMATION_INVALID');
  const resumed = listSemanticOperationsTasks({ identityScope: { ...identity, deviceId: 'device-02' } });
  assert.ok(resumed.some((item) => item.id === task.id));
  const confirmation = issueSemanticOperationsTaskConfirmation({ taskId: task.id, identityScope: { ...identity, deviceId: 'device-02' } });
  assert.ok(confirmation.confirmationToken);
  const [first, second] = await Promise.all([
    executeSemanticOperationsTask({ taskId: task.id, role, identityScope: identity, confirmationToken: confirmation.confirmationToken }),
    executeSemanticOperationsTask({ taskId: task.id, role, identityScope: { ...identity, deviceId: 'device-03' }, confirmationToken: confirmation.confirmationToken })
  ]);
  assert.equal([first, second].filter((result) => result.task?.status === 'completed').length, 1);
  assert.equal([first, second].filter((result) => result.code === 'SEMANTIC_TASK_NOT_CONFIRMABLE').length, 1);
});

test('confirmation is invalidated by draft drift and task history supports governed search and archive', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const role = getRole('executive');
  const task = await createSemanticOperationsTask({ body: { text: '检查当前模型结构与断裂关系' }, role, identityScope: identity });
  const draft = getOAMetaModelDraft();
  draft.objectTypes[0].label = '组织（并发修订）';
  assert.ok(!saveOAMetaModelDraft(draft, role).error);
  const stale = issueSemanticOperationsTaskConfirmation({ taskId: task.id, identityScope: identity });
  assert.equal(stale.code, 'SEMANTIC_TASK_REVIEW_STALE');
  const found = listSemanticOperationsTasks({ identityScope: identity, query: '断裂关系', status: 'waiting_confirmation' });
  assert.equal(found.length, 1);
  assert.ok(!archiveSemanticOperationsTask({ taskId: task.id, identityScope: identity }).error);
  assert.equal(listSemanticOperationsTasks({ identityScope: identity }).length, 0);
  assert.equal(listSemanticOperationsTasks({ identityScope: identity, includeArchived: true }).length, 1);
});

test('semantic draft validates metrics, glossary, contracts, quality, access, and lineage as first-class assets', () => {
  resetRuntimeState(['oa_meta_model_runtime']);
  const role = getRole('executive');
  const draft = getOAMetaModelDraft();
  assert.ok(draft.metrics.length && draft.glossaryTerms.length && draft.dataContracts.length && draft.qualityRules.length && draft.accessPolicies.length && draft.lineageEdges.length);
  const passed = validateOAMetaModelDraft(role);
  assert.equal(passed.draft.validation.status, 'passed');
  draft.metrics[0].grain = 'MissingObject';
  assert.ok(!saveOAMetaModelDraft(draft, role).error);
  const failed = validateOAMetaModelDraft(role);
  assert.equal(failed.draft.validation.status, 'failed');
  assert.equal(failed.draft.validation.checks.find((item) => item.name === '指标口径').status, 'failed');
});

test('semantic operations routing never turns greetings, questions, negations, or ambiguous text into model changes', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const role = getRole('executive');
  const cases = [
    ['你好', 'conversation', 'greeting'],
    ['你能做什么？', 'conversation', 'capability_question'],
    ['如何发布语义模型？', 'conversation', 'guidance_question'],
    ['帮我处理一下', 'needs_clarification', 'operation_not_identified'],
    ['不要发布模型', 'conversation', 'negated_operation'],
    ['删除当前模型', 'unsupported_operation', 'unsupported_destructive_operation'],
    ['回滚这个快照', 'unsupported_operation', 'unsupported_destructive_operation']
  ];
  for (const [text, intent, reason] of cases) {
    const classified = classifySemanticOperationsIntent(text);
    assert.equal(classified.intent, intent, text);
    assert.equal(classified.reason, reason, text);
    const task = await createSemanticOperationsTask({ body: { text }, role, identityScope: identity });
    assert.equal(task.intent, intent, text);
    assert.equal(task.status, intent === 'needs_clarification' ? 'needs_input' : 'completed', text);
    assert.equal(task.confirmationRequired, false, text);
    assert.equal(task.command, null, text);
    assert.equal(task.proposal, null, text);
    assert.equal(task.planning, null, text);
  }
  const greeting = listSemanticOperationsTasks({ identityScope: identity }).find((task) => task.request === '你好');
  const deniedReplay = await executeSemanticOperationsTask({ taskId: greeting.id, role, identityScope: identity });
  assert.equal(deniedReplay.code, 'SEMANTIC_TASK_NOT_CONFIRMABLE');
});

test('semantic operations routes each explicit operational intent without cross-command leakage', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const role = getRole('executive');
  const cases = [
    ['检查 ERP 和 WMS 的连接状态', 'discover_sources', 'inspect_sources', false],
    ['查看当前模型发布状态和快照情况', 'inspect_status', 'inspect_status', false],
    ['检查当前模型结构与断裂关系', 'validate_model', 'validate_model', true],
    ['运行 Semantica 校验和模拟构建', 'simulate_model', 'simulate_model', true],
    ['发布语义模型', 'publish_model', 'publish_model', true],
    ['建立 WMS 库存与入库语义模型', 'build_model', 'apply_proposal', true]
  ];
  for (const [text, intent, command, confirmationRequired] of cases) {
    const task = await createSemanticOperationsTask({ body: { text }, role, identityScope: identity });
    assert.equal(task.intent, intent, text);
    assert.equal(task.command, command, text);
    assert.equal(task.confirmationRequired, confirmationRequired, text);
    assert.equal(task.status, confirmationRequired ? 'waiting_confirmation' : 'completed', text);
    assert.equal(Boolean(task.proposal), intent === 'build_model', text);
  }
});

test('semantic operations classifier handles natural-language variants and risky near-matches', () => {
  const cases = [
    ['你好，帮我建立 WMS 库存模型', 'build_model'],
    ['发布是什么意思？', 'conversation'],
    ['我不想发布模型', 'conversation'],
    ['取消发布', 'conversation'],
    ['查看 ERP 接入情况', 'discover_sources'],
    ['列出当前可用系统', 'discover_sources'],
    ['Semantica 是否可用', 'inspect_status'],
    ['模型有多少对象', 'inspect_status'],
    ['发布状态', 'inspect_status'],
    ['检查模型状态', 'inspect_status'],
    ['可以发布模型吗', 'inspect_status'],
    ['查看当前模型结构', 'validate_model'],
    ['检查字段和主键', 'validate_model'],
    ['检查模型结构', 'validate_model'],
    ['校验一下当前草稿', 'validate_model'],
    ['试运行模型', 'simulate_model'],
    ['请发布语义模型', 'publish_model'],
    ['新增供应商对象', 'build_model'],
    ['根据 ERP 数据字典识别供应商对象', 'build_model'],
    ['建立一个模型', 'needs_clarification'],
    ['建立 WMS 模型', 'needs_clarification'],
    ['创建客户对象', 'needs_clarification'],
    ['模拟一下', 'needs_clarification'],
    ['下线模型', 'unsupported_operation'],
    ['hi', 'conversation']
  ];
  for (const [text, intent] of cases) assert.equal(classifySemanticOperationsIntent(text).intent, intent, text);
});

test('semantic proposal generator refuses ungrounded default catalog objects', () => {
  resetRuntimeState(['semantic_operations_agent_proposals']);
  const proposal = createSemanticOperationsProposal({ input: '你好', multimodalContent: { modelContext: '', evidence: [] }, attachments: [], identityScope: identity });
  assert.equal(proposal.code, 'SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS');
  assert.equal(proposal.status, 422);
});

test('semantic source discovery exposes governed WMS readiness without reading business records', async () => {
  resetRuntimeState(['semantic_operations_agent_tasks']);
  const discovery = discoverSemanticSources({ request: '检查 ERP 和 WMS 的连接状态与建模物料。', role: getRole('executive') });
  assert.deepEqual(discovery.requestedSystems, ['ERP', 'WMS']);
  assert.equal(discovery.sources.find((item) => item.code === 'ERP').authorized, true);
  assert.equal(discovery.sources.find((item) => item.code === 'WMS').status, 'not_configured');
  assert.equal(discovery.sources.find((item) => item.code === 'WMS').authorized, true);
  assert.equal(discovery.blockers.length, 0);
  assert.ok(discovery.warnings.some((item) => item.includes('WMS')));
  assert.match(discovery.policy, /不主动查询业务明细/);

  const task = await createSemanticOperationsTask({
    body: { text: '检查 ERP 和 WMS 的连接状态与建模物料。' },
    role: getRole('executive'),
    identityScope: identity
  });
  assert.equal(task.intent, 'discover_sources');
  assert.equal(task.command, 'inspect_sources');
  assert.equal(task.status, 'completed');
  assert.equal(task.confirmationRequired, false);
  assert.equal(task.sourceDiscovery.blockers.length, 0);
  assert.ok(task.sourceDiscovery.sources.find((item) => item.code === 'WMS').mappings.length >= 2);
  const explicitWms = discoverSemanticSources({ request: '根据 WMS 库存与入库数据建设模型。', role: getRole('executive') });
  assert.deepEqual(explicitWms.requestedSystems, ['WMS']);
  assert.deepEqual(explicitWms.sources.map((item) => item.code), ['WMS']);
});

test('WMS mock connector provides coherent inventory and receipt events', () => {
  const connector = getMockConnectorCatalog().find((item) => item.systemId === 'wms');
  const records = getMockSystemRecords('wms');
  assert.equal(connector.health, 'healthy');
  assert.equal(records.length, 100);
  assert.ok(records.some((item) => item.objectType === 'InventoryLot'));
  assert.ok(records.some((item) => item.objectType === 'InboundReceipt'));
  assert.ok(records.some((item) => item.objectType === 'Warehouse'));
  assert.ok(records.filter((item) => item.objectType === 'InboundReceipt').every((item) => item.payload.inventoryLotId));
});

test('OpenAPI material discovers WMS objects, primary keys, and references before draft review', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const openapi = {
    openapi: '3.1.0',
    info: { title: 'WMS Schema', version: '1.0.0' },
    paths: {},
    components: { schemas: {
      InventoryLot: {
        type: 'object', required: ['inventoryLotId', 'materialBatchId'],
        properties: {
          inventoryLotId: { type: 'string', 'x-primary-key': true },
          materialBatchId: { type: 'string' },
          warehouseCode: { type: 'string' },
          quantity: { type: 'number' }
        }
      },
      InboundReceipt: {
        type: 'object', required: ['receiptId'],
        properties: {
          receiptId: { type: 'string', 'x-primary-key': true },
          inventoryLot: { $ref: '#/components/schemas/InventoryLot' },
          receivedQty: { type: 'number' }
        }
      }
    } }
  };
  const proposal = await createSemanticOperationsProposalFromRequest({
    body: { text: '根据 WMS OpenAPI 建设入库与库存批次语义模型。', attachments: [{ name: 'wms-openapi.json', mimeType: 'application/json', dataUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(openapi)).toString('base64')}` }] },
    role: getRole('executive'),
    identityScope: identity
  });
  assert.equal(proposal.schemaDiscovery.files[0].format, 'openapi_json');
  assert.equal(proposal.schemaDiscovery.files[0].sourceSystem, 'WMS');
  assert.ok(proposal.objectTypes.some((item) => item.id === 'InventoryLot' && item.key === 'inventoryLotId'));
  assert.ok(proposal.objectTypes.some((item) => item.id === 'InboundReceipt' && item.key === 'receiptId'));
  assert.deepEqual(proposal.objectTypes.map((item) => item.id).sort(), ['InboundReceipt', 'InventoryLot']);
  assert.ok(proposal.objectTypes.flatMap((item) => item.fieldDefinitions).every((field) => field.mappingStatus === 'mapped' && field.sourceField));
  assert.ok(proposal.relationshipTypes.some((item) => item.from === 'InboundReceipt' && item.to === 'InventoryLot'));
  assert.equal(proposal.critic.status, 'passed');
});

test('visual proposal revision recalculates field metadata, critic, diff, and applied draft', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const task = await createSemanticOperationsTask({ body: { text: '建立 WMS 库存与入库语义模型。' }, role: getRole('executive'), identityScope: identity });
  const objects = structuredClone(task.proposal.objectTypes);
  const inventory = objects.find((item) => item.id === 'Inventory');
  inventory.label = '仓储可用库存';
  inventory.key = 'inventory_code';
  inventory.fieldDefinitions = inventory.fieldDefinitions.map((field) => field.name === 'inventory_id' ? { ...field, name: 'inventory_code', type: 'string', required: true, primaryKey: true } : { ...field, primaryKey: false });
  inventory.fields = inventory.fieldDefinitions.map((field) => field.name);
  const revised = reviseSemanticOperationsTaskProposal({
    taskId: task.id,
    body: { revision: task.proposal.revision, objectTypes: objects, relationshipTypes: task.proposal.relationshipTypes },
    role: getRole('executive'),
    identityScope: identity
  });
  assert.equal(revised.proposal.revision, 2);
  assert.equal(revised.proposal.critic.status, 'passed');
  assert.equal(revised.proposal.objectTypes.find((item) => item.id === 'Inventory').key, 'inventory_code');
  assert.equal(revised.proposal.objectTypes.find((item) => item.id === 'Inventory').fieldDefinitions.filter((item) => item.primaryKey).length, 1);
  assert.ok(revised.proposal.editDiff.summary.updatedObjects >= 1);
  assert.equal(revised.proposal.impactAnalysis.riskLevel, 'high');
  assert.deepEqual(revised.proposal.impactAnalysis.keyChanges, ['Inventory']);
  const confirmation = issueSemanticOperationsTaskConfirmation({ taskId: task.id, identityScope: identity });
  const executed = await executeSemanticOperationsTask({ taskId: task.id, role: getRole('executive'), identityScope: identity, confirmationToken: confirmation.confirmationToken });
  const appliedInventory = executed.result.draft.objectTypes.find((item) => item.id === 'Inventory');
  assert.equal(appliedInventory.label, '仓储可用库存');
  assert.equal(appliedInventory.key, 'inventory_code');
  assert.equal(appliedInventory.fieldDefinitions.find((item) => item.primaryKey).name, 'inventory_code');
  assert.equal(appliedInventory.fieldDefinitions.find((item) => item.primaryKey).mappingStatus, 'mapped');
});

test('proposal revision rejects stale versions, other identities, and broken relationships', () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const proposal = createSemanticOperationsProposal({ input: '建立供应商和原料批次语义模型。', multimodalContent: { modelContext: '', evidence: [] }, attachments: [], identityScope: identity });
  const denied = updateSemanticOperationsProposal({ proposalId: proposal.id, revision: 1, objectTypes: proposal.objectTypes, relationshipTypes: proposal.relationshipTypes, role: getRole('executive'), identityScope: { ...identity, subjectId: 'other' } });
  assert.equal(denied.code, 'SEMANTIC_PROPOSAL_NOT_FOUND');
  const broken = updateSemanticOperationsProposal({ proposalId: proposal.id, revision: 1, objectTypes: proposal.objectTypes, relationshipTypes: [{ from: 'Supplier', predicate: 'invalid', to: 'MissingObject' }], role: getRole('executive'), identityScope: identity });
  assert.equal(broken.code, 'SEMANTIC_PROPOSAL_INVALID');
  const updated = updateSemanticOperationsProposal({ proposalId: proposal.id, revision: 1, objectTypes: proposal.objectTypes, relationshipTypes: proposal.relationshipTypes, role: getRole('executive'), identityScope: identity });
  assert.equal(updated.revision, 2);
  const stale = updateSemanticOperationsProposal({ proposalId: proposal.id, revision: 1, objectTypes: proposal.objectTypes, relationshipTypes: proposal.relationshipTypes, role: getRole('executive'), identityScope: identity });
  assert.equal(stale.code, 'SEMANTIC_PROPOSAL_REVISION_CONFLICT');
  assert.equal(stale.proposal.revision, 2);
});

test('pending source mappings remain reviewable but block proposal confirmation', () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const proposal = createSemanticOperationsProposal({ input: '建立供应商语义模型。', multimodalContent: { modelContext: '', evidence: [] }, attachments: [], identityScope: identity });
  const objects = structuredClone(proposal.objectTypes);
  objects[0].fieldDefinitions.push({ name: 'risk_score', type: 'number', required: false, primaryKey: false, sourceField: '', mappingStatus: 'pending', reference: null, description: null });
  objects[0].fields.push('risk_score');
  const revised = updateSemanticOperationsProposal({ proposalId: proposal.id, revision: proposal.revision, objectTypes: objects, relationshipTypes: proposal.relationshipTypes, role: getRole('executive'), identityScope: identity });
  assert.equal(revised.revision, 2);
  assert.equal(revised.critic.status, 'failed');
  assert.equal(revised.critic.checks.find((item) => item.name === '字段来源映射').status, 'failed');
  assert.deepEqual(revised.impactAnalysis.pendingMappings, ['Supplier.risk_score']);
  assert.equal(revised.impactAnalysis.changedObjectCount, 1);
  assert.equal(revised.impactAnalysis.publishBlocked, true);
  const blocked = applySemanticOperationsProposal({ proposalId: proposal.id, role: getRole('executive'), identityScope: identity });
  assert.equal(blocked.code, 'SEMANTIC_PROPOSAL_CRITIC_FAILED');
});

test('mapping contract converts governed WMS Mock samples into canonical fact previews', () => {
  const draft = { objectTypes: [{
    id: 'InventoryLot', label: '库存批次', source: 'wms.inventory_lot', sourceSystems: ['WMS'], key: 'inventoryLotId', classification: '仓储运营受限',
    fields: ['inventoryLotId', 'materialBatchId', 'quantity'],
    fieldDefinitions: [
      { name: 'inventoryLotId', type: 'string', required: true, primaryKey: true, sourceField: 'inventoryLotId', mappingStatus: 'mapped' },
      { name: 'materialBatchId', type: 'string', required: true, primaryKey: false, sourceField: 'materialBatchId', mappingStatus: 'mapped' },
      { name: 'quantity', type: 'number', required: false, primaryKey: false, sourceField: 'quantity', mappingStatus: 'mapped' }
    ]
  }] };
  const contract = buildSemanticMappingContract(draft);
  const validation = validateSemanticMappingContract(draft);
  assert.equal(contract.schemaVersion, 'semantic-mapping-contract.v1');
  assert.match(contract.contractId, /^smc-/);
  assert.equal(validation.status, 'passed');
  assert.equal(validation.blocked, false);
  assert.equal(validation.summary.sampleCount, 3);
  assert.equal(validation.summary.successfulSampleCount, 3);
  assert.equal(validation.summary.observedCoveragePercent, 100);
  assert.match(validation.objects[0].transformedSamples[0].canonicalFact.id, /^InventoryLot:INVLOT-/);
  assert.equal(validation.objects[0].transformedSamples[0].canonicalFact.source.simulated, true);
});

test('mapping rehearsal blocks draft adoption until a missing required source field is repaired', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const openapi = {
    openapi: '3.1.0', info: { title: 'WMS Mapping Gate', version: '1.0.0' }, paths: {},
    components: { schemas: { InventoryLot: { type: 'object', required: ['inventoryLotId', 'measuredQuantity'], properties: {
      inventoryLotId: { type: 'string', 'x-primary-key': true },
      measuredQuantity: { type: 'number' }
    } } } }
  };
  const proposal = await createSemanticOperationsProposalFromRequest({
    body: { text: '根据 WMS OpenAPI 建设库存批次语义模型。', attachments: [{ name: 'wms-mapping.json', mimeType: 'application/json', dataUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(openapi)).toString('base64')}` }] },
    role: getRole('executive'), identityScope: identity
  });
  assert.equal(proposal.critic.status, 'passed');
  assert.equal(proposal.mappingValidation.status, 'failed');
  assert.equal(proposal.mappingValidation.blocked, true);
  assert.ok(proposal.mappingValidation.issues.some((issue) => issue.code === 'REQUIRED_SOURCE_VALUE_MISSING' && issue.field === 'measuredQuantity'));
  const blocked = applySemanticOperationsProposal({ proposalId: proposal.id, role: getRole('executive'), identityScope: identity });
  assert.equal(blocked.code, 'SEMANTIC_PROPOSAL_MAPPING_VALIDATION_FAILED');

  const objects = structuredClone(proposal.objectTypes);
  const measuredQuantity = objects[0].fieldDefinitions.find((field) => field.name === 'measuredQuantity');
  measuredQuantity.sourceField = 'quantity';
  measuredQuantity.mappingStatus = 'manual';
  const revised = updateSemanticOperationsProposal({ proposalId: proposal.id, revision: proposal.revision, objectTypes: objects, relationshipTypes: proposal.relationshipTypes, role: getRole('executive'), identityScope: identity });
  assert.equal(revised.mappingValidation.status, 'passed');
  assert.equal(revised.mappingValidation.blocked, false);
  const applied = applySemanticOperationsProposal({ proposalId: proposal.id, role: getRole('executive'), identityScope: identity });
  assert.equal(applied.proposal.status, 'applied_to_draft');
});

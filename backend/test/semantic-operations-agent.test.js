import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState, writeState } from '../src/repositories/runtime-state-repository.js';
import { mutateSemanticGovernanceState, readSemanticGovernanceState } from '../src/services/semantic-governance-store.js';
import { getRole } from '../src/services/authorization-service.js';
import { applySemanticOperationsProposal, createSemanticOperationsProposal, createSemanticOperationsProposalFromRequest, listSemanticOperationsSnapshots, rollbackSemanticOperationsSnapshot, saveSemanticOperationsDraft, updateSemanticOperationsProposal } from '../src/services/semantic-operations-agent-service.js';
import { archiveSemanticOperationsTask, classifySemanticOperationsIntent, createSemanticOperationsTask, executeSemanticOperationsTask, getSemanticOperationsTask, getSemanticOperationsTaskTrace, issueSemanticOperationsTaskConfirmation, listSemanticOperationsTasks, reviseSemanticOperationsTaskProposal } from '../src/services/semantic-operations-task-service.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft, validateOAMetaModelDraft } from '../src/services/meta-model-service.js';
import { detectRequestedSemanticSystems, discoverSemanticSources } from '../src/services/semantic-source-discovery-service.js';
import { getMockConnectorCatalog, getMockSystemRecords } from '../src/services/mock-scenario-service.js';
import { buildSemanticMappingContract, validateSemanticMappingContract, validateGovernedSemanticSamples } from '../src/services/semantic-mapping-validation-service.js';
import { resolveSemanticOperationsPlanSystems } from '../src/services/semantic-operations-planner-service.js';
import { naturalSchemaSkipReason, NATURAL_SCHEMA_SKIP_REASONS } from '../src/services/semantic-natural-schema-service.js';
import { semanticOperationsPrincipalKey } from '../src/services/semantic-operations-identity.js';
import { CANDIDATE_CATALOG, CANDIDATE_CATALOG_SIZE, listCatalogGaps, listUncoveredMentions, matchCandidateCatalog, UNCOVERED_MENTION_LIMIT } from '../src/services/semantic-candidate-catalog-service.js';

const identity = { tenantId: 'semantic-test', subjectId: 'architect-01', deviceId: 'device-01' };

test('explicit object addition follows task identity/CAS, invalidates old confirmation and blocks unmapped adoption', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_tasks', 'semantic_operations_agent_snapshots', 'oa_meta_model_runtime']);
  const role = getRole('executive'); const baseline = await getOAMetaModelDraft();
  let task = await createSemanticOperationsTask({ body: { text: '建立供应商语义模型。', systemCodes: ['ERP'] }, role, identityScope: identity });
  const token = await issueSemanticOperationsTaskConfirmation({ taskId: task.id, identityScope: identity });
  const body = { text: '新增对象“Customer”，名称“客户”，主键“customer_id”，类型“文本”，业务域“销售”，字段“name”，字段类型“文本”', parentTaskId: task.id, parentProposalRevision: task.proposal.revision };
  assert.equal((await createSemanticOperationsTask({ body: { text: body.text }, role, identityScope: identity })).code, 'SEMANTIC_EDIT_PROPOSAL_REQUIRED');
  assert.equal((await createSemanticOperationsTask({ body, role, identityScope: { ...identity, subjectId: 'other' } })).code, 'SEMANTIC_PARENT_TASK_NOT_FOUND');
  assert.equal((await createSemanticOperationsTask({ body, role, identityScope: { ...identity, tenantId: 'other-tenant' } })).code, 'SEMANTIC_PARENT_TASK_NOT_FOUND');
  assert.equal((await createSemanticOperationsTask({ body: { ...body, parentProposalRevision: 0 }, role, identityScope: identity })).code, 'SEMANTIC_PROPOSAL_REVISION_CONFLICT');
  task = await createSemanticOperationsTask({ body, role, identityScope: identity });
  assert.ok(!task.error, task.error); assert.equal(task.proposal.revision, body.parentProposalRevision + 1);
  const object = task.proposal.objectTypes.find(item => item.id === 'Customer');
  assert.deepEqual(object.sourceSystems, ['UNASSIGNED']); assert.equal(object.fieldDefinitions[0].sourceField, '');
  assert.equal(object.fieldDefinitions[0].mappingStatus, 'pending'); assert.equal(object.key, 'customer_id');
  assert.equal((await executeSemanticOperationsTask({ taskId: task.id, role, identityScope: identity, confirmationToken: token.confirmationToken })).code, 'SEMANTIC_TASK_CONFIRMATION_INVALID');
  const applied = await applySemanticOperationsProposal({ proposalId: task.proposal.id, role, identityScope: identity });
  assert.ok(applied.error, 'unmapped new objects must not be adopted');
  const current = await getOAMetaModelDraft();
  assert.deepEqual(current.objectTypes, baseline.objectTypes);
  assert.deepEqual(current.relationshipTypes, baseline.relationshipTypes);
  assert.equal(current.fingerprint, baseline.fingerprint);
  assert.equal((await listSemanticOperationsSnapshots({ identityScope: identity })).length, 0);
});

test('explicit relationship creation stays in the authorized candidate and does not infer joins or publish', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_tasks', 'semantic_operations_agent_snapshots', 'oa_meta_model_runtime']);
  const role = getRole('executive'); const baseline = await getOAMetaModelDraft();
  let task = await createSemanticOperationsTask({ body: { text: '建立供应商和采购订单语义模型。', systemCodes: ['ERP'] }, role, identityScope: identity });
  const taskId = task.id; const proposalId = task.proposal.id; const revision = task.proposal.revision;
  const token = await issueSemanticOperationsTaskConfirmation({ taskId, identityScope: identity });
  const command = '新增关系“fulfillsOrder”，从“Supplier”到“PurchaseOrder”，名称“履约订单”，基数“一对多”，依据“人工描述供应商承担订单履约责任”';
  const edit = text => createSemanticOperationsTask({ body: { text, parentTaskId: taskId, parentProposalRevision: task.proposal.revision }, role, identityScope: identity });
  task = await edit(`${command}；将“Supplier/fulfillsOrder/PurchaseOrder”的关系名称改为“订单履约责任”`);
  assert.equal(task.id, taskId); assert.equal(task.proposal.id, proposalId); assert.equal(task.proposal.revision, revision + 1);
  const relation = task.proposal.relationshipTypes.find(item => item.predicate === 'fulfillsOrder');
  assert.equal(relation.label, '订单履约责任'); assert.equal(relation.provenanceType, 'declared'); assert.ok(!relation.keyMapping); assert.ok(!relation.derivedFrom);
  assert.equal((await executeSemanticOperationsTask({ taskId, role, identityScope: identity, confirmationToken: token.confirmationToken })).code, 'SEMANTIC_TASK_CONFIRMATION_INVALID');
  const before = await getSemanticOperationsTask({ taskId, identityScope: identity });
  assert.equal((await edit(command)).code, 'SEMANTIC_EDIT_RELATION_CONFLICT');
  assert.deepEqual(await getSemanticOperationsTask({ taskId, identityScope: identity }), before);
  const stranger = { ...identity, subjectId: 'other' };
  assert.ok((await createSemanticOperationsTask({ body: { text: command, parentTaskId: taskId, parentProposalRevision: task.proposal.revision }, role, identityScope: stranger })).error);
  assert.equal((await createSemanticOperationsTask({ body: { text: command }, role, identityScope: identity })).code, 'SEMANTIC_EDIT_PROPOSAL_REQUIRED');
  assert.deepEqual((await getOAMetaModelDraft()).relationshipTypes, baseline.relationshipTypes);
  const reviewed = await issueSemanticOperationsTaskConfirmation({ taskId, identityScope: identity });
  assert.ok(reviewed.confirmationToken);
  const applied = await executeSemanticOperationsTask({ taskId, role, identityScope: identity, confirmationToken: reviewed.confirmationToken });
  assert.ok(!applied.error, applied.error); assert.equal(applied.task.status, 'completed');
  const saved = await getOAMetaModelDraft();
  const savedRelation = saved.relationshipTypes.find(item => item.predicate === 'fulfillsOrder');
  assert.equal(savedRelation.label, relation.label); assert.equal(savedRelation.evidence, relation.evidence);
  assert.equal(savedRelation.provenanceType, 'declared'); assert.ok(!savedRelation.keyMapping);
  // Persisted JSON omits undefined optional enum properties; compare wire-equivalent definitions.
  assert.deepEqual(saved.objectTypes.find(item => item.id === 'Supplier').fieldDefinitions, JSON.parse(JSON.stringify(task.proposal.objectTypes.find(item => item.id === 'Supplier').fieldDefinitions)));
});

test('atomic conversational batches persist once, invalidate confirmation and leave failed batches unchanged', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_tasks', 'semantic_operations_agent_snapshots', 'oa_meta_model_runtime']);
  const role = getRole('executive'); const baseline = await getOAMetaModelDraft();
  let task = await createSemanticOperationsTask({ body: { text: '建立供应商和采购订单语义模型。', systemCodes: ['ERP'] }, role, identityScope: identity });
  const id = task.id; const proposalId = task.proposal.id; const revision = task.proposal.revision;
  const token = await issueSemanticOperationsTaskConfirmation({ taskId: id, identityScope: identity });
  const edit = text => createSemanticOperationsTask({ body: { text, parentTaskId: id, parentProposalRevision: task.proposal.revision }, role, identityScope: identity });
  task = await edit('将“Supplier”的业务域改为“采购”；将“Supplier”的业务名称改为“采购供应商”；将“Supplier”的业务说明改为“负责供货；不是生产主体”');
  assert.equal(task.id, id); assert.equal(task.proposal.id, proposalId); assert.equal(task.proposal.revision, revision + 1);
  assert.equal(task.proposal.objectTypes.find(item => item.id === 'Supplier').description, '负责供货；不是生产主体');
  assert.equal((await executeSemanticOperationsTask({ taskId: id, role, identityScope: identity, confirmationToken: token.confirmationToken })).code, 'SEMANTIC_TASK_CONFIRMATION_INVALID');
  const before = await getSemanticOperationsTask({ taskId: id, identityScope: identity });
  const failed = await edit('将“Supplier”的业务域改为“物流”；将“不存在”的业务名称改为“错项”');
  assert.equal(failed.code, 'SEMANTIC_EDIT_TARGET_AMBIGUOUS');
  assert.deepEqual(await getSemanticOperationsTask({ taskId: id, identityScope: identity }), before);
  task = await edit('给“Supplier”新增字段“risk_score”，类型“number”；将“Supplier.risk_score”的字段说明改为“待确认风险分”');
  assert.equal(task.proposal.revision, revision + 2);
  assert.equal((await issueSemanticOperationsTaskConfirmation({ taskId: id, identityScope: identity })).code, 'SEMANTIC_TASK_PROPOSAL_BLOCKED');
  assert.deepEqual((await getOAMetaModelDraft()).objectTypes, baseline.objectTypes);
});

test('workspace questions bind an existing authorized object and model fingerprint across followup, reject drift and fabricated context', async () => {
  resetRuntimeState(['oa_meta_model_runtime', 'semantic_operations_agent_tasks']); const role = getRole('executive');
  const draft = await getOAMetaModelDraft(); const workspaceContext = { fingerprint: draft.fingerprint, objectId: draft.objectTypes[0].id };
  const first = await createSemanticOperationsTask({ body: { text: '解释这个对象的业务含义', workspaceContext }, role, identityScope: identity });
  assert.deepEqual(first.workspaceContext, workspaceContext); assert.equal(first.confirmationRequired, false);
  const followup = await createSemanticOperationsTask({ body: { text: '它有哪些关系', parentTaskId: first.id }, role, identityScope: identity }); assert.deepEqual(followup.workspaceContext, workspaceContext);
  const forged = await createSemanticOperationsTask({ body: { text: '解释对象', workspaceContext: { ...workspaceContext, objectId: 'NotExists' } }, role, identityScope: identity }); assert.equal(forged.code, 'SEMANTIC_WORKSPACE_TARGET_INVALID');
  const injected = await createSemanticOperationsTask({ body: { text: '解释对象', workspaceContext: { ...workspaceContext, grant: 'admin' } }, role, identityScope: identity }); assert.equal(injected.code, 'SEMANTIC_WORKSPACE_TARGET_INVALID');
  await saveOAMetaModelDraft({ ...draft, objectTypes: draft.objectTypes.map((object, index) => ({ ...object, label: index ? object.label : '已更新' })) }, role);
  const stale = await createSemanticOperationsTask({ body: { text: '再解释一次', parentTaskId: first.id }, role, identityScope: identity }); assert.equal(stale.code, 'SEMANTIC_WORKSPACE_STALE');
});

test('three explicit conversational edits retain one proposal, increment revisions and invalidate old confirmation without publishing', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_tasks', 'semantic_operations_agent_snapshots', 'oa_meta_model_runtime']);
  const role = getRole('executive'); const before = await getOAMetaModelDraft();
  let task = await createSemanticOperationsTask({ body: { text: '建立供应商和采购订单语义模型。', systemCodes: ['ERP'] }, role, identityScope: identity });
  const originalId = task.id; const proposalId = task.proposal.id; const revision = task.proposal.revision;
  const confirmation = await issueSemanticOperationsTaskConfirmation({ taskId: task.id, identityScope: identity });
  for (const [field, value] of [['业务域', '采购'], ['业务名称', '采购供应商'], ['业务说明', '本场景供货责任主体']]) {
    task = await createSemanticOperationsTask({ body: { text: `将“Supplier”的${field}改为“${value}”`, parentTaskId: task.id, parentProposalRevision: task.proposal.revision }, role, identityScope: identity });
    assert.equal(task.id, originalId); assert.equal(task.proposal.id, proposalId); assert.equal(task.status, 'waiting_confirmation');
  }
  assert.equal(task.proposal.revision, revision + 3); assert.equal(task.proposal.objectTypes.find(object => object.id === 'Supplier').businessDomain, '采购');
  assert.equal(task.proposal.objectTypes.find(object => object.id === 'Supplier').label, '采购供应商');
  assert.deepEqual((await getOAMetaModelDraft()).objectTypes, before.objectTypes);
  const stale = await createSemanticOperationsTask({ body: { text: '将“Supplier”的业务域改为“物流”', parentTaskId: task.id, parentProposalRevision: revision }, role, identityScope: identity });
  assert.equal(stale.code, 'SEMANTIC_PROPOSAL_REVISION_CONFLICT');
  const unknown = await createSemanticOperationsTask({ body: { text: '将“不存在”的业务域改为“物流”', parentTaskId: task.id, parentProposalRevision: task.proposal.revision }, role, identityScope: identity });
  assert.equal(unknown.code, 'SEMANTIC_EDIT_TARGET_AMBIGUOUS');
  const execution = await executeSemanticOperationsTask({ taskId: task.id, role, identityScope: identity, confirmationToken: confirmation.confirmationToken });
  assert.equal(execution.code, 'SEMANTIC_TASK_CONFIRMATION_INVALID');
});

test('conversational field edits and additions retain the candidate and fail closed on pending mappings', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_tasks', 'semantic_operations_agent_snapshots', 'oa_meta_model_runtime']);
  const role = getRole('executive'); const before = await getOAMetaModelDraft();
  let task = await createSemanticOperationsTask({ body: { text: '建立供应商和采购订单语义模型。', systemCodes: ['ERP'] }, role, identityScope: identity });
  const taskId = task.id; const proposalId = task.proposal.id; const object = task.proposal.objectTypes.find(item => item.id === 'Supplier');
  const field = object.fieldDefinitions.find(item => !item.primaryKey); assert.ok(field);
  const confirmation = await issueSemanticOperationsTaskConfirmation({ taskId, identityScope: identity });
  const edit = text => createSemanticOperationsTask({ body: { text, parentTaskId: task.id, parentProposalRevision: task.proposal.revision }, role, identityScope: identity });
  task = await edit(`将“Supplier.${field.name}”的字段说明改为“当前合成场景的供应商描述”`);
  assert.equal(task.id, taskId); assert.equal(task.proposal.id, proposalId);
  assert.equal(task.proposal.objectTypes.find(item => item.id === 'Supplier').fieldDefinitions.find(item => item.name === field.name).description, '当前合成场景的供应商描述');
  assert.equal((await executeSemanticOperationsTask({ taskId, role, identityScope: identity, confirmationToken: confirmation.confirmationToken })).code, 'SEMANTIC_TASK_CONFIRMATION_INVALID');
  const revision = task.proposal.revision;
  assert.equal((await edit('将“Supplier.supplier_id”的字段类型改为“number”')).code, 'SEMANTIC_EDIT_KEY_CHANGE_REQUIRES_REVIEW');
  assert.equal((await getSemanticOperationsTask({ taskId, identityScope: identity })).proposal.revision, revision);
  task = await edit('给“Supplier”新增字段“risk_score”，类型“number”，说明“待确认风险分”');
  assert.equal(task.id, taskId); assert.equal(task.proposal.id, proposalId);
  const added = task.proposal.objectTypes.find(item => item.id === 'Supplier').fieldDefinitions.find(item => item.name === 'risk_score');
  assert.equal(added.mappingStatus, 'pending'); assert.equal(added.sourceField, ''); assert.equal(added.primaryKey, false);
  assert.equal(task.proposal.impactAnalysis.publishBlocked, true); assert.equal(task.proposal.critic.status, 'failed');
  assert.equal((await issueSemanticOperationsTaskConfirmation({ taskId, identityScope: identity })).code, 'SEMANTIC_TASK_PROPOSAL_BLOCKED');
  assert.equal((await applySemanticOperationsProposal({ proposalId, role, identityScope: identity })).code, 'SEMANTIC_PROPOSAL_CRITIC_FAILED');
  const pendingRevision = task.proposal.revision;
  task = await edit('撤回候选字段“Supplier.risk_score”');
  assert.equal(task.id, taskId); assert.equal(task.proposal.id, proposalId); assert.equal(task.proposal.revision, pendingRevision + 1);
  assert.equal(task.proposal.objectTypes.find(item => item.id === 'Supplier').fields.includes('risk_score'), false);
  assert.equal(task.proposal.critic.status, 'passed');
  assert.ok((await issueSemanticOperationsTaskConfirmation({ taskId, identityScope: identity })).confirmationToken);
  assert.equal((await edit('撤回候选字段“Supplier.supplier_id”')).code, 'SEMANTIC_FIELD_REMOVAL_KEY_FORBIDDEN');
  assert.deepEqual((await getOAMetaModelDraft()).objectTypes, before.objectTypes);
});

test('withdrawal rechecks private server governance omitted from the public candidate before persisting', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'oa_meta_model_runtime']);
  const role = getRole('executive'); const initial = await createSemanticOperationsProposal({ input: '建立供应商语义模型。', identityScope: identity });
  const objects = structuredClone(initial.objectTypes);
  objects[0].fieldDefinitions.push({ name: 'risk_score', type: 'number', sourceField: '', mappingStatus: 'pending' }); objects[0].fields.push('risk_score');
  const added = await updateSemanticOperationsProposal({ proposalId: initial.id, revision: initial.revision, objectTypes: objects, relationshipTypes: initial.relationshipTypes, role, identityScope: identity });
  assert.equal(added.metrics, undefined);
  await mutateSemanticGovernanceState('semantic_operations_agent_proposals', `proposal-${initial.id}`, null, stored => {
    stored.draft.metrics = [{ id: 'risk_metric', expression: 'sum(risk_score)' }]; return { value: stored };
  });
  const reduced = structuredClone(added.objectTypes); reduced[0].fields = reduced[0].fields.filter(name => name !== 'risk_score'); reduced[0].fieldDefinitions = reduced[0].fieldDefinitions.filter(field => field.name !== 'risk_score');
  const rejected = await updateSemanticOperationsProposal({ proposalId: initial.id, revision: added.revision, objectTypes: reduced, relationshipTypes: added.relationshipTypes,
    candidateFieldWithdrawal: { objectId: reduced[0].id, fieldName: 'risk_score' }, role, identityScope: identity });
  assert.equal(rejected.code, 'SEMANTIC_FIELD_REMOVAL_DEPENDENCIES');
  assert.ok(rejected.dependencies.some(target => target.section === 'metrics'));
  const current = await readSemanticGovernanceState('semantic_operations_agent_proposals', `proposal-${initial.id}`);
  assert.equal(current.revision, added.revision); assert.ok(current.draft.objectTypes[0].fields.includes('risk_score'));
});

test('explicit candidate field commands require a target task and reject wrong identities and attachments', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_tasks']); const role = getRole('executive');
  const command = '给“Supplier”新增字段“risk_score”，类型“number”';
  assert.equal((await createSemanticOperationsTask({ body: { text: command }, role, identityScope: identity })).code, 'SEMANTIC_EDIT_PROPOSAL_REQUIRED');
  const task = await createSemanticOperationsTask({ body: { text: '建立供应商语义模型。', systemCodes: ['ERP'] }, role, identityScope: identity });
  const body = { text: command, parentTaskId: task.id, parentProposalRevision: task.proposal.revision };
  assert.equal((await createSemanticOperationsTask({ body, role, identityScope: { ...identity, subjectId: 'other' } })).code, 'SEMANTIC_PARENT_TASK_NOT_FOUND');
  assert.equal((await createSemanticOperationsTask({ body: { ...body, attachments: [{}] }, role, identityScope: identity })).code, 'SEMANTIC_EDIT_ATTACHMENT_UNSUPPORTED');
  assert.equal((await createSemanticOperationsTask({ body: { ...body, parentProposalRevision: 0 }, role, identityScope: identity })).code, 'SEMANTIC_PROPOSAL_REVISION_CONFLICT');
});

test('adoption mode is explicit: merge preserves objects, replace shows removals and remains recoverable', async () => {
  for (const adoptionMode of ['merge', 'replace']) {
    resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'oa_meta_model_runtime']);
    const before = await getOAMetaModelDraft();
    const proposal = await createSemanticOperationsProposal({ input: '建立供应商和原料批次的语义模型。', identityScope: identity, adoptionMode });
    assert.equal(proposal.adoptionMode, adoptionMode);
    const expectedRemoved = adoptionMode === 'replace' ? before.relationshipTypes.filter(item => !proposal.relationshipTypes.some(next => next.from === item.from && next.to === item.to && next.predicate === item.predicate)).length : 0;
    assert.equal(proposal.diff.summary.removedRelationships, expectedRemoved);
    assert.equal(proposal.diff.relationshipChanges.filter(item => item.change === 'removed').length, expectedRemoved);
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

test('semantic operations proposal can be applied by its owner or a same-tenant designated reviewer', () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const proposal = createSemanticOperationsProposal({ input: '建立供应商和原料批次的语义模型。', multimodalContent: { modelContext: '', evidence: [] }, attachments: [], identityScope: identity });
  const denied = applySemanticOperationsProposal({ proposalId: proposal.id, role: getRole('executive'), identityScope: { ...identity, subjectId: 'other-user' } });
  assert.equal(denied.code, 'SEMANTIC_PROPOSAL_NOT_FOUND');
  const noReviewPermission = applySemanticOperationsProposal({ proposalId: proposal.id, role: getRole('quality_manager'), identityScope: { ...identity, subjectId: 'reviewer' }, accessContext: { buttonPermissionIds: ['meta_model.draft.save'] } });
  assert.equal(noReviewPermission.code, 'SEMANTIC_PROPOSAL_NOT_FOUND');
  const reviewerIdentity = { ...identity, subjectId: 'reviewer' };
  const applied = applySemanticOperationsProposal({ proposalId: proposal.id, role: getRole('quality_manager'), identityScope: reviewerIdentity, accessContext: { buttonPermissionIds: ['meta_model.draft.save', 'meta_model.draft.review'] } });
  assert.equal(applied.proposal.status, 'applied_to_draft');
  assert.ok(applied.draft.objectTypes.some((item) => item.id === 'Supplier'));
  assert.equal(applied.draft.validation, null);
  assert.equal(applied.snapshot.status, 'active');
  assert.equal(applied.snapshot.createdBySubjectId, reviewerIdentity.subjectId);
  assert.equal(listSemanticOperationsSnapshots({ identityScope: identity }).length, 0);
  assert.equal(listSemanticOperationsSnapshots({ identityScope: reviewerIdentity })[0].rollbackAllowed, true);
  const manualDraft = { ...applied.draft, objectTypes: applied.draft.objectTypes.map((item, index) => index ? item : { ...item, label: `${item.label}（人工修订）` }) };
  const manualSave = saveSemanticOperationsDraft({ input: manualDraft, role: getRole('quality_manager'), identityScope: reviewerIdentity });
  assert.equal(manualSave.snapshot.sourceType, 'manual_save');
  const versionsAfterManualSave = listSemanticOperationsSnapshots({ identityScope: reviewerIdentity });
  assert.equal(versionsAfterManualSave.length, 2);
  assert.equal(versionsAfterManualSave.find((item) => item.sourceType === 'manual_save').rollbackAllowed, true);
  assert.equal(versionsAfterManualSave.find((item) => item.sourceType === 'agent_adoption').rollbackAllowed, false);
  const manualRollback = rollbackSemanticOperationsSnapshot({ snapshotId: manualSave.snapshot.id, role: getRole('quality_manager'), identityScope: reviewerIdentity });
  assert.equal(manualRollback.snapshot.status, 'rolled_back');
  assert.equal(manualRollback.snapshot.rolledBackBySubjectId, reviewerIdentity.subjectId);
  assert.ok(manualRollback.snapshot.rolledBackAt);
  const agentRollback = rollbackSemanticOperationsSnapshot({ snapshotId: applied.snapshot.id, role: getRole('quality_manager'), identityScope: reviewerIdentity });
  assert.equal(agentRollback.snapshot.status, 'rolled_back');
  assert.ok(!agentRollback.draft.objectTypes.some((item) => item.id === 'Supplier'));
  assert.equal(listSemanticOperationsSnapshots({ identityScope: reviewerIdentity }).filter((item) => item.status === 'rolled_back').length, 2);
});

test('semantic reviewer work queue is tenant- and permission-scoped', () => {
  resetRuntimeState(['semantic_operations_agent_tasks']);
  const task = {
    id: 'semantic-review-queue-fixture', owner: semanticOperationsPrincipalKey(identity), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: 'waiting_confirmation', intent: 'build_model', title: '待审核采购模型', request: '建立采购语义模型', command: 'apply_proposal',
    requiredPermission: 'meta_model.draft.save', reviewPermission: 'meta_model.draft.review', confirmationRequired: true,
    proposal: { id: 'proposal-fixture', revision: 1, objectTypes: [], relationshipTypes: [] }, messages: [], events: []
  };
  const olderTask = { ...task, createdAt: new Date(Date.now() - 60_000).toISOString(), title: '较早的待审核采购模型' };
  const newerTask = { ...task, id: 'semantic-review-queue-fixture-newer', createdAt: new Date(Date.now() + 60_000).toISOString(), title: '较新的待审核采购模型' };
  writeState('semantic_operations_agent_tasks', 'index', { [olderTask.id]: olderTask, [newerTask.id]: newerTask });
  const reviewer = { tenantId: identity.tenantId, subjectId: 'quality-reviewer' };
  const reviewAccess = { buttonPermissionIds: ['meta_model.draft.review', 'meta_model.draft.save'] };
  const visible = listSemanticOperationsTasks({ identityScope: reviewer, accessContext: reviewAccess });
  assert.equal(visible.length, 2);
  assert.equal(listSemanticOperationsTasks({ identityScope: reviewer, accessContext: reviewAccess, limit: 1, offset: 1 })[0].id, olderTask.id);
  assert.equal(visible[0].reviewerAccess, true);
  assert.equal(getSemanticOperationsTask({ taskId: task.id, identityScope: reviewer, accessContext: reviewAccess }).id, task.id);
  assert.equal(listSemanticOperationsTasks({ identityScope: reviewer, accessContext: { buttonPermissionIds: ['meta_model.draft.save'] } }).length, 0);
  assert.equal(listSemanticOperationsTasks({ identityScope: { tenantId: 'another-tenant', subjectId: 'quality-reviewer' }, accessContext: reviewAccess }).length, 0);
});

test('semantic operations task binds natural-language intent to one reviewable server-side command', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  // 阶段 3：建模范围必须显式给出。文本里的「供应商/采购订单/原料批次」是业务对象，
  // 不是系统范围——历史实现会据此推断为空后回落到全部可访问连接器，范围因此不可见。
  const task = await createSemanticOperationsTask({
    body: { text: '建立供应商、采购订单和原料批次的语义模型。', systemCodes: ['ERP', 'WMS'] },
    role: getRole('executive'),
    identityScope: identity
  });
  assert.equal(task.intent, 'build_model');
  assert.equal(task.command, 'apply_proposal');
  assert.equal(task.status, 'waiting_confirmation');
  assert.equal(task.proposal.critic.status, 'passed');
  assert.equal(task.planning.authoritativeIntent, 'build_model');
  assert.ok(['deterministic', 'local_model_advisory'].includes(task.planning.mode));
  assert.equal(task.systemScope.selectionSource, 'explicit');
  assert.deepEqual(task.systemScope.selected, ['ERP', 'WMS']);
  assert.deepEqual(task.planning.systems, ['ERP', 'WMS']);
  assert.deepEqual(task.sourceDiscovery.selectedSystemCodes, ['ERP', 'WMS']);
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
  const task = await createSemanticOperationsTask({ body: { text: '建立供应商和采购订单语义模型。', systemCodes: ['ERP'] }, role, identityScope: identity });
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
    ['检查 ERP 和 WMS 的连接状态', 'discover_sources', 'inspect_sources', false, ['ERP', 'WMS']],
    ['查看当前模型发布状态和快照情况', 'inspect_status', 'inspect_status', false, null],
    ['检查当前模型结构与断裂关系', 'validate_model', 'validate_model', true, null],
    ['运行 Semantica 校验和模拟构建', 'simulate_model', 'simulate_model', true, null],
    ['发布语义模型', 'publish_model', 'publish_model', true, null],
    ['建立 WMS 库存与入库语义模型', 'build_model', 'apply_proposal', true, ['WMS']]
  ];
  for (const [text, intent, command, confirmationRequired, systemCodes] of cases) {
    const task = await createSemanticOperationsTask({ body: { text, ...(systemCodes ? { systemCodes } : {}) }, role, identityScope: identity });
    if (intent === 'publish_model') {
      assert.equal(task.code, 'SEMANTIC_TASK_EXECUTION_BLOCKED', text);
      assert.equal(task.status, 409, text);
      assert.equal(task.task.intent, intent, text);
      assert.equal(task.task.command, command, text);
      assert.equal(task.task.confirmationRequired, true, text);
      continue;
    }
    assert.equal(task.intent, intent, text);
    assert.equal(task.command, command, text);
    assert.equal(task.confirmationRequired, confirmationRequired, text);
    assert.equal(task.status, confirmationRequired ? 'waiting_confirmation' : 'completed', text);
    assert.equal(Boolean(task.proposal), intent === 'build_model', text);
    // 只有来源绑定意图才携带范围；其余意图不得因为文本里出现系统名而被动获得范围。
    assert.deepEqual(task.systemScope ? task.systemScope.selected : null, systemCodes, text);
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
  // 阶段 3：文本识别已经从「范围依据」降级为「提示素材」。它仍然返回识别的系统名，
  // 但 selectionSource 必须如实标注范围是推断来的，且 scopeNotice 说明写入前需显式确认。
  assert.equal(discovery.selectionSource, 'text_inference');
  assert.deepEqual(discovery.selectedSystemCodes, ['ERP', 'WMS']);
  assert.equal(discovery.explicitSystemCodes, null);
  assert.match(discovery.scopeNotice, /推断而非显式选择/);
  assert.equal(discovery.sources.find((item) => item.code === 'ERP').authorized, true);
  assert.equal(discovery.sources.find((item) => item.code === 'WMS').status, 'not_configured');
  assert.equal(discovery.sources.find((item) => item.code === 'WMS').authorized, true);
  assert.equal(discovery.blockers.length, 0);
  assert.ok(discovery.warnings.some((item) => item.includes('WMS')));
  assert.match(discovery.policy, /不主动查询业务明细/);

  const task = await createSemanticOperationsTask({
    body: { text: '检查 ERP 和 WMS 的连接状态与建模物料。', systemCodes: ['ERP', 'WMS'] },
    role: getRole('executive'),
    identityScope: identity
  });
  assert.equal(task.intent, 'discover_sources');
  assert.equal(task.command, 'inspect_sources');
  assert.equal(task.status, 'completed');
  assert.equal(task.confirmationRequired, false);
  assert.equal(task.sourceDiscovery.blockers.length, 0);
  assert.deepEqual(task.sourceDiscovery.selectedSystemCodes, ['ERP', 'WMS']);
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
  const task = await createSemanticOperationsTask({ body: { text: '建立 WMS 库存与入库语义模型。', systemCodes: ['WMS'] }, role: getRole('executive'), identityScope: identity });
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

test('confirmed merge revisions update same-signature relationship cardinality instead of silently keeping old definitions', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime']);
  const first = await createSemanticOperationsProposal({ input: '建立供应商和原料批次的语义模型。', identityScope: identity });
  assert.ok(first.relationshipTypes.length);
  const applied = await applySemanticOperationsProposal({ proposalId: first.id, role: getRole('executive'), identityScope: identity }); assert.ok(!applied.error, applied.error);
  const second = await createSemanticOperationsProposal({ input: '建立供应商和原料批次的语义模型。', identityScope: identity });
  const relationships = structuredClone(second.relationshipTypes); const relation = relationships[0]; const changed = relation.cardinality === '1:n' ? 'n:1' : '1:n'; relation.cardinality = changed;
  const revised = await updateSemanticOperationsProposal({ proposalId: second.id, revision: second.revision, objectTypes: second.objectTypes, relationshipTypes: relationships, role: getRole('executive'), identityScope: identity });
  assert.ok(!revised.error, revised.error); assert.ok(revised.diff.relationshipChanges.some(item => item.change === 'updated'));
  const result = await applySemanticOperationsProposal({ proposalId: second.id, role: getRole('executive'), identityScope: identity }); assert.ok(!result.error, result.error);
  assert.equal(result.draft.relationshipTypes.find(item => item.from === relation.from && item.to === relation.to && item.predicate === relation.predicate).cardinality, changed);
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

// ── 阶段 4f：候选对象的**来源**与「没被生成」的原因必须可读（ADR-021）────────────
//
// 这一组针对本重构一路在消除的同一种毛病：**静默**。候选对象此前有两条静默路径——
//   ① 自然语言抽取不尝试（模拟运行时 / 材料没有字典线索），只 `return null`，不说明理由；
//   ② 受控目录关键词命中后，既不点名命中在哪个词上，也不说它是**兜底**而不是抽取结果。
// 于是「材料里写了发运单、候选里却没有」这件事无人能解释：是没写清？目录没这个词？还是没接模型？
test('阶段 4f：受控目录命中与「未做自然语言抽取」的原因都必须写进审阅说明', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'oa_meta_model_runtime']);
  // 纯自然语言、不带附件：结构化发现必然为空，于是落到受控目录兜底。
  // 测试环境恒为 mock 运行时，因此自然语言抽取**不会**被尝试——这件事此前是静默的。
  const proposal = await createSemanticOperationsProposalFromRequest({
    body: { text: '根据 ERP 的采购订单与供应商资料建立候选模型。' },
    role: getRole('executive'), identityScope: identity
  });
  assert.ok(!proposal.error, JSON.stringify(proposal).slice(0, 300));

  // ① 命中依据：必须点名「哪个目录条目被哪几个词命中」。
  //    只说「命中 2 类」仍回答不了「为什么没有发运单」——那要看的是**没命中**的那些。
  const catalogNote = proposal.reviewNotes.find((note) => note.includes('受控目录关键词命中'));
  assert.ok(catalogNote, `reviewNotes 未披露受控目录命中：${JSON.stringify(proposal.reviewNotes)}`);
  assert.match(catalogNote, /PurchaseOrder ← 采购订单/);
  assert.match(catalogNote, /Supplier ← 供应商/);
  assert.match(catalogNote, /受控目录共 20 类/);
  // 覆盖率与「可能漏了什么」必须一起说：这才说明白它只是词面匹配，不是「材料里的对象都在这了」。
  assert.match(catalogNote, /目录未覆盖的业务对象\*\*不会\*\*出现在候选里/);

  // ② 跳过原因：必须能区分「没接模型」与「材料没给字典线索」——两者要做的补救完全不同。
  const skipNote = proposal.reviewNotes.find((note) => note.includes('未从非结构化材料做自然语言抽取'));
  assert.ok(skipNote, `reviewNotes 未披露抽取跳过原因：${JSON.stringify(proposal.reviewNotes)}`);
  assert.match(skipNote, /模拟模式/);

  // ③ 目录也没命中时行为**不变**：仍是硬错误，不生成空候选、不放宽任何门槛。
  const empty = await createSemanticOperationsProposalFromRequest({
    body: { text: '你好' }, role: getRole('executive'), identityScope: identity
  });
  assert.equal(empty.code, 'SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS');
});

test('阶段 4f：两条跳过原因由纯函数判定，使模拟运行时遮不住另一条分支', () => {
  // 测试环境恒为 mock：若判定内联在 discoverNaturalSchema 里，`not_dictionary_like`
  // 这条分支会被 mock 分支永久遮住，等于没有覆盖。
  assert.equal(naturalSchemaSkipReason({ mode: 'workbuddy', material: '我们有订单、库存、发运三类数据，订单有单号和客户。' }), 'not_dictionary_like');
  assert.equal(naturalSchemaSkipReason({ mode: 'workbuddy', material: '采购订单表 purchase_order，主键 purchase_order_id。' }), null);
  assert.equal(naturalSchemaSkipReason({ mode: 'mock', material: '主键 purchase_order_id' }), 'mock_runtime');
  assert.equal(naturalSchemaSkipReason({ mode: undefined, material: '' }), 'not_dictionary_like');
  // 两句说明必须互不相同：合并成一句会让运营朝错误方向改材料（该换 provider 的跑去补字段名）。
  assert.notEqual(NATURAL_SCHEMA_SKIP_REASONS.mock_runtime, NATURAL_SCHEMA_SKIP_REASONS.not_dictionary_like);
  assert.match(NATURAL_SCHEMA_SKIP_REASONS.mock_runtime, /模拟模式/);
  assert.match(NATURAL_SCHEMA_SKIP_REASONS.not_dictionary_like, /字典线索/);
});

// ── 阶段 4g：候选对象的**覆盖面**必须可点名（ADR-022）──────────────────────────
//
// 阶段 4f 让「命中依据」可读，但**没命中的那些仍是沉默的**：运营看得到「命中 2 类」，
// 看不到「目录里根本没有承载你要的那类对象的词条」。于是留了一句无法执行的
// 「请核对是否遗漏」——要核对什么、怎么核对，一个字都没有。
// 本组钉住两侧：目录空白（确定性）与材料未覆盖提及（启发式）。
test('阶段 4g：目录空白与未覆盖提及都必须可点名，但都不得进入候选对象', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'oa_meta_model_runtime']);
  // 一次性把四个业务对象写清（并用顿号列举），其中三个在受控目录里没有任何词条。
  const proposal = await createSemanticOperationsProposalFromRequest({
    body: { text: '本次要建模的对象是采购订单、发运单、出库单、客户投诉。' },
    role: getRole('executive'), identityScope: identity
  });
  assert.ok(!proposal.error, JSON.stringify(proposal).slice(0, 300));

  // ① 披露必须落**结构化字段**，不能只活在一句中文里：界面与复算要按字段判断。
  const coverage = proposal.candidateCoverage;
  assert.ok(coverage, '提案上没有 candidateCoverage');
  assert.equal(coverage.catalogSize, CANDIDATE_CATALOG_SIZE);
  // 词表治理第一轮（2026-09-28）后目录 12+8=20 类；无声明的 6 类缺口仍在。
  assert.equal(coverage.catalogSize, 20);
  // 「兜底路径是否生效」是解读整份披露的前提：目录没被用到时，说「命中 0 类」会误导。
  assert.equal(coverage.fallbackApplied, true);
  assert.deepEqual(coverage.matched, [{ id: 'PurchaseOrder', matchedTerms: ['采购订单', '订单'] }]);

  // ② 目录空白（确定性）：平台已治理、但候选目录没有词条的对象类，必须点名。
  //    「发运单 / 出库单」进不来不是运营没写清——WMS 的世界模型里有 OutboundShipment，
  //    但受控目录里没有任何词条承载它。这一项此前没有任何地方能看出来。
  //    词表治理第一轮（2026-09-28）补了 8 类**有声明**对象的词条，缺口 14→6；
  //    OutboundShipment 无声明，仍在缺口里——词条补不了结构，这是有意保留。
  assert.equal(coverage.gaps.length, 6);
  assert.ok(coverage.gaps.some((item) => item.objectType === 'OutboundShipment' && item.system === 'WMS'));
  assert.ok(coverage.gaps.every((item) => !CANDIDATE_CATALOG.some((entry) => entry.id === item.objectType)));

  // ③ 未覆盖提及（启发式）：材料列举项里没有被任何词条覆盖的那些，必须点名。
  assert.deepEqual(coverage.uncoveredMentions, ['发运单', '出库单', '客户投诉']);
  assert.equal(coverage.uncoveredTruncated, false);
  assert.equal(coverage.uncoveredBasis, 'enumeration_heuristic');

  // ④ **披露不等于补齐**：点名之后候选对象集合必须**一个都没多**。
  //    把它们补进候选涉及对象来源与范围的既有决策（ADR-012 / 013 / 017），不在这里做。
  assert.deepEqual(proposal.objectTypes.map((item) => item.id), ['PurchaseOrder']);

  // ⑤ 审阅说明：三类披露各自说清，且启发式必须自我标注（不能被当成抽取结果）。
  const notes = proposal.reviewNotes;
  assert.ok(notes.some((note) => /受控目录共 20 类/.test(note)), notes.join('\n'));
  const gapNote = notes.find((note) => note.includes('在受控目录里没有任何词条'));
  assert.ok(gapNote, notes.join('\n'));
  assert.match(gapNote, /OutboundShipment（WMS）/);
  const mentionNote = notes.find((note) => note.includes('没有被任何受控词条覆盖'));
  assert.ok(mentionNote, notes.join('\n'));
  assert.match(mentionNote, /发运单、出库单、客户投诉/);
  assert.match(mentionNote, /启发式/);
  assert.match(mentionNote, /不是对象抽取结果/);

  // ⑥ 兜底路径没生效时（结构化材料给了对象），覆盖披露必须**不声称**目录能力问题。
  const structured = await createSemanticOperationsProposal({
    input: '采用材料中的结构化字典。', identityScope: identity,
    schemaDiscovery: {
      files: [], summary: '结构化字典', attribution: { attributed: [], ambiguous: [], unattributed: [] },
      objectTypes: [{ id: 'InventoryLot', label: '库存批次', source: 'wms.inventory_lot', key: 'inventoryLotId', fields: ['inventoryLotId', 'quantity'], fieldDefinitions: [
        { name: 'inventoryLotId', type: 'string', required: true, primaryKey: true, sourceField: 'inventoryLotId', mappingStatus: 'mapped' },
        { name: 'quantity', type: 'number', sourceField: 'quantity', mappingStatus: 'mapped' }
      ], classification: '内部受限', semanticType: 'InventoryLot', coreObject: 'InventoryLot', sourceSystems: ['WMS'] }],
      relationshipTypes: []
    }
  });
  assert.ok(!structured.error, JSON.stringify(structured).slice(0, 300));
  assert.equal(structured.candidateCoverage.fallbackApplied, false);
  assert.deepEqual(structured.candidateCoverage.matched, []);
  assert.deepEqual(structured.candidateCoverage.gaps, []);
  assert.deepEqual(structured.candidateCoverage.uncoveredMentions, []);
});

test('阶段 4g：覆盖面判据是纯函数，可脱离提案逐条取证', () => {
  // ① 词面命中必须带**命中词**：「命中 2 类」回答不了「为什么没有发运单」。
  assert.deepEqual(matchCandidateCatalog('根据 ERP 的采购订单与供应商资料建立候选模型。')
    .map((entry) => `${entry.item.id}←${entry.matchedTerms.join('、')}`), ['Supplier←供应商', 'PurchaseOrder←采购订单、订单']);

  // ② 目录空白：与系统目录的世界模型对象求差集，零启发式。6 类是该数据下的实测值
  //    （词表治理第一轮补了 8 类有声明的词条后，14→6），
  //    系统目录里增删世界模型对象时这条会失败——这是有意的（与棘轮同一立场）。
  const gaps = listCatalogGaps();
  assert.equal(gaps.length, 6);
  assert.deepEqual([...new Set(gaps.map((item) => item.system))].sort(), ['LIMS', 'MES', 'OMS', 'QMS', 'WMS']);
  assert.ok(!gaps.some((item) => item.objectType === 'PurchaseOrder'));

  // ③ 未覆盖提及：只有**并列列举**才取词。整段散文不产生任何提及——
  //    否则「我们要根据这些资料建立模型」会被当成一个对象名。
  assert.deepEqual(listUncoveredMentions({ sourceText: '我们要根据这些资料建立模型。' }).mentions, []);
  assert.deepEqual(listUncoveredMentions({ sourceText: '采购订单、发运单、出库单、客户投诉', matchedTerms: ['采购订单', '订单'] }).mentions,
    ['发运单', '出库单', '客户投诉']);

  // ④ 噪声门：列举项里夹着从句时，非名词性线索字必须把它挡掉，不能淹掉真正要看的词。
  assert.deepEqual(listUncoveredMentions({ sourceText: '我们有订单、库存、发运三类数据，订单有单号和客户。', matchedTerms: ['订单', '库存'] }).mentions, []);

  // ⑤ 覆盖判定必须**双向**：提及含词条（原料批次⊃原料）与词条含提及（物料主数据⊃物料）都算已覆盖。
  //    只判一向会让「物料」在命中「物料主数据」之后又被列进未覆盖清单，等于自己打自己。
  assert.deepEqual(listUncoveredMentions({ sourceText: '物料、发运单', matchedTerms: ['物料主数据'] }).mentions, ['发运单']);
  assert.deepEqual(listUncoveredMentions({ sourceText: '原料批次、发运单', matchedTerms: ['原料'] }).mentions, ['发运单']);
  //    反向对照：词条与提及只是「都含原料二字」但互不包含时，不得算覆盖。
  //    （注意此处的 `原料批次` 必须写在并列列举里才会被取词——单段文本不产生提及，见 ③。）
  assert.deepEqual(listUncoveredMentions({ sourceText: '原料批次、发运单', matchedTerms: ['物料主数据'] }).mentions, ['原料批次', '发运单']);

  // ⑥ 非汉字、单字与被覆盖项不得入清单；重复项去重。
  assert.deepEqual(listUncoveredMentions({ sourceText: 'ERP、WMS', matchedTerms: [] }).mentions, []);
  assert.deepEqual(listUncoveredMentions({ sourceText: '单、发运单、发运单', matchedTerms: [] }).mentions, ['发运单']);

  // ⑦ 截断必须**说明被截断**：整段材料若被切成几十个短语，全列出来只会把审阅说明淹掉，
  //    但静默丢弃会让「还有多少没看」变成新的沉默。
  const many = ['发运单', '出库单', '客户投诉', '来料单', '送货单', '退货单', '装箱单', '报关单', '提货单', '验收单', '领料单', '调拨单', '盘点单', '入库单', '结算单'];
  const truncated = listUncoveredMentions({ sourceText: many.join('、'), matchedTerms: [] });
  assert.equal(truncated.total, 15);
  assert.equal(truncated.mentions.length, UNCOVERED_MENTION_LIMIT);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.basis, 'enumeration_heuristic');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getRole } from '../src/services/authorization-service.js';
import { createSemanticOperationsProposalFromRequest, updateSemanticOperationsProposal, applySemanticOperationsProposal } from '../src/services/semantic-operations-agent-service.js';
import { createSemanticOperationsTask } from '../src/services/semantic-operations-task-service.js';
import { inspectMultimodalInput, extractMultimodalEvidence } from '../src/services/multimodal-input-service.js';
import { discoverSchemasFromAttachments } from '../src/services/semantic-schema-discovery-service.js';
import { loadSemanticMaterials, extendSemanticMaterials } from '../src/services/semantic-material-workspace-service.js';
import { compileWorldModelRequirements, validateProposalEvidence } from '../src/services/semantic-world-model-service.js';
import { hasSemanticGranularityMismatch } from '../src/services/agent-turn-understanding-service.js';
import { semanticFingerprint } from '../src/services/semantic-model-fingerprint.js';
import { getOAMetaModelDraft } from '../src/services/meta-model-service.js';

const role = getRole('executive');
const identityScope = { tenantId: 'manufacturing-test', subjectId: 'reviewer' };
const fixture = name => JSON.parse(readFileSync(new URL(`../../examples/semantic-schemas/manufacturing-case/${name}`, import.meta.url), 'utf8'));
const expected = fixture('expected-world-model.json');
const attachment = (name, document = fixture(name)) => ({ name, mimeType: 'application/json', dataUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(document)).toString('base64')}` });
const build = (files, text = '根据材料建设 ERP/WMS/LIMS/QMS/MES/OA 语义模型，不发布。') => createSemanticOperationsProposalFromRequest({ body: { text, attachments: files }, role, identityScope });
function assertFull(proposal) {
  assert.ok(!proposal.error, proposal.error);
  assert.equal(proposal.objectTypes.length, 13);
  for (const object of expected.objects) {
    const actual = proposal.objectTypes.find(item => item.id === object.id);
    assert.equal(actual.key, object.key, object.id);
    assert.equal(actual.granularity, object.granularity, object.id);
    assert.deepEqual(actual.sourceSystems, [object.sourceSystem], object.id);
  }
  assert.equal(proposal.relationshipTypes.length, 17);
  assert.equal(proposal.objectTypes.find(item => item.id === 'Supplier').coreObject, 'Supplier');
  assert.equal(proposal.critic.status, 'passed', JSON.stringify(proposal.critic));
}

test('SM01/02/03: API and dictionary preserve 13 sources, keys, granularities and 17 scalar FK relations', async () => {
  for (const file of ['combined-openapi.json', 'data-dictionary.json']) assertFull(await build([attachment(file)]));
});

test('SM06: complete structured parsing is independent of truncated LLM context', async () => {
  const files = [attachment('combined-openapi.json'), attachment('data-dictionary.json')];
  const inspected = inspectMultimodalInput({ attachments: files }, role);
  const content = await extractMultimodalEvidence(inspected.attachments);
  assert.ok(content.reports.some(item => item.contextTruncated));
  assert.ok(content.reports.every(item => item.extractionComplete));
  assert.ok(content.documents.length === 2);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(content)), 'documents'), false);
  assertFull(await build(files));
});

test('SM04/05: dictionary survives dialogue and samples; split upload equals full modeling', async () => {
  const before = semanticFingerprint(await getOAMetaModelDraft());
  const first = await createSemanticOperationsTask({ body: { text: '你好', attachments: [attachment('data-dictionary.json')] }, role, identityScope });
  const middle = await createSemanticOperationsTask({ body: { text: '只讨论业务，不建模。', parentTaskId: first.id, attachments: [attachment('sample-events.json')] }, role, identityScope });
  const last = await createSemanticOperationsTask({ body: { text: '根据前面完整材料生成候选模型。', parentTaskId: middle.id }, role, identityScope });
  assertFull(last.proposal);
  const batch = await createSemanticOperationsTask({ body: { text: '建立 ERP WMS 模型', attachments: ['erp', 'wms'].map(system => attachment(`${system}-openapi.json`)) }, role, identityScope });
  assert.equal(batch.proposal.objectTypes.length, 8);
  const merged = await createSemanticOperationsTask({ body: { text: '继续建模，合并前面的 ERP WMS 和本次四个系统。', parentTaskId: batch.id, attachments: ['lims', 'qms', 'mes', 'oa'].map(system => attachment(`${system}-openapi.json`)) }, role, identityScope });
  assertFull(merged.proposal);
  assert.equal(semanticFingerprint(await getOAMetaModelDraft()), before);
});

test('SM07: key and field conflicts block both input orders and adoption', async () => {
  const one = { tables: [{ name: 'Order', system: 'ERP', granularity: 'transaction', primaryKey: 'id', fields: [{ name: 'id' }, { name: 'external_id' }] }] };
  const two = structuredClone(one); two.tables[0].primaryKey = 'external_id';
  const files = [attachment('one.json', one), attachment('two.json', two)];
  for (const input of [files, [...files].reverse()]) {
    const proposal = await build(input);
    assert.equal(proposal.critic.status, 'failed');
    assert.equal(proposal.schemaDiscovery.conflicts.length, 1);
    const result = await applySemanticOperationsProposal({ proposalId: proposal.id, role, identityScope });
    assert.equal(result.code, 'SEMANTIC_PROPOSAL_CRITIC_FAILED');
  }
});

test('SM08: changing correct source or dropping a relation cannot retain a green critic', async () => {
  const proposal = await build([attachment('data-dictionary.json')]);
  const objects = structuredClone(proposal.objectTypes);
  objects.find(item => item.id === 'StockItem').sourceSystems = ['OA'];
  const changed = await updateSemanticOperationsProposal({ proposalId: proposal.id, revision: 1, objectTypes: objects, relationshipTypes: proposal.relationshipTypes.slice(1), role, identityScope });
  assert.equal(changed.critic.status, 'failed');
  assert.equal(changed.businessValidation.productionReady, false);
  assert.equal(changed.mappingValidation.blocked, true);
});

test('SM09: requirement evidence, categories, state candidates and fingerprint survive without granting execution', async () => {
  const request = '建立采购和库存模型。\n1. PurchaseOrder amount 按 po_id 聚合，不重复累计。\n2. StockItem HOLD 表示隔离，available 必须为0。\n3. 审批通过不能代替外部执行回执。';
  const proposal = await build([attachment('data-dictionary.json')], request);
  assert.ok(proposal.worldModel.rules.some(rule => rule.categories.includes('metric') && rule.evidence.includes('po_id')));
  assert.ok(proposal.worldModel.rules.some(rule => rule.categories.includes('state')));
  assert.ok(proposal.worldModel.rules.every(rule => rule.executable === false && rule.status === 'pending_review'));
  const revision = await updateSemanticOperationsProposal({ proposalId: proposal.id, revision: 1, objectTypes: proposal.objectTypes, relationshipTypes: proposal.relationshipTypes, role, identityScope });
  assert.deepEqual(revision.worldModel, proposal.worldModel);
  assert.notEqual(semanticFingerprint({ worldModel: proposal.worldModel }), semanticFingerprint({}));
  const model = compileWorldModelRequirements(request, [{ id: 'StockItem', fieldDefinitions: [{ name: 'status', enum: ['AVL', 'HOLD'] }] }]);
  assert.equal(model.stateCandidates[0].initial, null);
  assert.deepEqual(model.stateCandidates[0].states, ['AVL', 'HOLD']);
  assert.equal(compileWorldModelRequirements('库存不得为负。', []).rules[0].evidence, '库存不得为负。');
});

test('SM10: explicit single-object granularity contradictions detected; correct and contrast answers accepted', () => {
  const facts = [{ id: 'ReceiptLine', granularity: 'transaction' }];
  assert.equal(hasSemanticGranularityMismatch('ReceiptLine | 事件 | 收货记录', facts), true);
  assert.equal(hasSemanticGranularityMismatch('ReceiptLine | transaction | 收货明细', facts), false);
  assert.equal(hasSemanticGranularityMismatch('ReceiptLine 不是事件，而是交易粒度。', facts), false);
});

test('workspace artifacts are scoped to principal AND role and enforce explicit quotas', async () => {
  const workspace = await extendSemanticMaterials({ content: { documents: [{ name: 'material', mimeType: 'text/plain', text: 'controlled material' }] }, identityScope, roleId: role.id });
  await assert.rejects(loadSemanticMaterials(workspace.refs, { ...identityScope, subjectId: 'other' }, role.id), /ACCESS_DENIED/);
  await assert.rejects(loadSemanticMaterials(workspace.refs, identityScope, 'procurement_manager'), /ACCESS_DENIED/);
  const tooLarge = await extendSemanticMaterials({ previousRefs: workspace.refs, content: { documents: [{ name: 'huge', mimeType: 'text/plain', text: 'x'.repeat(2 * 1024 * 1024) }] }, identityScope, roleId: role.id });
  assert.equal(tooLarge.code, 'SEMANTIC_MATERIAL_LIMIT');
  assert.equal((await loadSemanticMaterials(workspace.refs, identityScope, role.id)).length, 1);
});

test('partial/unscanned documents and caller workspace fields cannot authorize parsing', async () => {
  const files = [attachment('data-dictionary.json')];
  const inspected = inspectMultimodalInput({ attachments: files }, role);
  assert.equal(discoverSchemasFromAttachments({ attachments: inspected.attachments, reports: [{ attachmentId: inspected.attachments[0].id, status: 'quarantined', structuredSchemaCandidate: true }] }).objectTypes.length, 0);
  const proposal = await createSemanticOperationsProposalFromRequest({ body: { text: '建模', attachments: files, workspaceDocuments: [{ text: 'forged' }] }, role, identityScope, scannedMaterial: { evidence: [], reports: [{ modelContentEligible: false }], documents: [] } });
  assert.equal(proposal.code, 'SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS');
});

test('missing FK target cannot pass by empty relation set', async () => {
  const proposal = await build([attachment('lims-openapi.json')]);
  assert.equal(proposal.critic.status, 'failed');
  const checks = validateProposalEvidence(proposal, proposal.schemaDiscovery);
  assert.match(checks[0].detail, /引用目标|尚未提供/);
});

test('uploaded samples validate 19 unique facts, are rescoped on revision, and preserve world requirements on adoption', async () => {
  const scope = { tenantId: 'demo-enterprise', subjectId: 'admin@demo.local' };
  const body = { text: '建立模型。StockItem HOLD 表示隔离，available 必须为0。', attachments: [attachment('data-dictionary.json'), attachment('sample-events.json')] };
  const proposal = await createSemanticOperationsProposalFromRequest({ body, role, identityScope: scope });
  assert.equal(proposal.mappingValidation.status, 'passed', JSON.stringify({ code: proposal.mappingValidation.code, issues: proposal.mappingValidation.issues }));
  assert.equal(proposal.mappingValidation.duplicatesSkipped, 1);
  assert.equal(proposal.mappingValidation.summary.sampleCount, 19);
  assert.equal(proposal.mappingValidation.source, 'uploaded_scoped_samples');
  const adopted = await applySemanticOperationsProposal({ proposalId: proposal.id, role, identityScope: scope });
  assert.ok(!adopted.error, adopted.error);
  assert.deepEqual(adopted.draft.worldModel, proposal.worldModel);
  assert.equal(adopted.draft.scenario.requireCaseReplay, true);
  const denied = await createSemanticOperationsProposalFromRequest({ body, role, identityScope });
  assert.equal(denied.mappingValidation.blocked, true);
  assert.equal(denied.businessValidation.productionReady, false);
  assert.ok(denied.mappingValidation.contract && denied.mappingValidation.summary);
  const conflicting = fixture('sample-events.json');
  conflicting.records.push({ ...conflicting.records[0], payload: { ...conflicting.records[0].payload, name: '同版本不同内容' } });
  const invalid = await createSemanticOperationsProposalFromRequest({ body: { ...body, attachments: [attachment('data-dictionary.json'), attachment('sample-events.json', conflicting)] }, role, identityScope: scope });
  assert.equal(invalid.mappingValidation.code, 'UPLOADED_SAMPLE_INVALID_OR_FORBIDDEN');
  assert.equal(invalid.mappingValidation.blocked, true);
});

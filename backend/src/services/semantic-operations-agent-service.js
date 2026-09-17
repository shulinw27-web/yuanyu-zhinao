import { createHash } from 'node:crypto';
import { mutateSemanticGovernanceState, mutateSemanticGovernanceStates, readSemanticGovernanceState } from './semantic-governance-store.js';
import { buildOAMetaModelDraftRuntimeChange, getOAMetaModelDraft, getOAMetaModelDraftFromRuntime, getOAMetaModelRuntimeTransactionEntry } from './meta-model-service.js';
import { inspectMultimodalInput, extractMultimodalEvidence } from './multimodal-input-service.js';
import { inspectModelPromptSafety } from './local-model-gateway.js';
import { discoverSchemasFromAttachments } from './semantic-schema-discovery-service.js';
import { discoverNaturalSchema } from './semantic-natural-schema-service.js';
import { validateSemanticMappingContract } from './semantic-mapping-validation-service.js';
import { semanticFingerprint } from './semantic-model-fingerprint.js';
import { inferObjectGranularity } from './ontology-contract-service.js';
import { semanticOperationsOwnerMatches, semanticOperationsPrincipalKey } from './semantic-operations-identity.js';
import { assertSemanticTenant } from './semantic-tenant-context.js';
import { discoverWorkspaceSchemas, extendSemanticMaterials } from './semantic-material-workspace-service.js';
import { validateProposalSamples } from './semantic-uploaded-sample-service.js';
import { compileWorldModelRequirements, validateProposalEvidence, proposalBusinessValidation } from './semantic-world-model-service.js';

const PROPOSAL_NAMESPACE = 'semantic_operations_agent_proposals';
const SNAPSHOT_NAMESPACE = 'semantic_operations_agent_snapshots';
const proposalKey = (id) => `proposal-${id}`;
const now = () => new Date().toISOString();
const identityKey = semanticOperationsPrincipalKey;
const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const sourceFieldName = (value) => String(value || '').replace(/_([a-z\d])/g, (_, character) => character.toUpperCase());
const includesAny = (text, values) => values.some((value) => text.includes(value));
const clone = (value) => JSON.parse(JSON.stringify(value));
const mapMaybe = (value, callback) => value && typeof value.then === 'function' ? value.then(callback) : callback(value);
const writeSemanticState = (namespace, key, value) => mutateSemanticGovernanceState(namespace, key, null, () => ({ value, result: value }));
const approvedSourceSystems = new Set(['ERP', 'WMS', 'LIMS', 'MES', 'QMS', 'OMS', 'OA', 'SRM', 'MDM', 'PLM', 'EAM', 'IOT', 'AI', 'AUDIT']);
const approvedCoreObjects = new Set(['Person', 'RawMaterial', 'Product', 'Equipment', 'Store']);
const approvedCardinalities = new Set(['1:1', '1:n', 'n:1', 'n:n']);
const approvedMappingStatuses = new Set(['mapped', 'manual', 'derived', 'ignored', 'pending']);
const MAX_PROPOSAL_OBJECTS = 40;
const MAX_PROPOSAL_FIELDS = 80;
const MAX_PROPOSAL_RELATIONSHIPS = 40;

const catalog = [
  { id: 'Material', label: '物料主数据', terms: ['物料主数据', '原料主数据'], source: 'erp.material', key: 'material_id', fields: ['material_id', 'name', 'status'], classification: '供应链受限', coreObject: 'Material' },
  { id: 'ProductSKU', label: '产品主数据', terms: ['产品主数据', 'SKU主数据'], source: 'erp.product', key: 'product_id', fields: ['product_id', 'name', 'status'], classification: '产品受限', coreObject: 'ProductSKU' },
  { id: 'Supplier', label: '供应商', terms: ['供应商', '供方'], source: 'erp.supplier', key: 'supplier_id', fields: ['supplier_id', 'name', 'qualification_status', 'status'], classification: '供应链受限', coreObject: 'Supplier' },
  { id: 'PurchaseDemand', label: '采购需求', terms: ['采购需求', '请购', '采购申请'], source: 'erp.purchase_demand', key: 'demand_id', fields: ['demand_id', 'material_code', 'qty', 'required_date', 'status'], classification: '运营受限', coreObject: 'RawMaterial' },
  { id: 'PurchaseOrder', label: '采购订单', terms: ['采购订单', '订单'], source: 'erp.purchase_order', key: 'purchase_order_id', fields: ['purchase_order_id', 'supplier_id', 'material_code', 'qty', 'status'], classification: '财务受限', coreObject: 'PurchaseOrder' },
  { id: 'RawMaterialBatch', label: '原料批次', terms: ['原料', '物料', '来料', '批次'], source: 'wms.raw_material_batch', key: 'material_batch_id', fields: ['material_batch_id', 'material_code', 'supplier_id', 'status'], classification: '质量受限', coreObject: 'RawMaterial' },
  { id: 'TestResult', label: '检验结果', terms: ['检验', '质检', '检测'], source: 'lims.test_result', key: 'test_result_id', fields: ['test_result_id', 'material_batch_id', 'item', 'result', 'status'], classification: '质量受限', coreObject: 'RawMaterial' },
  { id: 'ProductionBatch', label: '生产批次', terms: ['生产批次', '生产'], source: 'mes.production_batch', key: 'production_batch_id', fields: ['production_batch_id', 'product_code', 'material_batch_id', 'status'], classification: '生产受限', coreObject: 'Product' },
  { id: 'FinishedGoodsBatch', label: '成品批次', terms: ['成品', '放行'], source: 'qms.finished_goods_batch', key: 'finished_goods_batch_id', fields: ['finished_goods_batch_id', 'product_code', 'release_status', 'status'], classification: '质量受限', coreObject: 'Product' },
  { id: 'Inventory', label: '库存', terms: ['库存', '仓库'], source: 'wms.inventory', key: 'inventory_id', fields: ['inventory_id', 'material_batch_id', 'quantity', 'warehouse_code'], classification: '运营受限', coreObject: 'RawMaterial' },
  { id: 'Store', label: '门店', terms: ['门店', '店铺'], source: 'oms.store', key: 'store_id', fields: ['store_id', 'name', 'region', 'status'], classification: '门店运营受限', coreObject: 'Store' },
  { id: 'Equipment', label: '设备', terms: ['设备', '产线'], source: 'mes.equipment', key: 'equipment_id', fields: ['equipment_id', 'name', 'line_code', 'status'], classification: '生产受限', coreObject: 'Equipment' }
];

const relationshipCatalog = [
  ['Supplier', 'supplies', 'RawMaterialBatch', '供应商供货原料批次'], ['PurchaseDemand', 'requests', 'RawMaterialBatch', '采购需求对应原料批次'],
  ['PurchaseOrder', 'orders', 'RawMaterialBatch', '采购订单订购原料批次'], ['RawMaterialBatch', 'hasTestResult', 'TestResult', '原料批次关联检验结果'],
  ['RawMaterialBatch', 'consumedBy', 'ProductionBatch', '原料批次被生产批次领用'], ['ProductionBatch', 'produces', 'FinishedGoodsBatch', '生产批次产出成品批次'],
  ['RawMaterialBatch', 'storedAs', 'Inventory', '原料批次对应库存'], ['Equipment', 'produces', 'ProductionBatch', '设备执行生产批次']
];

const canonicalFieldDefinitions = (item) => (item.fieldDefinitions || []).map((field) => ({
  name: field.name,
  type: field.type || 'string',
  required: Boolean(field.required),
  primaryKey: Boolean(field.primaryKey),
  sourceField: field.sourceField ?? field.name,
  mappingStatus: field.mappingStatus || 'mapped',
  reference: field.reference || null,
  referenceField: field.referenceField || null,
  unit: field.unit || null,
  enum: field.enum || null,
  description: field.description || null
}));
const objectSignature = (item) => JSON.stringify({ id: item.id, label: item.label, source: item.source, key: item.key, fields: item.fields, fieldDefinitions: canonicalFieldDefinitions(item), classification: item.classification, semanticType: item.semanticType, coreObject: item.coreObject, sourceSystems: item.sourceSystems, granularity: item.granularity || inferObjectGranularity(item.id) });
const relationSignature = (item) => `${item.from}:${item.predicate}:${item.to}`;
const cleanText = (value, maxLength) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
const cleanIdentifier = (value, maxLength = 64) => cleanText(value, maxLength).replace(/[^\p{L}\p{N}_]/gu, '');
const normalizeFieldDefinitions = (item) => {
  const supplied = Array.isArray(item?.fieldDefinitions) && item.fieldDefinitions.length
    ? item.fieldDefinitions
    : (Array.isArray(item?.fields) ? item.fields : []).map((name) => ({ name, type: 'string', required: name === item?.key, primaryKey: name === item?.key, sourceField: name, mappingStatus: 'mapped' }));
  const fields = supplied.slice(0, MAX_PROPOSAL_FIELDS).map((field) => ({
    name: cleanIdentifier(field?.name, 64),
    type: cleanText(field?.type || 'string', 48) || 'string',
    required: Boolean(field?.required || field?.primaryKey),
    primaryKey: false,
    sourceField: cleanText(field?.sourceField === undefined ? field?.name : field.sourceField, 120).replace(/[^\p{L}\p{N}_.-]/gu, ''),
    mappingStatus: approvedMappingStatuses.has(field?.mappingStatus) ? field.mappingStatus : 'mapped',
    reference: field?.reference ? cleanIdentifier(field.reference, 48) : null,
    referenceField: field?.referenceField ? cleanIdentifier(field.referenceField, 64) : null,
    unit: cleanText(field?.unit, 80) || null,
    enum: Array.isArray(field?.enum) ? field.enum.map(value => cleanText(value, 120)).slice(0, 100) : undefined,
    description: cleanText(field?.description, 180) || null
  })).filter((field) => field.name);
  const unique = [...new Map(fields.map((field) => [field.name, field])).values()];
  const requestedKey = cleanIdentifier(item?.key, 64);
  const key = unique.some((field) => field.name === requestedKey) ? requestedKey : requestedKey || unique[0]?.name || '';
  unique.forEach((field) => { field.primaryKey = field.name === key; if (field.primaryKey) field.required = true; });
  return { key, fieldDefinitions: unique, fields: unique.map((field) => field.name) };
};

const sanitizeProposalDraft = (input, originalDraft) => {
  const sourceObjects = Array.isArray(input?.objectTypes) ? input.objectTypes : originalDraft.objectTypes;
  const sourceRelationships = Array.isArray(input?.relationshipTypes) ? input.relationshipTypes : originalDraft.relationshipTypes;
  if (!sourceObjects.length || sourceObjects.length > MAX_PROPOSAL_OBJECTS) return { error: `候选对象数量必须在 1 到 ${MAX_PROPOSAL_OBJECTS} 之间。` };
  if (sourceRelationships.length > MAX_PROPOSAL_RELATIONSHIPS) return { error: `候选关系不能超过 ${MAX_PROPOSAL_RELATIONSHIPS} 条。` };
  const originalById = new Map((originalDraft.objectTypes || []).map((item) => [item.id, item]));
  const objectTypes = sourceObjects.map((item) => {
    const id = cleanIdentifier(item?.id, 48);
    const original = originalById.get(id);
    const normalizedFields = normalizeFieldDefinitions(item);
    return {
      id,
      granularity: item?.granularity || original?.granularity || inferObjectGranularity(id),
      label: cleanText(item?.label, 48),
      source: cleanText(item?.source || original?.source, 80),
      key: normalizedFields.key,
      fields: normalizedFields.fields,
      fieldDefinitions: normalizedFields.fieldDefinitions,
      classification: cleanText(item?.classification, 32),
      semanticType: cleanIdentifier(item?.semanticType || id, 48),
      coreObject: cleanIdentifier(item?.coreObject, 32),
      sourceSystems: [...new Set((Array.isArray(item?.sourceSystems) ? item.sourceSystems : original?.sourceSystems || []).map((value) => cleanIdentifier(value, 16).toUpperCase()).filter(Boolean))].slice(0, 8),
      description: cleanText(item?.description, 300)
    };
  });
  const objectIds = new Set(objectTypes.map((item) => item.id));
  const relationshipTypes = sourceRelationships.map((item) => ({
    from: cleanIdentifier(item?.from, 48),
    predicate: cleanIdentifier(item?.predicate, 48),
    to: cleanIdentifier(item?.to, 48),
    label: cleanText(item?.label, 60),
    cardinality: approvedCardinalities.has(item?.cardinality) ? item.cardinality : '1:n',
    evidence: cleanText(item?.evidence ?? '运营人员复核', 100),
    provenanceType: item?.provenanceType || 'declared', validFrom: item?.validFrom || null, validTo: item?.validTo || null
  }));
  if (new Set(objectTypes.map((item) => item.id)).size !== objectTypes.length) return { error: '候选对象编码不能重复。' };
  if (objectTypes.some((item) => !item.id || !item.label)) return { error: '每个候选对象都必须保留对象编码和业务名称。' };
  if (objectTypes.some((item) => item.fields.length < 2)) return { error: '每个候选对象至少需要两个不重名字段。' };
  if (objectTypes.some((item) => !item.key || !item.fields.includes(item.key))) return { error: '每个候选对象必须选择一个存在于字段列表中的主键。' };
  if (objectTypes.some((item) => !approvedCoreObjects.has(item.coreObject) && item.coreObject !== item.id)) return { error: '请选择标准元对象，或使用该对象自身的编码作为独立类型。' };
  if (relationshipTypes.some((item) => !item.from || !item.to || !item.predicate || !objectIds.has(item.from) || !objectIds.has(item.to))) return { error: '关系的起点、终点和谓词必须完整，并引用本次候选对象。' };
  const relationshipKeys = relationshipTypes.map(relationSignature);
  if (new Set(relationshipKeys).size !== relationshipKeys.length) return { error: '候选关系不能重复。' };
  return { draft: { ...originalDraft, objectTypes, relationshipTypes } };
};

const buildEditDiff = (original, current) => {
  const beforeObjects = new Map((original.objectTypes || []).map((item) => [item.id, item]));
  const afterObjects = new Map((current.objectTypes || []).map((item) => [item.id, item]));
  const objectChanges = [...new Set([...beforeObjects.keys(), ...afterObjects.keys()])].map((id) => {
    const before = beforeObjects.get(id);
    const after = afterObjects.get(id);
    const beforeFields = new Set(before?.fields || []);
    const afterFields = new Set(after?.fields || []);
    return {
      id,
      change: !before ? 'added' : !after ? 'removed' : objectSignature(before) === objectSignature(after) ? 'unchanged' : 'updated',
      fieldsAdded: [...afterFields].filter((field) => !beforeFields.has(field)),
      fieldsRemoved: [...beforeFields].filter((field) => !afterFields.has(field)),
      keyChanged: Boolean(before && after && before.key !== after.key)
    };
  });
  const beforeRelations = new Set((original.relationshipTypes || []).map(relationSignature));
  const afterRelations = new Set((current.relationshipTypes || []).map(relationSignature));
  return {
    summary: {
      addedObjects: objectChanges.filter((item) => item.change === 'added').length,
      updatedObjects: objectChanges.filter((item) => item.change === 'updated').length,
      removedObjects: objectChanges.filter((item) => item.change === 'removed').length,
      addedRelationships: [...afterRelations].filter((item) => !beforeRelations.has(item)).length,
      removedRelationships: [...beforeRelations].filter((item) => !afterRelations.has(item)).length
    },
    objectChanges
  };
};

const buildImpactAnalysis = (original, current, editDiff = buildEditDiff(original, current)) => {
  const changedObjects = editDiff.objectChanges.filter((item) => item.change !== 'unchanged');
  const changedIds = new Set(changedObjects.map((item) => item.id));
  const affectedRelationships = (current.relationshipTypes || []).filter((item) => changedIds.has(item.from) || changedIds.has(item.to)).map(relationSignature);
  const keyChanges = changedObjects.filter((item) => item.keyChanged).map((item) => item.id);
  const removedFields = changedObjects.flatMap((item) => item.fieldsRemoved.map((field) => `${item.id}.${field}`));
  const removedObjects = changedObjects.filter((item) => item.change === 'removed').map((item) => item.id);
  const pendingMappings = (current.objectTypes || []).flatMap((item) => (item.fieldDefinitions || []).filter((field) => field.mappingStatus === 'pending' || (!field.sourceField && !['derived', 'ignored'].includes(field.mappingStatus))).map((field) => `${item.id}.${field.name}`));
  const highRisk = keyChanges.length || removedObjects.length || removedFields.length;
  const mediumRisk = editDiff.summary.removedRelationships || pendingMappings.length;
  const riskLevel = highRisk ? 'high' : mediumRisk ? 'medium' : changedObjects.length || editDiff.summary.addedRelationships ? 'low' : 'none';
  const requiredActions = [
    ...(keyChanges.length ? ['重新建立业务键索引，并验证历史对象引用迁移。'] : []),
    ...(removedObjects.length || removedFields.length ? ['检查 Agent 证据映射、检索投影和下游订阅者兼容性。'] : []),
    ...(affectedRelationships.length ? ['重新运行关系闭合校验与 Semantica 模型定义校验。'] : []),
    ...(pendingMappings.length ? ['补齐待确认字段的源字段映射。'] : []),
    ...(!changedObjects.length && !editDiff.summary.addedRelationships && !editDiff.summary.removedRelationships ? ['无需额外迁移动作。'] : [])
  ];
  return {
    riskLevel,
    changedObjectCount: changedObjects.length,
    keyChanges,
    removedObjects,
    removedFields,
    pendingMappings,
    affectedRelationships,
    requiredActions,
    publishBlocked: Boolean(pendingMappings.length),
    policy: '影响分析只评估元模型结构；不会读取业务明细，也不会自动执行索引迁移或发布。'
  };
};

const buildDiff = (base, draft, adoptionMode = 'merge') => {
  const baseObjects = new Map((base.objectTypes || []).map((item) => [item.id, item]));
  const baseRelations = new Set((base.relationshipTypes || []).map(relationSignature));
  const objectChanges = (draft.objectTypes || []).map((item) => {
    const before = baseObjects.get(item.id);
    return { id: item.id, label: item.label, change: !before ? 'added' : objectSignature(before) === objectSignature(item) ? 'unchanged' : 'updated', fields: item.fields, sourceSystems: item.sourceSystems };
  });
  const relationshipChanges = (draft.relationshipTypes || []).map((item) => ({ ...item, change: baseRelations.has(relationSignature(item)) ? 'unchanged' : 'added' }));
  const addedObjects = objectChanges.filter((item) => item.change === 'added').length;
  const updatedObjects = objectChanges.filter((item) => item.change === 'updated').length;
  const addedRelationships = relationshipChanges.filter((item) => item.change === 'added').length;
  const removals = adoptionMode === 'replace' ? (base.objectTypes || []).filter(o => !draft.objectTypes.some(x => x.id === o.id)).map(o => ({ id: o.id, label: o.label, change: 'removed', fields: o.fields, sourceSystems: o.sourceSystems })) : [];
  return { adoptionMode, baseFingerprint: semanticFingerprint(base), summary: { addedObjects, updatedObjects, addedRelationships, removedObjects: removals.length }, objectChanges: [...objectChanges, ...removals], relationshipChanges };
};

const critiqueProposalDraft = (draft, base, discovery) => {
  const objectIds = new Set((base.objectTypes || []).map((item) => item.id));
  const candidateIds = new Set();
  const checks = [];
  const malformedObjects = (draft.objectTypes || []).filter((item) => !item.id || !item.label || !item.key || !Array.isArray(item.fields) || item.fields.length < 2 || !item.classification || !item.semanticType || !item.coreObject || !item.sourceSystems?.length);
  checks.push({ name: '对象定义完整性', status: malformedObjects.length ? 'failed' : 'passed', detail: malformedObjects.length ? `有 ${malformedObjects.length} 个对象缺少主键、字段、分级或语义锚点。` : '每个候选对象均包含主键、字段、数据分级、语义类型与核心元对象锚点。' });
  const duplicateIds = (draft.objectTypes || []).filter((item) => (candidateIds.has(item.id) ? true : (candidateIds.add(item.id), false)));
  checks.push({ name: '对象编码唯一性', status: duplicateIds.length ? 'failed' : 'passed', detail: duplicateIds.length ? `发现重复对象编码：${duplicateIds.map((item) => item.id).join('、')}。` : '候选对象编码不存在重复。' });
  const unapprovedSources = (draft.objectTypes || []).flatMap((item) => (item.sourceSystems || []).filter((source) => !approvedSourceSystems.has(String(source).toUpperCase())).map((source) => `${item.id}:${source}`));
  checks.push({ name: '受控来源系统', status: unapprovedSources.length ? 'failed' : 'passed', detail: unapprovedSources.length ? `存在未登记来源系统：${unapprovedSources.join('、')}。` : '所有候选来源系统均在受控系统目录内。' });
  const knownIds = new Set([...objectIds, ...(draft.objectTypes || []).map((item) => item.id)]);
  const brokenRelations = (draft.relationshipTypes || []).filter((item) => !item.from || !item.to || !item.predicate || !knownIds.has(item.from) || !knownIds.has(item.to));
  checks.push({ name: '关系引用闭合', status: brokenRelations.length ? 'failed' : 'passed', detail: brokenRelations.length ? `有 ${brokenRelations.length} 条关系的起点、终点或谓词无效。` : '所有候选关系均引用现有或本次新增对象。' });
  const unanchoredObjects = (draft.objectTypes || []).filter((item) => !approvedCoreObjects.has(item.coreObject) && item.coreObject !== item.id);
  checks.push({ name: '核心元对象映射', status: unanchoredObjects.length ? 'failed' : 'passed', detail: unanchoredObjects.length ? `有 ${unanchoredObjects.length} 个对象未映射到核心元对象。` : '所有候选对象已映射到企业核心元对象。' });
  const invalidKeys = (draft.objectTypes || []).filter((item) => !item.key || !item.fields?.includes(item.key) || item.fieldDefinitions?.filter((field) => field.primaryKey).length !== 1);
  checks.push({ name: '字段与主键一致性', status: invalidKeys.length ? 'failed' : 'passed', detail: invalidKeys.length ? `有 ${invalidKeys.length} 个对象的主键未落在字段定义中，或存在多个主键标记。` : '每个对象均有且仅有一个稳定主键，字段定义与主键一致。' });
  const invalidMappings = (draft.objectTypes || []).flatMap((item) => (item.fieldDefinitions || []).filter((field) => field.mappingStatus === 'pending' || (!field.sourceField && !['derived', 'ignored'].includes(field.mappingStatus)) || (field.primaryKey && !['mapped', 'manual'].includes(field.mappingStatus))).map((field) => `${item.id}.${field.name}`));
  checks.push({ name: '字段来源映射', status: invalidMappings.length ? 'failed' : 'passed', detail: invalidMappings.length ? `有 ${invalidMappings.length} 个字段尚未映射，或主键未绑定稳定源字段。` : '字段均已绑定源字段、人工映射、派生规则或明确忽略策略。' });
  checks.push(...validateProposalEvidence(draft, discovery));
  return { status: checks.every((item) => item.status === 'passed') ? 'passed' : 'failed', checkedAt: now(), checks };
};

const publicProposal = (proposal) => proposal && ({
  adoptionMode: proposal.adoptionMode || 'merge',
  worldModel: proposal.draft.worldModel || null,
  scenario: proposal.draft.scenario || null,
  stateMachines: proposal.draft.stateMachines || [],
  businessValidation: proposalBusinessValidation(proposal.draft, proposal.critic, proposal.mappingValidation),
  id: proposal.id, status: proposal.status, createdAt: proposal.createdAt, source: proposal.source, sourceSummary: proposal.sourceSummary,
  objectTypes: proposal.draft.objectTypes, relationshipTypes: proposal.draft.relationshipTypes, reviewNotes: proposal.reviewNotes,
  critic: proposal.critic, diff: proposal.diff, editDiff: proposal.editDiff || buildEditDiff(proposal.originalDraft || proposal.draft, proposal.draft), impactAnalysis: proposal.impactAnalysis || buildImpactAnalysis(proposal.originalDraft || proposal.draft, proposal.draft), mappingValidation: proposal.mappingValidation || validateSemanticMappingContract(proposal.draft), schemaDiscovery: proposal.schemaDiscovery || null,
  revision: proposal.revision || 1, updatedAt: proposal.updatedAt || proposal.createdAt, revisions: proposal.revisions || [], snapshotId: proposal.snapshotId || null, requiresConfirmation: true
});

const publicSnapshot = (snapshot) => snapshot && ({
  id: snapshot.id, proposalId: snapshot.proposalId, createdAt: snapshot.createdAt, status: snapshot.status,
  rolledBackAt: snapshot.rolledBackAt || null, summary: snapshot.diff.summary, diff: snapshot.diff, rollbackAllowed: snapshot.status === 'active'
});

export function createSemanticOperationsProposal({ input, multimodalContent, attachments = [], schemaDiscovery = null, identityScope, requirements = '', sampleRefs = [], roleId, adoptionMode = 'merge' }) {
  assertSemanticTenant(identityScope);
  if (!['merge', 'replace'].includes(adoptionMode)) return { error: '请选择合并或替换当前草稿。', code: 'SEMANTIC_ADOPTION_MODE_INVALID' };
  const sourceText = `${normalize(input)}\n${normalize(multimodalContent?.modelContext)}`.slice(0, 24_000);
  const selected = catalog.filter((item) => includesAny(sourceText, item.terms));
  const catalogSelection = schemaDiscovery?.objectTypes?.length ? [] : selected;
  const catalogCandidates = catalogSelection.map((item) => ({
    id: item.id, label: item.label, source: item.source, key: item.key, fields: item.fields, classification: item.classification,
    granularity: inferObjectGranularity(item.id),
    semanticType: item.id, coreObject: item.coreObject, sourceSystems: [item.source.split('.')[0].toUpperCase()],
    fieldDefinitions: item.fields.map((name) => ({ name, type: 'string', required: name === item.key, primaryKey: name === item.key, sourceField: sourceFieldName(name), mappingStatus: 'mapped', reference: null, description: null })),
    description: `由语义运营 Agent 根据${attachments.length ? '已通过内容扫描的材料与' : ''}自然语言描述生成的待审阅对象。`
  }));
  const objectTypes = [...new Map([...(schemaDiscovery?.objectTypes || []), ...catalogCandidates].map((item) => [item.id, item])).values()];
  if (!objectTypes.length) return {
    error: '没有从当前诉求或受控材料中识别到可追溯的候选对象。请补充业务对象、来源系统和字段范围，或上传结构化数据字典。',
    code: 'SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS',
    status: 422
  };
  const ids = new Set(objectTypes.map((item) => item.id));
  const catalogRelationships = (schemaDiscovery?.objectTypes?.length ? [] : relationshipCatalog).filter(([from, , to]) => ids.has(from) && ids.has(to)).map(([from, predicate, to, label]) => ({
    from, predicate, to, label, cardinality: '1:n', evidence: attachments.length ? '受控材料与自然语言描述' : '用户自然语言描述'
  }));
  const relationshipTypes = [...new Map([...(schemaDiscovery?.relationshipTypes || []), ...catalogRelationships].map((item) => [`${item.from}:${item.predicate}:${item.to}`, item])).values()];
  const fingerprint = createHash('sha256').update(`${identityKey(identityScope)}:${sourceText}`).digest('hex').slice(0, 16);
  const id = `semantic-proposal-${fingerprint}-${Date.now().toString(36)}`;
  const worldModel = compileWorldModelRequirements(requirements, objectTypes);
  const draft = { objectTypes, relationshipTypes, ...(schemaDiscovery?.schemas?.length ? {
    worldModel, modelingProfile: 'general',
    scenario: { objective: normalize(input).slice(0, 2000), questions: ['材料中的对象、关系和业务约束是否完整保留？'], decisionBindings: [], actionBindings: [], requireCaseReplay: true },
    stateMachines: [],
  } : {}) };
  return mapMaybe(getOAMetaModelDraft(), (base) => mapMaybe(validateProposalSamples(draft, { sampleRefs, roleId, identityScope, requireEvidence: Boolean(schemaDiscovery?.schemas?.length) }), (mappingValidation) => {
  const proposal = {
    id, adoptionMode, owner: identityKey(identityScope), createdAt: now(), status: 'pending_review', source: attachments.length ? 'multimodal_and_natural_language' : 'natural_language',
    sourceSummary: schemaDiscovery?.files?.length ? schemaDiscovery.summary : attachments.length ? `已引用 ${multimodalContent?.evidence?.length || 0} 条通过扫描的材料文本；未配置企业视觉适配器的图片不会被当作已理解内容。` : '仅根据运营人员的自然语言描述生成，不读取企业业务系统。',
    schemaDiscovery, sampleRefs, originRoleId: roleId, revision: 1, updatedAt: now(), originalDraft: clone(draft), revisions: [],
    draft, critic: critiqueProposalDraft(draft, base, schemaDiscovery), diff: buildDiff(base, draft, adoptionMode), editDiff: buildEditDiff(draft, draft), impactAnalysis: buildImpactAnalysis(adoptionMode === 'replace' ? base : draft, draft), mappingValidation, reviewNotes: [
      '这是语义运营 Agent 生成的待审阅草稿，尚未写入语义层或 Semantica。',
      adoptionMode === 'replace' ? `替换当前工作区草稿：现有 ${base.objectTypes.length} 类对象中未出现在候选的对象将移除；确认前请检查，采纳时保存回滚快照。不是新增并行模型。` : '合并到当前工作区草稿；保留既有对象，不会新建并行模型。',
      '采纳后只保存为元模型草稿；仍需校验、模拟构建和管理层登记。',
      '不复制原始业务记录，只保留对象结构、字段和关系。',
      ...(schemaDiscovery?.warnings?.length ? ['结构化材料仍有待复核项，Schema Critic 失败前不能采纳。'] : [])
    ]
  };
  return mapMaybe(writeSemanticState(PROPOSAL_NAMESPACE, proposalKey(id), proposal), () => publicProposal(proposal));
  }));
}

export function updateSemanticOperationsProposal({ proposalId, revision, objectTypes, relationshipTypes, role, identityScope }) {
  assertSemanticTenant(identityScope);
  return mapMaybe(readSemanticGovernanceState(PROPOSAL_NAMESPACE, proposalKey(proposalId)), (proposal) => {
  if (!proposal || !semanticOperationsOwnerMatches(proposal.owner, identityScope)) return { error: '未找到可修订的语义建模提案，或该提案不属于当前身份。', code: 'SEMANTIC_PROPOSAL_NOT_FOUND' };
  if (proposal.status !== 'pending_review') return { error: '只有等待评审的语义提案可以修订。', code: 'SEMANTIC_PROPOSAL_NOT_PENDING' };
  const currentRevision = proposal.revision || 1;
  if (Number(revision) !== currentRevision) return { error: '提案已在其他窗口更新，请刷新后基于最新版本继续修改。', code: 'SEMANTIC_PROPOSAL_REVISION_CONFLICT', proposal: publicProposal(proposal) };
  const normalized = sanitizeProposalDraft({ objectTypes, relationshipTypes }, proposal.draft);
  if (normalized.error) return { error: normalized.error, code: 'SEMANTIC_PROPOSAL_INVALID' };
  return mapMaybe(getOAMetaModelDraft(), (base) => mapMaybe(validateProposalSamples(normalized.draft, { sampleRefs: proposal.sampleRefs, roleId: role.id, identityScope, requireEvidence: Boolean(proposal.schemaDiscovery?.schemas?.length) }), (mappingValidation) => {
  proposal.originalDraft ||= clone(proposal.draft);
  proposal.draft = normalized.draft;
  proposal.revision = currentRevision + 1;
  proposal.updatedAt = now();
  proposal.updatedBy = role.id;
  proposal.critic = critiqueProposalDraft(proposal.draft, base, proposal.schemaDiscovery);
  proposal.diff = buildDiff(base, proposal.draft, proposal.adoptionMode);
  proposal.editDiff = buildEditDiff(proposal.originalDraft, proposal.draft);
  proposal.impactAnalysis = buildImpactAnalysis(proposal.originalDraft, proposal.draft, proposal.editDiff);
  proposal.mappingValidation = mappingValidation;
  proposal.revisions ||= [];
  proposal.revisions.unshift({ revision: proposal.revision, time: proposal.updatedAt, actor: role.id, criticStatus: proposal.critic.status, summary: proposal.editDiff.summary });
  proposal.revisions = proposal.revisions.slice(0, 20);
  return mapMaybe(writeSemanticState(PROPOSAL_NAMESPACE, proposalKey(proposalId), proposal), () => publicProposal(proposal));
  }));
  });
}

export async function createSemanticOperationsProposalFromRequest({ body, role, identityScope, scannedMaterial = null, sourceMaterialIncomplete = false, workspaceDocuments = null }) {
  assertSemanticTenant(identityScope);
  const input = String(body?.text || '').trim();
  const promptSafety = inspectModelPromptSafety(input);
  if (!promptSafety.safe) return { error: '运营指令未通过安全检查，未生成语义草稿。', status: 400 };
  const multimodal = inspectMultimodalInput(body, role);
  if (multimodal.error) return { error: multimodal.error, status: 400 };
  if (sourceMaterialIncomplete) return { error: '上文附件没有完整读取或记忆已截断。请重新上传需要建模的完整范围，不能从缺失的历史摘录生成完整模型。', code: 'SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS', status: 422 };
  const content = scannedMaterial || await extractMultimodalEvidence(multimodal.attachments);
  if (multimodal.attachments.length && (!content.evidence.length || content.reports.some(item => !item.modelContentEligible || item.partial || (item.truncated && !item.extractionComplete)))) return { error: '附件尚未完整读取或已被隔离，不能据此生成完整候选模型。请先处理解析提示，缩小材料范围或补充可读取的字典。', code: 'SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS', status: 422 };
  let schemaDiscovery = workspaceDocuments ? discoverWorkspaceSchemas(workspaceDocuments, input) : discoverSchemasFromAttachments({ attachments: multimodal.attachments, reports: content.reports, input, documents: content.documents });
  if (!schemaDiscovery.objectTypes.length) {
    const naturalMaterial = `${String(body?.sourceMaterial || input)}\n${(workspaceDocuments || content.documents || []).map(document => document.text).join('\n') || content.modelContext || ''}`;
    if (naturalMaterial.length > 20000) return { error: '非结构化材料超过单次可核对范围，请拆分业务范围或提供结构化字典；完整材料已保留，不从截断摘录猜测模型。', code: 'SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS', status: 422 };
    const natural = await discoverNaturalSchema(naturalMaterial);
    if (natural?.error) return { ...natural, code: 'SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS', status: 422 };
    if (natural) schemaDiscovery = natural;
  }
  const requirements = [...(workspaceDocuments || content.documents || []).filter(document => document.kind === 'request' || !/json|csv|yaml/.test(document.mimeType)).map(document => document.text), body.sourceMaterial || input].join('\n');
  const sampleDocuments = (workspaceDocuments || content.documents || []).filter(document => {
    if (document.mimeType !== 'application/json') return false;
    try { return Array.isArray(JSON.parse(document.text).records); } catch { return false; }
  });
  const sampleWorkspace = await extendSemanticMaterials({ content: { documents: sampleDocuments }, roleId: role.id, identityScope });
  if (sampleWorkspace.error) return sampleWorkspace;
  return createSemanticOperationsProposal({ input, multimodalContent: content, attachments: multimodal.attachments, schemaDiscovery, identityScope, requirements, sampleRefs: sampleWorkspace.refs, roleId: role.id, adoptionMode: body.adoptionMode || 'merge' });
}

export function listSemanticOperationsSnapshots({ identityScope }) {
  assertSemanticTenant(identityScope);
  return mapMaybe(readSemanticGovernanceState(SNAPSHOT_NAMESPACE, 'index', {}), (index) => Object.values(index).filter((snapshot) => semanticOperationsOwnerMatches(snapshot.owner, identityScope)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicSnapshot));
}

export function applySemanticOperationsProposal({ proposalId, role, identityScope }) {
  assertSemanticTenant(identityScope);
  return mapMaybe(readSemanticGovernanceState(PROPOSAL_NAMESPACE, proposalKey(proposalId)), (proposal) => {
  if (!proposal || !semanticOperationsOwnerMatches(proposal.owner, identityScope)) return { error: '未找到可采纳的语义建模草稿，或该草稿不属于当前身份。', code: 'SEMANTIC_PROPOSAL_NOT_FOUND' };
  if (proposal.status !== 'pending_review') return { error: '该语义建模草稿已被采纳或已失效。', code: 'SEMANTIC_PROPOSAL_NOT_PENDING' };
  proposal.draft.objectTypes = proposal.draft.objectTypes.map((item) => ({ ...item, ...normalizeFieldDefinitions(item) }));
  return mapMaybe(getOAMetaModelDraft(), (base) => mapMaybe(validateProposalSamples(proposal.draft, { sampleRefs: proposal.sampleRefs, roleId: role.id, identityScope, requireEvidence: Boolean(proposal.schemaDiscovery?.schemas?.length) }), (mappingValidation) => {
  proposal.critic = critiqueProposalDraft(proposal.draft, base, proposal.schemaDiscovery);
  proposal.diff = buildDiff(base, proposal.draft, proposal.adoptionMode);
  proposal.editDiff = buildEditDiff(proposal.originalDraft || proposal.draft, proposal.draft);
  proposal.impactAnalysis = buildImpactAnalysis(proposal.originalDraft || proposal.draft, proposal.draft, proposal.editDiff);
  proposal.mappingValidation = mappingValidation;
  if (proposal.critic.status !== 'passed') {
    return mapMaybe(writeSemanticState(PROPOSAL_NAMESPACE, proposalKey(proposalId), proposal), () => ({ error: 'Schema Critic 未通过，修复失败项后才能采纳草稿。', code: 'SEMANTIC_PROPOSAL_CRITIC_FAILED', proposal: publicProposal(proposal) }));
  }
  if (proposal.mappingValidation.blocked) {
    return mapMaybe(writeSemanticState(PROPOSAL_NAMESPACE, proposalKey(proposalId), proposal), () => ({ error: 'Mock 样本映射演练未通过，修复必填字段、类型或主键映射后才能采纳草稿。', code: 'SEMANTIC_PROPOSAL_MAPPING_VALIDATION_FAILED', proposal: publicProposal(proposal) }));
  }
  const replacing = proposal.adoptionMode === 'replace';
  const existing = new Map((replacing ? [] : base.objectTypes).map((item) => [item.id, item]));
  proposal.draft.objectTypes.forEach((item) => existing.set(item.id, { ...existing.get(item.id), ...item, fields: [...new Set([...(existing.get(item.id)?.fields || []), ...item.fields])] }));
  const relationshipTypes = replacing ? [] : [...base.relationshipTypes];
  proposal.draft.relationshipTypes.forEach((item) => {
    if (!relationshipTypes.some((current) => current.from === item.from && current.predicate === item.predicate && current.to === item.to)) relationshipTypes.push(item);
  });
  const mergedInput = { objectTypes: [...existing.values()], relationshipTypes, policies: base.policies, ...(proposal.draft.worldModel ? {
    worldModel: proposal.draft.worldModel, modelingProfile: proposal.draft.modelingProfile, scenario: proposal.draft.scenario
  } : {}), ...(replacing ? {
    modelingProfile: 'general', scenario: proposal.draft.scenario || { objective: '重新建模', questions: ['模型是否完整？'], decisionBindings: [], actionBindings: [], requireCaseReplay: true },
    stateMachines: [], events: [], metrics: [],
    glossaryTerms: [...existing.values()].map(o => ({ id: o.id, term: o.label, objectType: o.id, definition: o.description || o.label })),
    dataContracts: [...existing.values()].map(o => ({ id: `${o.id}_contract`, objectType: o.id, sourceSystem: o.sourceSystems[0], schemaVersion: '1.0' })),
    qualityRules: [...existing.values()].map(o => ({ id: `${o.id}_key`, objectType: o.id, field: o.key, rule: 'not_null' })),
    accessPolicies: [...existing.values()].map(o => ({ objectType: o.id, effect: 'deny', roles: [], condition: '需要单独审批对象权限' })),
    lineageEdges: [...existing.values()].map(o => ({ from: o.source, to: o.id, fields: o.fields }))
  } : {}) };
  const expectedBaseFingerprint = semanticFingerprint(base);
  return mutateSemanticGovernanceStates([
    getOAMetaModelRuntimeTransactionEntry(),
    { name: 'proposal', namespace: PROPOSAL_NAMESPACE, key: proposalKey(proposalId), initialValue: null },
    { name: 'snapshots', namespace: SNAPSHOT_NAMESPACE, key: 'index', initialValue: {} }
  ], (values) => {
    const storedProposal = values.proposal;
    if (!storedProposal || !semanticOperationsOwnerMatches(storedProposal.owner, identityScope)) return { commit: false, result: { error: '未找到可采纳的语义建模草稿，或该草稿不属于当前身份。', code: 'SEMANTIC_PROPOSAL_NOT_FOUND' } };
    if (storedProposal.status !== 'pending_review' || (storedProposal.revision || 1) !== (proposal.revision || 1)) return { commit: false, result: { error: '提案已被其他窗口更新或采纳，请刷新后重试。', code: 'SEMANTIC_PROPOSAL_REVISION_CONFLICT' } };
    const transactionBase = getOAMetaModelDraftFromRuntime(values.oaRuntime);
    if (semanticFingerprint(transactionBase) !== expectedBaseFingerprint) return { commit: false, result: { error: '语义草稿已发生并发变化，请重新审阅 Diff 后采纳。', code: 'SEMANTIC_PROPOSAL_BASE_STALE' } };
    const change = buildOAMetaModelDraftRuntimeChange(values.oaRuntime, mergedInput, role, {
      action: '采纳 Agent 语义建模提案',
      detail: `提案 ${proposal.id} 已${replacing ? '替换草稿为' : '合并'} ${proposal.draft.objectTypes.length} 个对象和 ${proposal.draft.relationshipTypes.length} 条关系。`
    });
    if (change.error) return { commit: false, result: { error: change.error } };
    const snapshot = {
      id: `semantic-snapshot-${createHash('sha256').update(`${proposal.id}:${now()}`).digest('hex').slice(0, 16)}`,
      owner: identityKey(identityScope), proposalId: proposal.id, createdAt: now(), status: 'active', before: clone(transactionBase), after: clone(change.result.draft), afterFingerprint: semanticFingerprint(change.result.draft), diff: proposal.diff
    };
    values.snapshots[snapshot.id] = snapshot;
    storedProposal.status = 'applied_to_draft'; storedProposal.appliedAt = now(); storedProposal.appliedBy = role.id; storedProposal.snapshotId = snapshot.id;
    return {
      values: { ...values, oaRuntime: change.runtime, proposal: storedProposal },
      result: { proposal: publicProposal(storedProposal), snapshot: publicSnapshot(snapshot), draft: change.result.draft, message: `已${replacing ? '替换当前草稿为' : '合并到当前草稿：'} ${storedProposal.draft.objectTypes.length} 个对象和 ${storedProposal.draft.relationshipTypes.length} 条关系，并保存可回滚快照；尚未校验或登记。` }
    };
  });
  }));
  });
}

export function rollbackSemanticOperationsSnapshot({ snapshotId, role, identityScope }) {
  assertSemanticTenant(identityScope);
  return mutateSemanticGovernanceStates([
    getOAMetaModelRuntimeTransactionEntry(),
    { name: 'snapshots', namespace: SNAPSHOT_NAMESPACE, key: 'index', initialValue: {} }
  ], (values) => {
    const snapshot = values.snapshots[snapshotId];
    if (!snapshot || !semanticOperationsOwnerMatches(snapshot.owner, identityScope)) return { commit: false, result: { error: '未找到可回滚的语义层快照，或该快照不属于当前身份。', code: 'SEMANTIC_SNAPSHOT_NOT_FOUND' } };
    if (snapshot.status !== 'active') return { commit: false, result: { error: '该快照已回滚或不再可用。', code: 'SEMANTIC_SNAPSHOT_NOT_ACTIVE' } };
    if (semanticFingerprint(getOAMetaModelDraftFromRuntime(values.oaRuntime)) !== snapshot.afterFingerprint) return { commit: false, result: { error: '当前语义层草稿已发生后续变更，不能覆盖式回滚该快照。请先处理较新的变更。', code: 'SEMANTIC_SNAPSHOT_STALE' } };
    const change = buildOAMetaModelDraftRuntimeChange(values.oaRuntime, snapshot.before, role, {
      action: '回滚 Agent 语义建模快照',
      detail: `已恢复到提案 ${snapshot.proposalId} 采纳前的草稿。`
    });
    if (change.error) return { commit: false, result: { error: change.error } };
    snapshot.status = 'rolled_back'; snapshot.rolledBackAt = now(); snapshot.rolledBackBy = role.id;
    values.snapshots[snapshot.id] = snapshot;
    return { values: { ...values, oaRuntime: change.runtime }, result: { snapshot: publicSnapshot(snapshot), draft: change.result.draft, message: `已回滚到采纳“${snapshot.proposalId}”前的语义层草稿版本；未影响已发布版本。` } };
  });
}

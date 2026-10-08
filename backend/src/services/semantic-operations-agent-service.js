import { createHash } from 'node:crypto';
import { mutateSemanticGovernanceState, mutateSemanticGovernanceStates, readSemanticGovernanceState } from './semantic-governance-store.js';
import { buildOAMetaModelDraftRuntimeChange, getOAMetaModelDraft, getOAMetaModelDraftFromRuntime, getOAMetaModelRuntimeTransactionEntry } from './meta-model-service.js';
import { inspectMultimodalInput, extractMultimodalEvidence } from './multimodal-input-service.js';
import { inspectModelPromptSafety } from './local-model-gateway.js';
import { discoverSchemasFromAttachments } from './semantic-schema-discovery-service.js';
import { discoverNaturalSchema } from './semantic-natural-schema-service.js';
import { discoverObjectMentionLinks } from './semantic-object-mention-service.js';
import { validateSemanticMappingContract } from './semantic-mapping-validation-service.js';
import { semanticFingerprint } from './semantic-model-fingerprint.js';
import { inferObjectGranularity } from './ontology-contract-service.js';
import { semanticOperationsOwnerMatches, semanticOperationsPrincipalKey } from './semantic-operations-identity.js';
import { assertSemanticTenant } from './semantic-tenant-context.js';
import { discoverWorkspaceSchemas, extendSemanticMaterials } from './semantic-material-workspace-service.js';
import { validateProposalSamples } from './semantic-uploaded-sample-service.js';
import { compileWorldModelRequirements, validateProposalEvidence, proposalBusinessValidation, preparePrimaryKeyCorrections } from './semantic-world-model-service.js';
import { mockOnboardingBasis } from './mock-onboarding-basis.js';
import { buildConfirmedRelationships, deriveIdentityLinking, resolveDeclarationRulings, resolveIdentityConflictRulings, sanitizeKeyMapping } from './semantic-identity-link-service.js';
import { isRegisteredSystemCode } from './semantic-source-discovery-service.js';
// 阶段 4g（ADR-022）：受控候选目录连它自己的「覆盖披露」一起搬出本文件。
// 搬出去的理由不是分文件，而是让「兜底路径能命中什么、命中不到什么」可以被**单独取证**——
// 它此前与提案组装、标识推导、审阅说明生成混在同一个文件里，没有独立的取证入口。
import { CANDIDATE_CATALOG_SIZE, listCatalogGaps, listUncoveredMentions, matchCandidateCatalog } from './semantic-candidate-catalog-service.js';

const PROPOSAL_NAMESPACE = 'semantic_operations_agent_proposals';
const SNAPSHOT_NAMESPACE = 'semantic_operations_agent_snapshots';
const proposalKey = (id) => `proposal-${id}`;
const now = () => new Date().toISOString();
const identityKey = semanticOperationsPrincipalKey;
const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const sourceFieldName = (value) => String(value || '').replace(/_([a-z\d])/g, (_, character) => character.toUpperCase());
const clone = (value) => JSON.parse(JSON.stringify(value));
const ownerTenantId = (owner) => { try { return JSON.parse(owner)?.[0] || null; } catch { return null; } };
const proposalCanBeReviewed = (proposal, identityScope, accessContext) => Boolean(proposal?.id
  && ownerTenantId(proposal.owner) === (identityScope?.tenantId || 'demo-enterprise')
  && accessContext?.buttonPermissionIds?.includes(proposal.reviewPermission || 'meta_model.draft.review')
  && accessContext?.buttonPermissionIds?.includes('meta_model.draft.save'));
const canAccessProposal = (proposal, identityScope, accessContext) => semanticOperationsOwnerMatches(proposal?.owner, identityScope)
  || proposalCanBeReviewed(proposal, identityScope, accessContext);
const mapMaybe = (value, callback) => value && typeof value.then === 'function' ? value.then(callback) : callback(value);
const writeSemanticState = (namespace, key, value) => mutateSemanticGovernanceState(namespace, key, null, () => ({ value, result: value }));
const persistProposalReviewFailure = (proposal, result) => mutateSemanticGovernanceState(PROPOSAL_NAMESPACE, proposalKey(proposal.id), null, current => {
  if (!current || current.status !== 'pending_review' || (current.revision || 1) !== (proposal.revision || 1)) return { commit: false, result: { error: '提案已被更新，旧校验结果未覆盖当前修订。', code: 'SEMANTIC_PROPOSAL_REVISION_CONFLICT' } };
  return { value: proposal, result };
});
const approvedSourceSystems = new Set(['ERP', 'WMS', 'LIMS', 'MES', 'QMS', 'OMS', 'OA', 'SRM', 'MDM', 'PLM', 'EAM', 'IOT', 'AI', 'AUDIT']);
const approvedCoreObjects = new Set(['Person', 'RawMaterial', 'Product', 'Equipment', 'Store']);
const approvedCardinalities = new Set(['1:1', '1:n', 'n:1', 'n:n']);
const approvedMappingStatuses = new Set(['mapped', 'manual', 'derived', 'ignored', 'pending']);
const MAX_PROPOSAL_OBJECTS = 40;
const MAX_PROPOSAL_FIELDS = 80;
const MAX_PROPOSAL_RELATIONSHIPS = 40;

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
      // 阶段 4c 第二段：归属候选必须一起过白名单。这已是同一类缺口的第三次出现
      // （`systemScope`、`derivedFrom` 都是「内部有、白名单没登记」）——白名单式重建每加一个字段都要在这里登记，
      // 漏登记的后果不是报错，而是**静默丢失**，只在重算结果与上一版不一致时才暴露。
      candidateSourceSystems: [...new Set((Array.isArray(item?.candidateSourceSystems) ? item.candidateSourceSystems : original?.candidateSourceSystems || []).map((value) => cleanIdentifier(value, 16).toUpperCase()).filter(Boolean))].slice(0, 8),
      candidateSourceEvidence: cleanText(item?.candidateSourceEvidence ?? original?.candidateSourceEvidence, 240) || null,
      candidateSourceBasis: cleanText(item?.candidateSourceBasis || original?.candidateSourceBasis, 32) || null,
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
    // 260 而非 100：人工确认并入的标识对应必须同时容纳「链接证据」「键形状」「人写下的映射依据」，
    // 100 字必然截断，且会截在半句话上（实测踩到）。这是展示保真度上限，不是安全边界。
    evidence: cleanText(item?.evidence ?? '运营人员复核', 260),
    provenanceType: item?.provenanceType || 'declared', validFrom: item?.validFrom || null, validTo: item?.validTo || null,
    // 由标识对应并入的关系必须留回指链接 key 的凭据，否则「这条边是推断还是材料写明的」无法追溯。
    // （与 `publicTask` 同类：新增字段不进白名单就会在净化时被静默丢掉。）
    derivedFrom: cleanText(item?.derivedFrom, 200) || null,
    // 阶段 4d（ADR-019）：**结构化映射定义必须一起过白名单**——这是同一缺口的第四次预防
    // （`systemScope`、`derivedFrom`、`candidateSourceSystems` 各踩过一次）。漏登记的后果不是报错，
    // 而是「边进了草稿、但『它需要经外部映射才能用』这件事在净化时被静默丢掉」——
    // 恰好又回到本 ADR 要消除的那个状态。清洗函数与确认解析共用同一份枚举与长度上限。
    keyMapping: sanitizeKeyMapping(item?.keyMapping)
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

const critiqueProposalDraft = (draft, base, discovery, primaryKeyCorrections = [], sourceAssignments = []) => {
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
  checks.push(...validateProposalEvidence(draft, discovery, primaryKeyCorrections, sourceAssignments));
  return { status: checks.every((item) => item.status === 'passed') ? 'passed' : 'failed', checkedAt: now(), checks };
};

const publicProposal = (proposal) => proposal && ({
  primaryKeyCorrections: proposal.primaryKeyCorrections || [],
  adoptionMode: proposal.adoptionMode || 'merge',
  worldModel: proposal.draft.worldModel || null,
  scenario: proposal.draft.scenario || null,
  stateMachines: proposal.draft.stateMachines || [],
  businessValidation: proposalBusinessValidation(proposal.draft, proposal.critic, proposal.mappingValidation),
  id: proposal.id, status: proposal.status, createdAt: proposal.createdAt, source: proposal.source, sourceSummary: proposal.sourceSummary,
  objectTypes: proposal.draft.objectTypes, relationshipTypes: proposal.draft.relationshipTypes, reviewNotes: proposal.reviewNotes,
  critic: proposal.critic, diff: proposal.diff, editDiff: proposal.editDiff || buildEditDiff(proposal.originalDraft || proposal.draft, proposal.draft), impactAnalysis: proposal.impactAnalysis || buildImpactAnalysis(proposal.originalDraft || proposal.draft, proposal.draft), mappingValidation: proposal.mappingValidation || validateSemanticMappingContract(proposal.draft), schemaDiscovery: proposal.schemaDiscovery || null,
  revision: proposal.revision || 1, updatedAt: proposal.updatedAt || proposal.createdAt, revisions: proposal.revisions || [], snapshotId: proposal.snapshotId || null, requiresConfirmation: true,
  scopeExclusions: proposal.scopeExclusions || null,
  // 阶段 4g：候选对象的覆盖面是**审阅依据**，必须进白名单。
  // 这个白名单此前已三次漏登记字段（`systemScope` / `derivedFrom` / `publicTask`），
  // 漏登记的后果不是报错而是**静默丢失**——因此新字段一律在此显式登记。
  candidateCoverage: proposal.candidateCoverage || null,
  // 阶段 4a：跨系统标识对应与冲突是**对外可见的审阅依据**，必须进白名单；
  // 上次 `systemScope` 漏登记的先例说明「内部有、外部无」只在接口层用例上暴露。
  // 阶段 4b 同理：人工确认了哪些对应、哪条没并进去，都是审阅结论的一部分。
  // 阶段 4c：等价裁定与重算报告同理——界面要靠它判断「哪些前提还没被看过」。
  identityLinking: proposal.identityLinking || null,
  identityConflictRulings: proposal.identityConflictRulings || [],
  // 阶段 4c 第三段：同名声明裁定同样是**改输入**的人工结论，且它决定了字段目录的组成——
  // 「对象为什么被拆成两个」必须能从提案上看出来，否则界面只能靠字段数变化猜。
  declarationRulings: proposal.declarationRulings || [],
  // 阶段 4c 第二段：归属确认是**改事实**的人工结论（写进 `sourceSystems`），比裁定与对应确认更重，
  // 因此它的留档必须对外可见——「这个对象的来源是人写的」要能从提案上看出来。
  sourceAssignments: proposal.sourceAssignments || [],
  identityLinkConfirmations: proposal.identityLinkConfirmations || [],
  identityLinkConfirmationReport: proposal.identityLinkConfirmationReport || null
});

const publicSnapshot = (snapshot, currentFingerprint = null) => snapshot && ({
  id: snapshot.id, proposalId: snapshot.proposalId || null, sourceType: snapshot.sourceType || 'agent_adoption', createdAt: snapshot.createdAt, status: snapshot.status,
  createdBySubjectId: snapshot.createdBySubjectId || null, createdByRoleId: snapshot.createdByRoleId || null,
  rolledBackAt: snapshot.rolledBackAt || null, rolledBackBySubjectId: snapshot.rolledBackBySubjectId || null, rolledBackByRoleId: snapshot.rolledBackByRoleId || snapshot.rolledBackBy || null,
  summary: snapshot.diff.summary, diff: snapshot.diff,
  rollbackAllowed: snapshot.status === 'active' && currentFingerprint !== null && currentFingerprint === snapshot.afterFingerprint
});

/**
 * 按所选来源范围过滤候选对象（ADR-013：范围是**过滤器**，且被排除项必须显式列出）。
 *
 * 判定规则（刻意区分三种「不在提案里」的原因，避免运营无法归因）：
 * - 来源**全部**在范围外 → **排除**，记入 `excludedObjects`；
 * - 来源**部分**在范围外 → **保留**（该对象有合法在范围内的来源，排除它会丢掉范围内系统的真实事实），
 *   但把范围外的那些来源记入 `partialScopeObjects.outside`；
 * - 来源缺失或为 `UNASSIGNED` → **保留**（来源未知即无法判断范围；把「未标注」当「超范围」会让
 *   纯自然语言抽取路径整体被清空，属灾难性静默丢失）；
 * - `scopeSystems` 非数组 → 调用方未提供范围（非建模路径），不做任何过滤。
 */
function applyScopeFilterToObjects(objectTypes, scopeSystems) {
  const excludedObjects = [];
  const partialScopeObjects = [];
  const unassignedObjects = [];
  // 阶段 4c 第二段（ADR-017 决策 3）：归属候选**不参与裁剪**——未确认的归属不足以决定对象去留，
  // 否则模型在材料里引用一句归属于范围外的原文就能把对象删掉。但候选指向范围外这件事必须可见，
  // 否则运营会以为这个对象的归属还没人看过。
  const candidateScopeObjects = { inScope: [], outOfScope: [] };
  if (!Array.isArray(scopeSystems)) return { objectTypes, excludedObjects, partialScopeObjects, unassignedObjects, candidateScopeObjects };
  const selected = new Set(scopeSystems);
  const kept = [];
  for (const object of objectTypes) {
    const known = [...new Set((object.sourceSystems || []).filter(Boolean))].filter((code) => code !== 'UNASSIGNED');
    if (!known.length) {
      unassignedObjects.push(object.id);
      for (const code of (object.candidateSourceSystems || []).map((item) => String(item || '').toUpperCase()).filter(Boolean)) {
        const entry = { objectId: object.id, label: object.label || object.id, system: code, evidence: object.candidateSourceEvidence || null };
        (selected.has(code) ? candidateScopeObjects.inScope : candidateScopeObjects.outOfScope).push(entry);
      }
      kept.push(object);
      continue;
    }
    const outside = known.filter((code) => !selected.has(code));
    if (outside.length === known.length) {
      excludedObjects.push({ objectId: object.id, label: object.label || object.id, sourceSystems: known });
      continue;
    }
    if (outside.length) partialScopeObjects.push({ objectId: object.id, sourceSystems: known, outside });
    kept.push(object);
  }
  return { objectTypes: kept, excludedObjects, partialScopeObjects, unassignedObjects, candidateScopeObjects };
}

/**
 * 端点对象被排除后，引用它的关系必须一并排除；否则会留下悬空边（Critic 会判 `brokenRelations`），
 * 且运营看到「关系少了」却无法归因。按端点分别给出原因。
 */
function partitionRelationshipsByScope(relationshipTypes, keptIds, excludedIds = new Set()) {
  const kept = [];
  const excludedRelationships = [];
  for (const item of relationshipTypes) {
    const missing = [item.from, item.to].filter((endpoint) => !keptIds.has(endpoint));
    if (!missing.length) { kept.push(item); continue; }
    // 区分「被范围排除」与「本次压根没识别到」，否则运营会去查一个不存在的系统。
    const reason = missing.map((endpoint) => (excludedIds.has(endpoint)
      ? `端点对象 ${endpoint} 因来源系统不在本次所选范围内被排除`
      : `端点对象 ${endpoint} 不在本次提案中`)).join('；');
    excludedRelationships.push({ from: item.from, predicate: item.predicate, to: item.to, reason: `${reason}，关系随对象一并排除。` });
  }
  return { relationshipTypes: kept, excludedRelationships };
}

export function createSemanticOperationsProposal({ input, multimodalContent, attachments = [], schemaDiscovery = null, naturalSchemaSkip = null, mentionLinking = null, identityScope, requirements = '', sampleRefs = [], roleId, adoptionMode = 'merge', prepareOnly = false, scopeSystems = null }) {
  assertSemanticTenant(identityScope);
  if (!['merge', 'replace'].includes(adoptionMode)) return { error: '请选择合并或替换当前草稿。', code: 'SEMANTIC_ADOPTION_MODE_INVALID' };
  const sourceText = `${normalize(input)}\n${normalize(multimodalContent?.modelContext)}`.slice(0, 24_000);
  // 「硬编码目录 + 关键词命中」的实体（阶段 4f 起把依据说清楚，阶段 4g 起连**没命中的**也说）。
  // 受控目录（`semantic-candidate-catalog-service.js`）是受控词汇表，只有当结构化材料与
  // 自然语言抽取**都没产出对象**时才兜底使用。兜底时必须披露命中词与覆盖率：
  // 否则「材料里写了、但目录没有这个词」的对象会静默消失，
  // 运营只看到「候选里没有发运单」，分不清是自己没写清、还是目录压根不含这个词。
  // 阶段 4h（ADR-025）：受控对象链接产出的候选。链接只在「材料逐字提及 ↔ 已登记对象类型」
  // 两侧都被服务端校验过时成立；结构（字段/主键）来自该系统的既有声明，模型不给结构。
  const mentionCandidates = mentionLinking?.candidates || [];
  const mentionStructureGaps = mentionLinking?.gaps || [];
  const catalogHits = matchCandidateCatalog(sourceText);
  // 兜底条件收窄：受控对象链接**产出了候选**时，目录兜底同样不生效——
  // 链接候选来自已登记类型与系统声明，是比词面命中更强的事实来源。
  const catalogSelection = (schemaDiscovery?.objectTypes?.length || mentionCandidates.length) ? [] : catalogHits.map((entry) => entry.item);
  // 阶段 4g（ADR-022）：兜底路径生效时，把「目录覆盖面」本身一并披露——
  //   ① 目录空白（确定性）：平台已治理、但候选目录没有词条的对象类；
  //   ② 未覆盖提及（启发式）：材料列举项里没有被任何词条覆盖的那些。
  // 两项都只披露，**不入草稿**（披露不等于补齐，同 ADR-018 / ADR-021 立场）。
  const coveredTerms = catalogHits.flatMap((entry) => entry.matchedTerms);
  const catalogGaps = catalogSelection.length ? listCatalogGaps() : [];
  const uncovered = catalogSelection.length
    ? listUncoveredMentions({ sourceText, matchedTerms: coveredTerms })
    : { mentions: [], total: 0, truncated: false, basis: 'enumeration_heuristic' };
  const candidateCoverage = {
    catalogSize: CANDIDATE_CATALOG_SIZE,
    // 「兜底路径是否生效」是解读整份覆盖披露的前提：结构化材料或自然语言抽取产出了对象时，
    // 目录根本没被用到，此时说「目录命中 0 类」会误导成「目录能力不行」。
    fallbackApplied: Boolean(catalogSelection.length),
    matched: catalogHits.map((entry) => ({ id: entry.item.id, matchedTerms: entry.matchedTerms })),
    gaps: catalogGaps,
    uncoveredMentions: uncovered.mentions,
    uncoveredTotal: uncovered.total,
    uncoveredTruncated: uncovered.truncated,
    // 提及清单的**取得方式**必须随清单一起走。把它写成字段而不是一句注释，
    // 是因为下游（界面 / 报告 / 复算）需要能判断「这份清单该不该被当真」。
    uncoveredBasis: uncovered.basis,
    // 阶段 4h（ADR-025）：受控对象链接的披露。`skipped` 是解读前提（同 `fallbackApplied`
    // 的理由）：模拟运行时下链接根本没跑，「linked 为空」不说明材料里没有已登记对象。
    // `linked[].structured` 说清每条链接有没有落成候选；给不出结构的留在 `structureGaps`。
    mentionLinking: mentionLinking ? {
      skipped: mentionLinking.skipped || null,
      skipReason: mentionLinking.skipped ? mentionLinking.reason : null,
      basis: mentionLinking.skipped ? null : (mentionLinking.basis || null),
      linked: (mentionLinking.links || []).map((link) => ({
        mention: link.mention, objectType: link.objectType, system: link.system,
        evidence: link.evidence,
        structured: !mentionStructureGaps.some((gap) => gap.objectType === link.objectType)
      })),
      total: mentionLinking.total || 0,
      truncated: Boolean(mentionLinking.truncated),
      mergedDuplicates: mentionLinking.mergedDuplicates || 0,
      structureGaps: mentionStructureGaps
    } : null
  };
  const catalogCandidates = catalogSelection.map((item) => ({
    id: item.id, label: item.label, source: item.source, key: item.key, fields: item.fields, classification: item.classification,
    granularity: inferObjectGranularity(item.id),
    semanticType: item.id, coreObject: item.coreObject, sourceSystems: [item.source.split('.')[0].toUpperCase()],
    fieldDefinitions: item.fields.map((name) => ({ name, type: 'string', required: name === item.key, primaryKey: name === item.key, sourceField: sourceFieldName(name), mappingStatus: 'mapped', reference: null, description: null })),
    description: `由元域智语 Agent 根据${attachments.length ? '已通过内容扫描的材料与' : ''}自然语言描述生成的待审阅对象。`
  }));
  const extractedObjectTypes = [...new Map([...(schemaDiscovery?.objectTypes || []), ...mentionCandidates, ...catalogCandidates].map((item) => [item.id, item])).values()];
  if (!extractedObjectTypes.length) return {
    error: '没有从当前诉求或受控材料中识别到可追溯的候选对象。请补充业务对象、来源系统和字段范围，或上传结构化数据字典。',
    code: 'SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS',
    status: 422
  };
  const scoped = applyScopeFilterToObjects(extractedObjectTypes, scopeSystems);
  const objectTypes = scoped.objectTypes;
  // 识别到了对象、但全被范围排除——必须与「什么都没识别到」区分开：前者是范围问题（可补选系统解决），
  // 后者是材料问题。用同一个错误码会让运营去改材料，方向就错了。
  if (!objectTypes.length) return {
    error: `识别到的候选对象全部来自本次未选择的系统：${scoped.excludedObjects.map((item) => `${item.label}（${item.sourceSystems.join('/')}）`).join('、')}。本次所选范围不覆盖它们的来源，已按范围排除；如需建模这些对象，请补选对应系统后重试。`,
    code: 'SEMANTIC_PROPOSAL_SCOPE_EXCLUDED_ALL',
    status: 422
  };
  const ids = new Set(objectTypes.map((item) => item.id));
  const excludedIds = new Set(scoped.excludedObjects.map((item) => item.objectId));
  // 关系必须在**过滤前**的候选集上组装：若先按保留对象过滤，被丢弃的关系就再也看不见了，
  // 「关系为什么少了」也就无法归因。
  const extractedIds = new Set(extractedObjectTypes.map((item) => item.id));
  const catalogRelationships = (schemaDiscovery?.objectTypes?.length ? [] : relationshipCatalog).filter(([from, , to]) => extractedIds.has(from) && extractedIds.has(to)).map(([from, predicate, to, label]) => ({
    from, predicate, to, label, cardinality: '1:n', evidence: attachments.length ? '受控材料与自然语言描述' : '用户自然语言描述'
  }));
  const scopedRelationships = partitionRelationshipsByScope([...new Map([...(schemaDiscovery?.relationshipTypes || []), ...catalogRelationships].map((item) => [`${item.from}:${item.predicate}:${item.to}`, item])).values()], ids, excludedIds);
  const relationshipTypes = scopedRelationships.relationshipTypes;
  const scopeExclusions = {
    appliedTo: Array.isArray(scopeSystems) ? [...scopeSystems] : null,
    excludedObjects: scoped.excludedObjects,
    excludedRelationships: scopedRelationships.excludedRelationships,
    partialScopeObjects: scoped.partialScopeObjects,
    unassignedObjects: scoped.unassignedObjects,
    // 归属候选只在「对象没有已确认来源」时存在，因此与 `unassignedObjects` 是同一批对象上的一层信息。
    candidateScopeObjects: scoped.candidateScopeObjects
  };
  const fingerprint = createHash('sha256').update(`${identityKey(identityScope)}:${sourceText}`).digest('hex').slice(0, 16);
  const id = `semantic-proposal-${fingerprint}-${Date.now().toString(36)}`;
  // 阶段 4a：范围内系统的字段目录、标识识别与跨系统标识对应。
  // 只在调用方显式给出范围时推导——没有范围就没有「范围内的系统声明」这回事。
  // 结果**只上报**，不自动并入 relationshipTypes：字段名归一化推出的是假设，不是证据。
  const identityLinking = Array.isArray(scopeSystems) ? deriveIdentityLinking({ objects: objectTypes, systems: scopeSystems }) : null;
  const worldModel = compileWorldModelRequirements(requirements, objectTypes);
  // 「其所属概念存在等价分歧、且该分歧尚未裁定」的链接——这才是「结论站在一个没人回答过的前提上」的准确口径。
  // 直接数 `ruling === null` 会把 PurchaseOrder / Supplier 这类根本没有等价分歧的链接也算进来。
  const unresolvedConcepts = identityLinking?.rulingReport?.unresolvedConcepts || [];
  const unresolvedAssumptionLinks = unresolvedConcepts.length
    ? identityLinking.links.filter((item) => !item.ruling && unresolvedConcepts.includes(item.concept))
    : [];
  // 归属候选的可读清单（范围内 + 范围外合并），供 reviewNotes 生成提示。
  const candidateAttribution = [...scopeExclusions.candidateScopeObjects.inScope, ...scopeExclusions.candidateScopeObjects.outOfScope];
  const draft = { objectTypes, relationshipTypes, ...(schemaDiscovery?.schemas?.length ? {
    worldModel, modelingProfile: 'general',
    scenario: { objective: normalize(input).slice(0, 2000), questions: ['材料中的对象、关系和业务约束是否完整保留？'], decisionBindings: [], actionBindings: [], requireCaseReplay: true },
    stateMachines: [],
  } : {}) };
  return mapMaybe(getOAMetaModelDraft(), (base) => mapMaybe(validateProposalSamples(draft, { sampleRefs, roleId, identityScope, requireEvidence: Boolean(schemaDiscovery?.schemas?.length) }), (mappingValidation) => {
  const proposal = {
    id, adoptionMode, owner: identityKey(identityScope), reviewPermission: 'meta_model.draft.review', createdAt: now(), status: 'pending_review', source: attachments.length ? 'multimodal_and_natural_language' : 'natural_language',
    sourceSummary: schemaDiscovery?.files?.length ? schemaDiscovery.summary : attachments.length ? `已引用 ${multimodalContent?.evidence?.length || 0} 条通过扫描的材料文本；未配置企业视觉适配器的图片不会被当作已理解内容。` : '仅根据运营人员的自然语言描述生成，不读取企业业务系统。',
    schemaDiscovery, sampleRefs, originRoleId: roleId, revision: 1, updatedAt: now(), originalDraft: clone(draft), revisions: [],
    scopeExclusions,
    // 阶段 4g（ADR-022）：候选对象的**覆盖面**（目录空白 + 未覆盖提及）与命中依据。
    // 结构化字段而非只写进审阅说明：界面要能单独渲染「目录没覆盖什么」，
    // 报告与复算也要能按字段判断，不必去解析一段中文。
    candidateCoverage,
    identityLinking,
    // 阶段 4c：等价裁定与确认一样是**全量语义**的集合，初始为空（未裁定任何概念）。
    identityConflictRulings: [],
    // 阶段 4c 第二段：归属确认初始为空（没有任何对象的来源被人确认过）。
    sourceAssignments: [],
    // 阶段 4c 第三段：同名声明裁定初始为空（没有任何分歧被裁定过）——
    // 「未裁定」与「裁定为合并」是两种不同状态，前者意味着目录里的并集还是默认动作。
    declarationRulings: [],
    draft, critic: critiqueProposalDraft(draft, base, schemaDiscovery), diff: buildDiff(base, draft, adoptionMode), editDiff: buildEditDiff(draft, draft), impactAnalysis: buildImpactAnalysis(adoptionMode === 'replace' ? base : draft, draft), mappingValidation, reviewNotes: [
      '这是元域智语 Agent 生成的待审阅草稿，尚未写入语义层或 Semantica。',
      adoptionMode === 'replace' ? `替换当前工作区草稿：现有 ${base.objectTypes.length} 类对象中未出现在候选的对象将移除；确认前请检查，采纳时保存回滚快照。不是新增并行模型。` : '合并到当前工作区草稿；保留既有对象，不会新建并行模型。',
      '采纳后只保存为元模型草稿；仍需校验、模拟构建和管理层登记。',
      '不复制原始业务记录，只保留对象结构、字段和关系。',
      ...(scopeExclusions.excludedObjects.length ? [`按所选来源范围排除了 ${scopeExclusions.excludedObjects.length} 类对象（${scopeExclusions.excludedObjects.map((item) => `${item.objectId}（${item.sourceSystems.join('/')}）`).join('、')}）；如需纳入请补选对应系统后重跑。`] : []),
      // 阶段 4f：候选对象的**来源**必须可读。「受控目录关键词命中」与「材料逐字抽取」的可信度完全不同：
      // 前者只是词面匹配一张硬编码表，后者逐字核对原文。不说清会让运营把两种来源当成一种，
      // 也会让「材料里写了、但目录没这个词的对象」静默消失而无人察觉。
      ...(catalogSelection.length ? [`候选对象中有 ${catalogSelection.length} 类来自**受控目录关键词命中**（${catalogHits.map((entry) => `${entry.item.id} ← ${entry.matchedTerms.join('、')}`).join('；')}），受控目录共 ${CANDIDATE_CATALOG_SIZE} 类。这条路只按词面匹配：材料里写到、但目录未覆盖的业务对象**不会**出现在候选里，请核对是否遗漏。`] : []),
      // 阶段 4g（ADR-022）：上面那句「请核对是否遗漏」此前**无法核对**——目录没覆盖什么，
      // 材料里哪些词没被覆盖，都不可见。下面两条分别把这两侧点亮：
      // 一条是确定性的（目录与平台已治理对象的差集），一条是启发式的（材料列举项）。
      ...(catalogGaps.length ? [`受控目录 ${CANDIDATE_CATALOG_SIZE} 类之外，系统目录里还登记了 ${catalogGaps.length} 类**世界模型对象**（${catalogGaps.map((item) => `${item.objectType}（${item.system}）`).join('、')}），它们**在受控目录里没有任何词条**：材料里若只提到这些对象，关键词兜底一定命中不到。要建它们，请上传结构化数据字典，或先在系统目录里为该对象补词条后重跑。`] : []),
      ...(uncovered.total ? [`材料里另有 ${uncovered.total} 处列举项没有被任何受控词条覆盖（${uncovered.mentions.join('、')}${uncovered.truncated ? ' 等' : ''}），因此**不会**出现在候选里。这份清单由「列举分隔符 + 纯中文短短语」**启发式**取得（见 candidateCoverage.uncoveredBasis），**不是对象抽取结果**：可能混入非对象词，也可能漏掉没有用分隔符列出的对象名。请人工核对；若其中有要建模的对象，请补充材料或用受控目录的用词重写。`] : []),
      // 阶段 4h（ADR-025）：受控对象链接把「已登记类型」的点名升级为候选——这是对
      // 4g 决策 6「点名不进候选」的收窄推翻：只有两侧都被服务端校验的链接才进，
      // 且结构来自系统声明、字段映射仍未确认，Critic 会拦住未映射就采纳的尝试。
      ...(mentionCandidates.length ? [`${mentionCandidates.length} 类候选来自**受控对象链接**（${mentionCandidates.map((item) => `${item.label} ← ${item.sourceSystems.join('/')}`).join('、')}）：材料逐字提及了这些对象，且对象类型已在系统目录登记；字段与主键来自该系统的既有声明，**字段映射尚未确认**，采纳前须补齐映射。`] : []),
      ...(mentionStructureGaps.length ? [`另有 ${mentionStructureGaps.length} 处材料提及链接到了已登记对象类型、但给不出候选结构：${mentionStructureGaps.map((gap) => `${gap.mention}→${gap.objectType}（${gap.reason === 'no_declaration' ? '系统无字段声明' : '声明中识别不出主键'}）`).join('、')}。${mentionStructureGaps[0]?.suggestion || ''}`] : []),
      ...(naturalSchemaSkip ? [`未从非结构化材料做自然语言抽取——${naturalSchemaSkip.reason}`] : []),
      ...(identityLinking?.summary.links ? [`范围内系统的声明给出了 ${identityLinking.summary.links} 条跨系统标识引用（其中 ${identityLinking.summary.requiresMapping} 条是代理键与业务键之间的引用，不能按值直接对齐，确认时必须给出**结构化映射定义**${identityLinking.summary.shapeUnknown ? `；另有 ${identityLinking.summary.shapeUnknown} 条有一端键形状未判定（裸名），必须先判定形状才能确认` : ''}）。这些是**假设**，未自动并入草稿关系，需人工确认后再建模。`] : []),
      ...(identityLinking?.conflicts.length ? [`标识冲突 ${identityLinking.conflicts.length} 项（${[...new Set(identityLinking.conflicts.map((item) => item.kind))].join('、')}）已单独上报，未做静默合并。`] : []),
      // 这条提示是本阶段的核心：链接数看着是 11，但其中大部分站在一个没人回答过的前提上。
      // 只说「有 11 条对应」会让人以为 11 个结论分别独立——实际上它们共享少数几个等价假设。
      ...(unresolvedAssumptionLinks.length ? [`其中 ${unresolvedAssumptionLinks.length} 条标识对应建立在「同一概念下的多个字段名指向同一实体」这一**尚未裁定**的等价前提上（涉及 ${unresolvedConcepts.join('、')}）；请先裁定等价前提，再逐条确认是否并入。`] : []),
      // 阶段 4c 第二段：归属候选是「材料里已经写明的归属」——它不进 sourceSystems，也不参与裁剪；
      // 但不说清会让人以为这些对象的来源还没人看过，或反过来以为已经定了。
      ...(candidateAttribution.length ? [`${candidateAttribution.length} 个对象的来源归属由材料原文推断（${candidateAttribution.map((item) => `${item.objectId}→${item.system}`).join('、')}），属**候选**：未写入来源系统、未参与范围裁剪，需人工确认后才成为事实。`] : []),
      ...(scopeExclusions.candidateScopeObjects.outOfScope.length ? [`另有 ${scopeExclusions.candidateScopeObjects.outOfScope.length} 个对象的推断归属不在本次所选范围内（${scopeExclusions.candidateScopeObjects.outOfScope.map((item) => `${item.objectId}→${item.system}`).join('、')}）；因归属未经确认，未据此排除这些对象，请确认归属或补选系统。`] : []),
      ...(schemaDiscovery?.attribution?.ambiguous?.length ? [`${schemaDiscovery.attribution.ambiguous.length} 个对象的归属原文同时提到多个系统（${schemaDiscovery.attribution.ambiguous.map((item) => `${item.objectId}：${item.systems.join('/')}`).join('、')}），未自动择一。`] : []),
      // 阶段 4c 第三段：并集是**默认动作**，不是结论。不说清会让人以为「这个对象有 7 个字段」
      // 是某处声明的原文，而实际上它是两处声明的并集——且并集还会参与标识识别。
      ...(identityLinking?.summary.mergedUnruledObjects ? [`${identityLinking.summary.mergedUnruledObjects} 个对象的字段来自多处声明的**并集**（尚未裁定「合并 / 区分粒度」），其标识也是在这份并集上识别的；目录条目已逐处列出声明出处与各处独有字段。`] : []),
      ...(identityLinking?.declarationReport?.unresolvedItems?.length ? [`同名声明不一致 ${identityLinking.summary.declarationDivergences} 项，其中 ${identityLinking.declarationReport.unresolvedItems.length} 项未裁定（${identityLinking.declarationReport.unresolvedItems.join('、')}）：未裁定即沿用字段并集。`] : []),
      ...(schemaDiscovery?.warnings?.length ? ['结构化材料仍有待复核项，Schema Critic 失败前不能采纳。'] : [])
    ]
  };
  if (prepareOnly) return { proposal, publicProposal: publicProposal(proposal), entry: { name: 'proposal', namespace: PROPOSAL_NAMESPACE, key: proposalKey(id), initialValue: null } };
  return mapMaybe(writeSemanticState(PROPOSAL_NAMESPACE, proposalKey(id), proposal), () => publicProposal(proposal));
  }));
}

/**
 * 归一化「标识对应确认集合」（阶段 4b）。
 *
 * **省略 ≠ 清空**：省略表示「本次不调整确认」（保持既有），空数组才是「撤销全部」。
 * 两者混为一谈会让任何一次普通字段修订都顺手撤销此前的人工确认——
 * 这与 ADR-012 里「空选择 ≠ 未指定」是同一类区分，必须显式表达。
 * 未重新提交的历史确认标 `explicit: false`，其失效只上报、不阻断修订（否则历史确认会锁死字段演进）。
 */
const MAX_IDENTITY_LINK_CONFIRMATIONS = 40;
/**
 * 只取已知字段的浅拷贝：`keyMapping` 是**结构化定义**，多带字段没有意义，
 * 而且会绕过下游的白名单纪律（与 `sanitizeProposalDraft` 的教训同源）。
 */
const pickKeyMapping = (value) => (value && typeof value === 'object' && !Array.isArray(value)
  ? {
    fromField: value.fromField, toField: value.toField, basis: value.basis,
    lookupSource: value.lookupSource, owner: value.owner, version: value.version
  }
  : null);
const resolveIdentityLinkConfirmations = ({ proposal, requested }) => {
  if (requested === undefined || requested === null) {
    return {
      entries: (proposal.identityLinkConfirmations || []).map((item) => ({
        key: item.key, evidence: item.evidence || '',
        ...(item.shape ? { shape: item.shape } : {}),
        ...(item.keyMapping ? { keyMapping: item.keyMapping } : {}),
        explicit: false
      }))
    };
  }
  if (!Array.isArray(requested)) return { error: '标识对应确认必须是数组；空数组表示撤销全部已确认的对应。', code: 'SEMANTIC_IDENTITY_CONFIRMATION_INVALID' };
  if (requested.length > MAX_IDENTITY_LINK_CONFIRMATIONS) return { error: `单次确认的标识对应不能超过 ${MAX_IDENTITY_LINK_CONFIRMATIONS} 条。`, code: 'SEMANTIC_IDENTITY_CONFIRMATION_INVALID' };
  const entries = [];
  for (const item of requested) {
    const key = cleanText(typeof item === 'string' ? item : item?.key, 200);
    if (!key) return { error: '每条标识对应确认都必须给出 key。', code: 'SEMANTIC_IDENTITY_CONFIRMATION_INVALID' };
    // 阶段 4d：确认项现在可能带两样额外输入——形状判定（形状未判定时必填）与结构化映射定义
    // （形状已知且不同时必填）。语义与合法性校验都在 `buildConfirmedRelationships` 里做，
    // 因为只有那里同时握有链接事实（两端字段名、形状、状态）。
    const shape = cleanText(typeof item === 'string' ? '' : item?.shape, 16).toLowerCase();
    const keyMapping = typeof item === 'string' ? null : pickKeyMapping(item?.keyMapping);
    entries.push({
      key, evidence: cleanText(typeof item === 'string' ? '' : item?.evidence, 80),
      ...(shape ? { shape } : {}), ...(keyMapping ? { keyMapping } : {}), explicit: true
    });
  }
  return { entries };
};

const MAX_SOURCE_ASSIGNMENTS = 60;

/**
 * 「归属确认集合」的全量语义（阶段 4c 第二段 / ADR-017 决策 5，与标识确认、等价裁定同构）：
 * 省略＝不调整、空数组＝撤销全部、显式项＝`{ objectId, system, evidence }`。
 *
 * 与那两者不同的是：**归属是事实**——它写进 `sourceSystems`，而来源决定范围裁剪。
 * 所以它比候选与裁定都「重」：依据不得为空（「人点了一下」不是依据），
 * 目标系统必须已在系统注册表里（否则 Critic 的受控来源检查会失败，等于写进一个不可用的来源），
 * 而且应用之后必须**重新按范围过滤**——这一步在下面单独做。
 */
function resolveSourceAssignments({ objectTypes = [], requested, inherited = [] }) {
  const available = new Set((objectTypes || []).map((item) => item.id));
  const carried = (inherited || []).map((item) => ({ objectId: item.objectId, system: item.system, evidence: item.evidence || '' }));
  if (requested === undefined || requested === null) return { entries: carried.map((item) => ({ ...item, explicit: false })), unknown: [] };
  if (!Array.isArray(requested)) return { error: '归属确认必须是数组；省略表示不调整，空数组表示撤销全部。', code: 'SEMANTIC_SOURCE_ASSIGNMENT_INVALID' };
  if (requested.length > MAX_SOURCE_ASSIGNMENTS) return { error: `单次确认的归属不能超过 ${MAX_SOURCE_ASSIGNMENTS} 个对象。`, code: 'SEMANTIC_SOURCE_ASSIGNMENT_INVALID' };
  const entries = [];
  const unknown = [];
  const seen = new Set();
  for (const item of requested) {
    const objectId = cleanIdentifier(typeof item === 'string' ? item : item?.objectId, 48);
    if (!objectId) return { error: '每条归属确认都必须给出对象编码。', code: 'SEMANTIC_SOURCE_ASSIGNMENT_INVALID' };
    if (seen.has(objectId)) return { error: `归属确认里对象 ${objectId} 被重复提交。`, code: 'SEMANTIC_SOURCE_ASSIGNMENT_INVALID' };
    seen.add(objectId);
    if (!available.has(objectId)) { unknown.push({ objectId, explicit: true }); continue; }
    const system = cleanIdentifier(typeof item === 'string' ? '' : item?.system, 16).toUpperCase();
    if (!system) return { error: `对象 ${objectId} 的归属确认缺少目标系统。`, code: 'SEMANTIC_SOURCE_ASSIGNMENT_INVALID' };
    if (!isRegisteredSystemCode(system)) return { error: `系统编码不在系统注册表中，无法作为归属：${system}。请从系统接入清单中选择。`, code: 'SEMANTIC_SOURCE_ASSIGNMENT_UNKNOWN_SYSTEM' };
    const evidence = cleanText(typeof item === 'string' ? '' : item?.evidence, 240);
    if (!evidence) return { error: `对象 ${objectId} 的归属确认缺少依据：归属会写入来源系统并参与范围裁剪，必须留下依据（材料原文或人工说明）。`, code: 'SEMANTIC_SOURCE_ASSIGNMENT_EVIDENCE_REQUIRED' };
    entries.push({ objectId, system, evidence, explicit: true });
  }
  return { entries, unknown };
}

/**
 * 应用归属确认：确认过的对象写进 `sourceSystems`，撤销的**回退到创建时的来源**。
 *
 * 三处刻意的设计：
 * - **撤销是回退而不是清空**：提案里可能有本就已确认来源的对象（结构化字典路径抽出的），
 *   把它们清成 `UNASSIGNED` 等于顺手篡改一个不是本次提交的事实。
 * - **撤销必须能把被裁掉的对象找回来**：确认到范围外的对象会被范围过滤器移出草稿，
 *   若不从原稿恢复，「撤销」就成了单向操作——对象一旦被裁就再也回不来。
 *   只恢复**此前被人确认过归属**的对象，不会把用户手动删除的对象悄悄加回来。
 *   关系同理，且只在端点都回来时才恢复。
 * - **候选在确认那一刻清空**：不清的话界面上会同时出现「候选 ERP」与「已确认 WMS」，
 *   改判时尤其误导。材料原本推断的是什么仍留在 `schemaDiscovery` 上，信息不丢；
 *   撤销时再从原稿恢复候选，回到「材料推断过、但没人确认」的状态。
 */
function applySourceAssignmentsToDraft({ draft, originalDraft, previous = [], entries = [] }) {
  const originalById = new Map((originalDraft?.objectTypes || []).map((item) => [item.id, item]));
  const previouslyAssigned = new Set((previous || []).map((item) => item.objectId));
  const target = new Map(entries.map((item) => [item.objectId, item.system]));
  let changed = 0;
  const present = new Set(draft.objectTypes.map((item) => item.id));
  const restored = [];
  for (const objectId of previouslyAssigned) {
    if (present.has(objectId) || target.has(objectId)) continue;
    const original = originalById.get(objectId);
    if (!original) continue;
    restored.push(structuredClone(original));
    present.add(objectId);
    changed += 1;
  }
  if (restored.length) {
    // 恢复不是「追加到末尾」：撤销后应当看起来跟确认之前一样，顺序也是——否则每次撤销
    // 都会让对象表重排一次，Diff 里全是「位置变了」的噪声。
    const order = new Map((originalDraft?.objectTypes || []).map((item, index) => [item.id, index]));
    draft.objectTypes = [...draft.objectTypes, ...restored].sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  }
  const presentRelationships = new Set(draft.relationshipTypes.map((item) => `${item.from}:${item.predicate}:${item.to}`));
  for (const relationship of originalDraft?.relationshipTypes || []) {
    const signature = `${relationship.from}:${relationship.predicate}:${relationship.to}`;
    if (presentRelationships.has(signature)) continue;
    if (!present.has(relationship.from) || !present.has(relationship.to)) continue;
    if (!previouslyAssigned.has(relationship.from) && !previouslyAssigned.has(relationship.to)) continue;
    draft.relationshipTypes.push(structuredClone(relationship));
    presentRelationships.add(signature);
  }
  for (const object of draft.objectTypes) {
    const original = originalById.get(object.id);
    if (target.has(object.id)) {
      const system = target.get(object.id);
      if ((object.sourceSystems || []).join('/') !== system) changed += 1;
      object.sourceSystems = [system];
      object.candidateSourceSystems = [];
      object.candidateSourceEvidence = null;
      object.candidateSourceBasis = null;
      continue;
    }
    if (previouslyAssigned.has(object.id)) {
      object.sourceSystems = [...(original?.sourceSystems || ['UNASSIGNED'])];
      object.candidateSourceSystems = [...(original?.candidateSourceSystems || [])];
      object.candidateSourceEvidence = original?.candidateSourceEvidence ?? null;
      object.candidateSourceBasis = original?.candidateSourceBasis ?? null;
      changed += 1;
    }
  }
  return changed;
}

export function updateSemanticOperationsProposal({ proposalId, revision, objectTypes, relationshipTypes, primaryKeyCorrections, identityLinkConfirmations, identityConflictRulings, declarationRulings, sourceAssignments, role, identityScope }) {
  assertSemanticTenant(identityScope);
  return mapMaybe(readSemanticGovernanceState(PROPOSAL_NAMESPACE, proposalKey(proposalId)), (proposal) => {
  if (!proposal || !semanticOperationsOwnerMatches(proposal.owner, identityScope)) return { error: '未找到可修订的语义建模提案，或该提案不属于当前身份。', code: 'SEMANTIC_PROPOSAL_NOT_FOUND' };
  if (proposal.status !== 'pending_review') return { error: '只有等待评审的语义提案可以修订。', code: 'SEMANTIC_PROPOSAL_NOT_PENDING' };
  const currentRevision = proposal.revision || 1;
  if (Number(revision) !== currentRevision) return { error: '提案已在其他窗口更新，请刷新后基于最新版本继续修改。', code: 'SEMANTIC_PROPOSAL_REVISION_CONFLICT', proposal: publicProposal(proposal) };
  const requests = resolveIdentityLinkConfirmations({ proposal, requested: identityLinkConfirmations });
  if (requests.error) return requests;
  // 并入的关系由服务端**从确认集合重建**，所以先把客户端传来的同源关系剔除：
  // 确认与撤销于是都是幂等的全量语义，界面也不需要能直接编辑这类边——
  // 它对人的入口只有「确认这条对应」一个，避免同一条边出现两种互相矛盾的表达方式。
  const submitted = Array.isArray(relationshipTypes) ? relationshipTypes : proposal.draft.relationshipTypes;
  const normalized = sanitizeProposalDraft({ objectTypes, relationshipTypes: submitted.filter((item) => !item?.derivedFrom) }, proposal.draft);
  if (normalized.error) return { error: normalized.error, code: 'SEMANTIC_PROPOSAL_INVALID' };
  // 阶段 4c 第二段：归属确认**必须先于标识重算**——归属决定对象进哪个系统的字段目录，
  // 目录变了，跨系统对应与冲突全都跟着变。顺序错了会把基于旧归属的对应写回提案。
  const assignment = resolveSourceAssignments({ objectTypes: normalized.draft.objectTypes, requested: sourceAssignments, inherited: proposal.sourceAssignments || [] });
  if (assignment.error) return assignment;
  const staleAssignments = assignment.unknown.filter((item) => item.explicit);
  if (staleAssignments.length) return {
    error: `归属确认指向的对象已不在提案中（${staleAssignments.map((item) => item.objectId).join('、')}）：对象可能已被移除或改名。未把旧结论写入来源系统，请刷新后重新确认。`,
    code: 'SEMANTIC_SOURCE_ASSIGNMENT_STALE'
  };
  const assignmentChanged = applySourceAssignmentsToDraft({ draft: normalized.draft, originalDraft: proposal.originalDraft, previous: proposal.sourceAssignments, entries: assignment.entries });
  // 归属一旦成为事实，就有资格决定对象去留——这是「候选不参与裁剪」配对的另一半。
  // 只在真的有变化、且本次确实带范围时重跑，避免无谓地重算范围结论。
  const scope = proposal.scopeExclusions?.appliedTo;
  const rescope = Array.isArray(scope) && assignmentChanged ? applyScopeFilterToObjects(normalized.draft.objectTypes, scope) : null;
  if (rescope) {
    if (!rescope.objectTypes.length) return {
      error: `确认的归属让全部候选对象都落到本次所选范围之外（${rescope.excludedObjects.map((item) => `${item.objectId}（${item.sourceSystems.join('/')}）`).join('、')}）。未保存本次归属确认——请改为确认正确归属，或补选对应系统后重新生成提案。`,
      code: 'SEMANTIC_PROPOSAL_SCOPE_EXCLUDED_ALL'
    };
    normalized.draft.objectTypes = rescope.objectTypes;
    const keptIds = new Set(rescope.objectTypes.map((item) => item.id));
    const excludedIds = new Set(rescope.excludedObjects.map((item) => item.objectId));
    const repartitioned = partitionRelationshipsByScope(normalized.draft.relationshipTypes, keptIds, excludedIds);
    normalized.draft.relationshipTypes = repartitioned.relationshipTypes;
    rescope.excludedRelationships = repartitioned.excludedRelationships;
  }
  // 标识对应是从对象字段推出来的，字段一旦被修订就会过期——必须**先重算再重建并入关系**，
  // 否则会把一份与当前草稿不符的旧结论写回关系表。
  //
  // 阶段 4c：等价裁定必须先于确认解析。裁定决定**哪些链接存在**，而确认是按键指向链接的；
  // 顺序反了就会出现「确认了一条已被裁定判为不成立的边」。裁定本身也由服务端从裁定集合重建，
  // 与确认同构（省略＝不调整、空数组＝撤销全部）。
  let rulingEntries = [];
  let declarationEntries = [];
  let linking = null;
  // 阶段 4d：确认的失败面从一类（缺映射依据）扩为三类——缺形状判定 / 形状判定不适用 / 结构化映射定义不完整。
  // 每一类的**动作**都不同（判形状 / 刷新 / 补定义），所以不能共用一个错误码。
  let confirmed = { relationships: [], accepted: [], unknown: [], droppedStale: [], invalidMapping: [], missingShape: [], invalidShapes: [], outOfScope: [], shapeResolutions: [], skippedExisting: [] };
  if (proposal.identityLinking?.systems?.length) {
    const systems = proposal.identityLinking.systems;
    // 先用**不带裁定**的基线校验请求里的概念：裁定的合法性只能由当前声明事实判定，
    // 不能拿「裁定自己的结果」来判自己（否则一条错误裁定会让它的校验依据一起消失）。
    const baseline = deriveIdentityLinking({ objects: normalized.draft.objectTypes, systems });
    const rulings = resolveIdentityConflictRulings({ conflicts: baseline.conflicts, inherited: proposal.identityConflictRulings || [], requested: identityConflictRulings });
    if (rulings.error) return rulings;
    const staleConcepts = rulings.unknown.filter((item) => !item.explicit);
    // 显式重新提交却找不到对应冲突 → 硬错误：界面拿的是一份过期结论。
    const unknownExplicit = rulings.unknown.filter((item) => item.explicit);
    if (unknownExplicit.length) return {
      error: `标识等价裁定已不适用（${unknownExplicit.map((item) => item.concept).join('、')}）：当前声明里这些概念不再由多个字段名表达，没有可裁定的等价分歧。未按旧结论裁定，请刷新后重新裁定。`,
      code: 'SEMANTIC_IDENTITY_RULING_UNKNOWN_CONFLICT'
    };
    rulingEntries = rulings.entries;
    // 阶段 4c 第三段（ADR-018）：同名声明裁定决定**字段目录的组成**（并集还是拆分），
    // 与等价裁定一样先解析、再重算。它的校验依据是**基线目录里的既有对象名**
    // （组名撞名就是「把两个不同对象合成一个名字」，必须挡住）。
    const catalogNames = new Map(baseline.fieldCatalog.map((entry) => [entry.code, new Set(entry.objects.map((object) => object.objectId))]));
    const declaration = resolveDeclarationRulings({
      items: baseline.conflicts.filter((item) => item.kind === 'declaration_divergence'),
      inherited: proposal.declarationRulings || [], requested: declarationRulings, catalogNames
    });
    if (declaration.error) return declaration;
    const staleDeclarations = declaration.unknown.filter((item) => !item.explicit);
    const unknownDeclarationExplicit = declaration.unknown.filter((item) => item.explicit);
    if (unknownDeclarationExplicit.length) return {
      error: `同名声明裁定已不适用（${unknownDeclarationExplicit.map((item) => item.key).join('、')}）：当前声明里这些对象不再存在字段集不一致的分歧。未按旧结论裁定，请刷新后重新裁定。`,
      code: 'SEMANTIC_DECLARATION_RULING_UNKNOWN_CONFLICT'
    };
    declarationEntries = declaration.entries;
    linking = deriveIdentityLinking({ objects: normalized.draft.objectTypes, systems, rulings: rulingEntries, declarationRulings: declarationEntries });
    // 被裁定撤下的链接若此前已被确认，确认随之失效——但原因必须与「字段修订」区分开，
    // 两者要运营做的事完全不同（前者去看裁定，后者去看字段）。
    const staleReasons = new Map(linking.withdrawnLinks.map((item) => [item.key, item.reason]));
    // 拆分 / 改名会让对象名变化，基于旧名的链接 key 随之不存在；这类失效同样要能解释得清
    // （「上一版还能确认，这一版没了」不能靠猜）。与基线逐 key 对比，且不覆盖更具体的原因。
    const droppedLinks = [];
    const liveKeys = new Set(linking.links.map((item) => item.key));
    for (const link of baseline.links) {
      if (liveKeys.has(link.key)) continue;
      const reason = staleReasons.has(link.key)
        ? staleReasons.get(link.key)
        : '该对应在当前裁定下的声明事实里已不再成立（同名声明被裁定区分粒度后，对象名或字段集改变）。';
      if (!staleReasons.has(link.key)) {
        staleReasons.set(link.key, reason);
        droppedLinks.push({ key: link.key, evidence: link.evidence, reason });
      }
    }
    confirmed = buildConfirmedRelationships({ links: linking.links, confirmations: requests.entries, declaredRelationships: normalized.draft.relationshipTypes, staleReasons });
    linking.rulingReport.droppedStale = staleConcepts.map((item) => ({ concept: item.concept, reason: '当前声明里该概念不再由多个字段名表达，裁定已失去对应冲突。' }));
    linking.declarationReport.droppedStale = staleDeclarations.map((item) => ({ key: item.key, reason: '当前声明里该对象不再存在字段集不一致的分歧，裁定已失去对应冲突。' }));
    linking.declarationReport.droppedLinks = droppedLinks;
  }
  // 显式重新提交却查不到的 key 是硬错误：那说明界面拿的是一份过期结论，按旧结论并入等于写入不存在的对应。
  if (confirmed.unknown.length) return { error: `确认的标识对应已不存在：${confirmed.unknown.map((item) => `${item.key}（${item.reason}）`).join('、')}未按旧结论并入，请刷新后重新确认。`, code: 'SEMANTIC_IDENTITY_CONFIRMATION_STALE' };
  // 阶段 4e（ADR-020）：端点对象不在本次候选内的对应**写不进草稿**，必须给专用错误码说清是哪个对象——
  // 交给通用草案校验只会报「关系的起点、终点和谓词必须完整」，而三者俱全，原因与事实对不上。
  if (confirmed.outOfScope.length) return {
    error: `以下标识对应本次不可并入：${confirmed.outOfScope.map((item) => item.reason).join(' ')}`,
    code: 'SEMANTIC_IDENTITY_CONFIRMATION_ENDPOINT_OUT_OF_SCOPE'
  };
  // 形状未判定的对应**不能**先确认再说：不判形状就无法知道它能不能按值对齐，
  // 让它进草稿等于把「不知道」记成一条可用连接（阶段 4d / ADR-019 决策 2）。
  if (confirmed.missingShape.length) return {
    error: `以下标识对应有一端键形状未判定，必须先判定形状（代理键 / 业务键）再确认：${confirmed.missingShape.map((item) => item.reason).join(' ')}`,
    code: 'SEMANTIC_IDENTITY_CONFIRMATION_SHAPE_REQUIRED'
  };
  if (confirmed.invalidShapes.length) return {
    error: confirmed.invalidShapes.map((item) => item.reason).join(' '),
    code: confirmed.invalidShapes[0].code || 'SEMANTIC_IDENTITY_CONFIRMATION_SHAPE_NOT_APPLICABLE'
  };
  // 两端形状都已知且不同 → 必须给**结构化映射定义**；只有自由文本不再被接受（这正是本 ADR 要消除的
  //「前提只活在一段中文里」）。契约破坏性变更：取代 `SEMANTIC_IDENTITY_CONFIRMATION_REQUIRES_MAPPING_EVIDENCE`。
  if (confirmed.invalidMapping.length) return {
    error: `标识映射定义不完整：${confirmed.invalidMapping.map((item) => item.reason).join(' ')}`,
    code: 'SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID'
  };
  const merged = confirmed.relationships.length
    ? sanitizeProposalDraft({ objectTypes: normalized.draft.objectTypes, relationshipTypes: [...normalized.draft.relationshipTypes, ...confirmed.relationships] }, proposal.draft)
    : normalized;
  if (merged.error) return { error: merged.error, code: 'SEMANTIC_PROPOSAL_INVALID' };
  const correctionResult = preparePrimaryKeyCorrections({ discovery: proposal.schemaDiscovery, draft: merged.draft,
    previous: proposal.primaryKeyCorrections, requested: primaryKeyCorrections, actor: identityScope?.subjectId, roleId: role.id, revision: currentRevision + 1, time: now() });
  if (correctionResult.error) return { error: correctionResult.error, code: 'SEMANTIC_PRIMARY_KEY_CORRECTION_INVALID' };
  return mapMaybe(getOAMetaModelDraft(), (base) => mapMaybe(validateProposalSamples(merged.draft, { sampleRefs: proposal.sampleRefs, roleId: role.id, identityScope, requireEvidence: Boolean(proposal.schemaDiscovery?.schemas?.length) }), (mappingValidation) => {
  proposal.originalDraft ||= clone(proposal.draft);
  proposal.draft = merged.draft;
  proposal.revision = currentRevision + 1;
  proposal.updatedAt = now();
  proposal.updatedBy = role.id;
  proposal.primaryKeyCorrections = correctionResult.corrections;
  // 归属确认同样是**服务端从集合重建**的人工结论：它改的是 `sourceSystems`（事实），
  // 因此要连同「这次确认了哪些、依据是什么」一起留档——否则下一次修订时无从判断
  // 某个对象的来源是人写的还是抽出来的。
  proposal.sourceAssignments = assignment.entries.map((item) => ({ objectId: item.objectId, system: item.system, evidence: item.evidence }));
  if (rescope) proposal.scopeExclusions = {
    ...proposal.scopeExclusions,
    excludedObjects: rescope.excludedObjects, excludedRelationships: rescope.excludedRelationships,
    partialScopeObjects: rescope.partialScopeObjects, unassignedObjects: rescope.unassignedObjects,
    candidateScopeObjects: rescope.candidateScopeObjects
  };
  // 重算结果与确认集合都是审阅依据，必须留在提案上：「这次确认了什么、哪条没并进去、为什么」要可追溯。
  if (linking) proposal.identityLinking = linking;
  // 阶段 4c：裁定集合也由服务端从请求重建，并连同重算报告一起留档——
  // 「哪些概念已裁定、哪些链接因裁定消失」是下一版界面的判断依据，不能只活在客户端状态里。
  proposal.identityConflictRulings = rulingEntries.map((item) => ({ concept: item.concept, ruling: item.ruling, groups: item.groups || null }));
  // 阶段 4c 第三段：同名声明裁定同理。它改的是**字段目录的组成**（并集还是拆分），
  // 于是「哪些声明被拆开、哪些被排除」必须留档，否则下一次修订无从重建目录。
  proposal.declarationRulings = declarationEntries.map((item) => ({ key: item.key, ruling: item.ruling, groups: item.groups || null }));
  proposal.identityLinkConfirmations = confirmed.accepted;
  proposal.identityLinkConfirmationReport = {
    merged: confirmed.relationships.length,
    skippedExisting: confirmed.skippedExisting,
    droppedStale: confirmed.droppedStale,
    // 形状判定是**这次修订产生的新结论**（判定前那条边连能不能对齐都不知道），
    // 必须与并入数一样留档：否则下一版界面无从知道「这个裸名的形状是人判的，还是本就没判」。
    shapeResolutions: confirmed.shapeResolutions
  };
  proposal.critic = critiqueProposalDraft(proposal.draft, base, proposal.schemaDiscovery, proposal.primaryKeyCorrections, proposal.sourceAssignments);
  proposal.diff = buildDiff(base, proposal.draft, proposal.adoptionMode);
  proposal.editDiff = buildEditDiff(proposal.originalDraft, proposal.draft);
  proposal.impactAnalysis = buildImpactAnalysis(proposal.originalDraft, proposal.draft, proposal.editDiff);
  proposal.mappingValidation = mappingValidation;
  proposal.revisions ||= [];
  proposal.revisions.unshift({ revision: proposal.revision, time: proposal.updatedAt, actor: role.id, criticStatus: proposal.critic.status, summary: proposal.editDiff.summary, primaryKeyCorrections: clone(proposal.primaryKeyCorrections),
    sourceAssignments: clone(proposal.sourceAssignments),
    identityConflictRulings: clone(proposal.identityConflictRulings), declarationRulings: clone(proposal.declarationRulings), identityLinkConfirmations: clone(confirmed.accepted), identityLinkConfirmationReport: clone(proposal.identityLinkConfirmationReport) });
  proposal.revisions = proposal.revisions.slice(0, 20);
  return mutateSemanticGovernanceState(PROPOSAL_NAMESPACE, proposalKey(proposalId), null, current => {
    if (!current || !semanticOperationsOwnerMatches(current.owner, identityScope)) return { commit: false, result: { error: '提案不属于当前身份。', code: 'SEMANTIC_PROPOSAL_NOT_FOUND' } };
    if (current.status !== 'pending_review' || (current.revision || 1) !== currentRevision) return { commit: false, result: { error: '提案已更新，请重新读取后审阅。', code: 'SEMANTIC_PROPOSAL_REVISION_CONFLICT' } };
    return { value: proposal, result: publicProposal(proposal) };
  });
  }));
  });
}

export async function createSemanticOperationsProposalFromRequest({ body, role, identityScope, scannedMaterial = null, sourceMaterialIncomplete = false, workspaceDocuments = null, scopeSystems = null }) {
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
  // 阶段 4f：自然语言抽取被跳过时的原因。`null` 表示「没跳过」，与「跳过但没说」是两种状态，
  // 后者正是本阶段要消除的——静默跳过会让「为什么没有候选对象」变成谜。
  let naturalSchemaSkip = null;
  // 阶段 4h：受控对象链接的结果。`null` 表示本轮没有进入链接环节
  // （结构化材料或自然语言抽取已产出对象）——与「链接跑了但没产出」是两种状态。
  let mentionLinking = null;
  if (!schemaDiscovery.objectTypes.length) {
    const naturalMaterial = `${String(body?.sourceMaterial || input)}\n${(workspaceDocuments || content.documents || []).map(document => document.text).join('\n') || content.modelContext || ''}`;
    if (naturalMaterial.length > 20000) return { error: '非结构化材料超过单次可核对范围，请拆分业务范围或提供结构化字典；完整材料已保留，不从截断摘录猜测模型。', code: 'SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS', status: 422 };
    const natural = await discoverNaturalSchema(naturalMaterial);
    if (natural?.error) return { ...natural, code: 'SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS', status: 422 };
    // 阶段 4f：「跳过抽取」与「抽取后无产出」必须分开带出去——两者此前都只表现为
    // 「候选对象里没有它」，审阅人无法判断该改材料还是该换 provider。
    naturalSchemaSkip = natural?.skipped ? natural : null;
    if (natural && !natural.skipped) schemaDiscovery = natural;
    else {
      // 阶段 4h（ADR-025）：抽取跳过（模拟运行时 / 材料无字典线索）后，受控对象链接
      // 仍有机会把材料里**逐字提及**的已登记对象带进候选——这是「写四个对象只得 1 类」
      // 根因的处置点。mock 下链接同样跳过并带原因，行为与 4g 之前完全一致。
      mentionLinking = await discoverObjectMentionLinks({ material: naturalMaterial, systems: scopeSystems });
      if (mentionLinking?.error) return { ...mentionLinking, code: 'SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS', status: 422 };
    }
  }
  const requirements = [...(workspaceDocuments || content.documents || []).filter(document => document.kind === 'request' || !/json|csv|yaml/.test(document.mimeType)).map(document => document.text), body.sourceMaterial || input].join('\n');
  const sampleDocuments = (workspaceDocuments || content.documents || []).filter(document => {
    if (document.mimeType !== 'application/json') return false;
    try { return Array.isArray(JSON.parse(document.text).records); } catch { return false; }
  });
  const sampleWorkspace = await extendSemanticMaterials({ content: { documents: sampleDocuments }, roleId: role.id, identityScope });
  if (sampleWorkspace.error) return sampleWorkspace;
  return createSemanticOperationsProposal({ input, multimodalContent: content, attachments: multimodal.attachments, schemaDiscovery, naturalSchemaSkip, mentionLinking, identityScope, requirements, sampleRefs: sampleWorkspace.refs, roleId: role.id, adoptionMode: body.adoptionMode || 'merge', scopeSystems });
}

export function listSemanticOperationsSnapshots({ identityScope }) {
  assertSemanticTenant(identityScope);
  return mapMaybe(readSemanticGovernanceState(SNAPSHOT_NAMESPACE, 'index', {}), (index) => mapMaybe(getOAMetaModelDraft(), (draft) => {
    const currentFingerprint = semanticFingerprint(draft);
    return Object.values(index).filter((snapshot) => semanticOperationsOwnerMatches(snapshot.owner, identityScope))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((snapshot) => publicSnapshot(snapshot, currentFingerprint));
  }));
}

export function saveSemanticOperationsDraft({ input, role, identityScope }) {
  assertSemanticTenant(identityScope);
  return mutateSemanticGovernanceStates([
    getOAMetaModelRuntimeTransactionEntry(),
    { name: 'snapshots', namespace: SNAPSHOT_NAMESPACE, key: 'index', initialValue: {} }
  ], ({ oaRuntime, snapshots }) => {
    const before = getOAMetaModelDraftFromRuntime(oaRuntime);
    const change = buildOAMetaModelDraftRuntimeChange(oaRuntime, input, role, { action: '手动保存语义模型草稿' });
    if (change.error) return { commit: false, result: change };
    const after = change.result.draft;
    const beforeFingerprint = semanticFingerprint(before);
    const afterFingerprint = semanticFingerprint(after);
    let savedSnapshot = null;
    if (beforeFingerprint !== afterFingerprint) {
      const createdAt = now();
      const owner = semanticOperationsPrincipalKey(identityScope);
      const id = `semantic-snapshot-${createHash('sha256').update(JSON.stringify([owner, beforeFingerprint, afterFingerprint, createdAt, Math.random()])).digest('hex').slice(0, 16)}`;
      savedSnapshot = {
        id, owner, sourceType: 'manual_save', proposalId: null, createdAt, status: 'active',
        createdBySubjectId: identityScope.subjectId || null, createdByRoleId: role.id,
        before: clone(before), after: clone(after), afterFingerprint, diff: buildDiff(before, after, 'replace')
      };
      snapshots[id] = savedSnapshot;
    }
    return {
      values: { oaRuntime: change.runtime, snapshots },
      result: { ...change.result, ...(savedSnapshot ? { snapshot: publicSnapshot(savedSnapshot, afterFingerprint) } : {}) }
    };
  });
}

export function applySemanticOperationsProposal({ proposalId, role, identityScope, accessContext }) {
  assertSemanticTenant(identityScope);
  return mapMaybe(readSemanticGovernanceState(PROPOSAL_NAMESPACE, proposalKey(proposalId)), (proposal) => {
  if (!proposal || !canAccessProposal(proposal, identityScope, accessContext)) return { error: '未找到当前身份可审核的语义建模草稿。', code: 'SEMANTIC_PROPOSAL_NOT_FOUND' };
  if (proposal.status !== 'pending_review') return { error: '该语义建模草稿已被采纳或已失效。', code: 'SEMANTIC_PROPOSAL_NOT_PENDING' };
  proposal.draft.objectTypes = proposal.draft.objectTypes.map((item) => ({ ...item, ...normalizeFieldDefinitions(item) }));
  return mapMaybe(getOAMetaModelDraft(), (base) => mapMaybe(validateProposalSamples(proposal.draft, { sampleRefs: proposal.sampleRefs, roleId: role.id, identityScope, requireEvidence: Boolean(proposal.schemaDiscovery?.schemas?.length) }), (mappingValidation) => {
  proposal.critic = critiqueProposalDraft(proposal.draft, base, proposal.schemaDiscovery, proposal.primaryKeyCorrections, proposal.sourceAssignments);
  proposal.diff = buildDiff(base, proposal.draft, proposal.adoptionMode);
  proposal.editDiff = buildEditDiff(proposal.originalDraft || proposal.draft, proposal.draft);
  proposal.impactAnalysis = buildImpactAnalysis(proposal.originalDraft || proposal.draft, proposal.draft, proposal.editDiff);
  proposal.mappingValidation = mappingValidation;
  if (proposal.critic.status !== 'passed') {
    return persistProposalReviewFailure(proposal, { error: 'Schema Critic 未通过，修复失败项后才能采纳草稿。', code: 'SEMANTIC_PROPOSAL_CRITIC_FAILED', proposal: publicProposal(proposal) });
  }
  if (proposal.mappingValidation.blocked) {
    return persistProposalReviewFailure(proposal, { error: 'Mock 样本映射演练未通过，修复必填字段、类型或主键映射后才能采纳草稿。', code: 'SEMANTIC_PROPOSAL_MAPPING_VALIDATION_FAILED', proposal: publicProposal(proposal) });
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
    { name: 'snapshots', namespace: SNAPSHOT_NAMESPACE, key: 'index', initialValue: {} },
    ...(proposal.onboardingBasis ? [{ name: 'onboardingProjects', namespace: 'mock_onboarding_v1', key: proposal.onboardingBasis.key, initialValue: {} }] : [])
  ], (values) => {
    const storedProposal = values.proposal;
    if (!storedProposal || !canAccessProposal(storedProposal, identityScope, accessContext)) return { commit: false, result: { error: '未找到当前身份可审核的语义建模草稿。', code: 'SEMANTIC_PROPOSAL_NOT_FOUND' } };
    if (storedProposal.status !== 'pending_review' || (storedProposal.revision || 1) !== (proposal.revision || 1)) return { commit: false, result: { error: '提案已被其他窗口更新或采纳，请刷新后重试。', code: 'SEMANTIC_PROPOSAL_REVISION_CONFLICT' } };
    if (storedProposal.onboardingBasis) {
      const basis = storedProposal.onboardingBasis;
      const project = values.onboardingProjects?.[basis.projectId];
      const reviewer = !semanticOperationsOwnerMatches(storedProposal.owner, identityScope);
      const sameTenantProject = ownerTenantId(project?.owner) === (identityScope?.tenantId || 'demo-enterprise');
      if (!project || !(reviewer ? sameTenantProject : semanticOperationsOwnerMatches(project.owner, identityScope) && project.roleId === role.id) || mockOnboardingBasis(project) !== basis.fingerprint) return { commit: false, result: { error: '来源接入项目已变化、租户不一致或当前角色不匹配，请重新完成验证并交接。旧提案未写入草稿。', code: 'SEMANTIC_ONBOARDING_SOURCE_STALE' } };
    }
    const transactionBase = getOAMetaModelDraftFromRuntime(values.oaRuntime);
    if (semanticFingerprint(transactionBase) !== expectedBaseFingerprint) return { commit: false, result: { error: '语义草稿已发生并发变化，请重新审阅 Diff 后采纳。', code: 'SEMANTIC_PROPOSAL_BASE_STALE' } };
    const change = buildOAMetaModelDraftRuntimeChange(values.oaRuntime, mergedInput, role, {
      action: '采纳 Agent 语义建模提案',
      detail: `提案 ${proposal.id} 已${replacing ? '替换草稿为' : '合并'} ${proposal.draft.objectTypes.length} 个对象和 ${proposal.draft.relationshipTypes.length} 条关系。`
    });
    if (change.error) return { commit: false, result: { error: change.error } };
    const snapshot = {
      id: `semantic-snapshot-${createHash('sha256').update(`${proposal.id}:${now()}`).digest('hex').slice(0, 16)}`,
      owner: semanticOperationsPrincipalKey(identityScope), sourceType: 'agent_adoption', createdBySubjectId: identityScope.subjectId || null, createdByRoleId: role.id,
      proposalId: proposal.id, createdAt: now(), status: 'active', before: clone(transactionBase), after: clone(change.result.draft), afterFingerprint: semanticFingerprint(change.result.draft), diff: proposal.diff
    };
    values.snapshots[snapshot.id] = snapshot;
    storedProposal.status = 'applied_to_draft'; storedProposal.appliedAt = now(); storedProposal.appliedBy = role.id; storedProposal.snapshotId = snapshot.id;
    return {
      values: { ...values, oaRuntime: change.runtime, proposal: storedProposal },
      result: { proposal: publicProposal(storedProposal), snapshot: publicSnapshot(snapshot, snapshot.afterFingerprint), draft: change.result.draft, message: `已${replacing ? '替换当前草稿为' : '合并到当前草稿：'} ${storedProposal.draft.objectTypes.length} 个对象和 ${storedProposal.draft.relationshipTypes.length} 条关系，并保存可回滚快照；尚未校验或登记。` }
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
    snapshot.status = 'rolled_back'; snapshot.rolledBackAt = now(); snapshot.rolledBackByRoleId = role.id; snapshot.rolledBackBySubjectId = identityScope.subjectId || null;
    values.snapshots[snapshot.id] = snapshot;
    return { values: { ...values, oaRuntime: change.runtime }, result: { snapshot: publicSnapshot(snapshot, semanticFingerprint(change.result.draft)), draft: change.result.draft, message: `已回滚到采纳“${snapshot.proposalId}”前的语义层草稿版本；未影响已发布版本。` } };
  });
}

import { mutateSemanticGovernanceState, mutateSemanticGovernanceWithEvent, readSemanticGovernanceState } from './semantic-governance-store.js';
import { semanticRecordContract } from './semantic-record-contract-service.js';
import { buildOntologyImpact, inferObjectGranularity, modelingProfiles, objectGranularities, replayOntologyDecisions, validateOntologyContract } from './ontology-contract-service.js';
import { getBusinessDecisionCatalog } from './business-decision-service.js';
import { semanticFingerprint } from './semantic-model-fingerprint.js';
import { assertSemanticTenant, currentSemanticTenant, currentSemanticModel, DEFAULT_SEMANTIC_MODEL_ID } from './semantic-tenant-context.js';
import { sanitizeKeyMapping } from '../domain-contracts/key-mapping.js';

const now = () => new Date().toISOString();

const oaMetaModel = {
  id: 'oa-governance',
  code: 'OA-META-001',
  name: 'OA 组织、权限与审批元模型',
  version: '0.1.0',
  category: '内务协同',
  recordContract: semanticRecordContract,
  target: { id: 'oa', code: 'OA / BPM', name: 'OA / BPM 审批系统', connectionMode: 'API + Webhook + 定时补偿' },
  description: '定义组织、人、角色、权限、流程、审批、任务和审计的共用语义。后续采购、生产变更、质量 CAPA 等业务只需引用该模型，而不重复定义审批链。',
  coreObjectBindings: [
    { coreObject: 'Person', usage: 'OA 是人员元对象的权威身份源，向权限、审批、任务和审计提供责任主体。' },
    { coreObject: 'RawMaterial', usage: '采购、检验和领用流程必须通过 BusinessAction 关联原材料对象。' },
    { coreObject: 'Product', usage: '研发、生产、质量和市场流程必须通过 BusinessAction 关联产品对象。' },
    { coreObject: 'Equipment', usage: '生产、维护、校准和偏差流程必须通过 BusinessAction 关联设备对象。' },
    { coreObject: 'Store', usage: '门店经营、补货、订单、履约和线下客诉流程必须通过 BusinessAction 关联权威门店对象。' }
  ],
  governance: {
    classification: '内部受限',
    owner: '流程与数字化负责人',
    steward: '账号与权限中心',
    publishApproval: '管理层 + 数据负责人',
    retention: '730 天',
    accessRule: 'RBAC + ABAC + 审批上下文'
  },
  objectTypes: [
    { id: 'Organization', label: '组织', source: 'oa.organization', key: 'org_id', fields: ['org_id', 'name', 'parent_org_id', 'status'], classification: '内部' },
    { id: 'Person', label: '人员', source: 'oa.employee', key: 'employee_id', fields: ['employee_id', 'display_name', 'org_id', 'status'], classification: '个人信息受限' },
    { id: 'Position', label: '岗位', source: 'oa.position', key: 'position_id', fields: ['position_id', 'name', 'org_id', 'grade'], classification: '内部' },
    { id: 'BusinessRole', label: '业务角色', source: 'oa.role', key: 'role_id', fields: ['role_id', 'name', 'data_domain', 'capabilities'], classification: '内部受限' },
    { id: 'ApprovalFlow', label: '审批流程', source: 'oa.process_definition', key: 'process_id', fields: ['process_id', 'name', 'business_type', 'version', 'status'], classification: '内部受限' },
    { id: 'ApprovalNode', label: '审批节点', source: 'oa.process_node', key: 'node_id', fields: ['node_id', 'process_id', 'sequence', 'assignee_rule', 'sla_minutes'], classification: '内部受限' },
    { id: 'ApprovalRequest', label: '审批实例', source: 'oa.approval_instance', key: 'instance_id', fields: ['instance_id', 'business_ref', 'applicant_id', 'status', 'submitted_at'], classification: '内部受限' },
    { id: 'WorkTask', label: '待办任务', source: 'oa.task', key: 'task_id', fields: ['task_id', 'instance_id', 'owner_id', 'due_at', 'status'], classification: '内部受限' },
    { id: 'BusinessAction', label: '业务动作', source: 'ai.business_action', key: 'action_id', fields: ['action_id', 'action_type', 'resource', 'risk_level', 'confirmation_required'], classification: '内部受限' },
    { id: 'AuditRecord', label: '审计记录', source: 'audit.event', key: 'audit_id', fields: ['audit_id', 'actor_id', 'action', 'outcome', 'occurred_at'], classification: '审计受限' }
  ],
  relationshipTypes: [
    { predicate: 'contains', from: 'Organization', to: 'Organization', label: '组织包含组织' },
    { predicate: 'employs', from: 'Organization', to: 'Person', label: '组织隶属人员' },
    { predicate: 'holds', from: 'Person', to: 'Position', label: '人员担任岗位' },
    { predicate: 'grants', from: 'BusinessRole', to: 'BusinessAction', label: '角色授予动作能力' },
    { predicate: 'defines', from: 'ApprovalFlow', to: 'ApprovalNode', label: '流程定义节点' },
    { predicate: 'governs', from: 'ApprovalFlow', to: 'BusinessAction', label: '流程约束业务动作' },
    { predicate: 'instantiates', from: 'ApprovalRequest', to: 'ApprovalFlow', label: '审批实例引用流程' },
    { predicate: 'creates', from: 'ApprovalRequest', to: 'WorkTask', label: '审批实例创建待办' },
    { predicate: 'approves', from: 'WorkTask', to: 'BusinessAction', label: '待办审批业务动作' },
    { predicate: 'records', from: 'ApprovalRequest', to: 'AuditRecord', label: '审批实例产生审计' }
  ],
  events: [
    { type: 'EmployeeChanged', source: 'oa.employee', effect: '刷新人员—组织—岗位关系' },
    { type: 'RoleGranted', source: 'oa.role_binding', effect: '刷新权限中心授权边界' },
    { type: 'ApprovalSubmitted', source: 'oa.approval_instance', effect: '创建审批实例与首个待办' },
    { type: 'ApprovalTaskOverdue', source: 'scheduler', effect: '触发升级通知与风险事件' },
    { type: 'ApprovalCompleted', source: 'oa.approval_instance', effect: '允许受控业务动作继续执行' }
  ],
  stateMachines: [
    { object: 'ApprovalRequest', initial: '草稿', states: ['草稿', '已提交', '审批中', '已通过', '已驳回', '已撤回', '已超时'], terminal: ['已通过', '已驳回', '已撤回'] },
    { object: 'WorkTask', initial: '待处理', states: ['待处理', '处理中', '已完成', '已转交', '已超时'], terminal: ['已完成', '已超时'] }
  ],
  policies: [
    '智脑发起写入类业务动作前，必须先校验用户业务角色与 BusinessAction 能力。',
    '风险等级为高或涉及资金、质量、主数据时，ApprovalRequest 必须处于“已通过”。',
    '人员手机号、邮箱等字段在非账号中心场景默认脱敏。',
    '审批实例、待办和审计记录以请求级权限裁剪，智脑不持有全域永久明文。'
  ],
  validationRules: ['每个对象必须配置稳定业务主键', '每个审批实例必须关联流程定义与业务动作', '每个审批节点必须配置办理人规则或升级策略', '每个敏感字段必须声明数据分级'],
  metrics: [{ id: 'approval_cycle_minutes', label: '审批周期', description: '审批实例从提交到终态的分钟数。', grain: 'ApprovalRequest', aggregation: 'avg', expression: 'minutes_between(submitted_at, completed_at)', unit: 'minute' }],
  glossaryTerms: [{ id: 'approval_request', term: '审批实例', definition: '一次业务审批的运行实例，与流程定义和业务动作关联。', steward: '流程与数字化负责人', objectType: 'ApprovalRequest' }],
  dataContracts: [{ id: 'oa_approval_contract', sourceSystem: 'OA', objectType: 'ApprovalRequest', schemaVersion: '1.0', freshnessMinutes: 15, availabilitySlo: 99.9, owner: '账号与权限中心' }],
  qualityRules: [{ id: 'approval_status_valid', objectType: 'ApprovalRequest', field: 'status', rule: 'not_null', severity: 'error', threshold: 1 }],
  accessPolicies: [{ id: 'approval_scope_policy', objectType: 'ApprovalRequest', effect: 'allow', roles: ['executive', 'quality_manager', 'production_manager', 'procurement_manager'], condition: 'organization_id in subject.organization_ids', maskedFields: [] }],
  lineageEdges: [{ from: 'OA.approval_instance', to: 'ApprovalRequest', transformation: 'canonical_mapping', fields: ['instance_id', 'status', 'submitted_at'] }]
};

const OA_NAMESPACE = 'oa_meta_model_runtime';
const OA_KEY = 'workspace';
const initialOARuntime = () => ({ oaSimulation: null, oaDraft: null });
const getOARuntime = () => readSemanticGovernanceState(OA_NAMESPACE, OA_KEY, initialOARuntime);
const mapMaybe = (value, callback) => value && typeof value.then === 'function' ? value.then(callback) : callback(value);

const clone = (value) => JSON.parse(JSON.stringify(value));
const hydrateFieldDefinitions = (item) => {
  const definitions = Array.isArray(item.fieldDefinitions) && item.fieldDefinitions.length
    ? item.fieldDefinitions
    : (item.fields || []).map((name) => ({ name, type: 'string', required: name === item.key, primaryKey: name === item.key, sourceField: name, mappingStatus: 'mapped', reference: null, description: null }));
  return definitions.map((field) => ({ ...field, sourceField: field.sourceField || field.name, mappingStatus: field.mappingStatus || 'mapped', primaryKey: field.name === item.key, required: Boolean(field.required || field.name === item.key) }));
};
const normalizeSemanticDraft = (draft) => ({
  ...draft,
  modelingProfile: draft.modelingProfile || 'oa-approval',
  scenario: clone(draft.scenario || { objective: '', questions: [], decisionBindings: [], actionBindings: [] }),
  objectTypes: (draft.objectTypes || []).map((item) => ({ ...item, fieldDefinitions: hydrateFieldDefinitions(item), semanticType: item.semanticType || item.id, coreObject: item.coreObject || coreBindingDefaults[item.id] || item.id, sourceSystems: item.sourceSystems?.length ? item.sourceSystems : [String(item.source || 'oa').split('.')[0].toUpperCase()], description: item.description || '' })),
  relationshipTypes: (draft.relationshipTypes || []).map((item) => ({ ...item, cardinality: item.cardinality || '1:n', evidence: item.evidence ?? '建模草稿' })),
  metrics: clone(draft.metrics || oaMetaModel.metrics),
  glossaryTerms: clone(draft.glossaryTerms || oaMetaModel.glossaryTerms),
  dataContracts: clone(draft.dataContracts || oaMetaModel.dataContracts),
  qualityRules: clone(draft.qualityRules || oaMetaModel.qualityRules),
  accessPolicies: clone(draft.accessPolicies || oaMetaModel.accessPolicies),
  lineageEdges: clone(draft.lineageEdges || oaMetaModel.lineageEdges)
});
const currentMetaModel = (runtime = getOARuntime()) => runtime.oaDraft ? {
  ...oaMetaModel,
  ...(runtime.oaDraft.modelingProfile === 'general' ? { name: runtime.oaDraft.scenario?.objective || '通用业务模型', code: 'SEMANTIC-GENERAL', target: { id: 'multi-source', code: '受控来源', name: '场景指定的数据来源' } } : {}),
  modelingProfile: runtime.oaDraft.modelingProfile || 'oa-approval',
  scenario: runtime.oaDraft.scenario,
  worldModel: runtime.oaDraft.worldModel || null,
  objectTypes: normalizeSemanticDraft(runtime.oaDraft).objectTypes,
  relationshipTypes: normalizeSemanticDraft(runtime.oaDraft).relationshipTypes,
  policies: runtime.oaDraft.policies,
  stateMachines: runtime.oaDraft.stateMachines,
  events: runtime.oaDraft.events,
  metrics: runtime.oaDraft.metrics,
  glossaryTerms: runtime.oaDraft.glossaryTerms,
  dataContracts: runtime.oaDraft.dataContracts,
  qualityRules: runtime.oaDraft.qualityRules,
  accessPolicies: runtime.oaDraft.accessPolicies,
  lineageEdges: runtime.oaDraft.lineageEdges
} : oaMetaModel;

const summary = (runtime = getOARuntime()) => {
  const model = currentMetaModel(runtime);
  return {
  ...model,
  objectCount: model.objectTypes.length,
  relationshipCount: model.relationshipTypes.length,
  eventCount: model.events.length,
  policyCount: model.policies.length,
  metricCount: model.metrics?.length || 0,
  contractCount: model.dataContracts?.length || 0,
  qualityRuleCount: model.qualityRules?.length || 0,
  status: runtime.oaSimulation?.status || 'ready_to_build',
  simulation: runtime.oaSimulation ? { id: runtime.oaSimulation.id, builtAt: runtime.oaSimulation.builtAt, builtBy: runtime.oaSimulation.builtBy, instanceCount: runtime.oaSimulation.instances.nodes.length, relationCount: runtime.oaSimulation.instances.edges.length, validation: runtime.oaSimulation.validation } : null,
  draft: runtime.oaDraft ? { id: runtime.oaDraft.id, updatedAt: runtime.oaDraft.updatedAt, updatedBy: runtime.oaDraft.updatedBy, validation: runtime.oaDraft.validation } : null
  };
};

const canConfigure = (role) => ['executive', 'quality_manager', 'production_manager', 'procurement_manager', 'marketing_manager'].includes(role?.id);
const canPublish = (role) => role?.id === 'executive';
const requiredObjectTypes = ['Organization', 'Person', 'BusinessRole', 'ApprovalFlow', 'ApprovalRequest', 'BusinessAction', 'AuditRecord'];
const coreBindingDefaults = {
  Organization: 'Person', Person: 'Person', Position: 'Person', BusinessRole: 'Person', ApprovalFlow: 'Person', ApprovalNode: 'Person', ApprovalRequest: 'Person', WorkTask: 'Person', BusinessAction: 'Person', AuditRecord: 'Person',
  PurchaseDemand: 'RawMaterial', QualityReview: 'RawMaterial', BudgetCheck: 'RawMaterial', NotificationReceipt: 'Person',
  TestResult: 'RawMaterial', QualityEvent: 'RawMaterial', ProductionBatch: 'Product', Inventory: 'RawMaterial', Fulfillment: 'Store', CAPA: 'Product'
};

const makeDraft = () => ({
  id: 'oa-draft-001',
  modelingProfile: 'oa-approval',
  scenario: { objective: '组织、权限和审批协同', questions: ['谁可以发起、审批并追溯业务动作？'], decisionBindings: [], actionBindings: [] },
  objectTypes: clone(oaMetaModel.objectTypes).map((item) => ({ ...item, semanticType: item.id, coreObject: coreBindingDefaults[item.id] || item.id, sourceSystems: [item.source.split('.')[0].toUpperCase()], description: '' })), relationshipTypes: clone(oaMetaModel.relationshipTypes).map((item) => ({ ...item, cardinality: '1:n', evidence: 'OA 元模型模板' })), policies: clone(oaMetaModel.policies),
  stateMachines: clone(oaMetaModel.stateMachines), events: clone(oaMetaModel.events), metrics: clone(oaMetaModel.metrics), glossaryTerms: clone(oaMetaModel.glossaryTerms), dataContracts: clone(oaMetaModel.dataContracts), qualityRules: clone(oaMetaModel.qualityRules), accessPolicies: clone(oaMetaModel.accessPolicies), lineageEdges: clone(oaMetaModel.lineageEdges), updatedAt: now(), updatedBy: '系统模板', validation: null,
  audit: [{ time: now(), actor: '系统模板', action: '创建业务可视化建模草稿', detail: '基于 OA 元模型模板生成可编辑草稿。' }]
});

const validateDraft = (draft) => {
  const objectIds = new Set(draft.objectTypes.map((item) => item.id));
  const checks = [
    { name: '业务对象与主键', status: draft.objectTypes.length > 0 && objectIds.size === draft.objectTypes.length && draft.objectTypes.every((item) => item.id && item.label && item.key && item.fields?.length >= 2 && item.fields.includes(item.key)) ? 'passed' : 'failed', detail: '至少一个对象，每个对象需具备名称、唯一编码及落在字段中的稳定主键；不以对象数量验收业务价值。' },
    ...(draft.modelingProfile === 'oa-approval' ? [
      { name: '必备审批语义', status: requiredObjectTypes.every((id) => objectIds.has(id)) ? 'passed' : 'failed', detail: 'OA 模板要求组织、人员、角色、审批流、审批实例、业务动作和审计记录。' },
      { name: '审批控制', status: draft.stateMachines.some((item) => item.object === 'ApprovalRequest' && item.states?.includes('已通过')) && draft.policies.length >= 3 ? 'passed' : 'failed', detail: 'OA 模板要求审批状态机和写入前策略；通用模型也不能绕过平台权限。' }
    ] : []),
    { name: '关系闭环', status: draft.relationshipTypes.every((item) => objectIds.has(item.from) && objectIds.has(item.to) && item.predicate) ? 'passed' : 'failed', detail: '所有关系必须引用已定义对象；独立单对象场景可以没有关系。' },
    { name: '平台治理声明', status: draft.policies.length > 0 ? 'passed' : 'failed', detail: '必须声明治理边界；声明不能替代服务端 IAM、审批和执行校验。' },
    ...validateOntologyContract(draft),
    { name: '数据分级', status: draft.objectTypes.every((item) => item.classification) ? 'passed' : 'failed', detail: '每个对象均已声明数据分级。' },
    { name: '语义锚点与来源', status: draft.objectTypes.every((item) => item.semanticType && item.coreObject && item.sourceSystems?.length && !item.sourceSystems.includes('待观察')) ? 'passed' : 'failed', detail: '每个对象必须声明语义类型、核心元对象锚点和已确认的受控来源系统；“待观察”模板不能发布。' },
    { name: '指标口径', status: draft.metrics?.every((item) => item.id && item.label && item.grain && objectIds.has(item.grain) && item.expression && item.aggregation) ? 'passed' : 'failed', detail: '每个指标必须定义稳定编码、业务名称、粒度对象、聚合方式和计算表达式。' },
    { name: '数据契约与质量规则', status: Boolean(draft.dataContracts?.length) && draft.dataContracts.every((item) => item.id && item.sourceSystem && objectIds.has(item.objectType) && item.schemaVersion) && Boolean(draft.qualityRules?.length) && draft.qualityRules.every((item) => item.id && objectIds.has(item.objectType) && item.rule) ? 'passed' : 'failed', detail: '来源对象必须有版本化数据契约，并配置可执行的数据质量规则。' },
    { name: '术语、访问与血缘', status: Boolean(draft.glossaryTerms?.length) && draft.glossaryTerms.every((item) => item.term && item.definition && objectIds.has(item.objectType)) && Boolean(draft.accessPolicies?.length) && draft.accessPolicies.every((item) => objectIds.has(item.objectType) && item.effect) && Boolean(draft.lineageEdges?.length) && draft.lineageEdges.every((item) => item.from && objectIds.has(item.to)) ? 'passed' : 'failed', detail: '核心业务术语、对象访问策略和来源血缘必须明确。' }
  ];
  for (const check of checks.filter(item => item.status === 'failed')) {
    const targets = [];
    for (const object of draft.objectTypes) {
      const fields = check.name === '语义锚点与来源' ? [!object.semanticType && 'semanticType', !object.coreObject && 'coreObject', (!object.sourceSystems?.length || object.sourceSystems.includes('待观察')) && 'sourceSystems']
        : check.name === '数据分级' ? [!object.classification && 'classification']
          : check.name === '业务对象与主键' ? [!object.label && 'label', !object.key && 'key', (!object.fields?.length || !object.fields.includes(object.key)) && 'fields'] : [];
      for (const field of fields.filter(Boolean)) targets.push({ kind: 'object', targetId: object.id, field });
    }
    if (check.name === '关系闭环') for (const relation of draft.relationshipTypes) {
      if (!objectIds.has(relation.from) || !objectIds.has(relation.to) || !relation.predicate) targets.push({ kind: 'relation', from: relation.from, predicate: relation.predicate, to: relation.to, field: !objectIds.has(relation.from) ? 'from' : !objectIds.has(relation.to) ? 'to' : 'predicate' });
    }
    const sections = { '指标口径': ['metrics'], '数据契约与质量规则': ['dataContracts', 'qualityRules'], '术语、访问与血缘': ['glossaryTerms', 'accessPolicies', 'lineageEdges'] };
    const validAsset = {
      metrics: item => item.id && item.label && item.grain && objectIds.has(item.grain) && item.expression && item.aggregation,
      dataContracts: item => item.id && item.sourceSystem && objectIds.has(item.objectType) && item.schemaVersion,
      qualityRules: item => item.id && objectIds.has(item.objectType) && item.rule,
      glossaryTerms: item => item.term && item.definition && objectIds.has(item.objectType),
      accessPolicies: item => objectIds.has(item.objectType) && item.effect,
      lineageEdges: item => item.from && objectIds.has(item.to)
    };
    if (sections[check.name]) for (const section of sections[check.name]) {
      if (Array.isArray(draft[section]) && !draft[section].length) targets.push({ kind: 'section', section, index: -1, field: 'definition' });
      (draft[section] || []).forEach((item, index) => { if (!validAsset[section](item)) targets.push({ kind: 'section', section, index, field: 'definition' }); });
    }
    if (targets.length) check.targets = targets;
  }
  return { status: checks.every((item) => item.status === 'passed') ? 'passed' : 'failed', checks, checkedAt: now() };
};

const sanitizeObjectTypes = (value) => (Array.isArray(value) ? value : []).slice(0, 40).map((item, index) => {
  const id = String(item.id || `BusinessObject${index + 1}`).replace(/[^A-Za-z0-9_]/g, '').slice(0, 48) || `BusinessObject${index + 1}`;
  const label = String(item.label || id).trim().slice(0, 48);
  const source = String(item.source || `oa.custom_${id.toLowerCase()}`).trim().slice(0, 80);
  const sourceSystems = Array.isArray(item.sourceSystems) ? item.sourceSystems.map((system) => String(system).trim().toUpperCase()).filter(Boolean).slice(0, 8) : [source.split('.')[0].toUpperCase()];
  const fields = Array.isArray(item.fields) ? item.fields.map((field) => String(field).trim()).filter(Boolean).slice(0, 80) : [String(item.key || `${id.toLowerCase()}_id`), 'name', 'status'];
  const key = fields.includes(String(item.key || '')) ? String(item.key).trim().slice(0, 48) : fields[0];
  const suppliedDefinitions = Array.isArray(item.fieldDefinitions) ? item.fieldDefinitions : [];
  const fieldDefinitions = fields.map((name) => {
    const definition = suppliedDefinitions.find((field) => String(field?.name) === name) || {};
    return {
      name,
      type: String(definition.type || 'string').trim().slice(0, 48),
      required: Boolean(definition.required || name === key),
      primaryKey: name === key,
      sourceField: String(definition.sourceField || name).trim().slice(0, 120),
      mappingStatus: ['mapped', 'manual', 'derived', 'ignored', 'pending'].includes(definition.mappingStatus) ? definition.mappingStatus : 'mapped',
      reference: definition.reference ? String(definition.reference).replace(/[^A-Za-z0-9_]/g, '').slice(0, 48) : null,
      referenceField: definition.referenceField ? String(definition.referenceField).replace(/[^A-Za-z0-9_]/g, '').slice(0, 64) : null,
      unit: definition.unit ? String(definition.unit).slice(0, 80) : null,
      enum: Array.isArray(definition.enum) ? definition.enum.map(value => String(value).slice(0, 120)).slice(0, 100) : undefined,
      description: definition.description ? String(definition.description).trim().slice(0, 180) : null
    };
  });
  return {
    id, label, source, key, fields, fieldDefinitions, businessDomain: String(item.businessDomain || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48),
    granularity: item.granularity || inferObjectGranularity(id),
    classification: String(item.classification || '内部受限').trim().slice(0, 32), semanticType: String(item.semanticType || id).trim().slice(0, 48),
    coreObject: String(item.coreObject || coreBindingDefaults[id] || id).trim().slice(0, 32), description: String(item.description || '').trim().slice(0, 180), sourceSystems
  };
});

const sanitizeRelationshipTypes = (value, objectTypes) => {
  const allowed = new Set(objectTypes.map((item) => item.id));
  return (Array.isArray(value) ? value : []).slice(0, 40).map((item) => ({ predicate: String(item.predicate || '').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 48), from: String(item.from || ''), to: String(item.to || ''), label: String(item.label || '').trim().slice(0, 60), cardinality: ['1:1', '1:n', 'n:1', 'n:n'].includes(item.cardinality) ? item.cardinality : '1:n', evidence: String(item.evidence ?? '建模草稿').trim().slice(0, 100), provenanceType: item.provenanceType || 'declared', validFrom: item.validFrom || null, validTo: item.validTo || null, ...(item.keyMapping ? { keyMapping: sanitizeKeyMapping(item.keyMapping) } : {}) })).filter((item) => allowed.has(item.from) && allowed.has(item.to));
};

const makeInstances = () => ({
  nodes: [
    { id: 'org-hq', type: 'Organization', label: '元元健康总部', state: 'active' },
    { id: 'org-production', type: 'Organization', label: '生产与质量中心', state: 'active' },
    { id: 'org-supply', type: 'Organization', label: '采购与供应链中心', state: 'active' },
    { id: 'person-procurement', type: 'Person', label: '采购负责人', state: 'protected' },
    { id: 'person-quality', type: 'Person', label: '质量经理', state: 'protected' },
    { id: 'role-procurement', type: 'BusinessRole', label: '采购管理角色', state: 'active' },
    { id: 'action-purchase', type: 'BusinessAction', label: '发起采购申请', state: 'guarded' },
    { id: 'flow-purchase', type: 'ApprovalFlow', label: '原料采购申请流程', state: 'active' },
    { id: 'request-pr-20260731', type: 'ApprovalRequest', label: 'PR-20260731-001', state: 'in_progress' },
    { id: 'task-quality-check', type: 'WorkTask', label: '质量复核待办', state: 'pending' },
    { id: 'audit-001', type: 'AuditRecord', label: '策略校验审计', state: 'active' }
  ],
  edges: [
    ['org-hq', 'contains', 'org-production'], ['org-hq', 'contains', 'org-supply'], ['org-supply', 'employs', 'person-procurement'], ['org-production', 'employs', 'person-quality'], ['role-procurement', 'grants', 'action-purchase'], ['flow-purchase', 'governs', 'action-purchase'], ['request-pr-20260731', 'instantiates', 'flow-purchase'], ['request-pr-20260731', 'creates', 'task-quality-check'], ['task-quality-check', 'approves', 'action-purchase'], ['request-pr-20260731', 'records', 'audit-001']
  ].map(([from, predicate, to]) => ({ from, predicate, to }))
});

export const getMetaModels = () => mapMaybe(getOARuntime(), (runtime) => [summary(runtime)]);
export const getMetaModel = (id) => id === oaMetaModel.id ? mapMaybe(getOARuntime(), summary) : null;
export const getOAMetaModelSimulation = () => mapMaybe(getOARuntime(), (runtime) => clone(runtime.oaSimulation));
export const getOAMetaModelDraft = () => mapMaybe(getOARuntime(), (runtime) => {
  const draft = clone(normalizeSemanticDraft(runtime.oaDraft || makeDraft()));
  return { ...draft, fingerprint: semanticFingerprint(draft) };
});
export const getOAMetaModelDraftFromRuntime = (runtime) => clone(normalizeSemanticDraft(runtime?.oaDraft || makeDraft()));
export const getPublishedOntologyModel = () => mapMaybe(getOARuntime(), (runtime) => runtime.publishedModel
  ? { ...clone(runtime.publishedModel), ...(currentSemanticModel() !== DEFAULT_SEMANTIC_MODEL_ID ? { modelId: currentSemanticModel(), runtimeReadEnabled: false } : {}) } : null);
export const getPublishedDecisionContext = (capabilityId) => mapMaybe(getOARuntime(), (runtime) => {
  if (currentSemanticModel() !== DEFAULT_SEMANTIC_MODEL_ID) return null;
  const published = runtime.publishedModel;
  if (!published?.draft?.scenario?.decisionBindings?.some((item) => item.capabilityId === capabilityId)) return null;
  return { modelVersion: published.version, modelFingerprint: published.fingerprint, publishedAt: published.publishedAt,
    bindings: clone(published.draft.scenario.decisionBindings.filter((item) => item.capabilityId === capabilityId)),
    objectTypes: clone(published.draft.objectTypes.filter((object) => published.draft.scenario.decisionBindings.some((binding) => binding.capabilityId === capabilityId && binding.objectType === object.id))),
    authority: 'published_definition_not_permission_grant' };
});
export const getOAMetaModelRuntimeTransactionEntry = () => ({ name: 'oaRuntime', namespace: OA_NAMESPACE, key: OA_KEY, initialValue: initialOARuntime });

export const getOAMetaModelAuthoringProfile = (role, semanticDiscovery = null) => ({
  canModel: canConfigure(role),
  canPublish: canPublish(role),
  role: role?.name,
  modelingProfiles, objectGranularities, decisionCatalog: getBusinessDecisionCatalog(),
  guidance: [
    '从业务对象库拖入对象，填写业务名称、数据来源、主键和数据分级。',
    '用关系编辑器描述“谁关联谁、关联含义是什么”。',
    '保存草稿后执行校验；管理层通过发布后才可供智脑和工作流引用。'
  ],
  semanticDiscovery
});

export const buildOAMetaModelDraftRuntimeChange = (runtime, input, role, { action = '保存业务建模草稿', detail } = {}) => {
  if (!canConfigure(role)) return { error: '当前角色没有元模型建模权限。请在权限中心授予“业务建模协作人”。' };
  const nextRuntime = clone(runtime || initialOARuntime());
  const base = normalizeSemanticDraft(nextRuntime.oaDraft || makeDraft());
  if (input?.objectTypes !== undefined && (!Array.isArray(input.objectTypes) || !input.objectTypes.length || input.objectTypes.length > 40 || input.objectTypes.some((item) => !item || !Array.isArray(item.fields) || item.fields.length > 80 || !item.fields.includes(item.key)))) return { error: '对象数量应为 1–40，字段最多 80 个且必须包含指定主键；不会静默替换主键或恢复旧对象。' };
  const objectTypes = sanitizeObjectTypes(input?.objectTypes ?? base.objectTypes);
  if (objectTypes.some((item) => !objectGranularities.includes(item.granularity))) return { error: '对象粒度不受支持。' };
  const modelingProfile = input?.modelingProfile ?? base.modelingProfile;
  if (!modelingProfiles.includes(modelingProfile)) return { error: '不支持的建模场景。' };
  const scenario = input?.scenario ?? base.scenario;
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario) || typeof scenario.objective !== 'string' || scenario.objective.length > 2000
    || !Array.isArray(scenario.questions) || scenario.questions.length > 30 || scenario.questions.some((item) => typeof item !== 'string' || item.length > 1000)
    || !Array.isArray(scenario.decisionBindings) || !Array.isArray(scenario.actionBindings) || scenario.decisionBindings.length > 30 || scenario.actionBindings.length > 30
    || [...scenario.decisionBindings, ...scenario.actionBindings].some((item) => !item || typeof item !== 'object' || Array.isArray(item))) return { error: '场景目标、验收问题或能力绑定格式无效。' };
  const stateMachines = input?.stateMachines ?? base.stateMachines;
  if (!Array.isArray(stateMachines) || stateMachines.length > 30 || stateMachines.some((item) => !item || !Array.isArray(item.states) || !Array.isArray(item.terminal))) return { error: '状态机定义格式无效。' };
  const events = input?.events ?? base.events;
  if (!Array.isArray(events) || events.length > 100 || events.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) return { error: '事件定义格式无效。' };
  if (new Set(objectTypes.map((item) => item.id)).size !== objectTypes.length) return { error: '业务对象编码不能重复。' };
  const rawRelationships = input?.relationshipTypes ?? base.relationshipTypes;
  const ids = new Set(objectTypes.map((item) => item.id));
  if (!Array.isArray(rawRelationships) || rawRelationships.length > 40 || rawRelationships.some((item) => !item || !ids.has(item.from) || !ids.has(item.to) || !/^[\p{L}\p{N}_]{1,48}$/u.test(item.predicate || '') || !['1:1', '1:n', 'n:1', 'n:n'].includes(item.cardinality || '1:n'))) return { error: '关系必须连接现有对象并声明有效基数；不会静默丢弃无效关系。' };
  const relationKeys = rawRelationships.map((item) => JSON.stringify([item.from, item.predicate, item.to]));
  if (rawRelationships.some(item => item.keyMapping !== undefined && item.keyMapping !== null && !sanitizeKeyMapping(item.keyMapping))) return { error: '主数据映射定义无效；必须声明两端字段、依据、责任人与版本，不会静默移除映射约束。', code: 'READ_MAPPING_BINDING_INVALID' };
  if (rawRelationships.some(item => item.keyMapping && (!objectTypes.find(type => type.id === item.from)?.fields.includes(item.keyMapping.fromField) || !objectTypes.find(type => type.id === item.to)?.fields.includes(item.keyMapping.toField)))) return { error: '主数据映射两端字段必须存在于对应模型对象中。', code: 'READ_MAPPING_FIELDS_INVALID' };
  if (new Set(relationKeys).size !== relationKeys.length) return { error: '关系不能重复。' };
  const relationshipTypes = sanitizeRelationshipTypes(input?.relationshipTypes ?? base.relationshipTypes, objectTypes);
  const policies = Array.isArray(input?.policies) ? input.policies.map((item) => String(item).trim()).filter(Boolean).slice(0, 12) : base.policies;
  const semanticAssets = {
    metrics: Array.isArray(input?.metrics) ? clone(input.metrics).slice(0, 50) : base.metrics,
    glossaryTerms: Array.isArray(input?.glossaryTerms) ? clone(input.glossaryTerms).slice(0, 100) : base.glossaryTerms,
    dataContracts: Array.isArray(input?.dataContracts) ? clone(input.dataContracts).slice(0, 50) : base.dataContracts,
    qualityRules: Array.isArray(input?.qualityRules) ? clone(input.qualityRules).slice(0, 100) : base.qualityRules,
    accessPolicies: Array.isArray(input?.accessPolicies) ? clone(input.accessPolicies).slice(0, 100) : base.accessPolicies,
    lineageEdges: Array.isArray(input?.lineageEdges) ? clone(input.lineageEdges).slice(0, 100) : base.lineageEdges
  };
  if (Object.values(semanticAssets).some((items) => items.some((item) => !item || typeof item !== 'object' || Array.isArray(item)))) return { error: '治理资产必须为有效对象。' };
  const worldModel = input?.worldModel ?? base.worldModel ?? null;
  if (worldModel && (worldModel.schemaVersion !== 'semantic-world-model.v1' || !Array.isArray(worldModel.rules) || worldModel.rules.length > 100 || worldModel.rules.some(rule => !rule.id || typeof rule.evidence !== 'string' || rule.executable !== false))) return { error: '世界模型需求资产必须保留原文证据，不能包含可执行指令。' };
  nextRuntime.oaDraft = { ...base, worldModel: clone(worldModel), modelingProfile, scenario: clone(scenario), stateMachines: clone(stateMachines), events: clone(events), objectTypes, relationshipTypes, policies, ...semanticAssets, updatedAt: now(), updatedBy: role.name, validation: null };
  nextRuntime.oaDraft.dependencyImpact = buildOntologyImpact(base, nextRuntime.oaDraft);
  nextRuntime.oaDraft.audit ||= [];
  nextRuntime.oaDraft.audit.unshift({ time: now(), actor: role.name, action, detail: detail || `已保存 ${objectTypes.length} 个业务对象和 ${relationshipTypes.length} 条业务关系。` });
  nextRuntime.oaSimulation = null;
  return { runtime: nextRuntime, result: { draft: { ...clone(nextRuntime.oaDraft), fingerprint: semanticFingerprint(nextRuntime.oaDraft) }, metaModel: summary(nextRuntime) } };
};

export const saveOAMetaModelDraft = (input, role) => {
  return mutateSemanticGovernanceState(OA_NAMESPACE, OA_KEY, initialOARuntime, (runtime) => {
    const change = buildOAMetaModelDraftRuntimeChange(runtime, input, role);
    if (change.error) return { commit: false, result: { error: change.error, ...(change.code ? { code: change.code } : {}) } };
    return { value: change.runtime, result: change.result };
  });
};

export const validateOAMetaModelDraft = (role, { expectedFingerprint } = {}) => {
  if (!canConfigure(role)) return { error: '当前角色没有校验元模型草稿的权限。' };
  return mutateSemanticGovernanceState(OA_NAMESPACE, OA_KEY, initialOARuntime, (runtime) => {
    if (expectedFingerprint !== undefined && semanticFingerprint(getOAMetaModelDraftFromRuntime(runtime)) !== expectedFingerprint) return { commit: false, result: { error: '草稿结构已改变，请重新核对。', code: 'MODEL_DRAFT_FINGERPRINT_CONFLICT', status: 409 } };
    runtime.oaDraft = normalizeSemanticDraft(runtime.oaDraft || makeDraft());
    runtime.oaDraft.validation = validateDraft(runtime.oaDraft);
    runtime.oaDraft.updatedAt = now(); runtime.oaDraft.updatedBy = role.name;
    runtime.oaDraft.audit.unshift({ time: now(), actor: role.name, action: '校验业务建模草稿', detail: `校验结果：${runtime.oaDraft.validation.status}` });
    return { value: runtime, result: { draft: { ...clone(runtime.oaDraft), fingerprint: semanticFingerprint(runtime.oaDraft) }, metaModel: summary(runtime) } };
  });
};

export const simulateBuildOAMetaModel = (role, { expectedFingerprint } = {}) => {
  if (!canConfigure(role)) return { error: '当前角色无权模拟构建 OA 元模型。' };
  return mutateSemanticGovernanceState(OA_NAMESPACE, OA_KEY, initialOARuntime, (runtime) => {
  if (expectedFingerprint !== undefined && semanticFingerprint(getOAMetaModelDraftFromRuntime(runtime)) !== expectedFingerprint) return { commit: false, result: { error: '草稿结构已改变，请重新核对。', code: 'MODEL_DRAFT_FINGERPRINT_CONFLICT', status: 409 } };
  runtime.oaDraft = normalizeSemanticDraft(runtime.oaDraft || makeDraft());
  runtime.oaDraft.validation = validateDraft(runtime.oaDraft);
  if (runtime.oaDraft.validation.status !== 'passed') return { commit: false, result: { error: '请先修复元模型草稿的校验问题，再模拟构建。', draft: clone(runtime.oaDraft) } };
  const model = currentMetaModel(runtime);
  const oaInstances = makeInstances();
  const instances = model.modelingProfile === 'general' ? {
    nodes: model.objectTypes.map((item) => ({ id: `synthetic-${item.id}`, type: item.id, label: `${item.label}（结构示例）`, state: 'synthetic' })),
    edges: model.relationshipTypes.map((item) => ({ from: `synthetic-${item.from}`, predicate: item.predicate, to: `synthetic-${item.to}` }))
  } : oaInstances;
  const decisionReplay = replayOntologyDecisions(runtime.oaDraft);
  const checks = [
    { name: '对象主键', status: model.objectTypes.every((item) => item.key) ? 'passed' : 'failed', detail: `${model.objectTypes.length} 个对象类型均定义稳定业务主键。` },
    ...runtime.oaDraft.validation.checks,
    { name: '已绑定判断回放', status: decisionReplay.status === 'failed' ? 'failed' : 'passed', detail: decisionReplay.status === 'not_configured' ? '未绑定判断，仅验证模型结构，不代表业务判断已验收。' : '已执行内置合成判断用例；不代表真实历史数据或外部写入验收。' }
  ];
  runtime.oaSimulation = {
    ...(expectedFingerprint !== undefined ? { sourceFingerprint: expectedFingerprint } : {}),
    id: 'oa-sim-20260731-001', status: 'simulated', builtAt: now(), builtBy: role.name,
    instances, decisionReplay, sourceMode: 'synthetic', verifiesLiveSystems: false, validation: { status: checks.every((item) => item.status === 'passed') ? 'passed' : 'failed', checks },
    audit: [{ time: now(), actor: role.name, action: '模拟构建元模型', detail: '已生成模板或结构示例并回放已绑定判断；未连接真实业务系统。' }]
  };
  return { value: runtime, result: { metaModel: summary(runtime), simulation: clone(runtime.oaSimulation), reused: false } };
  });
};

export const publishOAMetaModel = (role, { version, expectedFingerprint, tenantId } = {}) => {
  if (tenantId) assertSemanticTenant({ tenantId });
  const publishingTenant = tenantId || currentSemanticTenant();
  if (!canPublish(role)) return { error: '仅管理层可发布 OA 元模型版本。' };
  return mutateSemanticGovernanceWithEvent({ namespace: OA_NAMESPACE, key: OA_KEY, initialValue: initialOARuntime, mutation: (runtime) => {
    if (expectedFingerprint && semanticFingerprint(currentMetaModel(runtime)) !== expectedFingerprint) return { commit: false, result: { error: '草稿在发布期间发生变化，未将新草稿误登记为旧版本；需要核对独立服务部署。', code: 'ONTOLOGY_PUBLICATION_STALE' } };
    if (!runtime.oaSimulation?.validation || runtime.oaSimulation.validation.status !== 'passed') return { commit: false, result: { error: '请先完成并通过 OA 元模型模拟构建校验。' } };
    if (runtime.oaSimulation.status === 'published') return { commit: false, result: { error: `当前模拟结果已发布为 ${runtime.oaSimulation.version}，不能重复发布。` } };
    runtime.oaSimulation.status = 'published';
    runtime.oaSimulation.version = version || `mm-oa-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)}`;
    runtime.oaSimulation.publishedAt = now();
    runtime.publishedModel = { tenantId: publishingTenant, version: runtime.oaSimulation.version, publishedAt: runtime.oaSimulation.publishedAt,
      fingerprint: semanticFingerprint(runtime.oaDraft), draft: clone(runtime.oaDraft) };
    runtime.oaSimulation.audit.unshift({ time: now(), actor: role.name, action: '发布 OA 元模型', detail: `${runtime.oaSimulation.version} 已进入受控生效状态；Demo 未写入真实 OA。` });
    const result = { metaModel: summary(runtime), simulation: clone(runtime.oaSimulation) };
    return { value: runtime, result, event: { type: 'governance.meta_model.published', tenantId: publishingTenant, aggregateType: 'MetaModel', aggregateId: oaMetaModel.id, actor: { type: 'role', id: role.id }, payload: { version: runtime.oaSimulation.version, validationStatus: runtime.oaSimulation.validation.status } } };
  } });
};

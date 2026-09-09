const coreMetaObjects = [
  {
    id: 'Person', code: 'CORE-PERSON', name: '人员', icon: '人', color: '#6e81ff',
    description: '任何动作的责任主体。承载组织归属、岗位、业务角色、授权、技能与审批身份。',
    source: 'OA / 账号中心', key: 'person_id', classification: '个人信息受限',
    lifecycle: ['入职/接入', '在岗', '角色变更', '离岗/停用'],
    governance: '权限中心负责身份与角色；智脑按请求级短时授权读取。'
  },
  {
    id: 'RawMaterial', code: 'CORE-MATERIAL', name: '原材料', icon: '料', color: '#edb55d',
    description: '采购、来料检验、库存、配方消耗、批次追溯和供应商质量的核心锚点。',
    source: 'ERP / SRM / LIMS / WMS', key: 'material_batch_id', classification: '质量与供应链受限',
    identitySemantics: { granularity: 'legacy_batch_anchor', masterType: 'Material', batchType: 'RawMaterialBatch', inventoryType: 'Inventory', migration: '保持历史编号；新增场景以明确粒度对象建模，不把主数据与批次合并。' },
    lifecycle: ['主数据建立', '供应商准入', '采购/到货', '检验/放行', '领用/报废'],
    governance: '涉及质量放行、供应商资质和采购写入时必须经过策略与审批校验。'
  },
  {
    id: 'Product', code: 'CORE-PRODUCT', name: '产品', icon: '品', color: '#4ed6af',
    description: '研发配方、规格、生产批次、成品检验、库存、销售、客户反馈与召回的业务锚点。',
    source: 'PLM / MES / LIMS / ERP / QMS / OMS', key: 'product_batch_id', classification: '产品与质量受限',
    identitySemantics: { granularity: 'legacy_mixed_anchor', masterType: 'ProductSKU', batchType: 'FinishedGoodsBatch', migration: '保持历史批次与 SKU 引用；新场景区分产品主数据和成品批次。' },
    lifecycle: ['研发', '配方/规格批准', '生产', '检验/放行', '销售/售后', '召回/退市'],
    governance: '产品批次和规格变更需关联质量证据、审批记录和可追溯审计。'
  },
  {
    id: 'Equipment', code: 'CORE-EQUIPMENT', name: '设备', icon: '设', color: '#5fc6f5',
    description: '工艺执行、产能、设备状态、维护、清洁、校准与偏差分析的实体锚点。',
    source: 'MES / EAM / IoT', key: 'equipment_id', classification: '生产受限',
    lifecycle: ['建档', '启用', '生产使用', '维护/校准', '停用/报废'],
    governance: '设备异常或校准逾期时，自动限制相关生产业务动作并触发风险通知。'
  },
  {
    id: 'Store', code: 'CORE-STORE', name: '门店', icon: '店', color: '#ef7f9a',
    description: '直营网点、加盟网点与零售终端的经营锚点，承载门店组织、区域、营业状态、库存、订单、履约、客诉与终端设备关系。',
    source: 'MDM / OMS / POS / ERP', key: 'store_id', classification: '门店运营受限',
    lifecycle: ['筹备/建档', '试营业', '营业', '暂停营业/整改', '闭店/注销'],
    governance: '门店状态、所属组织与经营范围由主数据权威源维护；门店停业或越出授权组织范围时阻断补货、销售与处置动作。'
  }
];

const processTemplates = [
  { id: 'procurement', name: '原材料采购', required: ['Person', 'RawMaterial'], optional: ['Product'], description: '发起人提出具体原材料需求；可关联产品需求以解释采购原因。' },
  { id: 'production', name: '产品生产', required: ['Person', 'RawMaterial', 'Product', 'Equipment'], optional: [], description: '生产批次必须同时说明责任人、投料、目标产品和执行设备。' },
  { id: 'quality', name: '质量检验与放行', required: ['Person'], optional: ['RawMaterial', 'Product', 'Equipment', 'Store'], description: '质量人员对原料、产品、设备或门店相关对象形成检验、放行或偏差记录。' },
  { id: 'maintenance', name: '设备维护与校准', required: ['Person', 'Equipment'], optional: ['Product'], description: '维护责任人与设备为必填；如影响产品批次则附加产品关联。' },
  { id: 'market-feedback', name: '市场反馈与投诉', required: ['Person', 'Product'], optional: ['Store'], description: '市场或客服人员针对具体产品记录反馈；线下来源应关联门店，并路由风险与质量处置。' },
  { id: 'store-operation', name: '门店运营', required: ['Person', 'Store'], optional: ['Product', 'Equipment'], description: '门店经营、巡检和异常处置必须说明责任人与目标门店，可关联商品和店内设备。' },
  { id: 'store-replenishment', name: '门店补货', required: ['Person', 'Store', 'Product'], optional: [], description: '门店补货必须绑定申请人、目标门店和具体产品，库存与订单仍由权威系统复核。' }
];

const relationships = [
  { from: 'Person', predicate: 'procures', to: 'RawMaterial', label: '人员发起原材料采购' },
  { from: 'RawMaterial', predicate: 'composes', to: 'Product', label: '原材料构成产品' },
  { from: 'Equipment', predicate: 'produces', to: 'Product', label: '设备生产产品' },
  { from: 'Person', predicate: 'operates', to: 'Equipment', label: '人员操作设备' },
  { from: 'Person', predicate: 'approves', to: 'Product', label: '人员审批产品相关动作' },
  { from: 'Equipment', predicate: 'affects', to: 'RawMaterial', label: '设备状态影响原材料处理' },
  { from: 'Person', predicate: 'manages', to: 'Store', label: '人员负责门店运营' },
  { from: 'Store', predicate: 'sells', to: 'Product', label: '门店销售产品' },
  { from: 'Equipment', predicate: 'located_at', to: 'Store', label: '设备部署于门店' }
];

const actionBindingPolicies = {
  create_procurement_demand: { processType: 'procurement', bindings: ['Person', 'RawMaterial', 'Product'] },
  launch_procurement: { processType: 'procurement', bindings: ['Person', 'RawMaterial', 'Product'] },
  approve_procurement: { processType: 'procurement', bindings: ['Person', 'RawMaterial', 'Product'] },
  create_quality_investigation: { processType: 'quality', bindings: ['Person', 'RawMaterial', 'Product'] },
  create_market_response_draft: { processType: 'market-feedback', bindings: ['Person', 'Product', 'Store'] },
  create_store_operation_task: { processType: 'store-operation', bindings: ['Person', 'Store', 'Product', 'Equipment'] },
  create_store_replenishment_draft: { processType: 'store-replenishment', bindings: ['Person', 'Store', 'Product'] },
  create_budget_review_draft: { processType: 'procurement', bindings: ['Person', 'RawMaterial', 'Product'] }
};

const prohibitedStatuses = new Set(['blocked', 'disabled', 'quarantined', 'decommissioned', 'recalled']);

// 演示环境中的权威对象投影。生产实现必须由受控 Connector 查询权威来源，
// 不可信的客户端字段（状态、来源、数据分级）不能作为校验依据。
const authoritativeCoreObjects = [
  { type: 'Person', id: 'usr-001', status: 'active', source: 'OA', classification: '个人信息受限' },
  { type: 'Person', id: 'usr-003', status: 'active', source: 'OA', classification: '个人信息受限' },
  { type: 'Person', id: 'usr-004', status: 'active', source: 'OA', classification: '个人信息受限' },
  { type: 'Person', id: 'usr-005', status: 'active', source: 'OA', classification: '个人信息受限' },
  { type: 'RawMaterial', id: 'RMB-VC-20260718', status: 'released', source: 'ERP/LIMS', classification: '质量与供应链受限' },
  { type: 'Product', id: 'FG-SLEEP-20260812', status: 'released', source: 'MES/LIMS', classification: '产品与质量受限' },
  { type: 'Product', id: 'SKU-SLEEP-01', status: 'released', source: 'OMS/ERP', classification: '产品与质量受限' },
  { type: 'Store', id: 'STORE-SH-001', status: 'active', source: 'MDM/OMS/POS', classification: '门店运营受限', organizationId: 'org-market-dept' },
  { type: 'Store', id: 'STORE-HZ-002', status: 'active', source: 'MDM/OMS/POS', classification: '门店运营受限', organizationId: 'org-market-dept' }
];

const authoritativeObjectByKey = new Map(authoritativeCoreObjects.map((item) => [`${item.type}:${item.id}`, item]));

const demoBindingsByAction = {
  create_procurement_demand: [
    { type: 'Person', id: 'usr-004', status: 'active', source: 'OA' },
    { type: 'RawMaterial', id: 'RMB-VC-20260718', status: 'released', source: 'ERP/LIMS' },
    { type: 'Product', id: 'FG-SLEEP-20260812', status: 'released', source: 'MES/LIMS' }
  ],
  create_quality_investigation: [
    { type: 'Person', id: 'usr-003', status: 'active', source: 'OA' },
    { type: 'RawMaterial', id: 'RMB-VC-20260718', status: 'released', source: 'ERP/LIMS' },
    { type: 'Product', id: 'FG-SLEEP-20260812', status: 'released', source: 'MES/LIMS' }
  ],
  create_market_response_draft: [
    { type: 'Person', id: 'usr-005', status: 'active', source: 'OA' },
    { type: 'Product', id: 'SKU-SLEEP-01', status: 'released', source: 'OMS/ERP' },
    { type: 'Store', id: 'STORE-SH-001', status: 'active', source: 'MDM/OMS/POS' }
  ],
  create_store_operation_task: [
    { type: 'Person', id: 'usr-005', status: 'active', source: 'OA' },
    { type: 'Store', id: 'STORE-SH-001', status: 'active', source: 'MDM/OMS/POS' },
    { type: 'Product', id: 'SKU-SLEEP-01', status: 'released', source: 'OMS/ERP' }
  ],
  create_store_replenishment_draft: [
    { type: 'Person', id: 'usr-005', status: 'active', source: 'OA' },
    { type: 'Store', id: 'STORE-SH-001', status: 'active', source: 'MDM/OMS/POS' },
    { type: 'Product', id: 'SKU-SLEEP-01', status: 'released', source: 'OMS/ERP' }
  ],
  create_budget_review_draft: [
    { type: 'Person', id: 'usr-004', status: 'active', source: 'OA' },
    { type: 'RawMaterial', id: 'RMB-VC-20260718', status: 'released', source: 'ERP/LIMS' },
    { type: 'Product', id: 'FG-SLEEP-20260812', status: 'released', source: 'MES/LIMS' }
  ]
};

const normalizeBinding = (binding) => {
  if (typeof binding === 'string') return { type: binding, id: null, status: null };
  return {
    type: binding?.type || binding?.objectType || binding?.metaObjectType || null,
    id: binding?.id || binding?.objectId || binding?.referenceId || null,
    status: String(binding?.status || 'active').toLowerCase(),
    source: binding?.source || null
  };
};

export const getCoreMetaObjectLayer = () => ({
  name: '核心元对象层', version: '1.1.0', principle: '每个业务流程至少绑定一名人员，并绑定与业务目的直接相关的原材料、产品、设备或门店。',
  objects: coreMetaObjects, relationships, processTemplates,
  controls: ['人员决定责任与权限', '原材料、产品、设备、门店决定数据域与业务影响范围', '门店必须使用权威主数据状态与所属组织，不能由客户端自行声明', '流程缺少必填核心对象时，仅允许保存草稿，不允许调用智脑执行或提交审批']
});

export const validateCoreObjectBindings = ({ processType, bindings = [] }) => {
  const template = processTemplates.find((item) => item.id === processType);
  if (!template) return { status: 'failed', reason: '未找到业务流程模板。', missing: [] };
  const normalized = bindings.map(normalizeBinding);
  const allowedTypes = new Set([...template.required, ...template.optional]);
  const verifiedBindings = normalized.map((binding) => {
    const authoritative = binding.type && binding.id ? authoritativeObjectByKey.get(`${binding.type}:${binding.id}`) : null;
    return { ...binding, authoritative };
  });
  const missing = template.required.filter((type) => !verifiedBindings.some((binding) => binding.type === type && binding.authoritative));
  const invalid = verifiedBindings.flatMap((binding) => {
    if (!binding.type || !binding.id) return [{ ...binding, reason: '缺少核心对象类型或稳定业务标识。' }];
    if (!allowedTypes.has(binding.type)) return [{ ...binding, reason: '该对象类型不属于当前流程的允许绑定范围。' }];
    if (!binding.authoritative) return [{ ...binding, reason: '未在权威对象投影中找到该对象，拒绝使用客户端伪造绑定。' }];
    if (binding.source && binding.source !== binding.authoritative.source) return [{ ...binding, reason: '客户端声明的来源与权威来源不一致。' }];
    if (binding.status && binding.status !== binding.authoritative.status) return [{ ...binding, reason: '客户端声明的状态与权威状态不一致。' }];
    if (prohibitedStatuses.has(binding.authoritative.status)) return [{ ...binding, reason: '权威对象状态不允许进入该业务流程。' }];
    return [];
  });
  const trustedBindings = verifiedBindings.filter((binding) => binding.authoritative).map(({ authoritative, ...binding }) => ({ ...binding, status: authoritative.status, source: authoritative.source, classification: authoritative.classification, ...(authoritative.organizationId ? { organizationId: authoritative.organizationId } : {}) }));
  return { status: missing.length || invalid.length ? 'failed' : 'passed', process: template.name, missing, invalid, required: template.required, optional: template.optional, bindings: trustedBindings };
};

export const getCoreObjectActionPolicy = (action) => actionBindingPolicies[action] || null;

export const getDemoCoreBindingsForAction = (action) => structuredClone(demoBindingsByAction[action] || []);

export const evaluateCoreObjectAction = (action, bindings) => {
  const policy = getCoreObjectActionPolicy(action);
  if (!policy) return { status: 'passed', required: [], optional: [], process: '通用业务动作', bindings: [] };
  return validateCoreObjectBindings({ processType: policy.processType, bindings: bindings || [] });
};

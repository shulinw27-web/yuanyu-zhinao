import { mutateState, readState } from '../repositories/runtime-state-repository.js';
import { mutateWithDomainEvent } from '../infrastructure/domain-events/domain-event-outbox.js';
import { semanticTenantStateKey, currentSemanticTenant } from './semantic-tenant-context.js';
import { getConnectionTargets } from './system-registry-service.js';

const templates = [
  {
    id: 'lims-quality', code: 'LIMS', name: '实验室质量模板', category: '质量与合规', version: '1.0.0', color: '#1677c8',
    description: '将样品、规格、检验结果和放行决定映射为质量追溯上下文。', targets: ['lims'],
    mappings: [
      { source: 'test_result', object: 'TestResult', event: 'TestResultCompleted', keys: ['result_id'], fields: ['result_id', 'sample_id', 'test_item', 'result_value', 'decision'], classification: '质量受限' },
      { source: 'sample', object: 'Sample', event: 'SampleReceived', keys: ['sample_id'], fields: ['sample_id', 'material_batch_no', 'collected_at'], classification: '质量受限' }
    ],
    relationships: ['Sample → belongs_to → MaterialBatch', 'TestResult → tests → Sample', 'TestResult → triggers → RiskCase'],
    rules: ['检验不合格且原料已领用时创建质量风险', '放行决定仅质量角色可见'],
    governance: { sensitivity: '质量受限', retention: '730 天', approval: '质量经理 + 数据负责人' }
  },
  {
    id: 'mes-production', code: 'MES', name: '制造执行模板', category: '生产运营', version: '1.0.0', color: '#0c9a73',
    description: '映射生产批次、工序、设备状态和偏差，实现生产可追溯。', targets: ['mes'],
    mappings: [
      { source: 'production_batch', object: 'ProductionBatch', event: 'BatchStatusChanged', keys: ['batch_no'], fields: ['batch_no', 'formula_version', 'line', 'status', 'started_at'], classification: '生产受限' },
      { source: 'deviation', object: 'Deviation', event: 'DeviationRaised', keys: ['deviation_id'], fields: ['deviation_id', 'batch_no', 'severity', 'description'], classification: '生产受限' }
    ],
    relationships: ['ProductionBatch → consumes → MaterialBatch', 'ProductionBatch → produces → FinishedGoodsBatch', 'Deviation → affects → ProductionBatch'],
    rules: ['严重偏差自动关联生产批次和质量风险', '未放行批次禁止进入可售库存'],
    governance: { sensitivity: '生产受限', retention: '730 天', approval: '生产负责人 + 质量经理' }
  },
  {
    id: 'erp-supply-chain', code: 'ERP', name: '供应链与财务模板', category: '供应链', version: '1.0.0', color: '#cf7a12',
    description: '映射库存、采购申请、采购订单、供应商和预算控制。', targets: ['erp'],
    mappings: [
      { source: 'inventory', object: 'Inventory', event: 'InventoryAllocated', keys: ['sku', 'lot_no'], fields: ['sku', 'lot_no', 'available_qty', 'expiry_date', 'warehouse'], classification: '运营受限' },
      { source: 'purchase_order', object: 'PurchaseOrder', event: 'PurchaseOrderChanged', keys: ['po_id'], fields: ['po_id', 'supplier_id', 'material_code', 'qty', 'amount', 'status'], classification: '财务受限' }
    ],
    relationships: ['Inventory → stores → FinishedGoodsBatch', 'PurchaseOrder → purchases → RawMaterial', 'PurchaseOrder → selects → Supplier'],
    rules: ['库存低于安全阈值时创建补货建议', '采购订单写入必须经过审批工作流'],
    governance: { sensitivity: '财务受限', retention: '730 天', approval: '采购负责人 + 财务负责人' }
  },
  {
    id: 'oms-order', code: 'OMS', name: '订单运营模板', category: '市场运营', version: '1.0.0', color: '#7b67c9',
    description: '映射门店、订单、渠道、履约和退货状态，形成脱敏门店与订单运营上下文。', targets: ['oms'],
    mappings: [
      { source: 'store', object: 'Store', event: 'StoreStatusChanged', keys: ['store_id'], fields: ['store_id', 'store_name', 'organization_id', 'region_code', 'operation_status'], classification: '门店运营受限' },
      { source: 'order', object: 'Order', event: 'OrderStatusChanged', keys: ['order_id'], fields: ['order_id', 'store_id', 'channel', 'sku', 'delivery_status', 'created_at'], classification: '市场受限' },
      { source: 'fulfillment', object: 'Fulfillment', event: 'FulfillmentStatusChanged', keys: ['fulfillment_id'], fields: ['fulfillment_id', 'order_id', 'carrier', 'status', 'dispatched_at'], classification: '订单运营受限' }
    ],
    relationships: ['Store → sells → Product', 'Order → placed_at → Store', 'Order → ordered_from → Channel', 'Fulfillment → fulfills → Order', 'Order → allocates → FinishedGoodsBatch'],
    rules: ['停业门店不能创建补货或销售动作', '履约延迟聚集时创建订单运营风险', '订单身份字段在进入世界模型前脱敏'],
    governance: { sensitivity: '订单运营受限', retention: '365 天', approval: '市场负责人 + 数据负责人' }
  },
  {
    id: 'wms-warehouse', code: 'WMS', name: '仓储与物流模板', category: '仓储物流', version: '1.0.0', color: '#2c9bd4',
    description: '映射库位、库存批次、出入库、冷链和发运事件。', targets: ['wms'],
    mappings: [
      { source: 'stock_lot', object: 'InventoryLot', event: 'LotStockChanged', keys: ['lot_no', 'warehouse_code'], fields: ['lot_no', 'warehouse_code', 'location', 'on_hand_qty', 'expiry_date'], classification: '运营受限' },
      { source: 'shipment', object: 'Shipment', event: 'ShipmentDispatched', keys: ['shipment_id'], fields: ['shipment_id', 'order_id', 'carrier', 'status', 'temperature_status'], classification: '运营受限' }
    ],
    relationships: ['InventoryLot → stored_at → WarehouseLocation', 'Shipment → fulfills → Order', 'Shipment → carries → FinishedGoodsBatch'],
    rules: ['临期批次触发库存周转风险', '冷链异常触发质量风险复核'],
    governance: { sensitivity: '运营受限', retention: '365 天', approval: '仓储负责人 + 质量经理' }
  },
  {
    id: 'qms-quality', code: 'QMS', name: '质量管理模板', category: '质量与合规', version: '1.0.0', color: '#2f7fd3',
    description: '映射 CAPA、变更控制、偏差、审计和质量文件版本。', targets: ['qms'],
    mappings: [
      { source: 'capa', object: 'CAPA', event: 'CAPAStatusChanged', keys: ['capa_id'], fields: ['capa_id', 'source_deviation', 'owner', 'due_date', 'status'], classification: '质量受限' },
      { source: 'change_control', object: 'ChangeControl', event: 'ChangeControlSubmitted', keys: ['change_id'], fields: ['change_id', 'scope', 'risk_level', 'effective_date', 'status'], classification: '质量受限' }
    ],
    relationships: ['CAPA → resolves → Deviation', 'ChangeControl → changes → Specification', 'ChangeControl → requires → Approval'],
    rules: ['逾期 CAPA 触发合规风险', '高风险变更须关联影响批次与审批记录'],
    governance: { sensitivity: '质量受限', retention: '1095 天', approval: '质量负责人 + 合规负责人' }
  },
  {
    id: 'srm-supplier', code: 'SRM', name: '供应商管理模板', category: '供应链', version: '1.0.0', color: '#569f4a',
    description: '映射供应商资质、审计、合同、绩效和原料来源。', targets: ['srm'],
    mappings: [
      { source: 'supplier', object: 'Supplier', event: 'SupplierStatusChanged', keys: ['supplier_id'], fields: ['supplier_id', 'qualification_status', 'certificate_expiry', 'risk_level'], classification: '供应链受限' },
      { source: 'supplier_audit', object: 'SupplierAudit', event: 'SupplierAuditCompleted', keys: ['audit_id'], fields: ['audit_id', 'supplier_id', 'score', 'finding_count', 'audit_date'], classification: '供应链受限' }
    ],
    relationships: ['Supplier → supplies → RawMaterial', 'SupplierAudit → audits → Supplier', 'Supplier → governed_by → Contract'],
    rules: ['供应商证照临期触发续证提醒', '资质失效时阻断新增采购草稿'],
    governance: { sensitivity: '供应链受限', retention: '730 天', approval: '采购负责人 + 质量经理' }
  },
  {
    id: 'oa-approval', code: 'OA', name: '办公与审批模板', category: '内务协同', version: '1.0.0', color: '#865ad2',
    description: '映射审批实例、组织、人员职责、任务和通知回执。', targets: ['oa'],
    mappings: [
      { source: 'approval_instance', object: 'ApprovalRequest', event: 'ApprovalStatusChanged', keys: ['instance_id'], fields: ['instance_id', 'business_type', 'applicant', 'status', 'submitted_at'], classification: '内部受限' },
      { source: 'task', object: 'WorkTask', event: 'TaskAssigned', keys: ['task_id'], fields: ['task_id', 'owner', 'due_date', 'status', 'business_ref'], classification: '内部受限' }
    ],
    relationships: ['ApprovalRequest → approves → BusinessAction', 'WorkTask → assigned_to → OrganizationRole', 'ApprovalRequest → produces → AuditRecord'],
    rules: ['高风险业务动作必须存在审批实例', '审批超时触发升级通知'],
    governance: { sensitivity: '内部受限', retention: '730 天', approval: '流程负责人 + 数据负责人' }
  }
];

// 连接目标清单已收敛到系统注册表：自 2026-09-26（ADR-024）起只派生 6 个已接入的
// 演示样例系统，不再预设备 SRM/OA 待接入目标——接入清单完全由租户自行登记。
// 上方的 SRM / OA 连接模板保留为平台资产，但需先有租户登记的对应目标才可用。
export const getWorldModelConnectionTargets = () => getConnectionTargets();

const WORLD_NAMESPACE = 'world_model_runtime';
const WORLD_KEY = 'drafts';
const initialWorldDrafts = () => [];
const getDraftState = () => readState(WORLD_NAMESPACE, semanticTenantStateKey(WORLD_KEY), initialWorldDrafts);
const now = () => new Date().toISOString();
const canConfigure = (role) => ['executive', 'quality_manager'].includes(role?.id);
const canPublish = (role) => role?.id === 'executive';
const templateById = (id) => templates.find((item) => item.id === id);

const buildDraft = (template, target, actor) => ({
  id: `wmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  templateId: template.id, templateName: template.name, templateVersion: template.version,
  targetId: target.id, targetName: target.name, targetStatus: target.status, category: template.category,
  status: 'draft', version: null, createdAt: now(), updatedAt: now(), createdBy: actor.name,
  mappings: template.mappings.map((item) => ({ ...item, source: `${target.code.toLowerCase()}.${item.source}` })),
  relationships: template.relationships, rules: template.rules, governance: template.governance,
  validation: null, audit: [{ time: now(), actor: actor.name, action: '基于连接模板创建世界模型草稿', detail: `${template.code} 模板 → ${target.code} 数据连接` }]
});

export const getWorldModelTemplates = () => templates.map((template) => ({ ...template, mappingCount: template.mappings.length, relationshipCount: template.relationships.length, ruleCount: template.rules.length }));
export const getWorldModelTemplate = (id) => templateById(id) || null;
export const getWorldModelDrafts = (roleId) => {
  const visibleCategories = {
    quality_manager: ['质量与合规', '生产运营', '供应链'],
    production_manager: ['生产运营', '仓储物流'],
    marketing_manager: ['市场运营']
  };
  return getDraftState().filter((draft) => roleId === 'executive' || visibleCategories[roleId]?.includes(draft.category)).slice(0, 12);
};

export const createWorldModelDraft = ({ templateId, targetId }, role) => {
  if (!canConfigure(role)) return { error: '当前角色无权创建世界模型配置草稿。' };
  const template = templateById(templateId);
  const target = getConnectionTargets().find((item) => item.id === targetId);
  if (!template || !target) return { error: '模板或目标系统不存在。' };
  return mutateState(WORLD_NAMESPACE, semanticTenantStateKey(WORLD_KEY), initialWorldDrafts, (drafts) => {
    const existing = drafts.find((item) => item.templateId === templateId && item.targetId === targetId && item.status !== 'published');
    if (existing) return { commit: false, result: { draft: existing, reused: true } };
    const draft = buildDraft(template, target, role);
    drafts.unshift(draft);
    return { value: drafts, result: { draft, reused: false } };
  });
};

export const validateWorldModelDraft = (id, role) => {
  if (!canConfigure(role)) return { error: '当前角色无权校验世界模型配置草稿。' };
  return mutateState(WORLD_NAMESPACE, semanticTenantStateKey(WORLD_KEY), initialWorldDrafts, (drafts) => {
  const draft = drafts.find((item) => item.id === id);
  if (!draft) return { commit: false, result: { error: '未找到世界模型草稿。' } };
  const checks = [
    { name: '主键完整性', status: draft.mappings.every((item) => item.keys?.length) ? 'passed' : 'failed', detail: '每个对象映射均已定义稳定业务主键。' },
    { name: '字段映射完整性', status: draft.mappings.every((item) => item.fields?.length >= 3) ? 'passed' : 'failed', detail: '关键字段满足模板最低要求。' },
    { name: '关系与事件可追溯', status: draft.relationships.length && draft.mappings.every((item) => item.event) ? 'passed' : 'failed', detail: '对象关系和事件驱动更新已定义。' },
    { name: '数据分级与审批边界', status: draft.governance.sensitivity && draft.governance.approval ? 'passed' : 'failed', detail: `数据分级：${draft.governance.sensitivity}；发布审批：${draft.governance.approval}。` }
  ];
  draft.validation = { status: checks.every((item) => item.status === 'passed') ? 'passed' : 'failed', checks, checkedAt: now(), checkedBy: role.name };
  draft.status = draft.validation.status === 'passed' ? 'validated' : 'draft';
  draft.updatedAt = now();
  draft.audit.unshift({ time: now(), actor: role.name, action: '校验世界模型草稿', detail: `校验结果：${draft.validation.status}` });
  return { value: drafts, result: { draft } };
  });
};

export const publishWorldModelDraft = (id, role) => {
  if (!canPublish(role)) return { error: '仅管理层可发布世界模型配置版本。' };
  return mutateWithDomainEvent({ namespace: WORLD_NAMESPACE, key: semanticTenantStateKey(WORLD_KEY), initialValue: initialWorldDrafts, mutation: (drafts) => {
  const draft = drafts.find((item) => item.id === id);
  if (!draft) return { commit: false, result: { error: '未找到世界模型草稿。' } };
  if (draft.validation?.status !== 'passed') return { commit: false, result: { error: '请先完成并通过映射校验，再提交发布。' } };
  draft.status = 'published';
  draft.version = `wm-${draft.templateId}-${new Date().toISOString().slice(0, 10).replaceAll('-', '.')}`;
  draft.updatedAt = now();
  draft.audit.unshift({ time: now(), actor: role.name, action: '发布世界模型版本（Demo 模拟）', detail: `${draft.version} 已进入受控生效状态；生产环境仍需审批中心签核。` });
  return { value: drafts, result: { draft }, event: { type: 'governance.world_model.published', tenantId: currentSemanticTenant(), aggregateType: 'WorldModel', aggregateId: draft.id, actor: { type: 'role', id: role.id }, payload: { version: draft.version, templateId: draft.templateId, targetId: draft.targetId, validationStatus: draft.validation.status } } };
  } });
};

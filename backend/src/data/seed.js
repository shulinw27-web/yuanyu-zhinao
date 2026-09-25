import { getDemoConnectedSystems } from './system-catalog.js';

export const roles = {
  executive: {
    id: 'executive', name: '管理层', team: '总控视图', color: '#6d5ce8',
    scopes: ['risk:read', 'risk:approve', 'world:read:aggregate', 'notification:read']
  },
  quality_manager: {
    id: 'quality_manager', name: '质量经理', team: '质量与合规', color: '#1677c8',
    scopes: ['risk:read:quality', 'risk:acknowledge', 'world:read:quality', 'notification:read:quality']
  },
  production_manager: {
    id: 'production_manager', name: '生产负责人', team: '生产运营', color: '#0c9a73',
    scopes: ['risk:read:production', 'world:read:production', 'notification:read:production']
  },
  procurement_manager: {
    id: 'procurement_manager', name: '采购负责人', team: '采购与供应链', color: '#805ad5',
    scopes: ['risk:read:procurement', 'world:read:supply', 'notification:read:procurement']
  },
  marketing_manager: {
    id: 'marketing_manager', name: '市场负责人', team: '市场运营', color: '#cf7a12',
    scopes: ['risk:read:market', 'world:read:market', 'notification:read:market']
  }
};

export const modules = [
  { id: 'production', name: '生产质量', description: '批次、检验、偏差、放行与追溯', status: '已启用', model: '生产子模型' },
  { id: 'marketing', name: '市场运营', description: '订单、渠道、投诉与需求洞察', status: '已启用', model: '市场子模型' },
  { id: 'internal', name: '内务协同', description: '供应商、合同、预算与内部流程', status: '规划中', model: '内务子模型' }
];

// 系统清单已收敛到唯一事实源 data/system-catalog.js。
// 此处保留同名导出以维持既有消费方（platform/public-api、simulation/public-api、
// frontend 的 /api/systems 消费）不变；返回的是 demo 接入样例视图，
// 字段与顺序与历史完全一致。系统类型定义的修改请一律在 system-catalog.js 内进行。
export const connectedSystems = getDemoConnectedSystems();

export const platformStatus = {
  worldModel: '运行中', monitoring: true, monitoringMode: '7 × 24 事件监控', eventStream: '正常', totalEvents: 600,
  eventsPerMinute: 36, riskEngine: '在线', orchestration: '在线', subModels: [
    { name: '生产子模型', status: '在线', load: 42 }, { name: '市场子模型', status: '在线', load: 27 }, { name: '内务子模型', status: '待接入', load: 0 }
  ],
  notifications: { pending: 1, delivered: 7, failed: 0, escalation: 'P0 虚拟电话已开启', voiceProvider: 'Mock' },
  lastModelUpdate: '09:48:22', security: '策略中心与 KMS 正常'
};

export const systemConfigurations = [
  { systemId: 'lims', enabled: true, owner: '质量数字化组', syncInterval: '实时', credentialRef: 'kms://health-prod/lims-reader', mapping: [
    { source: 'lims.test_result', object: 'TestResult', event: 'TestResultCompleted', fields: 'result_id, test_item, result_value, decision' },
    { source: 'lims.sample', object: 'Sample', event: 'SampleReceived', fields: 'sample_id, material_batch_no, collected_at' }
  ]},
  { systemId: 'mes', enabled: true, owner: '制造数字化组', syncInterval: '30 秒', credentialRef: 'kms://health-prod/mes-reader', mapping: [
    { source: 'mes.production_batch', object: 'ProductionBatch', event: 'BatchStatusChanged', fields: 'batch_no, formula_version, line, status' },
    { source: 'mes.deviation', object: 'Deviation', event: 'DeviationRaised', fields: 'deviation_id, batch_no, severity, description' }
  ]},
  { systemId: 'erp', enabled: true, owner: '供应链 IT', syncInterval: '60 秒', credentialRef: 'kms://health-prod/erp-reader', mapping: [
    { source: 'erp.inventory', object: 'Inventory', event: 'InventoryAllocated', fields: 'sku, lot_no, available_qty, expiry_date' },
    { source: 'erp.supplier', object: 'Supplier', event: 'SupplierStatusChanged', fields: 'supplier_id, qualification_status, expiry_date' }
  ]},
  { systemId: 'wms', enabled: true, owner: '仓储数字化组', syncInterval: '30 秒', credentialRef: 'kms://health-prod/wms-reader', mapping: [
    { source: 'wms.inventory_lot', object: 'InventoryLot', event: 'InventoryLotChanged', fields: 'inventory_lot_id, material_batch_id, warehouse_code, location_code, quantity, status' },
    { source: 'wms.inbound_receipt', object: 'InboundReceipt', event: 'InboundReceiptChanged', fields: 'receipt_id, purchase_order_id, material_batch_id, received_qty, received_at, status' }
  ]},
  { systemId: 'qms', enabled: true, owner: '质量数字化组', syncInterval: '实时', credentialRef: 'kms://health-prod/qms-reader', mapping: [
    { source: 'qms.capa', object: 'CAPA', event: 'CAPAStatusChanged', fields: 'capa_id, source_deviation, owner, due_date, status' },
    { source: 'qms.quality_event', object: 'QualityEvent', event: 'QualityEventRaised', fields: 'event_id, product, category, severity, status' }
  ]},
  { systemId: 'oms', enabled: true, owner: '订单运营组', syncInterval: '实时', credentialRef: 'kms://health-prod/oms-webhook', mapping: [
    { source: 'oms.store', object: 'Store', event: 'StoreStatusChanged', fields: 'store_id, store_name, organization_id, region_code, operation_status' },
    { source: 'oms.order', object: 'Order', event: 'OrderStatusChanged', fields: 'order_id, store_id, channel, sku, delivery_status' },
    { source: 'oms.fulfillment', object: 'Fulfillment', event: 'FulfillmentStatusChanged', fields: 'fulfillment_id, order_id, carrier, status, dispatched_at' }
  ]}
];

export const globalConfigurations = {
  monitoring: { enabled: true, p0EscalationMinutes: 5, p1EscalationMinutes: 30, p2DigestMinutes: 480, dataRetentionDays: 365, riskRules: 18 },
  security: { policyMode: 'RBAC + ABAC', kmsMode: '请求级短时凭据', auditRetentionDays: 730 },
  models: { orchestrator: '总控模型', production: '生产子模型', marketing: '市场子模型', internal: '内务子模型（待启用）' }
};

export const procurementScenario = {
  intent: { material: '维生素 C（食品级）', materialCode: 'RM-VC-001', requestedQty: 500, unit: 'kg', requiredDate: '2026-08-10', productionDemand: 'PB-20260812-A / 睡眠营养系列' },
  demand: { available: 120, safetyStock: 80, inTransit: 100, plannedConsumption: 540, shortage: 400, latestOrderDate: '2026-08-03' },
  checks: [
    { name: '生产需求与 BOM', result: '通过', detail: '生产计划消耗 540kg；当前可用量不足。', source: 'MES + ERP' },
    { name: '供应商资质', result: '通过', detail: '2 家合格供应商证书在有效期内。', source: 'QMS + SRM' },
    { name: '质量规格', result: '通过', detail: '需执行 VC-2026 微生物与含量检验计划。', source: 'LIMS' },
    { name: '预算与合同', result: '关注', detail: '最佳交期供应商较合同基准高 2.8%。', source: 'ERP + 合同库' }
  ],
  suppliers: [
    { id: 'SUP-018', name: '华东营养原料有限公司', qualification: '合格', price: 82.5, leadTime: 5, score: 91, certificateUntil: '2027-03-18', recommendation: '推荐', reason: '交期最稳，质量绩效 99.2%，可覆盖生产窗口。' },
    { id: 'SUP-006', name: '康源食品配料有限公司', qualification: '合格', price: 80.2, leadTime: 9, score: 83, certificateUntil: '2026-11-06', recommendation: '备选', reason: '价格较优，但交期压缩后生产缓冲不足。' }
  ],
  policy: { budgetLimit: 50000, estimatedAmount: 33000, approvalRoute: ['采购负责人', '质量经理', '财务经理'], writeGuard: '审批完成前，仅创建草稿采购申请；不写入正式采购订单。' },
  workflow: [
    { id: 'demand', name: '需求与库存核算', system: 'MES / ERP', status: '完成' },
    { id: 'quality', name: '质量与供应商校验', system: 'LIMS / QMS', status: '完成' },
    { id: 'proposal', name: '生成采购方案', system: '总控 AI', status: '完成' },
    { id: 'approval', name: '多角色审批', system: '审批中心', status: '待发起' },
    { id: 'erp', name: '创建 ERP 采购申请', system: 'ERP', status: '待审批' },
    { id: 'notify', name: '通知与审计回写', system: '通知 / 审计', status: '待执行' }
  ],
  audit: [
    { time: '10:18', actor: '总控 AI', action: '生成采购协同方案', detail: '已引用生产需求、库存、质量与供应商资格证据。' },
    { time: '10:18', actor: '策略中心', action: '完成预授权评估', detail: '金额低于预算阈值；正式订单写入需要审批。' }
  ],
  execution: { status: '方案待发起', requisitionId: null, selectedSupplier: 'SUP-018' }
};

export const riskCases = [
  {
    id: 'RC-2026-0042', severity: 'P0', status: '待确认', title: '原料批 RM-20260718 检验异常',
    organizationId: 'org-quality-dept',
    source: 'LIMS · TestResultCompleted', createdAt: '2026-07-30 09:42', owner: '李敏（质量）', ownerUserId: 'usr-003',
    summary: '微生物指标超出内部放行阈值。该原料已被领用于 2 个生产批次，并关联 3 个待发订单。',
    affected: { rawBatches: 1, productionBatches: 2, finishedBatches: 2, inventory: '1,860 瓶', orders: 3 },
    permissions: ['quality_manager', 'production_manager', 'marketing_manager', 'executive'],
    actions: [
      { label: '冻结建议', type: 'recommended', status: '待审批' },
      { label: '通知质量与生产', type: 'notification', status: '已送达' },
      { label: '影响订单脱敏通知', type: 'notification', status: '已送达' }
    ],
    audit: [
      { time: '09:42', actor: '规则引擎', action: '创建 P0 RiskCase', detail: '规则：检验不合格且原料已被领用' },
      { time: '09:42', actor: '总控 AI', action: '生成影响范围说明', detail: '仅检索获授权对象；引用 8 条证据' },
      { time: '09:43', actor: '通知中心', action: '发出通知', detail: '邮件、短信、Webhook 共 6 条' }
    ]
  },
  {
    id: 'RC-2026-0041', severity: 'P1', status: '处理中', title: '成品批 FG-20260721 库存临期风险',
    organizationId: 'org-production-factory-sh',
    source: 'ERP · InventoryAllocated', createdAt: '2026-07-30 08:18', owner: '周航（供应链）', ownerUserId: 'usr-004',
    summary: '渠道 A 的可用库存中存在 360 瓶临近内部周转期限，建议调整订单分配。',
    affected: { rawBatches: 0, productionBatches: 0, finishedBatches: 1, inventory: '360 瓶', orders: 2 },
    permissions: ['production_manager', 'marketing_manager', 'executive'], actions: [], audit: []
  },
  {
    id: 'RC-2026-0038', severity: 'P1', status: '已关闭', title: '渠道投诉聚集：睡眠系列口感反馈',
    organizationId: 'org-market-dept',
    source: 'QMS · QualityEventRaised', createdAt: '2026-07-29 16:05', owner: '陈宁（市场）', ownerUserId: 'usr-005',
    summary: '近 7 天相似投诉 12 条，已完成渠道话术调整及批次关联排查。',
    affected: { rawBatches: 0, productionBatches: 1, finishedBatches: 1, inventory: '—', orders: 0 },
    permissions: ['marketing_manager', 'quality_manager', 'executive'], actions: [], audit: []
  }
];

export const worldGraph = {
  nodes: [
    { id: 'raw', type: 'RawMaterialBatch', label: 'RM-20260718', sub: '原料批 · 检验异常', state: 'exception', sensitivity: '机密' },
    { id: 'test', type: 'TestResult', label: 'TR-88931', sub: '微生物项目不合格', state: 'exception', sensitivity: '质量受限' },
    { id: 'pb1', type: 'ProductionBatch', label: 'PB-20260725-A', sub: '生产批 · 已领用', state: 'affected', sensitivity: '生产受限' },
    { id: 'pb2', type: 'ProductionBatch', label: 'PB-20260726-B', sub: '生产批 · 已领用', state: 'affected', sensitivity: '生产受限' },
    { id: 'fg', type: 'FinishedGoodsBatch', label: 'FG-20260727', sub: '成品批 · 待放行', state: 'affected', sensitivity: '质量受限' },
    { id: 'stock', type: 'Inventory', label: 'INV-SH-01', sub: '库存 · 1,860 瓶', state: 'affected', sensitivity: '运营受限' },
    { id: 'store', type: 'Store', label: 'STORE-SH-001', sub: '上海静安旗舰店 · 营业中', state: 'active', sensitivity: '市场受限' },
    { id: 'order', type: 'Order', label: 'ORD-100238 等 3 单', sub: '订单 · 脱敏可见', state: 'protected', sensitivity: '市场受限' },
    { id: 'risk', type: 'RiskCase', label: 'RC-2026-0042', sub: 'P0 · 待确认', state: 'risk', sensitivity: '跨域受控' }
  ],
  edges: [
    ['raw', 'test', '产生检验结果'], ['raw', 'pb1', '被领用'], ['raw', 'pb2', '被领用'],
    ['pb1', 'fg', '产出'], ['pb2', 'fg', '产出'], ['fg', 'stock', '入库'], ['store', 'order', '产生'], ['stock', 'order', '分配'],
    ['test', 'risk', '触发'], ['fg', 'risk', '影响'], ['order', 'risk', '影响']
  ]
};

export const notificationRecords = [
  { id: 'NT-9001', channel: '邮件', target: 'quality@demo.local', status: '已送达', riskId: 'RC-2026-0042', time: '09:43', policy: 'P0-质量负责人' },
  { id: 'NT-9002', channel: '短信', target: '*** 138 0013', status: '已送达', riskId: 'RC-2026-0042', time: '09:43', policy: 'P0-值班升级' },
  { id: 'NT-9003', channel: 'Webhook', target: 'MES /risk-events', status: '已回执', riskId: 'RC-2026-0042', time: '09:44', policy: '生产协同' },
  { id: 'NT-9004', channel: '邮件', target: 'market@demo.local', status: '已送达', riskId: 'RC-2026-0042', time: '09:44', policy: '订单影响（脱敏）' }
];

export const dashboardMetrics = {
  totalRisks: 3, p0: 1, pendingApprovals: 1, notificationSuccessRate: 100, monitoredEvents: 600
};

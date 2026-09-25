// 系统目录：平台内「业务系统」这一概念的**唯一定义处**（Single Source of Truth）。
//
// 收敛背景：本文件建立前，系统清单分散在 5 个位置且成员与属性互不一致——
//   1. data/seed.js:connectedSystems                        6 个
//   2. services/mcp-connector-service.js:connectorCatalog    7 个
//   3. services/semantic-source-discovery-service.js:systemAliases  12 个
//   4. services/world-model-template-service.js:connectionTargets   8 个
//   5. data/mock-onboarding-catalog.js:mockOnboardingScenarios      每场景硬编码 3 个
// 「以系统为基石」的前提是系统本身有唯一事实源，否则无法对单个系统做生命周期治理。
//
// 多租户约定（重要）：
//   * 本文件描述的是**系统类型**（ERP/WMS/QMS… 这类产品类型），属**平台级**，所有租户共享，
//     不带 tenantId。租户不应修改系统类型本身。
//   * 租户对某系统的**接入实例与生命周期状态**（草稿→已登记→已授权→已连通→已停用）由
//     services/system-registry-service.js 按租户隔离存储，不写在本文件。
//   * 因此本文件里的 demoConnection 只是 demo 租户的默认接入样例值，不是任何租户的真实状态。

const SYSTEM_DEFINITION_LIST = [
  {
    code: 'OA',
    id: 'oa',
    name: 'OA / BPM 审批系统',
    domain: '内务协同',
    aliases: ['oa', 'bpm', '审批', '组织', '流程'],
    connector: {
      id: 'mcp-oa', displayName: 'OA / BPM', status: 'connected_demo', transport: 'MCP over HTTPS',
      credentialRef: 'kms://identity/oa-service-principal', classification: '组织与审批受限',
      dataDomains: ['internal'], objects: ['Person', 'Approval', 'Task'],
      tools: ['read_approval_context'], writeMode: 'approval_required'
    },
    // 连接目标视图中的接入状态。OA 的连接器已登记，但租户尚未完成接入流程——
    // 这与 connector.status 并不矛盾：前者描述「受控连接器目录是否登记」，
    // 后者描述「本租户是否完成接入」。两者此前被混在一处，是本文件要消除的歧义之一。
    onboardingStatus: 'pending_onboarding',
    worldObjectTypes: [],
    demoConnection: null
  },
  {
    code: 'ERP',
    id: 'erp',
    name: 'ERP 供应链与库存系统',
    domain: '供应链',
    aliases: ['erp', '采购', '供应商', '财务', '库存'],
    connector: {
      id: 'mcp-erp', displayName: 'ERP 供应与库存', status: 'connected_demo', transport: 'MCP over HTTPS',
      credentialRef: 'kms://integration/erp-read-write', classification: '供应链受限',
      dataDomains: ['production', 'internal'], objects: ['RawMaterial', 'Product', 'Supplier', 'Budget'],
      tools: ['read_inventory', 'create_procurement_draft'], writeMode: 'draft_and_approval'
    },
    onboardingStatus: 'connected',
    // worldObjectTypes 是「世界模型里被建模的对象」，connector.objects 是「连接器对外暴露的对象」。
    // 两者刻意分开保存：当前它们并不相同（例如 ERP 建模用 Inventory/PurchaseOrder，
    // 连接器暴露 RawMaterial/Budget），合并会改变模型行为。差异已登记为待业务确认项（见 ADR-009）。
    worldObjectTypes: ['Inventory', 'PurchaseOrder', 'Supplier'],
    demoConnection: { mode: 'CDC', status: '延迟', health: 96.4, lastSync: '09:42:06', color: '#cf7a12', alert: '库存分配事件延迟 6 分钟' }
  },
  {
    code: 'WMS',
    id: 'wms',
    name: 'WMS 仓储管理系统',
    domain: '仓储物流',
    aliases: ['wms', '仓储', '仓库', '库位', '入库', '出库'],
    connector: {
      id: 'mcp-wms', displayName: 'WMS 仓储与物流', status: 'connected_demo', transport: 'MCP over HTTPS',
      credentialRef: 'kms://integration/wms-readonly', classification: '仓储运营受限',
      dataDomains: ['production', 'internal'],
      objects: ['InventoryLot', 'Warehouse', 'InboundReceipt', 'OutboundShipment'],
      tools: ['read_inventory_lot', 'read_inbound_receipt'], writeMode: 'read_only'
    },
    onboardingStatus: 'connected',
    worldObjectTypes: ['InventoryLot', 'Warehouse', 'InboundReceipt', 'OutboundShipment'],
    demoConnection: { mode: 'CDC + API', status: '正常', health: 99.92, lastSync: '09:48:16', color: '#2c9bd4' }
  },
  {
    code: 'MES',
    id: 'mes',
    name: 'MES 制造执行系统',
    domain: '生产运营',
    aliases: ['mes', '生产', '制造', '工单', '设备'],
    connector: {
      id: 'mcp-mes', displayName: 'MES 生产执行', status: 'connected_demo', transport: 'MCP over HTTPS',
      credentialRef: 'kms://integration/mes-readonly', classification: '生产受限',
      dataDomains: ['production'], objects: ['Equipment', 'Product', 'ProductionBatch'],
      tools: ['read_production_plan', 'read_equipment_status'], writeMode: 'read_only'
    },
    onboardingStatus: 'connected',
    worldObjectTypes: ['ProductionBatch', 'ProcessStep', 'Deviation'],
    demoConnection: { mode: 'CDC + API', status: '正常', health: 99.96, lastSync: '09:48:19', color: '#0c9a73' }
  },
  {
    code: 'LIMS',
    id: 'lims',
    name: 'LIMS 实验室管理系统',
    domain: '质量与合规',
    aliases: ['lims', '实验室', '检验', '检测', '样品'],
    connector: {
      id: 'mcp-lims', displayName: 'LIMS 质量实验室', status: 'connected_demo', transport: 'MCP over HTTPS',
      credentialRef: 'kms://integration/lims-readonly', classification: '质量受限',
      dataDomains: ['production'], objects: ['RawMaterial', 'Product', 'QualityRecord'],
      tools: ['read_release_status', 'read_coa'], writeMode: 'read_only'
    },
    onboardingStatus: 'connected',
    worldObjectTypes: ['TestResult', 'Specification', 'Sample'],
    demoConnection: { mode: '事件订阅', status: '正常', health: 99.98, lastSync: '09:48:22', color: '#1677c8' }
  },
  {
    code: 'QMS',
    id: 'qms',
    name: 'QMS 质量管理系统',
    domain: '质量与合规',
    aliases: ['qms', '质量', '偏差', 'capa', '放行'],
    connector: {
      id: 'mcp-qms', displayName: 'QMS 质量管理', status: 'connected_demo', transport: 'MCP over HTTPS',
      credentialRef: 'kms://integration/qms-readonly', classification: '质量受限',
      dataDomains: ['production'], objects: ['CAPA', 'ChangeControl', 'QualityEvent'],
      tools: ['read_capa_status', 'read_quality_event'], writeMode: 'read_only'
    },
    onboardingStatus: 'connected',
    worldObjectTypes: ['CAPA', 'ChangeControl', 'QualityEvent'],
    demoConnection: { mode: '事件订阅', status: '正常', health: 99.94, lastSync: '09:48:11', color: '#2f7fd3' }
  },
  {
    code: 'OMS',
    id: 'oms',
    name: 'OMS 订单与门店运营系统',
    domain: '市场运营',
    aliases: ['oms', '销售订单', '客户订单', '门店订单', '门店', '履约', '退货'],
    connector: {
      id: 'mcp-oms', displayName: 'OMS 订单与门店运营', status: 'connected_demo', transport: 'MCP over HTTPS',
      credentialRef: 'kms://integration/oms-desensitized', classification: '订单与门店运营受限',
      dataDomains: ['marketing'], objects: ['Store', 'Order', 'Fulfillment', 'ReturnOrder'],
      tools: ['read_store_status', 'read_order_fulfillment'], writeMode: 'read_only'
    },
    onboardingStatus: 'connected',
    worldObjectTypes: ['Store', 'Order', 'Fulfillment', 'ReturnOrder'],
    demoConnection: { mode: 'Webhook', status: '正常', health: 99.91, lastSync: '09:47:54', color: '#7b67c9' }
  },
  {
    code: 'SRM',
    id: 'srm',
    name: 'SRM 供应商管理系统',
    domain: '供应链',
    aliases: ['srm', '供应商协同'],
    connector: null,
    onboardingStatus: 'pending_onboarding',
    worldObjectTypes: [],
    demoConnection: null
  },
  {
    code: 'MDM',
    id: 'mdm',
    name: 'MDM 主数据管理平台',
    domain: '主数据治理',
    aliases: ['mdm', '主数据'],
    connector: null,
    onboardingStatus: 'not_registered',
    worldObjectTypes: [],
    demoConnection: null
  },
  {
    code: 'PLM',
    id: 'plm',
    name: 'PLM 产品生命周期管理',
    domain: '研发与工程',
    aliases: ['plm', '产品生命周期'],
    connector: null,
    onboardingStatus: 'not_registered',
    worldObjectTypes: [],
    demoConnection: null
  },
  {
    code: 'EAM',
    id: 'eam',
    name: 'EAM 企业资产管理',
    domain: '设备与资产',
    aliases: ['eam', '资产管理'],
    connector: null,
    onboardingStatus: 'not_registered',
    worldObjectTypes: [],
    demoConnection: null
  },
  {
    code: 'IOT',
    id: 'iot',
    name: 'IOT 物联网平台',
    domain: '设备与资产',
    aliases: ['iot', '物联网', '传感器'],
    connector: null,
    onboardingStatus: 'not_registered',
    worldObjectTypes: [],
    demoConnection: null
  }
];

export const systemDefinitions = Object.freeze(SYSTEM_DEFINITION_LIST);

// demo 租户已接入系统的展示顺序。此前该顺序由 seed.js 的数组字面量隐含决定，
// 现显式声明，避免有人调整目录条目顺序时静默改变接口返回顺序与界面顺序。
export const DEMO_CONNECTION_ORDER = Object.freeze(['lims', 'mes', 'erp', 'wms', 'qms', 'oms']);

// 待接入系统的展示顺序。同样显式声明：此前的顺序由 world-model-template-service
// 的字面量决定（SRM 在前、OA 在后），而目录里 OA 排在 SRM 之前。若直接按目录顺序
// 派生会静默改变前端列表顺序，故单独钉住。
export const PENDING_ONBOARDING_ORDER = Object.freeze(['srm', 'oa']);

// ── 角色可见性策略：两套并列声明 ────────────────────────────────────────────
//
// 这两张表**语义不同，不可合并**，此前分别硬编码在两个服务里，现集中到唯一事实源：
//
//   ROLE_DATA_DOMAINS    角色 → 数据域。决定「受控连接器目录」中哪些连接器对该角色可见
//                        （含 OA：连接器已登记，但角色仍需数据域授权）。
//   ROLE_RECORD_SYSTEMS  角色 → 可读取本地受控模拟记录的系统 id。决定「Mock 数据读取器」范围。
//
// 两者的差异是**有意的策略收窄**，不是遗漏：
//   * OA 只在 ROLE_DATA_DOMAINS 中（有连接器），不在 ROLE_RECORD_SYSTEMS 中（无模拟记录集）。
//   * MES 虽属 production 数据域，但 procurement_manager 的 Mock 读取范围被有意排除
//     （采购角色不需要生产执行明细）。此收窄无法从数据域推导，属独立策略。
// 是否统一这两套策略需要业务确认，已登记为 ADR-009 的待决项；当前保持原行为不变。
export const ROLE_DATA_DOMAINS = Object.freeze({
  executive: ['production', 'marketing', 'internal'],
  quality_manager: ['production'],
  production_manager: ['production'],
  procurement_manager: ['production', 'internal'],
  marketing_manager: ['marketing']
});

export const ROLE_RECORD_SYSTEMS = Object.freeze({
  executive: ['lims', 'mes', 'erp', 'wms', 'qms', 'oms'],
  quality_manager: ['lims', 'mes', 'erp', 'wms', 'qms'],
  production_manager: ['lims', 'mes', 'erp', 'wms', 'qms'],
  procurement_manager: ['lims', 'erp', 'wms', 'qms'],
  marketing_manager: ['oms']
});

// ── 接入生命周期状态机 ──────────────────────────────────────────────────────
//
// 每个租户对每个系统的接入是一条独立生命周期。状态只能沿着下列边迁移，
// 非法跃迁必须被拒绝（由 system-registry-service.js 执行）。
//   draft → registered → authorized → connected ⇄ suspended
//   registered/authorized/connected 均可回退到 draft（重新登记）
export const SYSTEM_CONNECTION_STATES = Object.freeze(['draft', 'registered', 'authorized', 'connected', 'suspended']);

export const SYSTEM_CONNECTION_TRANSITIONS = Object.freeze({
  draft: ['registered'],
  registered: ['authorized', 'draft'],
  authorized: ['connected', 'draft'],
  connected: ['suspended'],
  suspended: ['connected', 'draft']
});

// 接通状态 ↔ onboardingStatus 的映射：onboardingStatus 描述「目录侧登记程度」，
// 生命周期状态描述「本租户接入进度」，前者是后者的默认起点。
export const ONBOARDING_STATE_SEED = Object.freeze({
  connected: 'connected',
  pending_onboarding: 'registered',
  not_registered: 'draft'
});

// ── 派生视图（纯函数，无租户上下文，供 data 层与 services 层共用） ──────────
//
// 这两个视图此前是 seed.js 与 world-model-template-service.js 里的字面量数组，
// 现在是目录的纯派生结果。放在 data 层是为了让 data/seed.js 能直接取用而不必
// 反向依赖 services（避免分层反转）。

const catalogById = new Map(SYSTEM_DEFINITION_LIST.map((item) => [item.id, item]));

/**
 * demo 租户的接入样例视图，字段与顺序和历史 connectedSystems 完全一致。
 * 注意：这是**样例默认值**，不是任何租户的真实接入状态。
 */
export function getDemoConnectedSystems() {
  return DEMO_CONNECTION_ORDER.flatMap((id) => {
    const item = catalogById.get(id);
    if (!item || !item.demoConnection) return [];
    const { mode, status, health, lastSync, color, alert } = item.demoConnection;
    return [{
      id: item.id, name: item.name, code: item.code, domain: item.domain, mode, status, health, lastSync,
      objects: [...item.worldObjectTypes], events: 100, color,
      ...(alert ? { alert } : {})
    }];
  });
}

/** 连接目标视图：已接入 + 待接入，保持历史结构与顺序。 */
export function getConnectionTargets() {
  const connected = getDemoConnectedSystems().map((item) => ({ id: item.id, name: item.name, code: item.code, status: '已接入', domain: item.domain }));
  const pending = PENDING_ONBOARDING_ORDER.flatMap((id) => {
    const item = catalogById.get(id);
    return item && item.onboardingStatus === 'pending_onboarding'
      ? [{ id: item.id, name: item.name, code: item.code, status: '待接入', domain: item.domain }]
      : [];
  });
  return [...connected, ...pending];
}

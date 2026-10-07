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

// ── 自定义系统登记物料（2026-09-26 / ADR-024）────────────────────────────────
//
// 背景：接入清单不再预设备待接入/未登记系统（见 registry 的租户接入清单），「新增接入」
// 变成租户自行登记任意命名的系统。登记必须提交一组**必填物料**，目标是让智脑
// 不靠猜就能明白接入的是什么系统：
//   * name / domain / description ——「这是什么系统」：称呼、业务归类、管什么流程；
//   * keyEntities ——「里面有什么数据」：核心业务对象（同时作为世界建模对象面）；
//   * dataDomains ——「授权边界在哪」：接入后按数据域参与角色裁剪；
//   * accessIntention ——「为什么要接」：智脑被期望用它做什么；
//   * businessOwner ——「出了问题找谁」。
// 系统码与模拟数据源场景为可选：系统码缺省由注册表按名称生成并防撞；不挂接模拟
// 场景的自定义系统可以被识别与授权，但不能连通性探测，也就永远到不了 connected。
export const DATA_DOMAIN_OPTIONS = Object.freeze([
  { id: 'production', label: '生产质量', description: '批次、检验、偏差、放行与追溯' },
  { id: 'marketing', label: '市场运营', description: '订单、渠道、投诉与需求洞察' },
  { id: 'internal', label: '内务协同', description: '供应商、合同、预算与内部流程' }
]);

export const SYSTEM_REGISTRATION_FIELDS = Object.freeze([
  { key: 'name', label: '系统名称', required: true, format: 'text', help: '你们怎么称呼这个系统（2–40 字）', constraints: { minLength: 2, maxLength: 40 } },
  { key: 'domain', label: '业务域', required: true, format: 'text', help: '业务归类，例如「供应链」「研发与工程」（2–20 字）', constraints: { minLength: 2, maxLength: 20 } },
  { key: 'description', label: '系统定位说明', required: true, format: 'text', help: '这个系统是干什么的、覆盖哪些业务流程（不少于 10 字）', constraints: { minLength: 10, maxLength: 400 } },
  { key: 'keyEntities', label: '核心业务对象', required: true, format: 'list', help: '该系统管理的主要数据对象，用顿号或逗号分隔（至少 1 个）', constraints: { minItems: 1, maxItems: 12 } },
  { key: 'dataDomains', label: '覆盖数据域', required: true, format: 'dataDomains', help: '接入后按数据域参与角色授权裁剪（至少勾选 1 个）', constraints: { minItems: 1 } },
  { key: 'accessIntention', label: '接入目的', required: true, format: 'text', help: '智脑要用这个系统做什么：读什么数据、支撑什么业务（不少于 10 字）', constraints: { minLength: 10, maxLength: 400 } },
  { key: 'businessOwner', label: '业务责任人', required: true, format: 'text', help: '该系统接入后的业务第一责任人（2–30 字）', constraints: { minLength: 2, maxLength: 30 } },
  { key: 'code', label: '系统码', required: false, format: 'code', help: '留空则按名称自动生成；不可占用平台目录保留码', constraints: { pattern: '^[A-Z][A-Z0-9_]{1,15}$' } },
  { key: 'vendor', label: '厂商 / 供应商', required: false, format: 'text', help: '系统供应方，便于后续连接器对接（不超过 40 字）', constraints: { maxLength: 40 } },
  { key: 'mockScenarioId', label: '模拟数据源场景', required: false, format: 'mockScenario', help: '演示环境的连通性探测数据面；不挂接则无法探测，也就不能接通', constraints: {} },
  // ── 连接配置段（ADR-028，2026-10-06）──────────────────────────────────
  // 触发 ADR-024 复审条件 1：登记物料从「业务描述性」扩展到「连接配置引用」。
  // 凭据永不进登记物料，只存 credentialRef（Key Center 引用），与平台系统 connector.credentialRef 一致。
  { key: 'attachmentDocuments', label: '附加文档（接口说明 / 数据字典）', required: false, format: 'documentAttachments', help: '可选 0–N 份 PDF / DOCX / XLSX 文档；只持久化提取文本与解析取证、原文件不落地；只进理解上下文与 schema 发现候选、不进 mock 强校验链（5a 边界不变）', constraints: { maxItems: 8 } },
  { key: 'heartbeat', label: '心跳接口（连通性测试）', required: true, format: 'heartbeat', help: '目标系统提供的健康检查 URL；智脑按授权方式调用，断言预期状态码与返回体。心跳通过只证明网络可达 + 服务应答，不证明业务接口可用——接通仍需人工签字', constraints: {} },
  { key: 'auth', label: '授权方式（智脑如何访问到）', required: true, format: 'auth', help: '默认用户令牌透传（智脑不持有凭据、转发当前用户 SSO 令牌）；后台场景退到服务主体凭据（Key Center 保管、声明 scope、写操作仍需用户审批）', constraints: {} }
]);

// ── 授权方式选项（ADR-028）──────────────────────────────────────────────
// a. user_token_passthrough      —— 智脑不持有凭据，转发当前用户 SSO 令牌；服从「智脑不提权」纪律。
// b. service_principal            —— 智脑持有服务主体凭据（client_credentials），可后台执行；
//                                    必须声明 scope + 写操作仍需用户审批。
// c. api_key                      —— 静态 API Key，Key Center 保管，请求头带 X-API-Key；
//                                    适用于无 OAuth 的 SaaS 接口，写操作仍需用户审批。
// d. oauth_authorization_code     —— OAuth 2.0 授权码流：用户授权后换 token；
//                                    需 credentialRef（存 client_secret）+ redirectUri。
// e. mTLS                         —— 双向 TLS：客户端证书由 Key Center 保管，
//                                    请求不用 Authorization 头、用 TLS 层签名；心跳只验证可达。
export const AUTH_SCHEME_OPTIONS = Object.freeze([
  { id: 'user_token_passthrough', label: '用户令牌透传', description: '智脑不持有凭据，调用时转发当前用户 SSO 令牌；目标系统与智脑共用 IdP。服从「智脑不提权」——智脑能调用的，当前用户自己也能调用。', requiresCredentialRef: false },
  { id: 'service_principal', label: '服务主体凭据', description: '智脑在目标系统注册为受信应用，凭据存 Key Center；与用户会话解耦，可后台执行。必须声明 scope + 写操作仍需用户审批。', requiresCredentialRef: true },
  { id: 'api_key', label: 'API Key', description: '静态 API Key 存 Key Center，请求头带 X-API-Key；适用于无 OAuth 的 SaaS 接口。写操作仍需用户审批。', requiresCredentialRef: true },
  { id: 'oauth_authorization_code', label: 'OAuth 授权码', description: 'OAuth 2.0 授权码流：用户在目标系统授权后，智脑用 authorization_code 换 access_token；需 credentialRef（存 client_secret）+ redirectUri。', requiresCredentialRef: true },
  { id: 'mTLS', label: '双向 TLS', description: '客户端证书由 Key Center 保管，TLS 握手时签名；心跳只验证网络可达，不需要 Authorization 头。', requiresCredentialRef: true }
]);


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
//   connected → degraded（心跳连续失败自动降级，ADR-028）
//   degraded → connected（人工裁定恢复）/ degraded → suspended（人工停用）
//   registered/authorized/connected 均可回退到 draft（重新登记）
export const SYSTEM_CONNECTION_STATES = Object.freeze(['draft', 'registered', 'authorized', 'connected', 'suspended', 'degraded']);

export const SYSTEM_CONNECTION_TRANSITIONS = Object.freeze({
  draft: ['registered'],
  registered: ['authorized', 'draft'],
  authorized: ['connected', 'draft'],
  connected: ['suspended', 'degraded'],
  suspended: ['connected', 'draft'],
  degraded: ['connected', 'suspended']
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

/**
 * 连接目标视图：已接入的演示样例系统。2026-09-26（ADR-024）起不再派生「待接入」目标——
 * 接入清单完全由租户自行登记，平台不预设备任何待接入/未登记系统；SRM/OA 的历史
 * 待接入目标随之移除，相关元模型连接模板保留但需先有租户登记的对应目标才可用。
 */
export function getConnectionTargets() {
  return getDemoConnectedSystems().map((item) => ({ id: item.id, name: item.name, code: item.code, status: '已接入', domain: item.domain }));
}

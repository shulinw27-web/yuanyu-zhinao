// 系统注册表测试：验证「单一系统事实源」与「多租户接入生命周期」。
//
// 这个测试的存在意义不是覆盖新代码，而是把 5 处历史重复定义**钉住**：
// 只要有人再在别处新增一份系统清单、或调整目录成员/顺序导致接口输出变化，
// 这里必须失败，改动必须是有意的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { connectedSystems } from '../src/data/seed.js';
import { mockOnboardingScenarios } from '../src/data/mock-onboarding-catalog.js';
import { getMcpConnectors } from '../src/services/mcp-connector-service.js';
import { detectRequestedSemanticSystems, discoverSemanticSources } from '../src/services/semantic-source-discovery-service.js';
import { getEnterpriseConnectorReadiness } from '../src/services/system-integration-service.js';
import { getWorldModelConnectionTargets } from '../src/services/world-model-template-service.js';
import {
  getSystemDefinitions, getSystemByCode, getSystemRegistrySnapshot,
  getConnectorSurfaceSystemCodes, getRecordSurfaceSystemIds, detectSystemCodesInText,
  getTenantSystemConnections, getTenantSystemConnection, getTenantSystemDefinition,
  registerTenantCustomSystem, transitionSystemConnection, canTransitionSystemConnection, SYSTEM_REGISTRY_NAMESPACE,
  getSystemRegistrationSchema
} from '../src/services/system-registry-service.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Use the runtime-test-bootstrap memory store.');

const identity = (tenantId) => ({ tenantId, subjectId: 'registry-tester', deviceId: 'device-1' });
const within = (tenantId, work) => runWithSemanticTenant(identity(tenantId), work);

// 自定义系统登记物料（ADR-024）：覆盖七个必填项的最小合法样例。
const registrationMaterials = (overrides = {}) => ({
  name: '供应商协同中台',
  domain: '供应链',
  description: '管理供应商准入、资质、绩效与合同协同的外部平台，覆盖寻源到付款全流程。',
  keyEntities: ['供应商档案', '绩效评分', '合同'],
  dataDomains: ['production', 'internal'],
  accessIntention: '读取供应商资质与绩效数据，支撑采购风险分析与供应商画像。',
  businessOwner: '采购负责人',
  heartbeat: { endpoint: 'https://api.example.com/health', method: 'GET', expectedStatus: 200, timeoutMs: 5000 },
  auth: { scheme: 'user_token_passthrough', writeApprovalRequired: true },
  ...overrides
});

test.beforeEach(() => resetRuntimeState([SYSTEM_REGISTRY_NAMESPACE]));

test('唯一事实源：5 处历史系统定义全部由注册表派生', () => {
  const snapshot = getSystemRegistrySnapshot();
  assert.equal(snapshot.definitionCount, 12);
  assert.deepEqual(snapshot.duplicateChecks, { uniqueCodes: true, uniqueIds: true, uniqueConnectorIds: true });
  assert.deepEqual(snapshot.connectorCodes, ['OA', 'ERP', 'WMS', 'MES', 'LIMS', 'QMS', 'OMS']);
  assert.deepEqual(snapshot.onboardingConnected, ['ERP', 'WMS', 'MES', 'LIMS', 'QMS', 'OMS']);
  assert.deepEqual(snapshot.onboardingPending, ['OA', 'SRM']);
  assert.deepEqual(snapshot.onboardingUnregistered, ['MDM', 'PLM', 'EAM', 'IOT']);

  // 处 1：data/seed.js 的 connectedSystems
  assert.deepEqual(connectedSystems.map((item) => item.id), ['lims', 'mes', 'erp', 'wms', 'qms', 'oms']);
  // 处 2：受控连接器目录
  assert.deepEqual(getMcpConnectors('executive').connectors.map((item) => item.system), ['OA', 'ERP', 'WMS', 'MES', 'LIMS', 'QMS', 'OMS']);
  // 处 3：文本别名表（12 个系统，顺序即目录声明顺序）
  assert.deepEqual(getSystemDefinitions().map((item) => item.code), ['OA', 'ERP', 'WMS', 'MES', 'LIMS', 'QMS', 'OMS', 'SRM', 'MDM', 'PLM', 'EAM', 'IOT']);
  // 处 4：世界模型连接目标（2026-09-26 起只派生 6 个已接入演示样例，不再预设备待接入目标）
  assert.deepEqual(getWorldModelConnectionTargets().map((item) => item.id), ['lims', 'mes', 'erp', 'wms', 'qms', 'oms']);
  // 处 5：模拟接入场景
  assert.deepEqual(mockOnboardingScenarios.map((scenario) => scenario.systems), [['OMS', 'ERP', 'WMS'], ['QMS', 'MES', 'WMS']]);
});

test('兼容视图：connectedSystems 字段与顺序与历史逐字段一致', () => {
  assert.equal(connectedSystems.length, 6);
  assert.deepEqual(connectedSystems[2], {
    id: 'erp', name: 'ERP 供应链与库存系统', code: 'ERP', domain: '供应链', mode: 'CDC', status: '延迟',
    health: 96.4, lastSync: '09:42:06', objects: ['Inventory', 'PurchaseOrder', 'Supplier'], events: 100,
    color: '#cf7a12', alert: '库存分配事件延迟 6 分钟'
  });
  // 只有 ERP 带 alert，其余不带该键（避免前端出现 `undefined` 提示条）
  assert.deepEqual(connectedSystems.filter((item) => 'alert' in item).map((item) => item.id), ['erp']);
  // 世界模型对象与连接器暴露对象是两组不同的集合，本阶段刻意未合并
  const erp = getSystemByCode('ERP');
  assert.deepEqual([...erp.worldObjectTypes], ['Inventory', 'PurchaseOrder', 'Supplier']);
  assert.deepEqual([...erp.connector.objects], ['RawMaterial', 'Product', 'Supplier', 'Budget']);
});

test('角色可见性：连接器面与记录面是两套并列策略，差异是有意的', () => {
  const snapshot = getSystemRegistrySnapshot();
  // 连接器面（数据域推导）
  assert.deepEqual(getConnectorSurfaceSystemCodes('executive'), ['OA', 'ERP', 'WMS', 'MES', 'LIMS', 'QMS', 'OMS']);
  assert.deepEqual(getConnectorSurfaceSystemCodes('marketing_manager'), ['OMS']);
  // 记录面（显式策略，含对采购角色的有意收窄）
  assert.deepEqual(getRecordSurfaceSystemIds('executive'), ['lims', 'mes', 'erp', 'wms', 'qms', 'oms']);
  assert.deepEqual(getRecordSurfaceSystemIds('procurement_manager'), ['lims', 'erp', 'wms', 'qms']);
  // 两处差异非疏漏：OA 有连接器无模拟记录；MES 对采购角色被显式排除
  assert.ok(getConnectorSurfaceSystemCodes('procurement_manager').includes('OA'));
  assert.ok(!getRecordSurfaceSystemIds('procurement_manager').includes('mes'));
  // 策略快照被钉住，任何调整都必须在此显式反映
  assert.deepEqual(snapshot.roleDataDomains.procurement_manager, ['production', 'internal']);
  assert.deepEqual(snapshot.recordSurface.procurement_manager, ['lims', 'erp', 'wms', 'qms']);
  // 记录面仍驱动就绪度视图
  assert.deepEqual(getEnterpriseConnectorReadiness('marketing_manager').map((item) => item.systemId), ['oms']);
  assert.deepEqual(getEnterpriseConnectorReadiness('executive').map((item) => item.systemId), ['lims', 'mes', 'erp', 'wms', 'qms', 'oms']);
});

test('文本系统识别：显式码优先、别名回退、未登记系统也可被认知', () => {
  assert.deepEqual(detectSystemCodesInText('分析 ERP 和 WMS'), ['ERP', 'WMS']);
  assert.deepEqual(detectRequestedSemanticSystems('分析 ERP 和 WMS，建立采购订单与库存之间的语义模型。'), ['ERP', 'WMS']);
  // 别名回退（无显式码命中）
  assert.deepEqual(detectSystemCodesInText('看看实验室记录和质量的偏差'), ['LIMS', 'QMS']);
  // 未登记任何连接器的系统仍在目录内（体现「平台认知」，不代表可接入）
  assert.deepEqual(detectSystemCodesInText('把主数据和物联网平台也纳入'), ['MDM', 'IOT']);
  // 空文本不得回落为任何系统——这正是阶段 3 要修掉的「静默放大范围」
  assert.deepEqual(detectSystemCodesInText(''), []);
  assert.deepEqual(detectSystemCodesInText('帮我建个模型'), []);
});

test('多租户：接入清单＝Mock 演示样例＋租户登记，绝不预设备待接入/未登记系统', () => {
  // 预设成员只有 6 个 Mock 已连通系统；pending_onboarding / not_registered 的目录类型
  // （OA/SRM/MDM/PLM/EAM/IOT）一律不进租户清单——接入什么系统完全由租户自己登记（ADR-024）。
  const base = within('company-b', () => getTenantSystemConnections());
  assert.deepEqual(base.map((item) => item.code), ['ERP', 'WMS', 'MES', 'LIMS', 'QMS', 'OMS']);
  assert.ok(base.every((item) => item.lifecycleState === 'connected'));
  for (const code of ['OA', 'SRM', 'MDM', 'PLM', 'EAM', 'IOT']) {
    assert.equal(within('company-b', () => getTenantSystemConnection(code)), null, `${code} 不得被预设备进租户接入清单`);
  }

  // 租户 A 登记自定义系统：定义与生命周期都只落在 A 的租户工作区。
  const registered = within('company-a', () => registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SCMX' }), actor: { id: 'architect' } }));
  assert.equal(registered.code, 'SCMX');
  assert.equal(registered.state, 'registered');
  const connection = within('company-a', () => getTenantSystemConnection('SCMX'));
  assert.equal(connection.lifecycleState, 'registered');
  assert.equal(connection.tenantId, 'company-a');
  assert.equal(connection.origin, 'tenant_custom');
  assert.equal(within('company-a', () => getTenantSystemConnections().length), 7);

  // 租户 B 完全不受影响：看不到 A 的自定义系统，清单仍是 6 个演示样例。
  assert.equal(within('company-b', () => getTenantSystemConnection('SCMX')), null);
  assert.equal(within('company-b', () => getTenantSystemConnections().length), 6);
});

test('登记：必填物料逐字段点名，系统码防撞与自动生成', () => {
  within('company-a', () => {
    // 缺必填物料：每个缺失字段都必须被点名，不能只报一句「校验未通过」。
    const invalid = registerTenantCustomSystem({ materials: { name: 'x' }, actor: { id: 'a' } });
    assert.equal(invalid.code, 'SYSTEM_MATERIALS_INVALID');
    const fields = new Set(invalid.issues.map((issue) => issue.field));
    for (const key of ['domain', 'description', 'keyEntities', 'dataDomains', 'accessIntention', 'businessOwner']) {
      assert.ok(fields.has(key), `缺失物料 ${key} 必须被点名`);
    }
    // 未知的模拟数据源场景与非法数据域同样显式拒绝
    const badScenario = registerTenantCustomSystem({ materials: registrationMaterials({ mockScenarioId: 'nope' }), actor: { id: 'a' } });
    assert.equal(badScenario.code, 'SYSTEM_MATERIALS_INVALID');
    assert.ok(badScenario.issues.some((issue) => issue.field === 'mockScenarioId'));
    const badDomain = registerTenantCustomSystem({ materials: registrationMaterials({ dataDomains: ['secret'] }), actor: { id: 'a' } });
    assert.ok(badDomain.issues.some((issue) => issue.field === 'dataDomains'));
    // 平台保留码不得占用
    assert.equal(registerTenantCustomSystem({ materials: registrationMaterials({ code: 'ERP' }), actor: { id: 'a' } }).code, 'SYSTEM_CODE_RESERVED');
    // 同租户已占用码显式拒绝，不静默改名
    registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SCMX' }), actor: { id: 'a' } });
    const taken = registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SCMX', name: '另一个系统' }), actor: { id: 'a' } });
    assert.equal(taken.code, 'SYSTEM_CODE_TAKEN');
    // 自动生成：纯中文名取不到 ASCII 段 → SYS 兜底，重名自动加序号
    assert.equal(registerTenantCustomSystem({ materials: registrationMaterials(), actor: { id: 'a' } }).code, 'SYS');
    assert.equal(registerTenantCustomSystem({ materials: registrationMaterials(), actor: { id: 'a' } }).code, 'SYS2');
  });
});

test('接入状态机：非法跃迁不落库、未知系统与缺失主体一律拒绝', () => {
  assert.equal(canTransitionSystemConnection('draft', 'connected'), false);
  assert.equal(canTransitionSystemConnection('registered', 'authorized'), true);
  assert.equal(canTransitionSystemConnection('connected', 'registered'), false);
  assert.equal(canTransitionSystemConnection('connected', 'suspended'), true);

  within('company-a', () => {
    registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SRMP' }), actor: { id: 'architect' } });
    const before = getTenantSystemConnection('SRMP');
    // registered → connected 是跨级跃迁，必须拒绝
    const illegal = transitionSystemConnection({ code: 'SRMP', to: 'connected', actor: { id: 'architect' } });
    assert.equal(illegal.code, 'SYSTEM_TRANSITION_REJECTED');
    assert.equal(illegal.from, 'registered');
    const after = getTenantSystemConnection('SRMP');
    assert.equal(after.lifecycleState, 'registered');
    // 被拒绝的跃迁不得写入：updatedAt 不应发生变化
    assert.equal(after.updatedAt, before.updatedAt);

    assert.equal(transitionSystemConnection({ code: 'ZZZ', to: 'registered', actor: { id: 'a' } }).code, 'SYSTEM_NOT_REGISTERED');
    // 平台保留类型未登记进本租户清单：给出「先登记」的指引，而不是笼统拒绝
    const reserved = transitionSystemConnection({ code: 'OA', to: 'authorized', actor: { id: 'a' } });
    assert.equal(reserved.code, 'SYSTEM_ACCESS_MISSING');
    assert.match(reserved.error, /平台目录保留类型/);
    assert.equal(transitionSystemConnection({ code: 'SRMP', to: 'bogus', actor: { id: 'a' } }).code, 'SYSTEM_STATE_UNKNOWN');
    assert.equal(transitionSystemConnection({ code: 'SRMP', to: 'authorized' }).code, 'SYSTEM_ACTOR_REQUIRED');
  });
});

test('来源发现仍可用，且未登记连接器的系统被明确标注为 not_registered', () => {
  const discovered = discoverSemanticSources({ request: '分析 ERP 和 WMS 的库存与入库单', role: 'executive' });
  assert.deepEqual(discovered.requestedSystems, ['ERP', 'WMS']);
  assert.deepEqual(discovered.sources.map((item) => item.code), ['ERP', 'WMS']);
  assert.ok(discovered.sources.every((item) => item.authorized));
  assert.deepEqual(discovered.registeredSystems, ['ERP', 'LIMS', 'MES', 'OA', 'OMS', 'QMS', 'WMS']);

  const unregistered = discoverSemanticSources({ request: '把 SRM 也纳入', role: 'executive' });
  assert.deepEqual(unregistered.sources.map((item) => item.status), ['not_registered']);
  assert.ok(unregistered.blockers.some((line) => line.startsWith('SRM')));
});

// ── 连接配置段（ADR-028，2026-10-06）──────────────────────────────────────
// 登记物料从「业务描述性」扩展到「连接配置段」：附加文档（可选）+ 心跳接口（必填）+ 授权方式（必填）。
// 凭据永不进登记物料，只存 credentialRef（Key Center 引用）。

const validHeartbeat = { endpoint: 'https://api.supplier.example.com/health', method: 'GET', expectedStatus: 200, timeoutMs: 5000 };
const validUserTokenAuth = { scheme: 'user_token_passthrough', writeApprovalRequired: true };
const validServicePrincipalAuth = {
  scheme: 'service_principal',
  credentialRef: 'kms://integration/supplier-service-principal',
  scope: ['read:supplier', 'read:contract'],
  writeApprovalRequired: true
};

test('登记物料 schema 下发连接配置段：heartbeat/auth 必填、attachmentDocuments 可选、authSchemes 选项齐全', () => {
  const schema = getSystemRegistrationSchema();
  const requiredKeys = schema.fields.filter((field) => field.required).map((field) => field.key);
  assert.ok(requiredKeys.includes('heartbeat'), 'heartbeat 必填');
  assert.ok(requiredKeys.includes('auth'), 'auth 必填');
  assert.ok(!requiredKeys.includes('attachmentDocuments'), 'attachmentDocuments 可选');
  assert.deepEqual(schema.authSchemes.map((option) => option.id), ['user_token_passthrough', 'service_principal', 'api_key', 'oauth_authorization_code', 'mTLS']);
  // service_principal 必须要求 credentialRef
  const sp = schema.authSchemes.find((option) => option.id === 'service_principal');
  assert.equal(sp.requiresCredentialRef, true);
  const utp = schema.authSchemes.find((option) => option.id === 'user_token_passthrough');
  assert.equal(utp.requiresCredentialRef, false);
});

test('正例：登记带用户令牌透传授权与心跳的自定义系统——落库并披露连接配置段', () => {
  const registered = within('conn-tenant-a', () => registerTenantCustomSystem({
    materials: registrationMaterials({ code: 'SCMA', heartbeat: validHeartbeat, auth: validUserTokenAuth }),
    actor: { id: 'architect' }
  }));
  assert.equal(registered.code, 'SCMA');
  assert.equal(registered.state, 'registered');
  const view = within('conn-tenant-a', () => getTenantSystemDefinition('SCMA'));
  assert.ok(view, '自定义系统应入租户清单');
  assert.equal(view.origin, 'tenant_custom');
  assert.deepEqual(view.heartbeat, validHeartbeat);
  assert.deepEqual(view.auth, validUserTokenAuth);
  assert.equal(view.connector, null, '8-1 阶段 connector 保持 null，探测升级在 8-2');
});

test('正例：登记带服务主体凭据与文档物料的自定义系统——credentialRef 与 scope 落库', () => {
  const doc = { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dataUrl: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBA==' };
  const registered = within('conn-tenant-b', () => registerTenantCustomSystem({
    materials: registrationMaterials({ code: 'SCMB', heartbeat: validHeartbeat, auth: validServicePrincipalAuth, attachmentDocuments: [doc] }),
    actor: { id: 'architect' }
  }));
  assert.equal(registered.code, 'SCMB');
  const view = within('conn-tenant-b', () => getTenantSystemDefinition('SCMB'));
  assert.deepEqual(view.auth, validServicePrincipalAuth);
  assert.equal(view.attachmentDocuments.length, 1);
  assert.deepEqual(view.attachmentDocuments[0], doc);
});

test('反例：心跳 endpoint 缺失或非法 URL', () => {
  const noEndpoint = within('conn-c', () => registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SCMC', heartbeat: { method: 'GET' }, auth: validUserTokenAuth }), actor: { id: 'a' } }));
  assert.equal(noEndpoint.code, 'SYSTEM_MATERIALS_INVALID');
  assert.ok(noEndpoint.issues.some((issue) => issue.field === 'heartbeat' && /endpoint 为必填/.test(issue.message)));
  const badUrl = within('conn-c', () => registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SCMC2', heartbeat: { endpoint: 'not-a-url' }, auth: validUserTokenAuth }), actor: { id: 'a' } }));
  assert.equal(badUrl.code, 'SYSTEM_MATERIALS_INVALID');
  assert.ok(badUrl.issues.some((issue) => issue.field === 'heartbeat' && /合法的 http\/https URL/.test(issue.message)));
});

test('反例：授权方式缺失、未知 scheme、service_principal 缺 credentialRef 或 scope', () => {
  // 用 auth: null 覆盖 helper 的默认值，确证「无 auth」被拒
  const noAuth = within('conn-d', () => registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SCMD', heartbeat: validHeartbeat, auth: null }), actor: { id: 'a' } }));
  assert.equal(noAuth.code, 'SYSTEM_MATERIALS_INVALID');
  assert.ok(noAuth.issues.some((issue) => issue.field === 'auth' && /必填项/.test(issue.message)));
  const unknownScheme = within('conn-d', () => registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SCMD2', heartbeat: validHeartbeat, auth: { scheme: 'basic_auth' } }), actor: { id: 'a' } }));
  assert.equal(unknownScheme.code, 'SYSTEM_MATERIALS_INVALID');
  assert.ok(unknownScheme.issues.some((issue) => /未知的授权方式/.test(issue.message)));
  const noCred = within('conn-d', () => registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SCMD3', heartbeat: validHeartbeat, auth: { scheme: 'service_principal', scope: ['read:x'] } }), actor: { id: 'a' } }));
  assert.equal(noCred.code, 'SYSTEM_MATERIALS_INVALID');
  assert.ok(noCred.issues.some((issue) => /必须提供 credentialRef/.test(issue.message)));
  const badCred = within('conn-d', () => registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SCMD4', heartbeat: validHeartbeat, auth: { scheme: 'service_principal', credentialRef: 'http://bad', scope: ['read:x'] } }), actor: { id: 'a' } }));
  assert.equal(badCred.code, 'SYSTEM_MATERIALS_INVALID');
  assert.ok(badCred.issues.some((issue) => /kms:\/\/ 开头/.test(issue.message)));
  const noScope = within('conn-d', () => registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SCMD5', heartbeat: validHeartbeat, auth: { scheme: 'service_principal', credentialRef: 'kms://integration/x' } }), actor: { id: 'a' } }));
  assert.equal(noScope.code, 'SYSTEM_MATERIALS_INVALID');
  assert.ok(noScope.issues.some((issue) => /必须声明 scope/.test(issue.message)));
});

test('反例：用户令牌透传方式不得带 credentialRef（智脑不持有凭据）', () => {
  const withCred = within('conn-e', () => registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SCME', heartbeat: validHeartbeat, auth: { scheme: 'user_token_passthrough', credentialRef: 'kms://integration/x' } }), actor: { id: 'a' } }));
  assert.equal(withCred.code, 'SYSTEM_MATERIALS_INVALID');
  assert.ok(withCred.issues.some((issue) => /不需要 credentialRef/.test(issue.message)));
});

test('反例：附加文档 dataUrl 非法、超过 8 份', () => {
  const badDataUrl = within('conn-f', () => registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SCMF', heartbeat: validHeartbeat, auth: validUserTokenAuth, attachmentDocuments: [{ mimeType: 'application/pdf', dataUrl: 'https://not-data-url' }] }), actor: { id: 'a' } }));
  assert.equal(badDataUrl.code, 'SYSTEM_MATERIALS_INVALID');
  assert.ok(badDataUrl.issues.some((issue) => issue.field === 'attachmentDocuments' && /data:.*;base64,/.test(issue.message)));
  const tooMany = Array.from({ length: 9 }, () => ({ mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBERi0=' }));
  const overflow = within('conn-f', () => registerTenantCustomSystem({ materials: registrationMaterials({ code: 'SCMF2', heartbeat: validHeartbeat, auth: validUserTokenAuth, attachmentDocuments: tooMany }), actor: { id: 'a' } }));
  assert.equal(overflow.code, 'SYSTEM_MATERIALS_INVALID');
  assert.ok(overflow.issues.some((issue) => issue.field === 'attachmentDocuments' && /最多 8 份/.test(issue.message)));
});

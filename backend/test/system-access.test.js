// 系统接入（阶段 2）专项测试。
//
// 覆盖四类风险，全部以实测行为为断言对象，不做文档推断：
//   1. 单一事实源：总览/详情的系统成员与顺序必须由注册表派生，不得出现第二份清单。
//   2. 多租户：接入生命周期与探测结果按租户隔离，且只认受信上下文里的租户。
//   3. 授权与阻断：越权、未登记连接器一律显式拒绝，不静默降级为「成功」。
//   4. 连通性探测是真的：会监听端口、发分页请求、校验响应契约；故障模式必须显式失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { handleGovernanceRoutes } from '../src/routes/governance-routes.js';
import { getSystemRegistrySnapshot, transitionSystemConnection, getTenantSystemConnection } from '../src/services/system-registry-service.js';
import { getRole } from '../src/services/authorization-service.js';
import {
  SYSTEM_ACCESS_BOUNDARY,
  getSystemAccessOverview,
  getSystemAccessDetail,
  probeSystemConnection,
  transitionTenantSystemConnection,
  getSystemProbeResults
} from '../src/services/system-access-service.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Use the runtime-test-bootstrap memory store.');

const NAMESPACES = ['system_access_runtime', 'system_registry_runtime'];
const executiveRole = getRole('executive');
const identity = tenantId => ({ tenantId, subjectId: 'same-operator', deviceId: 'same-device' });
const within = (tenant, work) => runWithSemanticTenant(identity(tenant), work);

test.beforeEach(() => resetRuntimeState(NAMESPACES));

// ── 1. 单一事实源 ────────────────────────────────────────────────────────────

test('总览：系统成员与顺序完全由注册表派生，且七项呈现字段齐备', async () => {
  const registry = getSystemRegistrySnapshot();
  const overview = await getSystemAccessOverview({ roleId: 'executive' });
  assert.deepEqual(overview.systems.map((item) => item.code), registry.codes, '总览成员/顺序必须由注册表派生');
  assert.equal(overview.boundary, SYSTEM_ACCESS_BOUNDARY);
  for (const item of overview.systems) {
    for (const key of ['lifecycleState', 'authorized', 'objects', 'worldObjectTypes', 'mappingCount', 'owner', 'health', 'probe']) {
      assert.ok(Object.hasOwn(item, key), `${item.code} 缺少呈现字段 ${key}`);
    }
    // 连接器面对象目录与世界模型建模对象是两个轴，不得被合并成一份
    if (item.connector) assert.deepEqual(item.objects, item.connector.objects);
    assert.notStrictEqual(item.objects, item.worldObjectTypes);
  }
  assert.equal(overview.summary.total, registry.codes.length);
  assert.equal(overview.summary.connected, registry.onboardingConnected.length);
});

test('详情：字段目录来自合成数据字典，未建目录的系统显式说明原因而非留空占位', async () => {
  const erp = await getSystemAccessDetail({ code: 'ERP', roleId: 'executive' });
  assert.equal(erp.fieldCatalog.available, true);
  assert.ok(erp.fieldCatalog.tables.length > 0);
  for (const table of erp.fieldCatalog.tables) {
    assert.ok(table.primaryKey, `${table.name} 必须显式声明主键`);
    assert.ok(table.fields.some((field) => field.name === table.primaryKey && field.primaryKey));
  }
  const srm = await getSystemAccessDetail({ code: 'SRM', roleId: 'executive' });
  assert.equal(srm.fieldCatalog.available, false);
  assert.equal(srm.fieldCatalog.tables.length, 0);
  assert.match(srm.fieldCatalog.unavailableReason, /尚无本地合成数据字典/);
  const missing = await getSystemAccessDetail({ code: 'NOPE', roleId: 'executive' });
  assert.equal(missing.status, 404);
  assert.equal(missing.code, 'SYSTEM_NOT_REGISTERED');
});

test('详情：跨场景声明的同一对象按名字归并，字段声明不一致时显式报冲突而非静默取其一', async () => {
  // 实测数据：WMS 的 StockPosition/Warehouse、OMS 的 SalesOrder 同时被 fulfillment 与
  // quality_incident 两个合成场景声明。早期实现逐场景 push，导致「对象目录」被重复项撑大
  // （WMS 10→实际 8、OMS 8→实际 7），前端还以 name 作 :key 出现重复键。
  for (const [code, expected] of [['WMS', 8], ['OMS', 7]]) {
    const detail = await getSystemAccessDetail({ code, roleId: 'executive' });
    const names = detail.fieldCatalog.tables.map((table) => table.name);
    assert.equal(new Set(names).size, names.length, `${code} 字段目录的对象类型不得重复`);
    assert.equal(names.length, expected, `${code} 对象目录计数必须是归并后的数量`);
    assert.deepEqual(detail.fieldCatalog.objectTypes, names);
  }

  // 归并不等于合并语义：WMS 的 StockPosition 在两个场景里字段声明**确实不同**
  // （fulfillment 含 stock_id/ownership/unit，quality_incident 只有 lot_id/warehouse_id/qty/status）。
  // 这种情况必须显式暴露，不得静默取先出现的那个 —— 否则界面上的"字段目录"会随场景遍历顺序漂移。
  const wms = await getSystemAccessDetail({ code: 'WMS', roleId: 'executive' });
  const stockPosition = wms.fieldCatalog.tables.find((item) => item.name === 'StockPosition');
  assert.equal(stockPosition.scenarioIds.length, 2, 'StockPosition 必须记录两个来源场景');
  const conflict = wms.fieldCatalog.conflicts.find((item) => item.objectType === 'StockPosition');
  assert.ok(conflict, '字段声明不一致必须进入 conflicts');
  assert.deepEqual(conflict.scenarioIds, ['fulfillment', 'quality_incident']);
  assert.match(conflict.detail, /未做自动合并/);

  // Warehouse 在两个场景里声明一致，属正常归并，不应产生冲突。
  assert.ok(!wms.fieldCatalog.conflicts.some((item) => item.objectType === 'Warehouse'));

  // 探测只读取该系统的首个含记录场景，因此目录中的对象不保证都在同一次探测中可见；
  // 详情必须透出这个场景标识，界面才能如实标注。
  assert.equal(wms.fieldCatalog.readScenarioId, 'fulfillment');
  const lims = await getSystemAccessDetail({ code: 'LIMS', roleId: 'executive' });
  assert.equal(lims.fieldCatalog.readScenarioId, 'quality_incident');
});

// ── 2. 多租户 ───────────────────────────────────────────────────────────────

test('多租户：接入生命周期与探测结果按租户隔离，绝不接受请求体里的租户标识', async () => {
  const t = await within('company-a', async () => {
    transitionSystemConnection({ code: 'ERP', to: 'suspended', actor: { id: 'operator-a' }, reason: 'A 租户停用' });
    const probe = await probeSystemConnection({ code: 'ERP', roleId: 'executive', identityScope: identity('company-a') });
    return { state: getTenantSystemConnection('ERP').lifecycleState, lastProbe: probe.code, records: probe.recordCount };
  });
  assert.equal(t.state, 'suspended');
  assert.equal(t.records > 0, true);

  const other = await within('company-b', async () => ({
    state: getTenantSystemConnection('ERP').lifecycleState,
    probe: getSystemProbeResults().probes.ERP || null,
    overviewTenant: (await getSystemAccessOverview({ roleId: 'executive' })).tenantId
  }));
  assert.equal(other.state, 'connected', 'B 租户不得继承 A 租户的接入生命周期');
  assert.equal(other.probe, null, 'B 租户不得看到 A 租户的探测结果');
  assert.equal(other.overviewTenant, 'company-b');

  // 租户标识校验在进入业务逻辑之前同步完成，不依赖调用方传入的 tenantId 字段
  assert.throws(
    () => runWithSemanticTenant({ tenantId: ' bad tenant ' }, () => getSystemAccessOverview({ roleId: 'executive' })),
    (error) => error.code === 'SEMANTIC_TENANT_REQUIRED'
  );
});

// ── 3. 授权与显式阻断 ───────────────────────────────────────────────────────

test('授权：角色按数据域裁剪可见系统，越权与未登记连接器一律显式拒绝', async () => {
  const executive = await getSystemAccessOverview({ roleId: 'executive' });
  const marketing = await getSystemAccessOverview({ roleId: 'marketing_manager' });
  assert.deepEqual(marketing.systems.filter((item) => item.authorized).map((item) => item.code), ['OMS']);
  assert.ok(executive.systems.filter((item) => item.authorized).length > 1);
  // 未授权系统的阻断原因必须可读，而不是留空
  for (const item of marketing.systems.filter((row) => !row.authorized && row.connector)) {
    assert.match(item.blockedReason, /未获该系统所属数据域授权/);
  }
  for (const item of executive.systems.filter((row) => !row.connector)) {
    assert.match(item.blockedReason, /尚未登记受控连接器/);
  }

  const denied = await probeSystemConnection({ code: 'ERP', roleId: 'marketing_manager' });
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'SYSTEM_PROBE_FORBIDDEN');

  const unregistered = await probeSystemConnection({ code: 'SRM', roleId: 'executive' });
  assert.equal(unregistered.status, 409);
  assert.equal(unregistered.code, 'SYSTEM_CONNECTOR_NOT_REGISTERED');

  const unknownFault = await probeSystemConnection({ code: 'ERP', roleId: 'executive', faultMode: 'not-a-fault' });
  assert.equal(unknownFault.status, 400);
  assert.equal(unknownFault.code, 'SYSTEM_PROBE_FAULT_UNKNOWN');
});

// ── 4. 连通性探测 ───────────────────────────────────────────────────────────

test('探测：真实发起分页只读读取并校验契约，结果落当前租户历史', async () => {
  const result = await within('demo-enterprise', () => probeSystemConnection({ code: 'ERP', roleId: 'executive', identityScope: identity('demo-enterprise') }));
  assert.equal(result.status, 'verified');
  assert.equal(result.sourceKind, 'local_mock_http');
  assert.equal(result.protocol, 'mock-onboarding-query.v1');
  assert.ok(result.requests >= 1 && result.pageCount >= 1, '必须真的发生过 HTTP 分页请求');
  assert.ok(result.recordCount > 0 && result.objectTypes.length > 0);
  assert.ok(result.recordCount <= result.readableRecords, '单系统记录数不得超过整批可读记录数');
  const history = getSystemProbeResults().probes.ERP.history;
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'verified');
});

test('探测：可探测性以数据源实际记录为判据，而非材料场景的声明范围', async () => {
  const overview = await getSystemAccessOverview({ roleId: 'executive' });
  const probeable = overview.systems.filter((item) => item.probe.supported).map((item) => item.code).sort();
  // LIMS 未出现在任何 mockOnboardingScenarios.systems 声明中，但 quality_incident 数据集确有
  // Inspection 记录；判据若取声明范围会把它误报为不可探测。
  assert.ok(probeable.includes('LIMS'), `LIMS 应可探测，实际 ${probeable.join(',')}`);
  const lims = await probeSystemConnection({ code: 'LIMS', roleId: 'executive', identityScope: identity('demo-enterprise') });
  assert.equal(lims.status, 'verified');
  assert.equal(lims.scenarioId, 'quality_incident');
  assert.ok(lims.objectTypes.includes('Inspection'));
  // 未登记连接器的系统不参与探测
  for (const code of ['SRM', 'MDM', 'PLM', 'EAM', 'IOT']) assert.equal(probeable.includes(code), false);
});

test('探测：六种故障模式必须显式失败或被显式标为结构漂移，不得伪装成功', async () => {
  // 结构漂移由数据源在首条记录上注入，故漂移用例必须探测首条记录所属的系统（实测为 ERP）。
  const run = (faultMode, code = 'WMS') => within('demo-enterprise', () => probeSystemConnection({ code, roleId: 'executive', faultMode, identityScope: identity('demo-enterprise') }));
  const expectations = {
    rate_limited: { status: 'failed', issue: 'MOCK_SOURCE_RATE_LIMITED' },
    timeout: { status: 'failed', issue: 'MOCK_SOURCE_TIMEOUT' },
    malformed: { status: 'failed', issue: 'MOCK_SOURCE_MALFORMED' },
    cross_tenant: { status: 'failed', issue: 'MOCK_SOURCE_TENANT_MISMATCH' },
    incomplete: { status: 'failed', issue: 'MOCK_SOURCE_INCOMPLETE' }
  };
  for (const [faultMode, expected] of Object.entries(expectations)) {
    const result = await run(faultMode);
    assert.equal(result.status, expected.status, `${faultMode} 状态不符`);
    assert.equal(result.issue.code, expected.issue, `${faultMode} 错误码不符`);
    assert.equal(result.recordCount, 0);
    assert.ok(result.issue.message.length > 0);
  }
  // 结构漂移不是「失败」，而是「读到了，但字段目录对不上」——必须单独状态并给出具体字段
  const drift = await run('schema_drift', 'ERP');
  assert.equal(drift.status, 'schema_drift');
  assert.equal(drift.issue.code, 'MOCK_SOURCE_SCHEMA_DRIFT');
  assert.ok(drift.issue.detail.length > 0);
  assert.match(drift.issue.detail[0], /undeclared_mock_field/);
  resetRuntimeState(NAMESPACES);
});

// ── 5. 路由与权限闸门 ───────────────────────────────────────────────────────

async function callRoute({ method, path, tenant = 'demo-enterprise', role = 'executive', actionRole = executiveRole, body = null, pagePermissionIds = ['page.world.view'] }) {
  let response;
  const handled = await handleGovernanceRoutes({
    req: { method }, res: {}, url: new URL(`http://test${path}`), role,
    agentIdentity: identity(tenant),
    effectiveAccess: { pagePermissionIds },
    selectActionRole: () => actionRole,
    denyButton: (permissionId) => { response = { status: 403, value: { denied: permissionId } }; },
    readBody: async () => body,
    send: (_res, status, value) => { response = { status, value }; }
  });
  assert.equal(handled, true, `路由未接管 ${method} ${path}`);
  return response;
}

test('路由：接入读取沿用页面权限，接入写入仍需 meta_model.draft.save', async () => {
  const overview = await callRoute({ method: 'GET', path: '/api/semantic-operations/systems' });
  assert.equal(overview.status, 200);
  assert.equal(overview.value.boundary, SYSTEM_ACCESS_BOUNDARY);

  const detail = await callRoute({ method: 'GET', path: '/api/semantic-operations/systems/ERP' });
  assert.equal(detail.status, 200);
  assert.equal(detail.value.system.code, 'ERP');

  const templates = await callRoute({ method: 'GET', path: '/api/semantic-operations/systems/mapping-templates' });
  assert.equal(templates.status, 200);
  assert.ok(templates.value.templates.length > 0, '字面量路径必须先于 :code 匹配');

  const deniedRead = await callRoute({ method: 'GET', path: '/api/semantic-operations/systems/mapping-templates', pagePermissionIds: [] });
  assert.equal(deniedRead.status, 403);
  assert.equal(deniedRead.value.denied, 'page.world.view');

  const probe = await callRoute({ method: 'POST', path: '/api/semantic-operations/systems/ERP/probe', body: { faultMode: 'none' } });
  assert.equal(probe.status, 200);
  assert.equal(probe.value.status, 'verified');

  const deniedProbe = await callRoute({ method: 'POST', path: '/api/semantic-operations/systems/ERP/probe', actionRole: null, body: { faultMode: 'none' } });
  assert.equal(deniedProbe.status, 403);
  assert.equal(deniedProbe.value.denied, 'meta_model.draft.save');

  const mappingDrafts = await callRoute({ method: 'POST', path: '/api/semantic-operations/systems/LIMS/mapping-drafts' });
  assert.equal(mappingDrafts.status, 200);
  assert.equal(mappingDrafts.value.draft.targetId, 'lims');
  const reused = await callRoute({ method: 'POST', path: '/api/semantic-operations/systems/LIMS/mapping-drafts' });
  assert.equal(reused.value.reused, true, '重复生成应复用既有草稿而不是产生第二份');

  const noTemplate = await callRoute({ method: 'POST', path: '/api/semantic-operations/systems/MDM/mapping-drafts' });
  assert.equal(noTemplate.status, 409);
  assert.equal(noTemplate.value.code, 'SYSTEM_MAPPING_TEMPLATE_MISSING');

  const unknownRoleMapping = await callRoute({ method: 'POST', path: '/api/semantic-operations/systems/LIMS/mapping-drafts', actionRole: null });
  assert.equal(unknownRoleMapping.status, 403);
  assert.equal(unknownRoleMapping.value.denied, 'world.draft.create');

  const detailDenied = await callRoute({ method: 'GET', path: '/api/semantic-operations/systems/ERP', role: 'marketing_manager' });
  assert.equal(detailDenied.status, 200);
  assert.equal(detailDenied.value.system.authorized, false);
  assert.equal(detailDenied.value.system.probe.supported, false, '未授权不得被标为可探测');

  const roleMismatch = await callRoute({ method: 'GET', path: '/api/semantic-operations/systems/ERP', role: 'executive', actionRole: null });
  assert.equal(roleMismatch.status, 200, '读取不应受写入闸门影响');
});

// ── 6. 接入生命周期操作面（2026-09-26 新增：ADR-023） ───────────────────────
// 此前状态机早已在注册表定义，却从未暴露为可执行动作——界面上的接入状态只能看
// 种子值，没有「新增接入」也没有「已接通系统的管理」。这一节锁死操作面的行为。

test('生命周期：登记→授权→（无 verified 探测拒绝接通）→探测→接通→停用→重新接通全链路可执行', async () => {
  const tenant = 'lifecycle-tenant';
  const call = (args) => callRoute({ tenant, ...args });

  // 种子起点：OA 是 pending_onboarding → 生命周期 registered
  const before = await call({ method: 'GET', path: '/api/semantic-operations/systems/OA' });
  assert.equal(before.value.lifecycle.state, 'registered');
  assert.deepEqual(before.value.lifecycle.transitions, ['authorized', 'draft']);

  // 登记流程的服务端动作：确认数据域授权（registered → authorized）
  const authorized = await call({ method: 'POST', path: '/api/semantic-operations/systems/OA/lifecycle', body: { to: 'authorized', reason: '已完成连接信息登记与数据域授权确认' } });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.value.from, 'registered');
  assert.equal(authorized.value.to, 'authorized');
  assert.equal(authorized.value.lifecycle.label, '已授权');
  assert.equal(authorized.value.lifecycle.updatedBy, 'same-operator');

  // 接通门禁：该租户尚无 verified 探测，authorized → connected 必须被拒绝
  const blocked = await call({ method: 'POST', path: '/api/semantic-operations/systems/OA/lifecycle', body: { to: 'connected', reason: '想直接接通' } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.value.code, 'SYSTEM_CONNECT_PROBE_REQUIRED');

  // 通过连通性测试后，接通才被放行
  const probe = await call({ method: 'POST', path: '/api/semantic-operations/systems/OA/probe', body: { faultMode: 'none' } });
  assert.equal(probe.value.status, 'verified');
  const connected = await call({ method: 'POST', path: '/api/semantic-operations/systems/OA/lifecycle', body: { to: 'connected', reason: '连通性测试通过，正式接通' } });
  assert.equal(connected.status, 200);
  assert.equal(connected.value.lifecycle.state, 'connected');

  // 已接通系统的管理：停用（保留登记与授权）→ 重新接通
  const suspended = await call({ method: 'POST', path: '/api/semantic-operations/systems/OA/lifecycle', body: { to: 'suspended', reason: '系统侧维护，暂停接入' } });
  assert.equal(suspended.status, 200);
  const overview = await call({ method: 'GET', path: '/api/semantic-operations/systems' });
  assert.ok(overview.value.summary.suspended >= 1, '总览必须暴露停用计数');
  const resumed = await call({ method: 'POST', path: '/api/semantic-operations/systems/OA/lifecycle', body: { to: 'connected', reason: '维护完成，恢复接入' } });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.value.lifecycle.state, 'connected');

  // 非法跃迁与未知状态：connected → registered 不在状态机里，必须显式拒绝
  const illegal = await call({ method: 'POST', path: '/api/semantic-operations/systems/OA/lifecycle', body: { to: 'registered', reason: '非法跃迁' } });
  assert.equal(illegal.status, 409);
  assert.equal(illegal.value.code, 'SYSTEM_TRANSITION_REJECTED');
});

test('生命周期：理由必填、未知状态、未知系统、越权与租户隔离各自显式失败', async () => {
  const tenant = 'lifecycle-guards';
  const call = (args) => callRoute({ tenant, ...args });

  const noReason = await call({ method: 'POST', path: '/api/semantic-operations/systems/OA/lifecycle', body: { to: 'authorized' } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.value.code, 'SYSTEM_TRANSITION_REASON_REQUIRED');

  const unknownState = await call({ method: 'POST', path: '/api/semantic-operations/systems/OA/lifecycle', body: { to: 'enabled', reason: '未知状态' } });
  assert.equal(unknownState.status, 400);
  assert.equal(unknownState.value.code, 'SYSTEM_STATE_UNKNOWN');

  const unknownSystem = await call({ method: 'POST', path: '/api/semantic-operations/systems/NOPE/lifecycle', body: { to: 'registered', reason: '未知系统' } });
  assert.equal(unknownSystem.status, 404);
  assert.equal(unknownSystem.value.code, 'SYSTEM_NOT_REGISTERED');

  const denied = await call({ method: 'POST', path: '/api/semantic-operations/systems/OA/lifecycle', actionRole: null, body: { to: 'authorized', reason: '没有写入权限' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.value.denied, 'meta_model.draft.save');

  // 租户隔离：guards 租户推进 OA 不影响 demo-enterprise 的种子状态
  await call({ method: 'POST', path: '/api/semantic-operations/systems/OA/lifecycle', body: { to: 'authorized', reason: 'guards 租户内推进' } });
  const other = await within('demo-enterprise', () => getTenantSystemConnection('OA'));
  assert.equal(other.lifecycleState, 'registered', '其他租户不得继承本租户的接入生命周期推进');
});

test('生命周期：服务层直调与路由层行为一致（含接通门禁与审计字段）', async () => {
  const result = await within('lifecycle-direct', () => transitionTenantSystemConnection({
    code: 'OA', to: 'authorized', reason: '服务层直调', identityScope: identity('lifecycle-direct')
  }));
  assert.equal(result.to, 'authorized');
  assert.equal(result.lifecycle.updatedBy, 'same-operator');
  assert.match(result.lifecycle.reason, /服务层直调/);

  const blocked = await within('lifecycle-direct', () => transitionTenantSystemConnection({
    code: 'OA', to: 'connected', reason: '未探测就接通', identityScope: identity('lifecycle-direct')
  }));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, 'SYSTEM_CONNECT_PROBE_REQUIRED');
});

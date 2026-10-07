// 系统接入监控专项测试（2026-10-07）。
//
// 覆盖：
//   1. 接入成功后 sync 自动挂载（connected → mounted）
//   2. 停用（suspended）/ 退回（draft）后 sync 解除挂载
//   3. degraded 仍在监控中
//   4. 轮询正例：心跳通过 → verified、无告警
//   5. 轮询告警：连续 2 次失败 → 告警分派一次（邮件+通知经 mock 回调验证）
//   6. 轮询降级：连续 3 次失败 → 自动降级 degraded + 升级告警
//   7. 恢复：失败后探测恢复 verified → recover 通知
//   8. pause 后轮询跳过该系统
//   9. 定义已删除（挂载了不存在的系统码）→ sync 解除
//  10. 单次失败不清零、skipped（不可探测）不参与失败计数
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetRuntimeState, writeState } from '../src/repositories/runtime-state-repository.js';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { runWithIAMStoreContext } from '../src/services/iam-store.js';
import { createTenantIAMWorkspace, iamWorkspaceKey } from '../src/services/iam-workspace-model.js';
import { initialRolePolicies } from '../src/data/iam-seed.js';
import { getAlertingWorkspaceForAccess, saveAlertingConfiguration } from '../src/domains/alerting/alerting-service.js';
import { resolveMonitoringTenantIds, runConfiguredMonitoringCycles } from '../src/workers/system-monitoring-worker.js';
import { handleSystemMonitoringRoutes } from '../src/routes/system-monitoring-routes.js';
import { registerTenantCustomSystem, transitionSystemConnection, getTenantSystemConnections } from '../src/services/system-registry-service.js';
import {
  syncSystemMonitoring, getSystemMonitoringOverview, controlSystemMonitoring,
  mountSystemMonitoring, recordMonitoringProbeOutcome, runSystemMonitoringCycle,
  acquireSystemMonitoringWorkerLease
} from '../src/services/system-monitoring-service.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Use the runtime-test-bootstrap memory store.');

const NAMESPACES = ['system_access_runtime', 'system_registry_runtime', 'key_center', 'system_monitoring_runtime', 'alerting', 'iam', 'domain_event_outbox', 'semantic_operations_notifications'];
const identity = tenantId => ({ tenantId, subjectId: 'monitor-tester', deviceId: 'device-1' });
const within = (tenant, work) => runWithSemanticTenant(identity(tenant), work);

const baseMaterials = (overrides = {}) => ({
  name: '监控测试系统',
  domain: '供应链',
  description: '管理供应商数据的外部平台，覆盖寻源到付款全流程。',
  keyEntities: ['供应商档案'],
  dataDomains: ['production', 'internal'],
  accessIntention: '读取供应商资质与绩效数据，支撑采购风险分析。',
  businessOwner: '采购负责人',
  heartbeat: { endpoint: 'https://api.example.com/health', method: 'GET', expectedStatus: 200 },
  auth: { scheme: 'user_token_passthrough', writeApprovalRequired: true },
  ...overrides
});

/** 注册并接通自定义系统：registered → authorized → connected */
function registerAndConnect(tenant, code, overrides = {}) {
  within(tenant, () => registerTenantCustomSystem({ materials: baseMaterials({ code, ...overrides }), actor: { id: 'tester' } }));
  within(tenant, () => transitionSystemConnection({ code, to: 'authorized', reason: '授权通过', actor: { id: 'tester' } }));
  within(tenant, () => transitionSystemConnection({ code, to: 'connected', reason: '测试接通', actor: { id: 'tester' } }));
}

const okFetcher = () => async () => ({ ok: true, status: 200, text: async () => '{"status":"ok"}', headers: new Map() });
const failFetcher = () => async () => { throw new Error('network unreachable'); };
const nullDispatch = async () => null;

async function callMonitoringRoute({ method, path, tenant = 'demo-enterprise', actionRole = { id: 'executive' }, body = null }) {
  let response;
  const handled = await handleSystemMonitoringRoutes({
    req: { method }, res: {}, url: new URL(`http://test${path}`),
    agentIdentity: identity(tenant),
    selectActionRole: () => actionRole,
    denyButton: permissionId => { response = { status: 403, value: { denied: permissionId } }; },
    readBody: async () => body,
    send: (_res, status, value) => { response = { status, value }; }
  });
  assert.equal(handled, true, `监控路由未接管 ${method} ${path}`);
  return response;
}

test.beforeEach(() => resetRuntimeState(NAMESPACES));

test('接入成功后 sync 自动挂载；degraded 仍在监控', async () => {
  await within('mon-a', async () => {
    registerAndConnect('mon-a', 'MONA');
    const synced = syncSystemMonitoring();
    assert.equal(synced.events.filter((e) => e.code === 'MONA' && e.action === 'mounted').length, 1, '接通后应有一条自动挂载事件');
    // 降级后仍在监控（degraded 是监控发现的异常状态，持续探测）
    transitionSystemConnection({ code: 'MONA', to: 'degraded', reason: '测试降级', actor: { id: 'tester' } });
    const again = syncSystemMonitoring();
    assert.equal(again.events.filter((e) => e.code === 'MONA' && e.action === 'unmounted').length, 0, 'degraded 不应解除监控');
    const overview = await getSystemMonitoringOverview();
    const mona = overview.systems.find((s) => s.code === 'MONA');
    assert.ok(mona, '降级系统应仍在监控列表');
    assert.equal(mona.lifecycleState, 'degraded');
  });
});

test('停用（suspended）/ 退回（draft）后 sync 解除挂载；删除（定义消失）也解除', async () => {
  await within('mon-b', async () => {
    registerAndConnect('mon-b', 'MONB');
    syncSystemMonitoring();
    // 停用 → 解除
    transitionSystemConnection({ code: 'MONB', to: 'suspended', reason: '停用测试', actor: { id: 'tester' } });
    let overview = await getSystemMonitoringOverview();
    assert.equal(overview.systems.some((s) => s.code === 'MONB'), false, '停用后不应在监控列表');
    assert.ok(overview.events.some((e) => e.code === 'MONB' && e.action === 'unmounted'), '停用应记录解除事件');
    // 恢复接通 → 重新挂载
    transitionSystemConnection({ code: 'MONB', to: 'connected', reason: '恢复接通', actor: { id: 'tester' } });
    overview = await getSystemMonitoringOverview();
    assert.ok(overview.systems.some((s) => s.code === 'MONB'), '恢复接通后应重新挂载');
    // 退回 draft：状态机不允许 connected → draft 直达，须经 suspended 中转
    transitionSystemConnection({ code: 'MONB', to: 'suspended', reason: '先停用', actor: { id: 'tester' } });
    transitionSystemConnection({ code: 'MONB', to: 'draft', reason: '退回重新登记', actor: { id: 'tester' } });
    overview = await getSystemMonitoringOverview();
    assert.equal(overview.systems.some((s) => s.code === 'MONB'), false, '退回 draft 后不应在监控列表');
    // 模拟「删除」：挂载了一个不存在的系统码 → sync 应解除
    mountSystemMonitoring({ code: 'GONE', name: '已删除系统', source: 'manual' });
    overview = await getSystemMonitoringOverview();
    assert.equal(overview.systems.some((s) => s.code === 'GONE'), false, '定义已删除的系统应被 sync 解除');
  });
});

test('轮询正例：心跳通过 → verified、无告警', async () => {
  await within('mon-c', async () => {
    registerAndConnect('mon-c', 'MONC');
    const result = await runSystemMonitoringCycle({ fetcher: okFetcher(), dispatch: nullDispatch, notify: nullDispatch });
    assert.ok(result.checked >= 1, `应至少巡检 1 个系统，实际 ${result.checked}`);
    assert.equal(result.failed, 0, '心跳应全通过');
    assert.equal(result.alerts, 0, '不应有告警');
    const overview = await getSystemMonitoringOverview();
    const monc = overview.systems.find((s) => s.code === 'MONC');
    assert.equal(monc.monitoring.consecutiveFailures, 0);
    assert.equal(monc.monitoring.alerted, false);
  });
});

test('轮询告警：连续 2 次失败 → 告警分派一次（不重复）', async () => {
  await within('mon-d', async () => {
    registerAndConnect('mon-d', 'MOND', { heartbeat: { endpoint: 'https://fail.example.com/health', expectedStatus: 200 } });
    const dispatchCalls = [];
    const collectDispatch = async (event) => { dispatchCalls.push(event); return null; };
    // 第 1 次失败：计数，不告警
    await runSystemMonitoringCycle({ alertThreshold: 2, degradeThreshold: 99, fetcher: failFetcher(), dispatch: collectDispatch, notify: nullDispatch });
    assert.equal(dispatchCalls.length, 0, '第 1 次失败不应告警');
    // 第 2 次失败：达到阈值 → 告警
    await runSystemMonitoringCycle({ alertThreshold: 2, degradeThreshold: 99, fetcher: failFetcher(), dispatch: collectDispatch, notify: nullDispatch });
    assert.equal(dispatchCalls.length, 1, '连续 2 次失败应告警一次');
    assert.equal(dispatchCalls[0].kind, 'probe_failed');
    assert.equal(dispatchCalls[0].code, 'MOND');
    // 第 3 次失败：已告警过，不重复告警
    await runSystemMonitoringCycle({ alertThreshold: 2, degradeThreshold: 99, fetcher: failFetcher(), dispatch: collectDispatch, notify: nullDispatch });
    assert.equal(dispatchCalls.length, 1, '同一失败周期不应重复告警');
  });
});

test('告警分派失败保留待发送事件；下一轮使用同一 ID 重试并只确认一次', async () => {
  await within('mon-retry', async () => {
    registerAndConnect('mon-retry', 'MONRETRY');
    const events = [];
    const dispatch = async event => {
      events.push(event);
      if (events.length === 1) throw new Error('mail temporarily unavailable');
    };
    await runSystemMonitoringCycle({ alertThreshold: 1, degradeThreshold: 99, fetcher: failFetcher(), dispatch, notify: nullDispatch });
    let overview = await getSystemMonitoringOverview();
    let state = overview.systems.find(item => item.code === 'MONRETRY').monitoring;
    assert.equal(state.alerted, false);
    assert.equal(state.alertPending, true);
    await runSystemMonitoringCycle({ alertThreshold: 1, degradeThreshold: 99, fetcher: failFetcher(), dispatch, notify: nullDispatch });
    overview = await getSystemMonitoringOverview();
    state = overview.systems.find(item => item.code === 'MONRETRY').monitoring;
    assert.equal(state.alerted, true);
    assert.equal(state.alertPending, false);
    assert.equal(events.length, 2);
    assert.equal(events[0].alertEventId, events[1].alertEventId, '重试必须复用告警 ID');
    await runSystemMonitoringCycle({ alertThreshold: 1, degradeThreshold: 99, fetcher: failFetcher(), dispatch, notify: nullDispatch });
    assert.equal(events.length, 2, '成功确认后不得重复分派');
  });
});

test('非 Demo 租户未配置本租户管理员时拒绝投递，保持待发送且不回退 Demo', async () => {
  await within('enterprise-alert', async () => {
    registerAndConnect('enterprise-alert', 'MONSAFE');
    const result = await runSystemMonitoringCycle({ alertThreshold: 1, degradeThreshold: 99, fetcher: failFetcher(), notify: nullDispatch });
    assert.equal(result.deliveryFailures, 1);
    const overview = await getSystemMonitoringOverview();
    const state = overview.systems.find(item => item.code === 'MONSAFE').monitoring;
    assert.equal(state.alerted, false);
    assert.equal(state.alertPending, true);
  });
});

test('非 Demo 租户配置本租户管理员联系点后，默认告警可投递且不进入 Demo 工作区', async () => {
  const tenantId = 'enterprise-delivery';
  const iam = createTenantIAMWorkspace(tenantId);
  iam.organizations = [{ id: 'org-enterprise', name: '企业运维组织', parentId: null }];
  iam.users = [{ id: 'enterprise-admin', account: 'admin@enterprise.example', name: '企业管理员', title: '管理员', department: '信息部', orgUnitId: 'org-enterprise', roleIds: ['executive'], primaryRoleId: 'executive', status: 'active', sources: ['local'], version: 1 }];
  iam.rolePolicies = { executive: structuredClone(initialRolePolicies.executive) };
  writeState('iam', iamWorkspaceKey(tenantId), iam);

  await runWithIAMStoreContext(() => within(tenantId, async () => {
    const accessIdentity = { tenantId, subjectId: 'enterprise-admin', source: 'identity_session' };
    const baseline = await getAlertingWorkspaceForAccess('executive', accessIdentity);
    await saveAlertingConfiguration({
      expectedVersion: baseline.configurationVersion,
      contactPoints: [{ userId: 'enterprise-admin', email: 'alerts@enterprise.example', enabledChannels: ['in_app', 'push', 'email'] }]
    }, { type: 'test', id: 'enterprise-admin', tenantId });
    registerAndConnect(tenantId, 'MONMAIL');
    const cycle = await runSystemMonitoringCycle({ alertThreshold: 1, degradeThreshold: 99, fetcher: failFetcher(), notify: nullDispatch });
    assert.equal(cycle.deliveryFailures, 0, JSON.stringify(cycle));
    assert.equal(cycle.alerts, 1);
    const workspace = await getAlertingWorkspaceForAccess('executive', accessIdentity);
    assert.ok(workspace.deliveries.some(item => item.channel === 'email' && item.target === 'alerts@enterprise.example'));
    assert.equal((await getSystemMonitoringOverview()).systems.find(item => item.code === 'MONMAIL').monitoring.alerted, true);
  }), tenantId);

  const demo = await getAlertingWorkspaceForAccess('executive', { source: 'demo_header', subjectId: 'demo:executive:monitoring-test' });
  assert.equal(demo.deliveries.some(item => item.target === 'alerts@enterprise.example'), false);
});

test('常驻监控租户配置生产模式必须显式给出，并逐租户绑定上下文', async () => {
  assert.throws(() => resolveMonitoringTenantIds('', true), /SYSTEM_MONITOR_TENANT_IDS_REQUIRED/);
  assert.throws(() => resolveMonitoringTenantIds('tenant-a,tenant-a', true), /SYSTEM_MONITOR_TENANT_IDS_INVALID/);
  assert.deepEqual(resolveMonitoringTenantIds('tenant-a, tenant-b', true), ['tenant-a', 'tenant-b']);
  const seen = [];
  const results = await runConfiguredMonitoringCycles({
    tenantIds: ['tenant-a', 'tenant-b'],
    runCycle: async () => {
      const { currentSemanticTenant } = await import('../src/services/semantic-tenant-context.js');
      seen.push(currentSemanticTenant());
      return { checked: 0 };
    }
  });
  assert.deepEqual(seen, ['tenant-a', 'tenant-b']);
  assert.equal(results.every(item => !item.error), true);
  assert.equal(results.every(item => !item.skipped), true);
});

test('同租户 Leader 租约在到期前拒绝其他 worker，到期后允许接管', () => {
  within('lease-tenant', () => {
    const first = acquireSystemMonitoringWorkerLease({ workerId: 'worker-a', leaseMs: 30_000, nowAt: 1_000_000 });
    const blocked = acquireSystemMonitoringWorkerLease({ workerId: 'worker-b', leaseMs: 30_000, nowAt: 1_010_000 });
    const renewed = acquireSystemMonitoringWorkerLease({ workerId: 'worker-a', leaseMs: 30_000, nowAt: 1_020_000 });
    const takeover = acquireSystemMonitoringWorkerLease({ workerId: 'worker-b', leaseMs: 30_000, nowAt: 1_050_001 });
    assert.equal(first.acquired, true);
    assert.deepEqual(blocked, { acquired: false, leaderWorkerId: 'worker-a', expiresAt: first.expiresAt });
    assert.equal(renewed.acquired, true);
    assert.equal(takeover.acquired, true);
    assert.equal(takeover.leaderWorkerId, 'worker-b');
  });
});

const runLeaseProcess = ({ databasePath, workerId, nowAt }) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['backend/test/helpers/system-monitoring-lease-worker.mjs', databasePath, 'lease-process-tenant', workerId, String(nowAt), '30000'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'sqlite', RUNTIME_SQLITE_PATH: databasePath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('exit', code => {
    if (code !== 0) return reject(new Error(`lease worker ${workerId} failed (${code}): ${stderr}`));
    try { resolve(JSON.parse(stdout.trim().split(/\r?\n/u).at(-1))); } catch { reject(new Error(`lease worker ${workerId} returned invalid JSON: ${stdout}\n${stderr}`)); }
  });
});

test('共享 SQLite 下多进程同租户只能有一个监控 Leader', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yuanyu-system-monitor-'));
  const databasePath = join(directory, 'runtime.sqlite');
  try {
    const attempts = await Promise.all(['a', 'b', 'c', 'd'].map(workerId => runLeaseProcess({ databasePath, workerId, nowAt: 2_000_000 })));
    assert.equal(attempts.filter(item => item.acquired).length, 1, JSON.stringify(attempts));
    const takeover = await runLeaseProcess({ databasePath, workerId: 'takeover', nowAt: 2_030_001 });
    assert.equal(takeover.acquired, true);
    assert.equal(takeover.leaderWorkerId, 'takeover');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('轮询降级：连续 3 次失败 → 自动降级 degraded + 升级告警', async () => {
  await within('mon-e', async () => {
    registerAndConnect('mon-e', 'MONE', { heartbeat: { endpoint: 'https://fail2.example.com/health', expectedStatus: 200 } });
    const dispatchCalls = [];
    const collectDispatch = async (event) => { dispatchCalls.push(event); return null; };
    for (let i = 0; i < 3; i++) {
      await runSystemMonitoringCycle({ alertThreshold: 2, degradeThreshold: 3, fetcher: failFetcher(), dispatch: collectDispatch, notify: nullDispatch });
    }
    const connections = within('mon-e', () => getTenantSystemConnections());
    assert.equal(connections.find((c) => c.code === 'MONE')?.lifecycleState, 'degraded', '连续 3 次失败应自动降级');
    assert.equal(dispatchCalls.filter((e) => e.kind === 'degraded').length, 1, '降级应触发一次升级告警');
    assert.equal(dispatchCalls.filter((e) => e.kind === 'probe_failed').length, 1, '探测失败告警应只有一次');
  });
});

test('降级告警分派失败后保持待发送，下一轮不重复降级但重试通知', async () => {
  await within('mon-degrade-retry', async () => {
    registerAndConnect('mon-degrade-retry', 'MONDR');
    const calls = [];
    const dispatch = async event => {
      calls.push(event);
      if (event.kind === 'degraded' && calls.filter(item => item.kind === 'degraded').length === 1) throw new Error('notification unavailable');
    };
    const first = await runSystemMonitoringCycle({ alertThreshold: 1, degradeThreshold: 1, fetcher: failFetcher(), dispatch, notify: nullDispatch });
    assert.equal(first.degradations, 1);
    assert.equal(first.deliveryFailures, 1);
    let overview = await getSystemMonitoringOverview();
    assert.equal(overview.systems.find(item => item.code === 'MONDR').monitoring.degradeAlertPending, true);
    const second = await runSystemMonitoringCycle({ alertThreshold: 1, degradeThreshold: 1, fetcher: failFetcher(), dispatch, notify: nullDispatch });
    assert.equal(second.degradations, 0);
    overview = await getSystemMonitoringOverview();
    assert.equal(overview.systems.find(item => item.code === 'MONDR').monitoring.degradeAlertPending, false);
    const degraded = calls.filter(item => item.kind === 'degraded');
    assert.equal(degraded.length, 2);
    assert.equal(degraded[0].alertEventId, degraded[1].alertEventId);
  });
});

test('恢复：失败告警后探测恢复 verified → recover 通知、告警状态复位', async () => {
  await within('mon-f', async () => {
    registerAndConnect('mon-f', 'MONF', { heartbeat: { endpoint: 'https://fail3.example.com/health', expectedStatus: 200 } });
    const notifyCalls = [];
    const collectNotify = async (event) => { notifyCalls.push(event); return null; };
    // 连续 2 次失败 → 告警（alertThreshold=2，需两个失败周期）
    await runSystemMonitoringCycle({ alertThreshold: 2, degradeThreshold: 99, fetcher: failFetcher(), dispatch: nullDispatch, notify: collectNotify });
    await runSystemMonitoringCycle({ alertThreshold: 2, degradeThreshold: 99, fetcher: failFetcher(), dispatch: nullDispatch, notify: collectNotify });
    // 恢复 → recover
    await runSystemMonitoringCycle({ alertThreshold: 2, degradeThreshold: 99, fetcher: okFetcher(), dispatch: nullDispatch, notify: collectNotify });
    assert.equal(notifyCalls.length, 1, '恢复应触发一次通知');
    const overview = await getSystemMonitoringOverview();
    const monf = overview.systems.find((s) => s.code === 'MONF');
    assert.equal(monf.monitoring.alerted, false, '恢复后告警状态应复位');
    assert.equal(monf.monitoring.consecutiveFailures, 0, '恢复后连续失败应清零');
    // 再次失败 → 重新告警（新失败周期）
    await runSystemMonitoringCycle({ alertThreshold: 2, degradeThreshold: 99, fetcher: failFetcher(), dispatch: nullDispatch, notify: collectNotify });
    assert.equal(notifyCalls.length, 1, '恢复后的单次失败不应立即告警');
  });
});

test('pause 后轮询跳过该系统；resume 后恢复巡检', async () => {
  await within('mon-g', async () => {
    registerAndConnect('mon-g', 'MONG');
    syncSystemMonitoring();
    const paused = controlSystemMonitoring({ code: 'MONG', action: 'pause' });
    assert.equal(paused.error, undefined);
    await runSystemMonitoringCycle({ fetcher: okFetcher(), dispatch: nullDispatch, notify: nullDispatch });
    let overview = await getSystemMonitoringOverview();
    const pausedEntry = overview.systems.find((s) => s.code === 'MONG');
    assert.equal(pausedEntry.paused, true, '应为暂停状态');
    assert.equal(pausedEntry.monitoring.lastProbeAt, null, '暂停后不应巡检该系统（无探测记录）');
    controlSystemMonitoring({ code: 'MONG', action: 'resume' });
    await runSystemMonitoringCycle({ fetcher: okFetcher(), dispatch: nullDispatch, notify: nullDispatch });
    overview = await getSystemMonitoringOverview();
    assert.ok(overview.systems.find((s) => s.code === 'MONG')?.monitoring.lastProbeAt, '恢复后应有探测记录');
  });
});

test('skipped（不可探测）不参与失败计数，不触发告警', () => {
  within('mon-h', () => {
    // skipped 语义直接经 recordMonitoringProbeOutcome 验证（无可读数据集时轮询产出的三态之一）
    const decision = recordMonitoringProbeOutcome({ code: 'MONH', probeOutcome: 'skipped', lifecycleState: 'connected' });
    assert.equal(decision.alert, false);
    assert.equal(decision.consecutiveFailures, 0);
    // 连续多次 skipped 不累积失败
    for (let i = 0; i < 5; i++) recordMonitoringProbeOutcome({ code: 'MONH', probeOutcome: 'skipped', lifecycleState: 'connected' });
    const after = recordMonitoringProbeOutcome({ code: 'MONH', probeOutcome: 'failed', lifecycleState: 'connected', alertThreshold: 2 });
    assert.equal(after.consecutiveFailures, 1, 'skipped 不应累积进失败计数');
  });
});

test('平台演示系统（seed connected）自动挂载到监控', async () => {
  await within('mon-i', async () => {
    const overview = await getSystemMonitoringOverview();
    // 演示租户的 6 个 seed 接入样例（LIMS/MES/ERP/WMS/QMS/OMS）应被自动挂载
    assert.ok(overview.summary.monitored >= 6, `演示租户至少应挂载 6 个 seed 系统，实际 ${overview.summary.monitored}`);
    for (const code of ['LIMS', 'MES', 'ERP', 'WMS', 'QMS', 'OMS']) {
      assert.ok(overview.systems.some((s) => s.code === code), `${code} 应在监控列表`);
    }
  });
});

test('监控路由：总览与控制均绑定受信租户，不得回落读取 demo-enterprise', async () => {
  // tenant-a 只有一个自定义已接通系统；若路由遗漏 runWithSemanticTenant，会错误读到
  // Demo 租户的六个种子系统，且暂停动作也会写错租户。
  registerAndConnect('route-tenant-a', 'MONROUTE');
  const tenantA = await callMonitoringRoute({ method: 'GET', path: '/api/semantic-operations/system-monitoring', tenant: 'route-tenant-a' });
  assert.equal(tenantA.status, 200);
  assert.ok(tenantA.value.systems.some(item => item.code === 'MONROUTE'), '所属租户必须看到自己的自定义挂载系统');

  const paused = await callMonitoringRoute({ method: 'POST', path: '/api/semantic-operations/system-monitoring/MONROUTE/pause', tenant: 'route-tenant-a' });
  assert.equal(paused.status, 200);
  assert.equal(paused.value.paused, true);

  const tenantB = await callMonitoringRoute({ method: 'GET', path: '/api/semantic-operations/system-monitoring', tenant: 'route-tenant-b' });
  assert.equal(tenantB.status, 200);
  assert.equal(tenantB.value.systems.some(item => item.code === 'MONROUTE'), false, '另一个租户不得看到 A 的挂载系统');

  const wrongMethod = await callMonitoringRoute({ method: 'GET', path: '/api/semantic-operations/system-monitoring/MONROUTE/pause', tenant: 'route-tenant-a' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.value.code, 'SYSTEM_MONITORING_METHOD_NOT_ALLOWED');
});

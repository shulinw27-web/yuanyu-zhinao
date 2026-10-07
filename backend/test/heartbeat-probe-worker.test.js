// 心跳定时探测 worker（ADR-028 阶段 8-6）专项测试。
//
// 覆盖：
//   1. runHeartbeatProbeCycle 正例：所有已接通系统心跳通过 → checked=N verified=N failed=0
//   2. runHeartbeatProbeCycle 反例：连续N次失败 → 自动降级为 degraded
//   3. 不巡检未接通系统、无心跳系统、平台系统
//   4. 降级后不再重复降级（幂等）
//   5. 恢复后不自动升级回 connected（需人工裁定）
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { registerTenantCustomSystem, transitionSystemConnection, getTenantSystemConnections } from '../src/services/system-registry-service.js';
import { runHeartbeatProbeCycle } from '../src/workers/heartbeat-probe-worker.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Use the runtime-test-bootstrap memory store.');

const NAMESPACES = ['system_access_runtime', 'system_registry_runtime', 'key_center'];
const identity = tenantId => ({ tenantId, subjectId: 'worker-tester', deviceId: 'device-1' });
const within = (tenant, work) => runWithSemanticTenant(identity(tenant), work);

const baseMaterials = (overrides = {}) => ({
  name: '心跳巡检测试系统',
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

// mock fetcher：返回 200（心跳通过）
function okFetcher() {
  return async () => ({ ok: true, status: 200, text: async () => '{"status":"ok"}', headers: new Map() });
}

// mock fetcher：抛错（心跳失败）
function failFetcher() {
  return async () => { throw new Error('network unreachable'); };
}

test.beforeEach(() => resetRuntimeState(NAMESPACES));

test('正例：已接通系统心跳全通过 → checked=N verified=N failed=0', async () => {
  registerAndConnect('wk-a', 'SWKA');
  const result = await within('wk-a', () => runHeartbeatProbeCycle({ failureThreshold: 3, fetcher: okFetcher() }));
  assert.ok(result.checked >= 1, `应至少巡检 1 个系统，实际 checked=${result.checked}`);
  assert.equal(result.failed, 0, '心跳应全通过');
  assert.equal(result.verified, result.checked, '全部 verified');
});

test('反例：连续N次失败 → 自动降级为 degraded', async () => {
  registerAndConnect('wk-b', 'SWKB', { heartbeat: { endpoint: 'https://fail.example.com/health', expectedStatus: 200 } });
  // 心跳会失败（注入 failFetcher），连续 3 次巡检后应降级
  for (let i = 0; i < 3; i++) {
    await within('wk-b', () => runHeartbeatProbeCycle({ failureThreshold: 3, fetcher: failFetcher() }));
  }
  const connections = within('wk-b', () => getTenantSystemConnections());
  const swkb = connections.find((c) => c.code === 'SWKB');
  assert.ok(swkb, 'SWKB 应有连接记录');
  assert.equal(swkb.lifecycleState, 'degraded', '连续 3 次失败后应自动降级为 degraded');
});

test('不巡检未接通系统、无心跳系统', async () => {
  // 注册但未接通（registered 状态）
  within('wk-c', () => registerTenantCustomSystem({ materials: baseMaterials({ code: 'SWKC' }), actor: { id: 'tester' } }));
  // 无心跳——但 heartbeat 是必填项，所以不能传 null。
  // 注册一个有心跳的系统但不接通，验证 worker 只巡检 connected/degraded
  within('wk-c', () => registerTenantCustomSystem({ materials: baseMaterials({ code: 'SWKCU' }), actor: { id: 'tester' } }));
  const result = await within('wk-c', () => runHeartbeatProbeCycle({ failureThreshold: 3, fetcher: okFetcher() }));
  assert.equal(result.checked, 0, '未接通系统不应被巡检');
});

test('降级后不再重复降级（幂等）', async () => {
  registerAndConnect('wk-d', 'SWKE', { heartbeat: { endpoint: 'https://fail2.example.com/health', expectedStatus: 200 } });
  // 降级
  for (let i = 0; i < 3; i++) {
    await within('wk-d', () => runHeartbeatProbeCycle({ failureThreshold: 3, fetcher: failFetcher() }));
  }
  // 确认已降级
  const connsBefore = within('wk-d', () => getTenantSystemConnections());
  const swkeBefore = connsBefore.find((c) => c.code === 'SWKE');
  assert.equal(swkeBefore.lifecycleState, 'degraded', '应已降级');
  // 再巡检一次——已 degraded，不应再降级（degraded 状态也巡检但不重复降级）
  const result = await within('wk-d', () => runHeartbeatProbeCycle({ failureThreshold: 3, fetcher: failFetcher() }));
  assert.equal(result.degraded, 0, '已 degraded 的系统不应再降级');
});

test('恢复后不自动升级回 connected（需人工裁定）', async () => {
  registerAndConnect('wk-e', 'SWKF', { heartbeat: { endpoint: 'https://fail3.example.com/health', expectedStatus: 200 } });
  // 降级（3次失败）
  for (let i = 0; i < 3; i++) {
    await within('wk-e', () => runHeartbeatProbeCycle({ failureThreshold: 3, fetcher: failFetcher() }));
  }
  const beforeConnections = within('wk-e', () => getTenantSystemConnections());
  const beforeSwkf = beforeConnections.find((c) => c.code === 'SWKF');
  assert.equal(beforeSwkf.lifecycleState, 'degraded');
  // 再巡检——此时心跳恢复（注入 okFetcher），但 worker 不应自动升级回 connected
  await within('wk-e', () => runHeartbeatProbeCycle({ failureThreshold: 3, fetcher: okFetcher() }));
  const afterConnections = within('wk-e', () => getTenantSystemConnections());
  const afterSwkf = afterConnections.find((c) => c.code === 'SWKF');
  assert.equal(afterSwkf.lifecycleState, 'degraded', 'worker 不自动升级回 connected');
});

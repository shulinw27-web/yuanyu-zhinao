// 心跳探测与凭据解析（ADR-028 阶段 8-2）专项测试。
//
// 覆盖：
//   1. executeHeartbeatProbe 正例：user_token_passthrough + mock fetcher 返回 200 → verified
//   2. executeHeartbeatProbe 正例：service_principal + 凭据解析成功 + 200 → verified
//   3. executeHeartbeatProbe 反例：transport failed / status mismatch / body mismatch / timeout
//   4. probeSystemConnection 优先走心跳路径（自定义系统有 heartbeat）
//   5. 接通门禁：心跳 verified 后可接通（不放宽 reason 必填）
//   6. 凭据策略注册：登记 service_principal 系统时自动注册 Key Center 凭据策略
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { registerTenantCustomSystem } from '../src/services/system-registry-service.js';
import { getCustomSystemCredentialPolicy, registerCustomSystemCredentialPolicy } from '../src/services/key-center/key-center-service.js';
import {
  executeHeartbeatProbe,
  probeSystemConnection,
  transitionTenantSystemConnection
} from '../src/services/system-access-service.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Use the runtime-test-bootstrap memory store.');

const NAMESPACES = ['system_access_runtime', 'system_registry_runtime', 'key_center'];
const identity = tenantId => ({ tenantId, subjectId: 'heartbeat-tester', deviceId: 'device-1' });
const within = (tenant, work) => runWithSemanticTenant(identity(tenant), work);

const baseMaterials = (overrides = {}) => ({
  name: '供应商协同中台',
  domain: '供应链',
  description: '管理供应商准入、资质、绩效与合同协同的外部平台，覆盖寻源到付款全流程。',
  keyEntities: ['供应商档案', '绩效评分', '合同'],
  dataDomains: ['production', 'internal'],
  accessIntention: '读取供应商资质与绩效数据，支撑采购风险分析与供应商画像。',
  businessOwner: '采购负责人',
  heartbeat: { endpoint: 'https://api.supplier.example.com/health', method: 'GET', expectedStatus: 200, timeoutMs: 5000 },
  auth: { scheme: 'user_token_passthrough', writeApprovalRequired: true },
  ...overrides
});

// mock fetcher：返回可配置的 { status, body }，并记录请求参数供断言
function mockFetcher(response, record = {}) {
  return async (url, options) => {
    record.url = url;
    record.method = options?.method;
    record.headers = { ...(options?.headers || {}) };
    return {
      status: response.status,
      text: async () => response.body || '',
      json: async () => JSON.parse(response.body || '{}')
    };
  };
}

test.beforeEach(() => resetRuntimeState(NAMESPACES));

// ── 1. executeHeartbeatProbe 正例 ──────────────────────────────────────────

test('心跳探测正例：user_token_passthrough + 200 → verified，请求头带 X-On-Behalf-Of', async () => {
  const registered = within('hb-a', () => registerTenantCustomSystem({ materials: baseMaterials({ code: 'SHBA' }), actor: { id: 'tester' } }));
  assert.equal(registered.code, 'SHBA');
  const { getTenantSystemDefinitions } = await import('../src/services/system-registry-service.js');
  const def = within('hb-a', () => getTenantSystemDefinitions().find((d) => d.code === 'SHBA'));
  const record = {};
  const fetcher = mockFetcher({ status: 200, body: '{"status":"ok"}' }, record);
  // executeHeartbeatProbe 必须在租户上下文里调（credentialResolver 依赖 currentSemanticTenant）
  const result = await within('hb-a', () => executeHeartbeatProbe(def, { identityScope: identity('hb-a'), fetcher }));
  assert.equal(result.status, 'verified');
  assert.equal(result.issue, null);
  assert.equal(record.url, 'https://api.supplier.example.com/health');
  assert.equal(record.method, 'GET');
  assert.equal(record.headers['X-On-Behalf-Of'], 'heartbeat-tester', '用户令牌透传：转发当前用户身份');
  assert.equal(record.headers.Authorization, undefined, '用户令牌透传：智脑不持有凭据');
});

test('心跳探测正例：service_principal + 凭据解析成功 + 200 → verified，请求头带 Authorization', async () => {
  const registered = within('hb-b', () => registerTenantCustomSystem({
    materials: baseMaterials({
      code: 'SHBB',
      auth: { scheme: 'service_principal', credentialRef: 'kms://integration/supplier-sp', scope: ['read:supplier', 'heartbeat'], writeApprovalRequired: true }
    }),
    actor: { id: 'tester' }
  }));
  assert.equal(registered.code, 'SHBB');
  // 登记时自动注册了凭据策略，确认 Key Center 有记录
  const policy = within('hb-b', () => getCustomSystemCredentialPolicy(registered.id));
  assert.ok(policy, '登记 service_principal 系统时应自动注册凭据策略');
  assert.equal(policy.secretRef, 'kms://integration/supplier-sp');
  assert.deepEqual(policy.operations, ['read:supplier', 'heartbeat']);
  const { getTenantSystemDefinitions } = await import('../src/services/system-registry-service.js');
  const def = within('hb-b', () => getTenantSystemDefinitions().find((d) => d.code === 'SHBB'));
  const record = {};
  const fetcher = mockFetcher({ status: 200, body: '{"status":"ok"}' }, record);
  // executeHeartbeatProbe 必须在租户上下文里调（credentialResolver 读 Key Center 按租户隔离）
  const result = await within('hb-b', () => executeHeartbeatProbe(def, { identityScope: identity('hb-b'), fetcher }));
  assert.equal(result.status, 'verified');
  assert.match(record.headers.Authorization, /^Bearer hb-/, 'service_principal：请求头带 opaque Bearer token');
  assert.equal(record.headers['X-On-Behalf-Of'], undefined, 'service_principal：不转发用户身份（机器调用）');
});

// ── 2. executeHeartbeatProbe 反例 ───────────────────────────────────────────

test('心跳探测反例：fetcher 抛错 → failed (HEARTBEAT_TRANSPORT_FAILED)', async () => {
  const { getTenantSystemDefinitions } = await import('../src/services/system-registry-service.js');
  within('hb-c', () => registerTenantCustomSystem({ materials: baseMaterials({ code: 'SHBC' }), actor: { id: 'tester' } }));
  const def = within('hb-c', () => getTenantSystemDefinitions().find((d) => d.code === 'SHBC'));
  const fetcher = async () => { throw new Error('network unreachable'); };
  const result = await executeHeartbeatProbe(def, { identityScope: identity('hb-c'), fetcher });
  assert.equal(result.status, 'failed');
  assert.equal(result.issue.code, 'HEARTBEAT_TRANSPORT_FAILED');
  assert.match(result.issue.message, /network unreachable/);
});

test('心跳探测反例：status 不匹配 → failed (HEARTBEAT_STATUS_MISMATCH)', async () => {
  const { getTenantSystemDefinitions } = await import('../src/services/system-registry-service.js');
  within('hb-d', () => registerTenantCustomSystem({ materials: baseMaterials({ code: 'SHBD' }), actor: { id: 'tester' } }));
  const def = within('hb-d', () => getTenantSystemDefinitions().find((d) => d.code === 'SHBD'));
  const fetcher = mockFetcher({ status: 503, body: '' });
  const result = await executeHeartbeatProbe(def, { identityScope: identity('hb-d'), fetcher });
  assert.equal(result.status, 'failed');
  assert.equal(result.issue.code, 'HEARTBEAT_STATUS_MISMATCH');
  assert.match(result.issue.message, /503.*200/);
});

test('心跳探测反例：expectedBody 不匹配 → failed (HEARTBEAT_BODY_MISMATCH)', async () => {
  const { getTenantSystemDefinitions } = await import('../src/services/system-registry-service.js');
  within('hb-e', () => registerTenantCustomSystem({
    materials: baseMaterials({ code: 'SHBE', heartbeat: { endpoint: 'https://api.example.com/health', expectedBody: '"status":"healthy"' } }),
    actor: { id: 'tester' }
  }));
  const def = within('hb-e', () => getTenantSystemDefinitions().find((d) => d.code === 'SHBE'));
  const fetcher = mockFetcher({ status: 200, body: '{"status":"degraded"}' });
  const result = await executeHeartbeatProbe(def, { identityScope: identity('hb-e'), fetcher });
  assert.equal(result.status, 'failed');
  assert.equal(result.issue.code, 'HEARTBEAT_BODY_MISMATCH');
  assert.match(result.issue.message, /不含预期内容/);
});

test('心跳探测反例：无 fetcher → failed (HEARTBEAT_FETCHER_UNAVAILABLE)', async () => {
  const { getTenantSystemDefinitions } = await import('../src/services/system-registry-service.js');
  within('hb-f', () => registerTenantCustomSystem({ materials: baseMaterials({ code: 'SHBF' }), actor: { id: 'tester' } }));
  const def = within('hb-f', () => getTenantSystemDefinitions().find((d) => d.code === 'SHBF'));
  const result = await executeHeartbeatProbe(def, { identityScope: identity('hb-f'), fetcher: null });
  assert.equal(result.status, 'failed');
  assert.equal(result.issue.code, 'HEARTBEAT_FETCHER_UNAVAILABLE');
});

// ── 3. probeSystemConnection 优先走心跳路径 + 接通门禁 ─────────────────────

test('probeSystemConnection 优先走心跳路径：自定义系统有 heartbeat 时走真实 HTTP 探测', async () => {
  within('hb-g', () => registerTenantCustomSystem({ materials: baseMaterials({ code: 'SHBG' }), actor: { id: 'tester' } }));
  const fetcher = mockFetcher({ status: 200, body: '{"status":"ok"}' });
  const result = await within('hb-g', () => probeSystemConnection({
    code: 'SHBG', roleId: 'executive', identityScope: identity('hb-g'), fetcher
  }));
  assert.equal(result.code, 'SHBG');
  assert.equal(result.status, 'verified');
  assert.equal(result.probeKind, 'heartbeat', '自定义系统有 heartbeat 时走心跳路径');
  assert.equal(result.issue, null);
});

test('接通门禁：心跳 verified 后可接通（不放宽 reason 必填）', async () => {
  within('hb-h', () => registerTenantCustomSystem({ materials: baseMaterials({ code: 'SHBH' }), actor: { id: 'tester' } }));
  const fetcher = mockFetcher({ status: 200, body: '{"status":"ok"}' });
  // 先探测取得 verified
  const probe = await within('hb-h', () => probeSystemConnection({ code: 'SHBH', roleId: 'executive', identityScope: identity('hb-h'), fetcher }));
  assert.equal(probe.status, 'verified');
  // 接通仍需 reason 必填（人工签字语义，ADR-023 第 4 条）
  const noReason = within('hb-h', () => transitionTenantSystemConnection({ code: 'SHBH', to: 'connected', reason: '', identityScope: identity('hb-h') }));
  assert.equal(noReason.code, 'SYSTEM_TRANSITION_REASON_REQUIRED');
  // 带理由可接通（需先 authorized 再 connected）
  within('hb-h', () => transitionTenantSystemConnection({ code: 'SHBH', to: 'authorized', reason: '授权通过', identityScope: identity('hb-h') }));
  const connected = within('hb-h', () => transitionTenantSystemConnection({ code: 'SHBH', to: 'connected', reason: '心跳探测通过，业务确认接入', identityScope: identity('hb-h') }));
  assert.equal(connected.to, 'connected');
  assert.equal(connected.from, 'authorized', '接通前状态为 authorized');
  // 心跳未通过时不可接通
  within('hb-h2', () => registerTenantCustomSystem({ materials: baseMaterials({ code: 'SHBI' }), actor: { id: 'tester' } }));
  const failedProbe = await within('hb-h2', () => probeSystemConnection({ code: 'SHBI', roleId: 'executive', identityScope: identity('hb-h2'), fetcher: mockFetcher({ status: 503 }) }));
  assert.equal(failedProbe.status, 'failed');
  const blocked = within('hb-h2', () => transitionTenantSystemConnection({ code: 'SHBI', to: 'connected', reason: '尝试接通', identityScope: identity('hb-h2') }));
  assert.equal(blocked.code, 'SYSTEM_CONNECT_PROBE_REQUIRED');
});

test('降级路径：平台系统（无 heartbeat 字段）仍走模拟数据源', async () => {
  // 平台系统（如 ERP）没有 heartbeat 字段——它们仍走模拟数据源探测（ADR-028 不影响平台系统）
  const result = await within('hb-i', () => probeSystemConnection({ code: 'ERP', roleId: 'executive', identityScope: identity('hb-i') }));
  assert.equal(result.code, 'ERP');
  assert.notEqual(result.status, 'failed', '平台系统走模拟数据源，不应因心跳路径而失败');
  assert.equal(result.probeKind, undefined, '平台系统无 heartbeat，走模拟数据源路径（probeKind 未设置）');
  assert.ok(result.simulatedScope === undefined || typeof result.simulatedScope === 'undefined', '平台系统探测不带 simulatedScope 标注');
});

// ── 4. 凭据策略注册边界 ─────────────────────────────────────────────────────

test('凭据策略注册：user_token_passthrough 不注册凭据策略（智脑不持有凭据）', () => {
  const registered = within('hb-j', () => registerTenantCustomSystem({ materials: baseMaterials({ code: 'SHBK' }), actor: { id: 'tester' } }));
  const policy = within('hb-j', () => getCustomSystemCredentialPolicy(registered.id));
  assert.equal(policy, null, 'user_token_passthrough 不在 Key Center 注册凭据策略');
});

test('凭据策略注册：service_principal 自动注册，可重复登记版本递增', () => {
  const registered = within('hb-k', () => registerTenantCustomSystem({
    materials: baseMaterials({ code: 'SHBL', auth: { scheme: 'service_principal', credentialRef: 'kms://integration/sp1', scope: ['read:x'], writeApprovalRequired: true } }),
    actor: { id: 'tester' }
  }));
  const policy = within('hb-k', () => getCustomSystemCredentialPolicy(registered.id));
  assert.ok(policy);
  assert.equal(policy.version, 1);
  // 再次注册（模拟凭据轮换）
  within('hb-k', () => registerCustomSystemCredentialPolicy({ connectorId: registered.id, secretRef: 'kms://integration/sp1', scope: ['read:x', 'read:y'] }));
  const updated = within('hb-k', () => getCustomSystemCredentialPolicy(registered.id));
  assert.equal(updated.version, 2);
  assert.deepEqual(updated.operations, ['read:x', 'read:y']);
});

// ── 5. 新授权方式（ADR-028 8-7）─────────────────────────────────────────────

test('心跳探测正例：api_key + 凭据解析成功 + 200 → verified，请求头带 X-API-Key', async () => {
  const registered = within('hb-l', () => registerTenantCustomSystem({
    materials: baseMaterials({
      code: 'SHBM',
      auth: { scheme: 'api_key', credentialRef: 'kms://integration/supplier-apikey', writeApprovalRequired: true }
    }),
    actor: { id: 'tester' }
  }));
  assert.equal(registered.code, 'SHBM');
  const { getTenantSystemDefinitions } = await import('../src/services/system-registry-service.js');
  const def = within('hb-l', () => getTenantSystemDefinitions().find((d) => d.code === 'SHBM'));
  const record = {};
  const fetcher = mockFetcher({ status: 200, body: '{"status":"ok"}' }, record);
  const result = await within('hb-l', () => executeHeartbeatProbe(def, { identityScope: identity('hb-l'), fetcher }));
  assert.equal(result.status, 'verified');
  assert.match(record.headers['X-API-Key'], /^hb-/, 'api_key：请求头带 X-API-Key（opaque handle）');
  assert.equal(record.headers.Authorization, undefined, 'api_key：不设 Authorization 头');
  assert.equal(record.headers['X-On-Behalf-Of'], undefined, 'api_key：不转发用户身份');
});

test('心跳探测正例：oauth_authorization_code + 凭据解析成功 + 200 → verified，请求头带 Authorization Bearer', async () => {
  const registered = within('hb-m', () => registerTenantCustomSystem({
    materials: baseMaterials({
      code: 'SHBN',
      auth: { scheme: 'oauth_authorization_code', credentialRef: 'kms://integration/supplier-oauth', redirectUri: 'https://app.example.com/callback', writeApprovalRequired: true }
    }),
    actor: { id: 'tester' }
  }));
  assert.equal(registered.code, 'SHBN');
  const { getTenantSystemDefinitions } = await import('../src/services/system-registry-service.js');
  const def = within('hb-m', () => getTenantSystemDefinitions().find((d) => d.code === 'SHBN'));
  const record = {};
  const fetcher = mockFetcher({ status: 200, body: '{"status":"ok"}' }, record);
  const result = await within('hb-m', () => executeHeartbeatProbe(def, { identityScope: identity('hb-m'), fetcher }));
  assert.equal(result.status, 'verified');
  assert.match(record.headers.Authorization, /^Bearer hb-/, 'oauth_authorization_code：请求头带 Bearer token');
  assert.equal(record.headers['X-On-Behalf-Of'], undefined, 'oauth_authorization_code：不转发用户身份');
});

test('心跳探测正例：mTLS + 200 → verified，无特殊请求头（TLS 层签名）', async () => {
  const registered = within('hb-n', () => registerTenantCustomSystem({
    materials: baseMaterials({
      code: 'SHBO',
      auth: { scheme: 'mTLS', credentialRef: 'kms://integration/supplier-mtls', writeApprovalRequired: true }
    }),
    actor: { id: 'tester' }
  }));
  assert.equal(registered.code, 'SHBO');
  const { getTenantSystemDefinitions } = await import('../src/services/system-registry-service.js');
  const def = within('hb-n', () => getTenantSystemDefinitions().find((d) => d.code === 'SHBO'));
  const record = {};
  const fetcher = mockFetcher({ status: 200, body: '{"status":"ok"}' }, record);
  const result = await within('hb-n', () => executeHeartbeatProbe(def, { identityScope: identity('hb-n'), fetcher }));
  assert.equal(result.status, 'verified');
  assert.equal(record.headers.Authorization, undefined, 'mTLS：不设 Authorization 头（TLS 层签名）');
  assert.equal(record.headers['X-API-Key'], undefined, 'mTLS：不设 X-API-Key 头');
  assert.equal(record.headers['X-On-Behalf-Of'], undefined, 'mTLS：不转发用户身份');
});

test('凭据策略注册：api_key / oauth_authorization_code / mTLS 均自动注册凭据策略', () => {
  const schemes = [
    { scheme: 'api_key', credentialRef: 'kms://test/ak1', label: 'api_key' },
    { scheme: 'oauth_authorization_code', credentialRef: 'kms://test/oauth1', redirectUri: 'https://app.example.com/cb', label: 'oauth' },
    { scheme: 'mTLS', credentialRef: 'kms://test/mtls1', label: 'mTLS' }
  ];
  for (const { scheme, credentialRef, redirectUri, label } of schemes) {
    const tenant = `hb-p-${label}`;
    const code = `SHBP${label.charAt(0).toUpperCase()}`;
    const authBase = { scheme, credentialRef, writeApprovalRequired: true };
    if (redirectUri) authBase.redirectUri = redirectUri;
    const registered = within(tenant, () => registerTenantCustomSystem({
      materials: baseMaterials({ code, auth: authBase }),
      actor: { id: 'tester' }
    }));
    assert.equal(registered.code, code, `${label} 登记成功`);
    const policy = within(tenant, () => getCustomSystemCredentialPolicy(registered.id));
    assert.ok(policy, `${label} 应自动注册凭据策略`);
    assert.equal(policy.secretRef, credentialRef, `${label} 凭据策略 secretRef 匹配`);
  }
});

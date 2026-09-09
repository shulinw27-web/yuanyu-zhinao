import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDingTalkAuthService } from '../src/services/dingtalk-auth-service.js';
import { readDingTalkConfiguration } from '../src/config/dingtalk-config.js';
import { loadRuntimeConfiguration } from '../src/config/runtime-config.js';
import { createIdentitySessionService } from '../src/services/identity-session-service.js';
import { createIdentityProviderService } from '../src/services/identity-provider-service.js';
import { evaluateClientRequest } from '../src/services/client-version-policy-service.js';
import { isPublicPath } from '../src/http/route-security.js';
import { resolveRequestIdentity } from '../src/services/request-identity-service.js';
import { handleIdentityRoutes } from '../src/routes/identity-routes.js';

const config = () => ({ corpId: 'corp-test', clientId: 'app-test', clientSecret: 'synthetic-secret', tenantId: 'enterprise-test', allowedOrigins: ['https://agent.example.test'], userBindings: [{ userId: 'employee-1', account: 'production@demo.local' }] });
const identity = { origin: 'https://agent.example.test', deviceId: 'test-device', platform: 'dingtalk-mobile' };
const user = () => ({ id: 'u-test', account: 'production@demo.local', name: '测试成员', status: 'active', primaryRoleId: 'production_manager', roleIds: ['production_manager'], version: 1 });
function setup(overrides = {}) {
  const calls = []; const sessions = [];
  let now = 1000;
  const service = createDingTalkAuthService({ getConfig: config, clock: () => now, findUser: user,
    issueSession: async (input) => { sessions.push(input); return { id: 'identity-test' }; },
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return new Response(JSON.stringify(url.includes('/oauth2/') ? { accessToken: 'synthetic-token', expireIn: 7200 } : { errcode: 0, result: { userid: 'employee-1', name: '不可信昵称', sys: true } }));
    }, ...overrides });
  const login = (extra = {}) => service.login({ ...identity, corpId: 'corp-test', code: 'one-use-code', challengeId: service.challenge(identity).challengeId, ...extra });
  return { service, calls, sessions, login, advance: (ms) => { now += ms; } };
}

test('未配置时关闭登录，不返回密钥或模拟身份', async () => {
  const { service, calls } = setup({ getConfig: () => { throw new Error('secret/path'); } });
  assert.equal(service.connection().configured, false);
  assert.equal(service.challenge(identity).status, 503);
  assert.equal((await service.login(identity)).status, 503);
  assert.equal(calls.length, 0);
  assert.doesNotMatch(JSON.stringify(service.connection()), /secret|path/);
});
test('手机与 PC 免登映射到平台角色，不信任浏览器角色或钉钉管理员标识', async () => {
  for (const platform of ['dingtalk-mobile', 'dingtalk-pc']) {
    const { service, sessions } = setup();
    const context = { ...identity, platform };
    const result = await service.login({ ...context, challengeId: service.challenge(context).challengeId, code: 'code', corpId: 'corp-test', roleId: 'admin', account: 'admin@demo.local' });
    assert.equal(result.user.roleId, 'production_manager');
    assert.equal(result.user.name, '测试成员');
    assert.equal(sessions[0].tenantId, 'enterprise-test');
    assert.equal(sessions[0].platform, platform);
    assert.equal(sessions[0].deviceId, identity.deviceId);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|synthetic-token|不可信/);
  }
});
test('固定官方端点、POST 免登码、不自动重试单次授权', async () => {
  const { calls, login } = setup();
  await login();
  assert.equal(calls[0].url, 'https://api.dingtalk.com/v1.0/oauth2/accessToken');
  assert.equal(JSON.parse(calls[0].body).appKey, 'app-test');
  assert.equal(new URL(calls[1].url).hostname, 'oapi.dingtalk.com');
  assert.equal(JSON.parse(calls[1].body).code, 'one-use-code');
  assert.ok(calls.every((call) => call.redirect === 'error' && call.signal && call.method === 'POST'));
});
test('拒绝跨企业、跨来源、跨设备和非钉钉通道', async () => {
  for (const extra of [{ corpId: 'other-corp' }, { origin: 'https://evil.test' }, { origin: undefined }, { deviceId: 'other' }, { platform: 'desktop' }]) {
    const { login, calls, sessions } = setup();
    assert.ok((await login(extra)).error);
    assert.equal(calls.length, 0); assert.equal(sessions.length, 0);
  }
});
test('挑战一次性、过期、配置变更及免登码重复使用均拒绝', async () => {
  const { service, login, advance, calls } = setup();
  const challengeId = service.challenge(identity).challengeId;
  advance(120001);
  assert.equal((await service.login({ ...identity, challengeId, corpId: 'corp-test', code: 'code' })).code, 'DINGTALK_CHALLENGE_INVALID');
  assert.equal((await login()).sessionId, 'identity-test');
  assert.equal((await login()).code, 'DINGTALK_CODE_REPLAY');
  assert.equal(calls.length, 2);
  const changing = config();
  const fixture = setup({ getConfig: () => changing });
  const pending = fixture.service.challenge(identity).challengeId;
  changing.tenantId = 'other';
  assert.equal((await fixture.service.login({ ...identity, challengeId: pending, corpId: 'corp-test', code: 'code' })).code, 'DINGTALK_CHALLENGE_INVALID');
});
test('同码并发仅签发一个会话；应用 token 缓存仍逐次验证免登码', async () => {
  const { login, sessions, calls } = setup();
  const results = await Promise.all([login(), login()]);
  assert.equal(results.filter((result) => result.sessionId).length, 1);
  await login({ code: 'another-code' });
  assert.equal(sessions.length, 2);
  assert.equal(calls.filter((call) => call.url.includes('/oauth2/')).length, 1);
});
test('未映射、停用账号、无效主角色不会创建会话', async () => {
  for (const overrides of [{ getConfig: () => ({ ...config(), userBindings: [] }) }, { findUser: () => null }, { findUser: () => ({ ...user(), status: 'disabled' }) }, { findUser: () => ({ ...user(), roleIds: [] }) }]) {
    const { login, sessions } = setup(overrides);
    assert.equal((await login()).status, 403); assert.equal(sessions.length, 0);
  }
});
test('上游错误、恶意响应、网络超时均不泄露凭据或创建会话', async () => {
  for (const fetchImpl of [async () => { throw new Error('token=synthetic-secret'); }, async () => new Response('secret', { status: 500 }), async () => new Response('not-json'), async () => new Response(JSON.stringify({ errcode: 40029, errmsg: 'secret' }))]) {
    const { login, sessions } = setup({ fetchImpl });
    const result = await login();
    assert.equal(result.code, 'DINGTALK_LOGIN_FAILED');
    assert.doesNotMatch(JSON.stringify(result), /secret|token=/); assert.equal(sessions.length, 0);
  }
});
test('钉钉会话复用既有停用、权限版本与设备绑定校验', async () => {
  const state = new Map(); const current = user();
  const sessions = createIdentitySessionService({ validateProviderBinding: createIdentityProviderService({ getDingTalkConfig: config }).validateSessionBinding, repository: { readState: async (_n, key) => state.get(key), writeState: async (_n, key, value) => state.set(key, value), deleteState: async (_n, key) => state.delete(key) }, findUserByAccount: () => current, findRolePolicy: () => ({ version: 1 }) });
  const fixture = setup({ issueSession: sessions.issueIdentitySession });
  const logged = await fixture.login();
  assert.ok((await sessions.validateIdentitySession(logged.sessionId, undefined, identity.deviceId)).session);
  assert.ok((await sessions.validateIdentitySession(logged.sessionId, undefined, 'wrong-device')).error);
  current.version++;
  assert.equal((await sessions.validateIdentitySession(logged.sessionId, undefined, identity.deviceId)).code, 'IDENTITY_AUTHORIZATION_STALE');
});
test('配置要求服务器文件、精确来源及唯一映射；生产钉钉身份模式保留安全启动门禁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dingtalk-config-test-'));
  const path = join(dir, 'config.json');
  const env = { NODE_ENV: 'production', DINGTALK_ENABLED: 'true', DINGTALK_CONFIG_FILE: path };
  try {
    writeFileSync(path, JSON.stringify(config()));
    assert.equal(readDingTalkConfiguration(env).corpId, 'corp-test');
    const production = { ...env, OA_AUTH_MODE: 'dingtalk', ACCOUNT_AUTH_MODE: 'enterprise', DEMO_ALLOW_ROLE_HEADER: 'false', AGENT_RUNTIME_MODE: 'local', SINGLE_NODE_DEPLOYMENT: 'true', KEY_CENTER_PROVIDER: 'external-kms', KEY_CENTER_PROVIDER_URL: 'https://kms.example.test', KEY_CENTER_WORKLOAD_ID: 'test-api', CORS_ALLOWED_ORIGINS: identity.origin };
    assert.equal(loadRuntimeConfiguration(production).nodeEnv, 'production');
    assert.throws(() => loadRuntimeConfiguration({ ...production, SINGLE_NODE_DEPLOYMENT: 'false' }), /SINGLE_NODE_DEPLOYMENT/);
    assert.throws(() => loadRuntimeConfiguration({ ...production, DINGTALK_ENABLED: 'false' }), /钉钉/);
    for (const mutation of [{ allowedOrigins: ['*'] }, { allowedOrigins: ['http://intranet.local'] }, { allowedOrigins: ['https://agent.example.test/path'] }, { userBindings: [config().userBindings[0], config().userBindings[0]] }, { clientSecret: 'REPLACE_WITH_APP_SECRET' }]) {
      writeFileSync(path, JSON.stringify({ ...config(), ...mutation }));
      assert.throws(() => readDingTalkConfiguration(env));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('撤销钉钉绑定立即使既有会话失效，开发态也不允许钉钉 Demo 角色兜底', async () => {
  const state = new Map(); const currentConfig = config();
  const sessions = createIdentitySessionService({ validateProviderBinding: createIdentityProviderService({ getDingTalkConfig: () => currentConfig }).validateSessionBinding, repository: { readState: async (_n, key) => state.get(key), writeState: async (_n, key, value) => state.set(key, value), deleteState: async (_n, key) => state.delete(key) }, findUserByAccount: user, findRolePolicy: () => ({ version: 1 }) });
  const fixture = setup({ issueSession: sessions.issueIdentitySession });
  const logged = await fixture.login();
  currentConfig.userBindings = [];
  assert.equal((await sessions.validateIdentitySession(logged.sessionId, null, identity.deviceId)).code, 'DINGTALK_IDENTITY_REVOKED');
  for (const platform of ['dingtalk-mobile', 'dingtalk-pc']) assert.ok((await resolveRequestIdentity({ headers: { 'x-client-platform': platform, 'x-demo-role': 'admin' }, allowDemoRoleHeader: true })).error);
});

test('实际身份路由返回未配置状态和 503，附带伪造身份也不能登录', async () => {
  const previous = process.env.DINGTALK_ENABLED;
  process.env.DINGTALK_ENABLED = 'false';
  try {
    for (const [method, path] of [['GET', '/api/auth/dingtalk/config'], ['POST', '/api/auth/dingtalk/login/challenge'], ['POST', '/api/auth/dingtalk/login']]) {
      let response;
      const handled = await handleIdentityRoutes({ req: { method, headers: { origin: identity.origin, 'x-client-platform': 'dingtalk-mobile', 'x-client-device-id': identity.deviceId } }, res: {}, url: new URL(`https://agent.example.test${path}`), readBody: async () => ({ roleId: 'admin', account: 'admin@demo.local', corpId: 'corp-test', code: 'untrusted' }), send: (_res, status, body) => { response = { status, body }; } });
      assert.equal(handled, true);
      assert.equal(response.status, method === 'GET' ? 200 : 503);
      assert.equal(response.body.sessionId, undefined);
    }
  } finally { if (previous === undefined) delete process.env.DINGTALK_ENABLED; else process.env.DINGTALK_ENABLED = previous; }
});

test('钉钉只公开登录端点，业务端点和版本门禁仍然生效', () => {
  assert.equal(isPublicPath('/api/auth/dingtalk/login'), true);
  assert.equal(isPublicPath('/api/auth/dingtalk/login/anything'), false);
  assert.equal(isPublicPath('/api/agent/message'), false);
  for (const platform of ['dingtalk-mobile', 'dingtalk-pc']) {
    assert.equal(evaluateClientRequest({ 'x-client-platform': platform, 'x-client-version': '0.3.0' }, { production: true }).allowed, true);
    assert.equal(evaluateClientRequest({ 'x-client-platform': platform, 'x-client-version': '0.1.0' }, { production: true }).allowed, false);
  }
});

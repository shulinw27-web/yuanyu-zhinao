import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { validateIdentityProviderConfiguration, readIdentityProviderConfiguration } from '../src/config/identity-provider-config.js';
import { loadRuntimeConfiguration } from '../src/config/runtime-config.js';
import { createIdentityProviderService } from '../src/services/identity-provider-service.js';
import { createIdentityProviderRegistry } from '../src/services/identity-provider-registry.js';
import { verifyEnterpriseAccessToken } from '../src/services/enterprise-oidc-service.js';
import { createIdentitySessionService, issueIdentitySession, revokeIdentitySession } from '../src/services/identity-session-service.js';
import { resolveRequestIdentityAsync } from '../src/services/request-identity-service.js';
import { loginWithOA } from '../src/services/oa-auth-service.js';
import { loginWithLocalAccount } from '../src/services/account-center-service.js';
import { handleIdentityRoutes } from '../src/routes/identity-routes.js';
import { isPublicPath } from '../src/http/route-security.js';
import { sendJson } from '../src/http/http-utils.js';

const provider = (id = 'company-sso', account = 'quality@demo.local') => ({ id, type: 'oidc', name: id, enabled: true, issuer: `https://${id}.example.test`, jwksUri: `https://${id}.example.test/jwks`, audience: 'zhinao-api', tenantId: 'company', bindings: [{ subject: 'employee-1', account }] });
const configuration = () => validateIdentityProviderConfiguration({ version: 1, defaultBearerProviderId: 'company-sso', providers: [provider(), provider('second-sso', 'production@demo.local')] });
const { privateKey, publicKey } = await generateKeyPair('RS256');
const key = await exportJWK(publicKey); key.kid = 'test-key'; key.alg = 'RS256';
const jwks = createLocalJWKSet({ keys: [key] });
const token = (issuer = provider().issuer, claims = {}, audience = 'zhinao-api', subject = 'employee-1') => new SignJWT({ email: 'executive@demo.local', roles: ['executive'], ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(privateKey);
const service = (getConfiguration = configuration) => createIdentityProviderService({ env: {}, getConfiguration, oidcVerifier: (value, options) => verifyEnterpriseAccessToken(value, { ...options, jwks }) });

test('标准 OIDC 无 tid 也可接入；使用 sub 映射且忽略外部邮箱和管理员角色', async () => {
  const result = await service().verifyBearer(await token());
  assert.equal(result.role, 'quality_manager');
  assert.equal(result.subjectId, 'quality@demo.local');
  assert.equal(result.externalIdentity.providerId, 'company-sso');
  assert.equal(result.tenantId, 'company');
});

test('相同 subject 在不同身份源独立绑定，不跨 issuer 探测或回退', async () => {
  const api = service();
  assert.equal((await api.verifyBearer(await token(provider('second-sso').issuer), 'second-sso')).role, 'production_manager');
  assert.equal((await api.verifyBearer(await token(), 'second-sso')).code, 'OIDC_TOKEN_INVALID');
  assert.ok((await api.verifyBearer(await token(), 'unknown')).error);
  assert.ok((await api.verifyBearer(await token(), '__proto__')).error);
});

test('错误 audience、未绑定 subject、失效签名不回退 Demo 或邮箱映射', async () => {
  const api = service();
  assert.equal((await api.verifyBearer(await token(undefined, {}, 'other-api'))).code, 'OIDC_TOKEN_INVALID');
  assert.equal((await api.verifyBearer(await token(undefined, { email: 'quality@demo.local' }, undefined, 'unbound'))).code, 'OIDC_IAM_USER_NOT_FOUND');
  const signed = await token();
  assert.equal((await api.verifyBearer(`${signed.slice(0, signed.lastIndexOf('.') + 1)}invalid`)).code, 'OIDC_TOKEN_INVALID');
});

test('可选企业声明与平台 tenant 分开，跨企业声明被拒绝', async () => {
  const config = configuration(); Object.assign(config.providers[0], { tenantClaim: 'tid', externalTenantId: 'corp-external' });
  const api = service(() => config);
  assert.equal((await api.verifyBearer(await token(undefined, { tid: 'corp-external' }))).tenantId, 'company');
  assert.equal((await api.verifyBearer(await token(undefined, { tid: 'wrong-corp' }))).code, 'OIDC_TOKEN_INVALID');
});

test('身份源停用、删除绑定和配置读取失败作用于下一次 Bearer 请求', async () => {
  const config = configuration(); const api = service(() => config); const signed = await token();
  assert.equal((await api.verifyBearer(signed)).role, 'quality_manager');
  config.providers[0].bindings = [];
  assert.equal((await api.verifyBearer(signed)).code, 'OIDC_IAM_USER_NOT_FOUND');
  config.providers[0].enabled = false;
  assert.equal((await api.verifyBearer(signed)).code, 'IDENTITY_PROVIDER_REVOKED');
  assert.ok((await service(() => { throw new Error('private-file-path'); }).verifyBearer(signed)).error);
});

test('无默认身份源时必须明确选择，不依赖 JWT 未验签的 issuer 自动路由', async () => {
  const config = configuration(); config.defaultBearerProviderId = null; const api = service(() => config);
  assert.ok((await api.verifyBearer(await token())).error);
  assert.equal((await api.verifyBearer(await token(), 'company-sso')).role, 'quality_manager');
});

test('适配器注册拒绝重复 ID 和客户端动态模块；公开描述不带绑定、端点或凭据', () => {
  const adapter = { id: 'sample', type: 'custom', name: 'Sample', configured: true, validateBinding: () => true };
  assert.equal(createIdentityProviderRegistry([adapter]).get('sample').type, 'custom');
  assert.throws(() => createIdentityProviderRegistry([adapter, adapter]));
  assert.throws(() => createIdentityProviderRegistry([{ ...adapter, id: undefined }]));
  assert.doesNotMatch(JSON.stringify(service().describe()), /bindings|employee-1|quality@|jwks|https:/);
  assert.deepEqual(service(() => { throw new Error('secret'); }).describe().providers, []);
});

test('统一会话验证绑定、发行方和内部 IAM 权限版本，撤销后删除持久会话', async () => {
  const config = configuration(); const api = service(() => config); const records = new Map();
  const user = { id: 'u1', version: 1, status: 'active', roleIds: ['quality_manager'] };
  const sessions = createIdentitySessionService({ repository: { readState: async (_n, id) => records.get(id), writeState: async (_n, id, value) => records.set(id, value), deleteState: async (_n, id) => records.delete(id) }, findUserByAccount: () => user, findRolePolicy: () => ({ version: 1 }), validateProviderBinding: api.validateSessionBinding });
  const identity = await api.verifyBearer(await token());
  const issue = () => sessions.issueIdentitySession({ source: 'external', account: identity.subjectId, tenantId: identity.tenantId, roleId: identity.role, deviceId: 'device-1', externalIdentity: identity.externalIdentity });
  const first = await issue();
  assert.ok((await sessions.validateIdentitySession(first.id, null, 'device-1')).session);
  assert.ok((await sessions.validateIdentitySession(first.id, null, 'device-2')).error);
  user.version++;
  assert.equal((await sessions.validateIdentitySession(first.id, null, 'device-1')).code, 'IDENTITY_AUTHORIZATION_STALE');
  const second = await issue(); config.providers[0].bindings = [];
  assert.equal((await sessions.validateIdentitySession(second.id, null, 'device-1')).code, 'IDENTITY_PROVIDER_REVOKED');
  assert.equal(records.has(second.id), false);
});

test('切换钉钉配置/身份源清单会拒绝旧会话；未知外部身份不得绕过验证', async () => {
  const config = configuration();
  const api = createIdentityProviderService({ env: {}, getConfiguration: () => config, getDingTalkConfig: () => ({ corpId: 'corp', clientId: 'app', tenantId: 'company', userBindings: [{ userId: 'employee-1', account: 'quality@demo.local' }] }) });
  const session = { source: 'dingtalk', tenantId: 'company', account: 'quality@demo.local', identityBinding: { corpId: 'corp', clientId: 'app', userId: 'employee-1' }, externalIdentity: { providerId: 'dingtalk', tenantId: 'company', subjectId: 'employee-1' } };
  assert.ok((await api.validateSessionBinding(session)).error);
  config.providers.push({ id: 'dingtalk', name: '钉钉', type: 'dingtalk', enabled: true });
  assert.equal(await api.validateSessionBinding(session), null);
  session.identityBinding.clientId = 'other-app';
  assert.ok((await api.validateSessionBinding(session)).error);
  assert.ok((await api.validateSessionBinding({ source: 'external' })).error);
  assert.ok((await api.validateSessionBinding({ ...session, externalIdentity: { providerId: 'unregistered' } })).error);
});

test('配置拒绝重复映射、不安全 URL、未知协议、缺失字段与无效默认项', () => {
  const mutations = [
    { providers: [provider(), provider()] }, { providers: [{ ...provider(), id: undefined }] },
    { providers: [{ ...provider(), type: 'wecom' }] }, { providers: [{ ...provider(), jwksUri: 'http://intranet/jwks' }] },
    { providers: [{ ...provider(), issuer: 'https://user:secret@sso.test' }] },
    { providers: [{ ...provider(), bindings: [...provider().bindings, ...provider().bindings] }] },
    { providers: [{ ...provider(), tenantClaim: 'tid' }] }, { defaultBearerProviderId: 'unregistered' },
    { providers: [{ ...provider(), tenantId: 'REPLACE_WITH_TENANT' }] }
  ];
  for (const mutation of mutations) assert.throws(() => validateIdentityProviderConfiguration({ version: 1, defaultBearerProviderId: 'company-sso', providers: [provider()], ...mutation }));
});

test('服务端文件适配生产启动门禁：可多 OIDC、不要求无关钉钉凭据、空身份源拒绝启动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'identity-provider-test-')); const path = join(dir, 'providers.json');
  const env = { IDENTITY_PROVIDERS_FILE: path, NODE_ENV: 'production', DEMO_ALLOW_ROLE_HEADER: 'false', AGENT_RUNTIME_MODE: 'local', SINGLE_NODE_DEPLOYMENT: 'true', KEY_CENTER_PROVIDER: 'external-kms', KEY_CENTER_PROVIDER_URL: 'https://kms.example.test', KEY_CENTER_WORKLOAD_ID: 'api-test', CORS_ALLOWED_ORIGINS: 'https://agent.example.test' };
  try {
    writeFileSync(path, JSON.stringify(configuration()));
    assert.equal(readIdentityProviderConfiguration(env).providers.length, 2);
    assert.equal(loadRuntimeConfiguration(env).nodeEnv, 'production');
    const config = configuration(); config.defaultBearerProviderId = null; config.providers.forEach((item) => { item.enabled = false; });
    writeFileSync(path, JSON.stringify(config));
    assert.throws(() => loadRuntimeConfiguration(env), /启用的身份源/);
    writeFileSync(path, 'invalid-json');
    assert.throws(() => loadRuntimeConfiguration(env), /IDENTITY_PROVIDERS_FILE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('托管身份配置存在即关闭本地和 OA Mock、Demo header；错误配置不回退', async () => {
  const previous = process.env.IDENTITY_PROVIDERS_FILE;
  process.env.IDENTITY_PROVIDERS_FILE = 'invalid-file';
  try {
    for (const login of [loginWithOA, loginWithLocalAccount]) assert.ok((await login({ account: 'quality@demo.local', password: 'demo' })).error);
    assert.ok((await resolveRequestIdentityAsync({ headers: { 'x-demo-role': 'executive' }, allowDemoRoleHeader: true })).error);
  } finally { if (previous === undefined) delete process.env.IDENTITY_PROVIDERS_FILE; else process.env.IDENTITY_PROVIDERS_FILE = previous; }
});

test('路由只公开脱敏能力目录，不开放身份绑定写入；跨域允许认证与身份选择头', async () => {
  let result;
  assert.equal(await handleIdentityRoutes({ req: { method: 'GET' }, res: {}, url: new URL('https://agent.test/api/auth/providers'), send: (_res, status, payload) => { result = { status, payload }; } }), true);
  assert.equal(result.status, 200); assert.ok(Array.isArray(result.payload.providers));
  assert.equal(isPublicPath('/api/auth/providers'), true); assert.equal(isPublicPath('/api/auth/providers/bindings'), false);
  let headers;
  sendJson({ writeHead: (_status, value) => { headers = value; }, end: () => {} }, 200, {});
  assert.match(headers['Access-Control-Allow-Headers'], /Authorization/); assert.match(headers['Access-Control-Allow-Headers'], /x-identity-provider/);
});

test('请求按指定身份源验签，不接受伪造 Demo 角色；缺少令牌不降级', async () => {
  const api = service();
  const result = await resolveRequestIdentityAsync({ headers: { authorization: `Bearer ${await token(provider('second-sso').issuer)}`, 'x-identity-provider': 'second-sso', 'x-demo-role': 'executive' }, oidcVerifier: api.verifyBearer });
  assert.equal(result.role, 'production_manager');
  assert.ok((await resolveRequestIdentityAsync({ headers: { 'x-identity-provider': 'second-sso' }, allowDemoRoleHeader: true })).error);
  assert.equal((await resolveRequestIdentityAsync({ headers: { authorization: 'Bearer token', 'x-identity-provider': '../attack' } })).code, 'IDENTITY_PROVIDER_INVALID');
});

test('旧本地会话不能通过身份源请求头伪装成新的企业登录', async () => {
  const session = await issueIdentitySession({ source: 'test', account: 'quality@demo.local', roleId: 'quality_manager', deviceId: 'identity-switch-test' });
  try {
    const result = await resolveRequestIdentityAsync({ headers: { 'x-identity-session': session.id, 'x-client-device-id': 'identity-switch-test', 'x-identity-provider': 'company-sso' } });
    assert.equal(result.code, 'IDENTITY_PROVIDER_MISMATCH');
  } finally { await revokeIdentitySession(session.id); }
});

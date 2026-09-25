import test from 'node:test';
import assert from 'node:assert/strict';
import { seedTenantIAM } from './helpers/tenant-iam-fixture.js';
import { resetRuntimeState, writeState, readState } from '../src/repositories/runtime-state-repository.js';
import { asyncRuntimeStateRepository } from '../src/repositories/async-runtime-state-repository.js';
import { configureIAMRepository, runWithIAMStoreContext, currentIAMTenant, getIAMSnapshot, findIAMUserByAccount, getIAMRolePolicy, updateIAMUser, updateIAMRolePolicy, appendIAMAudit } from '../src/services/iam-store.js';
import { iamWorkspaceKey, createTenantIAMWorkspace } from '../src/services/iam-workspace-model.js';
import { createAsyncIAMStore } from '../src/services/async-iam-store.js';
import { getEffectiveAccess } from '../src/services/access-control-service.js';
import { createIdentitySessionService } from '../src/services/identity-session-service.js';
import { verifyEnterpriseAccessToken } from '../src/services/enterprise-oidc-service.js';
import { createDingTalkAuthService } from '../src/services/dingtalk-auth-service.js';
import { listDomainEvents } from '../src/infrastructure/domain-events/domain-event-outbox.js';

const account = 'quality@demo.local';
const within = (tenant, work) => runWithIAMStoreContext(work, tenant);
const seed = () => {
  seedTenantIAM('company-a', [account]);
  const b = seedTenantIAM('company-b', [account]);
  b.users[0].name = 'B only';
  b.rolePolicies.quality_manager.menuIds = [];
  b.rolePolicies.quality_manager.buttonPermissionIds = [];
  writeState('iam', iamWorkspaceKey('company-b'), b);
};
test.beforeEach(() => { configureIAMRepository(null); resetRuntimeState(['iam', 'identity_sessions', 'domain_event_outbox']); seed(); });
test.afterEach(() => configureIAMRepository(null));

for (const driver of ['sync', 'async']) {
  test(`${driver}: concurrent tenant snapshots, same account, roles and audits remain isolated`, async () => {
    if (driver === 'async') configureIAMRepository(asyncRuntimeStateRepository);
    const values = await Promise.all(['company-a', 'company-b'].map(tenant => within(tenant, async () => {
      await new Promise(resolve => setImmediate(resolve));
      await appendIAMAudit({ action: tenant, targetId: 'synthetic' });
      assert.equal(currentIAMTenant(), tenant);
      return { snapshot: getIAMSnapshot(), access: getEffectiveAccess('quality_manager', { subjectId: account, tenantId: tenant }) };
    })));
    assert.ok(values[0].access.buttonPermissionIds.length > 0);
    assert.deepEqual(values[1].access.buttonPermissionIds, []);
    assert.equal(values[1].snapshot.users[0].name, 'B only');
    assert.deepEqual(values.map(value => value.snapshot.audits.map(audit => audit.action)), [['company-a'], ['company-b']]);
    await within('company-a', async () => {
      await assert.rejects(within('company-b', getIAMSnapshot), { code: 'IAM_TENANT_MISMATCH' });
      assert.throws(() => getEffectiveAccess('quality_manager', { subjectId: account, tenantId: 'company-b' }), { code: 'IAM_TENANT_MISMATCH' });
    });
  });

  test(`${driver}: policy and user changes revoke only the matching tenant sessions`, async () => {
    if (driver === 'async') configureIAMRepository(asyncRuntimeStateRepository);
    const sessions = createIdentitySessionService({ validateProviderBinding: async () => null });
    const issue = tenantId => sessions.issueIdentitySession({ source: 'synthetic', tenantId, account, roleId: 'quality_manager', deviceId: 'test-device' });
    const a = await issue('company-a'); const b = await issue('company-b');
    await within('company-a', async () => {
      const policy = getIAMRolePolicy('quality_manager');
      assert.equal((await updateIAMRolePolicy(policy.roleId, { ...policy, menuIds: [] }, policy.version)).policy.version, 2);
    });
    assert.equal((await sessions.validateIdentitySession(a.id, null, 'test-device')).code, 'IDENTITY_AUTHORIZATION_STALE');
    assert.equal((await sessions.validateIdentitySession(b.id, null, 'test-device')).session.id, b.id);
    const renewed = await issue('company-a');
    await within('company-a', async () => {
      const user = findIAMUserByAccount(account);
      await updateIAMUser(user.id, { ...user, status: 'disabled' }, user.version);
    });
    assert.equal((await sessions.validateIdentitySession(renewed.id, null, 'test-device')).code, 'IDENTITY_USER_INACTIVE');
    assert.ok((await sessions.validateIdentitySession(b.id, null, 'test-device')).session);
    await assert.rejects(issue('company-a'), { code: 'IDENTITY_TENANT_USER_UNBOUND' });
    assert.equal(await asyncRuntimeStateRepository.readState('identity_sessions', a.id), null);
  });

  test(`${driver}: new tenant is empty, never copies Demo and cannot issue a Demo session`, async () => {
    if (driver === 'async') configureIAMRepository(asyncRuntimeStateRepository);
    await within('new-company', () => {
      const snapshot = getIAMSnapshot();
      assert.deepEqual(snapshot.users, []); assert.deepEqual(snapshot.rolePolicies, []);
      assert.deepEqual(snapshot.organizations, []);
      assert.equal(findIAMUserByAccount(account), null);
    });
    const sessions = createIdentitySessionService();
    await assert.rejects(sessions.issueIdentitySession({ tenantId: 'new-company', account, roleId: 'quality_manager' }), { code: 'IDENTITY_TENANT_USER_UNBOUND' });
    await within('company-a', () => assert.equal(getEffectiveAccess('quality_manager', { source: 'demo_header', subjectId: 'demo:quality_manager:fake', tenantId: 'company-a' }).principalResolved, false));
    await runWithIAMStoreContext(() => assert.ok(findIAMUserByAccount(account)), 'demo-enterprise');
  });
}

test('tenant keys reject malformed values and cannot alias legacy or delimiter-shaped keys', async () => {
  for (const value of ['', ' a ', '\n', 42, null, 'a'.repeat(121)]) assert.throws(() => iamWorkspaceKey(value));
  assert.notEqual(iamWorkspaceKey('workspace'), iamWorkspaceKey('demo-enterprise'));
  assert.notEqual(iamWorkspaceKey('a:b'), iamWorkspaceKey('a'));
  assert.deepEqual(createTenantIAMWorkspace('new').users, []);
  const asyncStore = createAsyncIAMStore({ repository: asyncRuntimeStateRepository, tenantId: 'company-b' });
  assert.equal((await asyncStore.findUserByAccount(account)).name, 'B only');
});

test('session tenant binding tamper and legacy missing binding fail closed', async () => {
  const service = createIdentitySessionService({ validateProviderBinding: async () => null });
  for (const tenantId of ['company-b', undefined]) {
    const session = await service.issueIdentitySession({ tenantId: 'company-a', account, roleId: 'quality_manager' });
    writeState('identity_sessions', session.id, { ...session, tenantId });
    assert.equal((await service.validateIdentitySession(session.id)).code, 'IDENTITY_TENANT_BINDING_INVALID');
    assert.equal(readState('identity_sessions', session.id), null);
  }
});

test('OIDC maps verified provider tenant, not a globally matching account', async () => {
  const env = { OIDC_ISSUER: 'https://synthetic.test', OIDC_AUDIENCE: 'test', OIDC_JWKS_URI: 'https://synthetic.test/jwks', OIDC_TENANT_ID: 'new-company' };
  const options = { env, jwks: {}, jwtVerifyImpl: async () => ({ protectedHeader: { alg: 'RS256' }, payload: { sub: 'employee', tid: env.OIDC_TENANT_ID, email: account } }) };
  assert.equal((await verifyEnterpriseAccessToken('synthetic', options)).code, 'OIDC_IAM_USER_NOT_FOUND');
  env.OIDC_TENANT_ID = 'company-b';
  assert.equal((await verifyEnterpriseAccessToken('synthetic', options)).tenantId, 'company-b');
});

test('DingTalk verified enterprise cannot borrow a globally matching Demo account', async () => {
  const config = { corpId: 'synthetic', clientId: 'test', clientSecret: 'test', tenantId: 'unprovisioned', allowedOrigins: ['https://synthetic.test'], userBindings: [{ userId: 'employee', account }] };
  let issued = false;
  const service = createDingTalkAuthService({ getConfig: () => config, fetchImpl: async url => new Response(JSON.stringify(url.includes('/oauth2/') ? { accessToken: 'synthetic', expireIn: 7200 } : { errcode: 0, result: { userid: 'employee' } })), issueSession: async () => { issued = true; } });
  const input = { origin: 'https://synthetic.test', deviceId: 'device', platform: 'dingtalk-mobile' };
  assert.equal((await service.login({ ...input, challengeId: service.challenge(input).challengeId, corpId: config.corpId, code: 'test-code' })).code, 'DINGTALK_IAM_UNMAPPED');
  assert.equal(issued, false);
});

test('IAM outbox mutations bind the trusted tenant even when supplied event tenant differs', async () => {
  for (const async of [false, true]) {
    configureIAMRepository(async ? asyncRuntimeStateRepository : null);
    await within('company-a', async () => {
      const user = findIAMUserByAccount(account);
      await updateIAMUser(user.id, { ...user, name: 'Updated A' }, user.version, {
        type: 'iam.user.authorization_changed', aggregateType: 'IAMUser', aggregateId: user.id, tenantId: 'company-b',
        payload: { userId: user.id, roleIds: user.roleIds, status: user.status, policyVersion: user.version + 1 }
      });
    });
  }
  assert.equal((await listDomainEvents({ tenantId: 'company-a' })).length, 2);
  assert.equal((await listDomainEvents({ tenantId: 'company-b' })).length, 0);
});

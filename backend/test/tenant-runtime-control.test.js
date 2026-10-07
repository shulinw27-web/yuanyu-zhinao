import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantRuntimeControl, configureTenantRuntimeControl, tenantRuntimeFeature } from '../src/services/tenant-runtime-control-service.js';
import { resetRuntimeState, readState, writeState } from '../src/repositories/runtime-state-repository.js';
import { asyncRuntimeStateRepository } from '../src/repositories/async-runtime-state-repository.js';
import { iamWorkspaceKey } from '../src/services/iam-workspace-model.js';
import { runWithIAMStoreContext, getIAMUsers, getIAMOrganizations, getIAMRolePolicy, updateIAMRolePolicy } from '../src/services/iam-store.js';
import { createIdentitySessionService } from '../src/services/identity-session-service.js';
import { runWithTenantExecution } from '../src/services/tenant-execution-context.js';
import { dispatchAuthorizedRoutes } from '../src/http/authorized-route-dispatch.js';
import { executePrivateAgentCommand, claimPrivateAgentLongTask, completePrivateAgentDesktopExecution } from '../src/services/private-agent-service.js';
import { controlSemanticInspectionSchedule, createSemanticInspectionSchedule, listSemanticInspectionSchedules, runSemanticInspectionCycle } from '../src/services/semantic-inspection-schedule-service.js';

const timestamp = Date.parse('2026-09-17T00:00:00Z');
function fixture(tenantId = 'enrolled-a', options = {}) {
  let now = timestamp;
  const portal = { users: [{ id: 'portal-owner', status: 'active', authorizationVersion: 0 }],
    tenants: [{ id: tenantId, status: 'sandbox_ready', version: 1, membership: null, members: [{ userId: 'portal-owner', status: 'active', role: 'owner' }] }],
    provisioning: [{ id: 'job-1', tenantId, requestedBy: 'portal-owner', tenantVersion: 1, status: 'blocked' }] };
  const providers = { providers: [{ id: 'enterprise-sso', type: 'oidc', enabled: true, tenantId, issuer: 'https://synthetic.test', audience: 'test',
    bindings: [{ account: 'reviewer@synthetic.test', subject: 'employee-1' }] }] };
  const manifest = { version: 1, tenantId, provisioningId: 'job-1', expectedPortalVersion: 1, expiresAt: timestamp + 86400000,
    dailyRequests: 5, features: ['iam', 'semantic', 'knowledge'], organizations: [{ id: 'org-company', name: '合成企业', parentId: null }],
    users: [{ portalUserId: 'portal-owner', account: 'reviewer@synthetic.test', name: '合成校对员', orgUnitId: 'org-company',
      roleIds: ['executive'], primaryRoleId: 'executive', providerId: 'enterprise-sso', subject: 'employee-1' }] };
  const args = { readPortal: async () => portal, readProviders: () => providers, clock: () => now, ...options };
  const control = createTenantRuntimeControl(args);
  const identity = { tenantId, subjectId: manifest.users[0].account };
  const approve = async () => control.apply(manifest, (await control.prepare(manifest)).digest);
  return { portal, providers, manifest, control, identity, approve, install: () => configureTenantRuntimeControl(args), advance: ms => { now += ms; } };
}
test.beforeEach(() => { resetRuntimeState(['iam', 'tenant_runtime_control_v1', 'identity_sessions']); configureTenantRuntimeControl({}); });
test.afterEach(() => configureTenantRuntimeControl({}));

test('inspection cancelled while admission awaits never starts the executor', async () => {
  resetRuntimeState(['semantic_inspection_schedules', 'semantic_operations_notifications']);
  let cancelId;
  const f = fixture('cancel-admission', { readPortal: async () => {
    if (cancelId) { await controlSemanticInspectionSchedule({ id: cancelId, action: 'cancel', identityScope: f.identity }); cancelId = null; }
    return f.portal;
  } });
  f.install(); await f.approve();
  const created = await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role: { id: 'executive' }, identityScope: f.identity });
  cancelId = created.schedule.id;
  let calls = 0;
  await runSemanticInspectionCycle({ executeInspection: async () => { calls++; return { severity: 'info' }; } });
  assert.equal(calls, 0);
  const current = (await listSemanticInspectionSchedules({ identityScope: f.identity }))[0];
  assert.equal(current.status, 'cancelled'); assert.equal(current.lastRun, null);
});

test('inspection cycle itself enforces tenant admission and charges exactly once', async () => {
  resetRuntimeState(['semantic_inspection_schedules', 'semantic_operations_notifications']);
  const f = fixture(); f.install(); await f.approve();
  await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role: { id: 'executive' }, identityScope: f.identity });
  let calls = 0;
  await runSemanticInspectionCycle({ executeInspection: async () => {
    calls++;
    assert.deepEqual(getIAMUsers().map(user => user.account), [f.identity.subjectId]);
    return { severity: 'info', summary: '合成检查通过', findings: [] };
  } });
  assert.equal(calls, 1);
  assert.equal((await f.control.inspect(f.identity.tenantId)).usage.count, 1);
  assert.equal((await listSemanticInspectionSchedules({ identityScope: f.identity }))[0].lastRun.status, 'passed');
});

for (const phase of ['before', 'during']) test(`inspection rejects ${phase} execution revocation without adopting results`, async () => {
  resetRuntimeState(['semantic_inspection_schedules', 'semantic_operations_notifications']);
  const f = fixture(); f.install(); await f.approve();
  await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role: { id: 'executive' }, identityScope: f.identity });
  if (phase === 'before') await f.control.revoke(f.identity.tenantId, 1);
  let calls = 0;
  await runSemanticInspectionCycle({ executeInspection: async () => {
    calls++; await f.control.revoke(f.identity.tenantId, 1);
    return { severity: 'warning', summary: 'must-not-persist', findings: [] };
  } });
  assert.equal(calls, phase === 'before' ? 0 : 1);
  const schedules = await listSemanticInspectionSchedules({ identityScope: f.identity });
  assert.equal(schedules[0].lastRun.status, 'failed');
  assert.equal(schedules[0].lastRun.result, null);
  assert.doesNotMatch(JSON.stringify(schedules), /must-not-persist/);
});

test('direct execution entry points cannot bypass enrolled sandbox feature boundaries', async () => {
  const f = fixture(); f.install(); await f.approve();
  const role = { id: 'executive' };
  for (const operation of [
    () => executePrivateAgentCommand('desktop_create_text_artifact', role, 'unused-run', 'unused-confirmation', f.identity),
    () => executePrivateAgentCommand('launch_procurement', role, 'unused-run', 'unused-confirmation', f.identity),
    () => claimPrivateAgentLongTask({ taskId: 'unused-task', role, identityScope: f.identity }),
    () => completePrivateAgentDesktopExecution({ role, runId: 'unused-run', identityScope: f.identity })
  ]) await assert.rejects(operation(), { code: 'RUNTIME_FEATURE_NOT_ENTITLED' });
  assert.equal((await f.control.inspect(f.identity.tenantId)).usage.count, 0);
  await f.control.revoke(f.identity.tenantId, 1);
  await assert.rejects(claimPrivateAgentLongTask({ taskId: 'unused-task', role, identityScope: f.identity }), { code: 'RUNTIME_ENROLLMENT_REVOKED' });
});

test('review is read-only; explicit digest atomically initializes only approved tenant identities', async () => {
  const f = fixture(); const preview = await f.control.prepare(f.manifest);
  assert.equal((await f.control.inspect(f.identity.tenantId)).configured, false);
  assert.equal(readState('iam', iamWorkspaceKey(f.identity.tenantId)), null);
  assert.equal(readState('tenant_runtime_control_v1', iamWorkspaceKey(f.identity.tenantId)), null);
  await assert.rejects(f.control.apply(f.manifest, 'a'.repeat(64)), { code: 'ENROLLMENT_REVIEW_CHANGED' });
  assert.equal((await f.control.apply(f.manifest, preview.digest)).revision, 1);
  assert.equal((await f.control.apply(f.manifest, preview.digest)).duplicate, true);
  await runWithIAMStoreContext(() => {
    assert.deepEqual(getIAMUsers().map(user => user.account), ['reviewer@synthetic.test']);
    assert.deepEqual(getIAMOrganizations().map(org => org.id), ['org-company']);
    assert.equal(getIAMRolePolicy('executive').dataScope.mode, 'current_org');
  }, f.identity.tenantId);
  assert.equal((await f.control.inspect('unconfigured-company')).configured, false);
});

test('changed preview, IAM data or runtime revision cannot reuse an approval', async () => {
  const f = fixture(); const preview = await f.control.prepare(f.manifest);
  f.manifest.dailyRequests++;
  await assert.rejects(f.control.apply(f.manifest, preview.digest), { code: 'ENROLLMENT_REVIEW_CHANGED' });
  await f.approve();
  const next = await f.control.prepare(f.manifest);
  await runWithIAMStoreContext(async () => {
    const policy = getIAMRolePolicy('executive'); await updateIAMRolePolicy('executive', policy, policy.version);
  }, f.identity.tenantId);
  await assert.rejects(f.control.apply(f.manifest, next.digest), { code: 'ENROLLMENT_REVIEW_CHANGED' });
});

test('atomic enrollment rollback leaves neither granted IAM nor runtime policy', async () => {
  const f = fixture('rollback-company', { repository: { ...asyncRuntimeStateRepository,
    mutateStates: async (specs, work) => asyncRuntimeStateRepository.mutateStates(specs, (...args) => { work(...args); throw new Error('simulated storage failure'); }) } });
  await assert.rejects(f.approve(), /simulated storage failure/);
  assert.equal((await f.control.inspect('rollback-company')).configured, false);
  await runWithIAMStoreContext(() => assert.deepEqual(getIAMUsers(), []), 'rollback-company');
});

test('unknown fields, unbound subject, Demo, roles, hierarchy cycles and excessive seats reject', async () => {
  for (const change of [m => { m.tenantId = 'demo-enterprise'; }, m => { m.secret = 'bad'; }, m => { m.dailyRequests = 0; },
    m => { m.features = ['business-write']; }, m => { m.users[0].roleIds = ['superadmin']; }, m => { m.users[0].subject = 'unknown'; },
    m => { m.organizations[0].parentId = 'org-company'; }, m => { m.users.push(structuredClone(m.users[0])); }]) {
    const f = fixture(); change(f.manifest); await assert.rejects(f.approve());
  }
  const f = fixture(); f.providers.providers[0].tenantId = 'someone-else';
  await assert.rejects(f.approve(), { code: 'ENROLLMENT_PROVIDER_BINDING_REQUIRED' });
  const seats = fixture();
  for (let i = 2; i <= 4; i++) {
    const user = { ...structuredClone(seats.manifest.users[0]), portalUserId: `p${i}`, account: `user${i}@synthetic.test`, subject: `employee-${i}` };
    seats.manifest.users.push(user); seats.portal.users.push({ id: user.portalUserId, status: 'active' });
    seats.portal.tenants[0].members.push({ userId: user.portalUserId, status: 'active', role: 'member' });
    seats.providers.providers[0].bindings.push({ account: user.account, subject: user.subject });
  }
  await assert.rejects(seats.approve(), { code: 'RUNTIME_SEAT_LIMIT' });
});

for (const [label, mutate] of [
  ['tenant suspended', f => { f.portal.tenants[0].status = 'suspended'; f.portal.tenants[0].version++; }],
  ['member removed', f => { f.portal.tenants[0].members[0].status = 'removed'; }],
  ['account disabled', f => { f.portal.users[0].status = 'suspended'; }],
  ['subject remapped', f => { f.providers.providers[0].bindings[0].subject = 'other'; }],
  ['request cancelled', f => { f.portal.provisioning[0].status = 'cancelled'; }]
]) test(`${label}: next admission rejects without waiting for a background sync`, async () => {
  const f = fixture(); await f.approve(); assert.equal((await f.control.authorize(f.identity)).managed, true);
  mutate(f); await assert.rejects(f.control.authorize(f.identity));
});

test('disable/restore unseen by the runtime still invalidates old authorization evidence', async () => {
  const f = fixture(); await f.approve();
  f.portal.users[0].status = 'suspended'; f.portal.users[0].authorizationVersion++;
  f.portal.users[0].status = 'active'; f.portal.users[0].authorizationVersion++;
  await assert.rejects(f.control.authorize(f.identity), { code: 'RUNTIME_AUTHORIZATION_STALE' });
});

test('revoke and reviewed re-enrollment increment generations and invalidate old sessions', async () => {
  const f = fixture(); f.install(); await f.approve();
  const sessions = createIdentitySessionService({ validateProviderBinding: async () => null });
  const session = await sessions.issueIdentitySession({ tenantId: f.identity.tenantId, account: f.identity.subjectId, roleId: 'executive' });
  await f.control.revoke(f.identity.tenantId, 1);
  assert.equal((await sessions.validateIdentitySession(session.id)).code, 'IDENTITY_RUNTIME_REVOKED');
  assert.equal((await f.approve()).revision, 3);
  await assert.rejects(f.control.authorize(f.identity, { expectedRevision: 1 }), { code: 'RUNTIME_AUTHORIZATION_STALE' });
  const fresh = await sessions.issueIdentitySession({ tenantId: f.identity.tenantId, account: f.identity.subjectId, roleId: 'executive' });
  assert.ok((await sessions.validateIdentitySession(fresh.id)).session);
});

test('daily quotas are atomic, persisted and tenant-scoped; rejected requests do not grant access', async () => {
  const f = fixture(); await f.approve();
  const results = await Promise.allSettled(Array.from({ length: 9 }, () => f.control.authorize(f.identity, { feature: 'knowledge', consume: true })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 5);
  assert.equal(results.filter(result => result.reason?.code === 'RUNTIME_DAILY_QUOTA_EXCEEDED').length, 4);
  assert.equal((await f.control.inspect(f.identity.tenantId)).usage.count, 5);
  await assert.rejects(f.control.authorize(f.identity, { feature: 'background-agent' }), { code: 'RUNTIME_FEATURE_NOT_ENTITLED' });
  await assert.rejects(f.control.authorize({ ...f.identity, subjectId: 'admin@demo.local' }), { code: 'RUNTIME_SUBJECT_UNBOUND' });
  const other = fixture('enrolled-b'); await other.approve();
  assert.equal((await other.control.authorize(other.identity, { consume: true })).managed, true);
});

test('UTC quota rollover retains policy; expiry and source failure deny', async () => {
  const f = fixture(); f.manifest.expiresAt += 86400000; await f.approve();
  await f.control.authorize(f.identity, { consume: true }); f.advance(86400000);
  await f.control.authorize(f.identity, { consume: true }); assert.equal((await f.control.inspect(f.identity.tenantId)).usage.count, 1);
  f.advance(86400000); await assert.rejects(f.control.authorize(f.identity), { code: 'RUNTIME_ENROLLMENT_REVOKED' });
  const down = createTenantRuntimeControl({ readPortal: () => { throw new Error('private/path/secret'); }, clock: () => timestamp });
  await assert.rejects(down.authorize(f.identity), error => error.code === 'RUNTIME_SOURCE_UNAVAILABLE_OR_REVOKED' && !error.message.includes('secret'));
});

test('production cannot activate sandbox admission; required mode rejects unmanaged tenants', async () => {
  const f = fixture('production-denied', { production: () => true });
  await assert.rejects(f.approve(), { code: 'SANDBOX_ENROLLMENT_ONLY' });
  await assert.rejects(f.control.authorize(f.identity), { code: 'RUNTIME_ENROLLMENT_REQUIRED' });
  await assert.rejects(f.control.authorize({ tenantId: 'demo-enterprise', subjectId: 'admin@demo.local' }), { code: 'DEMO_RUNTIME_DISABLED' });
  const strict = fixture('required-denied', { required: () => true });
  await assert.rejects(strict.control.authorize(strict.identity), { code: 'RUNTIME_ENROLLMENT_REQUIRED' });
});

test('HTTP capability gate prevents shared business/desktop execution and consumes sandbox quota', async () => {
  const f = fixture(); f.install(); await f.approve(); let invoked = false;
  const context = path => ({ req: { method: 'GET' }, res: {}, url: new URL(`http://test${path}`), role: 'executive', identity: {}, agentIdentity: f.identity, send: () => {} });
  const handlers = [async () => { invoked = true; return true; }];
  await assert.rejects(dispatchAuthorizedRoutes(context('/api/agent/run'), handlers, async () => false), { code: 'RUNTIME_FEATURE_NOT_ENTITLED' });
  assert.equal(invoked, false);
  await dispatchAuthorizedRoutes(context('/api/permission-management'), handlers, async () => false);
  assert.equal(invoked, true); assert.equal((await f.control.inspect(f.identity.tenantId)).usage.count, 1);
  assert.equal(tenantRuntimeFeature('/api/permission-management-evil'), 'unverified_runtime');
});

test('worker restores tenant context; revocation in flight discards result; blocked work never starts', async () => {
  const f = fixture(); f.install(); await f.approve(); let executed = false;
  const args = { identity: f.identity, roleId: 'executive', feature: 'semantic', permission: 'page.semantic-operations.view' };
  await assert.rejects(runWithTenantExecution({ ...args, feature: 'background-agent' }, async () => { executed = true; }), { code: 'RUNTIME_FEATURE_NOT_ENTITLED' });
  assert.equal(executed, false);
  await assert.rejects(runWithTenantExecution(args, async () => { assert.equal(getIAMUsers()[0].account, f.identity.subjectId); await f.control.revoke(f.identity.tenantId, 1); return 'must not accept'; }), { code: 'RUNTIME_ENROLLMENT_REVOKED' });
});

test('managed HTTP withholds a prepared response when portal permission changes during lookup', async () => {
  const f = fixture(); f.install(); await f.approve(); let sent = false;
  const context = { req: { method: 'GET' }, res: {}, url: new URL('http://test/api/permission-management'), role: 'executive', identity: {}, agentIdentity: f.identity, send: () => { sent = true; } };
  await assert.rejects(dispatchAuthorizedRoutes(context, [async route => {
    route.send({}, 200, { sensitive: 'synthetic' }); f.portal.users[0].authorizationVersion++; return true;
  }], async () => false), { code: 'RUNTIME_AUTHORIZATION_STALE' });
  assert.equal(sent, false);
});

test('worker rejects an IAM permission version changed during the operation', async () => {
  const f = fixture(); f.install(); await f.approve();
  await assert.rejects(runWithTenantExecution({ identity: f.identity, roleId: 'executive', feature: 'semantic', permission: 'page.semantic-operations.view' }, async () => {
    const policy = getIAMRolePolicy('executive'); await updateIAMRolePolicy('executive', policy, policy.version); return 'stale result';
  }), { code: 'RUNTIME_PERMISSION_REVOKED' });
});

test('existing unmanaged IAM cannot be overwritten by commercial enrollment', async () => {
  const f = fixture(); const workspace = { schemaVersion: 3, configurationVersion: 1, users: [{ id: 'existing' }], organizations: [], rolePolicies: {}, audits: [] };
  writeState('iam', iamWorkspaceKey(f.identity.tenantId), workspace);
  await assert.rejects(f.approve(), { code: 'EXISTING_IAM_REQUIRES_MIGRATION' });
  assert.deepEqual(readState('iam', iamWorkspaceKey(f.identity.tenantId)), workspace);
});

test('DingTalk enrollment binds corp/app and immutable user ID, never stores client secret', async () => {
  const f = fixture(); f.manifest.users[0].providerId = 'dingtalk';
  f.providers.providers = [{ id: 'dingtalk', type: 'dingtalk', enabled: true }];
  f.providers.dingTalk = { tenantId: f.identity.tenantId, corpId: 'synthetic-corp', clientId: 'synthetic-app', clientSecret: 'not-for-runtime-store',
    userBindings: [{ account: f.identity.subjectId, userId: 'employee-1' }] };
  const preview = await f.control.prepare(f.manifest);
  assert.equal(JSON.stringify(preview).includes('not-for-runtime-store'), false);
  await f.approve(); assert.equal((await f.control.authorize(f.identity)).managed, true);
  f.providers.dingTalk.corpId = 'different-corp';
  await assert.rejects(f.control.authorize(f.identity), { code: 'RUNTIME_AUTHORIZATION_STALE' });
  f.providers.providers[0].enabled = false;
  await assert.rejects(f.control.authorize(f.identity), { code: 'RUNTIME_SOURCE_UNAVAILABLE_OR_REVOKED' });
});

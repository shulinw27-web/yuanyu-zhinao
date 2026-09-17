import test from 'node:test';
import assert from 'node:assert/strict';
import { multitenantFixture, isolatedPortal } from './helpers/multitenant-fixture.js';
import { inspectTenantProvisioning } from '../src/services/tenant-provisioning-preflight.js';

const checks = () => ['semantic_instance', 'business_iam', 'runtime_entitlements', 'runtime_revocation'].map(id => ({ id, status: 'passed', code: 'SYNTHETIC_TEST_ONLY' }));
function setup(options) {
  const f = multitenantFixture(options); const tenantId = f.tenant('alice');
  f.act('root', 'admin.tenant', { tenantId, status: 'sandbox_ready', expectedVersion: 1 });
  const submit = (requestId = 'test-request', who = 'alice') => f.act(who, 'tenant.provision', {
    tenantId, requestId, expectedVersion: f.workspace('alice').tenants[0].version, confirmed: true
  });
  return { ...f, tenantId, submit };
}

test('provisioning: authenticated managers submit a versioned idempotent request, not an access grant', () => {
  const f = setup(); const a = f.submit(); const b = f.submit();
  assert.equal(a.provisioning.id, b.provisioning.id); assert.equal(b.duplicate, true);
  assert.equal(a.runtimeConnected, false); assert.equal(f.state().provisioning.length, 1);
  assert.equal(f.workspace('alice').tenants[0].provisioning.status, 'requested');
  assert.throws(() => f.submit('another'), error => error.code === 'PROVISIONING_ALREADY_EXISTS');
  assert.throws(() => f.submit('evil', 'bob'), error => error.code === 'TENANT_NOT_FOUND');
});

test('provisioning: approval, explicit confirmation, strict fields and membership are required', () => {
  const f = multitenantFixture(); const tenantId = f.tenant('alice');
  const body = { tenantId, requestId: 'request', expectedVersion: 1, confirmed: true };
  assert.throws(() => f.act('alice', 'tenant.provision', body), error => error.code === 'PROVISIONING_REQUIRES_SANDBOX_APPROVAL');
  f.act('root', 'admin.tenant', { tenantId, status: 'sandbox_ready', expectedVersion: 1 });
  assert.throws(() => f.act('alice', 'tenant.provision', { ...body, confirmed: false }), error => error.code === 'PROVISIONING_CONFIRMATION_REQUIRED');
  assert.throws(() => f.act('alice', 'tenant.provision', { ...body, endpoint: 'http://evil', role: 'executive' }));
  f.invite('alice', tenantId, 'carol');
  assert.throws(() => f.act('carol', 'tenant.provision', body), error => error.code === 'TENANT_PERMISSION_DENIED');
  assert.equal(Object.hasOwn(f.workspace('carol').tenants[0], 'provisioning'), false);
});

test('provisioning: even passing all injected checks never creates runtime identity or permissions', async () => {
  const f = setup({ provisioningInspector: async () => checks() }); const job = f.submit().provisioning;
  const result = await f.service.inspectProvisioning(job.id);
  assert.equal(result.provisioning.status, 'preflight_ready'); assert.equal(result.runtimeConnected, false);
  assert.equal(f.workspace('alice').tenants[0].runtimeConnected, false);
  assert.equal(f.state().audits.filter(item => item.action.startsWith('provisioning.check')).length, 2);
  assert.equal(Object.hasOwn(result.provisioning, 'lease'), false);
});

test('provisioning: lease rejects parallel checks and cancellation discards late results', async () => {
  let release; const f = setup({ provisioningInspector: () => new Promise(resolve => { release = resolve; }) });
  const job = f.submit().provisioning; const pending = f.service.inspectProvisioning(job.id);
  await assert.rejects(f.service.inspectProvisioning(job.id), error => error.code === 'PROVISIONING_BUSY');
  f.act('alice', 'tenant.provision-cancel', { tenantId: f.tenantId, provisioningId: job.id });
  release(checks()); const result = await pending;
  assert.equal(result.resultDiscarded, true); assert.equal(result.provisioning.status, 'cancelled'); assert.deepEqual(result.provisioning.checks, []);
});

test('provisioning: suspension and restored status cannot revive an old approved request', async () => {
  let release; const f = setup({ provisioningInspector: () => new Promise(resolve => { release = resolve; }) });
  const job = f.submit().provisioning; const pending = f.service.inspectProvisioning(job.id);
  let version = f.workspace('alice').tenants[0].version;
  f.act('root', 'admin.tenant', { tenantId: f.tenantId, expectedVersion: version++, status: 'suspended' });
  f.act('root', 'admin.tenant', { tenantId: f.tenantId, expectedVersion: version, status: 'sandbox_ready' });
  release(checks()); const result = await pending;
  assert.equal(result.resultDiscarded, true); assert.equal(result.provisioning.status, 'superseded');
  assert.notEqual(f.submit('new-approval').provisioning.id, job.id);
});

test('provisioning: removing the requesting administrator invalidates its pending request', async () => {
  const f = setup(); f.invite('alice', f.tenantId, 'carol', 'admin');
  const job = f.submit('carol-request', 'carol').provisioning;
  f.act('alice', 'tenant.member', { tenantId: f.tenantId, userId: 'carol', role: 'member', status: 'removed', expectedVersion: f.workspace('alice').tenants[0].version });
  await assert.rejects(f.service.inspectProvisioning(job.id), error => error.code === 'PROVISIONING_NOT_ACTIVE');
  assert.equal(f.workspace('alice').tenants[0].provisioning.status, 'superseded');
});

test('provisioning: expired lease can be retried, but earlier output cannot replace newer output', async () => {
  let release; let calls = 0;
  const f = setup({ provisioningInspector: () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(checks()) });
  const job = f.submit().provisioning; const old = f.service.inspectProvisioning(job.id);
  f.advance(31000);
  const fresh = await f.service.inspectProvisioning(job.id); assert.equal(fresh.provisioning.attempts, 2);
  release(checks().map(item => ({ ...item, status: 'blocked' })));
  assert.equal((await old).resultDiscarded, true);
  assert.equal(f.workspace('alice').tenants[0].provisioning.status, 'preflight_ready');
});

test('provisioning: malformed checks and raw provider errors are bounded and never persisted', async () => {
  for (const inspect of [async () => [{ id: 'semantic_instance', status: 'passed', code: 'TOKEN=secret' }], async () => { throw new Error('secret credential payload'); }]) {
    const f = setup({ provisioningInspector: inspect }); const job = f.submit().provisioning;
    const result = await f.service.inspectProvisioning(job.id);
    assert.equal(result.provisioning.status, 'blocked'); assert.equal(result.provisioning.checks.length, 4);
    assert.equal(JSON.stringify(f.state()).includes('secret'), false);
  }
});

test('provisioning: real HTTP preserves CSRF/cross-tenant boundaries and exposes no worker route', async t => {
  const f = setup(); const server = await isolatedPortal(f); t.after(server.close);
  const body = { tenantId: f.tenantId, requestId: 'http', expectedVersion: 2, confirmed: true };
  assert.equal((await server.call('bob', 'tenant/provision', body)).status, 404);
  assert.equal((await server.call('alice', 'tenant/provision', body, { 'X-CSRF-Token': 'wrong' })).status, 403);
  const result = await server.call('alice', 'tenant/provision', body); assert.equal(result.status, 200);
  assert.equal(result.body.runtimeConnected, false);
  assert.equal((await server.call('alice', 'provisioning/check', { id: result.body.provisioning.id })).status, 404);
});

test('provisioning: deployed preflight honestly blocks missing execution-plane adapters', async () => {
  const result = await inspectTenantProvisioning({ tenantId: 'not-bound-synthetic-provisioning-tenant' });
  assert.equal(result.length, 4); assert.ok(result.every(item => item.status === 'blocked'));
  assert.ok(result.some(item => item.code === 'TENANT_IAM_BINDING_NOT_IMPLEMENTED'));
});

test('provisioning: account suspension discards an in-flight result even after account restoration', async () => {
  let release; const f = setup({ provisioningInspector: () => new Promise(resolve => { release = resolve; }) });
  const job = f.submit().provisioning; const pending = f.service.inspectProvisioning(job.id);
  f.act('root', 'admin.user', { userId: 'alice', status: 'suspended' });
  f.act('root', 'admin.user', { userId: 'alice', status: 'active' });
  release(checks()); const result = await pending;
  assert.equal(result.resultDiscarded, true); assert.equal(result.provisioning.status, 'superseded');
  assert.deepEqual(result.provisioning.checks, []);
});

test('provisioning: each request has a bounded retry count', async () => {
  const f = setup({ provisioningInspector: async () => checks() }); const job = f.submit().provisioning;
  for (let index = 0; index < 10; index++) await f.service.inspectProvisioning(job.id);
  await assert.rejects(f.service.inspectProvisioning(job.id), error => error.code === 'PROVISIONING_ATTEMPT_LIMIT');
  assert.equal(f.workspace('alice').tenants[0].provisioning.attempts, 10);
});

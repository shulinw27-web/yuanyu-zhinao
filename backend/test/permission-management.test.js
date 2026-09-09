import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { getEffectiveAccess } from '../src/services/access-control-service.js';
import { getIAMRolePolicy, getIAMUser, updateIAMRolePolicy } from '../src/services/iam-store.js';
import { assignUserRoles, getPermissionManagementWorkspace, saveRolePolicy } from '../src/services/permission-management-service.js';
import { getNotifications, getRiskList } from '../src/services/risk-service.js';

const executiveIdentity = { subjectId: 'admin@demo.local' };
const qualityIdentity = { subjectId: 'quality@demo.local' };

test('permission workspace exposes a full admin editor and a scoped read-only snapshot', () => {
  const admin = getPermissionManagementWorkspace('executive', executiveIdentity);
  assert.equal(admin.canManage, true);
  assert.equal(admin.users.length, 5);
  assert.ok(admin.organizations.some((item) => item.parentId));
  assert.ok(admin.permissionCatalog.flatMap((item) => item.buttons).some((item) => item.id === 'permission.policy.save'));
  assert.ok(admin.dataScopeModes.some((item) => item.id === 'org_and_descendants'));
  assert.ok(admin.effectiveAccess.menuIds.includes('permissions'));
  assert.ok(admin.audits.length > 0);

  const scoped = getPermissionManagementWorkspace('quality_manager', qualityIdentity);
  assert.equal(scoped.canManage, false);
  assert.deepEqual(scoped.users.map((item) => item.account), ['quality@demo.local']);
  assert.deepEqual(scoped.audits, []);
  assert.equal(scoped.permissionCatalog.some((item) => item.menuId === 'permissions'), false);
});

test('permission audits require their dedicated button grant', async () => {
  const baseline = getIAMRolePolicy('executive');
  const changed = await saveRolePolicy({
    ...baseline,
    buttonPermissionIds: baseline.buttonPermissionIds.filter((id) => id !== 'permission.audit.view'),
    expectedVersion: baseline.version,
    reason: '验证权限审计独立授权'
  }, 'executive', executiveIdentity);
  assert.equal(changed.error, undefined);
  assert.equal(changed.workspace.canManage, true);
  assert.deepEqual(changed.workspace.audits, []);
  assert.deepEqual(getPermissionManagementWorkspace('executive', executiveIdentity).audits, []);

  const restored = await saveRolePolicy({
    ...baseline,
    expectedVersion: changed.role.policy.version,
    reason: '恢复权限审计授权'
  }, 'executive', executiveIdentity);
  assert.equal(restored.error, undefined);
  assert.ok(restored.workspace.audits.length > 0);
});

test('organization descendants scope rejects overrides and is anchored to the user direct organization at runtime', async () => {
  const baseline = getIAMRolePolicy('marketing_manager');
  const rejected = await saveRolePolicy({
    ...baseline,
    dataScope: { mode: 'org_and_descendants', organizationIds: ['org-quality-center'] },
    expectedVersion: baseline.version,
    reason: '尝试将组织后代范围重定向到其他组织'
  }, 'executive', executiveIdentity);
  assert.equal(rejected.code, 'DATA_SCOPE_ORGANIZATION_OVERRIDE');

  const injected = await updateIAMRolePolicy('marketing_manager', {
    ...baseline,
    dataScope: { mode: 'org_and_descendants', organizationIds: ['org-quality-center'] }
  }, baseline.version);
  assert.equal(injected.error, undefined);
  try {
    assert.deepEqual(
      getEffectiveAccess('marketing_manager', { subjectId: 'market@demo.local' }).organizationIds,
      ['org-market-dept']
    );
  } finally {
    const restored = await updateIAMRolePolicy('marketing_manager', baseline, injected.policy.version);
    assert.equal(restored.error, undefined);
  }
});

test('personnel role assignment enforces admin authority, optimistic locking, and the last-admin guard', async () => {
  const target = getIAMUser('usr-005');
  const denied = await assignUserRoles({
    userId: target.id,
    orgUnitId: target.orgUnitId,
    roleIds: ['marketing_manager', 'quality_manager'],
    expectedVersion: target.version
  }, 'quality_manager', qualityIdentity);
  assert.equal(denied.code, 'FORBIDDEN');

  const changed = await assignUserRoles({
    userId: target.id,
    orgUnitId: 'org-market-dept',
    roleIds: ['marketing_manager', 'quality_manager'],
    expectedVersion: target.version
  }, 'executive', executiveIdentity);
  assert.deepEqual(changed.user.roleIds, ['marketing_manager', 'quality_manager']);
  assert.ok(getEffectiveAccess('marketing_manager', target.account).buttonPermissionIds.includes('risk.acknowledge'));

  const stale = await assignUserRoles({
    userId: target.id,
    orgUnitId: target.orgUnitId,
    roleIds: target.roleIds,
    expectedVersion: target.version
  }, 'executive', executiveIdentity);
  assert.equal(stale.code, 'VERSION_CONFLICT');

  const restored = await assignUserRoles({
    userId: target.id,
    orgUnitId: target.orgUnitId,
    roleIds: target.roleIds,
    primaryRoleId: target.primaryRoleId,
    expectedVersion: changed.user.version
  }, 'executive', executiveIdentity);
  assert.deepEqual(restored.user.roleIds, target.roleIds);

  const admin = getIAMUser('usr-001');
  const lockout = await assignUserRoles({
    userId: admin.id,
    orgUnitId: admin.orgUnitId,
    roleIds: ['quality_manager'],
    expectedVersion: admin.version
  }, 'executive', executiveIdentity);
  assert.equal(lockout.code, 'LAST_EXECUTIVE_GUARD');
});

test('role policy changes drive organization-scoped risks and cannot self-lock the admin role', async () => {
  const baseline = getIAMRolePolicy('marketing_manager');
  const denied = await saveRolePolicy({
    ...baseline,
    expectedVersion: baseline.version,
    reason: '越权测试'
  }, 'quality_manager', qualityIdentity);
  assert.equal(denied.code, 'FORBIDDEN');

  const executive = getIAMRolePolicy('executive');
  const lockout = await saveRolePolicy({
    ...executive,
    buttonPermissionIds: executive.buttonPermissionIds.filter((id) => id !== 'permission.policy.save'),
    expectedVersion: executive.version,
    reason: '自锁防护测试'
  }, 'executive', executiveIdentity);
  assert.equal(lockout.code, 'EXECUTIVE_LOCKOUT_GUARD');

  const changed = await saveRolePolicy({
    ...baseline,
    dataScope: { mode: 'selected_orgs', organizationIds: ['org-market-dept'] },
    expectedVersion: baseline.version,
    reason: '验证市场组织数据隔离'
  }, 'executive', executiveIdentity);
  assert.equal(changed.role.policy.dataScope.mode, 'selected_orgs');
  assert.deepEqual((await getRiskList('marketing_manager', 'market@demo.local')).map((item) => item.id), ['RC-2026-0038']);
  assert.equal((await getNotifications('marketing_manager', 'market@demo.local')).some((item) => item.riskId === 'RC-2026-0042'), false);

  const restored = await saveRolePolicy({
    ...baseline,
    expectedVersion: changed.role.version,
    reason: '恢复市场角色基线'
  }, 'executive', executiveIdentity);
  assert.deepEqual(restored.role.policy.dataScope, baseline.dataScope);
});

test('HTTP permission APIs enforce button policies and apply saved data scopes immediately', async () => {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['backend/src/app.js'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'development', API_HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', (chunk) => { serverLog += chunk; });
  child.stderr.on('data', (chunk) => { serverLog += chunk; });
  const baseUrl = `http://127.0.0.1:${port}/api`;
  const call = async (path, roleId, { method = 'GET', body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-demo-role': roleId,
        'x-client-device-id': `permission-test-${roleId}`
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, payload: await response.json() };
  };
  const waitUntilReady = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) return;
      } catch { /* API is still starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`权限测试 API 未就绪：${serverLog}`);
  };

  try {
    await waitUntilReady();
    const admin = await call('/permission-management', 'executive');
    const quality = await call('/permission-management', 'quality_manager');
    assert.equal(admin.status, 200);
    assert.equal(admin.payload.canManage, true);
    assert.equal(quality.status, 403);
    assert.equal(quality.payload.code, 'PAGE_PERMISSION_DENIED');

    const target = admin.payload.users.find((item) => item.id === 'usr-005');
    const forbidden = await call(`/permission-management/users/${target.id}/roles`, 'quality_manager', {
      method: 'POST',
      body: { orgUnitId: target.orgUnitId, roleIds: target.roleIds, expectedVersion: target.version }
    });
    assert.equal(forbidden.status, 403);

    const assigned = await call(`/permission-management/users/${target.id}/roles`, 'executive', {
      method: 'POST',
      body: { orgUnitId: target.orgUnitId, roleIds: ['marketing_manager', 'quality_manager'], expectedVersion: target.version }
    });
    assert.equal(assigned.status, 200);
    const effective = await call('/access/me', 'marketing_manager');
    assert.deepEqual(effective.payload.roleIds, ['marketing_manager', 'quality_manager']);
    assert.ok(effective.payload.buttonPermissionIds.includes('risk.acknowledge'));

    const stale = await call(`/permission-management/users/${target.id}/roles`, 'executive', {
      method: 'POST',
      body: { orgUnitId: target.orgUnitId, roleIds: target.roleIds, expectedVersion: target.version }
    });
    assert.equal(stale.status, 409);

    const restored = await call(`/permission-management/users/${target.id}/roles`, 'executive', {
      method: 'POST',
      body: {
        orgUnitId: target.orgUnitId,
        roleIds: target.roleIds,
        primaryRoleId: target.primaryRoleId,
        expectedVersion: assigned.payload.user.version
      }
    });
    assert.equal(restored.status, 200);

    const qualityApprove = await call('/risk-cases/RC-2026-0042/approve', 'quality_manager', { method: 'POST', body: {} });
    assert.equal(qualityApprove.status, 403);
    assert.equal(qualityApprove.payload.code, 'BUTTON_PERMISSION_DENIED');

    const baseline = admin.payload.roles.find((item) => item.id === 'marketing_manager').policy;
    const policy = await call('/permission-management/roles/marketing_manager/policy', 'executive', {
      method: 'POST',
      body: {
        menuIds: baseline.menuIds,
        buttonPermissionIds: baseline.buttonPermissionIds,
        dataScope: { mode: 'selected_orgs', organizationIds: ['org-market-dept'] },
        expectedVersion: baseline.version,
        reason: 'HTTP 组织数据范围回归'
      }
    });
    assert.equal(policy.status, 200);
    const marketRisks = await call('/risk-cases', 'marketing_manager');
    assert.deepEqual(marketRisks.payload.map((item) => item.id), ['RC-2026-0038']);
    assert.equal((await call('/risk-cases/RC-2026-0042', 'marketing_manager')).status, 404);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

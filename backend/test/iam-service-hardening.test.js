import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getEffectiveAccess,
  getEffectiveRoleIds,
  hasEffectiveRole,
  selectEffectiveRole,
  selectEffectiveRoleForPermission
} from '../src/services/access-control-service.js';
import { issueIdentitySession, validateIdentitySession } from '../src/services/identity-session-service.js';
import { getIAMRolePolicy, getIAMUser, updateIAMRolePolicy, updateIAMUser } from '../src/services/iam-store.js';
import { assignUserRoles, getPermissionManagementWorkspace, saveRolePolicy } from '../src/services/permission-management-service.js';

test('unknown explicit subjects fail closed while an explicit Demo identity keeps role fixtures usable', async () => {
  const unknown = getEffectiveAccess('executive', 'missing-user@demo.local');
  assert.deepEqual(unknown.roleIds, []);
  assert.deepEqual(unknown.buttonPermissionIds, []);
  assert.equal(unknown.principalResolved, false);
  assert.equal(getPermissionManagementWorkspace('executive', { subjectId: 'missing-user@demo.local', source: 'identity_session' }).canManage, false);
  const target = getIAMUser('usr-005');
  assert.equal((await assignUserRoles({ userId: target.id, roleIds: ['marketing_manager'], orgUnitId: target.orgUnitId, expectedVersion: target.version }, 'executive', { subjectId: 'missing-user@demo.local', source: 'identity_session' })).code, 'FORBIDDEN');

  const rawForgedDemo = getEffectiveAccess('executive', 'demo:executive:forged');
  assert.deepEqual(rawForgedDemo.roleIds, []);
  assert.equal(rawForgedDemo.demoRoleFallback, false);
  const sessionForgedDemo = getEffectiveAccess('executive', { source: 'identity_session', subjectId: 'demo:executive:forged' });
  assert.deepEqual(sessionForgedDemo.roleIds, []);
  assert.equal(sessionForgedDemo.demoRoleFallback, false);

  const demo = getEffectiveAccess('executive', { source: 'demo_header', subjectId: 'demo:executive:test-device' });
  assert.equal(demo.demoRoleFallback, true);
  assert.ok(demo.roleIds.includes('executive'));
  assert.ok(demo.buttonPermissionIds.includes('permission.policy.save'));
});

test('self and current_org scopes are anchored to the current IAM user organization', async () => {
  const procurement = getIAMRolePolicy('procurement_manager');
  const rejected = await saveRolePolicy({
    ...procurement,
    dataScope: { mode: 'current_org', organizationIds: ['org-quality-dept'] },
    expectedVersion: procurement.version,
    reason: '尝试覆盖本组织锚点'
  }, 'executive', { subjectId: 'admin@demo.local', source: 'identity_session' });
  assert.equal(rejected.code, 'DATA_SCOPE_ORGANIZATION_OVERRIDE');
  assert.deepEqual(getEffectiveAccess('procurement_manager', 'procurement@demo.local').organizationIds, ['org-procurement-dept']);

  const productionPolicy = getIAMRolePolicy('production_manager');
  const forged = await updateIAMRolePolicy('production_manager', {
    ...productionPolicy,
    dataScope: { mode: 'self', organizationIds: ['org-quality-dept'] }
  }, productionPolicy.version);
  assert.ok(forged.policy);
  try {
    assert.deepEqual(getEffectiveAccess('production_manager', 'production@demo.local').organizationIds, ['org-production-factory-sh']);
  } finally {
    // The in-memory store keeps versions monotonic; restore only the policy content
    // and always use the version returned by the immediately preceding mutation.
    await updateIAMRolePolicy('production_manager', productionPolicy, forged.policy.version);
  }
});

test('identity sessions are invalidated immediately by user, role, or policy version changes', async () => {
  const quality = getIAMUser('usr-003');
  const inactiveSession = await issueIdentitySession({ source: 'local', account: quality.account, userName: quality.name, roleId: quality.primaryRoleId, roleName: '质量经理', deviceId: 'device-inactive' });
  const disabled = await updateIAMUser(quality.id, { ...quality, status: 'disabled' }, quality.version);
  assert.ok(disabled.user);
  try {
    const validation = await validateIdentitySession(inactiveSession.id, quality.primaryRoleId, 'device-inactive');
    assert.equal(validation.code, 'IDENTITY_USER_INACTIVE');
  } finally {
    await updateIAMUser(quality.id, quality, disabled.user.version);
  }

  const market = getIAMUser('usr-005');
  const roleSession = await issueIdentitySession({ source: 'local', account: market.account, userName: market.name, roleId: market.primaryRoleId, roleName: '市场负责人', deviceId: 'device-role' });
  const removed = await updateIAMUser(market.id, { ...market, roleIds: ['quality_manager'], primaryRoleId: 'quality_manager' }, market.version);
  assert.ok(removed.user);
  try {
    const validation = await validateIdentitySession(roleSession.id, null, 'device-role');
    assert.equal(validation.code, 'IDENTITY_ROLE_REVOKED');
  } finally {
    await updateIAMUser(market.id, market, removed.user.version);
  }

  const procurement = getIAMUser('usr-004');
  const policySession = await issueIdentitySession({ source: 'oa', account: procurement.account, userName: procurement.name, roleId: procurement.primaryRoleId, roleName: '采购负责人', deviceId: 'device-policy' });
  const policy = getIAMRolePolicy('procurement_manager');
  const changedPolicy = await updateIAMRolePolicy('procurement_manager', { ...policy }, policy.version);
  assert.ok(changedPolicy.policy);
  try {
    const validation = await validateIdentitySession(policySession.id, null, 'device-policy');
    assert.equal(validation.code, 'IDENTITY_AUTHORIZATION_STALE');
  } finally {
    await updateIAMRolePolicy('procurement_manager', policy, changedPolicy.policy.version);
  }
});

test('multi-role helpers expose one effective role set for business authorization', async () => {
  const market = getIAMUser('usr-005');
  const assigned = await updateIAMUser(market.id, {
    ...market,
    roleIds: ['marketing_manager', 'procurement_manager', 'executive']
  }, market.version);
  assert.ok(assigned.user);
  try {
    assert.deepEqual(getEffectiveRoleIds('marketing_manager', market.account), ['marketing_manager', 'procurement_manager', 'executive']);
    assert.equal(hasEffectiveRole('marketing_manager', 'procurement_manager', market.account), true);
    assert.equal(selectEffectiveRole('marketing_manager', ['executive', 'procurement_manager'], market.account)?.id, 'executive');
    assert.equal(selectEffectiveRole('marketing_manager', ['executive'], market.account)?.id, 'executive');
    assert.equal(selectEffectiveRoleForPermission('marketing_manager', 'meta_model.draft.save', market.account)?.id, 'marketing_manager');
    assert.equal(selectEffectiveRoleForPermission('marketing_manager', 'agent.evaluation.run', market.account)?.id, 'executive');
    assert.equal(selectEffectiveRoleForPermission('marketing_manager', 'meta_model.publish', market.account)?.id, 'executive');
  } finally {
    await updateIAMUser(market.id, market, assigned.user.version);
  }
});

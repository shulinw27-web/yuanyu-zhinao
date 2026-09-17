import { createHash } from 'node:crypto';
import { iamWorkspaceKey, createTenantIAMWorkspace } from './iam-workspace-model.js';
import { initialRolePolicies } from '../data/iam-seed.js';

export const enrollmentDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const runtimeDeny = (code, status = 403) => { throw Object.assign(new Error(code), { code, status }); };
const text = (value, max = 120) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const shape = (value, keys) => value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).every(key => keys.includes(key));
export const RUNTIME_FEATURES = ['iam', 'semantic', 'knowledge'];

export function validateEnrollment(input, now) {
  if (!shape(input, ['version', 'tenantId', 'provisioningId', 'expectedPortalVersion', 'expiresAt', 'dailyRequests', 'features', 'organizations', 'users']) || input.version !== 1) runtimeDeny('ENROLLMENT_INVALID', 400);
  iamWorkspaceKey(input.tenantId);
  if (input.tenantId === 'demo-enterprise' || !text(input.provisioningId) || !Number.isSafeInteger(input.expectedPortalVersion) || input.expectedPortalVersion < 1
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + 30 * 86400000
    || !Number.isSafeInteger(input.dailyRequests) || input.dailyRequests < 1 || input.dailyRequests > 10000
    || !Array.isArray(input.features) || !input.features.length || new Set(input.features).size !== input.features.length || input.features.some(value => !RUNTIME_FEATURES.includes(value))) runtimeDeny('ENROLLMENT_INVALID', 400);
  if (!Array.isArray(input.organizations) || !input.organizations.length || input.organizations.length > 100 || !Array.isArray(input.users) || !input.users.length || input.users.length > 50) runtimeDeny('ENROLLMENT_INVALID', 400);
  const orgIds = new Set();
  for (const org of input.organizations) {
    if (!shape(org, ['id', 'name', 'parentId']) || !text(org.id) || !text(org.name) || orgIds.has(org.id) || (org.parentId !== null && !text(org.parentId))) runtimeDeny('ENROLLMENT_ORGANIZATION_INVALID', 400);
    orgIds.add(org.id);
  }
  for (const org of input.organizations) {
    const seen = new Set([org.id]); let parent = org.parentId;
    while (parent) {
      if (seen.has(parent) || !orgIds.has(parent)) runtimeDeny('ENROLLMENT_ORGANIZATION_INVALID', 400);
      seen.add(parent); parent = input.organizations.find(item => item.id === parent).parentId;
    }
  }
  const accounts = new Set(); const portalIds = new Set(); const subjects = new Set();
  for (const user of input.users) {
    if (!shape(user, ['portalUserId', 'account', 'name', 'orgUnitId', 'roleIds', 'primaryRoleId', 'providerId', 'subject'])
      || !text(user.portalUserId) || !text(user.account, 254) || user.account !== user.account.toLowerCase() || !text(user.name)
      || !orgIds.has(user.orgUnitId) || !Array.isArray(user.roleIds) || !user.roleIds.length || new Set(user.roleIds).size !== user.roleIds.length
      || user.roleIds.some(role => !Object.hasOwn(initialRolePolicies, role)) || !user.roleIds.includes(user.primaryRoleId)
      || !text(user.providerId, 48) || !text(user.subject, 256) || accounts.has(user.account) || portalIds.has(user.portalUserId)
      || subjects.has(JSON.stringify([user.providerId, user.subject]))) runtimeDeny('ENROLLMENT_USER_INVALID', 400);
    accounts.add(user.account); portalIds.add(user.portalUserId); subjects.add(JSON.stringify([user.providerId, user.subject]));
  }
  return structuredClone(input);
}

export function portalEnrollmentEvidence(state, manifest, now) {
  const tenant = state?.tenants?.find(item => item.id === manifest.tenantId);
  const job = state?.provisioning?.find(item => item.id === manifest.provisioningId && item.tenantId === manifest.tenantId);
  const requester = state?.users?.find(item => item.id === job?.requestedBy && item.status === 'active');
  const requesterMember = tenant?.members.find(item => item.userId === requester?.id && item.status === 'active');
  if (!tenant || tenant.status !== 'sandbox_ready' || tenant.version !== manifest.expectedPortalVersion || !job
    || !['requested', 'blocked', 'preflight_ready'].includes(job.status) || job.tenantVersion !== tenant.version
    || !['owner', 'admin'].includes(requesterMember?.role)) runtimeDeny('PORTAL_ENROLLMENT_STALE');
  const membership = tenant.membership?.expiresAt > now ? tenant.membership : null;
  const seats = membership?.planId === 'business' ? 50 : membership?.planId === 'professional' ? 10 : 3;
  if (manifest.users.length > seats) runtimeDeny('RUNTIME_SEAT_LIMIT');
  const users = manifest.users.map(binding => {
    const user = state.users.find(item => item.id === binding.portalUserId && item.status === 'active');
    const member = tenant.members.find(item => item.userId === binding.portalUserId && item.status === 'active');
    if (!user || !member) runtimeDeny('PORTAL_MEMBER_REVOKED');
    return { id: user.id, authorizationVersion: user.authorizationVersion || 0, role: member.role };
  });
  return { tenantVersion: tenant.version, provisioningId: job.id, requesterId: requester.id,
    requesterVersion: requester.authorizationVersion || 0, planId: membership?.planId || 'explore', planExpiresAt: membership?.expiresAt || null, seats, users };
}

export function identityEnrollmentEvidence(configuration, manifest) {
  return manifest.users.map(user => {
    if (user.providerId === 'dingtalk') {
      const enabled = configuration?.providers?.some(item => item.id === 'dingtalk' && item.type === 'dingtalk' && item.enabled);
      const binding = configuration?.dingTalk;
      if (!enabled || binding?.tenantId !== manifest.tenantId || !text(binding.corpId, 256) || !text(binding.clientId, 256)
        || !binding.userBindings?.some(item => item.account === user.account && item.userId === user.subject)) runtimeDeny('ENROLLMENT_PROVIDER_BINDING_REQUIRED');
      return { providerId: 'dingtalk', corpId: binding.corpId, clientId: binding.clientId, tenantId: binding.tenantId, account: user.account, subject: user.subject };
    }
    const provider = configuration?.providers?.find(item => item.id === user.providerId && item.enabled && item.type === 'oidc' && item.tenantId === manifest.tenantId);
    if (!provider?.bindings?.some(item => item.account === user.account && item.subject === user.subject)) runtimeDeny('ENROLLMENT_PROVIDER_BINDING_REQUIRED');
    return { providerId: provider.id, issuer: provider.issuer, audience: provider.audience, tenantClaim: provider.tenantClaim,
      externalTenantId: provider.externalTenantId, account: user.account, subject: user.subject };
  });
}

export function enrollmentWorkspace(manifest) {
  const workspace = createTenantIAMWorkspace(manifest.tenantId);
  workspace.organizations = structuredClone(manifest.organizations);
  workspace.users = manifest.users.map(user => ({ id: `enterprise-${user.portalUserId}`, account: user.account, name: user.name,
    orgUnitId: user.orgUnitId, roleIds: [...user.roleIds], primaryRoleId: user.primaryRoleId, status: 'active', version: 1, sources: ['enterprise'] }));
  for (const roleId of new Set(manifest.users.flatMap(user => user.roleIds))) {
    workspace.rolePolicies[roleId] = { ...structuredClone(initialRolePolicies[roleId]), version: 1, dataScope: { mode: 'current_org', organizationIds: [] } };
  }
  return workspace;
}

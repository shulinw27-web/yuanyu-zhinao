import { permissionCatalog } from '../data/iam-seed.js';
import { findActiveIAMUserForRole, findIAMUserBySubject, getIAMOrganizations, getIAMRolePolicy } from './iam-store.js';
import { getRoleDefinition, isKnownRole } from './role-catalog-service.js';

export const EXECUTIVE_REQUIRED_PERMISSIONS = ['permission.user.assign', 'permission.policy.save'];

const normalizeSubject = (subject) => {
  if (subject && typeof subject === 'object') return subject.subjectId || subject.account || subject.userId || null;
  return subject || null;
};

const demoRoleFallbackEnabled = () => process.env.NODE_ENV !== 'production' && process.env.DEMO_ALLOW_ROLE_HEADER !== 'false';
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const resolvePrincipal = (roleId, identityContext) => {
  const subjectId = normalizeSubject(identityContext);
  const source = identityContext && typeof identityContext === 'object' ? identityContext.source : null;
  const demoSubjectPattern = new RegExp(`^demo:${escapeRegExp(roleId)}:[A-Za-z0-9._-]+$`);
  const trustedDemoIdentity = source === 'demo_header'
    && typeof subjectId === 'string'
    && demoSubjectPattern.test(subjectId);
  const allowDemoRoleFallback = demoRoleFallbackEnabled() && isKnownRole(roleId) && trustedDemoIdentity;
  if (subjectId && !trustedDemoIdentity) {
    return { subjectId, user: findIAMUserBySubject(subjectId), allowDemoRoleFallback: false, source: source || 'subject' };
  }
  if (allowDemoRoleFallback) {
    return { subjectId, user: findActiveIAMUserForRole(roleId), allowDemoRoleFallback: true, source: 'demo_header' };
  }
  return { subjectId, user: null, allowDemoRoleFallback: false, source: source || 'unresolved' };
};

const getDescendantIds = (organizationId, organizations) => {
  const result = new Set([organizationId]);
  let changed = true;
  while (changed) {
    changed = false;
    organizations.forEach((organization) => {
      if (result.has(organization.parentId) && !result.has(organization.id)) {
        result.add(organization.id);
        changed = true;
      }
    });
  }
  return result;
};

const organizationIdsForPolicy = (policy, user, organizations) => {
  if (!policy) return new Set();
  const mode = policy.dataScope?.mode || 'self';
  if (mode === 'all') return new Set(organizations.map((item) => item.id));
  if (mode === 'selected_orgs') return new Set(policy.dataScope?.organizationIds || []);
  if (mode === 'self' || mode === 'current_org') return new Set(user?.orgUnitId ? [user.orgUnitId] : []);
  if (mode === 'org_and_descendants') {
    // This scope is identity-bound: a stored policy must never be able to
    // redirect it to another branch of the organization tree.
    return user?.orgUnitId ? getDescendantIds(user.orgUnitId, organizations) : new Set();
  }
  return new Set();
};

export function hasButtonPermission(roleId, code) {
  if (roleId === 'executive' && EXECUTIVE_REQUIRED_PERMISSIONS.includes(code)) return true;
  return Boolean(getIAMRolePolicy(roleId)?.buttonPermissionIds.includes(code));
}

export function hasEffectiveButtonPermission(roleId, code, subjectId) {
  return getEffectiveAccess(roleId, subjectId).buttonPermissionIds.includes(code);
}

export function getEffectiveAccess(roleId, subjectId) {
  const principal = resolvePrincipal(roleId, subjectId);
  const user = principal.user;
  const roleIds = user
    ? (user.status === 'active' ? user.roleIds.filter((id) => isKnownRole(id)) : [])
    : [];
  const policies = roleIds.map((id) => getIAMRolePolicy(id)).filter(Boolean);
  const menuIds = new Set(policies.flatMap((policy) => policy.menuIds));
  const buttonPermissionIds = new Set(policies.flatMap((policy) => policy.buttonPermissionIds));
  if (roleIds.includes('executive')) {
    menuIds.add('permissions');
    EXECUTIVE_REQUIRED_PERMISSIONS.forEach((code) => buttonPermissionIds.add(code));
  }
  const organizations = getIAMOrganizations();
  const organizationIds = new Set();
  policies.forEach((policy) => organizationIdsForPolicy(policy, user, organizations).forEach((id) => organizationIds.add(id)));
  const unrestricted = policies.some((policy) => policy.dataScope?.mode === 'all');
  const catalogOrder = new Map(permissionCatalog.map((item, index) => [item.menuId, index]));
  return {
    subjectId: user?.id || normalizeSubject(subjectId) || null,
    account: user?.account || null,
    primaryRoleId: user?.primaryRoleId || (principal.allowDemoRoleFallback ? roleId : null),
    identitySource: principal.source,
    principalResolved: Boolean(user),
    demoRoleFallback: principal.allowDemoRoleFallback,
    roleIds,
    menuIds: [...menuIds].sort((a, b) => (catalogOrder.get(a) ?? 999) - (catalogOrder.get(b) ?? 999)),
    pagePermissionIds: permissionCatalog.filter((item) => menuIds.has(item.menuId)).map((item) => item.pagePermissionId),
    buttonPermissionIds: [...buttonPermissionIds],
    dataScopes: policies.map((policy) => ({ roleId: policy.roleId, ...structuredClone(policy.dataScope) })),
    organizationIds: unrestricted ? organizations.map((item) => item.id) : [...organizationIds],
    unrestricted
  };
}

export function getEffectiveRoleIds(roleId, identityContext) {
  return getEffectiveAccess(roleId, identityContext).roleIds;
}

export function hasEffectiveRole(roleId, requiredRoleIds, identityContext) {
  const required = new Set(Array.isArray(requiredRoleIds) ? requiredRoleIds : [requiredRoleIds]);
  return getEffectiveRoleIds(roleId, identityContext).some((effectiveRoleId) => required.has(effectiveRoleId));
}

export function selectEffectiveRole(roleId, allowedRoleIds, identityContext) {
  const allowed = Array.isArray(allowedRoleIds) ? allowedRoleIds : [allowedRoleIds];
  const effective = new Set(getEffectiveRoleIds(roleId, identityContext));
  const selectedRoleId = effective.has(roleId) && allowed.includes(roleId)
    ? roleId
    : allowed.find((candidate) => effective.has(candidate));
  return selectedRoleId ? getRoleDefinition(selectedRoleId) : null;
}

// Resolve the concrete business role that owns a button grant. The union of a
// user's roles is useful for rendering the UI, but downstream business guards
// must receive the role that actually granted the operation. Prefer the IAM
// primary role when it owns the grant, then use the first effective role with
// an explicit (or mandatory executive) grant.
export function selectEffectiveRoleForPermission(roleId, permissionCode, identityContext) {
  const effectiveAccess = getEffectiveAccess(roleId, identityContext);
  const grantedRoleIds = effectiveAccess.roleIds.filter((effectiveRoleId) => hasButtonPermission(effectiveRoleId, permissionCode));
  const selectedRoleId = grantedRoleIds.includes(effectiveAccess.primaryRoleId)
    ? effectiveAccess.primaryRoleId
    : grantedRoleIds[0];
  return selectedRoleId ? getRoleDefinition(selectedRoleId) : null;
}

export function canAccessOrganization(roleId, organizationId, subjectId) {
  if (!organizationId) return false;
  return getEffectiveAccess(roleId, subjectId).organizationIds.includes(organizationId);
}

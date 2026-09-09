import { roles as roleMetadata } from '../data/seed.js';
import { getIAMRolePolicies, getIAMRolePolicy } from './iam-store.js';

const clone = (value) => structuredClone(value);

const mergeRole = (roleId, policy) => {
  const metadata = roleMetadata[roleId];
  if (!metadata || !policy) return null;
  return {
    ...clone(metadata),
    status: 'active',
    policyVersion: policy.version,
    menuIds: clone(policy.menuIds),
    buttonPermissionIds: clone(policy.buttonPermissionIds),
    dataScope: clone(policy.dataScope)
  };
};

export function getRoleDefinition(roleId) {
  return mergeRole(roleId, getIAMRolePolicy(roleId));
}

export function isKnownRole(roleId) {
  return Boolean(getRoleDefinition(roleId));
}

export function getRoleCatalog() {
  return getIAMRolePolicies()
    .map((policy) => mergeRole(policy.roleId, policy))
    .filter(Boolean);
}

export function getRoleCatalogMap() {
  return Object.fromEntries(getRoleCatalog().map((role) => [role.id, role]));
}

export const PAGE_ACCESS_REQUIREMENTS = Object.freeze({
  dashboard: { menuId: 'dashboard', pagePermissionId: 'page.dashboard.view' },
  intelligence: { menuId: 'intelligence', pagePermissionId: 'page.intelligence.view' },
  agent: { menuId: 'agent', pagePermissionId: 'page.agent.view' },
  risks: { menuId: 'risks', pagePermissionId: 'page.risks.view' },
  world: { menuId: 'world', pagePermissionId: 'page.world.view' },
  channels: { menuId: 'channels', pagePermissionId: 'page.channels.view' },
  config: { menuId: 'config', pagePermissionId: 'page.config.view' },
  permissions: { menuId: 'permissions', pagePermissionId: 'page.permissions.view' },
  procurement: { menuId: 'agent', pagePermissionId: 'page.agent.view' },
});

const primaryPageOrder = ['dashboard', 'intelligence', 'agent', 'risks', 'world', 'channels', 'config', 'permissions'];

export function canAccessPage(pageId, effectiveAccess) {
  const requirement = PAGE_ACCESS_REQUIREMENTS[pageId];
  if (!requirement || !effectiveAccess) return false;
  const menuIds = Array.isArray(effectiveAccess.menuIds) ? effectiveAccess.menuIds : [];
  const pagePermissionIds = Array.isArray(effectiveAccess.pagePermissionIds) ? effectiveAccess.pagePermissionIds : [];
  return menuIds.includes(requirement.menuId) && pagePermissionIds.includes(requirement.pagePermissionId);
}

export function firstAccessiblePage(effectiveAccess) {
  return primaryPageOrder.find((pageId) => canAccessPage(pageId, effectiveAccess)) || null;
}

const signatureFields = ['roleIds', 'menuIds', 'pagePermissionIds', 'buttonPermissionIds', 'organizationIds'];

export function accessSignature(effectiveAccess) {
  if (!effectiveAccess) return '';
  const normalized = Object.fromEntries(signatureFields.map((field) => [
    field,
    [...new Set(Array.isArray(effectiveAccess[field]) ? effectiveAccess[field] : [])].map(String).sort()
  ]));
  return JSON.stringify(normalized);
}

export function captureAccessGeneration(generation, roleId) {
  return Object.freeze({ generation, roleId });
}

export function isCurrentAccessGeneration(snapshot, generation, roleId) {
  return Boolean(snapshot) && snapshot.generation === generation && snapshot.roleId === roleId;
}

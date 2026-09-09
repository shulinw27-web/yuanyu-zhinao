import { dataScopeModes, permissionCatalog } from '../data/iam-seed.js';
import { EXECUTIVE_REQUIRED_PERMISSIONS, getEffectiveAccess, hasEffectiveButtonPermission } from './access-control-service.js';
import { getRoleDefinition } from './role-catalog-service.js';
import {
  appendIAMAudit,
  findActiveIAMUserForRole,
  findIAMUserBySubject,
  getIAMAudits,
  getIAMOrganizations,
  getIAMRolePolicies,
  getIAMRolePolicy,
  getIAMUser,
  getIAMUsers,
  getIAMVersion,
  updateIAMRolePolicy,
  updateIAMUser
} from './iam-store.js';

const clone = (value) => structuredClone(value);
const uniqueIds = (values) => [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
const actorSubject = (identityScope) => identityScope?.subjectId || identityScope?.account || identityScope?.userId || null;

const resolveActor = (actorRoleId, identityScope) => {
  const subject = actorSubject(identityScope);
  const user = subject ? findIAMUserBySubject(subject) : null;
  if (user) return user;
  return getEffectiveAccess(actorRoleId, identityScope).demoRoleFallback ? findActiveIAMUserForRole(actorRoleId) : null;
};

const canActorManage = (actorRoleId, identityScope, permissionCode) => {
  const effectiveAccess = getEffectiveAccess(actorRoleId, identityScope);
  return effectiveAccess.roleIds.includes('executive')
    && hasEffectiveButtonPermission(actorRoleId, permissionCode, identityScope);
};

const organizationPath = (organization, organizations) => {
  const byId = new Map(organizations.map((item) => [item.id, item]));
  const names = [];
  const visited = new Set();
  let current = organization;
  while (current && !visited.has(current.id)) {
    names.unshift(current.name);
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return names.join(' / ');
};

const getDescendantIds = (organizationId, organizations) => {
  const result = new Set([organizationId]);
  let changed = true;
  while (changed) {
    changed = false;
    organizations.forEach((item) => {
      if (result.has(item.parentId) && !result.has(item.id)) {
        result.add(item.id);
        changed = true;
      }
    });
  }
  return result;
};

const decorateOrganizations = (organizations, users) => organizations
  .map((organization) => {
    const memberOrganizations = getDescendantIds(organization.id, organizations);
    return {
      ...organization,
      path: organizationPath(organization, organizations),
      memberCount: users.filter((user) => memberOrganizations.has(user.orgUnitId)).length
    };
  })
  .sort((a, b) => a.sortOrder - b.sortOrder);

const decorateUser = (user, organizations) => {
  const organization = organizations.find((item) => item.id === user.orgUnitId);
  return {
    ...clone(user),
    roleId: user.primaryRoleId,
    role: getRoleDefinition(user.primaryRoleId)?.name || user.primaryRoleId,
    roleNames: user.roleIds.map((roleId) => getRoleDefinition(roleId)?.name || roleId),
    department: organization?.name || user.department,
    organizationName: organization?.name || user.orgUnitId
  };
};

const decorateRole = (policy) => ({
  ...clone(getRoleDefinition(policy.roleId)),
  memberCount: getIAMUsers().filter((user) => user.status === 'active' && user.roleIds.includes(policy.roleId)).length,
  system: true,
  version: policy.version,
  policy: clone(policy)
});

const addAncestors = (organizationIds, organizations) => {
  const result = new Set(organizationIds);
  const byId = new Map(organizations.map((item) => [item.id, item]));
  organizationIds.forEach((id) => {
    let current = byId.get(id);
    while (current?.parentId) {
      result.add(current.parentId);
      current = byId.get(current.parentId);
    }
  });
  return result;
};

const filterCatalog = (effectiveAccess) => permissionCatalog
  .filter((menu) => effectiveAccess.menuIds.includes(menu.menuId))
  .map((menu) => ({ ...clone(menu), buttons: menu.buttons.filter((button) => effectiveAccess.buttonPermissionIds.includes(button.id)) }));

export function getPermissionManagementWorkspace(requestingRoleId, identityScope) {
  const organizations = getIAMOrganizations();
  const users = getIAMUsers();
  const policies = getIAMRolePolicies();
  const subject = actorSubject(identityScope);
  const effectiveAccess = getEffectiveAccess(requestingRoleId, identityScope);
  const canViewAudits = effectiveAccess.buttonPermissionIds.includes('permission.audit.view');
  const canManage = canActorManage(requestingRoleId, identityScope, 'permission.user.assign')
    && canActorManage(requestingRoleId, identityScope, 'permission.policy.save');

  if (!canManage) {
    const resolvedUser = subject ? findIAMUserBySubject(subject) : null;
    const currentUser = resolvedUser || (effectiveAccess.demoRoleFallback ? findActiveIAMUserForRole(requestingRoleId) : null);
    const visibleOrganizationIds = addAncestors(effectiveAccess.organizationIds, organizations);
    const visibleOrganizations = organizations.filter((item) => visibleOrganizationIds.has(item.id));
    const visibleUsers = currentUser ? [currentUser] : [];
    const visibleRoleIds = new Set(effectiveAccess.roleIds);
    const visiblePolicies = policies.filter((policy) => visibleRoleIds.has(policy.roleId));
    return {
      canManage: false,
      version: getIAMVersion(),
      summary: {
        organizationCount: visibleOrganizations.length,
        userCount: visibleUsers.length,
        roleCount: visiblePolicies.length,
        buttonPermissionCount: effectiveAccess.buttonPermissionIds.length
      },
      organizations: decorateOrganizations(visibleOrganizations, visibleUsers),
      users: visibleUsers.map((user) => decorateUser(user, organizations)),
      roles: visiblePolicies.map(decorateRole),
      permissionCatalog: filterCatalog(effectiveAccess),
      dataScopeModes: clone(dataScopeModes),
      audits: canViewAudits ? getIAMAudits(50) : [],
      effectiveAccess
    };
  }

  return {
    canManage: true,
    version: getIAMVersion(),
    summary: {
      organizationCount: organizations.length,
      userCount: users.length,
      roleCount: policies.length,
      buttonPermissionCount: permissionCatalog.reduce((total, menu) => total + menu.buttons.length, 0)
    },
    organizations: decorateOrganizations(organizations, users),
    users: users.map((user) => decorateUser(user, organizations)),
    roles: policies.map(decorateRole),
    permissionCatalog: clone(permissionCatalog),
    dataScopeModes: clone(dataScopeModes),
    audits: canViewAudits ? getIAMAudits(50) : [],
    effectiveAccess
  };
}

export async function assignUserRoles(payload, actorRoleId, identityScope) {
  if (!canActorManage(actorRoleId, identityScope, 'permission.user.assign')) {
    return { error: '仅具备人员角色分配权限的管理层可执行此操作。', code: 'FORBIDDEN' };
  }
  const user = getIAMUser(payload?.userId);
  if (!user) return { error: '未找到需要更新的人员。', code: 'USER_NOT_FOUND' };
  const roleIds = uniqueIds(payload?.roleIds);
  if (!roleIds.length) return { error: '人员至少需要保留一个角色。', code: 'ROLE_REQUIRED' };
  const unknownRoleIds = roleIds.filter((roleId) => !getRoleDefinition(roleId) || !getIAMRolePolicy(roleId));
  if (unknownRoleIds.length) return { error: `存在未知角色：${unknownRoleIds.join('、')}。`, code: 'UNKNOWN_ROLE' };
  const organizations = getIAMOrganizations();
  const organization = organizations.find((item) => item.id === payload?.orgUnitId && item.status === 'active');
  if (!organization) return { error: '请选择有效的组织节点。', code: 'UNKNOWN_ORGANIZATION' };
  const primaryRoleId = payload?.primaryRoleId || (roleIds.includes(user.primaryRoleId) ? user.primaryRoleId : roleIds[0]);
  if (!roleIds.includes(primaryRoleId)) return { error: '主角色必须包含在已分配角色中。', code: 'INVALID_PRIMARY_ROLE' };
  const status = payload?.status || user.status;
  if (!['active', 'inactive', 'disabled'].includes(status)) return { error: '人员状态无效。', code: 'INVALID_USER_STATUS' };
  const activeExecutives = getIAMUsers().filter((item) => item.status === 'active' && item.roleIds.includes('executive'));
  const removesActiveExecutive = user.status === 'active' && user.roleIds.includes('executive')
    && (status !== 'active' || !roleIds.includes('executive'));
  if (removesActiveExecutive && activeExecutives.length <= 1) {
    return { error: '不能移除或停用最后一个管理层账号。', code: 'LAST_EXECUTIVE_GUARD' };
  }
  const expectedVersion = Number(payload?.expectedVersion);
  const update = await updateIAMUser(user.id, {
    ...user,
    orgUnitId: organization.id,
    department: organization.name,
    roleIds,
    primaryRoleId,
    status
  }, Number.isInteger(expectedVersion) ? expectedVersion : NaN, (result) => ({
    type: 'iam.user.authorization_changed', version: 1, aggregateType: 'IAMUser', aggregateId: user.id,
    tenantId: identityScope?.tenantId, organizationId: result.user.orgUnitId,
    actor: { type: 'role', id: actorRoleId, subjectId: actorSubject(identityScope) },
    payload: { userId: user.id, roleIds: result.user.roleIds, primaryRoleId: result.user.primaryRoleId, status: result.user.status, policyVersion: result.user.version }
  }));
  if (update.error) return update;
  const actor = resolveActor(actorRoleId, identityScope);
  const audit = await appendIAMAudit({
    action: 'USER_ROLE_ASSIGNMENT_UPDATED', targetType: 'user', targetId: user.id,
    actorRoleId, actorSubjectId: actor?.id || actorSubject(identityScope) || actorRoleId,
    reason: String(payload?.reason || '更新人员所属组织与角色分配。').trim(),
    before: { orgUnitId: update.before.orgUnitId, roleIds: update.before.roleIds, primaryRoleId: update.before.primaryRoleId, status: update.before.status, version: update.before.version },
    after: { orgUnitId: update.user.orgUnitId, roleIds: update.user.roleIds, primaryRoleId: update.user.primaryRoleId, status: update.user.status, version: update.user.version },
    result: 'success'
  });
  return {
    user: decorateUser(update.user, organizations),
    audit,
    version: update.version,
    workspace: getPermissionManagementWorkspace(actorRoleId, identityScope)
  };
}

export async function saveRolePolicy(payload, actorRoleId, identityScope) {
  if (!canActorManage(actorRoleId, identityScope, 'permission.policy.save')) {
    return { error: '仅具备角色策略保存权限的管理层可执行此操作。', code: 'FORBIDDEN' };
  }
  const roleId = String(payload?.roleId || '').trim();
  const current = getIAMRolePolicy(roleId);
  if (!getRoleDefinition(roleId) || !current) return { error: '未找到需要更新的角色策略。', code: 'ROLE_POLICY_NOT_FOUND' };
  const menuIds = uniqueIds(payload?.menuIds);
  const buttonPermissionIds = uniqueIds(payload?.buttonPermissionIds);
  const menuById = new Map(permissionCatalog.map((menu) => [menu.menuId, menu]));
  const buttonToMenu = new Map(permissionCatalog.flatMap((menu) => menu.buttons.map((button) => [button.id, menu.menuId])));
  const unknownMenus = menuIds.filter((id) => !menuById.has(id));
  const unknownButtons = buttonPermissionIds.filter((id) => !buttonToMenu.has(id));
  if (unknownMenus.length) return { error: `存在未知页面权限：${unknownMenus.join('、')}。`, code: 'UNKNOWN_MENU_PERMISSION' };
  if (unknownButtons.length) return { error: `存在未知按钮权限：${unknownButtons.join('、')}。`, code: 'UNKNOWN_BUTTON_PERMISSION' };
  const orphanButtons = buttonPermissionIds.filter((id) => !menuIds.includes(buttonToMenu.get(id)));
  if (orphanButtons.length) return { error: `按钮权限必须同时授予所属页面：${orphanButtons.join('、')}。`, code: 'BUTTON_MENU_MISMATCH' };
  const mode = String(payload?.dataScope?.mode || '');
  if (!dataScopeModes.some((item) => item.id === mode)) return { error: '请选择有效的数据权限范围。', code: 'INVALID_DATA_SCOPE' };
  const organizationIds = uniqueIds(payload?.dataScope?.organizationIds);
  if (['self', 'current_org', 'org_and_descendants'].includes(mode) && organizationIds.length) {
    return { error: '本人、本组织或本组织及下级范围必须由人员直属组织实时确定，不能指定其他组织。', code: 'DATA_SCOPE_ORGANIZATION_OVERRIDE' };
  }
  const knownOrganizationIds = new Set(getIAMOrganizations().map((item) => item.id));
  const unknownOrganizations = organizationIds.filter((id) => !knownOrganizationIds.has(id));
  if (unknownOrganizations.length) return { error: `存在未知组织：${unknownOrganizations.join('、')}。`, code: 'UNKNOWN_ORGANIZATION' };
  if (mode === 'selected_orgs' && !organizationIds.length) return { error: '指定组织范围至少需要选择一个组织。', code: 'ORGANIZATION_REQUIRED' };
  const reason = String(payload?.reason || '').trim();
  if (!reason) return { error: '请填写权限策略变更原因。', code: 'REASON_REQUIRED' };
  if (roleId === 'executive') {
    const missingRequired = EXECUTIVE_REQUIRED_PERMISSIONS.filter((code) => !buttonPermissionIds.includes(code));
    if (!menuIds.includes('permissions') || missingRequired.length) {
      return { error: '管理层必须保留权限管理页面、人员分配和策略保存权限，避免系统自锁。', code: 'EXECUTIVE_LOCKOUT_GUARD' };
    }
  }
  const expectedVersion = Number(payload?.expectedVersion);
  const update = await updateIAMRolePolicy(roleId, {
    roleId,
    menuIds,
    buttonPermissionIds,
    dataScope: { mode, organizationIds: ['all', 'self', 'current_org', 'org_and_descendants'].includes(mode) ? [] : organizationIds }
  }, Number.isInteger(expectedVersion) ? expectedVersion : NaN, (result) => ({
    type: 'iam.role_policy.published', version: 1, aggregateType: 'IAMRolePolicy', aggregateId: roleId,
    tenantId: identityScope?.tenantId, actor: { type: 'role', id: actorRoleId, subjectId: actorSubject(identityScope) },
    payload: { roleId, policyVersion: result.policy.version, menuIds: result.policy.menuIds, dataScopeMode: result.policy.dataScope.mode }
  }));
  if (update.error) return update;
  const actor = resolveActor(actorRoleId, identityScope);
  const audit = await appendIAMAudit({
    action: 'ROLE_POLICY_UPDATED', targetType: 'role', targetId: roleId,
    actorRoleId, actorSubjectId: actor?.id || actorSubject(identityScope) || actorRoleId,
    reason,
    before: update.before,
    after: update.policy,
    result: 'success'
  });
  return {
    role: decorateRole(update.policy),
    audit,
    version: update.version,
    workspace: getPermissionManagementWorkspace(actorRoleId, identityScope)
  };
}

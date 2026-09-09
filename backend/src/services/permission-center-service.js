import { permissionCatalog } from '../data/iam-seed.js';
import { getAccessExplanation } from './authorization-service.js';
import { getBusinessAccessProfile } from './business-control-service.js';
import { getIAMRolePolicy } from './iam-store.js';
import { getRoleCatalog, getRoleDefinition } from './role-catalog-service.js';
import { getZhiNaoAuthorizationProfile } from './zhinao-authorization-service.js';

const menuNameById = new Map(permissionCatalog.map((item) => [item.menuId, item.name]));

const rolePolicy = (roleId) => {
  const policy = getIAMRolePolicy(roleId);
  return {
    role: getRoleDefinition(roleId),
    menus: (policy?.menuIds || []).map((id) => menuNameById.get(id) || id),
    buttons: policy?.buttonPermissionIds || [],
    dataScope: policy?.dataScope,
    version: policy?.version,
    data: getAccessExplanation(roleId),
    business: getBusinessAccessProfile(roleId),
    zhiNao: getZhiNaoAuthorizationProfile(roleId)
  };
};

export function getPermissionCenterOverview(requestingRoleId) {
  const roleIds = requestingRoleId === 'executive' ? getRoleCatalog().map((role) => role.id) : [requestingRoleId];
  return {
    policyMode: 'RBAC + ABAC + 业务条线权限 + 智脑委托权限',
    rolePolicies: roleIds.map(rolePolicy),
    evaluationOrder: ['账号中心身份与组织', '页面与菜单权限', '数据域与字段分级', '业务条线能力', '智脑服务主体短时授权', '用户确认与审批'],
    auditRule: '每次策略判定记录用户、身份源、设备、智脑主体、数据域、业务动作与结果。'
  };
}

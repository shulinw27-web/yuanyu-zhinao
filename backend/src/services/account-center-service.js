import { timingSafeEqual } from 'node:crypto';
import { getRole } from './authorization-service.js';
import { findIAMUserByAccount, getIAMOrganizations, getIAMUsers } from './iam-store.js';
import { issueIdentitySession } from './identity-session-service.js';
import { getOAConnectionStatus } from './oa-auth-service.js';
import { identityProviders } from './identity-provider-service.js';

const localMockAllowed = () => process.env.NODE_ENV !== 'production' && !process.env.IDENTITY_PROVIDERS_FILE && (process.env.ACCOUNT_AUTH_MODE || 'mock') === 'mock';

const publicAccount = (account) => ({
  ...account,
  roleId: account.primaryRoleId,
  role: getRole(account.primaryRoleId).name,
  roleNames: account.roleIds.map((roleId) => getRole(roleId).name),
  sources: account.sources
});

export function getIdentitySources() {
  return [
    { id: 'local', name: '本地演示账号', type: 'demo', status: localMockAllowed() ? 'enabled' : 'disabled', description: '仅开发环境演示登录，不是生产密码认证。' },
    { id: 'oa', name: 'OA 演示登录', type: 'demo', status: getOAConnectionStatus().status, description: '仅演示；企业接入使用下列身份适配器。' },
    ...identityProviders.describe().providers.map((provider) => ({ ...provider, status: provider.configured ? 'configured' : 'not_configured', description: '外部身份映射平台账号；角色与数据权限由平台 IAM 校验。' }))
  ];
}

export function getAccountCenterOverview(roleId) {
  const isAdmin = roleId === 'executive';
  const organizations = getIAMOrganizations();
  return {
    identitySources: getIdentitySources(),
    users: isAdmin ? getIAMUsers().map(publicAccount) : [],
    organizations: organizations.map((item) => item.name),
    organizationTree: organizations,
    localLogin: { enabled: localMockAllowed(), passwordPolicy: '当前本地登录仅用于开发演示；生产环境使用企业身份源。' }
  };
}

export async function loginWithLocalAccount({ account, password, deviceId, platform }) {
  const normalizedAccount = String(account || '').trim().toLowerCase();
  if (!normalizedAccount || !String(password || '').trim()) return { error: '请输入平台账号和密码。' };
  if (!localMockAllowed()) return { error: '本地演示账号已禁用，请使用已配置的企业身份源登录。' };
  const suppliedPassword = Buffer.from(String(password));
  const configuredPassword = Buffer.from(process.env.DEMO_LOCAL_PASSWORD || 'demo');
  if (suppliedPassword.length !== configuredPassword.length || !timingSafeEqual(suppliedPassword, configuredPassword)) return { error: '账号或密码错误。' };
  const user = findIAMUserByAccount(normalizedAccount);
  if (!user || user.status !== 'active' || !user.sources.includes('local')) return { error: '未找到已启用的平台账号。请联系管理员创建账号或选择 OA 登录。' };
  const role = getRole(user.primaryRoleId);
  const session = await issueIdentitySession({ source: 'local', account: user.account, userName: user.name, roleId: role.id, roleName: role.name, deviceId, platform });
  return { sessionId: session.id, user: { id: user.id, account: user.account, name: user.name, roleId: role.id, roleIds: user.roleIds, roleName: role.name, orgUnitId: user.orgUnitId, source: 'local', version: user.version }, connection: { id: 'local', name: '平台账号', status: 'enabled' } };
}

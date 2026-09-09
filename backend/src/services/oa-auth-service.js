import { timingSafeEqual } from 'node:crypto';
import { getRole } from './authorization-service.js';
import { findIAMUserByAccount } from './iam-store.js';
import { getIdentitySessionProfile, issueIdentitySession, revokeIdentitySession, validateIdentitySession } from './identity-session-service.js';

const getAuthMode = () => process.env.OA_AUTH_MODE || 'mock';
const demoMockAllowed = () => getAuthMode() === 'mock' && process.env.NODE_ENV !== 'production' && !process.env.IDENTITY_PROVIDERS_FILE;
const passwordsEqual = (supplied, configured) => {
  const candidate = Buffer.from(String(supplied));
  const expected = Buffer.from(String(configured));
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
};

export function getOAConnectionStatus() {
  const authMode = getAuthMode();
  const demoEnabled = demoMockAllowed();
  return {
    id: 'oa', system: 'OA / BPM', status: demoEnabled ? 'connected_demo' : 'identity_provider_required', authMode,
    endpoint: process.env.OA_OIDC_ISSUER || '企业 OA 单点登录（Demo 模拟）',
    capabilities: ['OIDC / OAuth 2.1 登录', '组织与角色同步', '审批待办路由', '移动端会话校验'],
    note: demoEnabled
      ? 'Demo 仅允许预置 OA 演示账号，并校验统一演示密码；不保存密码，也不根据账号文本推断角色。'
      : '当前环境已禁用 OA Mock 登录。请配置企业 OA 的 OIDC/OAuth 2.1 授权码流程与企业 IAM 会话。'
  };
}

export async function loginWithOA({ account, password, deviceId, platform }) {
  if (!demoMockAllowed()) return { error: 'OA Mock 登录已禁用。请使用已配置的企业身份提供方完成登录。' };
  const normalizedAccount = String(account || '').trim().toLowerCase();
  if (!normalizedAccount || !String(password || '').trim()) return { error: '请输入 OA 账号和密码。' };
  const expectedPassword = process.env.DEMO_OA_PASSWORD || process.env.DEMO_LOCAL_PASSWORD || 'demo';
  if (!passwordsEqual(password, expectedPassword)) return { error: 'OA 账号或密码错误。' };
  const user = findIAMUserByAccount(normalizedAccount);
  if (!user || user.status !== 'active' || !user.sources.includes('oa')) return { error: '未找到已启用的 OA 演示账号。请使用预置账号或配置企业身份提供方。' };
  const role = getRole(user.primaryRoleId);
  const session = await issueIdentitySession({ source: 'oa', account: user.account, userName: user.name, roleId: role.id, roleName: role.name, deviceId, platform });
  return { sessionId: session.id, user: { id: user.id, account: session.account, name: session.userName, roleId: session.roleId, roleIds: user.roleIds, roleName: session.roleName, orgUnitId: user.orgUnitId, source: 'oa', version: user.version }, connection: getOAConnectionStatus() };
}

export const validateOASession = validateIdentitySession;
export const getOASessionProfile = getIdentitySessionProfile;
export const logoutOA = revokeIdentitySession;

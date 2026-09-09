import { randomUUID } from 'node:crypto';
import { findIAMUserByAccount, getIAMRolePolicy } from './iam-store.js';
import { asyncRuntimeStateRepository } from '../repositories/async-runtime-state-repository.js';
import { identityProviders } from './identity-provider-service.js';

const SESSION_NAMESPACE = 'identity_sessions';

const sameRolePolicyVersions = (baseline, current) => {
  const baselineKeys = Object.keys(baseline || {}).sort();
  const currentKeys = Object.keys(current || {}).sort();
  return baselineKeys.length === currentKeys.length
    && baselineKeys.every((key, index) => key === currentKeys[index] && baseline[key] === current[key]);
};

export function createIdentitySessionService({
  repository = asyncRuntimeStateRepository,
  findUserByAccount = findIAMUserByAccount,
  findRolePolicy = getIAMRolePolicy,
  validateProviderBinding = (session) => identityProviders.validateSessionBinding(session),
  clock = () => Date.now(),
  createId = () => `identity-${randomUUID()}`
} = {}) {
  if (!repository || !['readState', 'writeState', 'deleteState'].every((method) => typeof repository[method] === 'function')) throw new TypeError('Identity session service requires an async runtime repository.');

  const authorizationSnapshot = (account) => {
    const user = findUserByAccount(account);
    if (!user) return null;
    return {
      userId: user.id,
      userVersion: user.version,
      roleIds: [...user.roleIds],
      rolePolicyVersions: Object.fromEntries(user.roleIds.map((roleId) => [roleId, findRolePolicy(roleId)?.version ?? null]))
    };
  };

  const invalidateSession = async (sessionId, error, code) => {
    await repository.deleteState(SESSION_NAMESPACE, sessionId);
    return { error, code };
  };

  const issueIdentitySession = async ({ source, tenantId = 'demo-enterprise', account, userName, roleId, roleName, deviceId, platform, identityBinding, externalIdentity }) => {
    const timestamp = clock();
    const session = {
      id: createId(), source, tenantId, account, userName, roleId, roleName,
      ...(identityBinding ? { identityBinding } : {}),
      ...(externalIdentity ? { externalIdentity } : {}),
      deviceId: deviceId || null,
      platform: platform || 'mobile',
      iamAuthorization: authorizationSnapshot(account),
      issuedAt: new Date(timestamp).toISOString(),
      expiresAt: new Date(timestamp + 8 * 60 * 60 * 1000).toISOString()
    };
    await repository.writeState(SESSION_NAMESPACE, session.id, session);
    return session;
  };

  const validateIdentitySession = async (sessionId, requestedRole, deviceId) => {
    const session = await repository.readState(SESSION_NAMESPACE, sessionId);
    if (!session) return { error: '登录会话无效，请重新登录。' };
    if (new Date(session.expiresAt).getTime() <= clock()) return invalidateSession(sessionId, '登录会话已过期，请重新登录。', 'IDENTITY_SESSION_EXPIRED');
    if (requestedRole && requestedRole !== session.roleId) return { error: '登录会话角色与请求角色不一致，已拒绝访问。' };
    if (session.deviceId && session.deviceId !== deviceId) return { error: '登录会话与当前设备不匹配，已拒绝访问。' };
    let bindingError;
    try { bindingError = await validateProviderBinding(session); }
    catch { bindingError = { error: '身份源校验未完成，请重新登录。', code: 'IDENTITY_PROVIDER_REVOKED' }; }
    if (bindingError) return invalidateSession(sessionId, bindingError.error, bindingError.code);
    const user = findUserByAccount(session.account);
    if (!user || user.status !== 'active') return invalidateSession(sessionId, '账号已停用或不存在，请重新登录。', 'IDENTITY_USER_INACTIVE');
    if (!user.roleIds.includes(session.roleId)) return invalidateSession(sessionId, '当前登录角色已被移除，请重新登录。', 'IDENTITY_ROLE_REVOKED');
    const currentAuthorization = authorizationSnapshot(session.account);
    if (!session.iamAuthorization
      || session.iamAuthorization.userId !== currentAuthorization?.userId
      || session.iamAuthorization.userVersion !== currentAuthorization?.userVersion
      || !sameRolePolicyVersions(session.iamAuthorization.rolePolicyVersions, currentAuthorization?.rolePolicyVersions)) {
      return invalidateSession(sessionId, '账号角色或权限策略已变更，请重新登录。', 'IDENTITY_AUTHORIZATION_STALE');
    }
    return { session };
  };

  const getIdentitySessionProfile = async (sessionId, deviceId) => {
    const result = await validateIdentitySession(sessionId, null, deviceId);
    if (result.error) return result;
    const { session } = result;
    return { user: { account: session.account, name: session.userName, roleId: session.roleId, roleName: session.roleName, source: session.source }, expiresAt: session.expiresAt };
  };

  const revokeIdentitySession = async (sessionId) => {
    if (sessionId) await repository.deleteState(SESSION_NAMESPACE, sessionId);
    return { success: true };
  };

  return Object.freeze({ issueIdentitySession, validateIdentitySession, getIdentitySessionProfile, revokeIdentitySession });
}

let identitySessionRepository = asyncRuntimeStateRepository;
let identitySessionService = createIdentitySessionService({ repository: identitySessionRepository });

export function configureIdentitySessionRepository(repository) {
  identitySessionRepository = repository;
  identitySessionService = createIdentitySessionService({ repository });
}

export const getIdentitySessionStoreInfo = () => identitySessionRepository.getInfo?.() || { driver: 'custom', persistence: 'unknown', schemaVersion: null };
export const probeIdentitySessionStore = async () => typeof identitySessionRepository.probe === 'function' ? identitySessionRepository.probe() : { ready: false };
export const issueIdentitySession = (...args) => identitySessionService.issueIdentitySession(...args);
export const validateIdentitySession = (...args) => identitySessionService.validateIdentitySession(...args);
export const getIdentitySessionProfile = (...args) => identitySessionService.getIdentitySessionProfile(...args);
export const revokeIdentitySession = (...args) => identitySessionService.revokeIdentitySession(...args);

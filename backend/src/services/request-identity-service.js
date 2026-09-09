import { validateIdentitySession } from './identity-session-service.js';
import { isKnownRole } from './role-catalog-service.js';
import { identityProviders } from './identity-provider-service.js';

export const isDemoRoleHeaderEnabled = () => process.env.NODE_ENV !== 'production' && !process.env.IDENTITY_PROVIDERS_FILE && process.env.DEMO_ALLOW_ROLE_HEADER !== 'false';

// A verified identity session always wins over the Demo header. This keeps the
// header useful for local fixtures without allowing it to elevate an authenticated user.
export async function resolveRequestIdentity({ headers = {}, url, allowDemoRoleHeader = isDemoRoleHeaderEnabled() }) {
  const sessionId = headers['x-identity-session'] || headers['x-oa-session'];
  if (sessionId) {
    const validation = await validateIdentitySession(sessionId, undefined, headers['x-client-device-id']);
    if (validation.error) return { error: validation.error };
    const sessionProvider = validation.session.externalIdentity?.providerId || (validation.session.source === 'dingtalk' ? 'dingtalk' : null);
    if (headers['x-identity-provider'] && headers['x-identity-provider'] !== sessionProvider) return { error: '登录会话不属于当前身份源，请重新登录。', code: 'IDENTITY_PROVIDER_MISMATCH' };
    return {
      role: validation.session.roleId,
      source: 'identity_session',
      tenantId: validation.session.tenantId || 'demo-enterprise',
      subjectId: validation.session.account,
      externalIdentity: validation.session.externalIdentity || null,
      sessionId: validation.session.id,
      deviceId: validation.session.deviceId || headers['x-client-device-id'] || null
    };
  }
  if (!allowDemoRoleHeader || process.env.IDENTITY_PROVIDERS_FILE || headers['x-identity-provider'] || ['dingtalk-mobile', 'dingtalk-pc'].includes(headers['x-client-platform'])) return { error: '请先完成身份认证。' };
  const requestedRole = headers['x-demo-role'] || url?.searchParams?.get('role') || 'quality_manager';
  const demoDeviceId = headers['x-client-device-id'] || null;
  return isKnownRole(requestedRole) ? {
    role: requestedRole,
    source: 'demo_header',
    tenantId: 'demo-enterprise',
    subjectId: demoDeviceId ? `demo:${requestedRole}:${demoDeviceId}` : `demo:${requestedRole}:anonymous`,
    sessionId: null,
    deviceId: demoDeviceId
  } : { error: '无效的演示角色。' };
}

export async function resolveRequestIdentityAsync({ headers = {}, url, allowDemoRoleHeader = isDemoRoleHeaderEnabled(), oidcVerifier = (token, providerId) => identityProviders.verifyBearer(token, providerId) }) {
  if (headers['x-identity-session'] || headers['x-oa-session']) return resolveRequestIdentity({ headers, url, allowDemoRoleHeader });
  const authorization = String(headers.authorization || '').trim();
  if (authorization) {
    const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
    if (!match || match[1].length > 16_384) return { error: '企业身份令牌格式无效。', code: 'OIDC_TOKEN_MALFORMED' };
    const providerId = headers['x-identity-provider'];
    if (providerId !== undefined && (typeof providerId !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(providerId))) return { error: '身份源标识无效。', code: 'IDENTITY_PROVIDER_INVALID' };
    const identity = await oidcVerifier(match[1], providerId);
    return identity.error ? identity : { ...identity, deviceId: headers['x-client-device-id'] || null };
  }
  return resolveRequestIdentity({ headers, url, allowDemoRoleHeader });
}

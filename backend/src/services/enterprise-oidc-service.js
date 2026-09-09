import { createRemoteJWKSet, jwtVerify } from 'jose';
import { findIAMUserByAccount } from './iam-store.js';

const jwksCache = new Map();
const allowedAccountClaims = new Set(['email', 'preferred_username', 'upn']);
const asymmetricAlgorithms = new Set(['RS256', 'RS384', 'RS512', 'ES256', 'ES384']);

const configurationFrom = (env) => {
  const issuer = String(env.OIDC_ISSUER || '');
  const audience = String(env.OIDC_AUDIENCE || '');
  const jwksUri = String(env.OIDC_JWKS_URI || '');
  const algorithms = String(env.OIDC_ALLOWED_ALGORITHMS || 'RS256,ES256').split(',').map((item) => item.trim()).filter(Boolean);
  const accountClaim = allowedAccountClaims.has(env.OIDC_ACCOUNT_CLAIM) ? env.OIDC_ACCOUNT_CLAIM : 'email';
  if (!issuer || !audience || !jwksUri) throw new Error('OIDC issuer, audience, and JWKS URI are required.');
  if (!algorithms.length || algorithms.some((item) => !asymmetricAlgorithms.has(item))) throw new Error('OIDC requires an approved asymmetric signature algorithm.');
  return { issuer, audience, jwksUri, algorithms, accountClaim, tenantId: env.OIDC_TENANT_ID || null, tenantClaim: env.OIDC_TENANT_CLAIM ?? 'tid', externalTenantId: env.OIDC_EXTERNAL_TENANT_ID || env.OIDC_TENANT_ID || null };
};

const remoteJwks = (uri) => {
  if (!jwksCache.has(uri)) jwksCache.set(uri, createRemoteJWKSet(new URL(uri), { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 }));
  return jwksCache.get(uri);
};

export async function verifyEnterpriseAccessToken(token, { env = process.env, jwks, jwtVerifyImpl = jwtVerify, providerId = 'oidc', subjectBindings } = {}) {
  try {
    const config = configurationFrom(env);
    const { payload, protectedHeader } = await jwtVerifyImpl(token, jwks || remoteJwks(config.jwksUri), {
      issuer: config.issuer, audience: config.audience, algorithms: config.algorithms,
      requiredClaims: ['sub', 'iat', 'exp'], clockTolerance: 5
    });
    if (!config.algorithms.includes(protectedHeader.alg)) throw new Error('OIDC algorithm denied.');
    if (config.tenantClaim && config.externalTenantId && payload[config.tenantClaim] !== config.externalTenantId) throw new Error('OIDC tenant mismatch.');
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('OIDC subject missing.');
    // Managed adapters bind immutable subjects, not editable email or name claims.
    const account = subjectBindings
      ? subjectBindings.find((item) => item.subject === payload.sub)?.account
      : String(payload[config.accountClaim] || '').trim().toLowerCase();
    if (!account) return { error: '企业身份未绑定平台账号。', code: 'OIDC_IAM_USER_NOT_FOUND' };
    const user = findIAMUserByAccount(account);
    if (!user || user.status !== 'active' || !user.roleIds.includes(user.primaryRoleId)) return { error: '企业身份未映射到已启用的平台账号。', code: 'OIDC_IAM_USER_NOT_FOUND' };
    return {
      role: user.primaryRoleId,
      roleIds: [...user.roleIds],
      source: 'oidc_bearer',
      tenantId: config.tenantId || 'demo-enterprise',
      subjectId: user.account,
      userId: user.id,
      oidcSubject: String(payload.sub),
      externalIdentity: { providerId, tenantId: config.tenantId || 'demo-enterprise', subjectId: payload.sub, issuer: config.issuer, audience: config.audience },
      sessionId: null
    };
  } catch {
    return { error: '企业身份令牌无效或已过期。', code: 'OIDC_TOKEN_INVALID' };
  }
}

import { readIdentityProviderConfiguration } from '../config/identity-provider-config.js';
import { readDingTalkConfiguration } from '../config/dingtalk-config.js';
import { createIdentityProviderRegistry } from './identity-provider-registry.js';
import { verifyEnterpriseAccessToken } from './enterprise-oidc-service.js';

const denied = () => ({ error: '身份源不可用、身份绑定已撤销或不匹配，请联系管理员。', code: 'IDENTITY_PROVIDER_REVOKED' });
const oidcEnv = (provider) => ({ OIDC_ISSUER: provider.issuer, OIDC_AUDIENCE: provider.audience, OIDC_JWKS_URI: provider.jwksUri, OIDC_TENANT_ID: provider.tenantId, OIDC_TENANT_CLAIM: provider.tenantClaim || '', OIDC_EXTERNAL_TENANT_ID: provider.externalTenantId || '' });

export function createIdentityProviderService({ getConfiguration = readIdentityProviderConfiguration, getDingTalkConfig = readDingTalkConfiguration, env = process.env, oidcVerifier = verifyEnterpriseAccessToken } = {}) {
  const configuration = () => getConfiguration(env);
  const dingTalkConfiguration = () => {
    const config = configuration();
    if (config && !config.providers.some((item) => item.id === 'dingtalk' && item.type === 'dingtalk' && item.enabled)) throw new Error('DingTalk identity provider disabled.');
    return getDingTalkConfig(env);
  };
  const registry = (config) => {
    const definitions = config ? config.providers.filter((item) => item.enabled) : [
      { id: 'dingtalk', type: 'dingtalk', name: '钉钉' },
      { id: 'oidc', type: 'oidc', name: '企业 OIDC', legacy: true }
    ];
    return createIdentityProviderRegistry(definitions.map((provider) => {
      if (provider.type === 'dingtalk') {
        let current;
        try { current = dingTalkConfiguration(); } catch { current = null; }
        return { ...provider, configured: Boolean(current), capabilities: ['host_code', 'session_binding'], validateBinding: (session) => {
          const binding = session.identityBinding;
          return Boolean(current && binding && session.tenantId === current.tenantId && binding.corpId === current.corpId && binding.clientId === current.clientId
            && current.userBindings.some((item) => item.userId === binding.userId && item.account.trim().toLowerCase() === session.account)
            && (!session.externalIdentity || (session.externalIdentity.providerId === provider.id && session.externalIdentity.subjectId === binding.userId && session.externalIdentity.tenantId === current.tenantId)));
        } };
      }
      return { ...provider, configured: provider.legacy ? Boolean(env.OIDC_ISSUER && env.OIDC_AUDIENCE && env.OIDC_JWKS_URI) : true, capabilities: ['bearer'],
        verifyBearer: (token) => oidcVerifier(token, provider.legacy ? { env } : { env: oidcEnv(provider), providerId: provider.id, subjectBindings: provider.bindings }),
        validateBinding: (session) => !provider.legacy && session.tenantId === provider.tenantId && session.externalIdentity?.tenantId === provider.tenantId
          && session.externalIdentity?.issuer === provider.issuer && session.externalIdentity?.audience === provider.audience
          && provider.bindings.some((item) => item.subject === session.externalIdentity?.subjectId && item.account === session.account)
      };
    }));
  };
  return Object.freeze({
    dingTalkConfiguration,
    describe() {
      try { const config = configuration(); return { configured: true, mode: config ? 'managed' : 'legacy', defaultBearerProviderId: config?.defaultBearerProviderId || (config ? null : 'oidc'), providers: registry(config).list() }; }
      catch { return { configured: false, mode: 'invalid', defaultBearerProviderId: null, providers: [] }; }
    },
    async verifyBearer(token, requestedProviderId) {
      try {
        const config = configuration();
        const providerId = requestedProviderId || (config ? config.defaultBearerProviderId : 'oidc');
        const adapter = registry(config).get(providerId);
        if (!adapter?.configured || !adapter.verifyBearer) return denied();
        // No retry against another provider when verification fails.
        return await adapter.verifyBearer(token);
      } catch { return denied(); }
    },
    async validateSessionBinding(session) {
      const id = session.externalIdentity?.providerId || (session.source === 'dingtalk' ? 'dingtalk' : null);
      if (!id) {
        try { if (configuration() || env.NODE_ENV === 'production') return denied(); }
        catch { return denied(); }
        return session.source === 'external' ? denied() : null;
      }
      try {
        const adapter = registry(configuration()).get(id);
        if (adapter?.configured && await adapter.validateBinding(session)) return null;
      } catch { /* Configuration failures revoke existing external sessions. */ }
      return { ...denied(), code: id === 'dingtalk' ? 'DINGTALK_IDENTITY_REVOKED' : 'IDENTITY_PROVIDER_REVOKED' };
    }
  });
}

export const identityProviders = createIdentityProviderService();

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const providerIdPattern = /^[a-z][a-z0-9-]{0,47}$/;
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !value.startsWith('REPLACE_WITH_');
const httpsUrl = (value) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Identity endpoint must use HTTPS without credentials or fragment.');
  return value;
};

// A deployment-owned file, never a path or issuer supplied by a login request.
// Without this file the existing single OIDC / DingTalk configuration remains compatible.
export function readIdentityProviderConfiguration(env = process.env) {
  if (!env.IDENTITY_PROVIDERS_FILE) return null;
  if (!isAbsolute(env.IDENTITY_PROVIDERS_FILE) || statSync(env.IDENTITY_PROVIDERS_FILE).size > 128 * 1024) throw new Error('Invalid identity provider configuration file.');
  const raw = readFileSync(env.IDENTITY_PROVIDERS_FILE, 'utf8');
  if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('Identity provider configuration too large.');
  return validateIdentityProviderConfiguration(JSON.parse(raw.replace(/^\uFEFF/, '')));
}

export function validateIdentityProviderConfiguration(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.providers) || !input.providers.length || input.providers.length > 16) throw new Error('Identity provider configuration requires version 1 and 1–16 providers.');
  const ids = new Set();
  const providers = input.providers.map((item) => {
    if (!item || typeof item.id !== 'string' || !providerIdPattern.test(item.id) || ids.has(item.id) || !['oidc', 'dingtalk'].includes(item.type) || typeof item.enabled !== 'boolean' || !nonempty(item.name)) throw new Error('Invalid or duplicate identity provider.');
    ids.add(item.id);
    if (item.type === 'dingtalk') {
      if (item.id !== 'dingtalk') throw new Error('The current DingTalk adapter uses the reserved dingtalk provider ID.');
      return { id: item.id, type: item.type, name: item.name, enabled: item.enabled };
    }
    if (item.id === 'dingtalk' || !nonempty(item.tenantId) || !nonempty(item.audience) || !Array.isArray(item.bindings)) throw new Error('OIDC requires a tenant, audience and explicit subject bindings.');
    const issuer = httpsUrl(item.issuer);
    const jwksUri = httpsUrl(item.jwksUri);
    const subjects = new Set(); const accounts = new Set();
    const bindings = item.bindings.map((binding) => {
      if (!binding || !nonempty(binding.subject) || !nonempty(binding.account)) throw new Error('Invalid external subject binding.');
      const account = binding.account.trim().toLowerCase();
      if (subjects.has(binding.subject) || accounts.has(account)) throw new Error('Duplicate subject or account within an identity provider.');
      subjects.add(binding.subject); accounts.add(account);
      return { subject: binding.subject, account };
    });
    const tenantClaim = item.tenantClaim || null;
    const externalTenantId = item.externalTenantId || null;
    if ((tenantClaim || externalTenantId) && (typeof tenantClaim !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tenantClaim) || !nonempty(externalTenantId))) throw new Error('Tenant claim and external tenant ID must be supplied together.');
    return { id: item.id, type: item.type, name: item.name, enabled: item.enabled, tenantId: item.tenantId, issuer, jwksUri, audience: item.audience, tenantClaim, externalTenantId, bindings };
  });
  const defaultBearerProviderId = input.defaultBearerProviderId || null;
  if (defaultBearerProviderId && !providers.some((item) => item.id === defaultBearerProviderId && item.enabled && item.type === 'oidc')) throw new Error('Default bearer provider must be an enabled OIDC provider.');
  return { version: 1, defaultBearerProviderId, providers };
}

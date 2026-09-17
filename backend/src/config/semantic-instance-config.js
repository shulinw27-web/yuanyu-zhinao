import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u.test(value);
const invalid = () => { throw new Error('SEMANTIC_INSTANCE_CONFIG_INVALID'); };

// Deployment-owned only. No URL, credential or tenant selection from a user payload.
export function localSemanticEndpoint(value) {
  const target = new URL(value);
  if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)
    || target.username || target.password || target.search || target.hash || target.pathname !== '/') invalid();
  // Use a literal loopback address so localhost DNS cannot redirect service credentials.
  if (target.hostname === 'localhost') target.hostname = '127.0.0.1';
  return target.origin;
}

export function validateSemanticInstanceConfiguration(input, legacyEndpoint = 'http://127.0.0.1:3011') {
  if (input?.version !== 1 || !Array.isArray(input.instances) || input.instances.length > 100) invalid();
  const tenants = new Set(); const endpoints = new Set(); const deployments = new Set(); const secrets = new Set();
  let legacy;
  try { legacy = localSemanticEndpoint(legacyEndpoint); } catch { invalid(); }
  return input.instances.map(item => {
    if (!item || !identifier(item.tenantId) || !identifier(item.deploymentId) || typeof item.enabled !== 'boolean'
      || typeof item.token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/u.test(item.token)) invalid();
    const endpoint = localSemanticEndpoint(item.endpoint);
    // Every instance, including disabled reservations, owns a distinct port and credential.
    // Demo's implicit endpoint is reserved unless Demo itself is explicitly bound.
    if (tenants.has(item.tenantId) || endpoints.has(endpoint) || deployments.has(item.deploymentId) || secrets.has(item.token)
      || item.tenantId !== 'demo-enterprise' && endpoint === legacy) invalid();
    tenants.add(item.tenantId); endpoints.add(endpoint); deployments.add(item.deploymentId); secrets.add(item.token);
    return Object.freeze({ tenantId: item.tenantId, deploymentId: item.deploymentId, endpoint, token: item.token, enabled: item.enabled });
  });
}

export function readSemanticInstanceConfiguration(env = process.env) {
  if (!env.SEMANTIC_INSTANCES_FILE) return null;
  const path = env.SEMANTIC_INSTANCES_FILE;
  if (!isAbsolute(path) || statSync(path).size > 128 * 1024) invalid();
  const raw = readFileSync(path, 'utf8');
  if (Buffer.byteLength(raw) > 128 * 1024) invalid();
  return validateSemanticInstanceConfiguration(JSON.parse(raw.replace(/^\uFEFF/u, '')), env.SEMANTIC_CONTEXT_ENDPOINT);
}

import { localSemanticEndpoint, readSemanticInstanceConfiguration } from '../config/semantic-instance-config.js';
import { currentSemanticTenant } from './semantic-tenant-context.js';

export function semanticInstanceConnection() {
  const tenantId = currentSemanticTenant();
  try {
    const instances = readSemanticInstanceConfiguration();
    // An explicit registry is authoritative: missing, disabled and invalid never fall back.
    if (instances) {
      const item = instances.find(item => item.tenantId === tenantId && item.enabled);
      return item ? { ...item, guarded: true } : { reason: 'tenant_endpoint_required' };
    }
    if (tenantId !== 'demo-enterprise' || process.env.NODE_ENV === 'production') return { reason: 'tenant_endpoint_required' };
    try { return { endpoint: localSemanticEndpoint(process.env.SEMANTIC_CONTEXT_ENDPOINT || 'http://127.0.0.1:3011'), tenantId, guarded: false }; }
    catch { return { reason: 'unsafe_endpoint' }; }
  } catch { return { reason: 'tenant_config_invalid' }; }
}

export async function requestSemanticInstance(connection, path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  let requestAttempted = false;
  const headers = { ...(body ? { 'content-type': 'application/json' } : {}), ...(connection.guarded ? {
    authorization: `Bearer ${connection.token}`, 'x-semantic-tenant': connection.tenantId,
    'x-semantic-deployment': connection.deploymentId
  } : {}) };
  const checkReceipt = response => {
    if (connection.guarded && (response.headers.get('x-semantic-tenant') !== connection.tenantId
      || response.headers.get('x-semantic-deployment') !== connection.deploymentId
      || response.headers.get('x-semantic-protocol') !== '1')) throw new Error('instance_identity_unverified');
  };
  try {
    // Verify the instance before transmitting a model or resetting anything.
    if (connection.guarded) {
      const probe = await fetch(new URL('/instance', connection.endpoint), { headers, redirect: 'error', signal: controller.signal });
      if (!probe.ok) throw new Error('instance_identity_unverified');
      checkReceipt(probe); await probe.body?.cancel();
    }
    requestAttempted = true;
    const response = await fetch(new URL(path, connection.endpoint), {
      method, headers, redirect: 'error', body: body ? JSON.stringify(body) : undefined, signal: controller.signal
    });
    checkReceipt(response);
    if (!response.ok) throw new Error('service_unavailable');
    const payload = await response.json();
    return connection.guarded ? { ...payload, instance: { tenantId: connection.tenantId, deploymentId: connection.deploymentId, protocol: 1, identityVerified: true } } : payload;
  } catch (error) {
    // Do not propagate a remote response, URL, credential or arbitrary exception into chat.
    throw Object.assign(new Error(error.message === 'instance_identity_unverified' ? 'instance_identity_unverified' : 'service_unavailable'), { requestAttempted });
  } finally { clearTimeout(timer); }
}

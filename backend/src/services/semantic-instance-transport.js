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

export async function requestSemanticInstance(connection, path, { method = 'GET', body, modelId, projectionScope = 'definition_only', beforeDispatch } = {}) {
  // Explicit bounded protocols, never a generic model/data router or runtime grant.
  if (!['definition_only', 'synthetic_graph', 'synthetic_relationships'].includes(projectionScope) || projectionScope !== 'definition_only' && !modelId) {
    throw Object.assign(new Error('instance_identity_unverified'), { requestAttempted: false });
  }
  if (modelId !== undefined || path.startsWith('/models/')) {
    const suffix = typeof modelId === 'string' ? path.slice(`/models/${modelId}/`.length) : '';
    const operationAllowed = projectionScope === 'definition_only'
      ? ['instance', 'definition', 'definition/validate', 'definition/publish'].includes(suffix)
      : projectionScope === 'synthetic_graph'
        ? ['graph', 'graph/ingest', 'graph/reset'].includes(suffix) || /^graph\/runs\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(suffix)
        : suffix === 'graph/relationships/materialize' && method === 'POST'
          || /^graph\/relationships\/runs\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(suffix) && method === 'GET';
    if (!connection.guarded || typeof modelId !== 'string' || modelId === 'oa-governance'
      || !/^[a-z][a-z0-9-]{1,63}$/.test(modelId)
      || !path.startsWith(`/models/${modelId}/`) || !operationAllowed) {
      throw Object.assign(new Error('instance_identity_unverified'), { requestAttempted: false });
    }
  }
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
    if (modelId && (response.headers.get('x-semantic-model') !== modelId
      || response.headers.get('x-semantic-model-protocol') !== '1')) throw new Error('instance_identity_unverified');
    if (projectionScope === 'synthetic_graph' && response.headers.get('x-semantic-graph-protocol') !== '1') throw new Error('instance_identity_unverified');
    if (projectionScope === 'synthetic_relationships' && response.headers.get('x-semantic-relationship-protocol') !== '1') throw new Error('instance_identity_unverified');
  };
  try {
    // Verify the instance before transmitting a model or resetting anything.
    if (connection.guarded) {
      const probe = await fetch(new URL(modelId ? `/models/${modelId}/instance` : '/instance', connection.endpoint), { headers, redirect: 'error', signal: controller.signal });
      if (!probe.ok) throw new Error('instance_identity_unverified');
      checkReceipt(probe); await probe.body?.cancel();
    }
    // Server composition hook, never a request-body grant. Recheck after the
    // network preflight, immediately before entering the actual transmission.
    if (beforeDispatch !== undefined) {
      if (typeof beforeDispatch !== 'function') throw new Error('instance_identity_unverified');
      await beforeDispatch();
    }
    requestAttempted = true;
    const response = await fetch(new URL(path, connection.endpoint), {
      method, headers, redirect: 'error', body: body ? JSON.stringify(body) : undefined, signal: controller.signal
    });
    checkReceipt(response);
    if (!response.ok) throw new Error('service_unavailable');
    const payload = await response.json();
    if (projectionScope === 'synthetic_graph' && (payload.modelId !== modelId || payload.projectionScope !== 'synthetic_graph'
      || payload.runtimeReadEnabled !== false || payload.graphProtocol !== 1)) throw new Error('instance_identity_unverified');
    if (projectionScope === 'synthetic_relationships' && (payload.modelId !== modelId || payload.projectionScope !== 'synthetic_relationships'
      || payload.runtimeReadEnabled !== false || payload.relationshipProtocol !== 1)) throw new Error('instance_identity_unverified');
    return connection.guarded ? { ...payload, instance: { tenantId: connection.tenantId, deploymentId: connection.deploymentId, protocol: 1, identityVerified: true,
      ...(modelId ? { modelId, modelProtocol: 1, projectionScope, runtimeReadEnabled: false,
        ...(projectionScope === 'synthetic_graph' ? { graphProtocol: 1 } : {}),
        ...(projectionScope === 'synthetic_relationships' ? { relationshipProtocol: 1 } : {}) } : {}) } } : payload;
  } catch (error) {
    // Do not propagate a remote response, URL, credential or arbitrary exception into chat.
    throw Object.assign(new Error(error.message === 'instance_identity_unverified' ? 'instance_identity_unverified' : 'service_unavailable'), { requestAttempted });
  } finally { clearTimeout(timer); }
}

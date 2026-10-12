import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
export const DEFAULT_SEMANTIC_MODEL_ID = 'oa-governance';
const invalid = code => Object.assign(new Error(code), { code, status: 403 });

// Bind only a server-verified identity, never a tenant ID from request bodies.
export function runWithSemanticTenant(identity, work) {
  const tenantId = identity?.tenantId;
  if (typeof tenantId !== 'string' || !tenantId.trim() || tenantId !== tenantId.trim() || tenantId.length > 120 || /[\u0000-\u001f]/u.test(tenantId)) {
    throw invalid('SEMANTIC_TENANT_REQUIRED');
  }
  const current = context.getStore();
  if (current && current.tenantId !== tenantId) throw invalid('SEMANTIC_TENANT_CONTEXT_MISMATCH');
  return context.run({ ...current, tenantId }, work);
}

// Internal context primitive. Admission must be performed by the registry, not
// by accepting a body/header directly. No nested tenant/model switching.
export function runWithSemanticModelWorkspace(identity, modelId, work, { registered = false } = {}) {
  if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId) || typeof work !== 'function') throw invalid('SEMANTIC_MODEL_CONTEXT_INVALID');
  return runWithSemanticTenant(identity, () => {
    const current = context.getStore();
    if (current.modelId && current.modelId !== modelId) throw invalid('SEMANTIC_MODEL_CONTEXT_MISMATCH');
    return context.run({ ...current, modelId, modelRegistered: current.modelRegistered === true || registered === true }, work);
  });
}

export const currentSemanticModel = () => context.getStore()?.modelId || DEFAULT_SEMANTIC_MODEL_ID;
export const semanticTenantContextIsBound = () => Boolean(context.getStore()?.tenantId);
// A registry admission marker, not a source grant or business runtime activation.
export const currentSemanticModelRegistered = () => currentSemanticModel() === DEFAULT_SEMANTIC_MODEL_ID || context.getStore()?.modelRegistered === true;

export function semanticModelStateKey(key) {
  const modelId = currentSemanticModel();
  return modelId === DEFAULT_SEMANTIC_MODEL_ID ? key : JSON.stringify(['semantic-model-v1', currentSemanticTenant(), modelId, key]);
}

export function currentSemanticTenant() {
  const tenantId = context.getStore()?.tenantId;
  if (tenantId) return tenantId;
  // Existing offline fixtures and explicit local Demo retain their old workspace.
  // Production and externally configured identity deployments must bind a tenant.
  if (process.env.NODE_ENV === 'production' || process.env.IDENTITY_PROVIDERS_FILE || process.env.DEMO_ALLOW_ROLE_HEADER === 'false') {
    throw invalid('SEMANTIC_TENANT_REQUIRED');
  }
  return 'demo-enterprise';
}

export function semanticTenantStateKey(key) {
  const tenantId = currentSemanticTenant();
  // Preserve legacy data for Demo only; never copy a legacy workspace to a new tenant.
  return tenantId === 'demo-enterprise' ? key : JSON.stringify(['semantic-tenant-v1', tenantId, key]);
}

export function assertSemanticTenant(identity) {
  const current = context.getStore();
  if (current && identity?.tenantId !== current.tenantId) throw invalid('SEMANTIC_TENANT_CONTEXT_MISMATCH');
}

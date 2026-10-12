import { currentSemanticTenant, assertSemanticTenant, runWithSemanticModelWorkspace } from './semantic-tenant-context.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceWithEvent } from './semantic-governance-store.js';

const namespace = 'semantic_model_registry';
const initial = () => ({ revision: 0, models: [] });
const failure = (code, status = 409) => ({ error: '模型注册未完成，请检查身份、权限、修订号和模型标识。', code, status });
const verified = (role, identityScope) => {
  assertSemanticTenant(identityScope);
  return role?.id === 'executive' && identityScope?.tenantId === currentSemanticTenant()
    && typeof identityScope.subjectId === 'string' && identityScope.subjectId.length > 0 && identityScope.subjectId.length <= 128
    && identityScope.subjectId === identityScope.subjectId.trim() && !/[\u0000-\u001f\u007f]/u.test(identityScope.subjectId);
};
const legacy = { id: 'oa-governance', label: '现有语义工作区', lifecycle: 'legacy_workspace', runtimeBinding: 'existing_default', legacy: true };

// Internal foundation only. Registration does not create a published definition,
// copy the legacy workspace, bind a Semantica instance or grant source access.
// Do not expose activation until all draft/review/replay/deployment paths are scoped.
export const semanticModelRegistry = {
  async withWorkspace({ role, identityScope, modelId, work }) {
    if (!verified(role, identityScope)) return failure('MODEL_REGISTRY_FORBIDDEN', 403);
    if (typeof work !== 'function') return failure('MODEL_WORKSPACE_CALLBACK_REQUIRED', 400);
    const state = await readSemanticGovernanceState(namespace, 'index', initial);
    if (modelId !== legacy.id && !state.models.some(model => model.id === modelId && model.lifecycle === 'registered')) return failure('MODEL_REGISTRY_NOT_FOUND', 404);
    if (!verified(role, identityScope)) return failure('MODEL_REGISTRY_FORBIDDEN', 403);
    return runWithSemanticModelWorkspace(identityScope, modelId, work, { registered: true });
  },
  async list({ role, identityScope }) {
    if (!verified(role, identityScope)) return failure('MODEL_REGISTRY_FORBIDDEN', 403);
    const state = await readSemanticGovernanceState(namespace, 'index', initial);
    return { revision: state.revision, models: structuredClone([legacy, ...state.models]), runtimeSelectionEnabled: false };
  },
  async register({ role, identityScope, body }) {
    if (!verified(role, identityScope)) return failure('MODEL_REGISTRY_FORBIDDEN', 403);
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['id', 'label', 'description', 'expectedRevision'].includes(key))
      || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(body.id) || body.id === legacy.id
      || typeof body.label !== 'string' || body.label !== body.label.trim() || body.label.length < 2 || body.label.length > 80
      || /[\u0000-\u001f\u007f<>]/u.test(body.label)
      || body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 1000 || /[\u0000-\u001f\u007f<>]/u.test(body.description))
      || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) return failure('MODEL_REGISTRY_INPUT_INVALID', 400);
    return mutateSemanticGovernanceWithEvent({ namespace, key: 'index', initialValue: initial, mutation: state => {
      if (!verified(role, identityScope)) return { commit: false, result: failure('MODEL_REGISTRY_FORBIDDEN', 403) };
      if (state.revision !== body.expectedRevision) return { commit: false, result: failure('MODEL_REGISTRY_REVISION_CONFLICT') };
      if (state.models.some(model => model.id === body.id || model.label === body.label) || body.label === legacy.label) return { commit: false, result: failure('MODEL_REGISTRY_DUPLICATE') };
      if (state.models.length >= 31) return { commit: false, result: failure('MODEL_REGISTRY_LIMIT') };
      const model = { id: body.id, label: body.label, description: body.description || '', lifecycle: 'registered', runtimeBinding: 'not_bound',
        legacy: false, createdAt: new Date().toISOString(), createdBy: identityScope.subjectId };
      state.models.push(model); state.revision++;
      return { value: state, result: { revision: state.revision, model: structuredClone(model), runtimeSelectionEnabled: false },
        event: { type: 'governance.semantic_model.registered', tenantId: identityScope.tenantId, aggregateType: 'SemanticModelRegistry', aggregateId: model.id,
          actor: { type: 'subject', id: identityScope.subjectId }, payload: { modelId: model.id, revision: state.revision, runtimeBinding: model.runtimeBinding } } };
    } });
  }
};

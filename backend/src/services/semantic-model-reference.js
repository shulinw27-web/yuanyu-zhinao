import { currentSemanticModel, currentSemanticModelRegistered, DEFAULT_SEMANTIC_MODEL_ID } from './semantic-tenant-context.js';
import { readSemanticGovernanceState } from './semantic-governance-store.js';

// Missing IDs are compatible only with legacy records in the default workspace.
// A reference never selects a workspace or grants access to one.
export const semanticModelReferenceMatches = record => Boolean(record)
  && (record.modelId === currentSemanticModel()
    || record.modelId === undefined && currentSemanticModel() === DEFAULT_SEMANTIC_MODEL_ID);

export async function assertCurrentSemanticModelAdmission() {
  if (currentSemanticModel() === DEFAULT_SEMANTIC_MODEL_ID) return;
  const registry = await readSemanticGovernanceState('semantic_model_registry', 'index', { models: [] });
  if (!currentSemanticModelRegistered() || !registry.models.some(model => model.id === currentSemanticModel() && model.lifecycle === 'registered')) {
    throw Object.assign(new Error('模型工作区授权已失效。'), { code: 'SEMANTIC_MODEL_WORKSPACE_REVOKED' });
  }
}

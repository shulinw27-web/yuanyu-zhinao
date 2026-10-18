import { getEffectiveAccess } from '../../services/access-control-service.js';
import { runWithIAMStoreContext, getIAMVersion } from '../../services/iam-store.js';
import { runWithSemanticTenant, runWithSemanticModelWorkspace, DEFAULT_SEMANTIC_MODEL_ID } from '../../services/semantic-tenant-context.js';
import { readSemanticGovernanceState } from '../../services/semantic-governance-store.js';
import { getOAMetaModelRuntimeTransactionEntry } from '../../services/meta-model-service.js';
import { getOntologyRuntimeGrant } from '../../services/ontology-read-plan-service.js';
import { semanticFingerprint } from '../../services/semantic-model-fingerprint.js';
import { createModelConversationOperations } from './model-conversations.js';

const modelIdValid = value => typeof value === 'string' && /^[a-z][a-z0-9-]{1,63}$/u.test(value);
const text = (value, limit = 160) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f<>]/u.test(value);
const rejected = (code, status = 403) => ({ error: '当前身份下无法读取该模型定义，请检查授权、发布状态和版本。', code, status });
const readRegistry = () => readSemanticGovernanceState('semantic_model_registry', 'index', { revision: 0, models: [] });
const registryValid = registry => Number.isSafeInteger(registry?.revision) && registry.revision >= 0 && Array.isArray(registry.models) && registry.models.length <= 31
  && registry.models.every(model => modelIdValid(model?.id) && model.id !== DEFAULT_SEMANTIC_MODEL_ID && text(model.label, 80))
  && new Set(registry.models.map(model => model.id)).size === registry.models.length;
const authority = identity => runWithIAMStoreContext(() => {
  const access = getEffectiveAccess(null, identity);
  return access.principalResolved && access.pagePermissionIds.includes('page.agent.view') && access.buttonPermissionIds.includes('agent.prompt.run')
    ? { roles: access.roleIds, stamp: JSON.stringify([getIAMVersion(), access]) } : null;
}, identity.tenantId);
const grantProof = (identity, modelId, roles) => runWithSemanticModelWorkspace(identity, modelId, () => {
  const grants = roles.map(roleId => ({ roleId, grant: getOntologyRuntimeGrant(identity, roleId) })).filter(item => item.grant?.metadata === true);
  return grants.length ? JSON.stringify(grants) : null;
}, { registered: true });
const readPublication = (identity, modelId) => runWithSemanticModelWorkspace(identity, modelId, async () => {
  const entry = getOAMetaModelRuntimeTransactionEntry();
  const runtime = await readSemanticGovernanceState(entry.namespace, entry.key, null);
  const lock = await readSemanticGovernanceState('ontology_publication', 'current', null);
  return { published: runtime?.publishedModel || null, lock };
}, { registered: true });

// Only a bounded schema projection. No samples, policies, connection settings,
// expressions, prompts, raw annotations or credentials enter this DTO.
const project = ({ published, lock }, model, identity) => {
  if (!published && !lock) return null;
  if (published?.tenantId !== identity.tenantId || published.modelId !== model.id || !text(published.version, 120)
    || !/^[a-f0-9]{24}$/u.test(published.fingerprint || '') || !text(published.publishedAt, 40) || !Number.isFinite(Date.parse(published.publishedAt))
    || lock?.status !== 'completed' || lock.modelId !== model.id || lock.version !== published.version || lock.fingerprint !== published.fingerprint
    || lock.target?.modelId !== model.id || lock.target.tenantId !== identity.tenantId || !text(lock.target.deploymentId, 120)) throw new Error('PUBLICATION_BINDING_INVALID');
  if (Buffer.byteLength(JSON.stringify(published)) > 512 * 1024) throw new Error('PUBLICATION_BUDGET');
  const draft = published.draft;
  if (!Array.isArray(draft?.objectTypes) || !draft.objectTypes.length || draft.objectTypes.length > 200 || !Array.isArray(draft.relationshipTypes) || draft.relationshipTypes.length > 400) throw new Error('SCHEMA_BUDGET');
  const ids = new Set();
  const nodes = draft.objectTypes.map(object => {
    if (!text(object?.id, 64) || ids.has(object.id) || !text(object.label) || !text(object.key, 64)
      || !Array.isArray(object.fields) || !object.fields.length || object.fields.length > 100 || object.fields.some(field => !text(field, 64))
      || new Set(object.fields).size !== object.fields.length || !object.fields.includes(object.key)
      || !Array.isArray(object.sourceSystems) || object.sourceSystems.length > 16 || object.sourceSystems.some(system => typeof system !== 'string' || !/^[A-Z][A-Z0-9_-]{0,39}$/u.test(system))) throw new Error('SCHEMA_OBJECT_INVALID');
    ids.add(object.id);
    return { id: object.id, label: object.label, key: object.key, fields: [...object.fields], sourceSystems: [...object.sourceSystems] };
  });
  const relations = new Set();
  const edges = draft.relationshipTypes.map(relation => {
    if (!ids.has(relation?.from) || !ids.has(relation.to) || !text(relation.predicate, 80)
      || relation.cardinality !== undefined && !['1:1', '1:n', 'n:1', 'n:n'].includes(relation.cardinality)) throw new Error('SCHEMA_RELATION_INVALID');
    const key = JSON.stringify([relation.from, relation.predicate, relation.to]);
    if (relations.has(key)) throw new Error('SCHEMA_RELATION_DUPLICATE'); relations.add(key);
    return { from: relation.from, to: relation.to, predicate: relation.predicate, ...(relation.cardinality ? { cardinality: relation.cardinality } : {}) };
  });
  if (semanticFingerprint(draft) !== published.fingerprint) throw new Error('PUBLICATION_FINGERPRINT_INVALID');
  const result = { modelId: model.id, label: model.label, version: published.version, fingerprint: published.fingerprint, publishedAt: published.publishedAt,
    authority: 'published_schema_not_business_facts_or_permissions', runtimeReadEnabled: false, chatSelectionEnabled: false,
    nodeCount: nodes.length, relationshipCount: edges.length, graph: { nodes, edges } };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error('PROJECTION_BUDGET');
  return result;
};

async function read({ identityScope, modelId } = {}) {
  if (modelId !== undefined && (!modelIdValid(modelId) || modelId === DEFAULT_SEMANTIC_MODEL_ID)) return rejected('AGENT_MODEL_REQUEST_INVALID', 400);
  try {
    const identity = structuredClone(identityScope);
    if (!text(identity?.tenantId, 120) || !text(identity.subjectId, 128)) return rejected('AGENT_MODEL_FORBIDDEN');
    return await runWithSemanticTenant(identity, async () => {
      const initial = await authority(identity); if (!initial) return rejected('AGENT_MODEL_FORBIDDEN');
      const registry = await readRegistry(); if (!registryValid(registry)) return rejected('AGENT_MODEL_STATE_INVALID', 409);
      const models = registry.models.filter(model => model.lifecycle === 'registered' && (modelId === undefined || model.id === modelId));
      const proofs = []; const output = [];
      for (const model of models) {
        const grant = grantProof(identity, model.id, initial.roles); if (!grant) continue;
        const snapshot = await readPublication(identity, model.id);
        const definition = project(snapshot, model, identity); if (!definition) continue;
        proofs.push({ model, grant, snapshot }); output.push(definition);
      }
      // Re-read the selected records and registry. No partial success after a
      // concurrent change; the fresh IAM snapshot follows all repository waits.
      for (const proof of proofs) if (JSON.stringify(await readPublication(identity, proof.model.id)) !== JSON.stringify(proof.snapshot)) return rejected('AGENT_MODEL_STATE_CHANGED', 409);
      if (JSON.stringify(await readRegistry()) !== JSON.stringify(registry)) return rejected('AGENT_MODEL_STATE_CHANGED', 409);
      const final = await authority(identity);
      if (!final || final.stamp !== initial.stamp || proofs.some(proof => grantProof(identity, proof.model.id, final.roles) !== proof.grant)) return rejected('AGENT_MODEL_AUTHORITY_CHANGED', 409);
      if (modelId !== undefined) return output[0] ? { contentScope: 'published_schema_only', model: output[0] } : rejected('AGENT_MODEL_NOT_FOUND', 404);
      return { contentScope: 'published_model_catalog_only', runtimeReadEnabled: false, chatSelectionEnabled: false,
        models: output.map(({ graph: _graph, ...summary }) => summary) };
    });
  } catch { return rejected('AGENT_MODEL_UNAVAILABLE', 409); }
}

// This reader admits actual business principals via fresh IAM and explicit
// per-model metadata grants; it never impersonates the registry's executive.
export const agentPublishedModels = { list: options => read(options), definition: options => read(options), ...createModelConversationOperations(options => read(options)) };

import { getRuntimeStoreInfo, mutateState, mutateStates, readState } from '../repositories/runtime-state-repository.js';
import { appendDomainEventToWorkspace, DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace, mutateWithDomainEvent } from '../infrastructure/domain-events/domain-event-outbox.js';
import { semanticTenantStateKey, semanticModelStateKey, currentSemanticModel, DEFAULT_SEMANTIC_MODEL_ID } from './semantic-tenant-context.js';

let postgresRepository = null;
const tenantWorkspaceNamespaces = new Set(['oa_meta_model_runtime', 'ontology_publication', 'semantic_model_registry']);
const modelWorkspaceNamespaces = new Set(['oa_meta_model_runtime', 'ontology_publication', 'ontology_case_replay', 'semantic_material_artifacts', 'semantic_model_system_materials', 'mock_onboarding_v1',
  'semantic_operations_agent_tasks', 'semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots',
  'semantic_operations_notifications', 'semantic_inspection_schedules', 'semantic_synthetic_transfers', 'semantic_synthetic_relationships', 'semantic_preview_requests']);
const scopedKey = (namespace, key) => {
  const tenantKey = tenantWorkspaceNamespaces.has(namespace) ? semanticTenantStateKey(key) : key;
  return modelWorkspaceNamespaces.has(namespace) ? semanticModelStateKey(tenantKey) : tenantKey;
};
const scopedEntry = entry => ({ ...entry, key: scopedKey(entry.namespace, entry.key) });

export function configureSemanticGovernanceRepository(repository = null) {
  if (repository && typeof repository.mutateState !== 'function') throw new TypeError('Semantic governance repository does not implement the asynchronous runtime-state port.');
  postgresRepository = repository;
}

export const getSemanticGovernanceStoreInfo = () => postgresRepository?.getInfo?.() || getRuntimeStoreInfo();
export const probeSemanticGovernanceStore = () => postgresRepository ? postgresRepository.probe() : Promise.resolve({ ready: true });
export const readSemanticGovernanceState = (namespace, key, initialValue) => postgresRepository ? postgresRepository.readState(namespace, scopedKey(namespace, key), initialValue) : readState(namespace, scopedKey(namespace, key), initialValue);
export const mutateSemanticGovernanceState = (namespace, key, initialValue, callback) => postgresRepository ? postgresRepository.mutateState(namespace, scopedKey(namespace, key), initialValue, callback) : mutateState(namespace, scopedKey(namespace, key), initialValue, callback);
export const mutateSemanticGovernanceStates = (entries, callback) => postgresRepository ? postgresRepository.mutateStates(entries.map(scopedEntry), callback) : mutateStates(entries.map(scopedEntry), callback);

export function mutateSemanticGovernanceWithEvent({ namespace, key, initialValue, mutation }) {
  key = scopedKey(namespace, key);
  const modelId = currentSemanticModel();
  const scopedMutation = (value, version) => {
    const outcome = mutation(value, version);
    if (!outcome?.event || modelId === DEFAULT_SEMANTIC_MODEL_ID || !modelWorkspaceNamespaces.has(namespace)) return outcome;
    const stamp = event => ({ ...event, payload: { ...event.payload, modelId } });
    const event = outcome.event;
    return { ...outcome, event: typeof event === 'function' ? (...args) => stamp(event(...args)) : stamp(event) };
  };
  if (!postgresRepository) return mutateWithDomainEvent({ namespace, key, initialValue, mutation: scopedMutation });
  return postgresRepository.mutateStates([
    { name: 'aggregate', namespace, key, initialValue },
    { name: 'outbox', namespace: DOMAIN_EVENT_NAMESPACE, key: DOMAIN_EVENT_WORKSPACE_KEY, initialValue: initialDomainEventWorkspace }
  ], ({ aggregate, outbox }, versions) => {
    const outcome = scopedMutation(aggregate, versions.aggregate) || {};
    if (outcome.commit === false) return { commit: false, result: outcome.result };
    const next = Object.hasOwn(outcome, 'value') ? outcome.value : aggregate;
    if (!outcome.event) throw new Error('Semantic governance mutations must provide an outbox event.');
    appendDomainEventToWorkspace(outbox, typeof outcome.event === 'function' ? outcome.event(outcome.result, next) : outcome.event);
    return { values: { aggregate: next, outbox }, result: outcome.result };
  });
}

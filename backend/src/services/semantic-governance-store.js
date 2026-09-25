import { getRuntimeStoreInfo, mutateState, mutateStates, readState } from '../repositories/runtime-state-repository.js';
import { appendDomainEventToWorkspace, DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace, mutateWithDomainEvent } from '../infrastructure/domain-events/domain-event-outbox.js';
import { semanticTenantStateKey } from './semantic-tenant-context.js';

let postgresRepository = null;
const tenantWorkspaceNamespaces = new Set(['oa_meta_model_runtime', 'ontology_publication']);
const scopedKey = (namespace, key) => tenantWorkspaceNamespaces.has(namespace) ? semanticTenantStateKey(key) : key;
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
  if (!postgresRepository) return mutateWithDomainEvent({ namespace, key, initialValue, mutation });
  return postgresRepository.mutateStates([
    { name: 'aggregate', namespace, key, initialValue },
    { name: 'outbox', namespace: DOMAIN_EVENT_NAMESPACE, key: DOMAIN_EVENT_WORKSPACE_KEY, initialValue: initialDomainEventWorkspace }
  ], ({ aggregate, outbox }, versions) => {
    const outcome = mutation(aggregate, versions.aggregate) || {};
    if (outcome.commit === false) return { commit: false, result: outcome.result };
    const next = Object.hasOwn(outcome, 'value') ? outcome.value : aggregate;
    if (!outcome.event) throw new Error('Semantic governance mutations must provide an outbox event.');
    appendDomainEventToWorkspace(outbox, typeof outcome.event === 'function' ? outcome.event(outcome.result, next) : outcome.event);
    return { values: { aggregate: next, outbox }, result: outcome.result };
  });
}

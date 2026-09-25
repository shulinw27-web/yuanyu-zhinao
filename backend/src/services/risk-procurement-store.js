import { getRuntimeStoreInfo, readState } from '../repositories/runtime-state-repository.js';
import { mutateWithDomainEvent, DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, appendDomainEventToWorkspace, initialDomainEventWorkspace } from '../infrastructure/domain-events/domain-event-outbox.js';

let postgresRepository = null;

export function configureRiskProcurementRepository(repository) {
  postgresRepository = repository;
}

export const getRiskProcurementStoreInfo = () => postgresRepository?.getInfo?.() || getRuntimeStoreInfo();
export const probeRiskProcurementStore = async () => postgresRepository?.probe ? postgresRepository.probe() : { ready: true };

export const readRiskProcurementState = async (namespace, key, initialValue) => postgresRepository
  ? postgresRepository.readState(namespace, key, initialValue)
  : readState(namespace, key, initialValue);

export async function mutateRiskProcurementWithEvent({ namespace, key, initialValue, mutation }) {
  if (!postgresRepository) return mutateWithDomainEvent({ namespace, key, initialValue, mutation });
  return postgresRepository.mutateStates([
    { name: 'aggregate', namespace, key, initialValue },
    { name: 'outbox', namespace: DOMAIN_EVENT_NAMESPACE, key: DOMAIN_EVENT_WORKSPACE_KEY, initialValue: initialDomainEventWorkspace }
  ], ({ aggregate, outbox }, versions) => {
    const outcome = mutation(aggregate, versions.aggregate) || {};
    if (outcome.commit === false) return { commit: false, result: outcome.result };
    const nextAggregate = Object.hasOwn(outcome, 'value') ? outcome.value : aggregate;
    if (!outcome.event) throw new Error('Risk and procurement mutations must provide an outbox event.');
    const event = typeof outcome.event === 'function' ? outcome.event(outcome.result, nextAggregate) : outcome.event;
    appendDomainEventToWorkspace(outbox, event);
    return { values: { aggregate: nextAggregate, outbox }, result: outcome.result };
  });
}

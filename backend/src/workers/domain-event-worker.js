import { acknowledgeDomainEvent, claimDomainEvents, failDomainEvent } from '../infrastructure/domain-events/domain-event-outbox.js';
import { listState, mutateState, readState } from '../repositories/runtime-state-repository.js';

const NAMESPACE = 'domain_event_consumers';
const initialCheckpoint = () => ({ schemaVersion: 1, processed: {}, projections: { total: 0, byType: {}, latest: [] } });
const clone = (value) => structuredClone(value);
let consumerRepository = null;

export function configureDomainEventConsumerRepository(repository) {
  consumerRepository = repository;
}

export function getDomainEventConsumerCheckpoint(consumerId) {
  return clone(readState(NAMESPACE, consumerId, initialCheckpoint));
}

export async function listDomainEventConsumerMetrics() {
  const rows = consumerRepository ? await consumerRepository.listState(NAMESPACE) : listState(NAMESPACE);
  return rows.map((row) => ({
    consumerId: row.key,
    processed: Object.keys(row.value.processed || {}).length,
    projectionTotal: Number(row.value.projections?.total || 0),
    byType: clone(row.value.projections?.byType || {}),
    latestProcessedAt: row.value.projections?.latest?.[0]?.occurredAt || null,
    updatedAt: row.updatedAt
  }));
}

const hasProcessed = (consumerId, eventId) => Boolean(getDomainEventConsumerCheckpoint(consumerId).processed[eventId]);

const recordProcessed = (consumerId, event) => mutateState(NAMESPACE, consumerId, initialCheckpoint, (checkpoint) => {
  if (checkpoint.processed[event.eventId]) return { commit: false, result: clone(checkpoint) };
  checkpoint.processed[event.eventId] = { type: event.type, version: event.version, processedAt: new Date().toISOString() };
  checkpoint.projections.total += 1;
  checkpoint.projections.byType[event.type] = (checkpoint.projections.byType[event.type] || 0) + 1;
  checkpoint.projections.latest.unshift({ eventId: event.eventId, type: event.type, aggregateId: event.aggregateId, occurredAt: event.occurredAt });
  checkpoint.projections.latest = checkpoint.projections.latest.slice(0, 100);
  return { value: checkpoint, result: clone(checkpoint) };
});

const defaultHandler = async () => {};

export async function processDomainEventBatch({
  consumerId = 'internal-projection-worker',
  tenantId,
  limit = 20,
  handlers = {},
  broker,
  eventStore = null
} = {}) {
  const claimed = eventStore ? await eventStore.claim({ consumerId, tenantId, limit, leaseSeconds: 30 }) : claimDomainEvents({ consumerId, tenantId, limit, leaseSeconds: 30 });
  const summary = { consumerId, claimed: claimed.length, published: 0, skipped: 0, failed: 0, errors: [] };
  for (const event of claimed) {
    try {
      const alreadyProcessed = eventStore ? await eventStore.hasProcessed(consumerId, event.eventId) : hasProcessed(consumerId, event.eventId);
      if (alreadyProcessed) {
        if (eventStore) await eventStore.acknowledge(event.eventId, consumerId); else acknowledgeDomainEvent(event.eventId, consumerId);
        summary.skipped += 1;
        continue;
      }
      const handler = handlers[event.type] || handlers['*'] || (broker ? (item) => broker.publish(item) : defaultHandler);
      await handler(clone(event));
      if (eventStore) await eventStore.recordProcessed(consumerId, event); else recordProcessed(consumerId, event);
      const acknowledgment = eventStore ? await eventStore.acknowledge(event.eventId, consumerId) : acknowledgeDomainEvent(event.eventId, consumerId);
      if (acknowledgment.error) throw new Error(acknowledgment.code || 'DOMAIN_EVENT_ACK_FAILED');
      summary.published += 1;
    } catch (error) {
      const errorCode = String(error?.code || error?.message || 'DOMAIN_EVENT_HANDLER_FAILED').slice(0, 160);
      if (eventStore) await eventStore.fail(event.eventId, consumerId, errorCode); else failDomainEvent(event.eventId, consumerId, errorCode);
      summary.failed += 1;
      summary.errors.push({ eventId: event.eventId, code: errorCode });
    }
  }
  return summary;
}

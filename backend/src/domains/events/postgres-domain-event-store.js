import { DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace } from './domain-event-outbox.js';

const CONSUMER_NAMESPACE = 'domain_event_consumers';
const MAX_ATTEMPTS = 5;
const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const initialCheckpoint = () => ({ schemaVersion: 1, processed: {}, projections: { total: 0, byType: {}, latest: [] } });

export class PostgresDomainEventStore {
  constructor(repository) {
    if (!repository || typeof repository.mutateState !== 'function') throw new TypeError('PostgreSQL domain event store requires an asynchronous runtime repository.');
    this.repository = repository;
  }

  async claim({ consumerId, limit = 20, leaseSeconds = 30, tenantId } = {}) {
    if (!consumerId) throw new Error('consumerId is required.');
    return this.repository.mutateState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace, (workspace) => {
      const timestamp = Date.now(); const claimed = [];
      for (const event of workspace.events) {
        const expiredClaim = event.status === 'processing' && Date.parse(event.claimExpiresAt || '') <= timestamp;
        const ready = (event.status === 'pending' || expiredClaim) && Date.parse(event.availableAt) <= timestamp;
        if (!ready || (tenantId && event.tenantId !== tenantId) || claimed.length >= Math.min(Math.max(Number(limit) || 20, 1), 100)) continue;
        event.status = 'processing'; event.claimedBy = String(consumerId).slice(0, 160); event.claimExpiresAt = new Date(timestamp + Math.min(Math.max(Number(leaseSeconds) || 30, 5), 300) * 1000).toISOString(); event.updatedAt = now(); claimed.push(clone(event));
      }
      return { value: workspace, result: claimed };
    });
  }

  async acknowledge(eventId, consumerId) {
    return this.repository.mutateState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace, (workspace) => {
      const event = workspace.events.find((item) => item.eventId === eventId);
      if (!event || event.status !== 'processing' || event.claimedBy !== consumerId) return { commit: false, result: { error: '事件不存在或不属于当前消费者。', code: 'DOMAIN_EVENT_CLAIM_MISMATCH' } };
      event.status = 'published'; event.publishedAt = now(); event.updatedAt = event.publishedAt; event.claimedBy = null; event.claimExpiresAt = null;
      return { value: workspace, result: clone(event) };
    });
  }

  async fail(eventId, consumerId, errorCode = 'DELIVERY_FAILED', options = {}) {
    return this.repository.mutateState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace, (workspace) => {
      const event = workspace.events.find((item) => item.eventId === eventId);
      if (!event || event.status !== 'processing' || event.claimedBy !== consumerId) return { commit: false, result: { error: '事件不存在或不属于当前消费者。', code: 'DOMAIN_EVENT_CLAIM_MISMATCH' } };
      event.attempts += 1; const maxAttempts = Math.min(Math.max(Number(options.maxAttempts) || MAX_ATTEMPTS, 1), MAX_ATTEMPTS);
      event.status = event.attempts >= maxAttempts ? 'dead_letter' : 'pending'; event.availableAt = new Date(Date.now() + Math.min(2 ** event.attempts, 60) * 1000).toISOString(); event.lastError = String(errorCode || 'DELIVERY_FAILED').slice(0, 160); event.updatedAt = now(); event.claimedBy = null; event.claimExpiresAt = null;
      return { value: workspace, result: clone(event) };
    });
  }

  async hasProcessed(consumerId, eventId) {
    const checkpoint = await this.repository.readState(CONSUMER_NAMESPACE, consumerId, initialCheckpoint);
    return Boolean(checkpoint.processed[eventId]);
  }

  async recordProcessed(consumerId, event) {
    return this.repository.mutateState(CONSUMER_NAMESPACE, consumerId, initialCheckpoint, (checkpoint) => {
      if (checkpoint.processed[event.eventId]) return { commit: false, result: clone(checkpoint) };
      checkpoint.processed[event.eventId] = { type: event.type, version: event.version, processedAt: now() };
      checkpoint.projections.total += 1; checkpoint.projections.byType[event.type] = (checkpoint.projections.byType[event.type] || 0) + 1;
      checkpoint.projections.latest.unshift({ eventId: event.eventId, type: event.type, aggregateId: event.aggregateId, occurredAt: event.occurredAt }); checkpoint.projections.latest = checkpoint.projections.latest.slice(0, 100);
      return { value: checkpoint, result: clone(checkpoint) };
    });
  }
}

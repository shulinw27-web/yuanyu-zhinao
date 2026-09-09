import { randomUUID } from 'node:crypto';
import { mutateState, mutateStates, readState } from '../../repositories/runtime-state-repository.js';
import { validateDomainEventContract } from './domain-event-contracts.js';

export const DOMAIN_EVENT_NAMESPACE = 'domain_event_outbox';
export const DOMAIN_EVENT_WORKSPACE_KEY = 'events';
const MAX_EVENTS = 5000;
const MAX_ATTEMPTS = 5;
const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
export const initialDomainEventWorkspace = () => ({ schemaVersion: 1, events: [] });
let managementRepository = null;

export function configureDomainEventRepository(repository) {
  managementRepository = repository;
}

export const getDomainEventStoreInfo = () => managementRepository?.getInfo?.() || { driver: 'runtime', persistence: 'runtime_managed' };
export const probeDomainEventStore = async () => managementRepository?.probe ? managementRepository.probe() : { ready: true };

const normalizeEvent = (event = {}) => {
  if (!event.type || !event.aggregateType || !event.aggregateId) {
    throw new Error('Domain events require type, aggregateType, and aggregateId.');
  }
  const occurredAt = event.occurredAt || now();
  const normalized = {
    eventId: event.eventId || randomUUID(),
    type: String(event.type).slice(0, 160),
    version: Math.max(1, Number(event.version) || 1),
    tenantId: String(event.tenantId || 'demo-enterprise').slice(0, 120),
    organizationId: event.organizationId ? String(event.organizationId).slice(0, 120) : null,
    aggregateType: String(event.aggregateType).slice(0, 120),
    aggregateId: String(event.aggregateId).slice(0, 180),
    correlationId: event.correlationId ? String(event.correlationId).slice(0, 180) : null,
    causationId: event.causationId ? String(event.causationId).slice(0, 180) : null,
    actor: clone(event.actor || { type: 'system', id: 'unknown' }),
    payload: clone(event.payload || {}),
    status: 'pending',
    attempts: 0,
    availableAt: event.availableAt || occurredAt,
    occurredAt,
    createdAt: now(),
    updatedAt: now(),
    claimedBy: null,
    claimExpiresAt: null,
    publishedAt: null,
    lastError: null
  };
  validateDomainEventContract(normalized);
  return normalized;
};

const appendEvent = (workspace, event) => {
  const normalized = normalizeEvent(event);
  if (workspace.events.some((item) => item.eventId === normalized.eventId)) return workspace.events.find((item) => item.eventId === normalized.eventId);
  workspace.events.unshift(normalized);
  workspace.events = workspace.events.slice(0, MAX_EVENTS);
  return normalized;
};

export const appendDomainEventToWorkspace = (workspace, event) => appendEvent(workspace, event);

export function publishDomainEvent(event) {
  return mutateState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace, (workspace) => {
    const created = appendEvent(workspace, event);
    return { value: workspace, result: clone(created) };
  });
}

export function mutateWithDomainEvent({ namespace, key, initialValue, mutation }) {
  return mutateStates([
    { name: 'aggregate', namespace, key, initialValue },
    { name: 'outbox', namespace: DOMAIN_EVENT_NAMESPACE, key: DOMAIN_EVENT_WORKSPACE_KEY, initialValue: initialDomainEventWorkspace }
  ], ({ aggregate, outbox }, versions) => {
    const outcome = mutation(aggregate, versions.aggregate) || {};
    if (outcome.commit === false) return { commit: false, result: outcome.result };
    const nextAggregate = Object.hasOwn(outcome, 'value') ? outcome.value : aggregate;
    if (!outcome.event) throw new Error('Atomic domain mutations must provide an outbox event.');
    const event = typeof outcome.event === 'function' ? outcome.event(outcome.result, nextAggregate) : outcome.event;
    appendEvent(outbox, event);
    return { values: { aggregate: nextAggregate, outbox }, result: outcome.result };
  });
}

export async function listDomainEvents({ tenantId, status, limit = 100 } = {}) {
  const workspace = managementRepository
    ? await managementRepository.readState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace)
    : readState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace);
  return clone(workspace.events
    .filter((event) => !tenantId || event.tenantId === tenantId)
    .filter((event) => !status || event.status === status)
    .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500)));
}

export function claimDomainEvents({ consumerId, limit = 20, leaseSeconds = 30, tenantId } = {}) {
  if (!consumerId) throw new Error('consumerId is required.');
  return mutateState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace, (workspace) => {
    const timestamp = Date.now();
    const claimed = [];
    for (const event of workspace.events) {
      const expiredClaim = event.status === 'processing' && new Date(event.claimExpiresAt || 0).getTime() <= timestamp;
      const ready = (event.status === 'pending' || expiredClaim) && new Date(event.availableAt).getTime() <= timestamp;
      if (!ready || (tenantId && event.tenantId !== tenantId) || claimed.length >= Math.min(Math.max(Number(limit) || 20, 1), 100)) continue;
      event.status = 'processing';
      event.claimedBy = String(consumerId).slice(0, 160);
      event.claimExpiresAt = new Date(timestamp + Math.min(Math.max(Number(leaseSeconds) || 30, 5), 300) * 1000).toISOString();
      event.updatedAt = now();
      claimed.push(clone(event));
    }
    return { value: workspace, result: claimed };
  });
}

export function acknowledgeDomainEvent(eventId, consumerId) {
  return mutateState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace, (workspace) => {
    const event = workspace.events.find((item) => item.eventId === eventId);
    if (!event || event.status !== 'processing' || event.claimedBy !== consumerId) {
      return { commit: false, result: { error: '事件不存在或不属于当前消费者。', code: 'DOMAIN_EVENT_CLAIM_MISMATCH' } };
    }
    event.status = 'published';
    event.publishedAt = now();
    event.updatedAt = event.publishedAt;
    event.claimedBy = null;
    event.claimExpiresAt = null;
    return { value: workspace, result: clone(event) };
  });
}

export function failDomainEvent(eventId, consumerId, errorCode = 'DELIVERY_FAILED', options = {}) {
  return mutateState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace, (workspace) => {
    const event = workspace.events.find((item) => item.eventId === eventId);
    if (!event || event.status !== 'processing' || event.claimedBy !== consumerId) {
      return { commit: false, result: { error: '事件不存在或不属于当前消费者。', code: 'DOMAIN_EVENT_CLAIM_MISMATCH' } };
    }
    event.attempts += 1;
    const maxAttempts = Math.min(Math.max(Number(options.maxAttempts) || MAX_ATTEMPTS, 1), MAX_ATTEMPTS);
    event.status = event.attempts >= maxAttempts ? 'dead_letter' : 'pending';
    event.availableAt = new Date(Date.now() + Math.min(2 ** event.attempts, 60) * 1000).toISOString();
    event.lastError = String(errorCode || 'DELIVERY_FAILED').slice(0, 160);
    event.updatedAt = now();
    event.claimedBy = null;
    event.claimExpiresAt = null;
    return { value: workspace, result: clone(event) };
  });
}

export async function getDomainEventOutboxMetrics({ tenantId } = {}) {
  const events = await listDomainEvents({ tenantId, limit: MAX_EVENTS });
  const byStatus = events.reduce((counts, event) => ({ ...counts, [event.status]: (counts[event.status] || 0) + 1 }), {});
  const pending = events.filter((event) => event.status === 'pending');
  return {
    total: events.length,
    pending: byStatus.pending || 0,
    processing: byStatus.processing || 0,
    published: byStatus.published || 0,
    deadLetter: byStatus.dead_letter || 0,
    oldestPendingAt: pending.length ? pending.reduce((oldest, event) => event.createdAt < oldest ? event.createdAt : oldest, pending[0].createdAt) : null
  };
}

export async function replayDeadLetterEvent(eventId, { tenantId, actor, reason } = {}) {
  const mutation = (workspace) => {
    const event = workspace.events.find((item) => item.eventId === eventId);
    if (!event || (tenantId && event.tenantId !== tenantId)) {
      return { commit: false, result: { error: '未找到可重放的死信事件。', code: 'DOMAIN_EVENT_NOT_FOUND' } };
    }
    if (event.status !== 'dead_letter') {
      return { commit: false, result: { error: '只有死信事件可以重放。', code: 'DOMAIN_EVENT_NOT_DEAD_LETTER' } };
    }
    event.status = 'pending';
    event.attempts = 0;
    event.availableAt = now();
    event.updatedAt = event.availableAt;
    event.claimedBy = null;
    event.claimExpiresAt = null;
    event.lastError = null;
    event.replayCount = Number(event.replayCount || 0) + 1;
    event.lastReplay = {
      actor: clone(actor || { type: 'system', id: 'unknown' }),
      reason: String(reason || 'manual_replay').slice(0, 300),
      replayedAt: event.updatedAt
    };
    return { value: workspace, result: clone(event) };
  };
  return managementRepository
    ? managementRepository.mutateState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace, mutation)
    : mutateState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace, mutation);
}

import { createHash, randomUUID } from 'node:crypto';
import {
  initialAlertingDeliveries,
  initialClassificationRules,
  initialContactPoints,
  initialEscalationPolicies,
  initialOnCallSchedules,
  initialSeverityLevels,
  initialVoiceCalls,
  initialVoiceProviders,
  initialVoiceTemplates
} from '../../data/alerting-seed.js';
import { getRuntimeStoreInfo, mutateState, readState } from '../../repositories/runtime-state-repository.js';
import { appendDomainEventToWorkspace, DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace, mutateWithDomainEvent } from '../../infrastructure/domain-events/domain-event-outbox.js';
import { currentIAMTenant } from '../../services/iam-store.js';

const NAMESPACE = 'alerting';
const WORKSPACE_KEY = 'workspace';
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let postgresRepository = null;

export function configureAlertingRepository(repository) {
  postgresRepository = repository;
}

export const getAlertingStoreInfo = () => postgresRepository?.getInfo?.() || getRuntimeStoreInfo();
export const probeAlertingStore = async () => postgresRepository?.probe ? postgresRepository.probe() : { ready: true };

export function appendAlertingAuditToState(state, event) {
  const createdAt = event.createdAt || new Date().toISOString();
  const payload = {
    id: event.id || `alert-audit-${randomUUID()}`,
    sequence: state.auditEvents.length + 1,
    type: event.type || 'recorded',
    status: event.status || 'completed',
    actor: clone(event.actor || { type: 'service', id: 'alerting-orchestrator' }),
    summary: String(event.summary || '告警编排事件').slice(0, 600),
    riskId: event.riskId || null,
    organizationId: event.organizationId || null,
    notificationId: event.notificationId || null,
    callId: event.callId || null,
    details: clone(event.details || {}),
    createdAt,
    previousHash: state.auditHeadHash || null
  };
  const stored = { ...payload, hash: hash(payload) };
  state.auditEvents.push(stored);
  state.auditHeadHash = stored.hash;
  if (state.auditEvents.length > 1000) state.auditEvents = state.auditEvents.slice(-1000);
  return stored;
}

export const alertingWorkspaceKey = (tenantId = currentIAMTenant()) => tenantId === 'demo-enterprise'
  ? WORKSPACE_KEY
  : JSON.stringify(['alerting-tenant-v1', tenantId, WORKSPACE_KEY]);

const initialWorkspace = () => {
  const demo = currentIAMTenant() === 'demo-enterprise';
  const state = {
    configurationVersion: 1,
    severityLevels: clone(initialSeverityLevels),
    classificationRules: clone(initialClassificationRules),
    escalationPolicies: clone(initialEscalationPolicies),
    onCallSchedules: demo ? clone(initialOnCallSchedules) : [],
    contactPoints: demo ? clone(initialContactPoints) : [],
    voiceProviders: clone(initialVoiceProviders),
    voiceTemplates: clone(initialVoiceTemplates),
    deliveries: demo ? clone(initialAlertingDeliveries) : [],
    voiceCalls: demo ? clone(initialVoiceCalls) : [],
    simulatedAlerts: [],
    outbox: [],
    auditEvents: [],
    auditHeadHash: null
  };
  if (demo) appendAlertingAuditToState(state, {
    id: 'alert-audit-seed-1', type: 'severity_classified', status: 'completed', riskId: 'RC-2026-0042', organizationId: 'org-quality-dept',
    summary: '风险 RC-2026-0042 按质量放行规则划分为 P0。', createdAt: '2026-07-30T01:42:06.000Z',
    details: { severity: 'P0', ruleId: 'quality-release-blocked', policyVersion: 1 }
  });
  if (demo) appendAlertingAuditToState(state, {
    id: 'alert-audit-seed-2', type: 'voice_call_started', status: 'answered', riskId: 'RC-2026-0042', organizationId: 'org-quality-dept',
    notificationId: 'NT-VOICE-9005', callId: 'CALL-2026-0001', summary: 'Mock 虚拟电话已拨打质量责任人并完成语音播放。',
    createdAt: '2026-07-30T01:43:28.000Z', details: { providerId: 'mock', receiverUserId: 'usr-003', target: '139****0003' }
  });
  return state;
};

export const getAlertingState = async () => clone(postgresRepository
  ? await postgresRepository.readState(NAMESPACE, alertingWorkspaceKey(), initialWorkspace)
  : readState(NAMESPACE, alertingWorkspaceKey(), initialWorkspace));

export async function mutateAlertingState(callback, domainEvent) {
  const key = alertingWorkspaceKey();
  if (postgresRepository) {
    if (!domainEvent) return postgresRepository.mutateState(NAMESPACE, key, initialWorkspace, (state, version) => callback(state, version));
    return postgresRepository.mutateStates([
      { name: 'aggregate', namespace: NAMESPACE, key, initialValue: initialWorkspace },
      { name: 'outbox', namespace: DOMAIN_EVENT_NAMESPACE, key: DOMAIN_EVENT_WORKSPACE_KEY, initialValue: initialDomainEventWorkspace }
    ], ({ aggregate, outbox }, versions) => {
      const outcome = callback(aggregate, versions.aggregate) || {};
      if (outcome.commit === false) return { commit: false, result: outcome.result };
      const nextState = Object.hasOwn(outcome, 'value') ? outcome.value : aggregate;
      const event = typeof domainEvent === 'function' ? domainEvent(outcome.result, nextState) : domainEvent;
      appendDomainEventToWorkspace(outbox, event);
      return { values: { aggregate: nextState, outbox }, result: outcome.result };
    });
  }
  if (!domainEvent) return mutateState(NAMESPACE, key, initialWorkspace, (state, version) => callback(state, version));
  return mutateWithDomainEvent({
    namespace: NAMESPACE,
    key,
    initialValue: initialWorkspace,
    mutation: (state, version) => {
      const outcome = callback(state, version) || {};
      if (outcome.commit === false) return outcome;
      const nextState = Object.hasOwn(outcome, 'value') ? outcome.value : state;
      return {
        ...outcome,
        value: nextState,
        event: typeof domainEvent === 'function'
          ? domainEvent(outcome.result, nextState)
          : domainEvent
      };
    }
  });
}

export function verifyAlertingAudit(events, expectedHeadHash) {
  const anchorHash = events[0]?.previousHash || null;
  let previousHash = anchorHash;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const { hash: storedHash, ...payload } = event;
    if (event.previousHash !== previousHash || hash(payload) !== storedHash) {
      return { valid: false, checkedEvents: index, failedEventId: event.id, reason: 'HASH_CHAIN_MISMATCH' };
    }
    previousHash = storedHash;
  }
  return previousHash === expectedHeadHash
    ? { valid: true, checkedEvents: events.length, algorithm: 'SHA-256', anchorHash, headHash: previousHash }
    : { valid: false, checkedEvents: events.length, reason: 'HEAD_HASH_MISMATCH' };
}

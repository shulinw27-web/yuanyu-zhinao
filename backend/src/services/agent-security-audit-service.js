import { createHash, randomUUID } from 'node:crypto';
import { enqueueSiemSecurityEvent } from './siem-event-export-service.js';

const MAX_EVENTS = 100;
const events = [];
const hash = (value) => createHash('sha256').update(String(value || 'anonymous')).digest('hex').slice(0, 20);

export function recordAgentSecurityEvent({ roleId, identityScope = {}, stage, assessment }) {
  const event = {
    id: `agent-security-${randomUUID()}`,
    tenantId: String(identityScope.tenantId || 'demo-enterprise').slice(0, 120),
    subjectFingerprint: hash(identityScope.subjectId || `role:${roleId}`),
    roleId,
    stage: String(stage || 'unknown').slice(0, 80),
    riskLevel: assessment?.riskLevel || 'high',
    signals: Array.isArray(assessment?.signals) ? assessment.signals.slice(0, 12) : [],
    contentFingerprint: assessment?.fingerprint || null,
    source: assessment?.source || 'unknown',
    createdAt: new Date().toISOString()
  };
  events.unshift(event);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  enqueueSiemSecurityEvent(event);
  return structuredClone(event);
}

export function getAgentSecurityAuditMetrics(roleId, identityScope = {}) {
  const tenantId = String(identityScope.tenantId || 'demo-enterprise');
  const subjectFingerprint = hash(identityScope.subjectId || `role:${roleId}`);
  const scoped = events.filter((event) => event.roleId === roleId && event.tenantId === tenantId && event.subjectFingerprint === subjectFingerprint);
  return {
    rejectedRequests: scoped.length,
    lastRejectedAt: scoped[0]?.createdAt || null,
    recentSignals: [...new Set(scoped.flatMap((event) => event.signals))].slice(0, 12)
  };
}

export function getAgentSecurityEventsForTest() {
  return structuredClone(events);
}

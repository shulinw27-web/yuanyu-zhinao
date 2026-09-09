import { createHash, randomUUID } from 'node:crypto';
import { listState, mutateState, writeState } from '../repositories/runtime-state-repository.js';

const NAMESPACE = 'agent_security_siem_outbox';
const MAX_EVENTS = 2_000;
const iso = (value = Date.now()) => new Date(value).toISOString();
const fingerprint = (value) => createHash('sha256').update(String(value || 'unknown')).digest('hex').slice(0, 24);
const clone = (value) => structuredClone(value);

const toEnvelope = (event) => ({
  schemaVersion: '1.0',
  id: `siem-${randomUUID()}`,
  timestamp: event.createdAt || iso(),
  event: {
    kind: 'alert', category: ['intrusion_detection'], type: ['denied'], action: String(event.stage || 'unknown'), outcome: 'failure',
    severity: event.riskLevel === 'critical' ? 9 : event.riskLevel === 'high' ? 7 : 5,
    originalEventId: event.id
  },
  service: { name: 'yuanyu-zhinao-agent', component: 'prompt-security' },
  organization: { idFingerprint: fingerprint(event.tenantId) },
  user: { idFingerprint: event.subjectFingerprint || null, roles: event.roleId ? [String(event.roleId).slice(0, 120)] : [] },
  threat: {
    technique: Array.isArray(event.signals) ? event.signals.slice(0, 12).map((signal) => ({ id: String(signal).slice(0, 120) })) : [],
    source: String(event.source || 'unknown').slice(0, 80),
    contentFingerprint: event.contentFingerprint || null
  },
  dataHandling: { promptIncluded: false, attachmentIncluded: false, piiIncluded: false }
});

const publicEntry = (entry) => {
  if (!entry) return null;
  const { claimedBy: _claimedBy, ...safe } = entry;
  return clone(safe);
};

export function enqueueSiemSecurityEvent(securityEvent, nowAt = Date.now()) {
  const envelope = toEnvelope(securityEvent);
  const entry = { id: envelope.id, status: 'pending', attempts: 0, envelope, createdAt: iso(nowAt), updatedAt: iso(nowAt), nextAttemptAt: iso(nowAt), leaseExpiresAt: null, claimedBy: null, deliveredAt: null, exportId: null, lastError: null };
  writeState(NAMESPACE, entry.id, entry);
  const rows = listState(NAMESPACE).sort((left, right) => String(right.value.createdAt).localeCompare(String(left.value.createdAt)));
  rows.slice(MAX_EVENTS).forEach((row) => {
    if (row.value.status === 'delivered') mutateState(NAMESPACE, row.key, null, (value) => ({ value: { ...value, hidden: true } }));
  });
  return publicEntry(entry);
}

export function claimSiemExportBatch({ workerId, limit = 50, leaseMs = 60_000, nowAt = Date.now() }) {
  const id = String(workerId || '').trim().slice(0, 120);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/u.test(id)) throw new Error('SIEM worker id is invalid.');
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const claimed = [];
  for (const row of listState(NAMESPACE).sort((left, right) => String(left.value.createdAt).localeCompare(String(right.value.createdAt)))) {
    if (claimed.length >= boundedLimit) break;
    const result = mutateState(NAMESPACE, row.key, null, (entry) => {
      if (!entry || entry.hidden || entry.status === 'delivered') return { commit: false, result: null };
      const leaseActive = entry.status === 'exporting' && Date.parse(entry.leaseExpiresAt || '') > nowAt;
      if (leaseActive || Date.parse(entry.nextAttemptAt || '') > nowAt) return { commit: false, result: null };
      const next = { ...entry, status: 'exporting', attempts: Number(entry.attempts || 0) + 1, claimedBy: id, leaseExpiresAt: iso(nowAt + Math.min(Math.max(Number(leaseMs) || 60_000, 10_000), 300_000)), updatedAt: iso(nowAt) };
      return { value: next, result: publicEntry(next) };
    });
    if (result) claimed.push(result);
  }
  return claimed;
}

export function completeSiemExportBatch({ ids, workerId, exportId, nowAt = Date.now() }) {
  return (Array.isArray(ids) ? ids : []).map((id) => mutateState(NAMESPACE, id, null, (entry) => {
    if (!entry || entry.status !== 'exporting' || entry.claimedBy !== workerId) return { commit: false, result: null };
    const next = { ...entry, status: 'delivered', deliveredAt: iso(nowAt), updatedAt: iso(nowAt), leaseExpiresAt: null, claimedBy: null, exportId: String(exportId || '').slice(0, 160), lastError: null };
    return { value: next, result: publicEntry(next) };
  })).filter(Boolean);
}

export function failSiemExportBatch({ ids, workerId, error, nowAt = Date.now() }) {
  return (Array.isArray(ids) ? ids : []).map((id) => mutateState(NAMESPACE, id, null, (entry) => {
    if (!entry || entry.status !== 'exporting' || entry.claimedBy !== workerId) return { commit: false, result: null };
    const delayMs = Math.min(15 * 60_000, 5_000 * (2 ** Math.min(Number(entry.attempts || 1) - 1, 7)));
    const next = { ...entry, status: 'pending', updatedAt: iso(nowAt), nextAttemptAt: iso(nowAt + delayMs), leaseExpiresAt: null, claimedBy: null, lastError: String(error || 'SIEM export failed.').slice(0, 300) };
    return { value: next, result: publicEntry(next) };
  })).filter(Boolean);
}

export function getSiemOutboxMetrics(nowAt = Date.now()) {
  const entries = listState(NAMESPACE).map((row) => row.value).filter((entry) => !entry.hidden);
  const pending = entries.filter((entry) => entry.status === 'pending' || (entry.status === 'exporting' && Date.parse(entry.leaseExpiresAt || '') <= nowAt));
  return {
    total: entries.length,
    pending: pending.length,
    exporting: entries.filter((entry) => entry.status === 'exporting' && Date.parse(entry.leaseExpiresAt || '') > nowAt).length,
    delivered: entries.filter((entry) => entry.status === 'delivered').length,
    oldestPendingAgeMs: pending.length ? Math.max(0, nowAt - Math.min(...pending.map((entry) => Date.parse(entry.createdAt)).filter(Number.isFinite))) : 0,
    failedAttempts: entries.reduce((sum, entry) => sum + Math.max(0, Number(entry.attempts || 0) - (entry.status === 'delivered' ? 1 : 0)), 0)
  };
}

export function getSiemEntriesForTest() {
  return listState(NAMESPACE).map((row) => publicEntry(row.value));
}

export function listSiemEventEnvelopesForDetection({ limit = 500 } = {}) {
  return listState(NAMESPACE)
    .map((row) => row.value)
    .filter((entry) => !entry.hidden)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, Math.min(Math.max(Number(limit) || 500, 1), 2_000))
    .map((entry) => clone(entry.envelope));
}

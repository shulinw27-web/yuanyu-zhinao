import { createHash } from 'node:crypto';
import { getSiemOutboxMetrics, listSiemEventEnvelopesForDetection } from './siem-event-export-service.js';

const findingId = (ruleId, key) => `${ruleId}-${createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}`;

export function evaluateSecurityDetectionRules({ nowAt = Date.now(), windowMinutes = 15 } = {}) {
  const windowStart = nowAt - Math.min(Math.max(Number(windowMinutes) || 15, 1), 1_440) * 60_000;
  const events = listSiemEventEnvelopesForDetection({ limit: 2_000 }).filter((event) => Date.parse(event.timestamp || '') >= windowStart);
  const findings = [];
  const attackCounts = new Map();
  for (const event of events) {
    const key = `${event.organization?.idFingerprint || 'unknown'}:${event.user?.idFingerprint || 'unknown'}`;
    const techniques = (event.threat?.technique || []).map((item) => item.id);
    if (techniques.some((item) => /prompt|instruction|exfiltration|secret/i.test(item))) attackCounts.set(key, (attackCounts.get(key) || 0) + 1);
    if (Number(event.event?.severity || 0) >= 9) findings.push({ id: findingId('critical-security-event', event.id), ruleId: 'critical-security-event', severity: 'P0', status: 'open', summary: '检测到严重 Agent 安全事件。', eventId: event.id });
  }
  for (const [key, count] of attackCounts) if (count >= 3) findings.push({ id: findingId('repeated-prompt-attack', key), ruleId: 'repeated-prompt-attack', severity: 'P1', status: 'open', summary: `同一匿名主体在窗口内触发 ${count} 次提示词或凭据攻击拦截。`, subjectFingerprint: key.split(':')[1] });
  const outbox = getSiemOutboxMetrics(nowAt);
  if (outbox.pending >= 100 || outbox.oldestPendingAgeMs >= 15 * 60_000) findings.push({ id: findingId('siem-export-backlog', `${outbox.pending}:${Math.floor(outbox.oldestPendingAgeMs / 60_000)}`), ruleId: 'siem-export-backlog', severity: 'P1', status: 'open', summary: `SIEM 待导出 ${outbox.pending} 条，最老等待 ${Math.ceil(outbox.oldestPendingAgeMs / 60_000)} 分钟。` });
  return { evaluatedAt: new Date(nowAt).toISOString(), windowMinutes, eventCount: events.length, findingCount: findings.length, findings, rules: [
    { id: 'critical-security-event', threshold: 'severity >= 9' },
    { id: 'repeated-prompt-attack', threshold: 'same anonymized subject >= 3 / 15m' },
    { id: 'siem-export-backlog', threshold: 'pending >= 100 or oldest >= 15m' }
  ] };
}

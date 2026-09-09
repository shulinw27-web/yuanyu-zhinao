import test from 'node:test';
import assert from 'node:assert/strict';
import { recordAgentSecurityEvent } from '../src/services/agent-security-audit-service.js';
import { claimSiemExportBatch, completeSiemExportBatch, getSiemEntriesForTest, getSiemOutboxMetrics } from '../src/services/siem-event-export-service.js';
import { authorizeMetricsRequest, renderPrometheusMetrics } from '../src/observability/prometheus-metrics.js';

test('security rejection emits a privacy-minimized SIEM envelope and supports leased delivery', () => {
  const event = recordAgentSecurityEvent({
    roleId: 'quality_manager', identityScope: { tenantId: 'tenant-secret', subjectId: 'person@example.test' }, stage: 'user_input_preflight',
    assessment: { riskLevel: 'high', signals: ['prompt_injection'], fingerprint: 'content-hash', source: 'text', rawPrompt: 'must never be exported' }
  });
  const entry = getSiemEntriesForTest().find((item) => item.envelope.event.originalEventId === event.id);
  assert.ok(entry);
  const serialized = JSON.stringify(entry);
  assert.doesNotMatch(serialized, /tenant-secret|person@example\.test|must never be exported/);
  assert.equal(entry.envelope.dataHandling.promptIncluded, false);
  const claimed = claimSiemExportBatch({ workerId: 'siem-worker-test', limit: 200 });
  assert.ok(claimed.some((item) => item.id === entry.id));
  completeSiemExportBatch({ ids: [entry.id], workerId: 'siem-worker-test', exportId: 'export-1' });
  assert.equal(getSiemEntriesForTest().find((item) => item.id === entry.id).status, 'delivered');
});

test('Prometheus output has bounded labels and production metrics authorization fails closed', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousToken = process.env.OBSERVABILITY_METRICS_TOKEN;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.OBSERVABILITY_METRICS_TOKEN;
    assert.deepEqual(authorizeMetricsRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), { allowed: false, status: 503, reason: 'metrics_token_not_configured' });
    process.env.OBSERVABILITY_METRICS_TOKEN = 'a-secure-observability-token-32-bytes';
    assert.equal(authorizeMetricsRequest({ socket: { remoteAddress: '10.0.0.2' }, headers: { authorization: 'Bearer a-secure-observability-token-32-bytes' } }).allowed, true);
    const metrics = await renderPrometheusMetrics();
    assert.match(metrics, /zhinao_agent_long_task_queue_depth/);
    assert.match(metrics, /zhinao_siem_outbox_events\{status="pending"\}/);
    assert.doesNotMatch(metrics, /tenantId|subjectId|deviceId|runId/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousToken === undefined) delete process.env.OBSERVABILITY_METRICS_TOKEN; else process.env.OBSERVABILITY_METRICS_TOKEN = previousToken;
  }
  assert.ok(getSiemOutboxMetrics().total >= 1);
});

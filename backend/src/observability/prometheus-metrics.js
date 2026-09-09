import { timingSafeEqual } from 'node:crypto';
import { getAgentLongTaskQueueMetrics } from '../services/agent-long-task-store.js';
import { getSiemOutboxMetrics } from '../services/siem-event-export-service.js';

const line = (name, value, labels = null) => `${name}${labels ? `{${Object.entries(labels).map(([key, item]) => `${key}="${String(item).replace(/["\\\n]/gu, '_')}"`).join(',')}}` : ''} ${Number(value) || 0}`;
const loopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(address || ''));
const equalSecret = (left, right) => {
  const first = Buffer.from(String(left || ''));
  const second = Buffer.from(String(right || ''));
  return first.length === second.length && first.length > 0 && timingSafeEqual(first, second);
};

export function authorizeMetricsRequest(req) {
  const configuredToken = String(process.env.OBSERVABILITY_METRICS_TOKEN || '');
  if (!configuredToken) return process.env.NODE_ENV === 'production'
    ? { allowed: false, status: 503, reason: 'metrics_token_not_configured' }
    : { allowed: loopback(req.socket?.remoteAddress), status: 403, reason: 'loopback_only' };
  if (process.env.NODE_ENV === 'production' && configuredToken.length < 32) return { allowed: false, status: 503, reason: 'metrics_token_too_short' };
  const authorization = String(req.headers?.authorization || '');
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return { allowed: equalSecret(supplied, configuredToken), status: 401, reason: 'invalid_metrics_token' };
}

export async function renderPrometheusMetrics(nowAt = Date.now()) {
  const queue = await getAgentLongTaskQueueMetrics({ nowAt });
  const siem = getSiemOutboxMetrics(nowAt);
  return [
    '# HELP zhinao_agent_long_tasks Number of Agent desktop runtime tasks by status.',
    '# TYPE zhinao_agent_long_tasks gauge',
    ...['queued', 'paused', 'running', 'succeeded', 'failed', 'cancelled', 'timedOut'].map((status) => line('zhinao_agent_long_tasks', queue[status], { status: status === 'timedOut' ? 'timed_out' : status })),
    '# HELP zhinao_agent_long_task_queue_depth Active long task queue depth.',
    '# TYPE zhinao_agent_long_task_queue_depth gauge',
    line('zhinao_agent_long_task_queue_depth', queue.queueDepth),
    line('zhinao_agent_long_task_oldest_queued_seconds', queue.oldestQueuedAgeMs / 1000),
    line('zhinao_agent_long_task_worker_active_instances', queue.worker.activeInstances),
    line('zhinao_agent_long_task_worker_leader_healthy', queue.worker.status === 'healthy' ? 1 : 0),
    line('zhinao_agent_run_transition_consumer_active_instances', queue.transitionConsumer?.activeInstances || 0),
    line('zhinao_agent_run_transition_consumer_healthy', queue.transitionConsumer?.required ? (queue.transitionConsumer.ready ? 1 : 0) : 1),
    line('zhinao_agent_long_task_timeouts_last_hour', queue.timedOutLastHour),
    line('zhinao_agent_long_task_failures_last_hour', queue.failedLastHour),
    '# HELP zhinao_siem_outbox_events SIEM security event outbox records by state.',
    '# TYPE zhinao_siem_outbox_events gauge',
    line('zhinao_siem_outbox_events', siem.pending, { status: 'pending' }),
    line('zhinao_siem_outbox_events', siem.exporting, { status: 'exporting' }),
    line('zhinao_siem_outbox_events', siem.delivered, { status: 'delivered' }),
    line('zhinao_siem_outbox_oldest_pending_seconds', siem.oldestPendingAgeMs / 1000),
    line('zhinao_siem_outbox_failed_attempts_total', siem.failedAttempts),
    ''
  ].join('\n');
}

export async function sendPrometheusMetrics(req, res) {
  const authorization = authorizeMetricsRequest(req);
  if (!authorization.allowed) {
    res.writeHead(authorization.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-Id': res.requestId });
    res.end(JSON.stringify({ message: 'Metrics endpoint is unavailable.', code: 'METRICS_UNAVAILABLE' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-Id': res.requestId });
  res.end(await renderPrometheusMetrics());
}

import { createHmac, randomUUID } from 'node:crypto';
import { claimSiemExportBatch, completeSiemExportBatch, failSiemExportBatch, getSiemOutboxMetrics } from '../../backend/src/services/siem-event-export-service.js';

const workerId = String(process.env.SIEM_EXPORT_WORKER_ID || `siem-export-worker-${randomUUID()}`).slice(0, 120);
const endpoint = String(process.env.SIEM_EXPORT_URL || '').trim();
const batchSize = Math.min(Math.max(Number(process.env.SIEM_EXPORT_BATCH_SIZE) || 50, 1), 200);
const timeoutMs = Math.min(Math.max(Number(process.env.SIEM_EXPORT_TIMEOUT_MS) || 10_000, 1_000), 60_000);

const validateConfiguration = () => {
  if (!endpoint) return { configured: false, reason: 'SIEM_EXPORT_URL is not configured.' };
  const url = new URL(endpoint);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('Production SIEM export requires HTTPS.');
  if (process.env.NODE_ENV === 'production' && !process.env.SIEM_EXPORT_TOKEN && !process.env.SIEM_EXPORT_HMAC_SECRET) throw new Error('Production SIEM export requires a bearer token or HMAC secret.');
  return { configured: true, url };
};

export async function runSiemExportOnce() {
  const configuration = validateConfiguration();
  if (!configuration.configured) return { workerId, status: 'not_configured', metrics: getSiemOutboxMetrics() };
  const entries = claimSiemExportBatch({ workerId, limit: batchSize, leaseMs: timeoutMs + 10_000 });
  if (!entries.length) return { workerId, status: 'idle', exported: 0, metrics: getSiemOutboxMetrics() };
  const payload = entries.map((entry) => JSON.stringify(entry.envelope)).join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/x-ndjson', 'x-siem-batch-id': randomUUID() };
    if (process.env.SIEM_EXPORT_TOKEN) headers.authorization = `Bearer ${process.env.SIEM_EXPORT_TOKEN}`;
    if (process.env.SIEM_EXPORT_HMAC_SECRET) headers['x-content-signature'] = `sha256=${createHmac('sha256', process.env.SIEM_EXPORT_HMAC_SECRET).update(payload).digest('hex')}`;
    const response = await fetch(configuration.url, { method: 'POST', headers, body: payload, signal: controller.signal });
    if (!response.ok) throw new Error(`SIEM endpoint returned HTTP ${response.status}.`);
    const exportId = String(response.headers.get('x-siem-export-id') || headers['x-siem-batch-id']);
    completeSiemExportBatch({ ids: entries.map((entry) => entry.id), workerId, exportId });
    return { workerId, status: 'exported', exported: entries.length, exportId, metrics: getSiemOutboxMetrics() };
  } catch (error) {
    failSiemExportBatch({ ids: entries.map((entry) => entry.id), workerId, error: error?.message || String(error) });
    return { workerId, status: 'failed', exported: 0, error: String(error?.message || error).slice(0, 300), metrics: getSiemOutboxMetrics() };
  } finally { clearTimeout(timer); }
}

const result = await runSiemExportOnce();
process.stdout.write(`${JSON.stringify({ service: 'siem-export-worker', event: 'export_cycle', ...result })}\n`);
if (result.status === 'failed') process.exitCode = 1;

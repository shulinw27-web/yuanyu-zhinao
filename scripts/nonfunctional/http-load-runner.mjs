import { performance } from 'node:perf_hooks';

const percentile = (values, ratio) => values.length ? values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))] : 0;

export async function runHttpLoad({ url, requests = 100, concurrency = 10, headers = {}, fetchImpl = globalThis.fetch } = {}) {
  if (!String(url || '').startsWith('http')) throw new Error('A valid HTTP load-test URL is required.');
  const boundedRequests = Math.min(Math.max(Number(requests) || 100, 1), 100_000);
  const boundedConcurrency = Math.min(Math.max(Number(concurrency) || 10, 1), 500);
  const latencies = [];
  const statuses = new Map();
  let cursor = 0;
  const startedAt = performance.now();
  const worker = async () => {
    while (cursor < boundedRequests) {
      cursor += 1;
      const requestStartedAt = performance.now();
      try {
        const response = await fetchImpl(url, { headers });
        await response.arrayBuffer();
        statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
      } catch { statuses.set(0, (statuses.get(0) || 0) + 1); }
      latencies.push(performance.now() - requestStartedAt);
    }
  };
  await Promise.all(Array.from({ length: Math.min(boundedConcurrency, boundedRequests) }, worker));
  latencies.sort((left, right) => left - right);
  const durationMs = performance.now() - startedAt;
  const successCount = [...statuses.entries()].filter(([status]) => status >= 200 && status < 400).reduce((sum, [, count]) => sum + count, 0);
  return { requests: boundedRequests, concurrency: boundedConcurrency, durationMs: Math.round(durationMs), throughputPerSecond: Number((boundedRequests / Math.max(durationMs / 1_000, 0.001)).toFixed(2)), successCount, errorCount: boundedRequests - successCount, errorRate: Number((((boundedRequests - successCount) / boundedRequests) * 100).toFixed(2)), latencyMs: { p50: Math.round(percentile(latencies, 0.5)), p95: Math.round(percentile(latencies, 0.95)), p99: Math.round(percentile(latencies, 0.99)), max: Math.round(latencies.at(-1) || 0) }, statuses: Object.fromEntries(statuses) };
}

export function evaluateLoadThresholds(report, { maximumErrorRate = 1, maximumP95Ms = 1_000 } = {}) {
  const violations = [];
  if (report.errorRate > maximumErrorRate) violations.push(`error_rate>${maximumErrorRate}%`);
  if (report.latencyMs.p95 > maximumP95Ms) violations.push(`p95>${maximumP95Ms}ms`);
  return { passed: violations.length === 0, violations, thresholds: { maximumErrorRate, maximumP95Ms } };
}

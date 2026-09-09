const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Math.min(max, Math.max(min, Number(value)))) : fallback;

export async function runHttpSoak({ url, durationMs = 72 * 60 * 60 * 1000, intervalMs = 30000, requestTimeoutMs = 5000, maximumClientHeapGrowthMb = 256 }) {
  durationMs = bounded(durationMs, 72 * 60 * 60 * 1000, 100, 7 * 24 * 60 * 60 * 1000);
  intervalMs = bounded(intervalMs, 30000, 10, 600000);
  requestTimeoutMs = bounded(requestTimeoutMs, 5000, 50, 120000);
  maximumClientHeapGrowthMb = bounded(maximumClientHeapGrowthMb, 256, 1, 8192);
  const startedAt = Date.now();
  const initialHeap = process.memoryUsage().heapUsed;
  let maximumHeap = initialHeap;
  let samples = 0;
  let failedSamples = 0;
  const sampleDetails = [];
  while (Date.now() - startedAt < durationMs) {
    const sampledAt = Date.now();
    const remainingBudget = durationMs - (sampledAt - startedAt);
    // Do not launch a final probe with a few milliseconds of budget: that
    // would falsely label a healthy endpoint as failed at the sampling edge.
    if (samples > 0 && remainingBudget < Math.min(requestTimeoutMs, durationMs)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, remainingBudget));
      break;
    }
    const sample = { sampledAt: new Date(sampledAt).toISOString(), status: 0, ready: false };
    try {
      const response = await fetch(url, { headers: { 'x-client-platform': 'web', 'x-client-version': '0.1.0' }, signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, durationMs - (sampledAt - startedAt)))) });
      sample.status = response.status;
      await response.body?.cancel();
      sample.ready = response.ok;
    } catch {
      sample.error = 'readiness_request_failed_or_timed_out';
    }
    sample.latencyMs = Date.now() - sampledAt;
    sample.clientHeapUsedBytes = process.memoryUsage().heapUsed;
    maximumHeap = Math.max(maximumHeap, sample.clientHeapUsedBytes);
    samples += 1;
    if (!sample.ready) failedSamples += 1;
    // Aggregate all observations; bound retained detail for multi-day probes.
    if (sampleDetails.length === 1000) sampleDetails.shift();
    sampleDetails.push(sample);
    const remaining = durationMs - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(intervalMs, remaining)));
  }
  const clientHeapGrowthMb = Number(((maximumHeap - initialHeap) / 1024 / 1024).toFixed(2));
  return {
    schemaVersion: 'http-soak.v2', startedAt: new Date(startedAt).toISOString(), completedAt: new Date().toISOString(), requestedDurationMs: durationMs,
    samples, failedSamples, availability: samples ? `${(((samples - failedSamples) / samples) * 100).toFixed(3)}%` : '0.000%',
    clientHeapGrowthMb, serverMemory: { status: 'not_measured' }, memoryScope: 'load_generator_process_only',
    passed: samples > 0 && failedSamples === 0 && clientHeapGrowthMb <= maximumClientHeapGrowthMb,
    thresholds: { failedSamples: 0, maximumClientHeapGrowthMb, requestTimeoutMs }, sampleDetails, retainedSampleLimit: 1000
  };
}

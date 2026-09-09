import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { evaluateLoadThresholds, runHttpLoad } from '../../scripts/nonfunctional/http-load-runner.mjs';
import { runHttpSoak } from '../../scripts/nonfunctional/http-soak-runner.mjs';

test('bounded load runner reports throughput, percentiles, statuses and threshold decisions', async () => {
  const server = createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const report = await runHttpLoad({ url: `http://127.0.0.1:${server.address().port}/health`, requests: 40, concurrency: 8 });
    assert.equal(report.requests, 40);
    assert.equal(report.successCount, 40);
    assert.equal(report.errorCount, 0);
    assert.ok(report.throughputPerSecond > 0);
    assert.ok(report.latencyMs.p95 >= 0);
    assert.equal(evaluateLoadThresholds(report, { maximumErrorRate: 0, maximumP95Ms: 5_000 }).passed, true);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('load thresholds fail closed when error rate or latency budgets are exceeded', () => {
  const evaluation = evaluateLoadThresholds({ errorRate: 2.5, latencyMs: { p95: 1_200 } }, { maximumErrorRate: 1, maximumP95Ms: 1_000 });
  assert.equal(evaluation.passed, false);
  assert.deepEqual(evaluation.violations, ['error_rate>1%', 'p95>1000ms']);
});

test('soak probe labels client memory separately and bounds stalled readiness requests', async () => {
  let stall = false;
  const server = createServer((req, res) => { req.resume(); if (!stall) { res.writeHead(200); res.end('{}'); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/health/ready`;
    const report = await runHttpSoak({ url, durationMs: 200, intervalMs: 50 });
    assert.equal(report.passed, true);
    assert.ok(report.samples > 0);
    assert.equal(report.samples, 1, 'do not start another probe without its full deadline budget');
    assert.equal(report.serverMemory.status, 'not_measured');
    assert.equal(report.memoryScope, 'load_generator_process_only');
    assert.equal(Object.hasOwn(report, 'heapGrowthMb'), false);
    assert.ok(report.sampleDetails.every((item) => item.clientHeapUsedBytes > 0));
    stall = true;
    const start = Date.now();
    const failed = await runHttpSoak({ url, durationMs: 200, requestTimeoutMs: 50, intervalMs: 10 });
    assert.equal(failed.passed, false);
    assert.equal(failed.failedSamples, failed.samples);
    assert.ok(Date.now() - start < 2000);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

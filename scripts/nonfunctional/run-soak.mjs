import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runHttpSoak } from './http-soak-runner.mjs';

const baseUrl = String(process.env.SOAK_TEST_BASE_URL || 'http://127.0.0.1:3001/api').replace(/\/$/, '');
const report = await runHttpSoak({
  url: `${baseUrl}/health/ready`,
  durationMs: process.env.SOAK_TEST_DURATION_MS,
  intervalMs: process.env.SOAK_TEST_INTERVAL_MS,
  requestTimeoutMs: process.env.SOAK_TEST_REQUEST_TIMEOUT_MS,
  maximumClientHeapGrowthMb: process.env.SOAK_TEST_MAX_CLIENT_HEAP_GROWTH_MB || process.env.SOAK_TEST_MAX_HEAP_GROWTH_MB
});
await mkdir(resolve('output'), { recursive: true });
await writeFile(resolve('output/soak-report.json'), `${JSON.stringify(report, null, 2)}\n`);
const { sampleDetails: _samples, ...summary } = report;
process.stdout.write(`${JSON.stringify({ ...summary, output: 'output/soak-report.json' })}\n`);
if (!report.passed) process.exitCode = 1;

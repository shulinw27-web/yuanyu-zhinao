import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateLoadThresholds, runHttpLoad } from './http-load-runner.mjs';

const baseUrl = String(process.env.LOAD_TEST_BASE_URL || 'http://127.0.0.1:3001/api').replace(/\/$/, '');
const report = await runHttpLoad({ url: `${baseUrl}/health/live`, requests: Number(process.env.LOAD_TEST_REQUESTS) || 500, concurrency: Number(process.env.LOAD_TEST_CONCURRENCY) || 25, headers: { 'x-client-platform': 'web', 'x-client-version': '0.1.0' } });
const evaluation = evaluateLoadThresholds(report, { maximumErrorRate: Number(process.env.LOAD_TEST_MAX_ERROR_RATE) || 1, maximumP95Ms: Number(process.env.LOAD_TEST_MAX_P95_MS) || 1_000 });
await mkdir(resolve('output'), { recursive: true });
await writeFile(resolve('output/load-smoke-report.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), report, evaluation }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ report, evaluation, output: 'output/load-smoke-report.json' })}\n`);
if (!evaluation.passed) process.exitCode = 1;

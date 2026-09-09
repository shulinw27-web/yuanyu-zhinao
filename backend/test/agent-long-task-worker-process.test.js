import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const parseJsonLine = (output) => String(output || '').split(/\r?\n/u).filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line)).at(-1);

test('standalone maintenance worker publishes cross-process heartbeat and honors leader lease', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'zhinao-agent-worker-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const databasePath = join(tempRoot, 'runtime.db');
  const commonEnv = { ...process.env, NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'sqlite', RUNTIME_SQLITE_PATH: databasePath, AGENT_RUNTIME_WORKER_INTERVAL_MS: '5000' };
  const workerScript = resolve('services/agent-runtime-worker/app.js');
  const first = spawnSync(process.execPath, [workerScript, '--once'], { cwd: resolve('.'), env: { ...commonEnv, AGENT_RUNTIME_WORKER_ID: 'process-worker-primary' }, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(parseJsonLine(first.stdout).leader, true);
  const second = spawnSync(process.execPath, [workerScript, '--once'], { cwd: resolve('.'), env: { ...commonEnv, AGENT_RUNTIME_WORKER_ID: 'process-worker-standby' }, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(parseJsonLine(second.stdout).leader, false);

  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', "import { getAgentLongTaskQueueMetrics } from './backend/src/services/agent-long-task-service.js'; console.log(JSON.stringify(getAgentLongTaskQueueMetrics()));"], { cwd: resolve('.'), env: commonEnv, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const metrics = parseJsonLine(probe.stdout);
  assert.equal(metrics.worker.status, 'healthy');
  assert.equal(metrics.worker.activeInstances, 2);
  assert.equal(metrics.worker.leaderWorkerId, 'process-worker-primary');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 同步 spawnSync 在部分 Windows 环境（受控沙箱/文件锁）会以 EBUSY 失败；
// 改用异步 spawn 等价封装，保持真实跨进程语义与 { status, stdout, stderr } 返回结构。
const spawnNode = (args, options) => new Promise((resolvePromise) => {
  const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code, signal) => resolvePromise({ status: signal ? null : code, stdout, stderr }));
  child.on('error', () => resolvePromise({ status: null, stdout, stderr }));
});

const parseJsonLine = (output) => String(output || '').split(/\r?\n/u).filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line)).at(-1);

test('standalone maintenance worker publishes cross-process heartbeat and honors leader lease', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'zhinao-agent-worker-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const databasePath = join(tempRoot, 'runtime.db');
  const commonEnv = { ...process.env, NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'sqlite', RUNTIME_SQLITE_PATH: databasePath, AGENT_RUNTIME_WORKER_INTERVAL_MS: '5000' };
  const workerScript = resolve('services/agent-runtime-worker/app.js');
  const first = await spawnNode([workerScript, '--once'], { cwd: resolve('.'), env: { ...commonEnv, AGENT_RUNTIME_WORKER_ID: 'process-worker-primary' } });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(parseJsonLine(first.stdout).leader, true);
  const second = await spawnNode([workerScript, '--once'], { cwd: resolve('.'), env: { ...commonEnv, AGENT_RUNTIME_WORKER_ID: 'process-worker-standby' } });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(parseJsonLine(second.stdout).leader, false);

  const probe = await spawnNode(['--input-type=module', '-e', "import { getAgentLongTaskQueueMetrics } from './backend/src/services/agent-long-task-service.js'; console.log(JSON.stringify(getAgentLongTaskQueueMetrics()));"], { cwd: resolve('.'), env: commonEnv });
  assert.equal(probe.status, 0, probe.stderr);
  const metrics = parseJsonLine(probe.stdout);
  assert.equal(metrics.worker.status, 'healthy');
  assert.equal(metrics.worker.activeInstances, 2);
  assert.equal(metrics.worker.leaderWorkerId, 'process-worker-primary');
});

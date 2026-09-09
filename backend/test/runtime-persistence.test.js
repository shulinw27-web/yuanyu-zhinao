import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const repositoryUrl = new URL('../src/repositories/runtime-state-repository.js', import.meta.url).href;
const agentStoreUrl = new URL('../src/services/agent-runtime-store.js', import.meta.url).href;
const evidenceTraceUrl = new URL('../src/services/agent-evidence-trace-service.js', import.meta.url).href;

const runModule = (source, env) => spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
  cwd: resolve('.'),
  env: { ...process.env, ...env },
  encoding: 'utf8'
});

const runModuleAsync = (source, env) => new Promise((resolvePromise) => {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: resolve('.'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
});

const availablePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

const startApi = async (env) => {
  const child = spawn(process.execPath, ['backend/src/app.js'], { cwd: resolve('.'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 8_000;
  const healthUrl = `http://127.0.0.1:${env.PORT}/api/health`;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited before startup: ${stderr}`);
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return child;
    } catch {
      // Startup polling intentionally ignores connection refused.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  child.kill();
  if (child.exitCode === null) await new Promise((resolveClose) => child.once('close', resolveClose));
  throw new Error(`API did not start: ${stderr}`);
};

const stopApi = (child) => new Promise((resolveStop) => {
  if (child.exitCode !== null) { resolveStop(); return; }
  child.once('close', resolveStop);
  child.kill();
});

test('SQLite runtime state survives a process restart and can be reset', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhinao-runtime-'));
  const databasePath = join(directory, 'runtime.db');
  const env = { RUNTIME_STORE_DRIVER: 'sqlite', RUNTIME_SQLITE_PATH: databasePath };
  try {
    const writer = runModule(`
      const store = await import(${JSON.stringify(repositoryUrl)});
      store.writeState('persistence_test', 'record', { value: 42 });
      process.stdout.write(store.getRuntimeStoreInfo().persistence);
    `, env);
    assert.equal(writer.status, 0, writer.stderr);
    assert.equal(writer.stdout, 'durable_local');

    const reader = runModule(`
      const store = await import(${JSON.stringify(repositoryUrl)});
      process.stdout.write(JSON.stringify(store.readState('persistence_test', 'record')));
    `, env);
    assert.equal(reader.status, 0, reader.stderr);
    assert.deepEqual(JSON.parse(reader.stdout), { value: 42 });

    const reset = runModule(`
      const store = await import(${JSON.stringify(repositoryUrl)});
      store.resetRuntimeState(['persistence_test']);
      process.stdout.write(String(store.readState('persistence_test', 'record') === null));
    `, env);
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(reset.stdout, 'true');
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('SQLite transaction allows only one process to claim an Agent confirmation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhinao-claim-'));
  const databasePath = join(directory, 'runtime.db');
  const env = { RUNTIME_STORE_DRIVER: 'sqlite', RUNTIME_SQLITE_PATH: databasePath };
  const identity = { tenantId: 'tenant-a', subjectId: 'user-a', sessionId: 'session-a', deviceId: 'device-a' };
  try {
    const seed = runModule(`
      const store = await import(${JSON.stringify(agentStoreUrl)});
      const run = store.createAgentRun({
        roleId: 'quality_manager', identityScope: ${JSON.stringify(identity)}, input: '创建质量调查', domain: 'production',
        skill: {}, agents: [], plan: [], evidence: [], authorization: {}, businessControl: {}, multimodal: {},
        proposedCommand: { id: 'create_quality_investigation', requiresConfirmation: true }
      });
      process.stdout.write(JSON.stringify({ runId: run.id, token: run.confirmationToken }));
    `, env);
    assert.equal(seed.status, 0, seed.stderr);
    const confirmation = JSON.parse(seed.stdout);
    const claimSource = `
      const store = await import(${JSON.stringify(agentStoreUrl)});
      const result = store.claimAgentExecution({
        runId: process.env.TEST_RUN_ID,
        commandId: 'create_quality_investigation',
        confirmationToken: process.env.TEST_TOKEN,
        roleId: 'quality_manager',
        identityScope: ${JSON.stringify(identity)}
      });
      process.stdout.write(JSON.stringify({ success: !result.error, error: result.error || null }));
    `;
    const claimEnv = { ...env, TEST_RUN_ID: confirmation.runId, TEST_TOKEN: confirmation.token };
    const results = await Promise.all([runModuleAsync(claimSource, claimEnv), runModuleAsync(claimSource, claimEnv)]);
    results.forEach((result) => assert.equal(result.code, 0, result.stderr));
    const claims = results.map((result) => JSON.parse(result.stdout));
    assert.equal(claims.filter((claim) => claim.success).length, 1);
    assert.equal(claims.filter((claim) => !claim.success).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('evidence trace events and integrity survive a process restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhinao-evidence-trace-'));
  const databasePath = join(directory, 'runtime.db');
  const env = { RUNTIME_STORE_DRIVER: 'sqlite', RUNTIME_SQLITE_PATH: databasePath };
  const identity = { tenantId: 'trace-tenant', subjectId: 'trace-user', sessionId: 'trace-session', deviceId: 'trace-device' };
  try {
    const writer = runModule(`
      const traces = await import(${JSON.stringify(evidenceTraceUrl)});
      const trace = await traces.createAgentEvidenceTrace({ roleId: 'quality_manager', identityScope: ${JSON.stringify(identity)}, input: '持久化证据追踪', requestId: 'restart-trace' });
      await traces.appendAgentEvidenceEvent(trace.id, { type: 'tool_execution_succeeded', stage: 'tool_execution', status: 'succeeded', summary: '只读工具执行完成。', evidence: [{ source: 'QMS', id: 'QI-001', title: '质量调查记录', version: 'v1' }] });
      await traces.bindAgentEvidenceTraceRun(trace.id, { runId: 'run-persisted-trace', roleId: 'quality_manager', domain: 'production' });
      await traces.setAgentEvidenceTraceStatus(trace.id, 'completed', { completed: true });
      process.stdout.write(trace.id);
    `, env);
    assert.equal(writer.status, 0, writer.stderr);

    const reader = runModule(`
      const traces = await import(${JSON.stringify(evidenceTraceUrl)});
      const trace = await traces.getAgentEvidenceTraceByRunId('run-persisted-trace', ['quality_manager'], ${JSON.stringify(identity)});
      process.stdout.write(JSON.stringify({ id: trace?.id, status: trace?.status, eventCount: trace?.eventCount, integrity: trace?.integrity }));
    `, env);
    assert.equal(reader.status, 0, reader.stderr);
    const restored = JSON.parse(reader.stdout);
    assert.equal(restored.id, writer.stdout);
    assert.equal(restored.status, 'completed');
    assert.equal(restored.eventCount, 2);
    assert.equal(restored.integrity.valid, true);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('identity session remains valid after the API process restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhinao-http-restart-'));
  const databasePath = join(directory, 'runtime.db');
  const port = await availablePort();
  const env = {
    NODE_ENV: 'development',
    DEMO_ALLOW_ROLE_HEADER: 'false',
    RUNTIME_STORE_DRIVER: 'sqlite',
    RUNTIME_SQLITE_PATH: databasePath,
    API_HOST: '127.0.0.1',
    PORT: String(port)
  };
  const baseUrl = `http://127.0.0.1:${port}/api`;
  const deviceId = 'restart-test-device';
  let api = null;
  try {
    api = await startApi(env);
    const login = await fetch(`${baseUrl}/auth/local/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-device-id': deviceId, 'x-client-platform': 'test' },
      body: JSON.stringify({ account: 'admin@demo.local', password: 'demo' })
    });
    assert.equal(login.status, 200);
    const session = await login.json();
    await stopApi(api);
    api = await startApi(env);
    const access = await fetch(`${baseUrl}/access/me`, {
      headers: { 'x-identity-session': session.sessionId, 'x-client-device-id': deviceId, 'x-demo-role': session.user.roleId }
    });
    assert.equal(access.status, 200);
    const profile = await access.json();
    assert.equal(profile.account, 'admin@demo.local');
    assert.ok(profile.roleIds.includes('executive'));
  } finally {
    if (api) await stopApi(api);
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

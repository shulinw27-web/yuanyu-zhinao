import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { publishSemanticaModelDefinition, getSemanticaModelDeployment, resetSemanticaDemoGraph } from '../src/services/semantica-demo-bridge-service.js';
import { inspectTenantProvisioning } from '../src/services/tenant-provisioning-preflight.js';

// Explicit integration command: requires the real Semantica environment, never silently skips.
const python = process.env.SEMANTIC_TEST_PYTHON || resolve(process.platform === 'win32' ? '.venv-semantica/Scripts/python.exe' : '.venv-semantica/bin/python');
const execute = promisify(execFile);
const within = (tenantId, work) => runWithSemanticTenant({ tenantId }, work);
const headers = item => ({ authorization: `Bearer ${item.token}`, 'x-semantic-tenant': item.tenantId, 'x-semantic-deployment': item.deploymentId });
const definition = suffix => ({ id: `model-${suffix}`, code: `TEST-${suffix}`, modelingProfile: 'general',
  objectTypes: [{ id: 'QualityEvent', semanticType: 'QualityEvent', coreObject: 'QualityEvent', key: 'id', fields: ['id', 'status'], sourceSystems: ['QMS'], granularity: 'event' }], relationshipTypes: [] });

for (const durable of [false, true]) test(`real Python processes: isolation and restart (${durable ? 'SQLite' : 'memory'})`, { timeout: 120000 }, async t => {
  assert.ok(existsSync(python), 'Install the Semantica environment or set SEMANTIC_TEST_PYTHON to its Python executable.');
  const directory = mkdtempSync(join(tmpdir(), 'semantic-process-test-'));
  const children = [];
  const registryFile = join(directory, 'registry.json');
  const prior = { file: process.env.SEMANTIC_INSTANCES_FILE, enabled: process.env.SEMANTICA_DEMO_BRIDGE_ENABLED };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    if (prior.file === undefined) delete process.env.SEMANTIC_INSTANCES_FILE; else process.env.SEMANTIC_INSTANCES_FILE = prior.file;
    if (prior.enabled === undefined) delete process.env.SEMANTICA_DEMO_BRIDGE_ENABLED; else process.env.SEMANTICA_DEMO_BRIDGE_ENABLED = prior.enabled;
    await rm(directory, { recursive: true, maxRetries: 10, retryDelay: 100 });
  });
  async function start(suffix, databasePath = join(directory, `${suffix}.db`)) {
    const item = { version: 1, tenantId: `synthetic-${suffix}`, deploymentId: `process-${suffix}`, token: randomBytes(32).toString('base64url'), enabled: true };
    const configFile = join(directory, `${suffix}.json`); writeFileSync(configFile, JSON.stringify(item));
    const child = spawn(python, ['-u', 'services/semantic-context/app.py'], { cwd: resolve('.'), windowsHide: true,
      env: { ...process.env, SEMANTIC_CONTEXT_PORT: '0', SEMANTIC_INSTANCE_CONFIG_FILE: configFile, SEMANTIC_REQUIRE_INSTANCE_AUTH: 'true',
        SEMANTIC_INSTANCE_DB: durable ? databasePath : '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); child.stderr.on('data', () => {});
    const endpoint = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Semantic instance startup timed out')), 45000);
      let output = '';
      child.stdout.on('data', bytes => { output += bytes.toString(); const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/u); if (match) { clearTimeout(timer); resolveReady(match[1]); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Semantic instance exited ${code}`)); });
    });
    const health = await fetch(`${endpoint}/instance`, { headers: headers(item) });
    const status = await health.json(); assert.equal(health.status, 200); assert.equal(status.engine, 'semantica'); assert.equal(status.durable, durable);
    assert.equal(status.storage, durable ? 'sqlite-snapshot' : 'process-memory');
    return { ...item, endpoint, child };
  }
  const [a, b] = await Promise.all([start('a'), start('b')]);
  const bindings = [a, b].map(({ child: _child, ...item }) => item);
  const save = items => writeFileSync(registryFile, JSON.stringify({ version: 1, instances: items }));
  save(bindings); process.env.SEMANTIC_INSTANCES_FILE = registryFile; process.env.SEMANTICA_DEMO_BRIDGE_ENABLED = 'true';

  await t.test('portal resource preflight verifies durable instance but never invents IAM readiness', async () => {
    const result = await inspectTenantProvisioning({ tenantId: b.tenantId });
    assert.equal(result[0].status, durable ? 'passed' : 'blocked');
    assert.ok(result.slice(1).every(item => item.status === 'blocked'));
  });

  await t.test('every read and write route rejects missing identity or another tenant credential', async () => {
    for (const [path, method] of [['/health', 'GET'], ['/context/executive', 'GET'], ['/instance', 'GET'], ['/demo/model-candidates', 'GET'], ['/demo/runs/anything', 'GET'], ['/demo/model-definition', 'GET'], ['/demo/ingest', 'POST'], ['/demo/reset', 'POST'], ['/demo/model-definition/validate', 'POST'], ['/demo/model-definition/publish', 'POST']]) {
      for (const supplied of [{}, headers(a), { ...headers(b), 'x-semantic-tenant': a.tenantId }]) {
        const response = await fetch(`${b.endpoint}${path}`, { method, headers: supplied });
        assert.equal(response.status, 403, path); assert.deepEqual(await response.json(), { error: 'instance_access_denied' });
        assert.equal(response.headers.get('x-semantic-tenant'), null);
      }
    }
  });
  await t.test('parallel publications return only their own tenant model and version', async () => {
    const result = await Promise.all([a, b].map((item, index) => within(item.tenantId, () => publishSemanticaModelDefinition(definition(index), `v${index + 1}`))));
    assert.deepEqual(result.map(value => value.status), ['published', 'published']);
    const read = await Promise.all([a, b].map(item => within(item.tenantId, getSemanticaModelDeployment)));
    assert.deepEqual(read.map(value => value.id), ['model-0', 'model-1']);
    assert.deepEqual(read.map(value => value.version), ['v1', 'v2']);
  });
  await t.test('independent graphs retain only their own synthetic fact runs', async () => {
    for (const item of [a, b]) {
      const runId = `run-${item.tenantId}`;
      const facts = ['ERP', 'QMS'].map(system => ({ id: `${runId}-${system}`, sourceSystem: system, sourceRecordId: `${runId}-${system}`, objectType: 'QualityEvent', eventType: 'reported', status: 'open', classification: 'synthetic', occurredAt: '2026-09-16T00:00:00Z', runId, simulated: true, payload: { eventId: runId } }));
      const response = await fetch(`${item.endpoint}/demo/ingest`, { method: 'POST', headers: { ...headers(item), 'content-type': 'application/json' }, body: JSON.stringify({ runId, scenarioId: 'isolated-synthetic', expectedSystems: ['ERP', 'QMS'], facts }) });
      assert.equal(response.status, 200); assert.equal((await response.json()).ingestedFacts, 2);
    }
    const other = await fetch(`${b.endpoint}/demo/runs/run-${a.tenantId}`, { headers: headers(b) });
    assert.equal(other.status, 404);
    const own = await fetch(`${b.endpoint}/demo/runs/run-${b.tenantId}`, { headers: headers(b) });
    assert.equal(own.status, 200);
  });
  await t.test('incorrect endpoint binding and revoked credentials fail before publication', async () => {
    save([{ ...bindings[0], endpoint: b.endpoint }]);
    const misrouted = await within(a.tenantId, () => publishSemanticaModelDefinition(definition('wrong'), 'v3'));
    assert.equal(misrouted.requestAttempted, false); assert.equal(misrouted.reason, 'instance_identity_unverified');
    save([{ ...bindings[0], token: randomBytes(32).toString('base64url') }, bindings[1]]);
    assert.equal((await within(a.tenantId, getSemanticaModelDeployment)).status, 'unavailable');
    save([{ ...bindings[0], enabled: false }, bindings[1]]);
    assert.equal((await within(a.tenantId, getSemanticaModelDeployment)).reason, 'tenant_endpoint_required');
    assert.equal((await within(b.tenantId, getSemanticaModelDeployment)).id, 'model-1');
    save(bindings);
  });
  await t.test('resetting A does not reset B model or graph', async () => {
    assert.equal((await within(a.tenantId, resetSemanticaDemoGraph)).status, 'reset');
    assert.equal((await within(b.tenantId, getSemanticaModelDeployment)).id, 'model-1');
    const response = await fetch(`${b.endpoint}/demo/runs/run-${b.tenantId}`, { headers: headers(b) });
    assert.equal(response.status, 200);
  });
  await t.test('abrupt restart and key rotation preserve only committed durable state', async () => {
    const beforeRestart = await within(b.tenantId, getSemanticaModelDeployment);
    const exited = once(b.child, 'exit'); b.child.kill(); await exited;
    let restoredPath;
    if (durable) {
      const runOffline = async (operation, source, target) => {
        const args = ['services/semantic-context/manage_instance_store.py', operation, '--config', join(directory, 'b.json'), '--source', source];
        if (target) args.push('--target', target);
        const result = await execute(python, args, { cwd: resolve('.'), windowsHide: true, timeout: 45000 });
        return JSON.parse(result.stdout.trim());
      };
      const backup = join(directory, 'b-backup.db'); restoredPath = join(directory, 'b-restored.db');
      assert.equal((await runOffline('backup', join(directory, 'b.db'), backup)).status, 'completed');
      assert.equal((await runOffline('verify', backup)).status, 'verified');
      assert.equal((await runOffline('restore', backup, restoredPath)).status, 'completed');
    }
    const restarted = await start('b', restoredPath); save([bindings[0], { tenantId: restarted.tenantId, deploymentId: restarted.deploymentId, token: restarted.token, endpoint: restarted.endpoint, enabled: true }]);
    const oldCredential = await fetch(`${restarted.endpoint}/instance`, { headers: headers(b) });
    assert.equal(oldCredential.status, 403);
    const recovered = await within(b.tenantId, getSemanticaModelDeployment);
    assert.equal(recovered.status, durable ? 'published' : 'not_published');
    if (durable) assert.deepEqual(recovered, beforeRestart);
    const run = await fetch(`${restarted.endpoint}/demo/runs/run-${b.tenantId}`, { headers: headers(restarted) });
    assert.equal(run.status, durable ? 200 : 404);
    if (durable) assert.equal((await run.json()).run.validation.passed, true);
    // A reset must remain reset after its own restart, and cannot erase its model.
    const aExit = once(a.child, 'exit'); a.child.kill(); await aExit;
    const recoveredA = await start('a');
    const aRun = await fetch(`${recoveredA.endpoint}/demo/runs/run-${a.tenantId}`, { headers: headers(recoveredA) });
    assert.equal(aRun.status, 404);
    const aModel = await fetch(`${recoveredA.endpoint}/demo/model-definition`, { headers: headers(recoveredA) });
    assert.equal((await aModel.json()).status, durable ? 'published' : 'not_published');
  });
});

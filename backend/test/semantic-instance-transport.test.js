import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSemanticInstanceConfiguration, localSemanticEndpoint } from '../src/config/semantic-instance-config.js';
import { semanticInstanceConnection, requestSemanticInstance } from '../src/services/semantic-instance-transport.js';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { publishSemanticaModelDefinition, syncMockScenarioToSemantica } from '../src/services/semantica-demo-bridge-service.js';

const entry = (suffix = 'a', port = 3031) => ({ tenantId: `tenant-${suffix}`, deploymentId: `instance-${suffix}`, enabled: true,
  endpoint: `http://127.0.0.1:${port}`, token: suffix.repeat(43) });
const within = (tenantId, work) => runWithSemanticTenant({ tenantId }, work);

function registry(t, instances) {
  const directory = mkdtempSync(join(tmpdir(), 'semantic-registry-test-'));
  const file = join(directory, 'instances.json');
  const previous = process.env.SEMANTIC_INSTANCES_FILE;
  const enabled = process.env.SEMANTICA_DEMO_BRIDGE_ENABLED;
  process.env.SEMANTIC_INSTANCES_FILE = file; process.env.SEMANTICA_DEMO_BRIDGE_ENABLED = 'true';
  const write = value => writeFileSync(file, JSON.stringify(value));
  write({ version: 1, instances });
  t.after(() => {
    if (previous === undefined) delete process.env.SEMANTIC_INSTANCES_FILE; else process.env.SEMANTIC_INSTANCES_FILE = previous;
    if (enabled === undefined) delete process.env.SEMANTICA_DEMO_BRIDGE_ENABLED; else process.env.SEMANTICA_DEMO_BRIDGE_ENABLED = enabled;
    rmSync(directory, { recursive: true });
  });
  return write;
}

async function stub(t, respond) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ url: req.url, method: req.method, headers: req.headers, body });
    respond(req, res, body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, port: server.address().port };
}
function receipt(res, item) {
  res.setHeader('x-semantic-tenant', item.tenantId); res.setHeader('x-semantic-deployment', item.deploymentId); res.setHeader('x-semantic-protocol', '1');
}

test('instance registry reserves unique tenants, endpoints, deployment IDs and secrets', () => {
  const a = entry(); const b = entry('b', 3032);
  assert.equal(validateSemanticInstanceConfiguration({ version: 1, instances: [a, b] }).length, 2);
  for (const patch of [{ tenantId: a.tenantId }, { deploymentId: a.deploymentId }, { token: a.token }, { endpoint: 'http://localhost:3031/' }, { endpoint: 'http://127.0.0.1:3011' }, { enabled: 'true' }, { token: 'short' }, { tenantId: ' a' }]) {
    assert.throws(() => validateSemanticInstanceConfiguration({ version: 1, instances: [a, { ...b, ...patch }] }));
  }
});

test('instance endpoints reject remote hosts, paths, credentials, fragments and queries', () => {
  assert.equal(localSemanticEndpoint('http://localhost:3031/'), 'http://127.0.0.1:3031');
  for (const value of ['https://example.test', 'http://127.0.0.1:3031/other', 'http://a:b@127.0.0.1:3031', 'http://127.0.0.1:3031/?a=b', 'http://127.0.0.1:3031/#x', 'http://127.0.0.2:3031']) assert.throws(() => localSemanticEndpoint(value));
});

test('production Demo also requires an explicit guarded instance binding', () => {
  const prior = { mode: process.env.NODE_ENV, file: process.env.SEMANTIC_INSTANCES_FILE };
  process.env.NODE_ENV = 'production'; delete process.env.SEMANTIC_INSTANCES_FILE;
  try { assert.equal(within('demo-enterprise', semanticInstanceConnection).reason, 'tenant_endpoint_required'); }
  finally {
    if (prior.mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prior.mode;
    if (prior.file === undefined) delete process.env.SEMANTIC_INSTANCES_FILE; else process.env.SEMANTIC_INSTANCES_FILE = prior.file;
  }
});

test('authoritative registry never falls back on missing, disabled or invalid tenant binding', t => {
  const write = registry(t, [entry(), { ...entry('b', 3032), enabled: false }]);
  assert.equal(within('tenant-a', semanticInstanceConnection).guarded, true);
  for (const tenant of ['tenant-b', 'unknown', 'demo-enterprise']) assert.equal(within(tenant, semanticInstanceConnection).reason, 'tenant_endpoint_required');
  write({ version: 2, instances: [] });
  assert.equal(within('tenant-a', semanticInstanceConnection).reason, 'tenant_config_invalid');
});

test('parallel tenant requests use separate endpoints and exact service receipts', async t => {
  const instances = [];
  for (const suffix of ['a', 'b']) {
    const item = entry(suffix);
    const server = await stub(t, (_req, res) => { receipt(res, item); res.end(JSON.stringify({ marker: item.tenantId })); });
    item.endpoint = `http://127.0.0.1:${server.port}`; instances.push(item);
  }
  registry(t, instances);
  const result = await Promise.all(instances.map(item => within(item.tenantId, () => requestSemanticInstance(semanticInstanceConnection(), '/demo/model-definition'))));
  assert.deepEqual(result.map(item => item.marker), ['tenant-a', 'tenant-b']);
  assert.deepEqual(result.map(item => item.instance.tenantId), ['tenant-a', 'tenant-b']);
  assert.ok(result.every(item => item.instance.identityVerified));
});

test('wrong-instance or missing receipt blocks model transmission before POST', async t => {
  const item = entry();
  const server = await stub(t, (_req, res) => { receipt(res, { ...item, tenantId: 'tenant-b' }); res.end('{}'); });
  item.endpoint = `http://127.0.0.1:${server.port}`; registry(t, [item]);
  const result = await within(item.tenantId, () => publishSemanticaModelDefinition({ id: 'secret-model', objectTypes: [], relationshipTypes: [] }, 'v1'));
  assert.equal(result.reason, 'instance_identity_unverified'); assert.equal(result.requestAttempted, false);
  assert.deepEqual(server.requests.map(r => r.method), ['GET']);
  assert.equal(JSON.stringify(result).includes(item.token), false);
  assert.equal(server.requests[0].body, '');
});

test('redirect cannot carry a service token or model to another endpoint', async t => {
  let destinationHits = 0;
  const destination = await stub(t, (_req, res) => { destinationHits++; res.end('{}'); });
  const server = await stub(t, (_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${destination.port}` }); res.end(); });
  const item = { ...entry(), endpoint: `http://127.0.0.1:${server.port}` }; registry(t, [item]);
  await assert.rejects(within(item.tenantId, () => requestSemanticInstance(semanticInstanceConnection(), '/demo/reset', { method: 'POST' })), error => error.requestAttempted === false);
  assert.equal(destinationHits, 0); assert.equal(server.requests.length, 1);
});

test('write response without matching receipt is uncertain, never an acknowledged publish', async t => {
  const item = entry();
  const server = await stub(t, (req, res) => { if (req.url === '/instance') receipt(res, item); res.end(JSON.stringify({ status: 'published' })); });
  item.endpoint = `http://127.0.0.1:${server.port}`; registry(t, [item]);
  const result = await within(item.tenantId, () => publishSemanticaModelDefinition({ id: 'a', objectTypes: [], relationshipTypes: [] }, 'v1'));
  assert.equal(result.status, 'unavailable'); assert.equal(result.requestAttempted, true);
  assert.equal(server.requests.length, 2);
});

test('non-Demo cannot import the global mock fixture store into an isolated instance', async t => {
  registry(t, [entry()]);
  const result = await within('tenant-a', () => syncMockScenarioToSemantica('existing-demo-run'));
  assert.equal(result.reason, 'tenant_fixture_unavailable'); assert.equal(result.requestAttempted, false);
});

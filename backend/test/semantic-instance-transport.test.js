import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSemanticInstanceConfiguration, localSemanticEndpoint } from '../src/config/semantic-instance-config.js';
import { semanticInstanceConnection, requestSemanticInstance } from '../src/services/semantic-instance-transport.js';
import { runWithSemanticTenant, runWithSemanticModelWorkspace } from '../src/services/semantic-tenant-context.js';
import { publishSemanticaModelDefinition, syncMockScenarioToSemantica, getSemanticaModelDeployment } from '../src/services/semantica-demo-bridge-service.js';
import { semanticModelRegistry } from '../src/services/semantic-model-registry.js';
import { getRole } from '../src/services/authorization-service.js';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';

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

test('model transport verifies namespace receipts before disclosing a definition', async t => {
  const item = entry();
  let wrong = true;
  const server = await stub(t, (_req, res) => {
    receipt(res, item); res.setHeader('x-semantic-model', wrong ? 'manufacturing' : 'finance');
    res.setHeader('x-semantic-model-protocol', '1'); res.end('{}');
  });
  const connection = { ...item, guarded: true, endpoint: `http://127.0.0.1:${server.port}` };
  const options = { modelId: 'finance', method: 'POST', body: { definition: { id: 'synthetic' }, expectedFingerprint: null } };
  await assert.rejects(requestSemanticInstance(connection, '/models/finance/definition/publish', options), error => error.requestAttempted === false);
  assert.equal(server.requests.length, 1); assert.equal(server.requests[0].body, '');
  wrong = false;
  const result = await requestSemanticInstance(connection, '/models/finance/definition/publish', options);
  assert.equal(result.instance.modelId, 'finance'); assert.equal(result.instance.runtimeReadEnabled, false);
  assert.equal(result.instance.projectionScope, 'definition_only');
  assert.deepEqual(server.requests.slice(1).map(request => request.url), ['/models/finance/instance', '/models/finance/definition/publish']);
});

test('namespace paths cannot bypass binding, default reservations or definition-only scope', async () => {
  const connection = { ...entry(), guarded: true };
  for (const [path, options, target] of [
    ['/models/finance/definition', {}, connection],
    ['/models/manufacturing/definition', { modelId: 'finance' }, connection],
    ['/demo/reset', { modelId: 'finance' }, connection],
    ['/models/finance/context', { modelId: 'finance' }, connection],
    ['/models/oa-governance/definition', { modelId: 'oa-governance' }, connection],
    ['/models/finance/definition', { modelId: 'finance' }, { ...connection, guarded: false }]
  ]) await assert.rejects(requestSemanticInstance(target, path, options), error => error.requestAttempted === false);
});

test('wrong model receipt after a write remains uncertain instead of acknowledging publication', async t => {
  const item = entry();
  const server = await stub(t, (req, res) => {
    receipt(res, item); res.setHeader('x-semantic-model', req.url.endsWith('/instance') ? 'finance' : 'manufacturing');
    res.setHeader('x-semantic-model-protocol', '1'); res.end('{}');
  });
  await assert.rejects(requestSemanticInstance({ ...item, guarded: true, endpoint: `http://127.0.0.1:${server.port}` },
    '/models/finance/definition/publish', { modelId: 'finance', method: 'POST', body: { definition: {} } }), error => error.requestAttempted === true);
});

test('raw model context cannot access an authenticated bridge without registry admission', async t => {
  const server = await stub(t, (_req, res) => res.end('{}'));
  const item = { ...entry(), endpoint: `http://127.0.0.1:${server.port}` }; registry(t, [item]);
  await runWithSemanticModelWorkspace({ tenantId: item.tenantId }, 'unregistered', async () => {
    assert.equal((await getSemanticaModelDeployment()).reason, 'model_workspace_unregistered');
    assert.equal((await publishSemanticaModelDefinition({}, 'v1')).reason, 'model_workspace_unregistered');
  });
  assert.equal(server.requests.length, 0);
});

test('registered namespace bridge requires matching preflight, preserves CAS and never falls back to default paths', async t => {
  resetRuntimeState(['semantic_model_registry']);
  const item = entry();
  const server = await stub(t, (_req, res) => {
    receipt(res, item); res.setHeader('x-semantic-model', 'finance'); res.setHeader('x-semantic-model-protocol', '1');
    res.end(JSON.stringify({ status: 'not_published', modelId: 'finance', projectionScope: 'definition_only', runtimeReadEnabled: false }));
  });
  item.endpoint = `http://127.0.0.1:${server.port}`; registry(t, [item]);
  const role = getRole('executive'); const identityScope = { tenantId: item.tenantId, subjectId: 'synthetic-architect' };
  await within(item.tenantId, () => semanticModelRegistry.register({ role, identityScope, body: { id: 'finance', label: '财务模型', expectedRevision: 0 } }));
  await within(item.tenantId, () => semanticModelRegistry.withWorkspace({ role, identityScope, modelId: 'finance', work: async () => {
    const definition = { id: 'synthetic', objectTypes: [], relationshipTypes: [] };
    assert.equal((await publishSemanticaModelDefinition(definition, 'v1')).reason, 'model_deployment_unverified');
    assert.equal(server.requests.length, 0);
    const observed = await getSemanticaModelDeployment();
    const readCount = server.requests.length;
    assert.equal((await publishSemanticaModelDefinition(definition, 'v1', { expectedDeployment: { ...observed, instance: { ...observed.instance, deploymentId: 'other-deployment' } } })).requestAttempted, false);
    assert.equal(server.requests.length, readCount);
    await publishSemanticaModelDefinition(definition, 'v1', { expectedDeployment: observed });
    assert.equal(JSON.parse(server.requests.at(-1).body).expectedFingerprint, null);
    await publishSemanticaModelDefinition(definition, 'v2', { expectedDeployment: { ...observed, status: 'published', fingerprint: 'a'.repeat(20) } });
    assert.equal(JSON.parse(server.requests.at(-1).body).expectedFingerprint, 'a'.repeat(20));
    assert.ok(server.requests.every(request => request.url.startsWith('/models/finance/')));
  } }));
});

test('synthetic graph protocol requires explicit scope and graph receipt before transmitting facts', async t => {
  const item = entry(); let supported = false;
  const server = await stub(t, (_req, res) => {
    receipt(res, item); res.setHeader('x-semantic-model', 'finance'); res.setHeader('x-semantic-model-protocol', '1');
    if (supported) res.setHeader('x-semantic-graph-protocol', '1');
    res.end(JSON.stringify({ modelId: 'finance', projectionScope: 'synthetic_graph', runtimeReadEnabled: false, graphProtocol: 1 }));
  });
  const connection = { ...item, guarded: true, endpoint: `http://127.0.0.1:${server.port}` };
  for (const options of [{ modelId: 'finance' }, { modelId: 'finance', projectionScope: 'arbitrary' }]) {
    await assert.rejects(requestSemanticInstance(connection, '/models/finance/graph/ingest', options), error => error.requestAttempted === false);
  }
  assert.equal(server.requests.length, 0);
  const options = { modelId: 'finance', projectionScope: 'synthetic_graph', method: 'POST', body: { facts: ['synthetic-only'] } };
  await assert.rejects(requestSemanticInstance(connection, '/models/finance/graph/ingest', options), error => error.requestAttempted === false);
  assert.equal(server.requests.length, 1); assert.equal(server.requests[0].body, '');
  supported = true;
  const result = await requestSemanticInstance(connection, '/models/finance/graph/ingest', options);
  assert.equal(result.instance.projectionScope, 'synthetic_graph'); assert.equal(result.instance.runtimeReadEnabled, false);
  await assert.rejects(requestSemanticInstance(connection, '/models/finance/definition/publish', options), error => error.requestAttempted === false);
});

test('a foreign graph body cannot be accepted even if the response headers match', async t => {
  const item = entry();
  const server = await stub(t, (_req, res) => {
    receipt(res, item); res.setHeader('x-semantic-model', 'finance'); res.setHeader('x-semantic-model-protocol', '1'); res.setHeader('x-semantic-graph-protocol', '1');
    res.end(JSON.stringify({ modelId: 'production', projectionScope: 'synthetic_graph', runtimeReadEnabled: false, graphProtocol: 1 }));
  });
  await assert.rejects(requestSemanticInstance({ ...item, guarded: true, endpoint: `http://127.0.0.1:${server.port}` }, '/models/finance/graph',
    { modelId: 'finance', projectionScope: 'synthetic_graph' }), error => error.requestAttempted === true);
});

test('relationship protocol preflights before POST and permits only explicit bounded operations', async t => {
  const item = entry(); let supported = false;
  const server = await stub(t, (_req, res) => {
    receipt(res, item); res.setHeader('x-semantic-model', 'finance'); res.setHeader('x-semantic-model-protocol', '1');
    if (supported) res.setHeader('x-semantic-relationship-protocol', '1');
    res.end(JSON.stringify({ modelId: 'finance', projectionScope: 'synthetic_relationships', runtimeReadEnabled: false, relationshipProtocol: 1 }));
  });
  const connection = { ...item, guarded: true, endpoint: `http://127.0.0.1:${server.port}` };
  const path = '/models/finance/graph/relationships/materialize';
  const options = { modelId: 'finance', projectionScope: 'synthetic_relationships', method: 'POST', body: { confirmed: true, runId: 'synthetic-run' } };
  for (const [target, settings] of [[path, { ...options, projectionScope: 'synthetic_graph' }], [path, { ...options, projectionScope: 'definition_only' }],
    [path, { ...options, method: 'GET' }], ['/models/finance/graph/relationships/runs/run', options],
    ['/models/finance/graph/reset', options], ['/models/finance/graph/relationships/runs/run?other=1', { ...options, method: 'GET' }]]) {
    await assert.rejects(requestSemanticInstance(connection, target, settings), error => error.requestAttempted === false);
  }
  assert.equal(server.requests.length, 0);
  await assert.rejects(requestSemanticInstance(connection, path, options), error => error.requestAttempted === false);
  assert.equal(server.requests.length, 1); assert.equal(server.requests[0].body, '');
  supported = true;
  const result = await requestSemanticInstance(connection, path, options);
  assert.equal(result.instance.relationshipProtocol, 1); assert.equal(result.instance.projectionScope, 'synthetic_relationships');
  await requestSemanticInstance(connection, '/models/finance/graph/relationships/runs/synthetic-run', { modelId: 'finance', projectionScope: 'synthetic_relationships' });
  assert.equal(server.requests.at(-1).method, 'GET'); assert.equal(server.requests.at(-1).body, '');
});

test('relationship receipt cannot authorize foreign model, runtime reads or a different protocol', async t => {
  const item = entry(); let invalid = {};
  const server = await stub(t, (_req, res) => {
    receipt(res, item); res.setHeader('x-semantic-model', 'finance'); res.setHeader('x-semantic-model-protocol', '1'); res.setHeader('x-semantic-relationship-protocol', '1');
    res.end(JSON.stringify({ modelId: 'finance', projectionScope: 'synthetic_relationships', runtimeReadEnabled: false, relationshipProtocol: 1, ...invalid }));
  });
  const connection = { ...item, guarded: true, endpoint: `http://127.0.0.1:${server.port}` };
  for (const patch of [{ modelId: 'production' }, { runtimeReadEnabled: true }, { relationshipProtocol: 2 }, { projectionScope: 'synthetic_graph' }]) {
    invalid = patch;
    await assert.rejects(requestSemanticInstance(connection, '/models/finance/graph/relationships/runs/run',
      { modelId: 'finance', projectionScope: 'synthetic_relationships' }), error => error.requestAttempted === true);
  }
});

test('server dispatch guard runs after the network preflight and can prevent transmission', async t => {
  const item = entry(); const stages = [];
  const server = await stub(t, (req, res) => {
    stages.push(req.url.endsWith('/instance') ? 'probe' : 'transmission');
    receipt(res, item); res.setHeader('x-semantic-model', 'finance'); res.setHeader('x-semantic-model-protocol', '1'); res.setHeader('x-semantic-relationship-protocol', '1');
    res.end(JSON.stringify({ modelId: 'finance', projectionScope: 'synthetic_relationships', runtimeReadEnabled: false, relationshipProtocol: 1 }));
  });
  const connection = { ...item, guarded: true, endpoint: `http://127.0.0.1:${server.port}` };
  const options = { modelId: 'finance', projectionScope: 'synthetic_relationships', method: 'POST', body: { confirmed: true },
    beforeDispatch: async () => { stages.push('guard'); throw new Error('Synthetic revocation, never disclose this detail'); } };
  await assert.rejects(requestSemanticInstance(connection, '/models/finance/graph/relationships/materialize', options),
    error => error.requestAttempted === false && error.message === 'service_unavailable');
  assert.deepEqual(stages, ['probe', 'guard']); assert.equal(server.requests[0].body, '');
  stages.length = 0;
  await requestSemanticInstance(connection, '/models/finance/graph/relationships/materialize', { ...options, beforeDispatch: async () => stages.push('guard') });
  assert.deepEqual(stages, ['probe', 'guard', 'transmission']);
});

test('definition bridge forwards a trusted dispatch guard after real HTTP model preflight', async t => {
  resetRuntimeState(['semantic_model_registry']);
  const item = entry(); const stages = [];
  const server = await stub(t, (req, res) => {
    stages.push(req.url.endsWith('/instance') ? 'probe' : 'write');
    receipt(res, item); res.setHeader('x-semantic-model', 'finance'); res.setHeader('x-semantic-model-protocol', '1');
    res.end(JSON.stringify({ status: 'published', modelId: 'finance', projectionScope: 'definition_only', runtimeReadEnabled: false }));
  });
  item.endpoint = `http://127.0.0.1:${server.port}`; registry(t, [item]);
  const identityScope = { tenantId: item.tenantId, subjectId: 'synthetic-publisher' }; const role = getRole('executive');
  await runWithSemanticTenant(identityScope, () => semanticModelRegistry.register({ role, identityScope, body: { id: 'finance', label: '合成发布模型', expectedRevision: 0 } }));
  const expectedDeployment = { status: 'not_published', modelId: 'finance', projectionScope: 'definition_only', runtimeReadEnabled: false,
    instance: { tenantId: item.tenantId, deploymentId: item.deploymentId, modelId: 'finance', modelProtocol: 1, identityVerified: true } };
  const result = await runWithSemanticTenant(identityScope, () => semanticModelRegistry.withWorkspace({ role, identityScope, modelId: 'finance', work: () =>
    publishSemanticaModelDefinition({ id: 'synthetic', objectTypes: [], relationshipTypes: [] }, 'synthetic-v1', { expectedDeployment,
      beforeDispatch: async () => { stages.push('guard'); throw new Error('Do not disclose synthetic reason'); } }) }));
  assert.equal(result.status, 'unavailable'); assert.equal(result.requestAttempted, false);
  assert.deepEqual(stages, ['probe', 'guard']); assert.equal(server.requests.length, 1); assert.equal(server.requests[0].body, '');
  assert.doesNotMatch(JSON.stringify(result), /Do not disclose/u);
});

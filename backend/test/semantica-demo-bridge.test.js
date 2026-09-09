import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { runMockScenario } from '../src/services/mock-scenario-service.js';
import { getSemanticaModelDiscovery, publishSemanticaModelDefinition, syncMockScenarioToSemantica, validateSemanticaModelDefinition } from '../src/services/semantica-demo-bridge-service.js';

async function withSemanticStub(run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ method: req.method, path: req.url, body });
      if (req.method === 'GET' && req.url === '/demo/model-candidates') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ engine: 'semantica', status: 'observed', graph: { node_count: 4, edge_count: 3 }, observedRunCount: 1, candidateObjects: [{ id: 'QualityEvent' }], candidateRelationships: [{ from: 'TestResult', to: 'QualityEvent' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/demo/model-definition/validate') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ engine: 'semantica', status: 'passed', validation: { status: 'passed' } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/demo/model-definition/publish') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ engine: 'semantica', status: 'published', deployment: { id: body.definition.id, version: body.definition.version, objectCount: body.definition.objectTypes.length, relationshipCount: body.definition.relationshipTypes.length, fingerprint: 'fixture' } }));
        return;
      }
      const systems = [...new Set((body.facts || []).map((fact) => fact.sourceSystem))].sort();
      const response = {
        engine: 'semantica', status: 'verified', ingestedFacts: (body.facts || []).length,
        graph: { node_count: 11, edge_count: 24 },
        run: { runId: body.runId, facts: (body.facts || []).length, systems },
        validation: { facts_have_provenance: true, expected_systems_present: true, cross_system_context_built: true, all_facts_simulated: true, passed: true }
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const originalEndpoint = process.env.SEMANTIC_CONTEXT_ENDPOINT;
  const originalEnabled = process.env.SEMANTICA_DEMO_BRIDGE_ENABLED;
  process.env.SEMANTIC_CONTEXT_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.SEMANTICA_DEMO_BRIDGE_ENABLED = 'true';
  try {
    return await run(requests);
  } finally {
    if (originalEndpoint === undefined) delete process.env.SEMANTIC_CONTEXT_ENDPOINT; else process.env.SEMANTIC_CONTEXT_ENDPOINT = originalEndpoint;
    if (originalEnabled === undefined) delete process.env.SEMANTICA_DEMO_BRIDGE_ENABLED; else process.env.SEMANTICA_DEMO_BRIDGE_ENABLED = originalEnabled;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('mock scenario only sends synthetic, run-scoped facts to local Semantica', async () => {
  const started = runMockScenario('quality_batch_exception', 'executive');
  assert.ok(started.run);
  await withSemanticStub(async (requests) => {
    const result = await syncMockScenarioToSemantica(started.run.id);
    assert.equal(result.status, 'verified');
    assert.equal(result.validation.passed, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/demo/ingest');
    assert.equal(requests[0].body.runId, started.run.id);
    assert.deepEqual(requests[0].body.expectedSystems, ['LIMS', 'QMS', 'MES', 'OA']);
    assert.ok(requests[0].body.facts.every((fact) => fact.simulated === true && fact.runId === started.run.id));
    assert.deepEqual([...new Set(requests[0].body.facts.map((fact) => fact.sourceSystem))].sort(), ['LIMS', 'MES', 'OA', 'QMS']);
  });
});

test('bridge rejects non-local semantic endpoints without sending facts', async () => {
  const originalEndpoint = process.env.SEMANTIC_CONTEXT_ENDPOINT;
  const originalEnabled = process.env.SEMANTICA_DEMO_BRIDGE_ENABLED;
  process.env.SEMANTIC_CONTEXT_ENDPOINT = 'https://semantic.example.test';
  process.env.SEMANTICA_DEMO_BRIDGE_ENABLED = 'true';
  try {
    const result = await syncMockScenarioToSemantica('SIM-RUN-does-not-matter');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'unsafe_endpoint');
  } finally {
    if (originalEndpoint === undefined) delete process.env.SEMANTIC_CONTEXT_ENDPOINT; else process.env.SEMANTIC_CONTEXT_ENDPOINT = originalEndpoint;
    if (originalEnabled === undefined) delete process.env.SEMANTICA_DEMO_BRIDGE_ENABLED; else process.env.SEMANTICA_DEMO_BRIDGE_ENABLED = originalEnabled;
  }
});

test('model discovery returns only Semantica candidate structure from the local boundary', async () => {
  await withSemanticStub(async (requests) => {
    const result = await getSemanticaModelDiscovery();
    assert.equal(result.status, 'observed');
    assert.equal(result.graph.node_count, 4);
    assert.deepEqual(result.candidateObjects, [{ id: 'QualityEvent' }]);
    assert.deepEqual(requests.map((item) => [item.method, item.path]), [['GET', '/demo/model-candidates']]);
  });
});

test('model deployment sends a governed definition, not graph facts', async () => {
  const model = { id: 'oa-governance', code: 'OA-META-001', objectTypes: [{ id: 'QualityEvent', semanticType: 'QualityEvent', coreObject: 'RawMaterial', key: 'event_id', fields: ['event_id'], sourceSystems: ['QMS'] }], relationshipTypes: [] };
  await withSemanticStub(async (requests) => {
    const validation = await validateSemanticaModelDefinition(model);
    const deployment = await publishSemanticaModelDefinition(model, 'mm-oa-2026.08.26');
    assert.equal(validation.status, 'passed');
    assert.equal(deployment.status, 'published');
    assert.deepEqual(requests.map((item) => [item.method, item.path]), [['POST', '/demo/model-definition/validate'], ['POST', '/demo/model-definition/publish']]);
    assert.ok(requests.every((item) => item.body.definition && !Object.hasOwn(item.body.definition, 'facts')));
  });
});

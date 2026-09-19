import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import http from 'node:http';
import { Readable } from 'node:stream';
import { readMockOnboardingSource, observeMockOnboardingPortsForTest } from '../src/services/mock-onboarding-source-service.js';
import { installOfflineNetworkGuard } from '../../scripts/lib/offline-network-guard.mjs';
import { createMockOnboardingOntologyAdapter } from '../src/services/mock-onboarding-ontology-adapter.js';
import { discoverSchemasFromAttachments } from '../src/services/semantic-schema-discovery-service.js';
import { dictionary } from '../../examples/knowledge/dual-agent-mock/input-materials.mjs';
import { seedTenantIAM } from './helpers/tenant-iam-fixture.js';
import { runWithIAMStoreContext } from '../src/services/iam-store.js';
import { ontologyQueryFingerprint } from '../src/services/ontology-read-plan-service.js';

const request = { scenarioId: 'fulfillment', tenantId: 'mock-onboarding-a', projectId: 'mock-onboarding-source-test' };
async function withAdapter(work) {
  seedTenantIAM(request.tenantId, ['admin@demo.local']);
  const scope = { tenantId: request.tenantId, subjectId: 'admin@demo.local' };
  const discovered = discoverSchemasFromAttachments({ attachments: [{ id: 'dict', name: 'dictionary.json', mimeType: 'application/json' }], reports: [{ attachmentId: 'dict', status: 'content_scanned', structuredSchemaCandidate: true }], documents: [{ attachmentId: 'dict', text: JSON.stringify(dictionary) }] });
  const draft = { ...discovered, accessPolicies: discovered.objectTypes.map(type => ({ objectType: type.id, roles: ['executive'], effect: 'allow', condition: 'iam_scope' })) };
  const previous = process.env.ONTOLOGY_RUNTIME_GRANTS_JSON;
  process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ [request.tenantId]: { executive: { objects: Object.fromEntries(dictionary.tables.map(table => [table.name, { system: table.system, fields: table.fields.map(field => field.name), classifications: ['internal'] }])) } } });
  try {
    const source = await readMockOnboardingSource(request);
    const args = { source, draft, scope, roleId: 'executive' };
    const adapter = createMockOnboardingOntologyAdapter(args);
    const type = draft.objectTypes.find(item => item.id === 'SalesOrderLine');
    const query = { schemaVersion: 'ontology-query.v1', objectType: type.id, fields: type.fields, filter: { field: 'order_id', values: ['ORD-T900'] }, limit: 100 };
    await runWithIAMStoreContext(() => work({ args, adapter, query }), request.tenantId);
  } finally { if (previous === undefined) delete process.env.ONTOLOGY_RUNTIME_GRANTS_JSON; else process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = previous; }
}

test('ontology adapter projects only requested fields and binds coverage to one immutable snapshot', async () => withAdapter(({ args, adapter, query }) => {
  query.fields = ['line_id', 'qty'];
  const result = adapter.query(query);
  assert.equal(result.records.length, 2); assert.equal(result.queryCoverage.complete, true);
  assert.equal(result.queryCoverage.queryFingerprint, ontologyQueryFingerprint(query));
  assert.equal(result.queryCoverage.snapshotId, args.source.snapshotId);
  assert.deepEqual(Object.keys(result.records[0].payload), query.fields);
  assert.equal(result.published, false); assert.equal(result.synthetic, true);
  args.source.records.length = 0; args.draft.objectTypes.length = 0; args.scope.tenantId = 'other';
  result.records[0].payload.qty = 999;
  assert.notEqual(adapter.query(query).records[0].payload.qty, 999);
  assert.equal(adapter.query({ ...query, filter: { field: 'order_id', values: ['NOT_FOUND'] } }).records.length, 0);
}));

test('ontology adapter refuses unknown fields, query extensions, unsafe values and false completeness', async () => withAdapter(({ adapter, query }) => {
  for (const patch of [{ fields: ['secret'] }, { fields: ['qty', 'qty'] }, { endpoint: 'https://invalid' }, { limit: 0 }, { limit: 101 }, { filter: { field: 'secret', values: ['ORD-T900'] } }, { filter: { field: 'order_id', values: [null] } }, { filter: { field: 'order_id', values: ['ORD-T900'], sql: 'anything' } }]) {
    assert.throws(() => adapter.query({ ...query, ...patch }), { message: 'MOCK_ONTOLOGY_QUERY_INVALID' });
  }
  assert.throws(() => adapter.query({ ...query, limit: 1 }), { message: 'MOCK_ONTOLOGY_QUERY_INCOMPLETE' });
}));

test('ontology adapter rechecks grants and IAM even when no rows match', async () => withAdapter(({ adapter, query }) => {
  process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = '{}';
  assert.throws(() => adapter.query({ ...query, filter: { field: 'order_id', values: [] } }), { message: 'READ_OBJECT_FORBIDDEN' });
  seedTenantIAM(request.tenantId, []);
  assert.throws(() => adapter.query(query), { message: 'MOCK_ONTOLOGY_ACCESS_DENIED' });
}));

test('ontology adapter rejects foreign tenants, wrong systems, conflicts and unauthorized organizations', async () => withAdapter(({ args, query }) => {
  const foreign = structuredClone(args); foreign.source.records[0].tenantId = 'foreign';
  assert.throws(() => createMockOnboardingOntologyAdapter(foreign), { message: 'MOCK_ONTOLOGY_SOURCE_INVALID' });
  for (const [patch, error] of [[{ system: 'ERP' }, 'MOCK_ONTOLOGY_SOURCE_MISMATCH'], [{ organizationId: 'unknown' }, 'READ_RECORD_SCOPE'], [{ classification: 'secret' }, 'READ_RECORD_SCOPE']]) {
    const changed = structuredClone(args); Object.assign(changed.source.records.find(row => row.objectType === 'SalesOrderLine'), patch);
    assert.throws(() => createMockOnboardingOntologyAdapter(changed).query(query), { message: error });
  }
  const changed = structuredClone(args); const duplicate = structuredClone(changed.source.records.find(row => row.objectType === 'SalesOrderLine'));
  duplicate.payload.qty += 1; changed.source.records.push(duplicate);
  assert.throws(() => createMockOnboardingOntologyAdapter(changed).query(query), { message: 'READ_RECORD_CONFLICT' });
}));

test('ontology adapter is blocked in production including adapters created before the switch', async () => withAdapter(({ args, adapter, query }) => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(() => createMockOnboardingOntologyAdapter(args), { message: 'MOCK_ONTOLOGY_SANDBOX_ONLY' });
    assert.throws(() => adapter.query(query), { message: 'MOCK_ONTOLOGY_SANDBOX_ONLY' });
  } finally { process.env.NODE_ENV = previous; }
}));
const replaceResponse = (original, transform) => (url, options, callback) => original(url, options, async response => {
  const chunks = []; for await (const chunk of response) chunks.push(chunk);
  const value = transform(Buffer.concat(chunks).toString('utf8'));
  const replacement = Readable.from([Buffer.from(value)]);
  replacement.statusCode = response.statusCode; replacement.headers = response.headers;
  callback(replacement);
});

test('local Mock source reads two independent fixtures through bounded HTTP pages', async () => {
  for (const [scenarioId, count, pages, systems] of [['fulfillment', 34, 3, 6], ['quality_incident', 77, 5, 7]]) {
    const result = await readMockOnboardingSource({ ...request, scenarioId });
    assert.equal(result.sourceKind, 'local_mock_http'); assert.equal(result.protocol, 'mock-onboarding-query.v1');
    assert.equal(result.records.length, count); assert.equal(result.pageCount, pages); assert.equal(result.requests, pages);
    assert.equal(result.systems.length, systems); assert.ok(result.records.every(row => row.tenantId === request.tenantId));
    assert.ok(!JSON.stringify(result).includes('Bearer'));
  }
});

test('network guard permits only live local source ports and revokes them after cleanup', async () => {
  const guard = installOfflineNetworkGuard(); const ports = [];
  const stop = observeMockOnboardingPortsForTest(port => { ports.push(port); return guard.allowPort(port); });
  try {
    await readMockOnboardingSource(request);
    await assert.rejects(readMockOnboardingSource({ ...request, faultMode: 'timeout' }), { code: 'MOCK_SOURCE_TIMEOUT' });
    await new Promise(resolve => setTimeout(resolve, 200)); // No deferred pool reconnect after revoked port.
    assert.equal(ports.length, 2); assert.equal(guard.deniedAttempts, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${ports[0]}/records?cursor=0`), { code: 'MOCK_NETWORK_BLOCKED' });
  } finally { stop(); guard.restore(); }
});

test('faults reject the entire read including partial pages, then permit a clean retry', async () => {
  for (const [faultMode, code, pages] of [
    ['rate_limited', 'RATE_LIMITED', 0], ['timeout', 'TIMEOUT', 1], ['malformed', 'MALFORMED', 0],
    ['cross_tenant', 'TENANT_MISMATCH', 2], ['incomplete', 'INCOMPLETE', 1]
  ]) {
    await assert.rejects(readMockOnboardingSource({ ...request, faultMode }), error => {
      assert.equal(error.code, `MOCK_SOURCE_${code}`); assert.equal(error.pageCount, pages);
      assert.equal(error.records, undefined); assert.ok(!error.message.includes('synthetic-foreign-tenant')); return true;
    });
  }
  const result = await readMockOnboardingSource(request); assert.equal(result.records.length, 34);
  // Schema validation belongs to the onboarding service, not this transport.
  const drift = await readMockOnboardingSource({ ...request, faultMode: 'schema_drift' });
  assert.equal(drift.records[0].payload.undeclared_mock_field, '模拟新增字段');
});

test('unauthenticated malformed local HTTP request cannot crash the source or read data', async () => {
  let probe;
  const stop = observeMockOnboardingPortsForTest(port => {
    probe = new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port }); let body = '';
      socket.on('connect', () => socket.write('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
      socket.on('data', data => { body += data; }); socket.on('error', reject); socket.on('end', () => resolve(body));
    });
  });
  try {
    assert.equal((await readMockOnboardingSource(request)).records.length, 34);
    const result = await probe; assert.match(result, /403 Forbidden/); assert.ok(!result.includes('payload'));
  } finally { stop(); }
});

test('transport refuses forged fingerprints, drifted snapshots, cursor loops and duplicate records', async () => {
  const original = http.request;
  const mutations = [
    [page => { page.queryFingerprint = 'wrong-query'; }, 'CONTRACT_INVALID'],
    [page => { page.snapshotId = 'old-snapshot'; }, 'INCOMPLETE'],
    [page => { page.nextCursor = 0; }, 'INCOMPLETE'],
    [page => { page.records[1] = page.records[0]; }, 'INCOMPLETE'],
    [page => { page.coverage.totalRecords = 900; }, 'INCOMPLETE'],
    [page => { page.records[0].system = 'UNKNOWN'; }, 'CONTRACT_INVALID'],
    [page => { page.records[0].occurredAt = 'not-a-date'; }, 'CONTRACT_INVALID']
  ];
  try {
    for (const [mutate, code] of mutations) {
      http.request = replaceResponse(original, text => { const page = JSON.parse(text); mutate(page); return JSON.stringify(page); });
      await assert.rejects(readMockOnboardingSource(request), { code: `MOCK_SOURCE_${code}` });
    }
  } finally { http.request = original; }
});

test('source fails closed for oversized response, redirect, transport failure, invalid mode and production', async () => {
  const original = http.request;
  try {
    http.request = replaceResponse(original, () => 'x'.repeat(65537));
    await assert.rejects(readMockOnboardingSource(request), { code: 'MOCK_SOURCE_CONTRACT_INVALID' });
    http.request = (url, options, callback) => original(url, options, response => {
      response.statusCode = 302; response.headers.location = 'https://example.invalid/never-contact'; callback(response);
    });
    await assert.rejects(readMockOnboardingSource(request), error => error.code === 'MOCK_SOURCE_TRANSPORT_FAILED' && error.requests === 1);
    http.request = (_url, options) => { assert.equal(options.agent, false); throw new Error('sensitive upstream body'); };
    await assert.rejects(readMockOnboardingSource(request), error => error.code === 'MOCK_SOURCE_TRANSPORT_FAILED' && !error.message.includes('sensitive'));
  } finally { http.request = original; }
  await assert.rejects(readMockOnboardingSource({ ...request, faultMode: 'http://localhost:18080' }), { code: 'MOCK_SOURCE_CONTRACT_INVALID' });
  await assert.rejects(readMockOnboardingSource({ ...request, scenarioId: '../private' }), { code: 'MOCK_SOURCE_CONTRACT_INVALID' });
  const previous = process.env.NODE_ENV;
  try { process.env.NODE_ENV = 'production'; await assert.rejects(readMockOnboardingSource(request), { code: 'MOCK_SOURCE_SANDBOX_ONLY' }); }
  finally { process.env.NODE_ENV = previous; }
});

test('concurrent isolated sources enforce the per-process cap without mixing scopes', async () => {
  const requests = [0, 1, 2, 3, 4].map(i => readMockOnboardingSource({ ...request, projectId: `mock-onboarding-concurrent-${i}`, tenantId: `synthetic-${i}` }));
  const results = await Promise.allSettled(requests);
  assert.equal(results[4].status, 'rejected'); assert.equal(results[4].reason.code, 'MOCK_SOURCE_BUSY');
  for (const [i, result] of results.slice(0, 4).entries()) {
    assert.equal(result.status, 'fulfilled'); assert.ok(result.value.records.every(row => row.tenantId === `synthetic-${i}`));
  }
});

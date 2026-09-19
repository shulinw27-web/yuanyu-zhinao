// Integration test only: real local connector HTTP + real publication gates;
// Semantica deployment receipt is an explicit test double, NEVER a live receipt.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { installOfflineNetworkGuard } from './lib/offline-network-guard.mjs';
import { startMockOnboardingHTTP } from './lib/mock-onboarding-http.mjs';
import { prepareReviewedCalculationFixture } from './lib/mock-onboarding-reviewed-fixture.mjs';
import { createMockEventReplay } from './lib/mock-event-replay.mjs';
import { expected, complexReplayCases } from '../examples/knowledge/dual-agent-mock/expected.mjs';
if (process.env.NODE_ENV === 'production') throw new Error('Not available in production.');
Object.assign(process.env, { NODE_ENV: 'test', NODE_TEST_CONTEXT: 'mock-lifecycle-runner', RUNTIME_STORE_DRIVER: 'memory',
  IDENTITY_SESSION_STORE_DRIVER: 'runtime', IAM_STORE_DRIVER: 'runtime', SEMANTIC_GOVERNANCE_STORE_DRIVER: 'runtime',
  IDENTITY_PROVIDERS_FILE: '', DEMO_ALLOW_ROLE_HEADER: 'false', TENANT_RUNTIME_CONTROL_REQUIRED: 'false', SEMANTICA_DEMO_BRIDGE_ENABLED: 'false' });
const guard = installOfflineNetworkGuard(); let api; let connector; let revoke;
const checks = []; let calls = 0;
const check = async (name, work) => { await work(); checks.push({ name, passed: true }); };
try {
  api = await startMockOnboardingHTTP(guard); const fixture = await prepareReviewedCalculationFixture(api);
  const { runWithIAMStoreContext } = await import('../backend/src/services/iam-store.js');
  const { runWithSemanticTenant } = await import('../backend/src/services/semantic-tenant-context.js');
  const { getRole } = await import('../backend/src/services/authorization-service.js');
  const { getOAMetaModelDraft, saveOAMetaModelDraft, validateOAMetaModelDraft, simulateBuildOAMetaModel } = await import('../backend/src/services/meta-model-service.js');
  const { runOntologyReadReplay, publishGovernedOntology } = await import('../backend/src/services/ontology-runtime-service.js');
  const { getPublishedAgentOntology, runPublishedOntologyRead } = await import('../backend/src/services/published-ontology-agent-service.js');
  const { readMockOnboardingSource } = await import('../backend/src/services/mock-onboarding-source-service.js');
  const { createMockOnboardingOntologyAdapter } = await import('../backend/src/services/mock-onboarding-ontology-adapter.js');
  const { semanticFingerprint } = await import('../backend/src/services/semantic-model-fingerprint.js');
  const scope = { tenantId: 'mock-onboarding-a', subjectId: 'admin@demo.local', source: 'test' }; const role = getRole('executive');
  const within = work => runWithIAMStoreContext(() => runWithSemanticTenant(scope, work), scope.tenantId);
  const grants = JSON.parse(process.env.ONTOLOGY_RUNTIME_GRANTS_JSON); grants[scope.tenantId].executive.metadata = true; process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(grants);
  const source = await readMockOnboardingSource({ scenarioId: 'fulfillment', tenantId: scope.tenantId, projectId: fixture.projectId });
  let rows = structuredClone(source.records); let fault = 'none';
  const draft = await within(() => getOAMetaModelDraft()); const plan = draft.scenario.readPlans[0];
  const token = randomUUID(); process.env.MOCK_LIFECYCLE_TOKEN = token;
  connector = createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) return send(403, { code: 'FORBIDDEN' });
    try {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) return send(413, {}); }
      const body = JSON.parse(raw); calls++;
      if (body.access?.tenantId !== scope.tenantId || body.access?.subjectId !== scope.subjectId || body.access?.roleId !== role.id) return send(403, {});
      const type = draft.objectTypes.find(item => item.id === body.query?.objectType);
      if (type?.sourceSystems[0]?.toLowerCase() !== body.systemId) return send(400, {});
      const snapshotId = `synthetic-lifecycle-${createHash('sha256').update(JSON.stringify(rows)).digest('hex')}`;
      const response = await within(() => createMockOnboardingOntologyAdapter({ source: { ...source, snapshotId, records: rows }, draft, scope, roleId: role.id }).query(body.query));
      if (fault === 'incomplete') response.queryCoverage.complete = false;
      return send(200, response);
    } catch { return send(409, { code: 'SYNTHETIC_QUERY_REJECTED' }); }
  });
  await new Promise(resolve => connector.listen(0, '127.0.0.1', resolve)); const port = connector.address().port; revoke = guard.allowPort(port);
  process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = JSON.stringify(Object.fromEntries([...new Set(draft.objectTypes.flatMap(type => type.sourceSystems))].map(system => [system.toLowerCase(), { endpoint: `http://127.0.0.1:${port}`, tokenEnv: 'MOCK_LIFECYCLE_TOKEN' }])));
  await check('unpublished onboarding draft is unavailable to business Agent', async () => { assert.equal(await within(() => getPublishedAgentOntology(role.id, scope)), null); });
  await within(async () => {
    const validation = await validateOAMetaModelDraft(role); assert.equal(validation.draft.validation.status, 'passed', JSON.stringify(validation.draft.validation));
    await simulateBuildOAMetaModel(role);
  });
  await check('publication requires independent positive and negative replay', async () => {
    assert.equal((await within(() => publishGovernedOntology({ role, identityScope: scope }))).code, 'PUBLICATION_REPLAY_REQUIRED');
    const cases = complexReplayCases(plan.id, rows);
    const replay = await within(() => runOntologyReadReplay({ role, identityScope: scope, body: { candidateFingerprint: semanticFingerprint(draft), cases } }));
    assert.equal(replay.status, 'passed');
  });
  await check('governed publication with explicitly simulated deployment receipt succeeds', async () => {
    const result = await within(() => publishGovernedOntology({ role, identityScope: scope, deploy: async (candidate, version) => ({ status: 'published', deployment: { status: 'published', sourceFingerprint: semanticFingerprint(candidate), version } }) }));
    assert.equal(result.error, undefined, result.error);
  });
  const ontology = await within(() => getPublishedAgentOntology(role.id, scope));
  const read = () => within(() => runPublishedOntologyRead({ ontology, roleId: role.id, scope, target: fixture.target, planId: plan.id, input: '核对当前订单的库存和授信', allowModelAnalysis: false }));
  await check('published business read uses real connector HTTP and matches independent totals', async () => {
    const result = await read(); assert.ok(calls > 0); assert.deepEqual(Object.fromEntries(result.results.map(item => [item.id, item.value])), expected);
  });
  await check('sixteen independent business branches run through published engine and connector HTTP', async () => {
    for (const item of complexReplayCases(plan.id, source.records)) {
      rows = structuredClone(item.records); const result = await read();
      if (item.expectedError) assert.equal(result.results, undefined, item.label);
      else assert.deepEqual(Object.fromEntries(result.results.map(output => [output.id, output.value])), item.expected, item.label);
    }
    rows = structuredClone(source.records);
  });
  await check('reordered duplicate delivery is idempotent and conflicting delivery is rejected', async () => {
    rows = [...structuredClone(source.records).reverse(), structuredClone(source.records.find(row => row.id === 'CR-T1'))];
    assert.deepEqual(Object.fromEntries((await read()).results.map(output => [output.id, output.value])), expected);
    rows.at(-1).payload.amount += 1; assert.equal((await read()).results, undefined);
    rows = structuredClone(source.records);
  });
  await check('source changes update business facts without republishing the model', async () => {
    let replay = createMockEventReplay({ tenantId: scope.tenantId, projectId: fixture.projectId, records: rows });
    const order = rows.find(row => row.id === 'ORD-T900');
    const event = { eventId: 'order-amount-v2', tenantId: scope.tenantId, projectId: fixture.projectId, system: order.system, objectType: order.objectType,
      id: order.id, revision: 2, operation: 'upsert', record: { ...order, version: 'v2', payload: { ...order.payload, amount: 20000 } } };
    replay.apply([event]); rows = replay.snapshot().records;
    const result = await read(); assert.equal(result.results.find(item => item.id === 'creditGap').value, 11500);
    const checkpoint = JSON.parse(JSON.stringify(replay.checkpoint())); replay = createMockEventReplay(checkpoint);
    replay.apply([event, { ...event, eventId: 'order-amount-v1-late', revision: 1, record: order }]);
    rows = replay.snapshot().records;
    assert.equal((await read()).results.find(item => item.id === 'creditGap').value, 11500);
    const removal = { ...event, eventId: 'order-deleted-v3', revision: 3, operation: 'delete' }; delete removal.record;
    replay.apply([removal]); replay = createMockEventReplay(JSON.parse(JSON.stringify(replay.checkpoint())));
    replay.apply([event]); rows = replay.snapshot().records;
    assert.equal((await read()).results, undefined, 'deleted order must not be resurrected by an old delivery');
    replay.apply([{ ...event, eventId: 'order-restored-v4', revision: 4 }]); rows = replay.snapshot().records;
    assert.equal((await read()).results.find(item => item.id === 'creditGap').value, 11500);
  });
  await check('draft rule changes cannot replace the published business rule', async () => {
    const changed = structuredClone(draft); changed.scenario.readPlans[0].outputs[0].expression = { op: 'literal', value: 999 };
    assert.equal((await within(() => saveOAMetaModelDraft(changed, role))).error, undefined);
    const result = await read(); assert.equal(result.results.find(item => item.id === 'orderAmountCny').value, 20000);
  });
  await check('incomplete connector response cannot produce business metrics', async () => { fault = 'incomplete'; const result = await read(); assert.equal(result.results, undefined); fault = 'none'; });
  await check('runtime revocation blocks old business handles', async () => { process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = '{}'; const result = await read(); assert.equal(result.results, undefined); });
  console.log(JSON.stringify({ passed: true, checks, connectorRequests: calls, modelInvoked: false, humanPlanAndTestGrants: true,
    deployment: 'TEST_DOUBLE_RECEIPT_NOT_REAL_SEMANTICA', businessRead: 'published_engine_not_natural_language_understanding', realSystemsVerified: false }, null, 2));
} finally { if (connector?.listening) await new Promise(resolve => { connector.close(resolve); connector.closeAllConnections(); }); revoke?.(); if (api) await api.close(); guard.restore(); }

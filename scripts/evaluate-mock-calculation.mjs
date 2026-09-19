import assert from 'node:assert/strict';
import { installOfflineNetworkGuard } from './lib/offline-network-guard.mjs';
import { startMockOnboardingHTTP } from './lib/mock-onboarding-http.mjs';
import { prepareReviewedCalculationFixture } from './lib/mock-onboarding-reviewed-fixture.mjs';
import { expected } from '../examples/knowledge/dual-agent-mock/expected.mjs'; // Assertions only.

if (process.env.NODE_ENV === 'production') throw new Error('Not available in production.');
Object.assign(process.env, { NODE_ENV: 'test', NODE_TEST_CONTEXT: 'mock-calculation-runner', RUNTIME_STORE_DRIVER: 'memory',
  IDENTITY_SESSION_STORE_DRIVER: 'runtime', IAM_STORE_DRIVER: 'runtime', SEMANTIC_GOVERNANCE_STORE_DRIVER: 'runtime',
  IDENTITY_PROVIDERS_FILE: '', DEMO_ALLOW_ROLE_HEADER: 'false', TENANT_RUNTIME_CONTROL_REQUIRED: 'false' });
const guard = installOfflineNetworkGuard(); let api;
const checks = [];
const check = async (name, work) => { await work(); checks.push({ name, passed: true }); };
try {
  api = await startMockOnboardingHTTP(guard);
  const fixture = await prepareReviewedCalculationFixture(api);
  const path = `/${fixture.projectId}/calculations`; const tenant = 'mock-onboarding-a';
  const metadata = await api.call(tenant, path);
  await check('authenticated project lists saved human-reviewed plan', () => { assert.equal(metadata.status, 200); assert.equal(metadata.body.blockers.length, 0); });
  const body = { expectedRevision: metadata.body.revision, candidateFingerprint: metadata.body.candidateFingerprint, planId: metadata.body.plans[0].id, target: fixture.target };
  const actual = await api.call(tenant, path, body);
  await check('fresh HTTP synthetic source calculates independent business totals without records or publication', () => {
    assert.equal(actual.status, 200); assert.equal(actual.body.status, 'calculated');
    assert.deepEqual(Object.fromEntries(actual.body.results.map(item => [item.id, item.value])), expected);
    assert.equal(actual.body.records, undefined); assert.equal(actual.body.datasets, undefined); assert.equal(actual.body.published, false); assert.equal(actual.body.executionAuthorized, false);
  });
  await check('another tenant cannot read or run a project calculation', async () => {
    assert.equal((await api.call('mock-onboarding-b', path)).status, 404); assert.equal((await api.call('mock-onboarding-b', path, body)).status, 404);
  });
  await check('stale model and stale project revisions are rejected', async () => {
    assert.equal((await api.call(tenant, path, { ...body, candidateFingerprint: 'old' })).body.code, 'MOCK_CALCULATION_DRAFT_STALE');
    assert.equal((await api.call(tenant, path, { ...body, expectedRevision: 0 })).status, 409);
  });
  await check('missing root fails rather than returning zero', async () => { assert.equal((await api.call(tenant, path, { ...body, target: 'MISSING' })).body.code, 'MOCK_CALCULATION_REJECTED'); });
  await check('request cannot grant itself permissions or inject a source', async () => { assert.equal((await api.call(tenant, path, { ...body, endpoint: 'https://example.invalid' })).status, 400); });
  await check('revoking deployment grants blocks calculation', async () => { process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = '{}'; assert.equal((await api.call(tenant, path, body)).status, 403); });
  assert.equal(guard.deniedAttempts, 0);
  console.log(JSON.stringify({ passed: true, mode: 'synthetic_http_draft_calculation', modelInvoked: false, modelPublished: false,
    humanPlanAndTestGrants: true, checks, actual: actual.body.results, notTested: ['AI plan generation', 'Semantica publication', 'Zhinao conversation', 'real enterprise connectors'] }, null, 2));
} finally { if (api) await api.close(); guard.restore(); }

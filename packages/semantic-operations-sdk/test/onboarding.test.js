import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticOperationsClient } from '../src/index.js';

test('onboarding SDK uses verified session headers, encoded project IDs and revision payloads', async t => {
  const previous = { fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  t.after(() => Object.assign(globalThis, previous));
  const calls = [];
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/auth/local/login') ? { sessionId: 'trusted-session', user: { roleId: 'executive' } } : { project: { id: 'project /1', revision: 2 } }), { status: 200 });
  };
  const client = createSemanticOperationsClient({ baseUrl: 'http://mock.test/api', platform: 'onboarding-test' });
  await client.loginLocal({ account: 'local-test', password: 'fixture-only' });
  await client.onboarding();
  await client.createOnboardingProject({ scenarioId: 'fulfillment', name: '合成接入项目' });
  await client.onboardingProject('project /1');
  const payload = { expectedRevision: 1, kind: 'requirements', name: 'requirements.txt', text: '合成材料内容' };
  await client.saveOnboardingMaterial('project /1', payload);
  const connectionPayload = { expectedRevision: 2, faultMode: 'schema_drift' };
  await client.testOnboardingConnection('project /1', connectionPayload);
  await client.onboardingPreview('project /1');
  await client.onboardingPreview('project /1', 'Order / Detail');
  await client.onboardingAlignment('project /1');
  const mappingPayload = { expectedRevision: 2, config: { version: 'mock-alignment.v1', identities: [], units: [], states: [] } };
  await client.saveOnboardingAlignment('project /1', mappingPayload);
  await client.handoffOnboarding('project /1', { expectedRevision: 2 });
  await client.getTask('task /1');
  await client.onboardingCalculations('project /1');
  await client.previewOnboardingCalculation('project /1', { expectedRevision: 2, candidateFingerprint: 'fp', planId: 'plan', target: 'O1' });
  assert.deepEqual(calls.slice(1).map(call => call.url), [
    'http://mock.test/api/semantic-operations/onboarding',
    'http://mock.test/api/semantic-operations/onboarding',
    'http://mock.test/api/semantic-operations/onboarding/project%20%2F1',
    'http://mock.test/api/semantic-operations/onboarding/project%20%2F1/materials',
    'http://mock.test/api/semantic-operations/onboarding/project%20%2F1/connection',
    'http://mock.test/api/semantic-operations/onboarding/project%20%2F1/preview',
    'http://mock.test/api/semantic-operations/onboarding/project%20%2F1/preview?objectType=Order+%2F+Detail',
    'http://mock.test/api/semantic-operations/onboarding/project%20%2F1/alignment',
    'http://mock.test/api/semantic-operations/onboarding/project%20%2F1/alignment',
    'http://mock.test/api/semantic-operations/onboarding/project%20%2F1/handoff',
    'http://mock.test/api/semantic-operations/tasks/task%20%2F1',
    'http://mock.test/api/semantic-operations/onboarding/project%20%2F1/calculations',
    'http://mock.test/api/semantic-operations/onboarding/project%20%2F1/calculations'
  ]);
  assert.equal(calls[2].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[2].options.body), { scenarioId: 'fulfillment', name: '合成接入项目' });
  assert.equal(calls[4].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[4].options.body), payload);
  assert.equal(calls[5].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[5].options.body), connectionPayload);
  assert.equal(calls[6].options.method, undefined);
  assert.equal(calls[7].options.method, undefined);
  assert.equal(calls[8].options.method, undefined);
  assert.equal(calls[9].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[9].options.body), mappingPayload);
  assert.equal(calls[10].options.method, 'POST'); assert.deepEqual(JSON.parse(calls[10].options.body), { expectedRevision: 2 });
  for (const { options } of calls.slice(1)) {
    assert.equal(options.headers['x-identity-session'], 'trusted-session');
    assert.equal(options.headers['x-tenant-id'], undefined);
    assert.equal(options.headers['x-demo-role'], undefined);
  }
});

test('onboarding SDK preserves conflict codes for the material editor without automatic resubmission', async t => {
  const previous = { fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.localStorage = undefined;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ code: 'MOCK_ONBOARDING_REVISION_CONFLICT', message: '请重新读取项目后提交。' }), { status: 409 });
  };
  const client = createSemanticOperationsClient({ baseUrl: 'http://mock.test/api', platform: 'onboarding-conflict' });
  await assert.rejects(client.saveOnboardingMaterial('project-1', { expectedRevision: 1, kind: 'rules', name: 'rules.txt', text: '合成业务规则' }), error => error.status === 409 && error.code === 'MOCK_ONBOARDING_REVISION_CONFLICT');
  assert.equal(calls, 1);
});

test('mock connection and preview retain server errors without an automatic connection retry', async t => {
  const previous = { fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.localStorage = undefined;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ code: 'MOCK_ONBOARDING_PREVIEW_STALE', message: '材料版本已变化。' }), { status: 409 });
  };
  const client = createSemanticOperationsClient({ baseUrl: 'http://mock.test/api', platform: 'onboarding-connection-errors' });
  await assert.rejects(client.testOnboardingConnection('p1', { expectedRevision: 4, faultMode: 'none' }), error => error.status === 409);
  await assert.rejects(client.onboardingPreview('p1', 'Order'), error => error.status === 409 && error.code === 'MOCK_ONBOARDING_PREVIEW_STALE');
  assert.equal(calls, 2);
});

test('system access SDK exposes material understanding and monitoring endpoints with encoded system codes', async t => {
  const previous = { fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.localStorage = undefined;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createSemanticOperationsClient({ baseUrl: 'http://mock.test/api', platform: 'system-access-test' });
  await client.supplementSystemMaterials('ERP / 1', { note: '补充接口字典' });
  await client.systemUnderstanding('ERP / 1');
  await client.regenerateSystemUnderstanding('ERP / 1');
  await client.systemMonitoring();
  await client.controlSystemMonitoring('ERP / 1', 'pause');
  await client.runSystemMonitoring({ dryRun: true });
  assert.deepEqual(calls.map(call => call.url), [
    'http://mock.test/api/semantic-operations/systems/ERP%20%2F%201/materials',
    'http://mock.test/api/semantic-operations/systems/ERP%20%2F%201/understanding',
    'http://mock.test/api/semantic-operations/systems/ERP%20%2F%201/understanding',
    'http://mock.test/api/semantic-operations/system-monitoring',
    'http://mock.test/api/semantic-operations/system-monitoring/ERP%20%2F%201/pause',
    'http://mock.test/api/semantic-operations/system-monitoring/run'
  ]);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { note: '补充接口字典' });
  assert.equal(calls[1].options.method, undefined);
  assert.deepEqual(JSON.parse(calls[2].options.body), { regenerate: true });
  assert.equal(calls[3].options.method, undefined);
  assert.equal(calls[4].options.method, 'POST');
  assert.equal(calls[5].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[5].options.body), { dryRun: true });
});

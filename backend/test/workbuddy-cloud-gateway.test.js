import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateModelSummary, configureModelConnection, getLocalModelRuntime, getModelConnectionConfiguration, resetModelGatewayObservability } from '../src/services/local-model-gateway.js';
import { validateModelSelection, resetModelGovernanceForTest } from '../src/services/model-governance-service.js';
import { readWorkBuddyCloudConfiguration, isAllowedWorkBuddyCloudEndpoint, workBuddyCloudModelIsConfigured } from '../src/services/workbuddy-cloud-config.js';
import { fetchWorkBuddyCloudChat, setWorkBuddyCloudClientFactoryForTests } from '../src/services/workbuddy-cloud-transport.js';

const tempDir = mkdtempSync(join(tmpdir(), 'workbuddy-cloud-test-'));
const validConfig = { version: 1, resourceId: 'wbcs_test', endpoint: 'https://synthetic.app.workbuddy.host', publishableKey: 'wbpk_test_key_0123456789abcdef', model: 'auto', allowedModels: ['auto'] };
const writeConfig = (name, value) => {
  const file = join(tempDir, name);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};

const withWorkBuddyEnv = async (overrides, handler) => {
  const values = { WORKBUDDY_CLOUD_CONFIG_FILE: writeConfig('valid.json', validConfig), ...overrides };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  resetModelGatewayObservability(); resetModelGovernanceForTest();
  try { await handler(); } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    setWorkBuddyCloudClientFactoryForTests(null);
    resetModelGatewayObservability(); resetModelGovernanceForTest();
  }
};

test('WorkBuddy cloud config validation is strict and fails closed', () => {
  assert.equal(readWorkBuddyCloudConfiguration({ WORKBUDDY_CLOUD_CONFIG_FILE: join(tempDir, 'missing.json') }), null);
  assert.equal(readWorkBuddyCloudConfiguration({ WORKBUDDY_CLOUD_CONFIG_FILE: writeConfig('bad-endpoint.json', { ...validConfig, endpoint: 'https://evil.example.com/v1' }) }), null);
  assert.equal(readWorkBuddyCloudConfiguration({ WORKBUDDY_CLOUD_CONFIG_FILE: writeConfig('bad-key.json', { ...validConfig, publishableKey: 'sk-anything' }) }), null);
  assert.equal(readWorkBuddyCloudConfiguration({ WORKBUDDY_CLOUD_CONFIG_FILE: writeConfig('bad-model.json', { ...validConfig, model: 'not a model id' }) }), null);
  const parsed = readWorkBuddyCloudConfiguration({ WORKBUDDY_CLOUD_CONFIG_FILE: writeConfig('good.json', validConfig) });
  assert.equal(parsed.endpoint, validConfig.endpoint);
  assert.deepEqual(parsed.allowedModels, ['auto']);
  assert.equal(isAllowedWorkBuddyCloudEndpoint('http://synthetic.app.workbuddy.host'), false);
  assert.equal(isAllowedWorkBuddyCloudEndpoint('https://synthetic.app.workbuddy.host/extra?x=1'), false);
});

test('Governance pins the WorkBuddy model to the exact config-file version', () => {
  const env = { WORKBUDDY_CLOUD_CONFIG_FILE: writeConfig('pin.json', validConfig) };
  assert.equal(validateModelSelection('workbuddy', 'auto', env).allowed, true);
  assert.equal(validateModelSelection('workbuddy', 'glm-5.3', env).allowed, false);
  const explicit = { WORKBUDDY_CLOUD_CONFIG_FILE: env.WORKBUDDY_CLOUD_CONFIG_FILE, MODEL_ALLOWLIST_JSON: JSON.stringify({ workbuddy: ['glm-5.3'] }) };
  assert.equal(validateModelSelection('workbuddy', 'auto', explicit).allowed, false);
  assert.equal(validateModelSelection('workbuddy', 'glm-5.3', explicit).allowed, true);
  assert.equal(workBuddyCloudModelIsConfigured(readWorkBuddyCloudConfiguration(env), 'auto'), true);
});

test('WorkBuddy transport aggregates the streaming-only SSE contract into the gateway payload', async () => {
  await withWorkBuddyEnv({}, async () => {
    let captured;
    const chunks = [
      { choices: [{ delta: { role: 'assistant', content: '' } }] },
      { choices: [{ delta: { content: '{"schemaVersion":"agent-summary.v1",' } }] },
      { choices: [{ delta: { content: '"answer":"ok"' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    ];
    setWorkBuddyCloudClientFactoryForTests(() => ({ llm: { chat: { completions: { create: async function* (request) { captured = request; for (const chunk of chunks) yield chunk; } } } } }));
    const timing = { attempts: [] };
    const payload = await fetchWorkBuddyCloudChat({ model: 'auto', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], temperature: 0.2, responseFormat: { type: 'json_object' }, timeoutMs: 5000, timing });
    assert.equal(payload.choices[0].finish_reason, 'stop');
    assert.equal(payload.choices[0].message.content, '{"schemaVersion":"agent-summary.v1","answer":"ok"');
    assert.equal(payload.usage.total_tokens, 15);
    assert.deepEqual(timing.attempts, [{ elapsedMs: timing.attempts[0].elapsedMs, status: 200 }]);
    assert.equal(captured.model, 'auto');
    assert.equal(captured.stream, true);
    assert.equal(captured.messages[0].role, 'system');
    assert.deepEqual(captured.response_format, { type: 'json_object' });
    assert.ok(captured.signal instanceof AbortSignal);
    assert.equal(typeof captured.signal?.throwIfAborted, 'function');
  });
});

test('WorkBuddy transport maps provider failures to bounded gateway errors without leaking internals', async () => {
  await withWorkBuddyEnv({}, async () => {
    setWorkBuddyCloudClientFactoryForTests(() => ({ llm: { chat: { completions: { create: async function* () { /* eslint-disable-line require-yield */ const error = new Error('secret upstream detail'); error.error = { code: 'quota_exhausted', message: 'secret upstream detail' }; throw error; } } } } }));
    await assert.rejects(fetchWorkBuddyCloudChat({ model: 'auto', messages: [] }), error => {
      assert.match(error.message, /^WORKBUDDY_CLOUD_QUOTA_EXHAUSTED/);
      assert.doesNotMatch(error.message, /secret upstream detail/);
      return true;
    });
    setWorkBuddyCloudClientFactoryForTests(() => ({ llm: { chat: { completions: { create: async function* () { /* eslint-disable-line require-yield */ throw new Error('plain network failure'); } } } } }));
    await assert.rejects(fetchWorkBuddyCloudChat({ model: 'auto', messages: [] }), error => {
      assert.match(error.message, /^WORKBUDDY_CLOUD_PROVIDER_FAILURE/);
      assert.doesNotMatch(error.message, /plain network failure/);
      return true;
    });
    setWorkBuddyCloudClientFactoryForTests(() => ({ llm: { chat: { completions: { create: async function* () { /* eslint-disable-line require-yield */ const error = new Error('blocked'); error.error = { code: 'auth_origin_mismatch', message: 'blocked' }; throw error; } } } } }));
    await assert.rejects(fetchWorkBuddyCloudChat({ model: 'auto', messages: [] }), /WORKBUDDY_CLOUD_AUTH_REJECTED/);
  });
});

test('Gateway dispatches the workbuddy provider and validates the structured answer', async () => {
  await withWorkBuddyEnv({}, async () => {
    const envelope = { schemaVersion: 'agent-summary.v1', answer: '你好，我可以协助分析问题，尚未执行任何操作。', proposedAction: null, claimsExecution: false, executionReceipt: null };
    setWorkBuddyCloudClientFactoryForTests(() => ({ llm: { chat: { completions: { create: async function* (request) {
      assert.equal(request.stream, true);
      assert.equal(request.messages[0].role, 'system');
      assert.match(request.messages[0].content, /agent-summary\.v1|JSON Schema/u);
      yield { choices: [{ delta: { content: JSON.stringify(envelope) } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
    } } } } }));
    const configured = configureModelConnection({ mode: 'workbuddy', baseUrl: '', model: 'auto', apiKey: '' });
    assert.equal(configured.error, undefined);
    const result = await generateModelSummary({ prompt: '你好，请介绍你能协助处理的工作。', fallback: '本次未取得可用模型结果。', safetyIdentifier: 'workbuddy-test-subject' });
    assert.equal(result.source, 'workbuddy');
    assert.match(result.text, /尚未执行任何操作/);
    assert.equal(getLocalModelRuntime().mode, 'workbuddy');
    const providers = getModelConnectionConfiguration().providers;
    assert.equal(providers.find(item => item.id === 'workbuddy')?.configured, true);
  });
});

test('Gateway rejects a workbuddy runtime override that rewrites the pinned endpoint or model', async () => {
  await withWorkBuddyEnv({}, async () => {
    const rewritten = configureModelConnection({ mode: 'workbuddy', baseUrl: 'https://evil.example.com', model: 'auto', apiKey: '' });
    assert.equal(rewritten.code, 'WORKBUDDY_ENDPOINT_PINNED');
    const unpinnedModel = configureModelConnection({ mode: 'workbuddy', baseUrl: '', model: 'glm-5.3', apiKey: '' });
    assert.equal(unpinnedModel.code, 'MODEL_VERSION_NOT_ALLOWED');
  });
});

test('Cleanup temporary configuration files', () => { rmSync(tempDir, { recursive: true, force: true }); });

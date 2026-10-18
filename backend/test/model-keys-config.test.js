import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadModelKeysConfig } from '../../scripts/model-keys-config.mjs';

const key = 'synthetic-unified-key-not-real';
const sample = { activeProvider: 'glm', providers: { glm: { apiKey: key, model: 'glm-5', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, ark: { apiKey: '', model: '', baseUrl: '' } } };
const fixture = (t, config) => {
  const directory = mkdtempSync(join(tmpdir(), 'yuanyu-model-keys-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'models.json');
  writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
  return file;
};
test('one private file selects GLM only, empty inactive providers do not block it or change runtime', t => {
  const env = { MODEL_KEYS_FILE: fixture(t, sample) };
  assert.deepEqual(loadModelKeysConfig(env), { profile: 'glm', provider: 'compatible', model: 'glm-5' });
  assert.equal(env.COMPATIBLE_LLM_API_KEY, key);
  assert.equal(env.ARK_API_KEY, undefined);
  assert.equal(env.AGENT_RUNTIME_MODE, undefined);
  assert.deepEqual(JSON.parse(env.MODEL_ALLOWLIST_JSON), { compatible: ['glm-5'] });
});
test('unified profiles dispatch to existing exact adapters without mixing provider credentials', t => {
  for (const [profile, provider, prefix, model, baseUrl] of [
    ['ark', 'ark', 'ARK', 'approved-ark', 'https://ark.cn-beijing.volces.com/api/v3'],
    ['deepseek', 'deepseek', 'DEEPSEEK', 'approved-deepseek', 'https://api.deepseek.com'],
    ['qwen', 'compatible', 'COMPATIBLE_LLM', 'approved-qwen', 'https://gateway.example/v1'],
    ['kimi', 'compatible', 'COMPATIBLE_LLM', 'approved-kimi', 'https://gateway.example/v1']
  ]) {
    const env = { MODEL_KEYS_FILE: fixture(t, { activeProvider: profile, providers: { [profile]: { apiKey: key, model, baseUrl } } }) };
    assert.equal(loadModelKeysConfig(env).provider, provider);
    assert.equal(env[`${prefix}_MODEL`], model);
    assert.deepEqual(JSON.parse(env.MODEL_ALLOWLIST_JSON), { [provider]: [model] });
  }
});
test('bad/blank key, unsafe endpoint, malformed file, unknown keys and conflicting environment fail atomically without exposing secrets', t => {
  const alter = patch => ({ ...sample, providers: { ...sample.providers, glm: { ...sample.providers.glm, ...patch } } });
  for (const config of ['null', key, 'x'.repeat(65537), alter({ apiKey: '' }), alter({ model: 'not-glm' }), alter({ baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' }), alter({ baseUrl: 'https://user:secret@open.bigmodel.cn/api/paas/v4' }), { ...sample, activeProvider: '__proto__' }, { ...sample, NODE_OPTIONS: '--inspect' }, { ...sample, providers: { glm: { ...sample.providers.glm, unauthorized: true } } }]) {
    const env = { MODEL_KEYS_FILE: fixture(t, config) }; const before = { ...env };
    assert.throws(() => loadModelKeysConfig(env), error => !error.message.includes(key) && error.message.includes('MODEL_KEYS_CONFIG_INVALID'));
    assert.deepEqual(env, before);
  }
  for (const overrides of [{ COMPATIBLE_LLM_BASE_URL: 'https://other.example' }, { COMPATIBLE_LLM_API_KEY: 'different-secret' }, { MODEL_ALLOWLIST_JSON: '{"compatible":[]}' }]) {
    const env = { MODEL_KEYS_FILE: fixture(t, sample), ...overrides }; const before = { ...env };
    assert.throws(() => loadModelKeysConfig(env), /MODEL_KEYS_CONFIG_INVALID/u);
    assert.deepEqual(env, before);
  }
  assert.throws(() => loadModelKeysConfig({ MODEL_KEYS_FILE: './models.json' }), /MODEL_KEYS_CONFIG_INVALID/u);
});

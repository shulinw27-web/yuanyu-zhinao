import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGlmFileConfig, GLM_BASE_URL } from '../../scripts/glm-file-config.mjs';
import { validateModelSelection } from '../src/services/model-governance-service.js';

const sample = { apiKey: 'synthetic-glm-credential-not-real', model: 'glm-5', baseUrl: GLM_BASE_URL, allowedModels: ['glm-5'] };
const fixture = (t, text) => {
  const directory = mkdtempSync(join(tmpdir(), 'yuanyu-glm-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'glm.json');
  if (text !== undefined) writeFileSync(file, text);
  return file;
};
test('GLM private config loads only compatible credentials and exact approved model, with no provider switching', t => {
  const env = { GLM_CONFIG_FILE: fixture(t, '\uFEFF' + JSON.stringify(sample)) };
  assert.deepEqual(loadGlmFileConfig(env), { loaded: true });
  assert.equal(env.COMPATIBLE_LLM_API_KEY, sample.apiKey);
  assert.equal(env.COMPATIBLE_LLM_BASE_URL, GLM_BASE_URL);
  assert.equal(env.AGENT_RUNTIME_MODE, undefined);
  assert.equal(validateModelSelection('compatible', 'glm-5', env).allowed, true);
  assert.equal(validateModelSelection('compatible', 'glm-unapproved', env).allowed, false);
  assert.equal(env.ARK_API_KEY, undefined);
});
test('GLM environment overrides are preserved, not silently widened', t => {
  const env = { GLM_CONFIG_FILE: fixture(t, JSON.stringify(sample)), COMPATIBLE_LLM_API_KEY: '', MODEL_ALLOWLIST_JSON: '{"compatible":[]}' };
  loadGlmFileConfig(env);
  assert.equal(env.COMPATIBLE_LLM_API_KEY, '');
  assert.equal(validateModelSelection('compatible', 'glm-5', env).allowed, false);
});
test('GLM config rejects malformed/foreign/coding/unknown configs without leaking credentials or partial mutation', t => {
  for (const text of [undefined, sample.apiKey, 'x'.repeat(16385), 'null', '[]', JSON.stringify({ ...sample, baseUrl: 'https://example.com' }), JSON.stringify({ ...sample, baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' }), JSON.stringify({ ...sample, allowedModels: ['glm-other'] }), JSON.stringify({ ...sample, NODE_OPTIONS: '--inspect' }), JSON.stringify({ ...sample, apiKey: 'invalid\nkey' })]) {
    const env = { GLM_CONFIG_FILE: fixture(t, text) }; const original = { ...env };
    assert.throws(() => loadGlmFileConfig(env), error => error.message.includes('GLM_CONFIG_FILE') && !error.message.includes(sample.apiKey));
    assert.deepEqual(env, original);
  }
  assert.throws(() => loadGlmFileConfig({ GLM_CONFIG_FILE: './glm.json' }), /absolute path/);
  assert.throws(() => loadGlmFileConfig({}, 'linux'), /absolute path/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadArkFileConfig } from '../../scripts/ark-file-config.mjs';

const synthetic = { apiKey: 'synthetic-test-key-not-a-real-secret', model: 'approved-model', allowedModels: ['approved-model'] };
function fixture(t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'ark-config-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ark.json');
  if (content !== undefined) writeFileSync(path, content);
  return path;
}
test('private JSON supplies key, exact approval and standard endpoint without returning secret', t => {
  const env = { ARK_CONFIG_FILE: fixture(t, '\uFEFF' + JSON.stringify(synthetic)) };
  assert.deepEqual(loadArkFileConfig(env), { loaded: true });
  assert.equal(env.ARK_API_KEY, synthetic.apiKey);
  assert.deepEqual(JSON.parse(env.MODEL_ALLOWLIST_JSON), { ark: [synthetic.model] });
  assert.equal(env.ARK_BASE_URL, 'https://ark.cn-beijing.volces.com/api/v3');
});
test('explicit environment settings override the file, even empty values', t => {
  const env = { ARK_CONFIG_FILE: fixture(t, JSON.stringify(synthetic)), ARK_API_KEY: '', ARK_MODEL: 'different-model', MODEL_ALLOWLIST_JSON: '{"ark":[]}' };
  loadArkFileConfig(env);
  assert.equal(env.ARK_API_KEY, '');
  assert.equal(env.ARK_MODEL, 'different-model');
  assert.equal(env.MODEL_ALLOWLIST_JSON, '{"ark":[]}');
});
test('invalid files fail closed without disclosing contents or changing environment', t => {
  for (const content of [undefined, synthetic.apiKey, 'x'.repeat(16385), 'null', '[]', JSON.stringify({ ...synthetic, baseUrl: 'https://example.com/api/v3' }), JSON.stringify({ ...synthetic, allowedModels: ['other'] }), JSON.stringify({ ...synthetic, NODE_OPTIONS: '--inspect' })]) {
    const env = { ARK_CONFIG_FILE: fixture(t, content) };
    const before = { ...env };
    assert.throws(() => loadArkFileConfig(env), error => !error.message.includes(synthetic.apiKey) && error.message.includes('ARK_CONFIG_FILE'));
    assert.deepEqual(env, before);
  }
});
test('relative paths rejected and non-Windows environment-only startup preserved', () => {
  assert.throws(() => loadArkFileConfig({ ARK_CONFIG_FILE: './ark.json' }), /absolute path/);
  assert.deepEqual(loadArkFileConfig({}, 'linux'), { loaded: false });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRegistryLicense } from '../../scripts/license-registry.mjs';
test('license metadata uses exact official package/version and never transmits local content or credentials', async () => {
  const result = await resolveRegistryLicense({ name: '@vendor/optional', version: '1.2.3' }, async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/%40vendor%2Foptional/1.2.3');
    assert.equal(options.redirect, 'error'); assert.deepEqual(options.headers, { accept: 'application/json' }); assert.equal(options.body, undefined);
    return new Response(JSON.stringify({ name: '@vendor/optional', version: '1.2.3', license: 'MIT' }));
  });
  assert.equal(result.license, 'MIT');
});
test('unverified, mismatched, oversized or missing registry declarations remain unknown without guessing', async () => {
  for (const metadata of [{ name: 'other', version: '1.2.3', license: 'MIT' }, { name: 'x', version: '1.2.4', license: 'MIT' }, { name: 'x', version: '1.2.3', license: {} }, { name: 'x', version: '1.2.3', license: '' }]) {
    assert.equal(await resolveRegistryLicense({ name: 'x', version: '1.2.3' }, async () => new Response(JSON.stringify(metadata))), null);
  }
  assert.equal(await resolveRegistryLicense({ name: 'x', version: 'latest' }, () => { throw new Error('must not fetch'); }), null);
  assert.equal(await resolveRegistryLicense({ name: '../secret', version: '1.2.3' }, () => { throw new Error('must not fetch'); }), null);
  assert.equal(await resolveRegistryLicense({ name: 'x', version: '1.2.3' }, async () => new Response('x'.repeat(200001))), null);
  assert.equal(await resolveRegistryLicense({ name: 'x', version: '1.2.3' }, async () => { throw new Error('network'); }), null);
});

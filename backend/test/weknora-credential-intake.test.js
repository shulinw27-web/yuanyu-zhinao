import test from 'node:test';
import assert from 'node:assert/strict';
import { startCredentialIntake } from '../../scripts/weknora-credential-intake.mjs';

test('WK setup: single-use local form enforces origin, shape and never echoes credentials', async () => {
  const saved = []; const binding = { principalKey: 'a'.repeat(64) };
  const intake = await startCredentialIntake({ save: async value => saved.push(value), binding });
  try {
    const page = await fetch(intake.url);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /type="password"/);
    const post = (body, origin = new URL(intake.url).origin) => fetch(intake.url, { method: 'POST', headers: {
      Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    assert.equal((await post('key=synthetic-test-key', 'http://attacker.invalid')).status, 403);
    assert.equal((await post('key=synthetic-test-key&extra=true')).status, 400);
    assert.equal((await post('key=synthetic-test-key&key=another-test-key')).status, 400);
    assert.equal(saved.length, 0);
    const response = await post('key=synthetic-test-key');
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes('synthetic-test-key'), false);
    assert.equal(saved.length, 1); assert.equal(saved[0].retrievalMode, 'keyword_only');
    assert.deepEqual(saved[0].bindings, [binding]);
  } finally { intake.close(); }
});

test('WK setup: filesystem failure cannot expose the key or be retried against a partial file', async () => {
  const intake = await startCredentialIntake({ binding: {}, save: async () => { throw new Error('synthetic-test-key'); } });
  try {
    const response = await fetch(intake.url, { method: 'POST', headers: { Origin: new URL(intake.url).origin,
      'Content-Type': 'application/x-www-form-urlencoded' }, body: 'key=synthetic-test-key' });
    assert.equal(response.status, 500); assert.equal((await response.text()).includes('synthetic-test-key'), false);
  } finally { intake.close(); }
});

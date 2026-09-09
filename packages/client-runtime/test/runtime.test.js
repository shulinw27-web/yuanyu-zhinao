import test from 'node:test';
import assert from 'node:assert/strict';
import { compareClientVersions, evaluateClientCompatibility, resilientFetch } from '../src/index.js';

test('client versions are compared as semantic versions and invalid values fail closed', () => {
  assert.equal(compareClientVersions('0.3.0', '0.2.9'), 1);
  assert.equal(compareClientVersions('1.0.0', '1.0.0'), 0);
  assert.equal(evaluateClientCompatibility({ version: '0.1.0', minimumVersion: '0.2.0', recommendedVersion: '0.3.0' }).status, 'upgrade_required');
  assert.equal(evaluateClientCompatibility({ version: 'latest', minimumVersion: '0.2.0' }).allowed, false);
});

test('resilient fetch retries safe reads with backoff but never retries writes implicitly', async () => {
  let readCalls = 0;
  const read = await resilientFetch('https://example.test', {}, { attempts: 3, baseDelayMs: 0, wait: async () => {}, fetchImpl: async () => new Response('{}', { status: ++readCalls < 3 ? 503 : 200 }) });
  assert.equal(read.status, 200);
  assert.equal(readCalls, 3);
  let writeCalls = 0;
  const write = await resilientFetch('https://example.test', { method: 'POST' }, { attempts: 3, baseDelayMs: 0, wait: async () => {}, fetchImpl: async () => { writeCalls += 1; return new Response('{}', { status: 503 }); } });
  assert.equal(write.status, 503);
  assert.equal(writeCalls, 1);
});

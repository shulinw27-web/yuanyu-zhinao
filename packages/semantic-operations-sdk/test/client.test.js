import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticOperationsClient, resolveSemanticOperationsApiBaseUrl } from '../src/index.js';

test('resolves packaged desktop API endpoint', () => {
  assert.equal(resolveSemanticOperationsApiBaseUrl({ runtime: { semanticOperationsDesktop: { apiBaseUrl: 'http://127.0.0.1:3001/api/' } } }), 'http://127.0.0.1:3001/api');
});

test('uses identity and device sessions without demo role headers', async () => {
  const calls = [];
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/local/login')) return new Response(JSON.stringify({ sessionId: 'identity-1', user: { roleId: 'executive' } }), { status: 200 });
    if (url.endsWith('/session/device')) return new Response(JSON.stringify({ id: 'device-session-1' }), { status: 200 });
    return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
  };
  const client = createSemanticOperationsClient({ baseUrl: 'http://example.test/api', platform: 'test' });
  await client.loginLocal({ account: 'ops', password: 'secret' });
  await client.registerDevice();
  await client.tasks();
  assert.equal(calls[2].options.headers['x-identity-session'], 'identity-1');
  assert.equal(calls[2].options.headers['x-device-session'], 'device-session-1');
  assert.equal(calls[2].options.headers['x-demo-role'], undefined);
});

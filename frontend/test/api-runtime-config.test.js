import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentAuthenticationHeaders, createAgentClient, resolveAgentApiBaseUrl, resolveEnterpriseAccessTokenProvider } from '../../packages/agent-sdk/src/index.js';
import { buildAdminAuthenticationHeaders, resolveAdminApiBaseUrl } from '../src/api/client.js';

test('browser clients use the same-origin API by default', () => {
  const runtime = { location: { origin: 'https://zhinao.example.internal' } };
  assert.equal(resolveAgentApiBaseUrl({ runtime }), 'https://zhinao.example.internal/api');
  assert.equal(resolveAdminApiBaseUrl(runtime), 'https://zhinao.example.internal/api');
});

test('desktop bridge and explicit configuration override browser origin', () => {
  assert.equal(resolveAgentApiBaseUrl({ runtime: { location: { origin: 'null' }, zhinaoDesktop: { apiBaseUrl: 'https://gateway.example/api/' } } }), 'https://gateway.example/api');
  assert.equal(resolveAgentApiBaseUrl({ explicitBaseUrl: 'https://staging.example/api/' }), 'https://staging.example/api');
});

test('non-http packaged origins never become an API endpoint', () => {
  assert.equal(resolveAgentApiBaseUrl({ runtime: { location: { origin: 'tauri://localhost' } } }), 'http://127.0.0.1:3001/api');
});

test('enterprise bearer replaces Demo role headers and never persists through the header helper', () => {
  assert.deepEqual(buildAdminAuthenticationHeaders('executive', 'signed-token'), { Authorization: 'Bearer signed-token' });
  assert.deepEqual(buildAgentAuthenticationHeaders({ role: 'executive', accessToken: 'signed-token' }), { Authorization: 'Bearer signed-token' });
  assert.deepEqual(buildAgentAuthenticationHeaders({ role: 'executive', identitySessionId: 'session-1', accessToken: 'signed-token' }), { 'x-identity-session': 'session-1' });
  assert.equal(Object.hasOwn(buildAdminAuthenticationHeaders('executive', 'signed-token'), 'x-demo-role'), false);
});

test('enterprise access tokens are obtained through an async host callback instead of a global token value', async () => {
  let calls = 0;
  const provider = resolveEnterpriseAccessTokenProvider({
    __ZHINAO_RUNTIME_CONFIG__: { getAccessToken: async () => { calls += 1; return 'short-lived-token'; } }
  });
  assert.equal(await provider(), 'short-lived-token');
  assert.equal(calls, 1);
  assert.equal(resolveEnterpriseAccessTokenProvider({ __ZHINAO_RUNTIME_CONFIG__: { accessToken: 'must-not-be-read' } }), null);
});

test('an empty enterprise token provider fails closed before any Demo request can be sent', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('must not be called'); };
  try {
    const client = createAgentClient({ baseUrl: 'https://gateway.example/api', accessTokenProvider: async () => null });
    await assert.rejects(client.enterpriseSession(), (error) => error.code === 'OIDC_TOKEN_MISSING' && error.status === 401);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

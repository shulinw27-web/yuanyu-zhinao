import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentClient } from '../../packages/agent-sdk/src/index.js';
import { createSemanticOperationsClient } from '../../packages/semantic-operations-sdk/src/index.js';

const factories = [
  ['智脑', createAgentClient, 'healthcare-ai-identity-session-web'],
  ['元域智营', createSemanticOperationsClient, 'healthcare-ai-semantic-identity-session-web']
];
for (const [name, createClient, storageKey] of factories) {
  test(`${name}按身份源隔离缓存，Bearer 仅发送给选择的适配器且不持久化`, async () => {
    const oldFetch = globalThis.fetch; const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const stored = new Map([[storageKey, 'legacy-admin'], [`${storageKey}-old-sso`, 'other-source-session']]); const calls = [];
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) } });
    globalThis.fetch = async (_url, options) => { calls.push(options.headers); return new Response(JSON.stringify({ account: 'quality@demo.local', primaryRoleId: 'quality_manager' })); };
    try {
      const client = createClient({ baseUrl: 'https://agent.test/api', platform: 'web', identityProviderId: 'company-sso', accessTokenProvider: async () => 'synthetic-token' });
      assert.equal(client.identitySessionId, null);
      await client.enterpriseSession();
      assert.equal(calls[0].Authorization, 'Bearer synthetic-token');
      assert.equal(calls[0]['x-identity-provider'], 'company-sso');
      assert.equal(calls[0]['x-demo-role'], undefined); assert.equal(calls[0]['x-identity-session'], undefined);
      assert.ok(![...stored.values()].includes('synthetic-token'));
    } finally { globalThis.fetch = oldFetch; if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else delete globalThis.localStorage; }
  });
  test(`${name}拒绝不合法身份源 ID，令牌获取失败时不发送降级请求`, async () => {
    assert.throws(() => createClient({ identityProviderId: '../../untrusted' }));
    assert.throws(() => createClient({ identityProviderId: ['company-sso'] }));
    const oldFetch = globalThis.fetch; let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('should not fetch'); };
    try {
      const client = createClient({ identityProviderId: 'company-sso', accessTokenProvider: async () => { throw new Error('identity unavailable'); } });
      await assert.rejects(client.enterpriseSession(), /identity unavailable/);
      assert.equal(calls, 0);
    } finally { globalThis.fetch = oldFetch; }
  });
}

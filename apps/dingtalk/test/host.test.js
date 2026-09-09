import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateDingTalk, dingTalkPlatform, workbenchLayout } from '../src/dingtalk-host.js';
import { createAgentClient } from '@healthcare-ai/agent-sdk';

function fixture() {
  const calls = [];
  return { calls, client: {
    dingTalkConnection: async () => ({ configured: true, corpId: 'corp-fixture' }),
    dingTalkChallenge: async () => ({ challengeId: 'nonce-fixture' }),
    loginDingTalk: async (input) => { calls.push(input); return { user: { source: 'dingtalk' } }; }
  }, sdk: { ready: (cb) => cb(), runtime: { permission: { requestAuthCode: ({ onSuccess }) => onSuccess({ code: 'synthetic-code' }) } } }, userAgent: 'DingTalk Android' };
}
test('手机、桌面钉钉与窄窗口正确识别', () => {
  assert.equal(dingTalkPlatform('Android DingTalk'), 'dingtalk-mobile');
  assert.equal(dingTalkPlatform('iPhone DingTalk'), 'dingtalk-mobile');
  assert.equal(dingTalkPlatform('Windows DingTalk'), 'dingtalk-pc');
  assert.equal(dingTalkPlatform('Macintosh DingTalk'), 'dingtalk-pc');
  assert.equal(workbenchLayout(390), 'mobile'); assert.equal(workbenchLayout(800), 'mobile'); assert.equal(workbenchLayout(1440), 'desktop');
});
test('普通浏览器不调用身份或业务接口', async () => {
  await assert.rejects(authenticateDingTalk({ client: {}, userAgent: 'Chrome' }), /钉钉/);
});
test('官方免登码仅通过服务端客户端 POST 适配器提交', async () => {
  const input = fixture(); await authenticateDingTalk(input);
  assert.deepEqual(input.calls, [{ code: 'synthetic-code', corpId: 'corp-fixture', challengeId: 'nonce-fixture' }]);
});
test('未配置、SDK 拒绝、空码、超时均不登录且不回退演示账号', async () => {
  const unconfigured = fixture(); unconfigured.client.dingTalkConnection = async () => ({ configured: false });
  await assert.rejects(authenticateDingTalk(unconfigured), /配置/);
  for (const callback of [(args) => args.onFail({ secret: 'private' }), (args) => args.onSuccess({})]) {
    const input = fixture(); input.sdk.runtime.permission.requestAuthCode = callback;
    await assert.rejects(authenticateDingTalk(input), /钉钉/); assert.equal(input.calls.length, 0);
  }
  const input = fixture(); let late;
  input.sdk.ready = (callback) => { late = callback; };
  await assert.rejects(authenticateDingTalk({ ...input, timeoutMs: 5 }), /超时/);
  late(); assert.equal(input.calls.length, 0);
});
test('钉钉客户端不恢复缓存身份、不发送 Demo 角色、不持久化令牌', async () => {
  const oldFetch = globalThis.fetch; const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const writes = []; const calls = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => key.includes('device') ? 'fixture-device' : 'old-admin-session', setItem: (key) => writes.push(key), removeItem: () => {} } });
  globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return new Response(JSON.stringify({ sessionId: 'new-session', user: { roleId: 'production_manager', source: 'dingtalk' } })); };
  try {
    const client = createAgentClient({ baseUrl: 'https://agent.example.test/api', platform: 'dingtalk-mobile', role: null, persistIdentity: false });
    assert.equal(client.identitySessionId, null);
    await client.loginDingTalk({ code: 'code', corpId: 'corp', challengeId: 'nonce' });
    assert.equal(calls[0].headers['x-identity-session'], undefined); assert.equal(calls[0].headers['x-demo-role'], undefined);
    assert.equal(calls[0].method, 'POST'); assert.equal(writes.length, 0);
    await client.agentConversations(); assert.equal(calls[1].headers['x-identity-session'], 'new-session');
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(client.logoutOA()); assert.equal(client.identitySessionId, null);
  } finally { globalThis.fetch = oldFetch; if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; }
});

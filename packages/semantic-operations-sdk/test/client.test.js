import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticOperationsClient, resolveSemanticOperationsApiBaseUrl } from '../src/index.js';

test('resolves packaged desktop API endpoint', () => {
  assert.equal(resolveSemanticOperationsApiBaseUrl({ runtime: { semanticOperationsDesktop: { apiBaseUrl: 'http://127.0.0.1:3001/api/' } } }), 'http://127.0.0.1:3001/api');
});

test('uses identity and device sessions without demo role headers', async () => {  const calls = [];
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
  await client.tasks({ limit: 30, offset: 30 });
  assert.match(calls[3].url, /\/semantic-operations\/tasks\?limit=30&offset=30$/);
});

test('source scope list is requested explicitly and surfaces scope rejection codes', async () => {
  const calls = [];
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/semantic-operations/tasks')) {
      return new Response(JSON.stringify({ message: '本次诉求需要来源系统范围，但没有选择任何系统。', code: 'SEMANTIC_SYSTEM_SCOPE_REQUIRED' }), { status: 400 });
    }
    return new Response(JSON.stringify({ sources: [], scopeNotice: null }), { status: 200 });
  };
  const client = createSemanticOperationsClient({ baseUrl: 'http://example.test/api', platform: 'test' });
  await client.semanticSources();
  // 无参数时不带查询串；范围全量必须显式声明，不再依赖「没给范围就默认全量」。
  assert.equal(calls[0].url, 'http://example.test/api/semantic-operations/sources');
  await client.semanticSources({ scope: 'all_registered' });
  assert.equal(calls[1].url, 'http://example.test/api/semantic-operations/sources?scope=all_registered');
  await client.semanticSources({ query: 'ERP 与 WMS', scope: 'all_registered' });
  assert.equal(calls[2].url, 'http://example.test/api/semantic-operations/sources?query=ERP+%E4%B8%8E+WMS&scope=all_registered');
  // 任务创建的范围拒绝必须能按 code 识别，前端才能高亮范围面板而不是只显示一句话。
  await assert.rejects(() => client.createTask({ text: '建立语义模型。', systemCodes: [] }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'SEMANTIC_SYSTEM_SCOPE_REQUIRED');
    assert.match(error.body.message, /没有选择任何系统/);
    return true;
  });
});

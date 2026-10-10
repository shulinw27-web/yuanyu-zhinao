import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listenOnFetchableLoopback } from './http-fixture-port.js';

test('fixture binds a real Fetch-compatible loopback server and performs only HEAD readiness', async () => {
  const methods = []; const server = createServer((req, res) => { methods.push(req.method); res.end(); });
  try { const origin = await listenOnFetchableLoopback(server); assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u); assert.deepEqual(methods, ['HEAD']); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('blocked allocation retries only fixture binding; unrelated transport errors remain failures', async () => {
  const server = createServer((req, res) => res.end()); let calls = 0;
  try {
    await listenOnFetchableLoopback(server, async () => { if (++calls < 3) throw Object.assign(new Error('fetch failed'), { cause: new Error('bad port') }); });
    assert.equal(calls, 3);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const failed = createServer((req, res) => res.end());
  await assert.rejects(listenOnFetchableLoopback(failed, async () => { throw new Error('real transport failure'); }), /real transport failure/u);
  assert.equal(failed.listening, false);
});

test('fixture binding budget is finite and leaves no listening server on exhaustion', async () => {
  const server = createServer((req, res) => res.end()); let calls = 0;
  await assert.rejects(listenOnFetchableLoopback(server, async () => { calls++; throw Object.assign(new Error('fetch failed'), { cause: new Error('bad port') }); }), /FETCHABLE_TEST_PORT_UNAVAILABLE/u);
  assert.equal(calls, 16); assert.equal(server.listening, false);
});

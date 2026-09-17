import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

test('real HTTP auth → tenant IAM → permissions stays isolated; only changed tenant session is revoked', { timeout: 20000 }, async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = fork('backend/test/helpers/tenant-iam-http-worker.mjs', [], {
    execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_ENV: 'test', NODE_TEST_CONTEXT: 'child-v8', RUNTIME_STORE_DRIVER: 'memory', IAM_STORE_DRIVER: 'runtime', IDENTITY_SESSION_STORE_DRIVER: 'runtime',
      IDENTITY_PROVIDERS_FILE: '', DEMO_ALLOW_ROLE_HEADER: 'false', API_HOST: '127.0.0.1', PORT: String(port) }
  });
  // Capture child failures without exposing fixture session tokens in test output.
  let childLog = '';
  child.stdout.on('data', data => { childLog += data; }); child.stderr.on('data', data => { childLog += data; });
  const closed = once(child, 'close');
  try {
    const [{ sessions }] = await Promise.race([once(child, 'message'), closed.then(() => { throw new Error(`Synthetic API failed: ${childLog}`); })]);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/api/health/live`)).ok) break; } catch { /* Wait for test-only listener. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const call = async (tenant, extra = {}) => {
      const response = await fetch(`${base}/api/permission-management`, { headers: { 'x-identity-session': sessions[tenant], 'x-client-device-id': 'test-device', ...extra } });
      return { status: response.status, body: await response.json() };
    };
    const [a, b] = await Promise.all([call('http-a', { 'x-tenant-id': 'http-b', 'x-demo-role': 'executive' }), call('http-b')]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.match(JSON.stringify(a.body), /http-a/); assert.doesNotMatch(JSON.stringify(a.body), /http-b/);
    assert.match(JSON.stringify(b.body), /http-b/); assert.doesNotMatch(JSON.stringify(b.body), /http-a/);
    assert.equal((await fetch(`${base}/api/permission-management`, { headers: { 'x-tenant-id': 'http-a', 'x-demo-role': 'executive' } })).status, 401);
    const changed = once(child, 'message'); child.send('change-a-policy'); await changed;
    assert.equal((await call('http-a')).status, 401);
    assert.equal((await call('http-b')).status, 200);
  } finally { child.kill(); await closed; }
});

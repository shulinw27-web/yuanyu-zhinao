const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

test('development CSP permits only the selected origin and preserves production HTML and other restrictions', async () => {
  const { developmentApiCsp } = await import('../vite.config.js');
  const original = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
  const plugin = developmentApiCsp('http://127.0.0.1:15181/api');
  assert.equal(plugin.apply, 'serve');
  const changed = plugin.transformIndexHtml(original);
  assert.ok(changed.includes("connect-src 'self' http://127.0.0.1:15181"));
  assert.ok(!changed.includes('http://127.0.0.1:*'));
  assert.equal(changed.replace("connect-src 'self' http://127.0.0.1:15181", "connect-src 'self'"), original);
  assert.equal(developmentApiCsp('').transformIndexHtml(original), original);
  assert.ok(developmentApiCsp('https://gateway.example/api').transformIndexHtml(original).includes("connect-src 'self' https://gateway.example"));
  for (const target of ['http://remote.example:15181', 'file:///api', 'javascript:alert(1)', 'https://user:secret@gateway.example', ' http://127.0.0.1:15181', 'http://127.0.0.1:15181\n']) {
    assert.throws(() => developmentApiCsp(target).transformIndexHtml(original), /DEV_API_CSP_TARGET_INVALID/);
  }
});

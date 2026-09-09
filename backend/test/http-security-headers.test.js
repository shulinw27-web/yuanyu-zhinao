import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSecurityHeaders, sendJson } from '../src/http/http-utils.js';

const createResponse = ({ strictTransportSecurity = false, corsOrigin = null } = {}) => ({
  requestId: 'request-security-test',
  strictTransportSecurity,
  corsOrigin,
  writeHead(status, headers) { this.status = status; this.headers = headers; },
  end(payload) { this.payload = payload; }
});

test('API security headers deny embedding, sniffing, browser capabilities and referrer leakage', () => {
  const headers = buildSecurityHeaders();
  assert.match(headers['Content-Security-Policy'], /default-src 'none'/);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(headers['Permissions-Policy'], /camera=\(\)/);
  assert.equal(headers['Strict-Transport-Security'], undefined);
});

test('production JSON responses include HSTS, no-store and preserve an explicit CORS origin', () => {
  const response = createResponse({ strictTransportSecurity: true, corsOrigin: 'https://app.example.test' });
  sendJson(response, 200, { ok: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://app.example.test');
  assert.equal(response.headers.Vary, 'Origin');
  assert.deepEqual(JSON.parse(response.payload), { ok: true });
});

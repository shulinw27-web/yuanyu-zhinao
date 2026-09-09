import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClientRequest, getClientVersionPolicy } from '../src/services/client-version-policy-service.js';

test('client version policy rejects obsolete and unidentified production clients with HTTP 426', () => {
  assert.equal(evaluateClientRequest({}, { production: true }).code, 'CLIENT_PLATFORM_UNSUPPORTED');
  assert.equal(evaluateClientRequest({ 'x-client-platform': 'desktop', 'x-client-version': '0.2.9' }, { production: true }).code, 'CLIENT_UPGRADE_REQUIRED');
  assert.equal(evaluateClientRequest({ 'x-client-platform': 'desktop', 'x-client-version': '0.3.0' }, { production: true }).status, 'compatible');
});

test('all supported clients publish minimum and recommended versions', () => {
  const policy = getClientVersionPolicy();
  for (const platform of ['web', 'desktop', 'mobile', 'semantic-web', 'semantic-desktop']) {
    assert.match(policy[platform].minimumVersion, /^\d+\.\d+\.\d+$/);
    assert.match(policy[platform].recommendedVersion, /^\d+\.\d+\.\d+$/);
  }
});

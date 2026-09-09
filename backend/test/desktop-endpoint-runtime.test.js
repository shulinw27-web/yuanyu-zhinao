import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { authorizeDesktopEndpoint, getDesktopEndpointStatus, registerDesktopEndpointHeartbeat } from '../src/services/desktop-endpoint-service.js';

const identity = (suffix = 'a') => ({
  tenantId: 'endpoint-test-tenant',
  subjectId: `endpoint-user-${suffix}`,
  sessionId: `endpoint-session-${suffix}`,
  deviceId: `endpoint-device-${suffix}`,
  platform: 'desktop'
});
const keyPair = generateKeyPairSync('ed25519');
const publicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const publicKeyFingerprint = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex');
const heartbeat = (overrides = {}, nowAt = Date.now()) => {
  const value = {
    protocolVersion: 'endpoint-runtime.v1',
    endpointId: 'endpoint-123e4567-e89b-12d3-a456-426614174000',
    appVersion: '0.3.0',
    platform: 'win32',
    packaged: false,
    trustClaim: 'development_untrusted',
    keyProtection: 'file_system',
    capabilityManifestHash: 'a'.repeat(64),
    observedAt: new Date(nowAt).toISOString(),
    publicKey,
    ...overrides
  };
  const payload = JSON.stringify([value.protocolVersion, value.endpointId, value.appVersion, value.platform, value.packaged, value.trustClaim, value.keyProtection, value.capabilityManifestHash, value.observedAt]);
  return { ...value, signature: sign(null, Buffer.from(payload), keyPair.privateKey).toString('base64url') };
};

test('authenticated desktop heartbeat is device isolated and becomes stale', () => {
  const scope = identity('isolation');
  const registered = registerDesktopEndpointHeartbeat({ identityScope: scope, heartbeat: heartbeat({}, 1_000), nowAt: 1_000 });
  assert.equal(registered.connected, true);
  assert.equal(registered.allowed, true);
  assert.equal(registered.trustState, 'development_allowed');
  assert.equal(authorizeDesktopEndpoint(scope, 75_999).allowed, true);
  assert.equal(getDesktopEndpointStatus({ ...scope, deviceId: 'different-device' }, 2_000).trustState, 'heartbeat_missing');
  const stale = authorizeDesktopEndpoint(scope, 76_001);
  assert.equal(stale.allowed, false);
  assert.equal(stale.status.trustState, 'heartbeat_stale');
});

test('endpoint heartbeat schema, platform, clock, and minimum version fail closed', () => {
  const scope = identity('validation');
  assert.equal(registerDesktopEndpointHeartbeat({ identityScope: scope, heartbeat: heartbeat({ secret: 'not-allowed' }) }).code, 'DESKTOP_ENDPOINT_HEARTBEAT_ADDITIONAL_PROPERTY');
  assert.equal(registerDesktopEndpointHeartbeat({ identityScope: scope, heartbeat: { ...heartbeat(), signature: 'invalid' } }).code, 'DESKTOP_ENDPOINT_SIGNATURE_INVALID');
  assert.equal(registerDesktopEndpointHeartbeat({ identityScope: { ...scope, platform: 'web' }, heartbeat: heartbeat() }).code, 'DESKTOP_ENDPOINT_IDENTITY_REQUIRED');
  assert.equal(registerDesktopEndpointHeartbeat({ identityScope: scope, heartbeat: heartbeat({}, 0), nowAt: 200_001 }).code, 'DESKTOP_ENDPOINT_CLOCK_INVALID');
  const blocked = registerDesktopEndpointHeartbeat({ identityScope: scope, heartbeat: heartbeat({ appVersion: '0.2.9' }) });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.trustState, 'version_blocked');
});

test('production accepts only packaged endpoints whose capability manifest is server trusted', () => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousManifests = process.env.ZHINAO_TRUSTED_ENDPOINT_MANIFESTS;
  const previousKeys = process.env.ZHINAO_TRUSTED_ENDPOINT_KEYS;
  try {
    process.env.NODE_ENV = 'production';
    process.env.ZHINAO_TRUSTED_ENDPOINT_MANIFESTS = 'b'.repeat(64);
    process.env.ZHINAO_TRUSTED_ENDPOINT_KEYS = publicKeyFingerprint;
    const rejected = registerDesktopEndpointHeartbeat({ identityScope: identity('production-rejected'), heartbeat: heartbeat() });
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.trustState, 'development_rejected');
    const trusted = registerDesktopEndpointHeartbeat({
      identityScope: identity('production-trusted'),
      heartbeat: heartbeat({ packaged: true, trustClaim: 'packaged_unverified', keyProtection: 'os_user_bound', capabilityManifestHash: 'b'.repeat(64) })
    });
    assert.equal(trusted.allowed, true);
    assert.equal(trusted.trustState, 'enterprise_trusted');
    const unprotected = registerDesktopEndpointHeartbeat({
      identityScope: identity('production-unprotected'),
      heartbeat: heartbeat({ packaged: true, trustClaim: 'packaged_unverified', capabilityManifestHash: 'b'.repeat(64) })
    });
    assert.equal(unprotected.allowed, false);
    assert.equal(unprotected.trustState, 'key_protection_required');
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment;
    if (previousManifests === undefined) delete process.env.ZHINAO_TRUSTED_ENDPOINT_MANIFESTS; else process.env.ZHINAO_TRUSTED_ENDPOINT_MANIFESTS = previousManifests;
    if (previousKeys === undefined) delete process.env.ZHINAO_TRUSTED_ENDPOINT_KEYS; else process.env.ZHINAO_TRUSTED_ENDPOINT_KEYS = previousKeys;
  }
});

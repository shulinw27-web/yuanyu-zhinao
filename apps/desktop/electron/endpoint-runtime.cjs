const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ENDPOINT_ID_PATTERN = /^endpoint-[0-9a-f-]{36}$/u;
const heartbeatPayload = (heartbeat) => JSON.stringify([
  heartbeat.protocolVersion,
  heartbeat.endpointId,
  heartbeat.appVersion,
  heartbeat.platform,
  heartbeat.packaged,
  heartbeat.trustClaim,
  heartbeat.keyProtection,
  heartbeat.capabilityManifestHash,
  heartbeat.observedAt
]);
const canonicalCapabilities = (capabilities) => JSON.stringify({
  protocolVersion: String(capabilities?.protocolVersion || ''),
  workspaceName: String(capabilities?.workspaceName || ''),
  tools: (capabilities?.tools || []).map((tool) => ({
    id: String(tool.id || ''),
    riskLevel: String(tool.riskLevel || ''),
    requiresConfirmation: Boolean(tool.requiresConfirmation),
    overwrite: Boolean(tool.overwrite),
    protocols: Array.isArray(tool.protocols) ? [...tool.protocols].sort() : []
  })).sort((left, right) => left.id.localeCompare(right.id))
});

const writeIdentity = (endpointFile, identity, createOnly = false) => {
  const handle = fs.openSync(endpointFile, createOnly ? 'wx' : 'w', 0o600);
  try {
    fs.writeFileSync(handle, JSON.stringify(identity), 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
};

const resolveSecretProtector = (secretProtector) => {
  if (secretProtector?.kind === 'os_user_bound' && typeof secretProtector.protect === 'function' && typeof secretProtector.unprotect === 'function') return secretProtector;
  return Object.freeze({ kind: 'file_system', protect: (value) => value, unprotect: (value) => value });
};

const ensureEndpointIdentity = (userDataRoot, secretProtector) => {
  const root = path.resolve(userDataRoot);
  fs.mkdirSync(root, { recursive: true });
  const rootStats = fs.lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('ENDPOINT_USER_DATA_INVALID');
  const endpointFile = path.join(root, 'endpoint-runtime.json');
  if (fs.existsSync(endpointFile)) {
    const stats = fs.lstatSync(endpointFile);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 4_096) throw new Error('ENDPOINT_IDENTITY_FILE_INVALID');
    const stored = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
    if (!ENDPOINT_ID_PATTERN.test(String(stored.endpointId || '')) || !stored.publicKey) throw new Error('ENDPOINT_IDENTITY_INVALID');
    if (stored.encryptedPrivateKey) {
      if (stored.keyProtection !== secretProtector.kind || secretProtector.kind !== 'os_user_bound') throw new Error('ENDPOINT_KEY_PROTECTOR_REQUIRED');
      return { ...stored, privateKey: secretProtector.unprotect(stored.encryptedPrivateKey) };
    }
    if (!stored.privateKey) throw new Error('ENDPOINT_IDENTITY_INVALID');
    if (secretProtector.kind === 'os_user_bound') {
      const migrated = {
        endpointId: stored.endpointId,
        publicKey: stored.publicKey,
        keyProtection: secretProtector.kind,
        encryptedPrivateKey: secretProtector.protect(stored.privateKey)
      };
      writeIdentity(endpointFile, migrated);
      return { ...migrated, privateKey: stored.privateKey };
    }
    return { ...stored, keyProtection: 'file_system' };
  }
  const endpointId = `endpoint-${crypto.randomUUID()}`;
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const identity = {
    endpointId,
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    keyProtection: secretProtector.kind,
    ...(secretProtector.kind === 'os_user_bound'
      ? { encryptedPrivateKey: secretProtector.protect(privateKey) }
      : { privateKey })
  };
  writeIdentity(endpointFile, identity, true);
  return { ...identity, privateKey };
};

function createEndpointRuntime({ userDataRoot, appVersion, packaged, platform, capabilities, secretProtector = null }) {
  if (!path.isAbsolute(userDataRoot)) throw new TypeError('userDataRoot must be absolute');
  const protector = resolveSecretProtector(secretProtector);
  const identity = ensureEndpointIdentity(userDataRoot, protector);
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  const capabilityManifestHash = crypto.createHash('sha256').update(canonicalCapabilities(capabilities)).digest('hex');
  return Object.freeze({
    status: () => {
      const heartbeat = {
        protocolVersion: 'endpoint-runtime.v1',
        endpointId: identity.endpointId,
        appVersion: String(appVersion || '0.0.0'),
        platform: String(platform || 'unknown'),
        packaged: Boolean(packaged),
        trustClaim: packaged ? 'packaged_unverified' : 'development_untrusted',
        keyProtection: identity.keyProtection,
        capabilityManifestHash,
        observedAt: new Date().toISOString(),
        publicKey: identity.publicKey
      };
      return { ...heartbeat, signature: crypto.sign(null, Buffer.from(heartbeatPayload(heartbeat)), privateKey).toString('base64url') };
    }
  });
}

module.exports = { createEndpointRuntime };

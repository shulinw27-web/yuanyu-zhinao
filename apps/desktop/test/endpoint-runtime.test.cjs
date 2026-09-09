const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEndpointRuntime } = require('../electron/endpoint-runtime.cjs');

const capabilities = {
  protocolVersion: 'desktop-execution.v1',
  workspaceName: '元域智脑工作区',
  tools: [
    { id: 'desktop.artifact.create_text', riskLevel: 'L1', requiresConfirmation: true, overwrite: false },
    { id: 'desktop.browser.open_https', riskLevel: 'L1', requiresConfirmation: true, protocols: ['https:'] }
  ]
};

test('endpoint runtime persists one local identity and emits no filesystem path', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhinao-endpoint-runtime-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const first = createEndpointRuntime({ userDataRoot: tempRoot, appVersion: '0.3.0', packaged: false, platform: 'win32', capabilities }).status();
  const second = createEndpointRuntime({ userDataRoot: tempRoot, appVersion: '0.3.0', packaged: false, platform: 'win32', capabilities }).status();
  assert.equal(first.endpointId, second.endpointId);
  assert.equal(first.capabilityManifestHash, second.capabilityManifestHash);
  assert.equal(first.trustClaim, 'development_untrusted');
  assert.equal(first.keyProtection, 'file_system');
  assert.equal(JSON.stringify(first).includes(tempRoot), false);
  assert.match(first.endpointId, /^endpoint-[0-9a-f-]{36}$/u);
  assert.match(first.capabilityManifestHash, /^[a-f0-9]{64}$/u);
  assert.ok(first.publicKey.length > 40);
  assert.ok(first.signature.length > 60);
});

test('capability proof changes when the allowlisted endpoint tool manifest changes', (t) => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhinao-endpoint-proof-a-'));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhinao-endpoint-proof-b-'));
  t.after(() => { fs.rmSync(firstRoot, { recursive: true, force: true }); fs.rmSync(secondRoot, { recursive: true, force: true }); });
  const first = createEndpointRuntime({ userDataRoot: firstRoot, appVersion: '0.3.0', packaged: true, platform: 'win32', capabilities }).status();
  const changed = createEndpointRuntime({ userDataRoot: secondRoot, appVersion: '0.3.0', packaged: true, platform: 'win32', capabilities: { ...capabilities, tools: [...capabilities.tools, { id: 'desktop.artifact.create_docx', riskLevel: 'L1', requiresConfirmation: true, overwrite: false }] } }).status();
  assert.equal(first.trustClaim, 'packaged_unverified');
  assert.notEqual(first.capabilityManifestHash, changed.capabilityManifestHash);
});

test('endpoint private key is protected at rest and existing plaintext identity migrates without changing endpoint', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhinao-endpoint-protected-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const legacy = createEndpointRuntime({ userDataRoot: tempRoot, appVersion: '0.3.0', packaged: false, platform: 'win32', capabilities }).status();
  const legacyStored = JSON.parse(fs.readFileSync(path.join(tempRoot, 'endpoint-runtime.json'), 'utf8'));
  const protector = {
    kind: 'os_user_bound',
    protect: (value) => Buffer.from(`bound:${value}`, 'utf8').toString('base64'),
    unprotect: (value) => Buffer.from(value, 'base64').toString('utf8').replace(/^bound:/u, '')
  };
  const protectedStatus = createEndpointRuntime({ userDataRoot: tempRoot, appVersion: '0.3.0', packaged: true, platform: 'win32', capabilities, secretProtector: protector }).status();
  const stored = JSON.parse(fs.readFileSync(path.join(tempRoot, 'endpoint-runtime.json'), 'utf8'));
  assert.equal(protectedStatus.endpointId, legacy.endpointId);
  assert.equal(protectedStatus.keyProtection, 'os_user_bound');
  assert.equal(stored.keyProtection, 'os_user_bound');
  assert.equal(Object.hasOwn(stored, 'privateKey'), false);
  assert.ok(stored.encryptedPrivateKey);
  assert.equal(JSON.stringify(stored).includes(legacyStored.privateKey), false);
});

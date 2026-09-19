import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { installOfflineNetworkGuard } from '../../scripts/lib/offline-network-guard.mjs';
import { onboardingMaterials, syntheticEnterprises } from '../../examples/mock-onboarding/materials.mjs';
import './mock-event-replay.test.js';
import './mock-event-checkpoint.test.js';

test('offline guard blocks fetch, raw sockets and HTTPS before contacting any destination', async () => {
  const guard = installOfflineNetworkGuard();
  try {
    await assert.rejects(fetch('https://example.invalid/private'), { code: 'MOCK_NETWORK_BLOCKED' });
    await assert.rejects(fetch('http://127.0.0.1:18080/'), { code: 'MOCK_NETWORK_BLOCKED' });
    assert.throws(() => net.connect({ host: '192.0.2.1', port: 443 }), { code: 'MOCK_NETWORK_BLOCKED' });
    assert.throws(() => https.request('https://example.invalid/private'), { code: 'MOCK_NETWORK_BLOCKED' });
    assert.throws(() => net.connect({ path: 'mock-test-pipe' }), { code: 'MOCK_NETWORK_BLOCKED' });
    assert.equal(guard.deniedAttempts, 5);
  } finally { guard.restore(); }
});

test('offline guard allows the registered ephemeral HTTP listener but refuses redirects', async () => {
  const server = createServer((req, res) => { if (req.url === '/redirect') res.writeHead(302, { Location: 'https://example.invalid/no' }); else res.writeHead(200); res.end('synthetic'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const guard = installOfflineNetworkGuard(); guard.allowPort(server.address().port);
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal(await (await fetch(url)).text(), 'synthetic');
    await assert.rejects(fetch(`${url}/redirect`));
    assert.equal(guard.deniedAttempts, 0);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); guard.restore(); }
});

test('synthetic enterprise materials contain five input kinds, tenant-scoped facts and no expected answer files', () => {
  for (const enterprise of syntheticEnterprises) {
    const materials = onboardingMaterials(enterprise.scenarioId, enterprise.tenantId);
    assert.deepEqual(materials.map(item => item.kind), ['requirements', 'api', 'dictionary', 'samples', 'rules']);
    const rows = JSON.parse(materials.find(item => item.kind === 'samples').text).records;
    assert.ok(rows.length); assert.ok(rows.every(row => row.tenantId === enterprise.tenantId));
    assert.ok(materials.every(item => !/expected|read-plan|assessment/i.test(item.name)));
  }
  assert.throws(() => onboardingMaterials('fulfillment', 'real-customer'));
});

for (const script of ['evaluate-mock-onboarding.mjs', 'evaluate-mock-calculation.mjs', 'evaluate-mock-lifecycle.mjs']) test(`isolated authenticated HTTP regression: ${script}`, { timeout: 30000 }, async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`scripts/${script}`, ...(script === 'evaluate-mock-onboarding.mjs' ? ['--no-artifacts'] : [])], {
      windowsHide: true, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Mock onboarding child timed out.')); }, 25000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true); assert.equal(report.modelInvoked, false);
  if (script === 'evaluate-mock-onboarding.mjs') { assert.equal(report.realSystemsVerified, false); assert.equal(report.blockedNetworkAttempts, 2); assert.ok(report.checks.length >= 20); }
  else if (script === 'evaluate-mock-calculation.mjs') { assert.equal(report.modelPublished, false); assert.equal(report.humanPlanAndTestGrants, true); assert.equal(report.checks.length, 7); }
  else { assert.equal(report.humanPlanAndTestGrants, true); assert.equal(report.deployment, 'TEST_DOUBLE_RECEIPT_NOT_REAL_SEMANTICA'); assert.equal(report.checks.length, 10); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getEnterpriseConnectorObservability, resetEnterpriseConnectorObservabilityForTest, retrieveAgentSystemEvidenceAsync } from '../src/services/system-integration-service.js';

const withEnvironment = async (values, callback) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await callback(); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    resetEnterpriseConnectorObservabilityForTest();
  }
};

const listen = (handler) => new Promise((resolve) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, endpoint: `http://127.0.0.1:${server.address().port}` }));
});

test('production connector mode never returns Mock facts when a real connector is absent', async () => {
  await withEnvironment({ NODE_ENV: 'production', ENTERPRISE_CONNECTORS_CONFIG_JSON: '{}' }, async () => {
    const result = await retrieveAgentSystemEvidenceAsync('请分析原料批 RM-VC-20260801 的质量异常', 'quality_manager', { tenantId: 'tenant-a', subjectId: 'user-a' });
    assert.equal(result.mode, 'enterprise_connectors_only');
    assert.equal(result.evidence.length, 0);
    assert.doesNotMatch(result.summary, /已从.*模拟记录/);
  });
});

test('enterprise connector evidence carries normalized provenance and lifecycle state', async () => {
  const { server, endpoint } = await listen((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ records: [{ id: 'RM-VC-20260801', tenantId: 'demo-enterprise', organizationId: 'org-quality-dept', version: 'v7', status: 'recalled', title: '原料批', statement: '该批次处于召回状态。', classification: 'restricted', occurredAt: '2026-08-31T01:02:03.000Z' }] }));
  });
  try {
    await withEnvironment({ NODE_ENV: 'production', ENTERPRISE_CONNECTORS_CONFIG_JSON: JSON.stringify({ qms: { endpoint } }) }, async () => {
      const result = await retrieveAgentSystemEvidenceAsync('请分析原料批 RM-VC-20260801 的质量异常', 'quality_manager', { tenantId: 'demo-enterprise', subjectId: 'quality@demo.local' });
      const evidence = result.evidence.find((item) => item.systemId === 'qms');
      assert.equal(evidence.lifecycleState, 'recalled');
      assert.equal(evidence.provenance.objectVersion, 'v7');
      assert.equal(evidence.provenance.connectorMode, 'enterprise_connector');
      assert.match(evidence.provenance.contentHash, /^[a-f0-9]{64}$/);
    });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('connector failures open a per-system circuit instead of repeatedly calling the supplier', async () => {
  let calls = 0;
  const { server, endpoint } = await listen((req, res) => { calls += 1; req.resume(); res.writeHead(503); res.end(); });
  try {
    await withEnvironment({ NODE_ENV: 'production', CONNECTOR_CIRCUIT_FAILURE_THRESHOLD: '2', ENTERPRISE_CONNECTORS_CONFIG_JSON: JSON.stringify({ qms: { endpoint } }) }, async () => {
      for (let index = 0; index < 3; index += 1) await retrieveAgentSystemEvidenceAsync('请分析质量异常', 'quality_manager', { tenantId: 'tenant-a', subjectId: `user-${index}` });
      assert.equal(calls, 2);
      const metric = getEnterpriseConnectorObservability().connectors.find((item) => item.systemId === 'qms');
      assert.equal(metric.circuitState, 'open');
      assert.equal(metric.rejectedByCircuit, 1);
    });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

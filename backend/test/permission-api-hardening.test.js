import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

async function reservePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('HTTP page gates, multi-role business actions, and risk response redaction are enforced together', async () => {
  const port = await reservePort();
  const semanticServer = createHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/demo/model-definition/validate') {
      res.end(JSON.stringify({ status: 'passed', validation: { passed: true }, engine: 'permission-test-semantica' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/demo/model-definition/publish') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const { definition } = JSON.parse(body);
        res.end(JSON.stringify({ status: 'published', deployment: { status: 'published', version: definition.version, sourceFingerprint: definition.sourceFingerprint }, engine: 'permission-test-semantica' }));
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => semanticServer.once('error', reject).listen(0, '127.0.0.1', resolve));
  const semanticEndpoint = `http://127.0.0.1:${semanticServer.address().port}`;
  const child = spawn(process.execPath, ['backend/src/app.js'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'development', DEMO_ALLOW_ROLE_HEADER: 'true', SEMANTICA_DEMO_BRIDGE_ENABLED: 'true', SEMANTIC_CONTEXT_ENDPOINT: semanticEndpoint, API_HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', (chunk) => { serverLog += chunk; });
  child.stderr.on('data', (chunk) => { serverLog += chunk; });
  const baseUrl = `http://127.0.0.1:${port}/api`;
  const call = async (path, roleId, { method = 'GET', body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-demo-role': roleId,
        'x-client-device-id': `api-hardening-${roleId}`
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, payload: await response.json() };
  };
  const waitUntilReady = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) return;
      } catch { /* API is still starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`权限加固测试 API 未就绪：${serverLog}`);
  };

  try {
    await waitUntilReady();

    for (const path of ['/world-model', '/meta-objects', '/meta-models']) {
      const denied = await call(path, 'marketing_manager');
      assert.equal(denied.status, 403, `${path} should be protected by the world page permission`);
      assert.equal(denied.payload.code, 'PAGE_PERMISSION_DENIED');
      assert.equal(denied.payload.error, denied.payload.message);
    }
    assert.equal((await call('/meta-objects', 'quality_manager')).status, 200);

    const admin = await call('/permission-management', 'executive');
    assert.equal(admin.status, 200);
    const marketUser = admin.payload.users.find((item) => item.id === 'usr-005');
    const assigned = await call(`/permission-management/users/${marketUser.id}/roles`, 'executive', {
      method: 'POST',
      body: {
        orgUnitId: marketUser.orgUnitId,
        roleIds: ['marketing_manager', 'procurement_manager', 'executive'],
        primaryRoleId: 'marketing_manager',
        expectedVersion: marketUser.version,
        reason: '验证多角色动作与字段脱敏'
      }
    });
    assert.equal(assigned.status, 200);

    const riskWrite = await call('/risk-cases/RC-2026-0042/acknowledge', 'marketing_manager', { method: 'POST', body: {} });
    assert.equal(riskWrite.status, 200);
    assert.equal(riskWrite.payload.affected.rawBatches, '受限');
    assert.equal(riskWrite.payload.affected.productionBatches, '受限');

    const procurementLaunch = await call('/procurement/launch', 'marketing_manager', { method: 'POST', body: {} });
    assert.equal(procurementLaunch.status, 200);
    assert.ok(procurementLaunch.payload.keyLease?.id);

    const evaluation = await call('/agent/evaluations/run', 'marketing_manager', { method: 'POST', body: {} });
    assert.equal(evaluation.status, 200);
    assert.equal(evaluation.payload.report.executedBy, 'executive');

    const rotatedKey = await call('/key-center/policies/kc-model-gateway/rotate', 'marketing_manager', { method: 'POST', body: {} });
    assert.equal(rotatedKey.status, 200);
    assert.ok(rotatedKey.payload.policy.version > 5);

    const simulatedMetaModel = await call('/meta-models/oa-governance/simulate-build', 'marketing_manager', { method: 'POST', body: {} });
    assert.equal(simulatedMetaModel.status, 200);
    const publishedMetaModel = await call('/meta-models/oa-governance/publish', 'marketing_manager', { method: 'POST', body: {} });
    assert.equal(publishedMetaModel.status, 200);
    assert.equal(publishedMetaModel.payload.simulation.status, 'published');

    const templates = await call('/world-model/templates', 'marketing_manager');
    const targets = await call('/world-model/connection-targets', 'marketing_manager');
    assert.equal(templates.status, 200);
    assert.equal(targets.status, 200);
    const worldDraft = await call('/world-model/drafts', 'marketing_manager', {
      method: 'POST',
      body: { templateId: templates.payload[0].id, targetId: targets.payload[0].id }
    });
    assert.equal(worldDraft.status, 200);
    assert.equal(worldDraft.payload.draft.createdBy, '管理层');

    const deniedEvaluation = await call('/agent/evaluations/run', 'quality_manager', { method: 'POST', body: {} });
    assert.equal(deniedEvaluation.status, 403);
    assert.equal(deniedEvaluation.payload.code, 'BUTTON_PERMISSION_DENIED');

    const agentScopedRoles = await call(`/permission-management/users/${marketUser.id}/roles`, 'executive', {
      method: 'POST',
      body: {
        orgUnitId: marketUser.orgUnitId,
        roleIds: ['marketing_manager', 'executive'],
        primaryRoleId: 'marketing_manager',
        expectedVersion: assigned.payload.user.version,
        reason: '隔离 Agent 原始次角色回归场景'
      }
    });
    assert.equal(agentScopedRoles.status, 200);
    const marketPolicy = admin.payload.roles.find((item) => item.id === 'marketing_manager').policy;
    const reducedMarketPolicy = await call('/permission-management/roles/marketing_manager/policy', 'executive', {
      method: 'POST',
      body: {
        menuIds: marketPolicy.menuIds,
        buttonPermissionIds: marketPolicy.buttonPermissionIds.filter((id) => id !== 'agent.prompt.run'),
        dataScope: marketPolicy.dataScope,
        expectedVersion: marketPolicy.version,
        reason: '验证 Agent 原始次角色与确认令牌绑定'
      }
    });
    assert.equal(reducedMarketPolicy.status, 200);
    const agentProposal = await call('/agent/message', 'marketing_manager', {
      method: 'POST',
      body: { input: { text: '我需要采购一批生产原料，请先生成受控协同计划。', attachments: [] } }
    });
    assert.equal(agentProposal.status, 200);
    assert.equal(agentProposal.payload.agent.authorization.user.id, 'executive');
    assert.ok(agentProposal.payload.command?.confirmationToken);
    const agentExecution = await call('/agent/execute', 'marketing_manager', {
      method: 'POST',
      body: {
        runId: agentProposal.payload.runId,
        commandId: agentProposal.payload.command.id,
        confirmationToken: agentProposal.payload.command.confirmationToken
      }
    });
    assert.equal(agentExecution.status, 200);
    const restoredMarketPolicy = await call('/permission-management/roles/marketing_manager/policy', 'executive', {
      method: 'POST',
      body: {
        menuIds: marketPolicy.menuIds,
        buttonPermissionIds: marketPolicy.buttonPermissionIds,
        dataScope: marketPolicy.dataScope,
        expectedVersion: reducedMarketPolicy.payload.role.policy.version,
        reason: '恢复 Agent 多角色回归基线'
      }
    });
    assert.equal(restoredMarketPolicy.status, 200);

    const restored = await call(`/permission-management/users/${marketUser.id}/roles`, 'executive', {
      method: 'POST',
      body: {
        orgUnitId: marketUser.orgUnitId,
        roleIds: marketUser.roleIds,
        primaryRoleId: marketUser.primaryRoleId,
        expectedVersion: agentScopedRoles.payload.user.version,
        reason: '恢复多角色回归测试基线'
      }
    });
    assert.equal(restored.status, 200);

    const riskDetailBaseline = restoredMarketPolicy.payload.role.policy;
    const detailGrantRemoved = await call('/permission-management/roles/marketing_manager/policy', 'executive', {
      method: 'POST',
      body: {
        menuIds: riskDetailBaseline.menuIds,
        buttonPermissionIds: riskDetailBaseline.buttonPermissionIds.filter((id) => id !== 'risk.detail.view'),
        dataScope: riskDetailBaseline.dataScope,
        expectedVersion: riskDetailBaseline.version,
        reason: '验证风险详情 GET 的按钮级后端门禁'
      }
    });
    assert.equal(detailGrantRemoved.status, 200);
    assert.equal((await call('/risk-cases', 'marketing_manager')).status, 200);
    const deniedRiskDetail = await call('/risk-cases/RC-2026-0042', 'marketing_manager');
    assert.equal(deniedRiskDetail.status, 403);
    assert.equal(deniedRiskDetail.payload.code, 'BUTTON_PERMISSION_DENIED');

    const riskDetailGrantRestored = await call('/permission-management/roles/marketing_manager/policy', 'executive', {
      method: 'POST',
      body: {
        menuIds: riskDetailBaseline.menuIds,
        buttonPermissionIds: riskDetailBaseline.buttonPermissionIds,
        dataScope: riskDetailBaseline.dataScope,
        expectedVersion: detailGrantRemoved.payload.role.policy.version,
        reason: '恢复风险详情按钮授权'
      }
    });
    assert.equal(riskDetailGrantRestored.status, 200);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => semanticServer.close(resolve));
  }
});

test('production account center rejects anonymous requests before page authorization', async () => {
  const port = await reservePort();
  const child = spawn(process.execPath, ['backend/src/app.js'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', DEMO_ALLOW_ROLE_HEADER: 'false', OA_AUTH_MODE: 'oidc', ACCOUNT_AUTH_MODE: 'enterprise', OIDC_ISSUER: 'https://sso.example.test', OIDC_AUDIENCE: 'healthcare-ai', OIDC_JWKS_URI: 'https://sso.example.test/.well-known/jwks.json', OIDC_TENANT_ID: 'tenant-enterprise', AGENT_RUNTIME_MODE: 'local', KEY_CENTER_PROVIDER: 'external-kms', KEY_CENTER_PROVIDER_URL: 'https://kms-broker.example.test', KEY_CENTER_WORKLOAD_ID: 'agent-api', RUNTIME_STORE_DRIVER: 'sqlite', SINGLE_NODE_DEPLOYMENT: 'true', CORS_ALLOWED_ORIGINS: 'https://demo.example.test', API_HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', (chunk) => { serverLog += chunk; });
  child.stderr.on('data', (chunk) => { serverLog += chunk; });
  const baseUrl = `http://127.0.0.1:${port}/api`;
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        if ((await fetch(`${baseUrl}/health`)).ok) break;
      } catch { /* API is still starting. */ }
      if (attempt === 39) throw new Error(`生产权限测试 API 未就绪：${serverLog}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const response = await fetch(`${baseUrl}/account-center`);
    const payload = await response.json();
    assert.equal(response.status, 401);
    assert.equal(payload.error, '请先完成身份认证。');
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

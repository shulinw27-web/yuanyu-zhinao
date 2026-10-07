import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resetRuntimeState, writeState } from '../src/repositories/runtime-state-repository.js';
import {
  dispatchAlert,
  getAlertingWorkspaceForAccess,
  recordVoiceCallEvent,
  saveAlertingConfiguration,
  simulateAlert,
  testVoiceCall
} from '../src/domains/alerting/alerting-service.js';
import { runWithIAMStoreContext } from '../src/services/iam-store.js';
import { createTenantIAMWorkspace, iamWorkspaceKey } from '../src/services/iam-workspace-model.js';
import { initialRolePolicies } from '../src/data/iam-seed.js';
import { getAlertingState } from '../src/domains/alerting/alerting-store.js';

const executiveIdentity = { source: 'demo_header', subjectId: 'demo:executive:alerting-test' };
const actor = { type: 'test', id: 'alerting-test' };

test('deterministic rules classify P0/P1/P2 and only immediate P0 creates a voice call', async () => {
  resetRuntimeState(['alerting']);
  const p0 = await simulateAlert({ sourceSystem: 'LIMS', eventType: 'TestResultFailed', organizationId: 'org-quality-dept', ownerUserId: 'usr-003', affectedOrders: 2 }, actor);
  const p1 = await simulateAlert({ sourceSystem: 'ERP', eventType: 'InventoryExpiring', organizationId: 'org-procurement-dept', ownerUserId: 'usr-004', affectedOrders: 1 }, actor);
  const p2 = await simulateAlert({ sourceSystem: 'OMS', eventType: 'TrendNotice', organizationId: 'org-market-dept', ownerUserId: 'usr-005', affectedOrders: 0 }, actor);
  assert.equal(p0.classification.severity, 'P0');
  assert.equal(p1.classification.severity, 'P1');
  assert.equal(p2.classification.severity, 'P2');
  assert.ok(p0.deliveries.some((item) => item.channel === 'voice'));
  assert.equal(p1.deliveries.some((item) => item.channel === 'voice'), false);
  assert.equal(p2.deliveries.some((item) => item.channel === 'voice'), false);
  const workspace = await getAlertingWorkspaceForAccess('executive', executiveIdentity);
  assert.equal(workspace.auditIntegrity.valid, true);
  assert.equal(workspace.voiceCalls.filter((item) => item.riskId === p0.alert.riskId).length, 1);
  assert.equal(workspace.voiceCalls.filter((item) => item.riskId === p1.alert.riskId || item.riskId === p2.alert.riskId).length, 0);
  const escalated = await recordVoiceCallEvent(workspace.voiceCalls.find((item) => item.riskId === p0.alert.riskId).id, 'escalate', actor);
  assert.ok(escalated.escalationDeliveries.some((item) => item.channel === 'voice' && item.escalationStep === 2));
  const afterEscalation = await getAlertingWorkspaceForAccess('executive', executiveIdentity);
  assert.equal(afterEscalation.voiceCalls.filter((item) => item.riskId === p0.alert.riskId).length, 2);
  assert.equal(afterEscalation.auditIntegrity.valid, true);
});

test('configuration is versioned and P2 cannot be configured for immediate voice calls', async () => {
  resetRuntimeState(['alerting']);
  const baseline = await getAlertingWorkspaceForAccess('executive', executiveIdentity);
  const invalidLevels = structuredClone(baseline.severityLevels);
  invalidLevels.find((item) => item.id === 'P2').voiceMode = 'immediate';
  const denied = await saveAlertingConfiguration({ expectedVersion: baseline.configurationVersion, severityLevels: invalidLevels }, actor);
  assert.equal(denied.code, 'P2_IMMEDIATE_VOICE_DENIED');
  const nextLevels = structuredClone(baseline.severityLevels);
  nextLevels.find((item) => item.id === 'P1').acknowledgementMinutes = 20;
  const nextSchedules = structuredClone(baseline.onCallSchedules);
  nextSchedules.find((item) => item.id === 'oncall-quality').backupUserIds = ['usr-002'];
  const nextEscalationPolicies = structuredClone(baseline.escalationPolicies);
  nextEscalationPolicies.find((item) => item.id === 'p0-default').steps[1].delayMinutes = 6;
  const saved = await saveAlertingConfiguration({ expectedVersion: baseline.configurationVersion, severityLevels: nextLevels, onCallSchedules: nextSchedules, escalationPolicies: nextEscalationPolicies }, actor);
  assert.equal(saved.configurationVersion, baseline.configurationVersion + 1);
  const published = await getAlertingWorkspaceForAccess('executive', executiveIdentity);
  assert.deepEqual(published.onCallSchedules.find((item) => item.id === 'oncall-quality').backupUserIds, ['usr-002']);
  assert.equal(published.escalationPolicies.find((item) => item.id === 'p0-default').steps[1].delayMinutes, 6);
  const stale = await saveAlertingConfiguration({ expectedVersion: baseline.configurationVersion, severityLevels: nextLevels }, actor);
  assert.equal(stale.code, 'VERSION_CONFLICT');
});

test('voice DTMF acknowledgment records receipt but never grants high-risk approval', async () => {
  resetRuntimeState(['alerting']);
  const created = await testVoiceCall({ userId: 'usr-003' }, actor);
  assert.equal(created.call.status, 'answered');
  assert.equal(Object.hasOwn(created.call, 'phoneRef'), false);
  const receipt = await recordVoiceCallEvent(created.call.id, 'acknowledge', actor);
  assert.equal(receipt.call.status, 'acknowledged');
  assert.match(receipt.message, /业务处置仍需登录系统/);
  const workspace = await getAlertingWorkspaceForAccess('executive', executiveIdentity);
  const event = workspace.audits.find((item) => item.callId === created.call.id && item.type === 'voice_acknowledge');
  assert.equal(event.details.highRiskApprovalGranted, false);
  assert.equal(workspace.auditIntegrity.valid, true);
});

test('alerting workspace and calls remain organization scoped', async () => {
  resetRuntimeState(['alerting']);
  await simulateAlert({ sourceSystem: 'LIMS', eventType: 'TestResultFailed', organizationId: 'org-quality-dept', ownerUserId: 'usr-003' }, actor);
  const procurement = await getAlertingWorkspaceForAccess('procurement_manager', { source: 'identity_session', subjectId: 'procurement@demo.local' });
  assert.equal(procurement.voiceCalls.some((item) => item.organizationId === 'org-quality-dept'), false);
  assert.equal(procurement.audits.some((item) => item.organizationId === 'org-quality-dept'), false);
  assert.deepEqual(procurement.eligibleContactUsers, [], '没有发布权限的角色不得读取联系人候选目录');
});

test('alerting workspaces and contact points are tenant scoped and never inherit Demo recipients', async () => {
  resetRuntimeState(['alerting', 'iam', 'domain_event_outbox']);
  const tenantId = 'alerting-enterprise-a';
  const iam = createTenantIAMWorkspace(tenantId);
  iam.organizations = [{ id: 'org-a', name: '企业 A', parentId: null }];
  iam.users = [{ id: 'admin-a', account: 'admin@a.example', name: '企业 A 管理员', title: '管理员', department: '信息部', orgUnitId: 'org-a', roleIds: ['executive'], primaryRoleId: 'executive', status: 'active', sources: ['local'], version: 1 }];
  iam.rolePolicies = { executive: structuredClone(initialRolePolicies.executive) };
  writeState('iam', iamWorkspaceKey(tenantId), iam);

  await runWithIAMStoreContext(async () => {
    const identity = { tenantId, subjectId: 'admin-a', source: 'identity_session' };
    const baseline = await getAlertingWorkspaceForAccess('executive', identity);
    assert.deepEqual(baseline.contactPoints, [], '新租户不得继承 Demo 联系点');
    assert.deepEqual(baseline.eligibleContactUsers.map((item) => item.id), ['admin-a'], '联系人候选只来自当前租户 IAM');
    const saved = await saveAlertingConfiguration({
      expectedVersion: baseline.configurationVersion,
      contactPoints: [{ userId: 'admin-a', email: 'ops@a.example', maskedPhone: '139****1001', phoneRef: 'pii://tenant-a/users/admin-a/mobile', enabledChannels: ['in_app', 'push', 'email', 'voice'] }]
    }, { ...actor, tenantId });
    assert.equal(saved.error, undefined);
    const publicWorkspace = await getAlertingWorkspaceForAccess('executive', identity);
    assert.equal(Object.hasOwn(publicWorkspace.contactPoints[0], 'phoneRef'), false, '工作区不得返回真实号码引用');
    const republished = await saveAlertingConfiguration({
      expectedVersion: publicWorkspace.configurationVersion,
      contactPoints: publicWorkspace.contactPoints
    }, { ...actor, tenantId });
    assert.equal(republished.error, undefined);
    assert.equal((await getAlertingState()).contactPoints[0].phoneRef, 'pii://tenant-a/users/admin-a/mobile', '界面回写不得清空隐藏的 PII 引用');

    const escalationWorkspace = await getAlertingWorkspaceForAccess('executive', identity);
    const escalationPolicies = structuredClone(escalationWorkspace.escalationPolicies);
    const p2 = escalationPolicies.find((item) => item.severity === 'P2');
    p2.steps[0].receiverType = 'executive';
    p2.steps[0].channels = ['email'];
    assert.equal((await saveAlertingConfiguration({
      expectedVersion: escalationWorkspace.configurationVersion,
      escalationPolicies
    }, { ...actor, tenantId })).error, undefined);
    const executiveDelivery = await dispatchAlert({ riskId: 'TENANT-A-EXECUTIVE-1', title: '企业 A 管理层通知', sourceSystem: 'OMS', eventType: 'TrendNotice', organizationId: 'org-a', tenantId });
    assert.ok(executiveDelivery.deliveries.some(item => item.receiverUserId === 'admin-a' && item.target === 'ops@a.example'), '管理层升级必须解析当前租户 executive，而不是 Demo 用户');

    const dispatched = await dispatchAlert({ riskId: 'TENANT-A-SYSMON-1', title: '企业 A 系统异常', sourceSystem: 'ERP', eventType: 'SystemConnectionProbeFailed', organizationId: 'org-a', ownerUserId: 'admin-a', tenantId });
    assert.equal(dispatched.error, undefined);
    assert.ok(dispatched.deliveries.some(item => item.channel === 'email' && item.target === 'ops@a.example'));
    assert.equal((await getAlertingWorkspaceForAccess('executive', identity)).simulatedAlerts.some(item => item.riskId === 'TENANT-A-SYSMON-1'), true);
  }, tenantId);

  const demo = await getAlertingWorkspaceForAccess('executive', executiveIdentity);
  assert.equal(demo.simulatedAlerts.some(item => item.riskId === 'TENANT-A-SYSMON-1'), false, 'Demo 不得读取企业 A 告警');
  assert.ok(demo.contactPoints.some(item => item.email === 'admin@demo.local'), 'Demo 自身种子联系点保持可用');
});

test('alert dispatch rejects a tenant claim that differs from the bound IAM workspace', async () => {
  resetRuntimeState(['alerting']);
  await runWithIAMStoreContext(async () => {
    const denied = await dispatchAlert({ riskId: 'FORGED-TENANT', eventType: 'TrendNotice', tenantId: 'tenant-b' });
    assert.equal(denied.code, 'ALERT_TENANT_CONTEXT_MISMATCH');
  }, 'tenant-a');
});

async function reservePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('HTTP alerting APIs enforce page and button permissions', async () => {
  const port = await reservePort();
  const child = spawn(process.execPath, ['backend/src/app.js'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'development', RUNTIME_STORE_DRIVER: 'memory', DEMO_ALLOW_ROLE_HEADER: 'true', API_HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', (chunk) => { serverLog += chunk; });
  child.stderr.on('data', (chunk) => { serverLog += chunk; });
  const baseUrl = `http://127.0.0.1:${port}/api`;
  const call = async (path, roleId, { method = 'GET', body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', 'x-demo-role': roleId, 'x-client-device-id': `alerting-http-${roleId}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, payload: await response.json() };
  };
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { if ((await fetch(`${baseUrl}/health`)).ok) break; } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (attempt === 39) throw new Error(`告警测试 API 未就绪：${serverLog}`);
    }
    assert.equal((await call('/alerting/workspace', 'quality_manager')).status, 200);
    const denied = await call('/alerting/simulations', 'quality_manager', { method: 'POST', body: { sourceSystem: 'LIMS', eventType: 'TestResultFailed' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.payload.code, 'BUTTON_PERMISSION_DENIED');
    const simulated = await call('/alerting/simulations', 'executive', { method: 'POST', body: { sourceSystem: 'LIMS', eventType: 'TestResultFailed', organizationId: 'org-quality-dept', ownerUserId: 'usr-003' } });
    assert.equal(simulated.status, 200);
    assert.equal(simulated.payload.classification.severity, 'P0');
    assert.ok(simulated.payload.workspace.voiceCalls.some((item) => item.riskId === simulated.payload.alert.riskId));
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

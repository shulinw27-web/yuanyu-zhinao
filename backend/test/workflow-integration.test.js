import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { currentSemanticTenant, runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import {
  getWorkflowIntegrationOverview,
  getWorkflowDefinition,
  syncWorkflowDefinitions,
  syncConfiguredWorkflowDefinitions,
  reviewWorkflowDefinition,
  queryPublishedWorkflowContext,
  workflowWebhookOperations
} from '../src/domains/workflow-integration/public-api.js';
import { handleWorkflowIntegrationRoutes } from '../src/routes/workflow-integration-routes.js';
import { routeAgentTask, shouldHonorDeterministicWorkflowRead } from '../src/services/agent-orchestration-service.js';
import { authorizeZhiNaoTask } from '../src/services/zhinao-authorization-service.js';
import { executeReadOnlyTool } from '../src/services/agent-tool-registry.js';
import { roles } from '../src/data/seed.js';
import { runPrivateAgent } from '../src/services/private-agent-service.js';
import { resolveWorkflowSyncTenantIds, runConfiguredWorkflowSyncCycles, runWorkflowEventInboxCycles } from '../src/workers/workflow-sync-worker.js';
import { isPublicPath } from '../src/http/route-security.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Use the runtime-test-bootstrap memory store.');

const identity = tenantId => ({ tenantId, subjectId: 'operator-1', deviceId: 'device-1', roleId: 'procurement_manager' });
const within = (tenantId, work) => runWithSemanticTenant(identity(tenantId), work);

test.beforeEach(() => resetRuntimeState(['workflow_integration', 'workflow_webhook_inbox']));

test('模型理解失败时仅为带明确编号的流程查询保留确定性读取', () => {
  assert.equal(shouldHonorDeterministicWorkflowRead('生产工单 MO-20261008-021 现在到哪个流程节点？'), true);
  assert.equal(shouldHonorDeterministicWorkflowRead('运单 WB-20261008-778 的物流异常流程进展是什么？'), true);
  assert.equal(shouldHonorDeterministicWorkflowRead('生产流程是什么？'), false, '没有业务编号时不得读取企业流程数据');
  assert.equal(shouldHonorDeterministicWorkflowRead('分析生产批次 RC-2026-0041'), false, '非流程领域编号不得误走流程工具');
});

test('首次装载形成管理、业务和混合流程目录，流程结构来自确定性连接器', () => within('workflow-a', () => {
  const overview = getWorkflowIntegrationOverview();
  assert.equal(overview.metrics.definitions, 5);
  assert.equal(overview.metrics.published, 5);
  assert.equal(overview.metrics.reviewRequired, 0);
  assert.deepEqual(new Set(overview.definitions.map(item => item.category)), new Set(['management', 'business', 'hybrid']));
  assert.deepEqual(new Set(overview.definitions.map(item => item.processType)), new Set(['internal_affairs', 'procurement', 'production_manufacturing', 'logistics']));
  assert.equal(overview.metrics.crossSystemDefinitions, 5);
  assert.equal(overview.syncPolicy.realTime.enabled, true);
  assert.equal(overview.syncPolicy.scheduled.mode, 'incremental_reconciliation');
  assert.equal(overview.syncPolicy.manual.permission, 'meta_model.draft.save');
  assert.equal(overview.boundary.mode, 'read_only');

  const purchase = getWorkflowDefinition('DINGTALK-PURCHASE');
  assert.equal(purchase.definition.version, '3');
  assert.equal(purchase.definition.validation.status, 'passed');
  assert.ok(purchase.definition.nodes.some(node => node.type === 'condition' && node.expression === 'totalAmount >= 50000'));
  assert.ok(purchase.definition.fields.some(field => field.semanticTarget === 'PurchaseOrder.totalAmount'));
}));

test('增量同步发现新流程和破坏性变更，但不会自动替换智脑生效版本', () => within('workflow-b', () => {
  const result = syncWorkflowDefinitions({ scenario: 'changed' });
  assert.equal(result.syncRun.discovered, 1);
  assert.equal(result.syncRun.changed, 1);
  const overview = getWorkflowIntegrationOverview();
  assert.equal(overview.metrics.reviewRequired, 2);
  assert.equal(overview.metrics.published, 5, '存在候选版本时，旧生效版本仍应计入智脑可读取流程');

  const purchase = getWorkflowDefinition('DINGTALK-PURCHASE');
  assert.equal(purchase.activeVersion, '3');
  assert.equal(purchase.definition.version, '4');
  assert.equal(purchase.definition.publicationStatus, 'candidate');
  assert.equal(purchase.definition.diff.breaking, true);
  assert.ok(purchase.definition.diff.changes.some(change => change.includes('流转条件')));

  const query = queryPublishedWorkflowContext({ query: 'PO-20261008-001', identityScope: identity('workflow-b') });
  assert.equal(query.matches.length, 1);
  assert.equal(query.matches[0].definition.version, '3', '校对前智脑必须继续读取 v3');
}));

test('运营人员发布候选版本后智脑读取面切换版本，重复同步保持幂等', () => within('workflow-c', () => {
  syncWorkflowDefinitions({ scenario: 'changed' });
  const reviewed = reviewWorkflowDefinition({ code: 'DINGTALK-PURCHASE', version: '4', action: 'publish', actor: { type: 'user', id: 'reviewer' } });
  assert.equal(reviewed.activeVersion, '4');
  assert.equal(reviewed.definition.reviewStatus, 'approved');
  const second = syncWorkflowDefinitions({ scenario: 'changed' });
  assert.equal(second.syncRun.changed, 0);
  assert.equal(second.syncRun.discovered, 0);
  assert.equal(second.syncRun.unchanged, 6);
  const inFlight = queryPublishedWorkflowContext({ query: 'PO-20261008-001', identityScope: identity('workflow-c') });
  assert.equal(inFlight.matches.length, 1, '新版本发布后，仍在旧版本上运行的实例不能消失');
  assert.equal(inFlight.matches[0].definition.version, '3');
}));

test('管理流程对非本人查询隐藏个人信息，业务流程保留业务证据和当前节点', () => within('workflow-d', () => {
  const management = queryPublishedWorkflowContext({ query: '张三请假', identityScope: identity('workflow-d') });
  assert.equal(management.matches.length, 1);
  assert.equal(management.matches[0].redacted, true);
  assert.equal(management.matches[0].applicantName, '受限人员');
  assert.doesNotMatch(management.matches[0].title, /张三/u);
  assert.ok(management.matches[0].timeline.every(item => !item.actorDisplay || item.actorDisplay === '受限角色'));
  const operationalDetail = getWorkflowDefinition('DINGTALK-LEAVE', { identityScope: { ...identity('workflow-d'), roleId: 'marketing_manager' } });
  assert.equal(operationalDetail.instances[0].redactionReason, 'workflow_personal_scope');
  const ownDetail = getWorkflowDefinition('DINGTALK-LEAVE', { identityScope: { ...identity('workflow-d'), subjectId: 'EMP-001', roleId: 'marketing_manager' } });
  assert.equal(ownDetail.instances[0].applicantName, '张三');

  const business = queryPublishedWorkflowContext({ query: 'PO-20261008-001', identityScope: identity('workflow-d') });
  assert.equal(business.matches[0].currentNode.label, '财务审批');
  assert.equal(business.matches[0].evidence.sourceVersion, '3');
  assert.match(business.matches[0].summary, /ERP 尚未获准/u);

  const restricted = queryPublishedWorkflowContext({ query: 'PO-20261008-001', identityScope: { ...identity('workflow-d'), roleId: 'marketing_manager' } });
  assert.equal(restricted.matches[0].amount, null);
  assert.equal(restricted.matches[0].redactionReason, 'workflow_field_scope');
  assert.ok(restricted.matches[0].timeline.every(item => !item.actorDisplay || item.actorDisplay === '受限角色'));
}));

test('自然语言流程问题路由到流程语义工具，并只使用已发布版本回答', async () => within('workflow-agent', async () => {
  syncWorkflowDefinitions({ scenario: 'changed' });
  const route = routeAgentTask('采购单 PO-20261008-001 审批到哪一步了？');
  assert.equal(route.primaryDomain, 'workflow');
  assert.ok(route.subAgents.some(item => item.tool === 'read_workflow_context'));
  const authorization = authorizeZhiNaoTask({ role: roles.procurement_manager, route });
  assert.ok(authorization.allowedTools.includes('read_workflow_context'));
  const result = await executeReadOnlyTool('read_workflow_context', roles.procurement_manager, authorization, identity('workflow-agent'), { businessIds: ['PO-20261008-001'] }, { goal: '采购单 PO-20261008-001 审批到哪一步了？' });
  assert.match(result.summary, /财务审批/u);
  assert.match(result.summary, /ERP 尚未获准/u);
  assert.ok(result.evidence.some(item => item.id === 'DT-PURCHASE-20261008-009' && item.version === '3'));
  const historyRoute = routeAgentTask('采购单 PO-20261008-001 的审批记录是什么？');
  assert.equal(historyRoute.primaryDomain, 'workflow');
  const history = await executeReadOnlyTool('read_workflow_context', roles.procurement_manager, authorization, identity('workflow-agent'), { businessIds: ['PO-20261008-001'] }, { goal: '采购单 PO-20261008-001 的审批记录是什么？' });
  assert.match(history.summary, /流转记录/u);
  assert.match(history.summary, /采购负责人已通过/u);
}));

test('流程目录问题返回已发布定义，但不暴露管理流程表单或候选版本', () => within('workflow-catalog', () => {
  syncWorkflowDefinitions({ scenario: 'changed' });
  const result = queryPublishedWorkflowContext({ query: '现在有哪些流程？', identityScope: identity('workflow-catalog') });
  assert.equal(result.definitions.length, 5);
  assert.ok(result.definitions.every(item => !Object.hasOwn(item, 'fields')));
  const purchase = result.definitions.find(item => item.code === 'DINGTALK-PURCHASE');
  assert.equal(purchase.version, '3');
}));

test('智脑完整对话链能回答审批进度和流程目录，不附带无关领域拒绝', async () => {
  const scope = identity('workflow-dialogue');
  scope.subjectId = 'procurement@demo.local';
  const progress = await runWithSemanticTenant(scope, () => runPrivateAgent('采购单 PO-20261008-001 审批到哪一步了？', roles.procurement_manager, scope));
  assert.match(progress.text, /财务审批/u);
  assert.doesNotMatch(progress.text, /未获得 internal/u);
  assert.deepEqual(progress.route.map(item => item.id), ['orchestrator', 'workflow']);
  assert.ok(progress.evidence.some(item => item.id === 'DT-PURCHASE-20261008-009' && item.version === '3'));

  const catalogScope = identity('workflow-dialogue-catalog');
  catalogScope.subjectId = 'procurement@demo.local';
  const catalog = await runWithSemanticTenant(catalogScope, () => runPrivateAgent('现在有哪些流程？', roles.procurement_manager, catalogScope));
  assert.match(catalog.text, /员工请假审批/u);
  assert.match(catalog.text, /采购申请审批/u);
  assert.match(catalog.text, /生产工单投产与放行/u);
  assert.match(catalog.text, /物流异常协同处置/u);
  assert.ok(catalog.evidence.some(item => item.id === 'DINGTALK-PURCHASE'));
});

test('跨系统 Mock 生产与物流流程可由智脑 Agent 读取和解释', async () => {
  const productionScope = { ...identity('workflow-agent-production'), subjectId: 'production@demo.local', roleId: 'production_manager' };
  const production = await runWithSemanticTenant(productionScope, () => runPrivateAgent('生产工单 MO-20261008-021 现在到哪个流程节点？涉及哪些系统？', roles.production_manager, productionScope));
  assert.match(production.text, /QMS 质量放行校验/u);
  assert.match(production.text, /OA → ERP → WMS → QMS → MES/u);
  assert.ok(production.evidence.some(item => item.id === 'OA-PROD-20261008-021'));

  const logisticsScope = { ...identity('workflow-agent-logistics'), subjectId: 'procurement@demo.local' };
  const logistics = await runWithSemanticTenant(logisticsScope, () => runPrivateAgent('运单 WB-20261008-778 的物流异常流程进展和跨系统链路是什么？', roles.procurement_manager, logisticsScope));
  assert.match(logistics.text, /物流负责人确认处置/u);
  assert.match(logistics.text, /DINGTALK → OMS → WMS → TMS/u);
  assert.ok(logistics.evidence.some(item => item.id === 'DT-LOG-20261008-016'));
});

test('HTTP 路由对同步和发布使用不同权限闸门', async () => within('workflow-e', async () => {
  let response;
  const call = async ({ method, path, body, permissions = [] }) => {
    response = null;
    const handled = await handleWorkflowIntegrationRoutes({
      req: { method }, res: {}, url: new URL(`http://test${path}`), agentIdentity: identity('workflow-e'),
      selectActionRole: permission => permissions.includes(permission) ? { id: 'operator' } : null,
      denyButton: permission => { response = { status: 403, value: { permission } }; },
      readBody: async () => body,
      send: (_res, status, value) => { response = { status, value }; }
    });
    assert.equal(handled, true);
    return response;
  };

  assert.equal((await call({ method: 'GET', path: '/api/semantic-operations/workflows' })).status, 200);
  assert.equal((await call({ method: 'POST', path: '/api/semantic-operations/workflows/sync', body: { scenario: 'changed' } })).status, 403);
  assert.equal((await call({ method: 'POST', path: '/api/semantic-operations/workflows/sync', body: { scenario: 'changed' }, permissions: ['meta_model.draft.save'] })).status, 200);
  const configured = await call({ method: 'POST', path: '/api/semantic-operations/workflows/sync', body: { mode: 'configured' }, permissions: ['meta_model.draft.save'] });
  assert.equal(configured.status, 503);
  assert.equal(configured.value.code, 'WORKFLOW_CONNECTOR_NOT_CONFIGURED');
  assert.equal((await call({ method: 'POST', path: '/api/semantic-operations/workflows/DINGTALK-PURCHASE/versions/4/review', body: { action: 'publish' }, permissions: ['meta_model.draft.save'] })).status, 403);
  assert.equal((await call({ method: 'POST', path: '/api/semantic-operations/workflows/DINGTALK-PURCHASE/versions/4/review', body: { action: 'publish' }, permissions: ['meta_model.publish'] })).status, 200);
}));

test('受控真实连接器只从服务端凭据拉取规范化定义，并生成待校对候选版本', async () => within('workflow-configured', async () => {
  const source = getWorkflowDefinition('DINGTALK-PURCHASE').definition;
  const incoming = structuredClone(source);
  incoming.provider = 'dingtalk-live';
  incoming.version = '5';
  incoming.updatedAt = '2026-10-08T06:00:00.000Z';
  incoming.nodes.find(item => item.id === 'amount').expression = 'totalAmount >= 20000';
  const requests = [];
  const liveInstance = {
    provider: 'dingtalk-live', id: 'DT-LIVE-PURCHASE-001', definitionCode: 'DINGTALK-PURCHASE', definitionVersion: '5',
    title: '采购单 PO-LIVE-20261008-001 审批', status: 'running', currentNodeId: 'finance', applicantId: 'BUYER-009',
    applicantName: '采购专员', startedAt: '2026-10-08T05:30:00.000Z', updatedAt: '2026-10-08T06:10:00.000Z',
    businessKey: 'PO-LIVE-20261008-001', amount: 28000, summary: '生产连接器实例，当前等待财务审批。', timeline: [
      { id: 'live-submit', nodeId: 'start', label: '采购申请已提交', action: 'submitted', actorDisplay: '采购专员', occurredAt: '2026-10-08T05:30:00.000Z' },
      { id: 'live-finance', nodeId: 'finance', label: '进入财务审批', action: 'entered', actorDisplay: '财务经理', occurredAt: '2026-10-08T06:10:00.000Z' }
    ]
  };
  const env = {
    WORKFLOW_CONNECTORS_CONFIG_JSON: JSON.stringify([{ id: 'dingtalk-live', name: '钉钉生产适配网关', baseUrl: 'http://127.0.0.1:3999/', definitionsPath: '/api/workflow-definitions', credentialEnv: 'DINGTALK_WORKFLOW_TOKEN' }]),
    DINGTALK_WORKFLOW_TOKEN: 'server-secret'
  };
  const result = await syncConfiguredWorkflowDefinitions({
    env,
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), options });
      const cursor = new URL(url).searchParams.get('cursor');
      const payload = cursor
        ? { cursor: 'live-cursor-5', definitions: [], instances: [liveInstance] }
        : { cursor: 'live-cursor-4', nextCursor: 'page-2', definitions: [incoming], instances: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(result.syncRun.mode, 'scheduled_configured_incremental');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer server-secret');
  assert.equal(new URL(requests[1].url).searchParams.get('cursor'), 'page-2');
  assert.equal(result.syncRun.changed, 1);
  const definition = getWorkflowDefinition('DINGTALK-PURCHASE');
  assert.equal(definition.activeVersion, '3');
  assert.equal(definition.definition.version, '5');
  assert.equal(definition.definition.publicationStatus, 'candidate');
  assert.equal(queryPublishedWorkflowContext({ query: liveInstance.businessKey }).matches.length, 0, '候选版本实例不得提前进入智脑读取面');
  assert.equal(getWorkflowIntegrationOverview().providers.find(item => item.id === 'dingtalk-live').capabilities.runtimeInstances, true);
  reviewWorkflowDefinition({ code: 'DINGTALK-PURCHASE', version: '5', action: 'publish' });
  const published = queryPublishedWorkflowContext({ query: liveInstance.businessKey });
  assert.equal(published.matches.length, 1);
  assert.equal(published.matches[0].definition.version, '5');
  assert.equal(published.matches[0].timeline.length, 2);
  assert.equal(queryPublishedWorkflowContext({ query: 'PO-20261008-001' }).matches[0].definition.version, '3', '旧版本在途实例必须继续可读');
}));

test('真实连接器拒绝浏览器凭据、外部明文地址和跨来源定义', async () => within('workflow-config-guard', async () => {
  const external = await syncConfiguredWorkflowDefinitions({ env: {
    WORKFLOW_CONNECTORS_CONFIG_JSON: JSON.stringify([{ id: 'oa-live', baseUrl: 'http://example.com/', definitionsPath: '/flows', credentialEnv: 'OA_WORKFLOW_TOKEN' }]),
    OA_WORKFLOW_TOKEN: 'secret'
  }, fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal(external.code, 'WORKFLOW_CONNECTOR_TLS_REQUIRED');

  const env = {
    WORKFLOW_CONNECTORS_CONFIG_JSON: JSON.stringify([{ id: 'oa-live', baseUrl: 'http://127.0.0.1:3998/', definitionsPath: '/flows', credentialEnv: 'OA_WORKFLOW_TOKEN' }]),
    OA_WORKFLOW_TOKEN: 'secret'
  };
  const source = structuredClone(getWorkflowDefinition('DINGTALK-PURCHASE').definition);
  source.provider = 'forged-provider';
  const forged = await syncConfiguredWorkflowDefinitions({ env, fetchImpl: async () => new Response(JSON.stringify({ cursor: 'x', definitions: [source] }), { status: 200 }) });
  assert.equal(forged.code, 'WORKFLOW_CONNECTOR_DEFINITION_INVALID');

  source.provider = 'oa-live';
  const invalidInstance = {
    provider: 'oa-live', id: 'bad-instance', definitionCode: source.code, definitionVersion: source.version,
    title: '非法节点实例', status: 'running', currentNodeId: 'not-in-definition', updatedAt: '2026-10-08T06:00:00.000Z'
  };
  const invalid = await syncConfiguredWorkflowDefinitions({ env, fetchImpl: async () => new Response(JSON.stringify({ cursor: 'y', definitions: [source], instances: [invalidInstance] }), { status: 200 }) });
  assert.equal(invalid.code, 'WORKFLOW_CONNECTOR_INSTANCE_INVALID');
}));

test('真实连接器拒绝循环游标，避免分页同步无界运行', async () => within('workflow-cursor-guard', async () => {
  const source = structuredClone(getWorkflowDefinition('DINGTALK-PURCHASE').definition);
  source.provider = 'dingtalk-loop';
  const env = {
    WORKFLOW_CONNECTORS_CONFIG_JSON: JSON.stringify([{ id: 'dingtalk-loop', baseUrl: 'http://127.0.0.1:3997/', definitionsPath: '/flows', credentialEnv: 'DINGTALK_LOOP_TOKEN' }]),
    DINGTALK_LOOP_TOKEN: 'secret'
  };
  let calls = 0;
  const result = await syncConfiguredWorkflowDefinitions({
    env,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ cursor: `cursor-${calls}`, nextCursor: 'same-page', definitions: calls === 1 ? [source] : [] }), { status: 200 });
    }
  });
  assert.equal(result.code, 'WORKFLOW_CONNECTOR_CURSOR_INVALID');
  assert.equal(calls, 2);
}));

test('多连接器同步只替换明确返回实例字段的来源，不误清空其他来源实例', async () => within('workflow-instance-scope', async () => {
  const dingtalk = structuredClone(getWorkflowDefinition('DINGTALK-PURCHASE').definition);
  const oa = structuredClone(getWorkflowDefinition('OA-ONBOARDING').definition);
  const env = {
    WORKFLOW_CONNECTORS_CONFIG_JSON: JSON.stringify([
      { id: 'dingtalk', baseUrl: 'http://127.0.0.1:3996/', definitionsPath: '/flows', credentialEnv: 'DINGTALK_TOKEN' },
      { id: 'oa', baseUrl: 'http://127.0.0.1:3995/', definitionsPath: '/flows', credentialEnv: 'OA_TOKEN' }
    ]),
    DINGTALK_TOKEN: 'secret-1', OA_TOKEN: 'secret-2'
  };
  const result = await syncConfiguredWorkflowDefinitions({
    env,
    fetchImpl: async url => new Response(JSON.stringify(url.port === '3996'
      ? { cursor: 'dt-1', definitions: [dingtalk], instances: [] }
      : { cursor: 'oa-1', definitions: [oa] }), { status: 200 })
  });
  assert.equal(result.syncRun.status, 'succeeded');
  assert.equal(queryPublishedWorkflowContext({ query: 'PO-20261008-001' }).matches.length, 0, '明确空实例快照应清空该来源实例');
  assert.equal(queryPublishedWorkflowContext({ query: 'EMP-202610-023' }).matches.length, 1, '未返回 instances 字段的来源必须保持原实例');
}));

test('OAuth 服务主体连接器刷新短时令牌后再读取流程，不把 Client Secret 当业务凭据', async () => within('workflow-oauth', async () => {
  const source = structuredClone(getWorkflowDefinition('DINGTALK-PURCHASE').definition);
  const gatewayPayload = {
    schema: 'yuanyu.workflow.dingtalk.v1', cursor: 'oauth-1', processes: [{
      processCode: source.sourceId, code: source.code, processName: source.name, version: source.version,
      purpose: source.purpose, category: source.category, businessDomain: source.businessDomain, riskLevel: source.riskLevel,
      dataClassification: source.dataClassification, updatedAt: source.updatedAt, activities: source.nodes,
      transitions: source.edges, formComponents: source.fields, bindings: source.bindings
    }]
  };
  const env = {
    WORKFLOW_CONNECTORS_CONFIG_JSON: JSON.stringify([{
      id: 'oa-oauth', baseUrl: 'http://127.0.0.1:3994/', definitionsPath: '/flows', responseProfile: 'dingtalk_gateway_v1', authMode: 'oauth_client_credentials',
      tokenPath: '/oauth/token', clientIdEnv: 'OA_CLIENT_ID', clientSecretEnv: 'OA_CLIENT_SECRET', scope: 'workflow.read instance.read'
    }]),
    OA_CLIENT_ID: 'client-id', OA_CLIENT_SECRET: 'client-secret'
  };
  const calls = [];
  const result = await syncConfiguredWorkflowDefinitions({
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      if (url.pathname === '/oauth/token') return new Response(JSON.stringify({ token_type: 'Bearer', access_token: 'temporary-access-token-1234567890', expires_in: 300 }), { status: 200 });
      return new Response(JSON.stringify(gatewayPayload), { status: 200 });
    }
  });
  assert.equal(result.syncRun.status, 'succeeded');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'POST');
  assert.match(calls[0].options.body, /grant_type=client_credentials/u);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer temporary-access-token-1234567890');
  assert.doesNotMatch(JSON.stringify(result), /client-secret|temporary-access-token/u);
}));

test('签名流程通知按租户入队、防重放，并由 Worker 重试到死信后支持人工重放', async () => {
  const tenantId = 'workflow-webhook-tenant';
  const providerId = 'dingtalk-hook';
  const secret = 'workflow-webhook-secret-32-bytes-minimum';
  const receivedAt = Date.parse('2026-10-08T08:00:00.000Z');
  const env = {
    WORKFLOW_WEBHOOKS_CONFIG_JSON: JSON.stringify([{ id: providerId, tenantId, signingSecretEnv: 'DINGTALK_HOOK_SECRET' }]),
    DINGTALK_HOOK_SECRET: secret
  };
  assert.equal(isPublicPath(`/api/integrations/workflows/webhooks/${providerId}`), true);
  assert.equal(isPublicPath('/api/integrations/workflows/webhooks/../admin'), false);
  const sendEvent = (externalEventId, eventType = 'instance.changed', at = receivedAt) => {
    const timestamp = String(Math.floor(at / 1000));
    const signature = createHmac('sha256', secret).update(`${timestamp}\n${providerId}\n${externalEventId}\n${eventType}`).digest('hex');
    return workflowWebhookOperations.receive({
      providerId, env, receivedAt: at, body: { eventType, resourceRef: 'PO-PRIVATE-001' },
      headers: { 'x-workflow-event-id': externalEventId, 'x-workflow-timestamp': timestamp, 'x-workflow-signature': `sha256=${signature}` }
    });
  };
  const first = sendEvent('evt-001');
  assert.equal(first.accepted, true);
  assert.equal(first.event.resourceRefHash.length, 24);
  assert.equal(sendEvent('evt-001').duplicate, true);
  const invalid = workflowWebhookOperations.receive({ providerId, env, receivedAt, body: { eventType: 'instance.changed' }, headers: { 'x-workflow-event-id': 'evt-bad', 'x-workflow-timestamp': String(receivedAt / 1000), 'x-workflow-signature': `sha256=${'0'.repeat(64)}` } });
  assert.equal(invalid.code, 'WORKFLOW_WEBHOOK_SIGNATURE_INVALID');

  let syncCalls = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const cycle = await runWorkflowEventInboxCycles({ tenantIds: [tenantId], workerId: 'hook-worker', at: receivedAt + attempt * 600_000, sync: async () => { syncCalls += 1; return { error: 'upstream failed', code: 'WORKFLOW_CONNECTOR_UPSTREAM_FAILED' }; } });
    assert.equal(cycle[0].result.claimed, 1);
  }
  assert.equal(syncCalls, 5);
  await within(tenantId, () => {
    const overview = workflowWebhookOperations.overview();
    assert.equal(overview.deadLetter, 1);
    assert.equal(overview.recentDeadLetters[0].errorCode, 'WORKFLOW_CONNECTOR_UPSTREAM_FAILED');
    const replayed = workflowWebhookOperations.replay({ eventId: `${providerId}:evt-001`, actor: { type: 'user', id: 'operator-1' }, at: receivedAt + 3_600_000 });
    assert.equal(replayed.event.status, 'pending');
    assert.equal(replayed.event.replayCount, 1);
  });
  const recovered = await runWorkflowEventInboxCycles({ tenantIds: [tenantId], workerId: 'hook-worker', at: receivedAt + 3_600_001, sync: async () => ({ syncRun: { id: 'sync-recovered' } }) });
  assert.equal(recovered[0].result.status, 'succeeded');
  await within(tenantId, () => assert.equal(workflowWebhookOperations.overview().succeeded, 1));
});

test('增量同步 Worker 仅处理部署声明的租户，并为每个租户绑定独立上下文', async () => {
  assert.throws(() => resolveWorkflowSyncTenantIds('', true), /WORKFLOW_SYNC_TENANT_IDS_REQUIRED/u);
  assert.throws(() => resolveWorkflowSyncTenantIds('tenant-a,tenant-a', false), /WORKFLOW_SYNC_TENANT_IDS_INVALID/u);
  const calls = [];
  const results = await runConfiguredWorkflowSyncCycles({
    tenantIds: ['tenant-a', 'tenant-b'], workerId: 'workflow-worker-test',
    sync: async ({ actor }) => {
      calls.push({ tenantId: currentSemanticTenant(), actor });
      return { syncRun: { id: `sync-${currentSemanticTenant()}` } };
    }
  });
  assert.deepEqual(calls.map(item => item.tenantId), ['tenant-a', 'tenant-b']);
  assert.ok(calls.every(item => item.actor.id === 'workflow-worker-test'));
  assert.deepEqual(results.map(item => item.tenantId), ['tenant-a', 'tenant-b']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNodeServer } from 'node:http';
import { listenOnFetchableLoopback } from './http-fixture-port.js';
const createServer = handler => createNodeServer((req, res) => {
  res.setHeader('Connection', 'close');
  if (req.method === 'HEAD') { res.end(); return; }
  return handler(req, res);
});
import { businessIdDomains, extractQueryBusinessIds, hasUnsupportedQueryTimeFilter, matchingQueryBusinessIds, validateAgentReadInput, validateAgentQueryAnswer } from '../src/services/agent-query-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { routeAgentTask } from '../src/services/agent-orchestration-service.js';
import { validateToolInvocation, executeReadOnlyTool } from '../src/services/agent-tool-registry.js';
import { authorizeZhiNaoTask } from '../src/services/zhinao-authorization-service.js';
import { runPrivateAgent, executePrivateAgentCommand } from '../src/services/private-agent-service.js';
import { getAgentWorkItems } from '../src/services/agent-workflow-service.js';
import { acknowledgeRisk } from '../src/services/risk-service.js';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { retrieveAgentSystemEvidence, retrieveAgentSystemEvidenceAsync, resetEnterpriseConnectorObservabilityForTest } from '../src/services/system-integration-service.js';
import { getSemanticEvidenceForAgent, getSemanticContextOverview, recordSemanticDecision } from '../src/services/semantic-context-service.js';
import { retrieveEnterpriseKnowledge } from '../src/services/enterprise-knowledge-service.js';
import { resetModelGatewayObservability } from '../src/services/local-model-gateway.js';
import { resetModelGovernanceForTest } from '../src/services/model-governance-service.js';
import { buildAgentQueryPlan, matchesQueryPlan, detectQueryEvidenceConflicts, validQueryInstant } from '../src/services/agent-query-plan-service.js';
import { admitSemanticRecord } from '../src/services/semantic-record-contract-service.js';
import { planSemanticOperationsRequest } from '../src/services/semantic-operations-planner-service.js';

const scope = (subjectId = 'admin@demo.local') => ({ tenantId: 'demo-enterprise', subjectId, source: 'identity_session', sessionId: 'target-query-session', deviceId: 'target-query-device' });

test('as-of plans require exact timezone instants and never mix event/version filters', () => {
  const plan = buildAgentQueryPlan('查询 ORD-100 截至2026-08-17T10:00:00+08:00的状态');
  assert.equal(plan.status, 'ready');
  assert.equal(plan.asOf, '2026-08-17T02:00:00.000Z');
  assert.equal(plan.timeRange, null);
  assert.equal(plan.semantics, 'source_attested_valid_time_snapshot');
  for (const value of ['2026-02-30T00:00:00Z', '2026-08-17T24:00:00Z', '2026-08-17T10:00:00', '2026-08-17T10:00:00+99:00']) assert.equal(validQueryInstant(value), false, value);
  for (const suffix of ['截至 2099-01-01T00:00:00Z', '截至 2026-08-17', '截至 2026-08-17T10:00:00Z 版本 v2', '截至 2026-08-17T10:00:00Z 昨天事件', '截至 2026-08-17T10:00:00Z 截至 2026-08-16T10:00:00Z']) assert.equal(buildAgentQueryPlan(`查询 ORD-100 ${suffix}`).status, 'needs_input', suffix);
});

test('valid-time selection uses inclusive start, exclusive end and rejects missing intervals', () => {
  const plan = buildAgentQueryPlan('查询 ORD-100 截至 2026-08-17T02:00:00Z');
  assert.equal(matchesQueryPlan({ validTime: { from: plan.asOf, toExclusive: null } }, plan), true);
  assert.equal(matchesQueryPlan({ validTime: { from: '2026-08-01T00:00:00Z', toExclusive: plan.asOf } }, plan), false);
  assert.equal(matchesQueryPlan({ occurredAt: plan.asOf, validTime: { from: '2026-08-01T00:00:00Z' } }, plan), false);
  assert.equal(matchesQueryPlan({ validTime: { from: '2026-08-18T00:00:00Z', toExclusive: null } }, plan), false);
  const records = ['v1', 'v2'].map((version) => ({ source: 'OMS', id: 'ORD-100', version, statement: '相同文字' }));
  assert.equal(detectQueryEvidenceConflicts(records, plan)[0].reason, 'overlapping_valid_time_versions');
});

test('history without a configured history connector cannot reuse current Mock risk', async () => {
  const noTarget = await retrieveAgentSystemEvidenceAsync('查询订单截至 2026-08-17T02:00:00Z 的状态', 'executive', scope());
  assert.equal(noTarget.mode, 'query_rejected');
  const noConnector = await retrieveAgentSystemEvidenceAsync('查询 RC-2026-0041 截至 2026-08-17T02:00:00Z 的状态', 'executive', scope());
  assert.deepEqual(noConnector.evidence, []);
  assert.match(noConnector.summary, /没有读取当前 Mock 数据/);
  const result = await run('为 RC-2026-0041 截至 2026-08-17T02:00:00Z 的状态创建质量调查草稿');
  assert.equal(result.command, null);
  assert.equal(result.lifecycle.state, 'analysis_incomplete');
  assert.match(result.text, /历史查询还要求来源提供完整覆盖声明/);
  assert.doesNotMatch(result.text, /库存临期|360/);
});

test('HTTP history connector selects effective version and rejects incomplete, mixed-scope or overlapping responses', async () => {
  let mode = 'valid';
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); requests.push(request);
    const base = { id: 'ORD-100', tenantId: 'demo-enterprise', organizationId: 'org-market-dept', classification: 'internal', occurredAt: '2026-08-01T00:00:00Z' };
    const old = { ...base, version: 'v1', statement: '历史待处理', validFrom: '2026-08-01T00:00:00Z', validTo: '2026-08-18T00:00:00Z' };
    const current = { ...base, version: 'v2', statement: '现在已取消', validFrom: '2026-08-18T00:00:00Z', validTo: null };
    const payload = { queryCoverage: { schemaVersion: 'connector-history.v1', complete: true, asOf: request.query.asOf, businessIds: request.query.businessIds }, records: [old, current] };
    if (mode === 'no_coverage') delete payload.queryCoverage;
    if (mode === 'incomplete') payload.queryCoverage.complete = false;
    if (mode === 'wrong_time') payload.queryCoverage.asOf = '2026-08-16T02:00:00.000Z';
    if (mode === 'wrong_ids') payload.queryCoverage.businessIds = ['ORD-OTHER'];
    if (mode === 'missing_end') delete old.validTo;
    if (mode === 'reversed_interval') old.validTo = '2026-07-01T00:00:00Z';
    if (mode === 'bad_day') old.validFrom = '2026-02-30T00:00:00Z';
    if (mode === 'missing_version') delete current.version;
    if (mode === 'foreign_tenant') current.tenantId = 'other-tenant';
    if (mode === 'null_row') payload.records.push(null);
    if (mode === 'truncated') payload.records = Array(21).fill(old);
    if (mode === 'overlap') current.validFrom = old.validFrom;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload));
  });
  await listenOnFetchableLoopback(server);
  try {
    await withEnv({ NODE_ENV: 'production', AGENT_RUNTIME_MODE: 'mock', ENTERPRISE_CONNECTORS_CONFIG_JSON: JSON.stringify({ oms: { endpoint: `http://127.0.0.1:${server.address().port}` } }) }, async () => {
      const input = '查询 ORD-100 截至 2026-08-17T02:00:00Z 的状态';
      const evidence = await retrieveAgentSystemEvidenceAsync(input, 'marketing_manager', scope('market@demo.local'));
      assert.deepEqual(evidence.evidence.map((item) => item.provenance.objectVersion), ['v1']);
      assert.equal(requests[0].query.asOf, '2026-08-17T02:00:00.000Z');
      const success = await runPrivateAgent({ text: input }, getRole('marketing_manager'), scope('market@demo.local'));
      assert.equal(success.task.execution.query.status, 'matched');
      assert.match(success.text, /历史待处理/);
      assert.doesNotMatch(success.text, /现在已取消/);
      assert.equal(success.command, null);
      for (mode of ['no_coverage', 'incomplete', 'wrong_time', 'wrong_ids', 'missing_end', 'reversed_interval', 'bad_day', 'missing_version', 'foreign_tenant', 'null_row', 'truncated']) {
        const rejected = await retrieveAgentSystemEvidenceAsync(input, 'marketing_manager', scope('market@demo.local'));
        assert.deepEqual(rejected.evidence, [], mode);
      }
      mode = 'overlap';
      const conflict = await runPrivateAgent({ text: input }, getRole('marketing_manager'), scope('market@demo.local'));
      assert.equal(conflict.lifecycle.state, 'analysis_incomplete');
      assert.equal(conflict.task.execution.query.conflicts[0].reason, 'overlapping_valid_time_versions');
      assert.match(conflict.text, /多个有效版本/);
      assert.equal(conflict.command, null);
      assert.equal(conflict.evidenceTrace.events.some((event) => event.type === 'model_inference_started'), false);
    });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('query plans resolve dates in Shanghai time and reject ambiguous snapshots and invalid days', () => {
  const plan = buildAgentQueryPlan('查询 ORD-100 的 2026-08-17 至 2026-08-18 事件记录 版本 v2');
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.timeRange, { field: 'occurredAt', from: '2026-08-16T16:00:00.000Z', toExclusive: '2026-08-18T16:00:00.000Z' });
  assert.equal(plan.version, 'v2');
  assert.equal(matchesQueryPlan({ occurredAt: '2026-08-18T15:59:59Z', version: 'v2' }, plan), true);
  assert.equal(matchesQueryPlan({ occurredAt: '2026-08-18T16:00:00Z', version: 'v2' }, plan), false);
  assert.equal(matchesQueryPlan({ occurredAt: '2026-08-17T00:00:00Z', version: 'v1' }, plan), false);
  assert.equal(matchesQueryPlan({ version: 'v2' }, plan), false);
  assert.equal(buildAgentQueryPlan('昨天 ORD-100 事件', Date.parse('2026-09-07T01:00:00Z')).timeRange.from, '2026-09-05T16:00:00.000Z');
  for (const input of ['2026-02-30 ORD-100', '2026-09-02 至 2026-09-01 ORD-100', '最新 ORD-100', '版本 ORD-100', '最近 ORD-100', '2026-08-17 或 2026-08-18 ORD-100', '昨天 ORD-100 状态']) assert.equal(buildAgentQueryPlan(input).status, 'needs_input', input);
});

test('event queries filter Mock timestamps and never supplement missing history with current seed risk', async () => {
  const result = await run('查询 ORD-202608-00002 在 2026-08-17 的事件记录');
  assert.equal(result.task.execution.query.plan.status, 'ready');
  assert.equal(result.task.execution.query.plan.timeRange.field, 'occurredAt');
  const missing = await run('查询 RC-2026-0041 在 2026-08-17 的事件记录');
  assert.equal(missing.command, null);
  assert.doesNotMatch(missing.text, /库存临期|360/);
});

test('same object version conflict is distinct from normal version history', () => {
  const rows = [{ source: 'ERP', id: 'ORD-100', version: 'v1', statement: '待处理' }, { source: 'ERP', id: 'ORD-100', version: 'v2', statement: '完成' }];
  assert.equal(detectQueryEvidenceConflicts(rows).length, 0);
  assert.equal(detectQueryEvidenceConflicts([...rows, { ...rows[1], statement: '撤回' }])[0].variants, 2);
});
const run = (text, roleId = 'executive', options) => runPrivateAgent({ text }, getRole(roleId), scope(), options);
const withEnv = async (values, callback) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await callback(); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    resetEnterpriseConnectorObservabilityForTest();
    resetModelGatewayObservability();
    resetModelGovernanceForTest();
  }
};

test('targeted quality draft binds a single risk, requires confirmation, and cannot replay', async () => {
  const before = getAgentWorkItems('executive', scope()).length;
  const result = await run('为 RC-2026-0042 创建质量调查草稿');
  assert.equal(result.lifecycle.state, 'awaiting_confirmation');
  assert.deepEqual(result.command.targetBinding.businessIds, ['RC-2026-0042']);
  assert.equal(getAgentWorkItems('executive', scope()).length, before);
  const invalid = await executePrivateAgentCommand(result.command.id, getRole('executive'), result.runId, 'invalid', scope());
  assert.ok(invalid.error);
  const outcome = await executePrivateAgentCommand(result.command.id, getRole('executive'), result.runId, result.command.confirmationToken, scope());
  assert.equal(outcome.lifecycle.state, 'draft_created_pending_approval');
  assert.deepEqual(outcome.result.workItem.targetBinding.businessIds, ['RC-2026-0042']);
  assert.ok((await executePrivateAgentCommand(result.command.id, getRole('executive'), result.runId, result.command.confirmationToken, scope())).error);
});

test('risk drift invalidates a pending target binding and does not create a draft', async () => {
  resetRuntimeState(['risk_runtime']);
  try {
    const result = await run('为 RC-2026-0042 创建质量调查草稿');
    const before = getAgentWorkItems('executive', scope()).length;
    await acknowledgeRisk('RC-2026-0042', getRole('executive'));
    const outcome = await executePrivateAgentCommand(result.command.id, getRole('executive'), result.runId, result.command.confirmationToken, scope());
    assert.equal(outcome.code, 'AGENT_WRITE_TARGET_CHANGED');
    assert.equal(getAgentWorkItems('executive', scope()).length, before);
  } finally { resetRuntimeState(['risk_runtime']); }
});

test('questions and negations about draft creation never issue confirmation', async () => {
  for (const input of ['不要为 RC-2026-0042 创建质量调查草稿', '如何为 RC-2026-0042 创建质量调查草稿', '能否为 RC-2026-0042 创建质量调查草稿', '不要创建质量调查草稿，只分析报警']) {
    const result = await run(input);
    assert.equal(result.command, null, input);
  }
});

test('query parser normalizes whole identifiers without matching prefixes or control-plane IDs', () => {
  assert.deepEqual(extractQueryBusinessIds('查看 rc-2026-0041 和 RC-2026-0041，read-only，trace-a123'), ['RC-2026-0041']);
  assert.deepEqual(matchingQueryBusinessIds({ orderId: 'ORD-1000' }, ['ORD-100']), []);
  assert.deepEqual(businessIdDomains('RC-2026-0041、ORD-1000、SUP-006'), ['production', 'marketing', 'internal']);
  assert.equal(routeAgentTask('看看 RC-2026-0041').primaryDomain, 'production');
});

test('tool query schema rejects identity overrides, SQL, duplicate IDs and oversized inputs', () => {
  assert.equal(validateToolInvocation('analyze_production_impact', { businessIds: ['RC-2026-0041'] }).valid, true);
  for (const input of [{ businessIds: 'RC-2026-0041' }, { businessIds: ['rc-2026-0041'] }, { businessIds: ['RC-1', 'RC-1'] }, { businessIds: ['RC-1'], roleId: 'executive' }, { sql: 'select all' }, { businessIds: Array.from({ length: 11 }, (_, i) => `RC-${i}`) }, { businessIds: [`RC-${'1'.repeat(101)}`] }]) {
    assert.equal(validateToolInvocation('analyze_production_impact', input).valid, false);
    assert.equal(validateAgentReadInput(input), false);
  }
  assert.equal(validateToolInvocation('launch_procurement', { businessIds: ['SUP-006'] }).valid, false);
});

test('Mock system retrieval never fills an exact query with popular unrelated records', async () => {
  const matched = await retrieveAgentSystemEvidence('查询订单 ORD-202608-00002', 'marketing_manager');
  assert.ok(matched.evidence.length > 0);
  assert.ok(matched.evidence.every((item) => item.matchedBusinessIds.includes('ORD-202608-00002')));
  assert.match(matched.evidence[0].statement, /deliveryStatus=已分配/);
  const missing = await retrieveAgentSystemEvidence('查询订单 ORD-209999-99999', 'marketing_manager');
  assert.deepEqual(missing.evidence, []);
  assert.deepEqual((await retrieveAgentSystemEvidence('查询原料 RM-20260718', 'marketing_manager')).systemIds, []);
  assert.deepEqual((await retrieveAgentSystemEvidence('查询门店 STORE-SH-001', 'production_manager')).systemIds, []);
});

test('semantic exact queries and knowledge retrieval exclude unrelated default batch facts', () => {
  const missing = getSemanticEvidenceForAgent('原料检验 RM-20999999', 'executive');
  assert.deepEqual(missing.facts, []);
  assert.deepEqual(missing.relations, []);
  const matched = getSemanticEvidenceForAgent('原料检验 RM-20260718', 'executive', scope());
  assert.deepEqual(matched.facts.map((fact) => fact.label), ['RM-20260718']);
  assert.ok(matched.relations.every((rel) => matched.facts.some((fact) => fact.id === rel.source) && matched.facts.some((fact) => fact.id === rel.target)));
  const knowledge = retrieveEnterpriseKnowledge('原料检验 RM-20999999', 'executive');
  assert.ok(knowledge.results.some((item) => item.id === 'SOP-QA-018'));
  assert.equal(knowledge.results.some((item) => item.id === 'COA-VC-2026'), false);
});

test('semantic projection and decision history are identity scoped and fail closed', async () => {
  const foreign = { ...scope(), tenantId: 'foreign-tenant' };
  assert.deepEqual(getSemanticContextOverview('executive', foreign).graph.nodes, []);
  assert.deepEqual(getSemanticContextOverview('executive').graph.nodes, []);
  assert.deepEqual(getSemanticEvidenceForAgent('RM-20260718', 'procurement_manager', scope('procurement@demo.local')).facts, []);
  await recordSemanticDecision({ role: getRole('executive'), identityScope: scope(), runId: 'isolated-run', input: '查询', route: { primaryDomain: 'production' }, evidence: [{ id: 'SECRET-100' }] });
  assert.ok((await getSemanticContextOverview('executive', scope())).decisions.some((item) => item.id === 'dec-agent-isolated-run'));
  assert.equal((await getSemanticContextOverview('executive', foreign)).decisions.length, 0);
  assert.equal((await getSemanticContextOverview('quality_manager', scope())).decisions.length, 0);
  assert.deepEqual((await retrieveAgentSystemEvidenceAsync('查询订单 ORD-202608-00002', 'executive', foreign)).evidence, []);
  const otherTenant = await runPrivateAgent({ text: '查询 RC-2026-0042' }, getRole('executive'), foreign);
  assert.equal(otherTenant.task.execution.query.status, 'not_found_or_not_visible');
});

test('domain tool honors the selected lower-priority risk and its real current status', async () => {
  const role = getRole('executive');
  const authorization = authorizeZhiNaoTask({ role, route: routeAgentTask('RC-2026-0041') });
  const result = await executeReadOnlyTool('analyze_production_impact', role, authorization, scope(), { businessIds: ['RC-2026-0041'] });
  assert.match(result.summary, /RC-2026-0041/);
  assert.match(result.summary, /处理中/);
  assert.doesNotMatch(result.summary, /RC-2026-0042|仍待确认|1,860/);
  assert.deepEqual(result.matchedBusinessIds, ['RC-2026-0041']);
});

test('exact risk reads retain record-level role and organization restrictions', async () => {
  const role = getRole('quality_manager');
  const authorization = authorizeZhiNaoTask({ role, route: routeAgentTask('RC-2026-0041') });
  const result = await executeReadOnlyTool('analyze_production_impact', role, authorization, scope('quality@demo.local'), { businessIds: ['RC-2026-0041'] });
  assert.deepEqual(result.evidence, []);
  assert.doesNotMatch(result.summary, /360|渠道 A/);
  const denied = await executeReadOnlyTool('analyze_production_impact', role, { decision: 'DENY_BY_DEFAULT', allowedTools: [] }, scope(), { businessIds: ['RC-2026-0041'] });
  assert.equal(denied, null);
  const scoped = await runPrivateAgent({ text: '查询 RC-2026-0042' }, getRole('procurement_manager'), scope('procurement@demo.local'));
  assert.equal(scoped.task.execution.query.status, 'not_found_or_not_visible');
  assert.deepEqual(scoped.semanticContext.facts, []);
  assert.doesNotMatch(scoped.text, /RM-20260718|检验异常|1,860/);
});

test('Agent returns the requested order instead of a generic complaint dashboard', async () => {
  const result = await run('查询订单 ORD-202608-00002');
  assert.equal(result.task.execution.query.status, 'matched');
  assert.match(result.text, /ORD-202608-00002/);
  assert.match(result.text, /已分配/);
  assert.doesNotMatch(result.text, /RC-2026-0038|RC-2026-0042|ORD-202608-00003/);
  assert.equal(result.command, null);
  assert.equal(result.evidence.length, new Set(result.evidence.map((item) => `${item.source}/${item.id}/${item.statement}`)).size);
});

test('unsupported temporal queries ask for clarification instead of returning current records as history', async () => {
  for (const text of ['昨天 ORD-202608-00002 的状态', '查 ORD-202608-00002 在 2026-08-17 的状态', 'latest ORD-202608-00002']) {
    const result = await run(text);
    assert.equal(result.lifecycle.state, 'needs_input');
    assert.deepEqual(result.evidence, []);
    assert.equal(result.evidenceTrace.events.some((event) => event.type === 'evidence_source_queried'), false);
  }
  assert.equal(hasUnsupportedQueryTimeFilter('查询 PB-2026-08-17-A'), false);
  const followUp = await run('继续', 'executive', { conversationContext: { taskGoal: '查询昨天 ORD-202608-00002 的状态', userPrompt: '查询昨天 ORD-202608-00002 的状态' } });
  assert.equal(followUp.lifecycle.state, 'needs_input');
  assert.deepEqual(followUp.evidence, []);
});

test('unknown identifiers produce explicit non-confirmation without a default risk answer', async () => {
  const result = await run('分析报警 RC-2099-9999');
  assert.equal(result.task.status, 'needs_input');
  assert.equal(result.task.execution.query.status, 'not_found_or_not_visible');
  assert.match(result.text, /不能证明对象不存在/);
  assert.doesNotMatch(result.text, /RC-2026-0042|RM-20260718|已完成分析/);
  assert.equal(result.command, null);
  assert.equal(result.evidenceTrace.events.some((event) => event.type === 'model_inference_started'), false);
});

test('partial multi-ID matches cannot complete the overall query', async () => {
  const result = await run('分析 RC-2026-0041 和 RC-2099-9999');
  assert.deepEqual(result.task.execution.query.matchedIds, ['RC-2026-0041']);
  assert.deepEqual(result.task.execution.query.missingIds, ['RC-2099-9999']);
  assert.equal(result.task.execution.status, 'partial');
  assert.equal(result.lifecycle.state, 'analysis_incomplete');
  assert.match(result.text, /1\/2 个编号匹配/);
  assert.equal(result.task.steps.at(-1).status, 'insufficient_evidence');
});

test('current explicit target replaces previous chat targets instead of merging cases', async () => {
  const result = await run('继续分析 RC-2026-0041', 'executive', { conversationContext: { taskGoal: '分析报警 RC-2026-0042', userPrompt: '分析报警 RC-2026-0042' } });
  assert.deepEqual(result.task.execution.query.businessIds, ['RC-2026-0041']);
  assert.equal(result.task.execution.query.status, 'matched');
  assert.doesNotMatch(result.text, /RC-2026-0042|RM-20260718/);
  assert.match(result.task.goal, /RC-2026-0041/);
});

test('targeted writes stay incomplete until write handlers support the actual target binding', async () => {
  const result = await run('请为 SUP-006 创建采购申请');
  assert.equal(result.task.execution.query.status, 'matched');
  assert.equal(result.task.phase, 'write_target_unsupported');
  assert.equal(result.task.status, 'needs_input');
  assert.equal(result.command, null);
  assert.match(result.text, /不能拿默认案例代替/);
  assert.doesNotMatch(result.text, /SUP-018|华东营养|33,000/);
  assert.equal(result.evidenceTrace.events.some((event) => event.type === 'task_completed'), false);
});

test('oversized target lists are rejected before business retrieval', async () => {
  for (const input of [Array.from({ length: 11 }, (_, i) => `RC-${i}`).join(' '), `RC-${'1'.repeat(101)}`]) {
    const result = await run(`分析 ${input}`);
    assert.equal(result.lifecycle.state, 'needs_input');
    assert.deepEqual(result.evidence, []);
    assert.equal(result.evidenceTrace.events.some((event) => event.type === 'evidence_source_queried'), false);
  }
});

test('disabled Mock mode cannot answer an exact query from seed risk or semantic graph data', async () => {
  await withEnv({ CONNECTOR_MOCK_MODE: 'disabled', ENTERPRISE_CONNECTORS_CONFIG_JSON: '{}' }, async () => {
    const result = await run('分析报警 RC-2026-0042');
    assert.equal(result.task.execution.query.status, 'not_found_or_not_visible');
    assert.deepEqual(result.semanticContext.facts, []);
    assert.doesNotMatch(result.text, /RM-20260718|1,860|待确认的 P0/);
    assert.deepEqual((await retrieveAgentSystemEvidence('原料 RM-20260718', 'executive')).evidence, []);
  });
});

test('enterprise Connector response filtering is enforced even if the supplier ignores query IDs', async () => {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ records: [
      { id: 'ORD-1000', statement: '无关订单的记录。' },
      { id: 'ORD-100', statement: '指定订单已取消。', status: 'cancelled', tenantId: 'demo-enterprise', organizationId: 'org-market-dept', version: 'v2', classification: 'internal', occurredAt: '2026-08-17T01:00:00Z' }
    ] }));
  });
  await listenOnFetchableLoopback(server);
  try {
    await withEnv({ NODE_ENV: 'production', ENTERPRISE_CONNECTORS_CONFIG_JSON: JSON.stringify({ oms: { endpoint: `http://127.0.0.1:${server.address().port}` } }) }, async () => {
      const result = await retrieveAgentSystemEvidenceAsync('查询订单 ORD-100', 'marketing_manager', scope('market@demo.local'));
      assert.deepEqual(result.evidence.map((item) => item.id), ['ORD-100']);
      assert.equal(result.evidence[0].lifecycleState, 'cancelled');
      assert.deepEqual(bodies[0].query.businessIds, ['ORD-100']);
      assert.equal(bodies[0].access.subjectId, 'market@demo.local');
      assert.equal(Object.hasOwn(bodies[0], 'prompt'), false);
    });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('production semantic record contract rejects missing metadata and cross-scope records', () => {
  const record = { id: 'ORD-100', statement: 'record', tenantId: 'demo-enterprise', organizationId: 'org-market-dept', version: 'v2', classification: 'internal', occurredAt: '2026-08-17T01:00:00Z' };
  assert.equal(admitSemanticRecord(record, 'marketing_manager', scope('market@demo.local'), true), true);
  for (const field of ['id', 'tenantId', 'organizationId', 'version', 'classification', 'occurredAt']) {
    const copy = { ...record }; delete copy[field];
    assert.equal(admitSemanticRecord(copy, 'marketing_manager', scope('market@demo.local'), true), false, field);
  }
  assert.equal(admitSemanticRecord({ ...record, tenantId: 'foreign' }, 'executive', scope(), false), false);
  assert.equal(admitSemanticRecord(record, 'procurement_manager', scope('procurement@demo.local'), true), false);
});

test('HTTP connector dates and versions are filtered again and conflicting current records block the Agent', async () => {
  const requests = [];
  let conflicting = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const record = { id: 'ORD-100', tenantId: 'demo-enterprise', organizationId: 'org-market-dept', classification: 'internal', version: 'v2', occurredAt: '2026-08-17T01:00:00Z', statement: '订单待处理' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ records: conflicting ? [record, { ...record, statement: '订单已取消' }] : [record, { ...record, version: 'v1' }, { ...record, occurredAt: '2026-08-18T02:00:00Z' }, { ...record, tenantId: 'other-tenant' }] }));
  });
  await listenOnFetchableLoopback(server);
  try {
    await withEnv({ NODE_ENV: 'production', AGENT_RUNTIME_MODE: 'mock', ENTERPRISE_CONNECTORS_CONFIG_JSON: JSON.stringify({ oms: { endpoint: `http://127.0.0.1:${server.address().port}` } }) }, async () => {
      const result = await retrieveAgentSystemEvidenceAsync('查询 ORD-100 在 2026-08-17 的事件记录 版本 v2', 'marketing_manager', scope('market@demo.local'));
      assert.equal(result.evidence.length, 1);
      assert.equal(requests[0].query.version, 'v2');
      assert.equal(requests[0].query.timeRange.field, 'occurredAt');
      conflicting = true;
      const response = await runPrivateAgent({ text: '查询 ORD-100' }, getRole('marketing_manager'), scope('market@demo.local'));
      assert.equal(response.lifecycle.state, 'analysis_incomplete');
      assert.equal(response.task.execution.query.conflicts.length, 1);
      assert.match(response.text, /冲突记录/);
      assert.equal(response.command, null);
    });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('an empty real Connector response cannot reactivate default risk and semantic fixtures', async () => {
  const server = createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"records":[]}'); });
  await listenOnFetchableLoopback(server);
  try {
    await withEnv({ CONNECTOR_MOCK_MODE: 'enabled', ENTERPRISE_CONNECTORS_CONFIG_JSON: JSON.stringify({ qms: { endpoint: `http://127.0.0.1:${server.address().port}` } }) }, async () => {
      const result = await run('分析 RC-2026-0042');
      assert.equal(result.systemData.mode, 'enterprise_connector_no_evidence');
      assert.equal(result.task.execution.query.status, 'not_found_or_not_visible');
      assert.deepEqual(result.semanticContext.facts, []);
      assert.doesNotMatch(result.text, /RM-20260718|1,860/);
      assert.equal(result.command, null);
    });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('model answer guard rejects invented or swapped business identifiers', () => {
  assert.equal(validateAgentQueryAnswer('RC-2026-0041 处理中', ['RC-2026-0041'], []).valid, true);
  assert.equal(validateAgentQueryAnswer('RC-2026-0042 待确认', ['RC-2026-0041'], []).valid, false);
});

test('actual HTTP model answer with another risk ID is replaced by verified target facts', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1; req.resume();
    const answer = calls === 1 ? JSON.stringify({ schemaVersion: 'agent-turn.v1', intent: 'read_business', answer: '', resolvedRequest: '分析 RC-2026-0041', needsClarification: false }) : '当前 RC-2026-0042 处于待确认状态，请复核相关批次。';
    const envelope = { schemaVersion: 'agent-summary.v1', answer, proposedAction: null, claimsExecution: false, executionReceipt: null };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(envelope) } }] }));
  });
  await listenOnFetchableLoopback(server);
  try {
    await withEnv({ AGENT_RUNTIME_MODE: 'local', LOCAL_LLM_MODEL: 'query-test-model', LOCAL_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, MODEL_ALLOWLIST_JSON: JSON.stringify({ local: ['query-test-model'] }) }, async () => {
      resetModelGatewayObservability(); resetModelGovernanceForTest();
      const result = await run('分析 RC-2026-0041');
      assert.equal(calls, 2);
      assert.equal(result.agent.inferenceSource, 'query_answer_guard');
      assert.match(result.text, /RC-2026-0041/);
      assert.doesNotMatch(result.text, /RC-2026-0042/);
      assert.equal(result.command, null);
    });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('semantic operations exercises the real HTTP gateway in tests and cannot adopt a model-invented publish intent', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1; req.resume();
    const advice = { schemaVersion: 'semantic-operations-plan.v1', intent: 'publish_model', goal: '发布生产版本', systems: ['ERP'], rationale: '模型建议', questions: [] };
    const envelope = { schemaVersion: 'agent-summary.v1', answer: JSON.stringify(advice), proposedAction: null, claimsExecution: false, executionReceipt: null };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(envelope) } }] }));
  });
  await listenOnFetchableLoopback(server);
  try {
    await withEnv({ AGENT_RUNTIME_MODE: 'local', LOCAL_LLM_MODEL: 'ops-test-model', LOCAL_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, MODEL_ALLOWLIST_JSON: JSON.stringify({ local: ['ops-test-model'] }) }, async () => {
      const result = await planSemanticOperationsRequest({ request: '检查模型状态', authoritativeIntent: 'inspect_status', identityScope: scope(), sourceDiscovery: { sources: [] } });
      assert.equal(calls, 1, JSON.stringify({ port: server.address().port, mode: result.mode, provider: result.provider }));
      assert.equal(result.intentConflict, true);
      assert.equal(result.goal, '检查模型状态');
      assert.equal(result.authoritativeIntent, 'inspect_status');
      assert.deepEqual(result.systems, []);
    });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

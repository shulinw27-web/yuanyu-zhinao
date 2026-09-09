import test from 'node:test';
import assert from 'node:assert/strict';
import { getRole } from '../src/services/authorization-service.js';
import { acknowledgeRisk } from '../src/services/risk-service.js';
import { approveProcurement, launchProcurement } from '../src/services/procurement-service.js';
import { createWorkflowDraft } from '../src/services/agent-workflow-service.js';
import { getIAMRolePolicy } from '../src/services/iam-store.js';
import { saveRolePolicy } from '../src/services/permission-management-service.js';
import { readState, resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import {
  acknowledgeDomainEvent,
  claimDomainEvents,
  failDomainEvent,
  getDomainEventOutboxMetrics,
  listDomainEvents,
  mutateWithDomainEvent,
  publishDomainEvent,
  replayDeadLetterEvent
} from '../src/domains/events/domain-event-outbox.js';
import { createDomainEventBroker } from '../src/domains/events/brokers/domain-event-broker.js';
import { getDomainEventConsumerCheckpoint, listDomainEventConsumerMetrics, processDomainEventBatch } from '../src/workers/domain-event-worker.js';
import { dispatchAlert } from '../src/domains/alerting/alerting-service.js';
import { publishOAMetaModel, simulateBuildOAMetaModel } from '../src/services/meta-model-service.js';
import { createWorldModelDraft, publishWorldModelDraft, validateWorldModelDraft } from '../src/services/world-model-template-service.js';
import { claimAgentExecution, createAgentRun, recordAgentExecution } from '../src/services/agent-runtime-store.js';
import { getPlatformLiveness, getPlatformReadiness, getSystemCapabilities } from '../src/domains/platform/platform-health-service.js';
import { getDomainEventContractCatalog, validateDomainEventContract } from '../src/domains/events/domain-event-contracts.js';
import { createHmac } from 'node:crypto';
import { createConfiguredWorkerBroker } from '../../services/domain-event-worker/worker-config.js';

test('风险聚合变更与领域事件在同一事务中提交', async () => {
  resetRuntimeState(['risk_runtime', 'domain_event_outbox']);
  const risk = await acknowledgeRisk('RC-2026-0042', getRole('quality_manager'));
  const events = await listDomainEvents({ status: 'pending' });
  assert.equal(risk.status, '处理中');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'risk.case.acknowledged');
  assert.equal(events[0].aggregateId, risk.id);
  assert.equal(events[0].organizationId, risk.organizationId);
});

test('事件认领和确认绑定消费者，避免并行重复发布', async () => {
  resetRuntimeState(['risk_runtime', 'domain_event_outbox']);
  await acknowledgeRisk('RC-2026-0042', getRole('quality_manager'));
  const [event] = claimDomainEvents({ consumerId: 'worker-a', limit: 1 });
  assert.equal(event.status, 'processing');
  assert.deepEqual(claimDomainEvents({ consumerId: 'worker-b', limit: 1 }), []);
  assert.equal(acknowledgeDomainEvent(event.eventId, 'worker-b').code, 'DOMAIN_EVENT_CLAIM_MISMATCH');
  assert.equal(acknowledgeDomainEvent(event.eventId, 'worker-a').status, 'published');
  assert.equal((await listDomainEvents({ status: 'published' })).length, 1);
});

test('无效事件导致聚合与 Outbox 一并回滚', async () => {
  resetRuntimeState(['atomic_fixture', 'domain_event_outbox']);
  assert.throws(() => mutateWithDomainEvent({
    namespace: 'atomic_fixture',
    key: 'aggregate',
    initialValue: { count: 0 },
    mutation: (aggregate) => ({ value: { count: aggregate.count + 1 }, result: { count: 1 }, event: { aggregateType: 'Fixture', aggregateId: 'one' } })
  }), /require type/);
  assert.equal(readState('atomic_fixture', 'aggregate', { count: 0 }).count, 0);
  assert.deepEqual(await listDomainEvents(), []);
});

test('独立 Worker 记录幂等消费检查点并发布事件', async () => {
  resetRuntimeState(['domain_event_outbox', 'domain_event_consumers']);
  publishDomainEvent({ eventId: '11111111-1111-4111-8111-111111111111', type: 'test.fixture.created', version: 1, aggregateType: 'Fixture', aggregateId: 'fixture-1' });
  const first = await processDomainEventBatch({ consumerId: 'test-worker' });
  const second = await processDomainEventBatch({ consumerId: 'test-worker' });
  const checkpoint = getDomainEventConsumerCheckpoint('test-worker');
  assert.deepEqual({ published: first.published, failed: first.failed }, { published: 1, failed: 0 });
  assert.equal(second.claimed, 0);
  assert.equal(checkpoint.projections.total, 1);
  assert.equal(checkpoint.processed['11111111-1111-4111-8111-111111111111'].type, 'test.fixture.created');
});

test('采购发起和审批迁入持久化聚合并各自产生一次事件', async () => {
  resetRuntimeState(['procurement_runtime', 'domain_event_outbox']);
  const launched = await launchProcurement(getRole('procurement_manager'), undefined, { tenantId: 'demo-enterprise' });
  const approved = await approveProcurement(getRole('executive'), undefined, { tenantId: 'demo-enterprise' });
  const events = (await listDomainEvents()).map((event) => event.type);
  assert.equal(launched.execution.status, '审批中');
  assert.equal(approved.execution.status, '已提交执行');
  assert.deepEqual(events, ['procurement.requisition.approved', 'procurement.requisition.launched']);
});

test('IAM 策略发布与策略版本在同一事务写入事件', async () => {
  resetRuntimeState(['iam', 'domain_event_outbox']);
  const current = getIAMRolePolicy('quality_manager');
  const result = await saveRolePolicy({
    roleId: current.roleId,
    menuIds: current.menuIds,
    buttonPermissionIds: current.buttonPermissionIds,
    dataScope: current.dataScope,
    expectedVersion: current.version,
    reason: '验证 IAM 策略领域事件原子写入。'
  }, 'executive', { source: 'demo_header', tenantId: 'demo-enterprise', subjectId: 'demo:executive:event-worker-test' });
  const [event] = await listDomainEvents();
  assert.equal(result.role.version, current.version + 1);
  assert.equal(event.type, 'iam.role_policy.published');
  assert.equal(event.payload.policyVersion, result.role.version);
});

test('Agent 创建工作流草稿时写入同租户关联事件', async () => {
  resetRuntimeState(['agent_workflow', 'domain_event_outbox']);
  const result = createWorkflowDraft('create_quality_investigation', getRole('quality_manager'), 'run-event-1', { tenantId: 'tenant-a', subjectId: 'quality@demo.local' });
  const [event] = await listDomainEvents({ tenantId: 'tenant-a' });
  assert.equal(result.workItem.status, 'awaiting_approval');
  assert.equal(event.type, 'agent.workflow.draft_created');
  assert.equal(event.correlationId, 'run-event-1');
  assert.equal(event.aggregateId, result.workItem.id);
});

test('告警分类与通知编排在同一事务写入领域事件', async () => {
  resetRuntimeState(['alerting', 'domain_event_outbox']);
  const result = await dispatchAlert({ riskId: 'ALERT-EVENT-1', sourceSystem: 'QMS', eventType: 'QualityReleaseBlocked', organizationId: 'org-quality-dept' });
  const [event] = await listDomainEvents();
  assert.equal(result.alert.riskId, 'ALERT-EVENT-1');
  assert.equal(event.type, 'alert.classified');
  assert.equal(event.aggregateId, 'ALERT-EVENT-1');
  assert.equal(event.payload.severity, result.classification.severity);
});

test('死信可由授权管理接口重放并保留重放审计元数据', async () => {
  resetRuntimeState(['domain_event_outbox']);
  publishDomainEvent({ eventId: '22222222-2222-4222-8222-222222222222', type: 'test.delivery.failed', aggregateType: 'Fixture', aggregateId: 'fixture-dead', tenantId: 'tenant-a' });
  const [claimed] = claimDomainEvents({ consumerId: 'failing-worker', tenantId: 'tenant-a' });
  const failed = failDomainEvent(claimed.eventId, 'failing-worker', 'BROKER_UNAVAILABLE', { maxAttempts: 1 });
  assert.equal(failed.status, 'dead_letter');
  assert.equal((await getDomainEventOutboxMetrics({ tenantId: 'tenant-a' })).deadLetter, 1);
  const replayed = await replayDeadLetterEvent(claimed.eventId, { tenantId: 'tenant-a', actor: { type: 'user', id: 'admin' }, reason: 'broker recovered' });
  assert.equal(replayed.status, 'pending');
  assert.equal(replayed.replayCount, 1);
  assert.equal(replayed.lastReplay.reason, 'broker recovered');
});

test('Broker 适配边界支持内部投影并对未知或未注入外部 Broker 失败关闭', async () => {
  resetRuntimeState(['domain_event_outbox', 'domain_event_consumers']);
  publishDomainEvent({ type: 'test.broker.created', aggregateType: 'Fixture', aggregateId: 'broker-1' });
  const delivered = [];
  const broker = createDomainEventBroker({ type: 'projection', handler: async (event) => delivered.push(event.eventId) });
  const summary = await processDomainEventBatch({ consumerId: 'broker-worker', broker });
  assert.equal(summary.published, 1);
  assert.equal(delivered.length, 1);
  assert.equal((await listDomainEventConsumerMetrics()).find((item) => item.consumerId === 'broker-worker').processed, 1);
  assert.throws(() => createDomainEventBroker({ type: 'kafka' }), /requires brokers and topic/);
  assert.throws(() => createDomainEventBroker({ type: 'unknown' }), /Unsupported/);
});

test('元模型发布与治理聚合状态在同一事务产生事件', async () => {
  resetRuntimeState(['oa_meta_model_runtime', 'domain_event_outbox']);
  const role = getRole('executive');
  assert.equal(simulateBuildOAMetaModel(role).simulation.validation.status, 'passed');
  const published = publishOAMetaModel(role);
  const [event] = await listDomainEvents();
  assert.equal(published.simulation.status, 'published');
  assert.equal(event.type, 'governance.meta_model.published');
  assert.equal(event.payload.version, published.simulation.version);
});

test('世界模型发布与草稿状态在同一事务产生事件', async () => {
  resetRuntimeState(['world_model_runtime', 'domain_event_outbox']);
  const role = getRole('executive');
  const created = createWorldModelDraft({ templateId: 'qms-quality', targetId: 'qms' }, role);
  assert.equal(validateWorldModelDraft(created.draft.id, role).draft.validation.status, 'passed');
  const published = publishWorldModelDraft(created.draft.id, role);
  const [event] = await listDomainEvents();
  assert.equal(published.draft.status, 'published');
  assert.equal(event.type, 'governance.world_model.published');
  assert.equal(event.aggregateId, created.draft.id);
});

test('Agent 工具成功回执与 run 终态在同一事务产生事件', async () => {
  resetRuntimeState(['agent_runs', 'domain_event_outbox']);
  const identityScope = { tenantId: 'tenant-agent', subjectId: 'agent-user', sessionId: 'session-1', deviceId: 'device-1' };
  const run = createAgentRun({ roleId: 'quality_manager', identityScope, input: '创建调查草稿', domain: 'quality', skill: {}, agents: [], plan: [], evidence: [], authorization: {}, businessControl: {}, multimodal: {}, proposedCommand: { id: 'create_quality_investigation', requiresConfirmation: true } });
  assert.ok(claimAgentExecution({ runId: run.id, commandId: 'create_quality_investigation', confirmationToken: run.confirmationToken, roleId: 'quality_manager', identityScope }).run);
  const completed = recordAgentExecution(run.id, { commandId: 'create_quality_investigation', businessRecordId: 'QI-001', status: 'awaiting_approval' });
  const [event] = await listDomainEvents({ tenantId: 'tenant-agent' });
  assert.equal(completed.status, 'executed');
  assert.equal(event.type, 'agent.tool_execution.succeeded');
  assert.equal(event.payload.businessRecordId, 'QI-001');
});

test('运行平台公开区分存活、就绪与非敏感能力清单', async () => {
  assert.equal(getPlatformLiveness().status, 'ok');
  assert.equal((await getPlatformReadiness()).status, 'ready');
  const capabilities = getSystemCapabilities();
  assert.equal(capabilities.domainEvents.transactionalOutbox, true);
  assert.equal(capabilities.runtime.iamStore, 'memory');
  assert.equal(capabilities.agent.evidenceHashChain, true);
  assert.equal(Object.hasOwn(capabilities, 'credentials'), false);
});

test('领域事件注册表拒绝未知生产事件和不完整载荷', () => {
  assert.ok(getDomainEventContractCatalog().length >= 15);
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => validateDomainEventContract({ type: 'unknown.event', version: 1, aggregateType: 'Unknown', payload: {} }), /not registered/);
    assert.throws(() => validateDomainEventContract({ type: 'risk.case.acknowledged', version: 1, aggregateType: 'RiskCase', payload: { riskId: 'R-1' } }), /missing payload fields/);
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('Webhook Broker 使用事件 ID 幂等键与 HMAC 签名并拒绝非成功响应', async () => {
  const calls = [];
  const secret = 'test-signing-secret-1234';
  const broker = createConfiguredWorkerBroker({ EVENT_BROKER_TYPE: 'webhook', EVENT_WEBHOOK_URL: 'http://127.0.0.1/events', EVENT_WEBHOOK_SIGNING_SECRET: secret, NODE_ENV: 'test' }, {
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 202 }; }
  });
  const event = { eventId: 'event-webhook-1', type: 'risk.case.acknowledged', version: 1, aggregateType: 'RiskCase', aggregateId: 'R-1', payload: { riskId: 'R-1', severity: 'P0', status: '处理中' } };
  const result = await broker.publish(event);
  assert.equal(result.statusCode, 202);
  assert.equal(calls[0].options.headers['idempotency-key'], event.eventId);
  assert.equal(calls[0].options.headers['x-event-signature'], `sha256=${createHmac('sha256', secret).update(calls[0].options.body).digest('hex')}`);
  const rejected = createConfiguredWorkerBroker({ EVENT_BROKER_TYPE: 'webhook', EVENT_WEBHOOK_URL: 'https://events.example.test', EVENT_WEBHOOK_SIGNING_SECRET: secret, NODE_ENV: 'production' }, { fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(() => rejected.publish(event), (error) => error.code === 'WEBHOOK_BROKER_HTTP_503');
});

test('Kafka 与 RabbitMQ Worker 配置使用官方适配器且健康信息不泄露凭据', () => {
  const kafka = createConfiguredWorkerBroker({ EVENT_BROKER_TYPE: 'kafka', EVENT_KAFKA_BROKERS: 'kafka-a:9093,kafka-b:9093', EVENT_KAFKA_TOPIC: 'domain-events', EVENT_KAFKA_SSL: 'true', EVENT_KAFKA_USERNAME: 'worker', EVENT_KAFKA_PASSWORD: 'secret-password' });
  assert.deepEqual(kafka.getHealth(), { type: 'kafka', status: 'configured', durable: true, brokerCount: 2, topic: 'domain-events' });
  const rabbit = createConfiguredWorkerBroker({ EVENT_BROKER_TYPE: 'rabbitmq', EVENT_RABBITMQ_URL: 'amqps://worker:secret@rabbit.example.test/vhost', EVENT_RABBITMQ_EXCHANGE: 'domain.events' });
  assert.equal(rabbit.getHealth().endpointOrigin, 'rabbit.example.test');
  assert.equal(JSON.stringify(rabbit.getHealth()).includes('secret'), false);
});

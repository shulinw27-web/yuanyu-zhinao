import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { PostgresRuntimeStateRepository } from '../src/repositories/postgres-runtime-state-repository.js';
import { PostgresAgentLongTaskRepository } from '../src/repositories/postgres-agent-long-task-repository.js';
import { createIdentitySessionService } from '../src/services/identity-session-service.js';
import { createAsyncIAMStore } from '../src/services/async-iam-store.js';
import { configureDomainEventRepository, DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, getDomainEventOutboxMetrics, listDomainEvents } from '../src/infrastructure/domain-events/domain-event-outbox.js';
import { IAM_NAMESPACE, IAM_WORKSPACE_KEY, createInitialIAMWorkspace } from '../src/services/iam-workspace-model.js';
import { claimAgentExecution, createAgentRun, getAgentRun } from '../src/services/agent-runtime-store.js';
import { configureAgentLongTaskRepository, consumeAgentRunTransitions, enqueueAgentLongTask, listAgentLongTasks } from '../src/services/agent-long-task-store.js';
import { claimAgentExecution as claimDistributedAgentExecution, configureAgentRunRepository, createAgentRun as createDistributedAgentRun, forgetAgentLongTermMemory as forgetDistributedMemory, getAgentLongTermMemory as getDistributedMemory, getAgentRuns as getDistributedAgentRuns, recordAgentExecution as recordDistributedAgentExecution, rememberAgentLongTermGoal as rememberDistributedMemory } from '../src/services/agent-run-store.js';
import { PostgresDomainEventStore } from '../src/infrastructure/domain-events/postgres-domain-event-store.js';
import { configureDomainEventConsumerRepository, listDomainEventConsumerMetrics, processDomainEventBatch } from '../src/workers/domain-event-worker.js';
import { appendAgentEvidenceEvent, bindAgentEvidenceTraceRun, configureAgentEvidenceTraceRepository, createAgentEvidenceTrace, getAgentEvidenceTraceByRunId, listAgentEvidenceTraces, setAgentEvidenceTraceStatus } from '../src/services/agent-evidence-trace-service.js';
import { archiveAgentConversation, configureAgentConversationRepository, createAgentConversation, getAgentConversation, getAgentConversationContext, listAgentConversations, recordAgentConversationExchange } from '../src/services/agent-conversation-service.js';
import { configureAgentLearningRepository, getAgentLearningProfile, recordApprovedWorkflowSignal, updateAgentLearningProfile } from '../src/services/agent-learning-governance-service.js';
import { configureIAMRepository, getIAMStoreInfo, getIAMUser as getRequestIAMUser, runWithIAMStoreContext, updateIAMUser as updateRequestIAMUser } from '../src/services/iam-store.js';
import { configureRiskProcurementRepository } from '../src/services/risk-procurement-store.js';
import { acknowledgeRisk, approveRisk } from '../src/services/risk-service.js';
import { approveProcurement, getProcurementScenario, launchProcurement } from '../src/services/procurement-service.js';
import { configureAlertingRepository } from '../src/domains/alerting/alerting-store.js';
import { getAlertingWorkspaceForAccess, simulateAlert } from '../src/domains/alerting/alerting-service.js';
import { configureSimulationRepository, getMockSimulationOverview, resetMockSimulation, runMockScenario, setMockConnectorFault } from '../src/services/mock-scenario-service.js';
import { configureAgentOrchestrationRepository, createAgentOrchestration, listAgentOrchestrations } from '../src/services/agent-orchestration-service.js';
import { configureSemanticGovernanceRepository, createSemanticOperationsTask, listSemanticOperationsTasks } from '../src/services/semantic-operations-task-service.js';

const migrationSql = `${await readFile(resolve(import.meta.dirname, '../migrations/postgres/001_runtime_state.sql'), 'utf8')}\n${await readFile(resolve(import.meta.dirname, '../migrations/postgres/002_agent_runtime.sql'), 'utf8')}\n${await readFile(resolve(import.meta.dirname, '../migrations/postgres/003_agent_run_transition_delivery.sql'), 'utf8')}`;

const createRepository = async ({ migrate = true } = {}) => {
  const database = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  database.public.registerFunction({ name: 'char_length', args: [DataType.text], returns: DataType.integer, implementation: (value) => value.length });
  database.public.registerFunction({ name: 'hashtext', args: [DataType.text], returns: DataType.integer, implementation: (value) => value.length });
  database.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
  const { Pool } = database.adapters.createPg();
  const pool = new Pool();
  if (migrate) await pool.query(migrationSql);
  const repository = new PostgresRuntimeStateRepository({ pool, clock: () => '2030-01-01T00:00:00.000Z' });
  return { repository, pool };
};

test('PostgreSQL repository requires an initialized and supported schema', async () => {
  const { repository, pool } = await createRepository({ migrate: false });
  try {
    await assert.rejects(repository.initialize(), /schema is not initialized|does not exist/i);
  } finally {
    await pool.end();
  }
});

test('PostgreSQL Agent runtime repository enqueues idempotently and isolates a task to its bound endpoint', async () => {
  const { pool } = await createRepository();
  const repository = new PostgresAgentLongTaskRepository({ pool, clock: () => Date.parse('2030-01-01T00:00:00.000Z') });
  try {
    assert.equal((await repository.initialize()).schemaVersion, 3);
    const input = {
      runId: 'run-pg-1', commandId: 'desktop.create_text_file', roleId: 'quality_manager',
      identityScope: { tenantId: 'tenant-a', subjectId: 'subject-a', sessionId: 'session-a', deviceId: 'device-a' }
    };
    const first = await repository.enqueue(input);
    const duplicate = await repository.enqueue(input);
    assert.equal(first.reused, false);
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.task.id, first.task.id);
    assert.deepEqual(first.task.identityScope, input.identityScope);
    assert.equal(first.task.status, 'queued');
  } finally { await repository.close(); }
});

test('PostgreSQL Agent runtime worker heartbeat and lease use database-side compare-and-swap', async () => {
  const { pool } = await createRepository();
  const repository = new PostgresAgentLongTaskRepository({ pool, clock: () => Date.parse('2030-01-01T00:00:00.000Z') });
  try {
    await repository.recordHeartbeat({ workerId: 'worker-primary', nowAt: Date.parse('2030-01-01T00:00:00.000Z') });
    const primary = await repository.acquireLease({ workerId: 'worker-primary', nowAt: Date.parse('2030-01-01T00:00:00.000Z') });
    const standby = await repository.acquireLease({ workerId: 'worker-standby', nowAt: Date.parse('2030-01-01T00:00:01.000Z') });
    assert.equal(primary.acquired, true);
    assert.equal(standby.acquired, false);
  } finally { await repository.close(); }
});

test('PostgreSQL Agent task plane enforces endpoint isolation across control, claim, dispatch, and completion', async () => {
  const { pool } = await createRepository();
  const repository = new PostgresAgentLongTaskRepository({ pool, clock: () => Date.parse('2030-01-01T00:00:00.000Z') });
  const identityScope = { tenantId: 'tenant-plane', subjectId: 'subject-plane', sessionId: 'session-plane', deviceId: 'device-plane' };
  try {
    const queued = (await repository.enqueue({ runId: 'run-plane-1', commandId: 'desktop.command', roleId: 'production_manager', identityScope })).task;
    assert.equal((await repository.listTasks({ roleIds: ['production_manager'], identityScope })).length, 1);
    assert.equal((await repository.controlTask({ taskId: queued.id, roleId: 'production_manager', identityScope: { ...identityScope, deviceId: 'other' }, action: 'pause' })).code, 'AGENT_LONG_TASK_NOT_FOUND');
    assert.equal((await repository.controlTask({ taskId: queued.id, roleId: 'production_manager', identityScope, action: 'pause' })).task.status, 'paused');
    assert.equal((await repository.controlTask({ taskId: queued.id, roleId: 'production_manager', identityScope, action: 'resume' })).task.status, 'queued');
    const claimed = await repository.claimTask({ taskId: queued.id, roleId: 'production_manager', identityScope });
    assert.equal(claimed.task.status, 'running');
    assert.equal(claimed.task.attempt, 1);
    const dispatched = await repository.markDispatched(queued.id, { dispatchId: 'dispatch-plane-1', expiresAt: '2030-01-01T00:02:00.000Z' });
    assert.equal(dispatched.task.phase, 'endpoint_dispatched');
    const completed = await repository.completeByRun('run-plane-1', true, { dispatchId: 'dispatch-plane-1' });
    assert.equal(completed.task.status, 'succeeded');
  } finally { await repository.close(); }
});

test('PostgreSQL timed-out tasks emit leased Agent Run transitions exactly once', async () => {
  const { pool } = await createRepository();
  const repository = new PostgresAgentLongTaskRepository({ pool, clock: () => 0 });
  try {
    await repository.enqueue({ runId: 'run-timeout-transition', commandId: 'desktop.command', roleId: 'production_manager', identityScope: { tenantId: 'tenant-transition', subjectId: 'subject-transition', sessionId: 'session-transition', deviceId: 'device-transition' }, nowAt: 0, timeoutMs: 60_000 });
    assert.equal((await repository.expireDueTasks({ nowAt: 60_001 })).length, 1);
    const first = await repository.claimRunTransitions({ workerId: 'transition-worker-first', nowAt: 60_002 });
    const concurrent = await repository.claimRunTransitions({ workerId: 'transition-worker-second', nowAt: 60_003 });
    assert.equal(first.length, 1);
    assert.equal(concurrent.length, 0);
    assert.equal(await repository.completeRunTransition({ transitionId: first[0].id, workerId: 'transition-worker-first', nowAt: 60_004 }), true);
    assert.equal((await repository.claimRunTransitions({ workerId: 'transition-worker-second', nowAt: 120_005 })).length, 0);
  } finally { await repository.close(); }
});

test('API task-store adapter and transition consumer keep PostgreSQL task state aligned with Agent Run', async () => {
  const { pool } = await createRepository();
  const repository = new PostgresAgentLongTaskRepository({ pool, clock: () => 0 });
  const identityScope = { tenantId: 'tenant-adapter', subjectId: 'subject-adapter', sessionId: 'session-adapter', deviceId: 'device-adapter' };
  const commandId = 'desktop.adapter.command';
  const run = createAgentRun({
    roleId: 'production_manager', identityScope, input: 'adapter timeout', domain: 'desktop_workspace', skill: {}, agents: [], plan: [], evidence: [], authorization: {}, businessControl: {}, multimodal: {},
    proposedCommand: { id: commandId, target: 'desktop', requiresConfirmation: true }
  });
  assert.ok(claimAgentExecution({ runId: run.id, commandId, confirmationToken: run.confirmationToken, roleId: 'production_manager', identityScope }).run);
  configureAgentLongTaskRepository(repository);
  try {
    const queued = await enqueueAgentLongTask({ runId: run.id, commandId, roleId: 'production_manager', identityScope, nowAt: 0 });
    assert.equal(queued.task.status, 'queued');
    assert.equal((await listAgentLongTasks(['production_manager'], identityScope, 1_000)).length, 1);
    await repository.expireDueTasks({ nowAt: 600_001 });
    const consumed = await consumeAgentRunTransitions({ workerId: 'transition-adapter-worker' });
    assert.equal(consumed.consumed, 1);
    assert.equal((await repository.getTransitionConsumerStatus()).ready, true);
    assert.equal(getAgentRun(run.id).status, 'execution_timed_out');
  } finally {
    configureAgentLongTaskRepository(null);
    await repository.close();
  }
});

test('PostgreSQL Agent Run store atomically consumes confirmation and publishes its transactional Outbox', async () => {
  const { repository } = await createRepository();
  const identityScope = { tenantId: 'tenant-run-pg', subjectId: 'subject-run-pg', sessionId: 'session-run-pg', deviceId: 'device-run-pg' };
  configureAgentRunRepository(repository);
  try {
    const created = await createDistributedAgentRun({
      roleId: 'quality_manager', identityScope, input: 'create investigation', domain: 'quality', skill: {}, agents: [], plan: [], evidence: [], authorization: {}, businessControl: {}, multimodal: {},
      proposedCommand: { id: 'create_quality_investigation', target: 'server', requiresConfirmation: true }
    });
    // pg-mem does not emulate concurrent row locks; the repository contract itself
    // uses SELECT ... FOR UPDATE and this verifies the one-time state transition.
    const attempts = [
      await claimDistributedAgentExecution({ runId: created.id, commandId: 'create_quality_investigation', confirmationToken: created.confirmationToken, roleId: 'quality_manager', identityScope }),
      await claimDistributedAgentExecution({ runId: created.id, commandId: 'create_quality_investigation', confirmationToken: created.confirmationToken, roleId: 'quality_manager', identityScope })
    ];
    assert.equal(attempts.filter((item) => item.run).length, 1);
    assert.equal(attempts.filter((item) => item.error).length, 1);
    assert.equal((await getDistributedAgentRuns(['quality_manager'], { ...identityScope, subjectId: 'other' })).length, 0);
    assert.equal((await recordDistributedAgentExecution(created.id, { commandId: 'create_quality_investigation', businessRecordId: 'QI-PG-1', status: 'draft' })).status, 'executed');

    const delivered = [];
    const summary = await processDomainEventBatch({
      consumerId: 'pg-agent-run-event-worker', tenantId: identityScope.tenantId,
      eventStore: new PostgresDomainEventStore(repository), handlers: { '*': async (event) => { delivered.push(event); } }
    });
    assert.equal(summary.published, 1);
    assert.equal(delivered[0].type, 'agent.tool_execution.succeeded');
    assert.equal(delivered[0].aggregateId, created.id);
  } finally {
    configureAgentRunRepository(null);
    await repository.close();
  }
});

test('PostgreSQL Evidence Trace store serializes hash-chain events and isolates subjects', async () => {
  const { repository } = await createRepository();
  const identityScope = { tenantId: 'tenant-trace-pg', subjectId: 'subject-trace-pg', sessionId: 'session-trace-pg', deviceId: 'device-trace-pg' };
  configureAgentEvidenceTraceRepository(repository);
  try {
    const trace = await createAgentEvidenceTrace({ roleId: 'quality_manager', identityScope, input: 'inspect quality alarm', requestId: 'trace-pg-1' });
    await Promise.all([
      appendAgentEvidenceEvent(trace.id, { type: 'authorization_evaluated', stage: 'authorization', status: 'allowed', summary: '授权通过。' }),
      appendAgentEvidenceEvent(trace.id, { type: 'evidence_retrieved', stage: 'retrieval', status: 'completed', summary: '证据已读取。' })
    ]);
    await bindAgentEvidenceTraceRun(trace.id, { runId: 'run-trace-pg-1', roleId: 'quality_manager', domain: 'quality' });
    await setAgentEvidenceTraceStatus(trace.id, 'completed', { completed: true });
    const competing = await createAgentEvidenceTrace({ roleId: 'quality_manager', identityScope, input: 'competing trace' });
    const conflict = await bindAgentEvidenceTraceRun(competing.id, { runId: 'run-trace-pg-1', roleId: 'quality_manager', domain: 'quality' });
    assert.equal(conflict.code, 'EVIDENCE_RUN_INDEX_CONFLICT');

    const restored = await getAgentEvidenceTraceByRunId('run-trace-pg-1', ['quality_manager'], identityScope);
    assert.equal(restored.status, 'completed');
    assert.equal(restored.eventCount, 3);
    assert.equal(restored.integrity.valid, true);
    assert.deepEqual(restored.events.map((event) => event.sequence), [1, 2, 3]);
    assert.equal((await listAgentEvidenceTraces(['quality_manager'], { ...identityScope, subjectId: 'other' })).length, 0);
  } finally {
    configureAgentEvidenceTraceRepository(null);
    await repository.close();
  }
});

test('PostgreSQL Agent memory is shared, deduplicated, subject-isolated, and revocable', async () => {
  const { repository } = await createRepository();
  const identityScope = { tenantId: 'tenant-memory-pg', subjectId: 'subject-memory-pg', sessionId: 'session-memory-pg', deviceId: 'device-memory-pg' };
  configureAgentRunRepository(repository);
  try {
    const first = await rememberDistributedMemory({ roleId: 'quality_manager', identityScope, goal: '持续跟踪 RM-20260718 的质量状态。', domain: 'production' });
    const duplicate = await rememberDistributedMemory({ roleId: 'quality_manager', identityScope, goal: '持续跟踪 RM-20260718 的质量状态。', domain: 'production' });
    assert.equal(first.reused, false);
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.memory.id, first.memory.id);
    assert.equal((await getDistributedMemory('quality_manager', identityScope)).length, 1);
    assert.equal((await getDistributedMemory('quality_manager', { ...identityScope, subjectId: 'other' })).length, 0);
    assert.equal((await forgetDistributedMemory('quality_manager', identityScope, first.memory.id)).memory.id, first.memory.id);
    assert.equal((await getDistributedMemory('quality_manager', identityScope)).length, 0);
  } finally {
    configureAgentRunRepository(null);
    await repository.close();
  }
});

test('PostgreSQL Agent conversations persist task context, enforce subject isolation, and release archived slots', async () => {
  const { repository } = await createRepository();
  const identityScope = { tenantId: 'tenant-conversation-pg', subjectId: 'subject-conversation-pg' };
  const accessContext = { roleIds: ['quality_manager'], organizationIds: ['org-quality'], pagePermissionIds: ['page.agent.view'], buttonPermissionIds: ['agent.prompt.run'], dataScopes: [] };
  configureAgentConversationRepository(repository);
  try {
    const created = [];
    for (let index = 0; index < 8; index += 1) created.push(await createAgentConversation({ roleId: 'quality_manager', identityScope, accessContext, title: `任务 ${index + 1}` }));
    assert.equal((await createAgentConversation({ roleId: 'quality_manager', identityScope, accessContext })).code, 'AGENT_ACTIVE_TASK_LIMIT');
    await recordAgentConversationExchange({ conversationId: created[0].id, identityScope, roleId: 'quality_manager', accessContext, userText: '分析 RM-20260718 报警', response: { text: '已完成受控分析', runId: 'run-conversation-pg', task: { goal: '分析 RM-20260718 报警', primaryDomain: 'production', phase: 'analysis_completed', status: 'completed' } } });
    assert.match((await getAgentConversationContext(created[0].id, identityScope, accessContext)).prompt, /RM-20260718/);
    assert.equal(await getAgentConversation(created[0].id, { ...identityScope, subjectId: 'other' }, accessContext), null);
    assert.equal((await listAgentConversations(identityScope, accessContext)).length, 8);
    await archiveAgentConversation(created[1].id, identityScope);
    assert.equal((await createAgentConversation({ roleId: 'quality_manager', identityScope, accessContext, title: '释放槽位后的任务' })).error, undefined);
  } finally {
    configureAgentConversationRepository(null);
    await repository.close();
  }
});

test('PostgreSQL learning governance atomically binds minimized signals to active consent', async () => {
  const { repository } = await createRepository();
  const identityScope = { tenantId: 'tenant-learning-pg', subjectId: 'subject-learning-pg' };
  configureAgentLearningRepository(repository);
  try {
    assert.equal((await getAgentLearningProfile(identityScope)).workflowLearningEnabled, false);
    const enabled = await updateAgentLearningProfile({ identityScope, settings: { workflowLearningEnabled: true }, expectedVersion: 1 });
    const recorded = await recordApprovedWorkflowSignal({ identityScope, roleId: 'quality_manager', runId: 'sensitive-run-id', toolId: 'quality.read', outcomeType: 'analysis_completed' });
    assert.equal(recorded.recorded, true);
    assert.equal(recorded.signal.rawPromptStored, false);
    assert.doesNotMatch(JSON.stringify(recorded.signal), /sensitive-run-id/);
    const disabled = await updateAgentLearningProfile({ identityScope, settings: { workflowLearningEnabled: false }, expectedVersion: enabled.version });
    assert.equal(disabled.removedSignals, 1);
    assert.equal(disabled.signalCount, 0);
    assert.equal((await recordApprovedWorkflowSignal({ identityScope, roleId: 'quality_manager', runId: 'later-run', toolId: 'quality.read', outcomeType: 'analysis_completed' })).reason, 'consent_disabled');
    assert.equal((await getAgentLearningProfile({ ...identityScope, subjectId: 'other' })).signalCount, 0);
  } finally {
    configureAgentLearningRepository(null);
    await repository.close();
  }
});

test('PostgreSQL repository persists, versions, lists, deletes, and resets JSON state', async () => {
  const { repository } = await createRepository();
  try {
    assert.equal((await repository.initialize()).persistence, 'durable_distributed');
    assert.deepEqual(await repository.readState('orders', 'OMS-1', () => ({ status: 'created' })), { status: 'created' });
    assert.deepEqual(await repository.writeState('orders', 'OMS-1', { status: 'confirmed' }), { status: 'confirmed' });
    const rows = await repository.listState('orders');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].version, 2);
    assert.deepEqual(rows[0].value, { status: 'confirmed' });
    assert.equal(await repository.deleteState('orders', 'OMS-1'), true);
    assert.equal(await repository.readState('orders', 'OMS-1'), null);
    await repository.writeState('orders', 'OMS-2', { status: 'created' });
    await repository.resetRuntimeState(['orders']);
    assert.deepEqual(await repository.listState('orders'), []);
  } finally {
    await repository.close();
  }
});

test('PostgreSQL mutation contract commits atomically and rolls back aborted or failed changes', async () => {
  const { repository } = await createRepository();
  try {
    const first = await repository.mutateState('counter', 'primary', { count: 0 }, (state, version) => ({ value: { count: state.count + 1 }, result: { previousVersion: version } }));
    assert.deepEqual(first, { previousVersion: 0 });
    const aborted = await repository.mutateState('counter', 'primary', { count: 0 }, () => ({ commit: false, result: 'aborted' }));
    assert.equal(aborted, 'aborted');
    assert.deepEqual(await repository.readState('counter', 'primary'), { count: 1 });

    const result = await repository.mutateStates([
      { name: 'aggregate', namespace: 'procurement', key: 'PR-1', initialValue: { status: 'draft' } },
      { name: 'outbox', namespace: 'domain_event_outbox', key: 'default', initialValue: [] }
    ], (values, versions) => ({
      values: {
        aggregate: { status: 'submitted' },
        outbox: [...values.outbox, { id: 'evt-1', aggregateVersion: versions.aggregate + 1 }]
      },
      result: 'committed'
    }));
    assert.equal(result, 'committed');
    assert.deepEqual(await repository.readState('procurement', 'PR-1'), { status: 'submitted' });
    assert.deepEqual(await repository.readState('domain_event_outbox', 'default'), [{ id: 'evt-1', aggregateVersion: 1 }]);

    await assert.rejects(repository.mutateStates([
      { name: 'aggregate', namespace: 'procurement', key: 'PR-1', initialValue: {} },
      { name: 'outbox', namespace: 'domain_event_outbox', key: 'default', initialValue: [] }
    ], () => { throw new Error('transaction failed'); }), /transaction failed/);
    assert.deepEqual(await repository.readState('procurement', 'PR-1'), { status: 'submitted' });
    assert.deepEqual(await repository.readState('domain_event_outbox', 'default'), [{ id: 'evt-1', aggregateVersion: 1 }]);
  } finally {
    await repository.close();
  }
});

test('identity session application service runs against the asynchronous PostgreSQL repository port', async () => {
  const { repository } = await createRepository();
  const user = { id: 'usr-pg-1', account: 'pg-user@example.test', status: 'active', version: 1, roleIds: ['quality_manager'] };
  const service = createIdentitySessionService({
    repository,
    findUserByAccount: (account) => account === user.account ? structuredClone(user) : null,
    findRolePolicy: () => ({ version: 4 }),
    clock: () => Date.parse('2030-01-01T00:00:00.000Z'),
    createId: () => 'identity-postgres-1'
  });
  try {
    const session = await service.issueIdentitySession({ source: 'oidc', account: user.account, userName: 'PG User', roleId: 'quality_manager', roleName: '质量经理', deviceId: 'device-pg', platform: 'web' });
    assert.equal(session.id, 'identity-postgres-1');
    assert.equal((await service.validateIdentitySession(session.id, 'quality_manager', 'device-pg')).session.account, user.account);
    user.version += 1;
    const stale = await service.validateIdentitySession(session.id, 'quality_manager', 'device-pg');
    assert.equal(stale.code, 'IDENTITY_AUTHORIZATION_STALE');
    assert.equal(await repository.readState('identity_sessions', session.id), null);
  } finally {
    await repository.close();
  }
});

test('asynchronous IAM store atomically persists authorization changes and outbox events in PostgreSQL', async () => {
  const { repository } = await createRepository();
  const service = createAsyncIAMStore({ repository, clock: () => '2030-01-01T00:00:00.000Z', createId: () => 'pg-iam-id' });
  try {
    const current = await service.getUser('usr-003');
    const changed = await service.updateUser(current.id, { ...current, status: 'inactive' }, current.version, (result) => ({
      eventId: 'evt-iam-user-1',
      type: 'iam.user.authorization_changed',
      aggregateType: 'IAMUser',
      aggregateId: result.user.id,
      payload: { userId: result.user.id, roleIds: result.user.roleIds, status: result.user.status, policyVersion: result.version }
    }));
    assert.equal(changed.user.status, 'inactive');
    assert.equal(changed.user.version, 2);
    assert.equal((await repository.readState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY)).events[0].eventId, 'evt-iam-user-1');

    const stale = await service.updateUser(current.id, { ...current, status: 'active' }, current.version, () => ({
      type: 'iam.user.authorization_changed', aggregateType: 'IAMUser', aggregateId: current.id,
      payload: { userId: current.id, roleIds: current.roleIds, status: 'active', policyVersion: 3 }
    }));
    assert.equal(stale.code, 'VERSION_CONFLICT');
    assert.equal((await repository.readState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY)).events.length, 1);

    await assert.rejects(service.updateUser(current.id, { ...changed.user, status: 'active' }, changed.user.version, {
      type: 'iam.user.authorization_changed', aggregateType: 'IAMUser', aggregateId: current.id, payload: {}
    }), /missing payload fields/i);
    const rolledBack = await service.getUser(current.id);
    assert.equal(rolledBack.status, 'inactive');
    assert.equal(rolledBack.version, 2);
  } finally {
    await repository.close();
  }
});

test('asynchronous IAM store migrates legacy workspaces and persists role policy audits', async () => {
  const { repository } = await createRepository();
  const service = createAsyncIAMStore({ repository, clock: () => '2030-01-01T00:00:00.000Z', createId: () => 'pg-iam-migration' });
  try {
    const legacy = createInitialIAMWorkspace();
    legacy.schemaVersion = 1;
    legacy.rolePolicies.executive.buttonPermissionIds = legacy.rolePolicies.executive.buttonPermissionIds.filter((id) => id !== 'notification.voice.test' && id !== 'event.outbox.view');
    await repository.writeState(IAM_NAMESPACE, IAM_WORKSPACE_KEY, legacy);
    const snapshot = await service.getSnapshot();
    assert.ok((await service.getRolePolicy('executive')).buttonPermissionIds.includes('notification.voice.test'));
    assert.ok((await service.getRolePolicy('executive')).buttonPermissionIds.includes('event.outbox.view'));
    assert.equal(snapshot.audits[0].action, 'IAM_SCHEMA_MIGRATED');

    const policy = await service.getRolePolicy('quality_manager');
    const changed = await service.updateRolePolicy(policy.roleId, { ...policy, dataScope: { mode: 'current_org', organizationIds: [] } }, policy.version, (result) => ({
      eventId: 'evt-iam-policy-1',
      type: 'iam.role_policy.published',
      aggregateType: 'IAMRolePolicy',
      aggregateId: result.policy.roleId,
      payload: { roleId: result.policy.roleId, policyVersion: result.policy.version, dataScopeMode: result.policy.dataScope.mode }
    }));
    assert.equal(changed.policy.dataScope.mode, 'current_org');
    const audit = await service.appendAudit({ action: 'ROLE_POLICY_UPDATED', targetType: 'role', targetId: policy.roleId, actorRoleId: 'executive' });
    assert.equal(audit.id, 'iam-audit-pg-iam-migration');
    assert.equal((await service.getAudits(1))[0].action, 'ROLE_POLICY_UPDATED');
  } finally {
    await repository.close();
  }
});

test('PostgreSQL IAM request snapshots are fresh, write-through, and preserve the last-executive invariant', async () => {
  const { repository } = await createRepository();
  configureIAMRepository(repository);
  try {
    assert.equal(getIAMStoreInfo().driver, 'postgres');
    assert.throws(() => getRequestIAMUser('usr-001'), /request-scoped snapshot/i);

    const promoted = await runWithIAMStoreContext(async () => {
      const market = getRequestIAMUser('usr-005');
      const result = await updateRequestIAMUser(market.id, {
        ...market,
        roleIds: [...market.roleIds, 'executive']
      }, market.version);
      assert.equal(getRequestIAMUser(market.id).version, result.user.version);
      return result.user;
    });

    await runWithIAMStoreContext(() => {
      assert.equal(getRequestIAMUser(promoted.id).roleIds.includes('executive'), true);
    });

    const outcomes = await Promise.all([
      runWithIAMStoreContext(async () => {
        const admin = getRequestIAMUser('usr-001');
        return updateRequestIAMUser(admin.id, { ...admin, roleIds: ['quality_manager'], primaryRoleId: 'quality_manager' }, admin.version);
      }),
      runWithIAMStoreContext(async () => {
        const market = getRequestIAMUser('usr-005');
        return updateRequestIAMUser(market.id, { ...market, roleIds: ['marketing_manager'], primaryRoleId: 'marketing_manager' }, market.version);
      })
    ]);
    assert.equal(outcomes.filter((item) => item.user).length, 1);
    assert.equal(outcomes.filter((item) => item.code === 'LAST_EXECUTIVE_GUARD').length, 1);

    await runWithIAMStoreContext(() => {
      const activeExecutives = ['usr-001', 'usr-005'].map(getRequestIAMUser)
        .filter((user) => user.status === 'active' && user.roleIds.includes('executive'));
      assert.equal(activeExecutives.length, 1);
    });
  } finally {
    configureIAMRepository(null);
    await repository.close();
  }
});

test('PostgreSQL risk and procurement aggregates serialize concurrent transitions with one transactional event each', async () => {
  const { repository } = await createRepository();
  const qualityManager = { id: 'quality_manager', name: '质量经理' };
  const executive = { id: 'executive', name: '管理层' };
  const procurementManager = { id: 'procurement_manager', name: '采购经理' };
  const identityScope = { tenantId: 'tenant-risk-procurement-pg' };
  configureRiskProcurementRepository(repository);
  configureAlertingRepository(repository);
  configureDomainEventRepository(repository);
  configureDomainEventConsumerRepository(repository);
  try {
    const acknowledgements = await Promise.all([
      acknowledgeRisk('RC-2026-0042', qualityManager),
      acknowledgeRisk('RC-2026-0042', qualityManager)
    ]);
    assert.deepEqual(acknowledgements.map((risk) => risk.status), ['处理中', '处理中']);

    const approvals = await Promise.all([
      approveRisk('RC-2026-0042', qualityManager),
      approveRisk('RC-2026-0042', qualityManager)
    ]);
    assert.deepEqual(approvals.map((risk) => risk.status), ['已审批', '已审批']);

    const launches = await Promise.all([
      launchProcurement(procurementManager, undefined, identityScope),
      launchProcurement(procurementManager, undefined, identityScope)
    ]);
    assert.deepEqual(launches.map((scenario) => scenario.execution.status), ['审批中', '审批中']);

    const procurementApprovals = await Promise.all([
      approveProcurement(executive, undefined, identityScope),
      approveProcurement(executive, undefined, identityScope)
    ]);
    assert.deepEqual(procurementApprovals.map((scenario) => scenario.execution.status), ['已提交执行', '已提交执行']);
    assert.equal((await getProcurementScenario()).execution.status, '已提交执行');

    const alerts = await runWithIAMStoreContext(() => Promise.all([
      simulateAlert({ riskId: 'ALERT-PG-1', sourceSystem: 'LIMS', eventType: 'TestResultFailed', organizationId: 'org-quality-dept', ownerUserId: 'usr-003', tenantId: identityScope.tenantId }, { type: 'test', id: 'pg-alerting', tenantId: identityScope.tenantId }),
      simulateAlert({ riskId: 'ALERT-PG-1', sourceSystem: 'LIMS', eventType: 'TestResultFailed', organizationId: 'org-quality-dept', ownerUserId: 'usr-003', tenantId: identityScope.tenantId }, { type: 'test', id: 'pg-alerting', tenantId: identityScope.tenantId })
    ]), identityScope.tenantId);
    assert.deepEqual(alerts.map((alert) => alert.reused).sort(), [false, true]);
    assert.equal(await runWithIAMStoreContext(async () => (await getAlertingWorkspaceForAccess('executive', { tenantId: identityScope.tenantId, subjectId: 'pg-alerting' })).auditIntegrity.valid, identityScope.tenantId), true);

    const outbox = await repository.readState(DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY);
    assert.deepEqual(outbox.events.map((event) => event.type).sort(), [
      'alert.classified',
      'procurement.requisition.approved',
      'procurement.requisition.launched',
      'risk.case.acknowledged',
      'risk.case.disposition_approved'
    ]);
    assert.equal(outbox.events.every((event) => event.status === 'pending'), true);
    assert.equal((await listDomainEvents({ tenantId: identityScope.tenantId })).length, 3);
    assert.equal((await getDomainEventOutboxMetrics()).pending, 5);
    await repository.writeState('domain_event_consumers', 'pg-control-plane', {
      schemaVersion: 1,
      processed: { 'event-pg-1': { type: 'test.fixture.created', version: 1, processedAt: '2030-01-01T00:00:00.000Z' } },
      projections: { total: 1, byType: { 'test.fixture.created': 1 }, latest: [] }
    });
    assert.equal((await listDomainEventConsumerMetrics()).find((item) => item.consumerId === 'pg-control-plane').processed, 1);
  } finally {
    configureRiskProcurementRepository(null);
    configureAlertingRepository(null);
    configureDomainEventRepository(null);
    configureDomainEventConsumerRepository(null);
    await repository.close();
  }
});

test('PostgreSQL simulation and orchestration state is shared and mutation-safe across repository clients', async () => {
  const { repository } = await createRepository();
  configureSimulationRepository(repository);
  configureAgentOrchestrationRepository(repository);
  configureSemanticGovernanceRepository(repository);
  try {
    await resetMockSimulation('executive');
    const [first, second] = await Promise.all([
      runMockScenario('quality_batch_exception', 'executive'),
      runMockScenario('order_fulfillment_risk', 'executive')
    ]);
    assert.notEqual(first.run.id, second.run.id);
    await setMockConnectorFault('qms', 'data_delay', 'executive');
    const overview = await getMockSimulationOverview('executive');
    assert.equal(overview.activeRuns.length, 2);
    assert.equal(overview.connectors.find((item) => item.systemId === 'qms').health, 'delayed');

    const identityScope = { tenantId: 'pg-orchestration', subjectId: 'operator-a' };
    await createAgentOrchestration({ identityScope, roleId: 'executive', goal: '周期分析模拟质量异常', schedule: { type: 'interval', intervalMinutes: 30, startAt: new Date(Date.now() + 120_000).toISOString() }, steps: [{ id: 'read', title: '读取模拟状态', mode: 'read' }] });
    assert.equal((await listAgentOrchestrations(identityScope)).length, 1);

    const semanticIdentity = { tenantId: 'pg-semantic', subjectId: 'semantic-operator', deviceId: 'device-a' };
    const semanticTask = await createSemanticOperationsTask({ body: { text: '查看当前语义模型状态' }, role: { id: 'executive' }, identityScope: semanticIdentity });
    assert.equal(semanticTask.status, 'completed');
    assert.equal((await listSemanticOperationsTasks({ identityScope: semanticIdentity }))[0].id, semanticTask.id);
  } finally {
    configureSimulationRepository(null);
    configureAgentOrchestrationRepository(null);
    configureSemanticGovernanceRepository(null);
    await repository.close();
  }
});

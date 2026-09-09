import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimDueAgentOrchestrations,
  controlAgentOrchestration,
  createAgentOrchestration,
  listAgentOrchestrations,
  recordAgentOrchestrationCheckpoint
} from '../src/services/agent-orchestration-service.js';
import { agentResponseToOrchestrationResult, runAgentOrchestrationWorkerCycle } from '../src/workers/agent-orchestration-worker.js';

const identity = (subjectId) => ({ tenantId: 'orchestration-test', subjectId, sessionId: `${subjectId}-session`, deviceId: `${subjectId}-device` });
const steps = [
  { id: 'collect', title: '读取受控系统状态', mode: 'read' },
  { id: 'analyze', title: '分析差异', mode: 'analysis', dependsOn: ['collect'] },
  { id: 'proposal', title: '形成待确认提案', mode: 'proposal', dependsOn: ['analyze'] }
];

test('orchestration validates DAG schedules and isolates each authenticated user', async () => {
  const scope = identity('dag-user');
  const invalid = await createAgentOrchestration({ identityScope: scope, roleId: 'production_manager', goal: 'invalid', schedule: { type: 'interval', intervalMinutes: 1 }, steps, nowAt: 1_000 });
  assert.equal(invalid.code, 'AGENT_ORCHESTRATION_SCHEDULE_INVALID');
  const cyclic = await createAgentOrchestration({ identityScope: scope, roleId: 'production_manager', goal: 'invalid', schedule: { type: 'once', runAt: new Date(70_000).toISOString() }, steps: [{ id: 'a', title: 'A', dependsOn: ['b'] }, { id: 'b', title: 'B', dependsOn: ['a'] }], nowAt: 1_000 });
  assert.equal(cyclic.code, 'AGENT_ORCHESTRATION_DEPENDENCY_CYCLE');
  const created = await createAgentOrchestration({ identityScope: scope, roleId: 'production_manager', title: '库存巡检', goal: '定时分析 WMS 和 ERP 差异', schedule: { type: 'once', runAt: new Date(70_000).toISOString() }, steps, nowAt: 1_000 });
  assert.equal(created.status, 'active');
  assert.equal(created.executionPolicy.businessWriteAllowed, false);
  assert.equal((await listAgentOrchestrations(identity('other-user'))).length, 0);
  assert.equal((await listAgentOrchestrations(scope))[0].id, created.id);
});

test('due orchestration is lease-claimed, checkpointed in dependency order, and proposal waits for confirmation', async () => {
  const scope = identity('checkpoint-user');
  const created = await createAgentOrchestration({ identityScope: scope, roleId: 'production_manager', title: '质量巡检', goal: '巡检质量状态并形成提案', schedule: { type: 'once', runAt: new Date(70_000).toISOString() }, steps, nowAt: 1_000 });
  const claimed = await claimDueAgentOrchestrations({ workerId: 'worker-a', nowAt: 70_001 });
  assert.ok(claimed.some((item) => item.id === created.id));
  assert.equal((await recordAgentOrchestrationCheckpoint({ identityScope: scope, orchestrationId: created.id, stepId: 'analyze', status: 'running' })).code, 'AGENT_ORCHESTRATION_DEPENDENCY_PENDING');
  const first = await recordAgentOrchestrationCheckpoint({ identityScope: scope, orchestrationId: created.id, stepId: 'collect', status: 'succeeded', result: { records: 12, secret: 'not-stored' } });
  assert.equal(first.checkpoints.collect.rawResultStored, false);
  assert.equal(first.checkpoints.collect.resultDigest.length, 64);
  await recordAgentOrchestrationCheckpoint({ identityScope: scope, orchestrationId: created.id, stepId: 'analyze', status: 'succeeded', result: { differences: 2 } });
  const blocked = await recordAgentOrchestrationCheckpoint({ identityScope: scope, orchestrationId: created.id, stepId: 'proposal', status: 'succeeded', result: { action: 'create_order' } });
  assert.equal(blocked.code, 'AGENT_ORCHESTRATION_CONFIRMATION_REQUIRED');
  const waiting = await recordAgentOrchestrationCheckpoint({ identityScope: scope, orchestrationId: created.id, stepId: 'proposal', status: 'waiting_confirmation', result: { action: 'create_order' } });
  assert.equal(waiting.checkpoints.proposal.status, 'waiting_confirmation');
});

test('recurring orchestration supports pause and resume without losing checkpoints', async () => {
  const scope = identity('control-user');
  const created = await createAgentOrchestration({ identityScope: scope, roleId: 'quality_manager', goal: '周期复核', schedule: { type: 'interval', intervalMinutes: 15, startAt: new Date(70_000).toISOString() }, steps: [steps[0]], nowAt: 1_000 });
  const paused = await controlAgentOrchestration({ identityScope: scope, orchestrationId: created.id, action: 'pause', nowAt: 2_000 });
  assert.equal(paused.status, 'paused');
  assert.equal((await controlAgentOrchestration({ identityScope: scope, orchestrationId: created.id, action: 'resume', nowAt: 3_000 })).status, 'active');
});

test('worker executes dependency order, stores only evidence references, and stops proposals for confirmation', async () => {
  const scope = identity('worker-cycle');
  const created = await createAgentOrchestration({ identityScope: scope, roleId: 'executive', title: '周期分析', goal: '分析风险并给出提案', nowAt: 1_000, schedule: { type: 'once', runAt: new Date(70_000).toISOString() }, steps: [
    { id: 'read', title: '读取风险', mode: 'read' },
    { id: 'analyze', title: '分析影响', mode: 'analysis', dependsOn: ['read'] },
    { id: 'proposal', title: '生成提案', mode: 'proposal', dependsOn: ['analyze'] }
  ] });
  const calls = [];
  const result = await runAgentOrchestrationWorkerCycle({ workerId: 'worker-cycle-a', now: () => 70_001, executeStep: async ({ task, step }) => {
    calls.push(`${task.subjectId}:${step.id}`);
    return { traceId: `trace-12345678-${step.id}`, outcome: step.mode === 'proposal' ? 'waiting_confirmation' : 'succeeded', secret: 'must-not-persist' };
  } });
  assert.deepEqual(calls.filter((value) => value.startsWith('worker-cycle:')), ['worker-cycle:read', 'worker-cycle:analyze', 'worker-cycle:proposal']);
  const completed = result.items.find((item) => item.id === created.id);
  assert.equal(completed.status, 'waiting_confirmation');
  assert.deepEqual(completed.checkpoints.read.resultReference, { type: 'agent_evidence_trace', id: 'trace-12345678-read' });
  assert.equal(JSON.stringify(completed).includes('must-not-persist'), false);
  assert.equal((await controlAgentOrchestration({ identityScope: scope, orchestrationId: created.id, action: 'resume', nowAt: 80_000 })).status, 'active');
});

test('scheduler requires explicit verified read completion or a real pending confirmation', () => {
  const valid = { traceId: 'trace-verified', authorization: { decision: 'ALLOW_BY_POLICY' }, lifecycle: { state: 'analysis_completed' }, task: { execution: { status: 'completed' } } };
  assert.equal(agentResponseToOrchestrationResult(valid).outcome, 'succeeded');
  for (const response of [
    { ...valid, lifecycle: { state: 'needs_input' } },
    { ...valid, lifecycle: { state: 'analysis_incomplete' } },
    { ...valid, authorization: { decision: 'DENY_BY_DEFAULT' } },
    { ...valid, task: null },
    { ...valid, traceId: null },
    { ...valid, lifecycle: { state: 'awaiting_confirmation' } }
  ]) assert.equal(agentResponseToOrchestrationResult(response).outcome, 'failed');
  const pending = { ...valid, lifecycle: { state: 'awaiting_confirmation' }, command: { requiresConfirmation: true, confirmationToken: 'do-not-persist' } };
  const result = agentResponseToOrchestrationResult(pending);
  assert.equal(result.outcome, 'waiting_confirmation');
  assert.doesNotMatch(JSON.stringify(result), /do-not-persist/);
});

test('unverified read checkpoints fail and never release downstream dependencies', async () => {
  const scope = identity('worker-unverified');
  const created = await createAgentOrchestration({ identityScope: scope, roleId: 'executive', goal: '分析生产状态', nowAt: 1000000, schedule: { type: 'once', runAt: new Date(1070000).toISOString() }, steps: steps.slice(0, 2) });
  const calls = [];
  const result = await runAgentOrchestrationWorkerCycle({ workerId: 'worker-unverified', now: () => 1070001, executeStep: async ({ task, step }) => {
    calls.push(`${task.id}:${step.id}`);
    return { traceId: 'trace-incomplete', outcome: 'failed' };
  } });
  const completed = result.items.find((item) => item.id === created.id);
  assert.equal(completed.status, 'failed');
  assert.equal(completed.checkpoints.collect.status, 'failed');
  assert.deepEqual(calls.filter((item) => item.startsWith(created.id)), [`${created.id}:collect`]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimDueAgentOrchestrations,
  controlAgentOrchestration,
  createAgentOrchestration,
  listAgentOrchestrations,
  recordAgentOrchestrationCheckpoint,
  finalizeAgentOrchestrationRun
} from '../src/services/agent-orchestration-service.js';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { agentResponseToOrchestrationResult, executeClaimedAgentOrchestration, runAgentOrchestrationWorkerCycle } from '../src/workers/agent-orchestration-worker.js';

const identity = (subjectId) => ({ tenantId: 'orchestration-test', subjectId, sessionId: `${subjectId}-session`, deviceId: `${subjectId}-device` });
const steps = [
  { id: 'collect', title: '读取受控系统状态', mode: 'read' },
  { id: 'analyze', title: '分析差异', mode: 'analysis', dependsOn: ['collect'] },
  { id: 'proposal', title: '形成待确认提案', mode: 'proposal', dependsOn: ['analyze'] }
];

test('due work beyond an inactive workspace prefix is still claimed', async () => {
  resetRuntimeState(['agent_orchestrations']);
  for (let i = 0; i < 8; i++) await createAgentOrchestration({ identityScope: identity(`future-${i}`), roleId: 'executive', goal: '未来任务', nowAt: 1000, schedule: { type: 'once', runAt: new Date(9000000).toISOString() }, steps: [steps[0]] });
  const target = await createAgentOrchestration({ identityScope: identity('due-after-prefix'), roleId: 'executive', goal: '已到期任务', nowAt: 1000, schedule: { type: 'once', runAt: new Date(70000).toISOString() }, steps: [steps[0]] });
  const claimed = await claimDueAgentOrchestrations({ workerId: 'fair-worker', nowAt: 70001, limit: 1 });
  assert.deepEqual(claimed.map(item => item.id), [target.id]);
  resetRuntimeState(['agent_orchestrations']);
});

test('scheduler orders due work by time across workspaces rather than insertion order', async () => {
  resetRuntimeState(['agent_orchestrations']);
  const late = await createAgentOrchestration({ identityScope: identity('late-first'), roleId: 'executive', goal: '晚到期', nowAt: 1000, schedule: { type: 'once', runAt: new Date(90000).toISOString() }, steps: [steps[0]] });
  const early = await createAgentOrchestration({ identityScope: identity('early-second'), roleId: 'executive', goal: '早到期', nowAt: 1000, schedule: { type: 'once', runAt: new Date(70000).toISOString() }, steps: [steps[0]] });
  const first = await claimDueAgentOrchestrations({ workerId: 'order-worker', nowAt: 100000, limit: 1 });
  assert.equal(first[0].id, early.id);
  const second = await claimDueAgentOrchestrations({ workerId: 'other-worker', nowAt: 100000, limit: 1 });
  assert.equal(second[0].id, late.id);
  resetRuntimeState(['agent_orchestrations']);
});

test('expired cleanup also reaches workspaces beyond a future-work prefix', async () => {
  resetRuntimeState(['agent_orchestrations']);
  for (let i = 0; i < 8; i++) await createAgentOrchestration({ identityScope: identity(`future-cleanup-${i}`), roleId: 'executive', goal: '未来任务', nowAt: 1000, schedule: { type: 'once', runAt: new Date(9000000).toISOString() }, steps: [steps[0]] });
  const scope = identity('expired-after-prefix');
  const target = await createAgentOrchestration({ identityScope: scope, roleId: 'executive', goal: '待清理任务', nowAt: 1000, schedule: { type: 'once', runAt: new Date(70000).toISOString() }, steps: [steps[0]] });
  assert.equal((await claimDueAgentOrchestrations({ workerId: 'cleanup-worker', nowAt: 70001, leaseMs: 10000, limit: 1 }))[0].id, target.id);
  assert.equal((await claimDueAgentOrchestrations({ workerId: 'cleanup-worker', nowAt: 80001, limit: 1 })).length, 0);
  assert.equal((await listAgentOrchestrations(scope))[0].status, 'failed');
  resetRuntimeState(['agent_orchestrations']);
});

test('cancel during a running step prevents downstream execution and late checkpoints', async () => {
  const scope = identity('cancel-in-flight');
  const created = await createAgentOrchestration({ identityScope: scope, roleId: 'executive', goal: '取消中的任务', nowAt: 1000, schedule: { type: 'once', runAt: new Date(70000).toISOString() }, steps: steps.slice(0, 2) });
  const task = (await claimDueAgentOrchestrations({ workerId: 'cancel-worker', nowAt: 70001 })).find(item => item.id === created.id);
  const calls = [];
  await executeClaimedAgentOrchestration({ task, workerId: 'cancel-worker', now: () => 70002, executeStep: async ({ step }) => {
    calls.push(step.id);
    await controlAgentOrchestration({ identityScope: scope, orchestrationId: task.id, action: 'cancel', nowAt: 70002 });
    return { traceId: 'trace-cancelled-result', outcome: 'succeeded' };
  } });
  assert.deepEqual(calls, ['collect']);
  const current = (await listAgentOrchestrations(scope))[0];
  assert.equal(current.status, 'cancelled');
  assert.notEqual(current.checkpoints.collect.status, 'succeeded');
  assert.equal(current.checkpoints.analyze, undefined);
});

test('expired orchestration leases and same-worker old generations cannot write results', async () => {
  const scope = identity('lease-generation');
  const created = await createAgentOrchestration({ identityScope: scope, roleId: 'executive', goal: '租约竞争', nowAt: 1000, schedule: { type: 'interval', intervalMinutes: 15, startAt: new Date(70000).toISOString() }, steps: [steps[0]] });
  const first = (await claimDueAgentOrchestrations({ workerId: 'shared-worker', nowAt: 70001, leaseMs: 10000 })).find(item => item.id === created.id);
  const common = { identityScope: scope, orchestrationId: created.id, workerId: 'shared-worker', leaseToken: first.lease?.token };
  assert.equal((await finalizeAgentOrchestrationRun({ ...common, outcome: 'succeeded', nowAt: 80001 })).code, 'AGENT_ORCHESTRATION_LEASE_MISMATCH');
  const second = (await claimDueAgentOrchestrations({ workerId: 'shared-worker', nowAt: 970002 })).find(item => item.id === created.id);
  assert.notEqual(second.lease?.token, first.lease?.token);
  assert.equal((await recordAgentOrchestrationCheckpoint({ ...common, stepId: 'collect', status: 'succeeded', nowAt: 970003 })).code, 'AGENT_ORCHESTRATION_LEASE_MISMATCH');
});

test('expired one-shot tasks fail closed instead of staying running or automatically repeating', async () => {
  const scope = identity('expired-once');
  const created = await createAgentOrchestration({ identityScope: scope, roleId: 'executive', goal: '单次任务超时', nowAt: 1000, schedule: { type: 'once', runAt: new Date(70000).toISOString() }, steps: [steps[0]] });
  const first = (await claimDueAgentOrchestrations({ workerId: 'once-worker', nowAt: 70001, leaseMs: 10000 })).find(item => item.id === created.id);
  assert.ok(first.lease.token);
  const reclaimed = await claimDueAgentOrchestrations({ workerId: 'replacement-worker', nowAt: 80001 });
  assert.equal(reclaimed.some(item => item.id === created.id), false);
  const current = (await listAgentOrchestrations(scope))[0];
  assert.equal(current.status, 'failed'); assert.equal(current.lastRunStatus, 'failed');
  assert.equal(Object.hasOwn(current, 'lease'), false);
});

test('a valid lease does not permit completion without matching checkpoints', async () => {
  const scope = identity('unproven-final');
  const created = await createAgentOrchestration({ identityScope: scope, roleId: 'executive', goal: '不可虚报完成', nowAt: 1000, schedule: { type: 'once', runAt: new Date(70000).toISOString() }, steps: [steps[0]] });
  const claimed = (await claimDueAgentOrchestrations({ workerId: 'unproven-worker', nowAt: 70001 })).find(item => item.id === created.id);
  for (const outcome of ['succeeded', 'waiting_confirmation']) assert.equal((await finalizeAgentOrchestrationRun({ identityScope: scope, orchestrationId: created.id, workerId: 'unproven-worker', leaseToken: claimed.lease.token, outcome, nowAt: 70002 })).code, 'AGENT_ORCHESTRATION_OUTCOME_UNVERIFIED');
});

test('pause and resume invalidates the prior run even when the worker ID is reused', async () => {
  const scope = identity('pause-running');
  const created = await createAgentOrchestration({ identityScope: scope, roleId: 'executive', goal: '暂停运行任务', nowAt: 1000, schedule: { type: 'once', runAt: new Date(70000).toISOString() }, steps: [steps[0]] });
  const first = (await claimDueAgentOrchestrations({ workerId: 'pause-worker', nowAt: 70001 })).find(item => item.id === created.id);
  assert.equal((await controlAgentOrchestration({ identityScope: scope, orchestrationId: created.id, action: 'pause', nowAt: 70002 })).status, 'paused');
  await controlAgentOrchestration({ identityScope: scope, orchestrationId: created.id, action: 'resume', nowAt: 70003 });
  const second = (await claimDueAgentOrchestrations({ workerId: 'pause-worker', nowAt: 70004 })).find(item => item.id === created.id);
  assert.notEqual(second.lease.token, first.lease.token);
  assert.equal((await finalizeAgentOrchestrationRun({ identityScope: scope, orchestrationId: created.id, workerId: 'pause-worker', leaseToken: first.lease.token, outcome: 'succeeded', nowAt: 70005 })).code, 'AGENT_ORCHESTRATION_LEASE_MISMATCH');
});

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
  const lease = { workerId: 'worker-a', leaseToken: claimed.find(item => item.id === created.id).lease.token, nowAt: 70002 };
  assert.equal((await recordAgentOrchestrationCheckpoint({ ...lease, identityScope: scope, orchestrationId: created.id, stepId: 'analyze', status: 'running' })).code, 'AGENT_ORCHESTRATION_DEPENDENCY_PENDING');
  const first = await recordAgentOrchestrationCheckpoint({ ...lease, identityScope: scope, orchestrationId: created.id, stepId: 'collect', status: 'succeeded', result: { records: 12, secret: 'not-stored' } });
  assert.equal(first.checkpoints.collect.rawResultStored, false);
  assert.equal(first.checkpoints.collect.resultDigest.length, 64);
  await recordAgentOrchestrationCheckpoint({ ...lease, identityScope: scope, orchestrationId: created.id, stepId: 'analyze', status: 'succeeded', result: { differences: 2 } });
  const blocked = await recordAgentOrchestrationCheckpoint({ ...lease, identityScope: scope, orchestrationId: created.id, stepId: 'proposal', status: 'succeeded', result: { action: 'create_order' } });
  assert.equal(blocked.code, 'AGENT_ORCHESTRATION_CONFIRMATION_REQUIRED');
  const waiting = await recordAgentOrchestrationCheckpoint({ ...lease, identityScope: scope, orchestrationId: created.id, stepId: 'proposal', status: 'waiting_confirmation', result: { action: 'create_order' } });
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

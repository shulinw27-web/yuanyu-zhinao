import test from 'node:test';
import assert from 'node:assert/strict';
import { claimAgentExecution, createAgentRun, getAgentRun, recordAgentEndpointDispatch, recordAgentEndpointReceipt } from '../src/services/agent-runtime-store.js';
import { cancelAgentLongTask, claimAgentLongTask, enqueueAgentLongTask, expireAgentLongTasks, getAgentLongTaskQueueMetrics, listAgentLongTasks, pauseAgentLongTask, resumeAgentLongTask, runAgentLongTaskMaintenanceCycle } from '../src/services/agent-long-task-service.js';

const roleId = 'production_manager';
const identity = (suffix) => ({ tenantId: 'long-task-tenant', subjectId: `long-task-user-${suffix}`, sessionId: `long-task-session-${suffix}`, deviceId: `long-task-device-${suffix}`, platform: 'desktop' });
const createExecutingRun = (scope, suffix) => {
  const commandId = `desktop_command_${suffix}`;
  const created = createAgentRun({
    roleId,
    identityScope: scope,
    input: `long task ${suffix}`,
    domain: 'desktop_workspace',
    skill: { id: 'test', name: 'test', version: '1' },
    agents: [], plan: [], evidence: [], authorization: {}, businessControl: {}, multimodal: {},
    proposedCommand: { id: commandId, target: 'desktop', requiresConfirmation: true, endpointAction: { dispatchId: `desktop-dispatch-${suffix}`, toolId: 'desktop.artifact.create_text', input: { fileName: `${suffix}.md`, content: 'test', conflictPolicy: 'create_unique' } } }
  });
  const claimed = claimAgentExecution({ runId: created.id, commandId, confirmationToken: created.confirmationToken, roleId, identityScope: scope });
  assert.ok(claimed.run);
  return { runId: created.id, commandId };
};

test('long task pause and resume preserve queue state and device isolation', () => {
  const scope = identity('pause');
  const run = createExecutingRun(scope, 'pause');
  const queued = enqueueAgentLongTask({ ...run, roleId, identityScope: scope, nowAt: 1_000 }).task;
  assert.equal(queued.status, 'queued');
  const paused = pauseAgentLongTask({ taskId: queued.id, roleId, identityScope: scope, nowAt: 2_000 });
  assert.equal(paused.task.status, 'paused');
  assert.equal(claimAgentLongTask({ taskId: queued.id, roleId, identityScope: scope, nowAt: 3_000 }).code, 'AGENT_LONG_TASK_NOT_CLAIMABLE');
  assert.equal(resumeAgentLongTask({ taskId: queued.id, roleId, identityScope: { ...scope, deviceId: 'other' }, nowAt: 3_000 }).code, 'AGENT_LONG_TASK_NOT_FOUND');
  const resumed = resumeAgentLongTask({ taskId: queued.id, roleId, identityScope: scope, nowAt: 3_000 });
  assert.equal(resumed.task.status, 'queued');
  const claimed = claimAgentLongTask({ taskId: queued.id, roleId, identityScope: scope, nowAt: 4_000 });
  assert.equal(claimed.task.status, 'running');
  assert.equal(claimed.task.attempt, 1);
  assert.equal(cancelAgentLongTask({ taskId: queued.id, roleId, identityScope: scope, nowAt: 5_000 }).code, 'AGENT_LONG_TASK_NOT_CANCELLABLE');
});

test('cancelling a queued long task prevents all later dispatch claims', () => {
  const scope = identity('cancel');
  const run = createExecutingRun(scope, 'cancel');
  const queued = enqueueAgentLongTask({ ...run, roleId, identityScope: scope }).task;
  const cancelled = cancelAgentLongTask({ taskId: queued.id, roleId, identityScope: scope });
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(getAgentRun(run.runId).status, 'cancelled');
  assert.equal(claimAgentLongTask({ taskId: queued.id, roleId, identityScope: scope }).code, 'AGENT_LONG_TASK_NOT_CLAIMABLE');
});

test('queue and worker lease timeouts fail closed instead of retrying endpoint actions', () => {
  const previousTimeout = process.env.AGENT_LONG_TASK_TIMEOUT_MS;
  const previousLease = process.env.AGENT_LONG_TASK_LEASE_MS;
  process.env.AGENT_LONG_TASK_TIMEOUT_MS = '60000';
  process.env.AGENT_LONG_TASK_LEASE_MS = '30000';
  try {
    const queuedScope = identity('queue-timeout');
    const queuedRun = createExecutingRun(queuedScope, 'queue-timeout');
    const queued = enqueueAgentLongTask({ ...queuedRun, roleId, identityScope: queuedScope, nowAt: 1_000 }).task;
    const expiredQueued = expireAgentLongTasks({ nowAt: 61_001 });
    assert.ok(expiredQueued.some((item) => item.id === queued.id && item.status === 'timed_out'));
    assert.equal(getAgentRun(queuedRun.runId).status, 'execution_timed_out');

    const runningScope = identity('lease-timeout');
    const runningRun = createExecutingRun(runningScope, 'lease-timeout');
    const running = enqueueAgentLongTask({ ...runningRun, roleId, identityScope: runningScope, nowAt: 100_000 }).task;
    claimAgentLongTask({ taskId: running.id, roleId, identityScope: runningScope, nowAt: 101_000 });
    const expiredRunning = expireAgentLongTasks({ nowAt: 131_001 });
    assert.ok(expiredRunning.some((item) => item.id === running.id && item.phase === 'worker_lease_expired'));
    assert.equal(getAgentRun(runningRun.runId).status, 'execution_failed');
    assert.equal(listAgentLongTasks(roleId, runningScope, 131_002).find((item) => item.id === running.id).attempt, 1);
  } finally {
    if (previousTimeout === undefined) delete process.env.AGENT_LONG_TASK_TIMEOUT_MS; else process.env.AGENT_LONG_TASK_TIMEOUT_MS = previousTimeout;
    if (previousLease === undefined) delete process.env.AGENT_LONG_TASK_LEASE_MS; else process.env.AGENT_LONG_TASK_LEASE_MS = previousLease;
  }
});

test('late endpoint receipts are rejected and cannot turn an expired dispatch into success', () => {
  const scope = identity('late-receipt');
  const run = createExecutingRun(scope, 'late-receipt');
  const dispatchId = 'desktop-dispatch-late-receipt';
  const dispatched = recordAgentEndpointDispatch(run.runId, { dispatchId, toolId: 'desktop.artifact.create_text', expiresAt: new Date(0).toISOString() });
  assert.ok(dispatched.run);
  const receipt = recordAgentEndpointReceipt({
    runId: run.runId,
    roleId,
    identityScope: scope,
    commandId: run.commandId,
    dispatchId,
    receipt: { status: 'succeeded', dispatchId, toolId: 'desktop.artifact.create_text', artifact: { relativePath: 'late.md', bytes: 4, sha256: 'a'.repeat(64), workspace: '元域智脑工作区' } }
  });
  assert.equal(receipt.code, 'DESKTOP_RECEIPT_EXPIRED');
  assert.equal(getAgentRun(run.runId).status, 'execution_failed');
});

test('maintenance workers use a renewable single-leader lease with automatic takeover', () => {
  const first = runAgentLongTaskMaintenanceCycle({ workerId: 'runtime-worker-first', intervalMs: 5_000, leaseMs: 15_000, nowAt: 200_000 });
  assert.equal(first.leader, true);
  const standby = runAgentLongTaskMaintenanceCycle({ workerId: 'runtime-worker-standby', intervalMs: 5_000, leaseMs: 15_000, nowAt: 201_000 });
  assert.equal(standby.leader, false);
  assert.equal(standby.lease.workerId, 'runtime-worker-first');
  const takeover = runAgentLongTaskMaintenanceCycle({ workerId: 'runtime-worker-standby', intervalMs: 5_000, leaseMs: 15_000, nowAt: 215_001 });
  assert.equal(takeover.leader, true);
  assert.equal(takeover.lease.workerId, 'runtime-worker-standby');
  const metrics = getAgentLongTaskQueueMetrics({ nowAt: 215_002 });
  assert.equal(metrics.worker.status, 'healthy');
  assert.equal(metrics.worker.leaderWorkerId, 'runtime-worker-standby');
  assert.equal(metrics.worker.activeInstances, 2);
});

import { randomUUID } from 'node:crypto';
import { deleteState, listState, mutateState, readState, writeState } from '../repositories/runtime-state-repository.js';
import { abortAgentExecution, recordAgentExecutionFailure } from './agent-runtime-store.js';

const NAMESPACE = 'agent_long_runtime_tasks';
const WORKER_NAMESPACE = 'agent_long_task_workers';
const WORKER_LEASE_KEY = 'sweeper-lease';
const MAX_TASKS = 500;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_LEASE_MS = 3 * 60_000;
const MAX_PAUSE_MS = 30 * 60_000;
const ACTIVE_STATUSES = new Set(['queued', 'paused', 'running']);

const boundedEnv = (name, fallback, minimum, maximum) => {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, minimum), maximum) : fallback;
};
const taskTimeoutMs = () => boundedEnv('AGENT_LONG_TASK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 60 * 60_000);
const leaseMs = () => boundedEnv('AGENT_LONG_TASK_LEASE_MS', DEFAULT_LEASE_MS, 30_000, 10 * 60_000);
const timestamp = (nowAt = Date.now()) => new Date(nowAt).toISOString();
const normalizeIdentity = (identityScope = {}) => ({
  tenantId: String(identityScope.tenantId || '').slice(0, 120),
  subjectId: String(identityScope.subjectId || '').slice(0, 180),
  sessionId: String(identityScope.sessionId || '').slice(0, 180),
  deviceId: String(identityScope.deviceId || '').slice(0, 180)
});
const sameSubject = (task, identity) => task?.identityScope?.tenantId === identity.tenantId && task?.identityScope?.subjectId === identity.subjectId;
const sameEndpoint = (task, identity) => sameSubject(task, identity)
  && task.identityScope.sessionId === identity.sessionId
  && task.identityScope.deviceId === identity.deviceId;
const publicTask = (task) => {
  if (!task) return null;
  const { identityScope: _identityScope, ...safe } = task;
  return structuredClone(safe);
};
const taskError = (message, code) => ({ error: message, code });

const trimTasks = () => {
  const rows = listState(NAMESPACE).sort((left, right) => String(right.value.createdAt).localeCompare(String(left.value.createdAt)));
  rows.slice(MAX_TASKS).forEach((row) => {
    if (!ACTIVE_STATUSES.has(row.value.status)) mutateState(NAMESPACE, row.key, null, () => ({ value: { ...row.value, hidden: true } }));
  });
};

export function enqueueAgentLongTask({ runId, commandId, roleId, identityScope: suppliedIdentity, conversationId = null, type = 'desktop_execution', nowAt = Date.now() }) {
  const identityScope = normalizeIdentity(suppliedIdentity);
  if (!identityScope.tenantId || !identityScope.subjectId || !identityScope.sessionId || !identityScope.deviceId) return taskError('长任务必须绑定已认证的用户、会话和设备。', 'AGENT_LONG_TASK_IDENTITY_REQUIRED');
  const duplicate = listState(NAMESPACE).map((row) => row.value).find((item) => item.runId === runId && ACTIVE_STATUSES.has(item.status));
  if (duplicate) return { task: publicTask(duplicate), reused: true };
  const createdAt = timestamp(nowAt);
  const task = {
    id: `runtime-task-${randomUUID()}`,
    type,
    runId: String(runId || '').slice(0, 120),
    commandId: String(commandId || '').slice(0, 160),
    conversationId: conversationId ? String(conversationId).slice(0, 160) : null,
    roleId: String(roleId || '').slice(0, 120),
    identityScope,
    status: 'queued',
    phase: 'waiting_for_worker',
    attempt: 0,
    progress: 0,
    createdAt,
    updatedAt: createdAt,
    deadlineAt: timestamp(nowAt + taskTimeoutMs()),
    pauseExpiresAt: null,
    remainingTimeoutMs: null,
    leaseExpiresAt: null,
    dispatchId: null,
    result: null
  };
  writeState(NAMESPACE, task.id, task);
  trimTasks();
  return { task: publicTask(task), reused: false };
}

export function getAgentLongTask(taskId) {
  return readState(NAMESPACE, taskId);
}

export function expireAgentLongTasks({ nowAt = Date.now() } = {}) {
  const expired = [];
  listState(NAMESPACE).forEach((row) => {
    const result = mutateState(NAMESPACE, row.key, null, (task) => {
      if (!task || !ACTIVE_STATUSES.has(task.status)) return { commit: false, result: null };
      const dueAt = task.status === 'paused' ? Date.parse(task.pauseExpiresAt || '') : task.status === 'running' ? Date.parse(task.leaseExpiresAt || '') : Date.parse(task.deadlineAt || '');
      if (!Number.isFinite(dueAt) || dueAt > nowAt) return { commit: false, result: null };
      const previousStatus = task.status;
      task.status = 'timed_out';
      task.phase = previousStatus === 'running' ? 'worker_lease_expired' : 'deadline_expired';
      task.updatedAt = timestamp(nowAt);
      task.result = { code: 'AGENT_LONG_TASK_TIMED_OUT', message: '任务超过允许时间，已停止继续派发。' };
      return { value: task, result: structuredClone(task) };
    });
    if (result) expired.push(result);
  });
  expired.forEach((task) => {
    if (task.dispatchId || task.attempt > 0) recordAgentExecutionFailure(task.runId, '长任务 Worker 租约已过期；为避免重复端侧操作，任务不会自动重试。');
    else abortAgentExecution({ runId: task.runId, roleId: task.roleId, identityScope: task.identityScope, status: 'execution_timed_out', reason: '长任务排队或暂停超过允许时间。' });
  });
  return expired.map(publicTask);
}

export function listAgentLongTasks(roleIds, suppliedIdentity, nowAt = Date.now()) {
  expireAgentLongTasks({ nowAt });
  const identity = normalizeIdentity(suppliedIdentity);
  const allowedRoles = new Set((Array.isArray(roleIds) ? roleIds : [roleIds]).filter(Boolean));
  if (!identity.tenantId || !identity.subjectId || !allowedRoles.size) return [];
  return listState(NAMESPACE)
    .map((row) => row.value)
    .filter((task) => !task.hidden && sameEndpoint(task, identity) && allowedRoles.has(task.roleId))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 30)
    .map(publicTask);
}

const controlTask = ({ taskId, roleId, identityScope: suppliedIdentity, action, nowAt = Date.now() }) => {
  expireAgentLongTasks({ nowAt });
  const identity = normalizeIdentity(suppliedIdentity);
  return mutateState(NAMESPACE, taskId, null, (task) => {
    if (!task || task.roleId !== roleId || !sameEndpoint(task, identity)) return { commit: false, result: taskError('未找到当前会话和设备可控制的长任务。', 'AGENT_LONG_TASK_NOT_FOUND') };
    if (action === 'pause') {
      if (task.status !== 'queued') return { commit: false, result: taskError('只有排队中的任务可以暂停。', 'AGENT_LONG_TASK_NOT_PAUSABLE') };
      const remaining = Math.max(1_000, Date.parse(task.deadlineAt) - nowAt);
      task.status = 'paused'; task.phase = 'paused_by_user'; task.remainingTimeoutMs = remaining;
      task.pauseExpiresAt = timestamp(nowAt + Math.min(remaining, MAX_PAUSE_MS)); task.deadlineAt = null;
    } else if (action === 'resume') {
      if (task.status !== 'paused') return { commit: false, result: taskError('只有已暂停任务可以恢复。', 'AGENT_LONG_TASK_NOT_RESUMABLE') };
      task.status = 'queued'; task.phase = 'waiting_for_worker';
      task.deadlineAt = timestamp(nowAt + Math.max(1_000, Number(task.remainingTimeoutMs) || taskTimeoutMs()));
      task.pauseExpiresAt = null; task.remainingTimeoutMs = null;
    } else if (action === 'cancel') {
      if (!['queued', 'paused'].includes(task.status)) return { commit: false, result: taskError('任务已经开始派发，不能再安全取消。', 'AGENT_LONG_TASK_NOT_CANCELLABLE') };
      task.status = 'cancelled'; task.phase = 'cancelled_by_user'; task.result = { code: 'AGENT_LONG_TASK_CANCELLED', message: '用户已取消，未派发端侧操作。' };
    }
    task.updatedAt = timestamp(nowAt);
    return { value: task, result: { task: publicTask(task) } };
  });
};

export const pauseAgentLongTask = (input) => controlTask({ ...input, action: 'pause' });
export const resumeAgentLongTask = (input) => controlTask({ ...input, action: 'resume' });
export function cancelAgentLongTask(input) {
  const result = controlTask({ ...input, action: 'cancel' });
  if (result?.task) abortAgentExecution({ runId: result.task.runId, roleId: input.roleId, identityScope: input.identityScope, status: 'cancelled', reason: '用户在端侧派发前取消长任务。' });
  return result;
}

export function claimAgentLongTask({ taskId, roleId, identityScope: suppliedIdentity, nowAt = Date.now() }) {
  expireAgentLongTasks({ nowAt });
  const identity = normalizeIdentity(suppliedIdentity);
  return mutateState(NAMESPACE, taskId, null, (task) => {
    if (!task || task.roleId !== roleId || !sameEndpoint(task, identity)) return { commit: false, result: taskError('未找到当前会话和设备可领取的长任务。', 'AGENT_LONG_TASK_NOT_FOUND') };
    if (task.status !== 'queued') return { commit: false, result: taskError('任务不处于可领取的排队状态。', 'AGENT_LONG_TASK_NOT_CLAIMABLE') };
    task.status = 'running'; task.phase = 'worker_claimed'; task.attempt += 1; task.progress = 10;
    task.leaseExpiresAt = timestamp(nowAt + leaseMs()); task.updatedAt = timestamp(nowAt);
    return { value: task, result: { task: publicTask(task) } };
  });
}

export function markAgentLongTaskDispatched(taskId, dispatch, nowAt = Date.now()) {
  return mutateState(NAMESPACE, taskId, null, (task) => {
    if (!task || task.status !== 'running') return { commit: false, result: taskError('长任务不处于可派发状态。', 'AGENT_LONG_TASK_NOT_RUNNING') };
    task.phase = 'endpoint_dispatched'; task.progress = 50; task.dispatchId = dispatch.dispatchId;
    task.leaseExpiresAt = dispatch.expiresAt; task.updatedAt = timestamp(nowAt);
    return { value: task, result: { task: publicTask(task) } };
  });
}

export function failAgentLongTask(taskId, reason, nowAt = Date.now()) {
  return mutateState(NAMESPACE, taskId, null, (task) => {
    if (!task || !ACTIVE_STATUSES.has(task.status)) return { commit: false, result: null };
    task.status = 'failed'; task.phase = 'failed'; task.progress = 100; task.updatedAt = timestamp(nowAt);
    task.result = { code: 'AGENT_LONG_TASK_FAILED', message: String(reason || '长任务执行失败。').slice(0, 300) };
    return { value: task, result: { task: publicTask(task) } };
  });
}

export function completeAgentLongTaskByRun(runId, succeeded, result = null, nowAt = Date.now()) {
  const target = listState(NAMESPACE).map((row) => row.value).find((task) => task.runId === runId && task.status === 'running');
  if (!target) return null;
  return mutateState(NAMESPACE, target.id, null, (task) => {
    if (!task || task.status !== 'running') return { commit: false, result: null };
    task.status = succeeded ? 'succeeded' : 'failed'; task.phase = succeeded ? 'completed' : 'failed'; task.progress = 100;
    task.updatedAt = timestamp(nowAt); task.leaseExpiresAt = null; task.result = result ? structuredClone(result) : null;
    return { value: task, result: { task: publicTask(task) } };
  });
}

const normalizeWorkerId = (value) => {
  const workerId = String(value || '').trim().slice(0, 120);
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/u.test(workerId) ? workerId : null;
};

export function recordAgentLongTaskWorkerHeartbeat({ workerId: suppliedWorkerId, intervalMs = 5_000, nowAt = Date.now() }) {
  const workerId = normalizeWorkerId(suppliedWorkerId);
  if (!workerId) return taskError('Worker 标识格式无效。', 'AGENT_LONG_TASK_WORKER_ID_INVALID');
  const heartbeatTtlMs = Math.min(Math.max(Number(intervalMs) * 4, 15_000), 5 * 60_000);
  const heartbeat = {
    workerId,
    mode: 'timeout_sweeper',
    status: 'online',
    lastSeenAt: timestamp(nowAt),
    expiresAt: timestamp(nowAt + heartbeatTtlMs),
    intervalMs: Math.min(Math.max(Number(intervalMs) || 5_000, 500), 60_000)
  };
  writeState(WORKER_NAMESPACE, `heartbeat:${workerId}`, heartbeat);
  const staleBefore = nowAt - 24 * 60 * 60_000;
  listState(WORKER_NAMESPACE).forEach((row) => {
    if (row.key.startsWith('heartbeat:') && Date.parse(row.value?.expiresAt || '') < staleBefore) deleteState(WORKER_NAMESPACE, row.key);
  });
  return structuredClone(heartbeat);
}

export function acquireAgentLongTaskWorkerLease({ workerId: suppliedWorkerId, leaseMs = 15_000, nowAt = Date.now() }) {
  const workerId = normalizeWorkerId(suppliedWorkerId);
  if (!workerId) return taskError('Worker 标识格式无效。', 'AGENT_LONG_TASK_WORKER_ID_INVALID');
  const boundedLeaseMs = Math.min(Math.max(Number(leaseMs) || 15_000, 5_000), 5 * 60_000);
  return mutateState(WORKER_NAMESPACE, WORKER_LEASE_KEY, null, (lease) => {
    const leaseExpiresAt = Date.parse(lease?.expiresAt || '');
    if (lease && lease.workerId !== workerId && Number.isFinite(leaseExpiresAt) && leaseExpiresAt > nowAt) {
      return { commit: false, result: { acquired: false, lease: structuredClone(lease) } };
    }
    const next = { workerId, acquiredAt: lease?.workerId === workerId ? lease.acquiredAt : timestamp(nowAt), renewedAt: timestamp(nowAt), expiresAt: timestamp(nowAt + boundedLeaseMs) };
    return { value: next, result: { acquired: true, lease: structuredClone(next) } };
  });
}

export function getAgentLongTaskQueueMetrics({ identityScope: suppliedIdentity = null, roleIds = null, nowAt = Date.now() } = {}) {
  const identity = suppliedIdentity ? normalizeIdentity(suppliedIdentity) : null;
  const allowedRoles = roleIds ? new Set((Array.isArray(roleIds) ? roleIds : [roleIds]).filter(Boolean)) : null;
  const tasks = listState(NAMESPACE).map((row) => row.value).filter((task) => {
    if (task.hidden) return false;
    if (identity && !sameSubject(task, identity)) return false;
    return !allowedRoles || allowedRoles.has(task.roleId);
  });
  const count = (status) => tasks.filter((task) => task.status === status).length;
  const queuedAt = tasks.filter((task) => task.status === 'queued').map((task) => Date.parse(task.createdAt)).filter(Number.isFinite);
  const recentCutoff = nowAt - 60 * 60_000;
  const heartbeats = listState(WORKER_NAMESPACE).map((row) => row.value).filter((item) => item?.workerId && item?.lastSeenAt);
  const activeWorkers = heartbeats.filter((item) => Date.parse(item.expiresAt || '') > nowAt);
  const lease = readState(WORKER_NAMESPACE, WORKER_LEASE_KEY);
  const leaderOnline = Boolean(lease && Date.parse(lease.expiresAt || '') > nowAt && activeWorkers.some((item) => item.workerId === lease.workerId));
  return {
    total: tasks.length,
    queueDepth: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
    queued: count('queued'),
    paused: count('paused'),
    running: count('running'),
    succeeded: count('succeeded'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    timedOut: count('timed_out'),
    timedOutLastHour: tasks.filter((task) => task.status === 'timed_out' && Date.parse(task.updatedAt) >= recentCutoff).length,
    failedLastHour: tasks.filter((task) => task.status === 'failed' && Date.parse(task.updatedAt) >= recentCutoff).length,
    oldestQueuedAgeMs: queuedAt.length ? Math.max(0, nowAt - Math.min(...queuedAt)) : 0,
    worker: {
      status: leaderOnline ? 'healthy' : activeWorkers.length ? 'standby_only' : 'offline',
      activeInstances: activeWorkers.length,
      leaderWorkerId: leaderOnline ? lease.workerId : null,
      leaseExpiresAt: leaderOnline ? lease.expiresAt : null,
      lastHeartbeatAt: heartbeats.map((item) => item.lastSeenAt).sort().at(-1) || null
    }
  };
}

export function runAgentLongTaskMaintenanceCycle({ workerId, intervalMs = 5_000, leaseMs = 15_000, nowAt = Date.now() }) {
  const heartbeat = recordAgentLongTaskWorkerHeartbeat({ workerId, intervalMs, nowAt });
  if (heartbeat.error) return heartbeat;
  const leadership = acquireAgentLongTaskWorkerLease({ workerId, leaseMs, nowAt });
  if (!leadership.acquired) return { workerId, leader: false, expired: 0, heartbeat, lease: leadership.lease, metrics: getAgentLongTaskQueueMetrics({ nowAt }) };
  const expiredTasks = expireAgentLongTasks({ nowAt });
  return { workerId, leader: true, expired: expiredTasks.length, expiredTaskIds: expiredTasks.map((task) => task.id), heartbeat, lease: leadership.lease, metrics: getAgentLongTaskQueueMetrics({ nowAt }) };
}

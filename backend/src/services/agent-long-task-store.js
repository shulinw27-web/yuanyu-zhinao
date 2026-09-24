import { randomUUID } from 'node:crypto';
import {
  cancelAgentLongTask as cancelSqliteTask,
  claimAgentLongTask as claimSqliteTask,
  completeAgentLongTaskByRun as completeSqliteTaskByRun,
  enqueueAgentLongTask as enqueueSqliteTask,
  expireAgentLongTasks as expireSqliteTasks,
  failAgentLongTask as failSqliteTask,
  getAgentLongTask as getSqliteTask,
  getAgentLongTaskQueueMetrics as getSqliteMetrics,
  listAgentLongTasks as listSqliteTasks,
  markAgentLongTaskDispatched as markSqliteTaskDispatched,
  pauseAgentLongTask as pauseSqliteTask,
  resumeAgentLongTask as resumeSqliteTask
} from './agent-long-task-service.js';
import { abortAgentExecution, recordAgentExecutionFailure } from './agent-run-store.js';
import { getRuntimeStoreInfo } from '../repositories/runtime-state-repository.js';
import { configurePort, describePersistence, getPort, hasPort, LONG_TASK_PORT, PERSISTENCE_PORT_METHODS, PERSISTENCE_PORT_OPTIONAL_METHODS } from './persistence-port.js';

const publicTask = (task) => {
  if (!task) return null;
  const { identityScope: _identityScope, version: _version, ...safe } = task;
  return structuredClone(safe);
};
const boundedEnv = (name, fallback, minimum, maximum) => {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, minimum), maximum) : fallback;
};

export function configureAgentLongTaskRepository(repository = null) {
  configurePort(LONG_TASK_PORT, repository, {
    methods: PERSISTENCE_PORT_METHODS[LONG_TASK_PORT],
    optionalMethods: PERSISTENCE_PORT_OPTIONAL_METHODS[LONG_TASK_PORT]
  });
}

export function getAgentLongTaskStoreInfo() {
  return describePersistence(LONG_TASK_PORT, getRuntimeStoreInfo());
}

export const probeAgentLongTaskStore = async () => {
  if (!hasPort(LONG_TASK_PORT)) return { ready: true, transitionConsumer: { required: false, ready: true, activeInstances: 0 } };
  const database = await getPort(LONG_TASK_PORT).probe();
  const required = process.env.AGENT_RUN_TRANSITION_CONSUMER_ENABLED === 'true';
  const transitionConsumer = required ? await getPort(LONG_TASK_PORT).getTransitionConsumerStatus() : { ready: true, activeInstances: 0, lastHeartbeatAt: null };
  return { ready: database.ready && transitionConsumer.ready, databaseReady: database.ready, transitionConsumer: { required, ...transitionConsumer } };
};

export function enqueueAgentLongTask(input) {
  return hasPort(LONG_TASK_PORT)
    ? getPort(LONG_TASK_PORT).enqueue({ ...input, timeoutMs: boundedEnv('AGENT_LONG_TASK_TIMEOUT_MS', 600_000, 60_000, 3_600_000) }).then((result) => ({ ...result, task: publicTask(result.task) }))
    : enqueueSqliteTask(input);
}

export const getAgentLongTask = (taskId) => hasPort(LONG_TASK_PORT) ? getPort(LONG_TASK_PORT).getTask(taskId) : getSqliteTask(taskId);

export function listAgentLongTasks(roleIds, identityScope, nowAt = Date.now()) {
  return hasPort(LONG_TASK_PORT)
    ? getPort(LONG_TASK_PORT).listTasks({ roleIds, identityScope, nowAt }).then(async (items) => { await consumeAgentRunTransitions(); return items.map(publicTask); })
    : listSqliteTasks(roleIds, identityScope, nowAt);
}

const controlPostgresTask = async (input, action) => {
  await getPort(LONG_TASK_PORT).expireDueTasks({ nowAt: input.nowAt });
  await consumeAgentRunTransitions();
  const result = await getPort(LONG_TASK_PORT).controlTask({ ...input, action, timeoutMs: boundedEnv('AGENT_LONG_TASK_TIMEOUT_MS', 600_000, 60_000, 3_600_000) });
  return result?.task ? { ...result, task: publicTask(result.task) } : result;
};

export const pauseAgentLongTask = (input) => hasPort(LONG_TASK_PORT) ? controlPostgresTask(input, 'pause') : pauseSqliteTask(input);
export const resumeAgentLongTask = (input) => hasPort(LONG_TASK_PORT) ? controlPostgresTask(input, 'resume') : resumeSqliteTask(input);
export function cancelAgentLongTask(input) {
  if (!hasPort(LONG_TASK_PORT)) return cancelSqliteTask(input);
  return controlPostgresTask(input, 'cancel').then(async (result) => {
    if (result?.task) await abortAgentExecution({ runId: result.task.runId, roleId: input.roleId, identityScope: input.identityScope, status: 'cancelled', reason: '用户在端侧派发前取消长任务。' });
    return result;
  });
}

export function claimAgentLongTask(input) {
  if (!hasPort(LONG_TASK_PORT)) return claimSqliteTask(input);
  return getPort(LONG_TASK_PORT).expireDueTasks({ nowAt: input.nowAt }).then(async () => {
    await consumeAgentRunTransitions();
    const result = await getPort(LONG_TASK_PORT).claimTask({ ...input, leaseMs: boundedEnv('AGENT_LONG_TASK_LEASE_MS', 180_000, 30_000, 600_000) });
    return result?.task ? { ...result, task: publicTask(result.task) } : result;
  });
}

export const markAgentLongTaskDispatched = (taskId, dispatch, nowAt) => hasPort(LONG_TASK_PORT)
  ? getPort(LONG_TASK_PORT).markDispatched(taskId, dispatch, nowAt).then((result) => result?.task ? { ...result, task: publicTask(result.task) } : result)
  : markSqliteTaskDispatched(taskId, dispatch, nowAt);

export const failAgentLongTask = (taskId, reason, nowAt) => hasPort(LONG_TASK_PORT)
  ? getPort(LONG_TASK_PORT).failTask(taskId, reason, nowAt).then((result) => result?.task ? { ...result, task: publicTask(result.task) } : result)
  : failSqliteTask(taskId, reason, nowAt);

export const completeAgentLongTaskByRun = (runId, succeeded, result, nowAt) => hasPort(LONG_TASK_PORT)
  ? getPort(LONG_TASK_PORT).completeByRun(runId, succeeded, result, nowAt).then((outcome) => outcome?.task ? { ...outcome, task: publicTask(outcome.task) } : outcome)
  : completeSqliteTaskByRun(runId, succeeded, result, nowAt);

export const getAgentLongTaskQueueMetrics = (options = {}) => {
  if (!hasPort(LONG_TASK_PORT)) return { ...getSqliteMetrics(options), transitionConsumer: { required: false, ready: true, activeInstances: 0, lastHeartbeatAt: null } };
  return Promise.all([getPort(LONG_TASK_PORT).getMetrics(options), getPort(LONG_TASK_PORT).getTransitionConsumerStatus({ nowAt: options.nowAt })]).then(([metrics, transitionConsumer]) => ({
    ...metrics,
    transitionConsumer: { required: process.env.AGENT_RUN_TRANSITION_CONSUMER_ENABLED === 'true', ...transitionConsumer }
  }));
};

export function expireAgentLongTasks(options = {}) {
  return hasPort(LONG_TASK_PORT)
    ? getPort(LONG_TASK_PORT).expireDueTasks(options).then(async (tasks) => { await consumeAgentRunTransitions(); return tasks.map(publicTask); })
    : expireSqliteTasks(options);
}

export async function consumeAgentRunTransitions({ workerId = `agent-run-transition-${randomUUID()}`, limit = 100 } = {}) {
  if (!hasPort(LONG_TASK_PORT)) return { driver: 'sqlite', consumed: 0, failed: 0 };
  await getPort(LONG_TASK_PORT).recordHeartbeat({ workerId, mode: 'run_transition_consumer', intervalMs: boundedEnv('AGENT_RUN_TRANSITION_INTERVAL_MS', 5_000, 500, 60_000) });
  const transitions = await getPort(LONG_TASK_PORT).claimRunTransitions({ workerId, limit });
  let consumed = 0;
  let failed = 0;
  for (const transition of transitions) {
    try {
      if (transition.dispatchId || transition.attempt > 0) await recordAgentExecutionFailure(transition.runId, '长任务 Worker 租约已过期；为避免重复端侧操作，任务不会自动重试。');
      else await abortAgentExecution({ runId: transition.runId, roleId: transition.roleId, identityScope: transition.identityScope, status: 'execution_timed_out', reason: '长任务排队或暂停超过允许时间。' });
      if (await getPort(LONG_TASK_PORT).completeRunTransition({ transitionId: transition.id, workerId })) consumed += 1;
    } catch {
      failed += 1;
      await getPort(LONG_TASK_PORT).releaseRunTransition({ transitionId: transition.id, workerId });
    }
  }
  return { driver: 'postgres', claimed: transitions.length, consumed, failed };
}

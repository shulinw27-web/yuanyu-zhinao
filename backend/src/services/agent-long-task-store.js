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

let postgresRepository = null;
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
  if (repository && typeof repository.enqueue !== 'function') throw new TypeError('Agent long task repository does not implement the required port.');
  postgresRepository = repository;
}

export function getAgentLongTaskStoreInfo() {
  if (postgresRepository) return { driver: 'postgres', persistence: 'durable_distributed', schemaVersion: 3 };
  const runtimeStore = getRuntimeStoreInfo();
  return { driver: runtimeStore.driver, persistence: runtimeStore.persistence, schemaVersion: runtimeStore.schemaVersion };
}

export const probeAgentLongTaskStore = async () => {
  if (!postgresRepository) return { ready: true, transitionConsumer: { required: false, ready: true, activeInstances: 0 } };
  const database = await postgresRepository.probe();
  const required = process.env.AGENT_RUN_TRANSITION_CONSUMER_ENABLED === 'true';
  const transitionConsumer = required ? await postgresRepository.getTransitionConsumerStatus() : { ready: true, activeInstances: 0, lastHeartbeatAt: null };
  return { ready: database.ready && transitionConsumer.ready, databaseReady: database.ready, transitionConsumer: { required, ...transitionConsumer } };
};

export function enqueueAgentLongTask(input) {
  return postgresRepository
    ? postgresRepository.enqueue({ ...input, timeoutMs: boundedEnv('AGENT_LONG_TASK_TIMEOUT_MS', 600_000, 60_000, 3_600_000) }).then((result) => ({ ...result, task: publicTask(result.task) }))
    : enqueueSqliteTask(input);
}

export const getAgentLongTask = (taskId) => postgresRepository ? postgresRepository.getTask(taskId) : getSqliteTask(taskId);

export function listAgentLongTasks(roleIds, identityScope, nowAt = Date.now()) {
  return postgresRepository
    ? postgresRepository.listTasks({ roleIds, identityScope, nowAt }).then(async (items) => { await consumeAgentRunTransitions(); return items.map(publicTask); })
    : listSqliteTasks(roleIds, identityScope, nowAt);
}

const controlPostgresTask = async (input, action) => {
  await postgresRepository.expireDueTasks({ nowAt: input.nowAt });
  await consumeAgentRunTransitions();
  const result = await postgresRepository.controlTask({ ...input, action, timeoutMs: boundedEnv('AGENT_LONG_TASK_TIMEOUT_MS', 600_000, 60_000, 3_600_000) });
  return result?.task ? { ...result, task: publicTask(result.task) } : result;
};

export const pauseAgentLongTask = (input) => postgresRepository ? controlPostgresTask(input, 'pause') : pauseSqliteTask(input);
export const resumeAgentLongTask = (input) => postgresRepository ? controlPostgresTask(input, 'resume') : resumeSqliteTask(input);
export function cancelAgentLongTask(input) {
  if (!postgresRepository) return cancelSqliteTask(input);
  return controlPostgresTask(input, 'cancel').then(async (result) => {
    if (result?.task) await abortAgentExecution({ runId: result.task.runId, roleId: input.roleId, identityScope: input.identityScope, status: 'cancelled', reason: '用户在端侧派发前取消长任务。' });
    return result;
  });
}

export function claimAgentLongTask(input) {
  if (!postgresRepository) return claimSqliteTask(input);
  return postgresRepository.expireDueTasks({ nowAt: input.nowAt }).then(async () => {
    await consumeAgentRunTransitions();
    const result = await postgresRepository.claimTask({ ...input, leaseMs: boundedEnv('AGENT_LONG_TASK_LEASE_MS', 180_000, 30_000, 600_000) });
    return result?.task ? { ...result, task: publicTask(result.task) } : result;
  });
}

export const markAgentLongTaskDispatched = (taskId, dispatch, nowAt) => postgresRepository
  ? postgresRepository.markDispatched(taskId, dispatch, nowAt).then((result) => result?.task ? { ...result, task: publicTask(result.task) } : result)
  : markSqliteTaskDispatched(taskId, dispatch, nowAt);

export const failAgentLongTask = (taskId, reason, nowAt) => postgresRepository
  ? postgresRepository.failTask(taskId, reason, nowAt).then((result) => result?.task ? { ...result, task: publicTask(result.task) } : result)
  : failSqliteTask(taskId, reason, nowAt);

export const completeAgentLongTaskByRun = (runId, succeeded, result, nowAt) => postgresRepository
  ? postgresRepository.completeByRun(runId, succeeded, result, nowAt).then((outcome) => outcome?.task ? { ...outcome, task: publicTask(outcome.task) } : outcome)
  : completeSqliteTaskByRun(runId, succeeded, result, nowAt);

export const getAgentLongTaskQueueMetrics = (options = {}) => {
  if (!postgresRepository) return { ...getSqliteMetrics(options), transitionConsumer: { required: false, ready: true, activeInstances: 0, lastHeartbeatAt: null } };
  return Promise.all([postgresRepository.getMetrics(options), postgresRepository.getTransitionConsumerStatus({ nowAt: options.nowAt })]).then(([metrics, transitionConsumer]) => ({
    ...metrics,
    transitionConsumer: { required: process.env.AGENT_RUN_TRANSITION_CONSUMER_ENABLED === 'true', ...transitionConsumer }
  }));
};

export function expireAgentLongTasks(options = {}) {
  return postgresRepository
    ? postgresRepository.expireDueTasks(options).then(async (tasks) => { await consumeAgentRunTransitions(); return tasks.map(publicTask); })
    : expireSqliteTasks(options);
}

export async function consumeAgentRunTransitions({ workerId = `agent-run-transition-${randomUUID()}`, limit = 100 } = {}) {
  if (!postgresRepository) return { driver: 'sqlite', consumed: 0, failed: 0 };
  await postgresRepository.recordHeartbeat({ workerId, mode: 'run_transition_consumer', intervalMs: boundedEnv('AGENT_RUN_TRANSITION_INTERVAL_MS', 5_000, 500, 60_000) });
  const transitions = await postgresRepository.claimRunTransitions({ workerId, limit });
  let consumed = 0;
  let failed = 0;
  for (const transition of transitions) {
    try {
      if (transition.dispatchId || transition.attempt > 0) await recordAgentExecutionFailure(transition.runId, '长任务 Worker 租约已过期；为避免重复端侧操作，任务不会自动重试。');
      else await abortAgentExecution({ runId: transition.runId, roleId: transition.roleId, identityScope: transition.identityScope, status: 'execution_timed_out', reason: '长任务排队或暂停超过允许时间。' });
      if (await postgresRepository.completeRunTransition({ transitionId: transition.id, workerId })) consumed += 1;
    } catch {
      failed += 1;
      await postgresRepository.releaseRunTransition({ transitionId: transition.id, workerId });
    }
  }
  return { driver: 'postgres', claimed: transitions.length, consumed, failed };
}

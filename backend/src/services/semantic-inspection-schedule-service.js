import { randomUUID } from 'node:crypto';
import { mutateSemanticGovernanceState, mutateSemanticGovernanceStates, readSemanticGovernanceState } from './semantic-governance-store.js';
import { semanticOperationsOwnerMatches, semanticOperationsPrincipalKey } from './semantic-operations-identity.js';
import { buildSemanticOperationsNotification, insertSemanticOperationsNotification, SEMANTIC_NOTIFICATION_NAMESPACE } from './semantic-operations-notification-service.js';
import { runWithTenantExecution } from './tenant-execution-context.js';

const NAMESPACE = 'semantic_inspection_schedules';
const KEY = 'index';
const ALLOWED_CHECKS = new Set(['source_readiness', 'schema_integrity', 'deployment_drift', 'mapping_coverage']);
const now = (value = Date.now()) => new Date(value).toISOString();
const readIndex = () => readSemanticGovernanceState(NAMESPACE, KEY, {});
const mutateIndex = (callback) => mutateSemanticGovernanceState(NAMESPACE, KEY, {}, callback);
const nextTime = (intervalMinutes, nowAt = Date.now()) => new Date(nowAt + intervalMinutes * 60_000).toISOString();
const publicSchedule = schedule => { const { lease: _lease, ...safe } = structuredClone(schedule); return safe; };
const ownsLease = (schedule, workerId, token, nowAt) => Boolean(schedule?.status === 'active' && token && schedule.lease?.token === token
  && schedule.lease.workerId === workerId && Date.parse(schedule.lease.expiresAt) > nowAt);

export async function createSemanticInspectionSchedule({ body, role, identityScope }) {
  const checks = [...new Set(Array.isArray(body?.checks) ? body.checks.filter((item) => ALLOWED_CHECKS.has(item)) : [])];
  if (!checks.length) return { error: '请至少选择一项允许的只读语义检查。', code: 'SEMANTIC_INSPECTION_CHECK_REQUIRED' };
  const intervalMinutes = Math.max(15, Math.min(Number(body?.intervalMinutes) || 1440, 10080));
  const createdAt = now();
  const schedule = { id: `semantic-inspection-${randomUUID()}`, owner: semanticOperationsPrincipalKey(identityScope), roleId: role.id, identityScope: { tenantId: identityScope.tenantId, subjectId: identityScope.subjectId, deviceId: identityScope.deviceId || null, platform: identityScope.platform || null }, name: String(body?.name || '语义层日常只读巡检').slice(0, 100), checks, intervalMinutes, status: 'active', createdAt, updatedAt: createdAt, nextRunAt: body?.runNow === false ? nextTime(intervalMinutes) : createdAt, lastRun: null, lease: null };
  await mutateIndex((index) => { index[schedule.id] = schedule; return { value: index }; });
  return { schedule: publicSchedule(schedule) };
}

export async function listSemanticInspectionSchedules({ identityScope }) {
  const index = await readIndex();
  return Object.values(index).filter((item) => semanticOperationsOwnerMatches(item.owner, identityScope)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicSchedule);
}

export async function controlSemanticInspectionSchedule({ id, action, identityScope }) {
  if (!['pause', 'resume', 'cancel', 'run-now'].includes(action)) return { error: '不支持的巡检控制动作。', code: 'SEMANTIC_INSPECTION_ACTION_INVALID' };
  return mutateIndex((index) => {
    const schedule = index[id];
    if (!schedule || !semanticOperationsOwnerMatches(schedule.owner, identityScope)) return { commit: false, result: { error: '未找到当前身份的巡检计划。', code: 'SEMANTIC_INSPECTION_NOT_FOUND' } };
    if (schedule.status === 'cancelled' || (action === 'resume' && schedule.status !== 'paused')) return { commit: false, result: { error: '当前巡检状态不支持此操作；已取消计划需要重新创建。', code: 'SEMANTIC_INSPECTION_STATE_CONFLICT' } };
    if (action === 'cancel') schedule.status = 'cancelled';
    if (action === 'pause') schedule.status = 'paused';
    if (action === 'resume') { schedule.status = 'active'; schedule.nextRunAt = nextTime(schedule.intervalMinutes); }
    if (action === 'run-now') { schedule.status = 'active'; schedule.nextRunAt = now(); }
    schedule.updatedAt = now(); schedule.lease = null; index[id] = schedule;
    return { value: index, result: { schedule: publicSchedule(schedule) } };
  });
}

export async function claimDueSemanticInspection({ workerId, leaseMs = 120000, nowAt = Date.now() } = {}) {
  if (typeof workerId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(workerId)) throw new TypeError('Invalid inspection worker ID.');
  const current = now(nowAt);
  return mutateIndex((index) => {
    const schedule = Object.values(index).filter((item) => item.status === 'active' && item.nextRunAt <= current && (!item.lease || item.lease.expiresAt <= current)).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0];
    if (!schedule) return { commit: false, result: null };
    schedule.lease = { workerId, token: randomUUID(), claimedAt: current, expiresAt: now(nowAt + Math.max(10000, Math.min(Number(leaseMs) || 120000, 300000))) }; schedule.updatedAt = current; index[schedule.id] = schedule;
    return { value: index, result: structuredClone(schedule) };
  });
}

export async function completeSemanticInspection({ id, workerId, leaseToken, result, error = null, nowAt = Date.now() }) {
  // Returning from an executor is not proof that an inspection succeeded.
  if (!error && (!result || !['info', 'warning'].includes(result.severity) || typeof result.summary !== 'string'
    || !result.summary.trim() || result.summary.length > 1000 || !Array.isArray(result.findings) || result.findings.length > 100)) error = 'SEMANTIC_INSPECTION_RESULT_INVALID';
  return mutateSemanticGovernanceStates([
    { name: 'schedules', namespace: NAMESPACE, key: KEY, initialValue: {} },
    { name: 'notifications', namespace: SEMANTIC_NOTIFICATION_NAMESPACE, key: KEY, initialValue: {} }
  ], ({ schedules: index, notifications }) => {
    const schedule = index[id];
    if (!ownsLease(schedule, workerId, leaseToken, nowAt)) return { commit: false, result: null };
    const finishedAt = now(nowAt);
    schedule.lastRun = { finishedAt, status: error ? 'failed' : result?.severity === 'warning' ? 'warning' : 'passed', result: error ? null : result || null, error: error ? 'SEMANTIC_INSPECTION_FAILED' : null };
    schedule.nextRunAt = nextTime(schedule.intervalMinutes, nowAt); schedule.updatedAt = finishedAt; schedule.lease = null; index[id] = schedule;
    if (error || result?.severity === 'warning') insertSemanticOperationsNotification(notifications, buildSemanticOperationsNotification({
      identityScope: schedule.identityScope, severity: error ? 'error' : 'warning', title: error ? '语义巡检执行失败' : '语义巡检发现待处理项',
      message: error ? '巡检未完成，请检查授权和服务状态后重试。' : result.summary,
      sourceType: 'inspection', sourceId: schedule.id, action: { type: 'open_inspection', id: schedule.id }, createdAt: finishedAt
    }));
    return { values: { schedules: index, notifications }, result: publicSchedule(schedule) };
  });
}

export async function runSemanticInspectionCycle({ workerId = `semantic-worker-${process.pid}`, executeInspection, maxRuns = 10 } = {}) {
  if (typeof executeInspection !== 'function') throw new TypeError('A read-only inspection executor is required.');
  maxRuns = Math.max(1, Math.min(Number(maxRuns) || 10, 100));
  let count = 0;
  while (count < maxRuns) {
    const schedule = await claimDueSemanticInspection({ workerId });
    if (!schedule) break;
    const lease = { id: schedule.id, workerId, leaseToken: schedule.lease.token };
    try { await completeSemanticInspection({ ...lease, result: await runWithTenantExecution({ identity: schedule.identityScope, roleId: schedule.roleId, feature: 'semantic', permission: 'page.semantic-operations.view' }, async () => {
      const current = (await readIndex())[schedule.id];
      if (!ownsLease(current, workerId, lease.leaseToken, Date.now())) throw new Error('SEMANTIC_INSPECTION_LEASE_MISMATCH');
      return executeInspection(schedule);
    }) }); }
    catch { await completeSemanticInspection({ ...lease, error: 'SEMANTIC_INSPECTION_FAILED' }); }
    count += 1;
  }
  return { processed: count };
}

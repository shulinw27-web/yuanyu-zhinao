import { randomUUID } from 'node:crypto';
import { mutateSemanticGovernanceState, readSemanticGovernanceState } from './semantic-governance-store.js';
import { semanticOperationsOwnerMatches, semanticOperationsPrincipalKey } from './semantic-operations-identity.js';
import { createSemanticOperationsNotification } from './semantic-operations-notification-service.js';
import { runWithSemanticTenant } from './semantic-tenant-context.js';

const NAMESPACE = 'semantic_inspection_schedules';
const KEY = 'index';
const ALLOWED_CHECKS = new Set(['source_readiness', 'schema_integrity', 'deployment_drift', 'mapping_coverage']);
const now = () => new Date().toISOString();
const readIndex = () => readSemanticGovernanceState(NAMESPACE, KEY, {});
const mutateIndex = (callback) => mutateSemanticGovernanceState(NAMESPACE, KEY, {}, callback);
const nextTime = (intervalMinutes) => new Date(Date.now() + intervalMinutes * 60_000).toISOString();

export async function createSemanticInspectionSchedule({ body, role, identityScope }) {
  const checks = [...new Set(Array.isArray(body?.checks) ? body.checks.filter((item) => ALLOWED_CHECKS.has(item)) : [])];
  if (!checks.length) return { error: '请至少选择一项允许的只读语义检查。', code: 'SEMANTIC_INSPECTION_CHECK_REQUIRED' };
  const intervalMinutes = Math.max(15, Math.min(Number(body?.intervalMinutes) || 1440, 10080));
  const createdAt = now();
  const schedule = { id: `semantic-inspection-${randomUUID()}`, owner: semanticOperationsPrincipalKey(identityScope), roleId: role.id, identityScope: { tenantId: identityScope.tenantId, subjectId: identityScope.subjectId, deviceId: identityScope.deviceId || null, platform: identityScope.platform || null }, name: String(body?.name || '语义层日常只读巡检').slice(0, 100), checks, intervalMinutes, status: 'active', createdAt, updatedAt: createdAt, nextRunAt: body?.runNow === false ? nextTime(intervalMinutes) : createdAt, lastRun: null, lease: null };
  await mutateIndex((index) => { index[schedule.id] = schedule; return { value: index }; });
  return { schedule };
}

export async function listSemanticInspectionSchedules({ identityScope }) {
  const index = await readIndex();
  return Object.values(index).filter((item) => semanticOperationsOwnerMatches(item.owner, identityScope)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function controlSemanticInspectionSchedule({ id, action, identityScope }) {
  if (!['pause', 'resume', 'cancel', 'run-now'].includes(action)) return { error: '不支持的巡检控制动作。', code: 'SEMANTIC_INSPECTION_ACTION_INVALID' };
  return mutateIndex((index) => {
    const schedule = index[id];
    if (!schedule || !semanticOperationsOwnerMatches(schedule.owner, identityScope)) return { commit: false, result: { error: '未找到当前身份的巡检计划。', code: 'SEMANTIC_INSPECTION_NOT_FOUND' } };
    if (action === 'cancel') schedule.status = 'cancelled';
    if (action === 'pause') schedule.status = 'paused';
    if (action === 'resume') { schedule.status = 'active'; schedule.nextRunAt = nextTime(schedule.intervalMinutes); }
    if (action === 'run-now') { schedule.status = 'active'; schedule.nextRunAt = now(); }
    schedule.updatedAt = now(); schedule.lease = null; index[id] = schedule;
    return { value: index, result: { schedule } };
  });
}

export async function claimDueSemanticInspection({ workerId, leaseMs = 120000 } = {}) {
  const current = now();
  return mutateIndex((index) => {
    const schedule = Object.values(index).filter((item) => item.status === 'active' && item.nextRunAt <= current && (!item.lease || item.lease.expiresAt <= current)).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0];
    if (!schedule) return { commit: false, result: null };
    schedule.lease = { workerId, claimedAt: current, expiresAt: new Date(Date.now() + leaseMs).toISOString() }; schedule.updatedAt = current; index[schedule.id] = schedule;
    return { value: index, result: structuredClone(schedule) };
  });
}

export async function completeSemanticInspection({ id, workerId, result, error = null }) {
  const outcome = await mutateIndex((index) => {
    const schedule = index[id];
    if (!schedule || schedule.lease?.workerId !== workerId) return { commit: false, result: null };
    const finishedAt = now();
    schedule.lastRun = { finishedAt, status: error ? 'failed' : result?.severity === 'warning' ? 'warning' : 'passed', result: result || null, error: error ? String(error).slice(0, 500) : null };
    schedule.nextRunAt = nextTime(schedule.intervalMinutes); schedule.updatedAt = finishedAt; schedule.lease = null; index[id] = schedule;
    return { value: index, result: structuredClone(schedule) };
  });
  if (outcome && (error || result?.severity === 'warning')) await createSemanticOperationsNotification({ identityScope: outcome.identityScope, severity: error ? 'error' : 'warning', title: error ? '语义巡检执行失败' : '语义巡检发现待处理项', message: error || result.summary, sourceType: 'inspection', sourceId: outcome.id, action: { type: 'open_inspection', id: outcome.id } });
  return outcome;
}

export async function runSemanticInspectionCycle({ workerId = `semantic-worker-${process.pid}`, executeInspection, maxRuns = 10 } = {}) {
  let count = 0;
  while (count < maxRuns) {
    const schedule = await claimDueSemanticInspection({ workerId });
    if (!schedule) break;
    try { await completeSemanticInspection({ id: schedule.id, workerId, result: await runWithSemanticTenant(schedule.identityScope, () => executeInspection(schedule)) }); }
    catch (error) { await completeSemanticInspection({ id: schedule.id, workerId, error: error.message }); }
    count += 1;
  }
  return { processed: count };
}

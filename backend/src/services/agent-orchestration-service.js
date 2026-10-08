import { createHash, randomUUID } from 'node:crypto';
import { businessIdDomains } from './agent-query-service.js';
import { getRuntimeStoreInfo, listState, mutateState, readState } from '../repositories/runtime-state-repository.js';

const NAMESPACE = 'agent_orchestrations';
const MAX_ORCHESTRATIONS = 50;
const MAX_STEPS = 20;
const MIN_INTERVAL_MINUTES = 15;
let postgresRepository = null;

const routeDefinitions = Object.freeze({
  production: Object.freeze({ id: 'production', name: '生产质量 Agent', tool: 'analyze_production_impact', owner: '生产质量 Agent' }),
  marketing: Object.freeze({ id: 'marketing', name: '市场经营 Agent', tool: 'analyze_market_impact', owner: '市场经营 Agent' }),
  internal: Object.freeze({ id: 'internal', name: '内务协同 Agent', tool: 'review_internal_operations', owner: '内务协同 Agent' }),
  workflow: Object.freeze({ id: 'workflow', name: '流程语义 Agent', tool: 'read_workflow_context', owner: '流程语义 Agent' })
});
const orchestrationAgent = Object.freeze({ id: 'orchestrator', name: '总控编排 Agent', tool: 'route_and_govern' });

// These deterministic routing helpers are also used by the interactive Agent.
// They deliberately classify only; authorization and tool execution remain in
// their dedicated services and are re-evaluated for every turn.
export function routeAgentTask(input) {
  const text = String(input || '').toLowerCase();
  const domains = [];
  const workflowIntent = /(?:流程|审批到哪|审批进度|审批记录|审批历史|谁审批过|流转记录|当前节点|待谁审批|钉钉审批|oa\s*审批|请假|入职|供应商准入|workflow|process\s*instance)/iu.test(text);
  const workflowOnly = workflowIntent && !/(?:影响|分析|风险|核验|原因|处理方案)/u.test(text);
  if (workflowIntent) domains.push('workflow');
  if (!workflowOnly && /(?:生产|质量|检验|原料|批次|设备|库存|告警|报警|风险|lims|qms|mes|wms)/iu.test(text)) domains.push('production');
  if (!workflowOnly && /(?:市场|门店|订单|投诉|渠道|客户|履约|oms|销售)/iu.test(text)) domains.push('marketing');
  if (!workflowOnly && /(?:内务|预算|供应商|合同|采购|审批|财务|erp|oa)/iu.test(text)) domains.push('internal');
  const uniqueDomains = [...new Set([...domains, ...(workflowOnly ? [] : businessIdDomains(input))])];
  return {
    orchestrator: orchestrationAgent,
    primaryDomain: uniqueDomains[0] || null,
    subAgents: uniqueDomains.map((domain) => routeDefinitions[domain]),
    requiresClarification: uniqueDomains.length === 0,
    reason: uniqueDomains.length ? `matched:${uniqueDomains.join(',')}` : 'conversation_or_ambiguous_intent'
  };
}

export function buildAgentPlan({ route, canLaunchProcurement = false, isProcurement = false }) {
  const steps = (route?.subAgents || []).map((agent) => ({ tool: agent.tool, status: '只读分析，等待执行', owner: agent.owner || agent.name }));
  if (isProcurement) {
    steps.push({ tool: 'prepare_procurement', status: '生成不可写入的采购协同方案', owner: '总控编排 Agent' });
    steps.push({ tool: 'launch_procurement', status: canLaunchProcurement ? '具备发起条件，仍需本人确认' : '权限或安全条件不足，不会发起', owner: '受控业务执行层' });
  }
  return steps;
}

export function buildAgentTaskContract({ input, route, isProcurement = false, inheritedMemory = false }) {
  return {
    version: 'task-contract.v1',
    goal: String(input || '').trim().slice(0, 2_000),
    primaryDomain: route?.primaryDomain || null,
    phase: 'planned',
    status: route?.requiresClarification ? 'needs_input' : 'active',
    inheritedMemory: Boolean(inheritedMemory),
    writeRequested: Boolean(isProcurement),
    steps: (route?.subAgents || []).map((agent, index) => ({ id: `analysis-${index + 1}`, label: agent.name, mode: 'read_only', status: 'planned' }))
  };
}

const nowIso = (value = Date.now()) => new Date(value).toISOString();
const clone = (value) => structuredClone(value);
const identityOf = (scope = {}) => ({ tenantId: String(scope.tenantId || '').slice(0, 120), subjectId: String(scope.subjectId || '').slice(0, 180) });
const scopeKey = (scope) => JSON.stringify([scope.tenantId, scope.subjectId]);
const initialWorkspace = () => ({ schemaVersion: 1, orchestrations: {} });
const digest = (value) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
const ownsLease = (item, workerId, token, nowAt) => Boolean(item && ['active', 'running'].includes(item.status)
  && typeof token === 'string' && token && item.lease?.token === token && item.lease.workerId === workerId
  && Date.parse(item.lease.expiresAt) > nowAt);
const leaseMismatch = () => ({ commit: false, result: { error: '当前 Worker 的编排租约已失效。', code: 'AGENT_ORCHESTRATION_LEASE_MISMATCH' } });
const publicOrchestration = (item) => {
  if (!item) return null;
  const safe = clone(item);
  delete safe.lease;
  return safe;
};

export function configureAgentOrchestrationRepository(repository = null) {
  if (repository && typeof repository.mutateState !== 'function') throw new TypeError('Agent orchestration repository does not implement the asynchronous runtime-state port.');
  postgresRepository = repository;
}

export function getAgentOrchestrationStoreInfo() {
  if (postgresRepository) return { driver: 'postgres', persistence: 'durable_distributed', schemaVersion: 3 };
  const runtime = getRuntimeStoreInfo();
  return { driver: runtime.driver, persistence: runtime.persistence, schemaVersion: runtime.schemaVersion };
}

export const probeAgentOrchestrationStore = () => postgresRepository ? postgresRepository.probe() : Promise.resolve({ ready: true });
const readWorkspace = (identity) => postgresRepository ? postgresRepository.readState(NAMESPACE, scopeKey(identity), initialWorkspace) : readState(NAMESPACE, scopeKey(identity), initialWorkspace);
const mutateWorkspace = (identity, callback) => postgresRepository ? postgresRepository.mutateState(NAMESPACE, scopeKey(identity), initialWorkspace, callback) : mutateState(NAMESPACE, scopeKey(identity), initialWorkspace, callback);

const normalizeSchedule = (input, nowAt) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: '任务调度配置无效。', code: 'AGENT_ORCHESTRATION_SCHEDULE_INVALID' };
  if (input.type === 'once') {
    const runAt = Date.parse(input.runAt || '');
    if (!Number.isFinite(runAt) || runAt < nowAt + 60_000 || runAt > nowAt + 365 * 24 * 60 * 60_000) return { error: '单次任务必须安排在 1 分钟到 365 天内。', code: 'AGENT_ORCHESTRATION_SCHEDULE_INVALID' };
    return { type: 'once', runAt: nowIso(runAt), nextRunAt: nowIso(runAt), timezone: String(input.timezone || 'Asia/Shanghai').slice(0, 80) };
  }
  if (input.type === 'interval') {
    const intervalMinutes = Number(input.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < MIN_INTERVAL_MINUTES || intervalMinutes > 30 * 24 * 60) return { error: `循环任务间隔必须为 ${MIN_INTERVAL_MINUTES} 分钟到 30 天。`, code: 'AGENT_ORCHESTRATION_SCHEDULE_INVALID' };
    const startAt = input.startAt ? Date.parse(input.startAt) : nowAt + intervalMinutes * 60_000;
    if (!Number.isFinite(startAt) || startAt < nowAt + 60_000) return { error: '循环任务首次运行时间至少在 1 分钟后。', code: 'AGENT_ORCHESTRATION_SCHEDULE_INVALID' };
    return { type: 'interval', intervalMinutes, startAt: nowIso(startAt), nextRunAt: nowIso(startAt), timezone: String(input.timezone || 'Asia/Shanghai').slice(0, 80) };
  }
  return { error: '仅支持 once 或 interval 调度。', code: 'AGENT_ORCHESTRATION_SCHEDULE_INVALID' };
};

const normalizeSteps = (input) => {
  if (!Array.isArray(input) || !input.length || input.length > MAX_STEPS) return { error: `编排必须包含 1 到 ${MAX_STEPS} 个步骤。`, code: 'AGENT_ORCHESTRATION_STEPS_INVALID' };
  const steps = input.map((step, index) => ({
    id: String(step?.id || `step-${index + 1}`).trim().slice(0, 80),
    title: String(step?.title || '').trim().slice(0, 160),
    mode: ['read', 'analysis', 'proposal'].includes(step?.mode) ? step.mode : 'analysis',
    dependsOn: [...new Set((Array.isArray(step?.dependsOn) ? step.dependsOn : []).map((value) => String(value).trim().slice(0, 80)).filter(Boolean))]
  }));
  if (steps.some((step) => !step.id || !step.title) || new Set(steps.map((step) => step.id)).size !== steps.length) return { error: '步骤标识必须唯一且标题不能为空。', code: 'AGENT_ORCHESTRATION_STEPS_INVALID' };
  const ids = new Set(steps.map((step) => step.id));
  if (steps.some((step) => step.dependsOn.includes(step.id) || step.dependsOn.some((id) => !ids.has(id)))) return { error: '步骤依赖引用无效。', code: 'AGENT_ORCHESTRATION_DEPENDENCY_INVALID' };
  const visiting = new Set(); const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    const step = steps.find((item) => item.id === id);
    if (step.dependsOn.some((dependency) => !visit(dependency))) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  if (steps.some((step) => !visit(step.id))) return { error: '步骤依赖存在循环。', code: 'AGENT_ORCHESTRATION_DEPENDENCY_CYCLE' };
  return { steps };
};

export async function createAgentOrchestration({ identityScope, roleId, title, goal, schedule, steps, nowAt = Date.now() }) {
  const identity = identityOf(identityScope);
  if (!identity.tenantId || !identity.subjectId) return { error: '必须使用已认证身份创建任务编排。', code: 'AGENT_ORCHESTRATION_IDENTITY_REQUIRED' };
  const normalizedSchedule = normalizeSchedule(schedule, nowAt);
  if (normalizedSchedule.error) return normalizedSchedule;
  const normalizedSteps = normalizeSteps(steps);
  if (normalizedSteps.error) return normalizedSteps;
  const createdAt = nowIso(nowAt);
  const item = {
    id: `orchestration-${randomUUID()}`, tenantId: identity.tenantId, subjectId: identity.subjectId, roleId: String(roleId || '').slice(0, 120),
    title: String(title || '智脑定时任务').trim().slice(0, 120), goal: String(goal || '').trim().slice(0, 2_000), status: 'active',
    schedule: normalizedSchedule, steps: normalizedSteps.steps, checkpoints: {}, runCount: 0, lastRunAt: null,
    executionPolicy: { automaticModes: ['read', 'analysis'], proposalRequiresUserConfirmation: true, businessWriteAllowed: false },
    createdAt, updatedAt: createdAt
  };
  if (!item.goal) return { error: '任务目标不能为空。', code: 'AGENT_ORCHESTRATION_GOAL_REQUIRED' };
  return mutateWorkspace(identity, (workspace) => {
    const active = Object.values(workspace.orchestrations).filter((entry) => entry.status !== 'cancelled');
    if (active.length >= MAX_ORCHESTRATIONS) return { commit: false, result: { error: `最多保留 ${MAX_ORCHESTRATIONS} 个任务编排。`, code: 'AGENT_ORCHESTRATION_LIMIT' } };
    workspace.orchestrations[item.id] = item;
    return { value: workspace, result: publicOrchestration(item) };
  });
}

export async function listAgentOrchestrations(identityScope) {
  const identity = identityOf(identityScope);
  if (!identity.tenantId || !identity.subjectId) return [];
  const workspace = await readWorkspace(identity);
  return Object.values(workspace.orchestrations).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicOrchestration);
}

export async function controlAgentOrchestration({ identityScope, orchestrationId, action, nowAt = Date.now() }) {
  const identity = identityOf(identityScope);
  return mutateWorkspace(identity, (workspace) => {
    const item = workspace.orchestrations[orchestrationId];
    if (!item) return { commit: false, result: { error: '未找到当前用户的任务编排。', code: 'AGENT_ORCHESTRATION_NOT_FOUND' } };
    if (!['pause', 'resume', 'cancel'].includes(action)) return { commit: false, result: { error: '不支持该编排控制动作。', code: 'AGENT_ORCHESTRATION_ACTION_INVALID' } };
    if (action === 'resume' && !['paused', 'waiting_confirmation'].includes(item.status)) return { commit: false, result: { error: '只有暂停或等待确认的编排可以恢复。', code: 'AGENT_ORCHESTRATION_STATE_CONFLICT' } };
    if (action === 'pause' && !['active', 'running'].includes(item.status)) return { commit: false, result: { error: '只有活动或运行中的编排可以暂停。', code: 'AGENT_ORCHESTRATION_STATE_CONFLICT' } };
    if (action === 'cancel' && ['cancelled', 'completed'].includes(item.status)) return { commit: false, result: { error: '当前编排状态不允许取消。', code: 'AGENT_ORCHESTRATION_STATE_CONFLICT' } };
    item.status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled';
    item.updatedAt = nowIso(nowAt);
    item.lease = null;
    return { value: workspace, result: publicOrchestration(item) };
  });
}

export async function recordAgentOrchestrationCheckpoint({ identityScope, orchestrationId, workerId, leaseToken, stepId, status, result = null, nowAt = Date.now() }) {
  const identity = identityOf(identityScope);
  return mutateWorkspace(identity, (workspace) => {
    const item = workspace.orchestrations[orchestrationId];
    const step = item?.steps.find((entry) => entry.id === stepId);
    if (!item || !step) return { commit: false, result: { error: '未找到编排或步骤。', code: 'AGENT_ORCHESTRATION_STEP_NOT_FOUND' } };
    if (!ownsLease(item, workerId, leaseToken, nowAt)) return leaseMismatch();
    if (!['running', 'succeeded', 'failed', 'waiting_confirmation'].includes(status)) return { commit: false, result: { error: '检查点状态无效。', code: 'AGENT_ORCHESTRATION_CHECKPOINT_INVALID' } };
    const dependenciesReady = step.dependsOn.every((id) => item.checkpoints[id]?.status === 'succeeded');
    if (!dependenciesReady) return { commit: false, result: { error: '前置步骤尚未完成，不能推进当前步骤。', code: 'AGENT_ORCHESTRATION_DEPENDENCY_PENDING' } };
    if (step.mode === 'proposal' && status === 'succeeded') return { commit: false, result: { error: '提案步骤必须等待用户确认，不能自动标记为成功。', code: 'AGENT_ORCHESTRATION_CONFIRMATION_REQUIRED' } };
    const traceId = typeof result?.traceId === 'string' && /^trace-[a-zA-Z0-9-]{8,120}$/u.test(result.traceId) ? result.traceId : null;
    item.checkpoints[stepId] = {
      status,
      updatedAt: nowIso(nowAt),
      resultDigest: result === null ? null : digest(result),
      resultReference: traceId ? { type: 'agent_evidence_trace', id: traceId } : null,
      rawResultStored: false
    };
    item.updatedAt = nowIso(nowAt);
    return { value: workspace, result: publicOrchestration(item) };
  });
}

export async function claimDueAgentOrchestrations({ workerId, nowAt = Date.now(), leaseMs = 60_000, limit = 20 } = {}) {
  if (typeof workerId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(workerId)) throw new TypeError('Invalid orchestration worker ID.');
  limit = Math.max(1, Math.min(Math.floor(Number(limit) || 20), 100));
  leaseMs = Math.max(10000, Math.min(Number(leaseMs) || 60000, 300000));
  const rows = postgresRepository ? await postgresRepository.listState(NAMESPACE) : listState(NAMESPACE);
  // The repository already returns the full namespace. Truncating it before
  // finding due work permanently starves work behind an inactive prefix.
  const candidates = rows.map(row => {
    const times = Object.values(row.value?.orchestrations || {}).flatMap(item => {
      const expires = Date.parse(item.lease?.expiresAt);
      if (Number.isFinite(expires) && expires <= nowAt) return [expires];
      const due = Date.parse(item.schedule?.nextRunAt);
      return item.status === 'active' && due <= nowAt && !item.lease ? [due] : [];
    });
    return { row, dueAt: times.length ? Math.min(...times) : Infinity };
  }).filter(item => Number.isFinite(item.dueAt)).sort((a, b) => a.dueAt - b.dueAt || a.row.key.localeCompare(b.row.key));
  const claimed = [];
  for (const { row } of candidates) {
    if (claimed.length >= limit) break;
    const identity = { tenantId: row.value?.orchestrations && Object.values(row.value.orchestrations)[0]?.tenantId, subjectId: row.value?.orchestrations && Object.values(row.value.orchestrations)[0]?.subjectId };
    if (!identity.tenantId || !identity.subjectId) continue;
    const outcome = await mutateWorkspace(identity, (workspace) => {
      let expired = false;
      for (const item of Object.values(workspace.orchestrations)) {
        if (item.lease && Date.parse(item.lease.expiresAt) <= nowAt) {
          item.lease = null; item.lastRunStatus = 'failed'; item.lastRunCompletedAt = nowIso(nowAt); item.updatedAt = nowIso(nowAt);
          if (item.status === 'running') item.status = 'failed';
          expired = true;
        }
      }
      const due = Object.values(workspace.orchestrations).filter((item) => item.status === 'active' && Date.parse(item.schedule.nextRunAt) <= nowAt && (!item.lease || Date.parse(item.lease.expiresAt) <= nowAt)).sort((a, b) => a.schedule.nextRunAt.localeCompare(b.schedule.nextRunAt))[0];
      if (!due) return expired ? { value: workspace, result: null } : { commit: false, result: null };
      due.lease = { workerId, token: randomUUID(), claimedAt: nowIso(nowAt), expiresAt: nowIso(nowAt + Math.max(10_000, Math.min(leaseMs, 300_000))) };
      due.runCount += 1; due.lastRunAt = nowIso(nowAt); due.checkpoints = {}; due.updatedAt = nowIso(nowAt);
      if (due.schedule.type === 'once') due.status = 'running';
      else due.schedule.nextRunAt = nowIso(Math.max(nowAt, Date.parse(due.schedule.nextRunAt)) + due.schedule.intervalMinutes * 60_000);
      return { value: workspace, result: { ...publicOrchestration(due), lease: clone(due.lease) } };
    });
    if (outcome) claimed.push(outcome);
  }
  return claimed;
}

export async function finalizeAgentOrchestrationRun({ identityScope, orchestrationId, workerId, leaseToken, outcome, nowAt = Date.now() }) {
  const identity = identityOf(identityScope);
  return mutateWorkspace(identity, (workspace) => {
    const item = workspace.orchestrations[orchestrationId];
    if (!item) return { commit: false, result: { error: '未找到当前用户的任务编排。', code: 'AGENT_ORCHESTRATION_NOT_FOUND' } };
    if (!ownsLease(item, workerId, leaseToken, nowAt)) return leaseMismatch();
    if (!['succeeded', 'failed', 'waiting_confirmation'].includes(outcome)) return { commit: false, result: { error: '编排运行结果无效。', code: 'AGENT_ORCHESTRATION_OUTCOME_INVALID' } };
    if ((outcome === 'succeeded' && !item.steps.every(step => item.checkpoints[step.id]?.status === 'succeeded'))
      || (outcome === 'waiting_confirmation' && !item.steps.some(step => item.checkpoints[step.id]?.status === 'waiting_confirmation'))) {
      return { commit: false, result: { error: '检查点未证明该完成状态。', code: 'AGENT_ORCHESTRATION_OUTCOME_UNVERIFIED' } };
    }
    item.lastRunStatus = outcome;
    item.lastRunCompletedAt = nowIso(nowAt);
    item.lease = null;
    if (outcome === 'waiting_confirmation') item.status = 'waiting_confirmation';
    else if (item.schedule.type === 'once') item.status = outcome === 'succeeded' ? 'completed' : 'failed';
    else item.status = 'active';
    item.updatedAt = nowIso(nowAt);
    return { value: workspace, result: publicOrchestration(item) };
  });
}

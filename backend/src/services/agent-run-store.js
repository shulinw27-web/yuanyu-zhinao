import {
  abortAgentExecution as abortLegacyExecution,
  buildAgentRunRecord,
  cancelAgentRun as cancelLegacyRun,
  claimAgentExecution as claimLegacyExecution,
  createAgentRun as createLegacyRun,
  expirePendingAgentRuns as expireLegacyRuns,
  agentMemoryKey,
  forgetAgentLongTermMemory as forgetLegacyLongTermMemory,
  getAgentLongTermMemory as getLegacyLongTermMemory,
  getAgentMemory as getLegacyMemory,
  getAgentRun as getLegacyRun,
  getAgentRunOriginContext as getLegacyOriginContext,
  getAgentRuns as getLegacyRuns,
  normalizeAgentRunIdentityScope,
  publicAgentRun,
  MAX_MEMORY_PER_ROLE,
  prepareAgentLongTermMemoryMutation,
  purgeExpiredAgentLongTermMemory as purgeLegacyLongTermMemory,
  recordAgentEndpointDispatch as recordLegacyEndpointDispatch,
  recordAgentEndpointReceipt as recordLegacyEndpointReceipt,
  recordAgentExecution as recordLegacyExecution,
  recordAgentExecutionFailure as recordLegacyExecutionFailure,
  rememberAgentLongTermGoal as rememberLegacyLongTermGoal,
  sameAgentRunConfirmationContext,
  sameAgentRunSubject,
  secureAgentConfirmationTokenMatches
} from './agent-runtime-store.js';
import { appendDomainEventToWorkspace, DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace } from '../infrastructure/domain-events/domain-event-outbox.js';
import { getRuntimeStoreInfo, mutateState } from '../repositories/runtime-state-repository.js';
import { configurePort, delegate, describePersistence, getPort, hasPort, RUNTIME_STATE_PORT, PERSISTENCE_PORT_METHODS } from './persistence-port.js';
import { prepareMemoryCorrection } from './agent-memory-review.js';

const RUN_NAMESPACE = 'agent_runs';
const MEMORY_NAMESPACE = 'agent_memories';
const now = () => new Date().toISOString();

// 兼容调用点：历史上名为 configureAgentRunRepository，语义等价于注册运行时状态端口。
export function configureAgentRunRepository(repository = null) {
  return configurePort(RUNTIME_STATE_PORT, repository, { methods: PERSISTENCE_PORT_METHODS[RUNTIME_STATE_PORT] }) ? null : null;
}

export function getAgentRunStoreInfo() {
  return describePersistence(RUNTIME_STATE_PORT, getRuntimeStoreInfo());
}

export const probeAgentRunStore = () => getPort(RUNTIME_STATE_PORT) ? getPort(RUNTIME_STATE_PORT).probe() : Promise.resolve({ ready: true });

export async function correctAgentLongTermMemory(roleIds, identityScope, memoryId, body) {
  const prepared = prepareMemoryCorrection(memoryId, body);
  if (prepared.error) return prepared;
  for (const roleId of [...new Set(Array.isArray(roleIds) ? roleIds : [roleIds])]) {
    const key = agentMemoryKey(roleId, identityScope);
    const result = await delegate(RUNTIME_STATE_PORT, {
      remote: (repository) => repository.mutateState(MEMORY_NAMESPACE, key, [], prepared.mutation),
      local: () => mutateState(MEMORY_NAMESPACE, key, [], prepared.mutation)
    });
    if (result?.code !== 'MEMORY_NOT_FOUND') return result;
  }
  return { error: 'MEMORY_NOT_FOUND', code: 'MEMORY_NOT_FOUND', status: 404 };
}

export function createAgentRun(input) {
  return delegate(RUNTIME_STATE_PORT, {
    remote: (repository) => {
      const { run, confirmationToken } = buildAgentRunRecord(input);
      return repository.writeState(RUN_NAMESPACE, run.id, run).then(() => ({ ...publicAgentRun(run), confirmationToken }));
    },
    local: () => createLegacyRun(input)
  });
}

export const getAgentRun = (runId) => hasPort(RUNTIME_STATE_PORT) ? getPort(RUNTIME_STATE_PORT).readState(RUN_NAMESPACE, runId) : getLegacyRun(runId);

export async function getAgentRuns(roleId, suppliedIdentityScope) {
  if (!hasPort(RUNTIME_STATE_PORT)) return getLegacyRuns(roleId, suppliedIdentityScope);
  const roleIds = [...new Set((Array.isArray(roleId) ? roleId : [roleId]).filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))];
  if (!roleIds.length || !suppliedIdentityScope?.tenantId || !suppliedIdentityScope?.subjectId) return [];
  const identityScope = normalizeAgentRunIdentityScope(roleIds[0], suppliedIdentityScope);
  const allowedRoles = new Set(roleIds);
  const rows = (await getPort(RUNTIME_STATE_PORT).listState(RUN_NAMESPACE))
    .map((row) => row.value)
    .filter((run) => allowedRoles.has(run.roleId) && sameAgentRunSubject(run.identityScope, identityScope))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, 12);
  await expirePendingAgentRuns({ runIds: rows.map((run) => run.id) });
  return (await Promise.all(rows.map((run) => getAgentRun(run.id)))).filter(Boolean).map(publicAgentRun);
}

export function getAgentRunOriginContext(runId, suppliedIdentityScope) {
  if (!hasPort(RUNTIME_STATE_PORT)) return getLegacyOriginContext(runId, suppliedIdentityScope);
  return getAgentRun(runId).then((run) => {
    if (!run) return null;
    const identityScope = normalizeAgentRunIdentityScope(run.roleId, suppliedIdentityScope);
    return sameAgentRunSubject(run.identityScope, identityScope) ? { runId: run.id, roleId: run.roleId, status: run.status } : null;
  });
}

export async function expirePendingAgentRuns({ runIds = null, nowAt = Date.now() } = {}) {
  if (!hasPort(RUNTIME_STATE_PORT)) return expireLegacyRuns({ runIds, nowAt });
  const eligibleIds = Array.isArray(runIds) ? [...new Set(runIds.map((id) => String(id || '').trim()).filter(Boolean))] : (await getPort(RUNTIME_STATE_PORT).listState(RUN_NAMESPACE)).map((row) => row.key);
  let expired = 0;
  for (const runId of eligibleIds) {
    const changed = await getPort(RUNTIME_STATE_PORT).mutateState(RUN_NAMESPACE, runId, null, (run) => {
      const expiresAt = Date.parse(run?.confirmation?.expiresAt || '');
      if (!run || run.status !== 'awaiting_confirmation' || run.confirmation?.status !== 'pending' || !Number.isFinite(expiresAt) || expiresAt > nowAt) return { commit: false, result: false };
      const expiredAt = new Date(nowAt).toISOString();
      run.status = 'confirmation_expired'; run.confirmation.status = 'expired'; run.confirmation.expiredAt = expiredAt; run.updatedAt = expiredAt;
      return { value: run, result: true };
    });
    if (changed) expired += 1;
  }
  return expired;
}

export function claimAgentExecution({ runId, commandId, confirmationToken, roleId, identityScope: suppliedIdentityScope }) {
  if (!hasPort(RUNTIME_STATE_PORT)) return claimLegacyExecution({ runId, commandId, confirmationToken, roleId, identityScope: suppliedIdentityScope });
  const identityScope = normalizeAgentRunIdentityScope(roleId, suppliedIdentityScope);
  return getPort(RUNTIME_STATE_PORT).mutateState(RUN_NAMESPACE, runId, null, (run) => {
    if (!run || run.roleId !== roleId || !sameAgentRunConfirmationContext(run.identityScope, identityScope)) return { commit: false, result: { error: '智脑无法执行该动作：任务不存在、会话或设备不匹配，或当前用户不具备原任务权限。' } };
    if (run.status !== 'awaiting_confirmation' || run.confirmation?.status !== 'pending') return { commit: false, result: { error: '该任务不处于待确认状态，不能执行或重复执行。' } };
    if (!run.proposedCommand?.requiresConfirmation || run.proposedCommand.id !== commandId) return { commit: false, result: { error: '请求动作与原任务生成的待确认动作不一致。' } };
    if (Date.parse(run.confirmation.expiresAt) <= Date.now()) {
      run.status = 'confirmation_expired'; run.confirmation.status = 'expired'; run.confirmation.expiredAt = now(); run.updatedAt = run.confirmation.expiredAt;
      return { value: run, result: { error: '任务确认已过期，请重新发起业务请求。' } };
    }
    if (!secureAgentConfirmationTokenMatches(run.confirmation.tokenHash, confirmationToken)) return { commit: false, result: { error: '任务确认凭据无效。' } };
    run.status = 'executing'; run.confirmation.status = 'consumed'; run.confirmation.consumedAt = now(); run.updatedAt = run.confirmation.consumedAt;
    return { value: run, result: { run } };
  });
}

export function cancelAgentRun(input) {
  if (!hasPort(RUNTIME_STATE_PORT)) return cancelLegacyRun(input);
  const identityScope = normalizeAgentRunIdentityScope(input.roleId, input.identityScope);
  return getPort(RUNTIME_STATE_PORT).mutateState(RUN_NAMESPACE, input.runId, null, (run) => {
    if (!run || run.roleId !== input.roleId || !sameAgentRunConfirmationContext(run.identityScope, identityScope)) return { commit: false, result: { error: '智脑无法取消该动作：任务不存在、会话或设备不匹配，或当前用户不具备原任务权限。' } };
    if (run.status !== 'awaiting_confirmation' || run.confirmation?.status !== 'pending') return { commit: false, result: { error: '该任务不处于待确认状态，无法取消。' } };
    run.status = 'cancelled'; run.confirmation.status = 'cancelled'; run.confirmation.cancelledAt = now(); run.updatedAt = run.confirmation.cancelledAt;
    return { value: run, result: { run: publicAgentRun(run) } };
  });
}

export function abortAgentExecution(input) {
  if (!hasPort(RUNTIME_STATE_PORT)) return abortLegacyExecution(input);
  const identityScope = normalizeAgentRunIdentityScope(input.roleId, input.identityScope);
  return getPort(RUNTIME_STATE_PORT).mutateState(RUN_NAMESPACE, input.runId, null, (run) => {
    if (!run || run.roleId !== input.roleId || !sameAgentRunConfirmationContext(run.identityScope, identityScope)) return { commit: false, result: { error: '智脑无法停止该执行：任务、会话或设备不匹配。', code: 'AGENT_RUN_ABORT_IDENTITY_MISMATCH' } };
    if (run.status !== 'executing' || run.execution?.status === 'dispatched') return { commit: false, result: { error: '任务已经派发或不处于可停止状态。', code: 'AGENT_RUN_NOT_ABORTABLE' } };
    run.status = input.status || 'cancelled'; run.execution = { status: run.status, reason: String(input.reason || '任务已停止。').slice(0, 300) }; run.updatedAt = now();
    return { value: run, result: { run: publicAgentRun(run) } };
  });
}

const mutateRunWithEvent = (runId, mutation) => getPort(RUNTIME_STATE_PORT).mutateStates([
  { name: 'run', namespace: RUN_NAMESPACE, key: runId, initialValue: null },
  { name: 'outbox', namespace: DOMAIN_EVENT_NAMESPACE, key: DOMAIN_EVENT_WORKSPACE_KEY, initialValue: initialDomainEventWorkspace }
], ({ run, outbox }) => {
  const outcome = mutation(run);
  if (outcome.commit === false) return outcome;
  appendDomainEventToWorkspace(outbox, outcome.event);
  return { values: { run: outcome.value, outbox }, result: outcome.result };
});

export function recordAgentExecution(runId, execution) {
  if (!hasPort(RUNTIME_STATE_PORT)) return recordLegacyExecution(runId, execution);
  return mutateRunWithEvent(runId, (run) => {
    if (!run || run.status !== 'executing') return { commit: false, result: null };
    run.status = 'executed'; run.execution = execution; run.updatedAt = now();
    return { value: run, result: publicAgentRun(run), event: { type: 'agent.tool_execution.succeeded', aggregateType: 'AgentRun', aggregateId: run.id, tenantId: run.identityScope.tenantId, correlationId: run.id, actor: { type: 'tool', id: execution?.commandId || run.proposedCommand?.id || 'unknown' }, payload: { commandId: execution?.commandId || null, businessRecordId: execution?.businessRecordId || null, status: execution?.status || 'completed', evidenceTraceId: run.evidenceTraceId || null } } };
  });
}

export function recordAgentEndpointDispatch(runId, dispatch) {
  if (!hasPort(RUNTIME_STATE_PORT)) return recordLegacyEndpointDispatch(runId, dispatch);
  return getPort(RUNTIME_STATE_PORT).mutateState(RUN_NAMESPACE, runId, null, (run) => {
    if (!run || run.status !== 'executing' || run.proposedCommand?.target !== 'desktop') return { commit: false, result: { error: '任务不处于可派发的端侧执行状态。', code: 'DESKTOP_RUN_NOT_DISPATCHABLE' } };
    if (run.proposedCommand.endpointAction?.dispatchId !== dispatch?.dispatchId) return { commit: false, result: { error: '端侧派发与原始任务不一致。', code: 'DESKTOP_DISPATCH_MISMATCH' } };
    run.execution = { mode: 'endpoint', status: 'dispatched', dispatchId: dispatch.dispatchId, toolId: dispatch.toolId, dispatchedAt: now(), expiresAt: dispatch.expiresAt }; run.updatedAt = run.execution.dispatchedAt;
    return { value: run, result: { run } };
  });
}

export function recordAgentEndpointReceipt({ runId, roleId, identityScope: suppliedIdentityScope, commandId, dispatchId, receipt }) {
  if (!hasPort(RUNTIME_STATE_PORT)) return recordLegacyEndpointReceipt({ runId, roleId, identityScope: suppliedIdentityScope, commandId, dispatchId, receipt });
  const identityScope = normalizeAgentRunIdentityScope(roleId, suppliedIdentityScope);
  return getPort(RUNTIME_STATE_PORT).mutateState(RUN_NAMESPACE, runId, null, (run) => {
    if (!run || run.roleId !== roleId || !sameAgentRunConfirmationContext(run.identityScope, identityScope)) return { commit: false, result: { error: '端侧回执与任务用户、会话或设备不匹配。', code: 'DESKTOP_RECEIPT_IDENTITY_MISMATCH' } };
    if (run.status !== 'executing' || run.execution?.status !== 'dispatched') return { commit: false, result: { error: '任务不处于等待端侧回执状态。', code: 'DESKTOP_RECEIPT_RUN_STATE_INVALID' } };
    if (Date.parse(run.execution.expiresAt || '') <= Date.now()) {
      run.status = 'execution_failed'; run.execution = { ...run.execution, status: 'timed_out', completedAt: now(), error: '端侧执行派发已过期，迟到回执不会被接受。' }; run.updatedAt = run.execution.completedAt;
      return { value: run, result: { error: '端侧执行派发已过期，迟到回执不会被接受。', code: 'DESKTOP_RECEIPT_EXPIRED' } };
    }
    if (run.proposedCommand?.id !== commandId || run.proposedCommand?.target !== 'desktop') return { commit: false, result: { error: '端侧回执与原始命令不一致。', code: 'DESKTOP_RECEIPT_COMMAND_MISMATCH' } };
    if (run.execution.dispatchId !== dispatchId || receipt?.dispatchId !== dispatchId) return { commit: false, result: { error: '端侧回执与派发标识不一致。', code: 'DESKTOP_RECEIPT_DISPATCH_MISMATCH' } };
    if (run.execution.toolId !== receipt?.toolId) return { commit: false, result: { error: '端侧回执工具与派发工具不一致。', code: 'DESKTOP_RECEIPT_TOOL_MISMATCH' } };
    const completedAt = now(); const succeeded = receipt.status === 'succeeded'; run.status = succeeded ? 'executed' : 'execution_failed';
    run.execution = { ...run.execution, status: receipt.status, completedAt, ...(succeeded ? { artifact: structuredClone(receipt.artifact) } : { error: String(receipt.error || '端侧执行失败。').slice(0, 500) }) }; run.updatedAt = completedAt;
    return { value: run, result: { run: publicAgentRun(run) } };
  });
}

export function recordAgentExecutionFailure(runId, reason) {
  if (!hasPort(RUNTIME_STATE_PORT)) return recordLegacyExecutionFailure(runId, reason);
  return mutateRunWithEvent(runId, (run) => {
    if (!run || run.status !== 'executing') return { commit: false, result: null };
    run.status = 'execution_failed'; run.execution = { status: 'failed', reason: String(reason || '受控工具执行失败。').slice(0, 180) }; run.updatedAt = now();
    return { value: run, result: publicAgentRun(run), event: { type: 'agent.tool_execution.failed', aggregateType: 'AgentRun', aggregateId: run.id, tenantId: run.identityScope.tenantId, correlationId: run.id, actor: { type: 'tool', id: run.proposedCommand?.id || 'unknown' }, payload: { commandId: run.proposedCommand?.id || null, status: 'failed', reasonCode: 'CONTROLLED_TOOL_EXECUTION_FAILED', evidenceTraceId: run.evidenceTraceId || null } } };
  });
}

export async function purgeExpiredAgentLongTermMemory(roleId, suppliedIdentityScope, nowAt = Date.now()) {
  if (!hasPort(RUNTIME_STATE_PORT)) return purgeLegacyLongTermMemory(roleId, suppliedIdentityScope, nowAt);
  const roleIds = [...new Set((Array.isArray(roleId) ? roleId : [roleId]).filter(Boolean))];
  let removed = 0;
  for (const currentRoleId of roleIds) {
    const identityScope = normalizeAgentRunIdentityScope(currentRoleId, suppliedIdentityScope);
    removed += Number(await getPort(RUNTIME_STATE_PORT).mutateState(MEMORY_NAMESPACE, agentMemoryKey(currentRoleId, identityScope), [], (items) => {
      const active = items.filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > nowAt);
      const removedCount = items.length - active.length;
      return removedCount ? { value: active, result: removedCount } : { commit: false, result: 0 };
    }) || 0);
  }
  return removed;
}

export async function getAgentMemory(roleId, suppliedIdentityScope) {
  if (!hasPort(RUNTIME_STATE_PORT)) return getLegacyMemory(roleId, suppliedIdentityScope);
  const identityScope = normalizeAgentRunIdentityScope(roleId, suppliedIdentityScope);
  await purgeExpiredAgentLongTermMemory(roleId, identityScope);
  const timestamp = Date.now();
  return (await getPort(RUNTIME_STATE_PORT).readState(MEMORY_NAMESPACE, agentMemoryKey(roleId, identityScope), []))
    .filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > timestamp)
    .map((item) => structuredClone(item));
}

export async function getAgentLongTermMemory(roleId, suppliedIdentityScope) {
  if (!hasPort(RUNTIME_STATE_PORT)) return getLegacyLongTermMemory(roleId, suppliedIdentityScope);
  const roleIds = [...new Set((Array.isArray(roleId) ? roleId : [roleId]).filter(Boolean))];
  const memories = await Promise.all(roleIds.map(async (currentRoleId) => (await getAgentMemory(currentRoleId, suppliedIdentityScope)).map((item) => ({ ...item, roleId: currentRoleId }))));
  return memories.flat()
    .sort((left, right) => String(right.lastUsedAt || right.createdAt).localeCompare(String(left.lastUsedAt || left.createdAt)))
    .slice(0, MAX_MEMORY_PER_ROLE);
}

export async function rememberAgentLongTermGoal(input) {
  if (!hasPort(RUNTIME_STATE_PORT)) return rememberLegacyLongTermGoal(input);
  const prepared = prepareAgentLongTermMemoryMutation(input);
  return prepared.error ? prepared : getPort(RUNTIME_STATE_PORT).mutateState(MEMORY_NAMESPACE, prepared.key, [], prepared.mutation);
}

export async function forgetAgentLongTermMemory(roleId, suppliedIdentityScope, memoryId) {
  if (!hasPort(RUNTIME_STATE_PORT)) return forgetLegacyLongTermMemory(roleId, suppliedIdentityScope, memoryId);
  const roleIds = [...new Set((Array.isArray(roleId) ? roleId : [roleId]).filter(Boolean))];
  const targetId = String(memoryId || '').trim();
  if (!targetId) return { error: '缺少需要删除的记忆标识。' };
  for (const currentRoleId of roleIds) {
    const identityScope = normalizeAgentRunIdentityScope(currentRoleId, suppliedIdentityScope);
    const result = await getPort(RUNTIME_STATE_PORT).mutateState(MEMORY_NAMESPACE, agentMemoryKey(currentRoleId, identityScope), [], (items) => {
      const found = items.find((item) => item.id === targetId);
      return found ? { value: items.filter((item) => item.id !== targetId), result: { memory: structuredClone(found) } } : { commit: false, result: null };
    });
    if (result?.memory) return result;
  }
  return { error: '未找到可删除的长期记忆。' };
}

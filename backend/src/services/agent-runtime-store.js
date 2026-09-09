import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createMemoryDecision, normalizeUntrustedText } from './prompt-security-service.js';
import { deleteState, listState, mutateState, readState, writeState } from '../repositories/runtime-state-repository.js';
import { mutateWithDomainEvent } from '../domains/events/domain-event-outbox.js';
import { extractQueryBusinessIds } from './agent-query-service.js';

const MAX_RUNS = 500;
export const MAX_MEMORY_PER_ROLE = 24;
const LONG_TERM_MEMORY_TTL_MS = 90 * 24 * 60 * 60_000;
const DEFAULT_CONFIRMATION_TTL_MS = 10 * 60_000;
const RUN_NAMESPACE = 'agent_runs';
const MEMORY_NAMESPACE = 'agent_memories';

const now = () => new Date().toISOString();
const tokenHash = (value) => createHash('sha256').update(String(value || '')).digest('hex');
const confirmationTtlMs = () => {
  const configured = Number.parseInt(process.env.AGENT_CONFIRMATION_TTL_MS || '', 10);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 30_000), 30 * 60_000) : DEFAULT_CONFIRMATION_TTL_MS;
};

export const publicAgentConfirmation = (confirmation) => confirmation ? {
  status: confirmation.status,
  expiresAt: confirmation.expiresAt,
  consumedAt: confirmation.consumedAt || null,
  cancelledAt: confirmation.cancelledAt || null,
  expiredAt: confirmation.expiredAt || null
} : null;

export const normalizeAgentRunIdentityScope = (roleId, identityScope = {}) => ({
  tenantId: String(identityScope.tenantId || 'demo-enterprise').slice(0, 120),
  subjectId: String(identityScope.subjectId || `role:${roleId}`).slice(0, 180),
  sessionId: identityScope.sessionId ? String(identityScope.sessionId).slice(0, 180) : null,
  deviceId: identityScope.deviceId ? String(identityScope.deviceId).slice(0, 180) : null
});
export const agentMemoryKey = (roleId, identityScope) => JSON.stringify([identityScope.tenantId, identityScope.subjectId, roleId]);
export const sameAgentRunSubject = (left, right) => left.tenantId === right.tenantId && left.subjectId === right.subjectId;
export const sameAgentRunConfirmationContext = (left, right) => sameAgentRunSubject(left, right)
  && left.sessionId === right.sessionId
  && left.deviceId === right.deviceId;

const businessEntityPatterns = [
  { type: 'material_lot', pattern: /RM-(?:[A-Z]+-)?\d{8}/g },
  { type: 'production_batch', pattern: /PB-\d{6}-\d{2}-[A-Z]/g },
  { type: 'finished_goods_batch', pattern: /FG-\d{6}-\d{2}-[A-Z]/g },
  { type: 'sku', pattern: /SKU-[A-Z]+-\d{2}/g },
  { type: 'order', pattern: /ORD-\d{6}-\d{5}/g },
  { type: 'store', pattern: /STORE-[A-Z]{2}-\d{3}/g }
];
const extractBusinessEntities = (value) => businessEntityPatterns.flatMap(({ type, pattern }) => {
  const matches = String(value || '').toUpperCase().match(pattern) || [];
  return [...new Set(matches)].map((id) => ({ type, id }));
});

export const prepareAgentLongTermMemoryMutation = ({ roleId, identityScope: suppliedIdentityScope, runId = null, domain = null, goal, source = 'user_stated_goal', nowAt = Date.now() }) => {
  const identityScope = normalizeAgentRunIdentityScope(roleId, suppliedIdentityScope);
  const decision = createMemoryDecision(goal, { source: 'long_term_memory' });
  if (decision.status !== 'audit_only' || decision.summary.length < 4) return { error: '该内容未通过长期记忆安全校验。', decision };
  const content = normalizeUntrustedText(goal);
  if (content.length > 8000) return { error: '长期目标最多 8000 字符，请拆分任务；不会截断后保存。', decision };
  const createdAt = new Date(nowAt).toISOString();
  return { key: agentMemoryKey(roleId, identityScope), mutation: (roleMemory) => {
    const duplicate = roleMemory.find((item) => (item.content || item.summary) === content && item.domain === domain);
    if (duplicate) {
      duplicate.lastUsedAt = createdAt;
      duplicate.expiresAt = new Date(nowAt + LONG_TERM_MEMORY_TTL_MS).toISOString();
      return { value: roleMemory.slice(0, MAX_MEMORY_PER_ROLE), result: { memory: structuredClone(duplicate), reused: true } };
    }
    const memory = {
      id: `memory-${randomUUID()}`,
      runId,
      domain,
      summary: decision.summary,
      content,
      schemaVersion: 'agent-goal-memory.v2',
      kind: 'goal',
      entities: [...extractBusinessEntities(content), ...extractQueryBusinessIds(content).map((id) => ({ type: 'business_object', id }))].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index),
      source,
      trust: 'user_stated_unverified',
      risk: decision.assessment.riskLevel,
      reusable: true,
      retention: '90_days_or_user_deletion',
      createdAt,
      lastUsedAt: createdAt,
      expiresAt: new Date(nowAt + LONG_TERM_MEMORY_TTL_MS).toISOString()
    };
    roleMemory.unshift(memory);
    return { value: roleMemory.slice(0, MAX_MEMORY_PER_ROLE), result: { memory: structuredClone(memory), reused: false } };
  } };
};

const persistLongTermMemory = (input) => {
  const prepared = prepareAgentLongTermMemoryMutation(input);
  return prepared.error ? prepared : mutateState(MEMORY_NAMESPACE, prepared.key, [], prepared.mutation);
};

export const publicAgentRun = (run) => {
  const { identityScope: _identityScope, ...publicFields } = run;
  const proposedCommand = run.proposedCommand ? {
    id: run.proposedCommand.id,
    target: run.proposedCommand.target || 'server',
    requiresConfirmation: Boolean(run.proposedCommand.requiresConfirmation)
  } : null;
  return { ...structuredClone(publicFields), proposedCommand, confirmation: publicAgentConfirmation(run.confirmation) };
};

export const secureAgentConfirmationTokenMatches = (expectedHash, suppliedToken) => {
  if (!expectedHash || !suppliedToken) return false;
  const suppliedHash = tokenHash(suppliedToken);
  const expected = Buffer.from(expectedHash, 'hex');
  const supplied = Buffer.from(suppliedHash, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
};

const trimRuns = () => {
  const rows = listState(RUN_NAMESPACE).sort((a, b) => String(b.value.createdAt).localeCompare(String(a.value.createdAt)));
  rows.slice(MAX_RUNS).forEach((row) => deleteState(RUN_NAMESPACE, row.key));
};

export function buildAgentRunRecord({ roleId, identityScope: suppliedIdentityScope, input, memoryInput = input, domain, skill, agents, plan, evidence, authorization, businessControl, multimodal, proposedCommand = null, memoryDecision: suppliedMemoryDecision = null, evidenceTraceId = null, readVerification = null }) {
  if (readVerification && readVerification.status !== 'completed' && proposedCommand) throw new Error('Incomplete read verification cannot issue an executable proposal.');
  const createdAt = now();
  const identityScope = normalizeAgentRunIdentityScope(roleId, suppliedIdentityScope);
  const memoryDecision = suppliedMemoryDecision || createMemoryDecision(memoryInput);
  const confirmationToken = proposedCommand?.requiresConfirmation ? randomBytes(32).toString('base64url') : null;
  const confirmation = confirmationToken ? {
    status: 'pending',
    tokenHash: tokenHash(confirmationToken),
    expiresAt: new Date(Date.now() + confirmationTtlMs()).toISOString(),
    consumedAt: null,
    cancelledAt: null,
    expiredAt: null
  } : null;
  const displayInput = memoryDecision.status === 'quarantined'
    ? memoryDecision.summary
    : normalizeUntrustedText(input).slice(0, 1_000);
  const run = {
    id: `run-${randomUUID()}`,
    roleId,
    identityScope,
    input: displayInput,
    domain,
    skill,
    agents,
    plan,
    evidence,
    authorization,
    businessControl,
    multimodal,
    evidenceTraceId,
    proposedCommand: proposedCommand ? {
      id: proposedCommand.id,
      target: proposedCommand.target || 'server',
      requiresConfirmation: Boolean(proposedCommand.requiresConfirmation),
      ...(proposedCommand.targetBinding ? { targetBinding: structuredClone(proposedCommand.targetBinding) } : {}),
      ...(proposedCommand.target === 'desktop' && proposedCommand.endpointAction
        ? { endpointAction: structuredClone(proposedCommand.endpointAction) }
        : {})
    } : null,
    confirmation,
    promptSecurity: { memoryStatus: memoryDecision.status, riskLevel: memoryDecision.assessment.riskLevel, fingerprint: memoryDecision.assessment.fingerprint },
    status: confirmation ? 'awaiting_confirmation' : readVerification ? readVerification.status === 'completed' ? 'analysis_completed' : 'analysis_incomplete' : 'planned',
    ...(readVerification ? { readVerification: structuredClone(readVerification) } : {}),
    createdAt,
    updatedAt: createdAt,
    execution: null
  };
  return { run, confirmationToken };
}

export function createAgentRun(input) {
  const { run, confirmationToken } = buildAgentRunRecord(input);
  writeState(RUN_NAMESPACE, run.id, run);
  trimRuns();
  return { ...publicAgentRun(run), confirmationToken };
}

export function getAgentRuns(roleId, suppliedIdentityScope) {
  const roleIds = [...new Set((Array.isArray(roleId) ? roleId : [roleId])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim()))];
  if (!roleIds.length) return [];
  if (!suppliedIdentityScope?.tenantId || !suppliedIdentityScope?.subjectId) return [];
  const identityScope = normalizeAgentRunIdentityScope(roleIds[0], suppliedIdentityScope);
  const allowedRoleIds = new Set(roleIds);
  const matchingRunIds = listState(RUN_NAMESPACE)
    .map((row) => row.value)
    .filter((run) => allowedRoleIds.has(run.roleId) && sameAgentRunSubject(run.identityScope, identityScope))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 12)
    .map((run) => run.id);
  // A confirmation must not remain visually actionable simply because the
  // user has not tried to execute it after its TTL elapsed. Expiry is a
  // server-side state transition; no downstream business tool is called.
  expirePendingAgentRuns({ runIds: matchingRunIds });
  return matchingRunIds.map((runId) => getAgentRun(runId)).filter(Boolean).map(publicAgentRun);
}

export function getAgentRun(runId) {
  return readState(RUN_NAMESPACE, runId);
}

export function getAgentRunOriginContext(runId, suppliedIdentityScope) {
  const run = readState(RUN_NAMESPACE, runId);
  if (!run) return null;
  const identityScope = normalizeAgentRunIdentityScope(run.roleId, suppliedIdentityScope);
  if (!sameAgentRunSubject(run.identityScope, identityScope)) return null;
  return { runId: run.id, roleId: run.roleId, status: run.status };
}

export function getAgentMemory(roleId, suppliedIdentityScope) {
  const identityScope = normalizeAgentRunIdentityScope(roleId, suppliedIdentityScope);
  purgeExpiredAgentLongTermMemory(roleId, identityScope);
  const timestamp = Date.now();
  return readState(MEMORY_NAMESPACE, agentMemoryKey(roleId, identityScope), [])
    .filter((item) => !item.expiresAt || new Date(item.expiresAt).getTime() > timestamp)
    .map((item) => structuredClone(item));
}

export function rememberAgentLongTermGoal({ roleId, identityScope, goal, domain = null, source = 'user_pinned_task', nowAt = Date.now() }) {
  return persistLongTermMemory({ roleId, identityScope, domain, goal, source, nowAt });
}

export function purgeExpiredAgentLongTermMemory(roleId, suppliedIdentityScope, nowAt = Date.now()) {
  const roleIds = [...new Set((Array.isArray(roleId) ? roleId : [roleId]).filter(Boolean))];
  let removed = 0;
  for (const currentRoleId of roleIds) {
    const identityScope = normalizeAgentRunIdentityScope(currentRoleId, suppliedIdentityScope);
    const result = mutateState(MEMORY_NAMESPACE, agentMemoryKey(currentRoleId, identityScope), [], (items) => {
      const active = items.filter((item) => !item.expiresAt || new Date(item.expiresAt).getTime() > nowAt);
      const removedCount = items.length - active.length;
      if (!removedCount) return { commit: false, result: 0 };
      return { value: active, result: removedCount };
    });
    removed += Number(result || 0);
  }
  return removed;
}

export function getAgentLongTermMemory(roleId, suppliedIdentityScope) {
  const roleIds = [...new Set((Array.isArray(roleId) ? roleId : [roleId]).filter(Boolean))];
  return roleIds.flatMap((currentRoleId) => getAgentMemory(currentRoleId, suppliedIdentityScope).map((item) => ({ ...item, roleId: currentRoleId })))
    .sort((left, right) => String(right.lastUsedAt || right.createdAt).localeCompare(String(left.lastUsedAt || left.createdAt)))
    .slice(0, MAX_MEMORY_PER_ROLE);
}

export function forgetAgentLongTermMemory(roleId, suppliedIdentityScope, memoryId) {
  const roleIds = [...new Set((Array.isArray(roleId) ? roleId : [roleId]).filter(Boolean))];
  const targetId = String(memoryId || '').trim();
  if (!targetId) return { error: '缺少需要删除的记忆标识。' };
  for (const currentRoleId of roleIds) {
    const identityScope = normalizeAgentRunIdentityScope(currentRoleId, suppliedIdentityScope);
    const result = mutateState(MEMORY_NAMESPACE, agentMemoryKey(currentRoleId, identityScope), [], (items) => {
      const found = items.find((item) => item.id === targetId);
      if (!found) return { commit: false, result: null };
      return { value: items.filter((item) => item.id !== targetId), result: { memory: structuredClone(found) } };
    });
    if (result?.memory) return result;
  }
  return { error: '未找到可删除的长期记忆。' };
}

export function expirePendingAgentRuns({ runIds = null, nowAt = Date.now() } = {}) {
  const eligibleIds = Array.isArray(runIds)
    ? [...new Set(runIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : listState(RUN_NAMESPACE).map((row) => row.key);
  let expired = 0;
  eligibleIds.forEach((runId) => {
    const result = mutateState(RUN_NAMESPACE, runId, null, (run) => {
      const expiresAt = new Date(run?.confirmation?.expiresAt || '').getTime();
      if (!run || run.status !== 'awaiting_confirmation' || run.confirmation?.status !== 'pending' || !Number.isFinite(expiresAt) || expiresAt > nowAt) {
        return { commit: false, result: false };
      }
      const expiredAt = new Date(nowAt).toISOString();
      run.status = 'confirmation_expired';
      run.confirmation.status = 'expired';
      run.confirmation.expiredAt = expiredAt;
      run.updatedAt = expiredAt;
      return { value: run, result: true };
    });
    if (result) expired += 1;
  });
  return expired;
}

export function claimAgentExecution({ runId, commandId, confirmationToken, roleId, identityScope: suppliedIdentityScope }) {
  const identityScope = normalizeAgentRunIdentityScope(roleId, suppliedIdentityScope);
  return mutateState(RUN_NAMESPACE, runId, null, (run) => {
    if (!run || run.roleId !== roleId || !sameAgentRunConfirmationContext(run.identityScope, identityScope)) {
      return { commit: false, result: { error: '智脑无法执行该动作：任务不存在、会话或设备不匹配，或当前用户不具备原任务权限。' } };
    }
    if (run.status !== 'awaiting_confirmation' || run.confirmation?.status !== 'pending') {
      return { commit: false, result: { error: '该任务不处于待确认状态，不能执行或重复执行。' } };
    }
    if (!run.proposedCommand?.requiresConfirmation || run.proposedCommand.id !== commandId) {
      return { commit: false, result: { error: '请求动作与原任务生成的待确认动作不一致。' } };
    }
    if (new Date(run.confirmation.expiresAt).getTime() <= Date.now()) {
      run.status = 'confirmation_expired';
      run.confirmation.status = 'expired';
      run.confirmation.expiredAt = now();
      run.updatedAt = run.confirmation.expiredAt;
      return { value: run, result: { error: '任务确认已过期，请重新发起业务请求。' } };
    }
    if (!secureAgentConfirmationTokenMatches(run.confirmation.tokenHash, confirmationToken)) {
      return { commit: false, result: { error: '任务确认凭据无效。' } };
    }
    run.status = 'executing';
    run.confirmation.status = 'consumed';
    run.confirmation.consumedAt = now();
    run.updatedAt = run.confirmation.consumedAt;
    return { value: run, result: { run } };
  });
}

// Cancellation is intentionally less privileged than execution: the same
// authenticated user/session/device may always withdraw an unconfirmed action.
// It never invokes a tool or writes to a connected business system.
export function cancelAgentRun({ runId, roleId, identityScope: suppliedIdentityScope }) {
  const identityScope = normalizeAgentRunIdentityScope(roleId, suppliedIdentityScope);
  return mutateState(RUN_NAMESPACE, runId, null, (run) => {
    if (!run || run.roleId !== roleId || !sameAgentRunConfirmationContext(run.identityScope, identityScope)) {
      return { commit: false, result: { error: '智脑无法取消该动作：任务不存在、会话或设备不匹配，或当前用户不具备原任务权限。' } };
    }
    if (run.status !== 'awaiting_confirmation' || run.confirmation?.status !== 'pending') {
      return { commit: false, result: { error: '该任务不处于待确认状态，无法取消。' } };
    }
    run.status = 'cancelled';
    run.confirmation.status = 'cancelled';
    run.confirmation.cancelledAt = now();
    run.updatedAt = run.confirmation.cancelledAt;
    return { value: run, result: { run: publicAgentRun(run) } };
  });
}

export function abortAgentExecution({ runId, roleId, identityScope: suppliedIdentityScope, status = 'cancelled', reason = '任务已停止。' }) {
  const identityScope = normalizeAgentRunIdentityScope(roleId, suppliedIdentityScope);
  return mutateState(RUN_NAMESPACE, runId, null, (run) => {
    if (!run || run.roleId !== roleId || !sameAgentRunConfirmationContext(run.identityScope, identityScope)) {
      return { commit: false, result: { error: '智脑无法停止该执行：任务、会话或设备不匹配。', code: 'AGENT_RUN_ABORT_IDENTITY_MISMATCH' } };
    }
    if (run.status !== 'executing' || run.execution?.status === 'dispatched') {
      return { commit: false, result: { error: '任务已经派发或不处于可停止状态。', code: 'AGENT_RUN_NOT_ABORTABLE' } };
    }
    run.status = status;
    run.execution = { status, reason: String(reason).slice(0, 300) };
    run.updatedAt = now();
    return { value: run, result: { run: publicAgentRun(run) } };
  });
}

export function recordAgentExecution(runId, execution) {
  return mutateWithDomainEvent({ namespace: RUN_NAMESPACE, key: runId, initialValue: null, mutation: (run) => {
    if (!run || run.status !== 'executing') return { commit: false, result: null };
    run.status = 'executed';
    run.execution = execution;
    run.updatedAt = now();
    return { value: run, result: publicAgentRun(run), event: {
      type: 'agent.tool_execution.succeeded', aggregateType: 'AgentRun', aggregateId: run.id,
      tenantId: run.identityScope.tenantId, correlationId: run.id,
      actor: { type: 'tool', id: execution?.commandId || run.proposedCommand?.id || 'unknown' },
      payload: { commandId: execution?.commandId || null, businessRecordId: execution?.businessRecordId || null, status: execution?.status || 'completed', evidenceTraceId: run.evidenceTraceId || null }
    } };
  } });
}

export function recordAgentEndpointDispatch(runId, dispatch) {
  return mutateState(RUN_NAMESPACE, runId, null, (run) => {
    if (!run || run.status !== 'executing' || run.proposedCommand?.target !== 'desktop') {
      return { commit: false, result: { error: '任务不处于可派发的端侧执行状态。', code: 'DESKTOP_RUN_NOT_DISPATCHABLE' } };
    }
    if (run.proposedCommand.endpointAction?.dispatchId !== dispatch?.dispatchId) {
      return { commit: false, result: { error: '端侧派发与原始任务不一致。', code: 'DESKTOP_DISPATCH_MISMATCH' } };
    }
    run.execution = {
      mode: 'endpoint',
      status: 'dispatched',
      dispatchId: dispatch.dispatchId,
      toolId: dispatch.toolId,
      dispatchedAt: now(),
      expiresAt: dispatch.expiresAt
    };
    run.updatedAt = run.execution.dispatchedAt;
    return { value: run, result: { run } };
  });
}

export function recordAgentEndpointReceipt({ runId, roleId, identityScope: suppliedIdentityScope, commandId, dispatchId, receipt }) {
  const identityScope = normalizeAgentRunIdentityScope(roleId, suppliedIdentityScope);
  return mutateState(RUN_NAMESPACE, runId, null, (run) => {
    if (!run || run.roleId !== roleId || !sameAgentRunConfirmationContext(run.identityScope, identityScope)) {
      return { commit: false, result: { error: '端侧回执与任务用户、会话或设备不匹配。', code: 'DESKTOP_RECEIPT_IDENTITY_MISMATCH' } };
    }
    if (run.status !== 'executing' || run.execution?.status !== 'dispatched') {
      return { commit: false, result: { error: '任务不处于等待端侧回执状态。', code: 'DESKTOP_RECEIPT_RUN_STATE_INVALID' } };
    }
    if (Date.parse(run.execution.expiresAt || '') <= Date.now()) {
      run.status = 'execution_failed';
      run.execution = { ...run.execution, status: 'timed_out', completedAt: now(), error: '端侧执行派发已过期，迟到回执不会被接受。' };
      run.updatedAt = run.execution.completedAt;
      return { value: run, result: { error: '端侧执行派发已过期，迟到回执不会被接受。', code: 'DESKTOP_RECEIPT_EXPIRED' } };
    }
    if (run.proposedCommand?.id !== commandId || run.proposedCommand?.target !== 'desktop') {
      return { commit: false, result: { error: '端侧回执与原始命令不一致。', code: 'DESKTOP_RECEIPT_COMMAND_MISMATCH' } };
    }
    if (run.execution.dispatchId !== dispatchId || receipt?.dispatchId !== dispatchId) {
      return { commit: false, result: { error: '端侧回执与派发标识不一致。', code: 'DESKTOP_RECEIPT_DISPATCH_MISMATCH' } };
    }
    if (run.execution.toolId !== receipt?.toolId) {
      return { commit: false, result: { error: '端侧回执工具与派发工具不一致。', code: 'DESKTOP_RECEIPT_TOOL_MISMATCH' } };
    }
    const completedAt = now();
    const succeeded = receipt.status === 'succeeded';
    run.status = succeeded ? 'executed' : 'execution_failed';
    run.execution = {
      ...run.execution,
      status: receipt.status,
      completedAt,
      ...(succeeded ? { artifact: structuredClone(receipt.artifact) } : { error: String(receipt.error || '端侧执行失败。').slice(0, 500) })
    };
    run.updatedAt = completedAt;
    return { value: run, result: { run: publicAgentRun(run) } };
  });
}

export function recordAgentExecutionFailure(runId, reason) {
  return mutateWithDomainEvent({ namespace: RUN_NAMESPACE, key: runId, initialValue: null, mutation: (run) => {
    if (!run || run.status !== 'executing') return { commit: false, result: null };
    run.status = 'execution_failed';
    run.execution = { status: 'failed', reason: String(reason || '受控工具执行失败。').slice(0, 180) };
    run.updatedAt = now();
    return { value: run, result: publicAgentRun(run), event: {
      type: 'agent.tool_execution.failed', aggregateType: 'AgentRun', aggregateId: run.id,
      tenantId: run.identityScope.tenantId, correlationId: run.id,
      actor: { type: 'tool', id: run.proposedCommand?.id || 'unknown' },
      payload: { commandId: run.proposedCommand?.id || null, status: 'failed', reasonCode: 'CONTROLLED_TOOL_EXECUTION_FAILED', evidenceTraceId: run.evidenceTraceId || null }
    } };
  } });
}

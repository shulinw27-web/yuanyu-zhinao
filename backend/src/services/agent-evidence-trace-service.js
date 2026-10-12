import { createHash, randomUUID } from 'node:crypto';
import { deleteState, getRuntimeStoreInfo, listState, mutateState, readState, writeState } from '../repositories/runtime-state-repository.js';

const TRACE_NAMESPACE = 'agent_evidence_traces';
const RUN_INDEX_NAMESPACE = 'agent_evidence_trace_run_index';
const MAX_TRACES = 500;
const MAX_EVENTS_PER_TRACE = 160;
const MAX_EVIDENCE_PER_EVENT = 120;
let postgresRepository = null;
const traceMutationQueues = new Map();
const traceMutationErrors = new Map();

const now = () => new Date().toISOString();
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const digest = (value) => createHash('sha256').update(String(value || '')).digest('hex');
const clip = (value, length = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length);
const normalizeIdentityScope = (roleId, identityScope = {}) => ({
  tenantId: clip(identityScope.tenantId || 'demo-enterprise', 120),
  subjectId: clip(identityScope.subjectId || `role:${roleId}`, 180),
  sessionId: identityScope.sessionId ? clip(identityScope.sessionId, 180) : null,
  deviceId: identityScope.deviceId ? clip(identityScope.deviceId, 180) : null,
  source: identityScope.source ? clip(identityScope.source, 80) : null
});
const sameSubject = (left, right) => left?.tenantId === right?.tenantId && left?.subjectId === right?.subjectId;
const modelMatches = (trace, expectedModelId, expectedTenantId) => Boolean(trace)
  && (!expectedTenantId || trace.identityScope?.tenantId === expectedTenantId)
  && (expectedModelId === undefined || verifyAgentEvidenceTrace(trace).valid)
  && (expectedModelId && expectedModelId !== 'oa-governance'
    ? trace.modelId === expectedModelId : trace.modelId === undefined || trace.modelId === 'oa-governance');

export function configureAgentEvidenceTraceRepository(repository = null) {
  if (repository && typeof repository.mutateState !== 'function') throw new TypeError('Evidence Trace repository does not implement the asynchronous runtime-state port.');
  postgresRepository = repository;
}

export function getAgentEvidenceTraceStoreInfo() {
  if (postgresRepository) return { driver: 'postgres', persistence: 'durable_distributed', schemaVersion: 3 };
  const runtimeStore = getRuntimeStoreInfo();
  return { driver: runtimeStore.driver, persistence: runtimeStore.persistence, schemaVersion: runtimeStore.schemaVersion };
}

export const probeAgentEvidenceTraceStore = () => postgresRepository ? postgresRepository.probe() : Promise.resolve({ ready: true });

const enqueueTraceMutation = (traceId, operation) => {
  if (!postgresRepository) return operation();
  const previous = traceMutationQueues.get(traceId) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  traceMutationQueues.set(traceId, next);
  next.catch((error) => traceMutationErrors.set(traceId, error));
  next.finally(() => { if (traceMutationQueues.get(traceId) === next) traceMutationQueues.delete(traceId); }).catch(() => {});
  return next;
};

const waitForTraceMutations = async (traceId) => {
  await (traceMutationQueues.get(traceId)?.catch(() => {}) || Promise.resolve());
  const error = traceMutationErrors.get(traceId);
  if (error) {
    traceMutationErrors.delete(traceId);
    throw error;
  }
};

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};
const stableStringify = (value) => JSON.stringify(stableValue(value));

const sanitizeDetails = (value, depth = 0) => {
  if (depth > 5) return '[depth-limited]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return clip(value, 800);
  if (Array.isArray(value)) return value.slice(0, 120).map((item) => sanitizeDetails(item, depth + 1));
  if (typeof value !== 'object') return clip(value, 200);
  const blockedKeys = /password|secret|token|authorization|cookie|api[-_]?key|credential/i;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !blockedKeys.test(key))
    .slice(0, 120)
    .map(([key, item]) => [clip(key, 100), sanitizeDetails(item, depth + 1)]));
};

const evidenceSnapshot = (item, capturedAt) => {
  const normalized = {
    source: clip(item?.source || 'unknown', 180),
    id: clip(item?.id || `evidence-${randomUUID()}`, 220),
    title: clip(item?.title || item?.label || item?.statement || '受控证据', 300),
    statement: clip(item?.statement || item?.excerpt || item?.summary || '', 800) || null,
    classification: clip(item?.classification || 'internal', 80),
    systemId: clip(item?.systemId || item?.connectorId || '', 120) || null,
    version: clip(item?.version || item?.recordVersion || 'snapshot', 120),
    capturedAt: item?.capturedAt || item?.retrievedAt || capturedAt,
    organizationId: clip(item?.organizationId || item?.ownerOrgId || '', 160) || null,
    locator: item?.locator ? sanitizeDetails(item.locator) : null,
    confidence: clip(item?.confidence || '', 80) || null
  };
  return { ...normalized, contentHash: digest(stableStringify(normalized)) };
};

export function normalizeEvidenceSnapshots(items = [], capturedAt = now()) {
  return (Array.isArray(items) ? items : []).slice(0, MAX_EVIDENCE_PER_EVENT).map((item) => evidenceSnapshot(item, capturedAt));
}

const eventPayload = (traceId, sequence, event, previousHash, createdAt) => ({
  ...(event.idempotencyKey ? { idempotencyKey: clip(event.idempotencyKey, 120) } : {}),
  id: `trace-event-${randomUUID()}`,
  traceId,
  sequence,
  type: clip(event.type || 'unknown', 100),
  stage: clip(event.stage || event.type || 'unknown', 100),
  status: clip(event.status || 'recorded', 80),
  actor: sanitizeDetails(event.actor || { type: 'system', id: 'zhinao' }),
  summary: clip(event.summary || event.type || '证据事件', 800),
  details: sanitizeDetails(event.details || {}),
  evidence: normalizeEvidenceSnapshots(event.evidence || [], createdAt),
  createdAt,
  previousHash: previousHash || null
});

const calculateEventHash = (event) => digest(stableStringify(event));
const manifestPayload = (trace) => ({
  id: trace.id,
  ...(trace.modelId !== undefined ? { modelId: trace.modelId } : {}),
  kind: trace.kind,
  runId: trace.runId,
  requestId: trace.requestId,
  roleId: trace.roleId,
  tenantId: trace.identityScope?.tenantId,
  subjectFingerprint: digest(trace.identityScope?.subjectId || '').slice(0, 20),
  platform: trace.platform,
  domain: trace.domain,
  inputFingerprint: trace.inputFingerprint,
  inputLength: trace.inputLength,
  status: trace.status,
  eventCount: trace.eventCount,
  headHash: trace.headHash,
  createdAt: trace.createdAt,
  updatedAt: trace.updatedAt,
  completedAt: trace.completedAt
});
const refreshManifestHash = (trace) => {
  trace.manifestHash = digest(stableStringify(manifestPayload(trace)));
  return trace;
};

export function verifyAgentEvidenceTrace(trace) {
  if (!trace || !Array.isArray(trace.events)) return { valid: false, checkedEvents: 0, reason: 'TRACE_NOT_FOUND' };
  let previousHash = null;
  for (let index = 0; index < trace.events.length; index += 1) {
    const event = trace.events[index];
    const { hash, ...payload } = event;
    if (event.sequence !== index + 1 || event.previousHash !== previousHash || calculateEventHash(payload) !== hash) {
      return { valid: false, checkedEvents: index, failedSequence: index + 1, reason: 'HASH_CHAIN_MISMATCH' };
    }
    previousHash = hash;
  }
  if ((trace.headHash || null) !== previousHash) {
    return { valid: false, checkedEvents: trace.events.length, reason: 'HEAD_HASH_MISMATCH' };
  }
  if (trace.manifestHash !== digest(stableStringify(manifestPayload(trace)))) {
    return { valid: false, checkedEvents: trace.events.length, reason: 'MANIFEST_HASH_MISMATCH' };
  }
  return { valid: true, checkedEvents: trace.events.length, algorithm: 'SHA-256', headHash: previousHash, manifestHash: trace.manifestHash };
}

const publicTrace = (trace) => {
  if (!trace) return null;
  const { identityScope, ...fields } = trace;
  return {
    ...clone(fields),
    subjectFingerprint: digest(`${identityScope.tenantId}:${identityScope.subjectId}`).slice(0, 20),
    integrity: verifyAgentEvidenceTrace(trace)
  };
};

const trimTraces = async (created) => {
  const traces = (postgresRepository ? await postgresRepository.listState(TRACE_NAMESPACE) : listState(TRACE_NAMESPACE))
    .filter(row => created.modelId !== undefined
      ? row.value.modelId === created.modelId && row.value.identityScope?.tenantId === created.identityScope.tenantId
      : row.value.modelId === undefined)
    .sort((a, b) => String(b.value.createdAt).localeCompare(String(a.value.createdAt)));
  for (const row of traces.slice(MAX_TRACES)) {
    if (row.value.runId) {
      if (postgresRepository) await postgresRepository.deleteState(RUN_INDEX_NAMESPACE, row.value.runId);
      else deleteState(RUN_INDEX_NAMESPACE, row.value.runId);
    }
    if (postgresRepository) await postgresRepository.deleteState(TRACE_NAMESPACE, row.key);
    else deleteState(TRACE_NAMESPACE, row.key);
  }
};

export async function createAgentEvidenceTrace({ roleId, identityScope: suppliedIdentityScope, input, requestId = null, platform = null, kind = 'agent_task', modelId, reservedTraceId }) {
  if (modelId !== undefined && (kind !== 'semantic_operations_task' || typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId))) throw new Error('EVIDENCE_MODEL_BINDING_INVALID');
  if (reservedTraceId !== undefined && (kind !== 'semantic_operations_task' || !modelId || typeof reservedTraceId !== 'string' || !/^trace-[A-Za-z0-9-]{1,120}$/u.test(reservedTraceId))) throw new Error('EVIDENCE_TRACE_ID_INVALID');
  const createdAt = now();
  const identityScope = normalizeIdentityScope(roleId, suppliedIdentityScope);
  const inputText = String(input || '');
  const trace = {
    id: reservedTraceId || `trace-${randomUUID()}`,
    ...(modelId !== undefined ? { modelId } : {}),
    kind: clip(kind, 80),
    runId: null,
    requestId: requestId ? clip(requestId, 120) : null,
    roleId: clip(roleId, 100),
    identityScope,
    platform: clip(platform || suppliedIdentityScope?.platform || 'unknown', 80),
    domain: null,
    inputFingerprint: digest(inputText),
    inputLength: inputText.length,
    status: 'started',
    eventCount: 0,
    headHash: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    events: []
  };
  const first = eventPayload(trace.id, 1, {
    type: 'task_received',
    stage: 'request',
    status: 'accepted',
    actor: { type: 'user', roleId: trace.roleId, subjectFingerprint: digest(identityScope.subjectId).slice(0, 20) },
    summary: '智脑已接收任务并创建独立证据追踪。',
    details: { inputFingerprint: trace.inputFingerprint, inputLength: trace.inputLength, requestId: trace.requestId, platform: trace.platform }
  }, null, createdAt);
  trace.events = [{ ...first, hash: calculateEventHash(first) }]; trace.eventCount = 1; trace.headHash = trace.events[0].hash;
  const insert = existing => {
    if (!existing) return { value: refreshManifestHash(trace), result: clone(trace) };
    if (!modelMatches(existing, modelId) || !sameSubject(existing.identityScope, identityScope) || existing.roleId !== trace.roleId
      || existing.requestId !== trace.requestId || existing.inputFingerprint !== trace.inputFingerprint) throw new Error('EVIDENCE_TRACE_ID_CONFLICT');
    return { commit: false, result: clone(existing) };
  };
  const saved = postgresRepository ? await postgresRepository.mutateState(TRACE_NAMESPACE, trace.id, null, insert) : mutateState(TRACE_NAMESPACE, trace.id, null, insert);
  await trimTraces(saved);
  return saved;
}

export async function appendAgentEvidenceEvent(traceId, event, { expectedModelId, expectedTenantId } = {}) {
  const mutation = (trace) => {
    if (!modelMatches(trace, expectedModelId, expectedTenantId)) return { commit: false, result: null };
    if (event.idempotencyKey) {
      const previous = trace.events.find(item => item.idempotencyKey === clip(event.idempotencyKey, 120));
      if (previous) {
        if (previous.type !== clip(event.type || 'unknown', 100) || previous.summary !== clip(event.summary || event.type || '证据事件', 800)
          || stableStringify(previous.details) !== stableStringify(sanitizeDetails(event.details || {}))) throw new Error('EVIDENCE_EVENT_ID_CONFLICT');
        return { commit: false, result: clone(previous) };
      }
    }
    const createdAt = now();
    const sequence = trace.events.length + 1;
    if (sequence > MAX_EVENTS_PER_TRACE) {
      return { commit: false, result: { error: '证据追踪事件已达到单任务上限。' } };
    }
    const payload = eventPayload(trace.id, sequence, event, trace.headHash, createdAt);
    const storedEvent = { ...payload, hash: calculateEventHash(payload) };
    trace.events.push(storedEvent);
    trace.eventCount = trace.events.length;
    trace.headHash = storedEvent.hash;
    trace.updatedAt = createdAt;
    refreshManifestHash(trace);
    return { value: trace, result: clone(storedEvent) };
  };
  return enqueueTraceMutation(traceId, () => postgresRepository
    ? postgresRepository.mutateState(TRACE_NAMESPACE, traceId, null, mutation)
    : mutateState(TRACE_NAMESPACE, traceId, null, mutation));
}

export async function bindAgentEvidenceTraceRun(traceId, { runId, roleId, domain }) {
  const mutateTrace = (trace) => {
    // Non-default model run indexes are not supported by the legacy global index.
    if (!modelMatches(trace)) return { commit: false, result: null };
    trace.runId = clip(runId, 180);
    trace.roleId = clip(roleId || trace.roleId, 100);
    trace.domain = clip(domain || trace.domain || 'unknown', 100);
    trace.updatedAt = now();
    refreshManifestHash(trace);
    return { value: trace, result: publicTrace(trace) };
  };
  if (postgresRepository) {
    return enqueueTraceMutation(traceId, () => postgresRepository.mutateStates([
      { name: 'trace', namespace: TRACE_NAMESPACE, key: traceId, initialValue: null },
      { name: 'index', namespace: RUN_INDEX_NAMESPACE, key: runId, initialValue: null }
    ], ({ trace, index }) => {
      if (index && index !== traceId) return { commit: false, result: { error: '该 Agent Run 已绑定其他 Evidence Trace。', code: 'EVIDENCE_RUN_INDEX_CONFLICT', traceId: index } };
      const outcome = mutateTrace(trace);
      if (outcome.commit === false) return outcome;
      return { values: { trace: outcome.value, index: traceId }, result: outcome.result };
    }));
  }
  const existingTraceId = readState(RUN_INDEX_NAMESPACE, runId);
  if (existingTraceId && existingTraceId !== traceId) return { error: '该 Agent Run 已绑定其他 Evidence Trace。', code: 'EVIDENCE_RUN_INDEX_CONFLICT', traceId: existingTraceId };
  const result = mutateState(TRACE_NAMESPACE, traceId, null, mutateTrace);
  if (result?.runId) writeState(RUN_INDEX_NAMESPACE, result.runId, traceId);
  return result;
}

export async function setAgentEvidenceTraceStatus(traceId, status, { completed = false, expectedModelId, expectedTenantId } = {}) {
  const mutation = (trace) => {
    if (!modelMatches(trace, expectedModelId, expectedTenantId)) return { commit: false, result: null };
    trace.status = clip(status, 80);
    trace.updatedAt = now();
    if (completed) trace.completedAt = trace.updatedAt;
    refreshManifestHash(trace);
    return { value: trace, result: publicTrace(trace) };
  };
  return enqueueTraceMutation(traceId, () => postgresRepository
    ? postgresRepository.mutateState(TRACE_NAMESPACE, traceId, null, mutation)
    : mutateState(TRACE_NAMESPACE, traceId, null, mutation));
}

export async function getAgentEvidenceTraceInternal(traceId, { expectedModelId } = {}) {
  await waitForTraceMutations(traceId);
  const trace = postgresRepository ? await postgresRepository.readState(TRACE_NAMESPACE, traceId) : readState(TRACE_NAMESPACE, traceId);
  return modelMatches(trace, expectedModelId) ? trace : null;
}

export async function getAgentEvidenceTraceByRunIdInternal(runId) {
  const traceId = postgresRepository ? await postgresRepository.readState(RUN_INDEX_NAMESPACE, runId) : readState(RUN_INDEX_NAMESPACE, runId);
  return traceId ? getAgentEvidenceTraceInternal(traceId) : null;
}

export async function getAgentEvidenceTrace(traceId, roleIds, suppliedIdentityScope, { expectedModelId } = {}) {
  const allowedRoleIds = new Set((Array.isArray(roleIds) ? roleIds : [roleIds]).filter(Boolean));
  if (!allowedRoleIds.size || !suppliedIdentityScope?.tenantId || !suppliedIdentityScope?.subjectId) return null;
  const trace = await getAgentEvidenceTraceInternal(traceId, { expectedModelId });
  const identityScope = normalizeIdentityScope([...allowedRoleIds][0], suppliedIdentityScope);
  if (!trace || !allowedRoleIds.has(trace.roleId) || !sameSubject(trace.identityScope, identityScope)) return null;
  return publicTrace(trace);
}

export async function getAgentEvidenceTraceByRunId(runId, roleIds, suppliedIdentityScope) {
  const trace = await getAgentEvidenceTraceByRunIdInternal(runId);
  return trace ? getAgentEvidenceTrace(trace.id, roleIds, suppliedIdentityScope) : null;
}

export async function listAgentEvidenceTraces(roleIds, suppliedIdentityScope, limit = 20) {
  const allowedRoleIds = new Set((Array.isArray(roleIds) ? roleIds : [roleIds]).filter(Boolean));
  if (!allowedRoleIds.size || !suppliedIdentityScope?.tenantId || !suppliedIdentityScope?.subjectId) return [];
  const identityScope = normalizeIdentityScope([...allowedRoleIds][0], suppliedIdentityScope);
  const rows = postgresRepository ? await postgresRepository.listState(TRACE_NAMESPACE) : listState(TRACE_NAMESPACE);
  return rows
    .map((row) => row.value)
    .filter((trace) => modelMatches(trace) && allowedRoleIds.has(trace.roleId) && sameSubject(trace.identityScope, identityScope))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.min(Math.max(Number(limit) || 20, 1), 100))
    .map(publicTrace);
}

export async function ensureAgentEvidenceTraceForRun(run, suppliedIdentityScope) {
  if (!run?.id || !run?.roleId) return null;
  const existing = await getAgentEvidenceTraceByRunIdInternal(run.id);
  if (existing) return publicTrace(existing);
  const identityScope = {
    ...suppliedIdentityScope,
    tenantId: suppliedIdentityScope?.tenantId || 'demo-enterprise',
    subjectId: suppliedIdentityScope?.subjectId || `role:${run.roleId}`
  };
  const created = await createAgentEvidenceTrace({
    roleId: run.roleId,
    identityScope,
    input: run.input || '',
    requestId: null,
    platform: 'legacy-migration',
    kind: 'legacy_run_backfill'
  });
  const binding = await bindAgentEvidenceTraceRun(created.id, { runId: run.id, roleId: run.roleId, domain: run.domain });
  if (binding?.code === 'EVIDENCE_RUN_INDEX_CONFLICT') {
    if (postgresRepository) await postgresRepository.deleteState(TRACE_NAMESPACE, created.id);
    else deleteState(TRACE_NAMESPACE, created.id);
    const winner = await getAgentEvidenceTraceInternal(binding.traceId);
    return winner ? publicTrace(winner) : null;
  }
  await appendAgentEvidenceEvent(created.id, {
    type: 'legacy_run_imported', stage: 'migration', status: 'backfilled', actor: { type: 'service', id: 'evidence-trace-migration' },
    summary: '该任务创建于 Evidence Trace 上线前；已依据持久化 Run 回填可验证迁移记录，不伪造原始细粒度时间线。',
    details: { originalCreatedAt: run.createdAt, originalUpdatedAt: run.updatedAt, runStatus: run.status, skill: run.skill, authorization: { decision: run.authorization?.decision, grantedDomains: run.authorization?.grantedDomains }, plan: run.plan },
    evidence: run.evidence || []
  });
  if (run.execution) await appendAgentEvidenceEvent(created.id, {
    type: 'legacy_execution_receipt_imported', stage: 'migration', status: run.execution.status || run.status, actor: { type: 'service', id: 'evidence-trace-migration' },
    summary: '已从旧 Run 导入受控执行回执。', details: { execution: run.execution }
  });
  const pending = run.status === 'awaiting_confirmation';
  await appendAgentEvidenceEvent(created.id, {
    type: pending ? 'confirmation_state_imported' : 'migration_completed', stage: 'migration', status: pending ? 'pending' : 'completed', actor: { type: 'service', id: 'evidence-trace-migration' },
    summary: pending ? '旧 Run 的待确认状态已关联到迁移追踪。' : '旧 Run 的可用证据与状态迁移完成。',
    details: { runId: run.id, runStatus: run.status, confirmation: run.confirmation }
  });
  await setAgentEvidenceTraceStatus(created.id, pending ? 'awaiting_confirmation' : (run.status || 'backfilled'), { completed: !pending });
  return publicTrace(await getAgentEvidenceTraceInternal(created.id));
}

export async function createDeniedAgentExecutionTrace({ roleId, identityScope, runId, commandId, reason, requestId = null }) {
  const trace = await createAgentEvidenceTrace({
    roleId,
    identityScope,
    input: `execution:${runId || 'unknown'}:${commandId || 'unknown'}`,
    requestId,
    kind: 'agent_execution_attempt'
  });
  await appendAgentEvidenceEvent(trace.id, {
    type: 'execution_denied',
    stage: 'authorization',
    status: 'denied',
    actor: { type: 'user', roleId },
    summary: '执行请求在进入工具层前被拒绝，未产生业务写入。',
    details: { referencedRunFingerprint: digest(runId || '').slice(0, 24), commandId: clip(commandId || 'unknown', 120), reason: clip(reason, 500) }
  });
  await setAgentEvidenceTraceStatus(trace.id, 'denied', { completed: true });
  return publicTrace(await getAgentEvidenceTraceInternal(trace.id));
}

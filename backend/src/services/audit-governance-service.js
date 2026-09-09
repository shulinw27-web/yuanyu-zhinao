import { createHash, randomUUID } from 'node:crypto';
import { listState, mutateState, readState, writeState } from '../repositories/runtime-state-repository.js';
import { getAgentEvidenceTraceInternal, verifyAgentEvidenceTrace } from './agent-evidence-trace-service.js';
import { evaluateSecurityDetectionRules } from './security-detection-service.js';

const REQUEST_NAMESPACE = 'agent_audit_export_requests';
const MAX_EXPORT_TRACES = 50;
const clip = (value, length = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length);
const digest = (value) => createHash('sha256').update(String(value || '')).digest('hex');
const fingerprint = (identity = {}) => digest(`${identity.tenantId || 'unknown'}:${identity.subjectId || 'unknown'}`).slice(0, 24);
const publicRequest = (request) => request ? structuredClone(request) : null;

export async function createAuditExportRequest({ traceIds, justification, requesterRoleId, identityScope }) {
  const ids = [...new Set((Array.isArray(traceIds) ? traceIds : []).map((item) => clip(item, 180)).filter(Boolean))];
  if (!identityScope?.tenantId || !identityScope?.subjectId) return { error: '审计导出需要已认证主体。', code: 'AUDIT_EXPORT_IDENTITY_REQUIRED' };
  if (!ids.length || ids.length > MAX_EXPORT_TRACES) return { error: `单次审计导出必须包含 1 到 ${MAX_EXPORT_TRACES} 条追踪。`, code: 'AUDIT_EXPORT_BATCH_INVALID' };
  if (clip(justification, 500).length < 8) return { error: '请提供至少 8 个字符的审计导出理由。', code: 'AUDIT_EXPORT_JUSTIFICATION_REQUIRED' };
  const traces = await Promise.all(ids.map((id) => getAgentEvidenceTraceInternal(id)));
  if (traces.some((trace) => !trace || trace.identityScope?.tenantId !== identityScope.tenantId)) return { error: '导出范围包含不存在或跨租户的追踪。', code: 'AUDIT_EXPORT_SCOPE_DENIED' };
  const createdAt = new Date().toISOString();
  const request = { id: `audit-export-${randomUUID()}`, status: 'pending_approval', traceIds: ids, traceCount: ids.length, justification: clip(justification, 500), tenantId: clip(identityScope.tenantId, 120), requesterRoleId: clip(requesterRoleId, 100), requesterFingerprint: fingerprint(identityScope), createdAt, approvedAt: null, approverFingerprint: null, downloadedAt: null, exportHash: null };
  writeState(REQUEST_NAMESPACE, request.id, request);
  return { request: publicRequest(request), policy: { fourEyes: true, maxTraces: MAX_EXPORT_TRACES, watermarkRequired: true } };
}

export function approveAuditExportRequest({ requestId, approverRoleId, identityScope }) {
  return mutateState(REQUEST_NAMESPACE, clip(requestId, 180), null, (request) => {
    if (!request) return { commit: false, result: { error: '未找到审计导出申请。', code: 'AUDIT_EXPORT_NOT_FOUND' } };
    if (request.tenantId !== identityScope?.tenantId) return { commit: false, result: { error: '不能审批其他租户的导出申请。', code: 'AUDIT_EXPORT_SCOPE_DENIED' } };
    const approverFingerprint = fingerprint(identityScope);
    if (approverFingerprint === request.requesterFingerprint) return { commit: false, result: { error: '审计导出必须由另一名授权主体审批。', code: 'AUDIT_EXPORT_FOUR_EYES_REQUIRED' } };
    if (request.status !== 'pending_approval') return { commit: false, result: { error: '该导出申请不处于待审批状态。', code: 'AUDIT_EXPORT_STATE_CONFLICT' } };
    const next = { ...request, status: 'approved', approvedAt: new Date().toISOString(), approverRoleId: clip(approverRoleId, 100), approverFingerprint };
    return { value: next, result: { request: publicRequest(next) } };
  });
}

export async function generateApprovedAuditExport({ requestId, identityScope }) {
  const request = readState(REQUEST_NAMESPACE, clip(requestId, 180));
  if (!request || request.tenantId !== identityScope?.tenantId) return { error: '未找到可访问的审计导出申请。', code: 'AUDIT_EXPORT_NOT_FOUND' };
  if (request.status !== 'approved' && request.status !== 'downloaded') return { error: '审计导出尚未通过双人审批。', code: 'AUDIT_EXPORT_NOT_APPROVED' };
  const traces = (await Promise.all(request.traceIds.map((id) => getAgentEvidenceTraceInternal(id)))).map((trace) => {
    const { identityScope: _identityScope, ...safe } = trace;
    return { ...structuredClone(safe), subjectFingerprint: digest(`${trace.identityScope.tenantId}:${trace.identityScope.subjectId}`).slice(0, 20), integrity: verifyAgentEvidenceTrace(trace) };
  });
  const generatedAt = new Date().toISOString();
  const watermark = { exportRequestId: request.id, tenantId: request.tenantId, requesterFingerprint: request.requesterFingerprint, approverFingerprint: request.approverFingerprint, generatedAt, classification: 'restricted-audit-export', notice: '仅限获批审计目的使用；禁止转发和二次分发。' };
  const payload = { schemaVersion: 'agent-audit-export.v1', watermark, traceCount: traces.length, traces };
  const exportHash = digest(JSON.stringify(payload));
  mutateState(REQUEST_NAMESPACE, request.id, null, (current) => ({ value: { ...current, status: 'downloaded', downloadedAt: generatedAt, exportHash }, result: null }));
  return { ...payload, exportHash };
}

export function listAuditExportRequests(identityScope) {
  return listState(REQUEST_NAMESPACE).map((row) => row.value).filter((request) => request.tenantId === identityScope?.tenantId).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, 100).map(publicRequest);
}

export async function runAuditIntegrityInspection() {
  const rows = listState('agent_evidence_traces');
  const results = await Promise.all(rows.map(async (row) => {
    const trace = await getAgentEvidenceTraceInternal(row.key);
    return { traceId: row.key, ...verifyAgentEvidenceTrace(trace) };
  }));
  const invalid = results.filter((item) => !item.valid);
  return { inspectedAt: new Date().toISOString(), total: results.length, valid: results.length - invalid.length, invalid: invalid.length, status: invalid.length ? 'failed' : 'passed', failures: invalid.slice(0, 100), detection: evaluateSecurityDetectionRules() };
}

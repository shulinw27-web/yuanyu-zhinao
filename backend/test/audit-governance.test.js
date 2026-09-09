import test from 'node:test';
import assert from 'node:assert/strict';
import { appendAgentEvidenceEvent, createAgentEvidenceTrace, setAgentEvidenceTraceStatus } from '../src/services/agent-evidence-trace-service.js';
import { approveAuditExportRequest, createAuditExportRequest, generateApprovedAuditExport, runAuditIntegrityInspection } from '../src/services/audit-governance-service.js';
import { evaluateSecurityDetectionRules } from '../src/services/security-detection-service.js';
import { recordAgentSecurityEvent } from '../src/services/agent-security-audit-service.js';

const requester = { tenantId: 'tenant-audit', subjectId: 'audit-requester' };
const approver = { tenantId: 'tenant-audit', subjectId: 'audit-approver' };

test('audit export requires bounded scope, justification and four-eyes approval before generating a watermarked payload', async () => {
  const trace = await createAgentEvidenceTrace({ roleId: 'executive', identityScope: requester, input: '审计测试任务' });
  await appendAgentEvidenceEvent(trace.id, { type: 'test', status: 'completed', summary: '受控审计事件。' });
  await setAgentEvidenceTraceStatus(trace.id, 'completed', { completed: true });
  const created = await createAuditExportRequest({ traceIds: [trace.id], justification: '用于季度 Agent 权限审计复核', requesterRoleId: 'executive', identityScope: requester });
  assert.equal(created.request.status, 'pending_approval');
  assert.equal((await generateApprovedAuditExport({ requestId: created.request.id, identityScope: requester })).code, 'AUDIT_EXPORT_NOT_APPROVED');
  assert.equal(approveAuditExportRequest({ requestId: created.request.id, approverRoleId: 'executive', identityScope: requester }).code, 'AUDIT_EXPORT_FOUR_EYES_REQUIRED');
  assert.equal(approveAuditExportRequest({ requestId: created.request.id, approverRoleId: 'executive', identityScope: approver }).request.status, 'approved');
  const exported = await generateApprovedAuditExport({ requestId: created.request.id, identityScope: requester });
  assert.equal(exported.schemaVersion, 'agent-audit-export.v1');
  assert.equal(exported.traceCount, 1);
  assert.match(exported.exportHash, /^[a-f0-9]{64}$/);
  assert.equal(exported.watermark.classification, 'restricted-audit-export');
  assert.equal(exported.traces[0].identityScope, undefined);
});

test('integrity inspection validates stored hash chains and includes privacy-safe detection results', async () => {
  const inspection = await runAuditIntegrityInspection();
  assert.equal(inspection.status, 'passed');
  assert.equal(inspection.invalid, 0);
  assert.ok(inspection.total >= 1);
  assert.ok(Array.isArray(inspection.detection.rules));
});

test('security detection correlates repeated anonymized prompt attacks without exposing raw identity', () => {
  for (let index = 0; index < 3; index += 1) recordAgentSecurityEvent({ roleId: 'quality_manager', identityScope: { tenantId: 'detection-tenant', subjectId: 'person@example.test' }, stage: 'user_input_preflight', assessment: { riskLevel: 'high', signals: ['prompt_injection'], fingerprint: `hash-${index}`, source: 'text' } });
  const report = evaluateSecurityDetectionRules();
  const finding = report.findings.find((item) => item.ruleId === 'repeated-prompt-attack');
  assert.ok(finding);
  assert.doesNotMatch(JSON.stringify(report), /person@example\.test|detection-tenant/);
});

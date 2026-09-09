import { approveAuditExportRequest, createAuditExportRequest, generateApprovedAuditExport, getAgentEvidenceTrace, listAgentEvidenceTraces, listAuditExportRequests, runAuditIntegrityInspection } from '../domains/agent/public-api.js';

export async function handleEvidenceRoutes({ req, res, url, agentIdentity, effectiveAccess, selectActionRole, denyButton, readBody, send }) {
  if (req.method === 'GET' && url.pathname === '/api/agent/traces') {
    send(res, 200, await listAgentEvidenceTraces(effectiveAccess.roleIds, agentIdentity, url.searchParams.get('limit')));
    return true;
  }
  if (url.pathname === '/api/agent/audit-exports' && req.method === 'GET') {
    if (!selectActionRole('agent.audit.export')) { denyButton('agent.audit.export'); return true; }
    send(res, 200, { items: listAuditExportRequests(agentIdentity) }); return true;
  }
  if (url.pathname === '/api/agent/audit-exports' && req.method === 'POST') {
    const actionRole = selectActionRole('agent.audit.export');
    if (!actionRole) { denyButton('agent.audit.export'); return true; }
    const body = await readBody(req);
    const result = await createAuditExportRequest({ traceIds: body.traceIds, justification: body.justification, requesterRoleId: actionRole.id, identityScope: agentIdentity });
    send(res, result.error ? 400 : 201, result.error ? { message: result.error, code: result.code } : result); return true;
  }
  const exportActionMatch = url.pathname.match(/^\/api\/agent\/audit-exports\/([^/]+)\/(approve|download)$/);
  if (exportActionMatch && req.method === 'POST') {
    const actionRole = selectActionRole('agent.audit.export');
    if (!actionRole) { denyButton('agent.audit.export'); return true; }
    const requestId = decodeURIComponent(exportActionMatch[1]);
    const result = exportActionMatch[2] === 'approve'
      ? approveAuditExportRequest({ requestId, approverRoleId: actionRole.id, identityScope: agentIdentity })
      : await generateApprovedAuditExport({ requestId, identityScope: agentIdentity });
    send(res, result.error ? (result.code === 'AUDIT_EXPORT_NOT_FOUND' ? 404 : 409) : 200, result.error ? { message: result.error, code: result.code } : result); return true;
  }
  if (url.pathname === '/api/agent/audit-integrity/inspect' && req.method === 'POST') {
    if (!selectActionRole('agent.audit.export')) { denyButton('agent.audit.export'); return true; }
    send(res, 200, await runAuditIntegrityInspection()); return true;
  }
  const traceMatch = url.pathname.match(/^\/api\/agent\/traces\/([^/]+)$/);
  if (req.method === 'GET' && traceMatch) {
    const trace = await getAgentEvidenceTrace(traceMatch[1], effectiveAccess.roleIds, agentIdentity);
    send(res, trace ? 200 : 404, trace || { message: '未找到可访问的证据追踪。', code: 'EVIDENCE_TRACE_NOT_FOUND' });
    return true;
  }
  return false;
}

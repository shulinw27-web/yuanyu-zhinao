import { approveProcurement, getProcurementScenario, getZhiNaoAuthorizationProfile, launchProcurement, requestKeyLease } from '../domains/procurement/public-api.js';

function buildAuthorization(role, tool) {
  const profile = getZhiNaoAuthorizationProfile(role.id);
  return {
    ...profile,
    grantedDomains: profile.allowedDomains.map((item) => item.id),
    allowedWorkflowTools: [tool]
  };
}

async function requestProcurementLease({ role, tool, operation, purpose, requestId }) {
  return requestKeyLease({
    connectorId: 'mcp-erp',
    operation,
    purpose,
    role,
    authorization: buildAuthorization(role, tool),
    taskId: `pc-${requestId}`,
    ttlSeconds: 90
  });
}

export async function handleProcurementRoutes({ req, res, url, agentIdentity, selectActionRole, denyButton, send }) {
  if (req.method === 'GET' && url.pathname === '/api/procurement/scenario') {
    send(res, 200, await getProcurementScenario());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/procurement/launch') {
    const actionRole = selectActionRole('procurement.launch');
    if (!actionRole) { denyButton('procurement.launch'); return true; }
    const lease = await requestProcurementLease({ role: actionRole, tool: 'launch_procurement', operation: 'create_procurement_draft', purpose: 'PC 采购协同草稿', requestId: res.requestId });
    if (lease.error) { send(res, String(lease.code || '').startsWith('KMS_') ? 503 : 403, lease); return true; }
    const result = { ...await launchProcurement(actionRole, undefined, agentIdentity), keyLease: lease.lease };
    send(res, result.error ? 403 : 200, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/procurement/approve') {
    const actionRole = selectActionRole('procurement.approve');
    if (!actionRole) { denyButton('procurement.approve'); return true; }
    const lease = await requestProcurementLease({ role: actionRole, tool: 'approve_procurement', operation: 'approve_procurement', purpose: 'PC 采购协同审批', requestId: res.requestId });
    if (lease.error) { send(res, String(lease.code || '').startsWith('KMS_') ? 503 : 403, lease); return true; }
    const result = { ...await approveProcurement(actionRole, undefined, agentIdentity), keyLease: lease.lease };
    send(res, result.error ? 403 : 200, result);
    return true;
  }
  return false;
}

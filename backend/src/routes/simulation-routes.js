import { connectedSystems, getEffectiveRoleIds, hasButtonPermission, getSystemDataOverview, getSystemDataRecords, decideMockApproval, getMockSimulationOverview, recordMockScenarioSemanticValidation, resetMockSimulation, resetSemanticaDemoGraph, runMockScenario, setMockConnectorFault, syncMockScenarioToSemantica, getMcpConnectors } from '../domains/simulation/public-api.js';

export async function handleSimulationRoutes({ req, res, url, role, agentIdentity, effectiveAccess, selectActionRole, denyButton, readBody, send }) {
  if (req.method === 'GET' && url.pathname === '/api/systems') { send(res, 200, connectedSystems); return true; }
  if (req.method === 'GET' && url.pathname === '/api/agent/connectors') { send(res, 200, getMcpConnectors(role)); return true; }
  if (req.method === 'GET' && url.pathname === '/api/system-data/overview') { send(res, 200, await getSystemDataOverview(role)); return true; }
  const systemDataMatch = url.pathname.match(/^\/api\/system-data\/([^/]+)\/records$/);
  if (req.method === 'GET' && systemDataMatch) {
    const result = await getSystemDataRecords(systemDataMatch[1], role, url.searchParams.get('limit'));
    send(res, result.error ? 403 : 200, result);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/simulation/overview') { send(res, 200, await getMockSimulationOverview(role)); return true; }
  if (req.method === 'POST' && url.pathname === '/api/simulation/reset') {
    const actionRole = selectActionRole('simulation.reset');
    if (!actionRole) { denyButton('simulation.reset'); return true; }
    const result = await resetMockSimulation(actionRole.id);
    if (result.error) { send(res, 403, result); return true; }
    const semanticValidation = await resetSemanticaDemoGraph();
    send(res, 200, { ...result, semanticValidation });
    return true;
  }
  const connectorFaultMatch = url.pathname.match(/^\/api\/simulation\/connectors\/([^/]+)\/fault$/);
  if (req.method === 'POST' && connectorFaultMatch) {
    const actionRole = selectActionRole('simulation.fault.manage');
    if (!actionRole) { denyButton('simulation.fault.manage'); return true; }
    const body = await readBody(req);
    const result = await setMockConnectorFault(connectorFaultMatch[1], body.faultId, actionRole.id);
    send(res, result.error ? 403 : 200, result);
    return true;
  }
  const scenarioRunMatch = url.pathname.match(/^\/api\/simulation\/scenarios\/([^/]+)\/run$/);
  if (req.method === 'POST' && scenarioRunMatch) {
    const actionRole = selectActionRole('simulation.run');
    if (!actionRole) { denyButton('simulation.run'); return true; }
    const result = await runMockScenario(scenarioRunMatch[1], actionRole.id);
    if (result.error) { send(res, 403, result); return true; }
    const semanticValidation = await syncMockScenarioToSemantica(result.run.id);
    await recordMockScenarioSemanticValidation(result.run.id, semanticValidation);
    send(res, 200, { ...result, run: { ...result.run, semanticValidation }, overview: await getMockSimulationOverview(actionRole.id), semanticValidation });
    return true;
  }
  const approvalMatch = url.pathname.match(/^\/api\/simulation\/approvals\/([^/]+)\/decision$/);
  if (req.method === 'POST' && approvalMatch) {
    if (!selectActionRole('simulation.approval.decide')) { denyButton('simulation.approval.decide'); return true; }
    const body = await readBody(req);
    const effectiveRoleIds = getEffectiveRoleIds(role, agentIdentity);
    const primaryRoleId = effectiveAccess.primaryRoleId;
    const candidates = [primaryRoleId, ...effectiveRoleIds.filter((roleId) => roleId !== primaryRoleId)]
      .filter((roleId) => roleId && hasButtonPermission(roleId, 'simulation.approval.decide'));
    let result = null;
    for (const candidateRoleId of candidates) {
      result = await decideMockApproval(approvalMatch[1], body.decision, candidateRoleId);
      if (result?.error !== '当前角色无权处理该模拟 OA 审批。') break;
    }
    if (result?.error) { send(res, 403, result); return true; }
    const semanticValidation = result.run ? await syncMockScenarioToSemantica(result.run.id) : null;
    if (result.run && semanticValidation) await recordMockScenarioSemanticValidation(result.run.id, semanticValidation);
    send(res, 200, { ...result, run: result.run ? { ...result.run, semanticValidation } : result.run, overview: await getMockSimulationOverview(primaryRoleId), semanticValidation });
    return true;
  }
  return false;
}

import { getAccessExplanation, acknowledgeRisk, approveRisk, getDashboard, getRiskById, getRiskList } from '../domains/risk/public-api.js';
import { acknowledgeAlertNotifications } from '../domains/alerting/public-api.js';

const hiddenRisk = { message: '当前角色无权访问此风险事件。' };

export async function handleRiskRoutes({ req, res, url, role, agentIdentity, selectActionRole, denyButton, send }) {
  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    send(res, 200, await getDashboard(role, agentIdentity));
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/risk-cases') {
    send(res, 200, await getRiskList(role, agentIdentity));
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/authorization/explain') {
    send(res, 200, getAccessExplanation(role, agentIdentity));
    return true;
  }

  const match = url.pathname.match(/^\/api\/risk-cases\/([^/]+)(?:\/(acknowledge|approve))?$/);
  if (!match) return false;
  const [, id, action] = match;

  if (req.method === 'GET' && !action) {
    if (!selectActionRole('risk.detail.view')) { denyButton('risk.detail.view'); return true; }
    const risk = await getRiskById(id, role, agentIdentity);
    send(res, risk ? 200 : 404, risk || hiddenRisk);
    return true;
  }

  if (req.method === 'POST' && action === 'acknowledge') {
    if (!await getRiskById(id, role, agentIdentity)) { send(res, 404, hiddenRisk); return true; }
    const actionRole = selectActionRole('risk.acknowledge');
    if (!actionRole) { denyButton('risk.acknowledge'); return true; }
    if (!await acknowledgeRisk(id, actionRole)) { send(res, 404, { message: '未找到风险事件。' }); return true; }
    await acknowledgeAlertNotifications(id, { type: 'user', roleId: actionRole.id, subjectId: agentIdentity.subjectId || 'unknown' });
    const visibleRisk = await getRiskById(id, role, agentIdentity);
    send(res, visibleRisk ? 200 : 404, visibleRisk || hiddenRisk);
    return true;
  }

  if (req.method === 'POST' && action === 'approve') {
    if (!await getRiskById(id, role, agentIdentity)) { send(res, 404, hiddenRisk); return true; }
    const actionRole = selectActionRole('risk.approve');
    if (!actionRole) { denyButton('risk.approve'); return true; }
    if (!await approveRisk(id, actionRole)) { send(res, 404, { message: '未找到风险事件。' }); return true; }
    const visibleRisk = await getRiskById(id, role, agentIdentity);
    send(res, visibleRisk ? 200 : 404, visibleRisk || hiddenRisk);
    return true;
  }
  return false;
}

import { listAnomalyReports, changeAnomalyReport, extractAnomalyReport, getEffectiveAccess } from '../domains/governance/public-api.js';

export async function handleAnomalyRoutes({ req, res, url, role, agentIdentity, selectActionRole, denyButton, readBody, send }) {
  const base = '/api/agent/anomalies';
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
  const context = { identityScope: agentIdentity, roleId: role };
  const allowed = (write = false) => {
    const access = getEffectiveAccess(role, agentIdentity);
    return access.pagePermissionIds.includes('page.agent.view') && (!write || access.buttonPermissionIds.includes('agent.prompt.run'));
  };
  const reply = result => { send(res, result.error ? result.status || 400 : 200, result); return true; };
  if (!allowed()) return reply({ error: 'ANOMALY_ACCESS_DENIED', status: 403 });
  if (req.method === 'GET' && url.pathname === base) return reply(await listAnomalyReports(context));
  if (req.method !== 'POST') return reply({ error: 'ANOMALY_ROUTE_NOT_FOUND', status: 404 });
  if (!selectActionRole('agent.prompt.run')) { denyButton('agent.prompt.run'); return true; }
  const options = { context, body: await readBody(req), canRead: () => allowed(true) };
  if (url.pathname === base) return reply(await changeAnomalyReport({ ...options, action: 'create' }));
  const match = url.pathname.slice(base.length).match(/^\/([A-Za-z0-9-]{1,100})\/(append|edit|extract|ask|reply|confirm|retract)$/);
  if (!match) return reply({ error: 'ANOMALY_ROUTE_NOT_FOUND', status: 404 });
  return reply(await (match[2] === 'extract' ? extractAnomalyReport : changeAnomalyReport)({ ...options, id: match[1], action: match[2] }));
}

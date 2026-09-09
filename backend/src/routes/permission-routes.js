import { assignUserRoles, getPermissionCenterOverview, getPermissionManagementWorkspace, saveRolePolicy } from '../domains/iam/public-api.js';
import { permissionErrorStatus } from '../http/http-utils.js';

export async function handlePermissionRoutes({ req, res, url, role, agentIdentity, effectiveAccess, selectActionRole, denyButton, readBody, send }) {
  if (req.method === 'GET' && url.pathname === '/api/permission-center') { send(res, 200, getPermissionCenterOverview(role)); return true; }
  if (req.method === 'GET' && url.pathname === '/api/access/me') { send(res, 200, effectiveAccess); return true; }
  if (req.method === 'GET' && url.pathname === '/api/permission-management') { send(res, 200, getPermissionManagementWorkspace(role, agentIdentity)); return true; }
  const userMatch = url.pathname.match(/^\/api\/permission-management\/users\/([^/]+)\/roles$/);
  if (req.method === 'POST' && userMatch) {
    const actionRole = selectActionRole('permission.user.assign');
    if (!actionRole) { denyButton('permission.user.assign'); return true; }
    const result = await assignUserRoles({ ...await readBody(req), userId: decodeURIComponent(userMatch[1]) }, actionRole.id, agentIdentity);
    send(res, result.error ? permissionErrorStatus(result) : 200, result.error ? { ...result, message: result.error } : result);
    return true;
  }
  const policyMatch = url.pathname.match(/^\/api\/permission-management\/roles\/([^/]+)\/policy$/);
  if (req.method === 'POST' && policyMatch) {
    const actionRole = selectActionRole('permission.policy.save');
    if (!actionRole) { denyButton('permission.policy.save'); return true; }
    const result = await saveRolePolicy({ ...await readBody(req), roleId: decodeURIComponent(policyMatch[1]) }, actionRole.id, agentIdentity);
    send(res, result.error ? permissionErrorStatus(result) : 200, result.error ? { ...result, message: result.error } : result);
    return true;
  }
  return false;
}

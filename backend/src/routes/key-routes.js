import { getKeyCenterOverview, revokeKeyLease, rotateKeyPolicy } from '../domains/key-management/public-api.js';

export async function handleKeyRoutes({ req, res, url, role, selectActionRole, denyButton, send }) {
  if (req.method === 'GET' && url.pathname === '/api/key-center/overview') {
    send(res, 200, getKeyCenterOverview(role));
    return true;
  }

  const leaseMatch = url.pathname.match(/^\/api\/key-center\/leases\/([^/]+)\/revoke$/);
  if (req.method === 'POST' && leaseMatch) {
    const actionRole = selectActionRole('key.lease.revoke');
    if (!actionRole) { denyButton('key.lease.revoke'); return true; }
    const result = revokeKeyLease(leaseMatch[1], actionRole);
    send(res, result.error ? 403 : 200, result);
    return true;
  }

  const policyMatch = url.pathname.match(/^\/api\/key-center\/policies\/([^/]+)\/rotate$/);
  if (req.method === 'POST' && policyMatch) {
    const actionRole = selectActionRole('key.policy.rotate');
    if (!actionRole) { denyButton('key.policy.rotate'); return true; }
    const result = rotateKeyPolicy(policyMatch[1], actionRole);
    send(res, result.error ? 403 : 200, result);
    return true;
  }
  return false;
}

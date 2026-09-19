import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// Start in a fresh process after the caller has selected test/memory storage.
// This harness mounts production identity, IAM dispatcher and governance routes;
// it does not start unrelated production workers, databases or cloud clients.
export async function startMockOnboardingHTTP(guard) {
  if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory' || !process.env.NODE_TEST_CONTEXT) {
    throw new Error('Mock onboarding HTTP requires an isolated test memory process.');
  }
  const { seedTenantIAM } = await import('../../backend/test/helpers/tenant-iam-fixture.js');
  const { issueIdentitySession } = await import('../../backend/src/services/identity-session-service.js');
  const { resolveRequestIdentityAsync } = await import('../../backend/src/services/request-identity-service.js');
  const { dispatchAuthorizedRoutes } = await import('../../backend/src/http/authorized-route-dispatch.js');
  const { handleGovernanceRoutes } = await import('../../backend/src/routes/governance-routes.js');
  const { createBodyReader, sendJson } = await import('../../backend/src/http/http-utils.js');
  const { configureTenantRuntimeControl } = await import('../../backend/src/services/tenant-runtime-control-service.js');
  const { observeMockOnboardingPortsForTest } = await import('../../backend/src/services/mock-onboarding-source-service.js');
  // No production enrollment is asserted. These are explicitly unmanaged local
  // test tenants, still subject to IAM, session and route permission checks.
  configureTenantRuntimeControl({ required: () => false, production: () => false });
  const deviceId = 'mock-onboarding-device';
  const sessions = {};
  for (const tenantId of ['mock-onboarding-a', 'mock-onboarding-b']) {
    seedTenantIAM(tenantId, ['admin@demo.local']);
    sessions[tenantId] = (await issueIdentitySession({ source: 'test', tenantId, account: 'admin@demo.local', roleId: 'executive', deviceId })).id;
  }
  const readBody = createBodyReader(2 * 1024 * 1024);
  const server = createServer(async (req, res) => {
    res.requestId = randomUUID();
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!/^\/api\/semantic-operations\/onboarding(?:\/|$)/.test(url.pathname)) return sendJson(res, 404, { message: 'Only onboarding routes are mounted in this test.' });
      const identity = await resolveRequestIdentityAsync({ headers: req.headers, url, allowDemoRoleHeader: false });
      if (identity.error) return sendJson(res, 401, { message: 'Synthetic authentication required.' });
      await dispatchAuthorizedRoutes({ req, res, url, identity, role: identity.role, agentIdentity: identity, readBody, send: sendJson }, [handleGovernanceRoutes], async () => false);
    } catch (error) {
      sendJson(res, error.status || 500, { message: 'Mock request failed.', code: error.code || 'MOCK_REQUEST_FAILED' });
    }
  });
  let port; let revokePort; let stopObservingPorts;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
    revokePort = guard.allowPort(port);
    stopObservingPorts = observeMockOnboardingPortsForTest(port => guard.allowPort(port));
  } catch (error) {
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    revokePort?.(); stopObservingPorts?.(); throw error;
  }
  const call = async (tenantId, path = '', body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/semantic-operations/onboarding${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-device-id': deviceId,
        ...(sessions[tenantId] ? { 'x-identity-session': sessions[tenantId] } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000)
    });
    return { status: response.status, body: await response.json() };
  };
  return { call, port, syntheticHeaders: tenantId => ({ 'x-identity-session': sessions[tenantId], 'x-client-device-id': deviceId }),
    close: () => new Promise(resolve => { server.close(() => { stopObservingPorts(); revokePort(); resolve(); }); server.closeAllConnections(); }) };
}

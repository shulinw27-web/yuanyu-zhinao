import { dingTalkAuth, identityProviders, getAccountCenterOverview, getIAMStoreInfo, getIdentitySessionStoreInfo, getOAConnectionStatus, getOASessionProfile, getRoleCatalog, getRuntimeStoreInfo, loginWithLocalAccount, loginWithOA, logoutOA, modules, registerDeviceSession } from '../domains/identity/public-api.js';

export async function handleIdentityRoutes({ req, res, url, role, oaSessionId, readBody, send }) {
  if (req.method === 'GET' && url.pathname === '/api/auth/providers') {
    send(res, 200, identityProviders.describe()); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/dingtalk/config') {
    send(res, 200, dingTalkAuth.connection()); return true;
  }
  if (req.method === 'POST' && ['/api/auth/dingtalk/login/challenge', '/api/auth/dingtalk/login'].includes(url.pathname)) {
    const body = await readBody(req);
    const input = { challengeId: body?.challengeId, code: body?.code, corpId: body?.corpId, origin: req.headers.origin, deviceId: req.headers['x-client-device-id'], platform: req.headers['x-client-platform'] };
    const result = url.pathname.endsWith('/challenge') ? dingTalkAuth.challenge(input) : await dingTalkAuth.login(input);
    send(res, result.error ? result.status : 200, result.error ? { message: result.error, code: result.code } : result); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const { driver, persistence, schemaVersion } = getRuntimeStoreInfo();
    const identitySessionStore = getIdentitySessionStoreInfo();
    const iamStore = getIAMStoreInfo();
    send(res, 200, { status: 'ok', service: 'healthcare-ai-demo-api', runtimeStore: { driver, persistence, schemaVersion }, identitySessionStore: { driver: identitySessionStore.driver, persistence: identitySessionStore.persistence, schemaVersion: identitySessionStore.schemaVersion }, iamStore, time: new Date().toISOString() });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/oa/connection') { send(res, 200, getOAConnectionStatus()); return true; }
  if (req.method === 'GET' && url.pathname === '/api/account-center') { send(res, 200, getAccountCenterOverview(role)); return true; }
  if (req.method === 'POST' && url.pathname === '/api/auth/oa/login') {
    const body = await readBody(req);
    const result = await loginWithOA({ ...body, deviceId: req.headers['x-client-device-id'], platform: req.headers['x-client-platform'] });
    send(res, result.error ? 401 : 200, result.error ? { message: result.error } : result);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/local/login') {
    const body = await readBody(req);
    const result = await loginWithLocalAccount({ ...body, deviceId: req.headers['x-client-device-id'], platform: req.headers['x-client-platform'] });
    send(res, result.error ? 401 : 200, result.error ? { message: result.error } : result);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/oa/session') {
    const result = await getOASessionProfile(oaSessionId, req.headers['x-client-device-id']);
    send(res, result.error ? 401 : 200, result.error ? { message: result.error } : result);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/oa/logout') { send(res, 200, await logoutOA(oaSessionId)); return true; }
  if (req.method === 'POST' && url.pathname === '/api/session/device') { send(res, 200, registerDeviceSession(await readBody(req), role)); return true; }
  if (req.method === 'GET' && url.pathname === '/api/roles') { send(res, 200, getRoleCatalog()); return true; }
  if (req.method === 'GET' && url.pathname === '/api/modules') { send(res, 200, modules); return true; }
  return false;
}

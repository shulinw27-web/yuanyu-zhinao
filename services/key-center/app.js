import { createServer } from 'node:http';
import { URL } from 'node:url';
import { roles } from '../../backend/src/data/seed.js';
import { getRole } from '../../backend/src/services/authorization-service.js';
import { getKeyCenterOverview, requestKeyLease, revokeKeyLease, rotateKeyPolicy } from '../../backend/src/services/key-center/key-center-service.js';
import { registerConfiguredRemoteCredentialProvider } from '../../backend/src/services/key-center/remote-credential-provider.js';
import { probeKmsAdapter } from '../../backend/src/services/key-center/kms-adapter.js';

const port = Number.parseInt(process.env.KEY_CENTER_PORT || '3010', 10);
const host = process.env.KEY_CENTER_HOST || '127.0.0.1';
const isProduction = process.env.NODE_ENV === 'production';
const trustedPrincipals = new Set((process.env.KEY_CENTER_TRUSTED_PRINCIPALS || 'api-gateway,key-center-admin').split(',').map((item) => item.trim()).filter(Boolean));
registerConfiguredRemoteCredentialProvider();

const send = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let raw = '';
  let bytes = 0;
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 64 * 1024) { const error = new Error('请求体超过限制。'); error.status = 413; reject(error); req.resume(); return; }
    raw += chunk;
  });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  req.on('error', reject);
});

const authenticateWorkload = (req) => {
  const principal = String(req.headers['x-service-principal'] || '').trim();
  if (!principal && !isProduction) return { principal: 'local-demo-gateway', mode: 'development_bypass' };
  if (!principal || !trustedPrincipals.has(principal)) return { error: '未认证的服务主体。密钥中心仅接受可信工作负载调用。' };
  return { principal, mode: isProduction ? 'service_identity_required' : 'named_service_principal' };
};

const publicHealth = async () => {
  const adapter = await probeKmsAdapter();
  return { status: adapter.available ? 'ready' : 'not_ready', service: 'key-center', version: '0.1.0', host, identityMode: isProduction ? 'service_identity_required' : 'development_bypass_or_named_principal', credentialMaterialExposed: false, adapter: { provider: adapter.provider, mode: adapter.mode } };
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      const health = await publicHealth();
      return send(res, health.status === 'ready' ? 200 : 503, health);
    }
    const workload = authenticateWorkload(req);
    if (workload.error) return send(res, 401, { message: workload.error });
    const roleId = url.searchParams.get('role') || 'executive';
    if (!roles[roleId]) return send(res, 400, { message: '无效的业务角色。' });
    if (req.method === 'GET' && url.pathname === '/v1/overview') return send(res, 200, { ...getKeyCenterOverview(roleId), workload: { principal: workload.principal, mode: workload.mode } });
    if (req.method === 'POST' && url.pathname === '/v1/leases') {
      const body = await readBody(req);
      const result = await requestKeyLease({ ...body, role: getRole(body.roleId), authorization: body.authorization, taskId: body.taskId, ttlSeconds: body.ttlSeconds });
      const errorStatus = String(result.code || '').startsWith('KMS_') ? 503 : 403;
      return result.error ? send(res, errorStatus, { message: result.error, code: result.code }) : send(res, 200, { ...result, workload: { principal: workload.principal, mode: workload.mode } });
    }
    const revokeMatch = url.pathname.match(/^\/v1\/leases\/([^/]+)\/revoke$/);
    if (req.method === 'POST' && revokeMatch) {
      const body = await readBody(req);
      const result = revokeKeyLease(revokeMatch[1], getRole(body.roleId));
      return result.error ? send(res, 403, { message: result.error }) : send(res, 200, result);
    }
    const rotateMatch = url.pathname.match(/^\/v1\/policies\/([^/]+)\/rotate$/);
    if (req.method === 'POST' && rotateMatch) {
      const body = await readBody(req);
      const result = rotateKeyPolicy(rotateMatch[1], getRole(body.roleId));
      return result.error ? send(res, 403, { message: result.error }) : send(res, 200, result);
    }
    return send(res, 404, { message: '未找到接口。' });
  } catch (error) {
    return send(res, error.status || 500, { message: error.status ? error.message : '密钥中心暂时不可用。' });
  }
});

server.listen(port, host, () => console.log(`Key Center listening on http://${host}:${port}`));

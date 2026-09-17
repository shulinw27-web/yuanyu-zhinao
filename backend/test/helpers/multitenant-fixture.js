import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { createProductPortalService } from '../../src/services/product-portal-service.js';
import { createProductPortalServer } from '../../src/http/product-portal-server.js';

// Synthetic identities only. This fixture never opens the running portal database.
export function multitenantFixture({ provisioningInspector } = {}) {
  let now = Date.UTC(2026, 8, 16);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const sessions = Object.fromEntries(['alice', 'bob', 'carol', 'root'].map(id => {
    const token = randomBytes(32).toString('base64url');
    return [id, { token, csrf: hash(`csrf:${token}`) }];
  }));
  let state = {
    users: Object.keys(sessions).map(id => ({ id, email: `${id}@example.test`, name: id, status: 'active', platformAdmin: id === 'root' })),
    sessions: Object.entries(sessions).map(([id, s]) => ({ userId: id, hash: hash(s.token), csrfHash: hash(s.csrf), expiresAt: now + 86400000 })),
    tenants: [], orders: [], ledger: [], coupons: [], invitations: [], audits: []
  };
  const service = createProductPortalService({ sandboxPayments: true, clock: () => now, provisioningInspector,
    read: initial => structuredClone(state || initial()),
    mutate: (initial, callback) => {
      const outcome = callback(structuredClone(state || initial()));
      state = structuredClone(outcome.value);
      return structuredClone(outcome.result);
    }
  });
  const act = (who, action, body = {}) => service.perform(sessions[who].token, sessions[who].csrf, action, body);
  const tenant = (who, suffix = who) => act(who, 'tenant.create', { name: `合成租户-${suffix}`, slug: `synthetic-${suffix}`, requestId: suffix }).tenantId;
  const workspace = who => service.workspace(sessions[who].token);
  const invite = (who, tenantId, recipient, role = 'member') => {
    const result = act(who, 'tenant.invite', { tenantId, email: `${recipient}@example.test`, role });
    act(recipient, 'invite.accept', { token: result.invitationToken });
    return result;
  };
  const order = (who, tenantId, extra = {}) => act(who, 'order.create', { tenantId, kind: 'recharge', amountCents: 20000, requestId: randomBytes(8).toString('hex'), ...extra }).order;
  const pay = (who, orderId, method = 'sandbox') => act(who, 'order.pay', { orderId, method, confirmed: true });
  return { service, sessions, act, tenant, workspace, invite, order, pay, state: () => structuredClone(state), now, advance: ms => { now += ms; } };
}

export async function isolatedPortal(fixture) {
  const server = createProductPortalServer({ service: fixture.service });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const call = (who, path, body, headers = {}) => new Promise((resolve, reject) => {
    const session = fixture.sessions[who];
    const encoded = body === undefined ? null : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port: server.address().port, path: `/api/portal/${path}`, method: encoded ? 'POST' : 'GET', headers: {
      Origin: 'http://127.0.0.1:15195', 'X-Portal-Client': 'web', 'Content-Type': 'application/json',
      ...(session ? { Cookie: `yy_portal=${session.token}`, 'X-CSRF-Token': session.csrf } : {}), ...headers
    } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Synthetic portal request timed out')));
    req.on('error', reject); req.end(encoded);
  });
  return { url: `http://127.0.0.1:${server.address().port}`, call, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

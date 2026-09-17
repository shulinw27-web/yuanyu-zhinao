import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createProductPortalService } from '../src/services/product-portal-service.js';
import { createProductPortalServer } from '../src/http/product-portal-server.js';
import { readFileSync } from 'node:fs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture({ seed = true, sandboxPayments = true } = {}) {
  let state; let now = Date.UTC(2026, 8, 14);
  const service = createProductPortalService({ sandboxPayments, clock: () => now,
    read: initial => structuredClone(state || initial()),
    mutate: (initial, callback) => { const draft = structuredClone(state || initial()); const outcome = callback(draft); state = structuredClone(outcome.value); return structuredClone(outcome.result); }
  });
  const sessions = Object.fromEntries(['alice', 'bob', 'root'].map(name => [name, { token: randomBytes(32).toString('base64url'), csrf: randomBytes(32).toString('base64url') }]));
  for (const session of Object.values(sessions)) session.csrf = hash(`csrf:${session.token}`);
  if (seed) {
    state = { users: ['alice', 'bob', 'root'].map(id => ({ id, email: `${id}@example.test`, name: id, status: 'active', platformAdmin: id === 'root', createdAt: new Date(now).toISOString() })),
      sessions: Object.entries(sessions).map(([id, s]) => ({ userId: id, hash: hash(s.token), csrfHash: hash(s.csrf), expiresAt: now + 86400000 * 365 })), tenants: [], orders: [], ledger: [], coupons: [], invitations: [], audits: [] };
  }
  const act = (who, action, body = {}) => service.perform(sessions[who].token, sessions[who].csrf, action, body);
  const createTenant = (who = 'alice', slug = who) => act(who, 'tenant.create', { name: `${who}组织`, slug: `${slug}-org`, requestId: slug }).tenantId;
  const order = (tenantId, data = {}, who = 'alice') => act(who, 'order.create', { tenantId, kind: 'subscription', planId: 'professional', requestId: randomBytes(5).toString('hex'), ...data }).order;
  const pay = (orderId, method = 'sandbox', who = 'alice') => act(who, 'order.pay', { orderId, method, confirmed: true });
  const coupon = (data = {}) => act('root', 'admin.coupon', { code: 'WELCOME', type: 'fixed', value: 1000, minCents: 0, maxUses: 10, startsAt: now, expiresAt: now + 86400000, planId: null, ...data }).coupon;
  return { service, act, createTenant, order, pay, coupon, sessions, state: () => structuredClone(state), advance: delta => { now += delta; }, now: () => now };
}
const rejects = (fn, code) => assert.throws(fn, e => e.code === code);

test('portal: registration hashes passwords, has no automatic admin and login rotates sessions', async () => {
  const f = fixture({ seed: false }); const body = { email: 'Alice@Example.test', name: 'Alice', password: 'synthetic-passphrase-2026', acceptedTerms: true };
  const registered = await f.service.register(body);
  assert.equal(registered.user.platformAdmin, false); assert.equal(registered.user.emailVerified, false);
  assert.equal(registered.user.email, 'alice@example.test'); assert.equal(JSON.stringify(f.state()).includes(body.password), false);
  const login = await f.service.login({ email: body.email, password: body.password });
  assert.equal(f.service.workspace(login.sessionToken).user.id, registered.user.id);
  assert.equal(JSON.stringify(f.state()).includes(login.sessionToken), false);
  assert.equal(JSON.stringify(f.service.workspace(login.sessionToken)).includes('credentials'), false);
  await assert.rejects(f.service.login({ email: body.email, password: 'wrong-password-value' }), e => e.code === 'LOGIN_FAILED');
  await assert.rejects(f.service.register({ ...body, platformAdmin: true }), e => e.code === 'INVALID_INPUT');
  await assert.rejects(f.service.register({ ...body, password: 'short' }), e => e.code === 'PASSWORD_POLICY');
  await assert.rejects(f.service.register(body), e => e.code === 'REGISTRATION_UNAVAILABLE');
  f.service.bootstrapAdmin(body.email); rejects(() => f.service.workspace(login.sessionToken), 'AUTH_REQUIRED');
  const adminLogin = await f.service.login({ email: body.email, password: body.password });
  assert.equal(adminLogin.user.platformAdmin, true);
});

test('portal: tenant creation is scoped, idempotent and does not provision business access', () => {
  const f = fixture(); const id = f.createTenant(); assert.equal(f.createTenant(), id);
  const alice = f.service.workspace(f.sessions.alice.token); assert.equal(alice.tenants[0].runtimeConnected, false); assert.equal(alice.tenants[0].status, 'provisioning_pending');
  assert.equal(f.service.workspace(f.sessions.bob.token).tenants.length, 0);
  rejects(() => f.act('bob', 'tenant.create', { name: 'B', slug: 'alice-org', requestId: 'other' }), 'SLUG_TAKEN');
  rejects(() => f.act('alice', 'tenant.create', { name: 'different', slug: 'alice-org', requestId: 'alice' }), 'IDEMPOTENCY_CONFLICT');
  rejects(() => f.act('bob', 'order.create', { tenantId: id, kind: 'recharge', amountCents: 100, requestId: 'bad' }), 'TENANT_NOT_FOUND');
  rejects(() => f.act('alice', 'admin.tenant', { tenantId: id, status: 'sandbox_ready', expectedVersion: 1 }), 'ADMIN_REQUIRED');
  f.act('root', 'admin.tenant', { tenantId: id, status: 'sandbox_ready', expectedVersion: 1 });
  assert.equal(f.service.workspace(f.sessions.alice.token).tenants[0].runtimeConnected, false);
  rejects(() => f.act('root', 'admin.tenant', { tenantId: id, status: 'suspended', expectedVersion: 1 }), 'VERSION_CONFLICT');
});

test('portal: missing or changed CSRF, expired session and suspended user fail closed', () => {
  const f = fixture(); const s = f.sessions.alice;
  rejects(() => f.service.perform(s.token, undefined, 'logout', {}), 'CSRF_REJECTED');
  rejects(() => f.service.perform(s.token, 'wrong', 'logout', {}), 'CSRF_REJECTED');
  assert.equal(f.service.sessionCsrf(s.token), s.csrf); assert.equal(f.service.sessionCsrf(s.token), s.csrf);
  f.act('root', 'admin.user', { userId: 'alice', status: 'suspended' });
  rejects(() => f.service.workspace(s.token), 'AUTH_REQUIRED');
  f.act('root', 'admin.user', { userId: 'alice', status: 'active' }); rejects(() => f.service.workspace(s.token), 'AUTH_REQUIRED');
  rejects(() => f.act('root', 'admin.user', { userId: 'root', status: 'suspended' }), 'PROTECTED_ADMIN');
  f.advance(366 * 86400000); rejects(() => f.service.workspace(f.sessions.bob.token), 'AUTH_REQUIRED');
});

test('portal: integer-cent pricing and amount tampering are server validated', () => {
  const f = fixture(); const id = f.createTenant();
  for (const amountCents of [-1, 1.1, '100', 10000001, NaN]) rejects(() => f.order(id, { kind: 'recharge', planId: undefined, amountCents }), 'INVALID_AMOUNT');
  rejects(() => f.order(id, { totalCents: 1 }), 'INVALID_INPUT');
  rejects(() => f.order(id, { couponCode: 123 }), 'INVALID_INPUT');
  rejects(() => f.order(id, { planId: 'invented' }), 'PLAN_INVALID');
  assert.equal(f.order(id).totalCents, 9900);
});

test('portal: duplicate order/pay cannot credit twice and wallet cannot recharge itself', () => {
  const f = fixture(); const id = f.createTenant(); const data = { kind: 'recharge', planId: undefined, amountCents: 20000, requestId: 'top-up' };
  const order = f.order(id, data); assert.equal(f.order(id, data).id, order.id);
  rejects(() => f.order(id, { ...data, amountCents: 30000 }), 'IDEMPOTENCY_CONFLICT');
  rejects(() => f.pay(order.id, 'wallet'), 'PAYMENT_METHOD_INVALID');
  f.pay(order.id); assert.equal(f.pay(order.id).duplicate, true);
  assert.equal(f.state().tenants[0].balanceCents, 20000); assert.equal(f.state().ledger.length, 1);
  const subscription = f.order(id); f.pay(subscription.id, 'wallet'); f.pay(subscription.id, 'wallet');
  assert.equal(f.state().tenants[0].balanceCents, 10100); assert.equal(f.state().ledger.length, 2);
  assert.equal(f.service.workspace(f.sessions.alice.token).tenants[0].plan.id, 'professional');
  assert.equal(f.state().tenants[0].membership.expiresAt, f.now() + 30 * 86400000);
});

test('portal: insufficient balance, missing confirmation and disabled payment never mutate funds', () => {
  const f = fixture(); const order = f.order(f.createTenant());
  rejects(() => f.pay(order.id, 'wallet'), 'INSUFFICIENT_BALANCE');
  rejects(() => f.act('alice', 'order.pay', { orderId: order.id, method: 'sandbox', confirmed: false }), 'PAYMENT_CONFIRMATION_REQUIRED');
  assert.equal(f.state().orders[0].status, 'pending'); assert.equal(f.state().ledger.length, 0);
  const off = fixture({ sandboxPayments: false }); const o = off.order(off.createTenant()); rejects(() => off.pay(o.id), 'PAYMENT_NOT_CONFIGURED');
});

test('portal: coupon reservation, total cap, per-tenant limit and release on cancellation', () => {
  const f = fixture(); const alice = f.createTenant(); const bob = f.createTenant('bob'); f.coupon({ maxUses: 1 });
  const o = f.order(alice, { couponCode: 'welcome' }); assert.equal(o.totalCents, 8900);
  rejects(() => f.order(bob, { couponCode: 'WELCOME' }, 'bob'), 'COUPON_UNAVAILABLE');
  f.act('alice', 'order.cancel', { orderId: o.id });
  const b = f.order(bob, { couponCode: 'WELCOME' }, 'bob'); f.pay(b.id, 'sandbox', 'bob');
  rejects(() => f.order(bob, { couponCode: 'WELCOME' }, 'bob'), 'COUPON_UNAVAILABLE');
});

test('portal: coupon expiry, minimum, plan constraints and integer percentage rules', () => {
  const f = fixture(); const id = f.createTenant(); f.coupon({ type: 'percent', value: 1234 });
  assert.equal(f.order(id, { couponCode: 'WELCOME' }).discountCents, 1221);
  f.coupon({ code: 'TEAMONLY', planId: 'business' }); rejects(() => f.order(id, { couponCode: 'TEAMONLY' }), 'COUPON_UNAVAILABLE');
  f.coupon({ code: 'MINIMUM', minCents: 10000 }); rejects(() => f.order(id, { couponCode: 'MINIMUM' }), 'COUPON_UNAVAILABLE');
  rejects(() => f.coupon({ code: 'INVALID', type: 'percent', value: 10001 }), 'INVALID_AMOUNT');
  f.advance(86400001); rejects(() => f.order(id, { couponCode: 'WELCOME' }), 'COUPON_UNAVAILABLE');
});

test('portal: membership discount and coupon choose best without stacking; renew extends once', () => {
  const f = fixture(); const id = f.createTenant(); f.pay(f.order(id).id);
  const expires = f.state().tenants[0].membership.expiresAt;
  f.coupon({ value: 100 }); const q = f.order(id, { couponCode: 'WELCOME' });
  assert.equal(q.discountCents, 495); assert.equal(q.couponId, null); assert.equal(q.totalCents, 9405);
  f.pay(q.id); assert.equal(f.state().tenants[0].membership.expiresAt, expires + 30 * 86400000);
  rejects(() => f.order(id, { planId: 'business' }), 'PLAN_CHANGE_REQUIRES_REVIEW');
  f.advance(61 * 86400000); assert.equal(f.service.workspace(f.sessions.alice.token).tenants[0].plan.id, 'explore');
});

test('portal: expired and disabled-coupon orders cannot be paid', () => {
  const f = fixture(); const id = f.createTenant(); const c = f.coupon(); const first = f.order(id, { couponCode: c.code });
  f.act('root', 'admin.coupon-disable', { couponId: c.id }); rejects(() => f.pay(first.id), 'ORDER_STATE_CONFLICT');
  const second = f.order(id); f.advance(1800001); rejects(() => f.pay(second.id), 'ORDER_STATE_CONFLICT');
  assert.equal(f.service.workspace(f.sessions.alice.token).orders[0].status, 'expired');
});

test('portal: invite binds recipient and one-time token; member cannot manage billing', () => {
  const f = fixture(); const id = f.createTenant(); const invitation = f.act('alice', 'tenant.invite', { tenantId: id, email: 'bob@example.test', role: 'member' });
  assert.equal(invitation.delivery, 'manual'); assert.equal(JSON.stringify(f.state()).includes(invitation.invitationToken), false);
  rejects(() => f.act('root', 'invite.accept', { token: invitation.invitationToken }), 'INVITE_INVALID');
  f.act('bob', 'invite.accept', { token: invitation.invitationToken });
  rejects(() => f.act('bob', 'invite.accept', { token: invitation.invitationToken }), 'INVITE_INVALID');
  const bob = f.service.workspace(f.sessions.bob.token); assert.equal(bob.tenants[0].balanceCents, null); assert.equal(bob.tenants[0].members[0].email, undefined);
  rejects(() => f.order(id, {}, 'bob'), 'TENANT_PERMISSION_DENIED');
  rejects(() => f.act('bob', 'tenant.invite', { tenantId: id, email: 'root@example.test', role: 'admin' }), 'TENANT_PERMISSION_DENIED');
  f.act('alice', 'tenant.member', { tenantId: id, userId: 'bob', role: 'admin', status: 'active', expectedVersion: 2 });
  assert.equal(f.service.workspace(f.sessions.bob.token).tenants[0].role, 'admin');
  rejects(() => f.act('bob', 'tenant.member', { tenantId: id, userId: 'alice', role: 'member', status: 'removed', expectedVersion: 3 }), 'TENANT_PERMISSION_DENIED');
  f.act('alice', 'tenant.member', { tenantId: id, userId: 'bob', role: 'member', status: 'removed', expectedVersion: 3 });
  assert.equal(f.service.workspace(f.sessions.bob.token).tenants.length, 0);
});

test('portal: suspended tenant rejects writes and pending invitations', () => {
  const f = fixture(); const id = f.createTenant(); const invite = f.act('alice', 'tenant.invite', { tenantId: id, email: 'bob@example.test', role: 'member' });
  const order = f.order(id); f.act('root', 'admin.tenant', { tenantId: id, expectedVersion: 1, status: 'suspended' });
  rejects(() => f.pay(order.id), 'TENANT_SUSPENDED'); rejects(() => f.act('bob', 'invite.accept', { token: invite.invitationToken }), 'INVITE_INVALID');
});

test('portal HTTP: origin, CSRF, session, input size, admin and fake payment callbacks are guarded', async t => {
  const f = fixture(); const server = createProductPortalServer({ service: f.service }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/portal/`;
  const post = (path, body, overrides = {}) => fetch(url + path, { method: 'POST', headers: { Origin: 'http://127.0.0.1:15195', 'Content-Type': 'application/json', 'X-Portal-Client': 'web', Cookie: `yy_portal=${f.sessions.alice.token}`, 'X-CSRF-Token': f.sessions.alice.csrf, ...overrides }, body: JSON.stringify(body) });
  assert.equal((await fetch(url + 'catalog')).status, 200); assert.equal((await fetch(url + 'me')).status, 401);
  assert.equal((await post('tenant/create', {}, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await post('tenant/create', {}, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await post('tenant/create', { huge: 'x'.repeat(9000) })).status, 413);
  assert.equal((await post('payments/callback', { paid: true })).status, 404);
  assert.equal((await fetch(url + 'admin', { headers: { Cookie: `yy_portal=${f.sessions.alice.token}` } })).status, 403);
  assert.equal((await post('tenant/create', { name: 'HTTP组织', slug: 'http-test', requestId: 'http-1' })).status, 200);
});

test('portal contract: public docs and isolated API schemas remain explicit; browser patterns use valid Unicode syntax', () => {
  const specification = JSON.parse(readFileSync(new URL('../../packages/api-contracts/product-portal.openapi.json', import.meta.url), 'utf8'));
  const operations = Object.values(specification.paths).flatMap(path => Object.values(path));
  assert.equal(new Set(operations.map(o => o.operationId)).size, operations.length);
  assert.equal(specification.components.securitySchemes.portalSession.name, 'yy_portal');
  assert.equal(specification.paths['/order/pay'].post.requestBody.content['application/json'].schema.properties.method.enum.includes('wechat'), false);
  const docs = JSON.parse(readFileSync(new URL('../../docs/public/product-docs.json', import.meta.url), 'utf8'));
  assert.equal(new Set(docs.map(d => d.id)).size, docs.length); assert.ok(docs.every(d => d.title && d.sections.length));
  const component = readFileSync(new URL('../../apps/product-portal/src/ProductPortal.vue', import.meta.url), 'utf8');
  assert.ok(component.includes('@click.prevent="focusMain"')); assert.ok(component.includes('<main id="main" tabindex="-1">'));
  const patterns = [...component.matchAll(/pattern="([^"]+)"/g)].map(match => new RegExp(match[1], 'v'));
  assert.equal(patterns.length, 2); assert.ok(patterns[0].test('qa-org')); assert.ok(patterns[1].test('QA_WELCOME10'));
});

test('portal navigation: public pages, document deep links and unknown locations are distinct', async () => {
  const { parsePortalHash, docLink, publicPages } = await import('../../apps/product-portal/src/portal-navigation.js');
  assert.deepEqual(parsePortalHash(''), { page: 'home', article: '', section: '' });
  assert.equal(parsePortalHash('#/product').page, 'product'); assert.equal(parsePortalHash('#/semantic').page, 'semantic');
  assert.equal(parsePortalHash('#/demo').page, 'demo'); assert.equal(parsePortalHash('#/architecture').page, 'architecture');
  assert.deepEqual(parsePortalHash(docLink('walkthrough', 'section-3')), { page: 'docs', article: 'walkthrough', section: 'section-3' });
  assert.equal(parsePortalHash('#/docs').article, 'overview');
  for (const input of ['#/bad', '#/home/extra', '#/docs/a/extra']) assert.equal(parsePortalHash(input).page, 'not-found');
  for (const path of ['billing', 'admin', 'team', 'console']) assert.equal(publicPages.includes(path), false);
});

test('portal demonstration: fixed synthetic lineage stays consistent and never invokes enterprise APIs', async () => {
  const { scenario } = await import('../../apps/product-portal/src/demo-scenario.js');
  assert.equal(scenario.kind, 'synthetic-replay'); assert.equal(scenario.steps.length, 6);
  assert.equal(new Set(scenario.objects.map(item => item.id)).size, 4);
  assert.ok(scenario.objects.every(item => item.source && item.note && item.record.includes('DEMO')));
  assert.ok(scenario.steps[4].body.includes('不能重复加总')); assert.equal(scenario.steps[5].state, '尚未执行');
  for (const name of ['WebsitePages.vue', 'DemoWorkbench.vue']) {
    const code = readFileSync(new URL(`../../apps/product-portal/src/components/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /portalRequest|fetch\(|\/api\/|v-html/);
  }
});

test('portal redesigned content: internal navigation resolves and screenshots are available', async () => {
  const { parsePortalHash } = await import('../../apps/product-portal/src/portal-navigation.js');
  const docs = JSON.parse(readFileSync(new URL('../../docs/public/product-docs.json', import.meta.url), 'utf8'));
  for (const name of ['WebsitePages.vue', 'DemoWorkbench.vue', 'DocsCenter.vue']) {
    const code = readFileSync(new URL(`../../apps/product-portal/src/components/${name}`, import.meta.url), 'utf8');
    for (const match of code.matchAll(/(?<!:)href="(#\/[^"{}]+)"/g)) {
      const route = parsePortalHash(match[1]); assert.notEqual(route.page, 'not-found', match[1]);
      if (route.page === 'docs') assert.ok(docs.some(item => item.id === route.article), match[1]);
    }
  }
  for (const name of ['semantic-review.png', 'knowledge-workspace.png']) {
    const bytes = readFileSync(new URL(`../../apps/product-portal/public/product/${name}`, import.meta.url));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  }
  assert.ok(docs.find(item => item.id === 'walkthrough').sections.some(item => item.steps && item.expected));
});

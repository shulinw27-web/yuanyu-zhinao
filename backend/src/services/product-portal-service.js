import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { reconcileProvisioning, provisioningView, requestProvisioning, cancelProvisioning, createProvisioningInspector } from './portal-provisioning-workflow.js';

const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const initial = () => ({ users: [], sessions: [], tenants: [], orders: [], ledger: [], coupons: [], invitations: [], audits: [] });
const emailOf = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const string = (value, max = 100) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
function error(code, status = 400) { throw Object.assign(new Error(code), { code, status }); }
function shape(value, allowed) { if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !allowed.includes(k))) error('INVALID_INPUT'); }
function requiredText(value, max = 100) { if (!string(value, max)) error('INVALID_INPUT'); return value.trim(); }
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) error('INVALID_AMOUNT'); return value; }
function passwordValid(value) { if (typeof value !== 'string' || value.length < 12 || value.length > 128) error('PASSWORD_POLICY'); }
async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const key = await derive(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
  return { salt, hash: key.toString('hex') };
}
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, status: u.status, platformAdmin: u.platformAdmin, emailVerified: false, createdAt: u.createdAt });
export const PORTAL_PLANS = Object.freeze([
  { id: 'explore', name: '探索版', priceCents: 0, seats: 3, discountBps: 10000, description: '验证业务场景与语义模型', features: ['租户管理空间', '3 个协作席位', '产品与技术文档'] },
  { id: 'professional', name: '专业版', priceCents: 9900, seats: 10, discountBps: 9500, description: '面向小团队的协作方案', features: ['10 个协作席位', '会员权益记录', '余额与订单管理'] },
  { id: 'business', name: '团队版', priceCents: 29900, seats: 50, discountBps: 9000, description: '面向跨部门的组织管理', features: ['50 个协作席位', '成员角色管理', '企业开通申请'] }
]);
const planById = id => PORTAL_PLANS.find(p => p.id === id);

// Commerce identity is deliberately separate from business IAM. Payment does not grant data access.
export function createProductPortalService({ read, mutate, sandboxPayments = false, clock = () => Date.now(), provisioningInspector }) {
  const now = () => clock();
  const stamp = () => new Date(now()).toISOString();
  const readStore = () => read(initial);
  const transaction = work => mutate(initial, state => {
    reconcileProvisioning(state, now());
    const result = work(state);
    reconcileProvisioning(state, now());
    if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024) error('CAPACITY_REACHED', 413);
    return { value: state, result };
  });
  const audit = (state, actorId, action, targetId) => {
    state.audits.push({ id: randomUUID(), actorId, action, targetId, at: stamp() });
    if (state.audits.length > 10000) error('CAPACITY_REACHED', 413);
  };
  function authenticate(state, sessionToken, csrf) {
    const session = typeof sessionToken === 'string' && state.sessions.find(s => s.hash === digest(sessionToken) && s.expiresAt > now());
    const user = session && state.users.find(u => u.id === session.userId && u.status === 'active');
    if (!user) error('AUTH_REQUIRED', 401);
    if (csrf !== undefined && (!string(csrf, 100) || digest(csrf) !== session.csrfHash)) error('CSRF_REJECTED', 403);
    return { user, session };
  }
  function tenantAccess(state, user, tenantId, write = false) {
    const tenant = state.tenants.find(t => t.id === tenantId);
    const member = tenant?.members.find(m => m.userId === user.id && m.status === 'active');
    if (!tenant || !member) error('TENANT_NOT_FOUND', 404);
    if (write && !['owner', 'admin'].includes(member.role)) error('TENANT_PERMISSION_DENIED', 403);
    if (write && tenant.status === 'suspended') error('TENANT_SUSPENDED', 403);
    return { tenant, member };
  }
  function activePlan(tenant) { return tenant.membership?.expiresAt > now() ? planById(tenant.membership.planId) || PORTAL_PLANS[0] : PORTAL_PLANS[0]; }
  function tenantView(state, tenant, user) {
    const member = tenant.members.find(m => m.userId === user.id && m.status === 'active');
    const manager = ['owner', 'admin'].includes(member?.role);
    return { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, createdAt: tenant.createdAt, version: tenant.version,
      role: member.role, plan: activePlan(tenant), membership: tenant.membership, balanceCents: manager ? tenant.balanceCents : null,
      runtimeConnected: false, ...(manager ? { provisioning: provisioningView(state, tenant.id) } : {}), members: tenant.members.filter(m => m.status === 'active').map(m => {
        const u = state.users.find(u => u.id === m.userId);
        return { userId: m.userId, name: u?.name, ...(manager ? { email: u?.email, accountStatus: u?.status } : {}), role: m.role };
      }) };
  }
  function quote(state, tenant, data) {
    if (!['recharge', 'subscription'].includes(data.kind)) error('INVALID_INPUT');
    let plan = null;
    let subtotalCents;
    if (data.kind === 'recharge') { if (data.couponCode || data.planId) error('COUPON_NOT_APPLICABLE'); subtotalCents = integer(data.amountCents, 100, 10000000); }
    else {
      if (data.amountCents !== undefined) error('INVALID_INPUT');
      plan = planById(data.planId); if (!plan || plan.priceCents === 0) error('PLAN_INVALID');
      if (tenant.membership?.expiresAt > now() && tenant.membership.planId !== plan.id) error('PLAN_CHANGE_REQUIRES_REVIEW', 409);
      subtotalCents = plan.priceCents;
    }
    const memberDiscount = data.kind === 'subscription' ? Math.floor(subtotalCents * (10000 - activePlan(tenant).discountBps) / 10000) : 0;
    let coupon = null; let couponDiscount = 0;
    if (data.couponCode) {
      const code = requiredText(data.couponCode, 32).toUpperCase();
      coupon = state.coupons.find(c => c.code === code && c.active && c.expiresAt > now() && c.startsAt <= now());
      if (!coupon || coupon.planId && coupon.planId !== data.planId || subtotalCents < coupon.minCents) error('COUPON_UNAVAILABLE', 409);
      const reserved = state.orders.filter(o => o.couponId === coupon.id && (o.status === 'paid' || o.status === 'pending' && o.expiresAt > now()));
      if (reserved.length >= coupon.maxUses || reserved.some(o => o.tenantId === tenant.id)) error('COUPON_UNAVAILABLE', 409);
      couponDiscount = coupon.type === 'fixed' ? Math.min(subtotalCents, coupon.value) : Math.floor(subtotalCents * coupon.value / 10000);
    }
    const discountCents = Math.max(memberDiscount, couponDiscount);
    return { kind: data.kind, planId: plan?.id || null, subtotalCents, discountCents, totalCents: subtotalCents - discountCents,
      discountSource: couponDiscount > memberDiscount ? 'coupon' : memberDiscount ? 'membership' : 'none',
      couponId: couponDiscount > memberDiscount ? coupon.id : null, currency: 'CNY', environment: 'sandbox', days: plan ? 30 : null };
  }
  async function register(body) {
    shape(body, ['email', 'password', 'name', 'acceptedTerms']);
    const email = emailOf(body.email); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) error('EMAIL_INVALID');
    const name = requiredText(body.name, 60); passwordValid(body.password);
    if (body.acceptedTerms !== true) error('TERMS_REQUIRED');
    const credentials = await passwordHash(body.password);
    return transaction(state => {
      if (state.users.some(u => u.email === email)) error('REGISTRATION_UNAVAILABLE', 409);
      if (state.users.length >= 500) error('CAPACITY_REACHED', 413);
      const user = { id: randomUUID(), email, name, credentials, status: 'active', platformAdmin: false, createdAt: stamp(), termsVersion: 'sandbox-2026-09-14' };
      state.users.push(user); audit(state, user.id, 'account.register', user.id); return { user: publicUser(user) };
    });
  }
  async function login(body) {
    shape(body, ['email', 'password']); passwordValid(body.password);
    const email = emailOf(body.email); const user = readStore().users.find(u => u.email === email);
    const computed = await passwordHash(body.password, user?.credentials.salt || '0'.repeat(32));
    const valid = user && timingSafeEqual(Buffer.from(computed.hash, 'hex'), Buffer.from(user.credentials.hash, 'hex'));
    if (!valid) error('LOGIN_FAILED', 401);
    const sessionToken = token(); const csrfToken = digest(`csrf:${sessionToken}`);
    return transaction(state => {
      const latest = state.users.find(u => u.id === user.id);
      if (!latest || latest.status !== 'active' || latest.credentials.hash !== user.credentials.hash) error('LOGIN_FAILED', 401);
      state.sessions = state.sessions.filter(s => s.expiresAt > now());
      const existing = state.sessions.filter(s => s.userId === user.id);
      if (existing.length >= 5) state.sessions = state.sessions.filter(s => s.hash !== existing[0].hash);
      state.sessions.push({ hash: digest(sessionToken), userId: user.id, csrfHash: digest(csrfToken), expiresAt: now() + 8 * 3600000 });
      audit(state, user.id, 'account.login', user.id);
      return { sessionToken, csrfToken, user: publicUser(latest) };
    });
  }
  function workspace(sessionToken) {
    const state = readStore(); const { user } = authenticate(state, sessionToken);
    const tenants = state.tenants.filter(t => t.members.some(m => m.userId === user.id && m.status === 'active'));
    const billing = tenants.filter(t => t.members.some(m => m.userId === user.id && ['owner', 'admin'].includes(m.role) && m.status === 'active')).map(t => t.id);
    return { user: publicUser(user), tenants: tenants.map(t => tenantView(state, t, user)), orders: state.orders.filter(o => billing.includes(o.tenantId)).map(o => ({ ...o, status: o.status === 'pending' && o.expiresAt <= now() ? 'expired' : o.status })).reverse(),
      ledger: state.ledger.filter(l => billing.includes(l.tenantId)).slice(-100).reverse(), sandboxPayments, environment: 'sandbox' };
  }
  function sessionCsrf(sessionToken) {
    authenticate(readStore(), sessionToken);
    // Stable for the authenticated session: loading another tab must not invalidate an in-flight form.
    return digest(`csrf:${sessionToken}`);
  }
  function rateLimitPrincipal(sessionToken) {
    // One account keeps its budget across sessions; client tenant/role headers are irrelevant.
    return authenticate(readStore(), sessionToken).user.id;
  }
  function adminWorkspace(sessionToken) {
    const state = readStore(); const { user } = authenticate(state, sessionToken); if (!user.platformAdmin) error('ADMIN_REQUIRED', 403);
    return { users: state.users.map(publicUser), tenants: state.tenants.map(t => ({ id: t.id, name: t.name, status: t.status, version: t.version, createdAt: t.createdAt, memberCount: t.members.filter(m => m.status === 'active').length })),
      coupons: state.coupons, audits: state.audits.slice(-100).reverse(), orderStats: { count: state.orders.length, sandboxPaidCents: state.orders.filter(o => o.status === 'paid').reduce((sum, o) => sum + o.totalCents, 0) } };
  }
  function perform(sessionToken, csrf, action, body) {
    return transaction(state => {
      const { user, session } = authenticate(state, sessionToken, csrf || '');
      if (action === 'logout') { shape(body, []); state.sessions = state.sessions.filter(s => s !== session); return { ok: true }; }
      if (action === 'tenant.create') {
        shape(body, ['name', 'slug', 'requestId']); const name = requiredText(body.name, 80); const slug = requiredText(body.slug, 40).toLowerCase(); const requestId = requiredText(body.requestId);
        if (!/^[a-z][a-z0-9-]{2,39}$/.test(slug)) error('SLUG_INVALID');
        const existing = state.tenants.find(t => t.createdBy === user.id && t.requestId === requestId);
        if (existing) { if (existing.name !== name || existing.slug !== slug) error('IDEMPOTENCY_CONFLICT', 409); return { tenantId: existing.id }; }
        if (state.tenants.some(t => t.slug === slug)) error('SLUG_TAKEN', 409);
        if (state.tenants.filter(t => t.createdBy === user.id).length >= 5 || state.tenants.length >= 500) error('CAPACITY_REACHED', 413);
        const tenant = { id: randomUUID(), name, slug, requestId, createdBy: user.id, createdAt: stamp(), status: 'provisioning_pending', version: 1, balanceCents: 0, membership: null,
          members: [{ userId: user.id, role: 'owner', status: 'active' }] };
        state.tenants.push(tenant); audit(state, user.id, action, tenant.id); return { tenantId: tenant.id };
      }
      if (action === 'invite.accept') {
        shape(body, ['token']); const invite = state.invitations.find(i => i.hash === digest(requiredText(body.token)) && i.expiresAt > now() && !i.used);
        if (!invite || invite.email !== user.email) error('INVITE_INVALID', 409);
        const tenant = state.tenants.find(t => t.id === invite.tenantId); if (!tenant || tenant.status === 'suspended') error('INVITE_INVALID', 409);
        const issuer = tenant.members.find(m => m.userId === invite.createdBy && m.status === 'active');
        if (!issuer || !['owner', 'admin'].includes(issuer.role) || !state.users.some(u => u.id === issuer.userId && u.status === 'active')) error('INVITE_INVALID', 409);
        if (tenant.members.some(m => m.userId === user.id && m.status === 'active')) error('ALREADY_MEMBER', 409);
        if (tenant.members.filter(m => m.status === 'active').length >= activePlan(tenant).seats) error('SEAT_LIMIT', 409);
        tenant.members = tenant.members.filter(m => m.userId !== user.id); tenant.members.push({ userId: user.id, role: invite.role, status: 'active' }); tenant.version++; invite.used = true;
        audit(state, user.id, action, tenant.id); return { tenantId: tenant.id };
      }
      if (action.startsWith('admin.')) {
        if (!user.platformAdmin) error('ADMIN_REQUIRED', 403);
        if (action === 'admin.user') {
          shape(body, ['userId', 'status']); if (!['active', 'suspended'].includes(body.status)) error('INVALID_INPUT');
          const target = state.users.find(u => u.id === body.userId); if (!target) error('USER_NOT_FOUND', 404);
          if (target.id === user.id || target.platformAdmin) error('PROTECTED_ADMIN', 409);
          target.status = body.status; target.authorizationVersion = (target.authorizationVersion || 0) + 1;
          state.sessions = state.sessions.filter(s => s.userId !== target.id); audit(state, user.id, action, target.id); return { ok: true };
        }
        if (action === 'admin.tenant') {
          shape(body, ['tenantId', 'status', 'expectedVersion']); const tenant = state.tenants.find(t => t.id === body.tenantId);
          if (!tenant) error('TENANT_NOT_FOUND', 404); if (body.expectedVersion !== tenant.version) error('VERSION_CONFLICT', 409);
          if (!['sandbox_ready', 'suspended'].includes(body.status)) error('INVALID_INPUT');
          tenant.status = body.status; tenant.version++; audit(state, user.id, action, tenant.id); return { ok: true, runtimeConnected: false };
        }
        if (action === 'admin.coupon') {
          shape(body, ['code', 'type', 'value', 'minCents', 'maxUses', 'startsAt', 'expiresAt', 'planId']);
          const code = requiredText(body.code, 32).toUpperCase(); if (!/^[A-Z0-9_-]{3,32}$/.test(code) || !['fixed', 'percent'].includes(body.type)) error('INVALID_INPUT');
          if (state.coupons.some(c => c.code === code)) error('COUPON_EXISTS', 409);
          if (state.coupons.length >= 1000) error('CAPACITY_REACHED', 413);
          integer(body.value, 1, body.type === 'percent' ? 10000 : 10000000); integer(body.minCents, 0, 10000000); integer(body.maxUses, 1, 10000);
          if (!Number.isSafeInteger(body.startsAt) || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= now() || body.expiresAt <= body.startsAt || body.expiresAt > now() + 366 * 86400000) error('COUPON_DATE_INVALID');
          if (body.planId && !planById(body.planId)?.priceCents) error('PLAN_INVALID');
          const coupon = { id: randomUUID(), ...body, code, active: true }; state.coupons.push(coupon); audit(state, user.id, action, coupon.id); return { coupon };
        }
        if (action === 'admin.coupon-disable') {
          shape(body, ['couponId']); const coupon = state.coupons.find(c => c.id === body.couponId); if (!coupon) error('COUPON_UNAVAILABLE', 404);
          coupon.active = false;
          state.orders.filter(o => o.couponId === coupon.id && o.status === 'pending').forEach(o => { o.status = 'cancelled'; });
          audit(state, user.id, action, coupon.id); return { ok: true };
        }
        error('ACTION_NOT_FOUND', 404);
      }
      if (action === 'tenant.invite') {
        shape(body, ['tenantId', 'email', 'role']); const { tenant, member } = tenantAccess(state, user, body.tenantId, true);
        if (!['member', 'admin'].includes(body.role) || body.role === 'admin' && member.role !== 'owner') error('TENANT_PERMISSION_DENIED', 403);
        const email = emailOf(body.email); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) error('EMAIL_INVALID');
        state.invitations = state.invitations.filter(i => !i.used && i.expiresAt > now()); if (state.invitations.length >= 1000) error('CAPACITY_REACHED', 413);
        const value = token(); state.invitations.push({ id: randomUUID(), hash: digest(value), tenantId: tenant.id, createdBy: user.id, email, role: body.role, expiresAt: now() + 86400000, used: false });
        audit(state, user.id, action, tenant.id); return { invitationToken: value, delivery: 'manual', expiresInHours: 24 };
      }
      if (action === 'tenant.provision' || action === 'tenant.provision-cancel') {
        shape(body, action === 'tenant.provision' ? ['tenantId', 'requestId', 'expectedVersion', 'confirmed'] : ['tenantId', 'provisioningId']);
        const { tenant } = tenantAccess(state, user, body.tenantId, true);
        if (action === 'tenant.provision') requiredText(body.requestId, 100);
        const result = action === 'tenant.provision'
          ? requestProvisioning(state, tenant, user, body, now())
          : cancelProvisioning(state, tenant.id, requiredText(body.provisioningId, 100), now());
        if (!result.duplicate) audit(state, user.id, action, result.provisioning.id);
        return result;
      }
      if (action === 'tenant.member') {
        shape(body, ['tenantId', 'userId', 'role', 'status', 'expectedVersion']); const { tenant, member } = tenantAccess(state, user, body.tenantId, true);
        if (member.role !== 'owner') error('TENANT_PERMISSION_DENIED', 403);
        if (body.expectedVersion !== tenant.version) error('VERSION_CONFLICT', 409);
        const target = tenant.members.find(m => m.userId === body.userId && m.status === 'active');
        if (!target || target.role === 'owner' || !['admin', 'member'].includes(body.role) || !['active', 'removed'].includes(body.status)) error('MEMBER_CHANGE_INVALID');
        target.role = body.role; target.status = body.status; tenant.version++; audit(state, user.id, action, target.userId); return { ok: true };
      }
      if (['order.quote', 'order.create'].includes(action)) {
        shape(body, ['tenantId', 'kind', 'planId', 'amountCents', 'couponCode', ...(action === 'order.create' ? ['requestId'] : [])]);
        if (body.couponCode !== undefined && (typeof body.couponCode !== 'string' || body.couponCode.length > 32)) error('INVALID_INPUT');
        const { tenant } = tenantAccess(state, user, body.tenantId, true);
        const requestId = action === 'order.create' ? requiredText(body.requestId) : null;
        const fingerprint = digest(JSON.stringify([body.tenantId, body.kind, body.planId || null, body.amountCents || null, body.couponCode?.trim().toUpperCase() || null]));
        const existing = requestId && state.orders.find(o => o.createdBy === user.id && o.requestId === requestId);
        if (existing) { if (existing.fingerprint !== fingerprint) error('IDEMPOTENCY_CONFLICT', 409); return { order: existing }; }
        const price = quote(state, tenant, body); if (action === 'order.quote') return { quote: price };
        if (state.orders.length >= 2000) error('CAPACITY_REACHED', 413);
        const order = { id: randomUUID(), number: `YY${now()}${randomBytes(3).toString('hex').toUpperCase()}`, tenantId: tenant.id, createdBy: user.id, requestId, fingerprint, ...price,
          status: 'pending', createdAt: stamp(), expiresAt: now() + 1800000 };
        state.orders.push(order); audit(state, user.id, action, order.id); return { order };
      }
      if (['order.pay', 'order.cancel'].includes(action)) {
        shape(body, action === 'order.pay' ? ['orderId', 'method', 'confirmed'] : ['orderId']);
        const order = state.orders.find(o => o.id === body.orderId); if (!order) error('ORDER_NOT_FOUND', 404);
        const { tenant } = tenantAccess(state, user, order.tenantId, true);
        if (action === 'order.cancel') { if (order.status !== 'pending') error('ORDER_STATE_CONFLICT', 409); order.status = 'cancelled'; audit(state, user.id, action, order.id); return { order }; }
        if (!['sandbox', 'wallet'].includes(body.method) || body.confirmed !== true) error('PAYMENT_CONFIRMATION_REQUIRED');
        if (order.status === 'paid') return { order, duplicate: true };
        if (order.status !== 'pending' || order.expiresAt <= now()) error('ORDER_STATE_CONFLICT', 409);
        if (!sandboxPayments) error('PAYMENT_NOT_CONFIGURED', 503);
        if (body.method === 'wallet' && order.kind !== 'subscription') error('PAYMENT_METHOD_INVALID');
        if (order.kind === 'subscription' && tenant.membership?.expiresAt > now() && tenant.membership.planId !== order.planId) error('PLAN_CHANGE_REQUIRES_REVIEW', 409);
        if (body.method === 'wallet' && tenant.balanceCents < order.totalCents) error('INSUFFICIENT_BALANCE', 409);
        const delta = order.kind === 'recharge' ? order.totalCents : body.method === 'wallet' ? -order.totalCents : 0;
        if (tenant.balanceCents + delta > 100000000) error('CAPACITY_REACHED', 413);
        tenant.balanceCents += delta;
        if (order.kind === 'subscription') tenant.membership = { planId: order.planId, expiresAt: Math.max(now(), tenant.membership?.expiresAt || 0) + order.days * 86400000, environment: 'sandbox' };
        tenant.version++; order.status = 'paid'; order.paidAt = stamp(); order.method = body.method; order.receipt = `sandbox:${randomUUID()}`;
        if (delta) state.ledger.push({ id: randomUUID(), tenantId: tenant.id, orderId: order.id, deltaCents: delta, balanceAfterCents: tenant.balanceCents, at: stamp(), environment: 'sandbox' });
        audit(state, user.id, action, order.id); return { order, businessPermissionsGranted: false };
      }
      error('ACTION_NOT_FOUND', 404);
    });
  }
  function bootstrapAdmin(email) {
    return transaction(state => { const user = state.users.find(u => u.email === emailOf(email) && u.status === 'active'); if (!user) error('USER_NOT_FOUND', 404);
      user.platformAdmin = true; state.sessions = state.sessions.filter(s => s.userId !== user.id); audit(state, 'local-cli', 'admin.bootstrap', user.id); return publicUser(user); });
  }
  const inspectProvisioning = createProvisioningInspector({ transaction, clock, audit, inspect: provisioningInspector });
  return { register, login, workspace, perform, adminWorkspace, sessionCsrf, rateLimitPrincipal, bootstrapAdmin, inspectProvisioning,
    catalog: () => ({ plans: PORTAL_PLANS, environment: 'sandbox', sandboxPayments, pricingPublished: false, runtimeConnected: false, emailDelivery: false }) };
}

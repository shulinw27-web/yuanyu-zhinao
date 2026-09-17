import { randomUUID } from 'node:crypto';
import { inspectTenantProvisioning } from './tenant-provisioning-preflight.js';

const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const ids = ['semantic_instance', 'business_iam', 'runtime_entitlements', 'runtime_revocation'];
const terminal = ['cancelled', 'superseded'];
const view = job => job ? Object.fromEntries(Object.entries(job).filter(([key]) => !['lease', 'leaseExpiresAt'].includes(key))) : null;

export function reconcileProvisioning(state, now) {
  state.provisioning ||= [];
  for (const job of state.provisioning) {
    if (terminal.includes(job.status)) continue;
    const tenant = state.tenants.find(t => t.id === job.tenantId);
    const user = state.users.find(u => u.id === job.requestedBy && u.status === 'active');
    const member = tenant?.members.find(m => m.userId === user?.id && m.status === 'active');
    if (!tenant || !user || !['owner', 'admin'].includes(member?.role) || tenant.status !== 'sandbox_ready' || tenant.version !== job.tenantVersion) {
      job.status = 'superseded'; job.reason = 'TENANT_OR_AUTHORIZATION_CHANGED'; job.updatedAt = new Date(now).toISOString();
      job.checks = []; delete job.lease; delete job.leaseExpiresAt;
    }
  }
}

export function provisioningView(state, tenantId) {
  return view((state.provisioning || []).filter(job => job.tenantId === tenantId).at(-1));
}

export function requestProvisioning(state, tenant, user, body, now) {
  if (body.confirmed !== true) fail('PROVISIONING_CONFIRMATION_REQUIRED', 400);
  if (tenant.status !== 'sandbox_ready') fail('PROVISIONING_REQUIRES_SANDBOX_APPROVAL');
  const existing = state.provisioning.find(job => job.tenantId === tenant.id && job.requestedBy === user.id && job.requestId === body.requestId);
  if (existing) {
    if (existing.tenantVersion !== body.expectedVersion) fail('IDEMPOTENCY_CONFLICT');
    return { provisioning: view(existing), duplicate: true, runtimeConnected: false };
  }
  if (tenant.version !== body.expectedVersion) fail('VERSION_CONFLICT');
  if (state.provisioning.some(job => job.tenantId === tenant.id && !terminal.includes(job.status))) fail('PROVISIONING_ALREADY_EXISTS');
  if (state.provisioning.length >= 2000) fail('CAPACITY_REACHED', 413);
  const stamp = new Date(now).toISOString();
  const job = { id: randomUUID(), tenantId: tenant.id, requestedBy: user.id, requestId: body.requestId, tenantVersion: tenant.version,
    status: 'requested', attempts: 0, checks: [], createdAt: stamp, updatedAt: stamp, environment: 'sandbox', runtimeConnected: false };
  state.provisioning.push(job); return { provisioning: view(job), runtimeConnected: false };
}

export function cancelProvisioning(state, tenantId, jobId, now) {
  const job = state.provisioning.find(item => item.id === jobId && item.tenantId === tenantId);
  if (!job) fail('PROVISIONING_NOT_FOUND', 404);
  if (!terminal.includes(job.status)) { job.status = 'cancelled'; job.updatedAt = new Date(now).toISOString(); delete job.lease; delete job.leaseExpiresAt; }
  return { provisioning: view(job), runtimeConnected: false };
}

export function createProvisioningInspector({ transaction, clock, audit, inspect = inspectTenantProvisioning }) {
  return async jobId => {
    const lease = randomUUID();
    const started = transaction(state => {
      const job = state.provisioning.find(item => item.id === jobId);
      if (!job) fail('PROVISIONING_NOT_FOUND', 404);
      if (terminal.includes(job.status)) fail('PROVISIONING_NOT_ACTIVE');
      if (job.status === 'checking' && job.leaseExpiresAt > clock()) fail('PROVISIONING_BUSY');
      if (job.attempts >= 10) fail('PROVISIONING_ATTEMPT_LIMIT');
      job.status = 'checking'; job.lease = lease; job.leaseExpiresAt = clock() + 30000; job.attempts++;
      job.checks = []; job.updatedAt = new Date(clock()).toISOString();
      audit(state, 'local-cli', 'provisioning.check-start', job.id);
      return { tenantId: job.tenantId };
    });
    let checks;
    let timer;
    try {
      const result = await Promise.race([inspect(started), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5000); })]);
      if (!Array.isArray(result) || result.length !== ids.length || ids.some(id => result.filter(check => check?.id === id).length !== 1)
        || result.some(check => !['passed', 'blocked'].includes(check.status) || typeof check.code !== 'string' || !/^[A-Z0-9_]{1,80}$/u.test(check.code))) throw new Error('invalid result');
      // Persist only a bounded contract, never external data, URLs, credentials or raw errors.
      checks = result.map(({ id, status, code }) => ({ id, status, code }));
    } catch { checks = ids.map(id => ({ id, status: 'blocked', code: 'PREFLIGHT_INCOMPLETE' })); }
    finally { clearTimeout(timer); }
    return transaction(state => {
      const job = state.provisioning.find(item => item.id === jobId);
      if (!job) fail('PROVISIONING_NOT_FOUND', 404);
      if (job.lease !== lease || job.leaseExpiresAt <= clock() || terminal.includes(job.status)) return { provisioning: view(job), resultDiscarded: true, runtimeConnected: false };
      job.status = checks.every(check => check.status === 'passed') ? 'preflight_ready' : 'blocked';
      job.checks = checks; job.updatedAt = new Date(clock()).toISOString(); delete job.lease; delete job.leaseExpiresAt;
      audit(state, 'local-cli', 'provisioning.check-finish', job.id);
      return { provisioning: view(job), runtimeConnected: false };
    });
  };
}

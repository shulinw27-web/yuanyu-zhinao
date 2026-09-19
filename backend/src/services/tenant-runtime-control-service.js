import { randomUUID } from 'node:crypto';
import { asyncRuntimeStateRepository } from '../repositories/async-runtime-state-repository.js';
import { readTenantPortalState } from '../config/tenant-portal-reader.js';
import { readIdentityProviderConfiguration } from '../config/identity-provider-config.js';
import { readDingTalkConfiguration } from '../config/dingtalk-config.js';
import { iamWorkspaceKey, createTenantIAMWorkspace } from './iam-workspace-model.js';
import { enrollmentDigest, runtimeDeny, validateEnrollment, portalEnrollmentEvidence, identityEnrollmentEvidence, enrollmentWorkspace } from './tenant-enrollment-contract.js';

const NS = 'tenant_runtime_control_v1';
const key = tenantId => iamWorkspaceKey(tenantId);
const empty = () => ({ revision: 0, enrollment: null, usage: { day: '', count: 0 }, audits: [] });
const enrollmentProviders = () => {
  const configuration = readIdentityProviderConfiguration();
  return configuration?.providers.some(provider => provider.id === 'dingtalk' && provider.enabled)
    ? { ...configuration, dingTalk: readDingTalkConfiguration() } : configuration;
};
const audit = (state, action, now) => {
  state.audits.push({ id: randomUUID(), action, revision: state.revision, at: new Date(now).toISOString() });
  state.audits = state.audits.slice(-200);
};

export function createTenantRuntimeControl({ repository = asyncRuntimeStateRepository, readPortal = readTenantPortalState,
  readProviders = enrollmentProviders, clock = Date.now, production = () => process.env.NODE_ENV === 'production',
  required = () => process.env.TENANT_RUNTIME_CONTROL_REQUIRED === 'true' } = {}) {
  const evidence = async manifest => ({ portal: portalEnrollmentEvidence(await readPortal(), manifest, clock()),
    providers: identityEnrollmentEvidence(await readProviders(), manifest) });
  const prepare = async input => {
    if (production()) runtimeDeny('SANDBOX_ENROLLMENT_ONLY');
    const manifest = validateEnrollment(input, clock());
    const proof = await evidence(manifest);
    const iam = await repository.readState('iam', key(manifest.tenantId)) || createTenantIAMWorkspace(manifest.tenantId);
    const state = await repository.readState(NS, key(manifest.tenantId)) || empty();
    if (!state.enrollment && (iam.users.length || iam.organizations.length || Object.keys(iam.rolePolicies).length)) runtimeDeny('EXISTING_IAM_REQUIRES_MIGRATION');
    const review = { manifest, proof, expectedIAM: enrollmentDigest(iam), expectedRevision: state.revision };
    return { digest: enrollmentDigest(review), review, summary: { tenantId: manifest.tenantId, users: manifest.users.length,
      organizations: manifest.organizations.length, features: manifest.features, dailyRequests: manifest.dailyRequests, expiresAt: manifest.expiresAt,
      roleGrants: manifest.users.map(user => ({ account: user.account, roleIds: user.roleIds })), runtimeConnected: false, environment: 'sandbox' } };
  };
  const apply = async (input, confirmedDigest) => {
    if (production()) runtimeDeny('SANDBOX_ENROLLMENT_ONLY');
    const manifest = validateEnrollment(input, clock());
    const prior = await repository.readState(NS, key(manifest.tenantId)) || empty();
    if (prior.enrollment?.approvalDigest === confirmedDigest && prior.enrollment?.manifestDigest === enrollmentDigest(manifest) && prior.enrollment.status === 'approved') {
      const proof = await evidence(manifest);
      if (enrollmentDigest(proof) !== prior.enrollment.proofDigest) runtimeDeny('ENROLLMENT_REVIEW_CHANGED');
      return { duplicate: true, revision: prior.revision, runtimeConnected: false };
    }
    const prepared = await prepare(manifest);
    if (!/^[a-f0-9]{64}$/.test(confirmedDigest || '') || confirmedDigest !== prepared.digest) runtimeDeny('ENROLLMENT_REVIEW_CHANGED');
    return repository.mutateStates([
      { name: 'iam', namespace: 'iam', key: key(manifest.tenantId), initialValue: () => createTenantIAMWorkspace(manifest.tenantId) },
      { name: 'runtime', namespace: NS, key: key(manifest.tenantId), initialValue: empty }
    ], ({ iam, runtime }) => {
      if (enrollmentDigest(iam) !== prepared.review.expectedIAM || runtime.revision !== prepared.review.expectedRevision) runtimeDeny('ENROLLMENT_REVIEW_CHANGED');
      const next = enrollmentWorkspace(manifest);
      next.configurationVersion = iam.configurationVersion + 1;
      next.users.forEach(user => { user.version = (iam.users.find(old => old.id === user.id)?.version || 0) + 1; });
      Object.values(next.rolePolicies).forEach(policy => { policy.version = (iam.rolePolicies[policy.roleId]?.version || 0) + 1; });
      next.audits = [...iam.audits, { id: randomUUID(), action: 'REVIEWED_SANDBOX_ENROLLMENT', createdAt: new Date(clock()).toISOString() }].slice(-200);
      runtime.revision++;
      runtime.enrollment = { status: 'approved', approvalDigest: confirmedDigest, manifestDigest: enrollmentDigest(manifest),
        proofDigest: enrollmentDigest(prepared.review.proof), manifest, environment: 'sandbox' };
      audit(runtime, 'enrollment.approved', clock());
      return { values: { iam: next, runtime }, result: { revision: runtime.revision, environment: 'sandbox', runtimeConnected: false } };
    });
  };
  const revoke = async (tenantId, expectedRevision) => repository.mutateState(NS, key(tenantId), empty, state => {
    if (!state.enrollment || state.revision !== expectedRevision) runtimeDeny('ENROLLMENT_REVISION_CONFLICT');
    state.enrollment.status = 'revoked'; state.revision++; audit(state, 'enrollment.revoked', clock());
    return { value: state, result: { revision: state.revision, status: 'revoked', runtimeConnected: false } };
  });
  const authorize = async (identity, { feature, consume = false, expectedRevision } = {}) => {
    const tenantId = identity?.tenantId;
    if (!tenantId) runtimeDeny('RUNTIME_TENANT_REQUIRED');
    if (tenantId === 'demo-enterprise' && production()) runtimeDeny('DEMO_RUNTIME_DISABLED');
    const state = await repository.readState(NS, key(tenantId)) || empty();
    if (!state.enrollment) {
      if (tenantId === 'demo-enterprise' || (!production() && !required())) return { managed: false, revision: null };
      runtimeDeny('RUNTIME_ENROLLMENT_REQUIRED');
    }
    const { enrollment } = state;
    if (production()) runtimeDeny('SANDBOX_ENROLLMENT_ONLY');
    if (enrollment.status !== 'approved' || enrollment.manifest.expiresAt <= clock()) runtimeDeny('RUNTIME_ENROLLMENT_REVOKED');
    if (expectedRevision !== undefined && expectedRevision !== state.revision) runtimeDeny('RUNTIME_AUTHORIZATION_STALE');
    const user = enrollment.manifest.users.find(item => item.account === identity.subjectId);
    if (!user) runtimeDeny('RUNTIME_SUBJECT_UNBOUND');
    let proof;
    try { proof = await evidence(enrollment.manifest); }
    catch { runtimeDeny('RUNTIME_SOURCE_UNAVAILABLE_OR_REVOKED'); }
    if (enrollmentDigest(proof) !== enrollment.proofDigest) runtimeDeny('RUNTIME_AUTHORIZATION_STALE');
    if (feature && !enrollment.manifest.features.includes(feature)) runtimeDeny('RUNTIME_FEATURE_NOT_ENTITLED');
    if (consume) {
      const day = new Date(clock()).toISOString().slice(0, 10);
      await repository.mutateState(NS, key(tenantId), empty, current => {
        if (current.revision !== state.revision || current.enrollment?.status !== 'approved') runtimeDeny('RUNTIME_AUTHORIZATION_STALE');
        if (current.usage.day !== day) current.usage = { day, count: 0 };
        if (current.usage.count >= enrollment.manifest.dailyRequests) runtimeDeny('RUNTIME_DAILY_QUOTA_EXCEEDED', 429);
        current.usage.count++;
        return { value: current, result: null };
      });
    }
    return { managed: true, revision: state.revision, features: [...enrollment.manifest.features], environment: 'sandbox' };
  };
  const inspect = async tenantId => {
    const state = await repository.readState(NS, key(tenantId)) || empty();
    if (!state.enrollment) return { configured: false, runtimeConnected: false };
    return { configured: true, revision: state.revision, status: state.enrollment.status, environment: 'sandbox',
      users: state.enrollment.manifest.users.length, features: state.enrollment.manifest.features,
      expiresAt: state.enrollment.manifest.expiresAt, dailyRequests: state.enrollment.manifest.dailyRequests, usage: state.usage, runtimeConnected: false };
  };
  return Object.freeze({ prepare, apply, revoke, authorize, inspect });
}

let control = createTenantRuntimeControl();
export const configureTenantRuntimeControl = options => { control = createTenantRuntimeControl(options); };
export const authorizeTenantRuntime = (...args) => control.authorize(...args);

export function tenantRuntimeFeature(path) {
  if (/^\/api\/permission-management(?:\/|$)/.test(path)) return 'iam';
  if (/^\/api\/(?:agent|semantic-operations)\/knowledge-library(?:\/|$)/.test(path)) return 'knowledge';
  if (/^\/api\/meta-models\/oa-governance(?:\/|$)/.test(path)) return 'semantic';
  if (/^\/api\/semantic-operations\/onboarding(?:\/|$)/.test(path)) return 'semantic';
  // Shared business connectors and desktop execution have not passed tenant isolation yet.
  return 'unverified_runtime';
}

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getRuntimeStoreInfo, mutateState, readState } from '../repositories/runtime-state-repository.js';
import { mutateWithDomainEvent } from '../domains/events/domain-event-outbox.js';
import { createAsyncIAMStore } from './async-iam-store.js';
import {
  CURRENT_IAM_SCHEMA_VERSION,
  IAM_NAMESPACE,
  IAM_WORKSPACE_KEY,
  createInitialIAMWorkspace,
  migrateIAMWorkspace,
  normalizeIAMAccount
} from './iam-workspace-model.js';

const clone = (value) => structuredClone(value);
const initialWorkspace = createInitialIAMWorkspace;
const requestContext = new AsyncLocalStorage();
let asyncStore = null;
let asyncRepository = null;

const workspaceFromSnapshot = (snapshot) => ({
  schemaVersion: CURRENT_IAM_SCHEMA_VERSION,
  configurationVersion: snapshot.version,
  organizations: clone(snapshot.organizations),
  users: clone(snapshot.users),
  rolePolicies: Object.fromEntries(snapshot.rolePolicies.map((policy) => [policy.roleId, clone(policy)])),
  audits: clone(snapshot.audits)
});

export function configureIAMRepository(repository) {
  asyncRepository = repository;
  asyncStore = repository ? createAsyncIAMStore({ repository }) : null;
}

export const getIAMStoreInfo = () => asyncRepository?.getInfo?.() || getRuntimeStoreInfo();
export const probeIAMStore = async () => asyncRepository?.probe ? asyncRepository.probe() : { ready: true };

export async function runWithIAMStoreContext(operation) {
  if (!asyncStore) return operation();
  const snapshot = await asyncStore.getSnapshot();
  return requestContext.run({ workspace: workspaceFromSnapshot(snapshot) }, operation);
}

const refreshRequestWorkspace = async () => {
  const context = requestContext.getStore();
  if (asyncStore && context) context.workspace = workspaceFromSnapshot(await asyncStore.getSnapshot());
};

const workspace = () => {
  if (asyncStore) {
    const context = requestContext.getStore();
    if (!context?.workspace) {
      const error = new Error('PostgreSQL IAM reads require a request-scoped snapshot.');
      error.code = 'IAM_REQUEST_CONTEXT_REQUIRED';
      throw error;
    }
    return context.workspace;
  }
  const current = readState(IAM_NAMESPACE, IAM_WORKSPACE_KEY, initialWorkspace);
  if (Number(current.schemaVersion || 1) >= CURRENT_IAM_SCHEMA_VERSION) return current;
  return mutateState(IAM_NAMESPACE, IAM_WORKSPACE_KEY, initialWorkspace, (state) => {
    migrateIAMWorkspace(state);
    return { value: state, result: clone(state) };
  });
};

export const getIAMVersion = () => workspace().configurationVersion;
export const getIAMOrganizations = () => clone(workspace().organizations);
export const getIAMUsers = () => clone(workspace().users);
export const getIAMRolePolicies = () => clone(Object.values(workspace().rolePolicies));
export const getIAMAudits = (limit = 50) => clone(workspace().audits.slice(0, Math.max(0, Number(limit) || 0)));

export function getIAMUser(userId) {
  const user = workspace().users.find((item) => item.id === userId);
  return user ? clone(user) : null;
}

export function findIAMUserByAccount(account) {
  const normalized = normalizeIAMAccount(account);
  const user = workspace().users.find((item) => item.account === normalized);
  return user ? clone(user) : null;
}

export function findIAMUserBySubject(subjectId) {
  const normalized = normalizeIAMAccount(subjectId);
  const user = workspace().users.find((item) => item.id === subjectId || item.account === normalized);
  return user ? clone(user) : null;
}

export function findActiveIAMUserForRole(roleId) {
  const user = workspace().users.find((item) => item.status === 'active' && item.roleIds.includes(roleId));
  return user ? clone(user) : null;
}

export function getIAMRolePolicy(roleId) {
  const policy = workspace().rolePolicies[roleId];
  return policy ? clone(policy) : null;
}

export async function updateIAMUser(userId, nextValue, expectedVersion, domainEvent) {
  if (asyncStore) {
    const result = await asyncStore.updateUser(userId, nextValue, expectedVersion, domainEvent);
    if (!result?.error) await refreshRequestWorkspace();
    return result;
  }
  const mutation = (state) => {
    const index = state.users.findIndex((item) => item.id === userId);
    if (index < 0) return { commit: false, result: { error: '未找到需要更新的人员。', code: 'USER_NOT_FOUND' } };
    if (!Number.isInteger(expectedVersion) || state.users[index].version !== expectedVersion) {
      return { commit: false, result: { error: '人员信息已被其他操作更新，请刷新后重试。', code: 'VERSION_CONFLICT', currentVersion: state.users[index].version } };
    }
    const previous = clone(state.users[index]);
    const removesActiveExecutive = previous.status === 'active' && previous.roleIds.includes('executive')
      && (nextValue.status !== 'active' || !nextValue.roleIds.includes('executive'));
    const activeExecutiveCount = state.users.filter((item) => item.status === 'active' && item.roleIds.includes('executive')).length;
    if (removesActiveExecutive && activeExecutiveCount <= 1) {
      return { commit: false, result: { error: '不能移除或停用最后一个管理层账号。', code: 'LAST_EXECUTIVE_GUARD' } };
    }
    state.users[index] = { ...clone(nextValue), id: previous.id, account: previous.account, version: previous.version + 1 };
    state.configurationVersion += 1;
    const result = { before: previous, user: clone(state.users[index]), version: state.configurationVersion };
    return { value: state, result, ...(domainEvent ? { event: typeof domainEvent === 'function' ? domainEvent(result) : domainEvent } : {}) };
  };
  return domainEvent
    ? mutateWithDomainEvent({ namespace: IAM_NAMESPACE, key: IAM_WORKSPACE_KEY, initialValue: initialWorkspace, mutation })
    : mutateState(IAM_NAMESPACE, IAM_WORKSPACE_KEY, initialWorkspace, mutation);
}

export async function updateIAMRolePolicy(roleId, nextValue, expectedVersion, domainEvent) {
  if (asyncStore) {
    const result = await asyncStore.updateRolePolicy(roleId, nextValue, expectedVersion, domainEvent);
    if (!result?.error) await refreshRequestWorkspace();
    return result;
  }
  const mutation = (state) => {
    const current = state.rolePolicies[roleId];
    if (!current) return { commit: false, result: { error: '未找到需要更新的角色策略。', code: 'ROLE_POLICY_NOT_FOUND' } };
    if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
      return { commit: false, result: { error: '角色策略已被其他操作更新，请刷新后重试。', code: 'VERSION_CONFLICT', currentVersion: current.version } };
    }
    const previous = clone(current);
    const updated = { ...clone(nextValue), roleId, version: current.version + 1 };
    state.rolePolicies[roleId] = updated;
    state.configurationVersion += 1;
    const result = { before: previous, policy: clone(updated), version: state.configurationVersion };
    return { value: state, result, ...(domainEvent ? { event: typeof domainEvent === 'function' ? domainEvent(result) : domainEvent } : {}) };
  };
  return domainEvent
    ? mutateWithDomainEvent({ namespace: IAM_NAMESPACE, key: IAM_WORKSPACE_KEY, initialValue: initialWorkspace, mutation })
    : mutateState(IAM_NAMESPACE, IAM_WORKSPACE_KEY, initialWorkspace, mutation);
}

export async function appendIAMAudit(event) {
  if (asyncStore) {
    const result = await asyncStore.appendAudit(event);
    await refreshRequestWorkspace();
    return result;
  }
  return mutateState(IAM_NAMESPACE, IAM_WORKSPACE_KEY, initialWorkspace, (state) => {
    const audit = {
      id: event.id || `iam-audit-${randomUUID()}`,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      actorRoleId: event.actorRoleId,
      actorSubjectId: event.actorSubjectId || 'unknown',
      reason: event.reason || '未填写原因',
      before: event.before === undefined ? null : clone(event.before),
      after: event.after === undefined ? null : clone(event.after),
      result: event.result || 'success',
      createdAt: event.createdAt || new Date().toISOString()
    };
    state.audits.unshift(audit);
    state.audits = state.audits.slice(0, 200);
    return { value: state, result: clone(audit) };
  });
}

export function getIAMSnapshot() {
  const state = workspace();
  return {
    version: state.configurationVersion,
    organizations: clone(state.organizations),
    users: clone(state.users),
    rolePolicies: clone(Object.values(state.rolePolicies)),
    audits: clone(state.audits.slice(0, 50))
  };
}

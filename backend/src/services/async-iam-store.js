import { randomUUID } from 'node:crypto';
import {
  DOMAIN_EVENT_NAMESPACE,
  DOMAIN_EVENT_WORKSPACE_KEY,
  appendDomainEventToWorkspace,
  initialDomainEventWorkspace
} from '../domains/events/domain-event-outbox.js';
import {
  CURRENT_IAM_SCHEMA_VERSION,
  IAM_NAMESPACE,
  IAM_WORKSPACE_KEY,
  createInitialIAMWorkspace,
  migrateIAMWorkspace,
  normalizeIAMAccount
} from './iam-workspace-model.js';

const clone = (value) => structuredClone(value);

export function createAsyncIAMStore({ repository, clock = () => new Date().toISOString(), createId = randomUUID } = {}) {
  if (!repository || typeof repository.readState !== 'function' || typeof repository.mutateState !== 'function' || typeof repository.mutateStates !== 'function') {
    throw new TypeError('Async IAM store requires an asynchronous runtime state repository.');
  }

  const loadWorkspace = async () => {
    const current = await repository.readState(IAM_NAMESPACE, IAM_WORKSPACE_KEY, createInitialIAMWorkspace);
    if (Number(current.schemaVersion || 1) >= CURRENT_IAM_SCHEMA_VERSION) return current;
    return repository.mutateState(IAM_NAMESPACE, IAM_WORKSPACE_KEY, createInitialIAMWorkspace, (state) => {
      migrateIAMWorkspace(state, { createId, clock });
      return { value: state, result: clone(state) };
    });
  };

  const mutateAggregate = async (mutation, domainEvent) => {
    if (!domainEvent) return repository.mutateState(IAM_NAMESPACE, IAM_WORKSPACE_KEY, createInitialIAMWorkspace, mutation);
    return repository.mutateStates([
      { name: 'aggregate', namespace: IAM_NAMESPACE, key: IAM_WORKSPACE_KEY, initialValue: createInitialIAMWorkspace },
      { name: 'outbox', namespace: DOMAIN_EVENT_NAMESPACE, key: DOMAIN_EVENT_WORKSPACE_KEY, initialValue: initialDomainEventWorkspace }
    ], ({ aggregate, outbox }, versions) => {
      const outcome = mutation(aggregate, versions.aggregate) || {};
      if (outcome.commit === false) return { commit: false, result: outcome.result };
      const nextAggregate = Object.hasOwn(outcome, 'value') ? outcome.value : aggregate;
      const event = typeof domainEvent === 'function' ? domainEvent(outcome.result, nextAggregate) : domainEvent;
      appendDomainEventToWorkspace(outbox, event);
      return { values: { aggregate: nextAggregate, outbox }, result: outcome.result };
    });
  };

  const updateUser = async (userId, nextValue, expectedVersion, domainEvent) => mutateAggregate((state) => {
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
    return { value: state, result: { before: previous, user: clone(state.users[index]), version: state.configurationVersion } };
  }, domainEvent);

  const updateRolePolicy = async (roleId, nextValue, expectedVersion, domainEvent) => mutateAggregate((state) => {
    const current = state.rolePolicies[roleId];
    if (!current) return { commit: false, result: { error: '未找到需要更新的角色策略。', code: 'ROLE_POLICY_NOT_FOUND' } };
    if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
      return { commit: false, result: { error: '角色策略已被其他操作更新，请刷新后重试。', code: 'VERSION_CONFLICT', currentVersion: current.version } };
    }
    const previous = clone(current);
    const updated = { ...clone(nextValue), roleId, version: current.version + 1 };
    state.rolePolicies[roleId] = updated;
    state.configurationVersion += 1;
    return { value: state, result: { before: previous, policy: clone(updated), version: state.configurationVersion } };
  }, domainEvent);

  const appendAudit = async (event) => repository.mutateState(IAM_NAMESPACE, IAM_WORKSPACE_KEY, createInitialIAMWorkspace, (state) => {
    const audit = {
      id: event.id || `iam-audit-${createId()}`,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      actorRoleId: event.actorRoleId,
      actorSubjectId: event.actorSubjectId || 'unknown',
      reason: event.reason || '未填写原因',
      before: event.before === undefined ? null : clone(event.before),
      after: event.after === undefined ? null : clone(event.after),
      result: event.result || 'success',
      createdAt: event.createdAt || clock()
    };
    state.audits.unshift(audit);
    state.audits = state.audits.slice(0, 200);
    return { value: state, result: clone(audit) };
  });

  return Object.freeze({
    getVersion: async () => (await loadWorkspace()).configurationVersion,
    getOrganizations: async () => clone((await loadWorkspace()).organizations),
    getUsers: async () => clone((await loadWorkspace()).users),
    getRolePolicies: async () => clone(Object.values((await loadWorkspace()).rolePolicies)),
    getAudits: async (limit = 50) => clone((await loadWorkspace()).audits.slice(0, Math.max(0, Number(limit) || 0))),
    getUser: async (userId) => clone((await loadWorkspace()).users.find((item) => item.id === userId) || null),
    findUserByAccount: async (account) => clone((await loadWorkspace()).users.find((item) => item.account === normalizeIAMAccount(account)) || null),
    findUserBySubject: async (subjectId) => {
      const normalized = normalizeIAMAccount(subjectId);
      return clone((await loadWorkspace()).users.find((item) => item.id === subjectId || item.account === normalized) || null);
    },
    findActiveUserForRole: async (roleId) => clone((await loadWorkspace()).users.find((item) => item.status === 'active' && item.roleIds.includes(roleId)) || null),
    getRolePolicy: async (roleId) => clone((await loadWorkspace()).rolePolicies[roleId] || null),
    updateUser,
    updateRolePolicy,
    appendAudit,
    getSnapshot: async () => {
      const state = await loadWorkspace();
      return { version: state.configurationVersion, organizations: clone(state.organizations), users: clone(state.users), rolePolicies: clone(Object.values(state.rolePolicies)), audits: clone(state.audits.slice(0, 50)) };
    }
  });
}

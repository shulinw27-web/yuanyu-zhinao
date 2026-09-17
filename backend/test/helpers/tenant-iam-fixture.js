import { getRuntimeStoreInfo, writeState } from '../../src/repositories/runtime-state-repository.js';
import { createInitialIAMWorkspace, iamWorkspaceKey } from '../../src/services/iam-workspace-model.js';

// Explicit synthetic provisioning for tests only; production tenants start empty.
export function seedTenantIAM(tenantId, accounts = ['quality@demo.local', 'production@demo.local']) {
  if (!process.env.NODE_TEST_CONTEXT || getRuntimeStoreInfo().driver !== 'memory') throw new Error('Synthetic IAM fixture requires test memory storage.');
  const state = createInitialIAMWorkspace();
  state.users = state.users.filter(user => accounts.includes(user.account));
  const roleIds = new Set(state.users.flatMap(user => user.roleIds));
  state.rolePolicies = Object.fromEntries(Object.entries(state.rolePolicies).filter(([id]) => roleIds.has(id)));
  state.audits = [];
  writeState('iam', iamWorkspaceKey(tenantId), state);
  return state;
}

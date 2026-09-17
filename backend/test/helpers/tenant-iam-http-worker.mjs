import { seedTenantIAM } from './tenant-iam-fixture.js';
import { writeState } from '../../src/repositories/runtime-state-repository.js';
import { iamWorkspaceKey } from '../../src/services/iam-workspace-model.js';
import { issueIdentitySession } from '../../src/services/identity-session-service.js';
import { runWithIAMStoreContext, getIAMRolePolicy, updateIAMRolePolicy } from '../../src/services/iam-store.js';

if (!process.send || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Test worker only.');
const sessions = {};
for (const tenantId of ['http-a', 'http-b']) {
  const state = seedTenantIAM(tenantId, ['admin@demo.local']);
  state.users[0].name = tenantId;
  writeState('iam', iamWorkspaceKey(tenantId), state);
  sessions[tenantId] = (await issueIdentitySession({ source: 'test', tenantId, account: 'admin@demo.local', roleId: 'executive', deviceId: 'test-device' })).id;
}
await import('../../src/app.js');
process.send({ sessions });
process.on('message', async message => {
  if (message !== 'change-a-policy') return;
  await runWithIAMStoreContext(async () => {
    const policy = getIAMRolePolicy('executive');
    await updateIAMRolePolicy('executive', policy, policy.version);
  }, 'http-a');
  process.send({ changed: true });
});

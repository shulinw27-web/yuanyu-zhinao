import { seedTenantIAM } from './tenant-iam-fixture.js';
import { writeState } from '../../src/repositories/runtime-state-repository.js';
import { iamWorkspaceKey } from '../../src/services/iam-workspace-model.js';
import { issueIdentitySession } from '../../src/services/identity-session-service.js';
import { runWithIAMStoreContext, getIAMRolePolicy, updateIAMRolePolicy, findIAMUserByAccount } from '../../src/services/iam-store.js';
import { runWithSemanticTenant, semanticTenantStateKey } from '../../src/services/semantic-tenant-context.js';
import { semanticModelRegistry } from '../../src/services/semantic-model-registry.js';
import { mutateSemanticGovernanceState, mutateSemanticGovernanceStates } from '../../src/services/semantic-governance-store.js';
import { semanticPreviewRequests } from '../../src/domains/governance/model-preview-requests.js';
import { modelSystemMaterials } from '../../src/domains/governance/model-system-materials.js';
import { modelWorkspaces } from '../../src/domains/governance/model-workspaces.js';
import { createSemanticOperationsTask } from '../../src/services/semantic-operations-task-service.js';
import { getEffectiveAccess } from '../../src/services/access-control-service.js';
import { getRole } from '../../src/services/authorization-service.js';
import { semanticFingerprint } from '../../src/services/semantic-model-fingerprint.js';
import { getOAMetaModelRuntimeTransactionEntry } from '../../src/services/meta-model-service.js';

if (!process.send || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Test worker only.');
const sessions = {};
const fixtureTenants = process.env.SEMANTIC_TEST_HTTP_TENANTS ? JSON.parse(process.env.SEMANTIC_TEST_HTTP_TENANTS) : ['http-a', 'http-b'];
if (!Array.isArray(fixtureTenants) || fixtureTenants.length !== 2 || fixtureTenants.some(id => typeof id !== 'string' || !/^synthetic-[ab]$|^http-[ab]$/u.test(id))) throw new Error('Invalid isolated HTTP fixture tenants.');
for (const tenantId of fixtureTenants) {
  const state = seedTenantIAM(tenantId, ['admin@demo.local']);
  state.users[0].name = tenantId;
  writeState('iam', iamWorkspaceKey(tenantId), state);
  sessions[tenantId] = (await issueIdentitySession({ source: 'test', tenantId, account: 'admin@demo.local', roleId: 'executive', deviceId: 'test-device' })).id;
}
await import('../../src/app.js');
process.send({ sessions });
process.on('message', async message => {
  if (message === 'seed-published-catalog') {
    const readers = {}; const grants = {};
    for (const tenantId of fixtureTenants) {
      seedTenantIAM(tenantId, ['admin@demo.local', 'quality@demo.local']);
      const admin = { tenantId, subjectId: 'admin@demo.local' };
      await runWithSemanticTenant(admin, async () => {
        const registered = await modelWorkspaces.register({ identityScope: admin, body: { id: 'catalog-model', label: `${tenantId}模型`, expectedRevision: 0 } });
        if (registered.error) throw new Error('Synthetic catalog registration failed');
        await semanticModelRegistry.withWorkspace({ role: getRole('executive'), identityScope: admin, modelId: 'catalog-model', work: async () => {
          const draft = { objectTypes: [{ id: 'Lot', label: `${tenantId}批次`, key: 'id', fields: ['id'], sourceSystems: ['WMS'] }], relationshipTypes: [] };
          const fingerprint = semanticFingerprint(draft); const version = 'synthetic-v1';
          await mutateSemanticGovernanceStates([getOAMetaModelRuntimeTransactionEntry(), { name: 'lock', namespace: 'ontology_publication', key: 'current', initialValue: null }], values => {
            values.oaRuntime.publishedModel = { tenantId, modelId: 'catalog-model', version, fingerprint, publishedAt: '2026-10-18T00:00:00.000Z', draft };
            values.lock = { modelId: 'catalog-model', status: 'completed', version, fingerprint, target: { tenantId, modelId: 'catalog-model', deploymentId: 'synthetic-catalog' } };
            return { values };
          });
        } });
      });
      readers[tenantId] = (await issueIdentitySession({ source: 'test', tenantId, account: 'quality@demo.local', roleId: 'quality_manager', deviceId: 'test-device' })).id;
      grants[tenantId] = { quality_manager: { models: { 'catalog-model': { schemaVersion: 'ontology-model-grant.v1', modelId: 'catalog-model', metadata: true, objects: {} } } } };
    }
    process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(grants);
    process.send({ readers }); return;
  }
  if (message === 'remove-b-publish') {
    await runWithIAMStoreContext(async () => {
      const policy = getIAMRolePolicy('executive');
      policy.buttonPermissionIds = policy.buttonPermissionIds.filter(id => id !== 'meta_model.publish');
      await updateIAMRolePolicy('executive', policy, policy.version);
    }, 'http-b');
    const session = await issueIdentitySession({ source: 'test', tenantId: 'http-b', account: 'admin@demo.local', roleId: 'executive', deviceId: 'test-device' });
    process.send({ session: session.id }); return;
  }
  if (message === 'seed-prepared-previews') {
    const prepared = {};
    for (const tenantId of ['http-a', 'http-b']) await runWithIAMStoreContext(async () => {
      const identityScope = { tenantId, subjectId: findIAMUserByAccount('admin@demo.local').account }; const role = getRole('executive');
      await runWithSemanticTenant(identityScope, () => semanticModelRegistry.withWorkspace({ identityScope, role, modelId: 'supply-chain', work: async () => {
        const binding = { identityScope, roleId: role.id, requestId: '42345678-1234-4123-8123-123456789abc', inputFingerprint: (tenantId === 'http-a' ? 'c' : 'd').repeat(64) };
        await semanticPreviewRequests.reserve(binding); let checkpoint;
        const interrupted = await createSemanticOperationsTask({ identityScope, role, accessContext: getEffectiveAccess(null, identityScope), structuredPreview: true,
          body: { text: '根据WMS接口建立库存语义模型', systemCodes: ['WMS'] },
          checkpointPreparedTask: async task => { checkpoint = await semanticPreviewRequests.checkpointPreparedTask({ ...binding, task }); return checkpoint; },
          commitPreparedTask: async () => ({ code: 'SYNTHETIC_COMMIT_INTERRUPTED', status: 409 }) });
        if (interrupted.code !== 'SYNTHETIC_COMMIT_INTERRUPTED') throw new Error('Synthetic preparation failed');
        prepared[tenantId] = { requestId: binding.requestId, inputFingerprint: binding.inputFingerprint, expectedCheckpointFingerprint: checkpoint.checkpointFingerprint,
          expectedDraftFingerprint: (await modelWorkspaces.draft({ identityScope, modelId: 'supply-chain' })).draft.fingerprint };
      } }));
    }, tenantId);
    process.send({ prepared }); return;
  }
  if (message === 'seed-scoped-tasks' || message === 'seed-preview-tasks' || message === 'seed-adoption-tasks') {
    const previews = {};
    for (const tenantId of ['http-a', 'http-b']) await runWithIAMStoreContext(async () => {
      const identityScope = { tenantId, subjectId: findIAMUserByAccount('admin@demo.local').account };
      await runWithSemanticTenant(identityScope, () => semanticModelRegistry.withWorkspace({ identityScope, role: { id: 'executive' }, modelId: 'supply-chain',
        work: async () => {
          if (message === 'seed-scoped-tasks') {
          await semanticPreviewRequests.reserve({ identityScope, roleId: 'executive', requestId: '12345678-1234-4123-8123-123456789abc', inputFingerprint: (tenantId === 'http-a' ? 'a' : 'b').repeat(64) });
          await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, () => ({ value: { 'http-task': {
          id: 'http-task', modelId: 'supply-chain', owner: JSON.stringify([tenantId, identityScope.subjectId]),
          status: tenantId === 'http-a' ? 'completed' : 'waiting_confirmation', requiredPermission: 'meta_model.draft.save',
          createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z', request: 'PRIVATE-SYNTHETIC-TEXT', response: 'PRIVATE-SYNTHETIC-REPLY', events: []
        } }, result: true }));
          } else {
          const adoption = message === 'seed-adoption-tasks';
          const schemas = adoption ? { InventoryLot: { type: 'object', 'x-primary-key': 'inventoryLotId', properties: { inventoryLotId: { type: 'string' }, quantity: { type: 'number' } } } }
            : { StockRecord: { type: 'object', 'x-primary-key': 'id', properties: { id: { type: 'string' }, quantity: { type: 'number' } } } };
          writeState('system_access_runtime', semanticTenantStateKey('system_documents'), { WMS: { warnings: [], documents: [{ name: 'synthetic-wms.json', mimeType: 'application/json', text: JSON.stringify({ openapi: '3.0.0', 'x-source-system': 'WMS', components: { schemas } }) }] } });
          const options = { identityScope, modelId: 'supply-chain' };
          const sources = await modelSystemMaterials.inspect({ ...options, body: { systemCodes: ['WMS'] } });
          await modelSystemMaterials.bind({ ...options, body: { systemCodes: ['WMS'], confirmed: true, expectedRevision: sources.revision, expectedSourceFingerprint: sources.sourceFingerprint } });
          const draft = await modelWorkspaces.draft(options);
          const preview = await modelWorkspaces.previewModelTask({ ...options, body: { confirmed: true, requestId: adoption ? '52345678-1234-4123-8123-123456789abc' : '22345678-1234-4123-8123-123456789abc', text: '根据WMS接口建立库存语义模型', systemCodes: ['WMS'], expectedDraftFingerprint: draft.draft.fingerprint } });
          if (preview.error) throw new Error(preview.code);
          previews[tenantId] = { taskId: preview.task.id, fingerprint: preview.taskFingerprint };
          }
        } }));
    }, tenantId);
    process.send({ seeded: true, previews }); return;
  }
  if (message !== 'change-a-policy') return;
  await runWithIAMStoreContext(async () => {
    const policy = getIAMRolePolicy('executive');
    await updateIAMRolePolicy('executive', policy, policy.version);
  }, 'http-a');
  process.send({ changed: true });
});

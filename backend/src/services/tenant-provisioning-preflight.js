import { runWithSemanticTenant } from './semantic-tenant-context.js';
import { semanticInstanceConnection, requestSemanticInstance } from './semantic-instance-transport.js';

// Read-only deployment preflight. This never creates identities or turns commerce into IAM.
export async function inspectTenantProvisioning({ tenantId }) {
  let semantic = { id: 'semantic_instance', status: 'blocked', code: 'TENANT_INSTANCE_NOT_CONFIGURED' };
  try {
    await runWithSemanticTenant({ tenantId }, async () => {
      const connection = semanticInstanceConnection();
      if (connection.reason || !connection.guarded) return;
      const result = await requestSemanticInstance(connection, '/instance');
      if (result.status === 'ready' && result.engine === 'semantica' && result.storage === 'sqlite-snapshot'
        && result.durable === true && result.storageStatus === 'ready' && Number.isSafeInteger(result.revision) && result.revision >= 1
        && result.instance?.identityVerified && result.instance.tenantId === tenantId) {
        semantic = { id: 'semantic_instance', status: 'passed', code: 'DURABLE_INSTANCE_VERIFIED' };
      } else semantic.code = 'TENANT_INSTANCE_NOT_DURABLE_OR_READY';
    });
  } catch { semantic.code = 'TENANT_INSTANCE_CHECK_FAILED'; }
  return [semantic,
    { id: 'business_iam', status: 'blocked', code: 'TENANT_IAM_BINDING_NOT_IMPLEMENTED' },
    { id: 'runtime_entitlements', status: 'blocked', code: 'RUNTIME_ENTITLEMENTS_NOT_IMPLEMENTED' },
    { id: 'runtime_revocation', status: 'blocked', code: 'RUNTIME_REVOCATION_NOT_IMPLEMENTED' }];
}

import { runWithIAMStoreContext, getIAMVersion } from './iam-store.js';
import { runWithSemanticTenant } from './semantic-tenant-context.js';
import { authorizeTenantRuntime } from './tenant-runtime-control-service.js';
import { getEffectiveAccess } from './access-control-service.js';

// Check before dispatch and before accepting a result. This cannot undo a request already sent.
export async function runWithTenantExecution({ identity, roleId, feature, permission }, operation) {
  const admitted = await authorizeTenantRuntime(identity, { feature, consume: true });
  const execute = async () => {
    const version = getIAMVersion();
    if (admitted.managed && !getEffectiveAccess(roleId, identity).pagePermissionIds.includes(permission)) {
      throw Object.assign(new Error('运行权限已撤销。'), { code: 'RUNTIME_PERMISSION_REVOKED', status: 403 });
    }
    const result = await operation();
    await authorizeTenantRuntime(identity, { feature, expectedRevision: admitted.managed ? admitted.revision : undefined });
    if (admitted.managed) await runWithIAMStoreContext(() => {
      if (getIAMVersion() !== version) throw Object.assign(new Error('执行期间权限已变化。'), { code: 'RUNTIME_PERMISSION_REVOKED', status: 403 });
    }, identity.tenantId);
    return result;
  };
  return runWithIAMStoreContext(() => runWithSemanticTenant(identity, execute), identity.tenantId);
}

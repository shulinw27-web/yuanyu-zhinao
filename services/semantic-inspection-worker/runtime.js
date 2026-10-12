import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { getEffectiveAccess } from '../../backend/src/services/access-control-service.js';
import { getIAMVersion, runWithIAMStoreContext } from '../../backend/src/services/iam-store.js';
import { getRole } from '../../backend/src/services/authorization-service.js';
import { runWithSemanticTenant } from '../../backend/src/services/semantic-tenant-context.js';
import { runRegisteredSemanticInspectionCycle, runSemanticInspectionCycle } from '../../backend/src/services/semantic-inspection-schedule-service.js';
import { inspectSemanticReadOnly } from '../../backend/src/services/semantic-read-only-inspection.js';

const failure = code => Object.assign(new Error('巡检启动绑定或权限无效；未回退默认工作区。'), { code });
const validIdentity = value => typeof value === 'string' && value === value.trim() && value.length > 0
  && value.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(value);

// This is a server-admin file, not an HTTP payload and not an IAM grant.
export async function loadInspectionWorkerBinding(env = process.env) {
  const path = env.SEMANTIC_INSPECTION_BINDING_FILE;
  if (path === undefined) {
    if (env.NODE_ENV === 'production') throw failure('SEMANTIC_INSPECTION_BINDING_REQUIRED');
    return null;
  }
  if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path)) throw failure('SEMANTIC_INSPECTION_BINDING_INVALID');
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 16384) throw failure('SEMANTIC_INSPECTION_BINDING_INVALID');
    const content = await readFile(path, 'utf8');
    if (Buffer.byteLength(content) > 16384) throw failure('SEMANTIC_INSPECTION_BINDING_INVALID');
    const binding = JSON.parse(content);
    if (!binding || Array.isArray(binding) || Object.keys(binding).some(key => !['version', 'tenantId', 'subjectId', 'modelIds', 'maxRuns'].includes(key))
      || binding.version !== 1 || !validIdentity(binding.tenantId) || !validIdentity(binding.subjectId)
      || !Array.isArray(binding.modelIds) || !binding.modelIds.length || binding.modelIds.length > 32
      || new Set(binding.modelIds).size !== binding.modelIds.length
      || binding.modelIds.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(id))
      || binding.maxRuns !== undefined && (!Number.isSafeInteger(binding.maxRuns) || binding.maxRuns < 1 || binding.maxRuns > 100)) throw failure('SEMANTIC_INSPECTION_BINDING_INVALID');
    return { identityScope: { tenantId: binding.tenantId, subjectId: binding.subjectId, platform: 'semantic-inspection-worker' }, modelIds: binding.modelIds, maxRuns: binding.maxRuns ?? 10 };
  } catch { throw failure('SEMANTIC_INSPECTION_BINDING_INVALID'); }
}

const verifyAuthority = identityScope => runWithIAMStoreContext(() => {
  const access = getEffectiveAccess(null, identityScope);
  if (!access.principalResolved || !access.roleIds.includes('executive') || !access.pagePermissionIds.includes('page.semantic-operations.view')) throw failure('SEMANTIC_INSPECTION_BINDING_FORBIDDEN');
  return getIAMVersion();
}, identityScope.tenantId);

export async function runInspectionWorkerCycle({ env = process.env, workerId, executeInspection = inspectSemanticReadOnly } = {}) {
  const binding = await loadInspectionWorkerBinding(env);
  if (!binding) return runSemanticInspectionCycle({ workerId, executeInspection });
  const { identityScope, modelIds, maxRuns } = binding;
  await verifyAuthority(identityScope);
  const result = await runWithIAMStoreContext(() => runWithSemanticTenant(identityScope, () => runRegisteredSemanticInspectionCycle({
    role: getRole('executive'), identityScope, modelIds, maxRuns, workerId,
    executeInspection: async schedule => {
      const version = await verifyAuthority(identityScope);
      const inspected = await executeInspection(schedule);
      if (await verifyAuthority(identityScope) !== version) throw failure('SEMANTIC_INSPECTION_BINDING_FORBIDDEN');
      return inspected;
    }
  })), identityScope.tenantId);
  if (result.error) throw failure(result.code);
  await verifyAuthority(identityScope);
  return { processed: result.processed, modelCount: modelIds.length };
}

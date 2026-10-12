import { getEffectiveAccess } from '../../services/access-control-service.js';
import { getRole } from '../../services/authorization-service.js';
import { runWithIAMStoreContext, getIAMVersion } from '../../services/iam-store.js';
import { currentSemanticTenant, DEFAULT_SEMANTIC_MODEL_ID } from '../../services/semantic-tenant-context.js';
import { semanticModelRegistry } from '../../services/semantic-model-registry.js';
import { assertCurrentSemanticModelAdmission } from '../../services/semantic-model-reference.js';
import { getOAMetaModelDraft } from '../../services/meta-model-service.js';
import { semanticFingerprint } from '../../services/semantic-model-fingerprint.js';
import { readSemanticGovernanceState } from '../../services/semantic-governance-store.js';
import { semanticInstanceConnection } from '../../services/semantic-instance-transport.js';
import { getSemanticaModelDeployment, publishSemanticaModelDefinition } from '../../services/semantica-demo-bridge-service.js';
import { publishGovernedOntology } from '../../services/ontology-runtime-service.js';

const denied = (code, status = 403) => ({ error: '本机模型发布复验未通过，请重新检查权限、草稿和部署状态。', code, status });
const authority = identity => runWithIAMStoreContext(() => {
  const access = getEffectiveAccess(null, identity);
  return identity.tenantId === currentSemanticTenant() && access.principalResolved
    && access.roleIds.includes('executive') && access.pagePermissionIds.includes('page.semantic-operations.view')
    && access.buttonPermissionIds.includes('meta_model.publish')
    ? { stamp: JSON.stringify([getIAMVersion(), access]), role: getRole('executive') } : null;
}, identity.tenantId);
const safeTarget = (target, identity) => {
  try {
    const url = new URL(target.endpoint);
    return target.guarded === true && target.enabled === true && target.tenantId === identity.tenantId
      && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u.test(target.deploymentId)
      && /^[A-Za-z0-9_-]{43,128}$/u.test(target.token) && url.protocol === 'http:'
      && ['127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
};

// Dependencies are trusted server composition only. No HTTP route accepts them,
// and no caller payload can select an endpoint, credential, role or publisher.
export function createLocalModelPublisher({ connection = semanticInstanceConnection,
  inspect = getSemanticaModelDeployment, deploy = publishSemanticaModelDefinition } = {}) {
  return async ({ identityScope, modelId, body }) => {
    let entered = false;
    try {
      const identity = structuredClone(identityScope); const payload = structuredClone(body);
      if (!identity?.tenantId || !identity?.subjectId) return denied('LOCAL_PUBLICATION_FORBIDDEN');
      if (modelId === DEFAULT_SEMANTIC_MODEL_ID || !payload || Array.isArray(payload)
        || Object.keys(payload).some(key => !['confirmed', 'expectedFingerprint'].includes(key))
        || payload.confirmed !== true || typeof payload.expectedFingerprint !== 'string'
        || !/^[a-f0-9]{24}$/u.test(payload.expectedFingerprint)) return denied('LOCAL_PUBLICATION_INPUT_INVALID', 400);
      const initial = await authority(identity);
      if (!initial) return denied('LOCAL_PUBLICATION_FORBIDDEN');
      const pinned = structuredClone(connection());
      if (!safeTarget(pinned, identity)) return denied('LOCAL_PUBLICATION_TARGET_REQUIRED', 409);
      const targetMatches = () => {
        const current = connection();
        return safeTarget(current, identity) && JSON.stringify(current) === JSON.stringify(pinned);
      };
      const ownsExecution = lock => lock?.status === 'publishing' && lock.fingerprint === payload.expectedFingerprint
        && lock.modelId === modelId && lock.target?.modelId === modelId && lock.target?.tenantId === identity.tenantId
        && lock.target?.deploymentId === pinned.deploymentId;
      const recheck = async operation => {
        await assertCurrentSemanticModelAdmission();
        if (semanticFingerprint(await getOAMetaModelDraft()) !== payload.expectedFingerprint) throw new Error('draft_changed');
        if (operation) {
          const lock = await readSemanticGovernanceState('ontology_publication', 'current', null);
          if (!ownsExecution(lock) || lock.version !== operation.version) throw new Error('execution_changed');
        }
        // Fresh IAM snapshot after repository awaits, then synchronous target check.
        const now = await authority(identity);
        if (!now || now.stamp !== initial.stamp || !targetMatches()) throw new Error('authority_changed');
        // IAM and execution state are separate stores, not an atomic permission transaction.
        if (operation) {
          const lock = await readSemanticGovernanceState('ontology_publication', 'current', null);
          if (!ownsExecution(lock) || lock.version !== operation.version || !targetMatches()) throw new Error('execution_changed');
        }
      };
      return await semanticModelRegistry.withWorkspace({ role: initial.role, identityScope: identity, modelId, work: async () => {
        await recheck();
        entered = true;
        const result = await publishGovernedOntology({ role: initial.role, identityScope: identity, expectedFingerprint: payload.expectedFingerprint,
          beforeDispatch: recheck,
          inspect: async () => { await recheck(); const receipt = await inspect(); await recheck(); return receipt; },
          deploy: async (...args) => { await recheck(); return deploy(...args); } });
        const after = await authority(identity);
        if (!after || after.stamp !== initial.stamp || !targetMatches()) return { ...denied('LOCAL_PUBLICATION_AUTHORITY_CHANGED', 409), publicationMayHaveCommitted: true };
        if (result.error) return { ...denied(result.code || 'LOCAL_PUBLICATION_REJECTED', result.status || 409), publicationMayHaveCommitted: true };
        const lock = await readSemanticGovernanceState('ontology_publication', 'current', null);
        const final = await authority(identity);
        if (!final || final.stamp !== initial.stamp || !targetMatches()) return { ...denied('LOCAL_PUBLICATION_AUTHORITY_CHANGED', 409), publicationMayHaveCommitted: true };
        if (lock?.status !== 'completed' || lock.fingerprint !== payload.expectedFingerprint || lock.modelId !== modelId
          || lock.target?.deploymentId !== pinned.deploymentId) return { ...denied('LOCAL_PUBLICATION_EXECUTION_CHANGED', 409), publicationMayHaveCommitted: true };
        return { modelId, publication: { status: lock?.status, version: lock?.version, fingerprint: lock?.fingerprint },
          projectionScope: 'definition_only', runtimeReadEnabled: false };
      } });
    } catch { return { ...denied('LOCAL_PUBLICATION_UNAVAILABLE', 409), ...(entered ? { publicationMayHaveCommitted: true } : {}) }; }
  };
}

export const publishLocalModelWorkspace = createLocalModelPublisher();

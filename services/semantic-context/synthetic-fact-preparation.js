// Application composition: IAM snapshots and semantic deployment checks belong
// here, not in the governance domain or in a client-selected tenant workspace.
import { runWithIAMStoreContext, getIAMVersion } from '../../backend/src/services/iam-store.js';
import { getEffectiveAccess } from '../../backend/src/services/access-control-service.js';
import { previewSyntheticFactAdmission } from '../../backend/src/services/semantic-synthetic-fact-admission.js';
import { readSemanticGovernanceState } from '../../backend/src/services/semantic-governance-store.js';
import { getSemanticaModelDeployment } from '../../backend/src/services/semantica-demo-bridge-service.js';
import { getMetaModel } from '../../backend/src/services/meta-model-service.js';

const fail = code => { throw Object.assign(new Error('合成事实发送准备未通过。'), { code }); };
const snapshot = (identityScope, body) => runWithIAMStoreContext(async () => {
  const preview = await previewSyntheticFactAdmission({ identityScope, body });
  if (preview.status !== 'preview_passed') fail(preview.code);
  return { preview, iamVersion: getIAMVersion(), access: JSON.stringify(getEffectiveAccess(null, identityScope)) };
}, identityScope.tenantId);

const deploymentBinding = async (identityScope, preview) => {
  const lock = await readSemanticGovernanceState('ontology_publication', 'current', null);
  if (lock?.status !== 'completed' || lock.modelId !== preview.modelId || lock.version !== preview.version
    || lock.fingerprint !== preview.fingerprint || lock.target?.tenantId !== identityScope.tenantId
    || lock.target.modelId !== preview.modelId || typeof lock.target.deploymentId !== 'string' || !lock.target.deploymentId.trim()) {
    fail('SYNTHETIC_FACT_DEPLOYMENT_REQUIRED');
  }
  return structuredClone(lock);
};

// Internal, read-only preparation. It neither selects a workspace nor returns
// a bearer grant, a reusable write ticket, facts, credentials or connector URLs.
export async function prepareSyntheticFactTransfer({ identityScope, body, inspect = getSemanticaModelDeployment }) {
  let readRequestAttempted = false;
  try {
    const identity = structuredClone(identityScope); const input = structuredClone(body);
    const before = await snapshot(identity, input);
    const binding = await deploymentBinding(identity, before.preview);
    // Draft IDs identify editable artifacts; the deployment uses the canonical
    // model definition ID, not the draft ID. Neither is the namespace selector.
    const definitionId = (await getMetaModel('oa-governance')).id;
    readRequestAttempted = true;
    const remote = await inspect();
    const instance = remote?.instance;
    if (remote?.status !== 'published' || remote.id !== definitionId || remote.modelId !== before.preview.modelId || remote.modelProtocol !== 1
      || remote.projectionScope !== 'definition_only' || remote.runtimeReadEnabled !== false
      || remote.sourceFingerprint !== before.preview.fingerprint || remote.version !== before.preview.version
      || !/^[a-f0-9]{20}$/u.test(remote.fingerprint || '') || instance?.identityVerified !== true
      || instance.tenantId !== binding.target.tenantId || instance.deploymentId !== binding.target.deploymentId
      || instance.modelId !== binding.modelId || instance.protocol !== 1 || instance.modelProtocol !== 1
      || instance.projectionScope !== 'definition_only' || instance.runtimeReadEnabled !== false) fail('SYNTHETIC_FACT_DEPLOYMENT_DRIFT');
    // A fresh nested IAM context reloads the asynchronous repository snapshot;
    // reusing the outer request snapshot after this network await is unsafe.
    const after = await snapshot(identity, input);
    const freshBinding = await deploymentBinding(identity, after.preview);
    if (after.iamVersion !== before.iamVersion || after.access !== before.access
      || JSON.stringify(after.preview) !== JSON.stringify(before.preview)
      || JSON.stringify(freshBinding) !== JSON.stringify(binding)) fail('SYNTHETIC_FACT_CONTEXT_CHANGED');
    // The second semantic preview itself awaits repository operations. Reload
    // IAM once more after those awaits; none of these stores form a transaction.
    await runWithIAMStoreContext(() => {
      if (getIAMVersion() !== before.iamVersion || JSON.stringify(getEffectiveAccess(null, identity)) !== before.access) fail('SYNTHETIC_FACT_CONTEXT_CHANGED');
    }, identity.tenantId);
    const { requestAttempted: _previewOnly, ...summary } = after.preview;
    return { ...summary, status: 'preparation_passed', projectionScope: 'transfer_preparation',
      sourceFingerprint: after.preview.fingerprint, graphFingerprint: remote.fingerprint,
      readRequestAttempted, factWriteAttempted: false, writeAuthorizationIssued: false };
  } catch (error) {
    const code = /^(?:SYNTHETIC_FACT_[A-Z_]+|SEMANTIC_MODEL_WORKSPACE_REVOKED)$/u.test(error?.code || '')
      ? error.code : 'SYNTHETIC_FACT_PREPARATION_FAILED';
    return { status: 'rejected', code, readRequestAttempted, factWriteAttempted: false, writeAuthorizationIssued: false };
  }
}

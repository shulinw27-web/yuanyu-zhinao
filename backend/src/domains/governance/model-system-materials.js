import { createHash } from 'node:crypto';
import { getEffectiveAccess } from '../../services/access-control-service.js';
import { getRole } from '../../services/authorization-service.js';
import { runWithIAMStoreContext, getIAMVersion } from '../../services/iam-store.js';
import { currentSemanticTenant, DEFAULT_SEMANTIC_MODEL_ID } from '../../services/semantic-tenant-context.js';
import { semanticModelRegistry } from '../../services/semantic-model-registry.js';
import { assertCurrentSemanticModelAdmission, semanticModelReferenceMatches } from '../../services/semantic-model-reference.js';
import { discoverSemanticSources } from '../../services/semantic-source-discovery-service.js';
import { getSystemDocumentTexts } from '../../services/system-access-service.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceState } from '../../services/semantic-governance-store.js';

const namespace = 'semantic_model_system_materials';
const denied = code => ({ error: '系统资料绑定不可用，请重新检查明确范围、权限与资料版本。', code, status: 409 });
const validCodes = codes => Array.isArray(codes) && codes.length > 0 && codes.length <= 16
  && new Set(codes).size === codes.length && codes.every(code => typeof code === 'string' && /^[A-Z][A-Z0-9_-]{0,39}$/u.test(code));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fresh = (identity, codes) => runWithIAMStoreContext(() => {
  const access = getEffectiveAccess(null, identity);
  if (identity.tenantId !== currentSemanticTenant() || !access.principalResolved || !access.roleIds.includes('executive')
    || !access.pagePermissionIds.includes('page.semantic-operations.view') || !access.buttonPermissionIds.includes('meta_model.draft.save')) return null;
  const role = getRole('executive');
  if (!codes) return { role, stamp: digest([getIAMVersion(), access]) };
  const sources = discoverSemanticSources({ role, systemCodes: codes }).sources;
  if (sources.length !== codes.length || sources.some(source => !source.registryKnown || !source.authorized || source.status === 'not_registered')) return null;
  const bundles = codes.map(code => ({ code, ...getSystemDocumentTexts(code) }));
  if (bundles.some(bundle => bundle.warnings?.length || !Array.isArray(bundle.documents) || !bundle.documents.length)) return null;
  const documents = bundles.flatMap(bundle => bundle.documents.map(document => ({ sourceSystem: bundle.code, name: document.name, mimeType: document.mimeType, text: document.text })));
  if (documents.length > 64 || documents.some(document => typeof document.text !== 'string' || !document.text.trim()
    || typeof document.name !== 'string' || typeof document.mimeType !== 'string')
    || documents.reduce((bytes, document) => bytes + Buffer.byteLength(document.text), 0) > 2 * 1024 * 1024) return null;
  return { role, stamp: digest([getIAMVersion(), access]), fingerprint: digest(bundles), documents };
}, identity.tenantId);

// Internal explicit source binding only; no source grant, raw-document HTTP DTO
// or automatic import into tasks. Every consumption rechecks current IAM/data.
const operate = async ({ identityScope, modelId, body }, mode) => {
  let wrote = false;
  try {
    const identity = structuredClone(identityScope); const payload = structuredClone(body);
    if (!identity?.tenantId || !identity?.subjectId || modelId === DEFAULT_SEMANTIC_MODEL_ID) return denied('MODEL_SOURCE_FORBIDDEN');
    if (mode !== 'load' && (!payload || Array.isArray(payload) || Object.keys(payload).some(key => !(mode === 'bind'
      ? ['systemCodes', 'confirmed', 'expectedRevision', 'expectedSourceFingerprint'] : ['systemCodes']).includes(key)) || !validCodes(payload.systemCodes))) return denied('MODEL_SOURCE_INPUT_INVALID');
    if (mode === 'bind' && (payload.confirmed !== true || !Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0
      || typeof payload.expectedSourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.expectedSourceFingerprint))) return denied('MODEL_SOURCE_INPUT_INVALID');
    const initial = await fresh(identity);
    if (!initial) return denied('MODEL_SOURCE_FORBIDDEN');
    return await semanticModelRegistry.withWorkspace({ role: initial.role, identityScope: identity, modelId, work: async () => {
      await assertCurrentSemanticModelAdmission();
      const binding = await readSemanticGovernanceState(namespace, 'current', null);
      if (binding && !semanticModelReferenceMatches(binding)) return denied('MODEL_SOURCE_NOT_BOUND');
      const consumes = ['load', 'consume'].includes(mode);
      if (consumes && (!semanticModelReferenceMatches(binding) || !validCodes(binding.systemCodes))) return denied('MODEL_SOURCE_NOT_BOUND');
      if (mode === 'consume' && payload.systemCodes.some(code => !binding.systemCodes.includes(code))) return denied('MODEL_SOURCE_SCOPE_NOT_BOUND');
      const codes = consumes ? binding.systemCodes : [...payload.systemCodes].sort();
      const observed = await fresh(identity, codes);
      if (!observed || observed.stamp !== initial.stamp) return denied('MODEL_SOURCE_FORBIDDEN');
      if (consumes && observed.fingerprint !== binding.sourceFingerprint || mode === 'bind' && observed.fingerprint !== payload.expectedSourceFingerprint) return denied('MODEL_SOURCE_STALE');
      let revision = binding?.revision || 0;
      if (mode === 'bind') {
        const saved = await mutateSemanticGovernanceState(namespace, 'current', null, current => {
          if ((current?.revision || 0) !== payload.expectedRevision || current && !semanticModelReferenceMatches(current)) return { commit: false, result: false };
          return { value: { modelId, revision: payload.expectedRevision + 1, systemCodes: codes, sourceFingerprint: observed.fingerprint, confirmedBy: identity.subjectId }, result: true };
        });
        if (!saved) return denied('MODEL_SOURCE_REVISION_CONFLICT');
        wrote = true; revision = payload.expectedRevision + 1;
      }
      await assertCurrentSemanticModelAdmission();
      const after = await fresh(identity, codes);
      if (!after || after.stamp !== initial.stamp || after.fingerprint !== observed.fingerprint) return { ...denied('MODEL_SOURCE_CHANGED'), ...(wrote ? { bindingMayHaveCommitted: true } : {}) };
      if (consumes) {
        const current = await readSemanticGovernanceState(namespace, 'current', null);
        if (!semanticModelReferenceMatches(current) || current.revision !== binding.revision || current.sourceFingerprint !== binding.sourceFingerprint
          || JSON.stringify(current.systemCodes) !== JSON.stringify(binding.systemCodes)) return denied('MODEL_SOURCE_CHANGED');
        await assertCurrentSemanticModelAdmission();
        const final = await fresh(identity, codes);
        if (!final || final.stamp !== initial.stamp || final.fingerprint !== after.fingerprint) return denied('MODEL_SOURCE_CHANGED');
      }
      const selectedCodes = mode === 'consume' ? [...payload.systemCodes].sort() : codes;
      const documents = after.documents.filter(document => selectedCodes.includes(document.sourceSystem));
      return { modelId, revision, systemCodes: selectedCodes, sourceFingerprint: observed.fingerprint, documentCount: documents.length,
        runtimeReadEnabled: false, ...(consumes ? { documents } : {}) };
    } });
  } catch { return { ...denied('MODEL_SOURCE_UNAVAILABLE'), ...(wrote ? { bindingMayHaveCommitted: true } : {}) }; }
};
export const modelSystemMaterials = {
  inspect: options => operate(options, 'inspect'),
  bind: options => operate(options, 'bind'),
  load: options => operate(options, 'load'),
  consume: options => operate(options, 'consume')
};

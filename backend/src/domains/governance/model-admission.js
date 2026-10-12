import { assertCurrentSemanticModelAdmission, semanticModelReferenceMatches } from '../../services/semantic-model-reference.js';
import { currentSemanticModel, assertSemanticTenant } from '../../services/semantic-tenant-context.js';
import { readSemanticGovernanceState } from '../../services/semantic-governance-store.js';
import { semanticOperationsOwnerMatches } from '../../services/semantic-operations-identity.js';
import { mockOnboardingBasis } from '../../services/mock-onboarding-basis.js';
import { createHash } from 'node:crypto';

// Admission/reference checks do not select a workspace or grant source access.
export const semanticModelAdmission = {
  assert: assertCurrentSemanticModelAdmission, matches: semanticModelReferenceMatches,
  onboardingMatches: (project, basis) => semanticModelReferenceMatches(project) && basis?.modelId === currentSemanticModel()
    && mockOnboardingBasis(project) === basis.fingerprint,
  verifyCommittedHandoff: async ({ task, proposal, identityScope }) => {
    const identity = structuredClone(identityScope); assertSemanticTenant(identity);
    await assertCurrentSemanticModelAdmission();
    const source = task?.onboardingSource; const basis = proposal?.onboardingBasis;
    const key = JSON.stringify(['principal-role-v1', identity.tenantId, identity.subjectId, task?.originRoleId]);
    if (!semanticModelReferenceMatches(task) || !semanticModelReferenceMatches(proposal) || !semanticOperationsOwnerMatches(task.owner, identity)
      || source?.modelId !== currentSemanticModel() || basis?.modelId !== currentSemanticModel() || source.key !== key || basis.key !== key
      || typeof source.projectId !== 'string' || source.projectId !== basis.projectId || !/^[a-f0-9]{64}$/u.test(source.fingerprint || '')
      || source.fingerprint !== basis.fingerprint || !Number.isSafeInteger(source.basisRevision) || source.basisRevision < 1
      || !Number.isSafeInteger(source.materialRevision) || source.materialRevision < 1 || source.sourceKind !== 'local_mock_http') return false;
    const read = async () => (await readSemanticGovernanceState('mock_onboarding_v1', key, {}))[source.projectId];
    const project = await read();
    if (!semanticModelReferenceMatches(project) || project.id !== source.projectId || project.owner !== task.owner || project.roleId !== task.originRoleId
      || !Number.isSafeInteger(project.revision) || project.revision <= source.basisRevision || project.materialRevision !== source.materialRevision
      || project.connection?.status !== 'verified' || project.connection.materialRevision !== project.materialRevision
      || project.alignment?.report?.status !== 'validated_scope' || mockOnboardingBasis(project) !== source.fingerprint
      || project.handoff?.taskId !== task.id || project.handoff.proposalId !== proposal.id || project.handoff.basis !== source.fingerprint) return false;
    const materials = Object.values(project.materials || {});
    if (!materials.length || materials.some(material => typeof material.text !== 'string'
      || createHash('sha256').update(material.text).digest('hex') !== material.digest)) return false;
    const latest = await read();
    await assertCurrentSemanticModelAdmission();
    return JSON.stringify(latest) === JSON.stringify(project);
  },
  verifyOnboarding: async ({ proposal, onboardingSource, identityScope, roleId }) => {
    assertSemanticTenant(identityScope); await assertCurrentSemanticModelAdmission();
    if (!semanticModelReferenceMatches(proposal) || onboardingSource?.modelId !== currentSemanticModel()
      || typeof onboardingSource.key !== 'string' || typeof onboardingSource.projectId !== 'string'
      || !/^[a-f0-9]{64}$/u.test(onboardingSource.fingerprint || '')) return false;
    const project = (await readSemanticGovernanceState('mock_onboarding_v1', onboardingSource.key, {}))[onboardingSource.projectId];
    await assertCurrentSemanticModelAdmission();
    return semanticModelReferenceMatches(project) && semanticOperationsOwnerMatches(project.owner, identityScope) && project.roleId === roleId
      && project.revision === onboardingSource.basisRevision && project.materialRevision === onboardingSource.materialRevision
      && project.connection?.status === 'verified' && project.connection.materialRevision === project.materialRevision
      && project.alignment?.report?.status === 'validated_scope' && mockOnboardingBasis(project) === onboardingSource.fingerprint;
  }
};

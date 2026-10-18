import { semanticModelRegistry } from '../../services/semantic-model-registry.js';
import { getOAMetaModelDraft, getOAMetaModelSimulation, getPublishedOntologyModel, validateOAMetaModelDraft, simulateBuildOAMetaModel, getOAMetaModelRuntimeTransactionEntry, getOAMetaModelDraftFromRuntime } from '../../services/meta-model-service.js';
import { getRole } from '../../services/authorization-service.js';
import { getEffectiveAccess } from '../../services/access-control-service.js';
import { runWithIAMStoreContext, getIAMVersion } from '../../services/iam-store.js';
import { currentSemanticTenant } from '../../services/semantic-tenant-context.js';
import { assertCurrentSemanticModelAdmission, semanticModelReferenceMatches } from '../../services/semantic-model-reference.js';
import { saveSemanticOperationsDraft } from '../../services/semantic-operations-agent-service.js';
import { listSemanticOperationsTasks, getSemanticOperationsTask, issueSemanticOperationsTaskConfirmation, executeSemanticOperationsTask, createSemanticOperationsTask, semanticTaskStateFingerprint } from '../../services/semantic-operations-task-service.js';
import { publishLocalModelWorkspace } from './local-model-publication.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceStates } from '../../services/semantic-governance-store.js';
import { semanticModelEvidence } from './model-evidence.js';
import { loadSemanticMaterials } from '../../services/semantic-material-workspace-service.js';
import { modelSystemMaterials } from './model-system-materials.js';
import { semanticPreviewRequests } from './model-preview-requests.js';
import { semanticOperationsOwnerMatches, semanticOperationsPrincipalKey } from '../../services/semantic-operations-identity.js';
import { semanticFingerprint } from '../../services/semantic-model-fingerprint.js';
import { createHash, randomUUID } from 'node:crypto';
import { semanticModelAdmission } from './model-admission.js';
import { projectAdoptionReview } from './model-adoption-review.js';

const editableKeys = ['modelingProfile', 'scenario', 'stateMachines', 'events', 'objectTypes', 'relationshipTypes', 'policies', 'metrics', 'glossaryTerms', 'dataContracts', 'qualityRules', 'accessPolicies', 'lineageEdges'];
const assetLimits = { metrics: 50, glossaryTerms: 100, dataContracts: 50, qualityRules: 100, accessPolicies: 100, lineageEdges: 100 };
const editableDraft = draft => Object.fromEntries(['fingerprint', ...editableKeys].filter(key => Object.hasOwn(draft, key)).map(key => [key, draft[key]]));
const validPatch = input => Object.entries(assetLimits).every(([key, limit]) => input[key] === undefined || Array.isArray(input[key]) && input[key].length <= limit && input[key].every(item => item && typeof item === 'object' && !Array.isArray(item)))
  && (input.policies === undefined || Array.isArray(input.policies) && input.policies.length <= 12 && input.policies.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 2000));
const writePermissions = { draft: 'meta_model.draft.save', adopt: 'meta_model.draft.save', validate: 'meta_model.draft.validate', createValidation: 'meta_model.draft.validate', createSimulation: 'meta_model.simulate', confirmSimulation: 'meta_model.simulate', executeSimulation: 'meta_model.simulate', execute: 'meta_model.draft.validate', simulate: 'meta_model.simulate' };
const permissionFor = write => writePermissions[write] || 'meta_model.draft.save';
const uncertainWrite = write => write === 'preview' ? { taskMayHaveCommitted: true, preparationMayHaveCommitted: true } : ['execute', 'adopt', 'executeSimulation'].includes(write) ? { taskMayHaveCommitted: true, workspaceWriteMayHaveCommitted: true } : ['confirm', 'createValidation', 'createSimulation', 'confirmSimulation'].includes(write) ? { taskMayHaveCommitted: true } : write ? (typeof write === 'string' ? { workspaceWriteMayHaveCommitted: true } : { registrationMayHaveCommitted: true }) : {};
const validationSummary = validation => validation ? { status: validation.status, checks: (validation.checks || []).map(({ name, status }) => ({ name, status })) } : null;
const simulationSummary = simulation => simulation ? { status: simulation.status, sourceFingerprint: simulation.sourceFingerprint || null,
  sourceMode: simulation.sourceMode, verifiesLiveSystems: false, validation: validationSummary(simulation.validation),
  nodeCount: simulation.instances?.nodes?.length || 0, relationshipCount: simulation.instances?.edges?.length || 0 } : null;

const failure = (code, status = 403) => ({ error: '当前身份、权限或模型工作区不可用。', code, status });
const check = (identity, write) => runWithIAMStoreContext(() => {
  const access = getEffectiveAccess(null, identity);
  return identity?.tenantId === currentSemanticTenant() && access.principalResolved && access.roleIds.includes('executive')
    && access.pagePermissionIds.includes('page.semantic-operations.view')
    && (!write || access.buttonPermissionIds.includes(permissionFor(write)))
    && (write !== 'adopt' || access.buttonPermissionIds.includes('meta_model.draft.review'))
    ? { version: getIAMVersion(), access: JSON.stringify(access), accessContext: access, role: getRole('executive') } : null;
}, identity?.tenantId);
const guarded = async (identity, write, work) => {
  let writeStarted = false;
  try {
    const bound = structuredClone(identity);
    if (!bound?.tenantId || !bound?.subjectId) return failure('MODEL_WORKSPACE_FORBIDDEN');
    const before = await check(bound, write);
    if (!before) return failure('MODEL_WORKSPACE_FORBIDDEN');
    writeStarted = write;
    const result = await work(bound, before.role, before.accessContext);
    const after = await check(bound, write);
    if (!after || JSON.stringify(after) !== JSON.stringify(before)) {
      return { ...failure('MODEL_WORKSPACE_AUTHORITY_CHANGED', 409), ...uncertainWrite(write) };
    }
    return result;
  } catch { return { ...failure('MODEL_WORKSPACE_UNAVAILABLE', 409), ...uncertainWrite(writeStarted ? write : false) }; }
};

const taskSummary = task => ({ id: task.id, modelId: task.modelId, status: task.status,
  localValidationTask: task.command === 'validate_model' && task.routing?.reason === 'explicit_local_validation_task',
  localSimulationTask: task.command === 'simulate_model' && task.routing?.reason === 'explicit_local_simulation_task',
  ...(task.command === 'simulate_model' && task.routing?.reason === 'explicit_local_simulation_task' && task.status === 'completed' ? { simulation: simulationSummary(task.result?.simulation) } : {}),
  structuredAdoptionTask: task.command === 'apply_proposal' && task.creationMode === 'structured_preview' && task.planning?.provider === 'none',
  confirmationEvidenceState: task.confirmation?.evidenceState || 'not_required_or_legacy',
  createdAt: task.createdAt, updatedAt: task.updatedAt, confirmationRequired: Boolean(task.confirmationRequired),
  reviewerAccess: Boolean(task.reviewerAccess), requiredPermission: task.requiredPermission || null,
  displayTitle: task.status === 'waiting_confirmation' ? '待确认的语义模型任务' : '语义模型任务',
  ...(task.proposal ? { proposal: { id: task.proposal.id, revision: task.proposal.revision, status: task.proposal.status } } : {}) });
const validTaskId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(id);
const dialogueMessages = task => {
  if (!Array.isArray(task.messages) || task.messages.length > 64 || task.messages.some(message => !message || !['user', 'assistant'].includes(message.role)
    || typeof message.content !== 'string' || message.content.length > 8192
    || message.time !== undefined && (typeof message.time !== 'string' || message.time.length > 64))) return null;
  const messages = task.messages.map(({ role, content, time }) => ({ role, content, ...(time === undefined ? {} : { time }) }));
  return Buffer.byteLength(JSON.stringify(messages)) <= 128 * 1024 ? messages : null;
};

// Internal admission probe only. It does not return conversation or source
// content, and is not sufficient to grant create/confirm/execute operations.
const inspectTaskReferences = async (taskId, identity, accessContext) => {
  const visible = await getSemanticOperationsTask({ taskId, identityScope: identity, accessContext });
  if (!visible) return failure('MODEL_TASK_NOT_FOUND', 404);
  const index = await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {});
  const task = index[taskId];
  const seen = new Set(); const chain = [];
  let current = task;
  while (current) {
    if (!validTaskId(current.id) || seen.has(current.id) || chain.length >= 32 || !semanticModelReferenceMatches(current)
      || current.owner !== task.owner) return failure('MODEL_TASK_REFERENCE_INVALID', 409);
    seen.add(current.id); chain.push(current);
    if (!current.parentTaskId) break;
    if (!validTaskId(current.parentTaskId) || !index[current.parentTaskId]) return failure('MODEL_TASK_REFERENCE_INVALID', 409);
    current = index[current.parentTaskId];
  }
  if (!task || chain.some(item => (item.threadId || item.id) !== chain.at(-1).id)) return failure('MODEL_TASK_REFERENCE_INVALID', 409);
  const proposals = [];
  const materials = [];
  for (const item of chain) {
    if (item.creationMode === 'structured_preview' && (item.creationRequestId !== undefined || item.creationInputFingerprint !== undefined)
      && !await semanticPreviewRequests.verifyCommittedTask(item)) return failure('MODEL_PREVIEW_RECEIPT_INVALID', 409);
    // No owner impersonation for assigned reviewers. Source access remains
    // the current principal's grant, not the originating task's privilege.
    if (item.materialRefs !== undefined && !Array.isArray(item.materialRefs)) return failure('MODEL_TASK_MATERIAL_INVALID', 409);
    if (item.materialRefs?.length) {
      if (!semanticOperationsOwnerMatches(item.owner, identity) || typeof item.originRoleId !== 'string' || !item.originRoleId) return failure('MODEL_TASK_MATERIAL_INVALID', 409);
      try { materials.push({ task: item, documents: await loadSemanticMaterials(item.materialRefs, identity, item.originRoleId) }); }
      catch { return failure('MODEL_TASK_MATERIAL_INVALID', 409); }
    }
    if (item.systemMaterialBinding) {
      const binding = item.systemMaterialBinding;
      const consumed = await modelSystemMaterials.consume({ identityScope: identity, modelId: item.modelId, body: { systemCodes: binding.systemCodes } });
      if (consumed.error || consumed.revision !== binding.revision || consumed.sourceFingerprint !== binding.sourceFingerprint) return failure('MODEL_TASK_SOURCE_CHANGED', 409);
    }
    if (!item.proposal) {
      if (item.onboardingSource) return failure('MODEL_TASK_ONBOARDING_CHANGED', 409);
      continue;
    }
    if (!validTaskId(item.proposal.id)) return failure('MODEL_TASK_REFERENCE_INVALID', 409);
    const proposal = await readSemanticGovernanceState('semantic_operations_agent_proposals', `proposal-${item.proposal.id}`, null);
    if (!semanticModelReferenceMatches(proposal) || proposal.id !== item.proposal.id || proposal.owner !== item.owner
      || proposal.revision !== item.proposal.revision) return failure('MODEL_TASK_REFERENCE_INVALID', 409);
    if ((item.onboardingSource || proposal.onboardingBasis) && !await semanticModelAdmission.verifyCommittedHandoff({ task: item, proposal, identityScope: identity })) return failure('MODEL_TASK_ONBOARDING_CHANGED', 409);
    proposals.push({ item, proposal });
  }
  for (const item of chain) {
    if (item.traceProvisioning === 'ready' && !await semanticModelEvidence.verifyTaskTrace(item)) return failure('MODEL_TASK_EVIDENCE_INVALID', 409);
  }
  // Storage waits can race task revision, assignment or proposal replacement.
  // Withhold even this narrow probe if any referenced record changed.
  const latest = await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {});
  if (chain.some(item => JSON.stringify(latest[item.id]) !== JSON.stringify(item))) return failure('MODEL_TASK_REFERENCE_CHANGED', 409);
  for (const { item, proposal } of proposals) {
    const latestProposal = await readSemanticGovernanceState('semantic_operations_agent_proposals', `proposal-${proposal.id}`, null);
    if (JSON.stringify(latestProposal) !== JSON.stringify(proposal)) return failure('MODEL_TASK_REFERENCE_CHANGED', 409);
    if ((item.onboardingSource || proposal.onboardingBasis) && !await semanticModelAdmission.verifyCommittedHandoff({ task: item, proposal, identityScope: identity })) return failure('MODEL_TASK_ONBOARDING_CHANGED', 409);
  }
  for (const material of materials) {
    try {
      if (JSON.stringify(await loadSemanticMaterials(material.task.materialRefs, identity, material.task.originRoleId)) !== JSON.stringify(material.documents)) return failure('MODEL_TASK_MATERIAL_CHANGED', 409);
    } catch { return failure('MODEL_TASK_MATERIAL_INVALID', 409); }
  }
  for (const item of chain) {
    if (!item.systemMaterialBinding) continue;
    const binding = item.systemMaterialBinding;
    const consumed = await modelSystemMaterials.consume({ identityScope: identity, modelId: item.modelId, body: { systemCodes: binding.systemCodes } });
    if (consumed.error || consumed.revision !== binding.revision || consumed.sourceFingerprint !== binding.sourceFingerprint) return failure('MODEL_TASK_SOURCE_CHANGED', 409);
  }
  for (const item of chain) {
    if (item.creationMode === 'structured_preview' && (item.creationRequestId !== undefined || item.creationInputFingerprint !== undefined)
      && !await semanticPreviewRequests.verifyCommittedTask(item)) return failure('MODEL_PREVIEW_RECEIPT_INVALID', 409);
  }
  await assertCurrentSemanticModelAdmission();
  return { taskId, referenceScope: 'task_ancestry_proposal_ready_evidence_material_source_binding_committed_handoff', referenceState: 'valid', ancestorCount: chain.length - 1,
    evidenceState: task.traceProvisioning || 'not_verified', contentReturned: false, runtimeReadEnabled: false };
};

const analyzeWorkspace = ({ identityScope, modelId, body }, operation) => {
  const payload = structuredClone(body);
  return guarded(identityScope, operation, (identity, role) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
    if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => !['confirmed', 'expectedFingerprint'].includes(key))
      || payload.confirmed !== true || typeof payload.expectedFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(payload.expectedFingerprint)) return failure('MODEL_ANALYSIS_INPUT_INVALID', 400);
    await assertCurrentSemanticModelAdmission();
    const result = await runWithIAMStoreContext(() => {
      const access = getEffectiveAccess(null, identity);
      if (!access.principalResolved || !access.roleIds.includes('executive') || !access.pagePermissionIds.includes('page.semantic-operations.view') || !access.buttonPermissionIds.includes(permissionFor(operation))) return failure('MODEL_WORKSPACE_FORBIDDEN');
      return operation === 'validate' ? validateOAMetaModelDraft(getRole('executive'), payload) : simulateBuildOAMetaModel(getRole('executive'), payload);
    }, identity.tenantId);
    await assertCurrentSemanticModelAdmission();
    if (result.error) return { error: result.error, code: result.code || 'MODEL_ANALYSIS_REJECTED', status: result.status || 422 };
    return { modelId, sourceFingerprint: payload.expectedFingerprint, runtimeReadEnabled: false, selectionScope: 'request_only',
      ...(operation === 'validate' ? { validation: validationSummary(result.draft.validation) } : { simulation: simulationSummary(result.simulation) }) };
  } }));
};

// Narrow request-scoped surface, not activation of every legacy governance path.
export const modelWorkspaces = {
  previewRequestStatus: ({ identityScope, modelId, requestId }) => {
    const selected = requestId;
    return guarded(identityScope, 'draft', (identity, role) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
      const status = await semanticPreviewRequests.inspectStatus({ identityScope: identity, roleId: role.id, requestId: selected });
      return status.code ? failure(status.code, status.status) : { ...status, contentReturned: false, runtimeReadEnabled: false };
    } }));
  },
  recoverPreviewCommit: ({ identityScope, modelId, body }) => {
    const payload = structuredClone(body);
    return guarded(identityScope, 'draft', (identity, role, accessContext) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
      if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => !['confirmed', 'requestId', 'inputFingerprint', 'expectedCheckpointFingerprint', 'expectedDraftFingerprint'].includes(key))
        || payload.confirmed !== true || !/^[a-f0-9]{24}$/u.test(payload.expectedDraftFingerprint || '')) return failure('MODEL_PREVIEW_RECEIPT_INPUT_INVALID', 400);
      const loadArgs = { identityScope: identity, roleId: role.id, requestId: payload.requestId, inputFingerprint: payload.inputFingerprint, expectedCheckpointFingerprint: payload.expectedCheckpointFingerprint };
      const loaded = await semanticPreviewRequests.loadCommittedTask(loadArgs);
      if (loaded.code) return failure(loaded.code, loaded.status);
      const task = loaded.task;
      if (task.status !== 'waiting_confirmation' || task.confirmation?.state !== 'not_issued' || !['pending', 'ready'].includes(task.traceProvisioning)
        || task.reviewContext?.draftFingerprint !== payload.expectedDraftFingerprint || (await getOAMetaModelDraft()).fingerprint !== payload.expectedDraftFingerprint)
        return failure('MODEL_PREVIEW_RECEIPT_STATE_CHANGED', 409);
      const proof = await inspectTaskReferences(task.id, identity, accessContext);
      if (proof.error) return proof;
      const latest = await semanticPreviewRequests.loadCommittedTask(loadArgs);
      if (latest.code || JSON.stringify(latest.task) !== JSON.stringify(task)) return failure('MODEL_TASK_REFERENCE_CHANGED', 409);
      return { modelId, task: taskSummary(task), taskFingerprint: semanticTaskStateFingerprint(task), evidenceState: task.traceProvisioning,
        recoveredCommit: true, confirmationEnabled: false, executionEnabled: false, runtimeReadEnabled: false };
    } }));
  },
  resumePreparedPreview: ({ identityScope, modelId, body }) => {
    const payload = structuredClone(body);
    return guarded(identityScope, 'preview', (identity, role) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
      const baseline = await check(identity, 'draft');
      const probe = await modelWorkspaces.inspectPreparedPreview({ identityScope: identity, modelId, body: payload });
      if (probe.error) return probe;
      const binding = { identityScope: identity, roleId: role.id, requestId: payload.requestId, inputFingerprint: payload.inputFingerprint };
      const loaded = await semanticPreviewRequests.loadPreparedTask({ ...binding, expectedCheckpointFingerprint: payload.expectedCheckpointFingerprint });
      if (loaded.code || loaded.task.id !== probe.taskId) return failure('MODEL_PREVIEW_CHECKPOINT_CHANGED', 409);
      const rechecked = await modelWorkspaces.inspectPreparedPreview({ identityScope: identity, modelId, body: payload });
      if (rechecked.error) return rechecked;
      const fresh = await check(identity, 'draft');
      if (!fresh || JSON.stringify(fresh) !== JSON.stringify(baseline)) return failure('MODEL_WORKSPACE_AUTHORITY_CHANGED', 409);
      // This transaction can resume only the exact checkpoint. It never
      // re-extracts candidates, replaces IDs or signs an execution token.
      const receipt = await semanticPreviewRequests.commitPreparedTask({ ...binding, task: loaded.task });
      if (receipt.code) return failure(receipt.code, receipt.status);
      const task = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[receipt.taskId];
      if (!semanticModelReferenceMatches(task) || !semanticOperationsOwnerMatches(task.owner, identity) || task.creationRequestId !== payload.requestId
        || task.creationInputFingerprint !== payload.inputFingerprint || task.traceProvisioning !== 'pending') return { ...failure('MODEL_TASK_REFERENCE_CHANGED', 409), taskMayHaveCommitted: true };
      return { modelId, task: taskSummary(task), taskFingerprint: semanticTaskStateFingerprint(task), evidenceState: 'pending', resumedFromCheckpoint: true,
        confirmationEnabled: false, executionEnabled: false, runtimeReadEnabled: false };
    } }));
  },
  inspectPreparedPreview: ({ identityScope, modelId, body }) => {
    const payload = structuredClone(body);
    return guarded(identityScope, 'draft', (identity, role) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
      if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => !['confirmed', 'requestId', 'inputFingerprint', 'expectedCheckpointFingerprint', 'expectedDraftFingerprint'].includes(key))
        || payload.confirmed !== true || !/^[a-f0-9]{24}$/u.test(payload.expectedDraftFingerprint || '')) return failure('MODEL_PREVIEW_PREPARED_INPUT_INVALID', 400);
      const loadArgs = { identityScope: identity, roleId: role.id, requestId: payload.requestId, inputFingerprint: payload.inputFingerprint, expectedCheckpointFingerprint: payload.expectedCheckpointFingerprint };
      const loaded = await semanticPreviewRequests.loadPreparedTask(loadArgs);
      if (loaded.code) return failure(loaded.code, loaded.status);
      const task = loaded.task;
      if (task.parentTaskId || task.onboardingSource || !task.proposal || !validTaskId(task.proposal.id) || !Array.isArray(task.materialRefs)
        || !task.systemMaterialBinding || task.reviewContext?.proposalId !== task.proposal.id || task.reviewContext?.proposalRevision !== task.proposal.revision
        || task.reviewContext?.draftFingerprint !== payload.expectedDraftFingerprint) return failure('MODEL_PREVIEW_PREPARED_REFERENCE_INVALID', 409);
      let observed;
      for (let pass = 0; pass < 2; pass++) {
        if ((await getOAMetaModelDraft()).fingerprint !== payload.expectedDraftFingerprint) return failure('MODEL_DRAFT_FINGERPRINT_CONFLICT', 409);
        const proposal = await readSemanticGovernanceState('semantic_operations_agent_proposals', `proposal-${task.proposal.id}`, null);
        if (!semanticModelReferenceMatches(proposal) || proposal.id !== task.proposal.id || proposal.owner !== task.owner || proposal.revision !== task.proposal.revision || proposal.onboardingBasis)
          return failure('MODEL_PREVIEW_PREPARED_REFERENCE_INVALID', 409);
        let documents;
        try { documents = await loadSemanticMaterials(task.materialRefs, identity, role.id); }
        catch { return failure('MODEL_TASK_MATERIAL_INVALID', 409); }
        const binding = task.systemMaterialBinding;
        const sources = await modelSystemMaterials.consume({ identityScope: identity, modelId, body: { systemCodes: binding.systemCodes } });
        if (sources.error || sources.revision !== binding.revision || sources.sourceFingerprint !== binding.sourceFingerprint) return failure('MODEL_TASK_SOURCE_CHANGED', 409);
        if (!await semanticModelEvidence.verifyTaskTrace(task)) return failure('MODEL_TASK_EVIDENCE_INVALID', 409);
        const current = JSON.stringify({ proposal, documents });
        if (observed !== undefined && current !== observed) return failure('MODEL_TASK_REFERENCE_CHANGED', 409);
        observed = current;
        const latest = await semanticPreviewRequests.loadPreparedTask(loadArgs);
        if (latest.code || JSON.stringify(latest.task) !== JSON.stringify(task)) return failure('MODEL_PREVIEW_CHECKPOINT_CHANGED', 409);
      }
      return { modelId, taskId: task.id, checkpointFingerprint: loaded.checkpointFingerprint, referenceState: 'valid', contentReturned: false, executionEnabled: false };
    } }));
  },
  // Repairs only an existing, verifiable preview receipt; never regenerates
  // proposal events or returns an execution token after an uncertain write.
  recoverPreviewEvidence: ({ identityScope, modelId, taskId, body }) => {
    const payload = structuredClone(body);
    return guarded(identityScope, 'preview', (identity, role, accessContext) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
      if (!validTaskId(taskId) || !payload || Array.isArray(payload) || Object.keys(payload).some(key => !['confirmed', 'expectedTaskFingerprint'].includes(key))
        || payload.confirmed !== true || !/^[a-f0-9]{24}$/u.test(payload.expectedTaskFingerprint || '')) return failure('MODEL_PREVIEW_RECOVERY_INPUT_INVALID', 400);
      const baseline = await check(identity, 'draft');
      const record = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[taskId];
      if (!semanticModelReferenceMatches(record) || !semanticOperationsOwnerMatches(record.owner, identity) || record.originRoleId !== role.id
        || record.creationMode !== 'structured_preview' || record.status !== 'waiting_confirmation' || record.confirmation?.state !== 'not_issued'
        || record.traceProvisioning === 'missing') return failure('MODEL_PREVIEW_RECOVERY_FORBIDDEN', 409);
      if (semanticTaskStateFingerprint(record) !== payload.expectedTaskFingerprint) return failure('MODEL_TASK_FINGERPRINT_CONFLICT', 409);
      if (record.traceId) await semanticModelEvidence.get(record.traceId, [role.id], identity).catch(() => null);
      const proof = await inspectTaskReferences(taskId, identity, accessContext);
      if (proof.error) {
        if (proof.code === 'MODEL_TASK_EVIDENCE_INVALID') await semanticModelEvidence.quarantinePreviewEvidence({ taskId, identityScope: identity, roleId: role.id });
        return proof;
      }
      const fresh = await check(identity, 'draft');
      const latest = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[taskId];
      if (!fresh || JSON.stringify(fresh) !== JSON.stringify(baseline)) return failure('MODEL_WORKSPACE_AUTHORITY_CHANGED', 409);
      if (JSON.stringify(latest) !== JSON.stringify(record)) return failure('MODEL_TASK_REFERENCE_CHANGED', 409);
      const receipt = record.traceProvisioning === 'pending' && record.previewCheckpointFingerprint
        ? await semanticModelEvidence.completePendingPreview({ taskId, identityScope: identity, roleId: role.id, expectedTaskFingerprint: payload.expectedTaskFingerprint })
        : await semanticModelEvidence.completePreviewCreation({ taskId, identityScope: identity, roleId: role.id, expectedTaskFingerprint: payload.expectedTaskFingerprint });
      return receipt.error ? receipt : { modelId, taskId, ...receipt, confirmationTokenReturned: false, executionEnabled: false };
    } }));
  },
  // Server-only preview composition. Preparation failure recovery and
  // user-facing creation/adoption contracts remain to be completed.
  previewModelTask: ({ identityScope, modelId, body }) => {
    const payload = structuredClone(body);
    return guarded(identityScope, 'preview', (identity, role, accessContext) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
      if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => !['confirmed', 'requestId', 'text', 'systemCodes', 'attachments', 'expectedDraftFingerprint'].includes(key))
        || typeof payload.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(payload.requestId)
        || payload.confirmed !== true || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4000
        || !Array.isArray(payload.systemCodes) || !payload.systemCodes.length || payload.systemCodes.length > 16 || new Set(payload.systemCodes).size !== payload.systemCodes.length
        || payload.systemCodes.some(code => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{1,15}$/u.test(code))
        || payload.attachments !== undefined && (!Array.isArray(payload.attachments) || payload.attachments.length > 8 || payload.attachments.some(item => !item || typeof item !== 'object' || Array.isArray(item)))
        || typeof payload.expectedDraftFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(payload.expectedDraftFingerprint)) return failure('MODEL_PREVIEW_INPUT_INVALID', 400);
      await assertCurrentSemanticModelAdmission();
      if ((await getOAMetaModelDraft()).fingerprint !== payload.expectedDraftFingerprint) return failure('MODEL_DRAFT_FINGERPRINT_CONFLICT', 409);
      const sources = await modelSystemMaterials.consume({ identityScope: identity, modelId, body: { systemCodes: payload.systemCodes } });
      if (sources.error) return failure('MODEL_PREVIEW_SOURCE_UNAVAILABLE', 409);
      const baseline = await check(identity, 'draft');
      if (!baseline) return failure('MODEL_WORKSPACE_FORBIDDEN');
      const admission = async () => {
        await assertCurrentSemanticModelAdmission();
        const fresh = await check(identity, 'draft');
        if (!fresh || JSON.stringify(fresh) !== JSON.stringify(baseline) || (await getOAMetaModelDraft()).fingerprint !== payload.expectedDraftFingerprint) return false;
        const current = await modelSystemMaterials.consume({ identityScope: identity, modelId, body: { systemCodes: payload.systemCodes } });
        return !current.error && current.revision === sources.revision && current.sourceFingerprint === sources.sourceFingerprint;
      };
      const inputFingerprint = createHash('sha256').update(JSON.stringify([payload.text, payload.systemCodes, payload.attachments || [], payload.expectedDraftFingerprint, sources.revision, sources.sourceFingerprint])).digest('hex');
      const requestBinding = { identityScope: identity, roleId: role.id, requestId: payload.requestId, inputFingerprint };
      if (!await admission()) return failure('MODEL_PREVIEW_ADMISSION_CHANGED', 409);
      const reserved = await semanticPreviewRequests.reserve(requestBinding);
      if (reserved.code) return failure(reserved.code, reserved.status);
      if (reserved.reused && reserved.state !== 'committed') return { ...failure('MODEL_PREVIEW_REQUEST_PENDING', 409), preparationMayHaveCommitted: true };
      let result;
      if (reserved.reused) {
        const stored = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[reserved.taskId];
        if (!semanticModelReferenceMatches(stored) || !semanticOperationsOwnerMatches(stored.owner, identity) || stored.originRoleId !== role.id
          || stored.creationRequestId !== payload.requestId || stored.creationInputFingerprint !== inputFingerprint || stored.creationMode !== 'structured_preview'
          || stored.status !== 'waiting_confirmation' || stored.confirmation?.state !== 'not_issued') return failure('MODEL_PREVIEW_RECEIPT_INVALID', 409);
        result = { id: stored.id };
      } else result = await createSemanticOperationsTask({ identityScope: identity, role, accessContext, structuredPreview: true,
        body: { text: payload.text, systemCodes: payload.systemCodes, ...(payload.attachments === undefined ? {} : { attachments: payload.attachments }) }, beforeTaskCommit: admission,
        checkpointPreparedTask: async task => await admission() ? semanticPreviewRequests.checkpointPreparedTask({ ...requestBinding, task }) : { code: 'MODEL_PREVIEW_ADMISSION_CHANGED', status: 409 },
        commitPreparedTask: async task => await admission() ? semanticPreviewRequests.commitPreparedTask({ ...requestBinding, task }) : { code: 'MODEL_PREVIEW_ADMISSION_CHANGED', status: 409 } });
      if (result.error) return { ...failure(result.code || 'MODEL_PREVIEW_REJECTED', result.status || 409),
        ...(result.preparationMayHaveCommitted ? { preparationMayHaveCommitted: true } : {}), ...(result.taskMayHaveCommitted ? { taskMayHaveCommitted: true } : {}) };
      if (!await admission()) return { ...failure('MODEL_PREVIEW_ADMISSION_CHANGED', 409), taskMayHaveCommitted: true, preparationMayHaveCommitted: true };
      const proof = await inspectTaskReferences(result.id, identity, accessContext);
      if (proof.error) {
        if (proof.code === 'MODEL_TASK_EVIDENCE_INVALID') await semanticModelEvidence.quarantinePreviewEvidence({ taskId: result.id, identityScope: identity, roleId: role.id });
        return { ...proof, taskMayHaveCommitted: true, preparationMayHaveCommitted: true };
      }
      const beforeReceipt = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[result.id];
      const receipt = await semanticModelEvidence.completePreviewCreation({ taskId: result.id, identityScope: identity, roleId: role.id, expectedTaskFingerprint: semanticTaskStateFingerprint(beforeReceipt) });
      if (receipt.error) return receipt;
      if (!await admission()) return { ...failure('MODEL_PREVIEW_ADMISSION_CHANGED', 409), taskMayHaveCommitted: true, preparationMayHaveCommitted: true };
      const record = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[result.id];
      if (!semanticModelReferenceMatches(record) || !semanticOperationsOwnerMatches(record.owner, identity) || record.originRoleId !== role.id
        || record.creationRequestId !== payload.requestId || record.creationInputFingerprint !== inputFingerprint || record.status !== 'waiting_confirmation' || record.confirmation?.state !== 'not_issued'
        || record.creationMode !== 'structured_preview' || record.traceProvisioning !== 'ready') return { ...failure('MODEL_TASK_REFERENCE_CHANGED', 409), taskMayHaveCommitted: true };
      return { modelId, task: taskSummary(record), taskFingerprint: semanticTaskStateFingerprint(record), ...receipt, reused: reserved.reused, creationMode: 'structured_preview', executionEnabled: false, runtimeReadEnabled: false };
    } }));
  },
  createLocalTask: ({ identityScope, modelId, body, localSimulationOnly = false }) => {
    const payload = structuredClone(body);
    const operation = localSimulationOnly ? 'createSimulation' : 'createValidation';
    const command = localSimulationOnly ? 'simulate_model' : 'validate_model';
    return guarded(identityScope, operation, (identity, role) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
      if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => !['confirmed', 'kind', 'requestId', 'expectedDraftFingerprint'].includes(key))
        || payload.confirmed !== true || payload.kind !== command || typeof payload.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(payload.requestId)
        || typeof payload.expectedDraftFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(payload.expectedDraftFingerprint)) return failure('MODEL_LOCAL_TASK_INPUT_INVALID', 400);
      await assertCurrentSemanticModelAdmission();
      const owner = semanticOperationsPrincipalKey(identity);
      if (!await check(identity, operation)) return failure('MODEL_WORKSPACE_FORBIDDEN');
      const id = `semantic-task-local-${createHash('sha256').update(JSON.stringify([modelId, owner, payload.requestId])).digest('hex').slice(0, 24)}`;
      const created = await mutateSemanticGovernanceStates([{ name: 'tasks', namespace: 'semantic_operations_agent_tasks', key: 'index', initialValue: {} }, getOAMetaModelRuntimeTransactionEntry()], values => {
        const existing = values.tasks[id];
        if (existing) return semanticModelReferenceMatches(existing) && existing.owner === owner && existing.originRoleId === role.id && existing.command === payload.kind
          && existing.creationRequestId === payload.requestId && existing.reviewContext?.draftFingerprint === payload.expectedDraftFingerprint
          ? { commit: false, result: { taskId: id, reused: true } } : { commit: false, result: failure('MODEL_LOCAL_TASK_REQUEST_CONFLICT', 409) };
        if (semanticFingerprint(getOAMetaModelDraftFromRuntime(values.oaRuntime)) !== payload.expectedDraftFingerprint) return { commit: false, result: failure('MODEL_DRAFT_FINGERPRINT_CONFLICT', 409) };
        if (Object.keys(values.tasks).length >= 200) return { commit: false, result: failure('MODEL_LOCAL_TASK_LIMIT', 409) };
        const time = new Date().toISOString(); const request = localSimulationOnly ? '模拟当前模型草稿（仅本地合成数据）' : '校验当前模型草稿（仅本地结构检查）'; const response = '已创建本地任务，等待明确确认；未调用大模型、未执行或发布。';
        values.tasks[id] = { id, modelId, owner, originRoleId: role.id, creationRequestId: payload.requestId, createdAt: time, updatedAt: time, threadId: id,
          traceId: `trace-${randomUUID()}`, traceProvisioning: 'pending', status: 'waiting_confirmation', command, intent: command,
          requiredPermission: permissionFor(operation), confirmationRequired: true, confirmation: { state: 'not_issued' }, reviewContext: { draftFingerprint: payload.expectedDraftFingerprint },
          routing: { mode: 'server_rules', reason: localSimulationOnly ? 'explicit_local_simulation_task' : 'explicit_local_validation_task' }, request, response, messages: [{ role: 'user', content: request, time }, { role: 'assistant', content: response, time }],
          events: [{ type: localSimulationOnly ? 'local_simulation_task_created' : 'local_validation_task_created', time, detail: '只创建待确认任务，不执行。' }] };
        return { values, result: { taskId: id, reused: false } };
      });
      if (created.error) return created;
      await assertCurrentSemanticModelAdmission();
      const receipt = await semanticModelEvidence.completeLocalCreation({ taskId: id, identityScope: identity, roleId: role.id });
      if (receipt.error) return { ...receipt, taskId: id };
      const record = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[id];
      await assertCurrentSemanticModelAdmission();
      if (!semanticModelReferenceMatches(record) || record.owner !== owner || record.originRoleId !== role.id || record.creationRequestId !== payload.requestId || record.traceProvisioning !== 'ready') return { ...failure('MODEL_LOCAL_TASK_REFERENCE_CHANGED', 409), taskMayHaveCommitted: true };
      return { modelId, task: taskSummary(record), taskFingerprint: semanticTaskStateFingerprint(record), ...created, ...receipt, executionEnabled: false, runtimeReadEnabled: false };
    } }));
  },
  // Separate server-selected local commands; callers cannot override the mode.
  // Trusted internal selector only; HTTP local execution cannot supply it.
  executeAdoptionTask: options => modelWorkspaces.executeTask({ ...options, executionKind: 'adopt' }),
  executeTask: ({ identityScope, modelId, taskId, body, executionKind = 'validate' }) => {
    const payload = structuredClone(body);
    if (!['validate', 'simulate', 'adopt'].includes(executionKind)) return Promise.resolve(failure('MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED', 409));
    const operation = executionKind === 'adopt' ? 'adopt' : executionKind === 'simulate' ? 'executeSimulation' : 'execute'; const command = executionKind === 'adopt' ? 'apply_proposal' : executionKind === 'simulate' ? 'simulate_model' : 'validate_model';
    return guarded(identityScope, operation, (identity, role, accessContext) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
      if (!validTaskId(taskId) || !payload || Array.isArray(payload) || Object.keys(payload).some(key => !['confirmed', 'expectedTaskFingerprint', 'confirmationToken'].includes(key))
        || payload.confirmed !== true || typeof payload.expectedTaskFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(payload.expectedTaskFingerprint)
        || typeof payload.confirmationToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(payload.confirmationToken)) return failure('MODEL_TASK_EXECUTION_INPUT_INVALID', 400);
      const task = await getSemanticOperationsTask({ taskId, identityScope: identity, accessContext });
      if (!task || task.reviewerAccess) return failure('MODEL_TASK_EXECUTION_FORBIDDEN');
      if (task.command !== command) return failure('MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED', 409);
      if (executionKind === 'simulate' && task.routing?.reason !== 'explicit_local_simulation_task') return failure('MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED', 409);
      if (executionKind === 'adopt' && (task.creationMode !== 'structured_preview' || task.planning?.provider !== 'none' || !task.proposal
        || !/^[a-f0-9]{24}$/u.test(task.reviewContext?.draftFingerprint || '') || (await getOAMetaModelDraft()).fingerprint !== task.reviewContext.draftFingerprint)) return failure('MODEL_ADOPTION_PREVIEW_OR_DRAFT_CHANGED', 409);
      if (task.evidenceState !== 'ready' || task.confirmation?.evidenceState !== 'ready') return failure('MODEL_TASK_EVIDENCE_NOT_READY', 409);
      const proof = await inspectTaskReferences(taskId, identity, accessContext);
      if (proof.error) return proof;
      const baseline = await check(identity, operation);
      if (!baseline) return failure('MODEL_WORKSPACE_FORBIDDEN');
      const result = await runWithIAMStoreContext(() => executeSemanticOperationsTask({ taskId, identityScope: identity, role, accessContext: getEffectiveAccess(null, identity),
        confirmationToken: payload.confirmationToken, expectedTaskFingerprint: payload.expectedTaskFingerprint,
        localSimulationOnly: executionKind === 'simulate',
        executionAdmission: async phase => {
          await assertCurrentSemanticModelAdmission();
          const references = await inspectTaskReferences(taskId, identity, accessContext);
          const authority = await check(identity, operation);
          const draftCurrent = executionKind !== 'adopt' || phase === 'finalize' || (await getOAMetaModelDraft()).fingerprint === task.reviewContext.draftFingerprint;
          return !references.error && draftCurrent && authority && JSON.stringify(authority) === JSON.stringify(baseline);
        } }), identity.tenantId);
      await assertCurrentSemanticModelAdmission();
      return result.error ? { error: '受控本地任务未完成，请核对权限、引用和执行状态。', code: result.code || 'MODEL_TASK_EXECUTION_REJECTED', status: 409,
        ...(result.task?.confirmation?.state === 'consumed' ? { taskMayHaveCommitted: true, workspaceWriteMayHaveCommitted: true } : {}) }
        : { modelId, task: taskSummary(result.task), validation: validationSummary(result.result?.draft?.validation), ...(executionKind === 'simulate' ? { simulation: simulationSummary(result.result?.simulation) } : {}), runtimeReadEnabled: false, executedCommand: command };
    } }));
  },
  confirmAdoptionTask: options => modelWorkspaces.confirmTask({ ...options, structuredAdoptionOnly: true }),
  reviewAdoptionTask: ({ identityScope, modelId, taskId }) => guarded(identityScope, false, (identity, role, accessContext) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
    if (!validTaskId(taskId) || !await check(identity, 'adopt')) return failure('MODEL_ADOPTION_REVIEW_FORBIDDEN');
    const record = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[taskId];
    if (!semanticModelReferenceMatches(record) || !semanticOperationsOwnerMatches(record.owner, identity) || record.originRoleId !== role.id || record.status !== 'waiting_confirmation'
      || record.command !== 'apply_proposal' || record.creationMode !== 'structured_preview' || record.planning?.provider !== 'none' || !record.proposal || record.traceProvisioning !== 'ready') return failure('MODEL_ADOPTION_REVIEW_FORBIDDEN');
    const proof = await inspectTaskReferences(taskId, identity, accessContext);
    if (proof.error) return proof;
    const proposal = await readSemanticGovernanceState('semantic_operations_agent_proposals', `proposal-${record.proposal.id}`, null);
    const draft = await getOAMetaModelDraft();
    if (!semanticModelReferenceMatches(proposal) || proposal.owner !== record.owner || proposal.revision !== record.proposal.revision || proposal.status !== 'pending_review'
      || draft.fingerprint !== record.reviewContext?.draftFingerprint) return failure('MODEL_ADOPTION_REVIEW_CHANGED', 409);
    const result = projectAdoptionReview({ task: record, proposal, draft, taskFingerprint: semanticTaskStateFingerprint(record) });
    if (result.error) return result;
    const latestProof = await inspectTaskReferences(taskId, identity, accessContext);
    if (latestProof.error) return latestProof;
    const latest = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[taskId];
    const latestProposal = await readSemanticGovernanceState('semantic_operations_agent_proposals', `proposal-${proposal.id}`, null);
    if (JSON.stringify(latest) !== JSON.stringify(record) || JSON.stringify(latestProposal) !== JSON.stringify(proposal) || (await getOAMetaModelDraft()).fingerprint !== draft.fingerprint
      || !await check(identity, 'adopt')) return failure('MODEL_ADOPTION_REVIEW_CHANGED', 409);
    return result;
  } })),
  recoverAdoptionConfirmationEvidence: options => modelWorkspaces.recoverConfirmationEvidence({ ...options, structuredAdoptionOnly: true }),
  recoverConfirmationEvidence: ({ identityScope, modelId, taskId, localValidationOnly = false, localSimulationOnly = false, structuredAdoptionOnly = false }) => guarded(identityScope, structuredAdoptionOnly ? 'adopt' : localSimulationOnly ? 'confirmSimulation' : 'confirm', (identity, role, accessContext) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
    if (!validTaskId(taskId)) return failure('MODEL_TASK_REQUEST_INVALID', 400);
    const task = await getSemanticOperationsTask({ taskId, identityScope: identity, accessContext });
    if (!task || task.reviewerAccess) return failure('MODEL_TASK_CONFIRMATION_FORBIDDEN');
    if (localValidationOnly && task.command !== 'validate_model') return failure('MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED', 409);
    if (localSimulationOnly && (task.command !== 'simulate_model' || task.routing?.reason !== 'explicit_local_simulation_task')) return failure('MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED', 409);
    if (structuredAdoptionOnly && (task.command !== 'apply_proposal' || task.creationMode !== 'structured_preview' || task.planning?.provider !== 'none')) return failure('MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED', 409);
    // Only the owned trace is allowed to acknowledge a previous queued write
    // failure before the reference proof. This does not recreate history.
    if (task.traceId) await semanticModelEvidence.get(task.traceId, [role.id], identity).catch(() => null);
    const proof = await inspectTaskReferences(taskId, identity, accessContext);
    if (proof.error) return proof;
    const receipt = await semanticModelEvidence.completeConfirmation({ taskId, identityScope: identity, roleId: role.id });
    return receipt.error ? receipt : { modelId, taskId, ...receipt, confirmationTokenReturned: false, executionEnabled: false };
  } })),
  // Internal only until creation/execution contracts and UI are complete.
  confirmTask: ({ identityScope, modelId, taskId, body, localValidationOnly = false, localSimulationOnly = false, structuredAdoptionOnly = false }) => {
    const payload = structuredClone(body);
    const operation = structuredAdoptionOnly ? 'adopt' : localSimulationOnly ? 'confirmSimulation' : 'confirm';
    return guarded(identityScope, operation, (identity, role, accessContext) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
      if (!validTaskId(taskId) || !payload || Array.isArray(payload) || Object.keys(payload).some(key => !['confirmed', 'expectedTaskFingerprint'].includes(key))
        || payload.confirmed !== true || typeof payload.expectedTaskFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(payload.expectedTaskFingerprint)) return failure('MODEL_TASK_CONFIRMATION_INPUT_INVALID', 400);
      const task = await getSemanticOperationsTask({ taskId, identityScope: identity, accessContext });
      if (!task || task.reviewerAccess) return failure('MODEL_TASK_CONFIRMATION_FORBIDDEN');
      if (localValidationOnly && task.command !== 'validate_model') return failure('MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED', 409);
      if (localSimulationOnly && (task.command !== 'simulate_model' || task.routing?.reason !== 'explicit_local_simulation_task')) return failure('MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED', 409);
      if (structuredAdoptionOnly && (task.command !== 'apply_proposal' || task.creationMode !== 'structured_preview' || task.planning?.provider !== 'none')) return failure('MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED', 409);
      const proof = await inspectTaskReferences(taskId, identity, accessContext);
      if (proof.error) return proof;
      // This new entry requires a verified trace, unlike legacy task callers.
      const record = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[taskId];
      if (!record || record.traceProvisioning !== 'ready' || !await semanticModelEvidence.verifyTaskTrace(record)) return failure('MODEL_TASK_EVIDENCE_NOT_READY', 409);
      const baseline = await check(identity, operation);
      if (!baseline) return failure('MODEL_WORKSPACE_FORBIDDEN');
      const result = await runWithIAMStoreContext(() => issueSemanticOperationsTaskConfirmation({ taskId, identityScope: identity, accessContext: getEffectiveAccess(null, identity),
        expectedTaskFingerprint: payload.expectedTaskFingerprint, evidenceReceiptRequired: true,
        beforeCommit: async () => {
          await assertCurrentSemanticModelAdmission();
          const references = await inspectTaskReferences(taskId, identity, accessContext);
          const authority = await check(identity, operation);
          return !references.error && authority && JSON.stringify(authority) === JSON.stringify(baseline);
        } }), identity.tenantId);
      await assertCurrentSemanticModelAdmission();
      if (result.error) return { error: '任务确认未完成，请重新核对权限、引用和任务状态。', code: result.code, status: 409 };
      const receipt = await semanticModelEvidence.completeConfirmation({ taskId, identityScope: identity, roleId: role.id });
      if (receipt.error) return receipt;
      const confirmed = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[taskId];
      if (!semanticModelReferenceMatches(confirmed) || !semanticOperationsOwnerMatches(confirmed.owner, identity) || confirmed.confirmation?.evidenceState !== 'ready'
        || confirmed.command !== record.command || confirmed.originRoleId !== record.originRoleId || confirmed.proposal?.id !== record.proposal?.id
        || confirmed.proposal?.revision !== record.proposal?.revision || JSON.stringify(confirmed.reviewContext) !== JSON.stringify(record.reviewContext)
        || confirmed.confirmation.tokenHash !== createHash('sha256').update(result.confirmationToken).digest('hex')) return { ...failure('MODEL_TASK_CONFIRMATION_STATE_CHANGED', 409), taskMayHaveCommitted: true };
      return { modelId, task: taskSummary(confirmed), taskFingerprint: semanticTaskStateFingerprint(confirmed), ...receipt, confirmationToken: result.confirmationToken, expiresAt: result.expiresAt, executionEnabled: false };
    } }));
  },
  dialogue: ({ identityScope, modelId, taskId }) => guarded(identityScope, false, (identity, role, accessContext) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
    if (!validTaskId(taskId)) return failure('MODEL_TASK_REQUEST_INVALID', 400);
    await assertCurrentSemanticModelAdmission();
    const task = await getSemanticOperationsTask({ identityScope: identity, taskId, accessContext });
    if (!task) return failure('MODEL_TASK_NOT_FOUND', 404);
    // Review assignment is not permission to read the author's conversation.
    if (task.reviewerAccess) return failure('MODEL_TASK_DIALOGUE_FORBIDDEN');
    const proof = await inspectTaskReferences(taskId, identity, accessContext);
    if (proof.error) return proof;
    const messages = dialogueMessages(task);
    if (!messages) return failure('MODEL_TASK_DIALOGUE_LIMIT_OR_FORMAT', 413);
    const latest = await getSemanticOperationsTask({ identityScope: identity, taskId, accessContext });
    if (!latest || JSON.stringify(latest) !== JSON.stringify(task)) return failure('MODEL_TASK_REFERENCE_CHANGED', 409);
    const record = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[taskId];
    if (!semanticModelReferenceMatches(record) || !semanticOperationsOwnerMatches(record.owner, identity)) return failure('MODEL_TASK_REFERENCE_CHANGED', 409);
    await assertCurrentSemanticModelAdmission();
    return { modelId, taskFingerprint: semanticTaskStateFingerprint(record), task: { ...taskSummary(task), messages, evidenceState: proof.evidenceState }, contentScope: 'owner_dialogue_only',
      runtimeReadEnabled: false, executionEnabled: false, selectionScope: 'request_only' };
  } })),
  inspectTaskReferences: ({ identityScope, modelId, taskId }) => guarded(identityScope, false, (identity, role, accessContext) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
    if (!validTaskId(taskId)) return failure('MODEL_TASK_REQUEST_INVALID', 400);
    await assertCurrentSemanticModelAdmission();
    return inspectTaskReferences(taskId, identity, accessContext);
  } })),
  publish: publishLocalModelWorkspace,
  tasks: ({ identityScope, modelId, filters = {} }) => {
    const selection = structuredClone(filters);
    return guarded(identityScope, false, (identity, role, accessContext) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
      if (!selection || Array.isArray(selection) || Object.keys(selection).some(key => !['offset', 'limit', 'includeArchived'].includes(key))
        || selection.offset !== undefined && (!Number.isSafeInteger(selection.offset) || selection.offset < 0 || selection.offset > 1000000)
        || selection.limit !== undefined && (!Number.isSafeInteger(selection.limit) || selection.limit < 1 || selection.limit > 100)
        || selection.includeArchived !== undefined && typeof selection.includeArchived !== 'boolean') return failure('MODEL_TASK_REQUEST_INVALID', 400);
      await assertCurrentSemanticModelAdmission();
      const tasks = await listSemanticOperationsTasks({ identityScope: identity, accessContext, ...selection });
      await assertCurrentSemanticModelAdmission();
      return { modelId, tasks: tasks.map(taskSummary), offset: selection.offset || 0, limit: selection.limit || 30,
        runtimeReadEnabled: false, selectionScope: 'request_only', contentScope: 'task_metadata_only' };
    } }));
  },
  task: ({ identityScope, modelId, taskId }) => guarded(identityScope, false, (identity, role, accessContext) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
    if (!validTaskId(taskId)) return failure('MODEL_TASK_REQUEST_INVALID', 400);
    await assertCurrentSemanticModelAdmission();
    const task = await getSemanticOperationsTask({ identityScope: identity, taskId, accessContext });
    await assertCurrentSemanticModelAdmission();
    return task ? { modelId, task: taskSummary(task), runtimeReadEnabled: false, selectionScope: 'request_only', contentScope: 'task_metadata_only' }
      : failure('MODEL_TASK_NOT_FOUND', 404);
  } })),
  validate: options => analyzeWorkspace(options, 'validate'),
  simulate: options => analyzeWorkspace(options, 'simulate'),
  simulation: ({ identityScope, modelId }) => guarded(identityScope, false, (identity, role) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
    await assertCurrentSemanticModelAdmission();
    const simulation = await getOAMetaModelSimulation();
    await assertCurrentSemanticModelAdmission();
    return { modelId, simulation: simulationSummary(simulation), runtimeReadEnabled: false, selectionScope: 'request_only' };
  } })),
  draft: ({ identityScope, modelId }) => guarded(identityScope, false, (identity, role) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
    await assertCurrentSemanticModelAdmission();
    const draft = await getOAMetaModelDraft();
    await assertCurrentSemanticModelAdmission();
    return { modelId, draft: editableDraft(draft), runtimeReadEnabled: false, selectionScope: 'request_only' };
  } })),
  saveDraft: ({ identityScope, modelId, body }) => {
    const payload = structuredClone(body);
    return guarded(identityScope, 'draft', (identity, role) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work: async () => {
      if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => !['confirmed', 'expectedFingerprint', 'input'].includes(key))
        || payload.confirmed !== true || typeof payload.expectedFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(payload.expectedFingerprint)
        || !payload.input || typeof payload.input !== 'object' || Array.isArray(payload.input) || !Object.keys(payload.input).length
        || Object.keys(payload.input).some(key => !editableKeys.includes(key)) || !validPatch(payload.input)) return failure('MODEL_DRAFT_INPUT_INVALID', 400);
      await assertCurrentSemanticModelAdmission();
      const result = await runWithIAMStoreContext(() => {
        const access = getEffectiveAccess(null, identity);
        if (!access.principalResolved || !access.roleIds.includes('executive') || !access.pagePermissionIds.includes('page.semantic-operations.view') || !access.buttonPermissionIds.includes('meta_model.draft.save')) return failure('MODEL_WORKSPACE_FORBIDDEN');
        return saveSemanticOperationsDraft({ input: payload.input, expectedFingerprint: payload.expectedFingerprint, role: getRole('executive'), identityScope: identity });
      }, identity.tenantId);
      await assertCurrentSemanticModelAdmission();
      return result.error ? { error: result.error, code: result.code || 'MODEL_DRAFT_SAVE_REJECTED', status: result.status || 400 }
        : { draft: editableDraft(result.draft), ...(result.snapshot ? { snapshot: { id: result.snapshot.id, sourceType: result.snapshot.sourceType, createdAt: result.snapshot.createdAt } } : {}), modelId, runtimeReadEnabled: false, selectionScope: 'request_only' };
    } }));
  },
  list: ({ identityScope }) => guarded(identityScope, false, (identity, role) => semanticModelRegistry.list({ role, identityScope: identity })),
  register: ({ identityScope, body }) => {
    const payload = structuredClone(body);
    return guarded(identityScope, true, (identity, role) => semanticModelRegistry.register({ role, identityScope: identity, body: payload }));
  },
  inspect: ({ identityScope, modelId }) => guarded(identityScope, false, (identity, role) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId,
    work: async () => {
      await assertCurrentSemanticModelAdmission();
      const draft = await getOAMetaModelDraft(); const simulation = await getOAMetaModelSimulation(); const published = await getPublishedOntologyModel();
      await assertCurrentSemanticModelAdmission();
      return { modelId, selectionScope: 'request_only', runtimeReadEnabled: false, runtimeSelectionEnabled: false,
        draft: { fingerprint: draft.fingerprint, objectCount: draft.objectTypes.length, relationshipCount: draft.relationshipTypes.length },
        simulation: simulation ? { status: simulation.status, validationStatus: simulation.validation?.status } : null,
        publication: published ? { version: published.version, fingerprint: published.fingerprint } : null,
        availableOperations: ['inspect_workspace'], unavailableOperations: ['business_read', 'shared_route_activation', 'world_model_templates', 'material_evidence_chain'] };
    } }))
};

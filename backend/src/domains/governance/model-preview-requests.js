import { createHash } from 'node:crypto';
import { currentSemanticModel, assertSemanticTenant } from '../../services/semantic-tenant-context.js';
import { assertCurrentSemanticModelAdmission } from '../../services/semantic-model-reference.js';
import { semanticOperationsPrincipalKey } from '../../services/semantic-operations-identity.js';
import { mutateSemanticGovernanceState, mutateSemanticGovernanceStates, readSemanticGovernanceState } from '../../services/semantic-governance-store.js';

// Internal reservation primitive, not an IAM grant or retry/lease mechanism.
// An occupied slot must not restart preparation. Fresh admission, evidence
// completion and uncertain-response reuse still need facade composition.
export const semanticPreviewRequests = {
  inspectStatus: async ({ identityScope, roleId, requestId }) => {
    const identity = structuredClone(identityScope); assertSemanticTenant(identity);
    await assertCurrentSemanticModelAdmission();
    if (!identity?.tenantId || !identity?.subjectId || roleId !== 'executive'
      || typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(requestId)) return { code: 'MODEL_PREVIEW_STATUS_INPUT_INVALID', status: 400 };
    const owner = semanticOperationsPrincipalKey(identity); const modelId = currentSemanticModel();
    const key = createHash('sha256').update(JSON.stringify([modelId, owner, roleId, requestId])).digest('hex');
    const read = async () => (await readSemanticGovernanceState('semantic_preview_requests', owner, {}))[key];
    const slot = await read();
    if (!slot) return { code: 'MODEL_PREVIEW_REQUEST_NOT_FOUND', status: 404 };
    if (slot.modelId !== modelId || slot.owner !== owner || slot.roleId !== roleId || slot.requestId !== requestId || !['reserved', 'prepared', 'committed'].includes(slot.state)
      || typeof slot.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(slot.inputFingerprint)) return { code: 'MODEL_PREVIEW_RECEIPT_INVALID', status: 409 };
    const binding = { identityScope: identity, roleId, requestId, inputFingerprint: slot.inputFingerprint, expectedCheckpointFingerprint: slot.checkpointFingerprint };
    if (slot.state === 'prepared') {
      const prepared = await semanticPreviewRequests.loadPreparedTask(binding);
      if (prepared.code) return prepared;
    } else if (slot.state === 'committed') {
      const committed = await semanticPreviewRequests.loadCommittedTask(binding);
      if (committed.code) return committed;
    }
    const latest = await read();
    await assertCurrentSemanticModelAdmission();
    if (JSON.stringify(slot) !== JSON.stringify(latest)) return { code: 'MODEL_PREVIEW_CHECKPOINT_CHANGED', status: 409 };
    return { modelId, state: slot.state, inputFingerprint: slot.inputFingerprint,
      ...(slot.checkpointFingerprint ? { checkpointFingerprint: slot.checkpointFingerprint } : {}), ...(slot.state === 'committed' ? { taskId: slot.taskId } : {}),
      preparationAllowed: false, automaticRetryAllowed: false, automaticTakeoverAllowed: false,
      ...(slot.state === 'reserved' ? { blocker: 'preparation_checkpoint_absent' } : {}), executionEnabled: false };
  },
  loadCommittedTask: async ({ identityScope, roleId, requestId, inputFingerprint, expectedCheckpointFingerprint }) => {
    const identity = structuredClone(identityScope); assertSemanticTenant(identity);
    await assertCurrentSemanticModelAdmission();
    if (!identity?.tenantId || !identity?.subjectId || roleId !== 'executive'
      || typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(requestId)
      || typeof inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(inputFingerprint)
      || typeof expectedCheckpointFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedCheckpointFingerprint)) return { code: 'MODEL_PREVIEW_RECEIPT_INPUT_INVALID', status: 400 };
    const owner = semanticOperationsPrincipalKey(identity); const modelId = currentSemanticModel();
    const key = createHash('sha256').update(JSON.stringify([modelId, owner, roleId, requestId])).digest('hex');
    const slot = (await readSemanticGovernanceState('semantic_preview_requests', owner, {}))[key];
    if (!slot || slot.state !== 'committed' || slot.modelId !== modelId || slot.owner !== owner || slot.roleId !== roleId || slot.requestId !== requestId
      || slot.inputFingerprint !== inputFingerprint || slot.checkpointFingerprint !== expectedCheckpointFingerprint) return { code: 'MODEL_PREVIEW_RECEIPT_INVALID', status: 409 };
    const task = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[slot.taskId];
    if (!task || task.owner !== owner || task.originRoleId !== roleId || task.modelId !== modelId || task.creationRequestId !== requestId
      || task.creationInputFingerprint !== inputFingerprint || task.previewCheckpointFingerprint !== expectedCheckpointFingerprint
      || !await semanticPreviewRequests.verifyCommittedTask(task)) return { code: 'MODEL_PREVIEW_RECEIPT_INVALID', status: 409 };
    await assertCurrentSemanticModelAdmission();
    return { modelId, state: 'committed', task: structuredClone(task) };
  },
  // Internal snapshot read only. A caller still must freshly authorize and
  // revalidate draft, materials, proposal, sources and trace before resuming.
  loadPreparedTask: async ({ identityScope, roleId, requestId, inputFingerprint, expectedCheckpointFingerprint }) => {
    const identity = structuredClone(identityScope); assertSemanticTenant(identity);
    await assertCurrentSemanticModelAdmission();
    if (!identity?.tenantId || !identity?.subjectId || roleId !== 'executive'
      || typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(requestId)
      || typeof inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(inputFingerprint)
      || typeof expectedCheckpointFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedCheckpointFingerprint)) return { code: 'MODEL_PREVIEW_PREPARED_INPUT_INVALID', status: 400 };
    const owner = semanticOperationsPrincipalKey(identity); const modelId = currentSemanticModel();
    const key = createHash('sha256').update(JSON.stringify([modelId, owner, roleId, requestId])).digest('hex');
    const read = async () => (await readSemanticGovernanceState('semantic_preview_requests', owner, {}))[key];
    const slot = await read(); const task = slot?.preparedTask;
    if (!slot || slot.modelId !== modelId || slot.owner !== owner || slot.roleId !== roleId || slot.requestId !== requestId || slot.inputFingerprint !== inputFingerprint
      || slot.state !== 'prepared' || slot.checkpointFingerprint !== expectedCheckpointFingerprint
      || !task || task.modelId !== modelId || task.owner !== owner || task.originRoleId !== roleId || task.creationMode !== 'structured_preview'
      || task.planning?.provider !== 'none' || task.status !== 'waiting_confirmation' || task.confirmation?.state !== 'not_issued'
      || Buffer.byteLength(JSON.stringify(task)) > 256 * 1024 || createHash('sha256').update(JSON.stringify(task)).digest('hex') !== expectedCheckpointFingerprint)
      return { code: 'MODEL_PREVIEW_PREPARED_INVALID', status: 409 };
    if ((await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[task.id]) return { code: 'MODEL_PREVIEW_TASK_COLLISION', status: 409 };
    const latest = await read();
    await assertCurrentSemanticModelAdmission();
    if (JSON.stringify(slot) !== JSON.stringify(latest)) return { code: 'MODEL_PREVIEW_CHECKPOINT_CHANGED', status: 409 };
    return { modelId, state: 'prepared', checkpointFingerprint: expectedCheckpointFingerprint, task: structuredClone(task), executionEnabled: false };
  },
  // Verifies persisted links, never trusts a task's marker as a receipt.
  verifyCommittedTask: async task => {
    const expected = structuredClone(task);
    await assertCurrentSemanticModelAdmission();
    if (!expected || expected.modelId !== currentSemanticModel() || expected.creationMode !== 'structured_preview'
      || typeof expected.owner !== 'string' || expected.originRoleId !== 'executive'
      || typeof expected.creationRequestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(expected.creationRequestId)
      || typeof expected.creationInputFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(expected.creationInputFingerprint)) return false;
    const key = createHash('sha256').update(JSON.stringify([expected.modelId, expected.owner, expected.originRoleId, expected.creationRequestId])).digest('hex');
    const readReceipt = async () => (await readSemanticGovernanceState('semantic_preview_requests', expected.owner, {}))[key];
    const receipt = await readReceipt();
    if (!receipt || receipt.state !== 'committed' || receipt.modelId !== expected.modelId || receipt.owner !== expected.owner || receipt.roleId !== expected.originRoleId
      || receipt.requestId !== expected.creationRequestId || receipt.inputFingerprint !== expected.creationInputFingerprint || receipt.taskId !== expected.id
      || receipt.checkpointFingerprint !== expected.previewCheckpointFingerprint) return false;
    const stored = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[expected.id];
    const latestReceipt = await readReceipt();
    await assertCurrentSemanticModelAdmission();
    return JSON.stringify(stored) === JSON.stringify(expected) && JSON.stringify(receipt) === JSON.stringify(latestReceipt);
  },
  reserve: async ({ identityScope, roleId, requestId, inputFingerprint }) => {
    const identity = structuredClone(identityScope); assertSemanticTenant(identity);
    if (!identity?.tenantId || !identity?.subjectId || roleId !== 'executive'
      || typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(requestId)
      || typeof inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(inputFingerprint)) return { code: 'MODEL_PREVIEW_REQUEST_INPUT_INVALID', status: 400 };
    await assertCurrentSemanticModelAdmission();
    const modelId = currentSemanticModel(); const owner = semanticOperationsPrincipalKey(identity);
    const key = createHash('sha256').update(JSON.stringify([modelId, owner, roleId, requestId])).digest('hex');
    const result = await mutateSemanticGovernanceState('semantic_preview_requests', owner, {}, requests => {
      const existing = requests[key];
      if (existing) {
        if (existing.modelId !== modelId || existing.owner !== owner || existing.roleId !== roleId || existing.requestId !== requestId || existing.inputFingerprint !== inputFingerprint
          || !['reserved', 'prepared', 'committed'].includes(existing.state)) return { commit: false, result: { code: 'MODEL_PREVIEW_REQUEST_CONFLICT', status: 409 } };
        return { commit: false, result: { modelId, requestKey: key, state: existing.state, ...(existing.state === 'committed' ? { taskId: existing.taskId } : {}), reused: true, preparationAllowed: false } };
      }
      if (Object.keys(requests).length >= 200) return { commit: false, result: { code: 'MODEL_PREVIEW_REQUEST_CAPACITY', status: 409 } };
      requests[key] = { modelId, owner, roleId, requestId, inputFingerprint, state: 'reserved' };
      return { value: requests, result: { modelId, requestKey: key, state: 'reserved', reused: false, preparationAllowed: true } };
    });
    // A revoked registration can leave a reservation, never an authorized
    // successful response. There is no automatic deletion or takeover.
    await assertCurrentSemanticModelAdmission();
    return result;
  },
  checkpointPreparedTask: async ({ identityScope, roleId, requestId, inputFingerprint, task }) => {
    const identity = structuredClone(identityScope); const prepared = structuredClone(task); assertSemanticTenant(identity);
    await assertCurrentSemanticModelAdmission();
    const owner = semanticOperationsPrincipalKey(identity); const modelId = currentSemanticModel();
    if (roleId !== 'executive' || typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(requestId)
      || typeof inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(inputFingerprint)
      || !prepared || prepared.modelId !== modelId || prepared.owner !== owner || prepared.originRoleId !== roleId
      || typeof prepared.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(prepared.id)
      || prepared.creationMode !== 'structured_preview' || prepared.planning?.provider !== 'none'
      || prepared.status !== 'waiting_confirmation' || prepared.confirmation?.state !== 'not_issued' || !prepared.traceId
      || Buffer.byteLength(JSON.stringify(prepared)) > 256 * 1024) return { code: 'MODEL_PREVIEW_CHECKPOINT_INPUT_INVALID', status: 400 };
    const requestKey = createHash('sha256').update(JSON.stringify([modelId, owner, roleId, requestId])).digest('hex');
    const checkpointFingerprint = createHash('sha256').update(JSON.stringify(prepared)).digest('hex');
    const result = await mutateSemanticGovernanceState('semantic_preview_requests', owner, {}, slots => {
      const slot = slots[requestKey];
      if (!slot || slot.modelId !== modelId || slot.owner !== owner || slot.roleId !== roleId || slot.requestId !== requestId || slot.inputFingerprint !== inputFingerprint
        || !['reserved', 'prepared'].includes(slot.state)) return { commit: false, result: { code: 'MODEL_PREVIEW_CHECKPOINT_CONFLICT', status: 409 } };
      if (slot.state === 'prepared') return { commit: false, result: slot.checkpointFingerprint === checkpointFingerprint && JSON.stringify(slot.preparedTask) === JSON.stringify(prepared)
        ? { modelId, state: 'prepared', checkpointFingerprint, reused: true } : { code: 'MODEL_PREVIEW_CHECKPOINT_CONFLICT', status: 409 } };
      slots[requestKey] = { ...slot, state: 'prepared', preparedTask: prepared, checkpointFingerprint };
      return { value: slots, result: { modelId, state: 'prepared', checkpointFingerprint, reused: false } };
    });
    await assertCurrentSemanticModelAdmission(); return result;
  },
  // Caller must perform fresh IAM, draft/source and proposal admission. Only
  // the request receipt and the prepared task share this transaction.
  commitPreparedTask: async ({ identityScope, roleId, requestId, inputFingerprint, task }) => {
    const identity = structuredClone(identityScope); const prepared = structuredClone(task); assertSemanticTenant(identity);
    await assertCurrentSemanticModelAdmission();
    const owner = semanticOperationsPrincipalKey(identity); const modelId = currentSemanticModel();
    if (roleId !== 'executive' || typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(requestId)
      || typeof inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(inputFingerprint)
      || !prepared || prepared.modelId !== modelId || prepared.owner !== owner || prepared.originRoleId !== roleId
      || typeof prepared.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(prepared.id)
      || prepared.creationMode !== 'structured_preview' || prepared.planning?.provider !== 'none'
      || prepared.status !== 'waiting_confirmation' || prepared.confirmation?.state !== 'not_issued' || !prepared.traceId) return { code: 'MODEL_PREVIEW_COMMIT_INPUT_INVALID', status: 400 };
    const requestKey = createHash('sha256').update(JSON.stringify([modelId, owner, roleId, requestId])).digest('hex');
    const result = await mutateSemanticGovernanceStates([
      { name: 'requests', namespace: 'semantic_preview_requests', key: owner, initialValue: {} },
      { name: 'tasks', namespace: 'semantic_operations_agent_tasks', key: 'index', initialValue: {} }
    ], ({ requests, tasks }) => {
      const slot = requests[requestKey];
      if (!slot || slot.modelId !== modelId || slot.owner !== owner || slot.roleId !== roleId || slot.requestId !== requestId || slot.inputFingerprint !== inputFingerprint)
        return { commit: false, result: { code: 'MODEL_PREVIEW_REQUEST_CONFLICT', status: 409 } };
      if (!['reserved', 'prepared'].includes(slot.state)) return { commit: false, result: { code: 'MODEL_PREVIEW_REQUEST_ALREADY_COMMITTED', status: 409 } };
      if (slot.state === 'prepared' && (slot.checkpointFingerprint !== createHash('sha256').update(JSON.stringify(prepared)).digest('hex') || JSON.stringify(slot.preparedTask) !== JSON.stringify(prepared)))
        return { commit: false, result: { code: 'MODEL_PREVIEW_CHECKPOINT_CONFLICT', status: 409 } };
      if (tasks[prepared.id]) return { commit: false, result: { code: 'MODEL_PREVIEW_TASK_COLLISION', status: 409 } };
      if (Object.keys(tasks).length >= 200) return { commit: false, result: { code: 'MODEL_PREVIEW_TASK_CAPACITY', status: 409 } };
      tasks[prepared.id] = { ...prepared, creationRequestId: requestId, creationInputFingerprint: inputFingerprint,
        ...(slot.checkpointFingerprint ? { previewCheckpointFingerprint: slot.checkpointFingerprint } : {}), traceProvisioning: 'pending' };
      requests[requestKey] = { ...slot, state: 'committed', taskId: prepared.id };
      delete requests[requestKey].preparedTask;
      return { values: { requests, tasks }, result: { modelId, taskId: prepared.id, requestKey, state: 'committed', evidenceState: 'pending' } };
    });
    await assertCurrentSemanticModelAdmission(); return result;
  }
};

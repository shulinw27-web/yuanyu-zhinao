import { currentSemanticModel, currentSemanticTenant, semanticTenantContextIsBound, assertSemanticTenant } from '../../services/semantic-tenant-context.js';
import { createHash, randomUUID } from 'node:crypto';
import { assertCurrentSemanticModelAdmission, semanticModelReferenceMatches } from '../../services/semantic-model-reference.js';
import { createAgentEvidenceTrace, appendAgentEvidenceEvent, getAgentEvidenceTrace, getAgentEvidenceTraceInternal, setAgentEvidenceTraceStatus } from '../../services/agent-evidence-trace-service.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceState } from '../../services/semantic-governance-store.js';
import { semanticOperationsOwnerMatches } from '../../services/semantic-operations-identity.js';
import { semanticPreviewRequests } from './model-preview-requests.js';

// Server-only task composition, not an HTTP grant or a client-selected model.
const admitted = async work => {
  await assertCurrentSemanticModelAdmission();
  const result = await work(currentSemanticModel());
  await assertCurrentSemanticModelAdmission();
  return result;
};
// Existing offline default-model fixtures have no bound tenant context. All
// registered model workspaces and authenticated routes bind one explicitly.
const expectedTenant = () => semanticTenantContextIsBound() ? currentSemanticTenant() : undefined;
export const semanticModelEvidence = {
  completePendingPreview: async ({ taskId, identityScope, roleId, expectedTaskFingerprint }) => {
    const identity = structuredClone(identityScope); assertSemanticTenant(identity);
    try { return await admitted(async expectedModelId => {
      const task = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[taskId];
      if (!semanticModelReferenceMatches(task) || !semanticOperationsOwnerMatches(task.owner, identity) || task.originRoleId !== roleId
        || task.creationMode !== 'structured_preview' || task.traceProvisioning !== 'pending' || task.status !== 'waiting_confirmation' || task.confirmation?.state !== 'not_issued'
        || !/^[a-f0-9]{64}$/u.test(task.previewCheckpointFingerprint || '')
        || createHash('sha256').update(JSON.stringify(task || null)).digest('hex').slice(0, 24) !== expectedTaskFingerprint
        || !await semanticPreviewRequests.verifyCommittedTask(task)) throw new Error('PENDING_PREVIEW_BINDING_INVALID');
      const trace = await getAgentEvidenceTraceInternal(task.traceId, { expectedModelId });
      if (!trace || trace.requestId !== task.id || trace.roleId !== roleId || !semanticOperationsOwnerMatches(task.owner, trace.identityScope)) throw new Error('PENDING_PREVIEW_TRACE_INVALID');
      if (trace.events.some(event => event.type === 'semantic_intent_routed' && (event.details?.intent !== task.intent || event.details?.command !== task.command))) throw new Error('PENDING_PREVIEW_ROUTING_CONFLICT');
      const options = { expectedModelId, expectedTenantId: expectedTenant() };
      // Recovery observations are recorded now, never backdated as original
      // execution history. No absent or corrupted trace is reconstructed.
      await appendAgentEvidenceEvent(task.traceId, { idempotencyKey: 'preview-recovery-observed-v1', type: 'semantic_preview_receipt_recovered', stage: 'evidence', status: 'completed',
        summary: '按现有准备检查点和实际引用恢复候选回执；这是当前核验记录，不是补造历史执行。',
        details: { taskId, checkpointFingerprint: task.previewCheckpointFingerprint, recoveryObservation: true } }, options);
      if (!trace.events.some(event => event.type === 'semantic_intent_routed')) await appendAgentEvidenceEvent(task.traceId, {
        idempotencyKey: 'preview-recovery-routing-v1', type: 'semantic_intent_routed', stage: 'routing', status: 'completed', summary: '恢复时核验已保存的服务器路由。',
        details: { intent: task.intent, command: task.command, recoveryObservation: true } }, options);
      if (task.proposal && !trace.events.some(event => event.type === 'semantic_proposal_generated' && event.details?.proposalId === task.proposal.id && event.details?.revision === task.proposal.revision)) {
        if (trace.events.some(event => event.type === 'semantic_proposal_generated')) throw new Error('PENDING_PREVIEW_PROPOSAL_CONFLICT');
        await appendAgentEvidenceEvent(task.traceId, { idempotencyKey: 'preview-recovery-proposal-v1', type: 'semantic_proposal_generated', stage: 'proposal', status: 'completed',
          summary: '恢复时核验实际候选提案及修订；未重新生成候选。', details: { proposalId: task.proposal.id, revision: task.proposal.revision, recoveryObservation: true } }, options);
      }
      await setAgentEvidenceTraceStatus(task.traceId, 'awaiting_confirmation', options);
      return semanticModelEvidence.completePreviewCreation({ taskId, identityScope: identity, roleId, expectedTaskFingerprint });
    }); } catch { return { error: '候选任务已提交，但证据恢复未完成；仍不能确认或执行。', code: 'SEMANTIC_PENDING_PREVIEW_RECOVERY_INCOMPLETE', status: 409, evidencePending: true, taskMayHaveCommitted: true }; }
  },
  quarantinePreviewEvidence: async ({ taskId, identityScope, roleId }) => admitted(async expectedModelId => {
    const identity = structuredClone(identityScope); assertSemanticTenant(identity);
    const task = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[taskId];
    if (!semanticModelReferenceMatches(task) || !semanticOperationsOwnerMatches(task.owner, identity) || task.originRoleId !== roleId
      || task.creationMode !== 'structured_preview' || task.traceProvisioning !== 'ready') return false;
    const trace = await getAgentEvidenceTraceInternal(task.traceId, { expectedModelId }).catch(() => null);
    if (trace && trace.requestId === task.id && trace.roleId === roleId && semanticOperationsOwnerMatches(task.owner, trace.identityScope)
      && trace.events.some(event => event.type === 'semantic_intent_routed')
      && (!task.proposal || trace.events.some(event => event.type === 'semantic_proposal_generated' && event.details?.proposalId === task.proposal.id && event.details?.revision === task.proposal.revision))) return false;
    await assertCurrentSemanticModelAdmission();
    return mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => {
      if (JSON.stringify(index[taskId]) !== JSON.stringify(task)) return { commit: false, result: false };
      index[taskId].traceProvisioning = 'missing'; return { value: index, result: true };
    });
  }),
  completePreviewCreation: async ({ taskId, identityScope, roleId, expectedTaskFingerprint }) => {
    const identity = structuredClone(identityScope); assertSemanticTenant(identity);
    try { return await admitted(async expectedModelId => {
      const task = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[taskId];
      if (expectedTaskFingerprint !== undefined && createHash('sha256').update(JSON.stringify(task || null)).digest('hex').slice(0, 24) !== expectedTaskFingerprint) throw new Error('PREVIEW_TASK_FINGERPRINT_CHANGED');
      if (!semanticModelReferenceMatches(task) || !semanticOperationsOwnerMatches(task.owner, identity) || task.originRoleId !== roleId
        || task.creationMode !== 'structured_preview' || task.planning?.provider !== 'none' || !task.traceId) throw new Error('PREVIEW_TASK_BINDING_INVALID');
      if ((task.creationRequestId !== undefined || task.creationInputFingerprint !== undefined) && !await semanticPreviewRequests.verifyCommittedTask(task)) throw new Error('PREVIEW_REQUEST_RECEIPT_INVALID');
      const trace = await getAgentEvidenceTraceInternal(task.traceId, { expectedModelId });
      if (!trace || trace.requestId !== task.id || trace.roleId !== roleId || !semanticOperationsOwnerMatches(task.owner, trace.identityScope)
        || !trace.events.some(event => event.type === 'semantic_intent_routed')
        || task.proposal && !trace.events.some(event => event.type === 'semantic_proposal_generated' && event.details?.proposalId === task.proposal.id && event.details?.revision === task.proposal.revision)) throw new Error('PREVIEW_EVIDENCE_INCOMPLETE');
      await assertCurrentSemanticModelAdmission();
      if ((task.creationRequestId !== undefined || task.creationInputFingerprint !== undefined) && !await semanticPreviewRequests.verifyCommittedTask(task)) throw new Error('PREVIEW_REQUEST_RECEIPT_CHANGED');
      const linked = await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => {
        if (JSON.stringify(index[taskId]) !== JSON.stringify(task)) return { commit: false, result: false };
        index[taskId].traceProvisioning = 'ready'; return { value: index, result: true };
      });
      if (!linked) throw new Error('PREVIEW_TASK_LINK_CHANGED');
      return { evidenceState: 'ready', traceId: task.traceId };
    }); } catch { return { error: '候选任务可能已保存，但证据不完整或引用已变化；未开放确认/执行。', code: 'SEMANTIC_PREVIEW_EVIDENCE_INCOMPLETE', status: 409, taskMayHaveCommitted: true }; }
  },
  completeLocalCreation: async ({ taskId, identityScope, roleId }) => {
    const identity = structuredClone(identityScope); assertSemanticTenant(identity);
    try { return await admitted(async modelId => {
      const task = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[taskId];
      const simulation = task?.command === 'simulate_model' && task.routing?.reason === 'explicit_local_simulation_task';
      const creationEvent = simulation ? 'local_simulation_task_created' : 'local_validation_task_created';
      if (!semanticModelReferenceMatches(task) || !semanticOperationsOwnerMatches(task.owner, identity) || task.originRoleId !== roleId
        || !simulation && (task.command !== 'validate_model' || task.routing?.reason !== 'explicit_local_validation_task') || !task.creationRequestId || !task.traceId) throw new Error('LOCAL_TASK_BINDING_INVALID');
      const previous = await getAgentEvidenceTrace(task.traceId, [roleId], identity, { expectedModelId: modelId }).catch(() => null);
      if (task.traceProvisioning === 'missing') throw new Error('LOCAL_READY_TRACE_MISSING');
      if (task.traceProvisioning === 'ready') {
        const bound = previous && await getAgentEvidenceTraceInternal(task.traceId, { expectedModelId: modelId });
        if (!bound || bound.requestId !== task.id || bound.roleId !== roleId || !semanticOperationsOwnerMatches(task.owner, bound.identityScope)
          || !previous.events.some(event => event.type === creationEvent && event.details?.creationRequestId === task.creationRequestId)) {
          await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => {
            if (JSON.stringify(index[taskId]) !== JSON.stringify(task)) return { commit: false, result: false };
            index[taskId].traceProvisioning = 'missing'; return { value: index };
          });
          throw new Error('LOCAL_READY_TRACE_MISSING');
        }
        return { evidenceState: 'ready', traceId: task.traceId };
      }
      if (task.traceProvisioning !== 'pending' || task.status !== 'waiting_confirmation' || task.confirmation?.state !== 'not_issued') throw new Error('LOCAL_TASK_STATE_CHANGED');
      await createAgentEvidenceTrace({ modelId, kind: 'semantic_operations_task', reservedTraceId: task.traceId, roleId, identityScope: identity, input: task.request, requestId: task.id });
      await appendAgentEvidenceEvent(task.traceId, { idempotencyKey: 'local-task-creation-v1', type: creationEvent, stage: 'planning', status: 'completed',
        summary: '创建本地校验或合成模拟任务，等待明确确认；没有调用大模型、执行或发布。', details: { creationRequestId: task.creationRequestId, createdAt: task.createdAt } },
      { expectedModelId: modelId, expectedTenantId: expectedTenant() });
      const trace = await getAgentEvidenceTrace(task.traceId, [roleId], identity, { expectedModelId: modelId });
      if (!trace?.integrity.valid) throw new Error('LOCAL_TRACE_INVALID');
      if (trace.status === 'started') await setAgentEvidenceTraceStatus(task.traceId, 'awaiting_confirmation', { expectedModelId: modelId, expectedTenantId: expectedTenant() });
      await assertCurrentSemanticModelAdmission();
      const linked = await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => {
        if (JSON.stringify(index[taskId]) !== JSON.stringify(task)) return { commit: false, result: false };
        index[taskId].traceProvisioning = 'ready'; return { value: index, result: true };
      });
      if (!linked) throw new Error('LOCAL_TASK_LINK_CHANGED');
      return { evidenceState: 'ready', traceId: task.traceId };
    }); } catch { return { error: '本地任务可能已创建，但证据尚未就绪；同请求重试只恢复证据，不新建任务。', code: 'SEMANTIC_LOCAL_TASK_EVIDENCE_PENDING', status: 409, evidencePending: true, taskMayHaveCommitted: true }; }
  },
  completeConfirmation: async ({ taskId, identityScope, roleId }) => {
    const identity = structuredClone(identityScope); assertSemanticTenant(identity);
    try { return await admitted(async expectedModelId => {
      const task = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[taskId];
      if (!semanticModelReferenceMatches(task) || !semanticOperationsOwnerMatches(task.owner, identity) || task.originRoleId !== roleId
        || task.traceProvisioning !== 'ready' || task.confirmation?.state !== 'issued' || !['pending', 'ready'].includes(task.confirmation.evidenceState)
        || !/^[a-f0-9]{64}$/u.test(task.confirmation.tokenHash || '') || !['waiting_confirmation', 'retryable'].includes(task.status)) throw new Error('CONFIRMATION_BINDING_INVALID');
      // Drain any prior failed queued mutation before validating the stored
      // trace. No missing trace or invalid chain is silently reconstructed.
      await getAgentEvidenceTrace(task.traceId, [roleId], identity, { expectedModelId }).catch(() => null);
      const trace = await getAgentEvidenceTraceInternal(task.traceId, { expectedModelId });
      if (!trace || trace.requestId !== task.id || trace.roleId !== roleId || !semanticOperationsOwnerMatches(task.owner, trace.identityScope)) throw new Error('CONFIRMATION_TRACE_INVALID');
      const marker = createHash('sha256').update(task.confirmation.tokenHash).digest('hex').slice(0, 32);
      await appendAgentEvidenceEvent(task.traceId, { idempotencyKey: `confirmation-${marker}`, type: 'semantic_confirmation_issued', stage: 'confirmation', status: 'awaiting_user',
        summary: '已签发绑定草稿与提案版本的一次性确认凭证，尚未执行。', details: { issuedAt: task.confirmation.issuedAt, expiresAt: task.confirmation.expiresAt,
          proposalRevision: task.proposal?.revision || null } }, { expectedModelId, expectedTenantId: expectedTenant() });
      await setAgentEvidenceTraceStatus(task.traceId, 'confirmed_pending_execution', { expectedModelId, expectedTenantId: expectedTenant() });
      const recorded = await getAgentEvidenceTrace(task.traceId, [roleId], identity, { expectedModelId });
      if (!recorded?.integrity.valid || !recorded.events.some(event => event.type === 'semantic_confirmation_issued' && event.details?.issuedAt === task.confirmation.issuedAt
        && event.details?.expiresAt === task.confirmation.expiresAt)) throw new Error('CONFIRMATION_RECEIPT_MISSING');
      await assertCurrentSemanticModelAdmission();
      const linked = await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => {
        const current = index[taskId];
        if (JSON.stringify(current) !== JSON.stringify(task) || !semanticModelReferenceMatches(current) || current.owner !== task.owner || current.traceId !== task.traceId || current.confirmation?.state !== 'issued'
          || current.confirmation.tokenHash !== task.confirmation.tokenHash || current.confirmation.issuedAt !== task.confirmation.issuedAt
          || current.confirmation.expiresAt !== task.confirmation.expiresAt || !['waiting_confirmation', 'retryable'].includes(current.status)) return { commit: false, result: false };
        current.confirmation.evidenceState = 'ready'; return { value: index, result: true };
      });
      if (!linked) throw new Error('CONFIRMATION_LINK_CHANGED');
      return { confirmationEvidenceState: 'ready' };
    }); } catch { return { error: '确认可能已签发，但证据尚未完成；未返回凭证、未执行，请先恢复证据。', code: 'SEMANTIC_CONFIRMATION_EVIDENCE_PENDING', status: 409, evidencePending: true, taskMayHaveCommitted: true }; }
  },
  verifyTaskTrace: task => admitted(async expectedModelId => {
    const trace = await getAgentEvidenceTraceInternal(task.traceId, { expectedModelId });
    return Boolean(trace && trace.requestId === task.id && trace.roleId === task.originRoleId && semanticOperationsOwnerMatches(task.owner, trace.identityScope)
      && (!expectedTenant() || trace.identityScope.tenantId === expectedTenant()));
  }),
  attachOnboarding: async ({ taskId, identityScope, roleId }) => {
    const identity = structuredClone(identityScope); assertSemanticTenant(identity);
    try { return await admitted(async modelId => {
      let task = (await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}))[taskId];
      if (!semanticModelReferenceMatches(task) || !semanticOperationsOwnerMatches(task.owner, identity) || task.originRoleId !== roleId
        || !task.onboardingSource) throw new Error('HANDOFF_TRACE_BINDING_REQUIRED');
      if (!task.traceId) {
        task = await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => {
          const current = index[taskId];
          if (!semanticModelReferenceMatches(current) || !semanticOperationsOwnerMatches(current.owner, identity) || current.originRoleId !== roleId
            || current.proposal?.id !== task.proposal?.id) return { commit: false, result: null };
          if (current.traceId) return { commit: false, result: structuredClone(current) };
          current.traceId = `trace-${randomUUID()}`; current.traceProvisioning = 'pending'; current.traceBackfilled = true;
          return { value: index, result: structuredClone(current) };
        });
        if (!task) throw new Error('HANDOFF_TRACE_LINK_CHANGED');
      }
      // Acknowledge a prior queued storage failure only for this owned reserved
      // reference; initialization below still validates identity and integrity.
      const previousTrace = await getAgentEvidenceTrace(task.traceId, [roleId], identity, { expectedModelId: modelId }).catch(() => null);
      if (['ready', 'missing'].includes(task.traceProvisioning) && !previousTrace) {
        await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => {
          const current = index[taskId];
          if (semanticModelReferenceMatches(current) && current.traceId === task.traceId && semanticOperationsOwnerMatches(current.owner, identity)) {
            current.traceProvisioning = 'missing'; return { value: index };
          }
          return { commit: false, result: null };
        });
        throw new Error('HANDOFF_READY_TRACE_MISSING');
      }
      await createAgentEvidenceTrace({ modelId, kind: 'semantic_operations_task', reservedTraceId: task.traceId, roleId, identityScope: identity,
        input: task.request, requestId: task.id, platform: identity.platform });
      await appendAgentEvidenceEvent(task.traceId, { idempotencyKey: 'onboarding-handoff-v1', type: 'onboarding_handoff', stage: 'proposal', status: 'completed',
        summary: task.traceBackfilled ? '根据已有Mock交接记录补建证据，不推断缺失的过去执行历史。' : 'Mock项目已交接为待人工审核的模型任务，尚未采纳或发布。', details: { backfilled: Boolean(task.traceBackfilled), projectId: task.onboardingSource.projectId,
          proposalId: task.proposal.id, modelId, materialRevision: task.onboardingSource.materialRevision, sourceKind: task.onboardingSource.sourceKind } },
      { expectedModelId: modelId, expectedTenantId: expectedTenant() });
      const trace = await getAgentEvidenceTrace(task.traceId, [roleId], identity, { expectedModelId: modelId });
      if (!trace?.integrity.valid) throw new Error('HANDOFF_TRACE_INVALID');
      // Recovery must never downgrade a task trace that already reached execution.
      if (trace.status === 'started') await setAgentEvidenceTraceStatus(task.traceId, 'awaiting_confirmation', { expectedModelId: modelId, expectedTenantId: expectedTenant() });
      await assertCurrentSemanticModelAdmission();
      const linked = await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => {
        const current = index[taskId];
        if (!semanticModelReferenceMatches(current) || current.traceId !== task.traceId || current.proposal?.id !== task.proposal.id
          || !semanticOperationsOwnerMatches(current.owner, identity)) return { commit: false, result: false };
        current.traceProvisioning = 'ready'; return { value: index, result: true };
      });
      if (!linked) throw new Error('HANDOFF_TRACE_LINK_CHANGED');
      return { traceId: task.traceId, evidenceState: 'ready' };
    }); } catch { return { error: '交接任务已保存，但证据尚未完成；重试仅恢复同一证据，不重新建任务。', code: 'SEMANTIC_HANDOFF_EVIDENCE_PENDING', status: 409, evidencePending: true, taskMayHaveCommitted: true }; }
  },
  create: options => {
    const bound = structuredClone(options); assertSemanticTenant(bound.identityScope);
    return admitted(modelId => createAgentEvidenceTrace({ ...bound, kind: 'semantic_operations_task', modelId }));
  },
  append: (traceId, event) => {
    const payload = structuredClone(event);
    return admitted(expectedModelId => appendAgentEvidenceEvent(traceId, payload, { expectedModelId, expectedTenantId: expectedTenant() }));
  },
  get: (traceId, roles, identityScope) => {
    const identity = structuredClone(identityScope); const roleIds = structuredClone(roles); assertSemanticTenant(identity);
    return admitted(expectedModelId => getAgentEvidenceTrace(traceId, roleIds, identity, { expectedModelId }));
  },
  status: (traceId, status, options = {}) => {
    const bound = structuredClone(options);
    return admitted(expectedModelId => setAgentEvidenceTraceStatus(traceId, status, { ...bound, expectedModelId, expectedTenantId: expectedTenant() }));
  }
};

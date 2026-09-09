import test from 'node:test';
import assert from 'node:assert/strict';
import {
  forgetAgentWorkflowLearningSignal,
  getAgentLearningProfile,
  recordApprovedWorkflowSignal,
  recordAgentWorkflowLearningFeedback,
  updateAgentLearningProfile
} from '../src/services/agent-learning-governance-service.js';
import { createAgentRun, getAgentLongTermMemory, rememberAgentLongTermGoal } from '../src/services/agent-runtime-store.js';

const identity = (subjectId) => ({ tenantId: 'learning-test-tenant', subjectId, sessionId: `${subjectId}-session`, deviceId: `${subjectId}-device` });

test('learning is off by default and enterprise knowledge remains retrieval-only', async () => {
  const scope = identity('default-off-user');
  const profile = await getAgentLearningProfile(scope);
  assert.equal(profile.workflowLearningEnabled, false);
  assert.equal(profile.personalizationEnabled, false);
  assert.equal(profile.enterpriseKnowledgeMode, 'retrieval_only');
  assert.equal(profile.modelTrainingMode, 'disabled_without_approved_dataset');
  assert.equal(profile.policy.rawPromptsStored, false);
  assert.equal((await recordApprovedWorkflowSignal({ identityScope: scope, roleId: 'quality_manager', runId: 'run-a', toolId: 'quality.read', outcomeType: 'analysis_completed' })).reason, 'consent_disabled');
  assert.equal((await getAgentLearningProfile(scope)).signalCount, 0);
});

test('explicit consent records only a minimized successful-workflow signal', async () => {
  const scope = identity('consenting-user');
  const enabled = await updateAgentLearningProfile({ identityScope: scope, settings: { workflowLearningEnabled: true }, expectedVersion: 1 });
  assert.equal(enabled.workflowLearningEnabled, true);
  const recorded = await recordApprovedWorkflowSignal({
    identityScope: scope,
    roleId: 'production_manager',
    runId: 'run-with-sensitive-prompt-link',
    toolId: 'desktop.artifact.create_text',
    outcomeType: 'local_artifact_created'
  });
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.signal.rawPromptStored, false);
  assert.equal(recorded.signal.enterprisePayloadStored, false);
  assert.equal(Object.hasOwn(recorded.signal, 'prompt'), false);
  assert.equal(Object.hasOwn(recorded.signal, 'payload'), false);
  assert.equal(recorded.signal.runFingerprint.length, 24);
  assert.doesNotMatch(JSON.stringify(recorded.signal), /run-with-sensitive-prompt-link/);

  await recordApprovedWorkflowSignal({ identityScope: scope, roleId: 'production_manager', runId: 'run-b', toolId: 'desktop.artifact.create_text', outcomeType: 'local_artifact_created' });
  const profile = await getAgentLearningProfile(scope);
  assert.equal(profile.signalCount, 1);
  assert.equal(profile.signals[0].confirmedSuccessCount, 2);
  assert.equal((await forgetAgentWorkflowLearningSignal(scope, profile.signals[0].id)).signal.id, profile.signals[0].id);
  assert.equal((await getAgentLearningProfile(scope)).signalCount, 0);
});

test('withdrawing workflow-learning consent immediately purges personal signals', async () => {
  const scope = identity('withdraw-user');
  const enabled = await updateAgentLearningProfile({ identityScope: scope, settings: { workflowLearningEnabled: true }, expectedVersion: 1 });
  await recordApprovedWorkflowSignal({ identityScope: scope, roleId: 'production_manager', runId: 'run-c', toolId: 'create_procurement_demand', outcomeType: 'business_draft_created' });
  const disabled = await updateAgentLearningProfile({ identityScope: scope, settings: { workflowLearningEnabled: false }, expectedVersion: enabled.version });
  assert.equal(disabled.workflowLearningEnabled, false);
  assert.equal(disabled.removedSignals, 1);
  assert.equal(disabled.signalCount, 0);
});

test('repeated confirmed success becomes a recommendation but never an authorization', async () => {
  const scope = identity('adaptive-preference-user');
  await updateAgentLearningProfile({ identityScope: scope, settings: { workflowLearningEnabled: true, personalizationEnabled: true }, expectedVersion: 1 });
  for (const runId of ['run-1', 'run-2', 'run-3']) {
    await recordApprovedWorkflowSignal({ identityScope: scope, roleId: 'production_manager', runId, toolId: 'desktop.artifact.create_xlsx', outcomeType: 'local_artifact_created' });
  }
  let profile = await getAgentLearningProfile(scope);
  assert.equal(profile.signals[0].status, 'trusted_preference');
  assert.equal(profile.recommendations[0].confidence, 1);
  assert.equal(profile.recommendations[0].executableWithoutConfirmation, false);
  const feedback = await recordAgentWorkflowLearningFeedback({ identityScope: scope, signalId: profile.signals[0].id, helpful: false });
  assert.equal(feedback.signal.negativeFeedbackCount, 1);
  profile = await getAgentLearningProfile(scope);
  assert.equal(profile.policy.adaptiveRecommendationsNeverBypassAuthorization, true);
  assert.equal((await recordAgentWorkflowLearningFeedback({ identityScope: scope, signalId: 'missing', helpful: false })).code, 'AGENT_LEARNING_SIGNAL_NOT_FOUND');
});

test('learning controls reject unknown settings and stale updates', async () => {
  const scope = identity('settings-guard-user');
  assert.equal((await updateAgentLearningProfile({ identityScope: scope, settings: { rawPromptTrainingAllowed: true }, expectedVersion: 1 })).code, 'AGENT_LEARNING_SETTINGS_INVALID');
  const updated = await updateAgentLearningProfile({ identityScope: scope, settings: { personalizationEnabled: true }, expectedVersion: 1 });
  assert.equal(updated.version, 2);
  assert.equal((await updateAgentLearningProfile({ identityScope: scope, settings: { personalizationEnabled: false }, expectedVersion: 1 })).code, 'AGENT_LEARNING_VERSION_CONFLICT');
});

test('a safe Agent run does not silently become long-term memory', () => {
  const scope = identity('explicit-memory-user');
  const roleId = 'quality_manager';
  createAgentRun({
    roleId,
    identityScope: scope,
    input: '请持续跟踪 RM-20260718 的质量状态。',
    domain: 'production',
    skill: { id: 'quality-analysis', name: '质量分析', version: '1.0.0' },
    agents: [], plan: [], evidence: [], authorization: { grantedDomains: ['production'] }, businessControl: null, multimodal: null
  });
  assert.equal(getAgentLongTermMemory(roleId, scope).length, 0);
  const pinned = rememberAgentLongTermGoal({ roleId, identityScope: scope, goal: '请持续跟踪 RM-20260718 的质量状态。', domain: 'production' });
  assert.equal(pinned.memory.source, 'user_pinned_task');
  assert.equal(getAgentLongTermMemory(roleId, scope).length, 1);
});

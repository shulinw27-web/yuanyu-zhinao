import { createHash, randomUUID } from 'node:crypto';
import { getRuntimeStoreInfo, mutateState, readState } from '../repositories/runtime-state-repository.js';

const PROFILE_NAMESPACE = 'agent_learning_profiles';
const SIGNAL_NAMESPACE = 'agent_workflow_learning_signals';
const SIGNAL_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_SIGNALS = 30;
const TRUSTED_PREFERENCE_THRESHOLD = 3;
const MUTABLE_SETTINGS = new Set(['personalizationEnabled', 'workflowLearningEnabled']);
let postgresRepository = null;

const normalizeIdentity = (identityScope = {}) => ({
  tenantId: String(identityScope.tenantId || 'demo-enterprise').slice(0, 120),
  subjectId: String(identityScope.subjectId || '').slice(0, 180)
});
const scopeKey = (identityScope) => JSON.stringify([identityScope.tenantId, identityScope.subjectId]);
const fingerprint = (value) => createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
const defaultProfile = () => ({
  version: 1,
  personalizationEnabled: false,
  workflowLearningEnabled: false,
  enterpriseKnowledgeMode: 'retrieval_only',
  modelTrainingMode: 'disabled_without_approved_dataset',
  rawPromptTrainingAllowed: false,
  updatedAt: null
});
const publicSignal = (signal) => structuredClone(signal);
const recommendationFor = (signal) => ({
  signalId: signal.id,
  roleId: signal.roleId,
  toolId: signal.toolId,
  outcomeType: signal.outcomeType,
  status: signal.status,
  confidence: Math.max(0, Math.min(1, Number(((signal.confirmedSuccessCount - (signal.negativeFeedbackCount || 0)) / TRUSTED_PREFERENCE_THRESHOLD).toFixed(2)))),
  reason: `${signal.confirmedSuccessCount} 次本人确认成功${signal.negativeFeedbackCount ? `，${signal.negativeFeedbackCount} 次负反馈` : ''}`,
  executableWithoutConfirmation: false
});

export function configureAgentLearningRepository(repository = null) {
  if (repository && typeof repository.mutateState !== 'function') throw new TypeError('Agent learning repository does not implement the asynchronous runtime-state port.');
  postgresRepository = repository;
}

export function getAgentLearningStoreInfo() {
  if (postgresRepository) return { driver: 'postgres', persistence: 'durable_distributed', schemaVersion: 3 };
  const runtimeStore = getRuntimeStoreInfo();
  return { driver: runtimeStore.driver, persistence: runtimeStore.persistence, schemaVersion: runtimeStore.schemaVersion };
}

export const probeAgentLearningStore = () => postgresRepository ? postgresRepository.probe() : Promise.resolve({ ready: true });

const purgeExpiredSignals = (identityScope, nowAt = Date.now()) => {
  const mutation = (signals) => {
    const active = signals.filter((item) => new Date(item.expiresAt).getTime() > nowAt);
    if (active.length === signals.length) return { commit: false, result: 0 };
    return { value: active, result: signals.length - active.length };
  };
  return postgresRepository
    ? postgresRepository.mutateState(SIGNAL_NAMESPACE, scopeKey(identityScope), [], mutation)
    : mutateState(SIGNAL_NAMESPACE, scopeKey(identityScope), [], mutation);
};

export async function getAgentLearningProfile(identityScope) {
  const identity = normalizeIdentity(identityScope);
  if (!identity.subjectId) return { error: '缺少可验证的用户身份。', code: 'AGENT_LEARNING_IDENTITY_REQUIRED' };
  await purgeExpiredSignals(identity);
  const profile = postgresRepository ? await postgresRepository.readState(PROFILE_NAMESPACE, scopeKey(identity), defaultProfile) : readState(PROFILE_NAMESPACE, scopeKey(identity), defaultProfile);
  const signals = postgresRepository ? await postgresRepository.readState(SIGNAL_NAMESPACE, scopeKey(identity), []) : readState(SIGNAL_NAMESPACE, scopeKey(identity), []);
  return {
    ...profile,
    signalCount: signals.length,
    signals: signals.slice(0, 10).map(publicSignal),
    recommendations: profile.personalizationEnabled
      ? signals.filter((item) => item.status === 'trusted_preference').slice(0, 10).map(recommendationFor)
      : [],
    policy: {
      consentRequired: true,
      rawPromptsStored: false,
      enterpriseDataUsedForTraining: false,
      withdrawalDeletesWorkflowSignals: true,
      adaptiveRecommendationsNeverBypassAuthorization: true
    }
  };
}

export async function updateAgentLearningProfile({ identityScope, settings, expectedVersion = null }) {
  const identity = normalizeIdentity(identityScope);
  if (!identity.subjectId) return { error: '缺少可验证的用户身份。', code: 'AGENT_LEARNING_IDENTITY_REQUIRED' };
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { error: '学习设置格式无效。', code: 'AGENT_LEARNING_SETTINGS_INVALID' };
  const keys = Object.keys(settings);
  if (!keys.length || keys.some((key) => !MUTABLE_SETTINGS.has(key)) || keys.some((key) => typeof settings[key] !== 'boolean')) {
    return { error: '只允许修改明确支持的布尔型学习开关。', code: 'AGENT_LEARNING_SETTINGS_INVALID' };
  }
  const key = scopeKey(identity);
  const profileMutation = (profile) => {
    if (expectedVersion !== null && Number(expectedVersion) !== profile.version) {
      return { commit: false, result: { error: '学习设置已被更新，请刷新后重试。', code: 'AGENT_LEARNING_VERSION_CONFLICT', currentVersion: profile.version } };
    }
    const next = {
      ...profile,
      ...settings,
      version: profile.version + 1,
      updatedAt: new Date().toISOString()
    };
    return { value: next, result: next };
  };
  if (postgresRepository) {
    const result = await postgresRepository.mutateStates([
      { name: 'profile', namespace: PROFILE_NAMESPACE, key, initialValue: defaultProfile },
      { name: 'signals', namespace: SIGNAL_NAMESPACE, key, initialValue: [] }
    ], ({ profile, signals }) => {
      const outcome = profileMutation(profile);
      if (outcome.commit === false) return outcome;
      const removedSignals = settings.workflowLearningEnabled === false ? signals.length : 0;
      return { values: { profile: outcome.value, signals: settings.workflowLearningEnabled === false ? [] : signals }, result: { profile: outcome.result, removedSignals } };
    });
    if (result.error) return result;
    return { ...await getAgentLearningProfile(identity), removedSignals: result.removedSignals };
  }
  const result = mutateState(PROFILE_NAMESPACE, key, defaultProfile, profileMutation);
  if (result.error) return result;
  let removedSignals = 0;
  if (settings.workflowLearningEnabled === false) {
    removedSignals = mutateState(SIGNAL_NAMESPACE, key, [], (signals) => ({ value: [], result: signals.length }));
  }
  return { ...await getAgentLearningProfile(identity), removedSignals };
}

export async function recordApprovedWorkflowSignal({ identityScope, roleId, runId, toolId, outcomeType, nowAt = Date.now() }) {
  const identity = normalizeIdentity(identityScope);
  if (!identity.subjectId) return { recorded: false, reason: 'identity_required' };
  const safeToolId = String(toolId || '').trim().slice(0, 120);
  const safeOutcomeType = String(outcomeType || '').trim().slice(0, 80);
  if (!safeToolId || !safeOutcomeType) return { recorded: false, reason: 'invalid_signal' };
  const createdAt = new Date(nowAt).toISOString();
  const expiresAt = new Date(nowAt + SIGNAL_TTL_MS).toISOString();
  const signalMutation = (signals) => {
    const active = signals.filter((item) => new Date(item.expiresAt).getTime() > nowAt);
    const duplicate = active.find((item) => item.toolId === safeToolId && item.outcomeType === safeOutcomeType && item.roleId === roleId);
    if (duplicate) {
      duplicate.confirmedSuccessCount += 1;
      duplicate.status = duplicate.confirmedSuccessCount >= TRUSTED_PREFERENCE_THRESHOLD && (duplicate.negativeFeedbackCount || 0) < duplicate.confirmedSuccessCount ? 'trusted_preference' : 'candidate';
      duplicate.lastConfirmedAt = createdAt;
      duplicate.expiresAt = expiresAt;
      return { value: active.slice(0, MAX_SIGNALS), result: duplicate };
    }
    const next = {
      id: `learning-${randomUUID()}`,
      roleId: String(roleId || '').slice(0, 120),
      toolId: safeToolId,
      outcomeType: safeOutcomeType,
      runFingerprint: fingerprint(runId),
      trust: 'user_confirmed_success',
      status: 'candidate',
      confirmedSuccessCount: 1,
      negativeFeedbackCount: 0,
      rawPromptStored: false,
      enterprisePayloadStored: false,
      retention: '30_days_or_consent_withdrawal',
      createdAt,
      lastConfirmedAt: createdAt,
      expiresAt
    };
    active.unshift(next);
    return { value: active.slice(0, MAX_SIGNALS), result: next };
  };
  if (postgresRepository) {
    return postgresRepository.mutateStates([
      { name: 'profile', namespace: PROFILE_NAMESPACE, key: scopeKey(identity), initialValue: defaultProfile },
      { name: 'signals', namespace: SIGNAL_NAMESPACE, key: scopeKey(identity), initialValue: [] }
    ], ({ profile, signals }) => {
      if (!profile.workflowLearningEnabled) return { commit: false, result: { recorded: false, reason: 'consent_disabled' } };
      const outcome = signalMutation(signals);
      return { values: { profile, signals: outcome.value }, result: { recorded: true, signal: publicSignal(outcome.result) } };
    });
  }
  const profile = readState(PROFILE_NAMESPACE, scopeKey(identity), defaultProfile);
  if (!profile.workflowLearningEnabled) return { recorded: false, reason: 'consent_disabled' };
  const signal = mutateState(SIGNAL_NAMESPACE, scopeKey(identity), [], signalMutation);
  return { recorded: true, signal: publicSignal(signal) };
}

export async function forgetAgentWorkflowLearningSignal(identityScope, signalId) {
  const identity = normalizeIdentity(identityScope);
  if (!identity.subjectId) return { error: '缺少可验证的用户身份。', code: 'AGENT_LEARNING_IDENTITY_REQUIRED' };
  const targetId = String(signalId || '').trim();
  const mutation = (signals) => {
    const found = signals.find((item) => item.id === targetId);
    if (!found) return { commit: false, result: null };
    return { value: signals.filter((item) => item.id !== targetId), result: { signal: publicSignal(found) } };
  };
  const result = postgresRepository ? await postgresRepository.mutateState(SIGNAL_NAMESPACE, scopeKey(identity), [], mutation) : mutateState(SIGNAL_NAMESPACE, scopeKey(identity), [], mutation);
  return result || { error: '未找到可撤销的学习信号。', code: 'AGENT_LEARNING_SIGNAL_NOT_FOUND' };
}

export async function recordAgentWorkflowLearningFeedback({ identityScope, signalId, helpful }) {
  const identity = normalizeIdentity(identityScope);
  if (!identity.subjectId) return { error: '缺少可验证的用户身份。', code: 'AGENT_LEARNING_IDENTITY_REQUIRED' };
  if (typeof helpful !== 'boolean') return { error: '学习反馈必须明确为有帮助或无帮助。', code: 'AGENT_LEARNING_FEEDBACK_INVALID' };
  const targetId = String(signalId || '').trim();
  const mutation = (signals) => {
    const signal = signals.find((item) => item.id === targetId);
    if (!signal) return { commit: false, result: null };
    signal.negativeFeedbackCount = (signal.negativeFeedbackCount || 0) + (helpful ? 0 : 1);
    if (helpful) signal.confirmedSuccessCount += 1;
    signal.status = signal.confirmedSuccessCount >= TRUSTED_PREFERENCE_THRESHOLD && signal.negativeFeedbackCount < signal.confirmedSuccessCount
      ? 'trusted_preference'
      : signal.negativeFeedbackCount >= signal.confirmedSuccessCount ? 'suppressed' : 'candidate';
    signal.lastFeedbackAt = new Date().toISOString();
    return { value: signals, result: { signal: publicSignal(signal), recommendation: signal.status === 'trusted_preference' ? recommendationFor(signal) : null } };
  };
  const result = postgresRepository ? await postgresRepository.mutateState(SIGNAL_NAMESPACE, scopeKey(identity), [], mutation) : mutateState(SIGNAL_NAMESPACE, scopeKey(identity), [], mutation);
  return result || { error: '未找到可反馈的学习信号。', code: 'AGENT_LEARNING_SIGNAL_NOT_FOUND' };
}

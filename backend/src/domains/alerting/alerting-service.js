import { randomUUID } from 'node:crypto';
import { getEffectiveAccess } from '../../services/access-control-service.js';
import { getIAMOrganizations, getIAMUsers } from '../../services/iam-store.js';
import { classifyAlert } from './alert-classification-service.js';
import { appendAlertingAuditToState, getAlertingState, mutateAlertingState, verifyAlertingAudit } from './alerting-store.js';
import { createVoiceProvider } from './providers/voice-provider-registry.js';

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}-${randomUUID()}`;
const supportedChannels = new Set(['in_app', 'push', 'sms', 'voice', 'email', 'webhook']);
const voiceModes = new Set(['immediate', 'on_timeout', 'disabled']);
const receiverTypes = new Set(['risk_owner', 'on_call', 'organization_manager', 'executive']);

const organizationName = (organizationId) => getIAMOrganizations().find((item) => item.id === organizationId)?.name || '相关组织';
const userName = (userId) => getIAMUsers().find((item) => item.id === userId)?.name || userId;
const sanitizeContact = ({ phoneRef: _phoneRef, ...contact }) => clone(contact);
const publicCall = ({ phoneRef: _phoneRef, ...call }) => clone(call);

const resolveReceiver = (state, alert, receiverType = 'risk_owner') => {
  const schedule = state.onCallSchedules.find((item) => item.enabled && item.organizationId === alert.organizationId);
  let userId = alert.ownerUserId;
  if (receiverType === 'on_call') userId = schedule?.primaryUserId || userId;
  if (receiverType === 'organization_manager') userId = schedule?.backupUserIds?.[0] || schedule?.primaryUserId || userId;
  if (receiverType === 'executive') userId = 'usr-001';
  if (!userId) userId = schedule?.primaryUserId || 'usr-001';
  return { userId, contact: state.contactPoints.find((item) => item.userId === userId) || null };
};

const renderVoiceTemplate = (state, severity, alert) => {
  const template = state.voiceTemplates.find((item) => item.severity === severity && item.status === 'published');
  if (!template) return { template: null, text: '' };
  const values = { organizationName: organizationName(alert.organizationId), riskId: alert.riskId };
  const text = template.content.replace(/\{(organizationName|riskId)\}/g, (_, key) => values[key]);
  return { template, text };
};

const enqueueDelivery = (state, alert, classification, policy, step, channel, receiver) => {
  if (channel !== 'webhook' && (!receiver.contact || !receiver.contact.enabledChannels.includes(channel))) return null;
  const idempotencyKey = `${alert.riskId}:${policy.id}:${step.order}:${receiver.userId}:${channel}`;
  if (state.deliveries.some((item) => item.idempotencyKey === idempotencyKey)) return null;
  const createdAt = now();
  const delivery = {
    id: newId('NT'), riskId: alert.riskId, organizationId: alert.organizationId, severity: classification.severity,
    channel, receiverUserId: receiver.userId, target: channel === 'voice' || channel === 'sms' ? receiver.contact?.maskedPhone : channel === 'email' ? receiver.contact?.email : channel === 'webhook' ? '受控业务 Webhook' : userName(receiver.userId),
    policyId: policy.id, policyVersion: state.configurationVersion, escalationStep: step.order, status: 'queued', attempt: 1,
    idempotencyKey, createdAt, updatedAt: createdAt
  };
  state.deliveries.unshift(delivery);
  const task = { id: newId('OUTBOX'), type: channel === 'voice' ? 'voice_call' : 'channel_delivery', channel, deliveryId: delivery.id, status: 'pending', attempts: 0, availableAt: createdAt, createdAt, updatedAt: createdAt };
  state.outbox.push(task);
  appendAlertingAuditToState(state, {
    type: 'notification_enqueued', status: 'queued', riskId: alert.riskId, organizationId: alert.organizationId, notificationId: delivery.id,
    summary: `${classification.severity} 告警已生成 ${channel} 通知任务。`, details: { policyId: policy.id, escalationStep: step.order, receiverUserId: receiver.userId, idempotencyKey }
  });
  return delivery;
};

export async function dispatchAlert(event) {
  const state = await getAlertingState();
  const classification = classifyAlert(event, state.classificationRules, state.severityLevels);
  if (!classification.level) return { error: '没有可用的告警等级配置。', code: 'ALERT_SEVERITY_UNAVAILABLE' };
  const alert = {
    riskId: event.riskId || newId('SIM-RISK'), title: String(event.title || '模拟业务告警').slice(0, 160),
    sourceSystem: String(event.sourceSystem || 'UNKNOWN').toUpperCase(), eventType: String(event.eventType || 'UnknownEvent'),
    organizationId: event.organizationId || 'org-quality-dept', ownerUserId: event.ownerUserId || null,
    affectedOrders: Math.max(0, Number(event.affectedOrders || 0)), severity: classification.severity, status: 'open', createdAt: now()
  };
  const result = await mutateAlertingState((workspace) => {
    if (workspace.simulatedAlerts.some((item) => item.riskId === alert.riskId)) return { commit: false, result: { alert: clone(workspace.simulatedAlerts.find((item) => item.riskId === alert.riskId)), classification, reused: true } };
    workspace.simulatedAlerts.unshift(alert);
    workspace.simulatedAlerts = workspace.simulatedAlerts.slice(0, 100);
    appendAlertingAuditToState(workspace, {
      type: 'severity_classified', status: 'completed', riskId: alert.riskId, organizationId: alert.organizationId,
      summary: `告警已由规则 ${classification.ruleName} 划分为 ${classification.severity}。`, details: { classification }
    });
    const policy = workspace.escalationPolicies.find((item) => item.enabled && item.severity === classification.severity);
    if (!policy) return { value: workspace, result: { alert, classification, warning: '未配置升级策略。' } };
    const firstStep = policy.steps.find((item) => item.order === 1) || policy.steps[0];
    const receiver = resolveReceiver(workspace, alert, firstStep.receiverType);
    const configuredChannels = classification.level.channels.filter((channel) => supportedChannels.has(channel));
    const immediateChannels = classification.level.voiceMode === 'immediate'
      ? configuredChannels
      : configuredChannels.filter((channel) => channel !== 'voice');
    const deliveries = immediateChannels.map((channel) => enqueueDelivery(workspace, alert, classification, policy, firstStep, channel, receiver)).filter(Boolean);
    return { value: workspace, result: { alert, classification, policy: clone(policy), deliveries: clone(deliveries), reused: false } };
  }, (mutationResult) => ({
    type: 'alert.classified',
    aggregateType: 'Alert',
    aggregateId: mutationResult.alert.riskId,
    tenantId: event.tenantId || 'demo-enterprise',
    organizationId: mutationResult.alert.organizationId,
    correlationId: event.correlationId || mutationResult.alert.riskId,
    actor: event.actor || { type: 'service', id: 'alerting-orchestrator' },
    payload: {
      severity: mutationResult.classification.severity,
      sourceSystem: mutationResult.alert.sourceSystem,
      eventType: mutationResult.alert.eventType,
      deliveryCount: mutationResult.deliveries?.length || 0,
      policyId: mutationResult.policy?.id || null
    }
  }));
  await processNotificationOutbox();
  return result;
}

export async function processNotificationOutbox(limit = 50) {
  const processed = [];
  for (let index = 0; index < limit; index += 1) {
    const claimed = await mutateAlertingState((state) => {
      const task = state.outbox.find((item) => item.status === 'pending' && item.availableAt <= now());
      if (!task) return { commit: false, result: null };
      task.status = 'processing'; task.attempts += 1; task.updatedAt = now();
      return { value: state, result: clone(task) };
    });
    if (!claimed) break;
    const outcome = await mutateAlertingState((state) => {
      const task = state.outbox.find((item) => item.id === claimed.id);
      const delivery = state.deliveries.find((item) => item.id === claimed.deliveryId);
      if (!task || !delivery) return { commit: false, result: null };
      if (task.channel !== 'voice') {
        delivery.status = 'delivered'; delivery.updatedAt = now(); task.status = 'completed'; task.updatedAt = delivery.updatedAt;
        appendAlertingAuditToState(state, { type: 'notification_delivered', status: 'delivered', riskId: delivery.riskId, organizationId: delivery.organizationId, notificationId: delivery.id, summary: `${delivery.channel} 通知已由 Mock 通道送达。`, details: { channel: delivery.channel, receiverUserId: delivery.receiverUserId } });
        return { value: state, result: { taskId: task.id, deliveryId: delivery.id, status: delivery.status } };
      }
      const providerConfiguration = state.voiceProviders.find((item) => item.enabled && item.status === 'healthy');
      const provider = createVoiceProvider(providerConfiguration);
      if (!provider) {
        delivery.status = 'failed'; delivery.updatedAt = now(); task.status = 'failed'; task.updatedAt = delivery.updatedAt; task.lastError = 'VOICE_PROVIDER_UNAVAILABLE';
        appendAlertingAuditToState(state, { type: 'voice_call_failed', status: 'failed', riskId: delivery.riskId, organizationId: delivery.organizationId, notificationId: delivery.id, summary: '没有可用的虚拟电话供应商。', details: { code: task.lastError } });
        return { value: state, result: { taskId: task.id, deliveryId: delivery.id, status: 'failed' } };
      }
      const alert = state.simulatedAlerts.find((item) => item.riskId === delivery.riskId) || { riskId: delivery.riskId, organizationId: delivery.organizationId };
      const rendered = renderVoiceTemplate(state, delivery.severity, alert);
      const contact = state.contactPoints.find((item) => item.userId === delivery.receiverUserId);
      const placed = provider.placeCall({ idempotencyKey: delivery.idempotencyKey, phoneRef: contact?.phoneRef, maskedNumber: contact?.maskedPhone, text: rendered.text });
      const call = {
        id: newId('CALL'), notificationId: delivery.id, riskId: delivery.riskId, organizationId: delivery.organizationId, severity: delivery.severity,
        receiverUserId: delivery.receiverUserId, maskedNumber: contact?.maskedPhone || '未配置', phoneRef: contact?.phoneRef || null,
        providerId: providerConfiguration.id, providerCallId: placed.providerCallId, status: placed.status, receiptStatus: placed.playbackStatus,
        attempt: delivery.attempt, templateId: rendered.template?.id || null, policyVersion: delivery.policyVersion, idempotencyKey: delivery.idempotencyKey,
        startedAt: placed.startedAt, answeredAt: placed.answeredAt || null, completedAt: placed.status === 'answered' ? now() : null, acknowledgedAt: null
      };
      state.voiceCalls.unshift(call); state.voiceCalls = state.voiceCalls.slice(0, 300);
      delivery.status = placed.status; delivery.updatedAt = now(); task.status = 'completed'; task.updatedAt = delivery.updatedAt;
      appendAlertingAuditToState(state, { type: 'voice_call_started', status: placed.status, riskId: delivery.riskId, organizationId: delivery.organizationId, notificationId: delivery.id, callId: call.id, summary: `虚拟电话已拨打 ${contact?.maskedPhone || '责任人'} 并完成受控语音播放。`, details: { providerId: providerConfiguration.id, receiverUserId: delivery.receiverUserId, templateId: call.templateId, playbackStatus: call.receiptStatus } });
      return { value: state, result: { taskId: task.id, deliveryId: delivery.id, callId: call.id, status: call.status } };
    });
    if (outcome) processed.push(outcome);
  }
  return processed;
}

export async function getAlertingWorkspaceForAccess(roleId, identityContext) {
  const state = await getAlertingState();
  const access = getEffectiveAccess(roleId, identityContext);
  const allowed = new Set(access.organizationIds);
  const visible = (item) => access.unrestricted || allowed.has(item.organizationId);
  const deliveries = state.deliveries.filter(visible);
  const calls = state.voiceCalls.filter(visible).map(publicCall);
  const audits = state.auditEvents.filter((item) => !item.organizationId || visible(item));
  return {
    configurationVersion: state.configurationVersion,
    severityLevels: clone(state.severityLevels), classificationRules: clone(state.classificationRules), escalationPolicies: clone(state.escalationPolicies),
    onCallSchedules: state.onCallSchedules.filter(visible).map(clone), contactPoints: state.contactPoints.filter((item) => access.unrestricted || calls.some((call) => call.receiverUserId === item.userId)).map(sanitizeContact),
    voiceProviders: state.voiceProviders.map(({ credentialRef, ...provider }) => ({ ...clone(provider), credentialConfigured: Boolean(credentialRef) })),
    voiceTemplates: clone(state.voiceTemplates), deliveries: clone(deliveries), voiceCalls: calls, simulatedAlerts: state.simulatedAlerts.filter(visible).map(clone),
    audits: clone(audits.slice(-200).reverse()),
    metrics: {
      activeAlerts: state.simulatedAlerts.filter((item) => item.status === 'open' && visible(item)).length,
      voiceCalls: calls.length,
      acknowledgedCalls: calls.filter((item) => item.acknowledgedAt).length,
      queuedDeliveries: deliveries.filter((item) => item.status === 'queued').length,
      deliverySuccessRate: deliveries.length ? Math.round(deliveries.filter((item) => ['delivered', 'answered', 'acknowledged'].includes(item.status)).length / deliveries.length * 100) : 100
    },
    auditIntegrity: verifyAlertingAudit(state.auditEvents, state.auditHeadHash),
    capabilities: { providerAdapter: true, transactionalOutbox: true, dtmfReceiptOnly: true, highRiskApprovalByPhone: false }
  };
}

const validateConfiguration = (payload) => {
  const configurationFields = ['severityLevels', 'voiceProviders', 'onCallSchedules', 'escalationPolicies'];
  if (!configurationFields.some((field) => payload[field] !== undefined)) return { error: '没有提交可发布的告警配置。', code: 'EMPTY_ALERTING_CONFIGURATION' };
  if (payload.severityLevels !== undefined) {
    if (!Array.isArray(payload.severityLevels) || payload.severityLevels.length !== 3) return { error: '必须保留 P0、P1、P2 三个告警等级。', code: 'INVALID_SEVERITY_LEVELS' };
    const ids = new Set(payload.severityLevels.map((item) => item.id));
    if (!['P0', 'P1', 'P2'].every((id) => ids.has(id))) return { error: '告警等级必须包含 P0、P1、P2。', code: 'INVALID_SEVERITY_LEVELS' };
    for (const level of payload.severityLevels) {
      if (!Number.isInteger(level.acknowledgementMinutes) || level.acknowledgementMinutes < 1 || level.acknowledgementMinutes > 10080) return { error: `${level.id} 确认时限必须是 1 到 10080 分钟的整数。`, code: 'INVALID_ACK_WINDOW' };
      if (!voiceModes.has(level.voiceMode)) return { error: `${level.id} 电话策略无效。`, code: 'INVALID_VOICE_MODE' };
      if (!Array.isArray(level.channels) || level.channels.some((item) => !supportedChannels.has(item))) return { error: `${level.id} 包含不支持的通知渠道。`, code: 'INVALID_CHANNEL' };
    }
    if (payload.severityLevels.find((item) => item.id === 'P2')?.voiceMode === 'immediate') return { error: 'P2 低风险告警不能配置为立即外呼。', code: 'P2_IMMEDIATE_VOICE_DENIED' };
  }
  if (payload.escalationPolicies !== undefined) {
    if (!Array.isArray(payload.escalationPolicies) || payload.escalationPolicies.length !== 3) return { error: '必须为 P0、P1、P2 分别配置升级策略。', code: 'INVALID_ESCALATION_POLICIES' };
    const severities = new Set(payload.escalationPolicies.map((item) => item.severity));
    if (!['P0', 'P1', 'P2'].every((severity) => severities.has(severity))) return { error: '升级策略必须覆盖 P0、P1、P2。', code: 'INVALID_ESCALATION_POLICIES' };
    for (const policy of payload.escalationPolicies) {
      if (!Array.isArray(policy.steps) || !policy.steps.length) return { error: `${policy.severity} 至少需要一个升级步骤。`, code: 'INVALID_ESCALATION_STEPS' };
      let previousDelay = -1;
      const orders = new Set();
      for (const step of policy.steps) {
        if (!Number.isInteger(step.order) || step.order < 1 || orders.has(step.order)) return { error: `${policy.severity} 的升级步骤序号无效。`, code: 'INVALID_ESCALATION_STEPS' };
        if (!Number.isInteger(step.delayMinutes) || step.delayMinutes < previousDelay || step.delayMinutes > 10080) return { error: `${policy.severity} 的升级延迟必须递增且不超过 10080 分钟。`, code: 'INVALID_ESCALATION_DELAY' };
        if (!receiverTypes.has(step.receiverType)) return { error: `${policy.severity} 包含不支持的责任人类型。`, code: 'INVALID_ESCALATION_RECEIVER' };
        if (!Array.isArray(step.channels) || !step.channels.length || step.channels.some((channel) => !supportedChannels.has(channel))) return { error: `${policy.severity} 包含无效的升级渠道。`, code: 'INVALID_ESCALATION_CHANNEL' };
        if (policy.severity === 'P2' && step.channels.includes('voice')) return { error: 'P2 低风险升级链不能包含电话渠道。', code: 'P2_VOICE_ESCALATION_DENIED' };
        orders.add(step.order);
        previousDelay = step.delayMinutes;
      }
    }
  }
  if (payload.onCallSchedules !== undefined) {
    if (!Array.isArray(payload.onCallSchedules) || !payload.onCallSchedules.length) return { error: '值班表不能为空。', code: 'INVALID_ONCALL_SCHEDULES' };
    const knownUsers = new Set(getIAMUsers().map((item) => item.id));
    const knownOrganizations = new Set(getIAMOrganizations().map((item) => item.id));
    for (const schedule of payload.onCallSchedules) {
      if (!knownOrganizations.has(schedule.organizationId) || !knownUsers.has(schedule.primaryUserId)) return { error: `${schedule.name || schedule.id} 的组织或主值班人无效。`, code: 'INVALID_ONCALL_ASSIGNMENT' };
      if (!Array.isArray(schedule.backupUserIds) || schedule.backupUserIds.some((userId) => userId && !knownUsers.has(userId))) return { error: `${schedule.name || schedule.id} 的备班人员无效。`, code: 'INVALID_ONCALL_ASSIGNMENT' };
    }
  }
  return null;
};

export async function saveAlertingConfiguration(payload, actor) {
  const validation = validateConfiguration(payload);
  if (validation) return validation;
  return mutateAlertingState((state) => {
    if (!Number.isInteger(payload.expectedVersion) || payload.expectedVersion !== state.configurationVersion) return { commit: false, result: { error: '告警配置已被更新，请刷新后重试。', code: 'VERSION_CONFLICT', currentVersion: state.configurationVersion } };
    const before = { severityLevels: clone(state.severityLevels), escalationPolicies: clone(state.escalationPolicies), onCallSchedules: clone(state.onCallSchedules), voiceProviders: clone(state.voiceProviders) };
    if (Array.isArray(payload.severityLevels)) state.severityLevels = payload.severityLevels.map((level) => ({ ...clone(state.severityLevels.find((item) => item.id === level.id)), ...clone(level), id: level.id }));
    if (Array.isArray(payload.voiceProviders)) state.voiceProviders = state.voiceProviders.map((provider) => {
      const incoming = payload.voiceProviders.find((item) => item.id === provider.id);
      return incoming ? { ...provider, enabled: Boolean(incoming.enabled), language: String(incoming.language || provider.language), voice: String(incoming.voice || provider.voice) } : provider;
    });
    if (Array.isArray(payload.onCallSchedules)) state.onCallSchedules = state.onCallSchedules.map((schedule) => {
      const incoming = payload.onCallSchedules.find((item) => item.id === schedule.id);
      return incoming ? { ...schedule, enabled: Boolean(incoming.enabled), primaryUserId: incoming.primaryUserId, backupUserIds: [...new Set(incoming.backupUserIds)].filter((userId) => userId && userId !== incoming.primaryUserId) } : schedule;
    });
    if (Array.isArray(payload.escalationPolicies)) state.escalationPolicies = state.escalationPolicies.map((policy) => {
      const incoming = payload.escalationPolicies.find((item) => item.id === policy.id);
      return incoming ? { ...policy, enabled: Boolean(incoming.enabled), steps: clone(incoming.steps).sort((left, right) => left.order - right.order) } : policy;
    });
    state.configurationVersion += 1;
    appendAlertingAuditToState(state, { type: 'configuration_published', status: 'completed', actor, summary: `告警、值班升级与虚拟电话配置已发布为 v${state.configurationVersion}。`, details: { before, after: { severityLevels: state.severityLevels, escalationPolicies: state.escalationPolicies, onCallSchedules: state.onCallSchedules, voiceProviders: state.voiceProviders.map(({ credentialRef: _credentialRef, ...provider }) => provider) }, version: state.configurationVersion } });
    return { value: state, result: { configurationVersion: state.configurationVersion, message: '告警等级、升级时限与虚拟电话策略已发布。' } };
  }, (mutationResult) => ({
    type: 'alerting.configuration.published',
    aggregateType: 'AlertingConfiguration',
    aggregateId: 'alerting',
    tenantId: actor?.tenantId || 'demo-enterprise',
    actor: actor || { type: 'system', id: 'unknown' },
    payload: { configurationVersion: mutationResult.configurationVersion }
  }));
}

export async function simulateAlert(payload, actor) {
  const result = await dispatchAlert(payload);
  if (!result.error) await mutateAlertingState((state) => {
    appendAlertingAuditToState(state, { type: 'route_simulation_completed', status: 'completed', actor, riskId: result.alert.riskId, organizationId: result.alert.organizationId, summary: `路由模拟完成：${result.classification.severity}，生成 ${result.deliveries?.length || 0} 个通知任务。`, details: { classification: result.classification, policyId: result.policy?.id } });
    return { value: state, result: true };
  });
  return result;
}

export async function testVoiceCall(payload, actor) {
  const state = await getAlertingState();
  const userId = payload.userId || 'usr-003';
  const contact = state.contactPoints.find((item) => item.userId === userId);
  if (!contact) return { error: '测试人员没有配置电话联系点。', code: 'CONTACT_POINT_NOT_FOUND' };
  const organizationId = payload.organizationId || state.onCallSchedules.find((item) => item.primaryUserId === userId)?.organizationId || 'org-quality-dept';
  const riskId = newId('VOICE-TEST');
  await mutateAlertingState((workspace) => {
    const delivery = { id: newId('NT'), riskId, organizationId, severity: 'P0', channel: 'voice', receiverUserId: userId, target: contact.maskedPhone, policyId: 'voice-test', policyVersion: workspace.configurationVersion, escalationStep: 0, status: 'queued', attempt: 1, idempotencyKey: `${riskId}:voice-test:${userId}`, createdAt: now(), updatedAt: now() };
    workspace.deliveries.unshift(delivery);
    workspace.outbox.push({ id: newId('OUTBOX'), type: 'voice_call', channel: 'voice', deliveryId: delivery.id, status: 'pending', attempts: 0, availableAt: now(), createdAt: now(), updatedAt: now() });
    appendAlertingAuditToState(workspace, { type: 'voice_test_requested', status: 'queued', actor, riskId, organizationId, notificationId: delivery.id, summary: `已向 ${contact.maskedPhone} 发起 Mock 测试外呼。`, details: { receiverUserId: userId } });
    return { value: workspace, result: delivery.id };
  });
  const processed = await processNotificationOutbox();
  const callId = processed.find((item) => item.callId)?.callId;
  return { message: 'Mock 测试电话已完成语音播放。', call: publicCall((await getAlertingState()).voiceCalls.find((item) => item.id === callId)) };
}

export async function recordVoiceCallEvent(callId, action, actor) {
  const allowedActions = new Set(['acknowledge', 'replay', 'escalate', 'failed']);
  if (!allowedActions.has(action)) return { error: '不支持的电话事件。', code: 'INVALID_VOICE_EVENT' };
  const result = await mutateAlertingState((state) => {
    const call = state.voiceCalls.find((item) => item.id === callId);
    if (!call) return { commit: false, result: { error: '未找到电话记录。', code: 'VOICE_CALL_NOT_FOUND' } };
    const delivery = state.deliveries.find((item) => item.id === call.notificationId);
    if (action === 'acknowledge') { call.status = 'acknowledged'; call.receiptStatus = 'received'; call.acknowledgedAt = now(); if (delivery) delivery.status = 'acknowledged'; }
    if (action === 'replay') call.receiptStatus = 'replayed';
    let escalationDeliveries = [];
    if (action === 'escalate') {
      if (call.receiptStatus === 'escalation_requested') return { commit: false, result: { call: publicCall(call), message: '升级请求已受理，无需重复提交。' } };
      call.receiptStatus = 'escalation_requested';
      const policy = state.escalationPolicies.find((item) => item.id === delivery?.policyId && item.enabled);
      const nextStep = policy?.steps.find((item) => item.order > Number(delivery?.escalationStep || 0));
      if (nextStep) {
        const alert = state.simulatedAlerts.find((item) => item.riskId === call.riskId) || { riskId: call.riskId, organizationId: call.organizationId, ownerUserId: delivery?.receiverUserId };
        const receiver = resolveReceiver(state, alert, nextStep.receiverType);
        escalationDeliveries = nextStep.channels.map((channel) => enqueueDelivery(state, alert, { severity: call.severity }, policy, nextStep, channel, receiver)).filter(Boolean);
      }
    }
    if (action === 'failed') { call.status = 'failed'; call.receiptStatus = 'failed'; if (delivery) delivery.status = 'failed'; }
    call.completedAt = now(); if (delivery) delivery.updatedAt = call.completedAt;
    appendAlertingAuditToState(state, { type: `voice_${action}`, status: call.status, actor, riskId: call.riskId, organizationId: call.organizationId, notificationId: call.notificationId, callId: call.id, summary: action === 'acknowledge' ? '责任人通过电话按键确认已收到告警；该回执不代表业务审批。' : action === 'escalate' ? `电话升级请求已受理，生成 ${escalationDeliveries.length} 个下一责任人通知任务。` : `Mock 电话事件已记录：${action}。`, details: { action, receiptStatus: call.receiptStatus, escalationDeliveryIds: escalationDeliveries.map((item) => item.id), highRiskApprovalGranted: false } });
    return { value: state, result: { call: publicCall(call), escalationDeliveries: clone(escalationDeliveries), message: action === 'acknowledge' ? '已确认收到电话告警，业务处置仍需登录系统完成。' : action === 'escalate' ? escalationDeliveries.length ? '升级通知已发送给下一责任人。' : '当前已经是升级链最后一级。' : '电话事件已记录。' } };
  }, (mutationResult) => ({
    type: action === 'escalate' ? 'alert.escalation.requested' : 'alert.voice.receipt_recorded',
    aggregateType: 'VoiceCall',
    aggregateId: mutationResult.call.id,
    tenantId: actor?.tenantId || 'demo-enterprise',
    organizationId: mutationResult.call.organizationId,
    correlationId: mutationResult.call.riskId,
    actor: actor || { type: 'system', id: 'unknown' },
    payload: {
      action,
      riskId: mutationResult.call.riskId,
      receiptStatus: mutationResult.call.receiptStatus,
      escalationDeliveryIds: mutationResult.escalationDeliveries?.map((item) => item.id) || []
    }
  }));
  if (action === 'escalate' && !result.error) await processNotificationOutbox();
  return result;
}

export async function acknowledgeAlertNotifications(riskId, actor) {
  return mutateAlertingState((state) => {
    let changed = 0;
    state.deliveries.filter((item) => item.riskId === riskId && ['queued', 'answered', 'delivered'].includes(item.status)).forEach((delivery) => { delivery.status = 'acknowledged'; delivery.updatedAt = now(); changed += 1; });
    state.voiceCalls.filter((item) => item.riskId === riskId && ['queued', 'ringing'].includes(item.status)).forEach((call) => { call.status = 'cancelled'; call.completedAt = now(); });
    state.outbox.filter((item) => state.deliveries.some((delivery) => delivery.id === item.deliveryId && delivery.riskId === riskId) && item.status === 'pending').forEach((task) => { task.status = 'cancelled'; task.updatedAt = now(); });
    appendAlertingAuditToState(state, { type: 'risk_acknowledged', status: 'completed', actor, riskId, summary: `风险已在工作台确认，${changed} 条通知更新为已确认并停止后续待执行升级。`, details: { changedDeliveries: changed } });
    return { value: state, result: { changed } };
  });
}

export async function getAlertingNotifications(roleId, identityContext) {
  const workspace = await getAlertingWorkspaceForAccess(roleId, identityContext);
  return workspace.deliveries.map((item) => ({
    id: item.id, channel: item.channel === 'voice' ? '虚拟电话' : item.channel === 'in_app' ? '站内信' : item.channel === 'push' ? 'Push' : item.channel === 'sms' ? '短信' : item.channel === 'email' ? '邮件' : 'Webhook',
    target: item.target, status: item.status === 'answered' ? '已接听' : item.status === 'acknowledged' ? '已确认收到' : item.status === 'delivered' ? '已送达' : item.status === 'queued' ? '排队中' : item.status === 'failed' ? '失败' : item.status,
    riskId: item.riskId, time: new Date(item.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), policy: `${item.severity}-${item.policyId}`, severity: item.severity,
    title: `${item.severity} 告警通知`, description: `${item.channel === 'voice' ? '虚拟电话' : item.channel} 通知状态：${item.status}`, riskStatus: item.status, call: workspace.voiceCalls.find((call) => call.notificationId === item.id) || null
  }));
}

export const getSeverityDefinition = async (severity) => clone((await getAlertingState()).severityLevels.find((item) => item.id === severity) || null);

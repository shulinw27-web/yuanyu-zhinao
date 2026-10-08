import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mutateState, readState } from '../../repositories/runtime-state-repository.js';
import { runWithSemanticTenant, semanticTenantStateKey } from '../../services/semantic-tenant-context.js';

const NAMESPACE = 'workflow_webhook_inbox';
const MAX_EVENTS = 500;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 60_000;
const EVENT_TYPES = new Set(['definition.changed', 'instance.changed', 'instance.completed', 'reconciliation.requested']);
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,48}$/u;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/u;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]{2,100}$/u;
const initialInbox = () => ({ schemaVersion: 1, events: [] });
const stateKey = () => semanticTenantStateKey('inbox');
const clone = value => structuredClone(value);
const failure = (code, message, status = 400) => ({ error: message, code, status });
const header = (headers, name) => String(headers?.[name] || headers?.[name.toLowerCase()] || '').trim();
const safeCode = value => /^[A-Z0-9_]{3,100}$/u.test(String(value || '')) ? String(value) : 'WORKFLOW_SYNC_FAILED';

const parseConfiguration = env => {
  const raw = String(env.WORKFLOW_WEBHOOKS_CONFIG_JSON || '').trim();
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw Object.assign(new Error('流程 Webhook 配置不是有效 JSON。'), { code: 'WORKFLOW_WEBHOOK_CONFIG_INVALID', status: 503 }); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 20) throw Object.assign(new Error('流程 Webhook 配置必须包含 1 到 20 个提供方。'), { code: 'WORKFLOW_WEBHOOK_CONFIG_INVALID', status: 503 });
  const ids = new Set();
  return parsed.map(item => {
    const allowed = new Set(['id', 'tenantId', 'signingSecretEnv']);
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !allowed.has(key))) throw Object.assign(new Error('流程 Webhook 配置项无效。'), { code: 'WORKFLOW_WEBHOOK_CONFIG_INVALID', status: 503 });
    const id = String(item.id || '').trim();
    const tenantId = String(item.tenantId || '').trim();
    const signingSecretEnv = String(item.signingSecretEnv || '').trim();
    if (!PROVIDER_PATTERN.test(id) || ids.has(id) || !tenantId || tenantId.length > 120 || /[\u0000-\u001f]/u.test(tenantId) || !ENV_PATTERN.test(signingSecretEnv)) throw Object.assign(new Error('流程 Webhook 提供方、租户或密钥引用无效。'), { code: 'WORKFLOW_WEBHOOK_CONFIG_INVALID', status: 503 });
    ids.add(id);
    return { id, tenantId, signingSecretEnv };
  });
};

export const configuredWorkflowWebhookProviderIds = (env = process.env) => new Set(parseConfiguration(env).map(item => item.id));

const verifyWebhook = ({ providerId, headers, body, env, receivedAt }) => {
  const config = parseConfiguration(env).find(item => item.id === providerId);
  if (!config) return failure('WORKFLOW_WEBHOOK_PROVIDER_UNKNOWN', '未配置该流程通知提供方。', 404);
  const secret = String(env[config.signingSecretEnv] || '');
  if (Buffer.byteLength(secret, 'utf8') < 32) return failure('WORKFLOW_WEBHOOK_SECRET_UNAVAILABLE', '流程通知签名密钥未配置或强度不足。', 503);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['eventType', 'resourceRef'].includes(key))) return failure('WORKFLOW_WEBHOOK_BODY_INVALID', '流程通知正文契约无效。');
  const eventType = String(body.eventType || '').trim();
  if (!EVENT_TYPES.has(eventType)) return failure('WORKFLOW_WEBHOOK_EVENT_TYPE_INVALID', '流程通知事件类型不受支持。');
  if (body.resourceRef !== undefined && (typeof body.resourceRef !== 'string' || body.resourceRef.length > 240)) return failure('WORKFLOW_WEBHOOK_BODY_INVALID', '流程通知资源引用无效。');
  const eventId = header(headers, 'x-workflow-event-id');
  const timestamp = header(headers, 'x-workflow-timestamp');
  const supplied = header(headers, 'x-workflow-signature');
  if (!EVENT_ID_PATTERN.test(eventId) || !/^\d{10}$/u.test(timestamp) || !/^sha256=[a-f0-9]{64}$/u.test(supplied)) return failure('WORKFLOW_WEBHOOK_SIGNATURE_INVALID', '流程通知签名字段无效。', 401);
  const observedAt = Number(timestamp) * 1000;
  const configuredSkew = Number(env.WORKFLOW_WEBHOOK_MAX_SKEW_SECONDS || 300);
  const maxSkewSeconds = Number.isFinite(configuredSkew) ? Math.min(900, Math.max(60, configuredSkew)) : 300;
  if (Math.abs(receivedAt - observedAt) > maxSkewSeconds * 1000) return failure('WORKFLOW_WEBHOOK_TIMESTAMP_EXPIRED', '流程通知时间戳已过期。', 401);
  const signed = `${timestamp}\n${providerId}\n${eventId}\n${eventType}`;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(signed).digest('hex')}`);
  const candidate = Buffer.from(supplied);
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return failure('WORKFLOW_WEBHOOK_SIGNATURE_INVALID', '流程通知签名校验失败。', 401);
  return {
    config, event: {
      id: `${providerId}:${eventId}`, providerId, externalEventId: eventId, eventType,
      resourceRefHash: body.resourceRef ? createHash('sha256').update(body.resourceRef).digest('hex').slice(0, 24) : null,
      sourceTimestamp: new Date(observedAt).toISOString(), receivedAt: new Date(receivedAt).toISOString()
    }
  };
};

const enqueue = event => mutateState(NAMESPACE, stateKey(), initialInbox, inbox => {
  const existing = inbox.events.find(item => item.id === event.id);
  if (existing) {
    if (existing.eventType !== event.eventType) return { commit: false, result: failure('WORKFLOW_WEBHOOK_EVENT_CONFLICT', '同一通知编号对应了不同事件类型。', 409) };
    return { commit: false, result: { accepted: true, duplicate: true, event: clone(existing) } };
  }
  const retained = inbox.events.filter(item => item.status !== 'succeeded' || Date.now() - Date.parse(item.completedAt || item.receivedAt) < 7 * 86_400_000);
  if (retained.length >= MAX_EVENTS) return { commit: false, result: failure('WORKFLOW_WEBHOOK_INBOX_FULL', '流程通知收件箱已满，需要先处理失败事件。', 503) };
  const record = { ...event, status: 'pending', attempts: 0, nextAttemptAt: event.receivedAt, leaseId: null, leaseExpiresAt: null, errorCode: null, completedAt: null, replayCount: 0 };
  inbox.events = [record, ...retained].slice(0, MAX_EVENTS);
  return { value: inbox, result: { accepted: true, duplicate: false, event: clone(record) } };
});

const receive = ({ providerId, headers, body, env = process.env, receivedAt = Date.now() } = {}) => {
  try {
    const verified = verifyWebhook({ providerId, headers, body, env, receivedAt });
    if (verified.error) return verified;
    return runWithSemanticTenant({ tenantId: verified.config.tenantId }, () => enqueue(verified.event));
  } catch (error) {
    return failure(error.code || 'WORKFLOW_WEBHOOK_CONFIG_INVALID', error.message || '流程通知配置无效。', error.status || 503);
  }
};

const claim = ({ workerId, limit = 20, at = Date.now() } = {}) => mutateState(NAMESPACE, stateKey(), initialInbox, inbox => {
  const boundedLimit = Math.min(20, Math.max(1, Number(limit) || 20));
  const candidates = inbox.events
    .filter(item => (item.status === 'pending' && Date.parse(item.nextAttemptAt) <= at) || (item.status === 'processing' && Date.parse(item.leaseExpiresAt) <= at))
    .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt))
    .slice(0, boundedLimit);
  const claimed = candidates.map(item => {
    item.status = 'processing';
    item.attempts += 1;
    item.leaseId = `${workerId}:${randomUUID()}`;
    item.leaseExpiresAt = new Date(at + LEASE_MS).toISOString();
    return clone(item);
  });
  return { value: inbox, result: claimed };
});

const complete = ({ claims = [], succeeded, errorCode = null, at = Date.now() } = {}) => mutateState(NAMESPACE, stateKey(), initialInbox, inbox => {
  const receipts = [];
  for (const claimRecord of claims) {
    const item = inbox.events.find(event => event.id === claimRecord.id);
    if (!item || item.status !== 'processing' || item.leaseId !== claimRecord.leaseId) continue;
    item.leaseId = null;
    item.leaseExpiresAt = null;
    if (succeeded) {
      item.status = 'succeeded';
      item.errorCode = null;
      item.completedAt = new Date(at).toISOString();
    } else {
      item.errorCode = safeCode(errorCode);
      item.status = item.attempts >= MAX_ATTEMPTS ? 'dead_letter' : 'pending';
      item.nextAttemptAt = new Date(at + Math.min(300_000, 1000 * (2 ** item.attempts))).toISOString();
    }
    receipts.push({ id: item.id, status: item.status, attempts: item.attempts, errorCode: item.errorCode });
  }
  return { value: inbox, result: receipts };
});

const replay = ({ eventId, actor = null, at = Date.now() } = {}) => mutateState(NAMESPACE, stateKey(), initialInbox, inbox => {
  const item = inbox.events.find(event => event.id === eventId);
  if (!item) return { commit: false, result: failure('WORKFLOW_WEBHOOK_EVENT_NOT_FOUND', '未找到流程通知事件。', 404) };
  if (item.status !== 'dead_letter') return { commit: false, result: failure('WORKFLOW_WEBHOOK_EVENT_NOT_DEAD', '只有死信事件可以重新入队。', 409) };
  item.status = 'pending';
  item.attempts = 0;
  item.nextAttemptAt = new Date(at).toISOString();
  item.errorCode = null;
  item.completedAt = null;
  item.replayCount += 1;
  item.replayedBy = actor ? { type: actor.type, id: String(actor.id || '').slice(0, 120) } : null;
  return { value: inbox, result: { event: clone(item) } };
});

const overview = () => {
  const inbox = readState(NAMESPACE, stateKey(), initialInbox);
  const counts = { pending: 0, processing: 0, succeeded: 0, deadLetter: 0 };
  for (const event of inbox.events) {
    if (event.status === 'dead_letter') counts.deadLetter += 1;
    else if (Object.hasOwn(counts, event.status)) counts[event.status] += 1;
  }
  return {
    ...counts,
    recentDeadLetters: inbox.events.filter(item => item.status === 'dead_letter').slice(0, 10).map(item => ({ id: item.id, providerId: item.providerId, eventType: item.eventType, attempts: item.attempts, errorCode: item.errorCode, receivedAt: item.receivedAt }))
  };
};

export const workflowWebhookOperations = Object.freeze({ receive, claim, complete, replay, overview });

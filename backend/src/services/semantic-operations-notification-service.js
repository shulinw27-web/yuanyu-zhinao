import { randomUUID } from 'node:crypto';
import { mutateSemanticGovernanceState, readSemanticGovernanceState } from './semantic-governance-store.js';
import { semanticOperationsOwnerMatches, semanticOperationsPrincipalKey } from './semantic-operations-identity.js';

const NAMESPACE = 'semantic_operations_notifications';
const KEY = 'index';
const now = () => new Date().toISOString();
const readIndex = () => readSemanticGovernanceState(NAMESPACE, KEY, {});
const mutateIndex = (callback) => mutateSemanticGovernanceState(NAMESPACE, KEY, {}, callback);

export async function createSemanticOperationsNotification({ identityScope, severity = 'info', title, message, sourceType, sourceId, action = null }) {
  const owner = semanticOperationsPrincipalKey(identityScope);
  const createdAt = now();
  const notification = { id: `semantic-notice-${randomUUID()}`, owner, severity, title: String(title || '语义运营提醒').slice(0, 120), message: String(message || '').slice(0, 800), sourceType: sourceType || 'system', sourceId: sourceId || null, action, createdAt, readAt: null };
  await mutateIndex((index) => {
    index[notification.id] = notification;
    const rows = Object.values(index).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const stale of rows.slice(500)) delete index[stale.id];
    return { value: index };
  });
  return notification;
}

export async function listSemanticOperationsNotifications({ identityScope, limit = 50 }) {
  const index = await readIndex();
  return Object.values(index).filter((item) => semanticOperationsOwnerMatches(item.owner, identityScope)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, Math.min(Number(limit) || 50, 100)));
}

export async function readSemanticOperationsNotification({ id, identityScope }) {
  return mutateIndex((index) => {
    const notification = index[id];
    if (!notification || !semanticOperationsOwnerMatches(notification.owner, identityScope)) return { commit: false, result: { error: '未找到当前身份的语义通知。', code: 'SEMANTIC_NOTIFICATION_NOT_FOUND' } };
    notification.readAt ||= now();
    index[id] = notification;
    return { value: index, result: notification };
  });
}

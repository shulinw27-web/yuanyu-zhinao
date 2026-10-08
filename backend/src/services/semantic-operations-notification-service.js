import { randomUUID } from 'node:crypto';
import { mutateSemanticGovernanceState, readSemanticGovernanceState } from './semantic-governance-store.js';
import { semanticOperationsOwnerMatches, semanticOperationsPrincipalKey } from './semantic-operations-identity.js';

export const SEMANTIC_NOTIFICATION_NAMESPACE = 'semantic_operations_notifications';
const NAMESPACE = SEMANTIC_NOTIFICATION_NAMESPACE;
const KEY = 'index';
const now = () => new Date().toISOString();
const readIndex = () => readSemanticGovernanceState(NAMESPACE, KEY, {});
const mutateIndex = (callback) => mutateSemanticGovernanceState(NAMESPACE, KEY, {}, callback);

// Pure construction/insertion lets other aggregates save their result and its
// notification in the same repository transaction.
export function buildSemanticOperationsNotification({ identityScope, severity = 'info', title, message, sourceType, sourceId, action = null, audiencePermissionId = null, createdAt = now() }) {
  const owner = semanticOperationsPrincipalKey(identityScope);
  return { id: `semantic-notice-${randomUUID()}`, owner, audience: audiencePermissionId ? { tenantId: identityScope?.tenantId || 'demo-enterprise', permissionId: audiencePermissionId } : null, severity, title: String(title || '元域智语提醒').slice(0, 120), message: String(message || '').slice(0, 800), sourceType: sourceType || 'system', sourceId: sourceId || null, action, createdAt, readAt: null };
}

export function insertSemanticOperationsNotification(index, notification) {
  index[notification.id] = notification;
  const [tenantId, subjectId] = JSON.parse(notification.owner);
  // Keep the just-created notice even when multiple writes share a timestamp.
  // One principal's volume must never delete another principal's notices.
  const rows = Object.values(index).filter(item => semanticOperationsOwnerMatches(item.owner, { tenantId, subjectId }) && item.id !== notification.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  for (const stale of rows.slice(499)) delete index[stale.id];
}

export async function createSemanticOperationsNotification(input) {
  const notification = buildSemanticOperationsNotification(input);
  await mutateIndex((index) => {
    insertSemanticOperationsNotification(index, notification);
    return { value: index };
  });
  return notification;
}

const sameNotificationTenant = (item, identityScope) => item.audience?.tenantId === (identityScope?.tenantId || 'demo-enterprise');
const canViewNotification = (item, identityScope, accessContext) => semanticOperationsOwnerMatches(item.owner, identityScope)
  || Boolean(sameNotificationTenant(item, identityScope) && item.audience?.permissionId
    && accessContext?.buttonPermissionIds?.includes(item.audience.permissionId));

export async function listSemanticOperationsNotifications({ identityScope, accessContext, limit = 50 }) {
  const index = await readIndex();
  return Object.values(index).filter((item) => canViewNotification(item, identityScope, accessContext)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, Math.min(Number(limit) || 50, 100)));
}

export async function readSemanticOperationsNotification({ id, identityScope, accessContext }) {
  return mutateIndex((index) => {
    const notification = index[id];
    if (!notification || !canViewNotification(notification, identityScope, accessContext)) return { commit: false, result: { error: '未找到当前身份的语义通知。', code: 'SEMANTIC_NOTIFICATION_NOT_FOUND' } };
    notification.readAt ||= now();
    index[id] = notification;
    return { value: index, result: notification };
  });
}

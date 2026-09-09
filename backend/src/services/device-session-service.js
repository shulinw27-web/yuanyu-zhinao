import { listState, writeState } from '../repositories/runtime-state-repository.js';

const DEVICE_NAMESPACE = 'device_sessions';
const SUBSCRIPTION_NAMESPACE = 'notification_subscriptions';

const id = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const registerDeviceSession = ({ deviceId, platform, appVersion, pushToken, notificationChannel }, roleId) => {
  const session = {
    id: id('device-session'),
    deviceId: deviceId || id('anonymous-device'),
    platform: platform || 'unknown',
    appVersion: appVersion || 'unknown',
    roleId,
    pushToken: pushToken || null,
    notificationChannel: notificationChannel || 'in_app',
    issuedAt: new Date().toISOString(),
    expiresIn: 8 * 60 * 60
  };
  writeState(DEVICE_NAMESPACE, session.id, session);
  return { ...session, pushToken: session.pushToken ? '已登记（演示）' : null };
};

export const subscribeNotificationChannel = ({ channel, target, deviceId }, roleId) => {
  if (!['in_app', 'sms', 'email', 'webhook', 'push', 'voice'].includes(channel)) return { error: '不支持的通知渠道' };
  if (!target && channel !== 'in_app') return { error: '该通知渠道需要接收地址' };
  const subscription = {
    id: id('subscription'),
    channel,
    target: target || deviceId || roleId,
    deviceId: deviceId || null,
    roleId,
    status: 'active',
    createdAt: new Date().toISOString()
  };
  writeState(SUBSCRIPTION_NAMESPACE, subscription.id, subscription);
  return subscription;
};

export const getDeviceSessionMetrics = () => ({
  activeSessions: listState(DEVICE_NAMESPACE).length,
  notificationSubscriptions: listState(SUBSCRIPTION_NAMESPACE).length
});

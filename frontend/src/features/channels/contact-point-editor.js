export const contactChannelOptions = [
  { id: 'in_app', name: '站内信' },
  { id: 'push', name: 'Push' },
  { id: 'sms', name: '短信' },
  { id: 'voice', name: '虚拟电话' },
  { id: 'email', name: '邮件' },
  { id: 'webhook', name: 'Webhook' }
];

export function editableContactPoints(value = []) {
  return value.map((contact) => ({
    userId: String(contact.userId || ''),
    email: String(contact.email || ''),
    maskedPhone: String(contact.maskedPhone || ''),
    enabledChannels: Array.isArray(contact.enabledChannels) ? [...contact.enabledChannels] : ['in_app', 'email']
  }));
}

export function createContactPointDraft(userId = '') {
  return { userId, email: '', maskedPhone: '', enabledChannels: ['in_app', 'email'] };
}

export function contactPointIssue(contacts) {
  if (!contacts.length) return '';
  const users = new Set();
  for (const contact of contacts) {
    const userId = String(contact.userId || '').trim();
    const email = String(contact.email || '').trim();
    if (!userId) return '每个联系点都必须填写当前租户的 IAM 用户 ID。';
    if (users.has(userId)) return `IAM 用户 ${userId} 不能重复配置。`;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return `${userId} 的邮件地址格式无效。`;
    if (!Array.isArray(contact.enabledChannels) || !contact.enabledChannels.length) return `${userId} 至少需要启用一个通知渠道。`;
    users.add(userId);
  }
  return '';
}

export function contactPointPayload(contacts) {
  return contacts.map((contact) => ({
    userId: String(contact.userId).trim(),
    email: String(contact.email).trim().toLowerCase(),
    maskedPhone: String(contact.maskedPhone || '').trim() || null,
    enabledChannels: [...new Set(contact.enabledChannels)]
  }));
}

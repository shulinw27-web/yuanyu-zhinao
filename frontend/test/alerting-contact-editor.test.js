import test from 'node:test';
import assert from 'node:assert/strict';
import { contactPointIssue, contactPointPayload, createContactPointDraft, editableContactPoints } from '../src/features/channels/contact-point-editor.js';

test('联系点编辑模型不暴露受控电话引用，并规范化可发布字段', () => {
  const editable = editableContactPoints([{
    userId: 'admin-a', email: 'OPS@A.EXAMPLE', maskedPhone: '139****0001',
    phoneRef: 'pii://tenant-a/users/admin-a/mobile', enabledChannels: ['email', 'in_app']
  }]);
  assert.equal(Object.hasOwn(editable[0], 'phoneRef'), false);
  assert.equal(contactPointIssue(editable), '');
  assert.deepEqual(contactPointPayload(editable), [{
    userId: 'admin-a', email: 'ops@a.example', maskedPhone: '139****0001', enabledChannels: ['email', 'in_app']
  }]);
});

test('联系点编辑在提交前拒绝重复身份、非法邮箱和空渠道', () => {
  const contact = createContactPointDraft();
  assert.match(contactPointIssue([contact]), /IAM 用户 ID/);
  contact.userId = 'admin-a';
  contact.email = 'invalid';
  assert.match(contactPointIssue([contact]), /邮件地址格式无效/);
  contact.email = 'ops@a.example';
  contact.enabledChannels = [];
  assert.match(contactPointIssue([contact]), /至少需要启用一个/);
  contact.enabledChannels = ['email'];
  assert.match(contactPointIssue([contact, { ...contact }]), /不能重复配置/);
});

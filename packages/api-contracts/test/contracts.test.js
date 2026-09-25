import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { API_ERROR_CODES, AUTHORIZATION_REJECTION_CODES, normalizeAgentMessageBody } from '../src/index.js';

test('Agent 消息契约同时规范化旧版和新版请求体', () => {
  assert.deepEqual(normalizeAgentMessageBody({ text: 'legacy', conversationId: 'c1' }), {
    ok: true,
    input: { text: 'legacy', attachments: undefined, conversationId: 'c1' }
  });
  assert.deepEqual(normalizeAgentMessageBody({ input: { text: 'modern', attachments: [] } }), {
    ok: true,
    input: { text: 'modern', attachments: [] }
  });
});

test('Agent 消息契约拒绝不稳定字段类型并返回稳定错误码', () => {
  const result = normalizeAgentMessageBody({ input: { text: 42 } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, API_ERROR_CODES.INVALID_REQUEST_BODY);
});

test('授权拒绝错误码由共享契约提供且不可在运行时修改', () => {
  assert.equal(AUTHORIZATION_REJECTION_CODES.includes(API_ERROR_CODES.AGENT_ORIGIN_ROLE_DENIED), true);
  assert.throws(() => AUTHORIZATION_REJECTION_CODES.push('UNSAFE_MUTATION'), TypeError);
});

test('OpenAPI 契约可解析、operationId 唯一并覆盖核心模块', async () => {
  const source = await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8');
  const document = parse(source);
  assert.equal(document.openapi, '3.1.0');

  const operations = Object.entries(document.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
      .map(([method, operation]) => ({ path, method, ...operation }))
  );
  const operationIds = operations.map((item) => item.operationId);
  assert.equal(new Set(operationIds).size, operationIds.length);
  assert.equal(operations.length >= 25, true);
  assert.deepEqual(document.paths['/health/live'].get.security, []);
  assert.deepEqual(document.paths['/health/ready'].get.security, []);
  for (const path of ['/access/me', '/permission-management', '/agent/message', '/agent/traces', '/agent/learning-profile', '/agent/desktop-endpoint/heartbeat', '/risk-cases', '/alerting/workspace', '/procurement/launch', '/simulation/overview']) {
    assert.ok(document.paths[path], `缺少核心路径 ${path}`);
  }
  for (const path of ['/semantic-operations/tasks', '/semantic-operations/tasks/{id}/trace', '/semantic-operations/inspections', '/semantic-operations/notifications', '/semantic-operations/tasks/{id}/report-export']) assert.ok(document.paths[path], `缺少元域智营路径 ${path}`);
  assert.deepEqual(document.paths['/auth/local/login'].post.security, []);
  assert.equal(document.components.securitySchemes.oidcBearer.scheme, 'bearer');
  assert.equal(document.paths['/permission-management/roles/{id}/policy'].post['x-button-permission'], 'permission.policy.save');
  assert.equal(document.paths['/domain-events/outbox'].get['x-button-permission'], 'event.outbox.view');
  assert.equal(document.paths['/domain-events/contracts'].get['x-button-permission'], 'event.outbox.view');
  assert.equal(document.paths['/domain-events/outbox/{id}/replay'].post['x-button-permission'], 'event.outbox.replay');
});

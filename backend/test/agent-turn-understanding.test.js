import test from 'node:test';
import assert from 'node:assert/strict';
import { affirmativeRequest, conversationMaterial, parseTurnUnderstanding, prohibitsAction } from '../src/services/agent-turn-understanding-service.js';
import { classifySemanticOperationsIntent, createSemanticOperationsTask, listSemanticOperationsTasks } from '../src/services/semantic-operations-task-service.js';
import { isBroadReportRequest } from '../src/services/agent-dialogue-intent-service.js';
import { validateNaturalSchema } from '../src/services/semantic-natural-schema-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { validateSemanticMappingContract } from '../src/services/semantic-mapping-validation-service.js';
import { createAgentConversation, getAgentConversationContext, recordAgentConversationExchange } from '../src/services/agent-conversation-service.js';

test('negative clauses cannot become publish requests and do not swallow affirmative build requests', () => {
  for (const input of ['只讨论方案，不保存、不发布。采购订单主键是什么？', '我不需要发布，只想知道采购订单主键是什么。', '不要发布模型', '暂不发布，解释字段']) {
    assert.notEqual(classifySemanticOperationsIntent(input).intent, 'publish_model', input);
    assert.equal(prohibitsAction(input, 'publish_model'), true, input);
  }
  for (const input of ['请建立采购订单模型，但不要发布。', '请生成候选语义模型，采购订单字段 po_no、amount，仅供审阅，不发布。', '根据 ERP 数据字典识别供应商对象']) {
    assert.equal(classifySemanticOperationsIntent(input).intent, 'build_model', input);
    assert.equal(prohibitsAction(input, 'build_model'), false, input);
  }
  assert.equal(isBroadReportRequest('我不要 ERP 报告了，只排明天工作'), false);
  assert.match(affirmativeRequest('建立订单模型，但不要发布'), /建立订单模型/);
});

test('turn contract refuses malformed output, cross-surface intents and missing clarification state', () => {
  const good = { schemaVersion: 'agent-turn.v1', intent: 'dialogue', answer: '周四下午三点', resolvedRequest: '', needsClarification: false };
  assert.equal(parseTurnUnderstanding(JSON.stringify(good), 'business').answer, good.answer);
  for (const bad of ['not json', '{}', JSON.stringify({ ...good, intent: 'delete_all' }), JSON.stringify({ ...good, needsClarification: null }), JSON.stringify({ ...good, intent: 'publish_model' })]) assert.equal(parseTurnUnderstanding(bad, 'business'), null);
  assert.equal(parseTurnUnderstanding(JSON.stringify({ ...good, intent: 'read_business' }), 'semantic'), null);
});

test('unauthorized operations remain visible as denied conversation, not hidden executable plans', async () => {
  const identityScope = { tenantId: 'turn-tests', subjectId: 'quality-turn', deviceId: 'turn-device' };
  const task = await createSemanticOperationsTask({ body: { text: '发布语义模型' }, role: getRole('quality_manager'), identityScope });
  assert.equal(task.status, 'denied');
  assert.equal(task.intent, 'permission_denied');
  assert.equal(task.command, null);
  assert.equal(task.confirmationRequired, false);
  assert.ok((await listSemanticOperationsTasks({ identityScope, accessContext: { buttonPermissionIds: [] } })).some(item => item.id === task.id));
});

test('missing information is needs_input, not completed', async () => {
  const task = await createSemanticOperationsTask({ body: { text: '帮我处理一下' }, role: getRole('executive'), identityScope: { tenantId: 'turn-tests', subjectId: 'clarify-turn', deviceId: 'turn-device' } });
  assert.equal(task.status, 'needs_input');
  assert.equal(task.command, null);
});

test('twenty-turn context retains user facts and corrections without leaking another conversation', async () => {
  const identityScope = { tenantId: 'turn-tests', subjectId: 'twenty-turn', deviceId: 'turn-device' };
  const conversation = await createAgentConversation({ roleId: 'executive', identityScope });
  const exchange = userText => recordAgentConversationExchange({ conversationId: conversation.id, identityScope, roleId: 'executive', userText, response: { text: '已回应。' } });
  await exchange('项目代号蓝杉，截止周四下午三点。');
  for (let index = 0; index < 18; index += 1) await exchange(`讨论第${index + 1}项合成工作，不改变截止时间。`);
  await exchange('更正：代号青禾，截止时间不变。');
  const context = await getAgentConversationContext(conversation.id, identityScope);
  assert.match(context.prompt, /蓝杉/); assert.match(context.prompt, /青禾/); assert.match(context.prompt, /周四下午三点/);
  const other = await createAgentConversation({ roleId: 'executive', identityScope });
  assert.doesNotMatch((await getAgentConversationContext(other.id, identityScope)).prompt, /蓝杉|青禾/);
  assert.equal(await getAgentConversationContext(conversation.id, { ...identityScope, subjectId: 'other' }), null);
});

test('natural schema requires literal evidence and never marks unknown sources or mappings verified', () => {
  const material = '订单 orders：id 为主键，amount。';
  const value = { tables: [{ name: 'orders', evidence: '订单 orders', key: 'id', keyEvidence: 'id 为主键', fields: [{ name: 'id', evidence: 'id 为主键' }, { name: 'amount', evidence: 'amount' }] }] };
  const valid = validateNaturalSchema(value, material);
  assert.ok(validateNaturalSchema(JSON.parse(JSON.stringify(value).normalize('NFKC')), material));
  assert.equal(valid.objectTypes[0].key, 'id');
  assert.deepEqual(valid.objectTypes[0].sourceSystems, ['UNASSIGNED']);
  assert.ok(valid.objectTypes[0].fieldDefinitions.every(field => field.mappingStatus === 'pending'));
  const mapping = validateSemanticMappingContract(valid);
  assert.equal(mapping.blocked, true);
  const invented = structuredClone(value); invented.tables[0].fields.push({ name: 'status', evidence: 'status' });
  assert.equal(validateNaturalSchema(invented, material), null);
  const foreign = structuredClone(value); foreign.tables[0].fields[1].reference = 'secret_table';
  assert.equal(validateNaturalSchema(foreign, material), null);
});

test('scanned attachment context survives follow-ups but is excluded after access changes and from JSON responses', async () => {
  const identityScope = { tenantId: 'material-tests', subjectId: 'material-tests', deviceId: 'material-tests' };
  const accessContext = { roleIds: ['executive'], organizationIds: ['one'] };
  const conversation = await createAgentConversation({ roleId: 'executive', identityScope });
  const response = { text: '附件包含订单结构。', [conversationMaterial]: 'orders 的主键是 order_key。' };
  assert.doesNotMatch(JSON.stringify(response), /order_key/);
  await recordAgentConversationExchange({ conversationId: conversation.id, identityScope, roleId: 'executive', accessContext, userText: '请阅读附件', response });
  assert.match((await getAgentConversationContext(conversation.id, identityScope, accessContext)).prompt, /order_key/);
  assert.doesNotMatch((await getAgentConversationContext(conversation.id, identityScope, { ...accessContext, organizationIds: ['two'] })).prompt, /order_key/);
});

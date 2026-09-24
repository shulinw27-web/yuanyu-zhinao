import { loadArkFileConfig } from './ark-file-config.mjs';
process.env.NODE_ENV = 'test'; process.env.RUNTIME_STORE_DRIVER = 'memory';
process.env.AGENT_RUNTIME_MODE = process.env.AGENT_RUNTIME_MODE || 'ark'; process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = '{}'; if (process.env.AGENT_RUNTIME_MODE === 'ark') loadArkFileConfig();
const { runPrivateAgent } = await import('../backend/src/services/private-agent-service.js');
const { getRole } = await import('../backend/src/services/authorization-service.js');
const { createAgentConversation, getAgentConversationContext, recordAgentConversationExchange } = await import('../backend/src/services/agent-conversation-service.js');
const { createSemanticOperationsTask } = await import('../backend/src/services/semantic-operations-task-service.js');
const identity = { tenantId: 'demo-enterprise', subjectId: 'synthetic-material-context', deviceId: 'synthetic-material-context' };
const role = getRole('executive');
const dictionary = { tables: [{ name: 'RepairTicket', primaryKey: 'ticket_code', fields: [{ name: 'ticket_code', type: 'string', primaryKey: true }, { name: 'repair_cost', type: 'number' }] }] };
const attachment = { name: 'synthetic-wms-dictionary.json', mimeType: 'application/json', dataUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(dictionary)).toString('base64')}` };
const conversation = await createAgentConversation({ roleId: role.id, identityScope: identity });
const results = [];
for (const [index, text] of ['只讨论附件字典内容，不读取系统，不建模。请告诉我有哪些表，不需要列字段。', '附件里面这张表的主键和金额字段分别叫什么？只回答两个字段名。'].entries()) {
  const context = await getAgentConversationContext(conversation.id, identity);
  const response = await runPrivateAgent({ text, ...(index === 0 ? { attachments: [attachment] } : {}) }, role, identity, { conversationContext: context });
  const passed = response.agent.inferenceSource === (process.env.AGENT_RUNTIME_MODE || 'ark') && !response.command && (index === 0 ? /RepairTicket/.test(response.text) : /ticket_code/.test(response.text) && /repair_cost/.test(response.text));
  results.push(passed); console.log(JSON.stringify({ surface: 'brain', turn: index + 1, answer: response.text, passed }));
  await recordAgentConversationExchange({ conversationId: conversation.id, identityScope: identity, roleId: role.id, userText: text, response });
}
let parent;
for (const [index, text] of ['只讨论附件字典内容，不保存、不发布。请告诉我有哪些表，不需要列字段。', '附件里面这张表的主键和金额字段分别叫什么？只回答两个字段名。'].entries()) {
  const task = await createSemanticOperationsTask({ body: { text, ...(index === 0 ? { attachments: [attachment] } : { parentTaskId: parent.id }) }, role, identityScope: identity });
  const passed = task.routing?.source === (process.env.AGENT_RUNTIME_MODE || 'ark') && !task.command && (index === 0 ? /RepairTicket/.test(task.response) : /ticket_code/.test(task.response) && /repair_cost/.test(task.response));
  results.push(passed); console.log(JSON.stringify({ surface: 'semantic', turn: index + 1, answer: task.response, passed })); parent = task;
}
console.log(JSON.stringify({ type: 'summary', passed: results.filter(Boolean).length, total: results.length, scope: 'synthetic_json_attachment_and_followup_not_image_or_voice' }));
process.exitCode = results.every(Boolean) ? 0 : 1;

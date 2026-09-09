import { loadArkFileConfig } from './ark-file-config.mjs';
process.env.NODE_ENV = 'test';
process.env.RUNTIME_STORE_DRIVER = 'memory';
process.env.AGENT_RUNTIME_MODE = 'ark';
process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = '{}';
loadArkFileConfig();
const { runPrivateAgent } = await import('../backend/src/services/private-agent-service.js');
const { getRole } = await import('../backend/src/services/authorization-service.js');
const { createAgentConversation, recordAgentConversationExchange, getAgentConversationContext } = await import('../backend/src/services/agent-conversation-service.js');
const { createSemanticOperationsTask } = await import('../backend/src/services/semantic-operations-task-service.js');
// The in-memory demo fixtures belong to demo-enterprise. A different tenant
// deliberately cannot see them; use an isolated synthetic subject in that tenant.
const identity = { tenantId: 'demo-enterprise', subjectId: 'synthetic-intelligence', sessionId: 'synthetic-intelligence', deviceId: 'synthetic-intelligence' };
const role = getRole('executive');
const results = [];
async function brainCases(cases) {
  const conversation = await createAgentConversation({ roleId: role.id, identityScope: identity });
  for (const [id, text, accepts] of cases) {
    const context = await getAgentConversationContext(conversation.id, identity);
    const start = Date.now();
    const response = await runPrivateAgent({ text }, role, identity, { conversationContext: context });
    const row = { id, input: text, source: response.agent.inferenceSource, answer: response.text, state: response.lifecycle?.state, milliseconds: Date.now() - start, passed: response.agent.inferenceSource === 'ark' && !response.command && accepts(response.text) && (id !== 'B2' || response.evidence.length > 0), evidenceCount: response.evidence.length };
    if (id === 'B3' && !results.find(result => result.id === 'B2')?.passed) row.passed = false;
    results.push(row); console.log(JSON.stringify(row));
    await recordAgentConversationExchange({ conversationId: conversation.id, identityScope: identity, roleId: role.id, userText: text, response });
  }
}
const noIso = value => !/ISO|历史快照/.test(value);
await brainCases([
  ['B1', '验收测试：我需要最新的 ERP 系统报告，先不要生成文件，也不要发起业务流程。', value => noIso(value) && /综合|专项|范围/.test(value)],
  ['B2', '只看库存，用当前可访问的模拟记录分析三个关注点。不要生成文件，也不要发起业务流程。', value => /模拟/.test(value)],
  ['B3', '第二个问题具体是什么意思？不要重新列另外三个问题，用两句话解释就行。', value => noIso(value) && !/看不到.{0,8}(?:问题|上文)|发给我|原文发|无法准确解释/.test(value)],
  ['B4', '纠正一下：我现在不要 ERP 报告了。只基于以下合成事项排明天的工作：9点开会，11点前交周报，下午核对合同。不要读取公司系统，也不要创建文件。', value => noIso(value) && /合同/.test(value) && /周报/.test(value) && !/综合概览|专项安排/.test(value)],
  ['B5', '就按我上一条给出的三件事排时间。然后把11点改成10点半，其他约束不变。直接给安排，不要再问综合还是专项。', value => noIso(value) && /10[:：]30|10点半/.test(value) && /合同/.test(value)]
]);
await brainCases([
  ['B6', '上下文验收，以下全是合成信息：我的演示项目代号是蓝杉，周报截止时间是周四下午三点。我喜欢三条以内的简短回答。只在当前会话使用，不写入长期记忆，不读取公司系统。请复述这三项。', value => /蓝杉/.test(value) && /周四|星期四/.test(value)],
  ['B7', '补充更正：代号改成青禾，截止时间不变。请只回答更正后的代号和原来的截止时间。', value => /青禾/.test(value) && /周四|星期四/.test(value) && /三点|3点|15[:：]00/.test(value)],
  ['B8', '周报到底是星期几几点截止？我前面已经告诉你了，请直接回答。', value => /周四|星期四/.test(value) && /三点|3点|15[:：]00/.test(value)]
]);
let parent;
const dictionary = '采购订单 po_header：po_no 为主键，supplier_code，amount。入库单 receipt：receipt_no 为主键，po_no 为采购订单外键，received_qty。同一采购订单可多次入库。';
for (const [id, text, accepts, fresh] of [
  ['S1', '验收测试：你好，请用一句话说明你能做什么。不要建模或修改任何草稿。', task => /语义|建模|模型/.test(task.response) && !task.command],
  ['S2', `只讨论方案，不保存、不发布。合成数据字典：${dictionary}请说明应抽取哪些对象和关系，以及如何避免采购金额在多次入库时重复统计。`, task => /聚合|粒度|重复/.test(task.response) && !task.command],
  ['S3', '我刚才给出的采购订单主键是什么？请只回答字段名。', task => /po_no/.test(task.response) && !task.command],
  ['S4', `验收测试：请根据以下合成数据字典生成候选语义模型，仅展示提案供我审阅。${dictionary}`, task => task.intent === 'build_model' && task.status === 'waiting_confirmation' && task.proposal?.objectTypes.some(object => object.id === 'po_header' && object.key === 'po_no') && task.proposal?.relationshipTypes.some(relation => relation.from === 'receipt' && relation.to === 'po_header'), true]
]) {
  const start = Date.now();
  const task = await createSemanticOperationsTask({ body: { text, ...(!fresh && parent ? { parentTaskId: parent.id } : {}) }, role, identityScope: identity });
  const row = { id, input: text, source: task.routing?.source, intent: task.intent, answer: task.response || task.error, milliseconds: Date.now() - start, state: task.status, passed: task.routing?.source === 'ark' && Boolean(accepts(task)), proposal: task.proposal ? { objects: task.proposal.objectTypes.map(object => ({ id: object.id, key: object.key, fields: object.fields })), relations: task.proposal.relationshipTypes, critic: task.proposal.critic.status } : null };
  results.push(row); console.log(JSON.stringify(row)); parent = task;
}
console.log(JSON.stringify({ type: 'summary', passed: results.filter(result => result.passed).length, total: results.length, syntheticOnly: true, executedWrites: 0, note: 'Assertions cover named acceptance properties, not a universal intelligence score. Inspect answers manually.' }));
process.exitCode = results.every(result => result.passed) ? 0 : 1;

import { loadArkFileConfig } from './ark-file-config.mjs';
process.env.NODE_ENV = 'test'; process.env.RUNTIME_STORE_DRIVER = 'memory';
process.env.AGENT_RUNTIME_MODE = process.env.AGENT_RUNTIME_MODE || 'ark'; process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = '{}'; if (process.env.AGENT_RUNTIME_MODE === 'ark') loadArkFileConfig();
const { runPrivateAgent } = await import('../backend/src/services/private-agent-service.js');
const { getRole } = await import('../backend/src/services/authorization-service.js');
const { createAgentConversation, recordAgentConversationExchange, getAgentConversationContext } = await import('../backend/src/services/agent-conversation-service.js');
const identity = { tenantId: 'synthetic-long-dialogue', subjectId: 'synthetic-long-dialogue', deviceId: 'synthetic-long-dialogue' };
const role = getRole('executive');
const conversation = await createAgentConversation({ roleId: role.id, identityScope: identity });
const prompts = [
  '以下是合成工作安排，仅在本会话使用：项目代号蓝杉，截止周四下午三点，预算800元。请简短复述，不操作电脑、不读取系统。',
  '更正代号为青禾，另外两个值不变，请复述。',
  '插个话题：用一句话解释番茄工作法。',
  '回到我们的项目，预算是多少？',
  '帮我把“请尽快给我结果”改成礼貌的工作沟通语句，仅输出句子。',
  '两小时可以分成几个25分钟工作加5分钟休息的周期？',
  '预算从800元改成650元，截止时间不变。请复述项目安排。',
  '先不聊项目，用一句话解释待办清单和日历的区别。',
  '为什么会议要留出5分钟记录结论？简短回答。',
  '举一个清晰的会议议题标题，只是例子。',
  '把这个标题改得更简洁，保留主题。',
  '截止时间改成周五上午十点，不改预算和代号。给出三个最新值。',
  '现在插一个学习问题：什么叫信息过载？一句话。',
  '给我一个整理笔记的建议，不创建文件。',
  '刚才那个建议能否拆成两个步骤？',
  '再回到项目，最初的代号和现在的代号分别是什么？',
  '预算一共减少了多少钱？只回答计算结果。',
  '用一句话解释为什么要区分建议与已经执行的动作。',
  '输出一个会议记录的简短示例，只在聊天中展示，使用虚构内容。',
  '回到本会话的项目，请给我最终代号、截止时间、预算三个值，不采用已经被更正的旧值。'
];
let failures = 0;
for (const [index, input] of prompts.entries()) {
  const context = await getAgentConversationContext(conversation.id, identity);
  const response = await runPrivateAgent({ text: input }, role, identity, { conversationContext: context });
  const passed = response.agent.inferenceSource === (process.env.AGENT_RUNTIME_MODE || 'ark') && !response.command && response.evidence.length === 0
    && (index !== 19 || /青禾/.test(response.text) && /周五|星期五/.test(response.text) && /十点|10[:：]00|10点/.test(response.text) && /650/.test(response.text));
  if (!passed) failures += 1;
  console.log(JSON.stringify({ turn: index + 1, input, source: response.agent.inferenceSource, answer: response.text, passed }));
  await recordAgentConversationExchange({ conversationId: conversation.id, identityScope: identity, roleId: role.id, userText: input, response });
}
const isolated = await createAgentConversation({ roleId: role.id, identityScope: identity });
const response = await runPrivateAgent({ text: '这个新任务中，我的项目代号和截止时间是什么？如果我没有提供就直说，不要猜测。' }, role, identity, { conversationContext: await getAgentConversationContext(isolated.id, identity) });
const isolatedPassed = response.agent.inferenceSource === (process.env.AGENT_RUNTIME_MODE || 'ark') && !/青禾|蓝杉|650/.test(response.text) && !response.command;
console.log(JSON.stringify({ turn: 'new_window_isolation', answer: response.text, passed: isolatedPassed }));
if (!isolatedPassed) failures += 1;
console.log(JSON.stringify({ type: 'summary', actualModelTurns: 21, failures, note: 'Final corrected facts and no tool actions asserted; intermediate prose requires manual review.' }));
process.exitCode = failures ? 1 : 0;

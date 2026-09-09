import { loadArkFileConfig } from './ark-file-config.mjs';

// Three synthetic turns, isolated from user conversations and enterprise data.
process.env.NODE_ENV = 'test';
process.env.RUNTIME_STORE_DRIVER = 'memory';
process.env.AGENT_RUNTIME_MODE = 'ark';
process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = '{}';
loadArkFileConfig();
const { runPrivateAgent } = await import('../backend/src/services/private-agent-service.js');
const { getRole } = await import('../backend/src/services/authorization-service.js');
const { createAgentConversation, recordAgentConversationExchange, getAgentConversationContext } = await import('../backend/src/services/agent-conversation-service.js');
const identity = { tenantId: 'synthetic-dialogue', subjectId: 'synthetic-dialogue', sessionId: 'synthetic-dialogue', deviceId: 'synthetic-dialogue' };
const conversation = await createAgentConversation({ roleId: 'executive', identityScope: identity });
const results = [];
for (const text of ['我需要最新的ERP系统报告', '这是什么意思？']) {
  const context = await getAgentConversationContext(conversation.id, identity);
  const started = Date.now();
  const response = await runPrivateAgent({ text }, getRole('executive'), identity, { conversationContext: context });
  const passed = response.agent.inferenceSource === 'ark' && !response.command && response.evidence.length === 0 && !/ISO|历史快照/.test(response.text);
  results.push({ text, source: response.agent.inferenceSource, milliseconds: Date.now() - started, state: response.lifecycle?.state, answer: response.text, passed });
  await recordAgentConversationExchange({ conversationId: conversation.id, identityScope: identity, roleId: 'executive', userText: text, response });
}
const oldConversation = await createAgentConversation({ roleId: 'executive', identityScope: identity });
await recordAgentConversationExchange({ conversationId: oldConversation.id, identityScope: identity, roleId: 'executive', userText: '我需要最新的ERP系统报告', response: { text: '历史快照请提供含时区的完整 ISO 时点；尚不支持跨来源最新版本判断。本次未读取企业数据。', task: { goal: '我需要最新的ERP系统报告', status: 'needs_input' } } });
const context = await getAgentConversationContext(oldConversation.id, identity);
const explanation = await runPrivateAgent({ text: '这是什么意思？' }, getRole('executive'), identity, { conversationContext: context });
results.push({ text: '解释修复前的旧回复', source: explanation.agent.inferenceSource, state: explanation.lifecycle?.state, answer: explanation.text, passed: explanation.agent.inferenceSource === 'ark' && !explanation.command && explanation.evidence.length === 0 });
console.log(JSON.stringify({ status: results.every(item => item.passed) ? 'passed' : 'failed', data: 'synthetic_only', results }, null, 2));
process.exitCode = results.every(item => item.passed) ? 0 : 1;

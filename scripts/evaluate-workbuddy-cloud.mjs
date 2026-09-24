// WorkBuddy 云服务模型真实调用评估。
// 范围：传输层真实连通（模型目录 + 一次受控流式对话）与治理白名单核对。
// 边界：不验证完整智脑会话链路、不做生产验收；结果仅证明当前配置下云模型可真实返回。
import { readWorkBuddyCloudConfiguration } from '../backend/src/services/workbuddy-cloud-config.js';
import { validateModelSelection } from '../backend/src/services/model-governance-service.js';
import { fetchWorkBuddyCloudChat } from '../backend/src/services/workbuddy-cloud-transport.js';

const config = readWorkBuddyCloudConfiguration();
if (!config) {
  console.log(JSON.stringify({ status: 'blocked', reason: 'WORKBUDDY_CLOUD_NOT_CONFIGURED' }, null, 2));
  process.exit(1);
}

const pinnedModel = process.env.WORKBUDDY_CLOUD_MODEL || config.model;
const selection = validateModelSelection('workbuddy', pinnedModel);

const summary = {
  status: 'pending',
  endpoint: config.endpoint,
  pinnedModel,
  governanceAllowed: selection.allowed,
  allowlistSource: String(process.env.MODEL_ALLOWLIST_JSON || '').trim() ? 'environment' : 'config_file_pinned',
  chat: null
};

if (!selection.allowed) {
  summary.status = 'blocked';
  summary.reason = selection.code;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
}

const startedAt = performance.now();
try {
  const payload = await fetchWorkBuddyCloudChat({
    model: pinnedModel,
    temperature: 0.2,
    responseFormat: { type: 'json_object' },
    timeoutMs: 30_000,
    messages: [
      { role: 'system', content: `你是企业私有 Agent 的推理与解释层。输出必须是符合以下 JSON Schema 的顶层对象，不得用代码栅栏，不要返回 Schema 本身：${JSON.stringify({ type: 'object', additionalProperties: false, properties: { schemaVersion: { type: 'string', enum: ['agent-summary.v1'] }, answer: { type: 'string' }, proposedAction: { type: 'null' }, claimsExecution: { type: 'boolean', enum: [false] }, executionReceipt: { type: 'null' } }, required: ['schemaVersion', 'answer', 'proposedAction', 'claimsExecution', 'executionReceipt'] })}` },
      { role: 'user', content: '请返回就绪确认。' }
    ]
  });
  const text = payload.choices?.[0]?.message?.content?.trim() || '';
  const elapsedMs = Math.round(performance.now() - startedAt);
  summary.chat = {
    finishReason: payload.choices?.[0]?.finish_reason ?? null,
    elapsedMs,
    usage: payload.usage ? Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].map(key => [key, payload.usage?.[key] ?? null])) : null,
    envelopeValid: (() => { try { const parsed = JSON.parse(text); return parsed.schemaVersion === 'agent-summary.v1' && parsed.claimsExecution === false && parsed.proposedAction === null; } catch { return false; } })(),
    answerPreview: text.slice(0, 120)
  };
  summary.status = summary.chat.envelopeValid && summary.chat.finishReason === 'stop' ? 'passed' : 'degraded';
} catch (error) {
  summary.status = 'failed';
  summary.reason = error.message;
}

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.status === 'passed' ? 0 : 1);

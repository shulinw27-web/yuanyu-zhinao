// 会话意图识别与上下文拼装。
//
// 从 private-agent-service 抽出的独立关注点：
// 判断用户输入属于「追问」还是「新诉求」，并据此拼装可继承的会话上下文。
//
// 安全边界（不可放宽）：
// - 只继承同一授权会话中「用户」明确表达的目标与要点；
// - 模型此前的散文回复永不作为业务事实或执行指令；
// - 历史内容不构成新的授权。

import { isExplanationFollowUp } from './agent-dialogue-intent-service.js';
import { extractQueryBusinessIds } from './agent-query-service.js';
import { conversationDocuments } from './conversation-material-index.js';
import { conversationMaterial } from './agent-turn-understanding-service.js';

const conversationReferencePattern = /(?:^|[，。；：\s])(?:继续|接着|刚才|刚刚|上面|前面|之前|此前|上述|前述)|(?:这个|那个|该|它|其)(?:事项|问题|告警|任务|计划|流程|申请|风险)?(?:怎么|如何|为什么|能否|是否|继续|处理|分析|推进)?/;

// Short requests such as “给我一个处理方案” are usually a follow-up to the
// immediately preceding task even though they contain no pronoun. We only
// inherit prior *user* goals from the same authorized conversation; previous
// model prose is never treated as a business fact or an execution instruction.
const conversationFollowUpPattern = /(?:^(?:那|然后|再|继续|麻烦|请|帮我|给我|针对|根据|就).{0,28}(?:方案|建议|计划|步骤|措施|结论|明细|优先级|怎么办|怎么做|怎么处理|如何处理|下一步|继续|展开|细化)|(?:给我|给出|提供|补充|展开|细化|制定).{0,12}(?:方案|建议|计划|步骤|措施|结论|明细|优先级)|(?:下一步|怎么办|怎么做|怎么处理|如何处理|继续|展开|细化)[。！!？?]*$)/;

// 是否构成对当前会话的「追问/延续」：命中指代或短句延续模式即成立。
// 长期目标记忆只在这种情况下才有资格被召回（见 private-agent-service 的记忆选择）。
export const isConversationFollowUp = (input) => conversationReferencePattern.test(input)
  || conversationFollowUpPattern.test(String(input || '').trim());

export const getConversationUserContext = (input, conversationContext) => {
  if (!isExplanationFollowUp(input) && !isConversationFollowUp(input)) return '';
  const goal = String(conversationContext?.taskGoal || '').slice(0, 8000);
  const targets = extractQueryBusinessIds(goal);
  const notes = String(conversationContext?.userPrompt || '').split('\n').filter((line) => {
    const ids = extractQueryBusinessIds(line);
    return !targets.length || ids.every((id) => targets.includes(id));
  }).join('\n').slice(-4000);
  return [goal, notes].filter(Boolean).join('\n');
};

// A local model can be temporarily unavailable while it is starting or being
// upgraded. The controlled fallback must still acknowledge the actual request;
// a single generic sentence makes a healthy-looking Agent appear unresponsive.
export const buildConversationFallback = ({ input, priorContext, hasAttachments }) => {
  const request = String(input || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 180) || '这项诉求';
  const contextHint = priorContext ? '我会把它与当前会话中已明确的目标衔接起来，但不会把历史内容当作新的授权。' : '';
  const attachmentHint = hasAttachments ? '已收到附件；如需据此读取企业数据或触发流程，我会先说明范围并等待确认。' : '';
  if (/[？?]|(?:怎么|如何|为什么|能否|是否|是什么|哪些)/u.test(request)) {
    return `我理解你在问“${request}”。我可以先基于通用业务方法帮你拆解问题、列出判断依据和下一步；如需结合企业数据分析，我会先说明要访问的系统与数据范围。${contextHint}${attachmentHint}`;
  }
  return `我已收到“${request}”。在不读取企业数据、不创建业务动作的前提下，我可以先帮你梳理目标、约束和可选方案；涉及查询、任务创建或审批时，会逐步展示权限范围并等待你的确认。${contextHint}${attachmentHint}`;
};

// 会话材料并入回答时使用的键名（供 traceResponse 复用）。
export const conversationMaterialKey = conversationMaterial;
export const conversationDocumentsKey = conversationDocuments;

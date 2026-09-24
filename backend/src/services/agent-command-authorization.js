// 业务写入意图识别与命令授权裁决。
//
// 从 private-agent-service 抽出的独立关注点：判断用户是否表达了「创建/发起」业务动作，
// 并解析候选角色能否拥有可执行的 Agent Run 与命令上下文。
//
// 安全边界（不可放宽）：
// - 出现业务主题（如“采购”）不等于授权创建对应申请；
// - 候选角色必须同时具备 prompt 与 command 权限，且授权决策为 ALLOW_BY_POLICY；
// - 工作流定义限制角色时不得放宽。

import { authorizeZhiNaoTask } from './zhinao-authorization-service.js';
import { evaluateBusinessAction } from './business-control-service.js';
import { getDemoCoreBindingsForAction } from './core-meta-object-service.js';
import { getWorkflowDefinitions } from './agent-workflow-service.js';
import { hasButtonPermission } from './access-control-service.js';

// 仅出现“采购”是一个主题，不是授权创建采购申请的意图。
export const procurementActionIntentPattern = /(?:请|帮我|需要|我要|发起|创建|生成|准备).{0,18}(?:采购|购买|订购|下单|补货)|(?:采购|购买|订购|下单|补货).{0,18}(?:申请|需求|计划|协同|下单|发起|创建|生成)/i;
export const workflowWriteIntentPattern = /(?:创建|发起|提交|生成|登记|开立).{0,18}(?:草稿|调查|响应|复核|工单|流程|事项)|\b(?:create|launch|submit|open)\b.{0,24}\b(?:draft|investigation|response|review|workflow|case)\b/i;
const discussesWriteOnly = (input) => /不要|不用|别(?:再|帮我)?|禁止|暂不|不需要|无需|怎么|如何|能否|是否|为什么|吗[？?]?|\b(?:do not|don't|never|how|whether)\b/i.test(input);

export const workflowCommandBySkill = {
  production_risk_analysis: 'create_quality_investigation',
  market_complaint_insight: 'create_market_response_draft',
  internal_budget_review: 'create_budget_review_draft'
};

// 可执行 Agent Run 必须具备的两项权限：发起对话与确认命令。
// 导出供审计用途（拒绝原因需如实列出所缺权限）。
export const AGENT_PROMPT_PERMISSION = 'agent.prompt.run';
export const AGENT_COMMAND_PERMISSION = 'agent.command.execute';

// 判断输入是否表达了业务写入意图（用于区分“讨论采购”与“创建采购申请”）。
export const hasBusinessWriteIntent = (input) => {
  const text = String(input || '');
  if (discussesWriteOnly(text)) return false;
  return procurementActionIntentPattern.test(text) || workflowWriteIntentPattern.test(text);
};

export const canOwnExecutableAgentRun = (role) => Boolean(
  role?.id
  && hasButtonPermission(role.id, AGENT_PROMPT_PERMISSION)
  && hasButtonPermission(role.id, AGENT_COMMAND_PERMISSION)
);

export const commandContextForRole = ({ candidateRole, command, route, isProcurement, fallbackAuthorization }) => {
  if (!canOwnExecutableAgentRun(candidateRole)) return null;
  const candidateAuthorization = candidateRole.id === fallbackAuthorization?.user?.id
    ? fallbackAuthorization
    : authorizeZhiNaoTask({ role: candidateRole, route, isProcurement });
  if (candidateAuthorization.decision !== 'ALLOW_BY_POLICY') return null;
  const definition = getWorkflowDefinitions()[command.id];
  if (definition && !definition.roles.includes(candidateRole.id)) return null;
  const coreBindings = command.control?.coreObjectValidation?.bindings || getDemoCoreBindingsForAction(command.id);
  const businessControl = evaluateBusinessAction({
    role: candidateRole,
    zhiNaoGrant: candidateAuthorization,
    action: command.id,
    coreBindings
  });
  return businessControl.allowed
    ? { role: candidateRole, authorization: candidateAuthorization, businessControl }
    : null;
};

// 生命周期状态标签：统一表达“是否已请求数据访问 / 业务写入”。
export const lifecycle = (state, label, { dataAccess = 'not_requested', businessWrite = 'not_requested' } = {}) => ({
  state,
  label,
  dataAccess,
  businessWrite
});

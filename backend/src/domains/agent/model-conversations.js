import { getEffectiveAccess } from '../../services/access-control-service.js';
import { runWithIAMStoreContext } from '../../services/iam-store.js';
import { createAgentConversation, getAgentConversationContext, recordAgentConversationExchange } from '../../services/agent-conversation-service.js';
import { validAgentModelBinding, agentModelBindingsMatch } from '../../services/agent-model-binding.js';
import { inspectModelPromptSafety } from '../../services/local-model-gateway.js';
import { normalizeUntrustedText } from '../../services/prompt-security-service.js';

const rejected = (code, status = 409, uncertain = false) => ({ error: '结构会话未完成，请核对身份、模型版本与会话；不会回退到默认模型或执行业务操作。', code, status,
  ...(uncertain ? { conversationMayHaveCommitted: true } : {}) });
const access = identity => runWithIAMStoreContext(() => getEffectiveAccess(null, identity), identity?.tenantId);
const admitted = value => value?.principalResolved && value.pagePermissionIds.includes('page.agent.view') && value.buttonPermissionIds.includes('agent.prompt.run');
const bindingFor = model => ({ schemaVersion: 'agent-model-binding.v1', mode: 'published_schema_only', modelId: model.modelId, version: model.version, fingerprint: model.fingerprint });
const equivalent = (left, right) => left?.model && right?.model && JSON.stringify(left.model) === JSON.stringify(right.model);
const boundedAnswer = answer => {
  if (answer.length <= 7200 && normalizeUntrustedText(answer).length <= 7200) return answer;
  const lines = []; let size = 0;
  for (const line of answer.split('\n')) { const cost = Math.max(line.length, normalizeUntrustedText(line).length); if (size + cost + 1 > 7000) break; lines.push(line); size += cost + 1; }
  return `${lines.join('\n')}\n本次说明受长度预算限制，未展示部分请回到已发布结构图查看，不代表不存在。`;
};

// Trusted internal composition, never caller-supplied readers or interpreters.
// Schema answers are rendered from exact published graph rows, not fabricated
// free-form model output. This bounded consultation is not business execution.
export function createModelConversationOperations(readDefinition) {
  return {
    async createConversation({ identityScope: suppliedIdentity, modelId, body: suppliedBody } = {}) {
      let created = false;
      try {
        const identityScope = structuredClone(suppliedIdentity); const body = structuredClone(suppliedBody);
        if (!body || Array.isArray(body) || Object.keys(body).some(key => !['confirmed', 'expectedVersion', 'expectedFingerprint'].includes(key)) || body.confirmed !== true
          || typeof body.expectedVersion !== 'string' || body.expectedVersion.length > 120 || typeof body.expectedFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(body.expectedFingerprint)) return rejected('AGENT_MODEL_CONVERSATION_INPUT_INVALID', 400);
        const before = await access(identityScope); if (!admitted(before)) return rejected('AGENT_MODEL_FORBIDDEN', 403);
        const definition = await readDefinition({ identityScope, modelId }); if (definition.error) return definition;
        if (definition.model.version !== body.expectedVersion || definition.model.fingerprint !== body.expectedFingerprint) return rejected('AGENT_MODEL_VERSION_CHANGED');
        created = true;
        const result = await createAgentConversation({ identityScope, roleId: before.primaryRoleId, accessContext: before, title: `${definition.model.label} · 结构咨询`, modelBinding: bindingFor(definition.model) });
        if (result.error) return { ...result, status: 409 };
        const current = await readDefinition({ identityScope, modelId }); const after = await access(identityScope);
        if (!equivalent(definition, current) || !admitted(after) || JSON.stringify(after) !== JSON.stringify(before)) return rejected('AGENT_MODEL_CONVERSATION_AUTHORITY_CHANGED', 409, true);
        return { conversation: result, contentScope: 'model_bound_schema_conversation', runtimeReadEnabled: false };
      } catch { return rejected('AGENT_MODEL_CONVERSATION_UNAVAILABLE', 409, created); }
    },
    async answerConversation({ identityScope: suppliedIdentity, input: suppliedInput } = {}) {
      let written = false;
      try {
        const identityScope = structuredClone(suppliedIdentity); const input = structuredClone(suppliedInput);
        if (!input || Array.isArray(input) || Object.keys(input).some(key => !['text', 'conversationId', 'attachments'].includes(key))
          || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000 || typeof input.conversationId !== 'string'
          || !/^conversation-[a-f0-9-]{36}$/u.test(input.conversationId) || input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length)) return rejected('AGENT_MODEL_MESSAGE_INVALID', 400);
        const before = await access(identityScope); if (!admitted(before)) return rejected('AGENT_MODEL_FORBIDDEN', 403);
        const context = await getAgentConversationContext(input.conversationId, identityScope, before);
        if (!context || !validAgentModelBinding(context.modelBinding)) return rejected('AGENT_MODEL_CONVERSATION_NOT_FOUND', 404);
        const definition = await readDefinition({ identityScope, modelId: context.modelBinding.modelId }); if (definition.error) return definition;
        if (!agentModelBindingsMatch(context.modelBinding, bindingFor(definition.model))) return rejected('AGENT_MODEL_VERSION_CHANGED');
        const model = definition.model; const query = input.text.trim();
        let objectIds = []; let answer; let phase = 'schema_explained';
        const boundary = `当前仅解释“${model.label}”已发布版本 ${model.version} 的结构，不读取业务记录、不修改、审批或发布。`;
        const unsafe = !inspectModelPromptSafety(query).safe;
        const selectionText = query.replace(/^.*(?:而是|改为|改成|换成|只看|只解释)/u, '').replace(/^不是.+?[，,]?是/u, '');
        const businessText = /只看|只解释/u.test(query) ? selectionText : query;
        const business = /(?:执行|发布|审批|批准|删除|修改|更新|新增|创建|下单|发货|退款|导出|生成文件|实时|最新|实际|明细|余额|金额|销售额)|(?:多少|数量)(?!.*(?:对象|关系|字段))|\b(?:execute|publish|approve|delete|remove|modify|update|create|refund|export|actual|latest|balance|amount)\b/iu.test(businessText)
          || /(?:字段|主键|关系).*(?:改成|改为|换成)/u.test(query);
        const schema = /模型|对象|字段|主键|关系|关联|来源|系统|结构|解释|这个|它|继续|这些/u.test(query);
        if (unsafe || business) { phase = 'schema_scope_only'; answer = `${boundary}\n此请求超出结构咨询范围，请在普通业务任务中使用已经授权的业务模型处理；这里不会回退查询或执行。`; }
        else {
          const mentionsId = node => new RegExp(`(^|[^A-Za-z0-9_])${node.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}([^A-Za-z0-9_]|$)`, 'iu').test(selectionText);
          let matches = model.graph.nodes.filter(node => mentionsId(node) || selectionText.includes(node.label));
          if (!matches.length && /这个|它|继续|这些/u.test(query)) matches = model.graph.nodes.filter(node => context.modelObjectIds?.includes(node.id));
          const ambiguous = matches.some(node => model.graph.nodes.some(other => other.id !== node.id && other.label === node.label && selectionText.includes(node.label) && !mentionsId(node)))
            || /不是|不要|不看/u.test(query) && selectionText === query;
          if (ambiguous || matches.length > 3) { phase = 'schema_selection_required'; answer = `${boundary}\n对象范围不唯一，请提供一个稳定对象编码，最多同时解释三个对象。`; }
          else if (matches.length) {
            objectIds = matches.map(node => node.id);
            answer = `${boundary}\n${matches.map(node => {
              const relations = model.graph.edges.filter(edge => edge.from === node.id || edge.to === node.id);
              const limit = /关系|关联|来源|系统/u.test(query) ? 20 : 8;
              return `${node.label}（${node.id}）：主键 ${node.key}；来源 ${node.sourceSystems.join('、') || '未标注'}；${node.fields.length} 个字段：${node.fields.join('、')}。\n${relations.length ? relations.slice(0, limit).map(edge => `${edge.from} —${edge.predicate}→ ${edge.to}${edge.cardinality ? `（${edge.cardinality}）` : ''}`).join('\n') : '当前发布结构未声明该对象的关系。'}${relations.length > limit ? `\n本次显示前${limit}/${relations.length}条关系，可在结构图继续查看。` : ''}`;
            }).join('\n\n')}`;
          } else if (schema || /你好|帮助|能做什么/u.test(query)) answer = `${boundary}\n模型包含 ${model.nodeCount} 个对象、${model.relationshipCount} 条关系。可指定对象编码询问字段、主键或系统关系，例如：${model.graph.nodes.slice(0, 8).map(node => `${node.label}（${node.id}）`).join('、')}。`;
          else { phase = 'schema_selection_required'; answer = `${boundary}\n没有定位到明确对象。请给出对象名称或编码，或问“解释这个模型的结构”。`; }
        }
        const renderedAnswer = boundedAnswer(answer);
        const response = { text: renderedAnswer, modelBinding: context.modelBinding, schemaObjectIds: objectIds,
          agent: { name: '智脑结构咨询', runtime: { mode: 'deterministic_schema', model: 'published-definition', provider: 'none' } },
          evidence: [], plan: [], command: null, task: { phase, status: 'active', writeRequested: false },
          schemaEvidence: { modelId: model.modelId, version: model.version, fingerprint: model.fingerprint, objectIds, authority: model.authority, truncated: renderedAnswer !== answer } };
        const current = await readDefinition({ identityScope, modelId: model.modelId }); const after = await access(identityScope);
        if (!equivalent(definition, current) || !admitted(after) || JSON.stringify(after) !== JSON.stringify(before)) return rejected('AGENT_MODEL_CONVERSATION_AUTHORITY_CHANGED');
        written = true;
        const conversation = await recordAgentConversationExchange({ conversationId: input.conversationId, identityScope, roleId: after.primaryRoleId, accessContext: after,
          expectedModelRevision: context.modelConversationRevision, userText: query, response });
        if (!conversation) return rejected('AGENT_MODEL_CONVERSATION_CHANGED');
        const finalDefinition = await readDefinition({ identityScope, modelId: model.modelId }); const finalAccess = await access(identityScope);
        if (!equivalent(definition, finalDefinition) || !admitted(finalAccess) || JSON.stringify(finalAccess) !== JSON.stringify(before)) return rejected('AGENT_MODEL_CONVERSATION_AUTHORITY_CHANGED', 409, true);
        return { ...response, conversation, contextUsage: conversation.context };
      } catch { return rejected('AGENT_MODEL_CONVERSATION_UNAVAILABLE', 409, written); }
    }
  };
}

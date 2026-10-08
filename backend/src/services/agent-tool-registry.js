import { getDashboard, getWorldModel } from './risk-service.js';
import { approveProcurement, getProcurementScenario, launchProcurement } from './procurement-service.js';
import { executeDomainAnalysis } from './domain-analysis-service.js';
import { createWorkflowDraft } from './agent-workflow-service.js';
import { canZhiNaoUseTool } from './zhinao-authorization-service.js';
import { requestKeyLease } from './key-center/key-center-service.js';
import { MAX_QUERY_BUSINESS_IDS, validateAgentReadInput } from './agent-query-service.js';

const keyLeaseRequirement = {
  launch_procurement: { connectorId: 'mcp-erp', operation: 'create_procurement_draft', purpose: '创建受控 ERP 采购草稿' },
  approve_procurement: { connectorId: 'mcp-erp', operation: 'approve_procurement', purpose: '提交已审批 ERP 采购申请' }
};

const emptyInputSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({}),
  required: Object.freeze([]),
  additionalProperties: false
});
const defineTool = (definition) => Object.freeze({
  ...definition,
  domain: definition.scope.split(':')[0],
  inputSchema: ['analyze_production_impact', 'analyze_market_impact', 'review_internal_operations', 'read_workflow_context'].includes(definition.id)
    ? Object.freeze({ type: 'object', properties: Object.freeze({ businessIds: Object.freeze({ type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: MAX_QUERY_BUSINESS_IDS, uniqueItems: true }) }), required: [], additionalProperties: false })
    : emptyInputSchema
});

const tools = Object.freeze([
  defineTool({ id: 'create_procurement_demand', name: '提交采购需求草稿', scope: 'procurement:request', risk: '中', mode: '草稿 + 采购路由', description: '创建采购需求草稿并路由采购负责人；不创建 ERP 采购申请。' }),
  defineTool({ id: 'create_quality_investigation', name: '创建质量调查草稿', scope: 'quality:investigate', risk: '高', mode: '草稿 + 审批', description: '创建质量异常调查工作项，等待质量与生产审批。' }),
  defineTool({ id: 'create_market_response_draft', name: '创建市场处置草稿', scope: 'market:response', risk: '中', mode: '草稿 + 审批', description: '创建渠道投诉处置草稿，不直接发送客户沟通。' }),
  defineTool({ id: 'create_budget_review_draft', name: '创建预算核验草稿', scope: 'internal:budget', risk: '中', mode: '草稿 + 审批', description: '创建预算与供应商核验草稿，等待财务与采购审批。' }),
  defineTool({ id: 'analyze_production_impact', name: '生产影响分析', scope: 'production:analyze', risk: '低', mode: '只读推演', description: '分析原料、生产批、检验、库存和排产之间的受控影响关系。' }),
  defineTool({ id: 'analyze_market_impact', name: '市场影响分析', scope: 'market:analyze', risk: '低', mode: '只读推演', description: '分析渠道、订单、投诉、SKU 和需求变化的脱敏经营影响。' }),
  defineTool({ id: 'review_internal_operations', name: '内务协同检查', scope: 'internal:review', risk: '低', mode: '只读核验', description: '核验供应商、预算、合同与审批状态，不执行任何写入。' }),
  defineTool({ id: 'read_workflow_context', name: '读取流程语义上下文', scope: 'workflow:read', risk: '低', mode: '只读', description: '读取已发布流程定义、实例状态和当前审批节点；不执行审批、提交、撤回或催办。' }),
  defineTool({ id: 'read_world_context', name: '读取受控世界模型上下文', scope: 'world:read', risk: '低', mode: '只读', description: '查询当前用户可见的对象、关系、状态与证据。' }),
  defineTool({ id: 'read_operating_status', name: '查询企业运行状态', scope: 'risk:read', risk: '低', mode: '只读', description: '读取风险、监控、系统状态和通知摘要。' }),
  defineTool({ id: 'prepare_procurement', name: '生成原料采购协同方案', scope: 'procurement:prepare', risk: '中', mode: '计划', description: '核算需求、库存、质量、供应商与预算，生成不可写入的方案。' }),
  defineTool({ id: 'launch_procurement', name: '发起采购协同', scope: 'procurement:launch', risk: '高', mode: '写入草稿 + 审批', description: '创建 ERP 草稿采购申请，并发起采购、质量、财务审批。' }),
  defineTool({ id: 'approve_procurement', name: '批准采购协同', scope: 'procurement:approve', risk: '高', mode: '受控写入', description: '审批通过后提交 ERP 采购申请，并触发通知与审计回写。' })
]);

export function getRegisteredTools() { return tools; }

export function validateToolInvocation(toolId, input = {}) {
  const tool = tools.find((candidate) => candidate.id === toolId);
  if (!tool) return { valid: false, code: 'AGENT_TOOL_NOT_REGISTERED', error: '工具未在服务端允许列表中注册。' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, code: 'AGENT_TOOL_INPUT_INVALID', error: '工具参数必须是对象。' };
  const unexpected = Object.keys(input).filter((key) => !Object.hasOwn(tool.inputSchema.properties, key));
  if (unexpected.length) return { valid: false, code: 'AGENT_TOOL_INPUT_ADDITIONAL_PROPERTY', error: `工具参数包含未授权字段：${unexpected.join('、')}` };
  if (Object.hasOwn(tool.inputSchema.properties, 'businessIds') && !validateAgentReadInput(input)) return { valid: false, code: 'AGENT_TOOL_INPUT_INVALID', error: '业务编号必须是最多 10 个不重复的完整大写编号，不能指定身份或扩大数据范围。' };
  return { valid: true, tool };
}

export async function buildPreflightContext(roleId) {
  const [scenario, dashboard] = await Promise.all([getProcurementScenario(), getDashboard(roleId)]);
  return { scenario, dashboard, world: getWorldModel(roleId), evidenceCount: 8 };
}

export async function executeTool(toolId, role, runId, grant, businessControl, identityScope, input = {}, targetBinding = null) {
  const validation = validateToolInvocation(toolId, input);
  if (!validation.valid) return { error: validation.error, code: validation.code };
  if (!canZhiNaoUseTool(grant, toolId, { workflow: true })) return { error: '智脑当前未获得该工作流的短时授权。请检查用户角色、智脑权限主体和流程策略。' };
  if (!businessControl?.allowed) return { error: businessControl?.reason || '当前用户未获得该业务条线权限，智脑不会发起该业务流程。' };
  const leaseRequirement = keyLeaseRequirement[toolId];
  const leaseResult = leaseRequirement ? await requestKeyLease({ ...leaseRequirement, role, authorization: grant, taskId: runId, ttlSeconds: 90 }) : null;
  if (leaseResult?.error) return leaseResult;
  if (toolId === 'launch_procurement') return { ...await launchProcurement(role, businessControl.coreObjectValidation.bindings, identityScope), keyLease: leaseResult?.lease || null };
  if (toolId === 'approve_procurement') return { ...await approveProcurement(role, businessControl.coreObjectValidation.bindings, identityScope), keyLease: leaseResult?.lease || null };
  if (toolId.startsWith('create_')) return createWorkflowDraft(toolId, role, runId, identityScope, targetBinding);
  return { error: '工具不可执行或不存在。' };
}

export async function executeReadOnlyTool(toolId, role, grant, identityScope = null, input = {}, controlledContext = {}) {
  if (!canZhiNaoUseTool(grant, toolId)) return null;
  if (!validateToolInvocation(toolId, input).valid) return null;
  return executeDomainAnalysis(toolId, role.id, identityScope, input, controlledContext);
}

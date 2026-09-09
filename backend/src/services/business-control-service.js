import { evaluateCoreObjectAction } from './core-meta-object-service.js';

const capabilities = {
  'procurement:request': { name: '采购需求提交', description: '创建受控采购需求草稿并路由采购条线，不创建 ERP 采购申请。', risk: 'medium' },
  'procurement:initiate': { name: '采购流程发起', description: '创建 ERP 采购申请草稿并发起采购、质量、财务审批。', risk: 'high' },
  'procurement:approve': { name: '采购审批', description: '在既定审批节点批准采购协同。', risk: 'high' },
  'quality:investigate': { name: '质量异常调查', description: '创建质量异常调查草稿。', risk: 'high' },
  'market:response': { name: '市场处置发起', description: '创建市场投诉处置草稿。', risk: 'medium' },
  'internal:budget-review': { name: '预算核验发起', description: '创建预算与供应商核验草稿。', risk: 'medium' }
};

const roleCapabilities = {
  executive: ['procurement:initiate', 'procurement:approve', 'quality:investigate', 'market:response', 'internal:budget-review'],
  quality_manager: ['quality:investigate'],
  production_manager: ['procurement:request', 'quality:investigate'],
  procurement_manager: ['procurement:request', 'procurement:initiate'],
  marketing_manager: ['market:response']
};

const actionRequirements = {
  create_procurement_demand: { capability: 'procurement:request', agentWorkflow: 'create_procurement_demand', label: '提交采购需求' },
  launch_procurement: { capability: 'procurement:initiate', agentWorkflow: 'launch_procurement', label: '发起采购流程' },
  approve_procurement: { capability: 'procurement:approve', agentWorkflow: 'approve_procurement', label: '审批采购流程' },
  create_quality_investigation: { capability: 'quality:investigate', agentWorkflow: 'create_quality_investigation', label: '创建质量调查' },
  create_market_response_draft: { capability: 'market:response', agentWorkflow: 'create_market_response_draft', label: '创建市场处置' },
  create_budget_review_draft: { capability: 'internal:budget-review', agentWorkflow: 'create_budget_review_draft', label: '创建预算核验' }
};

export function getBusinessAccessProfile(roleId) {
  const grants = roleCapabilities[roleId] || [];
  return {
    roleId,
    grants: grants.map((id) => ({ id, ...capabilities[id] })),
    policy: '业务动作必须先通过条线能力校验，再通过智脑工作流权限、用户确认与审批校验。'
  };
}

export function evaluateBusinessAction({ role, zhiNaoGrant, action, coreBindings = [] }) {
  const requirement = actionRequirements[action];
  if (!requirement) return { allowed: false, action, reason: '未知业务动作，默认拒绝。' };
  const userCapabilities = roleCapabilities[role.id] || [];
  const hasUserCapability = userCapabilities.includes(requirement.capability);
  const hasZhiNaoWorkflow = zhiNaoGrant?.allowedWorkflowTools?.includes(requirement.agentWorkflow);
  const coreObjectValidation = evaluateCoreObjectAction(action, coreBindings);
  const decision = hasUserCapability && hasZhiNaoWorkflow && coreObjectValidation.status === 'passed';
  return {
    allowed: decision,
    action,
    label: requirement.label,
    requiredCapability: requirement.capability,
    capability: capabilities[requirement.capability],
    userCapabilities,
    hasUserCapability,
    hasZhiNaoWorkflow,
    coreObjectValidation,
    reason: decision
      ? '已通过业务条线能力、智脑工作流和核心元对象联合校验；仍需用户确认和后续审批。'
      : !hasUserCapability
        ? `当前角色缺少“${capabilities[requirement.capability].name}”权限，智脑不会发起该业务流程。`
        : !hasZhiNaoWorkflow
          ? '智脑当前未获得该工作流的短时授权，无法发起该业务流程。'
          : `业务动作缺少核心元对象：${coreObjectValidation.missing.join('、')}。`
  };
}

export function getBusinessActionRequirement(action) {
  return actionRequirements[action] ? { ...actionRequirements[action], capability: capabilities[actionRequirements[action].capability] } : null;
}

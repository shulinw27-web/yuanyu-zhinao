const principal = {
  id: 'zhinao-health-ops-001',
  name: '智脑',
  type: 'service_principal',
  credential: 'kms://health-prod/agent/zhinao-runtime',
  defaultDeny: true,
  description: '智脑自身不拥有业务数据的永久访问权；每次任务由策略中心发放与用户、设备、领域和工作流绑定的短时授权。'
};

const domainPolicies = {
  production: {
    name: '生产质量域',
    users: ['executive', 'quality_manager', 'production_manager', 'procurement_manager'],
    objects: ['ProductionBatch', 'RawMaterialBatch', 'Inventory', 'Deviation'],
    readTools: ['read_world_context', 'read_operating_status', 'analyze_production_impact'],
    workflowTools: ['create_procurement_demand', 'create_quality_investigation', 'prepare_procurement', 'launch_procurement']
  },
  marketing: {
    name: '市场运营域',
    users: ['executive', 'marketing_manager'],
    objects: ['Store', 'Order', 'Channel', 'Complaint', 'DemandSignal'],
    readTools: ['read_world_context', 'read_operating_status', 'analyze_market_impact'],
    workflowTools: ['create_market_response_draft', 'create_store_operation_task', 'create_store_replenishment_draft']
  },
  internal: {
    name: '内务协同域',
    users: ['executive', 'quality_manager'],
    objects: ['Supplier', 'Budget', 'Contract', 'ApprovalCase'],
    readTools: ['read_world_context', 'review_internal_operations'],
    workflowTools: ['create_budget_review_draft']
  }
};

const unique = (items) => [...new Set(items)];

export function getZhiNaoPrincipal() {
  return structuredClone(principal);
}

export function getZhiNaoAuthorizationProfile(roleId) {
  const domains = Object.entries(domainPolicies)
    .filter(([, policy]) => policy.users.includes(roleId))
    .map(([id, policy]) => ({ id, name: policy.name, objects: policy.objects, workflows: policy.workflowTools }));
  return {
    principal: getZhiNaoPrincipal(),
    roleId,
    allowedDomains: domains,
    decision: domains.length ? 'ALLOW_BY_POLICY' : 'DENY_BY_DEFAULT',
    note: '有效权限 = 用户角色权限 ∩ 智脑服务主体权限 ∩ 当前设备会话策略 ∩ 数据分级与工作流策略。'
  };
}

export function authorizeZhiNaoTask({ role, route, isProcurement = false }) {
  const requestedDomains = unique(route.subAgents.map((agent) => agent.id));
  const grantedDomains = requestedDomains.filter((domain) => domainPolicies[domain]?.users.includes(role.id));
  const deniedDomains = requestedDomains.filter((domain) => !grantedDomains.includes(domain));
  const allowedTools = unique(grantedDomains.flatMap((domain) => domainPolicies[domain].readTools));
  const allowedWorkflowTools = unique(grantedDomains.flatMap((domain) => domainPolicies[domain].workflowTools));

  if (isProcurement && !grantedDomains.includes('production')) {
    const index = allowedWorkflowTools.indexOf('launch_procurement');
    if (index >= 0) allowedWorkflowTools.splice(index, 1);
  }

  return {
    principal: getZhiNaoPrincipal(),
    user: { id: role.id, name: role.name, scopes: role.scopes || [] },
    requestedDomains,
    grantedDomains,
    deniedDomains,
    allowedTools,
    allowedWorkflowTools,
    dataBoundary: grantedDomains.flatMap((domain) => domainPolicies[domain].objects),
    decision: grantedDomains.length ? 'ALLOW_BY_POLICY' : 'DENY_BY_DEFAULT',
    expiresInSeconds: 300,
    auditReason: '用户角色、智脑服务主体、领域策略、数据分级和工作流权限取交集后生成本次短时授权。'
  };
}

export function canZhiNaoUseTool(grant, toolId, { workflow = false } = {}) {
  if (!grant || grant.decision !== 'ALLOW_BY_POLICY') return false;
  const tools = workflow ? grant.allowedWorkflowTools : grant.allowedTools;
  return tools.includes(toolId);
}

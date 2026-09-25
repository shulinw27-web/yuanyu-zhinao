import { readState } from '../repositories/runtime-state-repository.js';
import { mutateWithDomainEvent } from '../infrastructure/domain-events/domain-event-outbox.js';
import { verifyQualityDraftTarget } from './agent-target-binding-service.js';

const NAMESPACE = 'agent_workflow';
const WORKSPACE_KEY = 'workspace';
const initialWorkspace = () => ({ sequence: 0, workItems: [] });
const workspace = () => readState(NAMESPACE, WORKSPACE_KEY, initialWorkspace);

const normalizeRoleIds = (roleId) => [...new Set((Array.isArray(roleId) ? roleId : [roleId])
  .filter((item) => typeof item === 'string' && item.trim())
  .map((item) => item.trim()))];
const normalizeIdentityScope = (identityScope = {}) => ({
  tenantId: identityScope.tenantId ? String(identityScope.tenantId).slice(0, 120) : null,
  subjectId: identityScope.subjectId ? String(identityScope.subjectId).slice(0, 180) : null
});
const publicWorkItem = ({ tenantId: _tenantId, subjectId: _subjectId, ...item }) => structuredClone(item);

const definitions = {
  create_procurement_demand: {
    prefix: 'PD', title: '采购需求草稿', roles: ['executive', 'production_manager', 'procurement_manager'], approvers: ['采购负责人'], approverRoleIds: ['procurement_manager'], risk: '中'
  },
  create_quality_investigation: {
    prefix: 'QI', title: '质量异常调查草稿', roles: ['executive', 'quality_manager', 'production_manager'], approvers: ['质量经理', '生产负责人'], approverRoleIds: ['quality_manager', 'production_manager'], risk: '高'
  },
  create_market_response_draft: {
    prefix: 'MR', title: '市场投诉处置草稿', roles: ['executive', 'marketing_manager'], approvers: ['市场负责人', '质量经理'], approverRoleIds: ['marketing_manager', 'quality_manager'], risk: '中'
  },
  create_budget_review_draft: {
    prefix: 'BR', title: '预算与供应商核验草稿', roles: ['executive', 'quality_manager'], approvers: ['财务负责人', '采购负责人'], approverRoleIds: ['executive'], risk: '中'
  }
};

export function getWorkflowDefinitions() { return definitions; }

export function createWorkflowDraft(commandId, role, runId, suppliedIdentityScope, targetBinding = null) {
  if (!targetBinding) return persistWorkflowDraft(commandId, role, runId, suppliedIdentityScope);
  if (commandId !== 'create_quality_investigation') return { error: '该工具不支持对象绑定。', code: 'AGENT_WRITE_TARGET_UNSUPPORTED' };
  return verifyQualityDraftTarget(targetBinding, role.id, suppliedIdentityScope).then((valid) => valid
    ? persistWorkflowDraft(commandId, role, runId, suppliedIdentityScope, targetBinding)
    : { error: '目标已变化、不可访问或不支持该动作，请重新查询并确认。', code: 'AGENT_WRITE_TARGET_CHANGED' });
}

function persistWorkflowDraft(commandId, role, runId, suppliedIdentityScope, targetBinding = null) {
  const definition = definitions[commandId];
  if (!definition) return { error: '未知的受控工作流。' };
  if (!definition.roles.includes(role.id)) return { error: '当前角色无权创建该工作流草稿。' };
  const identityScope = normalizeIdentityScope(suppliedIdentityScope);
  if (!identityScope.tenantId || !identityScope.subjectId) return { error: '缺少可验证的租户或用户身份，不能创建工作流草稿。' };

  return mutateWithDomainEvent({ namespace: NAMESPACE, key: WORKSPACE_KEY, initialValue: initialWorkspace, mutation: (state) => {
    state.sequence += 1;
    const createdAt = new Date().toISOString();
    const item = {
      id: `${definition.prefix}-${new Date().getFullYear()}-${String(state.sequence).padStart(4, '0')}`,
      commandId, runId, roleId: role.id, title: definition.title, risk: definition.risk,
      ...(targetBinding ? { targetBinding: structuredClone(targetBinding) } : {}),
      ...identityScope,
      status: 'awaiting_approval', owner: role.name, approvers: definition.approvers, approverRoleIds: definition.approverRoleIds, createdAt,
      audit: [{ actor: role.name, action: 'Agent 创建受控草稿', time: createdAt }]
    };
    state.workItems.unshift(item);
    state.workItems = state.workItems.slice(0, 500);
    const result = { execution: { id: item.id, requisitionId: item.id, status: item.status, title: item.title }, workItem: publicWorkItem(item) };
    return {
      value: state,
      result,
      event: {
        type: 'agent.workflow.draft_created', version: 1, aggregateType: 'AgentWorkItem', aggregateId: item.id,
        tenantId: identityScope.tenantId, correlationId: runId, actor: { type: 'agent_role', id: role.id, name: role.name },
        payload: { workItemId: item.id, commandId, runId, status: item.status, risk: item.risk }
      }
    };
  }});
}

export function getAgentWorkItems(roleId, suppliedIdentityScope) {
  const roleIds = normalizeRoleIds(roleId);
  const identityScope = normalizeIdentityScope(suppliedIdentityScope);
  if (!roleIds.length || !identityScope.tenantId || !identityScope.subjectId) return [];
  const effectiveRoles = new Set(roleIds);
  return workspace().workItems
    .filter((item) => item.tenantId === identityScope.tenantId && item.subjectId === identityScope.subjectId)
    .filter((item) => effectiveRoles.has('executive') || effectiveRoles.has(item.roleId) || item.approverRoleIds?.some((approverRoleId) => effectiveRoles.has(approverRoleId)))
    .slice(0, 20)
    .map(publicWorkItem);
}

export function getWorkflowMetrics(roleId, identityScope) {
  const visible = getAgentWorkItems(roleId, identityScope);
  return {
    total: visible.length,
    awaitingApproval: visible.filter((item) => item.status === 'awaiting_approval').length,
    byRisk: ['高', '中'].map((risk) => ({ risk, count: visible.filter((item) => item.risk === risk).length }))
  };
}

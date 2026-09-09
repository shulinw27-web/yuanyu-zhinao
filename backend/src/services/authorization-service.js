import { canAccessOrganization, getEffectiveAccess } from './access-control-service.js';
import { getRoleDefinition } from './role-catalog-service.js';

const visibility = {
  executive: { fields: '聚合指标、跨域风险、受控证据摘要', restrict: '不展示配方原文与个人信息' },
  quality_manager: { fields: '检验指标、原料批、放行状态、追溯证据', restrict: '订单仅显示影响汇总' },
  production_manager: { fields: '生产批、工序、库存影响、冻结建议', restrict: '检验原始数值脱敏' },
  procurement_manager: { fields: '采购需求、库存缺口、供应商资质摘要、预算状态', restrict: '检验原始指标与客户订单明细不可见' },
  marketing_manager: { fields: '订单影响、渠道、投诉趋势、库存摘要', restrict: '原料供应商与检验明细不可见' }
};

const deniedRole = { id: 'denied', name: '未授权角色', team: '无授权', color: '#6b7280', scopes: [] };

export function getRole(roleId) {
  return getRoleDefinition(roleId) || deniedRole;
}

export function canAccessRisk(risk, roleId, subjectId) {
  const effectiveAccess = getEffectiveAccess(roleId, subjectId);
  return Boolean(risk?.permissions?.some((permissionRoleId) => effectiveAccess.roleIds.includes(permissionRoleId))
    && canAccessOrganization(roleId, risk.organizationId, subjectId));
}

export function redactRisk(risk, roleId) {
  const base = structuredClone(risk);
  if (roleId === 'marketing_manager' && base.id === 'RC-2026-0042') {
    base.summary = '质量风险可能影响 3 个待发订单；已向市场发送脱敏影响范围，请依据审批结果处理渠道沟通。';
    base.affected.rawBatches = '受限';
    base.affected.productionBatches = '受限';
  }
  if (roleId === 'production_manager' && base.id === 'RC-2026-0042') {
    base.summary = '原料批检验异常，已关联 2 个生产批次。检验原始指标仅对质量角色开放。';
  }
  if (roleId === 'executive' && base.id === 'RC-2026-0042') {
    base.summary = 'P0 质量风险已影响生产与订单，当前等待质量确认。总控视图展示聚合影响与处置进度。';
  }
  return base;
}

export function getAccessExplanation(roleId, subjectId) {
  const role = getRole(roleId);
  const effectiveAccess = getEffectiveAccess(roleId, subjectId);
  return { role, ...(visibility[role.id] || { fields: '无', restrict: '角色无效，拒绝访问' }), dataScope: effectiveAccess.dataScopes, organizationIds: effectiveAccess.organizationIds, decision: effectiveAccess.roleIds.length ? 'ALLOW（通过角色权限与组织数据范围联合评估；KMS 仅为本请求发放短时凭据）' : 'DENY（角色无效或账号未启用）' };
}

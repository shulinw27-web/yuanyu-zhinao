import { getDashboard, getRiskList, getWorldModel } from './risk-service.js';
import { getProcurementScenario } from './procurement-service.js';
import { matchingQueryBusinessIds } from './agent-query-service.js';
import { matchesQueryPlan } from './agent-query-plan-service.js';
import { evaluateBusinessDecision } from './business-decision-service.js';
import { getPublishedDecisionContext } from './meta-model-service.js';
import { evaluateBoundDecision } from './decision-binding-service.js';

const domainSystemIds = {
  analyze_production_impact: ['lims', 'qms', 'mes', 'wms', 'erp'],
  analyze_market_impact: ['oms', 'qms'],
  review_internal_operations: ['erp', 'qms']
};

async function analyzeSelectedObjects(toolId, roleId, identityScope, businessIds, context) {
  const evidence = (context.systemEvidence || []).filter((item) => domainSystemIds[toolId].includes(item.systemId)
    && (matchingQueryBusinessIds(item, businessIds).length || item.matchedBusinessIds?.some((id) => businessIds.includes(id))));
  const allowDemo = (!identityScope || identityScope.tenantId === 'demo-enterprise') && !context.queryPlan?.timeRange && !context.queryPlan?.version && !context.queryPlan?.asOf && (context.allowDemoFacts ?? (process.env.NODE_ENV !== 'production' && process.env.CONNECTOR_MOCK_MODE !== 'disabled'));
  if (allowDemo && toolId !== 'review_internal_operations') {
    const risks = await getRiskList(roleId, identityScope?.subjectId || null);
    for (const risk of risks) {
      if (!matchingQueryBusinessIds({ id: risk.id, title: risk.title, summary: risk.summary }, businessIds).length) continue;
      evidence.push({ source: 'RiskCase', id: risk.id, title: risk.title, statement: `状态：${risk.status}；等级：${risk.severity}；${risk.summary}`, classification: '按角色过滤的模拟风险' });
    }
  } else if (allowDemo && toolId === 'review_internal_operations') {
    const scenario = await getProcurementScenario();
    for (const supplier of scenario.suppliers) {
      if (!businessIds.includes(supplier.id.toUpperCase())) continue;
      evidence.push({ source: '供应商资质（模拟）', id: supplier.id, title: supplier.name, statement: `资质：${supplier.qualification}；参考价格：${supplier.price}；交期：${supplier.leadTime} 天；证照截止：${supplier.certificateUntil}` });
    }
  }
  const unique = evidence.filter((item) => matchesQueryPlan(item, context.queryPlan)).filter((item, index, all) => all.findIndex((other) => other.source === item.source && other.id === item.id && other.statement === item.statement && other.provenance?.objectVersion === item.provenance?.objectVersion) === index);
  const matchedBusinessIds = [...new Set(unique.flatMap((item) => [...matchingQueryBusinessIds(item, businessIds), ...(item.matchedBusinessIds || []).filter((id) => businessIds.includes(id))]))];
  return {
    summary: unique.length ? `以下是指定编号的可访问记录，不代表已完成处置：${unique.slice(0, 8).map((item) => `${item.source}/${item.id}：${item.title || ''}；${item.statement || ''}`).join('\n')}${unique.length > 8 ? '\n其余匹配记录见证据列表。' : ''}`
      : '在当前授权范围和本次数据源中未找到指定编号的匹配记录，无法判断是不存在、尚未接入还是不可访问。',
    evidence: unique,
    matchedBusinessIds
  };
}

export async function analyzeProductionImpact(roleId, identityScope = null) {
  const risks = await getRiskList(roleId, identityScope?.subjectId || null);
  const world = getWorldModel(roleId);
  const critical = risks.find((item) => item.severity === 'P0') || risks[0];
  const affected = critical?.affected || {};
  let decision = evaluateBusinessDecision('quality_disposition', { id: critical?.id, severity: critical?.severity, status: critical?.status, evidenceIds: critical ? [critical.id] : [], sourceMode: 'mock' });
  const publishedModel = await getPublishedDecisionContext('quality_disposition');
  const binding = publishedModel?.bindings.find((item) => item.objectType === 'QualityEvent' && item.inputMapping);
  if (binding && critical) {
    decision = evaluateBoundDecision({ binding, object: publishedModel.objectTypes.find((item) => item.id === binding.objectType), roleId, identityScope,
      record: { id: critical.id, objectType: 'QualityEvent', system: 'QMS', tenantId: 'demo-enterprise', organizationId: critical.organizationId,
        classification: '质量受限', version: critical.version || `demo-${critical.status}`, occurredAt: new Date().toISOString(), sourceMode: 'mock',
        payload: { id: critical.id, risk_id: critical.id, severity: critical.severity, status: critical.status } } });
    decision.reason ||= '已发布判断的字段或来源适配未通过，需校对模型，未执行业务动作。';
  }
  decision.publishedModel = publishedModel;
  const impact = [
    affected.productionBatches ? `${affected.productionBatches} 个生产批次` : null,
    affected.inventory ? `库存 ${affected.inventory}` : null,
    affected.orders ? `${affected.orders} 个待发订单` : null
  ].filter(Boolean).join('、');
  return {
    summary: critical ? `生产质量分析发现 ${critical.id}：${critical.title}。${impact ? `当前受控影响范围为 ${impact}。` : ''}${decision.reason}当前受控视图包含 ${world.nodes.length} 个业务对象，可沿批次关系继续追溯影响。本次仅分析，未创建调查或执行处置。` : '当前授权范围内未发现需要处置的生产质量风险。',
    decision,
    evidence: critical ? [{ source: 'RiskCase', id: critical.id }, { source: '世界模型关系图', id: `${world.nodes.length}-nodes` }] : [{ source: '世界模型关系图', id: `${world.nodes.length}-nodes` }]
  };
}

export async function analyzeMarketImpact(roleId, identityScope = null) {
  const dashboard = await getDashboard(roleId, identityScope?.subjectId || null);
  const complaint = dashboard.risks.find((item) => /投诉|Complaint/i.test(item.title || ''));
  return {
    summary: complaint ? `市场分析发现 ${complaint.id}：${complaint.title}。请基于受控渠道与订单影响摘要安排沟通，不展开原料或检验明细。` : `当前可见风险 ${dashboard.metrics.visibleRisks} 项，未发现需要立即处理的渠道投诉聚集事件。`,
    evidence: complaint ? [{ source: 'QMS 客诉质量事件', id: complaint.id }, { source: 'OMS 订单影响摘要', id: 'oms-order-impact' }, { source: '市场授权仪表盘', id: 'market-dashboard' }] : [{ source: '市场授权仪表盘', id: 'market-dashboard' }]
  };
}

export async function reviewInternalOperations() {
  const scenario = await getProcurementScenario();
  return {
    summary: `内务核验完成：${scenario.suppliers[0].name} 为推荐供应商；预计金额 ¥${scenario.policy.estimatedAmount.toLocaleString()}。如发起采购，系统将按采购、质量、财务路径审批。`,
    evidence: [{ source: '供应商资质', id: scenario.suppliers[0].id || 'SUP-018' }, { source: '预算策略', id: 'budget-policy' }, { source: '审批路径', id: 'approval-route' }]
  };
}

export async function executeDomainAnalysis(toolId, roleId, identityScope = null, input = {}, controlledContext = {}) {
  if (input.businessIds?.length && domainSystemIds[toolId]) return analyzeSelectedObjects(toolId, roleId, identityScope, input.businessIds, controlledContext);
  if (toolId === 'analyze_production_impact') return analyzeProductionImpact(roleId, identityScope);
  if (toolId === 'analyze_market_impact') return analyzeMarketImpact(roleId, identityScope);
  if (toolId === 'review_internal_operations') return reviewInternalOperations();
  return null;
}

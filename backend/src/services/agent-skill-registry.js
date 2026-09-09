const skills = [
  { id: 'production_risk_analysis', name: '生产质量影响分析', domain: 'production', version: '1.0.0', risk: '低', mode: '只读分析', tools: ['analyze_production_impact'], description: '针对检验异常、批次、库存和排产关系生成受控影响摘要。' },
  { id: 'market_complaint_insight', name: '市场投诉洞察', domain: 'marketing', version: '1.0.0', risk: '低', mode: '只读分析', tools: ['analyze_market_impact'], description: '针对渠道、订单、投诉和 SKU 生成脱敏经营影响摘要。' },
  { id: 'internal_budget_review', name: '内务预算与供应商核验', domain: 'internal', version: '1.0.0', risk: '低', mode: '只读核验', tools: ['review_internal_operations'], description: '核验预算、供应商资质、合同与审批路径，不执行写入。' },
  { id: 'procurement_orchestration', name: '原料采购协同', domain: 'production', version: '1.0.0', risk: '高', mode: '计划 + 审批', tools: ['analyze_production_impact', 'review_internal_operations', 'prepare_procurement', 'launch_procurement'], description: '跨生产与内务域生成采购计划；写入前必须确认并进入审批。' }
];

const evaluationSnapshots = {
  production_risk_analysis: { status: 'passed', scenarios: 18, controlCoverage: '权限、元对象、证据引用', lastRun: '2026-08-10' },
  market_complaint_insight: { status: 'passed', scenarios: 14, controlCoverage: '脱敏、产品追溯、审批路由', lastRun: '2026-08-10' },
  internal_budget_review: { status: 'passed', scenarios: 16, controlCoverage: '预算边界、供应商、审批路由', lastRun: '2026-08-10' },
  procurement_orchestration: { status: 'guarded', scenarios: 24, controlCoverage: '权限、元对象、二次确认、审批', lastRun: '2026-08-10' }
};

export function getAgentSkills() { return skills.map((skill) => ({ ...skill, evaluation: evaluationSnapshots[skill.id] })); }

export function resolveAgentSkill({ route, isProcurement }) {
  if (isProcurement) return skills.find((item) => item.id === 'procurement_orchestration');
  return skills.find((item) => item.domain === route.primaryDomain) || skills[0];
}

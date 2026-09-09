import { extractQueryBusinessIds, matchingQueryBusinessIds } from './agent-query-service.js';

const documents = [
  { id: 'SOP-QA-018', source: 'QMS 受控文件', title: '原料放行与异常升级 SOP', classification: '质量受限', roles: ['executive', 'quality_manager', 'production_manager', 'procurement_manager'], keywords: ['原料', '放行', '检验', '异常', '采购', '维生素'], excerpt: '原料在 LIMS 放行前不得进入生产投料；供应商资质或 COA 异常时，须创建质量调查并升级质量负责人。' },
  { id: 'COA-VC-2026', source: 'LIMS 检验记录', title: '维生素 C 原料批次 COA 摘要', classification: '质量受限', roles: ['executive', 'quality_manager', 'production_manager', 'procurement_manager'], keywords: ['维生素', 'c', '原料', 'coa', '检验', '批次'], excerpt: 'RMB-VC-20260718 批次为已放行状态；采购替代批次仍需完成供应商资质、COA 与来料检验核验。' },
  { id: 'POL-PR-003', source: '采购制度库', title: '采购申请与审批阈值', classification: '内务受限', roles: ['executive', 'procurement_manager', 'production_manager'], keywords: ['采购', '预算', '审批', '供应商', '下单', '补货'], excerpt: '采购申请先创建 ERP 草稿，再按采购、质量、财务路径审批；未完成审批不得向供应商发送正式订单。' },
  { id: 'SOP-MES-024', source: 'MES 生产 SOP', title: '设备校准与生产批次关联', classification: '生产受限', roles: ['executive', 'quality_manager', 'production_manager'], keywords: ['设备', '校准', '生产', '批次', '维护'], excerpt: '设备校准逾期或处于异常状态时，相关生产批次应被限制执行，并自动形成风险事件。' },
  { id: 'QMS-COM-011', source: 'QMS 客诉质量知识库', title: '市场投诉分级与产品追溯', classification: '质量受限', roles: ['executive', 'marketing_manager', 'quality_manager'], keywords: ['投诉', '市场', '客户', '产品', '召回', '反馈'], excerpt: '市场投诉以 QMS 质量事件参与分析；涉及产品安全的高风险投诉必须路由质量调查、批次追溯与 OMS 订单影响评估。' }
];

const normalize = (value) => String(value || '').toLowerCase();

export function retrieveEnterpriseKnowledge(query, roleId, limit = 3) {
  const text = normalize(query);
  const businessIds = extractQueryBusinessIds(query);
  const results = documents
    .filter((document) => document.roles.includes(roleId))
    // Policies can guide an analysis, but a default batch COA is not evidence
    // about an arbitrary requested batch.
    .filter((document) => !businessIds.length || document.source !== 'LIMS 检验记录' || matchingQueryBusinessIds({ id: document.id, excerpt: document.excerpt }, businessIds).length)
    .map((document) => ({ document, score: document.keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 1 : 0), 0) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ document, score }) => ({
      score,
      title: document.title,
      source: document.source,
      id: document.id,
      classification: document.classification,
      excerpt: document.excerpt
    }));
  return { mode: 'controlled_local_retrieval', query, results, noEvidence: !results.length };
}

export function getEnterpriseKnowledgeCatalog(roleId) {
  return documents
    .filter((document) => document.roles.includes(roleId))
    .map(({ id, source, title, classification, keywords }) => ({ id, source, title, classification, keywords }));
}

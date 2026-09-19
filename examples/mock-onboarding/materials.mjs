import * as fulfillment from '../knowledge/dual-agent-mock/input-materials.mjs';
import * as incident from '../semantic-schemas/supply-chain-incident/scenario.mjs';

// Source material only. Never import expected.mjs or a prebuilt read plan here.
const json = value => JSON.stringify(value, null, 2);
export function onboardingMaterials(scenarioId, tenantId, { includeDuplicateDeliveries = false } = {}) {
  if (!['fulfillment', 'quality_incident'].includes(scenarioId)) throw new Error('Unknown onboarding scenario.');
  if (!/^mock-onboarding-[ab]$/.test(tenantId)) throw new Error('Only isolated synthetic tenants are supported.');
  const source = scenarioId === 'fulfillment' ? fulfillment : incident;
  const samples = structuredClone(source.samples);
  samples.records.forEach(record => { record.tenantId = tenantId; });
  const sourceRecordCount = samples.records.length;
  if (!includeDuplicateDeliveries) {
    const exact = new Set();
    samples.records = samples.records.filter(row => { const value = json(row); if (exact.has(value)) return false; exact.add(value); return true; });
  }
  samples.preparation = { version: 'onboarding-input-v1', sourceRecordCount, removedExactDuplicateDeliveries: sourceRecordCount - samples.records.length,
    note: '入门材料为去除完全相同重复投递后的快照；原始事件资产未改动。重复/冲突与增量语义需后续单独验收。' };
  const api = scenarioId === 'fulfillment'
    ? `${fulfillment.apiNotes}\n逐对象来源以附属字典为准；API 文字中的退货/寄售归属须人工核对。`
    : `合成质量事件 API 文档，非企业系统。只读来源 ERP、LIMS、MES、WMS、OMS、QMS、OA。\nPOST /{system}/query 接受 ontology-query.v1；按 objectType 和 filter 查询。\n每条记录含租户、组织、来源、版本和事件时间；完整性由 queryCoverage.complete 与查询指纹声明。\n仅允许当前租户已授权对象；401 未认证，403 无权，409 冲突。分页不得遗漏；超时与未完成读取不能视为完整结果。\n${json(source.openapi)}`;
  const rules = scenarioId === 'fulfillment'
    ? `${source.requirements}\n${source.proposedRule}`
    : `${source.requirements}\n已审批不等于已执行，计划领料不等于实际投料，筛查阳性不等于根因确定。\n只按有效关系追踪拆合批后代；不反向把合批前的其他原料全部列为受影响。\n库存、在途、销售和待检退货保持不同口径；kg 与 piece 没有转换依据不得换算。当前仅分析，任何处置动作均需另行授权。`;
  return [
    { kind: 'requirements', name: '01-requirements.txt', text: source.requirements },
    { kind: 'api', name: '02-api.txt', text: api },
    { kind: 'dictionary', name: '03-dictionary.json', text: json(source.dictionary) },
    { kind: 'samples', name: '04-samples.json', text: json(samples) },
    { kind: 'rules', name: '05-rules.txt', text: rules }
  ];
}

export const syntheticEnterprises = [
  { tenantId: 'mock-onboarding-a', name: '模拟甲企业 · 订单履约', scenarioId: 'fulfillment' },
  { tenantId: 'mock-onboarding-b', name: '模拟乙企业 · 批次异常', scenarioId: 'quality_incident' }
];

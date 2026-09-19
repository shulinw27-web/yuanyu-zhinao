import * as fulfillment from '../knowledge/dual-agent-mock/input-materials.mjs';
import * as incident from '../semantic-schemas/supply-chain-incident/scenario.mjs';

// Explicit HUMAN-authored review inputs, not generated models or expected
// answers. Import separately; the initial empty project never installs these.
export function onboardingAlignment(scenarioId) {
  if (!['fulfillment', 'quality_incident'].includes(scenarioId)) throw new Error('Unknown synthetic scenario.');
  const tables = (scenarioId === 'fulfillment' ? fulfillment : incident).dictionary.tables;
  const names = scenarioId === 'fulfillment' ? ['ItemSKU', 'Customer', 'SalesOrder', 'SalesOrderLine'] : ['Supplier', 'PurchaseOrder', 'RawLot', 'Inspection'];
  const identities = names.map(objectType => ({ objectType, canonicalType: objectType, granularity: tables.find(table => table.name === objectType).granularity,
    aliases: [], evidence: '人工示例：沿用字典声明主键与粒度；不按名称相似度合并。' }));
  return { version: 'mock-alignment.v1', identities,
    units: scenarioId === 'fulfillment'
      ? [{ objectType: 'SalesOrderLine', field: 'qty', unitField: 'unit', sourceUnit: 'case', targetUnit: 'piece', lookup: { objectType: 'ItemSKU', viaField: 'sku_id', valueField: 'pieces_per_case' }, evidence: '按需求与字典，通过商品外键逐行查询包装系数；不汇总不同状态订单行。' }]
      : [{ objectType: 'RawLot', field: 'qty_kg', sourceUnit: 'kg', targetUnit: 'g', evidence: '字典明确 qty_kg 单位为 kg，按 SI 单位换算为 g；不转换成件数。' }],
    states: scenarioId === 'fulfillment'
      ? [{ objectType: 'SalesOrderLine', field: 'status', values: [{ source: 'open', target: 'pending' }, { source: 'cancelled', target: 'cancelled' }], evidence: '人工术语表：open 表示待处理，cancelled 表示已取消；仅规范术语，不作为履约资格判定。' },
        { objectType: 'ControlApproval', field: 'status', values: [{ source: 'approved', target: 'approved' }], evidence: '审批通过只表示批准，不能代替执行回执。' }]
      : [{ objectType: 'Inspection', field: 'result', values: [{ source: 'screen_positive', target: 'needs_retest' }, { source: 'pass', target: 'passed' }], evidence: '人工检验口径：筛查阳性仍待复测，不能认定根因或发起处置。' }]
  };
}

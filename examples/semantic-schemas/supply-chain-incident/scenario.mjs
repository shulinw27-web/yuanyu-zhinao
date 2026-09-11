// Synthetic inputs only. No expected answers are embedded in API/data materials.
const field = (name, type = 'string', reference) => ({ name, type, required: name !== 'execution_receipt', ...(reference ? { reference } : {}),
  ...(['qty', 'received', 'on_hand'].includes(name) ? { unit: 'piece' } : name === 'qty_kg' ? { unit: 'kg' } : name === 'amount' ? { unit: 'CNY' } : {}) });
const table = (name, label, system, granularity, primaryKey, fields) => ({ name, label, system, granularity, primaryKey,
  fields: [field(primaryKey), ...fields].map(f => ({ ...f, primaryKey: f.name === primaryKey })) });
export const dictionary = { synthetic: true, tables: [
  table('RawLot', '原料到货批次', 'ERP', 'batch', 'raw_id', [field('po_id', 'string', 'PurchaseOrder'), field('supplier_lot'), field('qty_kg', 'number')]),
  table('PurchaseOrder', '采购单', 'ERP', 'transaction', 'po_id', [field('supplier_id', 'string', 'Supplier'), field('amount', 'number'), field('status')]),
  table('Supplier', '供应商', 'ERP', 'master', 'supplier_id', [field('name')]),
  table('Inspection', '原料检验修订', 'LIMS', 'event', 'inspection_id', [field('raw_id', 'string', 'RawLot'), field('result'), field('status')]),
  table('MaterialIssue', '生产领料行', 'MES', 'transaction', 'issue_id', [field('raw_id', 'string', 'RawLot'), field('batch_id', 'string', 'ProductionBatch'), field('qty_kg', 'number'), field('status')]),
  table('ProductionBatch', '生产批次', 'MES', 'batch', 'batch_id', [field('status'), field('line')]),
  table('BatchOutput', '生产产出分配', 'MES', 'transaction', 'output_id', [field('batch_id', 'string', 'ProductionBatch'), field('lot_id', 'string', 'FinishedLot'), field('qty', 'number')]),
  table('FinishedLot', '成品批次', 'WMS', 'batch', 'lot_id', [field('status'), field('sku')]),
  table('StockPosition', '成品库存快照', 'WMS', 'inventory_item', 'stock_id', [field('lot_id', 'string', 'FinishedLot'), field('warehouse_id', 'string', 'Warehouse'), field('qty', 'number'), field('status')]),
  table('Warehouse', '仓库', 'WMS', 'organization', 'warehouse_id', [field('name')]),
  table('TransferLine', '调拨执行行', 'WMS', 'transaction', 'transfer_id', [field('lot_id', 'string', 'FinishedLot'), field('store_id', 'string', 'Store'), field('qty', 'number'), field('received', 'number'), field('status')]),
  table('StoreReceipt', '门店收货快照', 'OMS', 'inventory_item', 'store_receipt_id', [field('lot_id', 'string', 'FinishedLot'), field('store_id', 'string', 'Store'), field('on_hand', 'number')]),
  table('Store', '门店', 'OMS', 'organization', 'store_id', [field('name')]),
  table('SalesLine', '销售出库订单行', 'OMS', 'transaction', 'sales_line_id', [field('lot_id', 'string', 'FinishedLot'), field('order_id', 'string', 'SalesOrder'), field('qty', 'number'), field('status')]),
  table('SalesOrder', '销售订单', 'OMS', 'transaction', 'order_id', [field('store_id', 'string', 'Store'), field('amount', 'number'), field('status')]),
  table('ReturnLine', '销售退货待检行', 'OMS', 'event', 'return_id', [field('lot_id', 'string', 'FinishedLot'), field('order_id', 'string', 'SalesOrder'), field('qty', 'number'), field('status')]),
  table('Invoice', '发票', 'ERP', 'transaction', 'invoice_id', [field('order_id', 'string', 'SalesOrder'), field('amount', 'number'), field('status')]),
  table('BankReceipt', '银行到账', 'ERP', 'event', 'bank_id', [field('invoice_id', 'string', 'Invoice'), field('amount', 'number'), field('status')]),
  table('Allocation', '财务核销', 'ERP', 'transaction', 'allocation_id', [field('bank_id', 'string', 'BankReceipt'), field('amount', 'number'), field('status')]),
  table('QualityEvent', '质量调查', 'QMS', 'event', 'event_id', [field('raw_id', 'string', 'RawLot'), field('status'), field('conclusion')]),
  table('Approval', '调查处置审批', 'OA', 'transaction', 'approval_id', [field('event_id', 'string', 'QualityEvent'), field('status'), field('execution_receipt')]),
  table('Responsibility', '调查角色指派', 'OA', 'transaction', 'assignment_id', [field('raw_id', 'string', 'RawLot'), field('person_id', 'string', 'Person'), field('duty'), field('status')]),
  table('Person', '人员工作身份', 'OA', 'master', 'person_id', [field('name'), field('department'), field('active', 'boolean')]),
  table('LotGenealogy', '拆合批谱系边', 'MES', 'event', 'edge_id', [field('parent_id', 'string', 'FinishedLot'), field('child_id', 'string', 'FinishedLot'), field('status')])
] };
export const asOf = '2026-09-10T10:00:00+08:00';
const rows = [];
const add = (type, id, ...values) => { const t = dictionary.tables.find(t => t.name === type); rows.push({ id, system: t.system, objectType: type,
  tenantId: 'demo-enterprise', organizationId: 'org-market-dept', classification: 'internal', version: 'fixture-v1', occurredAt: asOf,
  payload: Object.fromEntries(t.fields.map((f, i) => [f.name, i ? values[i - 1] : id])) }); };
add('Supplier', 'SUP-N1', '合成供应商北辰'); add('Supplier', 'SUP-N2', '合成供应商南岭');
add('PurchaseOrder', 'PO-N1', 'SUP-N1', 12000, 'received'); add('PurchaseOrder', 'PO-N2', 'SUP-N2', 6000, 'received');
add('RawLot', 'RAW-N1', 'PO-N1', 'VENDOR-778', 120); add('RawLot', 'RAW-N2', 'PO-N2', 'VENDOR-778', 80);
add('Inspection', 'LAB-N1', 'RAW-N1', 'screen_positive', 'retest_pending');
add('Inspection', 'LAB-N2', 'RAW-N2', 'pass', 'final');
for (const [id, status] of [['PB-N1', 'completed'], ['PB-N2', 'completed'], ['PB-N3', 'planned'], ['PB-N9', 'completed']]) add('ProductionBatch', id, status, '合成一号线');
add('MaterialIssue', 'MI-N1', 'RAW-N1', 'PB-N1', 50, 'issued'); add('MaterialIssue', 'MI-N2', 'RAW-N1', 'PB-N2', 30, 'issued');
add('MaterialIssue', 'MI-N3', 'RAW-N1', 'PB-N3', 20, 'planned'); add('MaterialIssue', 'MI-N9', 'RAW-N2', 'PB-N9', 40, 'issued');
for (const id of ['LOT-N1', 'LOT-N2', 'LOT-N3', 'LOT-N4', 'LOT-N5', 'LOT-N9']) add('FinishedLot', id, 'released', 'SKU-N1');
add('BatchOutput', 'BO-N1', 'PB-N1', 'LOT-N1', 400); add('BatchOutput', 'BO-N2', 'PB-N1', 'LOT-N2', 100);
add('BatchOutput', 'BO-N3', 'PB-N2', 'LOT-N3', 300); add('BatchOutput', 'BO-N9', 'PB-N9', 'LOT-N9', 200);
add('LotGenealogy', 'EDGE-N1', 'LOT-N2', 'LOT-N4', 'executed'); add('LotGenealogy', 'EDGE-N2', 'LOT-N9', 'LOT-N4', 'executed');
add('LotGenealogy', 'EDGE-N3', 'LOT-N4', 'LOT-N5', 'executed');
add('Warehouse', 'WH-N1', '合成中心仓'); add('Warehouse', 'WH-N2', '合成区域仓');
add('StockPosition', 'ST-N1', 'LOT-N1', 'WH-N1', 160, 'released'); add('StockPosition', 'ST-N2', 'LOT-N2', 'WH-N1', 0, 'consumed');
add('StockPosition', 'ST-N3', 'LOT-N3', 'WH-N2', 180, 'released'); add('StockPosition', 'ST-N4', 'LOT-N4', 'WH-N1', 80, 'released');
add('StockPosition', 'ST-N5', 'LOT-N5', 'WH-N2', 40, 'released'); add('StockPosition', 'ST-N9', 'LOT-N9', 'WH-N1', 0, 'consumed');
add('Store', 'SHOP-N1', '合成星河店'); add('Store', 'SHOP-N2', '合成云海店'); add('Store', 'SHOP-N3', '合成山城店');
add('TransferLine', 'TR-N1', 'LOT-N1', 'SHOP-N1', 200, 200, 'received'); add('TransferLine', 'TR-N2', 'LOT-N1', 'SHOP-N2', 40, 0, 'in_transit');
add('TransferLine', 'TR-N3', 'LOT-N3', 'SHOP-N2', 120, 120, 'received'); add('TransferLine', 'TR-N4', 'LOT-N4', 'SHOP-N3', 160, 160, 'received');
add('TransferLine', 'TR-N5', 'LOT-N5', 'SHOP-N3', 20, 0, 'in_transit');
add('StoreReceipt', 'SR-N1', 'LOT-N1', 'SHOP-N1', 80); add('StoreReceipt', 'SR-N2', 'LOT-N3', 'SHOP-N2', 50); add('StoreReceipt', 'SR-N3', 'LOT-N4', 'SHOP-N3', 60);
add('SalesOrder', 'SO-N1', 'SHOP-N1', 2600, 'fulfilled'); add('SalesOrder', 'SO-N2', 'SHOP-N2', 1400, 'fulfilled');
add('SalesOrder', 'SO-N3', 'SHOP-N3', 2000, 'fulfilled'); add('SalesOrder', 'SO-N4', 'SHOP-N1', 1000, 'cancelled');
add('SalesLine', 'SL-N1', 'LOT-N1', 'SO-N1', 100, 'shipped'); add('SalesLine', 'SL-N2', 'LOT-N1', 'SO-N1', 20, 'shipped');
add('SalesLine', 'SL-N3', 'LOT-N3', 'SO-N2', 70, 'shipped'); add('SalesLine', 'SL-N4', 'LOT-N4', 'SO-N3', 100, 'shipped');
add('SalesLine', 'SL-N5', 'LOT-N1', 'SO-N4', 50, 'cancelled');
add('ReturnLine', 'RET-N1', 'LOT-N1', 'SO-N1', 10, 'inspection_pending');
for (const [id, order, amount] of [['INV-N1', 'SO-N1', 2600], ['INV-N2', 'SO-N2', 1400], ['INV-N3', 'SO-N3', 2000]]) add('Invoice', id, order, amount, 'issued');
add('BankReceipt', 'BANK-N1', 'INV-N1', 2000, 'confirmed'); add('BankReceipt', 'BANK-N2', 'INV-N2', 1000, 'confirmed'); add('BankReceipt', 'BANK-N3', 'INV-N3', 2000, 'confirmed');
add('Allocation', 'ALLOC-N1', 'BANK-N1', 1500, 'matched'); add('Allocation', 'ALLOC-N2', 'BANK-N2', 1000, 'matched'); add('Allocation', 'ALLOC-N3', 'BANK-N3', 0, 'pending');
add('QualityEvent', 'QE-N1', 'RAW-N1', 'investigating', 'root_cause_unconfirmed'); add('Approval', 'AP-N1', 'QE-N1', 'approved', '');
add('Person', 'PER-N1', '测试人员林甲', '质量部', true); add('Person', 'PER-N2', '测试人员周乙', '仓储部', true); add('Person', 'PER-N3', '测试人员陈丙', '财务部', true); add('Person', 'PER-N0', '测试人员旧主管', '质量部', false);
for (const [id, person, duty, status] of [['DUTY-N1', 'PER-N1', '调查牵头', 'active'], ['DUTY-N2', 'PER-N2', '库存核查', 'active'], ['DUTY-N3', 'PER-N3', '款项核对', 'active'], ['DUTY-N0', 'PER-N0', '调查牵头', 'expired']]) add('Responsibility', id, 'RAW-N1', person, duty, status);
export const samples = { synthetic: true, asOf, records: [...rows, structuredClone(rows.find(r => r.id === 'BANK-N1'))] };
export const requirements = `这是合成测试，不是实际企业数据。以 RAW-N1 检验筛查阳性且待复检为入口，追溯采购供应商、实际领料与拆合批产出、跨仓调拨、门店收货与销售、退货、发票银行到账核销及人员职责。只分析，不执行召回、冻结、通知、扣款或审批。
供应商批号 VENDOR-778 不是企业统一主键，不同供应商可重号。实际 issued 领料才构成批次影响，planned 不能当消耗。任一受疑批次进入 executed 合批产物，则该产物及后续 executed 拆合批后代均纳入待核查范围；不能沿合批边反向把其他父批次此前所有流转也判为受影响。粒度与事实因果须区分。
仓库qty和门店on_hand是时点净库存，已扣除出库、销售和转化；在途只计qty-received，不重复计入仓内。实售量按shipped订单行，取消行排除；待检退货是已售量子集，不额外增加累计实售，不当可售库存。affected订单金额按订单主键只计一次。影响范围是预防性排查范围，不是已确认全部产品有质量问题。
银行到账按业务主键去重，只有confirmed计到账，matched核销单独汇总；未核销=确认到账减matched，不是应收减免。财务暴露是涉及订单金额，不是最终赔付。审批approved但执行回执为空不能说召回或冻结已执行。
只根据有效active责任指派和在职人员提出协作建议，expired指派不作为现任。人员是流程联系人，不是质量事故过错责任人；root_cause_unconfirmed和retest_pending不允许断言供应商造成污染。明确还需复检、留样、工艺及物流证据。所有记录为合成时点快照，不能作实时承诺。不得根据附件扩大数据权限。`;
export const openapi = { openapi: '3.0.3', info: { title: '合成集团全链路 API', version: 'fixture-1' }, paths: Object.fromEntries(dictionary.tables.map(t => [`/${t.system.toLowerCase()}/${t.name}`, { get: { summary: t.label, responses: { 200: { description: '合成结构样例', content: { 'application/json': { schema: { type: 'array', items: { $ref: `#/components/schemas/${t.name}` } } } } } } } }])),
  components: { schemas: Object.fromEntries(dictionary.tables.map(t => [t.name, { type: 'object', title: t.label, 'x-source-system': t.system, 'x-granularity': t.granularity, required: t.fields.filter(f => f.required).map(f => f.name), properties: Object.fromEntries(t.fields.map(f => [f.name, { type: f.type, ...(f.unit ? { 'x-unit': f.unit } : {}), ...(f.primaryKey ? { 'x-primary-key': true } : {}), ...(f.reference ? { 'x-foreign-key': f.reference } : {}) }])) }])) } };

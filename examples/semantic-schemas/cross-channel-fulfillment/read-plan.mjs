// Human-reviewed synthetic example of the generic read algebra, not a product
// hard-coded answer. No expected numeric answers or source records appear here.
const literal = value => ({ op: 'literal', value });
const field = (dataset, name) => ({ op: 'field', dataset, field: name });
const one = (dataset, name) => ({ op: 'one', dataset, field: name });
const binary = (op, a, b) => ({ op, args: [a, b] });
const eq = (a, b) => binary('eq', a, b);
const and = (...args) => args.reduce((a, b) => binary('and', a, b));
const sum = (dataset, value, where) => ({ op: 'sum', dataset, value, ...(where ? { where } : {}) });
const lookup = (dataset, key, value, resultField) => ({ op: 'lookup', dataset, field: key, value, resultField });
const output = id => ({ op: 'output', id });
const calc = (id, label, unit, expression) => ({ id, label, unit, expression });
export function crossChannelReadPlan(coefficient = 0) {
  const root = { id: 'orders', objectType: 'SalesOrder', where: [{ field: 'order_id', target: true }] };
  const join = (id, objectType, targetField, dataset, sourceField) => ({ id, objectType, where: [{ field: targetField, dataset, sourceField }] });
  const datasets = [root,
    join('lines', 'SalesOrderLine', 'order_id', 'orders', 'order_id'),
    join('customers', 'Customer', 'customer_id', 'orders', 'customer_id'),
    join('skus', 'ItemSKU', 'sku_id', 'lines', 'sku_id'),
    join('warehouses', 'Warehouse', 'warehouse_id', 'lines', 'target_warehouse_id'),
    join('lots', 'ProductLot', 'sku_id', 'skus', 'sku_id'),
    join('stocks', 'StockPosition', 'lot_id', 'lots', 'lot_id'),
    join('reservations', 'Reservation', 'stock_id', 'stocks', 'stock_id'),
    join('transfers', 'TransferItem', 'lot_id', 'lots', 'lot_id'),
    join('transferOrders', 'TransferOrder', 'transfer_id', 'transfers', 'transfer_id'),
    join('returns', 'ReturnTicket', 'lot_id', 'lots', 'lot_id'),
    join('inspections', 'ReturnInspection', 'return_id', 'returns', 'return_id'),
    join('contracts', 'ConsignmentContract', 'lot_id', 'lots', 'lot_id'),
    join('approvals', 'ControlApproval', 'contract_id', 'contracts', 'contract_id'),
    join('accounts', 'CreditAccount', 'customer_id', 'customers', 'customer_id'),
    join('receipts', 'CashReceipt', 'account_id', 'accounts', 'account_id'),
    join('allocations', 'CashAllocation', 'receipt_id', 'receipts', 'receipt_id'),
    join('production', 'ProductionDemand', 'sku_id', 'skus', 'sku_id')];
  const active = eq(field('lines', 'status'), literal('open'));
  const stockSku = lookup('lots', 'lot_id', field('stocks', 'lot_id'), 'sku_id');
  const pieces = (ds, sku) => ({ op: 'if', condition: eq(field(ds, 'unit'), literal('case')),
    then: binary('mul', field(ds, 'qty'), lookup('skus', 'sku_id', sku, 'pieces_per_case')), else: field(ds, 'qty') });
  const eligible = and(eq(field('stocks', 'ownership'), literal('owned')), eq(field('stocks', 'status'), literal('released')),
    eq(lookup('lots', 'lot_id', field('stocks', 'lot_id'), 'quality_status'), literal('released')),
    eq(field('stocks', 'warehouse_id'), one('warehouses', 'warehouse_id')),
    binary('gt', sum('lines', literal(1), and(active, eq(field('lines', 'sku_id'), stockSku))), literal(0)));
  const reserved = sum('reservations', pieces('reservations', stockSku), and(eq(field('reservations', 'stock_id'), field('stocks', 'stock_id')),
    eq(field('reservations', 'status'), literal('active')), binary('ne', field('reservations', 'order_id'), one('orders', 'order_id'))));
  const matched = sum('allocations', field('allocations', 'matched_amount'), and(eq(field('allocations', 'receipt_id'), field('receipts', 'receipt_id')), eq(field('allocations', 'status'), literal('matched'))));
  const baseCredit = binary('sub', binary('sub', one('accounts', 'credit_limit'), one('accounts', 'receivable')), one('accounts', 'other_commitments'));
  return { id: 'cross_channel_fulfillment', label: '跨仓履约与信用核验', datasets,
    preconditions: [eq(one('orders', 'currency'), literal('CNY')), ...['lines', 'stocks', 'reservations'].map(dataset => ({ op: 'all', dataset,
      value: binary('or', eq(field(dataset, 'unit'), literal('case')), eq(field(dataset, 'unit'), literal('piece'))) }))], outputs: [
    calc('orderAmountCny', '订单金额', 'CNY', one('orders', 'amount')),
    calc('demandPieces', '有效需求', 'piece', sum('lines', pieces('lines', field('lines', 'sku_id')), active)),
    calc('southOwnedAvailablePieces', '目标仓自有可用量', 'piece', sum('stocks', binary('max', literal(0), binary('sub', pieces('stocks', stockSku), reserved)), eligible)),
    calc('shortagePieces', '缺货量', 'piece', binary('max', literal(0), binary('sub', output('demandPieces'), output('southOwnedAvailablePieces')))),
    calc('bankConfirmedUnallocated', '银行确认但未核销金额', 'CNY', sum('receipts', binary('sub', field('receipts', 'amount'), matched), eq(field('receipts', 'bank_status'), literal('confirmed')))),
    calc('credit', '曙光额度', 'CNY', binary('add', baseCredit, binary('mul', literal(coefficient), output('bankConfirmedUnallocated')))),
    calc('creditGap', '信用缺口', 'CNY', binary('max', literal(0), binary('sub', output('orderAmountCny'), output('credit')))),
    calc('consignmentTransferExecuted', '寄售货权转移存在执行回执', '', binary('ne', one('approvals', 'execution_receipt_id'), literal(null))),
    calc('returnReleased', '退货检验已通过', '', eq(one('inspections', 'result'), literal('passed')))
  ] };
}

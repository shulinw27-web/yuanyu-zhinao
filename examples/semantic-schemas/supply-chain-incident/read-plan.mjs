// Human-reviewed direct-scope control. Deliberately no invented transitive closure.
const f = (dataset, field) => ({ op: 'field', dataset, field });
const lit = value => ({ op: 'literal', value });
const bin = (op, a, b) => ({ op, args: [a, b] });
const eq = (a, value) => bin('eq', a, lit(value));
const sum = (dataset, value, where) => ({ op: 'sum', dataset, value, ...(where ? { where } : {}) });
const out = (id, label, unit, expression) => ({ id, label, unit, expression });
const join = (id, objectType, field, dataset, sourceField) => ({ id, objectType, where: [{ field, dataset, sourceField }] });
export const readPlan = { id: 'supply_chain_direct', label: '直接领料影响核查（不含拆合批后代，不能视为完整召回范围）',
  datasets: [{ id: 'raw', objectType: 'RawLot', where: [{ field: 'raw_id', target: true }] },
    join('po', 'PurchaseOrder', 'po_id', 'raw', 'po_id'), join('supplier', 'Supplier', 'supplier_id', 'po', 'supplier_id'),
    join('inspection', 'Inspection', 'raw_id', 'raw', 'raw_id'), join('issue', 'MaterialIssue', 'raw_id', 'raw', 'raw_id'),
    join('batch', 'ProductionBatch', 'batch_id', 'issue', 'batch_id'), join('output', 'BatchOutput', 'batch_id', 'batch', 'batch_id'),
    join('lot', 'FinishedLot', 'lot_id', 'output', 'lot_id'), join('stock', 'StockPosition', 'lot_id', 'lot', 'lot_id'),
    join('warehouse', 'Warehouse', 'warehouse_id', 'stock', 'warehouse_id'), join('transfer', 'TransferLine', 'lot_id', 'lot', 'lot_id'),
    join('storeReceipt', 'StoreReceipt', 'lot_id', 'lot', 'lot_id'), join('store', 'Store', 'store_id', 'transfer', 'store_id'),
    join('sales', 'SalesLine', 'lot_id', 'lot', 'lot_id'), join('order', 'SalesOrder', 'order_id', 'sales', 'order_id'),
    join('returns', 'ReturnLine', 'lot_id', 'lot', 'lot_id'), join('invoice', 'Invoice', 'order_id', 'order', 'order_id'),
    join('bank', 'BankReceipt', 'invoice_id', 'invoice', 'invoice_id'), join('allocation', 'Allocation', 'bank_id', 'bank', 'bank_id'),
    join('quality', 'QualityEvent', 'raw_id', 'raw', 'raw_id'), join('approval', 'Approval', 'event_id', 'quality', 'event_id'),
    join('duty', 'Responsibility', 'raw_id', 'raw', 'raw_id'), join('person', 'Person', 'person_id', 'duty', 'person_id'),
    join('genealogy', 'LotGenealogy', 'parent_id', 'lot', 'lot_id')],
  outputs: [
    out('warehousePieces', '直接批次仓内数量', 'piece', sum('stock', f('stock', 'qty'))),
    out('transitPieces', '直接批次在途数量', 'piece', sum('transfer', bin('sub', f('transfer', 'qty'), f('transfer', 'received')), eq(f('transfer', 'status'), 'in_transit'))),
    out('storePieces', '直接批次门店现存', 'piece', sum('storeReceipt', f('storeReceipt', 'on_hand'))),
    out('soldPieces', '直接批次已售数量', 'piece', sum('sales', f('sales', 'qty'), eq(f('sales', 'status'), 'shipped'))),
    out('pendingReturnPieces', '直接批次待检退货', 'piece', sum('returns', f('returns', 'qty'), eq(f('returns', 'status'), 'inspection_pending'))),
    out('involvedOrderCny', '直接批次涉及订单金额（非赔付额）', 'CNY', sum('order', f('order', 'amount'), eq(f('order', 'status'), 'fulfilled'))),
    out('confirmedBankCny', '直接批次确认到账', 'CNY', sum('bank', f('bank', 'amount'), eq(f('bank', 'status'), 'confirmed'))),
    out('matchedCny', '直接批次已核销', 'CNY', sum('allocation', f('allocation', 'amount'), eq(f('allocation', 'status'), 'matched'))),
    out('unallocatedCny', '直接批次未核销', 'CNY', bin('sub', { op: 'output', id: 'confirmedBankCny' }, { op: 'output', id: 'matchedCny' }))
  ] };

// Same model and facts, explicit generic forward-closure configuration.
export const fullReadPlan = structuredClone(readPlan);
fullReadPlan.id = 'supply_chain_full';
fullReadPlan.label = '原料实际领用与已执行拆合批后代影响核查';
fullReadPlan.datasets.find(d => d.id === 'issue').filter = { field: 'status', values: ['issued'] };
fullReadPlan.datasets.find(d => d.id === 'lot').expand = { edgeObjectType: 'LotGenealogy', fromField: 'parent_id', toField: 'child_id', stateField: 'status', activeStates: ['executed'], inactiveStates: ['planned', 'revoked'], maxDepth: 8 };
fullReadPlan.coverage = { mode: 'bounded_declared_graph', requiredExpansions: ['lot'] };
fullReadPlan.analysis = { enabled: true };
fullReadPlan.outputs.forEach(o => { o.label = o.label.replace('直接批次', '声明影响范围'); });

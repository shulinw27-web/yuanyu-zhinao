// Independent fixture oracle. This calculator is NOT installed in the product,
// exposed to an Agent, or used as evidence that the product computes these values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const dir = new URL('../../examples/semantic-schemas/cross-channel-fulfillment/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const dictionary = read('data-dictionary.json');
const api = read('combined-openapi.json');
const raw = read('sample-events.json').records;
const expected = read('expected-results.json');
const unique = [...new Map(raw.map(r => [JSON.stringify([r.tenantId, r.system, r.objectType, r.id, r.version]), r])).values()];
const rows = type => unique.filter(r => r.objectType === type).map(r => r.payload);
const one = (type, field, id) => rows(type).find(r => r[field] === id);
const pieces = (qty, unit, sku) => unit === 'case' ? qty * one('ItemSKU', 'sku_id', sku).pieces_per_case : qty;

test('fixture source/primary-key/field contracts agree and all foreign keys resolve', () => {
  assert.equal(dictionary.tables.length, 18);
  assert.equal(unique.length, expected.uniqueRecords);
  assert.equal(raw.length, unique.length + 1);
  let references = 0;
  for (const table of dictionary.tables) {
    const schema = api.components.schemas[table.name];
    assert.equal(schema['x-source-system'], table.system);
    assert.equal(schema['x-primary-key'], table.primaryKey);
    assert.equal(schema['x-granularity'], table.granularity);
    assert.deepEqual(Object.keys(schema.properties).sort(), table.fields.map(f => f.name).sort());
    const objectRows = unique.filter(r => r.objectType === table.name);
    for (const r of objectRows) {
      assert.equal(r.system, table.system);
      assert.equal(r.id, r.payload[table.primaryKey]);
      for (const f of table.fields) {
        if (f.required) assert.notEqual(r.payload[f.name], undefined);
        if (r.payload[f.name] !== null) assert.equal(typeof r.payload[f.name], f.type);
      }
    }
    for (const f of table.fields.filter(f => f.reference)) {
      references++;
      const [target, explicitField] = f.reference.split('.');
      const field = f.referenceField || explicitField || dictionary.tables.find(t => t.name === target)?.primaryKey;
      assert.ok(dictionary.tables.some(t => t.name === target));
      for (const r of objectRows) assert.ok(one(target, field, r.payload[f.name]), `${table.name}.${f.name} dangling FK`);
    }
  }
  assert.equal(references, 22);
});

test('independent quantity oracle excludes wrong SKU, warehouse, ownership, QC, cancellations and reservations', () => {
  const order = one('SalesOrder', 'order_id', 'ORD-X900');
  const lines = rows('SalesOrderLine').filter(l => l.order_id === order.order_id && l.status !== 'cancelled');
  const demand = lines.reduce((sum, l) => sum + pieces(l.qty, l.unit, l.sku_id), 0);
  const available = lines.reduce((sum, line) => sum + rows('StockPosition').reduce((total, stock) => {
    const lot = one('ProductLot', 'lot_id', stock.lot_id);
    if (lot.sku_id !== line.sku_id || stock.warehouse_id !== line.target_warehouse_id || stock.ownership !== 'owned'
      || stock.status !== 'released' || lot.quality_status !== 'released') return total;
    const reserved = rows('Reservation').filter(r => r.stock_id === stock.stock_id && r.status === 'active' && r.order_id !== order.order_id)
      .reduce((n, r) => n + pieces(r.qty, r.unit, lot.sku_id), 0);
    return total + Math.max(0, pieces(stock.qty, stock.unit, lot.sku_id) - reserved);
  }, 0), 0);
  assert.equal(order.amount, expected.answer.orderAmountCny);
  assert.equal(demand, expected.answer.demandPieces);
  assert.equal(available, expected.answer.southOwnedAvailablePieces);
  assert.equal(demand - available, expected.answer.shortagePieces);
});

test('independent credit oracle deduplicates receipt and does not deduct matched cash twice', () => {
  const account = one('CreditAccount', 'account_id', 'ACC-X1');
  const receipts = rows('CashReceipt').filter(r => r.account_id === account.account_id && r.bank_status === 'confirmed');
  const unmatched = receipts.reduce((sum, r) => sum + r.amount - rows('CashAllocation').filter(a => a.receipt_id === r.receipt_id && a.status === 'matched')
    .reduce((n, a) => n + a.matched_amount, 0), 0);
  const a = account.credit_limit - account.receivable - account.other_commitments;
  const b = a + 0.5 * unmatched;
  assert.equal(unmatched, expected.answer.bankConfirmedUnallocated);
  assert.equal(a, expected.answer.creditV1);
  assert.equal(b, expected.answer.creditV2);
  assert.equal(9000 - a, expected.answer.creditGapV1);
  assert.equal(9000 - b, expected.answer.creditGapV2);
});

test('approval and zero quantity are not execution or quarantine evidence', () => {
  const approval = one('ControlApproval', 'approval_id', 'AP-X1');
  assert.equal(approval.status, 'approved');
  assert.equal(approval.execution_receipt_id, null);
  assert.equal(one('StockPosition', 'stock_id', 'ST-X7').qty, 0);
  assert.equal(one('ProductLot', 'lot_id', 'LOT-X7').quality_status, 'released');
  assert.equal(one('TransferItem', 'transfer_line_id', 'TI-X1').received_qty, 0);
  assert.equal(one('ReturnInspection', 'inspection_id', 'RI-X1').result, 'pending');
});

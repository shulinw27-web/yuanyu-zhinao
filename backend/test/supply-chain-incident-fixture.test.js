import test from 'node:test';
import assert from 'node:assert/strict';
import { dictionary, samples, openapi } from '../../examples/semantic-schemas/supply-chain-incident/scenario.mjs';
import { expected } from '../../examples/semantic-schemas/supply-chain-incident/expected.mjs';
import { readPlan } from '../../examples/semantic-schemas/supply-chain-incident/read-plan.mjs';
import { discoverSchemasFromAttachments } from '../src/services/semantic-schema-discovery-service.js';
import { executeOntologyReadPlan, validateOntologyReadPlans } from '../src/services/ontology-read-plan-service.js';
export const discovered = discoverSchemasFromAttachments({ attachments: [{ id: 'dict', name: 'dictionary.json', mimeType: 'application/json' }], reports: [{ attachmentId: 'dict', status: 'content_scanned', structuredSchemaCandidate: true }], documents: [{ attachmentId: 'dict', text: JSON.stringify(dictionary) }] });
const unique = [...new Map(samples.records.map(r => [r.id, r])).values()];
const rows = type => unique.filter(r => r.objectType === type).map(r => r.payload);
test('all synthetic foreign keys resolve, identities and record grains are not conflated', () => {
  assert.equal(dictionary.tables.length, 24); assert.equal(discovered.objectTypes.length, 24);
  for (const t of dictionary.tables) for (const f of t.fields.filter(f => f.reference)) {
    const target = dictionary.tables.find(t => t.name === f.reference);
    const keys = new Set(rows(target.name).map(r => r[target.primaryKey]));
    for (const row of rows(t.name)) assert.ok(keys.has(row[f.name]), `${t.name}.${f.name}:${row[f.name]}`);
  }
  assert.equal(samples.records.length - unique.length, 1);
  assert.equal(rows('RawLot')[0].supplier_lot, rows('RawLot')[1].supplier_lot);
  assert.notEqual(rows('RawLot')[0].po_id, rows('RawLot')[1].po_id);
});
test('OpenAPI and dictionary express identical foreign keys using the supported extension', () => {
  const items = [dictionary, openapi];
  const combined = discoverSchemasFromAttachments({ attachments: items.map((_, i) => ({ id: String(i), name: `${i}.json`, mimeType: 'application/json' })),
    reports: items.map((_, i) => ({ attachmentId: String(i), status: 'content_scanned', structuredSchemaCandidate: true })), documents: items.map((value, i) => ({ attachmentId: String(i), text: JSON.stringify(value) })) });
  assert.equal(combined.objectTypes.length, 24); assert.equal(combined.relationshipTypes.length, 27);
  for (const t of dictionary.tables) for (const f of t.fields.filter(f => f.reference)) assert.ok(combined.objectTypes.find(o => o.id === t.name)?.fieldDefinitions.some(d => d.name === f.name && d.reference === f.reference));
});
test('independent oracle follows executed genealogy forwards only and reconciles full exposure', () => {
  const batches = new Set(rows('MaterialIssue').filter(r => r.raw_id === 'RAW-N1' && r.status === 'issued').map(r => r.batch_id));
  assert.deepEqual([...batches].sort(), expected.impactedBatches);
  const lots = new Set(rows('BatchOutput').filter(r => batches.has(r.batch_id)).map(r => r.lot_id));
  let changed = true; while (changed) { changed = false; for (const e of rows('LotGenealogy')) if (e.status === 'executed' && lots.has(e.parent_id) && !lots.has(e.child_id)) { lots.add(e.child_id); changed = true; } }
  assert.deepEqual([...lots].sort(), expected.transitiveLots); assert.ok(!lots.has('LOT-N9'));
  const filtered = t => rows(t).filter(r => lots.has(r.lot_id)); const total = (rs, f) => rs.reduce((n, r) => n + r[f], 0);
  const orderIds = new Set(filtered('SalesLine').filter(r => r.status === 'shipped').map(r => r.order_id));
  const orders = rows('SalesOrder').filter(r => orderIds.has(r.order_id));
  const invoices = new Set(rows('Invoice').filter(r => orderIds.has(r.order_id)).map(r => r.invoice_id));
  const banks = rows('BankReceipt').filter(r => invoices.has(r.invoice_id) && r.status === 'confirmed'); const bankIds = new Set(banks.map(r => r.bank_id));
  const matched = total(rows('Allocation').filter(r => bankIds.has(r.bank_id) && r.status === 'matched'), 'amount');
  assert.deepEqual({ warehousePieces: total(filtered('StockPosition'), 'qty'), transitPieces: filtered('TransferLine').filter(r => r.status === 'in_transit').reduce((n, r) => n + r.qty - r.received, 0),
    storePieces: total(filtered('StoreReceipt'), 'on_hand'), soldPieces: total(filtered('SalesLine').filter(r => r.status === 'shipped'), 'qty'), pendingReturnPieces: total(filtered('ReturnLine'), 'qty'),
    involvedOrderCny: total(orders, 'amount'), confirmedBankCny: total(banks, 'amount'), matchedCny: matched, unallocatedCny: total(banks, 'amount') - matched }, expected.totals);
  assert.deepEqual([...new Set(filtered('TransferLine').map(r => r.store_id))].sort(), expected.stores);
});
test('current published read algebra is a direct-only control, not a complete world traversal', async () => {
  const draft = { ...discovered, scenario: { readPlans: [readPlan], requireCaseReplay: true }, accessPolicies: dictionary.tables.map(t => ({ objectType: t.name, roles: ['executive'], effect: 'allow', condition: 'iam_scope' })) };
  process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ 'demo-enterprise': { executive: { metadata: true, objects: Object.fromEntries(dictionary.tables.map(t => [t.name, { system: t.system, fields: t.fields.map(f => f.name), classifications: ['internal'] }])) } } });
  assert.equal(validateOntologyReadPlans(draft).status, 'passed');
  const result = await executeOntologyReadPlan({ draft, plan: readPlan, target: 'RAW-N1', roleId: 'executive', scope: { tenantId: 'demo-enterprise', subjectId: 'demo:executive:chain', source: 'demo_header' },
    retrieve: async (type, query) => samples.records.filter(r => r.objectType === type.id && query.filter.values.includes(r.payload[query.filter.field])) });
  assert.deepEqual(Object.fromEntries(result.results.map(r => [r.id, r.value])), expected.directOnly);
  assert.ok(result.records.some(r => r.id === 'EDGE-N1')); assert.ok(!result.records.some(r => r.id === 'LOT-N4'));
  assert.notDeepEqual(expected.directOnly, expected.totals);
  const expanded = structuredClone(draft); expanded.scenario.readPlans[0].datasets.push({ id: 'children', objectType: 'FinishedLot', where: [{ field: 'lot_id', dataset: 'genealogy', sourceField: 'child_id' }] });
  assert.equal(validateOntologyReadPlans(expanded).status, 'failed');
});
test('responsibility, approval and root cause have independent evidence requirements', () => {
  assert.deepEqual(rows('Responsibility').filter(r => r.status === 'active').map(r => r.person_id).sort(), expected.contacts);
  assert.equal(rows('Approval')[0].status, 'approved'); assert.equal(rows('Approval')[0].execution_receipt, '');
  assert.equal(rows('QualityEvent')[0].conclusion, 'root_cause_unconfirmed');
  assert.equal(rows('Inspection')[0].status, 'retest_pending');
});

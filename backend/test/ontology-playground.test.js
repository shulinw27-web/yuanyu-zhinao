import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOntologyResultGraph } from '../src/services/ontology-result-graph.js';
import { relationshipDiff } from '../src/services/semantic-model-diff.js';
const draft = { objectTypes: [{ id: 'Supplier', label: '供应商', key: 'id' }, { id: 'Order', key: 'id', fieldDefinitions: [{ name: 'supplierId', reference: 'Supplier' }] }] };
const record = (type, id, payload) => ({ system: 'ERP', objectType: type, id, payload, version: 'v1', occurredAt: '2026-10-09' });
test('result graph uses only admitted instances and strict declared keys, never fabricated targets or payloads', () => {
  const records = [record('Order', 'O1', { id: 'O1', supplierId: 'S1', secret: 'payload-not-in-graph' }), record('Supplier', 'S1', { id: 'S1' }), record('Supplier', 'S2', { id: 'S2' })];
  const result = buildOntologyResultGraph(draft, records, 'v1', 'a'.repeat(24));
  assert.equal(result.objects.length, 3); assert.equal(result.relationships.length, 1); assert.ok(!JSON.stringify(result).includes('payload-not-in-graph'));
  assert.equal(buildOntologyResultGraph(draft, [records[0]], 'v1', 'a'.repeat(24)).relationships.length, 0);
  assert.equal(buildOntologyResultGraph(draft, [record('Order', 'O2', { supplierId: 1 }), record('Supplier', 'S3', { id: '1' })], 'v1', 'a'.repeat(24)).relationships.length, 0);
});
test('relation changes preserve before/after cardinality, evidence, mapping and explicit deletion mode', () => {
  const base = [{ from: 'Order', predicate: 'selects', to: 'Supplier', cardinality: '1:1', evidence: 'old' }];
  const candidate = [{ ...base[0], cardinality: 'n:1', evidence: 'revised' }];
  const result = relationshipDiff(base, candidate);
  assert.equal(result[0].change, 'updated'); assert.equal(result[0].before.cardinality, '1:1'); assert.equal(result[0].after.cardinality, 'n:1');
  assert.deepEqual(relationshipDiff(base, [], false), []); assert.equal(relationshipDiff(base, [], true)[0].change, 'removed');
});

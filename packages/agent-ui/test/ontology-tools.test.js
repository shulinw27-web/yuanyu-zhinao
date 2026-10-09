import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemMappingGraph, navigateOntologyQuestion, BUSINESS_TEMPLATES, previewBusinessTemplate, modelViewLink, readModelViewLink } from '../src/meta-model/ontology-tools.js';
import { exportOntologySubset, importOntologySubset } from '../src/meta-model/ontology-exchange.js';
const draft = { fingerprint: 'a'.repeat(24), objectTypes: [{ id: 'Supplier', label: '供应商', key: 'id', fields: ['id', 'name'], sourceSystems: ['ERP'] }, { id: 'PurchaseOrder', label: '采购订单', key: 'id', fields: ['id', 'supplierId'], sourceSystems: ['ERP', 'WMS'], fieldDefinitions: [{ name: 'supplierId', sourceField: 'supplier_id', mappingStatus: 'mapped', reference: 'Supplier' }] }], relationshipTypes: [{ from: 'PurchaseOrder', to: 'Supplier', predicate: 'selects', label: '选择', cardinality: 'n:1' }] };
test('mapping selection preserves declared cross-system reference endpoints without unfolding every field', () => {
  const graph = buildSystemMappingGraph(draft.objectTypes, 'PurchaseOrder');
  assert.equal(graph.objects.filter(item => item.label === '供应商').length, 1);
  assert.equal(graph.relationships.filter(item => item.predicate === 'references').length, 1);
  assert.ok(graph.objects.some(item => item.description?.includes('supplier_id')));
});
test('question navigation distinguishes model paths, ambiguous names and actual business quantities', () => {
  assert.equal(navigateOntologyQuestion(draft.objectTypes, draft.relationshipTypes, '采购订单与供应商有什么关系').mode, 'path');
  assert.equal(navigateOntologyQuestion(draft.objectTypes, draft.relationshipTypes, '供应商与采购订单有什么关系').mode, 'no_path');
  assert.equal(navigateOntologyQuestion(draft.objectTypes, draft.relationshipTypes, '采购订单有多少').mode, 'requires_business_read');
  assert.equal(navigateOntologyQuestion(draft.objectTypes, draft.relationshipTypes, '不知道').mode, 'needs_input');
  assert.equal(navigateOntologyQuestion([{ id: 'A', label: '订单' }, { id: 'B', label: '销售订单' }], [], '销售订单是什么').mode, 'explanation');
  assert.equal(navigateOntologyQuestion([{ id: 'C1', label: '客户' }, { id: 'C2', label: '客户' }], [], '两个客户有什么关系').mode, 'needs_input');
});
test('four templates are previews only and disclose existing identifier conflicts', () => {
  for (const template of BUSINESS_TEMPLATES) { const result = previewBusinessTemplate(template.id, draft); assert.equal(result.objects.length, 3); assert.equal(result.relationships.length, 2); assert.ok(result.objects.every(item => item.sourceSystems.length === 0)); }
  assert.ok(previewBusinessTemplate('procurement', draft).conflicts.includes('Supplier'));
  assert.equal(draft.objectTypes.length, 2);
});
test('model links carry no payload and reject stale, malformed and foreign object references', () => {
  const link = modelViewLink(draft.fingerprint, 'Supplier'); assert.equal(readModelViewLink(link, draft.fingerprint, draft.objectTypes).selectedId, 'Supplier');
  assert.ok(readModelViewLink(link, 'b'.repeat(24), draft.objectTypes).error);
  assert.ok(readModelViewLink(link, draft.fingerprint, []).error);
  assert.ok(readModelViewLink('#model-view=invalid', draft.fingerprint, []).error);
  assert.equal(readModelViewLink('#other', draft.fingerprint, []), null);
});
test('supported RDF JSON-LD subset roundtrips model structure and explicitly omits sensitive extensions', () => {
  const output = exportOntologySubset({ ...draft, accessPolicies: [{ token: 'do-not-export' }] });
  assert.ok(!JSON.stringify(output).includes('do-not-export'));
  const result = importOntologySubset(JSON.stringify(output.document));
  assert.deepEqual(result.objectTypes.map(item => [item.id, item.label, item.key, item.fields]), draft.objectTypes.map(item => [item.id, item.label, item.key, item.fields]));
  assert.deepEqual(result.relationshipTypes, draft.relationshipTypes); assert.ok(result.losses.length);
});
test('remote contexts, duplicates, dangling links, malformed fields and unsupported formats fail before import', () => {
  const doc = exportOntologySubset(draft).document;
  for (const mutate of [d => { d['@context'] = 'https://attacker.invalid/context'; }, d => d['@graph'].push(d['@graph'][0]), d => { d['@graph'][2]['rdfs:range']['@id'] = 'urn:yuanyu:ontology:Missing'; }, d => { d['@graph'][0]['yuanyu:fields'] = ['__proto__']; }]) { const bad = structuredClone(doc); mutate(bad); assert.throws(() => importOntologySubset(JSON.stringify(bad))); }
  assert.throws(() => importOntologySubset('<rdf:RDF/>')); assert.throws(() => importOntologySubset('x'.repeat(240001)));
  const unsupported = structuredClone(doc); unsupported['@graph'].push({ '@type': 'owl:Restriction' }); assert.ok(importOntologySubset(JSON.stringify(unsupported)).losses.some(item => item.includes('Restriction')));
});

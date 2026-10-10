import test from 'node:test'; import assert from 'node:assert/strict';
import { buildOntologyMockPack, ONTOLOGY_MOCK_PACKS } from '../src/meta-model/ontology-mock-packs.js';
import { navigateOntologyQuestion } from '../src/meta-model/ontology-tools.js';
import { exportOntologyProfile, importOntologyProfile } from '../src/meta-model/ontology-exchange-profiles.js';
test('four synthetic industry packs retain dictionaries, API, requirements, branches and expected outcomes; no grants', () => {
  for (const descriptor of ONTOLOGY_MOCK_PACKS) {
    const pack = buildOntologyMockPack(descriptor.id); assert.equal(pack.synthetic, true); assert.equal(pack.materials.length, 3); assert.equal(pack.systems.length, 3); assert.deepEqual(pack.grants, []);
    assert.match(pack.materials[1].text, /parent_id/); assert.equal(pack.acceptance.length, 2);
    assert.equal(pack.records.length, 4); assert.equal(pack.model.objectTypes.length, 3);
  }
});
test('business aliases, selected-object followup and model explanation never imply entity equivalence or actual quantities', () => {
  const objects = [{ id: 'MaterialBatch', label: '原料批次', aliases: ['来料'] }, { id: 'ProductionBatch', label: '生产批次' }]; const relationships = [{ from: 'MaterialBatch', to: 'ProductionBatch', predicate: 'usedIn' }];
  assert.equal(navigateOntologyQuestion(objects, relationships, '来料与生产批次有什么关系').mode, 'path');
  assert.equal(navigateOntologyQuestion(objects, relationships, '它与生产批次有什么关系', { selectedId: 'MaterialBatch' }).mode, 'path');
  assert.equal(navigateOntologyQuestion(objects, relationships, '解释来料').mode, 'explanation');
  assert.equal(navigateOntologyQuestion(objects, relationships, '物料批与生产批次有什么关系', { glossaryTerms: [{ term: '物料批', objectType: 'MaterialBatch' }] }).mode, 'path');
  assert.equal(navigateOntologyQuestion([...objects, { id: 'OtherBatch', label: '另一类来料', aliases: ['来料'] }], relationships, '来料与生产批次有什么关系').mode, 'needs_input');
  assert.equal(navigateOntologyQuestion(objects, relationships, '来料影响多少生产批次').mode, 'requires_business_read');
});

test('exchange profiles round-trip structural annotations without credentials or grants', () => {
  const draft = buildOntologyMockPack('procurement').model;
  draft.objectTypes[0].fieldDefinitions = [{ name: 'id', type: 'string', primaryKey: true, required: true, unit: 'kg', enumValues: ['A&B', 'c<d'], sourceField: 'private_id' }];
  draft.objectTypes[0].businessDomain = '采购';
  draft.credentials = { apiKey: 'never-export-this' }; draft.grants = ['never-grant'];
  draft.objectTypes[0].fieldDefinitions[0].enum = ['正常', '冻结'];
  draft.objectTypes[0].fieldDefinitions[0].reference = null; draft.objectTypes[0].fieldDefinitions[0].referenceField = null; draft.objectTypes[0].fieldDefinitions[0].description = null;
  for (const profile of ['platform-package', 'neutral-jsonld', 'playground-rdfxml', 'neutral-turtle']) {
    const file = exportOntologyProfile(draft, profile); assert.ok(!file.text.includes('never-export-this')); assert.ok(!file.text.includes('never-grant'));
    const imported = importOntologyProfile(file.text); assert.equal(imported.objectTypes.length, 3); assert.equal(imported.relationshipTypes.length, 2);
    assert.equal(imported.objectTypes[0].businessDomain, '采购');
    const field = imported.objectTypes[0].fieldDefinitions[0]; assert.equal(field.unit, 'kg'); assert.deepEqual(field.enumValues, ['A&B', 'c<d']);
    assert.deepEqual(field.enum, ['正常', '冻结']);
    assert.equal(field.sourceField, profile === 'platform-package' ? 'private_id' : undefined);
  }
});

test('generated relationship IRIs cannot alias legal class identifiers in any exchange profile', () => {
  const draft = { objectTypes: [{ id: 'relation_0', label: '合法对象', key: 'id', fields: ['id'] }], relationshipTypes: [{ from: 'relation_0', to: 'relation_0', predicate: 'links_to', cardinality: '1:n' }] };
  for (const profile of ['platform-package', 'neutral-jsonld', 'playground-rdfxml', 'neutral-turtle']) {
    const file = exportOntologyProfile(draft, profile);
    assert.ok(file.text.includes('urn:yuanyu:ontology:relationship/0'));
    const imported = importOntologyProfile(file.text);
    assert.equal(imported.objectTypes[0].id, 'relation_0');
    assert.deepEqual(imported.relationshipTypes.map(({ from, to, predicate }) => [from, to, predicate]), [['relation_0', 'relation_0', 'links_to']]);
  }
});

test('Turtle conversion rejects unsupported structures, ambiguity and invalid annotation types without network access', () => {
  const file = exportOntologyProfile(buildOntologyMockPack('procurement').model, 'neutral-turtle');
  assert.match(file.text, /owl:Class/u);
  for (const text of [file.text + '\n[] a owl:Restriction .', file.text.replace('yuanyu:key "id"', 'yuanyu:key 123'), file.text + '\nyuanyu:Supplier rdfs:label "重复" .', file.text.replace('yuanyu:fields', 'yuanyu:missingFields'), file.text.replace('urn:yuanyu:ontology:Receipt', 'urn:yuanyu:ontology:PurchaseOrder')]) assert.throws(() => importOntologyProfile(text));
  assert.throws(() => importOntologyProfile('x'.repeat(240001)), /240KB/u);
  const withUnsupported = importOntologyProfile(file.text + '\nyuanyu:PurchaseOrder owl:equivalentClass <https://example.invalid/Other> .');
  assert.ok(withUnsupported.losses.some(item => item.includes('equivalentClass')));
  assert.equal(withUnsupported.objectTypes.length, 3);
  const commented = importOntologyProfile('# 外部prefix不触发HTTP请求\n' + file.text);
  assert.equal(commented.profile, 'neutral-turtle');
});

test('XML exchange refuses entities, malformed markup, identity collisions and unsafe annotations', () => {
  const file = exportOntologyProfile(buildOntologyMockPack('procurement').model, 'playground-rdfxml');
  assert.throws(() => importOntologyProfile('<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + file.text), /DTD/);
  assert.throws(() => importOntologyProfile(file.text.replace('</rdf:RDF>', '</wrong>')));
  assert.throws(() => importOntologyProfile(file.text.replace('urn:yuanyu:ontology:Receipt', 'urn:yuanyu:ontology:PurchaseOrder')));
  const doc = JSON.parse(exportOntologyProfile(buildOntologyMockPack('procurement').model, 'platform-package').text); doc.metadata[0].apiKey = 'secret';
  assert.throws(() => importOntologyProfile(JSON.stringify(doc)), /注解/);
});

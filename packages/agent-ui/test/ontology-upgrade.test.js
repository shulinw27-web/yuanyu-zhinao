import test from 'node:test'; import assert from 'node:assert/strict';
import { buildOntologyMockPack, ONTOLOGY_MOCK_PACKS } from '../src/meta-model/ontology-mock-packs.js';
import { navigateOntologyQuestion } from '../src/meta-model/ontology-tools.js';
import { exportOntologyProfile, importOntologyProfile } from '../src/meta-model/ontology-exchange-profiles.js';
import { discoverMappingPaths } from '../src/meta-model/ontology-mapping-paths.js';

function pathFixture(pairs = [['Material', 'Stock'], ['Stock', 'Sale']]) {
  const draft = { objectTypes: [], relationshipTypes: [], scenario: { readPlans: [] } };
  for (const type of new Set(pairs.flat().concat(['Missing']))) draft.objectTypes.push({ id: type, key: 'code', fields: ['code'], sourceSystems: [type] });
  for (const [index, [from, to]] of pairs.entries()) {
    const id = `Lookup${index}`; const predicate = `mapped${index}`;
    draft.objectTypes.push({ id, key: 'left', fields: ['left', 'right', 'status', 'version', 'start', 'end'], sourceSystems: ['MDM'], fieldDefinitions: [{ name: 'left', reference: from, referenceField: 'code' }, { name: 'right', reference: to, referenceField: 'code' }] });
    draft.relationshipTypes.push({ from, to, predicate, keyMapping: { basis: 'master_data_lookup', lookupSource: id, fromField: 'code', toField: 'code', version: 'v1', owner: '合成维护岗' } });
    const mapping = { predicate, objectType: id, fromField: 'left', toField: 'right', statusField: 'status', versionField: 'version', validFromField: 'start', validToField: 'end', asOf: '2026-10-10T00:00:00Z' };
    draft.scenario.readPlans.push({ id: `plan${index}`, datasets: [{ id: 'root', objectType: from, where: [{ field: 'code', target: true }] }, { id: 'next', objectType: to, where: [{ field: 'code', dataset: 'root', sourceField: 'code', mapping }] }] });
  }
  return draft;
}
const pathSelection = { fromType: 'Material', fromField: 'code', toType: 'Sale', toField: 'code', maxDepth: 3 };

test('bounded mapping discovery joins only declared fields at one UTC point, without model writes or synthesized reverse edges', () => {
  const draft = pathFixture(); const before = JSON.stringify(draft);
  const result = discoverMappingPaths(draft, pathSelection);
  assert.equal(result.status, 'candidate'); assert.equal(result.execution, 'none'); assert.equal(result.uniqueWithinBoundOnly, true);
  assert.deepEqual(result.paths[0].steps.map(step => step.lookupObject), ['Lookup0', 'Lookup1']);
  assert.deepEqual(result.paths[0].steps[1].declarations, [{ planId: 'plan1', datasetId: 'next' }]);
  assert.equal(JSON.stringify(draft), before);
  assert.equal(discoverMappingPaths(draft, { ...pathSelection, fromType: 'Sale', toType: 'Material' }).status, 'not_found');
  assert.equal(discoverMappingPaths(draft, { ...pathSelection, maxDepth: 1 }).status, 'not_found');
  assert.ok(discoverMappingPaths(draft, { ...pathSelection, maxDepth: 1 }).depthCuts > 0);
});

test('explicit reverse declarations retain business relation direction and mapping evidence', () => {
  const draft = pathFixture();
  for (const plan of draft.scenario.readPlans) {
    const [root, next] = plan.datasets; [root.objectType, next.objectType] = [next.objectType, root.objectType]; next.where[0].mapping.direction = 'reverse';
  }
  const result = discoverMappingPaths(draft, { ...pathSelection, fromType: 'Sale', toType: 'Material' });
  assert.equal(result.status, 'candidate'); assert.ok(result.paths[0].steps.every(step => step.direction === 'reverse'));
  assert.equal(draft.relationshipTypes[0].from, 'Material');
});

test('multiple conversion routes are ambiguous, while duplicate declarations do not invent a second route', () => {
  const draft = pathFixture([['Material', 'Stock'], ['Stock', 'Sale'], ['Material', 'Sale']]);
  assert.equal(discoverMappingPaths(draft, pathSelection).status, 'ambiguous');
  const one = pathFixture(); const duplicate = structuredClone(one.scenario.readPlans[0]); duplicate.id = 'duplicate'; one.scenario.readPlans.push(duplicate);
  const result = discoverMappingPaths(one, pathSelection); assert.equal(result.status, 'candidate'); assert.equal(result.paths[0].steps[0].declarations.length, 2);
});

test('cycles terminate and incompatible times or different intermediate fields are not converted', () => {
  const draft = pathFixture([['Material', 'Stock'], ['Stock', 'Material'], ['Stock', 'Sale']]);
  const result = discoverMappingPaths(draft, pathSelection); assert.equal(result.status, 'candidate'); assert.equal(result.cyclesSkipped, 1);
  const changed = pathFixture(); changed.scenario.readPlans[1].datasets[1].where[0].mapping.asOf = '2026-10-11T00:00:00Z';
  assert.equal(discoverMappingPaths(changed, pathSelection).status, 'not_found'); assert.equal(discoverMappingPaths(changed, pathSelection).timeConflicts, 1);
  const different = pathFixture(); different.objectTypes.find(type => type.id === 'Stock').fields.push('otherCode');
  different.scenario.readPlans[1].datasets[1].where[0].sourceField = 'otherCode'; different.relationshipTypes[1].keyMapping.fromField = 'otherCode';
  different.objectTypes.find(type => type.id === 'Lookup1').fieldDefinitions[0].referenceField = 'otherCode';
  assert.equal(discoverMappingPaths(different, pathSelection).status, 'not_found');
});

test('different filters and preconditions remain distinct declarations, not a falsely unique conversion', () => {
  const draft = pathFixture(); const filtered = structuredClone(draft.scenario.readPlans[0]); filtered.id = 'filtered';
  filtered.datasets[1].filter = { field: 'code', values: ['synthetic-code'] }; draft.scenario.readPlans.push(filtered);
  const result = discoverMappingPaths(draft, pathSelection); assert.equal(result.status, 'ambiguous');
  assert.ok(result.paths.some(path => path.steps[0].requiresConstraintReview));
  delete filtered.datasets[1].filter; filtered.preconditions = [{ op: 'literal', value: false }];
  assert.equal(discoverMappingPaths(draft, pathSelection).status, 'ambiguous');
  filtered.id = draft.scenario.readPlans[0].id;
  assert.equal(discoverMappingPaths(draft, pathSelection).status, 'rejected');
});

test('malformed, scripted, duplicate and undeclared mapping bindings fail before producing any path', () => {
  for (const mutate of [
    draft => { draft.scenario.readPlans[0].datasets[1].where[0].mapping.script = 'untrusted'; },
    draft => { draft.scenario.readPlans[0].datasets[1].where[0].mapping = 0; },
    draft => { draft.scenario.readPlans[0].datasets[1].where[0].script = 'untrusted'; },
    draft => { draft.scenario.readPlans[0].datasets.push(null); },
    draft => { draft.objectTypes.find(type => type.id === 'Lookup0').fieldDefinitions = {}; },
    draft => { draft.relationshipTypes.push(structuredClone(draft.relationshipTypes[0])); },
    draft => { draft.objectTypes.find(type => type.id === 'Lookup0').fieldDefinitions = []; }
  ]) { const draft = pathFixture(); mutate(draft); const result = discoverMappingPaths(draft, pathSelection); assert.equal(result.status, 'rejected'); assert.deepEqual(result.paths, []); }
  assert.equal(discoverMappingPaths(pathFixture(), { ...pathSelection, maxDepth: 5 }).status, 'rejected');
  assert.equal(discoverMappingPaths(pathFixture(), { ...pathSelection, script: 'ignored?' }).status, 'rejected');
});

test('fanout search exhausts its hard budget and suppresses partial paths rather than choosing one', () => {
  const layers = [['Material'], ...Array.from({ length: 4 }, (_, layer) => Array.from({ length: 9 }, (_, index) => `Layer${layer}_${index}`))];
  const pairs = [];
  for (let layer = 1; layer < layers.length; layer++) for (const from of layers[layer - 1]) for (const to of layers[layer]) pairs.push([from, to]);
  const draft = pathFixture(pairs); const originals = draft.scenario.readPlans; draft.scenario.readPlans = [];
  for (let offset = 0; offset < originals.length; offset += 4) {
    const datasets = originals.slice(offset, offset + 4).flatMap((plan, index) => {
      const [root, next] = structuredClone(plan.datasets); root.id = `root${index}`; next.id = `next${index}`; next.where[0].dataset = root.id; return [root, next];
    }); draft.scenario.readPlans.push({ id: `bundle${offset}`, datasets });
  }
  const result = discoverMappingPaths(draft, { ...pathSelection, toType: 'Missing', maxDepth: 4 });
  assert.equal(result.code, 'MAPPING_PATH_SEARCH_LIMIT'); assert.deepEqual(result.paths, []); assert.equal(result.execution, 'none');
});
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

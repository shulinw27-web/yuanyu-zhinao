import test from 'node:test'; import assert from 'node:assert/strict';
import { buildOntologyMockPack, ONTOLOGY_MOCK_PACKS } from '@healthcare-ai/agent-ui/ontology-mock-packs';
import { buildOntologyResultGraph } from '../src/services/ontology-result-graph.js';
import { validateOntologyReadPlans, executeOntologyReadPlan, ontologyQueryFingerprint } from '../src/services/ontology-read-plan-service.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft, validateOAMetaModelDraft, simulateBuildOAMetaModel } from '../src/services/meta-model-service.js';
import { runOntologyReadReplay, publishGovernedOntology } from '../src/services/ontology-runtime-service.js';
import { getPublishedAgentOntology, runPublishedOntologyRead } from '../src/services/published-ontology-agent-service.js';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { getRole } from '../src/services/authorization-service.js';
import { proposeOntologyMapping } from '@healthcare-ai/agent-ui/ontology-mapping-wizard';
import { validateOntologyContract } from '../src/services/ontology-contract-service.js';

test('read validation returns exact dataset/output location and governance validation supplies section targets', t => {
  const f = mappingFixture(t); f.plan.datasets[1].where[0].field = 'notDeclared';
  const report = validateOntologyReadPlans(f.draft); assert.equal(report.code, 'READ_FIELD_UNKNOWN');
  assert.deepEqual(report.targets, [{ kind: 'section', section: 'readPlans', index: 0, datasetId: 'stock', field: 'where' }]);
  const draft = { ...f.draft, stateMachines: [{ object: 'Material', states: ['created'], initial: 'missing', terminal: [] }], modelingProfile: 'general' };
  const checks = validateOntologyContract(draft); assert.ok(checks.find(check => check.name === '状态机引用').targets.some(target => target.section === 'stateMachines' && target.index === 0));
});

function mappingFixture(t) {
  const previous = process.env.ONTOLOGY_RUNTIME_GRANTS_JSON;
  t.after(() => { if (previous === undefined) delete process.env.ONTOLOGY_RUNTIME_GRANTS_JSON; else process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = previous; });
  const scope = { tenantId: 'demo-enterprise', subjectId: 'demo:executive:mapping-test', source: 'demo_header' };
  const objectTypes = [
    { id: 'Material', key: 'id', fields: ['id'], sourceSystems: ['ERP'] },
    { id: 'Stock', key: 'id', fields: ['id', 'sku', 'qty'], sourceSystems: ['WMS'] },
    { id: 'Crosswalk', key: 'id', fields: ['id', 'erp', 'wms', 'status', 'revision', 'start', 'end'], sourceSystems: ['MDM'], fieldDefinitions: [{ name: 'erp', reference: 'Material', referenceField: 'id' }, { name: 'wms', reference: 'Stock', referenceField: 'sku' }] }
  ];
  const relation = { from: 'Material', to: 'Stock', predicate: 'stored_as', keyMapping: { fromField: 'id', toField: 'sku', basis: 'master_data_lookup', lookupSource: 'Crosswalk', owner: 'mock', version: 'map-v1' } };
  const plan = { id: 'mapped_stock', label: '映射库存', datasets: [{ id: 'material', objectType: 'Material', where: [{ field: 'id', target: true }] }, { id: 'stock', objectType: 'Stock', where: [{ field: 'sku', dataset: 'material', sourceField: 'id', mapping: { predicate: 'stored_as', objectType: 'Crosswalk', fromField: 'erp', toField: 'wms', statusField: 'status', versionField: 'revision', validFromField: 'start', validToField: 'end', asOf: '2026-10-09T00:00:00Z' } }] }], outputs: [{ id: 'qty', label: '库存', unit: '件', expression: { op: 'sum', dataset: 'stock', value: { op: 'field', dataset: 'stock', field: 'qty' } } }] };
  const draft = { objectTypes, relationshipTypes: [relation], accessPolicies: objectTypes.map(type => ({ objectType: type.id, roles: ['executive'], effect: 'allow', condition: 'iam_scope' })), scenario: { requireCaseReplay: true, decisionBindings: [], readPlans: [plan] } };
  process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ 'demo-enterprise': { executive: { objects: Object.fromEntries(objectTypes.map(type => [type.id, { system: type.sourceSystems[0], fields: type.fields, classifications: ['internal'] }])) } } });
  const record = (objectType, id, payload) => ({ id, objectType, system: objectTypes.find(type => type.id === objectType).sourceSystems[0], tenantId: scope.tenantId, organizationId: 'org-quality-dept', classification: 'internal', version: 'snapshot-v1', occurredAt: '2026-10-08T00:00:00Z', payload });
  const records = [record('Material', 'ERP-001', { id: 'ERP-001' }), record('Crosswalk', 'MAP-1', { id: 'MAP-1', erp: 'ERP-001', wms: 'SKU-900', status: 'confirmed', revision: 'map-v1', start: '2026-10-01T00:00:00Z', end: null }), record('Stock', 'STOCK-1', { id: 'STOCK-1', sku: 'SKU-900', qty: 42 })];
  const queries = [];
  const run = () => executeOntologyReadPlan({ draft, plan, target: 'ERP-001', roleId: 'executive', scope, retrieve: async (type, query) => { queries.push(query); return records.filter(row => row.objectType === type.id && query.filter.values.includes(row.payload[query.filter.field])); } });
  return { draft, plan, records, queries, run, scope };
}

function chainedMappingFixture(t) {
  const f = mappingFixture(t);
  const sale = { id: 'Sale', key: 'id', fields: ['id', 'product', 'amount'], sourceSystems: ['POS'] };
  const lookup = { id: 'SalesCrosswalk', key: 'id', fields: ['id', 'sku', 'product', 'status', 'revision', 'start', 'end'], sourceSystems: ['MDM'], fieldDefinitions: [{ name: 'sku', reference: 'Stock', referenceField: 'sku' }, { name: 'product', reference: 'Sale', referenceField: 'product' }] };
  f.draft.objectTypes.push(sale, lookup);
  f.draft.relationshipTypes.push({ from: 'Stock', to: 'Sale', predicate: 'sold_as', keyMapping: { fromField: 'sku', toField: 'product', basis: 'master_data_lookup', lookupSource: 'SalesCrosswalk', owner: 'mock', version: 'sales-v1' } });
  f.draft.accessPolicies.push(...[sale, lookup].map(type => ({ objectType: type.id, roles: ['executive'], effect: 'allow', condition: 'iam_scope' })));
  const grants = JSON.parse(process.env.ONTOLOGY_RUNTIME_GRANTS_JSON);
  for (const type of [sale, lookup]) grants['demo-enterprise'].executive.objects[type.id] = { system: type.sourceSystems[0], fields: type.fields, classifications: ['internal'] };
  process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(grants);
  const meta = { tenantId: f.scope.tenantId, organizationId: 'org-quality-dept', classification: 'internal', version: 'snapshot-v1', occurredAt: '2026-10-08T00:00:00Z' };
  f.records.push({ ...meta, id: 'SMAP-1', objectType: lookup.id, system: 'MDM', payload: { id: 'SMAP-1', sku: 'SKU-900', product: 'POS-77', status: 'confirmed', revision: 'sales-v1', start: '2026-10-01T00:00:00Z', end: null } }, { ...meta, id: 'SALE-1', objectType: sale.id, system: 'POS', payload: { id: 'SALE-1', product: 'POS-77', amount: 120 } });
  f.plan.datasets.push({ id: 'sales', objectType: 'Sale', where: [{ field: 'product', dataset: 'stock', sourceField: 'sku', mapping: { predicate: 'sold_as', objectType: 'SalesCrosswalk', fromField: 'sku', toField: 'product', statusField: 'status', versionField: 'revision', validFromField: 'start', validToField: 'end', asOf: '2026-10-09T00:00:00Z' } }] });
  f.plan.outputs.push({ id: 'sales_amount', label: '关联销售额', unit: '元', expression: { op: 'sum', dataset: 'sales', value: { op: 'field', dataset: 'sales', field: 'amount' } } });
  return f;
}

test('explicit ERP→MDM→WMS→MDM→POS chain keeps independent crosswalk versions and evidence at both hops', async t => {
  const f = chainedMappingFixture(t);
  assert.equal(validateOntologyReadPlans(f.draft).status, 'passed');
  const result = await f.run();
  assert.deepEqual(result.results.map(item => item.value), [42, 120]);
  assert.equal(result.coverage.mappings, 2); assert.equal(result.executionAuthorized, false);
  assert.deepEqual(f.queries.map(query => query.objectType), ['Material', 'Crosswalk', 'Stock', 'SalesCrosswalk', 'Sale']);
  assert.deepEqual(f.queries.at(-1).filter, { field: 'product', values: ['POS-77'] });
  const graph = buildOntologyResultGraph(f.draft, result.records, 'mock-v1', 'mock-fp', [result.mappingEvidence]);
  assert.equal(graph.relationshipCoverage.filter(item => item.status === 'requires_mapping_execution').length, 0);
});

test('explicit POS→WMS→ERP reverse chain uses declared mapping direction rather than guessing business codes', async t => {
  const f = chainedMappingFixture(t);
  const salesMapping = f.plan.datasets[2].where[0].mapping;
  const stockMapping = f.plan.datasets[1].where[0].mapping;
  f.plan.datasets = [{ id: 'sales', objectType: 'Sale', where: [{ field: 'id', target: true }] },
    { id: 'stock', objectType: 'Stock', where: [{ field: 'sku', dataset: 'sales', sourceField: 'product', mapping: { ...salesMapping, direction: 'reverse' } }] },
    { id: 'material', objectType: 'Material', where: [{ field: 'id', dataset: 'stock', sourceField: 'sku', mapping: { ...stockMapping, direction: 'reverse' } }] }];
  const queried = [];
  const result = await executeOntologyReadPlan({ draft: f.draft, plan: f.plan, target: 'SALE-1', roleId: 'executive', scope: f.scope, retrieve: async (type, query) => { queried.push(query); return f.records.filter(row => row.objectType === type.id && query.filter.values.includes(row.payload[query.filter.field])); } });
  assert.deepEqual(result.results.map(item => item.value), [42, 120]); assert.equal(result.coverage.mappings, 2);
  assert.deepEqual(queried.at(-1).filter, { field: 'id', values: ['ERP-001'] });
});

test('second-hop missing, unconfirmed, expired or conflicting crosswalk never yields partial financial outputs', async t => {
  for (const scenario of ['missing', 'unconfirmed', 'expired', 'conflict']) {
    await t.test(scenario, async subtest => {
    const f = chainedMappingFixture(subtest); const row = f.records.find(item => item.objectType === 'SalesCrosswalk');
    if (scenario === 'missing') f.records.splice(f.records.indexOf(row), 1);
    if (scenario === 'unconfirmed') row.payload.status = 'pending';
    if (scenario === 'expired') row.payload.end = '2026-10-08T00:00:00Z';
    if (scenario === 'conflict') f.records.push({ ...row, id: 'SMAP-2', payload: { ...row.payload, id: 'SMAP-2', product: 'POS-OTHER' } });
    await assert.rejects(f.run(), new RegExp({ missing: 'READ_MAPPING_MISSING', unconfirmed: 'READ_MAPPING_UNCONFIRMED', expired: 'READ_MAPPING_EXPIRED', conflict: 'READ_MAPPING_CONFLICT' }[scenario]));
    assert.ok(!f.queries.some(query => query.objectType === 'Sale'));
    });
  }
});

test('chain preflights all target and lookup permissions before requesting any upstream data', async t => {
  const f = chainedMappingFixture(t); const grants = JSON.parse(process.env.ONTOLOGY_RUNTIME_GRANTS_JSON);
  delete grants['demo-enterprise'].executive.objects.SalesCrosswalk;
  process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(grants);
  await assert.rejects(f.run(), /READ_OBJECT_FORBIDDEN/); assert.deepEqual(f.queries, []);
});

test('server mapping binding rejects script, URL and recursive extension keys before any retrieval', async t => {
  const f = mappingFixture(t); const original = structuredClone(f.plan.datasets[1].where[0].mapping);
  for (const extra of [{ script: 'return input' }, { url: 'https://invalid.example/mapping' }, { recursive: true }, { maxDepth: 100 }]) {
    f.plan.datasets[1].where[0].mapping = { ...original, ...extra };
    assert.equal(validateOntologyReadPlans(f.draft).code, 'READ_MAPPING_BINDING_INVALID');
    await assert.rejects(f.run(), /READ_PLAN_INVALID/); assert.equal(f.queries.length, 0);
  }
});

test('visual wizard proposal satisfies the server contract and executes the same authorized crosswalk', async t => {
  const f = mappingFixture(t); const clause = f.plan.datasets[1].where[0];
  const candidate = proposeOntologyMapping(f.draft, { relationKey: JSON.stringify(['Material', 'stored_as', 'Stock']), joinKey: JSON.stringify([f.plan.id, 'stock']), ...clause.mapping, owner: '维护岗', version: 'map-v1' });
  assert.equal(validateOntologyReadPlans(candidate.draft).status, 'passed');
  const result = await executeOntologyReadPlan({ draft: candidate.draft, plan: candidate.draft.scenario.readPlans[0], target: 'ERP-001', roleId: 'executive', scope: f.scope, retrieve: async (type, query) => f.records.filter(row => row.objectType === type.id && query.filter.values.includes(row.payload[query.filter.field])) });
  assert.equal(result.results[0].value, 42);
});

test('reverse crosswalk is explicit, uses original key references and preserves business edge direction', async t => {
  const f = mappingFixture(t); const binding = { ...f.plan.datasets[1].where[0].mapping, direction: 'reverse' };
  f.plan.datasets = [{ id: 'stock', objectType: 'Stock', where: [{ field: 'id', target: true }] }, { id: 'material', objectType: 'Material', where: [{ field: 'id', dataset: 'stock', sourceField: 'sku', mapping: binding }] }];
  f.plan.outputs = [{ id: 'materials', label: '原料数', unit: '项', expression: { op: 'sum', dataset: 'material', value: { op: 'literal', value: 1 } } }];
  assert.equal(validateOntologyReadPlans(f.draft).status, 'passed', JSON.stringify(validateOntologyReadPlans(f.draft)));
  const candidate = proposeOntologyMapping(f.draft, { relationKey: JSON.stringify(['Material', 'stored_as', 'Stock']), joinKey: JSON.stringify([f.plan.id, 'material']), ...binding, owner: '维护岗', version: 'map-v1' });
  assert.equal(candidate.draft.scenario.readPlans[0].datasets[1].where[0].mapping.direction, 'reverse');
  assert.deepEqual(candidate.draft.relationshipTypes[0].keyMapping, { ...f.draft.relationshipTypes[0].keyMapping, owner: '维护岗' });
  const queries = [];
  const run = () => executeOntologyReadPlan({ draft: f.draft, plan: f.plan, target: 'STOCK-1', roleId: 'executive', scope: f.scope, retrieve: async (type, query) => { queries.push(query); return f.records.filter(row => row.objectType === type.id && query.filter.values.includes(row.payload[query.filter.field])); } });
  const result = await run(); assert.equal(result.results[0].value, 1);
  assert.equal(queries.find(query => query.objectType === 'Crosswalk').filter.field, 'wms');
  const graph = buildOntologyResultGraph(f.draft, result.records, 'mock-v1', 'mock-fp', [result.mappingEvidence]);
  const relation = graph.relationships.find(item => item.predicate === 'stored_as'); assert.ok(relation);
  assert.equal(relation.from, JSON.stringify(['instance', 'ERP', 'Material', 'ERP-001']));
  assert.equal(relation.to, JSON.stringify(['instance', 'WMS', 'Stock', 'STOCK-1']));
  delete binding.direction; assert.equal(validateOntologyReadPlans(f.draft).code, 'READ_MAPPING_RELATION_INVALID');
  binding.direction = 'guess'; assert.equal(validateOntologyReadPlans(f.draft).code, 'READ_MAPPING_DIRECTION_INVALID');
  binding.direction = 'reverse';
  f.records.push({ ...structuredClone(f.records[1]), id: 'MAP-2', payload: { ...f.records[1].payload, id: 'MAP-2', erp: 'ERP-002' } });
  await assert.rejects(run, /READ_MAPPING_CONFLICT/u);
});

test('crosswalk survives reviewed draft, replay and publication, then drives the published Agent connector path', async t => {
  const f = mappingFixture(t); resetRuntimeState(['oa_meta_model_runtime', 'ontology_publication', 'domain_event_outbox']);
  f.draft.objectTypes[0].fields.push('name'); f.records[0].payload.name = '合成原料';
  const fixtureGrants = JSON.parse(process.env.ONTOLOGY_RUNTIME_GRANTS_JSON); fixtureGrants['demo-enterprise'].executive.objects.Material.fields.push('name');
  process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(fixtureGrants);
  const previousFetch = globalThis.fetch; const previousConnectors = process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON;
  t.after(() => { globalThis.fetch = previousFetch; if (previousConnectors === undefined) delete process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON; else process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = previousConnectors; });
  const objects = f.draft.objectTypes.map(type => ({ ...type, label: type.id, source: `mock.${type.sourceSystems[0]}.${type.id}`, coreObject: type.id, classification: '内部', fieldDefinitions: type.fields.map(name => ({ name, type: name === 'qty' ? 'number' : 'string', ...(type.fieldDefinitions?.find(field => field.name === name) || {}), ...(name === 'id' ? { primaryKey: true } : {}) })) }));
  const definition = { ...f.draft, objectTypes: objects, modelingProfile: 'general', scenario: { ...f.draft.scenario, objective: '合成主数据映射查询', questions: ['原料对应库存多少？'], actionBindings: [] }, policies: ['只读合成演练'], stateMachines: [], events: [], metrics: [], glossaryTerms: [{ term: '库存', definition: '选定原料映射后的授权库存', objectType: 'Stock' }], dataContracts: objects.map(o => ({ id: o.id, objectType: o.id, sourceSystem: o.sourceSystems[0], schemaVersion: 'mock-v1' })), qualityRules: objects.map(o => ({ id: o.id, objectType: o.id, rule: 'not_null' })), lineageEdges: objects.map(o => ({ from: o.source, to: o.id })) };
  const grants = JSON.parse(process.env.ONTOLOGY_RUNTIME_GRANTS_JSON); grants['demo-enterprise'].executive.metadata = true;
  process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(grants);
  const role = getRole('executive'); assert.ok(!(await saveOAMetaModelDraft(definition, role)).error);
  const savedDraft = await getOAMetaModelDraft(); assert.deepEqual(savedDraft.relationshipTypes[0].keyMapping, f.draft.relationshipTypes[0].keyMapping);
  const invalid = structuredClone(definition); invalid.relationshipTypes[0].keyMapping = { basis: 'master_data_lookup' };
  assert.equal((await saveOAMetaModelDraft(invalid, role)).code, 'READ_MAPPING_BINDING_INVALID');
  assert.equal((await getOAMetaModelDraft()).fingerprint, savedDraft.fingerprint);
  const validated = await validateOAMetaModelDraft(role); assert.equal(validated.draft.validation.status, 'passed', JSON.stringify(validated.draft.validation));
  await simulateBuildOAMetaModel(role); const candidateFingerprint = (await getOAMetaModelDraft()).fingerprint;
  const replay = await runOntologyReadReplay({ role, identityScope: f.scope, body: { candidateFingerprint, cases: [{ planId: f.plan.id, target: 'ERP-001', records: f.records, expected: { qty: 42 } }, { planId: f.plan.id, target: 'ERP-001', records: f.records.filter(row => row.objectType !== 'Crosswalk'), expectedError: 'READ_MAPPING_MISSING' }] } });
  assert.equal(replay.status, 'passed', JSON.stringify(replay));
  assert.ok(!(await publishGovernedOntology({ role, identityScope: f.scope, deploy: async (_candidate, version) => ({ status: 'published', deployment: { sourceFingerprint: candidateFingerprint, version } }) })).error);
  const ontology = await getPublishedAgentOntology('executive', f.scope); assert.ok(ontology);
  process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = JSON.stringify(Object.fromEntries(['erp', 'wms', 'mdm'].map(system => [system, { endpoint: 'http://127.0.0.1:19998' }])));
  globalThis.fetch = async (_url, request) => { const { query } = JSON.parse(request.body); return new Response(JSON.stringify({ records: f.records.filter(row => row.objectType === query.objectType && query.filter.values.includes(row.payload[query.filter.field])), queryCoverage: { schemaVersion: 'ontology-query.v1', complete: true, queryFingerprint: ontologyQueryFingerprint(query) } })); };
  const result = await runPublishedOntologyRead({ ontology, roleId: 'executive', scope: f.scope, target: 'ERP-001', planId: f.plan.id, allowModelAnalysis: false });
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.results[0].value, 42);
  assert.equal(result.graph.relationshipCoverage[0].status, 'mapped_in_snapshot');
  assert.equal(result.graph.relationships.filter(edge => edge.predicate === 'stored_as').length, 1);
});

test('authorized crosswalk converts different ERP/WMS identifiers and emits snapshot-bound graph evidence', async t => {
  const f = mappingFixture(t); assert.equal(validateOntologyReadPlans(f.draft).status, 'passed');
  const result = await f.run(); assert.equal(result.results[0].value, 42);
  assert.deepEqual(f.queries.map(query => query.objectType), ['Material', 'Crosswalk', 'Stock']);
  assert.deepEqual(f.queries[2].filter.values, ['SKU-900']);
  assert.equal(result.executionAuthorized, false);
  const graph = buildOntologyResultGraph(f.draft, result.records, 'v1', 'fp', [result.mappingEvidence]);
  assert.equal(graph.relationshipCoverage[0].status, 'mapped_in_snapshot');
  assert.equal(graph.relationships.filter(edge => edge.predicate === 'stored_as').length, 1);
  assert.equal(buildOntologyResultGraph(f.draft, result.records, 'v1', 'fp', [{}]).relationshipCoverage[0].status, 'requires_mapping_execution');
  const changed = structuredClone(result.records); changed[0].version = 'snapshot-v2';
  assert.equal(buildOntologyResultGraph(f.draft, changed, 'v1', 'fp', [result.mappingEvidence]).relationshipCoverage[0].status, 'requires_mapping_execution');
  const changedModel = structuredClone(f.draft); changedModel.relationshipTypes[0].keyMapping.version = 'map-v2';
  assert.equal(buildOntologyResultGraph(changedModel, result.records, 'v2', 'fp2', [result.mappingEvidence]).relationshipCoverage[0].status, 'requires_mapping_execution');
});

test('missing, unconfirmed, conflicting, expired and wrong-version mappings fail without reading WMS', async t => {
  const f = mappingFixture(t); const original = structuredClone(f.records);
  for (const [code, mutate] of [
    ['READ_MAPPING_MISSING', rows => rows.splice(1, 1)],
    ['READ_MAPPING_UNCONFIRMED', rows => { rows[1].payload.status = 'inferred'; }],
    ['READ_MAPPING_CONFLICT', rows => rows.push({ ...structuredClone(rows[1]), id: 'MAP-2', payload: { ...rows[1].payload, id: 'MAP-2', wms: 'SKU-901' } })],
    ['READ_MAPPING_EXPIRED', rows => { rows[1].payload.end = '2026-10-09T00:00:00Z'; }],
    ['READ_MAPPING_VERSION_MISMATCH', rows => { rows[1].payload.revision = 'map-v0'; }],
    ['READ_MAPPING_TIME_INVALID', rows => { rows[1].occurredAt = '2026-10-10T00:00:00Z'; }]
  ]) {
    f.records.splice(0, f.records.length, ...structuredClone(original)); f.queries.length = 0; mutate(f.records);
    await assert.rejects(f.run(), new RegExp(code)); assert.ok(!f.queries.some(query => query.objectType === 'Stock'));
  }
});

test('mapping object grants are preflighted; foreign mapping rows and dangling targets fail closed', async t => {
  const f = mappingFixture(t); const saved = process.env.ONTOLOGY_RUNTIME_GRANTS_JSON; const grants = JSON.parse(saved);
  delete grants['demo-enterprise'].executive.objects.Crosswalk; process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(grants);
  await assert.rejects(f.run(), /READ_OBJECT_FORBIDDEN/); assert.equal(f.queries.length, 0);
  process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = saved;
  f.records[1].tenantId = 'foreign'; await assert.rejects(f.run(), /READ_RECORD_SCOPE/);
  f.records[1].tenantId = 'demo-enterprise'; f.records.splice(2, 1);
  await assert.rejects(f.run(), /READ_MAPPING_TARGET_MISSING/);
});

test('mapping bindings reject arbitrary source URLs, absent references, and unversioned definitions', t => {
  const f = mappingFixture(t); const original = structuredClone(f.draft);
  for (const mutate of [draft => { draft.relationshipTypes[0].keyMapping.lookupSource = 'http://localhost/admin'; }, draft => { draft.objectTypes[2].fieldDefinitions = []; }, draft => { draft.relationshipTypes[0].keyMapping.version = ''; }]) {
    const draft = structuredClone(original); mutate(draft); assert.equal(validateOntologyReadPlans(draft).status, 'failed');
  }
});

test('revoking crosswalk access during target retrieval rejects the result instead of issuing usable evidence', async t => {
  const f = mappingFixture(t);
  await assert.rejects(executeOntologyReadPlan({ draft: f.draft, plan: f.plan, target: 'ERP-001', roleId: 'executive', scope: f.scope, retrieve: async (type, query) => {
    const rows = f.records.filter(record => record.objectType === type.id && query.filter.values.includes(record.payload[query.filter.field]));
    if (type.id === 'Stock') { const grants = JSON.parse(process.env.ONTOLOGY_RUNTIME_GRANTS_JSON); delete grants['demo-enterprise'].executive.objects.Crosswalk; process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(grants); }
    return rows;
  } }), /READ_OBJECT_FORBIDDEN/);
});
test('all four multi-system Mock packs project admitted records using published business relationships', () => {
  for (const descriptor of ONTOLOGY_MOCK_PACKS) {
    const pack = buildOntologyMockPack(descriptor.id);
    const graph = buildOntologyResultGraph(pack.model, pack.records, 'mock', 'a'.repeat(24));
    assert.equal(graph.objects.length, 4); assert.equal(graph.relationshipCoverage[0].matchedPairs, 2); assert.equal(graph.relationshipCoverage[1].matchedPairs, 1);
    assert.equal(graph.globalEnterpriseCoverage, false); assert.ok(graph.relationships.some(edge => edge.predicate === pack.model.relationshipTypes[0].predicate));
  }
});
test('published relationships refuse ambiguous or unevaluated lookup mappings; absent types never leak', () => {
  const pack = buildOntologyMockPack('procurement'); pack.model.relationshipTypes[0].keyMapping = { basis: 'master_data_lookup' };
  const graph = buildOntologyResultGraph(pack.model, pack.records, 'v1', 'a'.repeat(24)); assert.equal(graph.relationshipCoverage[0].status, 'requires_mapping_execution');
  assert.ok(!graph.relationships.some(edge => edge.predicate === pack.model.relationshipTypes[0].predicate));
  assert.ok(!graph.relationships.some(edge => edge.predicate === 'reference_parent_id' && edge.from.includes(pack.records[1].id)));
  assert.equal(graph.relationships.filter(edge => edge.predicate === 'reference_parent_id').length, 1, 'unrelated terminal foreign key remains visible');
  assert.equal(buildOntologyResultGraph(pack.model, [pack.records[0]], 'v1', 'a'.repeat(24)).relationshipCoverage.length, 0);
  delete pack.model.relationshipTypes[0].keyMapping;
  pack.model.objectTypes[1].fieldDefinitions.push({ name: 'other_parent', reference: pack.model.objectTypes[0].id, referenceField: 'id' });
  assert.equal(buildOntologyResultGraph(pack.model, pack.records, 'v1', 'a'.repeat(24)).relationshipCoverage[0].status, 'ambiguous_mapping');
});

test('recursive expansion cannot use mapping-dependent equality, while independent fields still work', () => {
  const model = { objectTypes: [
    { id: 'Node', key: 'id', fields: ['id'], sourceSystems: ['ERP'] },
    { id: 'Edge', key: 'id', fields: ['id', 'from_id', 'to_id', 'status'], sourceSystems: ['ERP'], fieldDefinitions: ['from_id', 'to_id'].map(name => ({ name, reference: 'Node', referenceField: 'id' })) }
  ], relationshipTypes: [], scenario: { requireCaseReplay: true, decisionBindings: [], readPlans: [{ id: 'expand', label: '受控扩展', datasets: [{ id: 'root', objectType: 'Node', where: [{ field: 'id', target: true }], expand: { edgeObjectType: 'Edge', maxDepth: 2, stateField: 'status', activeStates: ['active'], inactiveStates: ['inactive'], fromField: 'from_id', toField: 'to_id' } }], outputs: [{ id: 'root_id', label: '节点', expression: { op: 'one', dataset: 'root', field: 'id' } }] }] } };
  model.scenario.readPlans[0].outputs[0].unit = '';
  assert.equal(validateOntologyReadPlans(model).status, 'passed');
  model.relationshipTypes.push({ from: 'Edge', to: 'Node', predicate: 'mapped', keyMapping: { fromField: 'from_id', toField: 'id' } });
  assert.equal(validateOntologyReadPlans(model).code, 'READ_MAPPING_EXECUTION_REQUIRED');
  model.relationshipTypes[0].keyMapping.fromField = 'other_field';
  assert.equal(validateOntologyReadPlans(model).status, 'passed');
});

test('mapping-dependent joins fail before retrieval, even when an equality FK and a second predicate exist', async () => {
  const pack = buildOntologyMockPack('procurement');
  const first = pack.model.relationshipTypes[0];
  const plan = pack.suggestedReadPlan;
  const join = plan.datasets[1].where[0];
  const sourceType = plan.datasets[0].objectType; const targetType = plan.datasets[1].objectType;
  pack.model.scenario = { requireCaseReplay: true, decisionBindings: [], readPlans: [plan] };
  assert.equal(validateOntologyReadPlans(pack.model).status, 'passed');
  first.keyMapping = { basis: 'master_data_lookup', fromField: join.sourceField, toField: join.field, lookupSource: 'MDM', owner: 'mock', version: 'v1' };
  assert.equal(first.from, sourceType); assert.equal(first.to, targetType);
  assert.equal(validateOntologyReadPlans(pack.model).code, 'READ_MAPPING_EXECUTION_REQUIRED');
  let calls = 0;
  await assert.rejects(executeOntologyReadPlan({ draft: pack.model, plan, target: pack.records[0].id, retrieve: async () => { calls++; return []; } }), /READ_PLAN_INVALID/);
  assert.equal(calls, 0);
  pack.model.relationshipTypes.push({ ...first, predicate: 'alternate', keyMapping: undefined });
  const graph = buildOntologyResultGraph(pack.model, pack.records, 'v1', 'fp');
  assert.ok(!graph.relationships.some(edge => edge.predicate === 'alternate'));
  [first.from, first.to] = [first.to, first.from];
  [first.keyMapping.fromField, first.keyMapping.toField] = [first.keyMapping.toField, first.keyMapping.fromField];
  assert.equal(validateOntologyReadPlans(pack.model).code, 'READ_MAPPING_EXECUTION_REQUIRED');
});

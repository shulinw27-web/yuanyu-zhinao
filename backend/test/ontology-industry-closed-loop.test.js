import test from 'node:test'; import assert from 'node:assert/strict';
import { ONTOLOGY_MOCK_PACKS, buildOntologyMockPack } from '@healthcare-ai/agent-ui/ontology-mock-packs';
import { discoverSchemasFromAttachments } from '../src/services/semantic-schema-discovery-service.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft, validateOAMetaModelDraft, simulateBuildOAMetaModel } from '../src/services/meta-model-service.js';
import { runOntologyReadReplay, publishGovernedOntology } from '../src/services/ontology-runtime-service.js';
import { getPublishedAgentOntology, runPublishedOntologyRead } from '../src/services/published-ontology-agent-service.js';
import { ontologyQueryFingerprint } from '../src/services/ontology-read-plan-service.js';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { getRole } from '../src/services/authorization-service.js';
const scope = { tenantId: 'demo-enterprise', subjectId: 'demo:executive:industry-test', source: 'demo_header' };

for (const descriptor of ONTOLOGY_MOCK_PACKS) test(`${descriptor.id}: dictionary → reviewed candidate → replay → publication → authorized business graph`, async () => {
  resetRuntimeState(['oa_meta_model_runtime', 'ontology_publication', 'domain_event_outbox']);
  const previousGrants = process.env.ONTOLOGY_RUNTIME_GRANTS_JSON; const previousConnectors = process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON; const previousFetch = globalThis.fetch;
  try {
    const pack = buildOntologyMockPack(descriptor.id); const material = pack.materials[1];
    const discovered = discoverSchemasFromAttachments({ attachments: [{ id: 'dictionary', name: material.name, mimeType: 'application/json' }], reports: [{ attachmentId: 'dictionary', status: 'content_scanned', structuredSchemaCandidate: true }], documents: [{ attachmentId: 'dictionary', text: material.text }] });
    assert.equal(discovered.objectTypes.length, 3); assert.equal(discovered.relationshipTypes.length, 2);
    // Human simulation supplies policies/contracts; generated metadata grants nothing.
    const objects = discovered.objectTypes;
    objects.forEach(object => { object.businessDomain = object.id === pack.records[0].objectType ? '采购' : '运营'; });
    const definition = { ...discovered, relationshipTypes: pack.model.relationshipTypes, modelingProfile: 'general', scenario: { objective: `合成${pack.label}`, questions: pack.questions, requireCaseReplay: true, decisionBindings: [], actionBindings: [], readPlans: [pack.suggestedReadPlan] }, policies: ['只读合成演练，无业务写入'], stateMachines: [], events: [], metrics: [], glossaryTerms: [{ term: pack.label, definition: '本例只覆盖选定根对象和有界分支', objectType: objects[0].id }], dataContracts: objects.map(o => ({ id: o.id, objectType: o.id, sourceSystem: o.sourceSystems[0], schemaVersion: 'mock-v1' })), qualityRules: objects.map(o => ({ id: o.id, objectType: o.id, rule: 'not_null' })), lineageEdges: objects.map(o => ({ from: o.source, to: o.id })), accessPolicies: objects.map(o => ({ objectType: o.id, effect: 'allow', roles: ['executive'], condition: 'iam_scope' })) };
    const records = pack.records.map(record => ({ ...record, tenantId: scope.tenantId, organizationId: 'org-quality-dept', classification: 'internal' }));
    process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ [scope.tenantId]: { executive: { metadata: true, objects: Object.fromEntries(objects.map(o => [o.id, { system: o.sourceSystems[0], fields: o.fields, classifications: ['internal'] }])) } } });
    const role = getRole('executive'); assert.ok(!(await saveOAMetaModelDraft(definition, role)).error);
    const validation = await validateOAMetaModelDraft(role); assert.equal(validation.draft.validation.status, 'passed', JSON.stringify(validation.draft.validation));
    await simulateBuildOAMetaModel(role);
    assert.equal((await publishGovernedOntology({ role, identityScope: scope })).code, 'PUBLICATION_REPLAY_REQUIRED');
    const candidateFingerprint = (await getOAMetaModelDraft()).fingerprint; const target = records[0].id; const planId = pack.suggestedReadPlan.id;
    const replay = await runOntologyReadReplay({ role, identityScope: scope, body: { candidateFingerprint, cases: [{ planId, target, records, expected: { branchCount: 2, exceptionCount: 1 } }, { planId, target, records: [], expectedError: 'READ_ROOT_NOT_FOUND' }] } });
    assert.equal(replay.status, 'passed', JSON.stringify(replay));
    const deployed = await publishGovernedOntology({ role, identityScope: scope, deploy: async (_candidate, version) => ({ status: 'published', deployment: { sourceFingerprint: candidateFingerprint, version } }) });
    assert.ok(!deployed.error, JSON.stringify(deployed));
    const ontology = await getPublishedAgentOntology('executive', scope); assert.ok(ontology);
    assert.equal((await getOAMetaModelDraft()).objectTypes.find(object => object.id === pack.records[0].objectType).businessDomain, '采购');
    process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = JSON.stringify(Object.fromEntries(pack.systems.map(system => [system.toLowerCase(), { endpoint: 'http://127.0.0.1:19998' }])));
    let activeRecords = records;
    globalThis.fetch = async (_url, request) => { const { query } = JSON.parse(request.body); return new Response(JSON.stringify({ records: activeRecords.filter(record => record.objectType === query.objectType && query.filter.values.includes(record.payload[query.filter.field])), queryCoverage: { schemaVersion: 'ontology-query.v1', complete: true, queryFingerprint: ontologyQueryFingerprint(query) } })); };
    const read = () => runPublishedOntologyRead({ ontology, roleId: 'executive', scope, target, planId, input: '查询完整影响范围', allowModelAnalysis: false });
    const result = await read(); assert.equal(result.results.find(item => item.id === 'branchCount').value, 2); assert.equal(result.results.find(item => item.id === 'exceptionCount').value, 1);
    assert.equal(result.status, 'partial'); assert.equal(result.graph.relationshipCoverage[0].matchedPairs, 2); assert.equal(result.graph.globalEnterpriseCoverage, false);
    assert.equal(result.graph.objects.find(object => object.label.includes(records[0].id)).businessDomain, '采购');
    activeRecords = records.filter(record => record.id !== pack.records[2].id);
    assert.equal((await read()).results.find(item => item.id === 'branchCount').value, 1);
    activeRecords = records.map(record => ({ ...record, tenantId: 'foreign' }));
    const denied = await read(); assert.equal(denied.records, undefined); assert.equal(denied.graph, undefined); assert.match(denied.code, /READ_RECORD_SCOPE/);
    const invalid = structuredClone(definition); invalid.objectTypes[0].sourceSystems = ['待观察'];
    await saveOAMetaModelDraft(invalid, role);
    const issues = (await validateOAMetaModelDraft(role)).draft.validation.checks.find(check => check.name === '语义锚点与来源');
    assert.equal(issues.status, 'failed'); assert.ok(issues.targets.some(target => target.targetId === objects[0].id && target.field === 'sourceSystems'));
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of [['ONTOLOGY_RUNTIME_GRANTS_JSON', previousGrants], ['ENTERPRISE_CONNECTORS_CONFIG_JSON', previousConnectors]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

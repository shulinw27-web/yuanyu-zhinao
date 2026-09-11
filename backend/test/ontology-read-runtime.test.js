import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discoverSchemasFromAttachments } from '../src/services/semantic-schema-discovery-service.js';
import { executeOntologyReadPlan, validateOntologyReadPlans, ontologyQueryFingerprint } from '../src/services/ontology-read-plan-service.js';
import { crossChannelReadPlan } from '../../examples/semantic-schemas/cross-channel-fulfillment/read-plan.mjs';
import { buildAgentQueryPlan } from '../src/services/agent-query-plan-service.js';
import { createAgentConversation, recordAgentConversationExchange, getAgentConversationContext } from '../src/services/agent-conversation-service.js';
import { getPublishedAgentOntology, runPublishedOntologyRead } from '../src/services/published-ontology-agent-service.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft, validateOAMetaModelDraft, simulateBuildOAMetaModel } from '../src/services/meta-model-service.js';
import { runOntologyReadReplay, publishGovernedOntology } from '../src/services/ontology-runtime-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { turnUnderstandingTimeout, hasConflictingMaterialTotals } from '../src/services/agent-turn-understanding-service.js';

test('material headings cannot contradict final metric totals; different versions remain distinct', () => {
  assert.equal(hasConflictingMaterialTotals('2)南仓自有可用件数:60 piece\n更正为40\n- 南仓自有可用件数:40 piece'), true);
  assert.equal(hasConflictingMaterialTotals('**额度**：4,000 CNY\n- 额度：4000 CNY'), false);
  assert.equal(hasConflictingMaterialTotals('A版额度：4000 CNY\nB版额度：7500 CNY'), false);
});

test('understanding deadline accounts for material plus conversation, without overriding deployment bounds', () => {
  assert.equal(turnUnderstandingTimeout({ material: 'x'.repeat(6000), history: 'x'.repeat(3000) }, {}), 60000);
  assert.equal(turnUnderstandingTimeout({ input: '你好' }, {}), 30000);
  assert.equal(turnUnderstandingTimeout({ material: 'x'.repeat(20000) }, { AGENT_MODEL_TIMEOUT_MS: '15000' }), 15000);
  assert.equal(turnUnderstandingTimeout({}, { AGENT_MODEL_TIMEOUT_MS: '200000' }), 120000);
});

const fixture = n => JSON.parse(readFileSync(new URL(`../../examples/semantic-schemas/cross-channel-fulfillment/${n}`, import.meta.url), 'utf8'));
const dictionary = JSON.stringify(fixture('data-dictionary.json'));
const discovered = discoverSchemasFromAttachments({ attachments: [{ id: 'dict', name: 'dictionary.json', mimeType: 'application/json' }], reports: [{ attachmentId: 'dict', status: 'content_scanned', structuredSchemaCandidate: true }], documents: [{ attachmentId: 'dict', text: dictionary }] });
const scope = { tenantId: 'demo-enterprise', subjectId: 'demo:executive:read-test', source: 'demo_header' };
const source = fixture('sample-events.json').records;
const expected = fixture('expected-results.json').answer;
const draft = coefficient => ({ objectTypes: discovered.objectTypes, relationshipTypes: discovered.relationshipTypes,
  scenario: { requireCaseReplay: true, decisionBindings: [], readPlans: [crossChannelReadPlan(coefficient)] },
  accessPolicies: discovered.objectTypes.map(o => ({ objectType: o.id, effect: 'allow', roles: ['executive'], condition: 'iam_scope' })) });
const grants = () => { process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ 'demo-enterprise': { executive: { metadata: true, objects: Object.fromEntries(discovered.objectTypes.map(o => [o.id, { system: o.sourceSystems[0], fields: o.fields, classifications: ['internal'] }])) } } }); };
const run = (d, records = source, identity = scope) => executeOntologyReadPlan({ draft: d, plan: d.scenario.readPlans[0], target: 'ORD-X900', roleId: 'executive', scope: identity,
  retrieve: async (type, q) => records.filter(r => r.objectType === type.id && q.filter.values.includes(r.payload[q.filter.field])) });

test('read algebra retains declared joins and computes A/B from source records, not a fixture answer lookup', async () => {
  grants(); assert.equal(discovered.objectTypes.length, 18);
  for (const coefficient of [0, 0.5]) {
    const d = draft(coefficient); assert.equal(validateOntologyReadPlans(d).status, 'passed', JSON.stringify(validateOntologyReadPlans(d)));
    const result = await run(d); const values = Object.fromEntries(result.results.map(r => [r.id, r.value]));
    assert.equal(values.demandPieces, expected.demandPieces); assert.equal(values.southOwnedAvailablePieces, expected.southOwnedAvailablePieces);
    assert.equal(values.shortagePieces, expected.shortagePieces); assert.equal(values.bankConfirmedUnallocated, expected.bankConfirmedUnallocated);
    assert.equal(values.credit, coefficient ? expected.creditV2 : expected.creditV1); assert.equal(values.creditGap, coefficient ? expected.creditGapV2 : expected.creditGapV1);
    assert.equal(values.consignmentTransferExecuted, false); assert.equal(values.returnReleased, false);
  }
});
test('changed facts change calculation; published rule is not a canned numerical response', async () => {
  grants(); const records = structuredClone(source); records.find(r => r.id === 'ST-X1').payload.qty = 8;
  const result = await run(draft(0), records);
  assert.equal(result.results.find(r => r.id === 'southOwnedAvailablePieces').value, 60);
  assert.equal(result.results.find(r => r.id === 'shortagePieces').value, 120);
});
test('unknown operators, undeclared joins, output cycles and no replay gate fail contract validation', () => {
  for (const mutate of [d => { d.scenario.readPlans[0].outputs[0].expression = { op: 'eval', value: 'process.exit()' }; },
    d => { d.scenario.readPlans[0].datasets[1].where[0].sourceField = 'amount'; },
    d => { d.scenario.readPlans[0].outputs[0].expression = { op: 'output', id: 'orderAmountCny' }; },
    d => { d.scenario.requireCaseReplay = false; }]) {
    const d = draft(0); mutate(d); assert.equal(validateOntologyReadPlans(d).status, 'failed');
  }
});
test('deployment grant and model policy are intersected before any connector calls', async () => {
  grants(); const d = draft(0); d.accessPolicies[0].effect = 'deny'; let calls = 0;
  await assert.rejects(executeOntologyReadPlan({ draft: d, plan: d.scenario.readPlans[0], target: 'ORD-X900', roleId: 'executive', scope, retrieve: () => { calls++; return []; } }), /READ_OBJECT_FORBIDDEN/);
  assert.equal(calls, 0);
  delete process.env.ONTOLOGY_RUNTIME_GRANTS_JSON;
  await assert.rejects(run(draft(0)), /READ_OBJECT_FORBIDDEN/);
});
test('foreign tenant, missing required data and conflicting duplicate versions never become calculations', async () => {
  grants(); const foreign = structuredClone(source); foreign.find(r => r.id === 'ST-X1').tenantId = 'other';
  await assert.rejects(run(draft(0), foreign), /READ_RECORD_SCOPE/);
  const missing = structuredClone(source); delete missing.find(r => r.id === 'ST-X1').payload.qty;
  await assert.rejects(run(draft(0), missing), /READ_REQUIRED_FIELD/);
  const conflict = structuredClone(source); const extra = structuredClone(conflict.find(r => r.id === 'ST-X1')); extra.payload.qty = 99; conflict.push(extra);
  await assert.rejects(run(draft(0), conflict), /READ_RECORD_CONFLICT/);
});
test('model version explanation does not suppress real source-version and snapshot constraints', () => {
  assert.equal(buildAgentQueryPlan('分析 ORD-X900 并说明语义模型版本').status, 'ready');
  assert.equal(buildAgentQueryPlan('查询 ORD-X900 来源版本').status, 'needs_input');
  assert.equal(buildAgentQueryPlan('查询 ORD-X900 版本 v2 并说明模型版本').version, 'v2');
  assert.equal(buildAgentQueryPlan('查询 ORD-X900 最新数据，说明模型版本').status, 'needs_input');
});

test('unknown units and currencies fail explicitly, and revocation during retrieval discards the result', async () => {
  grants(); const invalid = structuredClone(source); invalid.find(r => r.id === 'ST-X1').payload.unit = 'litre';
  await assert.rejects(run(draft(0), invalid), /READ_PRECONDITION_FAILED/);
  const foreignCurrency = structuredClone(source); foreignCurrency.find(r => r.objectType === 'SalesOrder').payload.currency = 'USD';
  await assert.rejects(run(draft(0), foreignCurrency), /READ_PRECONDITION_FAILED/);
  const d = draft(0); let calls = 0;
  await assert.rejects(executeOntologyReadPlan({ draft: d, plan: d.scenario.readPlans[0], target: 'ORD-X900', roleId: 'executive', scope,
    retrieve: async (type, q) => { calls++; delete process.env.ONTOLOGY_RUNTIME_GRANTS_JSON; return source.filter(r => r.objectType === type.id && q.filter.values.includes(r.payload[q.filter.field])); } }), /READ_OBJECT_FORBIDDEN/);
  assert.equal(calls, 1);
});
test('revoking deployment grants hides old assistant history from the same conversation', async () => {
  grants(); const accessContext = { roleIds: ['executive'], organizationIds: [], buttonPermissionIds: [], pagePermissionIds: [], dataScopes: [] };
  const conversation = await createAgentConversation({ roleId: 'executive', identityScope: scope, accessContext });
  await recordAgentConversationExchange({ conversationId: conversation.id, roleId: 'executive', identityScope: scope, accessContext, input: '分析当前订单', response: { text: 'PRIVATE_CREDIT_RESULT_7000', evidence: [], plan: [], command: null } });
  const before = await getAgentConversationContext(conversation.id, scope, accessContext);
  assert.ok(before.prompt.includes('PRIVATE_CREDIT_RESULT_7000'));
  delete process.env.ONTOLOGY_RUNTIME_GRANTS_JSON;
  const after = await getAgentConversationContext(conversation.id, scope, accessContext);
  assert.ok(!after.prompt.includes('PRIVATE_CREDIT_RESULT_7000'));
});
test('read-plan publication requires fingerprint-bound positive and negative replay; metadata is tenant scoped', async () => {
  grants(); const role = getRole('executive'); const d = draft(0);
  const definition = { ...d, modelingProfile: 'general', scenario: { ...d.scenario, objective: '回放测试', questions: ['缺口是多少？'], actionBindings: [] },
    policies: ['只读，不授权写入'], stateMachines: [], events: [], metrics: [],
    glossaryTerms: [{ term: '曙光额度', definition: '授信减应收减承诺', objectType: 'CreditAccount' }],
    dataContracts: d.objectTypes.map(o => ({ id: o.id, objectType: o.id, sourceSystem: o.sourceSystems[0], schemaVersion: '1' })),
    qualityRules: d.objectTypes.map(o => ({ id: o.id, objectType: o.id, rule: 'not_null' })),
    lineageEdges: d.objectTypes.map(o => ({ from: o.source, to: o.id })) };
  await saveOAMetaModelDraft(definition, role);
  assert.equal((await validateOAMetaModelDraft(role)).draft.validation.status, 'passed');
  await simulateBuildOAMetaModel(role);
  assert.equal((await publishGovernedOntology({ role, identityScope: scope })).code, 'PUBLICATION_REPLAY_REQUIRED');
  const fingerprint = (await getOAMetaModelDraft()).fingerprint;
  const { creditV1, creditGapV1, creditV2: _b, creditGapV2: _g, ...common } = expected;
  const positive = { planId: d.scenario.readPlans[0].id, target: 'ORD-X900', records: source, expected: { ...common, credit: creditV1, creditGap: creditGapV1 } };
  const negative = { planId: positive.planId, target: positive.target, records: [], expectedError: 'READ_ROOT_NOT_FOUND' };
  assert.equal((await runOntologyReadReplay({ body: { candidateFingerprint: fingerprint, cases: [positive, positive] }, role, identityScope: scope })).status, 'failed');
  assert.equal((await runOntologyReadReplay({ body: { candidateFingerprint: fingerprint, cases: [positive, negative] }, role, identityScope: scope })).status, 'passed');
  const deployed = await publishGovernedOntology({ role, identityScope: scope, deploy: async (candidate, version) => ({ status: 'published', deployment: { sourceFingerprint: (await getOAMetaModelDraft()).fingerprint, version } }) });
  assert.ok(!deployed.error, deployed.error);
  assert.ok((await getPublishedAgentOntology('executive', scope)).metadata.modelVersion);
  assert.equal(await getPublishedAgentOntology('executive', { ...scope, tenantId: 'other' }), null);
  const originalFetch = globalThis.fetch; const previousConnectors = process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON;
  try {
    process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = JSON.stringify(Object.fromEntries(discovered.objectTypes.map(o => [o.sourceSystems[0].toLowerCase(), { endpoint: 'http://127.0.0.1:19998' }])));
    globalThis.fetch = async (_url, request) => {
      const { query } = JSON.parse(request.body);
      return new Response(JSON.stringify({ records: source.filter(r => r.objectType === query.objectType && query.filter.values.includes(r.payload[query.filter.field])), queryCoverage: { schemaVersion: 'ontology-query.v1', complete: true, queryFingerprint: ontologyQueryFingerprint(query) } }));
    };
    const ontology = await getPublishedAgentOntology('executive', scope);
    const partial = await runPublishedOntologyRead({ ontology, roleId: 'executive', scope, target: 'ORD-X900', input: '完整影响范围' });
    assert.equal(partial.status, 'partial', partial.text);
    assert.ok(partial.timing.sourceReadMs >= 0); assert.equal(partial.timing.analysisMs, 0);
    assert.equal(partial.coverage.globalEnterpriseCoverage, false);
    assert.equal(partial.coverage.status, 'declared_plan_only');
    const stale = await runPublishedOntologyRead({ ontology: { ...ontology, published: { ...ontology.published, fingerprint: 'stale' } }, roleId: 'executive', scope, target: 'ORD-X900' });
    assert.equal(stale.code, 'ONTOLOGY_VERSION_CHANGED'); assert.equal(stale.records, undefined);
    const tooMany = await runPublishedOntologyRead({ ontology, roleId: 'executive', scope, target: ['a','b','c','d'] });
    assert.equal(tooMany.status, 'needs_input');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConnectors === undefined) delete process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON; else process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = previousConnectors;
  }
  await saveOAMetaModelDraft({ ...definition, scenario: { ...definition.scenario, readPlans: [crossChannelReadPlan(0.5)] } }, role);
  await validateOAMetaModelDraft(role); await simulateBuildOAMetaModel(role);
  assert.equal((await publishGovernedOntology({ role, identityScope: scope })).code, 'PUBLICATION_REPLAY_REQUIRED');
});

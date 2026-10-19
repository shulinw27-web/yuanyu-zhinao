import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discoverSchemasFromAttachments } from '../src/services/semantic-schema-discovery-service.js';
import { executeOntologyReadPlan, validateOntologyReadPlans, ontologyQueryFingerprint, getOntologyRuntimeGrant } from '../src/services/ontology-read-plan-service.js';
import { runWithSemanticTenant, runWithSemanticModelWorkspace } from '../src/services/semantic-tenant-context.js';
import { crossChannelReadPlan } from '../../examples/semantic-schemas/cross-channel-fulfillment/read-plan.mjs';
import { buildAgentQueryPlan } from '../src/services/agent-query-plan-service.js';
import { createAgentConversation, recordAgentConversationExchange, getAgentConversationContext } from '../src/services/agent-conversation-service.js';
import { getPublishedAgentOntology, runPublishedOntologyRead, validatePublishedReadEvidence } from '../src/services/published-ontology-agent-service.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft, validateOAMetaModelDraft, simulateBuildOAMetaModel } from '../src/services/meta-model-service.js';
import { runOntologyReadReplay, publishGovernedOntology } from '../src/services/ontology-runtime-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { turnUnderstandingTimeout, hasConflictingMaterialTotals } from '../src/services/agent-turn-understanding-service.js';
import { buildKnowledgeBusinessBrief } from '../src/services/knowledge-business-brief-service.js';
import { saveLibraryDocument } from '../src/services/knowledge-library-service.js';
import { createLocalKnowledgeProvider } from '../src/services/knowledge-evidence-service.js';
import { selectPublishedReadPlan } from '../src/services/ontology-plan-selection.js';
import { runPrivateAgent } from '../src/services/private-agent-service.js';
import { retrieveOntologyConnectorRecords } from '../src/services/system-integration-service.js';

test('legacy ontology transport rejects independent models and foreign scopes before any network access', async () => {
  const previous = process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON;
  const originalFetch = globalThis.fetch;
  const identity = { tenantId: 'connector-synthetic', subjectId: 'synthetic-reader' };
  const query = { filter: { field: 'id', values: ['SYNTHETIC-1'] } };
  let calls = 0;
  try {
    process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = JSON.stringify({ wms: { endpoint: 'http://127.0.0.1:19999' } });
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ records: [], queryCoverage: {
        schemaVersion: 'ontology-query.v1', complete: true, queryFingerprint: ontologyQueryFingerprint(query)
      } }));
    };
    const read = scope => retrieveOntologyConnectorRecords({ sourceSystems: ['WMS'] }, query, 'executive', scope);
    await runWithSemanticModelWorkspace(identity, 'independent-model', async () => {
      const grant = { schemaVersion: 'ontology-model-grant.v1', modelId: 'independent-model', metadata: true,
        objects: { Stock: { system: 'WMS', fields: ['id'], classifications: ['internal'] } } };
      const settings = { ONTOLOGY_RUNTIME_GRANTS_JSON: JSON.stringify({ [identity.tenantId]: { executive: { models: { 'independent-model': grant } } } }) };
      assert.deepEqual(getOntologyRuntimeGrant(identity, 'executive', settings), grant);
      await assert.rejects(read(identity), /ONTOLOGY_CONNECTOR_MODEL_BINDING_REQUIRED/u);
      assert.equal(calls, 0);
    }, { registered: true });
    await runWithSemanticTenant(identity, async () => {
      for (const invalid of [{ ...identity, tenantId: 'foreign' }, { ...identity, subjectId: '' }, { ...identity, subjectId: ' reader ' },
        { ...identity, subjectId: 'reader\u007f' }, { ...identity, subjectId: 'r'.repeat(129) }, null]) {
        await assert.rejects(read(invalid), /ONTOLOGY_CONNECTOR_SCOPE_INVALID/u);
        assert.equal(calls, 0);
      }
      assert.deepEqual(await read(identity), []);
      assert.equal(calls, 1);
    });
    await assert.rejects(read(identity), /ONTOLOGY_CONNECTOR_SCOPE_INVALID/u);
    assert.equal(calls, 1);
    // Existing local Demo fixtures retain their default-model transport path.
    assert.deepEqual(await read({ tenantId: 'demo-enterprise', subjectId: 'demo:synthetic-reader' }), []);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON;
    else process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = previous;
  }
});

test('independent models require explicit server model grants and never inherit default role access', async () => {
  const scope = { tenantId: 'grant-synthetic', subjectId: 'synthetic-reader' };
  const oldGrant = { metadata: true, objects: { InventoryLot: { system: 'WMS', fields: ['id'], classifications: ['内部'] } } };
  const settings = { ONTOLOGY_RUNTIME_GRANTS_JSON: JSON.stringify({ [scope.tenantId]: { quality: oldGrant } }) };
  await runWithSemanticTenant(scope, async () => {
    assert.deepEqual(getOntologyRuntimeGrant(scope, 'quality', settings), oldGrant);
    assert.equal(getOntologyRuntimeGrant({ ...scope, tenantId: 'other' }, 'quality', settings), null);
    await runWithSemanticModelWorkspace(scope, 'quality-model', async () => {
      assert.equal(getOntologyRuntimeGrant(scope, 'quality', settings), null);
      const explicit = { schemaVersion: 'ontology-model-grant.v1', modelId: 'quality-model', metadata: true, objects: {} };
      settings.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ [scope.tenantId]: { quality: { ...oldGrant, models: { 'quality-model': explicit, 'other-model': { ...explicit, modelId: 'other-model' } } } } });
      assert.deepEqual(getOntologyRuntimeGrant(scope, 'quality', settings), explicit);
      for (const invalid of [{ ...explicit, modelId: 'other-model' }, { ...explicit, metadata: false }, { ...explicit, schemaVersion: 'legacy' }, { ...explicit, objects: [] }, { ...explicit, provider: 'foreign' }]) {
        settings.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ [scope.tenantId]: { quality: { ...oldGrant, models: { 'quality-model': invalid } } } });
        assert.equal(getOntologyRuntimeGrant(scope, 'quality', settings), null);
      }
    }, { registered: true });
    settings.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ [scope.tenantId]: { quality: { ...oldGrant, models: { 'unregistered-model': { schemaVersion: 'ontology-model-grant.v1', modelId: 'unregistered-model', metadata: true, objects: {} } } } } });
    await runWithSemanticModelWorkspace(scope, 'unregistered-model', () => assert.equal(getOntologyRuntimeGrant(scope, 'quality', settings), null));
  });
});

test('natural plan selection is bounded, declaration-based and never guesses ambiguous or excluded plans', () => {
  const plans = [
    { id: 'stock', label: '库存核验', outputs: [{ id: 'qty', label: '可用库存' }, { id: 'risk', label: '风险等级' }] },
    { id: 'credit', label: '授信核验', outputs: [{ id: 'gap', label: '授信缺口' }, { id: 'risk', label: '风险等级' }] }
  ];
  assert.equal(selectPublishedReadPlan(plans, { input: '请核对可用库存' }).planId, 'stock');
  assert.equal(selectPublishedReadPlan(plans, { input: '按授信核验查订单' }).basis, 'declared_name');
  assert.equal(selectPublishedReadPlan(plans, { input: '用 stock 查询' }).planId, 'stock');
  for (const input of ['你好', '风险等级', '可用库存和授信缺口', '库存核验及授信核验', '不要库存核验，用授信核验', 'not stock', 'stockpile', '按库存核验查询授信缺口']) {
    assert.equal(selectPublishedReadPlan(plans, { input }).status, 'needs_input', input);
  }
  assert.equal(selectPublishedReadPlan(plans, { planId: 'missing', input: '库存核验' }).reason, 'unknown_plan');
  assert.equal(selectPublishedReadPlan(plans, { planId: 'credit', input: '可用库存' }).reason, 'conflicting_request');
  assert.equal(selectPublishedReadPlan(plans, { planId: 'stock', input: '授信核验' }).status, 'needs_input');
  assert.equal(selectPublishedReadPlan(plans, { input: '按旧方案查询可用库存' }).reason, 'unknown_named_plan');
  assert.equal(selectPublishedReadPlan(plans, { input: '核对可用库存，不要生成文件，也不要发起审批' }).planId, 'stock');
  assert.equal(selectPublishedReadPlan([plans[0]], {}).basis, 'only_published_plan');
  assert.equal(selectPublishedReadPlan([plans[0]], { input: '不读取业务数据' }).status, 'needs_input');
  assert.equal(selectPublishedReadPlan([plans[0], plans[0]], {}).reason, 'invalid_catalogue');
  assert.equal(selectPublishedReadPlan([...plans, { ...plans[0], id: 'all', outputs: [...plans[0].outputs, ...plans[1].outputs] }], { input: '可用库存和授信缺口' }).planId, 'all');
});

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

test('default grants cannot trigger any connector read in another admitted model workspace', async () => {
  const previous = process.env.ONTOLOGY_RUNTIME_GRANTS_JSON; let reads = 0;
  try {
    grants(); const definition = draft(0);
    await runWithSemanticModelWorkspace(scope, 'other-admitted-model', async () => {
      await assert.rejects(executeOntologyReadPlan({ draft: definition, plan: definition.scenario.readPlans[0], target: 'ORD-X900', roleId: 'executive', scope,
        retrieve: async () => { reads++; return []; } }), /READ_OBJECT_FORBIDDEN/u);
      assert.equal(reads, 0);
    }, { registered: true });
  } finally { if (previous === undefined) delete process.env.ONTOLOGY_RUNTIME_GRANTS_JSON; else process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = previous; }
});

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
test('read plan catalogue is bounded and rejects duplicate identities', () => {
  const d = draft(0);
  d.scenario.readPlans = Array.from({ length: 3 }, (_, i) => ({ ...crossChannelReadPlan(0), id: `plan_${i}` }));
  assert.equal(validateOntologyReadPlans(d).status, 'passed');
  d.scenario.readPlans.push({ ...crossChannelReadPlan(0), id: 'fourth' });
  assert.equal(validateOntologyReadPlans(d).status, 'failed');
  d.scenario.readPlans = [crossChannelReadPlan(0), crossChannelReadPlan(0)];
  assert.equal(validateOntologyReadPlans(d).status, 'failed');
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
test('multiple published plans require explicit selection and per-plan replay; metadata is tenant scoped', async () => {
  grants(); const role = getRole('executive'); const d = draft(0);
  const alternative = { ...crossChannelReadPlan(0.5), id: 'cross_channel_alternative', label: '另一授信口径' };
  d.scenario.readPlans.push(alternative);
  const definition = { ...d, modelingProfile: 'general', scenario: { ...d.scenario, objective: '回放测试', questions: ['缺口是多少？'], actionBindings: [] },
    policies: ['只读，不授权写入'], stateMachines: [], events: [], metrics: [],
    glossaryTerms: [{ term: '曙光额度', definition: '授信减应收减承诺', objectType: 'CreditAccount' }],
    dataContracts: d.objectTypes.map(o => ({ id: o.id, objectType: o.id, sourceSystem: o.sourceSystems[0], schemaVersion: '1' })),
    qualityRules: d.objectTypes.map(o => ({ id: o.id, objectType: o.id, rule: 'not_null' })),
    lineageEdges: d.objectTypes.map(o => ({ from: o.source, to: o.id })) };
  const badDefinition = structuredClone(definition);
  badDefinition.scenario.readPlans[0].outputs[0].expression = { op: 'add', args: [{ op: 'literal', value: null }, { op: 'literal', value: 1 }] };
  await saveOAMetaModelDraft(badDefinition, role);
  const badCase = { planId: badDefinition.scenario.readPlans[0].id, target: 'ORD-X900', records: source, expectedError: 'READ_NOT_NUMERIC' };
  const badReplay = await runOntologyReadReplay({ body: { candidateFingerprint: (await getOAMetaModelDraft()).fingerprint, cases: [badCase, badCase] }, role, identityScope: scope });
  assert.equal(badReplay.status, 'failed');
  assert.ok(badReplay.results.every(row => row.code === 'READ_NOT_NUMERIC' && row.status === 'failed'));
  await saveOAMetaModelDraft(definition, role);
  assert.equal((await validateOAMetaModelDraft(role)).draft.validation.status, 'passed');
  await simulateBuildOAMetaModel(role);
  assert.equal((await publishGovernedOntology({ role, identityScope: scope })).code, 'PUBLICATION_REPLAY_REQUIRED');
  const fingerprint = (await getOAMetaModelDraft()).fingerprint;
  const { creditV1, creditGapV1, creditV2, creditGapV2, ...common } = expected;
  const positive = { planId: d.scenario.readPlans[0].id, target: 'ORD-X900', records: source, expected: { ...common, credit: creditV1, creditGap: creditGapV1 } };
  const negative = { planId: positive.planId, target: positive.target, records: [], expectedError: 'READ_ROOT_NOT_FOUND' };
  assert.equal((await runOntologyReadReplay({ body: { candidateFingerprint: fingerprint, cases: [positive, positive] }, role, identityScope: scope })).status, 'failed');
  assert.notEqual((await runOntologyReadReplay({ body: { candidateFingerprint: fingerprint, cases: [positive, negative] }, role, identityScope: scope })).status, 'passed');
  const alternatePositive = { ...positive, planId: alternative.id, expected: { ...common, credit: creditV2, creditGap: creditGapV2 } };
  assert.equal((await runOntologyReadReplay({ body: { candidateFingerprint: fingerprint, cases: [positive, negative, alternatePositive, { ...negative, planId: alternative.id }] }, role, identityScope: scope })).status, 'passed');
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
    const read = options => runPublishedOntologyRead({ ontology, roleId: 'executive', scope, target: 'ORD-X900', allowModelAnalysis: false, ...options });
    assert.equal((await read({})).code, 'ONTOLOGY_PLAN_SELECTION_REQUIRED');
    assert.equal((await read({ planId: 'not-published' })).code, 'ONTOLOGY_PLAN_SELECTION_REQUIRED');
    const alternateResult = await read({ planId: alternative.id });
    assert.equal(alternateResult.graph.mode, 'authorized_instance_snapshot');
    assert.equal(alternateResult.graph.objects.length, alternateResult.records.length);
    assert.equal(alternateResult.graph.modelFingerprint, ontology.published.fingerprint);
    assert.ok(alternateResult.graph.relationships.length > 0);
    const graphIds = new Set(alternateResult.graph.objects.map(item => item.id));
    assert.ok(alternateResult.graph.relationships.every(item => graphIds.has(item.from) && graphIds.has(item.to)));
    assert.equal(alternateResult.results.find(item => item.id === 'credit').value, creditV2);
    assert.equal(alternateResult.metadata.selectedReadPlan.id, alternative.id);
    // Revocation while publication is being reread must invalidate already
    // calculated evidence, even when metadata access remains enabled.
    const evidenceGrants = process.env.ONTOLOGY_RUNTIME_GRANTS_JSON;
    try {
      const narrowed = JSON.parse(evidenceGrants);
      narrowed['demo-enterprise'].executive.objects[alternateResult.records[0].objectType].fields = [];
      queueMicrotask(() => { process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(narrowed); });
      await assert.rejects(validatePublishedReadEvidence({ ontology, roleId: 'executive', scope, records: alternateResult.records }), /READ_OBJECT_FORBIDDEN/u);
    } finally { process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = evidenceGrants; }
    try {
      const narrowed = JSON.parse(evidenceGrants);
      narrowed['demo-enterprise'].executive.objects[alternative.datasets[0].objectType].fields = [];
      queueMicrotask(() => { process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(narrowed); });
      await assert.rejects(validatePublishedReadEvidence({ ontology, roleId: 'executive', scope, records: [], readPlanId: alternative.id }), /READ_OBJECT_FORBIDDEN/u);
    } finally { process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = evidenceGrants; }
    for (const changed of [{ modelId: 'another-model' }, { tenantId: 'another-tenant' }, { runtimeReadEnabled: false }]) {
      await assert.rejects(validatePublishedReadEvidence({ ontology: { ...ontology, published: { ...ontology.published, ...changed } }, roleId: 'executive', scope, records: alternateResult.records }), /ONTOLOGY_VERSION_CHANGED/u);
    }
    try {
      const narrowed = JSON.parse(evidenceGrants);
      narrowed['demo-enterprise'].executive.objects[alternateResult.records[0].objectType].classifications = [];
      queueMicrotask(() => { process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(narrowed); });
      await assert.rejects(validatePublishedReadEvidence({ ontology, roleId: 'executive', scope, records: alternateResult.records }), /READ_RECORD_SCOPE/u);
    } finally { process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = evidenceGrants; }
    const authorizedFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (...args) => {
        const response = await authorizedFetch(...args);
        const revoked = JSON.parse(evidenceGrants);
        revoked['demo-enterprise'].executive.metadata = false;
        process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(revoked);
        return response;
      };
      const revokedResult = await read({ planId: alternative.id });
      assert.equal(revokedResult.status, 'incomplete');
      for (const key of ['records', 'results', 'graph', 'metadata', 'comparisons', 'analysis']) assert.equal(revokedResult[key], undefined, key);
    } finally { globalThis.fetch = authorizedFetch; process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = evidenceGrants; }
    const natural = await read({ input: `按${alternative.id}核验 ORD-X900` });
    assert.equal(natural.results.find(item => item.id === 'credit').value, creditV2);
    assert.equal(natural.metadata.selectedReadPlan.basis, 'declared_name');
    const previousProvider = process.env.MODEL_PROVIDER;
    try {
      process.env.MODEL_PROVIDER = 'mock';
      const agentRead = await runPrivateAgent({ text: `按${alternative.id}核验 ORD-X900` }, role, scope);
      assert.equal(agentRead.semanticContext.selectedReadPlan.id, alternative.id);
      assert.equal(agentRead.semanticContext.calculations.find(item => item.id === 'credit').value, creditV2);
      assert.equal(agentRead.command, null);
      const clarify = await runPrivateAgent({ text: '查询 ORD-X900' }, role, scope);
      assert.equal(clarify.semanticContext.planSelection.reason, 'no_declared_match');
      assert.equal(clarify.semanticContext.querySteps.length, 0);
      assert.equal(clarify.command, null);
    } finally {
      if (previousProvider === undefined) delete process.env.MODEL_PROVIDER;
      else process.env.MODEL_PROVIDER = previousProvider;
    }
    const forged = structuredClone(ontology);
    forged.published.draft.scenario.readPlans[1].outputs = [];
    assert.equal((await read({ ontology: forged, planId: alternative.id })).results.find(item => item.id === 'credit').value, creditV2);
    const fetchForRead = globalThis.fetch;
    let blockedCalls = 0;
    globalThis.fetch = async () => { blockedCalls++; throw new Error('unexpected read'); };
    try {
      const ambiguous = await read({ input: '帮我分析一下' });
      assert.equal(ambiguous.selection.reason, 'no_declared_match');
      assert.ok(ambiguous.text.includes(alternative.id));
      assert.equal((await read({ input: `不要使用${alternative.id}` })).selection.reason, 'negated_request');
      assert.equal((await read({ ontology: { ...ontology, published: { ...ontology.published, fingerprint: 'stale' } }, planId: alternative.id })).code, 'ONTOLOGY_VERSION_CHANGED');
      assert.equal((await read({ scope: { ...scope, tenantId: 'other' }, planId: alternative.id })).code, 'ONTOLOGY_VERSION_CHANGED');
      assert.equal((await read({ ontology: { ...ontology, published: { ...ontology.published, modelId: 'finance', runtimeReadEnabled: false } }, planId: alternative.id })).code, 'ONTOLOGY_VERSION_CHANGED');
      const savedGrants = process.env.ONTOLOGY_RUNTIME_GRANTS_JSON;
      try {
        delete process.env.ONTOLOGY_RUNTIME_GRANTS_JSON;
        assert.equal((await read({ planId: alternative.id })).code, 'ONTOLOGY_VERSION_CHANGED');
      } finally { process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = savedGrants; }
      assert.equal(blockedCalls, 0);
    } finally { globalThis.fetch = fetchForRead; }
    const partial = await read({ planId: positive.planId, input: '完整影响范围' });
    assert.equal(partial.results.find(item => item.id === 'credit').value, creditV1);
    assert.equal(partial.status, 'partial', partial.text);
    assert.ok(partial.timing.sourceReadMs >= 0); assert.equal(partial.timing.analysisMs, 0);
    assert.equal(partial.coverage.globalEnterpriseCoverage, false);
    assert.equal(partial.coverage.status, 'declared_plan_only');
    const jointContext = { identityScope: { ...scope, deviceId: 'read-test' }, roleId: 'executive' };
    await saveLibraryDocument({ ...jointContext, id: 'joint-policy', body: { expectedRevision: 0, title: '订单信用合成制度', source: '合成测试', sourceVersion: 'v1', kind: 'reference', text: '订单履约前核验授信和库存，信用额度必须根据授权财务来源计算。' } });
    const localKnowledge = createLocalKnowledgeProvider(jointContext);
    const joint = await buildKnowledgeBusinessBrief({ context: jointContext,
      body: { question: '完整核验 ORD-X900 库存及授信缺口', targets: ['ORD-X900'], citations: (await localKnowledge.search({ query: '授信', limit: 3 })).results.map(item => item.citation), confirmed: true,
        planId: positive.planId, expectedModelFingerprint: ontology.published.fingerprint, expectedModelVersion: ontology.published.version },
      resolveProvider: () => localKnowledge, canRead: () => true });
    assert.equal(joint.status, 'partial', JSON.stringify(joint));
    assert.equal(joint.business.results.find(item => item.id === 'credit').value, expected.creditV1);
    assert.equal(joint.business.metadata.selectedReadPlan.id, positive.planId);
    assert.equal(joint.modelCalled, false); assert.equal(joint.knowledge.sources.length, 1);
    const stale = await read({ ontology: { ...ontology, published: { ...ontology.published, fingerprint: 'stale' } }, planId: positive.planId });
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

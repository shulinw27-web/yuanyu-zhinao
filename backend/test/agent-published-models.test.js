import test from 'node:test';
import assert from 'node:assert/strict';
import { agentPublishedModels } from '../src/domains/agent/published-models.js';
import { modelWorkspaces } from '../src/domains/governance/model-workspaces.js';
import { semanticModelRegistry } from '../src/services/semantic-model-registry.js';
import { semanticFingerprint } from '../src/services/semantic-model-fingerprint.js';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceStates, configureSemanticGovernanceRepository } from '../src/services/semantic-governance-store.js';
import { getOAMetaModelRuntimeTransactionEntry, simulateBuildOAMetaModel, publishOAMetaModel } from '../src/services/meta-model-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { configureIAMRepository, runWithIAMStoreContext } from '../src/services/iam-store.js';
import { iamWorkspaceKey } from '../src/services/iam-workspace-model.js';
import { resetRuntimeState, writeState } from '../src/repositories/runtime-state-repository.js';
import { asyncRuntimeStateRepository } from '../src/repositories/async-runtime-state-repository.js';
import { seedTenantIAM } from './helpers/tenant-iam-fixture.js';
import { createAgentClient } from '../../packages/agent-sdk/src/index.js';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createAgentConversation, getAgentConversation, getAgentConversationContext, recordAgentConversationExchange, pinAgentConversationGoal, recordAgentConversationTaskOutcome, configureAgentConversationRepository, listAgentConversations } from '../src/services/agent-conversation-service.js';
import { getEffectiveAccess } from '../src/services/access-control-service.js';
import { normalizeUntrustedText } from '../src/services/prompt-security-service.js';

const reader = { tenantId: 'published-catalog-tests', subjectId: 'quality@demo.local' };
const admin = { ...reader, subjectId: 'admin@demo.local' };
const originalGrants = process.env.ONTOLOGY_RUNTIME_GRANTS_JSON;
const grants = () => ({ [reader.tenantId]: { quality_manager: { metadata: true, objects: { inherited: 'DO_NOT_RETURN' }, models: {
  'quality-model': { schemaVersion: 'ontology-model-grant.v1', modelId: 'quality-model', metadata: true, objects: {} }
} } } });
let iam;
const within = work => runWithSemanticTenant(reader, work);
const workspace = (modelId, work) => semanticModelRegistry.withWorkspace({ role: { id: 'executive' }, identityScope: admin, modelId, work });
async function seedModel(modelId = 'quality-model', label = '质量模型') {
  const registry = await modelWorkspaces.list({ identityScope: admin });
  await modelWorkspaces.register({ identityScope: admin, body: { id: modelId, label, expectedRevision: registry.revision } });
  await workspace(modelId, async () => {
    const draft = { objectTypes: [{ id: 'Lot', label: '批次', key: 'id', fields: ['id', 'supplierId'], sourceSystems: ['WMS'], rawSamples: ['DO_NOT_RETURN'] },
      { id: 'Supplier', label: '供应商', key: 'id', fields: ['id'], sourceSystems: ['ERP'] }],
    relationshipTypes: [{ from: 'Lot', to: 'Supplier', predicate: 'supplied_by', cardinality: 'n:1', sourceField: 'supplierId', credential: 'DO_NOT_RETURN' }],
    policies: ['DO_NOT_RETURN'], scenario: { prompt: 'DO_NOT_RETURN' } };
    const fingerprint = semanticFingerprint(draft); const version = 'synthetic-v1';
    await mutateSemanticGovernanceStates([getOAMetaModelRuntimeTransactionEntry(), { name: 'lock', namespace: 'ontology_publication', key: 'current', initialValue: null }], values => {
      values.oaRuntime.publishedModel = { tenantId: reader.tenantId, modelId, version, fingerprint, draft, publishedAt: '2026-10-18T00:00:00.000Z', credential: 'DO_NOT_RETURN' };
      values.lock = { status: 'completed', version, fingerprint, modelId, target: { tenantId: reader.tenantId, modelId, deploymentId: 'synthetic-private-target' } };
      return { values };
    });
  });
}

test.beforeEach(() => {
  configureIAMRepository(null); configureSemanticGovernanceRepository(null); configureAgentConversationRepository(null);
  resetRuntimeState(['iam', 'semantic_model_registry', 'oa_meta_model_runtime', 'ontology_publication', 'domain_event_outbox', 'agent_conversations', 'agent_conversation_subjects']);
  iam = seedTenantIAM(reader.tenantId, ['admin@demo.local', 'quality@demo.local']);
  process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(grants());
});
test.afterEach(() => {
  configureIAMRepository(null); configureSemanticGovernanceRepository(null); configureAgentConversationRepository(null);
  if (originalGrants === undefined) delete process.env.ONTOLOGY_RUNTIME_GRANTS_JSON; else process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = originalGrants;
});

test('Brain SDK rejects coercible or path selectors before IO and only reads explicit model URLs', async () => {
  const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(catalogFixture()), { status: 200 }); };
  const catalogFixture = () => ({ contentScope: 'published_model_catalog_only', models: [] });
  try {
    const client = createAgentClient({ baseUrl: 'http://127.0.0.1:9999/api' });
    for (const modelId of ['../foreign', 'oa-governance', 'quality-model?modelId=other', { toString: () => 'quality-model' }]) assert.throws(() => client.publishedModel(modelId), TypeError);
    assert.equal(calls.length, 0); await client.publishedModels(); await client.publishedModel('quality-model');
    assert.equal(calls.length, 2); assert.match(calls[1].url, /\/agent\/published-models\/quality-model$/u);
    assert.ok(calls.every(call => (!call.options.method || call.options.method === 'GET') && !call.options.body && !call.options.headers['x-semantic-model']));
  } finally { globalThis.fetch = originalFetch; }
});

test('schema conversation SDK validates confirmation before IO and never retries an uncertain creation', async () => {
  let calls = 0; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { calls++; assert.match(url, /\/published-models\/quality-model\/conversations$/u); assert.equal(options.method, 'POST'); return new Response(JSON.stringify({ conversationMayHaveCommitted: true }), { status: 503 }); };
  try {
    const client = createAgentClient({ baseUrl: 'http://127.0.0.1:9999/api' }); const body = { confirmed: true, expectedVersion: 'synthetic-v1', expectedFingerprint: 'a'.repeat(24) };
    for (const input of [{ ...body, confirmed: false }, { ...body, modelId: 'foreign' }, { ...body, expectedFingerprint: {} }]) assert.throws(() => client.createModelConversation('quality-model', input), TypeError);
    assert.throws(() => client.createModelConversation('../foreign', body), TypeError); assert.equal(calls, 0);
    await assert.rejects(client.createModelConversation('quality-model', body), error => error.payload.conversationMayHaveCommitted === true);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('business principal sees only explicitly granted registered published schema, with zero IO and no execution activation', async () => {
  let calls = 0; const originalFetch = globalThis.fetch; globalThis.fetch = async () => { calls++; throw new Error('Network forbidden'); };
  try { await within(async () => {
    await seedModel(); await seedModel('finance-model', '财务模型');
    const catalog = await agentPublishedModels.list({ identityScope: reader });
    assert.deepEqual(catalog.models.map(model => model.modelId), ['quality-model'], JSON.stringify(catalog));
    assert.equal(catalog.models[0].graph, undefined); assert.equal(catalog.runtimeReadEnabled, false); assert.equal(catalog.chatSelectionEnabled, false);
    const detail = await agentPublishedModels.definition({ identityScope: reader, modelId: 'quality-model' });
    assert.equal(detail.model.graph.nodes.length, 2); assert.equal(detail.model.graph.edges[0].to, 'Supplier');
    assert.equal(detail.model.authority, 'published_schema_not_business_facts_or_permissions');
    assert.equal(detail.model.runtimeReadEnabled, false); assert.equal(detail.model.chatSelectionEnabled, false);
    assert.doesNotMatch(JSON.stringify(detail), /DO_NOT_RETURN|synthetic-private-target|rawSamples|credential/u);
    assert.equal((await modelWorkspaces.list({ identityScope: reader })).code, 'MODEL_WORKSPACE_FORBIDDEN', 'reader is not an executive');
    assert.equal((await agentPublishedModels.definition({ identityScope: reader, modelId: 'finance-model' })).status, 404);
    assert.equal(calls, 0);
  }); } finally { globalThis.fetch = originalFetch; }
});

test('publication producer stores the actual independent model identity without enabling runtime reads', async () => {
  await within(async () => {
    await modelWorkspaces.register({ identityScope: admin, body: { id: 'publication-producer', label: '发布记录模型绑定', expectedRevision: 0 } });
    await workspace('publication-producer', async () => {
      await simulateBuildOAMetaModel(getRole('executive'));
      const result = await publishOAMetaModel(getRole('executive'), { tenantId: reader.tenantId, version: 'synthetic-producer-v1' });
      assert.equal(result.error, undefined);
      const entry = getOAMetaModelRuntimeTransactionEntry(); const runtime = await readSemanticGovernanceState(entry.namespace, entry.key, null);
      assert.equal(runtime.publishedModel.modelId, 'publication-producer'); assert.equal(runtime.publishedModel.tenantId, reader.tenantId);
    });
  });
});

test('schema conversation pins one publication, supports exact object followups and never invokes a model or connector', async () => {
  const originalFetch = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('No provider or connector allowed'); };
  try { await within(async () => {
    await seedModel();
    const definition = (await agentPublishedModels.definition({ identityScope: reader, modelId: 'quality-model' })).model;
    const body = { confirmed: true, expectedVersion: definition.version, expectedFingerprint: definition.fingerprint };
    assert.equal((await agentPublishedModels.createConversation({ identityScope: reader, modelId: 'quality-model', body: { ...body, modelId: 'foreign' } })).status, 400);
    const created = await agentPublishedModels.createConversation({ identityScope: reader, modelId: 'quality-model', body });
    assert.equal(created.conversation.modelBinding.modelId, 'quality-model', JSON.stringify(created));
    const input = { conversationId: created.conversation.id, text: '解释批次对象的来源和关系' };
    const first = await agentPublishedModels.answerConversation({ identityScope: reader, input });
    assert.match(first.text, /WMS/u); assert.match(first.text, /Lot —supplied_by→ Supplier/u); assert.deepEqual(first.schemaObjectIds, ['Lot']);
    assert.equal(first.command, null); assert.equal(first.runId, undefined); assert.equal(first.agent.runtime.provider, 'none');
    const followup = await agentPublishedModels.answerConversation({ identityScope: reader, input: { ...input, text: '它的主键和字段是什么' } });
    assert.deepEqual(followup.schemaObjectIds, ['Lot']); assert.match(followup.text, /supplierId/u);
    assert.equal(followup.conversation.messageCount, 4);
    const correction = await agentPublishedModels.answerConversation({ identityScope: reader, input: { ...input, text: '不是批次，而是供应商对象' } });
    assert.deepEqual(correction.schemaObjectIds, ['Supplier']);
    const correctedFollowup = await agentPublishedModels.answerConversation({ identityScope: reader, input: { ...input, text: '它的字段是什么' } });
    assert.deepEqual(correctedFollowup.schemaObjectIds, ['Supplier']); assert.doesNotMatch(correctedFollowup.text, /supplierId/u);
    const explainOnly = await agentPublishedModels.answerConversation({ identityScope: reader, input: { ...input, text: '不发布，只解释批次关系' } });
    assert.deepEqual(explainOnly.schemaObjectIds, ['Lot']);
    const notAnId = await agentPublishedModels.answerConversation({ identityScope: reader, input: { ...input, text: 'Lottery' } });
    assert.deepEqual(notAnId.schemaObjectIds, []); assert.equal(notAnId.task.phase, 'schema_selection_required');
    for (const text of ['查询实际库存数量', '修改并发布模型', '生成文件到桌面']) {
      const blocked = await agentPublishedModels.answerConversation({ identityScope: reader, input: { ...input, text } });
      assert.equal(blocked.task.phase, 'schema_scope_only'); assert.equal(blocked.command, null); assert.deepEqual(blocked.schemaObjectIds, []);
    }
    assert.equal((await agentPublishedModels.answerConversation({ identityScope: reader, input: { ...input, attachments: [{}] } })).status, 400);
    assert.equal(calls, 0);
  }); } finally { globalThis.fetch = originalFetch; }
});

test('lost creation or message storage receipts disclose uncertain local commits and never fabricate a reply', async () => {
  await within(async () => {
    await seedModel(); const model = (await agentPublishedModels.definition({ identityScope: reader, modelId: 'quality-model' })).model;
    configureAgentConversationRepository({ ...asyncRuntimeStateRepository, async mutateStates(...args) { await asyncRuntimeStateRepository.mutateStates(...args); throw new Error('Synthetic create receipt loss'); } });
    const created = await agentPublishedModels.createConversation({ identityScope: reader, modelId: model.modelId, body: { confirmed: true, expectedVersion: model.version, expectedFingerprint: model.fingerprint } });
    assert.equal(created.conversationMayHaveCommitted, true); assert.equal(created.conversation, undefined);
    configureAgentConversationRepository(null);
    const stored = await listAgentConversations(reader); assert.equal(stored.length, 1);
    configureAgentConversationRepository({ ...asyncRuntimeStateRepository, async mutateState(...args) { await asyncRuntimeStateRepository.mutateState(...args); throw new Error('Synthetic message receipt loss'); } });
    const answer = await agentPublishedModels.answerConversation({ identityScope: reader, input: { conversationId: stored[0].id, text: 'Lot字段' } });
    assert.equal(answer.conversationMayHaveCommitted, true); assert.equal(answer.text, undefined); assert.equal(answer.conversation, undefined);
    configureAgentConversationRepository(null);
    assert.equal((await listAgentConversations(reader))[0].messageCount, 2, 'one committed exchange remains available for explicit readback');
  });
});

test('large structure explanations disclose whole-line budgets and survive history reload without silent storage truncation', async () => {
  await within(async () => {
    await seedModel();
    await workspace('quality-model', async () => {
      await mutateSemanticGovernanceStates([getOAMetaModelRuntimeTransactionEntry(), { name: 'lock', namespace: 'ontology_publication', key: 'current', initialValue: null }], values => {
        const published = values.oaRuntime.publishedModel;
        for (const node of published.draft.objectTypes) node.fields = ['id', ...Array.from({ length: 99 }, (_, i) => `field${i}_${'x'.repeat(50)}`)];
        published.fingerprint = semanticFingerprint(published.draft); values.lock.fingerprint = published.fingerprint;
        return { values };
      });
    });
    const model = (await agentPublishedModels.definition({ identityScope: reader, modelId: 'quality-model' })).model;
    const created = await agentPublishedModels.createConversation({ identityScope: reader, modelId: model.modelId, body: { confirmed: true, expectedVersion: model.version, expectedFingerprint: model.fingerprint } });
    const result = await agentPublishedModels.answerConversation({ identityScope: reader, input: { conversationId: created.conversation.id, text: 'Lot Supplier 字段' } });
    assert.equal(result.schemaEvidence.truncated, true); assert.ok(result.text.length <= 7200); assert.match(result.text, /长度预算限制/u);
    const accessContext = await runWithIAMStoreContext(() => getEffectiveAccess(null, reader), reader.tenantId);
    const restored = await getAgentConversation(created.conversation.id, reader, accessContext);
    assert.equal(restored.messages.at(-1).text, normalizeUntrustedText(result.text), 'history applies its existing Unicode normalization but must preserve the entire bounded reply');
    await workspace('quality-model', async () => {
      await mutateSemanticGovernanceStates([getOAMetaModelRuntimeTransactionEntry(), { name: 'lock', namespace: 'ontology_publication', key: 'current', initialValue: null }], values => {
        const published = values.oaRuntime.publishedModel;
        published.draft.objectTypes[0].fields = ['id', ...Array.from({ length: 99 }, (_, i) => `field${i}_${'㈜'.repeat(40)}`)];
        published.fingerprint = semanticFingerprint(published.draft); values.lock.fingerprint = published.fingerprint; return { values };
      });
    });
    const expandedModel = (await agentPublishedModels.definition({ identityScope: reader, modelId: model.modelId })).model;
    const expandedConversation = await agentPublishedModels.createConversation({ identityScope: reader, modelId: model.modelId, body: { confirmed: true, expectedVersion: expandedModel.version, expectedFingerprint: expandedModel.fingerprint } });
    const expanded = await agentPublishedModels.answerConversation({ identityScope: reader, input: { conversationId: expandedConversation.conversation.id, text: 'Lot 字段' } });
    assert.equal(expanded.schemaEvidence.truncated, true); assert.ok(normalizeUntrustedText(expanded.text).length <= 7200);
    const reloaded = await getAgentConversation(expandedConversation.conversation.id, reader, accessContext);
    assert.equal(reloaded.messages.at(-1).text, normalizeUntrustedText(expanded.text));
  });
});

test('model-bound history cannot be reused for another model, ordinary tasks, business outcomes or global pinned memories', async () => {
  await within(async () => {
    await seedModel();
    const model = (await agentPublishedModels.definition({ identityScope: reader, modelId: 'quality-model' })).model;
    const result = await agentPublishedModels.createConversation({ identityScope: reader, modelId: model.modelId, body: { confirmed: true, expectedVersion: model.version, expectedFingerprint: model.fingerprint } });
    const id = result.conversation.id; const accessContext = await runWithIAMStoreContext(() => getEffectiveAccess(null, reader), reader.tenantId);
    const context = await getAgentConversationContext(id, reader, accessContext);
    const record = response => recordAgentConversationExchange({ conversationId: id, identityScope: reader, accessContext, userText: 'test', expectedModelRevision: context.modelConversationRevision, response });
    assert.equal(await record({ text: 'legacy' }), null);
    assert.equal(await record({ text: 'foreign', modelBinding: { ...context.modelBinding, modelId: 'other-model' } }), null);
    assert.equal(await record({ text: 'execute', modelBinding: context.modelBinding, runId: 'foreign-run' }), null);
    assert.equal(await recordAgentConversationTaskOutcome({ conversationId: id, identityScope: reader, accessContext, response: { text: '业务结果' } }), null);
    assert.equal((await pinAgentConversationGoal(id, reader, accessContext)).code, 'AGENT_MODEL_MEMORY_FORBIDDEN');
    const ordinary = await createAgentConversation({ roleId: 'quality_manager', identityScope: reader, accessContext });
    assert.equal(await recordAgentConversationExchange({ conversationId: ordinary.id, identityScope: reader, accessContext, userText: 'test', response: { text: 'test', modelBinding: context.modelBinding } }), null);
    const answered = await agentPublishedModels.answerConversation({ identityScope: reader, input: { conversationId: id, text: 'Lot字段' } });
    assert.equal(answered.conversation.messageCount, 2);
    assert.equal(await record({ text: 'late', modelBinding: context.modelBinding }), null, 'stale message revision cannot overwrite the latest object focus');
    assert.equal((await agentPublishedModels.answerConversation({ identityScope: { ...reader, subjectId: 'admin@demo.local' }, input: { conversationId: id, text: 'Lot字段' } })).status, 404);
  });
});

test('new publication or grant revocation stops a bound conversation instead of querying the default model', async () => {
  await within(async () => {
    await seedModel(); const model = (await agentPublishedModels.definition({ identityScope: reader, modelId: 'quality-model' })).model;
    const created = await agentPublishedModels.createConversation({ identityScope: reader, modelId: model.modelId, body: { confirmed: true, expectedVersion: model.version, expectedFingerprint: model.fingerprint } });
    await workspace(model.modelId, async () => {
      await mutateSemanticGovernanceStates([getOAMetaModelRuntimeTransactionEntry(), { name: 'lock', namespace: 'ontology_publication', key: 'current', initialValue: null }], values => {
        values.oaRuntime.publishedModel.version = 'synthetic-v2'; values.lock.version = 'synthetic-v2'; return { values };
      });
    });
    const input = { conversationId: created.conversation.id, text: 'Lot字段' };
    assert.equal((await agentPublishedModels.answerConversation({ identityScope: reader, input })).code, 'AGENT_MODEL_VERSION_CHANGED');
    process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = '{}';
    assert.equal((await agentPublishedModels.answerConversation({ identityScope: reader, input })).status, 404);
    const current = await agentPublishedModels.createConversation({ identityScope: reader, modelId: model.modelId, body: { confirmed: true, expectedVersion: model.version, expectedFingerprint: model.fingerprint } });
    assert.equal(current.status, 404);
  });
});

test('unknown identities, missing page/run permissions, malformed selectors and legacy-only grants fail closed', async () => {
  await within(async () => {
    await seedModel();
    assert.equal((await agentPublishedModels.list({ identityScope: { ...reader, subjectId: 'unknown' } })).status, 403);
    for (const modelId of ['../foreign', 'oa-governance', 'quality-model?tenant=other', { toString: () => 'quality-model' }]) assert.equal((await agentPublishedModels.definition({ identityScope: reader, modelId })).status, 400);
    const configuration = grants(); delete configuration[reader.tenantId].quality_manager.models;
    process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(configuration);
    assert.deepEqual((await agentPublishedModels.list({ identityScope: reader })).models, []);
    process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify(grants());
    for (const permission of ['page.agent.view', 'agent.prompt.run']) {
      const denied = structuredClone(iam); const key = permission === 'page.agent.view' ? 'menuIds' : 'buttonPermissionIds';
      denied.rolePolicies.quality_manager[key] = denied.rolePolicies.quality_manager[key].filter(item => item !== (permission === 'page.agent.view' ? 'agent' : permission));
      writeState('iam', iamWorkspaceKey(reader.tenantId), denied);
      assert.equal((await agentPublishedModels.list({ identityScope: reader })).status, 403);
    }
    assert.equal((await agentPublishedModels.list({ identityScope: { ...reader, tenantId: 'foreign' } })).error !== undefined, true);
  });
});

test('wrong tenant/model/fingerprint, missing binding, unresolved publication and invalid graph never return a partial catalog', async () => {
  await within(async () => {
    await seedModel();
    await workspace('quality-model', async () => {
      const entry = getOAMetaModelRuntimeTransactionEntry();
      const original = await readSemanticGovernanceState(entry.namespace, entry.key, null);
      const lock = await readSemanticGovernanceState('ontology_publication', 'current', null);
      for (const mutate of [value => { value.publishedModel.modelId = 'foreign'; }, value => { value.publishedModel.tenantId = 'foreign'; },
        value => { delete value.publishedModel.modelId; }, value => { value.publishedModel.fingerprint = '0'.repeat(24); },
        value => { value.publishedModel.draft.objectTypes.push(value.publishedModel.draft.objectTypes[0]); },
        value => { value.publishedModel.draft.relationshipTypes[0].to = 'Unknown'; },
        value => { value.publishedModel.draft.objectTypes[0].sourceSystems = ['https://invalid.example/private']; },
        value => { value.publishedModel.draft.objectTypes[0].fields = Array.from({ length: 101 }, (_, i) => `field${i}`); },
        value => { value.publishedModel.draft.relationshipTypes = Array.from({ length: 401 }, () => value.publishedModel.draft.relationshipTypes[0]); }]) {
        const changed = structuredClone(original); mutate(changed);
        await mutateSemanticGovernanceStates([entry], () => ({ values: { oaRuntime: changed } }));
        const result = await agentPublishedModels.list({ identityScope: reader });
        assert.equal(result.status, 409, JSON.stringify(result)); assert.equal(result.models, undefined);
      }
      await mutateSemanticGovernanceStates([entry, { name: 'lock', namespace: 'ontology_publication', key: 'current', initialValue: null }], () => ({ values: { oaRuntime: original, lock: { ...lock, status: 'reconciliation_required' } } }));
      assert.equal((await agentPublishedModels.definition({ identityScope: reader, modelId: 'quality-model' })).status, 409);
    });
  });
});

test('late IAM, grant, registration and publication changes withhold the entire result', async () => {
  await within(async () => {
    await seedModel(); const stableGrants = JSON.stringify(grants());
    for (const kind of ['iam', 'grant', 'registration', 'publication']) {
      let fired = false; let runtimeReads = 0;
      configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, async readState(...args) {
        const value = await asyncRuntimeStateRepository.readState(...args);
        if (args[0] === 'oa_meta_model_runtime') runtimeReads++;
        if (!fired && runtimeReads === 2 && args[0] === 'ontology_publication') {
          fired = true;
          if (kind === 'iam') { const denied = structuredClone(iam); denied.rolePolicies.quality_manager.buttonPermissionIds = []; writeState('iam', iamWorkspaceKey(reader.tenantId), denied); }
          if (kind === 'grant') process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = '{}';
          if (kind === 'registration') await asyncRuntimeStateRepository.mutateState('semantic_model_registry', JSON.stringify(['semantic-tenant-v1', reader.tenantId, 'index']), {}, registry => ({ value: { ...registry, revision: registry.revision + 1 } }));
          if (kind === 'publication') return { ...value, version: 'synthetic-changed' };
        }
        return value;
      } });
      const result = await agentPublishedModels.list({ identityScope: reader });
      assert.equal(fired, true); assert.equal(result.status, 409, `${kind}: ${JSON.stringify(result)}`); assert.equal(result.models, undefined);
      configureSemanticGovernanceRepository(null); process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = stableGrants; writeState('iam', iamWorkspaceKey(reader.tenantId), iam);
    }
  });
});

test('real HTTP catalog and schema reads use business identities and isolate two tenants', { timeout: 20000 }, async () => {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = fork('backend/test/helpers/tenant-iam-http-worker.mjs', [], { execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_ENV: 'test', NODE_TEST_CONTEXT: 'child-v8', RUNTIME_STORE_DRIVER: 'memory', IAM_STORE_DRIVER: 'runtime', IDENTITY_SESSION_STORE_DRIVER: 'runtime',
      IDENTITY_PROVIDERS_FILE: '', DEMO_ALLOW_ROLE_HEADER: 'false', API_HOST: '127.0.0.1', PORT: String(port), ONTOLOGY_RUNTIME_GRANTS_JSON: '{}' } });
  let childLog = ''; child.stdout.on('data', data => { childLog += data; }); child.stderr.on('data', data => { childLog += data; }); const closed = once(child, 'close');
  try {
    await Promise.race([once(child, 'message'), closed.then(() => { throw new Error(`Synthetic API failed: ${childLog}`); })]);
    const seeded = once(child, 'message'); child.send('seed-published-catalog'); const [{ readers }] = await seeded;
    const base = `http://127.0.0.1:${port}`; let ready = false;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/api/health/live`)).ok) { ready = true; break; } } catch { /* Isolated fixture listener only. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    const call = async (tenant, path = '', method = 'GET', body) => {
      const response = await fetch(`${base}/api/agent/published-models${path}`, { method, headers: { 'x-identity-session': readers[tenant], 'x-client-device-id': 'test-device', 'x-tenant-id': 'http-b', 'x-demo-role': 'executive', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    const agent = async (tenant, path, body) => {
      const response = await fetch(`${base}/api/agent${path}`, { method: 'POST', headers: { 'x-identity-session': readers[tenant], 'x-client-device-id': 'test-device', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const conversations = {};
    for (const tenant of ['http-a', 'http-b']) {
      const catalog = await call(tenant); assert.equal(catalog.status, 200, JSON.stringify(catalog.body)); assert.equal(catalog.body.models.length, 1);
      const result = await call(tenant, '/catalog-model'); assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.model.graph.nodes[0].label, `${tenant}批次`); assert.equal(result.body.model.runtimeReadEnabled, false);
      assert.doesNotMatch(JSON.stringify(result.body), new RegExp(tenant === 'http-a' ? 'http-b' : 'http-a', 'u'));
      assert.equal((await call(tenant, '/catalog-model?tenantId=other')).status, 400);
      assert.equal((await call(tenant, '/catalog-model', 'POST')).status, 400);
      assert.equal((await call(tenant, '/unknown-model')).status, 404);
      assert.equal((await call(tenant, '/oa-governance')).status, 400);
      const createBody = { confirmed: true, expectedVersion: result.body.model.version, expectedFingerprint: result.body.model.fingerprint };
      assert.equal((await call(tenant, '/catalog-model/conversations')).status, 400);
      assert.equal((await call(tenant, '/catalog-model/conversations', 'POST', { ...createBody, modelId: 'foreign' })).status, 400);
      const created = await call(tenant, '/catalog-model/conversations', 'POST', createBody);
      assert.equal(created.status, 201, JSON.stringify(created.body)); conversations[tenant] = created.body.conversation.id;
      assert.equal(created.body.conversation.modelBinding.mode, 'published_schema_only');
      const response = await agent(tenant, '/message', { input: { conversationId: conversations[tenant], text: '解释批次对象字段' } });
      assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.agent.runtime.provider, 'none');
      assert.equal(response.body.modelBinding.fingerprint, result.body.model.fingerprint); assert.match(response.body.text, new RegExp(`${tenant}批次`, 'u'));
      const unsupported = await agent(tenant, '/message', { input: { conversationId: conversations[tenant], text: '查最新库存数量' } });
      assert.equal(unsupported.body.task.phase, 'schema_scope_only'); assert.equal(unsupported.body.command, null);
      assert.equal((await agent(tenant, '/message', { input: { conversationId: conversations[tenant], text: '字段', modelId: 'other-model' } })).status, 400);
      assert.equal((await agent(tenant, '/execute', { conversationId: conversations[tenant], runId: 'foreign', commandId: 'publish_model' })).body.code, 'AGENT_MODEL_ACTION_FORBIDDEN');
      assert.equal((await agent(tenant, `/conversations/${conversations[tenant]}/pin`, {})).body.code, 'AGENT_MODEL_MEMORY_FORBIDDEN');
      assert.equal((await agent(tenant, '/conversations', { modelBinding: created.body.conversation.modelBinding })).status, 400);
      assert.equal((await agent(tenant, `/conversations/${conversations[tenant]}/archive`, {})).status, 200);
      assert.equal((await agent(tenant, '/execute', { conversationId: conversations[tenant], runId: 'foreign', commandId: 'publish_model' })).body.code, 'AGENT_MODEL_ACTION_FORBIDDEN');
      assert.equal((await agent(tenant, '/cancel', { conversationId: conversations[tenant], runId: 'foreign' })).body.code, 'AGENT_MODEL_ACTION_FORBIDDEN');
    }
    assert.equal((await agent('http-a', '/message', { input: { conversationId: conversations['http-b'], text: '解释模型' } })).status, 404);
    assert.equal((await fetch(`${base}/api/agent/published-models`, { headers: { 'x-demo-role': 'executive', 'x-tenant-id': 'http-a' } })).status, 401);
  } finally { child.kill(); await closed; }
});

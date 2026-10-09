import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { knowledgeModelLinks } from '../src/domains/knowledge/public-api.js';
import { saveLibraryDocument, retractLibraryDocument } from '../src/services/knowledge-library-service.js';
import { createLocalKnowledgeProvider, buildKnowledgeBrief } from '../src/services/knowledge-evidence-service.js';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft } from '../src/services/meta-model-service.js';
import { getRole } from '../src/services/authorization-service.js';
const context = { identityScope: { tenantId: 'link-company', subjectId: 'alice' }, roleId: 'executive' };
const options = { context, resolveProvider: () => createLocalKnowledgeProvider(context), canRead: () => true };
test.beforeEach(() => resetRuntimeState(['knowledge_model_links_v1', 'knowledge_library_v1', 'oa_meta_model_runtime', 'domain_event_outbox']));
async function fixture() {
  await saveLibraryDocument({ ...context, id: 'policy', body: { expectedRevision: 0, title: '合成组织规范', source: '合成制度', sourceVersion: 'v1', kind: 'policy', text: '组织负责采购申请审核。' } });
  const evidence = await buildKnowledgeBrief({ provider: createLocalKnowledgeProvider(context), query: '采购申请', canRead: () => true });
  const model = await knowledgeModelLinks.list(options);
  return { objectId: model.objects[0].id, modelFingerprint: model.modelFingerprint, relationType: 'definition', citation: evidence.evidence[0].citation, confirmed: true };
}
test('confirmed links bind authoritative sources and model versions; duplicates are idempotent', async () => {
  const body = await fixture(); const result = await knowledgeModelLinks.save({ ...options, body });
  assert.equal(result.revision, 1);
  assert.equal((await knowledgeModelLinks.save({ ...options, body })).unchanged, true);
  const list = await knowledgeModelLinks.list(options);
  assert.equal(list.links.length, 1); assert.equal(list.links[0].status, 'confirmed');
  assert.match(list.links[0].excerpt, /采购申请/);
  const retracted = await knowledgeModelLinks.retract({ ...options, id: result.id, body: { expectedRevision: 1 } });
  assert.equal(retracted.status, 'retracted');
  assert.equal((await knowledgeModelLinks.retract({ ...options, id: result.id, body: { expectedRevision: 1 } })).status, 409);
  assert.equal((await knowledgeModelLinks.list(options)).links[0].excerpt, undefined);
});
test('source revocation and model changes invalidate links instead of recycling old evidence', async () => {
  const body = await fixture(); await knowledgeModelLinks.save({ ...options, body });
  await retractLibraryDocument({ ...context, id: 'policy', expectedRevision: 1 });
  const stale = (await knowledgeModelLinks.list(options)).links[0];
  assert.equal(stale.status, 'needs_review'); assert.equal(stale.excerpt, undefined); assert.equal(stale.citation, undefined);
});
test('model change rejects stale save and marks existing association for review', async () => {
  const body = await fixture(); await knowledgeModelLinks.save({ ...options, body });
  await runWithSemanticTenant(context.identityScope, async () => {
    const model = await getOAMetaModelDraft();
    await saveOAMetaModelDraft({ ...model, policies: [...model.policies, 'mock additional rule'] }, getRole('executive'));
  });
  assert.equal((await knowledgeModelLinks.save({ ...options, body })).code, 'KNOWLEDGE_MODEL_CHANGED');
  assert.equal((await knowledgeModelLinks.list(options)).links[0].status, 'needs_review');
});
test('links isolate tenant, subject and role; forge and revoked permission fail', async () => {
  const body = await fixture(); const saved = await knowledgeModelLinks.save({ ...options, body });
  for (const changed of [{ identityScope: { ...context.identityScope, tenantId: 'other' } }, { identityScope: { ...context.identityScope, subjectId: 'bob' } }, { roleId: 'quality_manager' }]) {
    const other = { ...context, ...changed };
    const scoped = { ...options, context: other, resolveProvider: () => createLocalKnowledgeProvider(other) };
    assert.deepEqual((await knowledgeModelLinks.list(scoped)).links, []);
    assert.equal((await knowledgeModelLinks.retract({ ...scoped, id: saved.id, body: { expectedRevision: 1 } })).status, 404);
  }
  for (const changed of [{ confirmed: false }, { objectId: 'not-in-model' }, { tenantId: 'other' }, { citation: { ...body.citation, start: 999 } }]) assert.ok((await knowledgeModelLinks.save({ ...options, body: { ...body, ...changed } })).error);
  assert.equal((await knowledgeModelLinks.list({ ...options, canRead: () => false })).status, 403);
});

test('permission revoked while assembling a graph never returns partial evidence', async () => {
  const body = await fixture(); await knowledgeModelLinks.save({ ...options, body });
  let checks = 0;
  const result = await knowledgeModelLinks.list({ ...options, canRead: () => ++checks < 3 });
  assert.equal(result.status, 403); assert.equal(result.links, undefined);
});

test('source revoked between graph assembly and final revalidation rejects the whole graph', async () => {
  const body = await fixture(); await knowledgeModelLinks.save({ ...options, body });
  let reads = 0;
  const provider = createLocalKnowledgeProvider(context);
  const result = await knowledgeModelLinks.list({ ...options, resolveProvider: () => ({ read: async citation => {
    if (++reads === 2) await retractLibraryDocument({ ...context, id: 'policy', expectedRevision: 1 });
    return provider.read(citation);
  } }) });
  assert.equal(result.code, 'KNOWLEDGE_EVIDENCE_CHANGED'); assert.equal(result.links, undefined);
});

test('Agent association suggestions are bounded, source-verified candidates and never silently saved', async () => {
  const body = await fixture();
  const result = await knowledgeModelLinks.suggest({ ...options, body: { citations: [body.citation], confirmed: true, modelFingerprint: body.modelFingerprint } });
  assert.equal(result.persisted, false); assert.equal(result.method, 'bounded_exact_mentions_no_model_call');
  assert.ok(result.suggestions.some(item => item.objectLabel === '组织' && item.status === 'candidate'));
  assert.deepEqual((await knowledgeModelLinks.list(options)).links, []);
  assert.equal((await knowledgeModelLinks.suggest({ ...options, body: { citations: [body.citation], confirmed: false, modelFingerprint: body.modelFingerprint } })).status, 400);
  await retractLibraryDocument({ ...context, id: 'policy', expectedRevision: 1 });
  assert.ok((await knowledgeModelLinks.suggest({ ...options, body: { citations: [body.citation], confirmed: true, modelFingerprint: body.modelFingerprint } })).error);
});

test('model associations require consent and bound targets and server-verified source pointers', async () => {
  const body = await fixture();
  const policy = () => ({ enabled: true, provider: 'mock_cloud', model: 'test', dataEgress: 'cloud' });
  let calls = 0;
  const generate = async () => { calls++; return { source: 'mock_cloud', text: JSON.stringify({ claims: [{ text: JSON.stringify({ targetId: body.objectId, reason: '规范定义该对象的审核职责，需要人工核对。', relationType: 'rule' }), sources: [{ index: 1, segment: 1 }] }], unknowns: [] }) }; };
  const input = { citations: [body.citation], modelFingerprint: body.modelFingerprint, confirmed: true, mode: 'model' };
  assert.equal((await knowledgeModelLinks.suggest({ ...options, body: input, policy, generate })).code, 'KNOWLEDGE_MODEL_CONSENT_REQUIRED');
  assert.equal(calls, 0);
  input.consent = { provider: 'mock_cloud', model: 'test', confirmed: true };
  const result = await knowledgeModelLinks.suggest({ ...options, body: input, policy, generate });
  assert.equal(result.modelCalled, true); assert.equal(result.persisted, false); assert.equal(result.suggestions[0].relationType, 'rule');
  assert.match(result.suggestions[0].excerpt, /组织/); assert.deepEqual((await knowledgeModelLinks.list(options)).links, []);
  assert.equal((await knowledgeModelLinks.suggest({ ...options, body: { ...input, targetIds: ['foreign'] }, policy, generate })).status, 400);
  assert.equal((await knowledgeModelLinks.suggest({ ...options, body: { ...input, targetIds: [body.objectId] }, policy, generate })).suggestions[0].objectId, body.objectId);
  const invented = await knowledgeModelLinks.suggest({ ...options, body: input, policy, generate: async () => ({ source: 'mock_cloud', text: JSON.stringify({ claims: [{ text: JSON.stringify({ targetId: 'invented', reason: '不存在', relationType: 'rule' }), sources: [{ index: 1, segment: 1 }] }], unknowns: [] }) }) });
  assert.equal(invented.code, 'KNOWLEDGE_ASSOCIATION_CONTRACT_INVALID');
});

test('revoking evidence during model association returns no suggestions', async () => {
  const body = await fixture();
  const result = await knowledgeModelLinks.suggest({ ...options, body: { citations: [body.citation], modelFingerprint: body.modelFingerprint, confirmed: true, mode: 'model', consent: { provider: 'mock_cloud', model: 'test', confirmed: true } }, policy: () => ({ enabled: true, provider: 'mock_cloud', model: 'test' }), generate: async () => { await retractLibraryDocument({ ...context, id: 'policy', expectedRevision: 1 }); return { source: 'mock_cloud', text: '{"claims":[],"unknowns":[]}' }; } });
  assert.ok(result.error); assert.equal(result.suggestions, undefined);
});

test('human relation-level association requires an existing model relation and invalidates with model changes', async () => {
  const body = await fixture(); const targets = await knowledgeModelLinks.list(options);
  const relation = targets.objects.find(item => item.targetType === 'relationship'); assert.ok(relation);
  assert.equal((await knowledgeModelLinks.save({ ...options, body: { ...body, objectId: relation.id } })).revision, 1);
  assert.equal((await knowledgeModelLinks.list(options)).links[0].objectId, relation.id);
  assert.ok((await knowledgeModelLinks.save({ ...options, body: { ...body, objectId: JSON.stringify(['relationship', 'Missing', 'fake', 'Other']) } })).error);
});

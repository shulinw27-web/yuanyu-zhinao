import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { knowledgeModelLinks } from '../src/domains/knowledge/public-api.js';
import { runWithSemanticTenant, getOAMetaModelDraft } from '../src/domains/governance/public-api.js';
import { saveOAMetaModelDraft } from '../src/services/meta-model-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { handleKnowledgeRoutes } from '../src/routes/knowledge-routes.js';
const context = { identityScope: { tenantId: 'views-company', subjectId: 'alice' }, roleId: 'executive' };
const options = { context, canRead: () => true };
const views = knowledgeModelLinks.views;
test.beforeEach(() => resetRuntimeState(['ontology_private_views_v1', 'oa_meta_model_runtime', 'domain_event_outbox']));
async function fixture() {
  const { modelFingerprint } = await views.list(options);
  const model = await runWithSemanticTenant(context.identityScope, getOAMetaModelDraft);
  return { expectedRevision: 0, label: '采购关系', selectedId: model.objectTypes[0].id, modelFingerprint, layout: { fingerprint: modelFingerprint, positions: { [model.objectTypes[0].id]: { x: 24, y: 70 } }, scale: 1.2, offset: { x: 0, y: 20 } } };
}
test('persistent views restore layout and selection and enforce revision compare-and-swap', async () => {
  const body = await fixture(); const result = await views.save({ ...options, body }); assert.equal(result.view.revision, 1);
  assert.deepEqual((await views.read({ ...options, id: result.view.id })).view.layout, body.layout);
  assert.equal((await views.list(options)).views[0].current, true);
  const update = { ...body, id: result.view.id, expectedRevision: 1, label: '新版视图' };
  assert.equal((await views.save({ ...options, body: update })).view.revision, 2);
  assert.equal((await views.save({ ...options, body: update })).code, 'KNOWLEDGE_REVISION_CONFLICT');
});
test('links convey no authority across tenants, users or roles; revoked reads fail', async () => {
  const result = await views.save({ ...options, body: await fixture() });
  for (const changed of [{ identityScope: { ...context.identityScope, tenantId: 'other' } }, { identityScope: { ...context.identityScope, subjectId: 'bob' } }, { roleId: 'quality_manager' }]) {
    const scoped = { ...options, context: { ...context, ...changed } };
    assert.deepEqual((await views.list(scoped)).views, []); assert.equal((await views.read({ ...scoped, id: result.view.id })).status, 404);
  }
  assert.equal((await views.read({ ...options, id: result.view.id, canRead: () => false })).status, 403);
  let checks = 0; assert.equal((await views.read({ ...options, id: result.view.id, canRead: () => ++checks < 2 })).status, 403);
});
test('views reject model changes, foreign coordinates, negative values and arbitrary payloads', async () => {
  const body = await fixture(); const saved = await views.save({ ...options, body });
  for (const layout of [{ ...body.layout, positions: { ForeignType: { x: 0, y: 0 } } }, { ...body.layout, scale: 999 }, { ...body.layout, businessRecords: [] }, { ...body.layout, positions: { [body.selectedId]: { x: -1, y: 0 } } }]) assert.equal((await views.save({ ...options, body: { ...body, layout } })).status, 400);
  await runWithSemanticTenant(context.identityScope, async () => { const draft = await getOAMetaModelDraft(); await saveOAMetaModelDraft({ ...draft, policies: [...draft.policies, 'synthetic change'] }, getRole('executive')); });
  assert.equal((await views.read({ ...options, id: saved.view.id })).code, 'KNOWLEDGE_MODEL_CHANGED');
  assert.equal((await views.list(options)).views[0].current, false);
  assert.equal((await views.save({ ...options, body })).code, 'KNOWLEDGE_MODEL_CHANGED');
});

test('personal view budget is bounded and list metadata does not reveal layouts', async () => {
  const body = await fixture();
  for (let index = 0; index < 20; index++) assert.ok((await views.save({ ...options, body: { ...body, label: `合成视图${index}` } })).view);
  assert.equal((await views.save({ ...options, body })).status, 413);
  const result = await views.list(options); assert.equal(result.views.length, 20); assert.ok(result.views.every(item => !item.layout && item.selectedId === undefined));
});

test('view HTTP endpoints enforce page and mutation permissions before reading request bodies', async () => {
  let reads = 0; let denied = '';
  const args = { req: { method: 'POST' }, res: {}, url: new URL('http://local/api/semantic-operations/knowledge-library/model-views'), role: context.roleId, agentIdentity: context.identityScope, effectiveAccess: { pagePermissionIds: ['page.semantic-operations.view'] }, selectActionRole: () => false, denyButton: id => { denied = id; }, readBody: async () => { reads++; return {}; }, send() {} };
  assert.equal(await handleKnowledgeRoutes(args), true); assert.equal(denied, 'meta_model.draft.save'); assert.equal(reads, 0);
  let response; await handleKnowledgeRoutes({ ...args, req: { method: 'GET' }, effectiveAccess: { pagePermissionIds: [] }, send: (_res, status, payload) => { response = { status, payload }; } });
  assert.equal(response.status, 403); assert.equal(response.payload.views, undefined);
});

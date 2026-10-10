import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resetRuntimeState, readState, writeState } from '../src/repositories/runtime-state-repository.js';
import { knowledgeModelLinks } from '../src/domains/knowledge/public-api.js';
import { runWithSemanticTenant, getOAMetaModelDraft } from '../src/domains/governance/public-api.js';
import { saveOAMetaModelDraft } from '../src/services/meta-model-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { handleKnowledgeRoutes } from '../src/routes/knowledge-routes.js';
import { runWithIAMStoreContext } from '../src/services/iam-store.js';
const context = { identityScope: { tenantId: 'views-company', subjectId: 'alice' }, roleId: 'executive' };
const options = { context, canRead: () => true };
const views = knowledgeModelLinks.views;
const teamModelViews = knowledgeModelLinks.teamViews;
test.beforeEach(() => resetRuntimeState(['ontology_private_views_v1', 'ontology_team_views_v1', 'ontology_team_view_archives_v1', 'oa_meta_model_runtime', 'domain_event_outbox']));
async function fixture() {
  const { modelFingerprint } = await views.list(options);
  const model = await runWithSemanticTenant(context.identityScope, getOAMetaModelDraft);
  return { expectedRevision: 0, label: '采购关系', selectedId: model.objectTypes[0].id, modelFingerprint, layout: { fingerprint: modelFingerprint, positions: { [model.objectTypes[0].id]: { x: 24, y: 70 } }, scale: 1.2, offset: { x: 0, y: 20 } } };
}

async function sharedFixture() {
  const body = await fixture(); const saved = await views.save({ ...options, body });
  const shared = await teamModelViews.share({ ...options, id: saved.view.id, body: { expectedRevision: 1, modelFingerprint: body.modelFingerprint } });
  assert.ok(shared.view, shared.error); return { body, saved, shared };
}

test('explicit team snapshot is reviewer-scoped, immutable and contains no private materials or personal ownership keys', async () => {
  const { body, saved, shared } = await sharedFixture();
  const reviewer = { ...options, context: { ...context, identityScope: { ...context.identityScope, subjectId: 'bob' }, roleId: 'quality_manager' } };
  assert.deepEqual((await views.list(reviewer)).views, []);
  const read = await teamModelViews.read({ ...reviewer, id: shared.view.id });
  assert.deepEqual(read.view.layout, body.layout); assert.equal(read.readOnly, true); assert.equal(read.view.owned, false);
  for (const key of ['owner', 'sourceId', 'sourceRevision', 'materials', 'citations']) assert.equal(read.view[key], undefined);
  const listing = await teamModelViews.list(reviewer); assert.equal(listing.views.length, 1); assert.equal(listing.views[0].layout, undefined);
  await views.save({ ...options, body: { ...body, id: saved.view.id, expectedRevision: 1, label: '个人修改后的名称' } });
  assert.equal((await teamModelViews.read({ ...reviewer, id: shared.view.id })).view.label, body.label);
  assert.equal((await teamModelViews.read({ ...reviewer, id: shared.view.id, canRead: () => false })).status, 403);
});

test('team sharing guards personal revision, identity, duplicate snapshots, injection and model changes', async () => {
  const { body, saved, shared } = await sharedFixture();
  const shareBody = { expectedRevision: 1, modelFingerprint: body.modelFingerprint };
  assert.equal((await teamModelViews.share({ ...options, id: saved.view.id, body: shareBody })).code, 'KNOWLEDGE_VIEW_ALREADY_SHARED');
  assert.equal((await teamModelViews.share({ ...options, id: saved.view.id, body: { ...shareBody, expectedRevision: 2 } })).code, 'KNOWLEDGE_REVISION_CONFLICT');
  assert.equal((await teamModelViews.share({ ...options, id: saved.view.id, body: { ...shareBody, layout: body.layout } })).status, 400);
  const outsider = { ...options, context: { ...context, identityScope: { tenantId: 'other', subjectId: 'alice' } } };
  assert.equal((await teamModelViews.read({ ...outsider, id: shared.view.id })).status, 404);
  assert.deepEqual((await teamModelViews.list(outsider)).views, []);
  const stranger = { ...options, context: { ...context, identityScope: { ...context.identityScope, subjectId: 'bob' } } };
  assert.equal((await teamModelViews.share({ ...stranger, id: saved.view.id, body: shareBody })).status, 404);
  await runWithSemanticTenant(context.identityScope, async () => { const draft = await getOAMetaModelDraft(); await saveOAMetaModelDraft({ ...draft, policies: [...draft.policies, 'changed'] }, getRole('executive')); });
  assert.equal((await teamModelViews.read({ ...options, id: shared.view.id })).code, 'KNOWLEDGE_MODEL_CHANGED');
  assert.equal((await teamModelViews.list(options)).views[0].current, false);
});

test('team snapshot retraction is owner-only, revision-bound and rechecked during concurrent reads', async () => {
  const { shared } = await sharedFixture();
  const stranger = { ...options, context: { ...context, identityScope: { ...context.identityScope, subjectId: 'bob' } } };
  const action = { id: shared.view.id, body: { expectedRevision: 1 } };
  assert.equal((await teamModelViews.retract({ ...stranger, ...action })).status, 404);
  assert.equal((await teamModelViews.retract({ ...options, ...action, body: { expectedRevision: 2 } })).code, 'KNOWLEDGE_REVISION_CONFLICT');
  let checks = 0;
  const read = await teamModelViews.read({ ...options, id: shared.view.id, canRead: async () => { if (++checks === 2) await teamModelViews.retract({ ...options, ...action }); return true; } });
  assert.equal(read.status, 404); assert.equal(read.view, undefined);
  assert.deepEqual((await teamModelViews.list(options)).views, []);
  assert.equal((await teamModelViews.retract({ ...options, ...action })).code, 'KNOWLEDGE_REVISION_CONFLICT');
});

test('team history is paginated metadata and owner-only archive retains revoked records without restoring them', async () => {
  const { shared } = await sharedFixture(); const id = shared.view.id;
  assert.equal((await teamModelViews.archive({ ...options, id, body: { expectedRevision: 1 } })).code, 'KNOWLEDGE_VIEW_RETRACTION_REQUIRED');
  await teamModelViews.retract({ ...options, id, body: { expectedRevision: 1 } });
  const stranger = { ...options, context: { ...context, identityScope: { ...context.identityScope, subjectId: 'bob' } } };
  assert.equal((await teamModelViews.archive({ ...stranger, id, body: { expectedRevision: 2 } })).status, 404);
  assert.equal((await teamModelViews.archive({ ...options, id, body: { expectedRevision: 1 } })).code, 'KNOWLEDGE_REVISION_CONFLICT');
  assert.equal((await teamModelViews.archive({ ...options, id, body: { expectedRevision: 2, erase: true } })).status, 400);
  assert.deepEqual(await teamModelViews.archive({ ...options, id, body: { expectedRevision: 2 } }), { archived: true, revision: 3, retained: true });
  const history = await teamModelViews.history({ ...stranger, limit: 1 });
  assert.equal(history.total, 1); assert.equal(history.views[0].owned, false); assert.ok(history.views[0].archivedAt);
  assert.equal(history.views[0].revoked, true); assert.equal(history.views[0].revision, 3);
  for (const field of ['layout', 'selectedId', 'owner', 'sourceId', 'sourceRevision']) assert.equal(history.views[0][field], undefined);
  assert.equal((await teamModelViews.history({ ...options, offset: 1, limit: 1 })).views.length, 0);
  assert.equal((await teamModelViews.history({ ...options, limit: 51 })).status, 400);
  assert.equal((await teamModelViews.history({ ...options, canRead: () => false })).status, 403);
  assert.equal((await teamModelViews.read({ ...options, id })).status, 404);
  assert.equal((await teamModelViews.archive({ ...options, id, body: { expectedRevision: 3 } })).status, 404);
});

test('explicit archive releases the daily history budget while preserving bounded audit history', async () => {
  const { body, saved, shared } = await sharedFixture();
  await teamModelViews.retract({ ...options, id: shared.view.id, body: { expectedRevision: 1 } });
  for (let index = 1; index < 100; index++) {
    const next = await teamModelViews.share({ ...options, id: saved.view.id, body: { expectedRevision: 1, modelFingerprint: body.modelFingerprint } });
    assert.ok(next.view);
    await teamModelViews.retract({ ...options, id: next.view.id, body: { expectedRevision: 1 } });
  }
  const sharing = { ...options, id: saved.view.id, body: { expectedRevision: 1, modelFingerprint: body.modelFingerprint } };
  assert.equal((await teamModelViews.share(sharing)).status, 413);
  await teamModelViews.archive({ ...options, id: shared.view.id, body: { expectedRevision: 2 } });
  assert.ok((await teamModelViews.share(sharing)).view);
  assert.equal((await teamModelViews.history({ ...options, offset: 20, limit: 20 })).views.length, 20);
  assert.equal((await teamModelViews.history(options)).total, 100);
});

test('archive capacity fails closed without deleting or moving any retained history', async () => {
  const { shared } = await sharedFixture(); await teamModelViews.retract({ ...options, id: shared.view.id, body: { expectedRevision: 1 } });
  const storageKey = createHash('sha256').update(JSON.stringify(['team-view', context.identityScope.tenantId])).digest('hex');
  const before = readState('ontology_team_views_v1', storageKey, []);
  const rows = Array.from({ length: 1000 }, () => ({ ...before[0], id: randomUUID(), archivedAt: new Date().toISOString() }));
  writeState('ontology_team_view_archives_v1', storageKey, rows);
  assert.equal((await teamModelViews.archive({ ...options, id: shared.view.id, body: { expectedRevision: 2 } })).code, 'KNOWLEDGE_VIEW_ARCHIVE_LIMIT');
  assert.deepEqual(readState('ontology_team_views_v1', storageKey, []), before);
  assert.deepEqual(readState('ontology_team_view_archives_v1', storageKey, []), rows);
});

test('team view HTTP writes require review and save permissions before reading bodies', async () => {
  let reads = 0; let response;
  const args = { req: { method: 'POST' }, res: {}, url: new URL('http://local/api/semantic-operations/knowledge-library/model-views/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/share'), role: 'procurement_manager', agentIdentity: context.identityScope, effectiveAccess: { pagePermissionIds: ['page.semantic-operations.view'] }, selectActionRole: () => false, denyButton: id => { response = { permission: id }; }, readBody: async () => { reads++; return {}; }, send: (_res, status, payload) => { response = { status, payload }; } };
  assert.equal(await runWithIAMStoreContext(() => handleKnowledgeRoutes(args), context.identityScope.tenantId), true); assert.equal(response.status, 403); assert.equal(reads, 0);
  await runWithIAMStoreContext(() => handleKnowledgeRoutes({ ...args, role: 'executive', agentIdentity: { tenantId: 'demo-enterprise', subjectId: 'usr-001' } }), 'demo-enterprise'); assert.equal(response.permission, 'meta_model.draft.save'); assert.equal(reads, 0);
});

test('team active snapshot budget is bounded independently of personal views', async () => {
  const body = await fixture();
  for (let index = 0; index < 20; index++) {
    const saved = await views.save({ ...options, body: { ...body, label: `团队合成${index}` } });
    assert.ok((await teamModelViews.share({ ...options, id: saved.view.id, body: { expectedRevision: 1, modelFingerprint: body.modelFingerprint } })).view);
  }
  const personal = (await views.list(options)).views[0];
  await views.save({ ...options, body: { ...body, id: personal.id, expectedRevision: 1 } });
  assert.equal((await teamModelViews.share({ ...options, id: personal.id, body: { expectedRevision: 2, modelFingerprint: body.modelFingerprint } })).status, 413);
  assert.equal((await teamModelViews.list(options)).views.length, 20);
});
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeModelLinks } from '../src/domains/knowledge/public-api.js';
import { resetRuntimeState, readState, writeState } from '../src/repositories/runtime-state-repository.js';
import { runWithIAMStoreContext } from '../src/services/iam-store.js';
import { createTenantIAMWorkspace } from '../src/services/iam-workspace-model.js';
import { getEffectiveAccess } from '../src/services/access-control-service.js';
import { handleKnowledgeRoutes } from '../src/routes/knowledge-routes.js';
import { createServer } from 'node:http';
import { listenOnFetchableLoopback } from './http-fixture-port.js';
import { createWeKnoraKnowledgeProvider, knowledgePrincipalKey } from '../src/services/weknora-knowledge-provider.js';
import { knowledgeDigest } from '../src/services/knowledge-evidence-service.js';
const reviews = knowledgeModelLinks.materialReviews;
const alice = { identityScope: { tenantId: 'review-company', subjectId: 'alice' }, roleId: 'executive' };
const bob = { ...alice, identityScope: { ...alice.identityScope, subjectId: 'bob' } };
const citation = { provider: 'weknora_local', knowledgeBaseId: 'enterprise', documentId: 'policy', chunkId: 'chunk', revision: 'a'.repeat(64), location: 'provider_chunk_not_pdf_coordinates' };
let available;
let calls;
const options = context => ({ context, canRead: () => true, resolveProvider: () => ({ read: async c => {
  calls++;
  return available ? { title: '合成采购规范', excerpt: '采购主管审核采购申请。', citation: c, revision: c.revision } : { error: 'KNOWLEDGE_ACCESS_DENIED', status: 403 };
} }) });
const submit = () => reviews.create({ ...options(alice), body: { citations: [citation], confirmed: true } });
const decide = (context, id, decision, expectedRevision = 1) => reviews.decide({ ...options(context), id, body: { decision, expectedRevision, confirmed: true } });
test.beforeEach(() => { resetRuntimeState(['iam', 'knowledge_material_reviews_v1', 'knowledge_material_review_archives_v1', 'domain_event_outbox']); available = true; calls = 0; });

test('shared review retains references only and independently verifies every reader; approval is not publication', async () => {
  const result = await submit(); const id = result.review.id;
  const stored = readState('knowledge_material_reviews_v1', knowledgeDigest(['material-review', alice.identityScope.tenantId]), []);
  assert.equal(stored.length, 1);
  assert.equal(JSON.stringify(stored).includes('采购'), false);
  assert.equal((await reviews.read({ ...options(bob), id })).sources[0].title, '合成采购规范');
  assert.equal((await reviews.list(options(bob))).reviews.length, 1);
  const accepted = await decide(bob, id, 'approved');
  assert.equal(accepted.status, 'approved'); assert.equal(accepted.revision, 2);
  assert.equal(accepted.published, false); assert.equal(accepted.grantsAuthority, false);
  assert.ok(calls >= 8);
});
test('private citations, forged fields, missing confirmation and duplicates fail without changing state', async () => {
  for (const body of [
    { citations: [{ ...citation, provider: 'local_private_library' }], confirmed: true },
    { citations: [citation], confirmed: false }, { citations: [citation], confirmed: true, tenantId: 'other' },
    { citations: [{ ...citation, excerpt: 'private' }], confirmed: true }, { citations: [citation, citation], confirmed: true }
  ]) assert.equal((await reviews.create({ ...options(alice), body })).status, 400);
  assert.equal((await reviews.list(options(alice))).reviews.length, 0);
  await submit();
  assert.equal((await submit()).error, 'KNOWLEDGE_REVIEW_ALREADY_PENDING');
});
test('separation of duties, owner withdrawal, CAS and terminal states cannot be bypassed', async () => {
  const id = (await submit()).review.id;
  assert.equal((await decide(alice, id, 'approved')).error, 'KNOWLEDGE_REVIEW_SEPARATION_REQUIRED');
  assert.equal((await decide({ ...alice, roleId: 'quality_manager' }, id, 'rejected')).status, 403);
  assert.equal((await decide(bob, id, 'withdrawn')).status, 403);
  assert.equal((await decide(bob, id, 'approved', 9)).error, 'KNOWLEDGE_REVISION_CONFLICT');
  assert.equal((await decide(alice, id, 'withdrawn')).status, 'withdrawn');
  assert.equal((await decide(bob, id, 'approved', 2)).error, 'KNOWLEDGE_REVIEW_STATE_CONFLICT');
});

test('IAM account aliases cannot bypass material review separation, including legacy rows', () => runWithIAMStoreContext(async () => {
  const iam = createTenantIAMWorkspace('demo-enterprise');
  writeState('iam', 'workspace', iam);
  const user = iam.users.find(item => item.id === 'usr-001');
  const submitter = { ...alice, identityScope: { tenantId: 'demo-enterprise', subjectId: user.account } };
  const alias = { ...submitter, roleId: 'quality_manager', identityScope: { ...submitter.identityScope, subjectId: user.id } };
  const id = (await reviews.create({ ...options(submitter), body: { citations: [citation], confirmed: true } })).review.id;
  const stateKey = knowledgeDigest(['material-review', 'demo-enterprise']);
  assert.equal((await decide(alias, id, 'approved')).error, 'KNOWLEDGE_REVIEW_SEPARATION_REQUIRED');
  // Older persisted rows only retained the raw login subject.
  const rows = readState('knowledge_material_reviews_v1', stateKey, []);
  delete rows[0].submitterPrincipal;
  writeState('knowledge_material_reviews_v1', stateKey, rows);
  const before = readState('domain_event_outbox', 'events', {});
  assert.equal((await decide(alias, id, 'rejected')).error, 'KNOWLEDGE_REVIEW_SEPARATION_REQUIRED');
  assert.deepEqual(readState('domain_event_outbox', 'events', {}), before);
  assert.equal(readState('knowledge_material_reviews_v1', stateKey, [])[0].revision, 1);
}, 'demo-enterprise'));

test('material assignment uses current IAM, CAS and assignee decisions, with atomic generic reminders', () => runWithIAMStoreContext(async () => {
  const iam = createTenantIAMWorkspace('demo-enterprise'); const user = iam.users.find(item => item.id === 'usr-001');
  iam.users.push({ ...structuredClone(user), id: 'reviewer-one', account: 'reviewer.one@example.test', name: '合成核对员一' },
    { ...structuredClone(user), id: 'reviewer-two', account: 'reviewer.two@example.test', name: '合成核对员二' });
  writeState('iam', 'workspace', iam);
  const ctx = subjectId => ({ ...alice, identityScope: { tenantId: 'demo-enterprise', subjectId } });
  const owner = ctx(user.id); const first = ctx('reviewer-one'); const second = ctx('reviewer-two');
  const id = (await reviews.create({ ...options(owner), body: { citations: [citation], confirmed: true } })).review.id;
  const assign = (context, subjectId, expectedRevision = 1) => reviews.assign({ ...options(context), id, body: { subjectId, expectedRevision, confirmed: true } });
  assert.ok((await reviews.reviewers(options(owner))).reviewers.some(person => person.subjectId === 'reviewer-one'));
  assert.equal((await assign(owner, user.id)).error, 'KNOWLEDGE_REVIEW_SEPARATION_REQUIRED');
  assert.equal((await assign(second, 'reviewer-one')).status, 403);
  assert.equal((await assign(owner, 'missing-user')).error, 'KNOWLEDGE_REVIEWER_UNAVAILABLE');
  const assigned = await assign(owner, 'reviewer-one'); assert.equal(assigned.revision, 2);
  const noticeState = readState('semantic_operations_notifications', 'index', {});
  const notice = Object.values(noticeState).find(item => item.sourceId === id);
  assert.equal(notice.audience.subjectId, 'reviewer-one'); assert.equal(JSON.stringify(notice).includes('采购规范'), false);
  const events = readState('domain_event_outbox', 'events', {}).events;
  assert.equal(events.filter(item => item.type === 'knowledge.material_review.assigned').length, 1);
  assert.equal((await decide(second, id, 'approved', 2)).error, 'KNOWLEDGE_REVIEW_ASSIGNEE_REQUIRED');
  assert.equal((await assign(first, 'reviewer-two', 1)).error, 'KNOWLEDGE_REVISION_CONFLICT');
  assert.deepEqual(readState('semantic_operations_notifications', 'index', {}), noticeState);
  assert.deepEqual(readState('domain_event_outbox', 'events', {}).events, events);
  available = false;
  assert.equal((await reviews.read({ ...options(first), id })).sources, undefined);
  assert.equal((await decide(first, id, 'approved', 2)).error, 'KNOWLEDGE_REVIEW_SOURCE_UNAVAILABLE');
  available = true;
  assert.equal((await assign(first, 'reviewer-two', 2)).revision, 3);
  assert.equal((await decide(first, id, 'approved', 3)).status, 403);
  assert.equal((await assign(second, null, 3)).revision, 4);
  assert.equal((await decide(first, id, 'approved', 4)).status, 'approved');
  assert.equal((await assign(owner, 'reviewer-two', 5)).error, 'KNOWLEDGE_REVIEW_STATE_CONFLICT');
}, 'demo-enterprise'));

test('assignment directory never resolves another tenant or retains revoked reviewer eligibility', () => runWithIAMStoreContext(async () => {
  const iam = createTenantIAMWorkspace('demo-enterprise'); const user = iam.users.find(item => item.id === 'usr-001');
  iam.users.push({ ...structuredClone(user), id: 'reviewer-one', account: 'reviewer.one@example.test', name: '合成核对员一' });
  writeState('iam', 'workspace', iam);
  const owner = { ...alice, identityScope: { tenantId: 'demo-enterprise', subjectId: user.id } };
  assert.equal((await reviews.reviewers(options(alice))).status, 403);
  const id = (await reviews.create({ ...options(owner), body: { citations: [citation], confirmed: true } })).review.id;
  const opts = { ...options(owner), id, body: { subjectId: 'reviewer-one', expectedRevision: 1, confirmed: true } };
  let count = 0;
  opts.resolveProvider = () => ({ read: async c => {
    if (++count === 2) { const current = readState('iam', 'workspace', {}); current.users.find(item => item.id === 'reviewer-one').status = 'disabled'; writeState('iam', 'workspace', current); }
    return { title: '合成规范', excerpt: '规范范围', citation: c };
  } });
  const before = readState('domain_event_outbox', 'events', {});
  assert.equal((await reviews.assign(opts)).error, 'KNOWLEDGE_REVIEWER_UNAVAILABLE');
  assert.deepEqual(readState('domain_event_outbox', 'events', {}), before);
  assert.equal(readState('knowledge_material_reviews_v1', knowledgeDigest(['material-review', 'demo-enterprise']), [])[0].revision, 1);
}, 'demo-enterprise'));
test('different tenant, inaccessible source and changed version never return cached content', async () => {
  const id = (await submit()).review.id;
  assert.equal((await reviews.read({ ...options({ ...bob, identityScope: { ...bob.identityScope, tenantId: 'other' } }), id })).status, 404);
  available = false;
  assert.deepEqual((await reviews.list(options(bob))).reviews, []);
  assert.equal((await decide(bob, id, 'approved')).error, 'KNOWLEDGE_REVIEW_SOURCE_UNAVAILABLE');
  const mismatch = { ...options(bob), id, resolveProvider: () => ({ read: async () => ({ title: 'new', excerpt: 'new', citation: { ...citation, revision: 'b'.repeat(64) } }) }) };
  assert.equal((await reviews.read(mismatch)).error, 'KNOWLEDGE_REVIEW_SOURCE_UNAVAILABLE');
  // Withdrawal does not require access to a source that has since disappeared.
  assert.equal((await decide(alice, id, 'withdrawn')).status, 'withdrawn');
});

test('explicit human review note is bounded, private to authorized source readers and absent from events', async () => {
  const id = (await submit()).review.id;
  const body = { decision: 'rejected', expectedRevision: 1, confirmed: true, note: '请补充采购金额适用范围。' };
  const before = readState('domain_event_outbox', 'events', {});
  for (const note of ['x'.repeat(1001), { text: 'invalid' }]) {
    assert.equal((await reviews.decide({ ...options(bob), id, body: { ...body, note } })).error, 'KNOWLEDGE_REVIEW_NOTE_INVALID');
  }
  assert.deepEqual(readState('domain_event_outbox', 'events', {}), before);
  assert.equal((await reviews.decide({ ...options(bob), id, body })).status, 'rejected');
  assert.equal((await reviews.read({ ...options(alice), id })).review.note, body.note);
  assert.equal(JSON.stringify(readState('domain_event_outbox', 'events', {})).includes(body.note), false);
  available = false;
  assert.equal((await reviews.read({ ...options(alice), id })).review, undefined);
  assert.deepEqual((await reviews.list(options(alice))).reviews, []);
});
test('permission or source revoked during final verification suppresses the complete response and mutation', async () => {
  const id = (await submit()).review.id;
  let reads = 0;
  const revoked = { ...options(bob), id, resolveProvider: () => ({ read: async c => ++reads === 1 ? { title: '合成资料', excerpt: '合成说明', citation: c } : { error: 'revoked' } }) };
  assert.equal((await reviews.read(revoked)).sources, undefined);
  const before = readState('knowledge_material_reviews_v1', knowledgeDigest(['material-review', alice.identityScope.tenantId]), []);
  let allowed = true;
  const permission = { ...options(bob), id, canRead: () => allowed, resolveProvider: () => ({ read: async c => { allowed = false; return { title: '合成资料', excerpt: '合成说明', citation: c }; } }) };
  assert.equal((await reviews.decide({ ...permission, body: { decision: 'approved', confirmed: true, expectedRevision: 1 } })).status, 403);
  assert.deepEqual(readState('knowledge_material_reviews_v1', knowledgeDigest(['material-review', alice.identityScope.tenantId]), []), before);
});
test('quota and pagination are bounded, summaries omit citations, content and reviewer identities', async () => {
  for (let n = 0; n < 100; n++) {
    const result = await reviews.create({ ...options(alice), body: { citations: [{ ...citation, chunkId: `chunk-${n}` }], confirmed: true } });
    assert.equal(result.review.status, 'pending');
  }
  const page = await reviews.list({ ...options(bob), offset: 90 });
  assert.equal(page.reviews.length, 10); assert.equal(page.hasMore, false);
  assert.ok(page.reviews.every(row => !('citations' in row) && !('sources' in row) && !('submitter' in row)));
  assert.equal((await submit()).status, 413);
  assert.equal((await reviews.list({ ...options(bob), offset: -1 })).status, 400);
});

test('HTTP review/read and write gates precede body consumption, with live permission revalidation', () => runWithIAMStoreContext(async () => {
  const identity = { tenantId: 'demo-enterprise', subjectId: 'usr-001' };
  writeState('iam', 'workspace', createTenantIAMWorkspace(identity.tenantId));
  let reads = 0; let denied; let response;
  const route = { req: { method: 'POST' }, res: {}, url: new URL('http://local/api/semantic-operations/knowledge-library/material-reviews'), role: 'executive', agentIdentity: identity,
    effectiveAccess: getEffectiveAccess('executive', identity), selectActionRole: () => false, denyButton: id => { denied = id; },
    readBody: async () => { reads++; return { citations: [{ ...citation, provider: 'local_private_library' }], confirmed: true }; }, send: (_res, status, body) => { response = { status, body }; } };
  await handleKnowledgeRoutes(route); assert.equal(denied, 'meta_model.draft.save'); assert.equal(reads, 0);
  await handleKnowledgeRoutes({ ...route, selectActionRole: () => ({ id: 'executive' }) }); assert.equal(response.status, 400); assert.equal(reads, 1);
  await handleKnowledgeRoutes({ ...route, selectActionRole: () => ({ id: 'executive' }), readBody: async () => {
    reads++; const iam = readState('iam', 'workspace', {}); iam.rolePolicies.executive.buttonPermissionIds = iam.rolePolicies.executive.buttonPermissionIds.filter(id => id !== 'meta_model.draft.review'); writeState('iam', 'workspace', iam);
    return { citations: [citation], confirmed: true };
  } }); assert.equal(response.status, 403);
  await handleKnowledgeRoutes(route); assert.equal(response.status, 403); assert.equal(reads, 2);
}, 'demo-enterprise'));

test('real WeKnora read adapter enforces each reviewer allowlist and rejects disabled or changed source revisions', async t => {
  let bobAllowed = false; let enabled = true; let text = '合成采购申请需要采购主管复核。';
  const methods = [];
  const updated = '2026-10-10T00:00:00Z';
  const server = createServer((req, res) => {
    res.setHeader('Connection', 'close');
    if (req.method === 'HEAD') { res.end(); return; }
    methods.push(req.method);
    const data = req.url === '/api/v1/knowledge/policy'
      ? { id: 'policy', tenant_id: 10000, knowledge_base_id: 'enterprise', title: '合成采购规范', updated_at: updated, parse_status: 'completed', enable_status: enabled ? 'enabled' : 'disabled', deleted_at: null }
      : { id: 'chunk', knowledge_id: 'policy', tenant_id: 10000, knowledge_base_id: 'enterprise', updated_at: updated, content: text, status: 2, is_enabled: true, deleted_at: null, chunk_type: 'text' };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data }));
  });
  const origin = await listenOnFetchableLoopback(server);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const configured = context => ({ context, canRead: () => true, resolveProvider: () => createWeKnoraKnowledgeProvider({ context, baseUrl: origin, apiKey: 'fixture-readonly-key',
    resolveScope: () => context.identityScope.subjectId === 'bob' && !bobAllowed ? null : { principalKey: knowledgePrincipalKey(context), tenantId: 10000, knowledgeBaseId: 'enterprise', knowledgeIds: ['policy'] } }) });
  const sourcePointer = { ...citation, revision: knowledgeDigest(['policy', updated, '合成采购规范', 'chunk', updated, text]) };
  const created = await reviews.create({ ...configured(alice), body: { citations: [sourcePointer], confirmed: true } });
  const id = created.review.id;
  assert.deepEqual((await reviews.list(configured(bob))).reviews, []);
  bobAllowed = true;
  assert.equal((await reviews.read({ ...configured(bob), id })).sources[0].excerpt, text);
  assert.equal((await reviews.decide({ ...configured(bob), id, body: { decision: 'approved', confirmed: true, expectedRevision: 1 } })).status, 'approved');
  text = '合成资料新版本';
  assert.equal((await reviews.read({ ...configured(bob), id })).sources, undefined);
  assert.deepEqual((await reviews.list(configured(bob))).reviews, []);
  enabled = false;
  assert.equal((await reviews.read({ ...configured(alice), id })).error, 'KNOWLEDGE_REVIEW_SOURCE_UNAVAILABLE');
  assert.ok(methods.length > 0); assert.ok(methods.every(method => method === 'GET'));
});

test('owner can retain terminal reviews in archive, but pending, foreign-owner and stale actions do not move records', async () => {
  const id = (await submit()).review.id;
  const body = { expectedRevision: 1, confirmed: true };
  assert.equal((await reviews.archive({ ...options(alice), id, body })).error, 'KNOWLEDGE_REVIEW_TERMINAL_REQUIRED');
  await decide(bob, id, 'approved');
  assert.equal((await reviews.archive({ ...options(bob), id, body: { ...body, expectedRevision: 2 } })).status, 404);
  assert.equal((await reviews.archive({ ...options(alice), id, body })).error, 'KNOWLEDGE_REVISION_CONFLICT');
  available = false;
  const archived = await reviews.archive({ ...options(alice), id, body: { ...body, expectedRevision: 2 } });
  assert.equal(archived.retained, true); assert.equal(archived.revision, 3);
  const stateKey = knowledgeDigest(['material-review', alice.identityScope.tenantId]);
  assert.equal(readState('knowledge_material_reviews_v1', stateKey, []).length, 0);
  const retained = readState('knowledge_material_review_archives_v1', stateKey, []);
  assert.equal(retained.length, 1); assert.deepEqual(retained[0].citations, [citation]);
  const archivedEvents = readState('domain_event_outbox', 'events', {}).events.filter(item => item.type === 'knowledge.material_review.archived');
  assert.equal(archivedEvents.length, 1); assert.equal(archivedEvents[0].aggregateId, id);
  assert.deepEqual(archivedEvents[0].payload, { revision: 3, status: 'approved' });
  assert.equal(JSON.stringify(archivedEvents).includes('采购'), false);
  assert.deepEqual((await reviews.history(options(alice))).reviews, []);
  available = true;
  const history = await reviews.history(options(bob));
  assert.equal(history.reviews[0].archivedAt, retained[0].archivedAt);
  assert.equal((await reviews.read({ ...options(bob), id })).review.revision, 3);
  assert.equal((await reviews.archive({ ...options(alice), id, body: { ...body, expectedRevision: 3 } })).status, 404);
  assert.equal((await decide(bob, id, 'approved', 3)).status, 404);
});

test('archive releases the 100-row daily budget; full 1000-row retention fails without moving records or events', async () => {
  const id = (await submit()).review.id; await decide(alice, id, 'withdrawn');
  const stateKey = knowledgeDigest(['material-review', alice.identityScope.tenantId]);
  const original = readState('knowledge_material_reviews_v1', stateKey, [])[0];
  const rows = Array.from({ length: 100 }, (_, n) => ({ ...original, id: n === 0 ? id : `aaaaaaaa-aaaa-aaaa-aaaa-${String(n).padStart(12, '0')}` }));
  writeState('knowledge_material_reviews_v1', stateKey, rows);
  assert.equal((await submit()).status, 413);
  await reviews.archive({ ...options(alice), id, body: { expectedRevision: 2, confirmed: true } });
  assert.equal((await submit()).review.status, 'pending');
  const archives = Array.from({ length: 1000 }, (_, n) => ({ ...original, archivedAt: '2026-10-10T00:00:00Z', id: `bbbbbbbb-bbbb-bbbb-bbbb-${String(n).padStart(12, '0')}` }));
  writeState('knowledge_material_review_archives_v1', stateKey, archives);
  const before = readState('knowledge_material_reviews_v1', stateKey, []);
  const outboxBefore = readState('domain_event_outbox', 'events', {});
  assert.equal((await reviews.archive({ ...options(alice), id: rows[1].id, body: { expectedRevision: 2, confirmed: true } })).error, 'KNOWLEDGE_REVIEW_ARCHIVE_LIMIT');
  assert.deepEqual(readState('knowledge_material_reviews_v1', stateKey, []), before);
  assert.deepEqual(readState('knowledge_material_review_archives_v1', stateKey, []), archives);
  assert.deepEqual(readState('domain_event_outbox', 'events', {}), outboxBefore);
  assert.equal((await reviews.history({ ...options(bob), offset: 990 })).reviews.length, 10);
  assert.equal((await reviews.history({ ...options(bob), offset: 1001 })).status, 400);
});

test('list rechecks earlier sources revoked while later rows are assembled', async () => {
  const first = (await submit()).review.id;
  const second = (await reviews.create({ ...options(alice), body: { citations: [{ ...citation, chunkId: 'second' }], confirmed: true } })).review.id;
  let revoked = false;
  const result = await reviews.list({ ...options(bob), resolveProvider: () => ({ read: async c => {
    if (c.chunkId === 'chunk') revoked = true;
    if (c.chunkId === 'second' && revoked) return { error: 'revoked' };
    return { title: '合成采购规范', excerpt: '采购主管审核采购申请。', citation: c, revision: c.revision };
  } }) });
  assert.ok(!result.error); assert.deepEqual(result.reviews.map(row => row.id), [first]);
  assert.ok(!result.reviews.some(row => row.id === second));
});

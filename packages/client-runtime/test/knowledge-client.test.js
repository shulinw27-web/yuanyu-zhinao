import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeClient } from '../src/index.js';

test('material reviews use the semantic authenticated SDK, encoded ids and explicit confirmation/CAS', async () => {
  const calls = []; const request = async (path, options = {}) => { calls.push({ path, ...options }); return {}; };
  const client = createKnowledgeClient(request, 'semantic-operations');
  await client.materialReviews(10); await client.materialReview('id/foreign');
  await client.submitMaterialReview([{ provider: 'weknora_local' }]); await client.decideMaterialReview('id/foreign', 2, 'approved');
  assert.ok(calls[0].path.endsWith('/material-reviews?offset=10'));
  assert.ok(calls[1].path.endsWith('/material-reviews/id%2Fforeign'));
  assert.deepEqual(JSON.parse(calls[2].body), { citations: [{ provider: 'weknora_local' }], confirmed: true });
  assert.deepEqual(JSON.parse(calls[3].body), { expectedRevision: 2, decision: 'approved', confirmed: true });
  assert.ok(calls.every(call => !call.headers));
  const business = createKnowledgeClient(request, 'agent');
  for (const name of ['materialReviews', 'materialReview', 'submitMaterialReview', 'decideMaterialReview']) assert.equal(business[name], undefined);
});

test('material archive SDK retains semantic-only identity requests and explicit confirmation', async () => {
  const calls = []; const client = createKnowledgeClient(async (path, options = {}) => { calls.push({ path, ...options }); }, 'semantic-operations');
  await client.materialReviewHistory(10); await client.archiveMaterialReview('review/id', 3);
  assert.ok(calls[0].path.endsWith('/material-reviews/history?offset=10'));
  assert.ok(calls[1].path.endsWith('/material-reviews/review%2Fid/archive'));
  assert.deepEqual(JSON.parse(calls[1].body), { expectedRevision: 3, confirmed: true });
  const business = createKnowledgeClient(() => {}, 'agent');
  assert.equal(business.materialReviewHistory, undefined); assert.equal(business.archiveMaterialReview, undefined);
});

test('material assignment and explicit notes preserve semantic-only authentication and CAS', async () => {
  const calls = []; const client = createKnowledgeClient(async (path, options = {}) => { calls.push({ path, ...options }); }, 'semantic-operations');
  await client.materialReviewers(); await client.assignMaterialReview('review/id', 4, 'reviewer-one');
  await client.assignMaterialReview('review/id', 5, null); await client.decideMaterialReview('review/id', 6, 'rejected', '请补充范围');
  assert.ok(calls[0].path.endsWith('/material-reviews/reviewers'));
  assert.ok(calls[1].path.endsWith('/material-reviews/review%2Fid/assignment'));
  assert.deepEqual(JSON.parse(calls[1].body), { expectedRevision: 4, subjectId: 'reviewer-one', confirmed: true });
  assert.deepEqual(JSON.parse(calls[2].body), { expectedRevision: 5, subjectId: null, confirmed: true });
  assert.equal(JSON.parse(calls[3].body).note, '请补充范围');
  assert.ok(calls.every(call => !call.headers));
  const business = createKnowledgeClient(() => {}, 'agent');
  assert.equal(business.assignMaterialReview, undefined); assert.equal(business.materialReviewers, undefined);
});

test('team views are semantic-only authenticated operations with encoded ids and revision-bound mutations', async () => {
  const calls = []; const request = async (path, options = {}) => { calls.push({ path, ...options }); return {}; };
  const client = createKnowledgeClient(request, 'semantic-operations');
  await client.teamModelViews(); await client.teamModelView('../foreign');
  await client.shareModelView('view', { expectedRevision: 2, modelFingerprint: 'fp' });
  await client.retractTeamModelView('view', 1);
  assert.equal(calls.length, 4); assert.ok(calls[1].path.endsWith('/team-model-views/..%2Fforeign'));
  assert.equal(calls[2].method, 'POST'); assert.deepEqual(JSON.parse(calls[2].body), { expectedRevision: 2, modelFingerprint: 'fp' });
  assert.deepEqual(JSON.parse(calls[3].body), { expectedRevision: 1 }); assert.ok(calls.every(call => !call.headers));
  const business = createKnowledgeClient(request, 'agent');
  for (const key of ['teamModelViews', 'teamModelView', 'shareModelView', 'retractTeamModelView']) assert.equal(business[key], undefined);
});

for (const surface of ['agent', 'semantic-operations']) {
  test(`knowledge SDK ${surface}: every operation uses the owning authenticated request`, async () => {
    const calls = [];
    const client = createKnowledgeClient(async (path, options = {}) => { calls.push({ path, ...options }); return { ok: true }; }, surface);
    await client.list(); await client.providers(); await client.preview('合成材料');
    await client.save('doc-1', { expectedRevision: 0, text: '正文' });
    await client.read('doc-1', 2); await client.retract('doc-1', 2);
    await client.brief('如何核验资质'); await client.citation({ provider: 'local_private_library', documentId: 'doc-1' });
    assert.equal(calls.length, 8);
    assert.ok(calls.every(call => call.path.startsWith(`/${surface}/knowledge-library`)));
    assert.equal(calls[3].method, 'PUT');
    assert.deepEqual(JSON.parse(calls[5].body), { expectedRevision: 2 });
    assert.equal(JSON.parse(calls[6].body).limit, 5);
    assert.ok(calls.every(call => !call.headers)); // no competing role or credentials
    await client.read('../foreign?revision=9', '1&role=admin');
    assert.ok(calls.at(-1).path.includes('..%2Fforeign%3Frevision%3D9?revision=1%26role%3Dadmin'));
    await client.studies(); await client.study('study-1', 2); await client.saveStudy('study-1', { expectedRevision: 2 });
    await client.restoreStudy('study-1', { revision: 1, expectedRevision: 2, confirmed: true });
    await client.prepareStudy({ title: '业务主题', citations: [] });
    await client.answer({ question: '由谁负责', history: [] }); await client.previewMaterial({ attachments: [], confirmed: true });
    assert.equal(calls.length, 16);
    assert.ok(calls[10].path.endsWith('/studies/study-1?revision=2'));
    assert.equal(calls[11].method, 'PUT'); assert.equal(calls[12].method, 'POST');
    assert.ok(calls.every(call => !call.headers));
    await client.supplement({ question: '审批回执', citations: [], confirmed: true });
    assert.ok(calls.at(-1).path.endsWith('/answer-sources'));
    if (surface === 'semantic-operations') {
      await client.modelLinks();
      assert.equal(calls.at(-1).path, '/semantic-operations/knowledge-library/model-links');
      await client.saveModelLink({ objectId: 'Organization', confirmed: true });
      assert.equal(calls.at(-1).method, 'POST');
      await client.suggestModelLinks({ citations: [], confirmed: true });
      assert.ok(calls.at(-1).path.endsWith('/model-links/suggest'));
      await client.retractModelLink('link/foreign', 3);
      assert.ok(calls.at(-1).path.endsWith('/model-links/link%2Fforeign/retract'));
      assert.deepEqual(JSON.parse(calls.at(-1).body), { expectedRevision: 3 });
      await client.proposeReadPlan({ request: '生成额度计算预览' });
      assert.ok(calls.at(-1).path.endsWith('/read-plan-proposal'));
      await client.modelViews(); assert.ok(calls.at(-1).path.endsWith('/model-views'));
      await client.modelView('view/foreign'); assert.ok(calls.at(-1).path.endsWith('/model-views/view%2Fforeign'));
      await client.saveModelView({ expectedRevision: 0 }); assert.equal(calls.at(-1).method, 'POST');
    } else {
      assert.equal(client.proposeReadPlan, undefined);
      assert.equal(client.modelLinks, undefined);
      assert.equal(client.saveModelLink, undefined);
      assert.equal(client.suggestModelLinks, undefined);
      assert.equal(client.retractModelLink, undefined);
      assert.equal(client.modelViews, undefined); assert.equal(client.modelView, undefined); assert.equal(client.saveModelView, undefined);
    }
    if (surface === 'agent') {
      await client.jointPlans();
      assert.equal(calls.at(-1).path, '/agent/knowledge-library/joint-plans');
      await client.jointBrief({ question: '核验', targets: ['ORD-1'], citations: [], confirmed: true });
      assert.equal(calls.at(-1).path, '/agent/knowledge-library/joint-brief');
      assert.equal(calls.at(-1).method, 'POST');
    } else { assert.equal(client.jointBrief, undefined); assert.equal(client.jointPlans, undefined); }
  });
}
test('knowledge SDK rejects unknown surfaces', () => {
  assert.throws(() => createKnowledgeClient(() => {}, '../admin'), TypeError);
});

test('team history and archive remain semantic-only and encode paging and revision parameters', async () => {
  const calls = []; const client = createKnowledgeClient(async (path, options) => { calls.push({ path, options }); return {}; }, 'semantic-operations');
  await client.teamModelHistory(20, 20); assert.ok(calls[0].path.endsWith('/team-model-views/history?offset=20&limit=20'));
  await client.archiveTeamModelView('old/foreign', 2); assert.ok(calls[1].path.endsWith('/team-model-views/old%2Fforeign/archive'));
  assert.deepEqual(JSON.parse(calls[1].options.body), { expectedRevision: 2 });
  assert.equal(createKnowledgeClient(() => {}, 'agent').archiveTeamModelView, undefined);
  assert.equal(createKnowledgeClient(() => {}, 'agent').teamModelHistory, undefined);
});

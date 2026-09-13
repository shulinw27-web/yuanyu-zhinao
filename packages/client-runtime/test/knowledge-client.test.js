import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeClient } from '../src/index.js';

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
      await client.proposeReadPlan({ request: '生成额度计算预览' });
      assert.ok(calls.at(-1).path.endsWith('/read-plan-proposal'));
    } else assert.equal(client.proposeReadPlan, undefined);
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

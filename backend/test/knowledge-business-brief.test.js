import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeBusinessBrief, listKnowledgeBusinessPlans } from '../src/services/knowledge-business-brief-service.js';
import { createLocalKnowledgeProvider } from '../src/services/knowledge-evidence-service.js';
import { saveLibraryDocument, retractLibraryDocument } from '../src/services/knowledge-library-service.js';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';

const context = { identityScope: { tenantId: 'joint-test', subjectId: 'alice' }, roleId: 'executive' };
test.beforeEach(() => resetRuntimeState(['knowledge_library_v1', 'domain_event_outbox']));
async function fixture() {
  await saveLibraryDocument({ ...context, id: 'policy', body: { expectedRevision: 0, title: '异常处置制度', source: '合成', sourceVersion: 'v1', kind: 'reference', text: '发现原料异常后先复核关联订单，实际影响金额查询业务系统。' } });
  const provider = createLocalKnowledgeProvider(context);
  const citations = (await provider.search({ query: '异常', limit: 3 })).results.map(item => item.citation);
  const ontology = { published: { version: 'v1', fingerprint: 'a'.repeat(24) } };
  const business = { status: 'completed', analysis: { status: 'not_requested' },
    records: [{ id: 'ORD-1', objectType: 'SalesOrder', system: 'OMS', occurredAt: '2026-09-13T00:00:00Z', payload: { amount: 100 } }],
    results: [{ id: 'amount', value: 100 }], comparisons: [], coverage: { globalEnterpriseCoverage: false }, metadata: {}, text: '金额：100' };
  return { provider, ontology, business, args: { context, body: { question: '核验 ORD-1 影响', targets: ['ORD-1'], citations, confirmed: true },
    resolveProvider: () => provider, canRead: () => true, getOntology: async () => ontology,
    readBusiness: async args => { assert.equal(args.allowModelAnalysis, false); return structuredClone(business); }, revalidateBusiness: async () => true } };
}
test('joint brief: explicit scoped read separates source excerpts and computed facts without model, writes or raw payloads', async () => {
  const { args } = await fixture(); const answer = await buildKnowledgeBusinessBrief(args);
  assert.equal(answer.mode, 'knowledge_business_readonly_comparison'); assert.equal(answer.modelCalled, false);
  assert.equal(answer.execution, 'none'); assert.equal(answer.persisted, false); assert.equal(answer.published, false);
  assert.equal(answer.business.results[0].value, 100); assert.equal(answer.knowledge.sources.length, 1);
  assert.equal(JSON.stringify(answer).includes('payload'), false);
  assert.equal(answer.business.coverage.globalEnterpriseCoverage, false);
});
test('joint brief: missing confirmation, duplicate roots, excessive scope, no-read instructions and absent publication stop before connectors', async () => {
  const { args } = await fixture(); let reads = 0;
  const readBusiness = () => { reads++; throw new Error('must not read'); };
  for (const body of [{ ...args.body, confirmed: false }, { ...args.body, targets: ['a', 'b', 'c', 'd'] },
    { ...args.body, targets: ['a', 'a'] }, { ...args.body, question: '不要读取业务数据，只讨论制度' }, { ...args.body, roleId: 'admin' }]) {
    assert.equal((await buildKnowledgeBusinessBrief({ ...args, body, readBusiness })).status, 400);
  }
  assert.equal((await buildKnowledgeBusinessBrief({ ...args, readBusiness, getOntology: async () => null })).status, 409);
  assert.equal(reads, 0);
});
test('joint brief: changed or incomplete business reads never release policy plus stale business facts', async () => {
  const { args, business } = await fixture(); let reads = 0;
  const changed = await buildKnowledgeBusinessBrief({ ...args, readBusiness: async () => ({ ...business, records: [{ id: String(++reads) }] }) });
  assert.equal(changed.code, 'KNOWLEDGE_BUSINESS_EVIDENCE_CHANGED'); assert.equal(changed.business, undefined);
  const incomplete = await buildKnowledgeBusinessBrief({ ...args, readBusiness: async () => ({ status: 'incomplete' }) });
  assert.equal(incomplete.code, 'KNOWLEDGE_BUSINESS_READ_INCOMPLETE');
});
test('joint brief: revoked knowledge, model rotation and late business permission withdrawal discard entire response', async () => {
  const { args, business, ontology } = await fixture(); let reads = 0;
  const rotated = await buildKnowledgeBusinessBrief({ ...args, getOntology: async () => ++reads === 1 ? ontology : { published: { version: 'v2', fingerprint: 'b'.repeat(24) } } });
  assert.equal(rotated.code, 'KNOWLEDGE_EVIDENCE_CHANGED');
  const denied = await buildKnowledgeBusinessBrief({ ...args, revalidateBusiness: async () => false });
  assert.equal(denied.status, 403); assert.equal(denied.business, undefined);
  const revoked = await buildKnowledgeBusinessBrief({ ...args, readBusiness: async () => {
    await retractLibraryDocument({ ...context, id: 'policy', expectedRevision: 1 }); return business;
  } });
  assert.ok(revoked.error); assert.equal(revoked.knowledge, undefined); assert.equal(revoked.business, undefined);
});

test('joint plan catalogue: metadata only, missing model is explicit and final access revocation hides catalogue', async () => {
  const { args, ontology } = await fixture();
  const plans = [{ id: 'credit-read', label: '信用核验', rootType: 'SalesOrder', outputs: [{ id: 'credit', label: '授信' }] }];
  const value = await listKnowledgeBusinessPlans({ ...args, getOntology: async () => ({ ...ontology, metadata: { readPlans: plans } }) });
  assert.deepEqual(value.plans, plans); assert.equal(value.businessRead, false); assert.equal(value.model.fingerprint, ontology.published.fingerprint);
  assert.equal((await listKnowledgeBusinessPlans({ ...args, getOntology: async () => null })).available, false);
  let checks = 0;
  const denied = await listKnowledgeBusinessPlans({ ...args, canRead: () => ++checks === 1 });
  assert.equal(denied.status, 403); assert.equal(denied.plans, undefined);
});
test('joint plan selection: model fingerprint/version changes and invalid fields stop before business reads', async () => {
  const { args } = await fixture(); let reads = 0;
  const readBusiness = async () => { reads++; throw new Error('must not read'); };
  for (const body of [{ ...args.body, expectedModelFingerprint: 'b'.repeat(24) }, { ...args.body, expectedModelVersion: 'v2' }]) {
    assert.equal((await buildKnowledgeBusinessBrief({ ...args, body, readBusiness })).code, 'KNOWLEDGE_MODEL_SELECTION_STALE');
  }
  for (const body of [{ ...args.body, planId: '../other' }, { ...args.body, expectedModelFingerprint: { toString: null } }]) {
    assert.equal((await buildKnowledgeBusinessBrief({ ...args, body, readBusiness })).status, 400);
  }
  assert.equal(reads, 0);
});

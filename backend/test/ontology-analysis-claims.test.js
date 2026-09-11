import test from 'node:test';
import assert from 'node:assert/strict';
import { createOntologyClaimContext, validateOntologyClaims, renderOntologyClaims } from '../src/services/ontology-analysis-claims.js';

const rows = [
  { id: 'SAME', system: 'ERP', objectType: 'Receipt', version: 'v1', payload: { amount: 10.25, confirmed: false, receipt: '', reference: null, zero: 0 } },
  { id: 'SAME', system: 'OA', objectType: 'Receipt', version: 'v2', payload: { amount: 99, confirmed: true } }
];
const plan = { datasets: [{ id: 'bank', objectType: 'Receipt' }, { id: 'allocation', objectType: 'Match' }] };
const context = () => createOntologyClaimContext(structuredClone(rows), [{ target: 'ROOT-A', results: [{ id: 'paid', label: '已到账', value: 10.25, unit: 'CNY' }], datasets: { bank: [rows[0]], allocation: [] } }], plan);
const proposal = ctx => ({ schemaVersion: 'ontology-claims.v2', contextId: ctx.contextId,
  observations: [{ record: 'r0', fields: ['amount', 'confirmed', 'receipt', 'reference', 'zero'] }], metrics: ['m0'],
  gaps: ctx.gaps.map(g => g.ref),
  hypotheses: [{ text: '匹配仍需核查，不能据此认定款项丢失。', refs: ['r0', 'm0'] }], recommendations: [{ text: '请核查外部凭证。', refs: ['r0'] }] });
const validate = (value, ctx) => validateOntologyClaims(JSON.stringify(value), ctx);

test('claim references render values only from source, preserving decimals, false, zero and null', () => {
  const ctx = context(); const result = validate(proposal(ctx), ctx); assert.equal(result.passed, true);
  const rendered = renderOntologyClaims(result, ctx);
  assert.match(rendered.text, /10.25/); assert.match(rendered.text, /false/); assert.match(rendered.text, /null/); assert.match(rendered.text, /zero.*=0/);
  assert.match(rendered.text, /本次声明查询条件下未得到记录/); assert.match(rendered.text, /不是已确认结论/);
  assert.equal(rendered.citations.length, 1); assert.equal(rendered.citations[0].system, 'ERP');
  assert.equal(rendered.verification.gapClaimsVerified, true); assert.equal(rendered.verification.narrativeEntailmentVerified, false);
});

test('claims cannot supply their own values, invented fields, source IDs, metrics or execution keys', () => {
  const ctx = context();
  for (const mutate of [p => { p.observations[0].value = 999; }, p => { p.observations[0].fields = ['password']; },
    p => { p.observations[0].record = 'other-tenant'; }, p => { p.metrics = ['m99']; }, p => { p.executed = true; },
    p => { p.recommendations[0].refs = ['foreign']; }, p => { p.recommendations[0].record = 'r0'; }, p => { p.hypotheses[0].refs = []; }, p => { p.observations.push(p.observations[0]); }]) {
    const p = proposal(ctx); mutate(p); assert.equal(validate(p, ctx).passed, false);
  }
});

test('structured gap claims cannot declare nonempty datasets, nonempty fields, zero or false missing', () => {
  const ctx = context();
  for (const gap of [{ reason: 'no_records', dataset: 'd0' }, { reason: 'no_records', dataset: 'd99' },
    ...['amount', 'confirmed', 'zero', 'unknown'].map(field => ({ reason: 'empty_field', record: 'r0', field }))]) {
    const p = proposal(ctx); p.gaps = [gap]; assert.equal(validate(p, ctx).passed, false);
  }
  assert.ok(ctx.gaps.every(g => !['amount', 'confirmed', 'zero'].includes(g.field)));
  const p = proposal(ctx); p.gaps = [ctx.gaps.find(g => g.field === 'reference').ref]; assert.equal(validate(p, ctx).passed, true);
  p.gaps = ['g999']; assert.equal(validate(p, ctx).passed, false);
});

test('snapshot binding rejects changed facts, cross-root proposals and stale metric values', () => {
  const a = context(); const old = proposal(a);
  const changed = structuredClone(rows); changed[0].payload.amount = 11;
  const b = createOntologyClaimContext(changed, [], plan); assert.equal(validate(old, b).passed, false);
  const otherRoot = createOntologyClaimContext(rows, [{ target: 'ROOT-B', results: [], datasets: {} }], plan);
  assert.notEqual(otherRoot.contextId, a.contextId); assert.equal(validate(old, otherRoot).passed, false);
  const p = proposal(a); p.observations = [{ record: 'r1', fields: ['amount'] }]; p.metrics = []; p.gaps = []; p.hypotheses = []; p.recommendations = [];
  assert.match(renderOntologyClaims(validate(p, a), a).text, /99/);
  assert.doesNotMatch(renderOntologyClaims(validate(p, a), a).text, /10.25/);
  assert.notEqual(createOntologyClaimContext(rows, [{ target: 'A', results: [] }]).contextId, createOntologyClaimContext(rows, [{ target: 'B', results: [] }]).contextId);
});

test('narratives can reference known empty query scopes, but not invent dataset references', () => {
  const ctx = context(); const p = proposal(ctx); p.recommendations[0].refs = ['d1'];
  assert.equal(validate(p, ctx).passed, true);
  assert.match(renderOntologyClaims(validate(p, ctx), ctx).text, /Match 查询范围（0 条）/);
  p.recommendations[0].refs = ['d999']; assert.equal(validate(p, ctx).signals[0], 'claim_narrative_reference_unknown');
  p.recommendations[0].refs = ['d1', 'd1']; assert.equal(validate(p, ctx).signals[0], 'claim_narrative_reference_bounds');
});

test('recommendations can cite server-issued gaps with transitive provenance, never invented gaps', () => {
  const ctx = context(); const p = proposal(ctx);
  p.observations = []; p.gaps = []; p.hypotheses = [];
  p.recommendations[0].refs = [ctx.gaps.find(g => g.field === 'receipt').ref, ctx.gaps.find(g => g.reason === 'no_records').ref];
  const rendered = renderOntologyClaims(validate(p, ctx), ctx);
  assert.match(rendered.text, /ERP\/Receipt SAME 的 receipt 为空/);
  assert.match(rendered.text, /ROOT-A Match 查询范围（0 条）.*不代表企业不存在/);
  assert.equal(rendered.citations.length, 1); assert.equal(rendered.citations[0].id, 'SAME');
  assert.equal(rendered.citations[0].system, 'ERP');
  p.recommendations[0].refs = ['g999']; assert.equal(validate(p, ctx).signals[0], 'claim_narrative_reference_unknown');
});

test('malformed or oversized claim bodies fail closed; raw unstructured answers cannot bypass references', () => {
  const ctx = context();
  for (const text of ['财务侧只有汇总。', '{', 'null', '[]', 'x'.repeat(16001)]) assert.equal(validateOntologyClaims(text, ctx).passed, false);
  const p = proposal(ctx);
  for (const size of [241, 293, 600]) { p.recommendations[0].text = 'x'.repeat(size); assert.equal(validate(p, ctx).passed, true); }
  p.recommendations[0].text = 'x'.repeat(601); assert.equal(validate(p, ctx).passed, false);
  assert.throws(() => renderOntologyClaims({ passed: false }, ctx), /NOT_VALIDATED/);
});

test('rendered source strings cannot introduce executable HTML or markdown links', () => {
  const malicious = [{ ...rows[0], payload: { note: '<img src=x onerror=alert(1)> [click](https://invalid.test)' } }];
  const ctx = createOntologyClaimContext(malicious, [], plan); const p = proposal(ctx);
  p.observations = [{ record: 'r0', fields: ['note'] }]; p.metrics = []; p.gaps = []; p.hypotheses = []; p.recommendations = [];
  const text = renderOntologyClaims(validate(p, ctx), ctx).text;
  assert.doesNotMatch(text, /<img|\[click\]/); assert.match(text, /&#60;/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discoverSchemasFromAttachments } from '../src/services/semantic-schema-discovery-service.js';
import { crossChannelReadPlan } from '../../examples/semantic-schemas/cross-channel-fulfillment/read-plan.mjs';
import { proposeSemanticReadPlan, validateReadPlanProposal } from '../src/services/semantic-read-plan-proposal-service.js';
import { planSemanticOperationsRequest } from '../src/services/semantic-operations-planner-service.js';
import { decodeReadPlanExpressions } from '../src/services/read-plan-expression-codec.js';
import { checkReadPlanTypes } from '../src/services/read-plan-type-check.js';

const text = readFileSync(new URL('../../examples/semantic-schemas/cross-channel-fulfillment/data-dictionary.json', import.meta.url), 'utf8');
const discovery = discoverSchemasFromAttachments({ attachments: [{ id: 'dict', name: 'dictionary.json', mimeType: 'application/json' }], reports: [{ attachmentId: 'dict', status: 'content_scanned', structuredSchemaCandidate: true }], documents: [{ attachmentId: 'dict', text }] });
const draft = { objectTypes: discovery.objectTypes, relationshipTypes: discovery.relationshipTypes, fingerprint: 'a'.repeat(24) };
const policy = () => ({ enabled: true, provider: 'ark', model: 'synthetic-model' });
const fixture = () => ({ readDraft: async () => draft, policy, canRead: () => true,
  body: { request: '按已提供规则生成订单核验计划，不执行。', rootType: 'SalesOrder', expectedFingerprint: draft.fingerprint, consent: { ...policy(), confirmed: true } },
  generate: async () => ({ source: 'ark', text: JSON.stringify({ preconditions: [], outputs: [{ id: 'amount', label: '金额', unit: 'CNY', expression: { op: 'one', dataset: 'SalesOrder', field: 'amount' } }] }) }) });

test('DM-11: compact expression transport decodes losslessly and still applies field scope gates', async () => {
  const options = fixture(); delete options.body.consent.enabled;
  const answer = expression => ({ preconditions: [], outputs: [{ id: 'amount', label: '金额', unit: 'CNY', expression }] });
  const result = await proposeSemanticReadPlan({ ...options, generate: async () => ({ source: 'ark', text: JSON.stringify(answer(['sub', ['one', 'SalesOrder', 'amount'], ['literal', 0]])) }) });
  assert.equal(result.status, 'pending_human_review');
  assert.deepEqual(result.plan.outputs[0].expression, { op: 'sub', args: [{ op: 'one', dataset: 'SalesOrder', field: 'amount' }, { op: 'literal', value: 0 }] });
  for (const expression of [['field', 'SalesOrder', 'amount'], ['one', 'SalesOrder', 'invented'], ['output', 'later']]) {
    const rejected = await proposeSemanticReadPlan({ ...options, generate: async () => ({ source: 'ark', text: JSON.stringify(answer(expression)) }) });
    assert.equal(rejected.plan, undefined); assert.equal(rejected.status, 502);
  }
  for (const expression of [['eval', 'process.exit()'], ['literal', { execute: true }], ['add', 1, 2], ['one', 'SalesOrder', 'amount', 'extra']]) {
    assert.throws(() => decodeReadPlanExpressions(answer(expression)), /READ_EXPRESSION_ENCODING/);
  }
  let deep = ['literal', 1]; for (let i = 0; i < 16; i++) deep = ['add', deep, ['literal', 0]];
  assert.throws(() => decodeReadPlanExpressions(answer(deep)), /READ_EXPRESSION_ENCODING/);
});

test('DM-11: nine-metric reference algebra round trips all operators without changing business semantics', () => {
  const encode = e => {
    if (e.op === 'literal') return [e.op, e.value];
    if (['one', 'field'].includes(e.op)) return [e.op, e.dataset, e.field];
    if (e.op === 'output') return [e.op, e.id];
    if (e.op === 'lookup') return [e.op, e.dataset, e.field, encode(e.value), e.resultField];
    if (['sum', 'all'].includes(e.op)) return [e.op, e.dataset, encode(e.value), ...(e.where ? [encode(e.where)] : [])];
    if (e.op === 'if') return [e.op, encode(e.condition), encode(e.then), encode(e.else)];
    return [e.op, ...e.args.map(encode)];
  };
  const { outputs, preconditions } = crossChannelReadPlan();
  const encoded = { outputs: outputs.map(o => ({ ...o, expression: encode(o.expression) })), preconditions: preconditions.map(encode) };
  assert.deepEqual(decodeReadPlanExpressions(encoded), { outputs, preconditions });
  assert.ok(JSON.stringify(encoded).length < JSON.stringify({ outputs, preconditions }).length * 0.7);
  const flatten = e => {
    const [op, ...args] = e;
    return [op === 'sum' && args.length === 3 ? 'sum_where' : op, ...args.flatMap(a => Array.isArray(a) ? flatten(a) : [a])];
  };
  const flat = { outputs: encoded.outputs.map(o => ({ ...o, expression: flatten(o.expression) })), preconditions: encoded.preconditions.map(flatten) };
  assert.deepEqual(decodeReadPlanExpressions(flat), { outputs, preconditions });
  assert.ok(JSON.stringify(flat).length < JSON.stringify(encoded).length);
  for (const expression of [['add', 'literal', 1], ['literal', 1, 'literal', 2], ['lookup', 'X', 'key', 'literal', 2]]) {
    assert.throws(() => decodeReadPlanExpressions({ preconditions: [], outputs: [{ expression }] }), /READ_EXPRESSION_ENCODING/);
  }
});

test('DM-12: known null/string arithmetic and non-boolean conditions reject before preview', async () => {
  const plan = crossChannelReadPlan();
  assert.equal(checkReadPlanTypes(plan, draft).valid, true);
  for (const expression of [{ op: 'add', args: [{ op: 'literal', value: null }, { op: 'literal', value: 1 }] },
    { op: 'if', condition: { op: 'literal', value: 1 }, then: { op: 'literal', value: 0 }, else: { op: 'literal', value: 2 } },
    { op: 'sum', dataset: 'SalesOrderLine', value: { op: 'if', condition: { op: 'literal', value: true }, then: { op: 'literal', value: 1 }, else: { op: 'literal', value: null } } }]) {
    const options = fixture(); delete options.body.consent.enabled;
    const result = await proposeSemanticReadPlan({ ...options, generate: async () => ({ source: 'ark', text: JSON.stringify({ preconditions: [], outputs: [{ id: 'n', label: '值', unit: '', expression }] }) }) });
    assert.equal(result.status, 502); assert.equal(result.plan, undefined); assert.equal(result.diagnostics.stage, 'READ_EXPRESSION_TYPE');
  }
});

test('DM-06: validated proposal has no persistence, grants, business execution or publication', async () => {
  const options = fixture(); delete options.body.consent.enabled;
  const result = await proposeSemanticReadPlan(options);
  assert.equal(result.status, 'pending_human_review'); assert.equal(result.persisted, false); assert.equal(result.execution, 'none'); assert.equal(result.replayRequired, true);
  assert.equal(result.plan.outputs[0].id, 'amount'); assert.equal(result.plan.datasets.length, 1); assert.equal(draft.scenario, undefined);
});

test('DM-06: unknown joins, injected actions, stale model and withdrawal reject whole proposal', async () => {
  const options = fixture(); delete options.body.consent.enabled; let calls = 0;
  const result = await proposeSemanticReadPlan({ ...options, body: { ...options.body, expectedFingerprint: 'b'.repeat(24) }, generate: () => { calls++; } });
  assert.equal(result.status, 409); assert.equal(calls, 0);
  const plan = crossChannelReadPlan();
  assert.equal(validateReadPlanProposal({ ...plan, execute: true }, draft, 'SalesOrder'), false);
  const unknown = structuredClone(plan); unknown.datasets[1].where[0].field = 'invented';
  assert.equal(validateReadPlanProposal(unknown, draft, 'SalesOrder'), false);
  let allowed = true;
  const revoked = await proposeSemanticReadPlan({ ...options, canRead: () => allowed, generate: async () => { allowed = false; return options.generate(); } });
  assert.equal(revoked.status, 403); assert.equal(revoked.plan, undefined);
  const unsafe = await proposeSemanticReadPlan({ ...options, generate: async () => ({ source: 'ark', text: JSON.stringify({ ...plan, endpoint: 'https://example.invalid' }) }) });
  assert.equal(unsafe.status, 502);
});

test('DM-05: planning receives known material index and cannot expand systems or repeat supplied dictionary request', async () => {
  let prompt;
  const result = await planSemanticOperationsRequest({ request: '建设模型', authoritativeIntent: 'build_model', sourceDiscovery: { sources: [{ code: 'ERP', status: 'configured' }] },
    materialFacts: { objects: [{ id: 'CreditAccount', key: 'account_id', fields: ['credit_limit'] }] }, runtime: { mode: 'ark', model: 'synthetic-model' },
    generate: async input => { prompt = input.prompt; return { source: 'ark', text: JSON.stringify({ schemaVersion: 'semantic-operations-plan.v1', intent: 'build_model', goal: '建模', systems: ['ERP', 'LIMS'], rationale: '材料', questions: ['请提供数据字典', '货权转移回执为空时如何处理？'] }) }; } });
  assert.match(prompt, /CreditAccount/); assert.deepEqual(result.systems, ['ERP']); assert.equal(result.systemConflict, true);
  assert.deepEqual(result.questions, ['货权转移回执为空时如何处理？']);
});

test('DM-07: valid deep expressions retain datasets during dependency pruning', async () => {
  const options = fixture(); delete options.body.consent.enabled;
  let expression = { op: 'one', dataset: 'CreditAccount', field: 'credit_limit' };
  for (let n = 0; n < 10; n++) expression = { op: 'add', args: [expression, { op: 'literal', value: 0 }] };
  const result = await proposeSemanticReadPlan({ ...options, generate: async () => ({ source: 'ark', text: JSON.stringify({ preconditions: [], outputs: [{ id: 'credit', label: '额度', unit: 'CNY', expression }] }) }) });
  assert.equal(result.status, 'pending_human_review');
  assert.deepEqual(result.plan.datasets.map(ds => ds.objectType), ['SalesOrder', 'Customer', 'CreditAccount']);
});

test('DM-08: billing and shipping foreign keys never silently select the first customer role', async () => {
  const options = fixture(); delete options.body.consent.enabled;
  const multi = structuredClone(draft); const order = multi.objectTypes.find(o => o.id === 'SalesOrder');
  order.fields.push('ship_to_id'); order.fieldDefinitions.push({ name: 'ship_to_id', type: 'string', reference: 'Customer', referenceField: 'customer_id' });
  const result = await proposeSemanticReadPlan({ ...options, readDraft: () => multi, generate: async () => ({ source: 'ark', text: JSON.stringify({ preconditions: [], outputs: [{ id: 'customer', label: '客户', unit: '', expression: { op: 'one', dataset: 'Customer', field: 'customer_id' } }] }) }) });
  assert.equal(result.code, 'READ_PLAN_JOIN_SELECTION_REQUIRED'); assert.equal(result.plan, undefined);
  assert.equal(result.joinChoices.find(c => c.objectType === 'Customer').options.length, 2);
  const selected = result.joinChoices[0].options.find(edge => edge.sourceField === 'ship_to_id');
  const approved = await proposeSemanticReadPlan({ ...options, readDraft: () => multi, body: { ...options.body, joinSelections: [selected] },
    generate: async () => ({ source: 'ark', text: JSON.stringify({ preconditions: [], outputs: [{ id: 'customer', label: '收货客户', unit: '', expression: { op: 'one', dataset: 'Customer', field: 'customer_id' } }] }) }) });
  assert.equal(approved.status, 'pending_human_review');
  assert.equal(approved.plan.datasets.find(ds => ds.objectType === 'Customer').where[0].sourceField, 'ship_to_id');
  // Unrelated ambiguous joins do not block a root-only query.
  assert.equal((await proposeSemanticReadPlan({ ...options, readDraft: () => multi })).status, 'pending_human_review');
});

test('DM-08: forged, duplicate and cyclic join selections are rejected before any model call', async () => {
  const options = fixture(); delete options.body.consent.enabled; let calls = 0;
  const edge = { objectType: 'Customer', fromObjectType: 'SalesOrder', field: 'customer_id', sourceField: 'customer_id' };
  for (const selections of [[{ ...edge, sourceField: 'invented' }], [edge, edge],
    [{ ...edge, fromObjectType: 'CreditAccount' }, { objectType: 'CreditAccount', fromObjectType: 'Customer', field: 'customer_id', sourceField: 'customer_id' }]]) {
    const result = await proposeSemanticReadPlan({ ...options, body: { ...options.body, joinSelections: selections }, generate: () => { calls++; } });
    assert.equal(result.code, 'READ_PLAN_JOIN_SELECTION_INVALID'); assert.equal(result.plan, undefined);
  }
  assert.equal(calls, 0);
});

test('DM-07: excessive expression depth remains rejected rather than partially compiled', async () => {
  const options = fixture(); delete options.body.consent.enabled;
  let expression = { op: 'one', dataset: 'CreditAccount', field: 'credit_limit' };
  for (let i = 0; i < 16; i++) expression = { op: 'add', args: [expression, { op: 'literal', value: 0 }] };
  const result = await proposeSemanticReadPlan({ ...options, generate: async () => ({ source: 'ark', text: JSON.stringify({ preconditions: [], outputs: [{ id: 'credit', label: '额度', unit: 'CNY', expression }] }) }) });
  assert.equal(result.status, 502); assert.equal(result.plan, undefined);
});

test('DM-10: clarification is explicit and does not persist, retry or execute', async () => {
  const options = fixture(); delete options.body.consent.enabled; let calls = 0;
  const result = await proposeSemanticReadPlan({ ...options, generate: async input => {
    calls++; assert.equal(input.answerContract, 'read_plan'); assert.match(input.prompt, /租户权限.*重复去重/);
    return { source: 'ark', text: JSON.stringify({ unsupported: true, reason: 'missing_rule', questions: ['有效行使用哪一项状态？'] }) };
  } });
  assert.equal(result.code, 'READ_PLAN_NEEDS_CLARIFICATION'); assert.equal(result.status, 422); assert.equal(calls, 1);
  assert.equal(result.persisted, false); assert.equal(result.plan, undefined); assert.equal(result.execution, 'none');
});

test('DM-09: only safe transient failures retry; token exhaustion never retries or leaks raw diagnostics', async () => {
  const options = fixture(); delete options.body.consent.enabled; let calls = 0;
  const transient = await proposeSemanticReadPlan({ ...options, generate: async () => ++calls === 1 ? { source: 'fallback', failureStage: 'transport' } : options.generate() });
  assert.equal(transient.status, 'pending_human_review'); assert.equal(calls, 2);
  calls = 0;
  const result = await proposeSemanticReadPlan({ ...options, generate: async () => { calls++; return { source: 'output_safety', text: 'private upstream body', safety: { signals: ['output_token_limit'] } }; } });
  assert.equal(result.status, 503); assert.equal(result.diagnostics.stage, 'output_token_limit'); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /private upstream/);
});

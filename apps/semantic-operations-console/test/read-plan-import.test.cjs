const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../../frontend/src/features/meta-model/ontology-read-plan-import.js');
const plan = id => ({ id, label: id, datasets: [{ id: 'rows', objectType: 'Order', where: [{ field: 'id', target: true }] }], outputs: [{ id: 'qty', label: '数量', unit: '件', expression: { op: 'one', dataset: 'rows', field: 'qty' } }] });
test('human import previews one to three plans in all supported wrappers', async () => {
  const { parseReadPlanImport } = await load();
  for (const value of [plan('one'), [plan('one'), plan('two')], { readPlans: [plan('one')] }, { scenario: { readPlans: [plan('one'), plan('two'), plan('three')] } }]) {
    assert.ok(parseReadPlanImport(value).length >= 1);
  }
});
test('human import rejects excessive, duplicate, malformed and invalid plan identities', async () => {
  const { parseReadPlanImport } = await load();
  for (const value of [null, [], { readPlans: {} }, [plan('same'), plan('same')], ['a','b','c','d'].map(plan), plan('bad-id'),
    { ...plan('valid'), datasets: [] }, { ...plan('valid'), outputs: Array(25).fill({}) }]) {
    assert.throws(() => parseReadPlanImport(value));
  }
});

test('nested malformed datasets, outputs and filters are refused before preview rendering', async () => {
  const { parseReadPlanImport } = await load();
  for (const patch of [{ datasets: [null] }, { datasets: [{}] }, { outputs: [null] }, { outputs: [{}] },
    { datasets: [{ ...plan('ok').datasets[0], where: [null] }] },
    { datasets: [{ ...plan('ok').datasets[0], filter: { field: 'status', values: {} } }] },
    { datasets: [{ ...plan('ok').datasets[0], expand: {} }] },
    { preconditions: {} }, { preconditions: [null] }, { coverage: true }, { analysis: { enabled: 'yes' } }]) {
    assert.throws(() => parseReadPlanImport({ ...plan('valid'), ...patch }), /结构无效/);
  }
});

test('bounded expression validation rejects bad arity, unknown operators, cycles and excessive depth', async () => {
  const { parseReadPlanImport } = await load();
  const cycle = { op: 'sum', dataset: 'rows' }; cycle.value = cycle;
  let deep = { op: 'literal', value: 1 }; for (let i = 0; i < 16; i++) deep = { op: 'sum', dataset: 'rows', value: deep };
  for (const expression of [null, { op: 'add', args: {} }, { op: 'add', args: [] }, { op: 'execute', value: 'code' }, { op: 'literal', value: {} }, cycle, deep]) {
    const value = plan('valid'); value.outputs[0].expression = expression;
    assert.throws(() => parseReadPlanImport(value));
  }
});

test('existing full synthetic read plans remain importable including nested preconditions', async () => {
  const { parseReadPlanImport } = await load();
  const { crossChannelReadPlan } = await import('../../../examples/semantic-schemas/cross-channel-fulfillment/read-plan.mjs');
  assert.equal(parseReadPlanImport(crossChannelReadPlan(0)).length, 1);
  const value = plan('graph'); value.datasets[0].expand = { edgeObjectType: 'Edge', fromField: 'from_id', toField: 'to_id', stateField: 'status', activeStates: ['active'], inactiveStates: ['closed'], maxDepth: 3 };
  value.coverage = { mode: 'bounded_declared_graph', requiredExpansions: ['rows'] };
  value.analysis = { enabled: true }; value.preconditions = [{ op: 'all', dataset: 'rows', value: { op: 'literal', value: true } }];
  assert.equal(parseReadPlanImport(value)[0], value);
});

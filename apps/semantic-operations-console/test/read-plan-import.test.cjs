const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../../frontend/src/features/meta-model/ontology-read-plan-import.js');
const plan = id => ({ id, label: id, datasets: [{}], outputs: [{}] });
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

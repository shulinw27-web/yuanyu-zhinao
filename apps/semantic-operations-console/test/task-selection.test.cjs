const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../src/task-selection.js');
test('explicit task beyond first 100 is fetched without silently selecting another task', async () => {
  const { resolveSemanticTaskSelection } = await load();
  const tasks = Array.from({ length: 100 }, (_, index) => ({ id: `recent-${index}` }));
  const calls = []; const target = { id: 'older', archivedAt: '2026-09-18' };
  const result = await resolveSemanticTaskSelection({ tasks, preferredId: 'older', client: { getTask: async id => { calls.push(id); return { task: target }; } } });
  assert.deepEqual(calls, ['older']); assert.equal(result.selected, target); assert.equal(result.tasks[0], target); assert.equal(tasks.length, 100);
});
test('missing or mismatched target rejects rather than falling back to a visible task', async () => {
  const { resolveSemanticTaskSelection } = await load();
  for (const response of [{}, { task: { id: 'wrong' } }]) await assert.rejects(resolveSemanticTaskSelection({ tasks: [{ id: 'recent' }], preferredId: 'target', client: { getTask: async () => response } }));
  await assert.rejects(resolveSemanticTaskSelection({ tasks: [{ id: 'recent' }], preferredId: 'target', client: { getTask: async () => { throw new Error('404'); } } }), /404/);
});
test('listed target needs no detail request and ordinary browsing retains selection', async () => {
  const { resolveSemanticTaskSelection } = await load();
  const tasks = [{ id: 'a' }, { id: 'b' }]; const client = { getTask: () => { throw new Error('unexpected request'); } };
  assert.equal((await resolveSemanticTaskSelection({ tasks, preferredId: 'b', client })).selected.id, 'b');
  assert.equal((await resolveSemanticTaskSelection({ tasks, selectedId: 'b', client })).selected.id, 'b');
  assert.equal((await resolveSemanticTaskSelection({ tasks: [], client })).selected, null);
});

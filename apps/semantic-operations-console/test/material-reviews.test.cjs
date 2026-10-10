const test = require('node:test'); const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'); const { resolve } = require('node:path');
const { parse, compileScript } = require('@vue/compiler-sfc'); const vue = require('vue');
const filename = resolve(__dirname, '../../../packages/agent-ui/src/knowledge/KnowledgeTeamReviewPanel.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const source = compileScript(descriptor, { id: 'material-review-test' }).content
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_, names) => `const { ${names.replace(/\s+as\s+/gu, ': ')} } = Vue;`)
  .replace('export default', 'return');
const Component = new Function('Vue', source)(vue);
const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode() {}, nextSibling() {}, patchProp() {}, insert() {}, remove() {} });
function mount(t, extra = {}) {
  let state;
  const props = vue.reactive({ canReview: true, canWrite: true, evidence: [], client: { materialReviews: async () => ({ reviews: [], hasMore: false }) }, ...extra });
  const app = renderer.createApp({ setup() { state = Component.setup(props, { expose() {}, emit() {} }); return () => null; } }); app.mount({}); t.after(() => app.unmount());
  return { props, state };
}
test('material review UI uses enterprise evidence only and requires an explicit submission', async t => {
  const calls = [];
  const ui = mount(t, { evidence: [{ title: 'private', citation: { provider: 'local_private_library' } }, { title: 'enterprise', citation: { provider: 'weknora_local' } }], client: {
    materialReviews: async () => ({ reviews: [] }), submitMaterialReview: async citations => { calls.push(citations); return {}; }
  } });
  await ui.state.refresh(); assert.equal(calls.length, 0); assert.equal(ui.state.eligible.value.length, 1);
  ui.state.choices.value = [0]; await ui.state.submit();
  assert.deepEqual(calls, [[{ provider: 'weknora_local' }]]);
  ui.props.canWrite = false; await vue.nextTick(); ui.state.choices.value = [0]; await ui.state.submit(); assert.equal(calls.length, 1);
});
test('material review UI forbids self-approval and uses current revision for explicit decisions', async t => {
  const calls = []; const ui = mount(t, { client: { materialReviews: async () => ({ reviews: [] }), decideMaterialReview: async (...args) => { calls.push(args); return {}; } } });
  await ui.state.refresh();
  ui.state.selected.value = { review: { id: 'review', revision: 3, status: 'pending', owned: true } };
  await ui.state.decide('approved'); assert.equal(calls.length, 0);
  await ui.state.decide('withdrawn'); assert.deepEqual(calls, [['review', 3, 'withdrawn']]);
  ui.state.selected.value = { review: { id: 'review2', revision: 4, status: 'pending', owned: false } };
  await ui.state.decide('withdrawn'); assert.equal(calls.length, 1);
  await ui.state.decide('approved'); assert.deepEqual(calls[1], ['review2', 4, 'approved']);
});
test('late material detail after permission revocation is discarded', async t => {
  let finish; const ui = mount(t, { client: { materialReviews: async () => ({ reviews: [] }), materialReview: () => new Promise(resolve => { finish = resolve; }) } });
  await ui.state.refresh(); const pending = ui.state.open({ id: 'review' });
  ui.props.canReview = false; await vue.nextTick(); finish({ review: { id: 'review' }, sources: [{ excerpt: 'secret' }] }); await pending;
  assert.equal(ui.state.selected.value, null); assert.deepEqual(ui.state.rows.value, []);
});

test('review note is explicit, bounded and cleared when authority changes', async t => {
  const calls = []; const ui = mount(t, { client: { materialReviews: async () => ({ reviews: [] }), decideMaterialReview: async (...args) => { calls.push(args); return {}; } } });
  await ui.state.refresh();
  ui.state.selected.value = { review: { id: 'review', revision: 1, status: 'pending', owned: false } };
  ui.state.reviewNote.value = 'x'.repeat(1001); await ui.state.decide('rejected'); assert.equal(calls.length, 0);
  ui.state.reviewNote.value = ' 请补充范围 '; await ui.state.decide('rejected');
  assert.deepEqual(calls, [['review', 1, 'rejected', '请补充范围']]);
  ui.state.reviewNote.value = 'private note'; ui.props.canWrite = false; await vue.nextTick();
  assert.equal(ui.state.reviewNote.value, '');
});

test('material assignment is explicit, follows server affordances and submits current CAS', async t => {
  const calls = []; const ui = mount(t, { client: { materialReviews: async () => ({ reviews: [] }), assignMaterialReview: async (...args) => { calls.push(args); return {}; }, decideMaterialReview: async (...args) => { calls.push(['decision', ...args]); return {}; } } });
  await ui.state.refresh();
  ui.state.selected.value = { review: { id: 'review', revision: 7, status: 'pending', owned: false, canAssign: false, canDecide: false } };
  ui.state.reviewerChoice.value = 'reviewer-one'; await ui.state.assign(); await ui.state.decide('approved'); assert.equal(calls.length, 0);
  ui.state.selected.value.review.canAssign = true; await ui.state.assign(); assert.deepEqual(calls, [['review', 7, 'reviewer-one']]);
  ui.state.selected.value = { review: { id: 'review', revision: 8, status: 'pending', canAssign: true } };
  await ui.state.assign(true); assert.deepEqual(calls[1], ['review', 8, null]);
});

test('material archive is explicit, owner-only and terminal; history switches to the retained list', async t => {
  const calls = []; const ui = mount(t, { client: {
    materialReviews: async () => ({ reviews: [] }), materialReviewHistory: async offset => { calls.push(['history', offset]); return { reviews: [], hasMore: false }; },
    archiveMaterialReview: async (...args) => { calls.push(['archive', ...args]); return {}; }
  } });
  await ui.state.refresh();
  for (const review of [{ owned: false, status: 'approved' }, { owned: true, status: 'pending' }, { owned: true, status: 'approved', archivedAt: 'now' }]) {
    ui.state.selected.value = { review: { id: 'r', revision: 3, ...review } }; await ui.state.archive();
  }
  assert.equal(calls.length, 0);
  ui.state.selected.value = { review: { id: 'r', revision: 3, owned: true, status: 'approved' } }; await ui.state.archive();
  assert.deepEqual(calls[0], ['archive', 'r', 3]);
  ui.state.showHistory.value = true; await vue.nextTick(); await ui.state.refresh(10);
  assert.ok(calls.some(call => call[0] === 'history' && call[1] === 10));
});

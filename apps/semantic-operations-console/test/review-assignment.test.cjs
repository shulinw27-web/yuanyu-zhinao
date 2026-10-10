const test = require('node:test'); const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'); const { resolve } = require('node:path');
const { parse, compileScript } = require('@vue/compiler-sfc'); const vue = require('vue');
const filename = resolve(__dirname, '../src/components/SemanticAgentWorkspace.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const source = compileScript(descriptor, { id: 'review-assignment-test' }).content
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_, names) => `const { ${names.replace(/\s+as\s+/gu, ': ')} } = Vue;`)
  .replace(/import[^;]+from ['"]\.\.\/task-guards.js['"];?/u, 'const canExecuteSemanticTask = () => true;')
  .replace(/import[^;]+from ['"]\.\.\/task-selection.js['"];?/u, 'const resolveSemanticTaskSelection = async ({tasks}) => ({ tasks, selected: tasks[0] || null });')
  .replace(/import[^;]+from ['"]@healthcare-ai\/agent-ui\/meta-model['"];?/u, 'const OntologyGraph = {};')
  .replace('export default', 'return');
const Component = new Function('Vue', source)(vue);
const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode() {}, nextSibling() {}, patchProp() {}, insert() {}, remove() {} });
function mount(t, extra = {}) {
  let state; const props = vue.reactive({ canReview: false, initialTaskId: '', client: { tasks: async () => ({ tasks: [] }), semanticSources: async () => ({ sources: [] }), ...extra } });
  const app = renderer.createApp({ setup() { state = Component.setup(props, { expose() {}, emit() {} }); return () => null; } }); app.mount({}); t.after(() => app.unmount());
  return { props, state };
}
test('review assignment UI performs no implicit write, requires permission and submits selected target with revision', async t => {
  const calls = [];
  const ui = mount(t, { modelReviewers: async () => ({ reviewers: [{ subjectId: 'bob', name: '审核人' }], actorSubjectId: 'alice' }), assignModelReview: async (id, body) => { calls.push({ id, body }); } });
  await vue.nextTick(); assert.equal(calls.length, 0); assert.deepEqual(ui.state.reviewers.value, []);
  await ui.state.assignReview(); assert.equal(calls.length, 0);
  ui.props.canReview = true; await vue.nextTick(); await ui.state.loadReviewers();
  ui.state.selected.value = { id: 'task1', status: 'waiting_confirmation', command: 'apply_proposal', reviewAssignment: { revision: 3, subjectId: 'bob' }, proposal: { objectTypes: [], relationshipTypes: [] } };
  assert.equal(ui.state.canExecute.value, false);
  ui.state.reviewerChoice.value = 'bob'; await ui.state.assignReview();
  assert.deepEqual(calls, [{ id: 'task1', body: { subjectId: 'bob', expectedRevision: 3 } }]);
});
test('revocation and identity client changes discard a late reviewer roster', async t => {
  let finish; const ui = mount(t, { modelReviewers: () => new Promise(resolve => { finish = resolve; }) });
  ui.props.canReview = true; await vue.nextTick();
  const loading = ui.state.loadReviewers(); ui.props.canReview = false; await vue.nextTick(); finish({ reviewers: [{ subjectId: 'foreign' }], actorSubjectId: 'foreign' }); await loading;
  assert.deepEqual(ui.state.reviewers.value, []); assert.equal(ui.state.reviewerActor.value, '');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse, compileScript } = require('@vue/compiler-sfc');
const vue = require('vue');
const filename = resolve(__dirname, '../src/components/SemanticOnboardingCalculation.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const compiled = compileScript(descriptor, { id: 'calculation-test' }).content;
const executable = compiled.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_match, names) => `const { ${names.replace(/\s+as\s+/gu, ': ')} } = Vue;`).replace('export default', 'return');
const Component = new Function('Vue', executable)(vue);
const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode() {}, nextSibling() {}, patchProp() {}, insert() {}, remove() {} });
const deferred = () => { let resolve; let reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const metadata = () => ({ projectId: 'p1', revision: 1, candidateFingerprint: 'fp1', plans: [{ id: 'plan1', label: '测试', rootObjectType: 'Order' }], blockers: [] });
const result = () => ({ projectId: 'p1', revision: 1, candidateFingerprint: 'fp1', planId: 'plan1', target: 'O1', status: 'calculated', published: false, executionAuthorized: false, results: [] });
function mount(t, overrides = {}) {
  let state; const writes = []; const events = [];
  const props = vue.reactive({ project: { id: 'p1', revision: 1 }, canWrite: true, blocked: false,
    client: { onboardingCalculations: async () => metadata(), previewOnboardingCalculation: async (id, body) => { writes.push({ id, body }); return result(); }, ...overrides } });
  const app = renderer.createApp({ setup() { state = Component.setup(props, { expose() {}, emit: (...args) => events.push(args) }); return () => null; } });
  app.mount({}); t.after(() => app.unmount()); return { state, props, writes, events, app };
}
test('calculation sends current model and project versions and never sends grants or raw records', async t => {
  const ui = mount(t); await ui.state.refresh(); ui.state.target.value = ' O1 '; await ui.state.run();
  assert.deepEqual(ui.writes, [{ id: 'p1', body: { expectedRevision: 1, candidateFingerprint: 'fp1', planId: 'plan1', target: 'O1' } }]);
  assert.equal(ui.state.report.value.status, 'calculated'); assert.equal(ui.state.busy.value, false);
});
test('readonly, blocked, missing target and blockers cannot invoke calculation', async t => {
  const ui = mount(t); await ui.state.run(); assert.equal(ui.writes.length, 0);
  await ui.state.refresh(); await ui.state.run(); assert.equal(ui.writes.length, 0);
  ui.state.target.value = 'O1'; ui.state.metadata.value.blockers = ['待采纳']; await ui.state.run();
  ui.props.canWrite = false; await ui.state.refresh(); await ui.state.run(); assert.equal(ui.writes.length, 0);
});
test('project changes discard late metadata and calculation responses', async t => {
  const pending = deferred(); const ui = mount(t, { onboardingCalculations: () => pending.promise });
  const request = ui.state.refresh(); ui.props.project = { id: 'p2', revision: 1 }; pending.resolve(metadata()); await request; assert.equal(ui.state.metadata.value, null);
  const calculation = deferred(); const other = mount(t, { previewOnboardingCalculation: () => calculation.promise });
  await other.state.refresh(); other.state.target.value = 'O1'; const running = other.state.run(); other.props.project.revision = 2; calculation.resolve(result()); await running;
  assert.equal(other.state.report.value, null); assert.equal(other.state.busy.value, false);
});
test('duplicate clicks do not duplicate reads and wrong result fingerprint is rejected', async t => {
  const pending = deferred(); let calls = 0; const ui = mount(t, { previewOnboardingCalculation: () => { calls++; return pending.promise; } });
  await ui.state.refresh(); ui.state.target.value = 'O1'; const running = ui.state.run(); await ui.state.run(); assert.equal(calls, 1);
  pending.resolve({ ...result(), candidateFingerprint: 'wrong' }); await running; assert.equal(ui.state.report.value, null); assert.match(ui.state.error.value, /不一致/);
});
test('editing target and parent operations invalidate prior results', async t => {
  const ui = mount(t); await ui.state.refresh(); ui.state.target.value = 'O1'; await ui.state.run();
  ui.state.target.value = 'O2'; assert.equal(ui.state.report.value, null);
  ui.props.blocked = true; assert.equal(ui.state.metadata.value, null); assert.equal(ui.state.runnable.value, false);
});

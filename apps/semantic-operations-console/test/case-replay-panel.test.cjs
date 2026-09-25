const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { parse, compileScript } = require('@vue/compiler-sfc');
const vue = require('vue');
// 组件源码已上提到 @healthcare-ai/agent-ui；这里通过包的声明式入口解析目录，
// 不再用相对路径穿透兄弟包的私有源码（见 docs/architecture/MODULARIZATION_AUDIT.md 第 2 节）。
const metaModelDir = dirname(require.resolve('@healthcare-ai/agent-ui/meta-model'));
const filename = resolve(metaModelDir, 'OntologyCaseReplay.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const compiled = compileScript(descriptor, { id: 'case-replay-test' }).content;
const executable = compiled.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_match, names) => `const { ${names.replace(/\s+as\s+/gu, ': ')} } = Vue;`).replace('export default', 'return');
const Component = new Function('Vue', executable)(vue);
const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode() {}, nextSibling() {}, patchProp() {}, insert() {}, remove() {} });
const deferred = () => { let resolve; let reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const result = (fingerprint = 'current') => ({ status: 'passed', candidateFingerprint: fingerprint, cases: [] });
const file = promise => ({ target: { files: [{ size: 100, text: () => promise }], value: '' } });
function mount(t, execute = async () => result()) {
  const props = vue.reactive({ fingerprint: 'current', role: 'executive', disabled: false, readPlanMode: false, execute }); let state;
  const app = renderer.createApp({ setup() { state = Component.setup(props, { expose() {} }); return () => null; } });
  app.mount({}); t.after(() => app.unmount()); return { props, state, app };
}
test('report must match current fingerprint and recognized result status', async t => {
  for (const value of [result('other'), {}, { ...result(), status: 'completed' }]) {
    const ui = mount(t, async () => value); ui.state.input.value = '[{}]'; await ui.state.run();
    assert.equal(ui.state.report.value, null); assert.match(ui.state.error.value, /未对应当前模型/);
  }
  const ui = mount(t); ui.state.input.value = '[{}]'; await ui.state.run(); assert.equal(ui.state.report.value.status, 'passed');
});
test('mode, execute, role, fingerprint and disabled changes invalidate in-flight results', async t => {
  for (const change of [ui => { ui.props.readPlanMode = true; }, ui => { ui.props.execute = async () => result(); }, ui => { ui.props.role = 'other'; }, ui => { ui.props.fingerprint = 'new'; }, ui => { ui.props.disabled = true; }]) {
    const pending = deferred(); const ui = mount(t, () => pending.promise); ui.state.input.value = '[{}]'; const operation = ui.state.run();
    change(ui); assert.equal(ui.state.busy.value, false); assert.equal(ui.state.input.value, '');
    pending.resolve(result()); await operation; assert.equal(ui.state.report.value, null);
  }
});
test('old completion never unlocks a newer request or overwrites its result', async t => {
  const older = deferred(); const newer = deferred(); const ui = mount(t, () => older.promise);
  ui.state.input.value = '[{}]'; const first = ui.state.run(); ui.props.execute = () => newer.promise;
  ui.state.input.value = '[{}]'; const second = ui.state.run(); older.resolve(result()); await first;
  assert.equal(ui.state.busy.value, true); assert.equal(ui.state.report.value, null);
  newer.resolve(result()); await second; assert.equal(ui.state.busy.value, false); assert.equal(ui.state.report.value.status, 'passed');
});
test('file read blocks replay and context changes discard late imports', async t => {
  let calls = 0; const ui = mount(t, async () => { calls++; return result(); }); const pending = deferred();
  ui.state.input.value = '[{}]'; const operation = ui.state.importCases(file(pending.promise));
  assert.equal(ui.state.busy.value, true); await ui.state.run(); assert.equal(calls, 0);
  ui.props.fingerprint = 'new'; pending.resolve('[{},{}]'); await operation;
  assert.equal(ui.state.input.value, ''); assert.equal(ui.state.busy.value, false);
  await ui.state.importCases(file(Promise.resolve('[{}]'))); assert.equal(ui.state.input.value, '[{}]'); assert.equal(ui.state.busy.value, false);
});
test('unmount and input changes reject stale success and failure', async t => {
  for (const change of [ui => ui.app.unmount(), ui => { ui.state.input.value = '[{},{}]'; }]) {
    const pending = deferred(); const ui = mount(t, () => pending.promise); ui.state.input.value = '[{}]'; const operation = ui.state.run();
    change(ui); pending.reject(new Error('old error')); await operation;
    assert.equal(ui.state.error.value, ''); assert.equal(ui.state.report.value, null);
  }
});
test('duplicate runs, blank inputs and missing fingerprint do not issue requests', async t => {
  const pending = deferred(); let calls = 0; const ui = mount(t, () => { calls++; return pending.promise; });
  await ui.state.run(); assert.equal(calls, 0); ui.props.fingerprint = ''; ui.state.input.value = '[{}]'; await ui.state.run(); assert.equal(calls, 0);
  ui.props.fingerprint = 'current'; ui.state.input.value = '[{}]'; const operation = ui.state.run(); await ui.state.run(); assert.equal(calls, 1);
  pending.resolve(result()); await operation;
});

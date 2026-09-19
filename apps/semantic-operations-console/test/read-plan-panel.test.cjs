const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse, compileScript } = require('@vue/compiler-sfc');
const vue = require('vue');
const filename = resolve(__dirname, '../../../frontend/src/features/meta-model/OntologyReadPlanPanel.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const compiled = compileScript(descriptor, { id: 'read-plan-panel-test' }).content;
const executable = compiled.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_match, names) => `const { ${names.replace(/\s+as\s+/gu, ': ')} } = Vue;`)
  .replace(/import \{ parseReadPlanImport \} from '[^']+';/u, 'const { parseReadPlanImport } = helpers;').replace('export default', 'return');
const deferred = () => { let resolve; let reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await vue.nextTick(); };
const plan = id => ({ id, label: id, datasets: [{ id: 'orders', objectType: 'Order', where: [{ field: 'id', target: true }] }], outputs: [{ id: 'qty', label: '数量', unit: '件', expression: { op: 'one', dataset: 'orders', field: 'qty' } }] });
const file = value => ({ target: { files: [{ size: 100, text: () => Promise.resolve(JSON.stringify(plan(value))) }], value: 'file' } });
const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode() {}, nextSibling() {}, patchProp() {}, insert() {}, remove() {} });
async function mount(t, client) {
  const helpers = await import('../../../frontend/src/features/meta-model/ontology-read-plan-import.js');
  const Component = new Function('Vue', 'helpers', executable)(vue, helpers);
  const props = vue.reactive({ draft: { objectTypes: [{ id: 'Order' }], scenario: { readPlans: [] } }, canEdit: true, client, savedFingerprint: 'a'.repeat(24), hasUnsavedChanges: false });
  const emitted = []; let state;
  const app = renderer.createApp({ setup() { state = Component.setup(props, { expose() {}, emit: (...args) => emitted.push(args) }); return () => null; } });
  app.mount({}); t.after(() => app.unmount()); await flush();
  return { props, state, emitted, app };
}
const policy = { enabled: true, provider: 'synthetic', model: 'mock' };
async function prepare(ui) { ui.state.request.value = '合计有效订单数量'; ui.state.rootType.value = 'Order'; await flush(); ui.state.consent.value = true; }

test('last selected import wins and stale failure cannot replace the current preview', async t => {
  const ui = await mount(t); const older = deferred();
  const first = ui.state.importPlan({ target: { files: [{ size: 100, text: () => older.promise }], value: '' } });
  await ui.state.importPlan(file('newer')); older.resolve(JSON.stringify(plan('older'))); await first;
  assert.equal(ui.state.pending.value[0].id, 'newer');
  const failed = deferred(); const second = ui.state.importPlan({ target: { files: [{ size: 100, text: () => failed.promise }], value: '' } });
  await ui.state.importPlan(file('latest')); failed.reject(new Error('old failure')); await second;
  assert.equal(ui.state.pending.value[0].id, 'latest'); assert.equal(ui.state.error.value, '');
});

test('manual import supersedes an in-flight model proposal without accepting its late response', async t => {
  const pending = deferred(); let calls = 0;
  const ui = await mount(t, { providers: async () => ({ answerPolicy: policy }), proposeReadPlan: () => { calls++; return pending.promise; } });
  await prepare(ui); const proposal = ui.state.propose();
  await ui.state.importPlan(file('manual')); pending.resolve({ plan: plan('generated') }); await proposal;
  assert.equal(calls, 1); assert.equal(ui.state.pending.value[0].id, 'manual'); assert.equal(ui.state.consent.value, false);
  ui.state.apply(); assert.equal(ui.emitted.length, 1); assert.equal(ui.emitted[0][1][0].id, 'manual');
});

test('client changes invalidate proposal, pending import and consent', async t => {
  const pending = deferred(); const ui = await mount(t, { providers: async () => ({ answerPolicy: policy }), proposeReadPlan: () => pending.promise });
  await prepare(ui); const proposal = ui.state.propose();
  ui.props.client = { providers: async () => ({ answerPolicy: { ...policy, model: 'other' } }) }; await flush();
  pending.resolve({ plan: plan('old_client') }); await proposal;
  assert.equal(ui.state.pending.value, null); assert.equal(ui.state.consent.value, false);
  const delayed = deferred(); const imported = ui.state.importPlan({ target: { files: [{ size: 100, text: () => delayed.promise }], value: '' } });
  ui.props.client = undefined; delayed.resolve(JSON.stringify(plan('old_file'))); await imported;
  assert.equal(ui.state.pending.value, null);
});

test('A-B-A provider responses cannot revive an older policy or consent', async t => {
  const first = deferred(); const latest = deferred(); let count = 0;
  const a = { providers: () => (++count === 1 ? first.promise : latest.promise) };
  const ui = await mount(t, a); ui.props.client = { providers: async () => ({ answerPolicy: policy }) }; await flush();
  ui.props.client = a; await flush(); latest.resolve({ answerPolicy: { ...policy, model: 'new-policy' } }); await flush();
  first.resolve({ answerPolicy: { ...policy, model: 'old-policy' } }); await flush();
  assert.equal(ui.state.policy.value.model, 'new-policy'); assert.equal(ui.state.consent.value, false);
});

test('draft changes, readonly state and unmount discard late imports and proposals', async t => {
  for (const change of [ui => { ui.props.savedFingerprint = 'b'.repeat(24); }, ui => { ui.props.hasUnsavedChanges = true; }, ui => { ui.props.canEdit = false; }, ui => ui.app.unmount()]) {
    const ui = await mount(t); const pending = deferred();
    const operation = ui.state.importPlan({ target: { files: [{ size: 100, text: () => pending.promise }], value: '' } });
    change(ui); pending.resolve(JSON.stringify(plan('stale'))); await operation;
    assert.equal(ui.state.pending.value, null); ui.state.apply(); assert.equal(ui.emitted.length, 0);
  }
});

test('duplicate generation and incomplete requests never invoke extra model calls', async t => {
  const pending = deferred(); let calls = 0;
  const ui = await mount(t, { providers: async () => ({ answerPolicy: policy }), proposeReadPlan: () => { calls++; return pending.promise; } });
  ui.state.consent.value = true; await ui.state.propose(); assert.equal(calls, 0);
  await prepare(ui); const operation = ui.state.propose(); await ui.state.propose(); assert.equal(calls, 1);
  pending.resolve({ plan: plan('valid') }); await operation;
  ui.props.canEdit = false; ui.state.apply(); assert.equal(ui.emitted.length, 0);
});

test('malformed import cannot be adopted and all preconditions have a meaningful preview', async t => {
  const ui = await mount(t);
  await ui.state.importPlan({ target: { files: [{ size: 100, text: async () => JSON.stringify({ ...plan('bad'), datasets: [null] }) }], value: '' } });
  assert.equal(ui.state.pending.value, null); assert.match(ui.state.error.value, /结构无效/); ui.state.apply(); assert.equal(ui.emitted.length, 0);
  assert.match(ui.state.expression({ op: 'all', dataset: 'orders', value: { op: 'eq', args: [{ op: 'field', dataset: 'orders', field: 'unit' }, { op: 'literal', value: 'piece' }] } }), /全部 orders 记录均满足.*orders.unit.*piece/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse, compileScript } = require('@vue/compiler-sfc');
const vue = require('vue');
const filename = resolve(__dirname, '../src/components/SemanticOnboardingAlignment.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const compiled = compileScript(descriptor, { id: 'alignment-test', inlineTemplate: true }).content;
const executable = compiled.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_match, names) => `const { ${names.replace(/\s+as\s+/gu, ': ')} } = Vue;`).replace('export default', 'return');
const Component = new Function('Vue', executable)({ ...vue, vModelText: {}, vModelSelect: {} });
const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null });
const renderer = vue.createRenderer({
  createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (item, text) => { item.text = text; }, setElementText: (item, text) => { item.children = []; item.text = text; },
  parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] || null,
  patchProp: (item, key, _old, value) => { item.props[key] = value; },
  insert: (item, parent, anchor = null) => {
    if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, item); item.parent = parent;
  },
  remove: item => { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null; }
});
const flatten = item => [item, ...item.children.flatMap(flatten)];
const content = item => item.type === '#comment' ? '' : `${item.text}${item.children.map(content).join(' ')}`;
const flush = async () => { await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await vue.nextTick(); };
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const snapshot = (id = 'p1', revision = 1) => ({ projectId: id, revision, config: null, report: null, tables: [{ name: 'Order', system: 'OMS', primaryKey: 'id', granularity: 'order', fields: [{ name: 'id', type: 'string' }, { name: 'qty', type: 'integer', unit: 'piece' }] }] });
async function mount(t, options = {}) {
  const writes = []; const updates = []; const locks = [];
  const state = vue.reactive({ project: { id: 'p1', revision: 1 }, canWrite: options.canWrite ?? true, blocked: false });
  const client = { onboardingAlignment: async id => snapshot(id, state.project.revision), saveOnboardingAlignment: async (id, payload) => { writes.push({ id, payload }); return { project: { id, revision: payload.expectedRevision + 1 } }; }, ...options.client };
  const root = node('root');
  const app = renderer.createApp({ render: () => vue.h(Component, { ...state, client, onUpdated: value => { updates.push(value); state.project = value; }, onBusy: value => locks.push(value) }) });
  app.mount(root); t.after(() => app.unmount()); await flush();
  const find = id => { const result = flatten(root).find(item => item.props['data-testid'] === id); assert.ok(result, id); return result; };
  return { state, client, root, app, writes, updates, locks, find, text: () => content(root), click: id => find(id).props.onClick(),
    async input(id, value) { const item = find(id); item.props['onUpdate:modelValue'](value); item.props.onInput?.({ target: { value } }); await flush(); } };
}
test('visual identity editor saves explicit config with revision, invalidates report and blocks parent during edits', async t => {
  const ui = await mount(t); assert.equal(ui.find('save-alignment').props.disabled, true);
  await ui.click('add-identities'); await flush(); assert.equal(ui.locks.at(-1), true);
  await ui.input('identities-0-evidence', '需求文档第 2 节');
  await ui.click('save-alignment'); await flush();
  assert.deepEqual(ui.writes[0], { id: 'p1', payload: { expectedRevision: 1, config: { version: 'mock-alignment.v1', identities: [{ objectType: 'Order', canonicalType: 'Order', granularity: 'order', aliases: [], evidence: '需求文档第 2 节' }], units: [], states: [] } } });
  assert.equal(ui.updates[0].revision, 2); assert.equal(ui.locks.at(-1), false);
  assert.match(ui.text(), /重新验证完整数据/);
});
test('readonly and invalid dictionary cannot add or save rules', async t => {
  for (const options of [{ canWrite: false }, { client: { onboardingAlignment: async () => ({ ...snapshot(), tables: [] }) } }]) {
    const ui = await mount(t, options); await ui.click('add-identities'); await ui.click('save-alignment'); await flush();
    assert.equal(ui.find('save-alignment').props.disabled, true); assert.equal(ui.writes.length, 0);
  }
});
test('version conflict preserves edits and requires explicit discard instead of automatic retry', async t => {
  let calls = 0;
  const ui = await mount(t, { client: { saveOnboardingAlignment: async () => { calls++; throw Object.assign(new Error('版本冲突'), { status: 409 }); } } });
  await ui.click('add-identities'); await flush(); await ui.input('identities-0-evidence', '人工依据');
  await ui.click('save-alignment'); await flush(); await ui.click('save-alignment');
  assert.equal(calls, 1); assert.match(ui.text(), /未自动重试或覆盖/); assert.equal(ui.locks.at(-1), true);
  ui.state.project.revision = 3; await flush(); assert.ok(ui.find('identities-0-evidence')); assert.match(ui.text(), /有未保存修改/);
  await ui.click('reload-alignment'); await flush(); assert.equal(ui.locks.at(-1), false); assert.match(ui.text(), /修订 3/);
});
test('pending save refuses duplicate submissions and late unmounted response cannot update project', async t => {
  const pending = deferred(); let calls = 0;
  const ui = await mount(t, { client: { saveOnboardingAlignment: () => { calls++; return pending.promise; } } });
  await ui.click('add-identities'); await flush(); const first = ui.click('save-alignment'); await ui.click('save-alignment');
  assert.equal(calls, 1); ui.app.unmount(); pending.resolve({ project: { id: 'p1', revision: 2 } }); await first;
  assert.equal(ui.updates.length, 0);
});
test('late old-project read never replaces current dictionary and errors stay actionable', async t => {
  const pending = deferred();
  const ui = await mount(t, { client: { onboardingAlignment: id => id === 'p1' ? pending.promise : Promise.resolve(snapshot(id, 4)) } });
  ui.state.project = { id: 'p2', revision: 4 }; await flush(); pending.resolve({ ...snapshot('p1'), tables: [] }); await flush();
  await ui.click('add-identities'); await flush(); assert.ok(ui.find('identity-0-type')); assert.match(ui.text(), /有未保存修改/);
});
test('blocked connection response refreshes report only when operation ends, and edits hide old results', async t => {
  const ui = await mount(t); ui.state.blocked = true; ui.state.project.revision = 2;
  ui.client.onboardingAlignment = async () => ({ ...snapshot('p1', 2), report: { status: 'needs_review', issues: [{ code: 'STATE', path: 'states[0]', message: '缺少状态映射' }], previews: {}, unconfiguredObjects: ['Stock'] } });
  await flush(); ui.state.blocked = false; await flush(); assert.match(content(ui.find('alignment-report')), /缺少状态映射/);
  await ui.click('add-states'); await flush(); assert.equal(flatten(ui.root).some(item => item.props['data-testid'] === 'alignment-report'), false);
});

test('numeric object primary keys do not coerce string business state values', async t => {
  const value = snapshot(); value.tables[0].fields[0].type = 'integer'; value.tables[0].fields.push({ name: 'status', type: 'string' });
  const ui = await mount(t, { client: { onboardingAlignment: async () => value } });
  await ui.click('add-states'); await flush(); await ui.input('states-0-evidence', '状态字典');
  ui.find('states-0-field').props['onUpdate:modelValue']('status');
  ui.find('states-0-0-source').props.onInput({ target: { value: '001' } });
  ui.find('states-0-0-target').props.onInput({ target: { value: 'pending' } });
  await ui.click('save-alignment'); await flush();
  assert.deepEqual(ui.writes[0].payload.config.states[0].values, [{ source: '001', target: 'pending' }]);
});

test('failed save retains exact evidence and state pairs for a deliberate retry', async t => {
  let attempts = 0; const payloads = [];
  const ui = await mount(t, { client: { saveOnboardingAlignment: async (id, payload) => {
    attempts++; payloads.push(payload); if (attempts === 1) throw new Error('网络暂不可用'); return { project: { id, revision: 2 } };
  } } });
  await ui.click('add-states'); await flush(); await ui.input('states-0-evidence', '人工规则第 3 节');
  ui.find('states-0-0-source').props.onInput({ target: { value: 'open' } });
  ui.find('states-0-0-target').props.onInput({ target: { value: 'pending' } });
  await ui.click('save-alignment'); await flush(); assert.match(ui.text(), /网络暂不可用/);
  await ui.click('save-alignment'); await flush(); assert.deepEqual(payloads[1], payloads[0]);
  assert.equal(payloads[1].config.states[0].evidence, '人工规则第 3 节');
});

test('evidence selection binds current server digest and clears an old quote on reselection', async t => {
  const source = { kind: 'rules', name: '规则.txt', digest: 'a'.repeat(64), text: '这是用于测试的完整原始业务规则摘录。' };
  const ui = await mount(t, { client: { onboardingAlignment: async () => ({ ...snapshot(), evidenceSources: [source] }) } });
  await ui.click('add-identities'); await flush(); await ui.input('identities-0-evidence', '业务说明');
  ui.find('identities-0-material').props.onChange({ target: { value: 'rules' } }); await flush();
  await ui.input('identities-0-quote', source.text); await ui.click('save-alignment'); await flush();
  assert.deepEqual(ui.writes[0].payload.config.identities[0].materialEvidence, { kind: 'rules', digest: source.digest, quote: source.text });
  ui.find('identities-0-material').props.onChange({ target: { value: 'rules' } }); await flush(); await ui.click('save-alignment'); await flush();
  assert.equal(ui.writes[1].payload.config.identities[0].materialEvidence.quote, '');
});

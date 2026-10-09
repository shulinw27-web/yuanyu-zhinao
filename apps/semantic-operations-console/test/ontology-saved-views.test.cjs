const test = require('node:test'); const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'); const { resolve } = require('node:path');
const { parse, compileScript } = require('@vue/compiler-sfc'); const vue = require('vue');
const filename = resolve(__dirname, '../../../packages/agent-ui/src/meta-model/OntologySavedViewsPanel.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const executable = compileScript(descriptor, { id: 'saved-views' }).content.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_, names) => `const { ${names.replace(/\s+as\s+/gu, ': ')} } = Vue;`).replace('export default', 'return');
const Component = new Function('Vue', 'location', 'history', executable)(vue, { href: 'http://local/' }, { replaceState() {} });
const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode() {}, nextSibling() {}, patchProp() {}, insert() {}, remove() {} });
function mount(t, client) { let state; const events = []; const fingerprint = 'a'.repeat(24); const props = vue.reactive({ client, draft: { fingerprint }, layout: { fingerprint, positions: {}, scale: 1, offset: { x: 0, y: 0 } }, selectedId: '', canEdit: true }); const app = renderer.createApp({ setup() { state = Component.setup(props, { expose() {}, emit: (...args) => events.push(args) }); return () => null; } }); app.mount({}); t.after(() => app.unmount()); return { state, props, events }; }
test('personal view UI saves only on explicit editable action and restores only a server-read view', async t => {
  let saves = 0; const view = { id: 'a'.repeat(36), revision: 1, label: '采购图', layout: {}, modelFingerprint: 'a'.repeat(24) };
  const ui = mount(t, { modelViews: async () => ({ views: [] }), saveModelView: async body => { saves++; assert.equal(body.expectedRevision, 0); return { view }; }, modelView: async () => ({ view }) });
  await vue.nextTick(); assert.equal(saves, 0); ui.props.canEdit = false; await vue.nextTick(); await ui.state.save(); assert.equal(saves, 0);
  ui.props.canEdit = true; await vue.nextTick(); await ui.state.save(); assert.equal(saves, 1); assert.match(ui.state.link.value, /saved-model-view/);
  await ui.state.restore(view.id); assert.equal(ui.events[0][0], 'restore'); assert.equal(ui.events[0][1].id, view.id);
});
test('changing client or model clears late views and cannot revive a foreign layout', async t => {
  let finish; const ui = mount(t, { modelViews: () => new Promise(resolve => { finish = resolve; }) });
  ui.props.client = { modelViews: async () => ({ views: [] }) }; await vue.nextTick(); finish({ views: [{ id: 'foreign' }] }); await vue.nextTick();
  assert.deepEqual(ui.state.views.value, []);
  ui.state.views.value = [{ id: 'old' }]; ui.props.draft = { fingerprint: 'b'.repeat(24) }; await vue.nextTick(); assert.deepEqual(ui.state.views.value, []);
});

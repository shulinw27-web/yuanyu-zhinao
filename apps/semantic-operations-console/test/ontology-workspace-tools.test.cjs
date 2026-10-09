const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse, compileScript } = require('@vue/compiler-sfc');
const vue = require('vue');
const tools = require('../../../packages/agent-ui/src/meta-model/ontology-tools.js');
const exchange = { ...require('../../../packages/agent-ui/src/meta-model/ontology-exchange.js'), ...require('../../../packages/agent-ui/src/meta-model/ontology-exchange-profiles.js') };
const Packs = require('../../../packages/agent-ui/src/meta-model/ontology-mock-packs.js');
const filename = resolve(__dirname, '../../../packages/agent-ui/src/meta-model/OntologyWorkspaceTools.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const compiled = compileScript(descriptor, { id: 'ontology-tools-test' }).content;
const executable = compiled.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_, names) => `const { ${names.replace(/\s+as\s+/gu, ': ')} } = Vue;`)
  .replace(/import OntologyGraph[^;]+;/u, 'const OntologyGraph = {};')
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/ontology-tools\.js['"];?/u, (_, names) => `const { ${names} } = Tools;`)
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/ontology-exchange-profiles\.js['"];?/u, (_, names) => `const { ${names} } = Exchange;`)
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/ontology-mock-packs\.js['"];?/u, (_, names) => `const { ${names} } = Packs;`).replace('export default', 'return');
const Component = new Function('Vue', 'Tools', 'Exchange', 'Packs', 'location', executable)(vue, tools, exchange, Packs, { hash: '', href: 'http://local/' });
const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode() {}, nextSibling() {}, patchProp() {}, insert() {}, remove() {} });
const definition = () => ({ fingerprint: 'a'.repeat(24), objectTypes: [{ id: 'Order', label: '订单', key: 'id', fields: ['id'], sourceSystems: [] }], relationshipTypes: [] });
function mount(t) { let state; const events = []; const props = vue.reactive({ draft: definition(), canEdit: true, selectedId: '' }); const app = renderer.createApp({ setup() { state = Component.setup(props, { expose() {}, emit: (...args) => events.push(args) }); return () => null; } }); app.mount({}); t.after(() => app.unmount()); return { state, props, events, app }; }
const event = text => ({ target: { files: [{ size: text.length, text: async () => text }], value: 'file' } });
test('format import remains a candidate, readonly handoff cannot emit material, explicit handoff retains original', async t => {
  const ui = mount(t); const raw = JSON.stringify(exchange.exportOntologySubset(definition())); await ui.state.loadFile(event(raw)); assert.ok(ui.state.imported.value); assert.equal(ui.events.length, 0);
  ui.props.canEdit = false; ui.state.handoff(); assert.equal(ui.events.length, 0);
  ui.props.canEdit = true; ui.state.handoff(); assert.equal(ui.events[0][0], 'material'); assert.equal(JSON.parse(ui.events[0][1].text).original, raw);
});
test('draft changes and unmount discard late format reads, no stale model candidate is revived', async t => {
  const ui = mount(t); let finish; const pending = new Promise(resolve => { finish = resolve; }); const running = ui.state.loadFile({ target: { value: 'file', files: [{ size: 100, text: () => pending }] } });
  ui.props.draft = { ...definition(), fingerprint: 'b'.repeat(24) }; await vue.nextTick(); finish(JSON.stringify(exchange.exportOntologySubset(definition()).document)); await running; assert.equal(ui.state.imported.value, null);
  let finish2; const running2 = ui.state.loadFile({ target: { value: '', files: [{ size: 100, text: () => new Promise(resolve => { finish2 = resolve; }) }] } }); ui.app.unmount(); finish2('{}'); await running2; assert.equal(ui.state.error.value, '');
});

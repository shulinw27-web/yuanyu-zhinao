const test = require('node:test'); const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'); const { resolve } = require('node:path');
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc'); const Vue = require('vue');
const Graph = require('../../../packages/agent-ui/src/meta-model/ontology-graph.js');
const Layout = require('../../../packages/agent-ui/src/meta-model/ontology-edit-session.js');
const filename = resolve(__dirname, '../../../packages/agent-ui/src/meta-model/OntologyGraph.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const compiled = compileScript(descriptor, { id: 'graph-layout-regression' });
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: 'graph-layout-regression', compilerOptions: { bindingMetadata: compiled.bindings } }).errors, []);
const executable = compiled.content.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_, names) => `const { ${names.replace(/\s+as\s+/gu, ': ')} } = Vue;`)
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/ontology-graph\.js['"];?/u, (_, names) => `const { ${names} } = Graph;`)
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/ontology-edit-session\.js['"];?/u, (_, names) => `const { ${names} } = Layout;`).replace('export default', 'return');
const Component = new Function('Vue', 'Graph', 'Layout', executable)(Vue, Graph, Layout);
const renderer = Vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode() {}, nextSibling() {}, patchProp() {}, insert() {}, remove() {} });
function mount(t) {
  let state; const events = []; const props = Vue.reactive({ objects: [{ id: 'a', sourceSystems: ['ERP', 'WMS'] }, { id: 'b', sourceSystems: ['WMS'] }], relationships: [{ from: 'a', predicate: 'relates', to: 'b' }, { from: 'a', predicate: 'self', to: 'a' }], diff: {}, selectedId: '', modelFingerprint: 'fp', savedLayout: null });
  const app = renderer.createApp({ setup() { state = Component.setup(props, { expose() {}, emit: (...args) => events.push(args) }); return () => null; } });
  app.mount({}); t.after(() => app.unmount()); return { state, props, events };
}
test('source overview counts multi-source membership without synthetic group nodes or mutation', async t => {
  const ui = mount(t); const before = JSON.stringify(ui.props.objects);
  assert.deepEqual(ui.state.sourceCounts.value, [{ name: 'ERP', count: 1 }, { name: 'WMS', count: 2 }]);
  ui.state.system.value = 'ERP'; await Vue.nextTick();
  assert.deepEqual(ui.state.visible.value.nodes.map(node => node.id), ['a']);
  assert.equal(ui.state.visible.value.edges.length, 1);
  ui.state.system.value = ''; await Vue.nextTick();
  assert.equal(ui.state.visible.value.edges.length, 2); assert.equal(ui.events.length, 0);
  assert.equal(JSON.stringify(ui.props.objects), before);
});
test('geometry recomputes after node drag and server revision; self-loop top remains in view bounds', async t => {
  const ui = mount(t); const edge = ui.state.visible.value.edges[0];
  const path = ui.state.edgeGeometry.value.get(edge.id).path;
  ui.state.positions.value = { a: { x: 200, y: 45 } }; await Vue.nextTick();
  assert.notEqual(ui.state.edgeGeometry.value.get(edge.id).path, path);
  for (const geometry of ui.state.edgeGeometry.value.values()) assert.ok(geometry.minY >= -ui.state.topMargin.value);
  ui.state.selectRelation(edge); assert.equal(ui.events[0][0], 'select-relationship');
  ui.props.relationships = []; await Vue.nextTick();
  assert.equal(ui.state.edgeGeometry.value.size, 0); assert.equal(ui.state.selectedEdge.value, '');
  assert.deepEqual(ui.state.positions.value, {});
});

test('group overview drills into exact original definitions without emitting or mutating business nodes', async t => {
  const ui = mount(t); const before = JSON.stringify(ui.props);
  ui.state.showOverview();
  assert.equal(ui.state.overview.value, true);
  const multi = ui.state.sourceOverview.value.groups.find(group => group.label === 'ERP / WMS');
  ui.state.openGroup(multi.id);
  assert.deepEqual(ui.state.visible.value.nodes.map(node => node.id), ['a']);
  assert.deepEqual(ui.state.visible.value.edges.map(edge => edge.predicate), ['self']);
  ui.state.showOverview();
  ui.state.openCrossing(ui.state.sourceOverview.value.crossings[0].id);
  assert.deepEqual(ui.state.visible.value.edges.map(edge => edge.predicate), ['relates']);
  assert.equal(ui.events.length, 0); assert.equal(JSON.stringify(ui.props), before);
  ui.state.selectRelation(ui.state.visible.value.edges[0]);
  assert.deepEqual(ui.events[0], ['select-relationship', { from: 'a', predicate: 'relates', to: 'b' }]);
});

test('selection and external path exit folded scopes and clear stale filters', async t => {
  const ui = mount(t);
  ui.state.system.value = 'ERP'; await Vue.nextTick(); ui.state.showOverview();
  ui.state.openGroup(ui.state.sourceOverview.value.groups[0].id);
  ui.props.selectedId = 'b'; await Vue.nextTick();
  assert.equal(ui.state.groupScope.value, ''); assert.equal(ui.state.selected.value, 'b');
  assert.ok(ui.state.visible.value.nodes.some(node => node.id === 'b'));
  ui.state.system.value = 'ERP'; await Vue.nextTick(); ui.state.showOverview();
  ui.props.pathSelection = { from: 'a', to: 'b' }; await Vue.nextTick();
  assert.equal(ui.state.overview.value, false); assert.equal(ui.state.system.value, '');
  assert.equal(ui.state.pathRequested.value, true); assert.deepEqual(ui.state.path.value.nodes, ['a', 'b']);
});

test('filters and server revisions invalidate group scopes, never leave hidden stale selection', async t => {
  const ui = mount(t); ui.state.openCrossing(ui.state.sourceOverview.value.crossings[0].id);
  ui.state.query.value = 'b'; await Vue.nextTick();
  assert.equal(ui.state.crossingScope.value, null); assert.equal(ui.state.sourceOverview.value.crossings.length, 0);
  ui.state.query.value = ''; await Vue.nextTick(); ui.state.openGroup(ui.state.sourceOverview.value.groups[0].id);
  ui.props.objects = [{ id: 'c', sourceSystems: ['MES'] }]; await Vue.nextTick();
  assert.equal(ui.state.groupScope.value, ''); assert.deepEqual(ui.state.visible.value.nodes.map(node => node.id), ['c']);
});

test('domain overview is independent of sources and external paths clear domain restrictions', async t => {
  const ui = mount(t); ui.props.objects[0].businessDomain = '采购'; ui.props.objects[1].businessDomain = '仓储'; await Vue.nextTick();
  ui.state.showOverview('domain'); assert.deepEqual(ui.state.sourceOverview.value.groups.map(group => group.label), ['采购', '仓储']);
  ui.state.openGroup(ui.state.sourceOverview.value.groups[0].id); assert.equal(ui.state.visible.value.nodes.length, 1);
  ui.state.domain.value = '采购'; await Vue.nextTick(); ui.props.pathSelection = { from: 'a', to: 'b' }; await Vue.nextTick();
  assert.equal(ui.state.domain.value, ''); assert.deepEqual(ui.state.path.value.nodes, ['a', 'b']); assert.equal(ui.events.length, 0);
});

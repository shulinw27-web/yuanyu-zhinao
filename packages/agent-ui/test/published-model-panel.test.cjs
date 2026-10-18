const test = require('node:test'); const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'); const { resolve } = require('node:path'); const vue = require('vue');
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
const filename = resolve(__dirname, '../src/meta-model/PublishedModelPanel.vue'); const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const script = compileScript(descriptor, { id: 'published-panel-test' }).content.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_, names) => `const { ${names} } = Vue;`).replace(/import OntologyGraph from ['"][^'"]+['"];?/u, 'const OntologyGraph = {};').replace('export default', 'return');
const Component = new Function('Vue', script)(vue);
const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode() {}, nextSibling() {}, patchProp() {}, insert() {}, remove() {} });
const summary = { modelId: 'quality-model', label: '质量模型', version: 'synthetic-v1', fingerprint: 'a'.repeat(24), authority: 'published_schema_not_business_facts_or_permissions', runtimeReadEnabled: false, chatSelectionEnabled: false, nodeCount: 1, relationshipCount: 0 };
const catalog = () => ({ contentScope: 'published_model_catalog_only', runtimeReadEnabled: false, chatSelectionEnabled: false, models: [{ ...summary }] });
const detail = () => ({ contentScope: 'published_schema_only', model: { ...summary, graph: { nodes: [{ id: 'Lot', label: '批次', key: 'id', fields: ['id'], sourceSystems: ['WMS'] }], edges: [] } } });
function mount(t, client) {
  let state; const events = []; const props = vue.reactive({ client }); const app = renderer.createApp({ setup() { state = Component.setup(props, { expose() {}, emit: (...args) => events.push(args) }); return () => null; } });
  app.mount({}); t.after(() => app.unmount()); return { state, props, app, events };
}
test('published schema panel has no implicit IO, reads only selected definitions and compiles read-only graph', async t => {
  let reads = 0; const ids = []; const { state } = mount(t, { publishedModels: async () => { reads++; return catalog(); }, publishedModel: async id => { ids.push(id); return detail(); } });
  assert.equal(reads, 0); assert.equal(state.definition.value, null);
  await state.inspect('foreign'); assert.deepEqual(ids, []);
  await state.load(); assert.equal(reads, 1); assert.equal(state.definition.value, null);
  await state.inspect('quality-model'); assert.deepEqual(ids, ['quality-model']); assert.equal(state.definition.value.graph.nodes.length, 1);
  assert.equal(compileTemplate({ source: descriptor.template.content, filename, id: 'published-panel-test' }).errors.length, 0);
  assert.match(descriptor.template.content, /:ask-enabled="false"/u); assert.match(descriptor.template.content, /:layout-save-enabled="false"/u);
  assert.doesNotMatch(script, /localStorage|sessionStorage|sendAgent|executeCommand/u);
});
test('changed publication, forbidden state or failed refresh removes old models without retry', async t => {
  let calls = 0; let changed = false; const { state } = mount(t, { publishedModels: async () => { calls++; return catalog(); }, publishedModel: async () => { const value = detail(); if (changed) value.model.version = 'synthetic-v2'; return value; } });
  await state.load(); await state.inspect('quality-model'); assert.ok(state.definition.value);
  changed = true; await state.inspect('quality-model'); assert.equal(state.definition.value, null); assert.equal(state.models.value.length, 0); assert.match(state.error.value, /版本或权限/u); assert.equal(calls, 1);
  const malformed = mount(t, { publishedModels: async () => ({ ...catalog(), runtimeReadEnabled: true }) });
  await malformed.state.load(); assert.equal(malformed.state.models.value.length, 0); assert.ok(malformed.state.error.value);
});
test('late client and unmount responses cannot restore an old authorized definition', async t => {
  let resolveDetail; const { state, props, app } = mount(t, { publishedModels: async () => catalog(), publishedModel: () => new Promise(resolve => { resolveDetail = resolve; }) });
  await state.load(); const waiting = state.inspect('quality-model');
  props.client = { publishedModels: async () => catalog() }; await vue.nextTick(); resolveDetail(detail()); await waiting;
  assert.equal(state.definition.value, null); assert.equal(state.models.value.length, 0);
  let resolveCatalog; props.client = { publishedModels: () => new Promise(resolve => { resolveCatalog = resolve; }) }; await vue.nextTick();
  const pending = state.load(); app.unmount(); resolveCatalog(catalog()); await pending; assert.equal(state.models.value.length, 0);
});

test('bound schema creation requires separate consent and exact version; no repeated POST after an unknown outcome', async t => {
  const calls = []; let fail = false; const conversation = { id: 'conversation-a11ce000-0000-4000-8000-000000000001', modelBinding: { schemaVersion: 'agent-model-binding.v1', mode: 'published_schema_only', modelId: summary.modelId, version: summary.version, fingerprint: summary.fingerprint } };
  const { state, events } = mount(t, { publishedModels: async () => catalog(), publishedModel: async () => detail(), createModelConversation: async (...args) => {
    calls.push(args); if (fail) throw new Error('Unknown receipt'); return { contentScope: 'model_bound_schema_conversation', runtimeReadEnabled: false, conversation };
  } });
  await state.load(); await state.inspect(summary.modelId); await state.createConversation(); assert.equal(calls.length, 0);
  state.conversationConfirmed.value = true; await state.createConversation(); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [summary.modelId, { confirmed: true, expectedVersion: summary.version, expectedFingerprint: summary.fingerprint }]);
  assert.equal(events[0][0], 'conversation-created'); assert.equal(events[0][1].modelBinding.modelId, summary.modelId);
  fail = true; state.conversationConfirmed.value = true; await state.createConversation(); assert.equal(calls.length, 2); assert.equal(state.definition.value, null);
  assert.match(state.error.value, /可能已创建/u); await state.createConversation(); assert.equal(calls.length, 2);
});

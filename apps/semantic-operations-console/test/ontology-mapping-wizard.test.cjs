const test = require('node:test'); const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'); const { resolve } = require('node:path');
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc'); const Vue = require('vue');
const Wizard = require('../../../packages/agent-ui/src/meta-model/ontology-mapping-wizard.js');
const { parseReadPlanImport } = require('@healthcare-ai/agent-ui/ontology-read-plan');
const filename = resolve(__dirname, '../../../packages/agent-ui/src/meta-model/OntologyMappingWizard.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const compiled = compileScript(descriptor, { id: 'mapping-wizard-regression' });
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: 'mapping-wizard-regression', compilerOptions: { bindingMetadata: compiled.bindings } }).errors, []);
const executable = compiled.content.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_, names) => `const { ${names.replace(/\s+as\s+/gu, ': ')} } = Vue;`)
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/ontology-mapping-wizard\.js['"];?/u, (_, names) => `const { ${names} } = Wizard;`).replace('export default', 'return');
const Component = new Function('Vue', 'Wizard', executable)(Vue, Wizard);
const renderer = Vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode() {}, nextSibling() {}, patchProp() {}, insert() {}, remove() {} });
function fixture() {
  const relation = { from: 'Material', to: 'Stock', predicate: 'stored' };
  const plan = { id: 'stock', label: '查库存', datasets: [{ id: 'material', objectType: 'Material', where: [{ field: 'id', target: true }] }, { id: 'stock', objectType: 'Stock', where: [{ field: 'sku', dataset: 'material', sourceField: 'id' }] }], outputs: [{ id: 'qty', label: '库存', unit: '件', expression: { op: 'sum', dataset: 'stock', value: { op: 'field', dataset: 'stock', field: 'qty' } } }] };
  const draft = { objectTypes: [{ id: 'Material', fields: ['id'], key: 'id', sourceSystems: ['ERP'] }, { id: 'Stock', fields: ['id', 'sku', 'qty'], key: 'id', sourceSystems: ['WMS'] }, { id: 'Crosswalk', fields: ['id', 'erp', 'wms', 'state', 'version', 'start', 'end'], key: 'id', sourceSystems: ['MDM'], fieldDefinitions: [{ name: 'erp', reference: 'Material', referenceField: 'id' }, { name: 'wms', reference: 'Stock', referenceField: 'sku' }] }], relationshipTypes: [relation], scenario: { objective: '模拟库存', questions: [], readPlans: [plan], decisionBindings: [], requireCaseReplay: true }, accessPolicies: [{ objectType: 'Material', roles: ['reader'], effect: 'allow' }] };
  const selection = { relationKey: JSON.stringify(['Material', 'stored', 'Stock']), joinKey: JSON.stringify(['stock', 'stock']), objectType: 'Crosswalk', fromField: 'erp', toField: 'wms', statusField: 'state', versionField: 'version', validFromField: 'start', validToField: 'end', owner: '维护岗', version: 'map-v1', asOf: '2026-10-09T00:00:00Z' };
  return { draft, selection };
}
function mount(t) {
  let state; const events = []; const props = Vue.reactive({ draft: fixture().draft, canEdit: true });
  const app = renderer.createApp({ setup() { state = Component.setup(props, { expose() {}, emit: (...args) => events.push(args) }); return () => null; } }); app.mount({}); t.after(() => app.unmount());
  return { state, events, props };
}
async function fill(ui) {
  const { selection } = fixture(); ui.state.form.value.relationKey = selection.relationKey; await Vue.nextTick();
  ui.state.form.value.joinKey = selection.joinKey; await Vue.nextTick();
  ui.state.form.value.objectType = selection.objectType; await Vue.nextTick(); Object.assign(ui.state.form.value, selection); await Vue.nextTick();
}
test('wizard candidate retains importable plan shape without changing source model, formulas or permissions', () => {
  const { draft, selection } = fixture(); const before = JSON.stringify(draft); const candidate = Wizard.proposeOntologyMapping(draft, selection);
  assert.deepEqual(parseReadPlanImport(candidate.draft), candidate.draft.scenario.readPlans); assert.equal(JSON.stringify(draft), before);
  assert.deepEqual(candidate.draft.accessPolicies, draft.accessPolicies);
  assert.deepEqual(candidate.draft.scenario.readPlans[0].outputs, draft.scenario.readPlans[0].outputs);
  assert.equal(candidate.draft.relationshipTypes[0].keyMapping.lookupSource, 'Crosswalk');
  assert.match(candidate.summary, /Material.id.*Crosswalk.*Stock.sku/);
});
test('wizard refuses reversed joins, ambiguous source tables, repeated fields and undeclared references', () => {
  for (const mutate of [f => { f.draft.relationshipTypes[0].from = 'Stock'; }, f => { f.draft.objectTypes[2].sourceSystems.push('ERP'); }, f => { f.selection.statusField = 'erp'; }, f => { f.draft.objectTypes[2].fieldDefinitions = []; }, f => { f.selection.asOf = '2026-02-30T00:00:00Z'; }, f => { f.draft.scenario.decisionBindings.push({ id: 'old' }); }]) {
    const f = fixture(); mutate(f); assert.throws(() => Wizard.proposeOntologyMapping(f.draft, f.selection));
  }
});
test('no interaction causes writes; apply emits one candidate and revoked roles cannot apply', async t => {
  const ui = mount(t); assert.equal(ui.events.length, 0); await fill(ui); assert.equal(ui.state.preview.value.error, '');
  assert.deepEqual(ui.state.candidateCrosswalks.value.map(item => item.id), ['Crosswalk']);
  ui.state.apply(); assert.equal(ui.events.length, 1); assert.equal(ui.events[0][0], 'apply-draft');
  assert.equal(ui.events[0][1].baseShape, JSON.stringify(ui.props.draft)); assert.deepEqual(parseReadPlanImport(ui.events[0][1].draft), ui.events[0][1].draft.scenario.readPlans);
  ui.props.canEdit = false; await Vue.nextTick(); ui.state.apply(); assert.equal(ui.events.length, 1); assert.equal(ui.state.form.value.relationKey, '');
});
test('model revisions clear pending selection and multiple dependent steps are disclosed', async t => {
  const ui = mount(t); await fill(ui); ui.props.draft.objectTypes[0].label = '新名称'; await Vue.nextTick();
  assert.equal(ui.state.form.value.relationKey, ''); assert.equal(ui.events.length, 0);
  const { draft, selection } = fixture(); const other = structuredClone(draft.scenario.readPlans[0]); other.id = 'second'; draft.scenario.readPlans.push(other);
  const candidate = Wizard.proposeOntologyMapping(draft, selection); assert.equal(candidate.affectedSteps, 2);
  assert.equal(candidate.draft.scenario.readPlans[1].datasets[1].where[0].mapping, undefined);
});

test('plan import rejects malformed mappings instead of displaying them as executable bindings', () => {
  const { draft, selection } = fixture(); const candidate = Wizard.proposeOntologyMapping(draft, selection).draft;
  for (const mutate of [mapping => { mapping.objectType = 'https://example.com'; }, mapping => { mapping.asOf = '2026-02-30T00:00:00Z'; }, mapping => { mapping.script = 'arbitrary'; }, mapping => { delete mapping.statusField; }]) {
    const changed = structuredClone(candidate); mutate(changed.scenario.readPlans[0].datasets[1].where[0].mapping); assert.throws(() => parseReadPlanImport(changed));
  }
});

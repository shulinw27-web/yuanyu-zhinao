const test = require('node:test'); const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'); const { resolve } = require('node:path');
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc'); const Vue = require('vue');
const History = require('../../../packages/agent-ui/src/meta-model/ontology-edit-session.js');
const filename = resolve(__dirname, '../../../packages/agent-ui/src/meta-model/OAMetaModelStudio.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const compiled = compileScript(descriptor, { id: 'studio-regression' });
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: 'studio-regression', compilerOptions: { bindingMetadata: compiled.bindings } }).errors, []);
const executable = compiled.content.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_, names) => `const { ${names.replace(/\s+as\s+/gu, ': ')} } = Vue;`)
  .replace(/import (\w+) from ['"][^'"]+\.vue['"];?/gu, (_, name) => `const ${name} = {};`)
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/ontology-edit-session\.js['"];?/u, (_, names) => `const { ${names} } = History;`).replace('export default', 'return');
const Component = new Function('Vue', 'History', executable)(Vue, History);
const renderer = Vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode() {}, nextSibling() {}, patchProp() {}, insert() {}, remove() {} });
const definition = label => ({ fingerprint: label, objectTypes: [{ id: 'Order', label, key: 'id', fields: ['id'], source: 'erp.orders', sourceSystems: ['ERP'], coreObject: 'Order' }], relationshipTypes: [] });
function mount(t) { let state; const events = []; const props = Vue.reactive({ draft: definition('初始'), role: 'admin', authoringProfile: { canModel: true }, buttonPermissionIds: ['meta_model.draft.save'] }); const app = renderer.createApp({ setup() { state = Component.setup(props, { expose() {}, emit: (...args) => events.push(args) }); return () => null; } }); app.mount({}); t.after(() => app.unmount()); return { state, props, events }; }
test('local model edits undo and redo without writes; returning to saved state clears dirty flag', t => {
  const ui = mount(t); ui.state.localDraft.value.objectTypes[0].label = '修改';
  assert.equal(ui.state.hasUnsavedChanges.value, true); ui.state.restoreEdit('undo');
  assert.equal(ui.state.selectedObject.value.label, '初始'); assert.equal(ui.state.hasUnsavedChanges.value, false);
  ui.state.restoreEdit('redo'); assert.equal(ui.state.selectedObject.value.label, '修改'); assert.equal(ui.events.length, 0);
});
test('Agent handoff refuses unsaved model explanations instead of discarding edits or using an old revision', t => {
  const ui = mount(t); ui.state.localDraft.value.objectTypes[0].label = '未保存'; ui.state.askFromWorkspace('解释关系'); assert.equal(ui.events.length, 0); assert.match(ui.state.workspaceNotice.value, /旧修订/);
  ui.state.restoreEdit('undo'); ui.state.askFromWorkspace('解释关系'); assert.deepEqual(ui.events[0], ['ask', '解释关系']);
});
test('role change and new server draft reset history; revoked author cannot restore old contents', async t => {
  const ui = mount(t); ui.state.localDraft.value.objectTypes[0].label = '旧草稿'; ui.props.role = 'reader'; ui.props.authoringProfile = { canModel: false }; await Vue.nextTick();
  assert.equal(ui.state.localDraft.value.objectTypes[0].label, '初始'); assert.equal(ui.state.historyCounts.value.undo, 0);
  ui.state.restoreEdit('undo'); assert.equal(ui.state.localDraft.value.objectTypes[0].label, '初始');
  ui.state.saveDraft(); assert.equal(ui.events.length, 0);
  ui.props.draft = definition('新版'); await Vue.nextTick(); assert.equal(ui.state.localDraft.value.objectTypes[0].label, '新版');
});
test('relationship property editing uses the same draft history and never emits adoption or publication', t => {
  const ui = mount(t); const relation = { from: 'Order', predicate: 'splits', to: 'Order', cardinality: '1:1' };
  ui.state.localDraft.value.relationshipTypes.push(relation); ui.state.editRelation(relation);
  ui.state.selectedRelation.value.cardinality = '1:n'; assert.equal(ui.state.localDraft.value.relationshipTypes[0].cardinality, '1:n');
  ui.state.restoreEdit('undo'); assert.equal(ui.state.selectedRelation.value.cardinality, '1:1'); assert.equal(ui.events.length, 0);
});
test('issue location opens only corresponding editor and never guesses targets of server validation', t => {
  const ui = mount(t); ui.state.jumpToIssue({ kind: 'object', targetId: 'Order' }); assert.equal(ui.state.advancedOpen.value, true); assert.equal(ui.state.selectedId.value, 'Order');
  ui.state.jumpToIssue({ kind: 'relation', from: 'Order', to: 'Missing', detail: '引用缺失' }); assert.equal(ui.state.reviewMode.value, 'relations'); assert.equal(ui.state.relationTo.value, 'Missing');
  ui.state.jumpToIssue({ kind: 'validation' }); assert.match(ui.state.workspaceNotice.value, /未提供精确目标/); assert.equal(ui.events.length, 0);
});

test('server issue targets navigate only current objects and are discarded after an unsaved edit', async t => {
  const ui = mount(t); const draft = definition(); draft.validation = { status: 'failed', checks: [{ status: 'failed', name: '来源', detail: '来源待核对', targets: [{ kind: 'object', targetId: 'Order', field: 'sourceSystems' }] }] }; ui.props.draft = draft; await Vue.nextTick();
  const issue = ui.state.reviewIssues.value.find(item => item.id.startsWith('validation-')); assert.equal(issue.targetId, 'Order'); ui.state.jumpToIssue(issue); assert.equal(ui.state.selectedId.value, 'Order');
  ui.state.localDraft.value.objectTypes[0].label = '未保存'; assert.ok(!ui.state.reviewIssues.value.some(item => item.id.startsWith('validation-')));
});

test('mapping handoff is atomic, undoable and rejects stale drafts or read-only roles', t => {
  const ui = mount(t); const base = JSON.stringify(ui.state.localDraft.value); const candidate = JSON.parse(base);
  candidate.scenario.readPlans = [{ id: 'mapping-test' }];
  ui.state.applyMappingDraft({ baseShape: 'stale', draft: candidate }); assert.equal(JSON.stringify(ui.state.localDraft.value), base);
  ui.state.applyMappingDraft({ baseShape: base, draft: candidate }); assert.equal(ui.state.hasUnsavedChanges.value, true);
  assert.equal(ui.events.length, 0); ui.state.restoreEdit('undo'); assert.equal(JSON.stringify(ui.state.localDraft.value), base);
  ui.props.buttonPermissionIds = []; ui.state.applyMappingDraft({ baseShape: base, draft: candidate }); assert.equal(JSON.stringify(ui.state.localDraft.value), base);
});

test('server section issues edit one atomic local item, allow undo and reject stale or forbidden targets', async t => {
  const ui = mount(t); const draft = definition('治理'); draft.metrics = [{ id: 'm', label: '旧指标' }];
  draft.validation = { checks: [{ status: 'failed', name: '指标口径', targets: [{ kind: 'section', section: 'metrics', index: 0, field: 'definition' }, { kind: 'section', section: '__proto__', index: 0 }] }] };
  ui.props.draft = draft; await Vue.nextTick(); const issue = ui.state.reviewIssues.value.find(item => item.kind === 'section');
  ui.state.jumpToIssue(issue); ui.state.diagnosticText.value = JSON.stringify({ id: 'm', label: '新指标' }); ui.state.applyDiagnosticEdit();
  assert.equal(ui.state.localDraft.value.metrics[0].label, '新指标'); assert.equal(ui.events.length, 0);
  ui.state.restoreEdit('undo'); assert.equal(ui.state.localDraft.value.metrics[0].label, '旧指标');
  ui.state.jumpToIssue(issue); ui.state.localDraft.value.objectTypes[0].label = '另一个修改'; ui.state.applyDiagnosticEdit();
  assert.match(ui.state.workspaceNotice.value, /变更/); assert.equal(ui.state.localDraft.value.metrics[0].label, '旧指标');
});

test('empty collection diagnostics accept only a local object array and remain undoable', async t => {
  const ui = mount(t); const draft = definition('空集合'); draft.metrics = [];
  draft.validation = { checks: [{ status: 'failed', name: '指标口径', targets: [{ kind: 'section', section: 'metrics', index: -1, field: 'definition' }] }] };
  ui.props.draft = draft; await Vue.nextTick(); const issue = ui.state.reviewIssues.value.find(item => item.kind === 'section');
  assert.ok(issue); ui.state.jumpToIssue(issue); ui.state.diagnosticText.value = '[1]'; ui.state.applyDiagnosticEdit();
  assert.deepEqual(ui.state.localDraft.value.metrics, []);
  ui.state.diagnosticText.value = JSON.stringify([{ id: 'm', label: '指标' }]); ui.state.applyDiagnosticEdit();
  assert.equal(ui.state.localDraft.value.metrics[0].id, 'm'); assert.equal(ui.events.length, 0);
  ui.state.restoreEdit('undo'); assert.deepEqual(ui.state.localDraft.value.metrics, []);
});

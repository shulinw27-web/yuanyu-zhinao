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

test('team UI requires review permission, explicit sharing and owner-only retraction', async t => {
  const calls = []; const personal = { id: 'personal', revision: 3, label: '采购', current: true }; const shared = { id: 'team', revision: 1, label: '团队', current: true, owned: false };
  const ui = mount(t, { modelViews: async () => ({ views: [personal] }), teamModelViews: async () => { calls.push('list'); return { views: [shared] }; }, shareModelView: async (id, body) => { calls.push({ action: 'share', id, body }); }, retractTeamModelView: async (id, revision) => { calls.push({ action: 'retract', id, revision }); }, teamModelView: async () => ({ view: shared }) });
  await ui.state.refresh(); assert.equal(calls.length, 0);
  ui.props.canReview = true; await vue.nextTick(); await ui.state.refresh(); ui.state.selected.value = personal.id;
  await ui.state.teamAction('share'); assert.deepEqual(calls.find(call => call.action === 'share'), { action: 'share', id: personal.id, body: { expectedRevision: 3, modelFingerprint: 'a'.repeat(24) } });
  ui.state.teamSelected.value = shared.id; await ui.state.teamAction('retract'); assert.ok(!calls.some(call => call.action === 'retract'));
  await ui.state.teamAction('restore'); assert.equal(ui.events.at(-1)[0], 'restore');
  shared.owned = true; shared.current = false; ui.state.teamViews.value = [shared]; await ui.state.teamAction('retract'); assert.deepEqual(calls.find(call => call.action === 'retract'), { action: 'retract', id: shared.id, revision: 1 });
});

test('review revocation discards an in-flight team layout and clears team metadata', async t => {
  let finish; const ui = mount(t, { modelViews: async () => ({ views: [] }), teamModelViews: async () => ({ views: [{ id: 'team', revision: 1, current: true }] }), teamModelView: () => new Promise(resolve => { finish = resolve; }) });
  ui.props.canReview = true; await vue.nextTick(); await ui.state.refresh(); ui.state.teamSelected.value = 'team';
  const restoring = ui.state.teamAction('restore'); ui.props.canReview = false; await vue.nextTick(); finish({ view: { id: 'team', layout: {} } }); await restoring;
  assert.deepEqual(ui.events, []); assert.deepEqual(ui.state.teamViews.value, []);
});

test('history archive is explicit, owner-only and retains history; paging uses server limits', async t => {
  const calls = []; const row = { id: 'old', revision: 2, label: '旧图', revoked: true, owned: false, archivedAt: null };
  const ui = mount(t, { modelViews: async () => ({ views: [] }), teamModelViews: async () => ({ views: [] }), teamModelHistory: async (offset, limit) => { calls.push({ offset, limit }); return { views: [row], total: 41 }; }, archiveTeamModelView: async (id, revision) => { calls.push({ archive: id, revision }); row.archivedAt = '2026-10-10T00:00:00Z'; row.revision++; } });
  ui.props.canReview = true; await vue.nextTick(); await ui.state.refresh();
  ui.state.historySelected.value = row.id; await ui.state.archiveHistory(); assert.ok(!calls.some(call => call.archive));
  row.owned = true; await ui.state.archiveHistory(); assert.deepEqual(calls.find(call => call.archive), { archive: 'old', revision: 2 });
  assert.equal(ui.state.historyViews.value.length, 1); assert.ok(ui.state.historyViews.value[0].archivedAt);
  ui.state.historySelected.value = row.id; await ui.state.archiveHistory(); assert.equal(calls.filter(call => call.archive).length, 1);
  await ui.state.historyPage(20); assert.deepEqual(calls.at(-1), { offset: 20, limit: 20 });
  ui.props.canReview = false; await vue.nextTick(); assert.deepEqual(ui.state.historyViews.value, []);
});

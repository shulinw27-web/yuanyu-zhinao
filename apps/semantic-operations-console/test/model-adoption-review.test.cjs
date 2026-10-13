const test = require('node:test'); const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'); const { resolve } = require('node:path');
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc'); const vue = require('vue');
const filename = resolve(__dirname, '../src/components/ModelAdoptionReviewPanel.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const source = compileScript(descriptor, { id: 'model-adoption-test' }).content.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_, names) => `const { ${names} } = Vue;`).replace('export default', 'return');
const Component = new Function('Vue', source)(vue);
const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode() {}, nextSibling() {}, patchProp() {}, insert() {}, remove() {} });
function mount(t, client, permissions = {}) {
  let state; const props = vue.reactive({ client, modelId: 'quality', taskId: 'preview-1', canReview: true, canSimulate: false, ...permissions });
  const emitted = []; const app = renderer.createApp({ setup() { state = Component.setup(props, { expose() {}, emit: (...args) => emitted.push(args) }); return () => null; } }); app.mount({}); t.after(() => app.unmount()); return { state, props, emitted };
}
const fp = 'a'.repeat(24); const confirmedFp = 'b'.repeat(24);
const review = () => ({ modelId: 'quality', taskId: 'preview-1', taskFingerprint: fp, draftFingerprint: fp, proposalId: 'proposal-1', proposalRevision: 1, adoptionMode: 'merge',
  graph: { nodes: [{ id: 'InventoryLot', label: '库存批次', key: 'id', sourceSystems: ['WMS'], fields: [{ name: 'id', type: 'string' }], kind: 'candidate' }], edges: [] },
  diff: { objectChanges: [{ id: 'InventoryLot', change: 'added' }], relationshipChanges: [] }, checks: { criticStatus: 'passed', mappingStatus: 'passed', mappingBlocked: false }, contentScope: 'owned_candidate_structure_only', executionEnabled: false, runtimeReadEnabled: false });
const confirm = () => ({ modelId: 'quality', task: { id: 'preview-1', modelId: 'quality', structuredAdoptionTask: true }, taskFingerprint: confirmedFp, confirmationEvidenceState: 'ready', executionEnabled: false, confirmationToken: 'x'.repeat(43), expiresAt: new Date(Date.now() + 600000).toISOString() });

test('review, confirmation, adoption and synthetic simulation require separate consent without automatic IO', async t => {
  const calls = []; let confirmed = false;
  const { state } = mount(t, {
    reviewAdoptionTask: async () => { calls.push('read'); return { ...review(), taskFingerprint: confirmed ? confirmedFp : fp }; },
    confirmAdoptionTask: async (model, task, body) => { calls.push('confirm'); assert.equal(body.expectedTaskFingerprint, fp); confirmed = true; return confirm(); },
    executeAdoptionTask: async (model, task, body) => { calls.push('adopt'); assert.equal(body.expectedTaskFingerprint, confirmedFp); return { modelId: model, task: { id: task, modelId: model, status: 'completed', structuredAdoptionTask: true }, executedCommand: 'apply_proposal', runtimeReadEnabled: false }; },
    modelDraft: async model => ({ modelId: model, draft: { fingerprint: 'c'.repeat(24) } }),
    simulateModelDraft: async (model, body) => { calls.push('simulate'); return { modelId: model, runtimeReadEnabled: false, simulation: { sourceFingerprint: body.expectedFingerprint, verifiesLiveSystems: false, status: 'passed', nodeCount: 1, relationshipCount: 0 } }; }
  }, { canSimulate: true });
  assert.equal(calls.length, 0); await state.action('confirm'); assert.equal(calls.length, 0);
  await state.action('review'); assert.equal(state.selected.value.id, 'InventoryLot');
  state.acknowledge.value = true; await state.action('confirm'); assert.ok(state.token.value); assert.equal(state.adopted.value, false);
  state.acknowledge.value = true; await state.action('confirm'); assert.equal(calls.filter(kind => kind === 'confirm').length, 1);
  await state.action('execute'); assert.equal(calls.includes('adopt'), false);
  state.executeAcknowledged.value = true; await state.action('execute'); assert.equal(state.adopted.value, true); assert.equal(state.token.value, null);
  await state.action('simulate'); assert.equal(calls.includes('simulate'), false); state.simulateAcknowledged.value = true; await state.action('simulate');
  assert.deepEqual(calls, ['read', 'confirm', 'read', 'adopt', 'simulate']); assert.equal(state.simulation.value.status, 'passed');
  assert.doesNotMatch(descriptor.template.content, /confirmationToken|token\.value|token\.fingerprint|v-html/u); assert.doesNotMatch(source, /localStorage|sessionStorage/u);
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: 'model-adoption-test' }).errors, []);
});

test('changed review version or expired token cannot dispatch adoption', async t => {
  let current = review(); let adopts = 0; const { state } = mount(t, { reviewAdoptionTask: async () => current, confirmAdoptionTask: async () => confirm(), executeAdoptionTask: async () => { adopts++; } });
  await state.action('review'); state.acknowledge.value = true; await state.action('confirm');
  current = { ...review(), taskFingerprint: confirmedFp, proposalRevision: 2 }; state.executeAcknowledged.value = true; await state.action('execute'); assert.equal(adopts, 0); assert.equal(state.review.value, null); assert.equal(state.token.value, null);
  current = review(); await state.action('review'); state.acknowledge.value = true; await state.action('confirm'); state.token.value.expiresAt = new Date(0).toISOString();
  state.executeAcknowledged.value = true; await state.action('execute'); assert.equal(adopts, 0);
});

test('blocked mapping prevents confirmation and pending evidence can be recovered without token reissue', async t => {
  let result = { ...review(), checks: { criticStatus: 'passed', mappingStatus: 'unverified', mappingBlocked: true } }; let confirms = 0; let recoveries = 0;
  const { state } = mount(t, { reviewAdoptionTask: async () => result, confirmAdoptionTask: async () => { confirms++; }, recoverAdoptionConfirmationEvidence: async (model, task) => { recoveries++; return { modelId: model, taskId: task, confirmationEvidenceState: 'ready', confirmationTokenReturned: false, executionEnabled: false }; } });
  await state.action('review'); state.acknowledge.value = true; await state.action('confirm'); assert.equal(confirms, 0);
  result = { ...review(), confirmationEvidenceState: 'pending' }; await state.action('review'); assert.equal(state.confirmationPending.value, true);
  await state.action('recover'); assert.equal(recoveries, 0); state.recoverAcknowledged.value = true; await state.action('recover'); assert.equal(recoveries, 1); assert.equal(state.token.value, null); assert.equal(state.review.value, null);
});

test('late reviews and tokens cannot survive task, identity or permission changes', async t => {
  let finish; const client = { reviewAdoptionTask: () => new Promise(resolve => { finish = resolve; }) };
  const { state, props } = mount(t, client); const pending = state.action('review'); props.taskId = 'another-task'; await vue.nextTick(); finish(review()); await pending;
  assert.equal(state.review.value, null); assert.equal(state.busy.value, false);
  props.taskId = 'preview-1'; props.client = { reviewAdoptionTask: async () => review(), confirmAdoptionTask: () => new Promise(resolve => { finish = resolve; }) }; await vue.nextTick();
  await state.action('review'); state.acknowledge.value = true; const confirmation = state.action('confirm'); props.canReview = false; await vue.nextTick(); finish(confirm()); await confirmation;
  assert.equal(state.token.value, null); assert.equal(state.review.value, null); assert.equal(state.acknowledge.value, false);
});

test('unknown adoption result clears ticket and is not automatically retried', async t => {
  let confirmed = false; let sends = 0;
  const { state } = mount(t, { reviewAdoptionTask: async () => ({ ...review(), taskFingerprint: confirmed ? confirmedFp : fp }), confirmAdoptionTask: async () => { confirmed = true; return confirm(); },
    executeAdoptionTask: async () => { sends++; throw Object.assign(new Error('unknown'), { payload: { taskMayHaveCommitted: true, workspaceWriteMayHaveCommitted: true } }); } });
  await state.action('review'); state.acknowledge.value = true; await state.action('confirm'); state.executeAcknowledged.value = true; await state.action('execute');
  assert.equal(sends, 1); assert.match(state.error.value, /可能已提交/u); state.executeAcknowledged.value = true; await state.action('execute'); assert.equal(sends, 1); assert.equal(state.token.value, null);
});

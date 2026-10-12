const test = require('node:test'); const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'); const { resolve } = require('node:path');
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc'); const vue = require('vue');
const filename = resolve(__dirname, '../src/components/SemanticModelTaskBrowser.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const source = compileScript(descriptor, { id: 'model-browser-test' }).content
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_, names) => `const { ${names} } = Vue;`).replace('export default', 'return');
const Component = new Function('Vue', source)(vue);
const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode() {}, nextSibling() {}, patchProp() {}, insert() {}, remove() {} });
function mount(t, client, permissions = {}) {
  let state; const props = vue.reactive({ client, canValidate: false, canConfirm: false, ...permissions });
  const app = renderer.createApp({ setup() { state = Component.setup(props, { expose() {} }); return () => null; } }); app.mount({}); t.after(() => app.unmount());
  return { state, props, app };
}
const registry = () => ({ models: [{ id: 'quality', label: '质量' }, { id: 'stock', label: '库存' }] });
const page = (modelId, ids) => ({ modelId, contentScope: 'task_metadata_only', tasks: ids.map(id => ({ id, modelId })) });
const dialogue = (modelId, id) => ({ modelId, contentScope: 'owner_dialogue_only', executionEnabled: false, runtimeReadEnabled: false, task: { id, modelId, messages: [{ role: 'assistant', content: '合成只读答复' }] } });

test('source UI separates inspection and explicit binding, clears stale scope and never retries an uncertain write', async t => {
  const calls = []; const summary = modelId => ({ modelId, revision: 0, sourceFingerprint: 'a'.repeat(64), systemCodes: ['WMS'], documentCount: 2, runtimeReadEnabled: false });
  const client = { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, []),
    inspectModelSources: async (id, body) => { calls.push({ kind: 'inspect', id, body }); return summary(id); },
    bindModelSources: async (id, body) => { calls.push({ kind: 'bind', id, body: JSON.parse(JSON.stringify(body)) }); return { ...summary(id), revision: 1 }; } };
  const { state } = mount(t, client, { canBuild: true }); await vue.nextTick(); await state.selectModel('quality');
  state.sourceCodesText.value = 'WMS'; await vue.nextTick(); await state.sourceAction(true); assert.equal(calls.length, 0);
  await state.sourceAction(false); assert.equal(calls.length, 1); assert.equal(state.sourceInspection.value.documentCount, 2);
  await state.sourceAction(true); assert.equal(calls.length, 1);
  state.sourceAcknowledged.value = true; await state.sourceAction(true); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { confirmed: true, systemCodes: ['WMS'], expectedRevision: 0, expectedSourceFingerprint: 'a'.repeat(64) });
  assert.equal(state.sourceInspection.value, null); assert.equal(state.sourceAcknowledged.value, false);
  await state.sourceAction(false); state.sourceAcknowledged.value = true;
  state.sourceCodesText.value = 'ERP'; await vue.nextTick(); assert.equal(state.sourceInspection.value, null); await state.sourceAction(true); assert.equal(calls.length, 3);
  state.sourceCodesText.value = 'WMS'; await vue.nextTick(); await state.sourceAction(false); state.sourceAcknowledged.value = true;
  client.bindModelSources = async () => { calls.push({ kind: 'lost' }); throw Object.assign(new Error('lost'), { payload: { bindingMayHaveCommitted: true } }); };
  await state.sourceAction(true); assert.equal(calls.length, 5); assert.match(state.error.value, /可能已提交/u); assert.equal(state.sourceInspection.value, null);
});

test('late source inspections and lost build permission cannot retain binding consent', async t => {
  let finish; const { state, props } = mount(t, { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, []), inspectModelSources: () => new Promise(resolve => { finish = resolve; }) }, { canBuild: true });
  await vue.nextTick(); await state.selectModel('quality'); state.sourceCodesText.value = 'WMS'; await vue.nextTick();
  const pending = state.sourceAction(false); await state.selectModel('stock');
  finish({ modelId: 'quality', revision: 0, sourceFingerprint: 'a'.repeat(64), systemCodes: ['WMS'], documentCount: 1, runtimeReadEnabled: false }); await pending;
  assert.equal(state.sourceInspection.value, null); assert.equal(state.sourceCodesText.value, '');
  props.canBuild = false; await vue.nextTick(); assert.equal(state.modelId.value, ''); assert.equal(state.sourceAcknowledged.value, false);
});

test('model browser is read-only, uses explicit selectors and deduplicates pages without stalling cursor', async t => {
  const calls = []; const client = { modelWorkspaces: async () => registry(), modelTasks: async (id, filters) => { calls.push({ id, filters }); return page(id, filters.offset ? ['task-0', 'last'] : Array.from({ length: 20 }, (_, i) => `task-${i}`)); }, modelTaskDialogue: async (modelId, id) => dialogue(modelId, id) };
  const { state } = mount(t, client); await vue.nextTick();
  assert.equal(calls.length, 0); assert.equal(state.modelId.value, '');
  await state.selectModel('quality'); await state.loadPage();
  assert.equal(state.tasks.value.length, 21); assert.equal(state.nextOffset.value, 22); assert.equal(state.hasMore.value, false);
  assert.deepEqual(calls.map(call => call.id), ['quality', 'quality']); assert.equal(calls[1].filters.offset, 20);
  await state.openTask(state.tasks.value[0]); assert.equal(state.dialogue.value.modelId, 'quality');
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: 'model-browser-test' }).errors, []);
  assert.doesNotMatch(descriptor.template.content, /v-html|confirmationToken/u);
});

test('model switch discards late list and conversation; failed references clear old dialogue', async t => {
  let finishPage; let finishDialogue;
  const client = { modelWorkspaces: async () => registry(), modelTasks: (id) => id === 'quality' ? new Promise(resolve => { finishPage = resolve; }) : Promise.resolve(page(id, ['stock-task'])), modelTaskDialogue: () => new Promise(resolve => { finishDialogue = resolve; }) };
  const { state } = mount(t, client); await vue.nextTick();
  const slow = state.selectModel('quality'); await state.selectModel('stock'); finishPage(page('quality', ['foreign-task'])); await slow;
  assert.equal(state.tasks.value[0].id, 'stock-task');
  const read = state.openTask(state.tasks.value[0]); const switched = state.selectModel('quality'); finishDialogue(dialogue('stock', 'stock-task')); await read;
  assert.equal(state.dialogue.value, null); finishPage(page('quality', ['quality-task'])); await switched;
  client.modelTaskDialogue = async () => { throw new Error('revoked'); }; await state.openTask(state.tasks.value[0]);
  assert.equal(state.dialogue.value, null); assert.equal(state.tasks.value.length, 0); assert.match(state.error.value, /无法读取对话/u);
});

test('foreign responses and identity client changes cannot retain prior contents', async t => {
  const { state, props } = mount(t, { modelWorkspaces: async () => registry(), modelTasks: async () => page('foreign', ['wrong']), modelTaskDialogue: async () => dialogue('foreign', 'wrong') });
  await vue.nextTick(); await state.selectModel('quality'); assert.equal(state.tasks.value.length, 0); assert.match(state.error.value, /读取失败/u);
  props.client = { modelWorkspaces: async () => ({ models: [] }) }; await vue.nextTick();
  assert.equal(state.modelId.value, ''); assert.equal(state.dialogue.value, null); assert.equal(state.tasks.value.length, 0);
});

test('local UI requires three separate acknowledgements and never persists or renders the one-use token', async t => {
  const calls = []; const fp = 'a'.repeat(24); const token = 'x'.repeat(43);
  const task = { id: 'local-1', modelId: 'quality', localValidationTask: true, evidenceState: 'ready', status: 'waiting_confirmation', confirmationEvidenceState: 'not_required_or_legacy' };
  const client = { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, []), modelDraft: async id => ({ modelId: id, draft: { fingerprint: fp } }),
    createLocalValidationTask: async (id, body) => { calls.push(['create', id, body]); return { modelId: id, task, evidenceState: 'ready' }; },
    modelTaskDialogue: async () => ({ ...dialogue('quality', 'local-1'), taskFingerprint: fp, task: { ...task, messages: [] } }),
    confirmLocalValidationTask: async (id, taskId, body) => { calls.push(['confirm', id, taskId, body]); return { modelId: id, task: { ...task, confirmationEvidenceState: 'ready' }, taskFingerprint: 'b'.repeat(24), confirmationEvidenceState: 'ready', confirmationToken: token, expiresAt: new Date(Date.now() + 600000).toISOString() }; },
    executeLocalValidationTask: async (id, taskId, body) => { calls.push(['execute', id, taskId, body]); return { modelId: id, task: { ...task, status: 'completed' }, executedCommand: 'validate_model', validation: { status: 'passed' } }; }
  };
  const { state } = mount(t, client, { canValidate: true, canConfirm: true }); await vue.nextTick();
  await state.selectModel('quality'); await state.localAction('create'); assert.equal(calls.length, 0);
  state.createAcknowledged.value = true; await state.localAction('create'); assert.equal(calls.length, 1); assert.equal(state.localToken.value, null);
  await state.localAction('confirm'); assert.equal(calls.length, 1);
  state.confirmAcknowledged.value = true; await state.localAction('confirm'); assert.equal(calls.length, 2); assert.equal(state.localToken.value.value, token);
  await state.localAction('execute'); assert.equal(calls.length, 2);
  state.executeAcknowledged.value = true; await state.localAction('execute'); assert.equal(calls.length, 3); assert.equal(state.localToken.value, null);
  assert.equal(calls[2][3].expectedTaskFingerprint, 'b'.repeat(24)); assert.equal(calls[2][3].confirmationToken, token);
  assert.equal(state.dialogue.value.status, 'completed'); assert.equal(state.actionBusy.value, false);
  assert.doesNotMatch(source, /localStorage|sessionStorage/u);
});

test('unknown create outcome is never retried automatically, and explicit recovery preserves original request ID', async t => {
  const requests = []; const client = { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, []), modelDraft: async id => ({ modelId: id, draft: { fingerprint: 'a'.repeat(24) } }),
    createLocalValidationTask: async (id, body) => { requests.push(JSON.parse(JSON.stringify(body))); const error = new Error('uncertain'); error.payload = { taskMayHaveCommitted: true }; throw error; }
  };
  const { state, props } = mount(t, client, { canValidate: true }); await vue.nextTick(); await state.selectModel('quality');
  state.createAcknowledged.value = true; await state.localAction('create'); assert.equal(requests.length, 1, JSON.stringify({ model: state.modelId.value, loading: state.loading.value, error: state.error.value })); assert.match(state.error.value, /可能已提交/u);
  await vue.nextTick(); assert.equal(requests.length, 1);
  state.createAcknowledged.value = true; await state.localAction('create'); assert.equal(requests.length, 2); assert.equal(requests[0].requestId, requests[1].requestId);
  props.canValidate = false; await vue.nextTick(); assert.equal(state.creationAttempt.value, null); assert.equal(state.localToken.value, null);
});

test('permission or task changes clear tokens and discard a late confirmation response', async t => {
  let finish;
  const task = { ...dialogue('quality', 'local-1'), taskFingerprint: 'a'.repeat(24), task: { id: 'local-1', modelId: 'quality', localValidationTask: true, evidenceState: 'ready', status: 'waiting_confirmation', messages: [] } };
  const { state, props } = mount(t, { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, ['local-1']), modelTaskDialogue: async () => task,
    confirmLocalValidationTask: () => new Promise(resolve => { finish = resolve; }) }, { canValidate: true, canConfirm: true });
  await vue.nextTick(); await state.selectModel('quality'); await state.openTask({ id: 'local-1' });
  state.confirmAcknowledged.value = true; const waiting = state.localAction('confirm'); props.canConfirm = false; await vue.nextTick();
  finish({ modelId: 'quality', task: task.task, taskFingerprint: 'b'.repeat(24), confirmationEvidenceState: 'ready', confirmationToken: 'x'.repeat(43), expiresAt: new Date(Date.now() + 600000).toISOString() }); await waiting;
  assert.equal(state.localToken.value, null); assert.equal(state.dialogue.value, null); assert.equal(state.actionBusy.value, false);
});

test('explicit evidence recovery never reissues a token and expired tokens cannot trigger execution', async t => {
  let recoveries = 0; let executions = 0;
  const task = { id: 'local-1', modelId: 'quality', localValidationTask: true, status: 'waiting_confirmation', evidenceState: 'ready', confirmationEvidenceState: 'pending', messages: [] };
  const { state } = mount(t, { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, ['local-1']),
    modelTaskDialogue: async () => ({ ...dialogue('quality', 'local-1'), taskFingerprint: 'a'.repeat(24), task }),
    recoverLocalConfirmationEvidence: async () => { recoveries++; return { modelId: 'quality', taskId: 'local-1', confirmationEvidenceState: 'ready', confirmationTokenReturned: false }; },
    executeLocalValidationTask: async () => { executions++; }
  }, { canValidate: true, canConfirm: true });
  await vue.nextTick(); await state.selectModel('quality'); await state.openTask(task);
  await state.localAction('recover'); assert.equal(recoveries, 0);
  state.recoverAcknowledged.value = true; await state.localAction('recover');
  assert.equal(recoveries, 1); assert.equal(state.localToken.value, null); assert.equal(state.taskFingerprint.value, '');
  state.localToken.value = { modelId: 'quality', taskId: 'local-1', fingerprint: 'a'.repeat(24), value: 'x'.repeat(43), expiresAt: new Date(Date.now() - 1000).toISOString() };
  state.executeAcknowledged.value = true; await state.localAction('execute');
  assert.equal(executions, 0); assert.equal(state.localToken.value, null);
});

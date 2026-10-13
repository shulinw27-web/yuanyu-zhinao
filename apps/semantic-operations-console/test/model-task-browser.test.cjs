const test = require('node:test'); const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'); const { resolve } = require('node:path');
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc'); const vue = require('vue');
const filename = resolve(__dirname, '../src/components/SemanticModelTaskBrowser.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const source = compileScript(descriptor, { id: 'model-browser-test' }).content
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_, names) => `const { ${names} } = Vue;`).replace(/import ModelAdoptionReviewPanel from ['"][^'"]+['"];?/u, 'const ModelAdoptionReviewPanel = {};').replace('export default', 'return');
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

const requestId = '12345678-1234-4234-8234-123456789012';
const requestStatus = (modelId, state = 'reserved') => ({ modelId, state, inputFingerprint: 'a'.repeat(64), preparationAllowed: false, automaticRetryAllowed: false, automaticTakeoverAllowed: false, executionEnabled: false,
  ...(state === 'reserved' ? { blocker: 'preparation_checkpoint_absent' } : { checkpointFingerprint: 'b'.repeat(64) }), ...(state === 'committed' ? { taskId: 'preview-1' } : {}) });

test('owned adoption completion updates the visible task only and late foreign events cannot revive state', async t => {
  const { state } = mount(t, { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, ['preview-1']), modelTaskDialogue: async () => ({ ...dialogue('quality', 'preview-1'), task: { ...dialogue('quality', 'preview-1').task, structuredAdoptionTask: true, status: 'waiting_confirmation' } }) }, { canReview: true });
  await vue.nextTick(); await state.selectModel('quality'); await state.openTask(state.tasks.value[0]);
  state.recordAdoption({ modelId: 'stock', task: { id: 'preview-1', modelId: 'stock', status: 'completed', structuredAdoptionTask: true } }); assert.equal(state.dialogue.value.status, 'waiting_confirmation');
  state.recordAdoption({ modelId: 'quality', task: { id: 'preview-1', modelId: 'quality', status: 'completed', structuredAdoptionTask: true } });
  assert.equal(state.dialogue.value.status, 'completed'); assert.equal(state.tasks.value[0].status, 'completed'); assert.equal(state.dialogue.value.messages[0].content, '合成只读答复');
  await state.selectModel('stock'); state.recordAdoption({ modelId: 'quality', task: { id: 'preview-1', modelId: 'quality', status: 'completed', structuredAdoptionTask: true } }); assert.equal(state.dialogue.value, null);
});

test('preview creation uses explicit consent, current draft and one UUID without adoption or execution', async t => {
  const calls = []; const client = { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, []), modelDraft: async id => ({ modelId: id, draft: { fingerprint: 'a'.repeat(24) } }),
    createStructuredPreview: async (id, body) => { calls.push(JSON.parse(JSON.stringify(body))); return { modelId: id, task: { modelId: id, id: 'preview-new', status: 'waiting_confirmation' }, creationMode: 'structured_preview', evidenceState: 'ready', executionEnabled: false, runtimeReadEnabled: false, taskFingerprint: 'b'.repeat(24) }; } };
  const { state } = mount(t, client, { canBuild: true }); await vue.nextTick(); await state.selectModel('quality');
  state.sourceCodesText.value = 'WMS'; state.previewText.value = '创建库存候选'; await vue.nextTick(); await state.createPreview(); assert.equal(calls.length, 0);
  state.previewAcknowledged.value = true; await state.createPreview(); assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedDraftFingerprint, 'a'.repeat(24)); assert.deepEqual(calls[0].systemCodes, ['WMS']); assert.match(calls[0].requestId, /^[a-f0-9-]{36}$/u);
  assert.equal(state.previewRequestId.value, calls[0].requestId); assert.equal(state.tasks.value[0].id, 'preview-new'); assert.equal(state.selectedId.value, ''); assert.equal(state.localToken.value, null);
  assert.equal(state.previewAttempt.value, null); assert.equal(state.previewAcknowledged.value, false);
});

test('prepared recovery separates probe, resume, commit receipt and evidence with fresh consent for every step', async t => {
  const calls = []; const fp = 'a'.repeat(24); const summary = (id, extra = {}) => ({ modelId: id, task: { modelId: id, id: 'preview-1' }, taskFingerprint: fp, evidenceState: 'pending', confirmationEnabled: false, executionEnabled: false, runtimeReadEnabled: false, ...extra });
  const { state } = mount(t, { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, []), modelDraft: async id => ({ modelId: id, draft: { fingerprint: fp } }), getPreviewRequestStatus: async id => requestStatus(id, 'prepared'),
    inspectPreparedPreview: async (id, uuid, body) => { calls.push(['probe', uuid, JSON.parse(JSON.stringify(body))]); return { modelId: id, taskId: 'preview-1', checkpointFingerprint: 'b'.repeat(64), referenceState: 'valid', contentReturned: false, executionEnabled: false }; },
    resumePreparedPreview: async (id, uuid, body) => { calls.push(['resume', uuid, JSON.parse(JSON.stringify(body))]); return summary(id, { resumedFromCheckpoint: true }); },
    recoverPreviewCommit: async (id, uuid) => { calls.push(['commit', uuid]); return summary(id, { recoveredCommit: true }); },
    recoverPreviewEvidence: async (id, taskId, body) => { calls.push(['evidence', taskId, body.expectedTaskFingerprint]); return { modelId: id, taskId, evidenceState: 'ready', executionEnabled: false, confirmationTokenReturned: false }; }
  }, { canBuild: true });
  await vue.nextTick(); await state.selectModel('quality'); state.previewRequestId.value = requestId; await vue.nextTick(); await state.inspectPreviewRequest();
  await state.recoverPreview('probe'); assert.equal(calls.length, 0);
  state.recoveryAcknowledged.value = true; await state.recoverPreview('resume'); assert.equal(calls.length, 0);
  await state.recoverPreview('probe'); assert.equal(calls.length, 1); assert.equal(state.recoveryAcknowledged.value, false);
  await state.recoverPreview('resume'); assert.equal(calls.length, 1);
  state.recoveryAcknowledged.value = true; await state.recoverPreview('resume'); assert.equal(calls.length, 2); assert.equal(state.previewReceipt.value.evidenceState, 'pending');
  assert.deepEqual(calls[0][2], calls[1][2]); assert.equal(state.preparedProof.value, null);
  state.recoveryAcknowledged.value = true; await state.recoverPreview('commit'); assert.equal(calls.length, 3);
  state.recoveryAcknowledged.value = true; await state.recoverPreview('evidence'); assert.equal(calls.length, 4); assert.equal(state.previewReceipt.value, null); assert.equal(state.localToken.value, null);
});

test('prepared recovery refuses changed draft, unknown outcome is not retried and late writes cannot restore state', async t => {
  let fp = 'a'.repeat(24); let sends = 0; let finish;
  const { state, props } = mount(t, { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, []), modelDraft: async id => ({ modelId: id, draft: { fingerprint: fp } }), getPreviewRequestStatus: async id => requestStatus(id, 'prepared'),
    inspectPreparedPreview: async id => ({ modelId: id, taskId: 'preview-1', checkpointFingerprint: 'b'.repeat(64), referenceState: 'valid', contentReturned: false, executionEnabled: false }),
    resumePreparedPreview: () => { sends++; return new Promise(resolve => { finish = resolve; }); }
  }, { canBuild: true });
  await vue.nextTick(); await state.selectModel('quality'); state.previewRequestId.value = requestId; await vue.nextTick(); await state.inspectPreviewRequest();
  state.recoveryAcknowledged.value = true; await state.recoverPreview('probe'); fp = 'c'.repeat(24);
  state.recoveryAcknowledged.value = true; await state.recoverPreview('resume'); assert.equal(sends, 0); assert.equal(state.preparedProof.value, null); assert.equal(state.previewRequestStatus.value, null);
  await state.inspectPreviewRequest(); state.recoveryAcknowledged.value = true; await state.recoverPreview('probe');
  state.recoveryAcknowledged.value = true; const pending = state.recoverPreview('resume'); await vue.nextTick();
  assert.equal(sends, 1); props.canBuild = false; await vue.nextTick(); finish({ modelId: 'quality', executionEnabled: false }); await pending;
  assert.equal(state.previewReceipt.value, null); assert.equal(state.modelId.value, ''); assert.equal(state.recoveryAcknowledged.value, false); assert.equal(state.actionBusy.value, false);
});

test('uncertain preview creation retains original request and refuses a second send', async t => {
  let sends = 0; const { state } = mount(t, { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, []), modelDraft: async id => ({ modelId: id, draft: { fingerprint: 'a'.repeat(24) } }),
    createStructuredPreview: async () => { sends++; throw new Error('response lost'); } }, { canBuild: true });
  await vue.nextTick(); await state.selectModel('quality'); state.sourceCodesText.value = 'WMS'; state.previewText.value = '库存候选'; await vue.nextTick();
  state.previewAcknowledged.value = true; await state.createPreview(); const original = state.previewAttempt.value.requestId;
  assert.equal(state.previewRequestId.value, original); assert.match(state.error.value, /不自动重发/u);
  state.previewAcknowledged.value = true; await state.createPreview(); assert.equal(sends, 1); assert.equal(state.previewAttempt.value.requestId, original);
  state.previewText.value = '另一个诉求'; await vue.nextTick(); assert.equal(state.previewAcknowledged.value, false); assert.equal(state.previewAttempt.value.requestId, original);
});

test('lost resume response clears recovery authority and requires an explicit original-request read', async t => {
  let resumes = 0; const { state } = mount(t, { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, []), modelDraft: async id => ({ modelId: id, draft: { fingerprint: 'a'.repeat(24) } }), getPreviewRequestStatus: async id => requestStatus(id, 'prepared'),
    inspectPreparedPreview: async id => ({ modelId: id, taskId: 'preview-1', checkpointFingerprint: 'b'.repeat(64), referenceState: 'valid', contentReturned: false, executionEnabled: false }),
    resumePreparedPreview: async () => { resumes++; throw new Error('response lost after commit'); }
  }, { canBuild: true });
  await vue.nextTick(); await state.selectModel('quality'); state.previewRequestId.value = requestId; await vue.nextTick(); await state.inspectPreviewRequest();
  state.recoveryAcknowledged.value = true; await state.recoverPreview('probe'); state.recoveryAcknowledged.value = true; await state.recoverPreview('resume');
  assert.equal(resumes, 1); assert.equal(state.statusBinding.value, null); assert.equal(state.previewReceipt.value, null); assert.equal(state.preparedProof.value, null); assert.equal(state.previewRequestId.value, requestId);
  assert.match(state.error.value, /可能已有任务/u); state.recoveryAcknowledged.value = true; await state.recoverPreview('resume'); assert.equal(resumes, 1);
});

test('preview preflight rejects invalid input and discards results after scope changes', async t => {
  let finish; let sends = 0; const { state } = mount(t, { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, []), modelDraft: () => new Promise(resolve => { finish = resolve; }), createStructuredPreview: async () => { sends++; } }, { canBuild: true });
  await vue.nextTick(); await state.selectModel('quality'); state.sourceCodesText.value = 'invalid'; state.previewText.value = '库存'; await vue.nextTick();
  state.previewAcknowledged.value = true; await state.createPreview(); assert.equal(sends, 0);
  state.sourceCodesText.value = 'WMS'; await vue.nextTick(); state.previewAcknowledged.value = true;
  const pending = state.createPreview(); await state.selectModel('stock'); finish({ modelId: 'quality', draft: { fingerprint: 'a'.repeat(24) } }); await pending;
  assert.equal(sends, 0); assert.equal(state.previewAttempt.value, null); assert.equal(state.actionBusy.value, false);
});

test('preview status UI makes only explicit scoped reads and does not expose snapshots or grants', async t => {
  const calls = []; let nextState = 'reserved';
  const { state } = mount(t, { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, []), getPreviewRequestStatus: async (model, id) => { calls.push([model, id]); return { ...requestStatus(model, nextState), preparedTask: { secret: 'not-displayable' } }; } }, { canBuild: true });
  await vue.nextTick(); await state.selectModel('quality'); assert.equal(calls.length, 0);
  state.previewRequestId.value = 'invalid'; await vue.nextTick(); await state.inspectPreviewRequest(); assert.equal(calls.length, 0);
  state.previewRequestId.value = requestId; await vue.nextTick(); await state.inspectPreviewRequest();
  assert.deepEqual(calls, [['quality', requestId]]); assert.deepEqual(state.previewRequestStatus.value, { state: 'reserved', taskId: null });
  nextState = 'prepared'; await state.inspectPreviewRequest(); assert.equal(state.previewRequestStatus.value.state, 'prepared');
  nextState = 'committed'; await state.inspectPreviewRequest(); assert.equal(state.previewRequestStatus.value.taskId, 'preview-1');
  assert.equal(state.selectedId.value, ''); assert.equal(state.localToken.value, null);
  assert.doesNotMatch(descriptor.template.content, /preparedTask|inputFingerprint|checkpointFingerprint/u);
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: 'model-browser-test' }).errors, []);
});

test('preview status rejects foreign or granting responses and clears failed summaries without retry', async t => {
  let response = requestStatus('quality'); let calls = 0;
  const client = { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, []), getPreviewRequestStatus: async () => { calls++; if (response instanceof Error) throw response; return response; } };
  const { state } = mount(t, client, { canBuild: true }); await vue.nextTick(); await state.selectModel('quality'); state.previewRequestId.value = requestId; await vue.nextTick();
  await state.inspectPreviewRequest(); assert.ok(state.previewRequestStatus.value);
  for (const malformed of [{ ...requestStatus('quality'), executionEnabled: true }, requestStatus('stock'), { ...requestStatus('quality', 'prepared'), checkpointFingerprint: '' }]) {
    response = malformed; await state.inspectPreviewRequest(); assert.equal(state.previewRequestStatus.value, null); assert.match(state.error.value, /无法核对/u);
  }
  response = Object.assign(new Error('missing'), { status: 404 }); await state.inspectPreviewRequest(); assert.match(state.error.value, /没有此请求/u); assert.equal(calls, 5);
});

test('late preview status is discarded on input, model, identity and permission changes', async t => {
  let finish; const client = { modelWorkspaces: async () => registry(), modelTasks: async id => page(id, []), getPreviewRequestStatus: () => new Promise(resolve => { finish = resolve; }) };
  const { state, props } = mount(t, client, { canBuild: true }); await vue.nextTick(); await state.selectModel('quality');
  for (const change of [async () => { state.previewRequestId.value = ''; await vue.nextTick(); }, () => state.selectModel('stock'), async () => { props.client = { ...client }; await vue.nextTick(); }, async () => { props.canBuild = false; await vue.nextTick(); }]) {
    if (!state.modelId.value) await state.selectModel('quality');
    state.previewRequestId.value = requestId; await vue.nextTick(); const pending = state.inspectPreviewRequest();
    await change(); finish(requestStatus('quality', 'committed')); await pending; assert.equal(state.previewRequestStatus.value, null); assert.equal(state.actionBusy.value, false);
  }
});

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

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import ModelAdoptionReviewPanel from './ModelAdoptionReviewPanel.vue';

const props = defineProps({ client: { type: Object, required: true }, canValidate: { type: Boolean, default: false }, canConfirm: { type: Boolean, default: false }, canBuild: { type: Boolean, default: false }, canReview: { type: Boolean, default: false }, canSimulate: { type: Boolean, default: false } });
const models = ref([]); const modelId = ref(''); const tasks = ref([]); const selectedId = ref(''); const dialogue = ref(null);
const loading = ref(false); const reading = ref(false); const hasMore = ref(false); const error = ref('');
const nextOffset = ref(0);
const taskFingerprint = ref(''); const actionBusy = ref(false); const notice = ref('');
const createAcknowledged = ref(false); const confirmAcknowledged = ref(false); const executeAcknowledged = ref(false); const recoverAcknowledged = ref(false);
const creationAttempt = ref(null); const localToken = ref(null);
const sourceCodesText = ref(''); const sourceInspection = ref(null); const sourceAcknowledged = ref(false);
const previewRequestId = ref(''); const previewRequestStatus = ref(null);
const previewText = ref(''); const previewAcknowledged = ref(false); const previewAttempt = ref(null);
const recoveryAcknowledged = ref(false); const preparedProof = ref(null); const previewReceipt = ref(null); const statusBinding = ref(null);
async function recoverPreview(kind) {
  if (!props.canBuild || !modelId.value || actionBusy.value || loading.value || reading.value || !recoveryAcknowledged.value || !['probe', 'resume', 'commit', 'evidence'].includes(kind)) return;
  const binding = statusBinding.value; const receipt = previewReceipt.value;
  if (kind === 'evidence') { if (!receipt || receipt.evidenceState !== 'pending' || receipt.task.modelId !== modelId.value) return; }
  else if (!binding || binding.modelId !== modelId.value || binding.requestId !== previewRequestId.value || !binding.checkpointFingerprint
    || previewRequestStatus.value?.state !== (kind === 'commit' ? 'committed' : 'prepared')) return;
  if (kind === 'resume' && !preparedProof.value) return;
  const request = generation; const statusRequest = statusGeneration; const selectedModel = modelId.value;
  const current = () => request === generation && statusRequest === statusGeneration && props.canBuild && modelId.value === selectedModel;
  actionBusy.value = true; recoveryAcknowledged.value = false; error.value = ''; notice.value = ''; localToken.value = null;
  try {
    let result;
    if (kind === 'evidence') {
      result = await props.client.recoverPreviewEvidence(selectedModel, receipt.task.id, { confirmed: true, expectedTaskFingerprint: receipt.taskFingerprint });
      if (!current()) return;
      if (result.modelId !== selectedModel || result.taskId !== receipt.task.id || result.evidenceState !== 'ready' || result.executionEnabled !== false || result.confirmationTokenReturned !== false) throw new Error('PREVIEW_RESPONSE_MISMATCH');
      previewReceipt.value = null; notice.value = '既有任务证据已核验就绪，没有签发或执行。请刷新任务列表后主动查看原任务。';
    } else {
      const draft = await props.client.modelDraft(selectedModel);
      if (!current()) return;
      if (draft.modelId !== selectedModel || !/^[a-f0-9]{24}$/u.test(draft.draft?.fingerprint || '')) throw new Error('MODEL_RESPONSE_MISMATCH');
      const body = { confirmed: true, inputFingerprint: binding.inputFingerprint, expectedCheckpointFingerprint: binding.checkpointFingerprint, expectedDraftFingerprint: draft.draft.fingerprint };
      if (kind === 'resume' && JSON.stringify(body) !== JSON.stringify(preparedProof.value.body)) throw new Error('PREPARED_PROOF_STALE');
      const method = kind === 'probe' ? 'inspectPreparedPreview' : kind === 'resume' ? 'resumePreparedPreview' : 'recoverPreviewCommit';
      result = await props.client[method](selectedModel, binding.requestId, body);
      if (!current()) return;
      if (result.modelId !== selectedModel || result.executionEnabled !== false) throw new Error('PREVIEW_RESPONSE_MISMATCH');
      if (kind === 'probe') {
        if (result.referenceState !== 'valid' || result.contentReturned !== false || result.checkpointFingerprint !== binding.checkpointFingerprint || typeof result.taskId !== 'string' || !result.taskId) throw new Error('PREVIEW_RESPONSE_MISMATCH');
        preparedProof.value = { body, taskId: result.taskId }; notice.value = '原准备快照引用检查通过，尚未续交；继续前需再次勾选确认。';
      } else {
        if (result.task?.modelId !== selectedModel || typeof result.task.id !== 'string' || !result.task.id || !/^[a-f0-9]{24}$/u.test(result.taskFingerprint || '')
          || result.confirmationEnabled !== false || result.runtimeReadEnabled !== false || !['pending', 'ready'].includes(result.evidenceState)
          || kind === 'resume' && (result.resumedFromCheckpoint !== true || result.task.id !== preparedProof.value.taskId || result.evidenceState !== 'pending')
          || kind === 'commit' && (result.recoveredCommit !== true || result.task.id !== previewRequestStatus.value.taskId)) throw new Error('PREVIEW_RESPONSE_MISMATCH');
        previewReceipt.value = { task: { id: result.task.id, modelId: selectedModel }, taskFingerprint: result.taskFingerprint, evidenceState: result.evidenceState };
        preparedProof.value = null; previewAttempt.value = null;
        previewRequestStatus.value = { state: 'committed', taskId: result.task.id };
        notice.value = `已核对原任务 ${result.task.id}，证据${result.evidenceState === 'pending' ? '待恢复' : '就绪'}；未重新抽取、签发或执行。`;
      }
    }
  } catch {
    if (current()) { preparedProof.value = null; previewReceipt.value = null; statusBinding.value = null; previewRequestStatus.value = null;
      error.value = '恢复未取得可验证结果，可能已有任务或证据写入。请只读核对原请求状态；不自动重发、签发或执行。'; }
  } finally { if (request === generation) actionBusy.value = false; }
}
async function createPreview() {
  if (!props.canBuild || !modelId.value || modelId.value === 'oa-governance' || actionBusy.value || loading.value || reading.value || !previewAcknowledged.value || previewAttempt.value) return;
  const codes = sourceCodesText.value.split(/[,，\s]+/u).filter(Boolean).sort(); const text = previewText.value;
  if (!text.trim() || text.length > 4000 || !codes.length || codes.length > 16 || new Set(codes).size !== codes.length || codes.some(code => !/^[A-Z][A-Z0-9_]{1,15}$/u.test(code))) {
    error.value = '请输入最多4000字的诉求和明确的已绑定来源码（例如WMS、ERP）。当前入口仅解析结构化Schema，不调用大模型。'; return;
  }
  const selectedModel = modelId.value; const request = generation; const stamp = sourceCodesText.value;
  const current = () => request === generation && props.canBuild && modelId.value === selectedModel && text === previewText.value && stamp === sourceCodesText.value;
  actionBusy.value = true; previewAcknowledged.value = false; error.value = ''; notice.value = ''; localToken.value = null;
  try {
    const draft = await props.client.modelDraft(selectedModel);
    if (!current()) return;
    if (draft.modelId !== selectedModel || !/^[a-f0-9]{24}$/u.test(draft.draft?.fingerprint || '')) throw new Error('MODEL_RESPONSE_MISMATCH');
    const body = { confirmed: true, requestId: globalThis.crypto.randomUUID(), text, systemCodes: codes, expectedDraftFingerprint: draft.draft.fingerprint };
    previewAttempt.value = { modelId: selectedModel, requestId: body.requestId }; previewRequestId.value = body.requestId;
    const result = await props.client.createStructuredPreview(selectedModel, body);
    if (!current()) return;
    if (result.modelId !== selectedModel || result.task?.modelId !== selectedModel || typeof result.task.id !== 'string' || !result.task.id || result.task.id.length > 200
      || result.creationMode !== 'structured_preview' || result.evidenceState !== 'ready' || result.executionEnabled !== false || result.runtimeReadEnabled !== false
      || result.task.status !== 'waiting_confirmation' || !/^[a-f0-9]{24}$/u.test(result.taskFingerprint || '')) throw new Error('PREVIEW_RESPONSE_MISMATCH');
    previewAttempt.value = null;
    tasks.value = [result.task, ...tasks.value.filter(task => task.id !== result.task.id)];
    notice.value = `结构化候选任务已创建：${result.task.id}。请求号：${body.requestId}。尚未采纳、确认、模拟或发布；请主动选择任务查看自己的对话。`;
  } catch {
    if (current()) { error.value = previewAttempt.value
      ? '创建没有获得可验证回执，可能已有准备记录或任务。保留原请求号，只读核对状态，不自动重发或创建第二条任务。'
      : '草稿预检未通过，没有发送创建请求；请检查权限和当前模型。'; }
  } finally { if (request === generation) actionBusy.value = false; }
}
let statusGeneration = 0;
const previewStateLabel = state => ({ reserved: '准备占位，尚无可恢复快照', prepared: '准备快照已保存，尚未提交任务', committed: '原任务已提交，仍需核对任务证据' }[state] || '未知状态');
async function inspectPreviewRequest() {
  if (!props.canBuild || !modelId.value || modelId.value === 'oa-governance' || actionBusy.value || loading.value || reading.value) return;
  previewRequestStatus.value = null;
  statusBinding.value = null; preparedProof.value = null; previewReceipt.value = null; recoveryAcknowledged.value = false;
  const id = previewRequestId.value;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id)) { error.value = '请输入原创建请求的完整小写 UUID v4，不自动猜测或新建请求。'; return; }
  const selectedModel = modelId.value; const request = generation; const statusRequest = ++statusGeneration;
  const current = () => request === generation && statusRequest === statusGeneration && modelId.value === selectedModel && props.canBuild && previewRequestId.value === id;
  actionBusy.value = true; error.value = ''; notice.value = '';
  try {
    const result = await props.client.getPreviewRequestStatus(selectedModel, id);
    if (!current()) return;
    if (result.modelId !== selectedModel || !['reserved', 'prepared', 'committed'].includes(result.state)
      || result.preparationAllowed !== false || result.automaticRetryAllowed !== false || result.automaticTakeoverAllowed !== false || result.executionEnabled !== false
      || !/^[a-f0-9]{64}$/u.test(result.inputFingerprint || '')
      || result.state !== 'reserved' && !/^[a-f0-9]{64}$/u.test(result.checkpointFingerprint || '')
      || result.state === 'reserved' && result.blocker !== 'preparation_checkpoint_absent'
      || result.state === 'committed' && (typeof result.taskId !== 'string' || !result.taskId || result.taskId.length > 200)) throw new Error('PREVIEW_STATUS_RESPONSE_MISMATCH');
    previewRequestStatus.value = { state: result.state, taskId: result.state === 'committed' ? result.taskId : null };
    statusBinding.value = { modelId: selectedModel, requestId: id, inputFingerprint: result.inputFingerprint, checkpointFingerprint: result.checkpointFingerprint };
  } catch (failure) {
    if (current()) { previewRequestStatus.value = null; error.value = failure.status === 404 || failure.payload?.code === 'MODEL_PREVIEW_REQUEST_NOT_FOUND'
      ? '当前模型与身份下没有此请求；查询不会创建占位或自动重试。'
      : '无法核对请求状态，请检查当前权限、模型及请求号；旧摘要已清除，不自动恢复或执行。'; }
  } finally { if (request === generation) actionBusy.value = false; }
}
const localTask = computed(() => dialogue.value?.localValidationTask === true && !dialogue.value?.reviewerAccess);
function recordAdoption(result) {
  if (!props.canReview || reading.value || !dialogue.value || result?.modelId !== modelId.value || result.task?.id !== selectedId.value || result.task.modelId !== modelId.value || result.task.status !== 'completed' || result.task.structuredAdoptionTask !== true) return;
  clearAuthorization(); dialogue.value = { ...dialogue.value, ...result.task };
  tasks.value = tasks.value.map(task => task.id === result.task.id ? { ...task, ...result.task } : task);
}
let generation = 0; let detailGeneration = 0;
const pageSize = 20;
const statusLabel = status => ({ waiting_confirmation: '待确认', completed: '已完成', failed: '失败', running: '执行中', cancelled: '已取消' }[status] || status || '未标记');
function clearAuthorization() { taskFingerprint.value = ''; localToken.value = null; createAcknowledged.value = false; confirmAcknowledged.value = false; executeAcknowledged.value = false; recoverAcknowledged.value = false; }
function clear() { tasks.value = []; nextOffset.value = 0; selectedId.value = ''; dialogue.value = null; hasMore.value = false; reading.value = false; loading.value = false; actionBusy.value = false; notice.value = ''; sourceCodesText.value = ''; sourceInspection.value = null; sourceAcknowledged.value = false; previewRequestId.value = ''; previewRequestStatus.value = null; previewText.value = ''; previewAcknowledged.value = false; previewAttempt.value = null; recoveryAcknowledged.value = false; preparedProof.value = null; previewReceipt.value = null; statusBinding.value = null; statusGeneration++; clearAuthorization(); detailGeneration++; }
async function sourceAction(bind = false) {
  if (!props.canBuild || !modelId.value || modelId.value === 'oa-governance' || actionBusy.value || loading.value || reading.value || bind && (!sourceInspection.value || !sourceAcknowledged.value)) return;
  const selectedModel = modelId.value; const request = generation; const codes = sourceCodesText.value.split(/[,，\s]+/u).filter(Boolean).sort();
  if (!codes.length || codes.length > 16 || new Set(codes).size !== codes.length || codes.some(code => !/^[A-Z][A-Z0-9_-]{0,39}$/u.test(code))) { error.value = '请输入明确系统码，例如 WMS、ERP；不自动猜测来源。'; return; }
  const stamp = sourceCodesText.value; const current = () => request === generation && modelId.value === selectedModel && props.canBuild && stamp === sourceCodesText.value;
  const previous = sourceInspection.value; sourceAcknowledged.value = false; actionBusy.value = true; error.value = ''; notice.value = '';
  try {
    const result = bind ? await props.client.bindModelSources(selectedModel, { confirmed: true, systemCodes: codes, expectedRevision: previous.revision, expectedSourceFingerprint: previous.sourceFingerprint })
      : await props.client.inspectModelSources(selectedModel, { systemCodes: codes });
    if (!current()) return;
    if (result.modelId !== selectedModel || result.runtimeReadEnabled !== false || !Number.isSafeInteger(result.revision) || result.revision < 0
      || !/^[a-f0-9]{64}$/u.test(result.sourceFingerprint || '') || !Array.isArray(result.systemCodes) || JSON.stringify([...result.systemCodes].sort()) !== JSON.stringify(codes)
      || !Number.isSafeInteger(result.documentCount) || result.documentCount < 1 || bind && result.revision !== previous.revision + 1) throw new Error('SOURCE_RESPONSE_MISMATCH');
    sourceInspection.value = bind ? null : { modelId: selectedModel, systemCodes: codes, revision: result.revision, sourceFingerprint: result.sourceFingerprint, documentCount: result.documentCount };
    notice.value = bind ? '来源资料已明确绑定；未授予新权限、生成候选或读取业务记录。' : '已检查资料摘要，尚未绑定；请核对来源范围后单独确认。';
  } catch (failure) {
    if (current()) { sourceInspection.value = null; error.value = failure.payload?.bindingMayHaveCommitted ? '绑定可能已提交，请重新检查当前资料，不自动重试。' : '来源检查或绑定未完成，请检查权限、资料和版本；不自动重试。'; }
  } finally { if (request === generation) actionBusy.value = false; }
}
async function loadModels() {
  const request = ++generation; clear(); models.value = []; modelId.value = ''; error.value = ''; loading.value = true;
  try {
    const result = await props.client.modelWorkspaces();
    if (request !== generation) return;
    models.value = result.models || [];
  } catch { if (request === generation) error.value = '无法读取模型列表，请检查登录身份与权限后重试。'; }
  finally { if (request === generation) loading.value = false; }
}
async function selectModel(id) {
  const request = ++generation; clear(); error.value = ''; modelId.value = id;
  if (creationAttempt.value?.modelId !== id) creationAttempt.value = null;
  if (!models.value.some(model => model.id === id)) { modelId.value = ''; loading.value = false; return; }
  await loadPage(request);
}
async function loadPage(request = generation) {
  const selectedModel = modelId.value; const offset = nextOffset.value;
  if (!selectedModel || loading.value && offset > 0) return;
  loading.value = true;
  try {
    const result = await props.client.modelTasks(selectedModel, { offset, limit: pageSize, includeArchived: false });
    if (request !== generation || selectedModel !== modelId.value) return;
    if (result.modelId !== selectedModel || result.contentScope !== 'task_metadata_only' || !Array.isArray(result.tasks)
      || result.tasks.some(task => task.modelId !== selectedModel)) throw new Error('MODEL_RESPONSE_MISMATCH');
    const known = new Set(tasks.value.map(task => task.id));
    tasks.value = [...tasks.value, ...result.tasks.filter(task => !known.has(task.id))];
    nextOffset.value = offset + result.tasks.length;
    hasMore.value = result.tasks.length === pageSize;
  } catch {
    if (request === generation) { clear(); error.value = '任务读取失败或权限/模型已变化，已清除旧内容，请重新选择模型。'; }
  } finally { if (request === generation) loading.value = false; }
}
async function openTask(task) {
  const request = generation; const detail = ++detailGeneration; const selectedModel = modelId.value;
  clearAuthorization(); notice.value = '';
  selectedId.value = task.id; dialogue.value = null; error.value = ''; reading.value = true;
  try {
    const result = await props.client.modelTaskDialogue(selectedModel, task.id);
    if (request !== generation || detail !== detailGeneration) return;
    if (result.modelId !== selectedModel || result.task?.id !== task.id || result.task.modelId !== selectedModel
      || result.contentScope !== 'owner_dialogue_only' || result.executionEnabled !== false || result.runtimeReadEnabled !== false) throw new Error('MODEL_RESPONSE_MISMATCH');
    dialogue.value = result.task;
    taskFingerprint.value = result.taskFingerprint || '';
  } catch {
    if (request === generation && detail === detailGeneration) { clear(); error.value = '无法读取对话：仅所有者可读，权限或引用变化、格式不支持及超限都会拒绝。已清除旧任务内容，请刷新模型列表。'; }
  } finally { if (request === generation && detail === detailGeneration) reading.value = false; }
}
async function localAction(kind) {
  if (actionBusy.value || loading.value || reading.value || !modelId.value) return;
  if (kind === 'create' ? !props.canValidate || !createAcknowledged.value
    : !localTask.value || (kind === 'execute' ? !props.canValidate || !executeAcknowledged.value : !props.canConfirm || !(kind === 'recover' ? recoverAcknowledged.value : confirmAcknowledged.value))) return;
  if (kind === 'confirm' && (dialogue.value.confirmationEvidenceState === 'pending' || dialogue.value.evidenceState !== 'ready')) return;
  const selectedModel = modelId.value; const id = selectedId.value; const request = generation; const detail = detailGeneration;
  const current = () => request === generation && detail === detailGeneration;
  actionBusy.value = true; error.value = ''; notice.value = '';
  try {
    let result;
    if (kind === 'create') {
      if (!creationAttempt.value) {
        const draft = await props.client.modelDraft(selectedModel);
        if (!current() || !props.canValidate) return;
        if (draft.modelId !== selectedModel || !/^[a-f0-9]{24}$/u.test(draft.draft?.fingerprint || '')) throw new Error('MODEL_RESPONSE_MISMATCH');
        creationAttempt.value = { modelId: selectedModel, body: { confirmed: true, kind: 'validate_model', requestId: globalThis.crypto.randomUUID(), expectedDraftFingerprint: draft.draft.fingerprint } };
      }
      result = await props.client.createLocalValidationTask(selectedModel, creationAttempt.value.body);
      if (!current()) return;
      if (result.modelId !== selectedModel || result.task?.modelId !== selectedModel || !result.task?.localValidationTask || result.evidenceState !== 'ready') throw new Error('MODEL_RESPONSE_MISMATCH');
      creationAttempt.value = null; createAcknowledged.value = false;
      tasks.value = [result.task, ...tasks.value.filter(task => task.id !== result.task.id)];
      await openTask(result.task);
      if (request === generation && modelId.value === selectedModel && selectedId.value === result.task.id) notice.value = result.reused ? '已复用原创建请求，没有新建第二条任务或自动执行。' : '本地校验任务已创建，尚未确认或执行。';
    } else if (kind === 'confirm') {
      if (!taskFingerprint.value) throw new Error('TASK_REFRESH_REQUIRED');
      localToken.value = null; confirmAcknowledged.value = false;
      result = await props.client.confirmLocalValidationTask(selectedModel, id, { confirmed: true, expectedTaskFingerprint: taskFingerprint.value });
      if (!current() || !props.canConfirm) return;
      if (result.modelId !== selectedModel || result.task?.id !== id || result.task.modelId !== selectedModel || result.task.localValidationTask !== true || result.confirmationEvidenceState !== 'ready' || !/^[a-f0-9]{24}$/u.test(result.taskFingerprint || '')
        || !/^[A-Za-z0-9_-]{43}$/u.test(result.confirmationToken || '') || !(Date.parse(result.expiresAt) > Date.now())) throw new Error('MODEL_RESPONSE_MISMATCH');
      localToken.value = { modelId: selectedModel, taskId: id, value: result.confirmationToken, fingerprint: result.taskFingerprint, expiresAt: result.expiresAt };
      taskFingerprint.value = result.taskFingerprint; dialogue.value = { ...dialogue.value, ...result.task };
      notice.value = '确认凭证已就绪，仅保存在本页内存；还没有执行。';
    } else if (kind === 'execute') {
      const token = localToken.value; localToken.value = null; executeAcknowledged.value = false;
      if (!token || token.modelId !== selectedModel || token.taskId !== id || Date.parse(token.expiresAt) <= Date.now()) throw new Error('TOKEN_EXPIRED_OR_MISSING');
      result = await props.client.executeLocalValidationTask(selectedModel, id, { confirmed: true, expectedTaskFingerprint: token.fingerprint, confirmationToken: token.value });
      if (!current()) return;
      if (result.modelId !== selectedModel || result.task?.id !== id || result.task.modelId !== selectedModel || result.task.localValidationTask !== true || result.executedCommand !== 'validate_model') throw new Error('MODEL_RESPONSE_MISMATCH');
      dialogue.value = { ...dialogue.value, ...result.task }; taskFingerprint.value = '';
      notice.value = `本地校验任务已归档，校验状态：${result.validation?.status || '未返回'}。未发布或写入源系统。`;
    } else if (kind === 'recover') {
      localToken.value = null; recoverAcknowledged.value = false;
      result = await props.client.recoverLocalConfirmationEvidence(selectedModel, id, { confirmed: true });
      if (!current()) return;
      if (result.modelId !== selectedModel || result.taskId !== id || result.confirmationEvidenceState !== 'ready' || result.confirmationTokenReturned !== false) throw new Error('MODEL_RESPONSE_MISMATCH');
      dialogue.value = { ...dialogue.value, confirmationEvidenceState: 'ready' }; taskFingerprint.value = '';
      notice.value = '确认证据已恢复，没有重签或执行；请刷新当前任务，重新明确确认才能获取新凭证。';
    }
  } catch (failure) {
    if (current()) {
      clear();
      error.value = failure.payload?.taskMayHaveCommitted || failure.payload?.workspaceWriteMayHaveCommitted
        ? '请求可能已提交，不能自动重试执行。请检查最新任务；创建可用原请求号明确恢复，确认证据按恢复入口处理。'
        : '操作未完成，旧凭证已清除。请刷新并检查权限、模型、任务状态或有效期；不会自动重试。';
    }
  } finally { if (request === generation) actionBusy.value = false; }
}
onMounted(loadModels);
watch(() => props.client, () => { creationAttempt.value = null; loadModels(); });
watch(sourceCodesText, () => { sourceInspection.value = null; sourceAcknowledged.value = false; previewAcknowledged.value = false; });
watch(previewText, () => { previewAcknowledged.value = false; });
watch(previewRequestId, () => { statusGeneration++; previewRequestStatus.value = null; statusBinding.value = null; preparedProof.value = null; previewReceipt.value = null; recoveryAcknowledged.value = false; });
watch(() => [props.canValidate, props.canConfirm, props.canBuild, props.canReview, props.canSimulate], () => { generation++; creationAttempt.value = null; models.value = []; modelId.value = ''; clear(); });
onBeforeUnmount(() => { generation++; detailGeneration++; clear(); });
</script>

<template>
  <section class="model-task-browser" aria-label="独立模型任务与本地校验">
    <header><div><h2>独立模型任务工作区</h2><p>明确选择模型查看自己的任务。结构化候选先审阅图和差异，再分别确认、采纳、本地合成模拟；校验任务另行操作。不调用大模型，不自动发布或写入源系统，不切换其他页面工作区。</p></div><button type="button" :disabled="actionBusy" @click="loadModels">刷新模型列表</button></header>
    <label class="model-picker">选择模型<select :value="modelId" :disabled="loading || actionBusy" @change="selectModel($event.target.value)"><option value="">请选择模型</option><option v-for="model in models" :key="model.id" :value="model.id">{{ model.label }} · {{ model.id }}</option></select></label>
    <section v-if="canBuild && modelId && modelId !== 'oa-governance'" class="local-actions" aria-label="明确来源资料绑定">
      <h3>先检查来源，再明确绑定</h3><p>只使用已有权限内的接口文档/字典资料，不读取业务明细或写入源系统。</p>
      <label>系统码<input v-model="sourceCodesText" placeholder="WMS, ERP" :disabled="actionBusy || loading || reading"></label>
      <button type="button" :disabled="actionBusy || loading || reading || !sourceCodesText.trim()" @click="sourceAction(false)">检查资料摘要</button>
      <template v-if="sourceInspection"><p>来源：{{ sourceInspection.systemCodes.join('、') }} · {{ sourceInspection.documentCount }}份资料 · 绑定修订{{ sourceInspection.revision }}</p>
        <label><input v-model="sourceAcknowledged" type="checkbox" :disabled="actionBusy">我确认以上范围，只绑定资料，不生成模型或执行任务</label>
        <button type="button" :disabled="!sourceAcknowledged || actionBusy || loading || reading" @click="sourceAction(true)">确认绑定资料</button></template>
    </section>
    <section v-if="canBuild && modelId && modelId !== 'oa-governance'" class="local-actions" aria-label="结构化候选预览创建">
      <h3>生成结构化候选预览</h3><p>先绑定上方来源资料，再描述建模诉求。仅解析接口文档/数据字典里的Schema，不调用大模型，不承诺自然语言或图片理解，也不自动采纳或执行。</p>
      <label class="preview-input">建模诉求<textarea v-model="previewText" maxlength="4000" :disabled="actionBusy || !!previewAttempt" rows="3" placeholder="例如：从已绑定WMS接口文档建立库存对象候选"></textarea></label>
      <label><input v-model="previewAcknowledged" type="checkbox" :disabled="actionBusy || !!previewAttempt">我确认只生成候选，使用上方明确来源，不自动执行</label>
      <button type="button" :disabled="!previewAcknowledged || !!previewAttempt || actionBusy || loading || reading" @click="createPreview">创建候选预览</button>
      <p v-if="previewAttempt">创建回执尚未核实，请保留请求号：{{ previewAttempt.requestId }}。当前不允许重发；换页/刷新不会证明原请求失败，请先记录此编号。</p>
    </section>
    <section v-if="canBuild && modelId && modelId !== 'oa-governance'" class="local-actions" aria-label="结构化预览请求状态">
      <h3>核对原预览请求</h3><p>输入原请求号，只查当前模型与身份下的元数据；不重新准备、恢复、采纳或执行。请求号不保存到浏览器存储。</p>
      <label>原请求号<input v-model="previewRequestId" maxlength="36" autocomplete="off" spellcheck="false" :disabled="actionBusy || loading || reading" placeholder="小写 UUID v4"></label>
      <button type="button" :disabled="actionBusy || loading || reading || !previewRequestId" @click="inspectPreviewRequest">只读核对状态</button>
      <template v-if="previewRequestStatus"><p role="status">{{ previewStateLabel(previewRequestStatus.state) }}<span v-if="previewRequestStatus.taskId"> · 原任务：{{ previewRequestStatus.taskId }}</span></p>
        <p v-if="previewRequestStatus.state === 'reserved'">没有快照，不能自动重试、接管或删除占位；不代表建模成功。</p>
        <p v-else>状态查询不授予确认或执行权限。每个恢复步骤都需单独勾选，服务器会重新复验权限及原引用。</p></template>
      <template v-if="statusBinding && previewRequestStatus && previewRequestStatus.state !== 'reserved'">
        <label><input v-model="recoveryAcknowledged" type="checkbox" :disabled="actionBusy">我确认只执行本次选择的检查/恢复，不采纳、签发或执行模型任务</label>
        <template v-if="previewRequestStatus.state === 'prepared'"><button type="button" :disabled="!recoveryAcknowledged || actionBusy" @click="recoverPreview('probe')">检查原准备快照</button><button type="button" :disabled="!preparedProof || !recoveryAcknowledged || actionBusy" @click="recoverPreview('resume')">仅续交原任务</button></template>
        <button v-if="previewRequestStatus.state === 'committed'" type="button" :disabled="!recoveryAcknowledged || actionBusy" @click="recoverPreview('commit')">读取原提交回执</button>
        <button v-if="previewReceipt?.evidenceState === 'pending'" type="button" :disabled="!recoveryAcknowledged || actionBusy" @click="recoverPreview('evidence')">核验并恢复原任务证据</button>
      </template>
    </section>
    <div v-if="modelId && canValidate" class="local-actions"><label><input v-model="createAcknowledged" type="checkbox" :disabled="actionBusy">我确认只创建本地结构校验任务，不自动执行</label><button type="button" :disabled="!createAcknowledged || actionBusy || loading || reading" @click="localAction('create')">{{ creationAttempt ? '明确恢复原创建请求' : '1. 创建本地校验任务' }}</button></div>
    <p v-if="notice" role="status" class="dialogue-status">{{ notice }}</p>
    <p v-if="error" role="alert" class="browser-error">{{ error }}</p>
    <p v-if="!modelId">{{ loading ? '正在读取模型列表…' : '选择模型后加载任务，不自动选择或激活模型。' }}</p>
    <div v-else class="model-task-columns">
      <aside aria-label="模型任务列表" :aria-busy="loading">
        <p>当前模型：{{ modelId }}</p>
        <button v-for="task in tasks" :key="task.id" type="button" :disabled="actionBusy" :class="{ selected: selectedId === task.id }" @click="openTask(task)"><strong>{{ task.displayTitle }}</strong><span>{{ statusLabel(task.status) }}{{ task.reviewerAccess ? ' · 审核摘要（不开放作者对话）' : '' }}</span><small>{{ task.id }}</small></button>
        <p v-if="!tasks.length">{{ loading ? '正在加载…' : '当前权限范围没有任务。' }}</p>
        <button v-if="hasMore" type="button" :disabled="loading" @click="loadPage()">{{ loading ? '加载中…' : '加载更多' }}</button>
      </aside>
      <article aria-label="任务对话" :aria-busy="reading">
        <ModelAdoptionReviewPanel v-if="dialogue?.structuredAdoptionTask && !dialogue.reviewerAccess && canReview && !reading" :key="`${modelId}:${selectedId}`" :client="client" :model-id="modelId" :task-id="selectedId" :can-review="canReview" :can-simulate="canSimulate" @applied="recordAdoption" />
        <div v-if="localTask && ['waiting_confirmation','retryable'].includes(dialogue.status)" class="local-actions">
          <button type="button" :disabled="actionBusy" @click="openTask({ id: selectedId })">刷新当前任务（清除旧凭证）</button>
          <template v-if="canConfirm && dialogue.confirmationEvidenceState !== 'pending'"><label><input v-model="confirmAcknowledged" type="checkbox" :disabled="actionBusy">我确认当前任务版本，只签发凭证，不执行</label><button type="button" :disabled="!confirmAcknowledged || !taskFingerprint || dialogue.evidenceState !== 'ready' || actionBusy || reading" @click="localAction('confirm')">2. 确认当前任务</button></template>
          <template v-if="canValidate && localToken"><label><input v-model="executeAcknowledged" type="checkbox" :disabled="actionBusy">我确认执行本地结构校验，不发布或写入源系统</label><button type="button" :disabled="!executeAcknowledged || actionBusy || reading" @click="localAction('execute')">3. 执行本地校验</button></template>
          <template v-if="canConfirm && dialogue.confirmationEvidenceState === 'pending'"><label><input v-model="recoverAcknowledged" type="checkbox" :disabled="actionBusy">仅恢复既有确认证据，不重签或执行</label><button type="button" :disabled="!recoverAcknowledged || actionBusy" @click="localAction('recover')">恢复确认证据</button></template>
        </div>
        <p v-if="reading" role="status">正在复验身份、模型与任务引用…</p>
        <template v-else-if="dialogue"><p class="dialogue-status">{{ statusLabel(dialogue.status) }} · 任务证据：{{ dialogue.evidenceState }} · 确认证据：{{ dialogue.confirmationEvidenceState || '未要求或旧记录' }} · 仅查看</p><div v-for="(item, index) in dialogue.messages" :key="index" :class="['model-message', item.role]"><strong>{{ item.role === 'user' ? '我' : '语义 Agent' }}</strong><p>{{ item.content }}</p><small v-if="item.time">{{ item.time }}</small></div></template>
        <p v-else>选择任务查看自己的对话。审核权限不会授予他人的聊天或私有资料访问权限。</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.model-task-browser { margin: 22px; padding: 22px; border: 1px solid #2b5263; border-radius: 12px; color: #d6edf6; background: #0a202d; }
header { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; } h2 { margin: 0 0 8px; } p { line-height: 1.65; }
header p, small { color: #9db8c8; } button, select { color: #d6edf6; background: #102f40; border: 1px solid #3c687b; border-radius: 8px; padding: 10px 14px; }
button { cursor: pointer; } button:disabled { opacity: .6; cursor: wait; } button:focus-visible, select:focus-visible { outline: 2px solid #57d5c5; outline-offset: 2px; }
.model-picker { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 16px 0; } select { max-width: 100%; }
.local-actions h3, .local-actions p { flex-basis: 100%; margin: 4px 0; }
.local-actions input:not([type="checkbox"]) { color: #d6edf6; background: #102f40; border: 1px solid #3c687b; border-radius: 8px; padding: 10px; width: min(260px, 100%); box-sizing: border-box; }
.local-actions input:focus-visible { outline: 2px solid #57d5c5; outline-offset: 2px; }
.preview-input { flex-basis: 100%; flex-direction: column; } .preview-input textarea { width: 100%; box-sizing: border-box; resize: vertical; color: #d6edf6; background: #102f40; border: 1px solid #3c687b; border-radius: 8px; padding: 10px; font: inherit; } .preview-input textarea:focus-visible { outline: 2px solid #57d5c5; outline-offset: 2px; }
.model-task-columns { display: grid; grid-template-columns: minmax(220px, 300px) minmax(0, 1fr); gap: 20px; }
aside, article { min-width: 0; max-height: 65vh; overflow-y: auto; scrollbar-gutter: stable; padding: 12px; border: 1px solid #2b5263; border-radius: 8px; background: #081a25; }
aside button { display: block; width: 100%; margin: 8px 0; text-align: left; overflow-wrap: anywhere; } aside span, aside small { display: block; margin-top: 6px; }
aside .selected { border-color: #57d5c5; background: #153b47; } .browser-error { color: #ffc49e; } .dialogue-status { color: #57d5c5; }
.model-message { padding: 14px; margin-bottom: 12px; border: 1px solid #2b5263; border-radius: 8px; } .model-message.user { background: #102f40; }
.model-message p { white-space: pre-wrap; overflow-wrap: anywhere; } @media (max-width: 760px) { .model-task-browser { margin: 12px; padding: 14px; } .model-task-columns { grid-template-columns: 1fr; } aside { max-height: 35vh; } article { max-height: none; } }
.local-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 14px; margin: 12px 0; border: 1px solid #3c687b; border-radius: 8px; } .local-actions label { display: flex; gap: 8px; align-items: flex-start; line-height: 1.6; } .local-actions input { margin-top: 5px; }
</style>

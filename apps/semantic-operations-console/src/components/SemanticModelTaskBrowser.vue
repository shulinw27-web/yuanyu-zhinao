<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({ client: { type: Object, required: true }, canValidate: { type: Boolean, default: false }, canConfirm: { type: Boolean, default: false }, canBuild: { type: Boolean, default: false } });
const models = ref([]); const modelId = ref(''); const tasks = ref([]); const selectedId = ref(''); const dialogue = ref(null);
const loading = ref(false); const reading = ref(false); const hasMore = ref(false); const error = ref('');
const nextOffset = ref(0);
const taskFingerprint = ref(''); const actionBusy = ref(false); const notice = ref('');
const createAcknowledged = ref(false); const confirmAcknowledged = ref(false); const executeAcknowledged = ref(false); const recoverAcknowledged = ref(false);
const creationAttempt = ref(null); const localToken = ref(null);
const sourceCodesText = ref(''); const sourceInspection = ref(null); const sourceAcknowledged = ref(false);
const localTask = computed(() => dialogue.value?.localValidationTask === true && !dialogue.value?.reviewerAccess);
let generation = 0; let detailGeneration = 0;
const pageSize = 20;
const statusLabel = status => ({ waiting_confirmation: '待确认', completed: '已完成', failed: '失败', running: '执行中', cancelled: '已取消' }[status] || status || '未标记');
function clearAuthorization() { taskFingerprint.value = ''; localToken.value = null; createAcknowledged.value = false; confirmAcknowledged.value = false; executeAcknowledged.value = false; recoverAcknowledged.value = false; }
function clear() { tasks.value = []; nextOffset.value = 0; selectedId.value = ''; dialogue.value = null; hasMore.value = false; reading.value = false; loading.value = false; actionBusy.value = false; notice.value = ''; sourceCodesText.value = ''; sourceInspection.value = null; sourceAcknowledged.value = false; clearAuthorization(); detailGeneration++; }
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
watch(sourceCodesText, () => { sourceInspection.value = null; sourceAcknowledged.value = false; });
watch(() => [props.canValidate, props.canConfirm, props.canBuild], () => { generation++; creationAttempt.value = null; models.value = []; modelId.value = ''; clear(); });
onBeforeUnmount(() => { generation++; detailGeneration++; clear(); });
</script>

<template>
  <section class="model-task-browser" aria-label="独立模型任务与本地校验">
    <header><div><h2>模型任务 · 本地校验</h2><p>明确选择模型查看自己的任务。本地校验需要分别创建、确认、执行；不调用大模型，不采纳、模拟、发布或写入源系统，也不切换其他页面工作区。</p></div><button type="button" :disabled="actionBusy" @click="loadModels">刷新模型列表</button></header>
    <label class="model-picker">选择模型<select :value="modelId" :disabled="loading || actionBusy" @change="selectModel($event.target.value)"><option value="">请选择模型</option><option v-for="model in models" :key="model.id" :value="model.id">{{ model.label }} · {{ model.id }}</option></select></label>
    <section v-if="canBuild && modelId && modelId !== 'oa-governance'" class="local-actions" aria-label="明确来源资料绑定">
      <h3>先检查来源，再明确绑定</h3><p>只使用已有权限内的接口文档/字典资料，不读取业务明细或写入源系统。</p>
      <label>系统码<input v-model="sourceCodesText" placeholder="WMS, ERP" :disabled="actionBusy || loading || reading"></label>
      <button type="button" :disabled="actionBusy || loading || reading || !sourceCodesText.trim()" @click="sourceAction(false)">检查资料摘要</button>
      <template v-if="sourceInspection"><p>来源：{{ sourceInspection.systemCodes.join('、') }} · {{ sourceInspection.documentCount }}份资料 · 绑定修订{{ sourceInspection.revision }}</p>
        <label><input v-model="sourceAcknowledged" type="checkbox" :disabled="actionBusy">我确认以上范围，只绑定资料，不生成模型或执行任务</label>
        <button type="button" :disabled="!sourceAcknowledged || actionBusy || loading || reading" @click="sourceAction(true)">确认绑定资料</button></template>
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
.model-task-columns { display: grid; grid-template-columns: minmax(220px, 300px) minmax(0, 1fr); gap: 20px; }
aside, article { min-width: 0; max-height: 65vh; overflow-y: auto; scrollbar-gutter: stable; padding: 12px; border: 1px solid #2b5263; border-radius: 8px; background: #081a25; }
aside button { display: block; width: 100%; margin: 8px 0; text-align: left; overflow-wrap: anywhere; } aside span, aside small { display: block; margin-top: 6px; }
aside .selected { border-color: #57d5c5; background: #153b47; } .browser-error { color: #ffc49e; } .dialogue-status { color: #57d5c5; }
.model-message { padding: 14px; margin-bottom: 12px; border: 1px solid #2b5263; border-radius: 8px; } .model-message.user { background: #102f40; }
.model-message p { white-space: pre-wrap; overflow-wrap: anywhere; } @media (max-width: 760px) { .model-task-browser { margin: 12px; padding: 14px; } .model-task-columns { grid-template-columns: 1fr; } aside { max-height: 35vh; } article { max-height: none; } }
.local-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 14px; margin: 12px 0; border: 1px solid #3c687b; border-radius: 8px; } .local-actions label { display: flex; gap: 8px; align-items: flex-start; line-height: 1.6; } .local-actions input { margin-top: 5px; }
</style>

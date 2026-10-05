<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import SemanticOnboardingAlignment from './SemanticOnboardingAlignment.vue';
import SemanticOnboardingCalculation from './SemanticOnboardingCalculation.vue';

const props = defineProps({ client: { type: Object, required: true }, canWrite: { type: Boolean, default: false } });
const emit = defineEmits(['open-agent', 'open-model']);
const materialKinds = [
  { kind: 'requirements', label: '业务需求', hint: '至少 24 个非空白字符，说明业务目标、涉及部门、需要回答的问题与验收口径。也可上传 PDF / Word / Excel 文档，登记的是服务端受控提取文本，原文件不保存。', document: true },
  { kind: 'api', label: '接口说明', hint: '至少 24 个非空白字符，描述来源系统、接口路径、只读方法、响应字段与授权方式。也可上传 PDF / Word / Excel 接口或数据字典文档，登记的是服务端受控提取文本，原文件不保存。仅登记文档，本步骤不调用接口。', document: true },
  { kind: 'dictionary', label: '数据字典', hint: '提交 JSON：tables 数组中每张表包含 name、system、primaryKey，以及 fields 数组（name、type，可选 required、reference、referenceField）。type 支持 string / number / integer / boolean。文档形态字典请到 Agent 对话面上传，仅进入候选路径。' },
  { kind: 'samples', label: '合成样本', hint: '提交 JSON：records 数组中每条记录包含 objectType 和 payload。objectType 与数据字典表名一致，payload 填合成字段值，主键、必填、字段类型与外键应匹配字典。' },
  { kind: 'rules', label: '业务规则', hint: '至少 24 个非空白字符，说明状态口径、异常判定、跨系统关联依据与需要人工处理的情况。也可上传 PDF / Word / Excel 文档，登记的是服务端受控提取文本，原文件不保存。', document: true }
];
const documentExtensionMime = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
});
const maxAttachmentBytes = 4 * 1024 * 1024;
const scenarios = ref([]);
const projects = ref([]);
const limits = ref({});
const scenarioId = ref('');
const projectName = ref('');
const selectedId = ref('');
const project = ref(null);
const materialKind = ref('requirements');
const materialName = ref('');
const materialText = ref('');
const materialAttachment = ref(null);
const documentMimeTypes = ref([]);
const loading = ref(false);
const loadingProject = ref(false);
const creating = ref(false);
const saving = ref(false);
const readingFile = ref(false);
const alignmentBusy = ref(false);
const handingOff = ref(false);
const calculating = ref(false);
const overviewError = ref('');
const projectError = ref('');
const formError = ref('');
const notice = ref('');
const conflict = ref(false);
const accessDenied = ref(false);
const faultModes = [
  { value: 'none', label: '正常响应' }, { value: 'rate_limited', label: '模拟限流（429）' },
  { value: 'timeout', label: '模拟超时' }, { value: 'malformed', label: '模拟响应格式损坏' },
  { value: 'cross_tenant', label: '模拟租户不匹配' }, { value: 'incomplete', label: '模拟分页不完整' },
  { value: 'schema_drift', label: '模拟字段结构变化' }
];
const faultMode = ref('none');
const testingConnection = ref(false);
const connectionError = ref('');
const connectionNotice = ref('');
const preview = ref(null);
const previewObjects = ref([]);
const previewObjectType = ref('');
const previewLoading = ref(false);
const previewError = ref('');
let disposed = false;
let overviewGeneration = 0;
let projectGeneration = 0;
let fileGeneration = 0;
let createGeneration = 0;
let saveGeneration = 0;
let connectionGeneration = 0;
let previewGeneration = 0;
let requestedPreviewObject = '';

const writable = computed(() => props.canWrite && !accessDenied.value);
const busy = computed(() => creating.value || saving.value || readingFile.value || testingConnection.value || alignmentBusy.value || handingOff.value || calculating.value);
const connection = computed(() => project.value?.connection || null);
const materialsReady = computed(() => project.value?.readiness?.status === 'ready_for_review');
const connectionVerified = computed(() => connection.value?.status === 'verified' && connection.value?.sourceKind === 'local_mock_http');
const canTestConnection = computed(() => writable.value && materialsReady.value && !busy.value && !loadingProject.value && !conflict.value);
const canPreview = computed(() => connectionVerified.value && !busy.value && !loadingProject.value && !conflict.value);
const previewRows = computed(() => Array.isArray(preview.value?.rows) ? preview.value.rows.slice(0, 10) : []);
const currentScenario = computed(() => scenarios.value.find(item => item.id === scenarioId.value));
const projectScenario = computed(() => scenarios.value.find(item => item.id === project.value?.scenarioId));
const currentKind = computed(() => materialKinds.find(item => item.kind === materialKind.value));
const byteLimit = computed(() => Number(limits.value.materialBytes || limits.value.maxMaterialBytes || limits.value.maxTextBytes) || 65536);
const textBytes = computed(() => new TextEncoder().encode(materialText.value).byteLength);
const existingMaterial = computed(() => project.value?.materials?.find(item => item.kind === materialKind.value));
const acceptsDocument = computed(() => Boolean(currentKind.value?.document));
const acceptsMimeTypes = computed(() => {
  const serverList = Array.isArray(documentMimeTypes.value) && documentMimeTypes.value.length ? documentMimeTypes.value : Object.values(documentExtensionMime);
  return acceptsDocument.value ? serverList : [];
});
const fileAccept = computed(() => ['.json,.txt,application/json,text/plain', ...acceptsMimeTypes.value.map(mime => `.${Object.keys(documentExtensionMime).find(key => documentExtensionMime[key] === mime) || ''}`)]
  .filter(item => item !== '.').join(','));
const attachmentKilobytes = computed(() => Math.max(1, Math.round((materialAttachment.value?.dataUrl?.length || 0) * 3 / 4 / 1024)));
const canSave = computed(() => writable.value && project.value && !busy.value && !loadingProject.value && !conflict.value
  && materialName.value.trim() && (materialAttachment.value || (materialText.value.trim() && textBytes.value <= byteLimit.value)));
const completed = computed(() => Number(project.value?.readiness?.completed) || 0);
const total = computed(() => Number(project.value?.readiness?.total) || materialKinds.length);
const progress = computed(() => Math.min(100, Math.max(0, Math.round(completed.value / total.value * 100))));
const allIssues = computed(() => {
  const summaryIssues = project.value?.readiness?.issues;
  const issues = summaryIssues?.length ? summaryIssues : (project.value?.materials || []).flatMap(item =>
    (item.issues || []).map(issue => `${materialKinds.find(kind => kind.kind === item.kind)?.label || item.kind}：${issue}`));
  return [...new Set(issues)];
});
const materialFor = kind => project.value?.materials?.find(item => item.kind === kind);
const missingFor = kind => project.value?.readiness?.missing?.find(item => item.kind === kind);
const stageLabel = status => ({ pending: '待准备', ready: '待复核', complete: '已完成' })[status] || '待准备';
const statusLabel = item => item?.readiness?.status === 'ready_for_review' ? '待人工复核' : '收集材料中';
const previewCell = value => {
  if (value === null || value === undefined) return '—';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
};
const displayTime = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '—';
const errorMessage = (error, fallback) => {
  if (error?.status === 401 || error?.status === 403) return '当前身份没有执行此操作的权限，请重新登录或联系管理员。';
  if (error?.status === 404) return '项目不存在或当前身份无权访问，请刷新项目列表。';
  if (error?.status === 413) return '材料超过服务端大小限制，请缩减内容后重新提交。';
  return error?.message || fallback;
};
const updateList = value => {
  const index = projects.value.findIndex(item => item.id === value.id);
  if (index < 0) projects.value.unshift(value);
  else projects.value.splice(index, 1, value);
};
function resetEditor() {
  fileGeneration += 1;
  readingFile.value = false;
  materialName.value = '';
  materialText.value = '';
  materialAttachment.value = null;
  formError.value = '';
}
watch(materialKind, resetEditor, { flush: 'sync' });

function clearPreview() {
  previewGeneration += 1;
  preview.value = null;
  previewObjects.value = [];
  previewObjectType.value = '';
  previewLoading.value = false;
  previewError.value = '';
  requestedPreviewObject = '';
}

function resetConnectionView(resetFault = true) {
  clearPreview();
  connectionError.value = '';
  connectionNotice.value = '';
  if (resetFault) faultMode.value = 'none';
}

function alignmentUpdated(value) {
  if (value.id !== project.value?.id) return;
  project.value = value;
  updateList(value);
  resetConnectionView(false);
}

async function handoffModel() {
  if (!writable.value || busy.value || conflict.value || project.value?.alignment?.status !== 'validated_scope' || project.value?.alignment?.evidenceStatus !== 'quotes_verified') return;
  const id = project.value.id; const selection = projectGeneration;
  handingOff.value = true; formError.value = ''; notice.value = '';
  try {
    const result = await props.client.handoffOnboarding(id, { expectedRevision: project.value.revision });
    if (disposed || selection !== projectGeneration || selectedId.value !== id) return;
    if (result.project?.id !== id || !result.taskId) throw new Error('交接结果不完整，请刷新核对。');
    project.value = result.project; updateList(result.project); clearPreview();
    notice.value = `${result.reused ? '已复用' : '已创建'}待审阅任务 ${result.taskId}。请转到 Agent 工作台校对，尚未采纳或发布。`;
  } catch (error) {
    if (!disposed && selection === projectGeneration) { formError.value = errorMessage(error, '建模交接失败。'); conflict.value = error?.code === 'MOCK_ONBOARDING_REVISION_CONFLICT'; }
  } finally { if (!disposed) handingOff.value = false; }
}

async function selectProject(id, preserveDraft = false) {
  if (busy.value || !id) return;
  const generation = ++projectGeneration;
  selectedId.value = id;
  loadingProject.value = true;
  projectError.value = '';
  notice.value = '';
  conflict.value = false;
  resetConnectionView(!preserveDraft);
  if (!preserveDraft) { project.value = null; resetEditor(); }
  try {
    const result = await props.client.onboardingProject(id);
    if (disposed || generation !== projectGeneration || selectedId.value !== id) return;
    if (result?.project?.id !== id) throw new Error('返回的项目与当前选择不一致，请重试。');
    project.value = result.project;
    updateList(result.project);
    if (preserveDraft) { formError.value = ''; notice.value = '项目版本已刷新，编辑内容已保留。请核对最新材料后重新保存。'; }
  } catch (error) {
    if (!disposed && generation === projectGeneration) {
      projectError.value = errorMessage(error, '项目加载失败。');
      if (preserveDraft) conflict.value = true;
    }
  } finally {
    if (!disposed && generation === projectGeneration) loadingProject.value = false;
  }
}

async function loadOverview() {
  if (loading.value || busy.value) return;
  const generation = ++overviewGeneration;
  loading.value = true;
  overviewError.value = '';
  accessDenied.value = false;
  try {
    const result = await props.client.onboarding();
    if (disposed || generation !== overviewGeneration) return;
    scenarios.value = Array.isArray(result.scenarios) ? result.scenarios : [];
    projects.value = Array.isArray(result.projects) ? result.projects : [];
    limits.value = result.limits || {};
    documentMimeTypes.value = Array.isArray(result.documentMimeTypes) ? result.documentMimeTypes : [];
    if (!scenarios.value.some(item => item.id === scenarioId.value)) scenarioId.value = scenarios.value[0]?.id || '';
    const id = projects.value.some(item => item.id === selectedId.value) ? selectedId.value : projects.value[0]?.id;
    if (id) await selectProject(id, id === selectedId.value);
    else { projectGeneration += 1; selectedId.value = ''; project.value = null; loadingProject.value = false; resetEditor(); resetConnectionView(); }
  } catch (error) {
    if (!disposed && generation === overviewGeneration) {
      overviewError.value = errorMessage(error, '接入项目加载失败，请重试。');
      accessDenied.value = error?.status === 401 || error?.status === 403;
    }
  } finally {
    if (!disposed && generation === overviewGeneration) loading.value = false;
  }
}

async function createProject() {
  if (!writable.value || busy.value || loading.value || !scenarioId.value || !projectName.value.trim()) return;
  const generation = ++createGeneration;
  const selection = ++projectGeneration;
  creating.value = true;
  loadingProject.value = false;
  formError.value = '';
  notice.value = '';
  resetConnectionView();
  try {
    const result = await props.client.createOnboardingProject({ scenarioId: scenarioId.value, name: projectName.value.trim() });
    if (disposed || generation !== createGeneration || selection !== projectGeneration) return;
    if (!result?.project?.id) throw new Error('新建项目没有返回有效结果，请刷新列表核对。');
    project.value = result.project;
    selectedId.value = result.project.id;
    updateList(result.project);
    projectName.value = '';
    projectError.value = '';
    conflict.value = false;
    resetEditor();
    notice.value = '空白模拟项目已建立，请逐项准备材料。';
  } catch (error) {
    if (!disposed && generation === createGeneration) formError.value = errorMessage(error, '项目创建失败。');
  } finally {
    if (!disposed && generation === createGeneration) creating.value = false;
  }
}

async function readMaterialFile(event) {
  const file = event.target?.files?.[0];
  if (event.target) event.target.value = '';
  if (!file || !writable.value || busy.value || !project.value || loadingProject.value) return;
  formError.value = '';
  const extension = /\.([a-z0-9]+)$/iu.exec(file.name)?.[1]?.toLowerCase() || '';
  const documentMimeType = documentExtensionMime[extension] || (acceptsMimeTypes.value.includes(file.type) ? file.type : null);
  if (documentMimeType) {
    // 文档形态：前端只读原文件为附件（不超过 4MB），文本提取在服务端受控完成。
    if (!acceptsDocument.value) { formError.value = '当前材料类别仅接受 JSON 文本；文档附件仅支持业务需求、接口说明与业务规则。'; return; }
    if (file.size > maxAttachmentBytes) { formError.value = '文档附件必须小于 4MB；请拆分后上传。'; return; }
    const generation = ++fileGeneration;
    const selection = projectGeneration;
    readingFile.value = true;
    try {
      const buffer = await file.arrayBuffer();
      if (disposed || generation !== fileGeneration || selection !== projectGeneration) return;
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      const base64 = btoa(binary);
      materialAttachment.value = { mimeType: documentMimeType, dataUrl: `data:${documentMimeType};base64,${base64}` };
      materialText.value = '';
      materialName.value = materialName.value.trim() || file.name.slice(0, 160);
      notice.value = '文档已就绪：服务端将登记受控提取文本与解析取证，原文件不会保存。点击保存后提交。';
    } catch (error) {
      if (!disposed && generation === fileGeneration) formError.value = errorMessage(error, '本地文档读取失败。');
    } finally {
      if (!disposed && generation === fileGeneration) readingFile.value = false;
    }
    return;
  }
  if (!/\.(json|txt)$/iu.test(file.name)) { formError.value = '请选择 UTF-8 编码的 .json / .txt 文件，或当前类别支持的 .pdf / .docx / .xlsx 文档。'; return; }
  if (file.size > byteLimit.value) { formError.value = '文件超过材料大小限制，请缩减内容。'; return; }
  const generation = ++fileGeneration;
  const selection = projectGeneration;
  readingFile.value = true;
  try {
    const text = await file.text();
    if (disposed || generation !== fileGeneration || selection !== projectGeneration) return;
    if (new TextEncoder().encode(text).byteLength > byteLimit.value) throw new Error('文件内容超过材料大小限制。');
    materialName.value = file.name.slice(0, 160);
    materialText.value = text;
    materialAttachment.value = null;
    notice.value = '文件已读入编辑区；点击保存后才会提交材料。';
  } catch (error) {
    if (!disposed && generation === fileGeneration) formError.value = errorMessage(error, '本地文件读取失败。');
  } finally {
    if (!disposed && generation === fileGeneration) readingFile.value = false;
  }
}

function removeAttachment() {
  materialAttachment.value = null;
  formError.value = '';
  notice.value = '';
}

async function saveMaterial() {
  if (!canSave.value) return;
  const id = project.value.id;
  const hadConnection = Boolean(project.value.connection);
  const selection = projectGeneration;
  const generation = ++saveGeneration;
  const payload = materialAttachment.value
    ? { expectedRevision: project.value.revision, kind: materialKind.value, name: materialName.value.trim(), attachment: { mimeType: materialAttachment.value.mimeType, dataUrl: materialAttachment.value.dataUrl } }
    : { expectedRevision: project.value.revision, kind: materialKind.value, name: materialName.value.trim(), text: materialText.value };
  saving.value = true;
  formError.value = '';
  notice.value = '';
  resetConnectionView(false);
  try {
    const result = await props.client.saveOnboardingMaterial(id, payload);
    if (disposed || generation !== saveGeneration || selection !== projectGeneration || selectedId.value !== id) return;
    if (result?.project?.id !== id) throw new Error('保存结果与当前项目不一致，请刷新核对。');
    project.value = result.project;
    updateList(result.project);
    const issues = result.project.materials?.find(item => item.kind === payload.kind)?.issues || [];
    notice.value = issues.length || allIssues.value.length
      ? '材料已登记，仍有需要补充或修正的内容，请按问题提示继续修订。'
      : hadConnection
        ? '材料已登记；此前模拟连接与预览已失效，请重新测试。尚未连接真实业务系统、发布模型或完成智能验证。'
        : '材料已登记，材料准备进度已更新。尚未连接真实业务系统、发布模型或完成智能验证。';
    if (!issues.length) resetEditor();
  } catch (error) {
    if (!disposed && generation === saveGeneration && selection === projectGeneration) {
      conflict.value = error?.status === 409;
      formError.value = conflict.value ? '项目已被更新，本次内容未覆盖服务器版本。请刷新项目、核对后重新保存。' : errorMessage(error, '材料保存失败。');
    }
  } finally {
    if (!disposed && generation === saveGeneration) saving.value = false;
  }
}

async function loadPreview(objectType = previewObjectType.value) {
  if (!canPreview.value || (previewLoading.value && requestedPreviewObject === objectType)) return;
  const id = project.value.id;
  const revision = project.value.revision;
  const selection = projectGeneration;
  const generation = ++previewGeneration;
  requestedPreviewObject = objectType;
  previewObjectType.value = objectType;
  preview.value = null;
  previewLoading.value = true;
  previewError.value = '';
  try {
    const result = await props.client.onboardingPreview(id, objectType || undefined);
    if (disposed || generation !== previewGeneration || selection !== projectGeneration || project.value?.id !== id || project.value?.revision !== revision) return;
    if (result?.projectId !== id || result.revision !== revision || result.sourceKind !== 'local_mock_http'
      || !Array.isArray(result.fields) || !Array.isArray(result.rows) || (objectType && result.objectType !== objectType)) {
      throw Object.assign(new Error('预览与当前项目或版本不一致，请刷新项目后重试。'), { status: 409 });
    }
    preview.value = result;
    previewObjectType.value = result.objectType;
    previewObjects.value = Array.isArray(result.objects) && result.objects.length ? result.objects : [{ objectType: result.objectType, system: result.system, totalRows: result.totalRows }];
  } catch (error) {
    if (!disposed && generation === previewGeneration && selection === projectGeneration) {
      if (error?.status === 409) conflict.value = true;
      previewError.value = error?.status === 409 ? '模拟连接或预览版本已失效，请刷新项目后重新测试连接。' : errorMessage(error, '合成数据预览加载失败，请重试。');
    }
  } finally {
    if (!disposed && generation === previewGeneration) previewLoading.value = false;
  }
}

async function testConnection() {
  if (!canTestConnection.value) return;
  const id = project.value.id;
  const selection = projectGeneration;
  const generation = ++connectionGeneration;
  const payload = { expectedRevision: project.value.revision, faultMode: faultMode.value };
  testingConnection.value = true;
  notice.value = '';
  resetConnectionView(false);
  let loadDefaultPreview = false;
  try {
    const result = await props.client.testOnboardingConnection(id, payload);
    if (disposed || generation !== connectionGeneration || selection !== projectGeneration || selectedId.value !== id) return;
    if (result?.project?.id !== id) throw new Error('连接测试结果与当前项目不一致，请刷新核对。');
    project.value = result.project;
    updateList(result.project);
    loadDefaultPreview = connectionVerified.value;
    connectionNotice.value = loadDefaultPreview
      ? '本地模拟 HTTP 连接测试通过。下面仅展示本项目的合成样本，不代表真实业务系统已接入。'
      : '模拟连接测试未通过，请查看下方结果；选择正常响应可重新验证。';
  } catch (error) {
    if (!disposed && generation === connectionGeneration && selection === projectGeneration) {
      if (error?.status === 409) conflict.value = true;
      connectionError.value = error?.status === 409 ? '项目版本或材料状态已变化，请刷新项目、核对材料后重新测试。' : errorMessage(error, '模拟连接测试请求失败，请重试。');
    }
  } finally {
    if (!disposed && generation === connectionGeneration) testingConnection.value = false;
  }
  if (loadDefaultPreview && !disposed && generation === connectionGeneration && selection === projectGeneration) await loadPreview('');
}

onMounted(loadOverview);
onBeforeUnmount(() => { disposed = true; overviewGeneration += 1; projectGeneration += 1; fileGeneration += 1; createGeneration += 1; saveGeneration += 1; connectionGeneration += 1; previewGeneration += 1; });
</script>

<template>
  <section class="onboarding-workspace" aria-label="企业接入材料工作区">
    <div class="onboarding-heading">
      <div><span class="eyebrow">ENTERPRISE ONBOARDING · MOCK</span><h2>从业务场景开始，备齐接入材料</h2><p>项目归属当前已认证企业，场景选择不会切换租户。</p></div>
      <span class="synthetic-badge">合成模拟模式</span>
    </div>
    <p class="onboarding-boundary">本阶段支持材料准备与本地模拟 HTTP 连接测试，仅限非生产环境的纯合成数据。材料齐备和模拟测试通过不代表已连接真实业务系统、已发布模型或已完成智能验证；不会自动调用模型。</p>
    <p v-if="!writable && !loading" class="read-only-state" role="status">当前为只读模式：可查看项目、连接结果和有效预览；创建、修订材料及启动连接测试需要运营编辑权限。</p>
    <div v-if="overviewError" class="error-state" role="alert">{{ overviewError }}<button type="button" :disabled="loading || busy" @click="loadOverview">重试加载</button></div>

    <form class="project-create" aria-label="创建模拟接入项目" data-testid="create-project-form" @submit.prevent="createProject">
      <label>选择业务场景<select v-model="scenarioId" data-testid="scenario-select" :disabled="!writable || loading || busy || !scenarios.length"><option v-if="!scenarios.length" value="">{{ loading ? '正在加载场景…' : '暂无可用场景' }}</option><option v-for="scenario in scenarios" :key="scenario.id" :value="scenario.id">{{ scenario.label }}</option></select></label>
      <label>项目名称<input v-model="projectName" data-testid="project-name" maxlength="100" placeholder="例如：华东工厂履约接入准备" :disabled="!writable || loading || busy" required /></label>
      <button class="primary-button" data-testid="create-project" :disabled="!writable || loading || busy || !scenarioId || !projectName.trim()">{{ creating ? '正在建立…' : '建立空白项目' }}</button>
      <div v-if="currentScenario" class="scenario-detail"><p>{{ currentScenario.description }}</p><span>涉及系统：{{ currentScenario.systems?.join(' / ') || '待补充' }}</span><ul><li v-for="question in currentScenario.questions" :key="question">{{ question }}</li></ul></div>
    </form>
    <p v-if="formError" class="error-state" data-testid="form-error" role="alert">{{ formError }}</p>
    <p v-if="notice" class="notice-state" data-testid="notice" role="status">{{ notice }}</p>
    <p v-if="loading" class="loading-state" role="status">正在加载接入项目与材料要求…</p>

    <div class="onboarding-columns">
      <aside class="project-list" aria-label="当前企业接入项目">
        <div class="section-heading"><h3>接入项目 <small>{{ projects.length }}</small></h3><button type="button" data-testid="refresh-overview" :disabled="loading || busy" @click="loadOverview">刷新</button></div>
        <p v-if="!loading && !projects.length" class="empty-state">还没有接入项目。选择一个业务场景，为当前企业建立空白项目。</p>
        <button v-for="item in projects" :key="item.id" type="button" :data-testid="`project-${item.id}`" class="project-card" :class="{ selected: selectedId === item.id }" :aria-pressed="selectedId === item.id" :disabled="loading || busy" @click="selectProject(item.id)"><strong>{{ item.name }}</strong><span>{{ scenarios.find(scenario => scenario.id === item.scenarioId)?.label || item.scenarioId }}</span><small>{{ statusLabel(item) }} · {{ item.readiness?.completed || 0 }}/{{ item.readiness?.total || 5 }}</small></button>
      </aside>

      <div class="project-detail" :aria-busy="loadingProject">
        <p v-if="loadingProject" class="loading-state" role="status">正在加载项目材料…</p>
        <div v-if="projectError" class="error-state" role="alert">{{ projectError }}<button type="button" :disabled="loadingProject || busy" @click="selectProject(selectedId, conflict)">重试项目</button></div>
        <template v-if="project && !loadingProject">
          <div class="section-heading project-title"><div><span class="eyebrow">{{ projectScenario?.label || project.scenarioId }}</span><h3 data-testid="project-title">{{ project.name }}</h3><small>修订 {{ project.revision }} · {{ statusLabel(project) }}</small></div><button type="button" data-testid="refresh-project" :disabled="busy" @click="selectProject(selectedId, true)">刷新项目{{ conflict ? '并保留编辑' : '' }}</button></div>
          <div class="readiness-summary"><div><strong>材料准备 {{ completed }}/{{ total }}</strong><span>{{ progress }}%</span></div><progress :value="completed" :max="total" aria-label="材料准备进度"/><p>{{ project.readiness?.nextAction || '请根据材料清单继续补充。' }}</p></div>
          <p v-if="project.boundary" class="project-boundary">{{ project.boundary }}</p>
          <ol v-if="project.milestones?.length" class="milestones" aria-label="接入阶段"><li v-for="milestone in project.milestones" :key="milestone.id"><span :class="milestone.status">{{ stageLabel(milestone.status) }}</span><strong>{{ milestone.label }}</strong><small>{{ milestone.detail }}</small></li></ol>
          <div v-if="allIssues.length" class="issue-list" data-testid="material-issues" role="status"><h4>待修订问题</h4><ul><li v-for="issue in allIssues" :key="issue">{{ issue }}</li></ul></div>
          <section class="material-checklist" aria-label="五类材料清单">
            <h4>材料清单与缺项</h4>
            <article v-for="kind in materialKinds" :key="kind.kind"><div><strong>{{ kind.label }}</strong><span :class="{ available: materialFor(kind.kind) && !missingFor(kind.kind) && !materialFor(kind.kind)?.issues?.length }">{{ !materialFor(kind.kind) ? '未提交' : missingFor(kind.kind) || materialFor(kind.kind)?.issues?.length ? '待修订' : '已登记' }}</span></div><p>{{ missingFor(kind.kind)?.reason || (materialFor(kind.kind) ? `${materialFor(kind.kind).name} · ${materialFor(kind.kind).bytes} 字节` : '请准备并提交该类材料。') }}</p><small v-if="materialFor(kind.kind)">{{ materialFor(kind.kind).name }} · 可提交新内容替换修订</small></article>
          </section>
          <section class="mock-connection" aria-label="本地模拟连接与合成数据预览">
            <div class="section-heading"><div><span class="eyebrow">LOCAL MOCK HTTP · SYNTHETIC ONLY</span><h4>模拟连接与数据预览</h4></div><span class="synthetic-badge">纯合成 · 非生产</span></div>
            <p class="connection-help">五类材料就绪后，由你手动测试本地模拟数据通道。故障选项用于检查拒绝异常响应的表现；不访问真实业务系统。</p>
            <div class="connection-actions"><label>响应模式<select v-model="faultMode" data-testid="connection-fault" :disabled="!writable || busy || conflict"><option v-for="mode in faultModes" :key="mode.value" :value="mode.value">{{ mode.label }}</option></select></label><button type="button" class="primary-button" data-testid="test-connection" :disabled="!canTestConnection" @click="testConnection">{{ testingConnection ? '正在测试本地连接…' : '测试模拟连接' }}</button></div>
            <p v-if="!materialsReady" class="connection-help">请先补齐并修正五类材料，才能启动模拟连接测试。</p>
            <p v-if="connectionError" class="error-state" data-testid="connection-error" role="alert">{{ connectionError }}</p>
            <p v-if="connectionNotice" class="notice-state" role="status">{{ connectionNotice }}</p>
            <div v-if="connection" class="connection-result" data-testid="connection-result" :class="{ verified: connectionVerified }">
              <strong>{{ connectionVerified ? '本地合成 HTTP 已验证' : '模拟连接未通过' }}</strong><small>测试时间：{{ displayTime(connection.checkedAt) }} · 材料修订 {{ connection.materialRevision }}</small>
              <dl><div><dt>来源系统</dt><dd>{{ connection.systems?.join(' / ') || '—' }}</dd></div><div><dt>记录 / 分页</dt><dd>{{ connection.recordCount || 0 }} / {{ connection.pageCount || 0 }}</dd></div><div><dt>模拟 HTTP 请求</dt><dd>{{ Array.isArray(connection.requests) ? connection.requests.length : connection.requests || 0 }}</dd></div><div><dt>本次响应模式</dt><dd>{{ faultModes.find(mode => mode.value === connection.faultMode)?.label || connection.faultMode }}</dd></div></dl>
              <p v-if="connection.issue" class="connection-issue" data-testid="connection-issue" role="alert">{{ connection.issue.message }}<small>{{ connection.issue.code }}</small></p>
            </div>
            <p v-else class="connection-empty">尚无有效连接结果。修改材料会使之前的连接结果与预览失效，需要重新测试。</p>
            <div v-if="connectionVerified" class="preview-workspace">
              <div class="preview-actions"><label v-if="previewObjects.length">预览对象<select v-model="previewObjectType" data-testid="preview-object" :disabled="busy || conflict" @change="loadPreview(previewObjectType)"><option v-for="item in previewObjects" :key="item.objectType" :value="item.objectType">{{ item.objectType }} · {{ item.system }} · {{ item.totalRows }} 条</option></select></label><button type="button" data-testid="load-preview" :disabled="!canPreview || previewLoading" @click="loadPreview()">{{ previewLoading ? '正在读取合成样本…' : preview ? '刷新预览' : '读取合成数据预览' }}</button></div>
              <p v-if="previewError" class="error-state" data-testid="preview-error" role="alert">{{ previewError }}</p>
              <p v-if="previewLoading" class="loading-state" role="status">正在读取当前项目的合成数据…</p>
              <template v-if="preview && !previewLoading">
                <p class="preview-caption" data-testid="preview-caption">{{ preview.objectType }} · {{ preview.system }} · 项目修订 {{ preview.revision }} · 共 {{ preview.totalRows }} 条，仅展示前 {{ previewRows.length }} 条{{ preview.truncated ? '（预览已截断）' : '' }}。</p>
                <div class="preview-table-scroll" tabindex="0" aria-label="合成样本字段与前十行"><table data-testid="preview-table"><caption>纯合成样本 · 最多 10 行</caption><thead><tr><th v-for="field in preview.fields" :key="field.name" scope="col">{{ field.name }}<small>{{ field.type }}{{ field.required ? ' · 必填' : '' }}</small></th></tr></thead><tbody><tr v-for="(row, index) in previewRows" :key="index"><td v-for="field in preview.fields" :key="field.name">{{ previewCell(row[field.name]) }}</td></tr></tbody></table></div>
                <p v-if="!previewRows.length" class="connection-help">此对象没有可预览的合成记录。</p>
              </template>
            </div>
          </section>
          <SemanticOnboardingAlignment :client="client" :project="project" :can-write="writable" :blocked="creating || saving || readingFile || testingConnection || handingOff || calculating || conflict" @busy="alignmentBusy = $event" @updated="alignmentUpdated" />
          <SemanticOnboardingCalculation :client="client" :project="project" :can-write="writable" :blocked="creating || saving || readingFile || testingConnection || handingOff || alignmentBusy || conflict" @busy="calculating = $event" @open-model="emit('open-model')" />
          <section class="mock-connection" aria-label="建模交接"><h4>交给元域智语 Agent 校对</h4><p>需先验证业务映射并为每条规则绑定当前材料摘录。再次读取完整模拟快照后生成候选结构；不会自动编译指标、采纳草稿或发布模型。</p><button type="button" data-testid="handoff-model" :disabled="!writable || busy || conflict || project.alignment?.status !== 'validated_scope' || project.alignment?.evidenceStatus !== 'quotes_verified'" @click="handoffModel">{{ handingOff ? '正在读取与交接…' : project.handoff?.current ? '查看 / 复用当前交接' : '生成待审阅建模任务' }}</button><template v-if="project.handoff"><p>任务：{{ project.handoff.taskId }} · {{ project.handoff.current ? '来源版本未变化' : '来源已变化，需重新验证和交接' }}</p><button type="button" :disabled="busy" @click="emit('open-agent', project.handoff.taskId)">转到 Agent 审阅</button></template></section>
          <form class="material-editor" data-testid="material-form" aria-label="登记或替换材料" @submit.prevent="saveMaterial">
            <h4>登记 / 替换材料</h4><p>支持 UTF-8 JSON / TXT 本地文件、直接粘贴内容，或在支持文档的类别上传 PDF / DOCX / XLSX（登记服务端提取文本，原文件不保存）。仅提交合成模拟材料。</p>
            <div class="material-fields"><label>材料类别<select v-model="materialKind" data-testid="material-kind" :disabled="!writable || busy || conflict"><option v-for="kind in materialKinds" :key="kind.kind" :value="kind.kind">{{ kind.label }}</option></select></label><label>材料名称<input v-model="materialName" data-testid="material-name" maxlength="160" placeholder="材料名称或文件名" :disabled="!writable || busy || conflict" required /></label></div>
            <p class="format-hint">{{ currentKind?.hint }}</p>
            <p v-if="existingMaterial" class="replacement-hint">已有材料：{{ existingMaterial.name }}{{ existingMaterial.source ? `（文档登记 · ${existingMaterial.source.mimeType} · ${existingMaterial.source.pageCount} 页 · 原文件未保存）` : '' }}。保存会替换这一类材料并生成新的项目修订。</p>
            <label class="file-picker">{{ acceptsDocument ? '读取本地文件（JSON / TXT，或 PDF / DOCX / XLSX 文档）' : '读取本地文件' }}<input type="file" data-testid="material-file" :accept="fileAccept" :disabled="!writable || busy || conflict" @change="readMaterialFile" /></label>
            <div v-if="materialAttachment" class="attachment-panel" data-testid="attachment-panel" role="status">
              <strong>{{ materialAttachment.mimeType === 'application/pdf' ? 'PDF 文档' : materialAttachment.mimeType.includes('spreadsheetml') ? 'Excel 工作簿' : 'Word 文档' }}</strong>
              <span>{{ materialName }} · {{ attachmentKilobytes }} KB · 原文件仅用于本次提取，不会保存到项目。</span>
              <small>服务端将登记受控提取文本与解析取证（页数、截断/缺页、内容扫描、脱敏信号）；提取不完整或超过 64 KiB 时整份拒绝，不做静默截断。</small>
              <button type="button" data-testid="remove-attachment" :disabled="busy" @click="removeAttachment">改用文本登记</button>
            </div>
            <label v-if="!materialAttachment">材料正文<textarea v-model="materialText" data-testid="material-text" rows="8" placeholder="粘贴本次准备的原始材料。不会自动填入预设模型或标准答案。" :disabled="!writable || busy || conflict" :required="!materialAttachment" /></label>
            <div class="editor-footer"><span :class="{ overlimit: textBytes > byteLimit }">{{ textBytes }} / {{ byteLimit }} 字节{{ readingFile ? ' · 正在读取文件…' : '' }}</span><button class="primary-button" data-testid="save-material" :disabled="!canSave">{{ saving ? '正在保存…' : existingMaterial ? '保存材料修订' : '保存材料' }}</button></div>
            <p v-if="conflict" class="conflict-state" role="alert">版本冲突：编辑内容仍保留。先点击“刷新项目并保留编辑”，核对最新状态后再次提交。</p>
          </form>
        </template>
        <p v-else-if="!loadingProject && !projectError" class="empty-detail">建立或选择项目后，这里会展示材料要求、缺项原因与下一步。</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.onboarding-workspace { color: #ddecf5; min-width: 0; font-size: 13px; line-height: 1.65; }
.onboarding-workspace :is(h2,h3,h4,p) { margin: 0; }
.onboarding-workspace :is(input,select,textarea,button) { font: inherit; }
.onboarding-workspace button { cursor: pointer; border: 1px solid #36556b; border-radius: 7px; background: #102637; color: #cfdfeb; padding: 8px 12px; }
.onboarding-workspace button:hover:not(:disabled) { border-color: #67c8c8; background: #18394a; }
.onboarding-workspace button:disabled { cursor: not-allowed; opacity: .48; }
.onboarding-workspace :is(input,select,textarea) { display: block; width: 100%; min-width: 0; padding: 9px 11px; border: 1px solid #345268; border-radius: 7px; background: #081927; color: #e2eef5; margin-top: 5px; }
.onboarding-workspace :is(input,select,textarea):disabled { opacity: .6; }
.onboarding-workspace :is(button,input,select,textarea):focus-visible { outline: 2px solid #7cddda; outline-offset: 3px; }
.onboarding-workspace textarea { resize: vertical; overflow-wrap: anywhere; min-height: 140px; }
.onboarding-workspace label { color: #b6ccda; min-width: 0; }
.onboarding-workspace .primary-button { background: #286b78; border-color: #468f99; color: #f0ffff; }
.onboarding-heading,.section-heading,.readiness-summary>div,.editor-footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.onboarding-heading { align-items: flex-start; flex-wrap: wrap; margin-bottom: 15px; }
.onboarding-heading h2 { font-size: 22px; font-weight: 600; margin: 5px 0; }
.onboarding-heading p,.scenario-detail,.empty-state,.empty-detail,.project-title small { color: #91abba; }
.eyebrow { color: #83becb; font-size: 10px; letter-spacing: .12em; }
.synthetic-badge { border: 1px solid #856c37; background: #332c1d; color: #e8c884; font-size: 11px; white-space: nowrap; padding: 5px 10px; border-radius: 20px; }
.onboarding-boundary,.read-only-state,.error-state,.notice-state,.conflict-state { padding: 11px 14px; border-radius: 8px; margin-bottom: 16px !important; overflow-wrap: anywhere; }
.onboarding-boundary { color: #d8c89f; border: 1px solid #665737; background: #2a261c; }
.read-only-state,.notice-state { color: #b6dce3; background: #14303d; border: 1px solid #365e6c; }
.error-state,.conflict-state { color: #f3c2ad; background: #392925; border: 1px solid #835948; }
.error-state button { margin-left: 10px; }
.project-create { display: grid; grid-template-columns: minmax(150px,1fr) minmax(180px,1.4fr) auto; align-items: end; gap: 12px; padding: 18px; border: 1px solid #2c4759; border-radius: 10px; background: #0c1d2b; margin-bottom: 20px; }
.scenario-detail { grid-column: 1/-1; font-size: 12px; border-top: 1px solid #274051; padding-top: 12px; }
.scenario-detail span { display: block; color: #afc8d5; margin-top: 5px; }
.scenario-detail ul { margin: 5px 0 0; padding-left: 18px; }
.onboarding-columns { display: grid; grid-template-columns: 220px minmax(0,1fr); gap: 18px; align-items: start; }
.project-list,.project-detail { min-width: 0; border: 1px solid #2a4354; border-radius: 10px; padding: 16px; background: #0a1b29; }
.section-heading { margin-bottom: 15px; flex-wrap: wrap; }
.section-heading h3 { font-size: 15px; }
.section-heading h3 small { color: #7f9eaf; padding-left: 4px; font-weight: normal; }
.section-heading>button { font-size: 11px; padding: 5px 9px; }
.project-list .project-card { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; width: 100%; text-align: left; margin-top: 9px; min-width: 0; overflow-wrap: anywhere; }
.project-card strong { font-weight: 500; }
.project-card span { font-size: 11px; color: #93b0c1; }
.project-card small { font-size: 10px; color: #8fbec8; }
.project-list .project-card.selected { border-color: #62a5b2; background: #143647; }
.project-title h3 { font-size: 19px; overflow-wrap: anywhere; }
.project-title>div { min-width: 0; }
.project-title small { font-size: 11px; }
.readiness-summary { border: 1px solid #35576a; background: #102d3b; padding: 14px; border-radius: 8px; }
.readiness-summary>div span { color: #8edbd8; }
.readiness-summary progress { width: 100%; height: 9px; accent-color: #71ceca; margin: 9px 0; }
.readiness-summary p { color: #b4d1dd; font-size: 12px; overflow-wrap: anywhere; }
.project-boundary { font-size: 11px; color: #bba981; padding: 10px 0; overflow-wrap: anywhere; }
.milestones { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(160px,100%),1fr)); gap: 9px; padding: 0; margin: 8px 0 18px; list-style: none; }
.milestones li { padding: 12px; border: 1px solid #2c4354; border-radius: 7px; background: #0c2131; min-width: 0; }
.milestones span { display: block; color: #88a0b0; font-size: 10px; }
.milestones span.complete { color: #85dbb9; }
.milestones span.ready { color: #e8c689; }
.milestones strong { display: block; font-size: 12px; margin: 4px 0; }
.milestones small { color: #90aaba; font-size: 11px; overflow-wrap: anywhere; }
.issue-list { border: 1px solid #75583d; color: #e1c095; background: #2b251e; border-radius: 7px; padding: 13px; margin: 14px 0; overflow-wrap: anywhere; }
.issue-list ul { margin: 5px 0 0; padding-left: 18px; }
.material-checklist { margin: 18px 0; }
.material-checklist h4,.material-editor h4 { font-size: 14px; margin-bottom: 9px; }
.material-checklist article { padding: 11px 0; border-bottom: 1px solid #253e4f; overflow-wrap: anywhere; }
.material-checklist article>div { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.material-checklist strong { font-size: 12px; }
.material-checklist span { color: #d7b881; font-size: 11px; }
.material-checklist span.available { color: #8cd5bd; }
.material-checklist p { color: #a8bfcc; font-size: 12px; margin-top: 4px; }
.material-checklist small { color: #7896a9; font-size: 10px; }
.mock-connection { border: 1px solid #35596b; border-radius: 9px; background: #0d2534; padding: 16px; margin: 20px 0; min-width: 0; }
.mock-connection h4 { font-size: 15px; margin-top: 3px; }
.mock-connection .section-heading { align-items: flex-start; }
.connection-help,.connection-empty,.preview-caption { font-size: 12px; color: #a3becc; overflow-wrap: anywhere; }
.connection-empty { padding-top: 10px; }
.connection-actions,.preview-actions { display: flex; align-items: flex-end; gap: 12px; margin: 14px 0; flex-wrap: wrap; }
.connection-actions label,.preview-actions label { flex: 1 1 180px; }
.connection-actions button,.preview-actions button { flex: 0 1 auto; }
.connection-result { border: 1px solid #805e49; background: #302721; border-radius: 8px; padding: 13px; margin-top: 12px; overflow-wrap: anywhere; }
.connection-result.verified { border-color: #396c65; background: #122f32; }
.connection-result>strong { color: #e8c09d; display: block; font-size: 13px; }
.connection-result.verified>strong { color: #99d8c3; }
.connection-result>small { color: #a0b8c5; font-size: 10px; display: block; margin-top: 5px; }
.connection-result dl { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; margin: 12px 0 0; }
.connection-result dt { color: #93aebc; font-size: 10px; }
.connection-result dd { margin: 0; font-size: 12px; color: #d1e3eb; }
.connection-result .connection-issue { margin-top: 12px; color: #f2bda4; font-size: 12px; }
.connection-issue small { display: block; color: #caa18d; font-size: 10px; margin-top: 3px; }
.preview-workspace { min-width: 0; margin-top: 15px; border-top: 1px solid #2f5264; padding-top: 3px; }
.preview-table-scroll { overflow-x: auto; max-width: 100%; border: 1px solid #355468; border-radius: 6px; margin-top: 10px; }
.preview-table-scroll:focus-visible { outline: 2px solid #7cddda; outline-offset: 3px; }
.preview-table-scroll table { border-collapse: collapse; min-width: 100%; text-align: left; font-size: 11px; }
.preview-table-scroll caption { text-align: left; padding: 9px 12px; color: #91bbcb; background: #102b3d; }
.preview-table-scroll th { background: #153447; color: #d0e4ef; font-weight: 500; }
.preview-table-scroll :is(th,td) { padding: 9px 12px; border-bottom: 1px solid #294658; min-width: 120px; max-width: 300px; overflow-wrap: anywhere; vertical-align: top; }
.preview-table-scroll th small { display: block; color: #92b0c1; font-size: 10px; margin-top: 3px; }
.preview-table-scroll tbody tr:nth-child(even) { background: #102b3a; }
.material-editor { border-top: 1px solid #345266; padding-top: 18px; }
.material-editor>p { color: #8faabd; font-size: 12px; margin-bottom: 13px; }
.material-fields { display: grid; grid-template-columns: minmax(120px,1fr) minmax(160px,1.5fr); gap: 12px; margin-bottom: 12px; }
.material-editor .format-hint { color: #abc9d9; background: #102638; padding: 10px; border-radius: 5px; overflow-wrap: anywhere; }
.material-editor .replacement-hint { color: #cdbb99; }
.file-picker { display: block; margin-bottom: 13px; }
.file-picker input { font-size: 12px; padding: 8px; }
.attachment-panel { border: 1px solid #3d6474; background: #10303f; border-radius: 7px; padding: 12px 14px; margin-bottom: 13px; overflow-wrap: anywhere; }
.attachment-panel strong { color: #9fd9d2; font-size: 12px; }
.attachment-panel span { display: block; color: #c4dae5; font-size: 12px; margin-top: 4px; }
.attachment-panel small { display: block; color: #94b2c2; font-size: 11px; margin-top: 5px; }
.attachment-panel button { margin-top: 9px; font-size: 11px; padding: 5px 9px; }
.editor-footer { margin-top: 12px; flex-wrap: wrap; }
.editor-footer span { font-size: 11px; color: #8ea9ba; }
.editor-footer .overlimit { color: #f0ad8e; }
.material-editor .conflict-state { margin-top: 12px !important; color: #f3c2ad; }
.loading-state { padding: 14px; color: #9dcbd8; }
.empty-detail { padding: 45px 20px; text-align: center; }
@media (max-width: 1180px) { .onboarding-columns { grid-template-columns: 190px minmax(0,1fr); gap: 12px; } .project-create { grid-template-columns: 1fr 1fr; } .project-create>.primary-button { grid-column: 1/-1; justify-self: start; } }
@media (max-width: 900px) { .onboarding-columns { grid-template-columns: minmax(0,1fr); } .project-list { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(190px,100%),1fr)); gap: 8px; } .project-list .section-heading,.project-list .empty-state { grid-column: 1/-1; margin: 0; } .project-list .project-card { margin: 0; } }
@media (max-width: 600px) { .project-create,.material-fields { grid-template-columns: minmax(0,1fr); } .project-create { padding: 14px; } .project-create>.primary-button { justify-self: stretch; } .project-detail { padding: 13px; } .onboarding-heading h2 { font-size: 18px; } .editor-footer { align-items: stretch; flex-direction: column; } .file-picker input { max-width: 100%; } }
@media (max-width: 600px) { .mock-connection { padding: 12px; } .connection-actions,.preview-actions { align-items: stretch; flex-direction: column; } .connection-actions label,.preview-actions label { flex-basis: auto; } .connection-result dl { grid-template-columns: minmax(0,1fr); } }
</style>

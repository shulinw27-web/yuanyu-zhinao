<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { WorldModelTemplateConfig } from '@healthcare-ai/agent-ui/system-access';

// 系统接入视图（阶段 2）。
//
// 定位：元域智语端的「系统接入」取代原「企业接入」的主视角，材料准备降为同页次级标签。
// 数据来源：/api/semantic-operations/systems*（后端 system-onboarding 域）。
//
// 权限分界（与后端一致，不在此处放宽；阶段 6 等价合并后 world.draft.* 已删）：
//   canProbe          → meta_model.draft.save：连通性探测是接入侧写入
//   canConfigureMapping → meta_model.draft.save：映射草稿与接入侧写入同一把闸门
//   canReadMapping    → page.world.view：读取连接模板/目标/草稿的页面门槛
const props = defineProps({
  client: { type: Object, required: true },
  role: { type: String, default: '' },
  buttonPermissionIds: { type: Array, default: () => [] },
  canProbe: { type: Boolean, default: false },
  canConfigureMapping: { type: Boolean, default: false },
  canReadMapping: { type: Boolean, default: false }
});
const emit = defineEmits(['open-agent']);

const filters = [
  { id: 'all', label: '全部' },
  { id: 'connected', label: '已连通' },
  { id: 'suspended', label: '已停用' },
  { id: 'pending', label: '待接入' },
  { id: 'unregistered', label: '未登记' },
  { id: 'probeable', label: '可探测' },
  { id: 'unauthorized', label: '未授权' }
];

const overview = ref(null);
const detail = ref(null);
const templates = ref([]);
const targets = ref([]);
const drafts = ref([]);
const selectedCode = ref('');
const filter = ref('all');
const faultMode = ref('none');
const mappingMessage = ref('');
const transitionReason = ref('');
const lifecycleMessage = ref('');
const transitioning = ref(false);
const loading = ref(false);
const detailLoading = ref(false);
const probing = ref(false);
const creatingDraft = ref(false);
const error = ref('');
const detailError = ref('');
const probeError = ref('');
const notice = ref('');
let disposed = false;
let overviewGeneration = 0;
let detailGeneration = 0;

const systems = computed(() => overview.value?.systems || []);
const faults = computed(() => detail.value?.faults || []);
const selected = computed(() => systems.value.find((item) => item.code === selectedCode.value) || null);
const selectedTarget = computed(() => targets.value.find((item) => item.id === selected?.value?.id) || null);
const selectedTemplate = computed(() => templates.value.find((item) => item.targets?.includes(selected.value?.id)) || null);
const selectedDraft = computed(() => drafts.value.find((item) => item.targetId === selected.value?.id && item.status !== 'published')
  || drafts.value.find((item) => item.targetId === selected.value?.id) || null);
const canProbeSelected = computed(() => props.canProbe && selected.value?.probe?.supported === true && !probing.value);
const probeDisabledReason = computed(() => {
  if (!props.canProbe) return '当前营运身份没有 meta_model.draft.save 权限，接入侧写入（含连通性探测）被拒绝。';
  if (!selected.value) return '请先选择一个系统。';
  if (!selected.value.connector) return '该系统尚未登记受控连接器，不能探测。';
  if (!selected.value.authorized) return '当前身份未获该系统所属数据域授权，探测被显式阻断。';
  if (!selected.value.probe.supported) return '本次演示环境没有该系统的本地合成数据源，无法探测。';
  return '';
});
const visibleSystems = computed(() => systems.value.filter((item) => {
  if (filter.value === 'connected') return item.lifecycleState === 'connected';
  if (filter.value === 'pending') return item.lifecycleState === 'registered' || item.lifecycleState === 'authorized';
  if (filter.value === 'unregistered') return item.lifecycleState === 'draft';
  if (filter.value === 'probeable') return item.probe.supported;
  if (filter.value === 'unauthorized') return item.authorized === false;
  return true;
}));

const displayTime = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '—';
const healthLabel = (item) => item?.health ? `${item.health.status} · ${item.health.health}%` : '—';
const probeStatusLabel = (probe) => ({
  verified: '连通性已验证（合成数据源）', schema_drift: '连通但字段目录漂移', failed: '连通性未通过',
  no_local_dataset: '无本地合成数据源'
})[probe?.status] || probe?.status || '尚未探测';
const errorMessage = (err, fallback) => {
  if (err?.status === 401 || err?.status === 403) return '当前身份没有执行此操作的权限，请重新登录或联系管理员。';
  if (err?.status === 404) return '系统不存在或当前身份无权访问，请刷新接入总览。';
  return err?.message || fallback;
};

async function loadMappingSurface() {
  if (!props.canReadMapping) { templates.value = []; targets.value = []; drafts.value = []; return; }
  try {
    const [templateResult, targetResult, draftResult] = await Promise.all([
      props.client.systemAccessMappingTemplates(), props.client.systemAccessConnectionTargets(), props.client.systemAccessMappingDrafts()
    ]);
    if (disposed) return;
    templates.value = templateResult.templates || [];
    targets.value = targetResult.targets || [];
    drafts.value = draftResult.drafts || [];
  } catch (err) {
    if (!disposed) mappingMessage.value = errorMessage(err, '元模型连接模板加载失败。');
  }
}

async function loadOverview() {
  const generation = ++overviewGeneration;
  loading.value = true;
  error.value = '';
  try {
    const result = await props.client.systemAccess();
    if (disposed || generation !== overviewGeneration) return;
    overview.value = result;
    const codes = (result.systems || []).map((item) => item.code);
    if (!codes.includes(selectedCode.value)) selectedCode.value = codes[0] || '';
    if (selectedCode.value) await selectSystem(selectedCode.value);
  } catch (err) {
    if (!disposed && generation === overviewGeneration) error.value = errorMessage(err, '系统接入总览加载失败，请重试。');
  } finally {
    if (!disposed && generation === overviewGeneration) loading.value = false;
  }
}

async function selectSystem(code) {
  if (!code) return;
  const generation = ++detailGeneration;
  selectedCode.value = code;
  detailLoading.value = true;
  detailError.value = '';
  probeError.value = '';
  notice.value = '';
  try {
    const result = await props.client.systemAccessDetail(code);
    if (disposed || generation !== detailGeneration || selectedCode.value !== code) return;
    detail.value = result;
    faultMode.value = 'none';
  } catch (err) {
    if (!disposed && generation === detailGeneration) { detail.value = null; detailError.value = errorMessage(err, '系统详情加载失败。'); }
  } finally {
    if (!disposed && generation === detailGeneration) detailLoading.value = false;
  }
}

async function probe() {
  if (!canProbeSelected.value) return;
  const code = selectedCode.value;
  const generation = detailGeneration;
  probing.value = true;
  probeError.value = '';
  notice.value = '';
  try {
    const result = await props.client.probeSystemConnection(code, { faultMode: faultMode.value });
    if (disposed || generation !== detailGeneration) return;
    notice.value = result.status === 'verified'
      ? `已完成一次真实的分页只读读取：${result.requests} 次请求 / ${result.pageCount} 页 / ${result.recordCount} 条记录。这是内置合成数据源，不等于真实企业系统已接入。`
      : `连通性探测未通过（${probeStatusLabel(result)}）。结果已记录，未被当作成功。`;
    await selectSystem(code);
  } catch (err) {
    if (!disposed && generation === detailGeneration) probeError.value = errorMessage(err, '连通性探测请求失败。');
  } finally {
    if (!disposed) probing.value = false;
  }
}

async function createMappingDraft() {
  if (!props.canConfigureMapping || !selectedTemplate.value || creatingDraft.value) return;
  const code = selectedCode.value;
  const generation = detailGeneration;
  creatingDraft.value = true;
  mappingMessage.value = '';
  try {
    const result = await props.client.createSystemMappingDraft(code);
    if (disposed || generation !== detailGeneration) return;
    mappingMessage.value = result.reused
      ? '该目标系统已存在同一模板的未发布草稿，已定位到既有草稿（未产生第二份）。'
      : `已基于「${result.draft.templateName}」生成映射草稿；请继续执行字段与关系校验，尚未发布。`;
    await loadMappingSurface();
  } catch (err) {
    if (!disposed) mappingMessage.value = errorMessage(err, '映射草稿创建失败。');
  } finally {
    if (!disposed) creatingDraft.value = false;
  }
}

// 校验 / 发布沿用既有世界模型治理链路（阶段 6 等价合并后为 meta_model.draft.validate / meta_model.publish）。
// 这里不做任何本地「假装通过」：状态与校验结论都由服务端返回后重新拉取草稿列表得到。
async function governMappingDraft(action, draftId) {
  const code = selectedCode.value;
  const generation = detailGeneration;
  creatingDraft.value = true;
  mappingMessage.value = '';
  try {
    const result = action === 'validate'
      ? await props.client.validateSystemMappingDraft(code, draftId)
      : await props.client.publishSystemMappingDraft(code, draftId);
    if (disposed || generation !== detailGeneration) return;
    if (action === 'validate') {
      mappingMessage.value = result.draft.validation.status === 'passed'
        ? '映射校验通过，已具备提交发布的条件。'
        : '映射校验未通过，请补齐主键、字段、关系或数据分级。';
    } else {
      mappingMessage.value = `世界模型版本 ${result.draft.version} 已发布（Demo 模拟，未写入真实系统）。`;
    }
    await loadMappingSurface();
  } catch (err) {
    if (!disposed) mappingMessage.value = errorMessage(err, '映射草稿治理操作失败。');
  } finally {
    if (!disposed) creatingDraft.value = false;
  }
}

function sendToAgent() {
  if (!detail.value) return;
  const objectTypes = detail.value.fieldCatalog.objectTypes.slice(0, 6).join('、') || '该系统的字段目录';
  emit('open-agent', `依据 ${detail.value.system.code}（${detail.value.system.name}）的 ${objectTypes} 建立语义模型。`);
}

// ── 接入生命周期操作面（2026-09-26 新增） ───────────────────────────────────
// 状态机由服务端定义（draft→registered→authorized→connected⇄suspended），前端只把
// 「当前允许的下一步」渲染成可执行动作；接通（→connected）的服务端门禁是
// 「最近一次连通性探测 verified」，这里只做同一条门禁的预判提示，不做本地放行。
const LIFECYCLE_STEPS = Object.freeze([
  { id: 'draft', label: '未登记' },
  { id: 'registered', label: '已登记' },
  { id: 'authorized', label: '已授权' },
  { id: 'connected', label: '已连通' }
]);
const TRANSITION_LABELS = Object.freeze({
  registered: '登记接入',
  authorized: '确认数据域授权',
  connected: '接通系统',
  suspended: '停用接入',
  draft: '退回 / 下线登记'
});
const lifecycleStepIndex = (state) => LIFECYCLE_STEPS.findIndex((step) => step.id === state);

const lifecycleActions = computed(() => (detail.value?.lifecycle?.transitions || []).map((to) => {
  const noWrite = !props.canProbe
    ? '当前营运身份没有 meta_model.draft.save 权限，接入状态操作被拒绝。' : '';
  const needsProbe = to === 'connected' && detail.value?.lastProbe?.status !== 'verified'
    ? '接通前必须先完成一次通过验证的连通性测试（verified），再到本面板执行接通。' : '';
  const disabledReason = needsProbe || noWrite;
  return { to, label: TRANSITION_LABELS[to] || to, disabled: Boolean(disabledReason), disabledReason };
}));

async function runTransition(to) {
  if (transitioning.value) return;
  if (!transitionReason.value.trim()) {
    lifecycleMessage.value = '请填写操作理由（必填，不超过 200 字），操作人、时间与理由都会进入审计记录。';
    return;
  }
  const code = selectedCode.value;
  const generation = detailGeneration;
  transitioning.value = true;
  lifecycleMessage.value = '';
  try {
    const result = await props.client.transitionSystemConnection(code, { to, reason: transitionReason.value.trim() });
    if (disposed || generation !== detailGeneration) return;
    lifecycleMessage.value = `接入状态已推进：${result.from} → ${result.to}（${result.lifecycle.label}），操作人与时间已记录。`;
    transitionReason.value = '';
    await loadOverview();
    await selectSystem(code);
  } catch (err) {
    if (!disposed) lifecycleMessage.value = errorMessage(err, '接入状态推进失败。');
  } finally {
    if (!disposed) transitioning.value = false;
  }
}

// ── 新增接入：登记自定义系统（ADR-024）────────────────────────────────────
// 接入清单不再预设备待接入/未登记系统，「新增接入」是租户提交接入物料、任意命名的
// 登记动作。必填项的定义（名称/业务域/定位说明/核心对象/数据域/接入目的/责任人）
// 由服务端总览的 registration schema 下发，前端只按 schema 渲染与预检，
// 不在本地复制第二份字段规则；系统码缺省由服务端生成并防撞。
const registrationOpen = ref(false);
const registrationForm = ref(null);
const registrationIssues = ref([]);
const registrationMessage = ref('');
const registering = ref(false);

const registrationSchema = computed(() => overview.value?.registration || null);
const registrationFields = computed(() => registrationSchema.value?.fields || []);
const registrationDataDomains = computed(() => registrationSchema.value?.dataDomains || []);
const registrationScenarios = computed(() => registrationSchema.value?.mockScenarios || []);
const registrationAuthSchemes = computed(() => registrationSchema.value?.authSchemes || []);
const isLongText = (key) => key === 'description' || key === 'accessIntention';

function openRegistration() {
  registrationForm.value = {
    name: '', domain: '', description: '', keyEntities: '', dataDomains: [],
    accessIntention: '', businessOwner: '', code: '', vendor: '', mockScenarioId: '',
    // 连接配置段（ADR-028）
    heartbeat: { endpoint: '', method: 'GET', expectedStatus: 200, expectedBody: '', timeoutMs: 5000 },
    auth: { scheme: 'user_token_passthrough', credentialRef: '', scope: [], writeApprovalRequired: true },
    attachmentDocuments: []
  };
  registrationIssues.value = [];
  registrationMessage.value = '';
  registrationOpen.value = true;
}

function toggleRegistrationDomain(domainId) {
  const list = registrationForm.value?.dataDomains || [];
  const index = list.indexOf(domainId);
  if (index >= 0) list.splice(index, 1); else list.push(domainId);
}

// 读取登记时附加的文档物料（ADR-028）：只读成 dataUrl 存入 form，
// 提交时随 payload 发给后端走 5a 安全闸门（提取文本+取证持久化、原文件不落地）。
async function readRegistrationDocuments(event) {
  const files = Array.from(event.target?.files || []);
  if (event.target) event.target.value = '';
  if (!files.length) return;
  for (const file of files) {
    if (file.size > 4 * 1024 * 1024) { registrationMessage.value = `文档 ${file.name} 超过 4MB 附件侧上限。`; continue; }
    const buffer = await file.arrayBuffer();
    // 分块 base64 避免 4MB 直接 String.fromCharCode 爆栈
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const base64 = btoa(binary);
    registrationForm.value.attachmentDocuments.push({
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      dataUrl: `data:${file.type || 'application/octet-stream'};base64,${base64}`
    });
  }
}

const heartbeatReady = computed(() => {
  const hb = registrationForm.value?.heartbeat;
  return Boolean(hb && String(hb.endpoint || '').trim());
});

const authReady = computed(() => {
  const auth = registrationForm.value?.auth;
  if (!auth?.scheme) return false;
  const scheme = registrationAuthSchemes.value.find((option) => option.id === auth.scheme);
  if (scheme?.requiresCredentialRef && !String(auth.credentialRef || '').trim()) return false;
  if (scheme?.requiresCredentialRef && !(Array.isArray(auth.scope) ? auth.scope : []).length) return false;
  return true;
});

function precheckRegistration() {
  const issues = [];
  const form = registrationForm.value || {};
  for (const field of registrationFields.value) {
    if (!field.required) continue;
    const value = form[field.key];
    let missing;
    if (field.format === 'dataDomains' || field.format === 'list') {
      missing = !(Array.isArray(value) ? value : String(value || '').split(/[、,，;；]/u)).some((item) => String(item || '').trim());
    } else if (field.format === 'heartbeat') {
      missing = !heartbeatReady.value;
    } else if (field.format === 'auth') {
      missing = !authReady.value;
    } else if (field.format === 'documentAttachments') {
      missing = false; // 文档物料可选
    } else {
      missing = !String(value ?? '').trim();
    }
    if (missing) issues.push({ field: field.key, message: `${field.label}为必填项：${field.help}` });
  }
  return issues;
}

async function submitRegistration() {
  if (registering.value) return;
  if (!props.canProbe) {
    registrationMessage.value = '当前营运身份没有 meta_model.draft.save 权限，登记接入被拒绝。';
    return;
  }
  const localIssues = precheckRegistration();
  if (localIssues.length) { registrationIssues.value = localIssues; return; }
  const form = registrationForm.value;
  const generation = overviewGeneration;
  registering.value = true;
  registrationIssues.value = [];
  registrationMessage.value = '';
  try {
    const payload = {
      name: form.name.trim(),
      domain: form.domain.trim(),
      description: form.description.trim(),
      keyEntities: String(form.keyEntities || '').split(/[、,，;；\n]/u).map((item) => item.trim()).filter(Boolean),
      dataDomains: [...form.dataDomains],
      accessIntention: form.accessIntention.trim(),
      businessOwner: form.businessOwner.trim(),
      ...(form.code.trim() ? { code: form.code.trim().toUpperCase() } : {}),
      ...(form.vendor.trim() ? { vendor: form.vendor.trim() } : {}),
      ...(form.mockScenarioId ? { mockScenarioId: form.mockScenarioId } : {}),
      // 连接配置段（ADR-028）
      heartbeat: {
        endpoint: form.heartbeat.endpoint.trim(),
        method: form.heartbeat.method || 'GET',
        expectedStatus: Number(form.heartbeat.expectedStatus) || 200,
        ...(form.heartbeat.expectedBody?.trim() ? { expectedBody: form.heartbeat.expectedBody.trim() } : {}),
        timeoutMs: Number(form.heartbeat.timeoutMs) || 5000
      },
      auth: {
        scheme: form.auth.scheme,
        ...(form.auth.scheme === 'service_principal' ? {
          credentialRef: form.auth.credentialRef.trim(),
          scope: [...(form.auth.scope || [])]
        } : {}),
        writeApprovalRequired: form.auth.writeApprovalRequired !== false
      },
      ...(form.attachmentDocuments?.length ? { attachmentDocuments: form.attachmentDocuments } : {})
    };
    const result = await props.client.registerSystemOnboarding(payload);
    if (disposed || generation !== overviewGeneration) return;
    registrationOpen.value = false;
    lifecycleMessage.value = `已登记接入系统 ${result.code}（${result.name}），生命周期进入「${result.lifecycle.label}」；下一步：确认数据域授权，并执行连通性测试后接通。`;
    await loadOverview();
    await selectSystem(result.code);
  } catch (err) {
    if (!disposed) {
      registrationIssues.value = Array.isArray(err?.body?.issues) ? err.body.issues : [];
      registrationMessage.value = errorMessage(err, '登记接入失败。');
    }
  } finally {
    if (!disposed) registering.value = false;
  }
}

onMounted(async () => { await Promise.all([loadOverview(), loadMappingSurface()]); });
onBeforeUnmount(() => { disposed = true; overviewGeneration += 1; detailGeneration += 1; });
</script>

<template>
  <section class="system-access" aria-label="系统接入">
    <div class="sa-heading">
      <div><span class="eyebrow">SYSTEM ONBOARDING · TENANT SCOPED</span><h2>以系统为基石管理接入</h2><p>接入清单＝6 个 Mock 演示接入样例＋本租户自行登记的系统，不预设备待接入/未登记系统；接入生命周期与探测结果按租户隔离，每个系统都可单独查看连接配置、字段目录与映射。</p></div>
      <span class="sa-badge">合成模拟环境</span>
    </div>
    <p class="sa-boundary">{{ overview?.boundary || '系统接入视图：接入状态按租户隔离；连通性探测读取内置合成模拟数据源，不连接任何真实企业系统。' }}</p>

    <p v-if="error" class="sa-error" role="alert">{{ error }}<button type="button" :disabled="loading" @click="loadOverview">重试加载</button></p>
    <p v-if="loading && !overview" class="sa-loading" role="status">正在加载系统接入总览…</p>

    <template v-if="overview">
      <div class="sa-summary">
        <article><span>系统总数</span><b>{{ overview.summary.total }}</b></article>
        <article><span>已连通</span><b>{{ overview.summary.connected }}</b></article>
        <article><span>已停用</span><b>{{ overview.summary.suspended ?? 0 }}</b></article>
        <article><span>待接入</span><b>{{ overview.summary.pending }}</b></article>
        <article><span>未登记</span><b>{{ overview.summary.notRegistered }}</b></article>
        <article><span>本角色已授权</span><b>{{ overview.summary.authorized }}</b></article>
        <article><span>可探测</span><b>{{ overview.summary.probeable }}</b></article>
        <article><span>已配置映射</span><b>{{ overview.summary.mappedObjects }}</b></article>
      </div>

      <div class="sa-filters" role="tablist" aria-label="系统筛选">
        <button v-for="item in filters" :key="item.id" type="button" role="tab" :aria-selected="filter === item.id" :class="{ active: filter === item.id }" @click="filter = item.id">{{ item.label }}</button>
        <button type="button" class="sa-refresh" :disabled="loading" @click="loadOverview">刷新</button>
        <button type="button" class="sa-new" data-testid="start-onboarding" @click="openRegistration">＋ 新增接入</button>
      </div>

      <section v-if="registrationOpen" class="sa-panel sa-register" aria-label="新增接入登记" data-testid="register-system-form">
        <div class="sa-panel-head"><div><span class="eyebrow">SYSTEM REGISTRATION</span><h4>新增接入：登记一个系统</h4></div><button type="button" class="sa-outline" @click="registrationOpen = false">收起</button></div>
        <p class="sa-help">{{ registrationSchema?.policy }}</p>
        <div class="sa-register-grid">
          <template v-for="field in registrationFields" :key="field.key">
            <label v-if="['text', 'list', 'code'].includes(field.format)" :class="{ wide: isLongText(field.key) }">
              {{ field.label }}<em v-if="field.required"> *必填</em>
              <textarea v-if="isLongText(field.key)" v-model="registrationForm[field.key]" rows="2" :data-testid="`register-field-${field.key}`" :placeholder="field.help" :maxlength="400" />
              <input v-else v-model="registrationForm[field.key]" :data-testid="`register-field-${field.key}`" :placeholder="field.help" :maxlength="40" />
            </label>
            <fieldset v-else-if="field.format === 'dataDomains'" class="wide">
              <legend>{{ field.label }}<em> *必填</em></legend>
              <label v-for="option in registrationDataDomains" :key="option.id" class="sa-domain-option">
                <input type="checkbox" :value="option.id" :data-testid="`register-domain-${option.id}`" :checked="registrationForm.dataDomains.includes(option.id)" @change="toggleRegistrationDomain(option.id)" />
                <span>{{ option.label }}<small>{{ option.description }}</small></span>
              </label>
            </fieldset>
            <label v-else-if="field.format === 'mockScenario'">
              {{ field.label }}
              <select v-model="registrationForm.mockScenarioId" data-testid="register-field-mockScenarioId">
                <option value="">不挂接（无法连通性探测，不能接通）</option>
                <option v-for="scenario in registrationScenarios" :key="scenario.id" :value="scenario.id">{{ scenario.label }} — {{ scenario.description }}</option>
              </select>
            </label>
            <fieldset v-else-if="field.format === 'heartbeat'" class="wide sa-heartbeat" data-testid="register-field-heartbeat">
              <legend>{{ field.label }}<em> *必填</em></legend>
              <p class="sa-help">{{ field.help }}</p>
              <label class="sa-hb-endpoint">心跳 URL<input v-model="registrationForm.heartbeat.endpoint" data-testid="register-heartbeat-endpoint" placeholder="https://api.example.com/health" /></label>
              <label class="sa-hb-method">方法<select v-model="registrationForm.heartbeat.method" data-testid="register-heartbeat-method"><option>GET</option><option>POST</option><option>HEAD</option></select></label>
              <label class="sa-hb-status">预期状态码<input type="number" v-model.number="registrationForm.heartbeat.expectedStatus" data-testid="register-heartbeat-status" min="100" max="599" /></label>
              <label class="sa-hb-timeout">超时(ms)<input type="number" v-model.number="registrationForm.heartbeat.timeoutMs" data-testid="register-heartbeat-timeout" min="500" max="30000" step="500" /></label>
              <label class="sa-hb-body wide">预期返回体（可选，子串匹配）<input v-model="registrationForm.heartbeat.expectedBody" data-testid="register-heartbeat-body" placeholder='"status":"ok"' /></label>
            </fieldset>
            <fieldset v-else-if="field.format === 'auth'" class="wide sa-auth" data-testid="register-field-auth">
              <legend>{{ field.label }}<em> *必填</em></legend>
              <p class="sa-help">{{ field.help }}</p>
              <label class="sa-auth-scheme">授权方式<select v-model="registrationForm.auth.scheme" data-testid="register-auth-scheme">
                <option v-for="option in registrationAuthSchemes" :key="option.id" :value="option.id">{{ option.label }} — {{ option.description }}</option>
              </select></label>
              <template v-if="registrationForm.auth.scheme === 'service_principal'">
                <label class="sa-auth-cred wide">凭据引用（Key Center kms://）<input v-model="registrationForm.auth.credentialRef" data-testid="register-auth-credentialRef" placeholder="kms://integration/your-system-sp" /></label>
                <label class="sa-auth-scope wide">访问范围 scope（逗号分隔）<input :value="registrationForm.auth.scope.join(', ')" data-testid="register-auth-scope" placeholder="read:supplier, read:contract" @input="registrationForm.auth.scope = String($event.target.value).split(/[,\s]+/u).map(s => s.trim()).filter(Boolean)" /></label>
              </template>
              <label class="sa-auth-write wide"><input type="checkbox" v-model="registrationForm.auth.writeApprovalRequired" data-testid="register-auth-writeApproval" />写操作仍需用户审批（推荐开启，服从「智脑不提权」）</label>
            </fieldset>
            <label v-else-if="field.format === 'documentAttachments'" class="wide sa-docs" data-testid="register-field-attachmentDocuments">
              {{ field.label }}
              <p class="sa-help">{{ field.help }}</p>
              <input type="file" data-testid="register-docs-file" accept=".pdf,.docx,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple @change="readRegistrationDocuments" />
              <ul v-if="registrationForm.attachmentDocuments?.length" class="sa-doc-list">
                <li v-for="(doc, index) in registrationForm.attachmentDocuments" :key="index"><span>{{ doc.name || doc.mimeType }}</span><button type="button" @click="registrationForm.attachmentDocuments.splice(index, 1)">移除</button></li>
              </ul>
            </label>
          </template>
        </div>
        <p v-for="issue in registrationIssues" :key="`${issue.field}-${issue.message}`" class="sa-help sa-blocked-inline">{{ issue.message }}</p>
        <p v-if="registrationMessage" class="sa-notice" role="status" data-testid="registration-message">{{ registrationMessage }}</p>
        <div class="sa-lifecycle-actions">
          <button type="button" class="sa-primary" data-testid="register-submit" :disabled="registering" @click="submitRegistration">{{ registering ? '正在登记…' : '提交登记（进入「已登记」）' }}</button>
          <span class="sa-help">提交后生命周期为「已登记」；接通仍需通过连通性测试（心跳 verified），门禁在服务端强制。</span>
        </div>
      </section>

      <div class="sa-layout">
        <aside class="sa-list" aria-label="系统清单">
          <p v-if="filter === 'unregistered'" class="sa-empty">未登记＝生命周期处于 draft 的系统（通常是登记被退回后待重新登记）。接入清单不预设备待接入系统；要接入新系统，请点右上「＋ 新增接入」自行登记。</p>
          <p v-if="!visibleSystems.length" class="sa-empty">当前筛选下没有系统。</p>
          <button v-for="item in visibleSystems" :key="item.code" type="button" class="sa-card" :class="{ selected: selectedCode === item.code }" :aria-pressed="selectedCode === item.code" @click="selectSystem(item.code)">
            <div class="sa-card-top"><i :style="{ background: item.health?.color || (item.connector ? '#2f7fd3' : '#4a5b6b') }">{{ item.code }}</i><span :class="item.lifecycleState">{{ item.lifecycleLabel }}</span></div>
            <strong>{{ item.name }}</strong>
            <small>{{ item.domain }} · {{ item.authorized ? '已授权' : '未授权' }}</small>
            <dl>
              <div><dt>健康 / 同步</dt><dd>{{ healthLabel(item) }} · {{ item.health?.lastSync || '—' }}</dd></div>
              <div><dt>对象目录</dt><dd>{{ item.objects.length }} 个连接器对象 / {{ item.worldObjectTypes.length }} 个建模对象</dd></div>
              <div><dt>映射数</dt><dd>{{ item.mappingCount }}</dd></div>
              <div><dt>责任人</dt><dd>{{ item.owner || '未指定' }}</dd></div>
            </dl>
            <em v-if="item.blockedReason">{{ item.blockedReason }}</em>
          </button>
        </aside>

        <div class="sa-detail">
          <p v-if="detailLoading" class="sa-loading" role="status">正在加载系统详情…</p>
          <p v-if="detailError" class="sa-error" role="alert">{{ detailError }}<button type="button" @click="selectSystem(selectedCode)">重试</button></p>
          <template v-if="detail && !detailLoading">
            <div class="sa-detail-head">
              <div><span class="eyebrow">{{ detail.system.connector?.displayName || detail.system.code }} · TENANT {{ detail.tenantId }}</span><h3>{{ detail.system.name }}</h3><p>{{ detail.system.domain }} · 生命周期：{{ detail.lifecycle.label }}<template v-if="detail.lifecycle.updatedAt"> · 更新于 {{ displayTime(detail.lifecycle.updatedAt) }}（{{ detail.lifecycle.updatedBy }}）</template></p></div>
              <button type="button" class="sa-outline" @click="sendToAgent">交给 Agent 建模</button>
            </div>
            <p v-if="detail.system.blockedReason" class="sa-blocked">{{ detail.system.blockedReason }}</p>

            <section v-if="detail.system.custom" class="sa-panel" aria-label="登记物料">
              <div class="sa-panel-head"><div><span class="eyebrow">REGISTRATION MATERIALS</span><h4>登记物料</h4></div><span class="sa-src">登记于 {{ displayTime(detail.system.custom.registeredAt) }} · {{ detail.system.custom.registeredBy }}</span></div>
              <div class="sa-grid">
                <div><span>系统定位说明</span><b>{{ detail.system.custom.description }}</b></div>
                <div><span>接入目的</span><b>{{ detail.system.custom.accessIntention }}</b></div>
                <div><span>核心业务对象</span><b>{{ detail.system.custom.keyEntities.join('、') }}</b></div>
                <div><span>覆盖数据域</span><b>{{ detail.system.custom.dataDomains.join('、') }}</b></div>
                <div><span>业务责任人</span><b>{{ detail.system.custom.businessOwner }}</b></div>
                <div v-if="detail.system.custom.vendor"><span>厂商 / 供应商</span><b>{{ detail.system.custom.vendor }}</b></div>
                <div><span>模拟数据源</span><b>{{ detail.system.custom.mockScenarioId || '未挂接（无法连通性探测）' }}</b></div>
              </div>
            </section>

            <section class="sa-panel" aria-label="接入流程与生命周期">
              <div class="sa-panel-head"><div><span class="eyebrow">ONBOARDING LIFECYCLE</span><h4>接入流程与生命周期</h4></div><span class="sa-src" :class="detail.lifecycle.state">{{ detail.lifecycle.label }}<template v-if="detail.lifecycle.reason"> · {{ detail.lifecycle.reason }}</template></span></div>
              <p class="sa-help">接入流程：登记接入（提交接入物料，见「＋ 新增接入」）→ 确认数据域授权 → 连通性测试通过（verified）→ 接通系统。已接通系统可停用（保留登记与授权）；停用后可重新接通或下线登记。每次推进都会记录操作人、时间与理由。</p>
              <div class="sa-lifecycle-steps" data-testid="lifecycle-steps">
                <span v-for="(step, index) in LIFECYCLE_STEPS" :key="step.id" :class="{ done: lifecycleStepIndex(detail.lifecycle.state) >= index && detail.lifecycle.state !== 'suspended', active: detail.lifecycle.state === step.id }"><i>{{ index + 1 }}</i>{{ step.label }}</span>
                <span v-if="detail.lifecycle.state === 'suspended'" class="suspended-badge">已停用（登记与授权保留，可重新接通或下线）</span>
              </div>
              <template v-if="detail.lifecycle.updatedAt">
                <p class="sa-help">最近一次变更：{{ displayTime(detail.lifecycle.updatedAt) }} · 操作人 {{ detail.lifecycle.updatedBy || '—' }}<template v-if="detail.lifecycle.reason"> · 理由：{{ detail.lifecycle.reason }}</template></p>
              </template>
              <div class="sa-lifecycle-actions">
                <button v-for="action in lifecycleActions" :key="action.to" type="button" :class="action.to === 'connected' ? 'sa-primary' : 'sa-outline'" :disabled="action.disabled || transitioning" :data-testid="`lifecycle-${action.to}`" :title="action.disabledReason" @click="runTransition(action.to)">{{ transitioning ? '处理中…' : action.label }}</button>
                <span v-if="!lifecycleActions.length" class="sa-help">当前状态没有允许的下一步跃迁。</span>
              </div>
              <p v-for="action in lifecycleActions.filter((item) => item.disabledReason)" :key="`reason-${action.to}`" class="sa-help sa-blocked-inline">{{ action.label }}：{{ action.disabledReason }}</p>
              <label class="sa-lifecycle-reason">操作理由（必填，≤200 字）<input v-model="transitionReason" maxlength="200" data-testid="lifecycle-reason" placeholder="例如：已与系统负责人核对连接配置与数据域授权，登记接入。" :disabled="!canProbe" /></label>
              <p v-if="lifecycleMessage" class="sa-notice" role="status" data-testid="lifecycle-message">{{ lifecycleMessage }}</p>
            </section>

            <section class="sa-panel">
              <div class="sa-panel-head"><div><span class="eyebrow">CONNECTION</span><h4>连接配置</h4></div><span class="sa-src" :class="{ demo: detail.connectionConfiguration.source === 'demo_seed' }">{{ detail.connectionConfiguration.source === 'demo_seed' ? '来源：demo 种子样例' : detail.connectionConfiguration.source === 'tenant_registration' ? '来源：租户登记物料' : '无配置' }}</span></div>
              <div class="sa-grid">
                <div><span>配置责任人</span><b>{{ detail.connectionConfiguration.owner || '未指定' }}</b></div>
                <div><span>同步频率</span><b>{{ detail.connectionConfiguration.syncInterval || '—' }}</b></div>
                <div><span>启用状态</span><b>{{ detail.connectionConfiguration.enabled === null ? '—' : detail.connectionConfiguration.enabled ? '已启用' : '已停用' }}</b></div>
                <div><span>传输方式</span><b>{{ detail.connectionConfiguration.transport || '—' }}</b></div>
                <div><span>数据分级</span><b>{{ detail.connectionConfiguration.classification || '—' }}</b></div>
                <div><span>写入模式</span><b>{{ detail.connectionConfiguration.writeMode || '—' }}</b></div>
                <div class="wide"><span>凭据引用</span><b class="sa-credential">{{ detail.connectionConfiguration.credentialRef || '—' }}</b></div>
                <div class="wide"><span>受控工具</span><b>{{ detail.connectionConfiguration.tools.length ? detail.connectionConfiguration.tools.join(' / ') : '—' }}</b></div>
              </div>
            </section>

            <section class="sa-panel">
              <div class="sa-panel-head"><div><span class="eyebrow">CONNECTIVITY PROBE</span><h4>连通性测试</h4></div><span class="sa-src">合成数据源 · 非生产</span></div>
              <p class="sa-help">探测会对内置的合成模拟 HTTP 数据源做一次真实的分页只读读取，并校验响应契约与分页完整性。它不连接任何真实企业系统，也不代表接入验收通过。</p>
              <div class="sa-probe-actions">
                <label>响应模式<select v-model="faultMode" :disabled="!canProbeSelected"><option v-for="mode in faults" :key="mode" :value="mode">{{ mode }}</option></select></label>
                <button type="button" class="sa-primary" :disabled="!canProbeSelected" @click="probe">{{ probing ? '正在探测…' : '开始连通性测试' }}</button>
              </div>
              <p v-if="probeDisabledReason" class="sa-help sa-blocked-inline">{{ probeDisabledReason }}</p>
              <p v-if="probeError" class="sa-error" role="alert">{{ probeError }}</p>
              <p v-if="notice" class="sa-notice" role="status">{{ notice }}</p>
              <div v-if="detail.lastProbe" class="sa-probe-result" :class="detail.lastProbe.status">
                <strong>{{ probeStatusLabel(detail.lastProbe) }}</strong>
                <small>{{ displayTime(detail.lastProbe.checkedAt) }} · 场景 {{ detail.lastProbe.scenarioId }} · 模式 {{ detail.lastProbe.faultMode }}</small>
                <dl>
                  <div><dt>HTTP 请求 / 分页</dt><dd>{{ detail.lastProbe.requests }} / {{ detail.lastProbe.pageCount }}</dd></div>
                  <div><dt>该系统记录数</dt><dd>{{ detail.lastProbe.recordCount }}<template v-if="detail.lastProbe.readableRecords">（整批 {{ detail.lastProbe.readableRecords }}）</template></dd></div>
                  <div class="wide"><dt>读到的对象</dt><dd>{{ detail.lastProbe.objectTypes.length ? detail.lastProbe.objectTypes.join(' / ') : '—' }}</dd></div>
                </dl>
                <p v-if="detail.lastProbe.issue" class="sa-issue">{{ detail.lastProbe.issue.message }}<small>{{ detail.lastProbe.issue.code }}<template v-if="detail.lastProbe.issue.detail?.length"> · {{ detail.lastProbe.issue.detail.join('、') }}</template></small></p>
              </div>
              <p v-else class="sa-help">尚无探测记录。修改或切换响应模式不会改变系统状态。</p>
            </section>

            <section class="sa-panel">
              <div class="sa-panel-head"><div><span class="eyebrow">FIELD CATALOG</span><h4>字段目录</h4></div><span class="sa-src">{{ detail.fieldCatalog.objectTypes.length }} 个对象 · 探测读取 {{ detail.fieldCatalog.readScenarioId || '无本地场景' }}</span></div>
              <p v-if="!detail.fieldCatalog.available" class="sa-help">{{ detail.fieldCatalog.unavailableReason }}</p>
              <template v-else>
                <p class="sa-help">目录是本地合成场景声明的并集（{{ detail.fieldCatalog.scenarioIds.join(' / ') }}）；探测只读取其中 {{ detail.fieldCatalog.readScenarioId }}，因此目录里的对象不保证都在同一次探测中可见。</p>
                <p v-if="detail.fieldCatalog.conflicts?.length" class="sa-issue">存在 {{ detail.fieldCatalog.conflicts.length }} 处跨场景字段声明冲突，未做自动合并。<small v-for="conflict in detail.fieldCatalog.conflicts" :key="conflict.objectType">{{ conflict.objectType }}：{{ conflict.scenarioIds.join(' / ') }}</small></p>
                <div class="sa-scroll">
                  <table>
                    <caption>字段目录来自合成数据字典，主键与引用为字典显式声明；同一对象被多个场景声明时按名字归并</caption>
                    <thead><tr><th scope="col">对象</th><th scope="col">粒度</th><th scope="col">主键</th><th scope="col">字段</th></tr></thead>
                    <tbody>
                      <tr v-for="table in detail.fieldCatalog.tables" :key="table.name">
                        <td><b>{{ table.name }}</b><small>{{ table.label }}</small><small v-if="table.scenarioIds?.length > 1" class="sa-scenario">来源场景 {{ table.scenarioIds.join(' / ') }}</small></td>
                        <td>{{ table.granularity }}</td>
                        <td><code>{{ table.primaryKey }}</code></td>
                        <td><span v-for="field in table.fields" :key="field.name" class="sa-field" :class="{ key: field.primaryKey }">{{ field.name }}<small>{{ field.type }}{{ field.required ? ' · 必填' : '' }}{{ field.reference ? ` → ${field.reference}` : '' }}</small></span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </template>
            </section>

            <section class="sa-panel">
              <div class="sa-panel-head"><div><span class="eyebrow">FIELD → META MODEL OBJECT</span><h4>字段 → 元模型对象映射</h4></div><span class="sa-src">{{ detail.mappings.length }} 条生效映射</span></div>
              <p class="sa-help">已发布映射以版本形式进入世界模型，随后才允许被 Agent 用作受控上下文。生成草稿不会自动校验或发布。</p>
              <div v-if="detail.mappings.length" class="sa-scroll">
                <table>
                  <thead><tr><th scope="col">源表 / Topic</th><th scope="col">元模型对象</th><th scope="col">业务事件</th><th scope="col">映射字段</th></tr></thead>
                  <tbody><tr v-for="item in detail.mappings" :key="item.source"><td><code>{{ item.source }}</code></td><td><b>{{ item.object }}</b></td><td><span class="sa-chip">{{ item.event }}</span></td><td><small>{{ item.fields }}</small></td></tr></tbody>
                </table>
              </div>
              <p v-else class="sa-help">该系统尚无生效映射。</p>
              <div class="sa-mapping-actions">
                <button type="button" class="sa-outline" :disabled="!canConfigureMapping || !selectedTemplate || creatingDraft" @click="createMappingDraft">{{ creatingDraft ? '正在生成…' : selectedDraft ? '查看 / 复用映射草稿' : '生成映射草稿' }}</button>
                <span v-if="!canReadMapping" class="sa-help">当前身份没有模型页面读取权限，连接模板与草稿不在此展示。</span>
                <span v-else-if="!selectedTemplate" class="sa-help">该系统尚无元模型连接模板，不能生成映射草稿。</span>
                <span v-else-if="!canConfigureMapping" class="sa-help">生成映射草稿需要 meta_model.draft.save 权限（阶段 6 等价合并后与接入侧写入同一把闸门）。</span>
              </div>
              <p v-if="mappingMessage" class="sa-notice" role="status">{{ mappingMessage }}</p>
              <WorldModelTemplateConfig
                v-if="canReadMapping && selectedTarget && selectedTemplate"
                :templates="templates" :targets="[selectedTarget]" :drafts="drafts" :role="role"
                :message="''" :button-permission-ids="buttonPermissionIds"
                @create="createMappingDraft"
                @validate="(id) => governMappingDraft('validate', id)"
                @publish="(id) => governMappingDraft('publish', id)" />
            </section>
          </template>
          <p v-else-if="!detailLoading && !detailError" class="sa-empty">从左侧选择一个系统查看连接配置、字段目录与映射。</p>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.system-access { color: #ddecf5; min-width: 0; font-size: 13px; line-height: 1.65; }
.system-access :is(h2,h3,h4,p,dl,dd,dt) { margin: 0; }
.system-access :is(input,select,button) { font: inherit; }
.system-access button { cursor: pointer; border: 1px solid #36556b; border-radius: 7px; background: #102637; color: #cfdfeb; padding: 8px 12px; }
.system-access button:hover:not(:disabled) { border-color: #67c8c8; background: #18394a; }
.system-access button:disabled { cursor: not-allowed; opacity: .48; }
.system-access select { display: block; width: 100%; min-width: 0; padding: 8px 10px; border: 1px solid #345268; border-radius: 7px; background: #081927; color: #e2eef5; margin-top: 5px; }
.system-access :is(button,select):focus-visible { outline: 2px solid #7cddda; outline-offset: 3px; }
.system-access label { color: #b6ccda; min-width: 0; }
.sa-heading,.sa-panel-head,.sa-detail-head,.sa-probe-actions,.sa-mapping-actions { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.sa-heading { margin-bottom: 14px; }
.sa-heading h2 { font-size: 22px; font-weight: 600; margin: 5px 0; }
.sa-heading p { color: #91abba; }
.eyebrow { color: #83becb; font-size: 10px; letter-spacing: .12em; }
.sa-badge,.sa-src { border: 1px solid #856c37; background: #332c1d; color: #e8c884; font-size: 11px; white-space: nowrap; padding: 4px 9px; border-radius: 20px; }
.sa-src { border-color: #3a5b70; background: #12293a; color: #9dc4d8; }
.sa-src.demo { border-color: #7a5c2f; background: #2c2519; color: #e0c288; }
.sa-boundary,.sa-blocked,.sa-error,.sa-notice,.sa-blocked-inline { padding: 11px 14px; border-radius: 8px; margin-bottom: 14px; overflow-wrap: anywhere; }
.sa-boundary { color: #d8c89f; border: 1px solid #665737; background: #2a261c; }
.sa-blocked,.sa-blocked-inline { color: #e8c09d; border: 1px solid #7a5c2f; background: #30251a; }
.sa-error { color: #f3c2ad; background: #392925; border: 1px solid #835948; }
.sa-error button { margin-left: 10px; }
.sa-notice { color: #b6dce3; background: #14303d; border: 1px solid #365e6c; }
.sa-loading,.sa-empty { padding: 14px; color: #9dcbd8; }
.sa-summary { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(120px,100%),1fr)); gap: 10px; margin-bottom: 14px; }
.sa-summary article { border: 1px solid #2c4354; border-radius: 8px; background: #0c2131; padding: 11px 13px; min-width: 0; }
.sa-summary span { display: block; color: #8ea9ba; font-size: 11px; }
.sa-summary b { color: #e6f4fb; font-size: 18px; }
.sa-filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.sa-filters button { font-size: 11px; padding: 5px 10px; }
.sa-filters button.active { border-color: #62a5b2; background: #143647; color: #eaf7fb; }
.sa-refresh { margin-left: auto; }
.sa-new { border-color: #4e8b7c; background: #123128; color: #b7e8d4; }
.sa-lifecycle-steps { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.sa-lifecycle-steps span { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #2c4354; border-radius: 20px; background: #0c2131; color: #8ea9ba; font-size: 11px; padding: 5px 11px; }
.sa-lifecycle-steps span.done { border-color: #3d7a68; background: #10302a; color: #a4dccb; }
.sa-lifecycle-steps span.active { border-color: #62a5b2; background: #143647; color: #eaf7fb; }
.sa-lifecycle-steps span i { font-style: normal; font-size: 10px; font-weight: 700; }
.sa-lifecycle-steps .suspended-badge { border-color: #8a7333; background: #322c18; color: #e6d08d; }
.sa-lifecycle-actions { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; margin-bottom: 10px; }
.sa-register { border-color: #3d6a58; }
.sa-register-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(240px,100%),1fr)); gap: 12px; margin-bottom: 10px; }
.sa-register-grid label { display: block; border: 1px solid #243c4d; border-radius: 7px; background: #0d2534; padding: 9px 11px; font-size: 12px; }
.sa-register-grid label em { font-style: normal; color: #e0a588; margin-left: 5px; font-size: 10px; }
.sa-register-grid label.wide { grid-column: 1 / -1; }
.sa-register-grid .wide { grid-column: 1 / -1; }
.sa-register-grid input, .sa-register-grid textarea { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; padding: 8px 10px; border: 1px solid #345268; border-radius: 7px; background: #081927; color: #e2eef5; font: inherit; }
.sa-register-grid input:focus-visible, .sa-register-grid textarea:focus-visible, .sa-register-grid select:focus-visible { outline: 2px solid #7cddda; outline-offset: 2px; }
.sa-register-grid fieldset { border: 1px solid #243c4d; border-radius: 7px; background: #0d2534; padding: 9px 11px; margin: 0; }
.sa-register-grid fieldset legend { color: #b6ccda; font-size: 12px; padding: 0 4px; }
.sa-register-grid fieldset legend em { font-style: normal; color: #e0a588; margin-left: 5px; font-size: 10px; }
.sa-domain-option { display: inline-flex; align-items: flex-start; gap: 8px; margin: 7px 12px 0 0; border: none !important; background: none !important; padding: 0 !important; cursor: pointer; }
.sa-domain-option input { width: auto !important; margin-top: 3px !important; }
.sa-domain-option span { color: #cfe2ec; font-size: 12px; }
.sa-domain-option small { display: block; color: #8ea9ba; font-size: 10px; }
.sa-lifecycle-reason { display: block; margin-bottom: 10px; }
.sa-lifecycle-reason input { display: block; width: 100%; box-sizing: border-box; margin-top: 5px; padding: 8px 10px; border: 1px solid #345268; border-radius: 7px; background: #081927; color: #e2eef5; font: inherit; }
.sa-lifecycle-reason input:focus-visible { outline: 2px solid #7cddda; outline-offset: 3px; }
.sa-layout { display: grid; grid-template-columns: 320px minmax(0,1fr); gap: 16px; align-items: start; }
.sa-list { display: flex; flex-direction: column; gap: 9px; min-width: 0; }
.sa-card { display: block; width: 100%; text-align: left; padding: 13px; border: 1px solid #2a4354; border-radius: 9px; background: #0a1b29; min-width: 0; overflow-wrap: anywhere; }
.sa-card.selected { border-color: #62a5b2; background: #143647; }
.sa-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sa-card-top i { font-style: normal; font-size: 10px; font-weight: 700; color: #fff; padding: 3px 7px; border-radius: 5px; }
.sa-card-top span { font-size: 10px; color: #8fbec8; }
.sa-card-top span.draft { color: #c9a978; }
.sa-card-top span.connected { color: #85dbb9; }
.sa-card-top span.suspended { color: #f0ad8e; }
.sa-card strong { display: block; font-size: 13px; margin: 7px 0 3px; }
.sa-card > small { color: #93b0c1; font-size: 11px; }
.sa-card dl { margin: 9px 0 0; }
.sa-card dl div { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; padding: 3px 0; border-top: 1px solid #1f3546; }
.sa-card dt { color: #7f9eaf; }
.sa-card dd { color: #cfe2ec; text-align: right; min-width: 0; overflow-wrap: anywhere; }
.sa-card em { display: block; margin-top: 8px; font-style: normal; font-size: 10px; color: #c9a978; }
.sa-detail { min-width: 0; }
.sa-detail-head { margin-bottom: 12px; align-items: flex-start; }
.sa-detail-head div { min-width: 0; }
.sa-detail-head h3 { font-size: 19px; margin: 5px 0 3px; overflow-wrap: anywhere; }
.sa-detail-head p { color: #91abba; font-size: 12px; }
.sa-outline { flex: 0 0 auto; }
.sa-primary { background: #286b78; border-color: #468f99; color: #f0ffff; }
.sa-panel { border: 1px solid #2c4759; border-radius: 10px; background: #0b1d2b; padding: 16px; margin-bottom: 14px; min-width: 0; }
.sa-panel-head { align-items: center; margin-bottom: 10px; }
.sa-panel-head h4 { font-size: 15px; margin-top: 3px; }
.sa-help { color: #a3becc; font-size: 12px; margin-bottom: 10px; overflow-wrap: anywhere; }
.sa-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(180px,100%),1fr)); gap: 10px; }
.sa-grid div { border: 1px solid #243c4d; border-radius: 7px; background: #0d2534; padding: 10px 12px; min-width: 0; }
.sa-grid div.wide { grid-column: 1 / -1; }
.sa-grid span { display: block; color: #8ea9ba; font-size: 10px; }
.sa-grid b { display: block; font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
.sa-credential { color: #7fd2e8 !important; font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 11px !important; }
.sa-probe-actions { justify-content: flex-start; align-items: flex-end; }
.sa-probe-actions label { flex: 0 1 200px; }
.sa-probe-result { border: 1px solid #396c65; background: #122f32; border-radius: 8px; padding: 13px; overflow-wrap: anywhere; }
.sa-probe-result.failed { border-color: #805e49; background: #302721; }
.sa-probe-result.schema_drift { border-color: #8a7333; background: #322c18; }
.sa-probe-result > strong { display: block; font-size: 13px; color: #99d8c3; }
.sa-probe-result.failed > strong { color: #e8c09d; }
.sa-probe-result.schema_drift > strong { color: #e6d08d; }
.sa-probe-result > small { display: block; color: #a0b8c5; font-size: 10px; margin-top: 5px; }
.sa-probe-result dl { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(170px,100%),1fr)); gap: 10px; margin: 12px 0 0; }
.sa-probe-result dl div.wide { grid-column: 1 / -1; }
.sa-probe-result dt { color: #93aebc; font-size: 10px; }
.sa-probe-result dd { color: #d1e3eb; font-size: 12px; overflow-wrap: anywhere; }
.sa-issue { margin-top: 12px; color: #f2bda4; font-size: 12px; }
.sa-issue small { display: block; color: #caa18d; font-size: 10px; margin-top: 3px; }
.sa-scroll { overflow-x: auto; max-width: 100%; border: 1px solid #355468; border-radius: 7px; }
.sa-scroll:focus-visible { outline: 2px solid #7cddda; outline-offset: 3px; }
.sa-scroll table { border-collapse: collapse; min-width: 100%; text-align: left; font-size: 11px; }
.sa-scroll caption { text-align: left; padding: 9px 12px; color: #91bbcb; background: #102b3d; }
.sa-scroll th { background: #153447; color: #d0e4ef; font-weight: 500; }
.sa-scroll :is(th,td) { padding: 9px 12px; border-bottom: 1px solid #294658; min-width: 110px; max-width: 340px; overflow-wrap: anywhere; vertical-align: top; }
.sa-scroll td small { display: block; color: #93b0c1; font-size: 10px; margin-top: 3px; }
.sa-scenario { color: #7fb6a6 !important; }
.sa-scroll code { color: #7fd2e8; font-size: 10px; }
.sa-chip { display: inline-block; padding: 3px 6px; border-radius: 4px; background: #2b2a4a; color: #c6b8f2; font-size: 10px; }
.sa-field { display: inline-block; margin: 0 6px 6px 0; padding: 3px 7px; border-radius: 5px; border: 1px solid #2f5266; background: #0f2a3b; color: #cfe3ec; font-size: 10px; }
.sa-field.key { border-color: #4e8b7c; background: #123128; }
.sa-field small { color: #8fa9b8; margin-left: 4px; }
.sa-mapping-actions { justify-content: flex-start; align-items: center; margin-top: 12px; }
.sa-mapping-actions .sa-help { margin: 0; }
@media (max-width: 1180px) { .sa-layout { grid-template-columns: minmax(0,1fr); } .sa-list { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(260px,100%),1fr)); } }
@media (max-width: 600px) { .sa-heading h2 { font-size: 18px; } .sa-panel { padding: 13px; } .sa-probe-actions { align-items: stretch; flex-direction: column; } .sa-probe-actions label { flex: 1 1 auto; } .sa-summary article { padding: 9px 11px; } }
</style>

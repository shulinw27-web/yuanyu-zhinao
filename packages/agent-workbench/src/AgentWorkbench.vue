<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { createAgentClient } from '@healthcare-ai/agent-sdk';

const props = defineProps({
  layout: { type: String, default: 'desktop' },
  platform: { type: String, default: 'desktop' },
  appVersion: { type: String, default: '0.3.0' },
  accessTokenProvider: { type: Function, default: null },
  enterpriseLogout: { type: Function, default: null },
  agentClient: { type: Object, default: null },
  identityLoginProvider: { type: Function, default: null },
  identityProviderName: { type: String, default: '企业身份' },
  identityEntryHint: { type: String, default: '请从企业指定入口登录本应用。' },
  disableDesktopBridge: { type: Boolean, default: false }
});

const client = props.agentClient || createAgentClient({
  platform: props.platform,
  appVersion: props.appVersion,
  role: 'production_manager',
  accessTokenProvider: props.accessTokenProvider
});
const view = ref('assistant');
const loading = ref(true);
const error = ref('');
const workItems = ref([]);
const notices = ref([]);
const operations = ref(null);
const memories = ref([]);
const learningProfile = ref(null);
const savingLearningProfile = ref(false);
const pinningMemory = ref(false);
const listening = ref(false);
const attachmentInput = ref(null);
const authenticated = ref(false);
const oaConnection = ref(null);
const profile = ref(null);
const account = ref('');
const password = ref('');
const loginLoading = ref(false);
const loginMode = ref('oa');
const conversations = ref([]);
const activeConversationId = ref(null);
const taskStates = ref({});
const chatViewport = ref(null);
const contextOpen = ref(true);
const desktopCapabilities = ref(null);
const desktopArtifacts = ref([]);
const desktopEndpointStatus = ref(null);
const runtimeTasks = ref([]);
const runtimeTaskWorkerBusy = ref(false);
let recognition = null;
let endpointHeartbeatTimer = null;
let runtimeTaskWorkerTimer = null;

const emptyTaskState = () => ({ messages: [], pending: null, sending: false, executing: false, input: '', attachments: [], loaded: false });
const fallbackTaskState = emptyTaskState();
function ensureTaskState(conversationId) {
  if (!conversationId) return fallbackTaskState;
  if (!taskStates.value[conversationId]) taskStates.value[conversationId] = emptyTaskState();
  return taskStates.value[conversationId];
}
const activeTaskState = computed(() => taskStates.value[activeConversationId.value] || fallbackTaskState);
const conversation = computed(() => conversations.value.find((item) => item.id === activeConversationId.value) || null);
const messages = computed({ get: () => activeTaskState.value.messages, set: (value) => { activeTaskState.value.messages = value; } });
const pending = computed({ get: () => activeTaskState.value.pending, set: (value) => { activeTaskState.value.pending = value; } });
const sending = computed({ get: () => activeTaskState.value.sending, set: (value) => { activeTaskState.value.sending = value; } });
const executing = computed({ get: () => activeTaskState.value.executing, set: (value) => { activeTaskState.value.executing = value; } });
const input = computed({ get: () => activeTaskState.value.input, set: (value) => { activeTaskState.value.input = value; } });
const attachments = computed({ get: () => activeTaskState.value.attachments, set: (value) => { activeTaskState.value.attachments = value; } });
const runningTaskCount = computed(() => Object.values(taskStates.value).filter((state) => state.sending || state.executing).length + runtimeTasks.value.filter((task) => ['queued', 'paused', 'running'].includes(task.status)).length);
const contextPercent = computed(() => Math.round((conversation.value?.context?.utilization || 0) * 100));

const isDesktop = computed(() => props.layout === 'desktop');
const desktopBridge = computed(() => props.disableDesktopBridge ? null : globalThis.zhinaoDesktop || null);
const pendingCount = computed(() => workItems.value.length);
const activeAlert = computed(() => [...notices.value].sort((left, right) => ({ P0: 0, P1: 1, P2: 2 }[left.severity] ?? 3) - ({ P0: 0, P1: 1, P2: 2 }[right.severity] ?? 3))[0] || null);
const alertCount = computed(() => notices.value.length);
const agentHealthy = computed(() => operations.value?.status === 'healthy');
const pageMeta = computed(() => ({
  assistant: { eyebrow: 'PRIVATE AGENT', title: '智脑工作台', description: '像与业务同事沟通一样提出问题；涉及数据与动作时，智脑会自动进入受控任务流程。' },
  alerts: { eyebrow: '24 / 7 MONITORING', title: '风险告警', description: '仅呈现当前身份与组织数据范围内的事件。' },
  tasks: { eyebrow: 'CONTROLLED WORKFLOW', title: '我的待办', description: '确认、审批与业务回执在同一条审计链中闭环。' }
}[view.value]));

const greeting = () => ({
  type: 'agent',
  text: '你好，我是智脑。你可以直接问我问题、说说你的想法，或描述想推进的事情。我会先理解和协助梳理；当需要查询企业数据、创建任务或推进审批时，我会明确说明范围，并在你的授权内执行。',
  createdAt: new Date().toISOString()
});

const traceStageLabels = {
  routing: '对话意图已理解',
  authorization: '权限已校验',
  retrieval: '业务数据已读取',
  read_only_tool: '受控分析已完成',
  model_inference: '模型已生成建议',
  planning: '仅生成建议（未执行）',
  confirmation: '等待本人确认',
  completion: '分析已完成（未执行）'
};

function modelLabel(runtime) {
  const model = String(runtime?.model || '').replace(/\\/g, '/').split('/').pop();
  return model || '受控模型网关';
}

function writeStateLabel(value) {
  if (value === 'draft_created') return '仅草稿已创建';
  if (value === 'local_artifact_pending') return '等待本机写入';
  if (value === 'local_artifact_created') return '本地产物已创建';
  if (value === 'external_navigation_completed') return '浏览器已打开';
  if (value === 'not_completed') return '执行未完成';
  return '未发生';
}

function traceHighlights(trace) {
  const seen = new Set();
  return (trace?.events || []).flatMap((event) => {
    const label = event.status === 'failed' && ['model_inference', 'completion'].includes(event.stage)
      ? '模型回答未完成，可重试'
      : event.type === 'conversation_completed'
      ? '对话已回应（未读取数据）'
      : event.stage === 'authorization' && event.status === 'not_requested'
        ? '未申请业务权限'
        : traceStageLabels[event.stage];
    if (!label || seen.has(event.stage) || event.status === 'started') return [];
    seen.add(event.stage);
    return [{ stage: event.stage, label, status: event.status }];
  });
}

function clearError() {
  error.value = '';
}

function setError(cause, fallback = '请求没有完成，请稍后重试。') {
  error.value = cause?.message || fallback;
}

async function scrollToLatest() {
  await nextTick();
  if (chatViewport.value) chatViewport.value.scrollTop = chatViewport.value.scrollHeight;
}

function mergeConversation(next) {
  const index = conversations.value.findIndex((item) => item.id === next.id);
  if (index >= 0) conversations.value[index] = { ...conversations.value[index], ...next };
  else conversations.value.unshift(next);
}

async function selectConversation(conversationId) {
  activeConversationId.value = conversationId;
  const state = ensureTaskState(conversationId);
  view.value = 'assistant';
  if (!state.loaded) {
    try {
      const detail = await client.agentConversation(conversationId);
      mergeConversation(detail);
      state.messages = detail.messages?.length ? detail.messages : [greeting()];
      state.loaded = true;
    } catch (cause) {
      setError(cause, '无法加载该智脑任务。');
    }
  }
  await scrollToLatest();
}

async function startConversation() {
  clearError();
  try {
    const created = await client.createAgentConversation();
    mergeConversation(created);
    const state = ensureTaskState(created.id);
    state.messages = [greeting()];
    state.loaded = true;
    activeConversationId.value = created.id;
    view.value = 'assistant';
    await scrollToLatest();
  } catch (cause) {
    setError(cause, '无法创建新的智脑任务。');
  }
}

async function loadConversations() {
  const result = await client.agentConversations();
  conversations.value = result.items || [];
  const active = conversations.value.find((item) => item.status === 'active');
  if (active) await selectConversation(active.id);
  else await startConversation();
}

async function archiveConversation(conversationId) {
  const target = conversations.value.find((item) => item.id === conversationId);
  if (!target || target.status === 'archived' || taskStates.value[conversationId]?.sending || taskStates.value[conversationId]?.executing) return;
  try {
    const archived = await client.archiveAgentConversation(conversationId);
    mergeConversation(archived);
    if (activeConversationId.value === conversationId) {
      const next = conversations.value.find((item) => item.status === 'active' && item.id !== conversationId);
      if (next) await selectConversation(next.id);
      else await startConversation();
    }
  } catch (cause) {
    setError(cause, '无法归档该智脑任务。');
  }
}

async function refresh({ quiet = false } = {}) {
  if (!quiet) loading.value = true;
  clearError();
  try {
    const [items, notificationData, operationData, memoryData, learningData, runtimeTaskData] = await Promise.all([
      client.agentWorkItems(),
      client.notifications(),
      client.agentOperations(),
      client.agentMemory(),
      client.agentLearningProfile(),
      client.agentRuntimeTasks()
    ]);
    workItems.value = items;
    notices.value = notificationData;
    operations.value = operationData;
    memories.value = memoryData || [];
    learningProfile.value = learningData;
    runtimeTasks.value = runtimeTaskData.items || [];
  } catch (cause) {
    setError(cause, '无法同步智脑运行状态。');
  } finally {
    if (!quiet) loading.value = false;
  }
}

async function initializeAuthenticatedSession() {
  await client.registerDevice({ notificationChannel: props.identityLoginProvider || isDesktop.value ? 'in_app' : 'push' });
  authenticated.value = true;
  await syncDesktopEndpoint();
  startEndpointHeartbeat();
  await loadConversations();
  await refresh();
  startRuntimeTaskWorker();
}

async function login() {
  if (props.identityLoginProvider) {
    if (loginLoading.value) return;
    loginLoading.value = true;
    clearError();
    try {
      const result = await props.identityLoginProvider();
      profile.value = result.user;
      await initializeAuthenticatedSession();
    } catch (cause) {
      authenticated.value = false;
      setError(cause, `${props.identityProviderName}登录未完成。`);
    } finally {
      loginLoading.value = false;
      loading.value = false;
    }
    return;
  }
  if (!account.value.trim() || !password.value.trim()) {
    error.value = `请输入${loginMode.value === 'oa' ? ' OA' : '平台'}账号和密码。`;
    return;
  }
  loginLoading.value = true;
  clearError();
  try {
    const result = loginMode.value === 'oa'
      ? await client.loginOA({ account: account.value, password: password.value })
      : await client.loginLocal({ account: account.value, password: password.value });
    profile.value = result.user;
    oaConnection.value = result.connection || oaConnection.value;
    await initializeAuthenticatedSession();
  } catch (cause) {
    setError(cause, '身份验证失败。');
  } finally {
    loginLoading.value = false;
  }
}

async function logout() {
  try {
    if (client.enterpriseAuthenticated) {
      await props.enterpriseLogout?.();
      client.clearEnterpriseAccessToken();
    } else {
      await client.logoutOA();
    }
  } catch {
    // 即使服务端会话已经过期，也要清理当前客户端视图。
  }
  authenticated.value = false;
  profile.value = null;
  workItems.value = [];
  notices.value = [];
  operations.value = null;
  memories.value = [];
  learningProfile.value = null;
  desktopEndpointStatus.value = null;
  runtimeTasks.value = [];
  if (endpointHeartbeatTimer) clearInterval(endpointHeartbeatTimer);
  endpointHeartbeatTimer = null;
  if (runtimeTaskWorkerTimer) clearInterval(runtimeTaskWorkerTimer);
  runtimeTaskWorkerTimer = null;
  conversations.value = [];
  activeConversationId.value = null;
  taskStates.value = {};
  account.value = '';
  password.value = '';
}

async function send(text = input.value) {
  const request = String(text || '').trim();
  const conversationId = activeConversationId.value;
  if (!conversationId) return;
  const state = ensureTaskState(conversationId);
  if ((!request && !state.attachments.length) || state.sending) return;
  clearError();
  const outgoingAttachments = state.attachments.map(({ name, mimeType, dataUrl }) => ({ name, mimeType, dataUrl }));
  const userText = request || `已上传 ${outgoingAttachments.length} 个业务材料，请分析。`;
  state.messages.push({ type: 'user', text: userText, createdAt: new Date().toISOString(), attachmentCount: outgoingAttachments.length });
  state.input = '';
  state.attachments = [];
  state.sending = true;
  await scrollToLatest();
  try {
    const response = await client.agentMessage({ text: request, attachments: outgoingAttachments, conversationId });
    state.messages.push({
      type: 'agent',
      text: response.text || '已生成受控业务计划。',
      evidence: response.evidence || [],
      plan: response.plan || [],
      task: response.task || null,
      route: response.route || [],
      evidenceTrace: response.evidenceTrace || null,
      traceId: response.traceId || null,
      lifecycle: response.lifecycle || null,
      inferenceSource: response.agent?.inferenceSource || null,
      runtime: response.agent?.runtime || null,
      guidance: response.guidance || null,
      memory: response.memory || null,
      materialAttachments: response.multimodal?.attachments || [],
      createdAt: new Date().toISOString()
    });
    state.pending = response.command ? { ...response.command, runId: response.runId } : null;
    if (response.conversation) mergeConversation(response.conversation);
    await Promise.all([refresh({ quiet: true }), scrollToLatest()]);
  } catch (cause) {
    setError(cause, '智脑暂时无法响应。');
    state.messages.push({ type: 'system', text: cause?.message || '请求失败，请稍后重试。', guidance: cause?.payload?.guidance || null, createdAt: new Date().toISOString() });
  } finally {
    state.sending = false;
    if (activeConversationId.value === conversationId) await scrollToLatest();
  }
}

async function execute() {
  const conversationId = activeConversationId.value;
  const state = ensureTaskState(conversationId);
  const command = state.pending;
  if (!command || state.executing) return;
  state.executing = true;
  clearError();
  try {
    if (command.target === 'desktop') {
      const endpoint = desktopBridge.value?.desktop;
      if (!endpoint?.execute) throw new Error('该动作只能在已安装的元域智脑桌面端执行。');
      const endpointStatus = await syncDesktopEndpoint();
      if (!endpointStatus?.allowed) throw new Error(endpointStatus?.reason || '当前桌面端未通过在线与版本校验。');
      const authorization = await client.agentExecute(command.id, command.runId, command.confirmationToken, conversationId);
      if (!authorization.runtimeTask) throw new Error('服务端没有返回有效的长任务队列记录。');
      runtimeTasks.value.unshift(authorization.runtimeTask);
      state.messages.push({ type: 'agent', text: authorization.text || '本机操作已确认并进入受控队列。', evidenceTrace: authorization.evidenceTrace || null, traceId: authorization.traceId || null, lifecycle: authorization.lifecycle || null, createdAt: new Date().toISOString() });
      if (authorization.conversation) {
        mergeConversation(authorization.conversation);
        state.messages = authorization.conversation.messages || state.messages;
      }
      state.pending = null;
      await Promise.all([refresh({ quiet: true }), scrollToLatest()]);
      return;
    }
    const result = await client.agentExecute(command.id, command.runId, command.confirmationToken, conversationId);
    state.messages.push({
      type: 'agent',
      text: result.text || '已创建受控工作项，正在等待后续审批。',
      evidence: result.evidence || [],
      evidenceTrace: result.evidenceTrace || null,
      traceId: result.traceId || null,
      lifecycle: result.lifecycle || null,
      createdAt: new Date().toISOString()
    });
    if (result.conversation) {
      mergeConversation(result.conversation);
      state.messages = result.conversation.messages || state.messages;
    }
    state.pending = null;
    await Promise.all([refresh({ quiet: true }), scrollToLatest()]);
  } catch (cause) {
    setError(cause, '当前动作无法执行。');
    state.messages.push({
      type: 'system',
      text: cause?.message || '当前动作无法执行。',
      evidenceTrace: cause?.evidenceTrace || null,
      traceId: cause?.traceId || null,
      createdAt: new Date().toISOString()
    });
  } finally {
    state.executing = false;
  }
}

async function cancelPending() {
  const conversationId = activeConversationId.value;
  const state = ensureTaskState(conversationId);
  const command = state.pending;
  if (!command || state.executing) return;
  state.executing = true;
  clearError();
  try {
    const result = await client.agentCancel(command.runId, conversationId);
    state.messages.push({
      type: 'agent',
      text: result.text || '已撤回待确认动作，未调用业务系统。',
      evidenceTrace: result.evidenceTrace || null,
      traceId: result.traceId || null,
      lifecycle: result.lifecycle || null,
      createdAt: new Date().toISOString()
    });
    if (result.conversation) {
      mergeConversation(result.conversation);
      state.messages = result.conversation.messages || state.messages;
    }
    state.pending = null;
    await Promise.all([refresh({ quiet: true }), scrollToLatest()]);
  } catch (cause) {
    setError(cause, '当前动作无法撤回。');
  } finally {
    state.executing = false;
  }
}

async function forgetMemory(memoryId) {
  try {
    await client.forgetAgentMemory(memoryId);
    memories.value = memories.value.filter((item) => item.id !== memoryId);
  } catch (cause) {
    setError(cause, '无法删除该长期记忆。');
  }
}

async function pinCurrentTask() {
  const target = conversation.value;
  if (!target?.task?.goal || target.task.pinnedMemoryId || pinningMemory.value) return;
  pinningMemory.value = true;
  clearError();
  try {
    const result = await client.pinAgentConversation(target.id);
    if (result.conversation) mergeConversation(result.conversation);
    if (result.memory) {
      const existing = memories.value.findIndex((item) => item.id === result.memory.id);
      if (existing >= 0) memories.value[existing] = { ...memories.value[existing], ...result.memory };
      else memories.value.unshift(result.memory);
    }
  } catch (cause) {
    setError(cause, '无法将当前任务固定为长期记忆。');
  } finally {
    pinningMemory.value = false;
  }
}

async function updateLearningSetting(setting) {
  if (!learningProfile.value || savingLearningProfile.value) return;
  savingLearningProfile.value = true;
  clearError();
  try {
    learningProfile.value = await client.updateAgentLearningProfile(
      { [setting]: !learningProfile.value[setting] },
      learningProfile.value.version
    );
  } catch (cause) {
    setError(cause, '无法更新学习授权，请刷新后重试。');
  } finally {
    savingLearningProfile.value = false;
  }
}

async function forgetLearningSignal(signalId) {
  try {
    await client.forgetAgentWorkflowLearningSignal(signalId);
    learningProfile.value.signals = learningProfile.value.signals.filter((item) => item.id !== signalId);
    learningProfile.value.signalCount = Math.max(0, learningProfile.value.signalCount - 1);
  } catch (cause) {
    setError(cause, '无法撤销该学习记录。');
  }
}

async function askAboutAlert(notice = activeAlert.value) {
  if (!notice) return;
  view.value = 'assistant';
  await send(`请针对告警“${notice.title}”说明影响范围、处置建议、需要我确认的动作以及当前可用证据。`);
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('附件读取失败，请重新选择。'));
    reader.readAsDataURL(file);
  });
}

async function selectAttachments(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  if (attachments.value.length + files.length > 5) {
    error.value = '一次最多上传 5 个材料。';
    return;
  }
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/json', 'text/csv', 'application/yaml', 'text/yaml']);
  try {
    const parsed = await Promise.all(files.map(async (file) => {
      if (!allowed.has(file.type)) throw new Error('仅支持图片、PDF、DOCX、XLSX、JSON、YAML 和 CSV 文档。');
      if (file.size > 4 * 1024 * 1024) throw new Error('单个材料必须小于 4MB。');
      return { name: file.name, mimeType: file.type, dataUrl: await readAsDataUrl(file), type: file.type.startsWith('image/') ? '图片' : file.name.split('.').pop()?.toUpperCase() || '文档' };
    }));
    const totalBytes = [...attachments.value, ...parsed].reduce((sum, item) => sum + Math.floor(((item.dataUrl?.split(',')[1]?.length || 0) * 3) / 4), 0);
    if (totalBytes > 12 * 1024 * 1024) throw new Error('本次材料总大小必须小于 12MB。');
    attachments.value.push(...parsed);
    clearError();
  } catch (cause) {
    setError(cause, '附件读取失败。');
  }
}

function startVoice() {
  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!Recognition) {
    error.value = '当前运行环境不支持语音识别，请使用文字输入；生产环境建议接入企业私有 ASR。';
    return;
  }
  recognition?.abort?.();
  recognition = new Recognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = false;
  listening.value = true;
  recognition.onresult = (event) => {
    input.value = event.results[0][0].transcript;
    listening.value = false;
  };
  recognition.onerror = () => {
    error.value = '语音识别未完成，请改用文字输入。';
    listening.value = false;
  };
  recognition.onend = () => { listening.value = false; };
  recognition.start();
}

function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function windowAction(action) {
  desktopBridge.value?.window?.[action]?.();
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

async function loadDesktopWorkspace() {
  const endpoint = desktopBridge.value?.desktop;
  if (!endpoint) return;
  try {
    const [capabilities, artifacts] = await Promise.all([endpoint.capabilities(), endpoint.listArtifacts()]);
    desktopCapabilities.value = capabilities;
    desktopArtifacts.value = Array.isArray(artifacts) ? artifacts : [];
  } catch {
    desktopCapabilities.value = null;
    desktopArtifacts.value = [];
  }
}

async function syncDesktopEndpoint({ quiet = false } = {}) {
  const endpoint = desktopBridge.value?.desktop;
  if (!endpoint?.endpointStatus || !authenticated.value) return null;
  try {
    const heartbeat = await endpoint.endpointStatus();
    const status = await client.agentDesktopEndpointHeartbeat(heartbeat);
    desktopEndpointStatus.value = status;
    return status;
  } catch (cause) {
    desktopEndpointStatus.value = { connected: false, allowed: false, trustState: 'heartbeat_failed', reason: cause?.message || '端侧心跳同步失败。' };
    if (!quiet) setError(cause, '无法验证当前桌面端运行状态。');
    return desktopEndpointStatus.value;
  }
}

function startEndpointHeartbeat() {
  if (!desktopBridge.value?.desktop?.endpointStatus) return;
  if (endpointHeartbeatTimer) clearInterval(endpointHeartbeatTimer);
  endpointHeartbeatTimer = setInterval(() => { syncDesktopEndpoint({ quiet: true }); }, 30_000);
}

function runtimeTaskLabel(task) {
  return ({ queued: '排队中', paused: '已暂停', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', timed_out: '已超时' }[task?.status] || task?.status || '未知');
}

async function controlRuntimeTask(task, action) {
  if (!task?.id || runtimeTaskWorkerBusy.value) return;
  try {
    const result = await client.controlAgentRuntimeTask(task.id, action);
    const updated = result.task;
    if (updated) {
      const index = runtimeTasks.value.findIndex((item) => item.id === updated.id);
      if (index >= 0) runtimeTasks.value[index] = updated;
      else runtimeTasks.value.unshift(updated);
    }
  } catch (cause) {
    setError(cause, '无法更新长任务状态。');
    await refresh({ quiet: true });
  }
}

async function processNextRuntimeTask() {
  if (!authenticated.value || runtimeTaskWorkerBusy.value || !desktopBridge.value?.desktop?.execute) return;
  const task = runtimeTasks.value.find((item) => item.status === 'queued' && Date.now() - Date.parse(item.createdAt) >= 3_000);
  if (!task) return;
  runtimeTaskWorkerBusy.value = true;
  try {
    const endpointStatus = await syncDesktopEndpoint({ quiet: true });
    if (!endpointStatus?.allowed) return;
    const authorization = await client.controlAgentRuntimeTask(task.id, 'claim');
    if (!authorization.desktopExecution) throw new Error('Worker 未收到有效的端侧派发。');
    const taskIndex = runtimeTasks.value.findIndex((item) => item.id === task.id);
    if (taskIndex >= 0 && authorization.runtimeTask) runtimeTasks.value[taskIndex] = authorization.runtimeTask;
    let receipt;
    try {
      receipt = await desktopBridge.value.desktop.execute(authorization.desktopExecution);
    } catch (cause) {
      receipt = { status: 'failed', dispatchId: authorization.desktopExecution.dispatchId, toolId: authorization.desktopExecution.toolId, error: cause?.message || '桌面端执行器没有返回结果。', completedAt: new Date().toISOString() };
    }
    const completion = await client.agentDesktopReceipt({ commandId: task.commandId, runId: task.runId, dispatchId: authorization.desktopExecution.dispatchId, receipt });
    if (completion.conversation) {
      mergeConversation(completion.conversation);
      const state = ensureTaskState(completion.conversation.id);
      if (state.loaded) state.messages = completion.conversation.messages || state.messages;
    }
    await Promise.all([refresh({ quiet: true }), loadDesktopWorkspace(), scrollToLatest()]);
  } catch (cause) {
    setError(cause, '长任务 Worker 执行失败。');
    await refresh({ quiet: true });
  } finally {
    runtimeTaskWorkerBusy.value = false;
  }
}

function startRuntimeTaskWorker() {
  if (!desktopBridge.value?.desktop?.execute) return;
  if (runtimeTaskWorkerTimer) clearInterval(runtimeTaskWorkerTimer);
  runtimeTaskWorkerTimer = setInterval(processNextRuntimeTask, 2_000);
}

async function openDesktopArtifact(artifact) {
  const endpoint = desktopBridge.value?.desktop;
  if (!endpoint?.openArtifact) return;
  const result = await endpoint.openArtifact(artifact?.name, artifact?.destination || 'desktop');
  if (!result?.opened) error.value = result?.error || '无法打开该本地产物。';
}

onMounted(async () => {
  if (props.identityLoginProvider) { await login(); return; }
  await loadDesktopWorkspace();
  try {
    if (client.enterpriseAuthenticated) {
      const session = await client.enterpriseSession();
      profile.value = session.user;
      await initializeAuthenticatedSession();
      return;
    }
    oaConnection.value = await client.oaConnection();
    if (!client.identitySessionId) {
      authenticated.value = false;
      loading.value = false;
      return;
    }
    const session = await client.identitySession();
    profile.value = session.user;
    await initializeAuthenticatedSession();
  } catch {
    authenticated.value = false;
    loading.value = false;
  }
});

onUnmounted(() => {
  recognition?.abort?.();
  if (endpointHeartbeatTimer) clearInterval(endpointHeartbeatTimer);
  if (runtimeTaskWorkerTimer) clearInterval(runtimeTaskWorkerTimer);
});
</script>

<template>
  <main :class="['agent-workbench', `layout-${layout}`, { authenticated }]">
    <div v-if="isDesktop && desktopBridge" class="native-titlebar">
      <div class="titlebar-drag"><span class="brand-mark small">Z</span><b>元域智脑</b><em>企业私有 Agent</em></div>
      <div class="window-controls">
        <button aria-label="最小化" @click="windowAction('minimize')">—</button>
        <button aria-label="最大化" @click="windowAction('toggleMaximize')">□</button>
        <button class="close" aria-label="关闭" @click="windowAction('close')">×</button>
      </div>
    </div>

    <section v-if="!authenticated" class="auth-screen">
      <div class="auth-intro">
        <div class="brand-lockup"><span class="brand-mark">Z</span><div><b>元域智脑</b><small>YUANYUAN HEALTH · PRIVATE AGENT</small></div></div>
        <div class="auth-copy"><span class="section-label">SECURE WORKSPACE</span><h1>把企业上下文带进每一次决策。</h1><p>统一连接告警、证据、任务与审批。模型负责理解和规划，权限与执行始终由服务端控制。</p></div>
        <div class="trust-list"><span><i/>身份与组织权限实时生效</span><span><i/>写操作需要本人确认</span><span><i/>规划、审批和回执全链路留痕</span></div>
      </div>
      <form v-if="identityLoginProvider" class="auth-card" @submit.prevent="login">
        <div><span class="section-label">ENTERPRISE WORKSPACE</span><h2>智脑工作台 · {{ identityProviderName }}</h2><p>使用企业身份登录，业务权限由平台账号决定。</p></div>
        <p role="status">{{ loginLoading ? `正在验证${identityProviderName}身份…` : identityEntryHint }}</p>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="primary-action" type="submit" :disabled="loginLoading">{{ loginLoading ? '正在登录…' : `使用${identityProviderName}登录` }}</button>
        <small>可对话、上传材料和处理权限内的业务；本机文件写入须使用独立桌面客户端。</small>
      </form>
      <form v-else class="auth-card" @submit.prevent="login">
        <div><span class="section-label">SIGN IN</span><h2>登录智脑工作台</h2><p>使用企业身份进入您的专属工作空间。</p></div>
        <div class="login-mode"><button type="button" :class="{ active: loginMode === 'oa' }" @click="loginMode = 'oa'">OA / BPM</button><button type="button" :class="{ active: loginMode === 'local' }" @click="loginMode = 'local'">平台账号</button></div>
        <div class="connection-state"><i/>{{ loginMode === 'oa' ? (oaConnection?.status === 'connected_demo' ? 'OA / BPM 模拟连接正常' : 'OA 身份服务可用') : '平台账号中心已启用' }}</div>
        <label><span>{{ loginMode === 'oa' ? 'OA 账号' : '平台账号' }}</span><input v-model.trim="account" autocomplete="username" placeholder="name@demo.local"/></label>
        <label><span>密码</span><input v-model="password" type="password" autocomplete="current-password" placeholder="输入登录密码"/></label>
        <p v-if="error" class="inline-error">{{ error }}</p>
        <button class="primary-action" type="submit" :disabled="loginLoading">{{ loginLoading ? '正在验证…' : '继续' }}</button>
        <small class="demo-note">演示账号：admin、production、quality、procurement、market @demo.local；密码统一为 demo。</small>
      </form>
    </section>

    <section v-else class="workspace-shell">
      <aside v-if="isDesktop" class="workspace-sidebar">
        <div class="brand-lockup sidebar-brand"><span class="brand-mark">Z</span><div><b>元域智脑</b><small>PRIVATE AGENT</small></div></div>
        <button class="new-task" @click="startConversation"><span>＋</span>新建任务</button>
        <nav class="workspace-nav" aria-label="智脑功能导航">
          <button :class="{ active: view === 'assistant' }" @click="view = 'assistant'"><span>◈</span><b>智脑</b><small>对话与任务规划</small></button>
          <button :class="{ active: view === 'alerts' }" @click="view = 'alerts'"><span>⌁</span><b>告警</b><small>授权范围内的风险</small><em v-if="alertCount">{{ alertCount }}</em></button>
          <button :class="{ active: view === 'tasks' }" @click="view = 'tasks'"><span>✓</span><b>待办</b><small>确认、审批与回执</small><em v-if="pendingCount">{{ pendingCount }}</em></button>
        </nav>
        <div class="sidebar-section task-list"><span>任务空间 <em v-if="runningTaskCount">{{ runningTaskCount }} 运行中</em></span><button v-for="task in conversations.filter((item) => item.status === 'active')" :key="task.id" :class="['conversation-item', { active: task.id === activeConversationId }]" @click="selectConversation(task.id)"><i :class="{ running: taskStates[task.id]?.sending || taskStates[task.id]?.executing }"/><span><b>{{ task.title }}</b><small>{{ task.task?.phase || 'new' }} · {{ Math.round((task.context?.utilization || 0) * 100) }}%</small></span><em title="归档任务" @click.stop="archiveConversation(task.id)">×</em></button></div>
        <div class="sidebar-spacer"/>
        <div class="sidebar-status"><i :class="{ offline: !agentHealthy }"/><div><b>{{ agentHealthy ? '智脑运行正常' : '正在同步状态' }}</b><small>{{ operations?.runtime?.model || '受控模型网关' }}</small></div></div>
        <button class="account-button" @click="logout"><span class="account-avatar">{{ profile?.name?.slice(0, 1) || 'U' }}</span><span><b>{{ profile?.name || profile?.roleName || '企业用户' }}</b><small>{{ profile?.roleName || profile?.department || '已认证身份' }}</small></span><em>退出</em></button>
      </aside>

      <section class="workspace-main">
        <header class="workspace-header">
          <div><span class="section-label">{{ pageMeta.eyebrow }}</span><h1>{{ pageMeta.title }}</h1><p>{{ pageMeta.description }}</p></div>
          <div class="header-tools"><span class="secure-chip"><i/>受控运行</span><button v-if="isDesktop" :class="{ active: contextOpen }" aria-label="切换上下文面板" @click="contextOpen = !contextOpen">上下文</button><button aria-label="刷新" @click="refresh()">↻</button></div>
        </header>

        <p v-if="error" class="workspace-error"><span>!</span>{{ error }}<button aria-label="关闭错误提示" @click="clearError">×</button></p>

        <template v-if="view === 'assistant'">
          <div ref="chatViewport" class="conversation-viewport">
            <div class="conversation-content">
              <div class="conversation-heading"><span class="agent-orb">Z</span><div><span>元域智脑</span><h2>今天想聊聊什么，或推进什么工作？</h2><p>用自然语言说出问题、想法或目标；智脑会判断是否需要进入受控任务流程。</p></div></div>
              <div v-if="!isDesktop" class="mobile-task-strip"><button class="create" @click="startConversation">＋</button><button v-for="task in conversations.filter((item) => item.status === 'active')" :key="task.id" :class="{ active: task.id === activeConversationId }" @click="selectConversation(task.id)"><i :class="{ running: taskStates[task.id]?.sending || taskStates[task.id]?.executing }"/>{{ task.title }}</button></div>
              <div v-if="!isDesktop" class="mobile-runtime-line"><span><i :class="{ offline: !agentHealthy }"/>{{ agentHealthy ? '智脑运行正常' : '正在同步智脑' }}</span><b>审计 {{ operations?.telemetry?.auditCoverage || '--' }} · 队列 {{ operations?.metrics?.queueDepth ?? '--' }}</b></div>
              <div v-if="!isDesktop" class="mobile-quick-actions"><button @click="send('请汇总我当前需要处理的风险、审批和任务，并按优先级给出建议。')">今日待办</button><button @click="send('请检查生产批次和原料质量风险，并列出需要我确认的事项。')">生产质控</button><button @click="send('我需要采购一批生产原料，请先生成受控协同计划。')">发起采购</button></div>
              <button v-if="!isDesktop && activeAlert" class="mobile-alert-context" @click="askAboutAlert()"><span>{{ activeAlert.severity || 'P2' }} 优先告警</span><b>{{ activeAlert.title }}</b><small>{{ activeAlert.description || activeAlert.detail }}</small><em>{{ activeAlert.channel === '虚拟电话' ? `电话 ${activeAlert.status} · ` : '' }}交给智脑分析 ↗</em></button>
              <article v-for="(message, index) in messages" :key="`${message.createdAt}-${index}`" :class="['chat-message', message.type]">
                <div class="message-author"><span>{{ message.type === 'agent' ? 'Z' : message.type === 'user' ? (profile?.name?.slice(0, 1) || '我') : '!' }}</span><b>{{ message.type === 'agent' ? '智脑' : message.type === 'user' ? '我' : '系统' }}</b><time>{{ formatTime(message.createdAt) }}</time></div>
                <div class="message-body"><p>{{ message.text }}</p><small v-if="message.attachmentCount">已提交 {{ message.attachmentCount }} 个受控材料</small>
                  <section v-if="message.type === 'agent' && (message.inferenceSource || message.evidenceTrace || message.lifecycle)" class="task-result-status">
                    <header><span :class="['model-source', message.inferenceSource || 'deterministic']">{{ message.inferenceSource === 'ark' ? '火山方舟已生成' : message.inferenceSource === 'local' ? '本地模型已生成' : ['openai', 'deepseek', 'compatible'].includes(message.inferenceSource) ? '云端模型已生成' : ['fallback', 'circuit_breaker', 'model_governance'].includes(message.inferenceSource) ? '模型未返回回答 · 备用说明' : message.inferenceSource === 'output_safety' ? '模型回答未通过校验' : '受控任务结果' }}</span><b v-if="message.runtime">{{ modelLabel(message.runtime) }}</b></header>
                    <div v-if="message.lifecycle" class="lifecycle-state"><b>{{ message.lifecycle.label }}</b><small>数据：{{ message.lifecycle.dataAccess === 'read_completed' ? '已按权限读取' : message.lifecycle.dataAccess === 'read_partial' ? '已尝试读取，部分核验未通过' : '未读取' }} · 写入：{{ writeStateLabel(message.lifecycle.businessWrite) }}</small></div>
                    <small v-if="message.memory?.source === 'long_term'" class="memory-status">已承接长期记忆：{{ message.memory.notice }}</small>
                    <small v-else-if="message.memory?.source === 'conversation'" class="memory-status">已承接当前任务记忆。</small>
                    <div v-if="traceHighlights(message.evidenceTrace).length" class="task-stage-list"><span v-for="item in traceHighlights(message.evidenceTrace)" :key="item.stage">{{ item.label }}</span></div>
                    <small>展示的是可核验的任务执行记录，不展示模型内部思维链。</small>
                  </section>
                  <section v-if="message.guidance" :class="['guidance-card', message.guidance.severity]"><header><span>路径校验</span><b>{{ message.guidance.title }}</b></header><p><strong>不合理之处：</strong>{{ message.guidance.problem }}</p><p><strong>原因：</strong>{{ message.guidance.why }}</p><div><span v-for="item in message.guidance.suggestions" :key="item">{{ item }}</span></div><small v-if="message.guidance.example">建议提问：{{ message.guidance.example }}</small></section>
                  <details v-if="message.evidence?.length"><summary>查看 {{ message.evidence.length }} 条业务证据</summary><div class="evidence-list"><article v-for="item in message.evidence" :key="`${item.source}-${item.id}`"><header><b>{{ item.source }}</b><code>{{ item.id }}</code></header><strong>{{ item.title || '受控证据' }}</strong><p v-if="item.statement">{{ item.statement }}</p><footer><span>{{ item.classification || 'internal' }}</span><span v-if="item.locator?.page">第 {{ item.locator.page }} 页</span><span v-if="item.confidence">{{ item.confidence }}</span><span>{{ item.version || 'snapshot' }}</span><time v-if="item.capturedAt">{{ new Date(item.capturedAt).toLocaleString() }}</time><code v-if="item.contentHash"># {{ item.contentHash.slice(0, 12) }}</code></footer></article></div></details>
                  <details v-if="message.materialAttachments?.length"><summary>附件读取范围</summary><div class="evidence-list"><article v-for="file in message.materialAttachments" :key="file.id"><b>{{ file.name }} · {{ !file.modelContentEligible ? '未读取 / 已隔离' : file.parsing?.partial || file.parsing?.truncated ? '部分读取' : '摘录可引用' }}</b><p v-if="file.parsing?.reason">{{ file.parsing.reason }}</p><p v-if="file.parsing?.truncated">内容已截断，未展示部分不能推断，请拆分文件或缩小范围。</p><p v-if="file.parsing?.missingPages?.length">未识别页面视觉内容：{{ file.parsing.missingPages.join('、') }}</p><p v-for="warning in file.parsing?.warnings || []" :key="warning">{{ warning }}</p></article></div></details>
                  <details v-if="message.plan?.length"><summary>查看执行计划</summary><div class="plan-list"><span v-for="item in message.plan" :key="item.tool"><i :class="item.status"/>{{ item.tool }}<small>{{ item.status }}</small></span></div></details>
                  <details v-if="message.evidenceTrace" class="trace-details"><summary>完整证据链 · {{ message.evidenceTrace.eventCount }} 个事件</summary><div class="trace-summary"><span>TRACE</span><code>{{ message.evidenceTrace.id }}</code><b :class="{ valid: message.evidenceTrace.integrity?.valid }">{{ message.evidenceTrace.integrity?.valid ? '哈希链校验通过' : '完整性待复核' }}</b><small>{{ message.evidenceTrace.status }}</small></div><ol class="trace-timeline"><li v-for="event in message.evidenceTrace.events" :key="event.id"><i/><div><header><b>{{ event.summary }}</b><time>{{ new Date(event.createdAt).toLocaleString() }}</time></header><p>{{ event.stage }} · {{ event.type }} · {{ event.status }}</p><details v-if="event.details && Object.keys(event.details).length" class="event-payload"><summary>查看事件字段</summary><pre>{{ JSON.stringify(event.details, null, 2) }}</pre></details><div v-if="event.evidence?.length" class="trace-evidence-refs"><span v-for="item in event.evidence" :key="`${event.id}-${item.source}-${item.id}`">{{ item.source }} / {{ item.id }} / #{{ item.contentHash.slice(0, 10) }}</span></div><code>#{{ event.hash.slice(0, 16) }} · prev {{ event.previousHash?.slice(0, 10) || 'ROOT' }}</code></div></li></ol></details>
                  <div v-else-if="message.traceId" class="persisted-trace-ref"><span>TRACE</span><code>{{ message.traceId }}</code><small>证据链已持久化，可在审计中心按 ID 追溯</small></div>
                </div>
              </article>
              <article v-if="sending" class="chat-message agent"><div class="message-author"><span>Z</span><b>智脑</b></div><div class="thinking"><i/><i/><i/><div><b>正在执行受控任务</b><span>安全校验 → 权限裁剪 → 数据读取 → 模型生成 → 计划与审计</span></div></div></article>
              <article v-if="pending" class="confirmation-card"><div class="confirmation-icon">✓</div><div><span>{{ pending.target === 'desktop' ? '本机操作待本人确认 · 尚未写入文件' : '方案待本人确认 · 尚未创建申请' }}</span><h3>{{ pending.label }}</h3><p>{{ pending.impact }}</p><small v-if="pending.control">权限校验：{{ pending.control.requiredCapability }} · {{ pending.control.reason }}</small></div><div class="confirmation-actions"><button :disabled="executing || (pending.target === 'desktop' && !desktopBridge?.desktop?.execute)" @click="execute">{{ executing ? '正在执行…' : pending.confirmLabel || '确认创建受控业务草稿' }}</button><button class="cancel" :disabled="executing" @click="cancelPending">撤回方案</button></div></article>
            </div>
          </div>

          <footer class="composer-shell">
            <div class="composer-wrap">
              <div v-if="attachments.length" class="attachment-strip"><div v-for="(attachment, index) in attachments" :key="`${attachment.name}-${index}`" class="attachment-chip"><span>{{ attachment.type }}</span><b>{{ attachment.name }}</b><button aria-label="移除材料" @click="attachments.splice(index, 1)">×</button></div></div>
              <textarea v-model="input" rows="1" placeholder="直接说出你的问题、想法或想推进的事情…" @keydown.enter.exact.prevent="send()"/>
              <div class="composer-actions"><div><button aria-label="上传图片或文档" @click="attachmentInput?.click()">＋</button><button :class="{ listening }" aria-label="语音输入" @click="startVoice">{{ listening ? '●' : '◉' }}</button></div><span>Enter 发送</span><button class="send-button" :disabled="sending || (!input.trim() && !attachments.length)" aria-label="发送消息" @click="send()">↑</button></div>
              <input ref="attachmentInput" class="file-input" type="file" accept="image/jpeg,image/png,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/json,text/csv,application/yaml,text/yaml" multiple @change="selectAttachments"/>
            </div>
            <small>智脑可能会出错。重要决策请核对来源证据；业务写入必须经过权限与确认。</small>
          </footer>
        </template>

        <section v-else-if="view === 'alerts'" class="collection-view">
          <div v-if="!notices.length" class="empty-state"><span>⌁</span><h2>暂无新的风险告警</h2><p>智脑会持续监控您有权访问的数据域。</p></div>
          <article v-for="notice in notices" :key="notice.id" :class="['collection-card', 'alert-card', `severity-${(notice.severity || 'P2').toLowerCase()}`]"><div class="card-icon">{{ notice.channel === '虚拟电话' ? '☎' : '⌁' }}</div><div><span><b class="alert-level">{{ notice.severity || 'P2' }}</b> AI 基座告警 · {{ notice.channel || '站内信' }}</span><h3>{{ notice.title }}</h3><p>{{ notice.description || notice.detail || '点击后，智脑会结合授权证据解释风险。' }}</p><small>{{ notice.id }} · {{ notice.status || notice.riskStatus }}</small></div><button @click="askAboutAlert(notice)">交给智脑分析</button></article>
        </section>

        <section v-else class="collection-view">
          <div v-if="!workItems.length" class="empty-state"><span>✓</span><h2>当前没有待办</h2><p>需要确认、审批或复核的任务会出现在这里。</p></div>
          <article v-for="item in workItems" :key="item.id" class="collection-card task-card"><div class="card-icon">✓</div><div><span>{{ item.risk }} 风险工作项</span><h3>{{ item.title }}</h3><p>{{ item.approvers.join(' → ') }}</p><small>{{ item.id }}</small></div><em>{{ item.status || '待处理' }}</em></article>
        </section>
      </section>

      <aside v-if="isDesktop && contextOpen" class="context-panel">
        <div class="context-heading"><div><span class="section-label">LIVE CONTEXT</span><h2>当前上下文</h2></div><button aria-label="关闭上下文" @click="contextOpen = false">×</button></div>
        <section class="context-section status-context"><div><span>智脑状态</span><b :class="{ healthy: agentHealthy }">{{ agentHealthy ? '运行正常' : '同步中' }}</b></div><div><span>审计覆盖率</span><b>{{ operations?.telemetry?.auditCoverage || '--' }}</b></div><div><span>任务队列</span><b>{{ operations?.metrics?.queueDepth ?? '--' }}</b></div><div><span>维护 Worker</span><b :class="{ healthy: operations?.telemetry?.runtimeQueue?.worker?.status === 'healthy' }">{{ operations?.telemetry?.runtimeQueue?.worker?.status === 'healthy' ? '单活在线' : operations?.telemetry?.runtimeQueue?.worker?.status === 'standby_only' ? '仅备用' : '未启动' }}</b></div></section>
        <section class="context-section context-budget"><span class="context-label">任务上下文</span><div class="context-meter"><i :style="{ width: `${Math.min(contextPercent, 100)}%` }"/></div><div><span>会话存储预算</span><b>{{ ((conversation?.context?.effectiveMaxTokens || 128000) / 1000).toFixed(0) }}K tokens</b></div><div><span>当前占用</span><b>{{ contextPercent }}%</b></div><div><span>自动压缩</span><b>{{ conversation?.context?.compactionCount || 0 }} 次</b></div><small>达到 70% 自动压缩；单轮理解历史最多 28,000 字符，材料另有限额，并非每次发送整个会话。</small></section>
        <section class="context-section"><span class="context-label">快捷任务</span><button @click="send('请汇总我当前需要处理的风险、审批和任务，并按优先级给出建议。')"><b>今日待办</b><small>汇总风险、审批与任务</small><em>↗</em></button><button @click="send('请检查生产批次和原料质量风险，并列出需要我确认的事项。')"><b>生产质控</b><small>检查批次与原料风险</small><em>↗</em></button><button @click="send('我需要采购一批生产原料，请先生成受控协同计划。')"><b>发起采购</b><small>生成受控协同计划</small><em>↗</em></button></section>
        <section v-if="runtimeTasks.length" class="context-section runtime-task-context"><span class="context-label">端侧长任务</span><article v-for="task in runtimeTasks.slice(0, 5)" :key="task.id"><header><i :class="task.status"/><b>{{ runtimeTaskLabel(task) }}</b><small>{{ task.progress }}%</small></header><p>{{ task.commandId }}</p><div v-if="task.status === 'queued'"><button @click="controlRuntimeTask(task, 'pause')">暂停</button><button class="danger" @click="controlRuntimeTask(task, 'cancel')">取消</button></div><div v-else-if="task.status === 'paused'"><button @click="controlRuntimeTask(task, 'resume')">恢复</button><button class="danger" @click="controlRuntimeTask(task, 'cancel')">取消</button></div><em v-if="task.result?.message">{{ task.result.message }}</em></article><small>确认后先进入持久队列；Worker 领取前可暂停或取消，超时后不会自动重试电脑操作。</small></section>
        <section v-if="desktopBridge" class="context-section artifact-context"><span class="context-label">本机工作区</span><div class="endpoint-capability"><i :class="{ ready: desktopEndpointStatus?.connected && desktopEndpointStatus?.allowed, blocked: desktopEndpointStatus && !desktopEndpointStatus.allowed }"/><b>{{ desktopEndpointStatus?.allowed ? '端侧运行环境可信在线' : desktopEndpointStatus?.connected ? '端侧版本未获信任' : desktopCapabilities ? '等待端侧心跳' : '端侧执行器不可用' }}</b><small>{{ desktopCapabilities?.tools?.length || 0 }} 个工具 · {{ desktopEndpointStatus?.appVersion ? `v${desktopEndpointStatus.appVersion}` : '版本待验证' }}</small></div><em v-if="desktopEndpointStatus?.publicKeyFingerprint" class="endpoint-proof">{{ desktopEndpointStatus.trustState }} · {{ desktopEndpointStatus.keyProtection === 'os_user_bound' ? '系统加密' : '文件保护' }} · key #{{ desktopEndpointStatus.publicKeyFingerprint.slice(0, 12) }}</em><em v-if="desktopEndpointStatus && !desktopEndpointStatus.allowed" class="endpoint-reason">{{ desktopEndpointStatus.reason }}</em><button v-for="artifact in desktopArtifacts.slice(0, 5)" :key="`${artifact.destination || 'desktop'}:${artifact.name}`" @click="openDesktopArtifact(artifact)"><b>{{ artifact.name }}</b><small>{{ artifact.workspace || '桌面\\元域智脑工作区' }} · {{ artifact.type.toUpperCase() }} · {{ formatBytes(artifact.bytes) }} · {{ new Date(artifact.modifiedAt).toLocaleString() }}</small><em>打开</em></button><small v-if="desktopCapabilities && !desktopArtifacts.length">尚无本地产物。可以指定保存到桌面、文档或下载目录；未指定时默认桌面。</small></section>
        <section v-if="activeAlert" class="context-section alert-context"><span class="context-label">{{ activeAlert.severity || 'P2' }} 优先告警 · {{ activeAlert.channel || '站内信' }}</span><h3>{{ activeAlert.title }}</h3><p>{{ activeAlert.description || activeAlert.detail }}</p><button @click="askAboutAlert()">分析此告警 <em>↗</em></button></section>
        <section v-if="operations?.telemetry?.enterpriseConnectors?.length" class="context-section connector-context"><span class="context-label">企业数据通道</span><p v-for="connector in operations.telemetry.enterpriseConnectors" :key="connector.systemId"><i :class="connector.status"/><b>{{ connector.code }}</b><small>{{ connector.status === 'ready_for_scoped_access' ? '已配置，待受控验证' : connector.status === 'not_configured' ? '本地模拟' : '配置待处理' }}</small></p><em v-if="operations.telemetry.enterpriseConnectors.some((item) => item.status === 'not_configured')">本地模拟数据不会被表述为实时企业数据。</em></section>
        <section v-if="conversation?.task?.goal" class="context-section pin-context"><span class="context-label">当前任务目标</span><p>{{ conversation.task.goal }}</p><button :disabled="pinningMemory || conversation.task.pinnedMemoryId" @click="pinCurrentTask">{{ conversation.task.pinnedMemoryId ? '已固定为长期记忆' : pinningMemory ? '正在固定…' : '固定为长期记忆' }}</button><em>仅在您主动固定后保存；不会把模型推测或企业数据写入长期记忆。</em></section>
        <section v-if="memories.length" class="context-section memory-context"><span class="context-label">长期记忆</span><p v-for="memory in memories.slice(0, 4)" :key="memory.id"><b>{{ memory.domain || '通用' }}</b><small>{{ memory.summary }}<em v-if="memory.entities?.length"> · {{ memory.entities.map((entity) => entity.id).join('、') }}</em></small><button :aria-label="`删除记忆 ${memory.summary}`" @click="forgetMemory(memory.id)">×</button></p><em>只保存安全通过的用户目标，90 天后自动清理；可随时删除。</em></section>
        <section v-if="learningProfile" class="context-section learning-context"><span class="context-label">学习与数据使用</span><button class="learning-toggle" :disabled="savingLearningProfile" @click="updateLearningSetting('workflowLearningEnabled')"><span><b>成功工作流学习</b><small>仅记录本人确认且执行成功的工具类型</small></span><i :class="{ enabled: learningProfile.workflowLearningEnabled }">{{ learningProfile.workflowLearningEnabled ? '已开启' : '默认关闭' }}</i></button><button class="learning-toggle" :disabled="savingLearningProfile" @click="updateLearningSetting('personalizationEnabled')"><span><b>个性化偏好</b><small>为后续偏好能力预留的独立授权</small></span><i :class="{ enabled: learningProfile.personalizationEnabled }">{{ learningProfile.personalizationEnabled ? '已开启' : '默认关闭' }}</i></button><div class="learning-policy"><b>企业数据</b><small>只做权限内检索，不用于模型训练</small></div><p v-for="signal in learningProfile.signals?.slice(0, 3)" :key="signal.id"><span><b>{{ signal.toolId }}</b><small>已确认成功 {{ signal.confirmedSuccessCount }} 次 · 30 天内有效</small></span><button :aria-label="`撤销学习记录 ${signal.toolId}`" @click="forgetLearningSignal(signal.id)">×</button></p><em>关闭工作流学习会立即清除全部个人学习信号；不保存原始提问和企业载荷。</em></section>
        <section class="context-section safety-context"><span class="context-label">安全边界</span><p><i/>仅使用当前身份可访问的数据</p><p><i/>模型不直接执行系统写入</p><p><i/>高风险动作需要确认与审批</p></section>
      </aside>

      <nav class="mobile-navigation" aria-label="智脑功能导航"><button :class="{ active: view === 'assistant' }" @click="view = 'assistant'"><span>◈</span>智脑</button><button :class="{ active: view === 'alerts' }" @click="view = 'alerts'"><span>⌁</span>告警<i v-if="alertCount">{{ alertCount }}</i></button><button :class="{ active: view === 'tasks' }" @click="view = 'tasks'"><span>✓</span>待办<i v-if="pendingCount">{{ pendingCount }}</i></button><button @click="logout"><span>{{ profile?.name?.slice(0, 1) || 'U' }}</span>我的</button></nav>
      <div v-if="loading" class="loading-toast"><i/>正在同步智脑状态…</div>
    </section>
  </main>
</template>

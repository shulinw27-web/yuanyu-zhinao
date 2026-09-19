<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { canExecuteSemanticTask } from '../task-guards.js';
import { resolveSemanticTaskSelection } from '../task-selection.js';

const props = defineProps({ client: { type: Object, required: true }, initialTaskId: { type: String, default: '' } });
const desktopBridge = globalThis.semanticOperationsDesktop || null;
const emit = defineEmits(['applied']);
const tasks = ref([]);
const selected = ref(null);
const selectedTrace = ref(null);
const exportedReport = ref(null);
const input = ref('');
const adoptionMode = ref('merge');
const files = ref([]);
const busy = ref(false);
const message = ref('');
const fileInput = ref(null);
const transcript = ref(null);
const proposalEditor = ref(null);
const editorDirty = ref(false);
const editorMessage = ref('');
const keyCorrectionReasons = ref({});
const needsKeyCorrection = objectId => selected.value?.proposal?.schemaDiscovery?.objectTypes?.some(object => object.id === objectId && !object.key);
const selectedGraphObjectId = ref('');
const taskQuery = ref('');
const taskStatus = ref('');
const showArchived = ref(false);
let taskLoadGeneration = 0;
const canSubmit = computed(() => Boolean(input.value.trim() || files.value.length) && !busy.value);
const canEditProposal = computed(() => selected.value?.status === 'waiting_confirmation' && selected.value?.command === 'apply_proposal' && Boolean(proposalEditor.value));
const canExecute = computed(() => canExecuteSemanticTask({ task: selected.value, editorDirty: editorDirty.value, busy: busy.value }));
const graphNodes = computed(() => (proposalEditor.value?.objectTypes || []).map((item, index) => {
  const fieldDefinitions = item.fieldDefinitions || [];
  const pendingMappings = fieldDefinitions.filter((field) => field.mappingStatus === 'pending' || (!field.sourceField && !['derived', 'ignored'].includes(field.mappingStatus))).length;
  const validationStatus = selected.value?.proposal?.mappingValidation?.objects?.find((object) => object.objectId === item.id)?.status || 'unverified';
  return { ...item, x: 125 + (index % 3) * 285, y: 72 + Math.floor(index / 3) * 118, pendingMappings, mappedFields: fieldDefinitions.length - pendingMappings, validationStatus };
}));
const graphHeight = computed(() => Math.max(210, 145 + Math.floor(Math.max(0, graphNodes.value.length - 1) / 3) * 118));
const graphEdges = computed(() => (proposalEditor.value?.relationshipTypes || []).map((item, index) => ({ ...item, key: `${item.from}-${item.predicate}-${item.to}-${index}`, fromNode: graphNodes.value.find((node) => node.id === item.from), toNode: graphNodes.value.find((node) => node.id === item.to) })).filter((item) => item.fromNode && item.toNode));
const mappingSummary = computed(() => {
  const fields = graphNodes.value.flatMap((item) => item.fieldDefinitions || []);
  const pending = fields.filter((field) => field.mappingStatus === 'pending' || (!field.sourceField && !['derived', 'ignored'].includes(field.mappingStatus))).length;
  return { total: fields.length, pending, ready: fields.length - pending };
});
const selectedMappingValidationObject = computed(() => selected.value?.proposal?.mappingValidation?.objects?.find((object) => object.objectId === selectedGraphObjectId.value) || selected.value?.proposal?.mappingValidation?.objects?.[0] || null);
const selectedMappingIssues = computed(() => (selected.value?.proposal?.mappingValidation?.issues || []).filter((issue) => issue.objectId === selectedMappingValidationObject.value?.objectId));
const displayPreviewValue = (value) => value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);

const statusLabel = { waiting_confirmation: '等待确认', executing: '执行中', retryable: '可重试', completed: '已完成', blocked: '已阻止', needs_input: '等待补充', denied: '权限不足', failed: '回答失败，可重试' };
const taskStatusLabel = task => task.status === 'completed' && task.intent === 'conversation' ? '已回应' : task.status === 'completed' && task.intent === 'needs_clarification' ? '等待补充' : statusLabel[task.status] || task.status;
const intentLabel = { build_model: '建设模型', discover_sources: '来源预检', inspect_status: '检查状态', validate_model: '校验模型', simulate_model: '模拟构建', publish_model: '发布模型', conversation: '普通对话', needs_clarification: '需要补充', unsupported_operation: '受限操作', permission_denied: '权限不足' };
const formatTaskTime = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });

const setInput = (value) => { input.value = String(value || ''); };
defineExpose({ setInput });

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('材料读取失败，请重新选择。'));
  reader.readAsDataURL(file);
});

const inferredMimeType = (file) => {
  if (file.type) return file.type;
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  return ({ json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })[extension] || '';
};

async function chooseFiles(event) {
  const selectedFiles = Array.from(event.target.files || []);
  event.target.value = '';
  if (!selectedFiles.length) return;
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/json', 'text/csv', 'application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
  if (files.value.length + selectedFiles.length > 5) { message.value = '一次最多上传5个材料。'; return; }
  if ([...files.value, ...selectedFiles].reduce((total, file) => total + (file.dataUrl ? Math.ceil(file.dataUrl.length * 0.75) : file.size || 0), 0) > 12 * 1024 * 1024) { message.value = '全部材料合计必须小于12MB。'; return; }
  try {
    const next = await Promise.all(selectedFiles.map(async (file) => {
      const mimeType = inferredMimeType(file);
      if (!allowed.has(mimeType)) throw new Error('仅支持PDF、图片、DOCX、XLSX、JSON、YAML和CSV。');
      const rawDataUrl = await readAsDataUrl(file);
      const dataUrl = rawDataUrl.replace(/^data:[^;]*;/, `data:${mimeType};`);
      return { name: file.name, mimeType, dataUrl };
    }));
    files.value.push(...next); message.value = '';
  } catch (error) { message.value = error.message; }
}

async function loadTasks(preferredId) {
  const generation = ++taskLoadGeneration;
  const client = props.client;
  if (preferredId) selected.value = null;
  try {
    const result = await client.tasks({ query: taskQuery.value, status: taskStatus.value, archived: showArchived.value || undefined, limit: 100 });
    if (generation !== taskLoadGeneration) return;
    const next = await resolveSemanticTaskSelection({ client, tasks: result.tasks || [], preferredId, selectedId: selected.value?.id });
    if (generation !== taskLoadGeneration) return;
    tasks.value = next.tasks; selected.value = next.selected;
    if (preferredId) message.value = '';
  } catch (error) {
    if (generation !== taskLoadGeneration) return;
    if (preferredId) { selected.value = null; message.value = '目标任务不可见或加载失败，请返回接入项目核对后重试。'; }
    else throw error;
  }
}

async function archiveTask() {
  if (!selected.value || selected.value.status === 'executing') return;
  busy.value = true;
  try {
    await props.client.archiveTask(selected.value.id);
    message.value = '任务已归档，执行证据仍保留。';
    await loadTasks();
  } catch (error) { message.value = error.message || '任务归档失败。'; }
  finally { busy.value = false; }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function initializeProposalEditor() {
  const proposal = selected.value?.proposal;
  keyCorrectionReasons.value = Object.fromEntries((proposal?.primaryKeyCorrections || []).map(item => [item.objectId, item.reason]));
  if (!proposal) { proposalEditor.value = null; editorDirty.value = false; editorMessage.value = ''; return; }
  proposalEditor.value = {
    revision: proposal.revision || 1,
    objectTypes: clone(proposal.objectTypes || []).map((item) => ({
      ...item,
      fieldDefinitions: item.fieldDefinitions?.length ? item.fieldDefinitions.map((field) => ({ ...field, sourceField: field.sourceField ?? field.name, mappingStatus: field.mappingStatus || 'mapped' })) : (item.fields || []).map((name) => ({ name, type: 'string', required: name === item.key, primaryKey: name === item.key, sourceField: name, mappingStatus: 'mapped', reference: null, description: null }))
    })),
    relationshipTypes: clone(proposal.relationshipTypes || [])
  };
  if (!proposalEditor.value.objectTypes.some((item) => item.id === selectedGraphObjectId.value)) selectedGraphObjectId.value = proposalEditor.value.objectTypes[0]?.id || '';
  editorDirty.value = false;
  editorMessage.value = '';
}

function markEditorDirty() { editorDirty.value = true; editorMessage.value = '存在尚未保存的修改，保存后才能确认写入草稿。'; }

function setPrimaryKey(object, fieldName) {
  object.key = fieldName;
  object.fieldDefinitions.forEach((field) => { field.primaryKey = field.name === fieldName; if (field.primaryKey) field.required = true; });
  markEditorDirty();
}

function addField(object) {
  let index = object.fieldDefinitions.length + 1;
  let name = `field_${index}`;
  while (object.fieldDefinitions.some((field) => field.name === name)) { index += 1; name = `field_${index}`; }
  object.fieldDefinitions.push({ name, type: 'string', required: false, primaryKey: false, sourceField: '', mappingStatus: 'pending', reference: null, description: null });
  object.fields = object.fieldDefinitions.map((field) => field.name);
  markEditorDirty();
}

function removeField(object, fieldIndex) {
  if (object.fieldDefinitions.length <= 2) { editorMessage.value = '每个对象至少保留两个字段。'; return; }
  const [removed] = object.fieldDefinitions.splice(fieldIndex, 1);
  if (removed.name === object.key) setPrimaryKey(object, object.fieldDefinitions[0].name);
  object.fields = object.fieldDefinitions.map((field) => field.name);
  markEditorDirty();
}

function syncFieldName(object, field) {
  if (field.primaryKey) object.key = field.name;
  object.fields = object.fieldDefinitions.map((item) => item.name);
  markEditorDirty();
}

function addObject() {
  let index = proposalEditor.value.objectTypes.length + 1;
  let id = `BusinessObject${index}`;
  while (proposalEditor.value.objectTypes.some((item) => item.id === id)) { index += 1; id = `BusinessObject${index}`; }
  proposalEditor.value.objectTypes.push({ id, label: '新业务对象', source: 'wms.custom_object', key: 'id', fields: ['id', 'name'], fieldDefinitions: [{ name: 'id', type: 'string', required: true, primaryKey: true, reference: null, description: null }, { name: 'name', type: 'string', required: false, primaryKey: false, reference: null, description: null }], classification: '内部受限（待复核）', semanticType: id, coreObject: id, sourceSystems: ['WMS'], description: '' });
  const created = proposalEditor.value.objectTypes.at(-1);
  created.fieldDefinitions.forEach((field) => { field.sourceField = ''; field.mappingStatus = 'pending'; });
  selectedGraphObjectId.value = id;
  markEditorDirty();
}

function removeObject(objectId) {
  if (proposalEditor.value.objectTypes.length <= 1) { editorMessage.value = '提案至少保留一个候选对象。'; return; }
  proposalEditor.value.objectTypes = proposalEditor.value.objectTypes.filter((item) => item.id !== objectId);
  proposalEditor.value.relationshipTypes = proposalEditor.value.relationshipTypes.filter((item) => item.from !== objectId && item.to !== objectId);
  selectedGraphObjectId.value = proposalEditor.value.objectTypes[0]?.id || '';
  markEditorDirty();
}

function addRelationship() {
  const [first, second = first] = proposalEditor.value.objectTypes;
  if (!first) return;
  proposalEditor.value.relationshipTypes.push({ from: first.id, predicate: 'references', to: second.id, label: '业务关联', cardinality: 'n:1', evidence: '运营人员复核' });
  markEditorDirty();
}

function removeRelationship(index) { proposalEditor.value.relationshipTypes.splice(index, 1); markEditorDirty(); }

function updateMapping(field) {
  if (['derived', 'ignored'].includes(field.mappingStatus)) field.sourceField = '';
  if (['mapped', 'manual'].includes(field.mappingStatus) && !field.sourceField) field.sourceField = field.name;
  markEditorDirty();
}

async function saveProposalRevision() {
  if (!canEditProposal.value || !editorDirty.value) return;
  busy.value = true; editorMessage.value = '';
  try {
    const objectTypes = proposalEditor.value.objectTypes.map((item) => ({ ...item, fields: item.fieldDefinitions.map((field) => field.name) }));
    const primaryKeyCorrections = objectTypes.filter(item => needsKeyCorrection(item.id) && keyCorrectionReasons.value[item.id]?.trim()).map(item => ({ objectId: item.id, field: item.key, reason: keyCorrectionReasons.value[item.id].trim() }));
    const task = await props.client.reviseProposal(selected.value.id, { revision: proposalEditor.value.revision, objectTypes, relationshipTypes: proposalEditor.value.relationshipTypes, primaryKeyCorrections });
    await loadTasks(task.id);
    message.value = task.response;
    editorMessage.value = '修订已保存，Schema Critic 和 Diff 已重新计算。';
  } catch (error) {
    editorMessage.value = error.body?.code === 'SEMANTIC_PROPOSAL_REVISION_CONFLICT' ? '提案已在其他窗口更新，请重新选择该任务后再修改。' : error.message || '提案修订保存失败。';
  } finally { busy.value = false; }
}

async function createTask() {
  if (!canSubmit.value) return;
  busy.value = true; message.value = '';
  try {
    const task = await props.client.createTask({ text: input.value.trim(), attachments: files.value, adoptionMode: adoptionMode.value, ...(selected.value ? { parentTaskId: selected.value.id } : {}) });
    await loadTasks(task.id);
    input.value = ''; files.value = [];
    if (selected.value?.id !== task.id) { selected.value = task; tasks.value = [task, ...tasks.value.filter(item => item.id !== task.id)]; }
    message.value = ['conversation', 'needs_clarification', 'unsupported_operation', 'permission_denied'].includes(task.intent)
      ? ''
      : task.confirmationRequired ? 'Agent已形成受控执行计划，请检查计划、Critic和Diff后再确认。' : '只读运营任务已完成。';
  } catch (error) { message.value = error.message || '任务创建失败。'; }
  finally { busy.value = false; }
}

async function executeTask() {
  if (!canExecute.value) return;
  busy.value = true; message.value = '';
  try {
    const confirmation = await props.client.confirmTask(selected.value.id);
    selected.value = { ...selected.value, status: 'executing', confirmation: { state: 'consumed' } };
    const result = await props.client.executeTask(selected.value.id, confirmation.confirmationToken);
    await loadTasks(result.task.id);
    message.value = result.task.response;
    emit('applied', { message: result.task.response, task: result.task, result: result.result });
  } catch (error) {
    if (error.body?.task) {
      await loadTasks(error.body.task.id);
      message.value = error.body.task.response || error.message;
    } else message.value = error.message || '任务执行失败。';
  } finally { busy.value = false; }
}

function newTask() {
  selected.value = null; selectedTrace.value = null; input.value = ''; files.value = []; message.value = ''; proposalEditor.value = null; editorDirty.value = false; editorMessage.value = ''; selectedGraphObjectId.value = '';
}

async function loadSelectedTrace() {
  const taskId = selected.value?.id;
  selectedTrace.value = null;
  if (!taskId || !selected.value?.traceId) return;
  try { const result = await props.client.taskTrace(taskId); if (selected.value?.id === taskId) selectedTrace.value = result; } catch { selectedTrace.value = null; }
}

async function exportReport() {
  if (!selected.value || !desktopBridge?.exportReport) { message.value = '受控报告导出仅在语义运营桌面端开放。'; return; }
  if (!globalThis.confirm('确认把当前任务摘要和证据链导出到“文档/元域语义运营报告”？')) return;
  busy.value = true;
  try {
    const report = { reportType: 'semantic_operations_task', exportedAt: new Date().toISOString(), task: selected.value, evidenceTrace: selectedTrace.value };
    const receipt = await desktopBridge.exportReport({ name: `语义运营-${selected.value.title}-${selected.value.id.slice(-6)}`, format: 'json', content: report });
    await props.client.recordReportExport(selected.value.id, { destination: receipt.destination, fileName: receipt.fileName, bytes: receipt.bytes, sha256: receipt.sha256, createdAt: receipt.createdAt });
    exportedReport.value = receipt; message.value = `报告已受控导出：${receipt.fileName}`; await loadTasks(selected.value.id); await loadSelectedTrace();
  } catch (error) { message.value = error.message || '报告导出失败。'; }
  finally { busy.value = false; }
}

onMounted(() => loadTasks(props.initialTaskId || undefined).catch((error) => { message.value = error.message; }));
watch(() => props.initialTaskId, id => loadTasks(id || undefined).catch(error => { message.value = error.message; }));
watch([taskStatus, showArchived], () => loadTasks().catch((error) => { message.value = error.message; }));
watch([() => selected.value?.id, () => selected.value?.proposal?.revision], initializeProposalEditor);
watch(() => selected.value?.id, loadSelectedTrace);
watch(() => selected.value?.id, () => nextTick(() => {
  if (transcript.value) transcript.value.scrollTop = 0;
}));
</script>

<template>
  <section class="agent-task-workspace">
    <aside class="task-history">
      <header><div><span>任务窗口</span><b>{{ tasks.length }}</b></div><button @click="newTask">＋ 新任务</button></header>
      <div class="task-filters"><input v-model="taskQuery" placeholder="搜索任务" @keyup.enter="loadTasks()"><select v-model="taskStatus"><option value="">全部状态</option><option value="waiting_confirmation">等待确认</option><option value="needs_input">等待补充</option><option value="denied">权限不足</option><option value="failed">回答失败</option><option value="executing">执行中</option><option value="retryable">可重试</option><option value="completed">已回应 / 已完成</option><option value="blocked">已阻止</option></select><label><input v-model="showArchived" type="checkbox">含归档</label><button @click="loadTasks()">查询</button></div>
      <button v-for="task in tasks" :key="task.id" :class="['task-history-item', { active: selected?.id === task.id }]" @click="selected = task"><span>{{ intentLabel[task.intent] }}</span><b>{{ task.title }}</b><small>{{ taskStatusLabel(task) }} · {{ formatTaskTime(task.createdAt) }}</small></button>
      <p v-if="!tasks.length">尚无运营任务。输入自然语言目标后，Agent会建立独立任务窗口。</p>
    </aside>

    <div class="task-conversation">
      <div ref="transcript" class="task-transcript">
        <template v-if="selected">
        <article v-for="(item, index) in selected.messages" :key="`${item.time}-${index}`" :class="['task-message', item.role === 'user' ? 'user' : 'agent']"><span>{{ item.role === 'user' ? '运营人员' : '语义运营 Agent' }} · 第 {{ Math.floor(index / 2) + 1 }} 轮</span><p>{{ item.content }}</p></article>
        <details v-if="selected.materialReview" class="task-message agent">
          <summary>附件读取范围 · {{ selected.materialReview.summary }}</summary>
          <div v-for="report in selected.materialReview.reports" :key="report.attachmentId">
            <b>{{ report.name }} · {{ !report.modelContentEligible ? '未读取 / 已隔离' : report.partial || report.truncated ? '部分读取' : '摘录可引用' }}</b>
            <p v-if="report.reason">{{ report.reason }}</p>
            <p v-if="report.truncated">内容超过处理上限；请拆分文件或缩小范围，未展示的部分不能推断。</p>
            <p v-if="report.missingPages?.length">未识别页面视觉内容：{{ report.missingPages.join('、') }}</p>
            <p v-for="warning in report.warnings || []" :key="warning">{{ warning }}</p>
          </div>
        </details>
        <article class="task-message agent"><span>当前任务状态 · {{ intentLabel[selected.intent] }}</span><div class="task-badges"><b>{{ taskStatusLabel(selected) }}</b><b>会话 {{ selected.threadId?.slice(-8) }} · 第{{ selected.turn }}轮</b><b>{{ selected.routing?.source === 'ark' ? '火山方舟理解' : selected.routing?.source === 'understanding_failed' ? '模型理解失败' : selected.routing?.source === 'local' ? '本地模型理解' : '受控规则' }}</b><b v-if="selected.requiredPermission">权限：{{ selected.requiredPermission }}</b><b v-if="selected.commandLabel">命令：{{ selected.commandLabel }}</b></div></article>
        <section v-if="selected.planning" class="task-planning">
          <header><div><span>PLANNING ENGINE</span><b>{{ selected.planning.mode === 'external_model_advisory' ? selected.planning.provider === 'ark' ? '火山方舟规划' : '云端模型规划' : selected.planning.mode === 'local_model_advisory' ? '本地模型规划' : '确定性安全规划' }}</b></div><small>{{ selected.planning.model }}</small></header>
          <p>{{ selected.planning.goal }}</p>
          <div class="planning-meta"><span>服务器意图：{{ intentLabel[selected.planning.authoritativeIntent] }}</span><span v-if="selected.planning.systems?.length">受控系统范围：{{ selected.planning.systems.join(' / ') }}</span><span v-if="selected.planning.intentConflict" class="conflict">模型建议与服务器意图不一致，已采用服务器判定</span><span v-if="selected.planning.systemConflict" class="conflict">模型建议了范围外系统，已按来源预检结果裁剪</span></div>
          <small>{{ selected.planning.rationale }}</small>
        </section>
        <section v-if="selected.plan?.length" class="agent-plan"><header><b>可审计执行计划</b><span>尚未执行的步骤不会被标记为完成</span></header><ol><li v-for="(step, index) in selected.plan" :key="step"><i>{{ index + 1 }}</i><span>{{ step }}</span></li></ol></section>

        <section v-if="selected.sourceDiscovery" class="source-discovery">
          <header><div><span>SOURCE DISCOVERY</span><b>来源与连接物料预检</b></div><small>不查询业务明细</small></header>
          <div class="source-cards"><article v-for="source in selected.sourceDiscovery.sources" :key="source.code" :class="source.status"><header><b>{{ source.code }}</b><span>{{ source.status }}</span></header><h4>{{ source.name }}</h4><p>{{ source.message }}</p><div v-if="source.objects?.length"><small>候选对象</small><b>{{ source.objects.join('、') }}</b></div><div v-if="source.mappings?.length"><small>已有映射</small><b>{{ source.mappings.length }} 项</b></div></article></div>
          <div v-if="selected.sourceDiscovery.blockers?.length" class="source-findings blocker"><b>阻断项</b><span v-for="item in selected.sourceDiscovery.blockers" :key="item">{{ item }}</span></div>
          <div v-if="selected.sourceDiscovery.warnings?.length" class="source-findings warning"><b>准备提醒</b><span v-for="item in selected.sourceDiscovery.warnings" :key="item">{{ item }}</span></div>
          <details v-if="selected.sourceDiscovery.sources?.length"><summary>查看真实接入所需物料</summary><ul><li v-for="item in selected.sourceDiscovery.sources[0].requiredAssets" :key="item">{{ item }}</li></ul></details>
        </section>

        <details v-if="selected.proposal" class="task-proposal" open>
          <summary>模型提案审阅 · {{ selected.proposal.objectTypes.length }} 个对象 · 第 {{ selected.proposal.revision }} 版</summary>
          <p v-if="selected.onboardingSource">来源：模拟接入项目 {{ selected.onboardingSource.projectId }}，材料修订 {{ selected.onboardingSource.materialRevision }}。{{ selected.onboardingSource.boundary }}</p>
          <header><div><span>SCHEMA CRITIC</span><b :class="selected.proposal.critic.status">{{ selected.proposal.critic.status === 'passed' ? '结构校验通过' : '存在阻断问题' }}</b></div><small>相对于当前草稿：新增对象 {{ selected.proposal.diff.summary.addedObjects }} · 更新对象 {{ selected.proposal.diff.summary.updatedObjects }} · 新增关系 {{ selected.proposal.diff.summary.addedRelationships }}</small></header>
          <div v-if="selected.proposal.schemaDiscovery?.files?.length" class="schema-discovery-summary"><div><b>结构化材料发现</b><span>{{ selected.proposal.schemaDiscovery.summary }}</span></div><span v-for="file in selected.proposal.schemaDiscovery.files" :key="file.attachmentId">{{ file.name }} · {{ file.format }} · {{ file.sourceSystem }} · {{ file.schemaCount }} 对象</span><small v-for="warning in selected.proposal.schemaDiscovery.warnings" :key="warning">{{ warning }}</small></div>
          <div class="task-critic-checks"><span v-for="check in selected.proposal.critic.checks" :key="check.name"><b>{{ check.status === 'passed' ? '通过' : '失败' }}</b>{{ check.name }}</span></div>
          <section v-if="selected.proposal.businessValidation" class="world-model-review">
            <h4>业务验收范围</h4>
            <p>结构：{{ selected.proposal.businessValidation.structureVerified ? '已核对' : '未通过' }} · 样本：{{ selected.proposal.businessValidation.samplesVerified ? '已验证当前样本' : '尚未完整验证' }} · 待评审需求：{{ selected.proposal.businessValidation.pendingRequirementCount }}</p>
            <p>{{ selected.proposal.businessValidation.detail }}</p>
          </section>
          <details v-if="selected.proposal.schemaDiscovery?.warnings?.length" class="world-model-review" open>
            <summary>材料待处理项 · {{ selected.proposal.schemaDiscovery.warnings.length }}</summary>
            <p v-for="warning in selected.proposal.schemaDiscovery.warnings" :key="warning">{{ warning }}</p>
            <article v-for="(conflict, index) in selected.proposal.schemaDiscovery.conflicts || []" :key="`${conflict.objectId}-${index}`">
              <b>{{ conflict.objectId }} · {{ conflict.reason }}</b>
              <p v-for="(version, versionIndex) in conflict.versions" :key="versionIndex">材料版本 {{ versionIndex + 1 }}：来源 {{ version.sourceSystem }} · 主键 {{ version.key }} · 粒度 {{ version.granularity }} · {{ version.fields.length }} 个字段</p>
            </article>
          </details>
          <details v-if="selected.proposal.worldModel?.rules?.length" class="world-model-review">
            <summary>业务规则与状态依据 · {{ selected.proposal.worldModel.rules.length }} 条待校对</summary>
            <p>以下是带原文证据的需求资产，不是已经生效的计算规则或权限。请在模型治理中配置指标、状态与已注册能力，并完成案例回放。</p>
            <article v-for="rule in selected.proposal.worldModel.rules" :key="rule.id">
              <b>{{ rule.objectTypes.join('、') || '跨对象约束' }} · {{ rule.categories.join(' / ') || '业务需求' }}</b>
              <p>{{ rule.evidence }}</p>
            </article>
          </details>
          <div class="task-model-diff"><article><b>对象建议</b><span v-for="item in selected.proposal.objectTypes" :key="item.id">{{ item.label }}<small>{{ item.id }} · {{ item.sourceSystems.join('/') }} · 主键 {{ item.key }}</small></span></article><article><b>关系建议</b><span v-for="item in selected.proposal.relationshipTypes" :key="`${item.from}-${item.predicate}-${item.to}`">{{ item.from }} — {{ item.predicate }} → {{ item.to }}<small>{{ item.cardinality }}</small></span></article></div>
          <div v-if="selected.proposal.editDiff" class="edit-diff-summary"><b>人工修订 Diff · 第 {{ selected.proposal.revision }} 版</b><span>新增对象 {{ selected.proposal.editDiff.summary.addedObjects }}</span><span>修改对象 {{ selected.proposal.editDiff.summary.updatedObjects }}</span><span>删除对象 {{ selected.proposal.editDiff.summary.removedObjects }}</span><span>新增关系 {{ selected.proposal.editDiff.summary.addedRelationships }}</span><span>删除关系 {{ selected.proposal.editDiff.summary.removedRelationships }}</span></div>

          <section v-if="proposalEditor" class="schema-editor">
            <header><div><span>VISUAL SCHEMA EDITOR</span><b>对象、字段、主键与关系复核</b></div><button :disabled="!canEditProposal || busy" @click="addObject">＋ 对象</button></header>
            <p>对象编码和来源系统用于治理追踪；修改字段名后请重新检查主键与关系。这里保存的是提案修订，不会直接发布模型。</p>
            <div class="proposal-graph">
              <header><div><b>候选语义关系图</b><span>点击节点联动下方字段与映射编辑器</span></div><div><b>{{ mappingSummary.ready }}/{{ mappingSummary.total }}</b><span>字段映射就绪</span></div></header>
              <svg :viewBox="`0 0 820 ${graphHeight}`" role="img" aria-label="Agent候选语义模型关系图">
                <defs><marker id="proposal-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z"/></marker></defs>
                <line v-for="edge in graphEdges" :key="edge.key" :x1="edge.fromNode.x" :y1="edge.fromNode.y" :x2="edge.toNode.x" :y2="edge.toNode.y" marker-end="url(#proposal-arrow)"/>
                <text v-for="edge in graphEdges" :key="`${edge.key}-label`" :x="(edge.fromNode.x + edge.toNode.x) / 2" :y="(edge.fromNode.y + edge.toNode.y) / 2 - 7" class="edge-label">{{ edge.predicate }} · {{ edge.cardinality }}</text>
                <g v-for="node in graphNodes" :key="node.id" :class="['proposal-graph-node', { selected: selectedGraphObjectId === node.id, warning: node.pendingMappings || node.validationStatus === 'unverified', validationFailed: node.validationStatus === 'failed' }]" role="button" tabindex="0" @click="selectedGraphObjectId = node.id" @keydown.enter="selectedGraphObjectId = node.id">
                  <rect :x="node.x - 100" :y="node.y - 34" width="200" height="68" rx="8"/>
                  <text :x="node.x" :y="node.y - 10" text-anchor="middle" class="node-label">{{ node.label }}</text>
                  <text :x="node.x" :y="node.y + 7" text-anchor="middle" class="node-meta">{{ node.id }} · {{ node.sourceSystems.join('/') }}</text>
                  <text :x="node.x" :y="node.y + 23" text-anchor="middle" class="node-mapping">{{ node.pendingMappings ? `${node.pendingMappings} 个映射待确认` : `${node.mappedFields} 个字段已映射` }}</text>
                </g>
              </svg>
            </div>
            <div class="schema-object-list">
              <article v-for="object in proposalEditor.objectTypes" v-show="selectedGraphObjectId === object.id" :key="object.id" class="schema-object-card">
                <header><div><code>{{ object.id }}</code><input v-model="object.label" :disabled="!canEditProposal || busy" aria-label="对象业务名称" @input="markEditorDirty"></div><button :disabled="!canEditProposal || busy" title="删除对象" @click="removeObject(object.id)">删除</button></header>
                <div class="object-meta-grid">
                  <label>数据来源<input v-model="object.source" :disabled="!canEditProposal || busy" @input="markEditorDirty"></label>
                  <label>数据分级<select v-model="object.classification" :disabled="!canEditProposal || busy" @change="markEditorDirty"><option>内部</option><option>内部受限</option><option>内部受限（待复核）</option><option>个人信息受限</option><option>质量受限</option><option>财务受限</option></select></label>
                  <label>核心元对象<select v-model="object.coreObject" :disabled="!canEditProposal || busy" @change="markEditorDirty"><option v-for="anchor in [...new Set([object.id, object.coreObject, 'Person', 'RawMaterial', 'Product', 'Equipment', 'Store'])]" :key="anchor" :value="anchor">{{ anchor === object.id ? `${anchor}（独立类型）` : anchor }}</option></select></label>
                  <label>来源系统<input :value="object.sourceSystems.join(' / ')" :disabled="!canEditProposal || busy" placeholder="例如 ERP / WMS；待核实请保留 UNASSIGNED" @input="object.sourceSystems = $event.target.value.split(/[ /,，]+/).filter(Boolean).map(value => value.toUpperCase()); markEditorDirty()"></label>
                </div>
                <div class="field-table">
                  <header><b>字段定义</b><span>主键</span><span>字段名</span><span>类型</span><span>源字段</span><span>映射方式</span><span>必填</span><i></i></header>
                  <div v-for="(field, fieldIndex) in object.fieldDefinitions" :key="`${object.id}-${fieldIndex}`">
                    <span :class="['mapping-dot', field.mappingStatus]"></span><input type="radio" :name="`pk-${object.id}`" :checked="object.key === field.name" :disabled="!canEditProposal || busy" title="设为主键" @change="setPrimaryKey(object, field.name)"><input v-model="field.name" :disabled="!canEditProposal || busy" aria-label="字段名" @input="syncFieldName(object, field)"><input v-model="field.type" :disabled="!canEditProposal || busy" aria-label="字段类型" @input="markEditorDirty"><input v-model="field.sourceField" :disabled="!canEditProposal || busy || ['derived', 'ignored'].includes(field.mappingStatus)" aria-label="源字段" @input="markEditorDirty"><select v-model="field.mappingStatus" :disabled="!canEditProposal || busy" aria-label="映射方式" @change="updateMapping(field)"><option value="mapped">自动匹配</option><option value="manual">人工映射</option><option value="derived">派生字段</option><option value="ignored">明确忽略</option><option value="pending">待确认</option></select><input v-model="field.required" type="checkbox" :disabled="!canEditProposal || busy || object.key === field.name" title="必填" @change="markEditorDirty"><button :disabled="!canEditProposal || busy" title="删除字段" @click="removeField(object, fieldIndex)">×</button>
                  </div>
                  <button :disabled="!canEditProposal || busy" @click="addField(object)">＋ 添加字段</button>
                </div>
                <label v-if="needsKeyCorrection(object.id)">原材料缺少主键：补充选择依据（12–1000 字符）
                  <textarea v-model="keyCorrectionReasons[object.id]" :disabled="!canEditProposal || busy" maxlength="1000" rows="3" placeholder="先选择原材料已有字段作为主键，再说明业务唯一性依据和核对范围。人工声明不等于样本或生产验收。" @input="markEditorDirty" />
                </label>
                <p v-if="needsKeyCorrection(object.id)">原始材料与缺项提示会保留。此处仅补充缺失主键，不允许覆盖材料中已经声明的主键；采纳时仍会重新检查样本和权限。</p>
              </article>
            </div>

            <div class="relationship-editor">
              <header><b>关系定义</b><button :disabled="!canEditProposal || busy" @click="addRelationship">＋ 关系</button></header>
              <div v-for="(relation, relationIndex) in proposalEditor.relationshipTypes" :key="relationIndex">
                <select v-model="relation.from" :disabled="!canEditProposal || busy" @change="markEditorDirty"><option v-for="object in proposalEditor.objectTypes" :key="object.id" :value="object.id">{{ object.id }}</option></select>
                <input v-model="relation.predicate" :disabled="!canEditProposal || busy" aria-label="关系谓词" @input="markEditorDirty">
                <select v-model="relation.to" :disabled="!canEditProposal || busy" @change="markEditorDirty"><option v-for="object in proposalEditor.objectTypes" :key="object.id" :value="object.id">{{ object.id }}</option></select>
                <select v-model="relation.cardinality" :disabled="!canEditProposal || busy" @change="markEditorDirty"><option>1:1</option><option>1:n</option><option>n:1</option><option>n:n</option></select>
                <button :disabled="!canEditProposal || busy" @click="removeRelationship(relationIndex)">×</button>
              </div>
            </div>
            <section v-if="selected.proposal.impactAnalysis" :class="['impact-analysis', selected.proposal.impactAnalysis.riskLevel]"><header><div><span>CHANGE IMPACT</span><b>修订影响分析</b></div><strong>{{ selected.proposal.impactAnalysis.riskLevel === 'high' ? '高影响' : selected.proposal.impactAnalysis.riskLevel === 'medium' ? '中影响' : selected.proposal.impactAnalysis.riskLevel === 'low' ? '低影响' : '无结构变化' }}</strong></header><div><span>变化对象 {{ selected.proposal.impactAnalysis.changedObjectCount }}</span><span>影响关系 {{ selected.proposal.impactAnalysis.affectedRelationships.length }}</span><span>主键变化 {{ selected.proposal.impactAnalysis.keyChanges.length }}</span><span>待确认映射 {{ selected.proposal.impactAnalysis.pendingMappings.length }}</span></div><ul><li v-for="item in selected.proposal.impactAnalysis.requiredActions" :key="item">{{ item }}</li></ul><small>{{ selected.proposal.impactAnalysis.policy }}</small></section>
            <section v-if="selected.proposal.mappingValidation" :class="['mapping-validation', selected.proposal.mappingValidation.status]">
              <header><div><span>DATA MAPPING REHEARSAL</span><b>Mock 样本映射演练</b><small>{{ selected.proposal.mappingValidation.contract.contractId }} · 服务端第 {{ selected.proposal.revision }} 版</small></div><strong>{{ selected.proposal.mappingValidation.status === 'passed' ? '演练通过' : selected.proposal.mappingValidation.status === 'failed' ? '存在阻断' : '部分验证' }}</strong></header>
              <div class="mapping-validation-metrics"><span><b>{{ selected.proposal.mappingValidation.summary.verifiedObjectCount }}/{{ selected.proposal.mappingValidation.summary.objectCount }}</b>对象通过</span><span><b>{{ selected.proposal.mappingValidation.summary.successfulSampleCount }}/{{ selected.proposal.mappingValidation.summary.sampleCount }}</b>样本转换</span><span><b>{{ selected.proposal.mappingValidation.summary.observedCoveragePercent }}%</b>字段命中</span><span><b>{{ selected.proposal.mappingValidation.summary.errorCount }}</b>阻断问题</span></div>
              <div class="mapping-validation-objects"><button v-for="object in selected.proposal.mappingValidation.objects" :key="object.objectId" :class="[object.status, { active: selectedMappingValidationObject?.objectId === object.objectId }]" @click="selectedGraphObjectId = object.objectId"><b>{{ object.objectId }}</b><span>{{ object.sourceSystem || '未分配' }} · {{ object.successfulSampleCount }}/{{ object.sampleCount }} 样本</span></button></div>
              <div v-if="selectedMappingValidationObject" class="mapping-validation-detail">
                <header><div><b>{{ selectedMappingValidationObject.objectId }}</b><span>{{ selectedMappingValidationObject.sourceSystem }}.{{ selectedMappingValidationObject.sourceObjectType }}</span></div><small>观察到 {{ selectedMappingValidationObject.observedFieldCount }}/{{ selectedMappingValidationObject.fieldCount }} 个目标字段</small></header>
                <div v-if="selectedMappingIssues.length" class="mapping-validation-issues"><p v-for="issue in selectedMappingIssues" :key="`${issue.code}-${issue.field}`" :class="issue.severity"><b>{{ issue.field || issue.objectId }}</b><span>{{ issue.message }}{{ issue.occurrences > 1 ? `（${issue.occurrences}个样本）` : '' }}</span><small>{{ issue.suggestion }}</small></p></div>
                <div v-if="selectedMappingValidationObject.transformedSamples.length" class="canonical-preview"><article v-for="sample in selectedMappingValidationObject.transformedSamples" :key="sample.sourceRecordId"><header><b>{{ sample.canonicalFact.id || '主键未生成' }}</b><span>{{ sample.sourceRecordId }} · 仅 Mock</span></header><div v-for="(value, field) in sample.canonicalFact.fields" :key="field"><span>{{ field }}</span><code>{{ displayPreviewValue(value) }}</code></div></article></div>
                <p v-else class="mapping-no-sample">当前对象没有可用 Mock 样本，只验证了契约结构，尚不能证明数据可转换。</p>
              </div>
              <small class="mapping-policy">{{ selected.proposal.mappingValidation.policy }}</small>
            </section>
            <footer><span :class="{ dirty: editorDirty }">{{ editorMessage || '当前界面与服务端提案版本一致。' }}</span><button :disabled="!editorDirty || busy" @click="saveProposalRevision">{{ busy ? '正在复核…' : '保存修订并重跑结构与映射演练' }}</button></footer>
          </section>
        </details>

        <section v-if="selected.result && selected.intent === 'inspect_status'" class="task-status-result"><article><b>{{ selected.result.objectCount }}</b><span>对象</span></article><article><b>{{ selected.result.relationshipCount }}</b><span>关系</span></article><article><b>{{ selected.result.validationStatus }}</b><span>校验</span></article><article><b>{{ selected.result.simulationStatus }}</b><span>模拟</span></article></section>

        <section v-if="selected.events?.length" class="task-events"><span>任务证据时间线（北京时间）</span><div v-for="event in selected.events" :key="`${event.time}-${event.type}`"><time>{{ formatTaskTime(event.time) }}</time><b>{{ event.type }}</b><small>{{ event.detail }}</small></div></section>
        <details v-if="selectedTrace" class="task-events"><summary>可验证 Evidence Trace · {{ selectedTrace.eventCount }} 个哈希链事件</summary><div v-for="event in selectedTrace.events" :key="event.hash"><time>{{ formatTaskTime(event.createdAt) }}</time><b>{{ event.stage }} · {{ event.status }}</b><small>{{ event.summary }} · {{ event.hash.slice(0, 12) }}</small></div><code>Head {{ selectedTrace.headHash }}<br>Manifest {{ selectedTrace.manifestHash }}</code></details>
        <button v-if="desktopBridge?.exportReport" class="task-archive" :disabled="busy" @click="exportReport">导出当前任务与证据链报告</button><button v-if="exportedReport" class="task-archive" @click="desktopBridge.showReport(exportedReport.path)">在文件夹中显示 {{ exportedReport.fileName }}</button>
        <button v-if="selected.status !== 'executing' && !selected.archivedAt" class="task-archive" @click="archiveTask">归档此任务</button>
        <button v-if="canExecute" class="task-confirm" @click="executeTask">明确确认：{{ selected.commandLabel }}</button>
        <p v-else-if="selected.status === 'waiting_confirmation' && editorDirty" class="task-blocked">请先保存当前可视化修改，重新运行 Schema Critic 后才能确认。</p>
        <p v-else-if="selected.status === 'waiting_confirmation' && selected.proposal?.critic?.status === 'failed'" class="task-blocked">Schema Critic 未通过，请在上方编辑器修复对象、主键、字段或关系。</p>
        <p v-else-if="selected.status === 'waiting_confirmation' && selected.proposal?.mappingValidation?.blocked" class="task-blocked">Mock 样本映射演练未通过，请根据上方字段缺失、类型或主键问题修正映射后再确认。</p>
        <p v-else-if="selected.status === 'blocked'" class="task-blocked">任务已被治理关口阻止。根据上方原因修复模型后，请建立新任务重新执行。</p>
        </template>
        <section v-else class="task-empty"><span>SEMANTIC OPERATIONS AGENT</span><h3>创建一个新的运营任务</h3><p>可以要求Agent建设模型、查看状态、校验草稿、模拟构建或提交发布。写操作始终先形成计划并等待确认。</p></section>
      </div>

      <div class="task-input-dock">
        <label class="adoption-mode">建模采纳方式 <select v-model="adoptionMode" :disabled="busy" aria-label="建模采纳方式"><option value="merge">合并到当前草稿（保留既有对象）</option><option value="replace">替换当前草稿（确认后保留回滚快照）</option></select><small>当前工作区只有一个活动模型；此选项不创建并行模型。</small></label>
        <p v-if="message" class="task-message-bar">{{ message }}</p>
        <div class="task-composer"><div v-if="files.length" class="task-files"><span v-for="(file, index) in files" :key="`${file.name}-${index}`">{{ file.name }}<button @click="files.splice(index, 1)">×</button></span></div><textarea v-model="input" :disabled="busy" aria-label="向语义运营 Agent 提交任务" :placeholder="selected ? '继续当前语义任务，例如：再补充WMS库位对象，并检查映射。' : '例如：检查当前语义模型状态；或者上传WMS数据字典建设采购到入库模型。'" @keydown.ctrl.enter="createTask"/><footer><div><button class="attach" :disabled="busy" @click="fileInput?.click()">＋ 添加材料</button><small>最多5份、合计12MB；支持 PDF / 图片 / DOCX / XLSX / JSON / YAML / CSV</small></div><div class="composer-actions"><small>{{ selected ? '将承接当前任务上下文' : 'Ctrl + Enter 发送' }}</small><button class="send" :disabled="!canSubmit" @click="createTask">{{ busy ? 'Agent处理中…' : selected ? '继续任务' : '交给Agent' }}</button></div></footer><input ref="fileInput" type="file" hidden multiple accept="image/jpeg,image/png,image/webp,application/pdf,application/json,.json,.yaml,.yml,text/csv,.csv,.docx,.xlsx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" @change="chooseFiles"/></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.adoption-mode{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:#aacbd5;font-size:12px;margin-bottom:8px}.adoption-mode select{max-width:100%;padding:7px;background:#0a2634;color:#d3edf1;border:1px solid #315b6b;border-radius:6px}.adoption-mode small{color:#91adb7}.adoption-mode :focus-visible{outline:2px solid #65d3ba;outline-offset:2px}
.world-model-review{margin:12px 0;padding:14px;border:1px solid #345565;border-radius:8px;color:#b9d2de;overflow-wrap:anywhere;font-size:12px;line-height:1.6}.world-model-review h4{margin:0;color:#69d9c2}.world-model-review summary{cursor:pointer;color:#69d9c2}.world-model-review article{padding:10px 0;border-top:1px solid #294553}.world-model-review p{margin:6px 0}.world-model-review b{font-size:11px}
.agent-task-workspace{display:grid;grid-template-columns:218px minmax(0,1fr);height:clamp(600px,calc(100vh - 280px),820px);min-height:0;border:1px solid #285064;border-radius:10px;overflow:hidden;background:#081925;box-shadow:0 18px 48px #020a0f59}.task-history{min-height:0;padding:0 12px 12px;overflow-y:auto;overscroll-behavior:contain;border-right:1px solid #274353;background:#071520;scrollbar-gutter:stable}.task-history>header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding:12px 0 10px;background:linear-gradient(180deg,#071520 78%,#07152000)}.task-history header div{display:flex;gap:5px;align-items:center;color:#7193a5;font-size:9px}.task-history header div b{color:#71d3c6}.task-history header button{border:1px solid #31586b;border-radius:5px;padding:5px 7px;color:#8fd7d5;background:#0c2634;font-size:9px}.task-history-item{display:grid;gap:4px;width:100%;margin-bottom:6px;padding:10px;border:1px solid transparent;border-radius:7px;color:#7896a6;background:transparent;text-align:left;transition:border-color .15s ease,background .15s ease,transform .15s ease}.task-history-item:hover{border-color:#2c5e72;background:#0b2432;transform:translateX(2px)}.task-history-item.active{border-color:#3c788c;background:#0e3040;box-shadow:inset 3px 0 #56cdb9}.task-history-item:focus-visible,.task-history header button:focus-visible,.task-composer button:focus-visible,.task-confirm:focus-visible{outline:2px solid #68d7c4;outline-offset:2px}.task-history-item span{color:#54b8bf;font-size:8px;letter-spacing:.08em}.task-history-item b{overflow:hidden;color:#c2dbe3;font-size:10px;white-space:nowrap;text-overflow:ellipsis}.task-history-item small,.task-history>p{color:#627f90;font-size:8px;line-height:1.5}.task-conversation{display:grid;grid-template-rows:minmax(0,1fr) auto;min-width:0;min-height:0;overflow:hidden;background:radial-gradient(circle at 88% 8%,#12334466,transparent 34%)}.task-transcript{min-width:0;min-height:0;padding:18px;overflow-y:auto;overscroll-behavior:contain;scroll-behavior:smooth;scrollbar-gutter:stable}.task-history,.task-transcript{scrollbar-color:#31586b #081925;scrollbar-width:thin}.task-history::-webkit-scrollbar,.task-transcript::-webkit-scrollbar{width:8px}.task-history::-webkit-scrollbar-thumb,.task-transcript::-webkit-scrollbar-thumb{border:2px solid #081925;border-radius:8px;background:#31586b}.task-message{display:grid;gap:6px;margin-bottom:10px;padding:12px 14px;border:1px solid #29495a;border-radius:8px;background:#0b2030}.task-message.user{margin-left:12%;border-color:#335367;background:#102738}.task-message span{color:#5eb9c2;font-size:8px;letter-spacing:.08em}.task-message p{margin:0;color:#c6dce4;font-size:11px;line-height:1.65}.task-badges{display:flex;flex-wrap:wrap;gap:5px}.task-badges b{padding:3px 5px;border-radius:3px;color:#7fb6c5;background:#102f40;font-size:8px}.agent-plan,.task-proposal,.task-events{margin:10px 0;padding:12px;border:1px solid #29495a;border-radius:8px;background:#091c29}.agent-plan header,.task-proposal>header{display:flex;justify-content:space-between;gap:12px}.agent-plan header b,.task-proposal header span{color:#bcd9e1;font-size:10px}.agent-plan header span,.task-proposal header small{color:#6d8e9f;font-size:8px}.agent-plan ol{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:10px 0 0;padding:0;list-style:none}.agent-plan li{display:flex;align-items:center;gap:7px;color:#8da9b6;font-size:9px}.agent-plan li i{width:19px;height:19px;display:grid;place-items:center;border:1px solid #386477;border-radius:50%;color:#69c7c6;font-style:normal;font-size:8px}.task-proposal>header>div{display:grid;gap:3px}.task-proposal header b{font-size:10px}.task-proposal header b.passed{color:#55d5ae}.task-proposal header b.failed{color:#ed8993}.task-critic-checks{display:flex;flex-wrap:wrap;gap:5px;margin:10px 0}.task-critic-checks span{padding:5px;border:1px solid #28495a;border-radius:4px;color:#7d9cab;font-size:8px}.task-critic-checks b{margin-right:4px;color:#5ed1b4}.task-model-diff{display:grid;grid-template-columns:1fr 1fr;gap:8px}.task-model-diff article{display:grid;align-content:start;gap:5px;padding:9px;border:1px solid #233f4f;border-radius:6px;background:#071722}.task-model-diff article>b{color:#8ac4d0;font-size:9px}.task-model-diff article>span{display:grid;gap:2px;padding:5px;border-radius:3px;color:#acc8d2;background:#0d2735;font-size:8px}.task-model-diff small{color:#5f8597;font-size:7px}.task-status-result{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:10px 0}.task-status-result article{display:grid;gap:4px;padding:12px;border:1px solid #294a5b;border-radius:7px;background:#0a202d}.task-status-result b{color:#61d4c0;font-size:14px}.task-status-result span{color:#66899a;font-size:8px}.task-events>span{color:#7195a5;font-size:8px;letter-spacing:.08em}.task-events>div{display:grid;grid-template-columns:55px 120px 1fr;gap:8px;margin-top:7px;padding-top:7px;border-top:1px solid #1e3948}.task-events time,.task-events b,.task-events small{font-size:8px}.task-events time{color:#527b8e}.task-events b{color:#75bac5}.task-events small{color:#75909e}.task-confirm{width:100%;margin-top:10px;padding:10px;border:1px solid #49c3a5;border-radius:7px;color:#06231c;background:#58d6b5;font-size:10px;font-weight:800}.task-blocked,.task-message-bar{padding:8px;border:1px solid #74434b;border-radius:5px;color:#e29aa4;background:#2b1720;font-size:9px}.task-empty{display:grid;place-items:center;align-content:center;min-height:100%;text-align:center}.task-empty span{color:#55b9c1;font-size:8px;letter-spacing:.15em}.task-empty h3{margin:8px 0;color:#dcecf0}.task-empty p{max-width:430px;margin:0;color:#7797a6;font-size:10px;line-height:1.6}.task-input-dock{position:relative;z-index:5;padding:8px 18px 16px;border-top:1px solid #244859;background:linear-gradient(180deg,#071722e8,#071722 24%);box-shadow:0 -18px 36px #04101a99}.task-composer{position:static;padding:10px;border:1px solid #3a6578;border-radius:9px;background:#0b2230;box-shadow:0 8px 24px #020b1270;transition:border-color .15s ease,box-shadow .15s ease}.task-composer:focus-within{border-color:#54bfae;box-shadow:0 0 0 2px #54bfae1f,0 8px 24px #020b1270}.task-composer textarea{display:block;width:100%;min-height:58px;max-height:140px;resize:none;border:0;outline:0;color:#d7e8ee;background:transparent;font:inherit;font-size:10px;line-height:1.55}.task-composer textarea::placeholder{color:#638394}.task-composer footer{display:flex;justify-content:space-between;align-items:center;gap:12px}.task-composer footer>div{display:flex;align-items:center;gap:8px;min-width:0}.task-composer button{border-radius:5px;padding:6px 9px;font-size:8px;transition:filter .15s ease,transform .15s ease}.task-composer button:not(:disabled):hover{filter:brightness(1.12);transform:translateY(-1px)}.task-composer button:disabled{cursor:not-allowed;opacity:.45}.attach{flex:none;border:1px solid #31586b;color:#7eb9c7;background:#0c2938}.send{flex:none;border:1px solid #52c9aa;color:#08261e;background:#59d7b5;font-weight:800}.task-composer small{overflow:hidden;color:#5f8294;font-size:7px;text-overflow:ellipsis;white-space:nowrap}.composer-actions{flex:none}.task-files{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px}.task-files span{padding:4px;border-radius:3px;color:#8eb0bd;background:#123344;font-size:8px}.task-files button{padding:0 2px;border:0;color:#80aabb;background:transparent}.task-message-bar{position:static;margin:0 0 7px;border-color:#2d675d;color:#80d7c0;background:#0c2926}@media(max-width:1300px){.agent-task-workspace{grid-template-columns:185px minmax(0,1fr);height:clamp(580px,calc(100vh - 265px),780px)}.agent-plan ol{grid-template-columns:1fr}.task-composer footer>div:first-child small{display:none}}
.task-planning,.source-discovery{margin:10px 0;padding:12px;border:1px solid #29495a;border-radius:8px;background:#091c29}.task-planning header,.source-discovery>header{display:flex;justify-content:space-between;gap:12px}.task-planning header>div,.source-discovery>header>div{display:grid;gap:3px}.task-planning header span,.source-discovery header span{color:#55b9c1;font-size:8px;letter-spacing:.1em}.task-planning header b,.source-discovery header b{color:#c7e0e6;font-size:10px}.task-planning header small,.source-discovery header small{color:#608698;font-size:8px}.task-planning p{margin:10px 0 7px;color:#b9d2da;font-size:10px}.task-planning>small{color:#718f9e;font-size:8px}.planning-meta{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:7px}.planning-meta span{padding:4px 6px;border-radius:4px;color:#83bac7;background:#102f40;font-size:8px}.planning-meta .conflict{color:#f0b382;background:#37261e}.source-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-top:10px}.source-cards article{display:grid;gap:5px;padding:9px;border:1px solid #2b4d5d;border-radius:6px;background:#071722}.source-cards article.not_registered,.source-cards article.forbidden,.source-cards article.rejected_endpoint,.source-cards article.missing_credential{border-color:#74434b}.source-cards article>header{display:flex;justify-content:space-between}.source-cards article>header b{color:#66d2c0;font-size:11px}.source-cards article>header span{color:#678c9d;font-size:7px}.source-cards h4{margin:0;color:#b6d1d9;font-size:9px}.source-cards p{margin:0;color:#6f8d9c;font-size:8px;line-height:1.45}.source-cards article>div{display:flex;justify-content:space-between;gap:5px}.source-cards article>div small,.source-cards article>div b{font-size:7px}.source-cards article>div small{color:#557d90}.source-cards article>div b{overflow:hidden;color:#84acb8;text-align:right;text-overflow:ellipsis}.source-findings{display:grid;gap:4px;margin-top:8px;padding:8px;border-radius:5px;font-size:8px}.source-findings.blocker{color:#eca0a8;background:#2d1720}.source-findings.warning{color:#e7c189;background:#30251a}.source-discovery details{margin-top:8px;color:#7699a8;font-size:8px}.source-discovery details ul{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:7px 0 0;padding-left:18px}@media(max-width:1300px){.source-cards{grid-template-columns:1fr 1fr}}
.schema-discovery-summary{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0;padding:9px;border:1px solid #386071;border-radius:6px;background:#0d2735}.schema-discovery-summary>div{display:grid;flex-basis:100%;gap:3px}.schema-discovery-summary>div b{color:#77d6c4;font-size:9px}.schema-discovery-summary>div span{color:#789aaa;font-size:8px}.schema-discovery-summary>span{padding:4px 6px;border-radius:4px;color:#9bc3cc;background:#123444;font-size:7px}.schema-discovery-summary>small{flex-basis:100%;color:#e5b27d;font-size:8px}
.edit-diff-summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:9px;padding:7px;border:1px solid #2b5263;border-radius:5px;background:#0b2230}.edit-diff-summary b{margin-right:auto;color:#77cfc1;font-size:8px}.edit-diff-summary span{padding:3px 5px;border-radius:3px;color:#86aebb;background:#123141;font-size:7px}.schema-editor{margin-top:10px;padding:11px;border:1px solid #397084;border-radius:7px;background:#071925}.schema-editor>header,.relationship-editor>header,.schema-object-card>header,.schema-editor>footer{display:flex;align-items:center;justify-content:space-between;gap:8px}.schema-editor>header>div{display:grid;gap:2px}.schema-editor>header span{color:#5ebdc3;font-size:7px;letter-spacing:.1em}.schema-editor>header b{color:#c5dee5;font-size:10px}.schema-editor button{border:1px solid #315d70;border-radius:4px;padding:5px 7px;color:#8dc7d0;background:#0d2b3a;font-size:8px}.schema-editor button:disabled{cursor:not-allowed;opacity:.45}.schema-editor>p{margin:8px 0;color:#6f92a2;font-size:8px;line-height:1.5}.proposal-graph{margin-bottom:9px;border:1px solid #2b5364;border-radius:7px;overflow:hidden;background:#061722}.proposal-graph>header{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #234756;background:#0b2634}.proposal-graph>header>div{display:grid;gap:2px}.proposal-graph>header>div:last-child{text-align:right}.proposal-graph>header b{color:#9bd4d8;font-size:9px}.proposal-graph>header span{color:#618796;font-size:7px}.proposal-graph svg{display:block;width:100%;min-height:200px}.proposal-graph line{stroke:#2f7180;stroke-width:1.5;marker-end:context-stroke}.proposal-graph .edge-label{fill:#638c99;font-size:7px}.proposal-graph-node{cursor:pointer;outline:none}.proposal-graph-node rect{fill:#0d2b39;stroke:#356678;stroke-width:1.2}.proposal-graph-node.selected rect{fill:#123d4b;stroke:#59d4bd;stroke-width:2}.proposal-graph-node.warning rect{stroke:#d29b58}.proposal-graph-node .node-label{fill:#cae3e7;font-size:10px;font-weight:700}.proposal-graph-node .node-meta{fill:#7197a4;font-size:7px}.proposal-graph-node .node-mapping{fill:#59cbb4;font-size:7px}.proposal-graph-node.warning .node-mapping{fill:#e1aa69}.schema-object-list{display:grid;gap:8px}.schema-object-card{padding:9px;border:1px solid #294b5b;border-radius:6px;background:#0a202d}.schema-object-card>header>div{display:flex;align-items:center;gap:7px}.schema-object-card code{color:#63d4bc;font-size:9px}.schema-object-card>header input{width:180px;border:0;border-bottom:1px solid #31596a;padding:3px;color:#c2dae1;background:transparent;font-size:9px}.schema-object-card>header button{border-color:#68434b;color:#d9929b;background:#2a1820}.object-meta-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0}.object-meta-grid label{display:grid;gap:3px;color:#648898;font-size:7px}.object-meta-grid input,.object-meta-grid select,.field-table input,.field-table select,.relationship-editor input,.relationship-editor select{min-width:0;border:1px solid #2b5061;border-radius:3px;padding:5px;color:#aecdd6;background:#0b2735;font-size:8px}.object-meta-grid input:disabled{color:#668795;background:#081b27}.field-table{display:grid;gap:3px;overflow-x:auto}.field-table>header,.field-table>div{display:grid;grid-template-columns:26px 38px minmax(88px,1.2fr) minmax(65px,.8fr) minmax(88px,1.2fr) 82px 38px 24px;align-items:center;gap:5px;min-width:700px}.field-table>header{padding:4px 0;color:#668b9b;font-size:7px}.field-table>header b{color:#8fc3ce}.field-table>div{padding:3px 0;border-top:1px solid #183746}.mapping-dot{justify-self:center;width:7px;height:7px;border-radius:50%;background:#4f7180}.mapping-dot.mapped,.mapping-dot.manual,.mapping-dot.derived{background:#51cbb0;box-shadow:0 0 0 3px #1c5147}.mapping-dot.pending{background:#df9c55;box-shadow:0 0 0 3px #55391f}.mapping-dot.ignored{background:#70818a}.field-table input[type=radio],.field-table input[type=checkbox]{justify-self:center;width:13px;height:13px;accent-color:#54cbb0}.field-table>div button{padding:2px 5px}.field-table>button{justify-self:start;margin-top:4px}.relationship-editor{margin-top:10px;padding-top:9px;border-top:1px solid #244656}.relationship-editor>header b{color:#91c5cf;font-size:9px}.relationship-editor>div{display:grid;grid-template-columns:1fr 1fr 1fr 70px 26px;gap:5px;margin-top:5px}.relationship-editor>div button{padding:2px}.impact-analysis{margin-top:10px;padding:9px;border:1px solid #2b5364;border-radius:6px;background:#0a202d}.impact-analysis>header{display:flex;align-items:center;justify-content:space-between}.impact-analysis>header>div{display:grid;gap:2px}.impact-analysis>header span{color:#5cbec3;font-size:7px;letter-spacing:.08em}.impact-analysis>header b{color:#bad7dd;font-size:9px}.impact-analysis>header strong{padding:4px 6px;border-radius:4px;color:#78d6bd;background:#123a35;font-size:8px}.impact-analysis.medium>header strong{color:#e4b775;background:#3d2c1c}.impact-analysis.high>header strong{color:#eb909a;background:#431d24}.impact-analysis>div{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}.impact-analysis>div span{padding:4px 6px;border-radius:3px;color:#83aebb;background:#123141;font-size:7px}.impact-analysis ul{margin:0 0 6px;padding-left:18px;color:#87a5b0;font-size:8px;line-height:1.6}.impact-analysis>small{color:#5e8291;font-size:7px}.schema-editor>footer{margin-top:10px;padding-top:8px;border-top:1px solid #244656}.schema-editor>footer span{color:#6d91a0;font-size:8px}.schema-editor>footer span.dirty{color:#edbc7e}.schema-editor>footer>button{border-color:#45a98f;color:#08251e;background:#55cdae;font-weight:700}@media(max-width:1300px){.object-meta-grid{grid-template-columns:1fr 1fr}.relationship-editor>div{grid-template-columns:1fr 1fr 1fr 58px 24px}}
.proposal-graph-node.validationFailed rect{stroke:#e36f7c;stroke-width:2}.mapping-validation{margin-top:10px;padding:10px;border:1px solid #315c6e;border-radius:7px;background:#081d29}.mapping-validation.failed{border-color:#7b4650}.mapping-validation>header,.mapping-validation-detail>header{display:flex;align-items:center;justify-content:space-between;gap:10px}.mapping-validation>header>div{display:grid;gap:2px}.mapping-validation>header span{color:#5fc2c8;font-size:7px;letter-spacing:.09em}.mapping-validation>header b{color:#c5dfe5;font-size:9px}.mapping-validation>header small{color:#5f8291;font-size:7px}.mapping-validation>header strong{padding:4px 6px;border-radius:4px;color:#76d7bd;background:#123a35;font-size:8px}.mapping-validation.failed>header strong{color:#ee929b;background:#421e25}.mapping-validation.partially_verified>header strong{color:#e6bb79;background:#3c2c1d}.mapping-validation-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:9px 0}.mapping-validation-metrics span{display:grid;gap:2px;padding:7px;border:1px solid #244654;border-radius:5px;color:#688c9b;background:#0b2633;font-size:7px}.mapping-validation-metrics b{color:#73d5c3;font-size:12px}.mapping-validation-objects{display:flex;flex-wrap:wrap;gap:5px}.mapping-validation-objects button{display:grid;gap:2px;padding:6px 8px;text-align:left}.mapping-validation-objects button.active{border-color:#5ecdb7;background:#123b40}.mapping-validation-objects button.failed{border-color:#74434c}.mapping-validation-objects b{color:#a8cad2;font-size:8px}.mapping-validation-objects span{color:#608695;font-size:7px}.mapping-validation-detail{margin-top:8px;padding:8px;border:1px solid #244754;border-radius:5px;background:#061721}.mapping-validation-detail>header b{color:#9fd2d8;font-size:9px}.mapping-validation-detail>header span,.mapping-validation-detail>header small{color:#618595;font-size:7px}.mapping-validation-issues{display:grid;gap:5px;margin-top:7px}.mapping-validation-issues p{display:grid;grid-template-columns:105px 1fr;gap:3px 7px;margin:0;padding:6px;border-radius:4px;background:#2f2419}.mapping-validation-issues p.error{background:#301920}.mapping-validation-issues b{color:#e5b479;font-size:8px}.mapping-validation-issues p.error b{color:#eb929b}.mapping-validation-issues span{color:#b8c9cd;font-size:8px}.mapping-validation-issues small{grid-column:2;color:#718e99;font-size:7px}.canonical-preview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:8px}.canonical-preview article{padding:7px;border:1px solid #244653;border-radius:5px;background:#0a2430}.canonical-preview article>header{display:grid;gap:2px;margin-bottom:5px}.canonical-preview article>header b{overflow:hidden;color:#75d5c0;font-size:8px;text-overflow:ellipsis}.canonical-preview article>header span{color:#557c8c;font-size:7px}.canonical-preview article>div{display:grid;grid-template-columns:42% 58%;gap:4px;padding:3px 0;border-top:1px solid #183642}.canonical-preview article>div span{overflow:hidden;color:#6d92a0;font-size:7px;text-overflow:ellipsis}.canonical-preview code{overflow:hidden;color:#b9d0d6;font-size:7px;text-overflow:ellipsis;white-space:nowrap}.mapping-no-sample{margin:8px 0 0;color:#d7ac75;font-size:8px}.mapping-policy{display:block;margin-top:8px;color:#597e8d;font-size:7px;line-height:1.5}@media(max-width:1300px){.canonical-preview{grid-template-columns:1fr 1fr}}
.agent-task-workspace{height:clamp(420px,calc(100dvh - 300px),1100px)}
@media(min-width:2200px) and (min-height:1700px){.agent-task-workspace{height:clamp(1100px,calc(100dvh - 300px),1700px)}}
@media(max-width:1300px){.agent-task-workspace{height:clamp(360px,calc(100dvh - 300px),820px)}}
@media(max-width:1100px){.agent-task-workspace{height:clamp(320px,calc(100dvh - 370px),700px);grid-template-columns:190px minmax(0,1fr)}}
@media(max-width:760px){.agent-task-workspace{grid-template-columns:1fr;height:auto;min-height:560px}.task-history{max-height:190px;border-right:0;border-bottom:1px solid #274353}.task-conversation{min-height:430px}.task-status-result{grid-template-columns:1fr 1fr}.task-model-diff{grid-template-columns:1fr}.source-cards{grid-template-columns:1fr}.canonical-preview{grid-template-columns:1fr}}
@media(max-height:800px) and (min-width:1181px){.agent-task-workspace{height:clamp(380px,calc(100dvh - 220px),620px)}.task-transcript{padding:12px}.task-input-dock{padding:7px 12px 10px}.task-composer textarea{min-height:44px}}
@media(max-height:800px) and (max-width:1180px){.agent-task-workspace{height:clamp(300px,calc(100dvh - 390px),460px)}.task-transcript{padding:12px}.task-input-dock{padding:7px 12px 10px}.task-composer textarea{min-height:44px}}
.task-filters{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:9px}.task-filters input,.task-filters select,.task-filters button{min-width:0;border:1px solid #294d60;border-radius:4px;padding:6px;color:#a9c7d0;background:#0a2230;font-size:8px}.task-filters label{display:flex;align-items:center;gap:4px;color:#7898a7;font-size:8px}.task-filters label input{width:auto}.task-archive{margin-top:8px;border:1px solid #31586b;border-radius:5px;padding:6px 9px;color:#7e9eac;background:#0a2230;font-size:8px}
.task-proposal>summary{cursor:pointer;margin:-3px 0 10px;padding:7px;border-bottom:1px solid #244656;color:#76cfc4;font-size:9px;list-style-position:inside}
</style>

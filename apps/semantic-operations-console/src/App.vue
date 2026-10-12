<script setup>
import { computed, defineAsyncComponent, nextTick, onMounted, ref } from 'vue';
import { createSemanticOperationsClient } from '@healthcare-ai/semantic-operations-sdk';
import SemanticAgentWorkspace from './components/SemanticAgentWorkspace.vue';
import SemanticOperationsCenter from './components/SemanticOperationsCenter.vue';
import SemanticOnboardingWorkspace from './components/SemanticOnboardingWorkspace.vue';
import SystemAccessWorkspace from './components/SystemAccessWorkspace.vue';
import WorkflowSemanticCenter from './components/WorkflowSemanticCenter.vue';
import { OAMetaModelStudio, OntologyWorkspaceTools, OntologySavedViewsPanel, OntologyGraph, semanticSimulationMessage } from '@healthcare-ai/agent-ui/meta-model';
import { KnowledgeLibraryPanel } from '@healthcare-ai/agent-ui/knowledge';
import { restoreSemanticSession, semanticConnectionMessage } from './session-bootstrap.js';

const SemanticModelTaskBrowser = defineAsyncComponent(() => import('./components/SemanticModelTaskBrowser.vue'));

const runtimePlatform = globalThis.semanticOperationsDesktop?.runtime === 'electron' ? 'semantic-electron' : 'semantic-web';
const client = createSemanticOperationsClient({ platform: runtimePlatform, appVersion: '0.2.0' });
const role = ref('');
const roles = ref([]);
const authenticated = ref(false);
const authenticating = ref(false);
const authMode = ref('local');
const account = ref('admin@demo.local');
const password = ref('');
const currentUser = ref(null);
const access = ref(null);
const profile = ref(null);
const draft = ref(null);
const metaModels = ref([]);
const simulation = ref(null);
const semanticContext = ref(null);
const snapshots = ref([]);
const rollbackTarget = ref(null);
const rollbackPhrase = ref('');
const agentPanel = ref(null);
const graphSelectedId = ref('');
const graphLayout = ref(null);
const embedOntology = new URLSearchParams(location.search).get('embed') === 'ontology';
const restoredView = ref(null);
function restoreModelView(view) { if (view.modelFingerprint !== draft.value?.fingerprint) return; graphLayout.value = view.layout; graphSelectedId.value = view.selectedId; restoredView.value = view; }
async function handoffOntologyMaterial(material) { activeView.value = 'agent'; await nextTick(); await agentPanel.value?.setMaterial(material); }
const operationsCenter = ref(null);
const activeView = ref('agent');
const accessTab = ref('systems');
const onboardingMounted = ref(false);
const onboardingTaskId = ref('');
const loading = ref(true);
const refreshingStatus = ref(false);
const message = ref('');
const error = ref('');
let loadGeneration = 0;

const buttonPermissionIds = computed(() => access.value?.buttonPermissionIds || []);
const canModel = computed(() => profile.value?.canModel === true && buttonPermissionIds.value.includes('meta_model.draft.save'));
const canValidate = computed(() => profile.value?.canModel === true && buttonPermissionIds.value.includes('meta_model.draft.validate'));
const canSimulate = computed(() => profile.value?.canModel === true && buttonPermissionIds.value.includes('meta_model.simulate'));
const canPublish = computed(() => profile.value?.canPublish === true && buttonPermissionIds.value.includes('meta_model.publish'));
const canReviewSemanticModels = computed(() => buttonPermissionIds.value.includes('meta_model.draft.review') && buttonPermissionIds.value.includes('meta_model.draft.save'));
const model = computed(() => metaModels.value[0] || null);
const semanticaStatus = computed(() => profile.value?.semanticDeployment?.status || profile.value?.semanticDiscovery?.status || '等待连接');
const deploymentDrift = computed(() => profile.value?.semanticDeployment?.drift || 'unknown');
const deploymentDriftLabel = computed(() => ({ in_sync: '草稿与部署一致', draft_ahead: '草稿有未发布变更', not_published: '尚未发布', unknown: '状态未知' })[deploymentDrift.value]);
const activeSnapshots = computed(() => snapshots.value.filter((item) => item.rollbackAllowed && canModel.value).length);
const suggestedPrompts = [
  '分析 ERP 和 WMS，建立采购到入库的语义模型。',
  '根据数据字典识别对象、主键和跨系统关系。',
  '检查当前模型是否存在重复对象和断裂关系。'
];
const workflow = computed(() => [
  { label: '理解运营诉求', status: 'ready' },
  { label: '生成对象与关系建议', status: 'ready' },
  { label: 'Schema Critic', status: 'guarded' },
  { label: '人工审阅 Diff', status: 'guarded' },
  { label: '保存草稿快照', status: 'guarded' },
  { label: 'Semantica 校验与发布', status: simulation.value?.status === 'published' ? 'done' : 'pending' }
]);

const unwrapAccess = (payload) => payload?.effectiveAccess || payload?.access || payload;

async function refreshSemanticStatus() {
  refreshingStatus.value = true;
  try { profile.value = await client.authoringProfile(); }
  catch (err) { error.value = err.message || '服务状态刷新失败。'; }
  finally { refreshingStatus.value = false; }
}

async function loadWorkspace({ preserveMessage = false } = {}) {
  const generation = ++loadGeneration;
  loading.value = true; error.value = ''; if (!preserveMessage) message.value = '';
  restoredView.value = null; graphLayout.value = null;
  try {
    const accessValue = unwrapAccess(await client.effectiveAccess());
    if (!Array.isArray(accessValue?.buttonPermissionIds)) throw new Error('当前身份的权限信息无效。');
    if (generation !== loadGeneration) return;
    access.value = accessValue;
    const [profileValue, draftValue, modelsValue, simulationValue, contextValue, snapshotValue] = await Promise.all([
      client.authoringProfile(), client.draft(), client.metaModels(), client.simulation(), client.semanticContext(),
      accessValue.pagePermissionIds.includes('page.semantic-operations.view') ? client.snapshots() : Promise.resolve({ snapshots: [] })
    ]);
    if (generation !== loadGeneration) return;
    access.value = accessValue;
    profile.value = profileValue;
    draft.value = draftValue;
    graphSelectedId.value = '';
    if (location.hash.startsWith('#model-view=')) activeView.value = 'model';
    metaModels.value = modelsValue;
    simulation.value = simulationValue;
    semanticContext.value = contextValue;
    snapshots.value = snapshotValue.snapshots || [];
    if (location.hash.startsWith('#saved-model-view=')) {
      const id = decodeURIComponent(location.hash.slice('#saved-model-view='.length));
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('模型视图链接格式无效。');
      const result = await client.knowledge.modelView(id);
      if (generation !== loadGeneration) return;
      if (result.view.modelFingerprint !== draftValue.fingerprint) throw new Error('模型版本已变化，不能套用旧视图。');
      restoreModelView(result.view); activeView.value = 'model';
    } else if (embedOntology) throw new Error('只读嵌入需要有效的个人模型视图链接。');
  } catch (err) {
    if (generation === loadGeneration) error.value = err.message || '元域智语端加载失败。';
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

async function refreshAfterAgent(result) {
  message.value = result?.message || '语义层草稿已更新。';
  await loadWorkspace({ preserveMessage: true });
}

// 系统接入 → Agent 的交接：把选中系统的上下文写成一句可编辑的诉求填进输入框，
// 由运营人员核对后再自行发送；不自动建模、不自动发布。
async function openSystemInAgent(input) {
  await prepareKnowledgeModelCandidate(input);
}

async function prepareKnowledgeModelCandidate(input) {
  activeView.value = 'agent';
  await nextTick();
  agentPanel.value?.setInput(input);
  message.value = '业务理解草稿已填入输入框，请核对后自行发送；尚未建模或发布。';
}

async function openSemanticReviewTask(taskId) {
  onboardingTaskId.value = taskId;
  activeView.value = 'agent';
  await nextTick();
  await agentPanel.value?.openTask?.(taskId);
}
async function askOntologyWorkspace(question) {
  activeView.value = 'agent'; await nextTick();
  agentPanel.value?.setWorkspaceQuestion(question, { fingerprint: draft.value?.fingerprint, objectId: graphSelectedId.value || draft.value?.objectTypes?.[0]?.id });
}
async function refreshSemanticNotifications() { await operationsCenter.value?.refresh?.(); }

async function runAction(action, successText) {
  try {
    const result = await action();
    if (result.error) throw new Error(result.error);
    message.value = typeof successText === 'function' ? successText(result) : successText;
    await loadWorkspace({ preserveMessage: true });
  } catch (err) { error.value = err.message || '操作失败。'; }
}

const saveDraft = (payload) => runAction(() => client.saveDraft(payload), '人工精调内容已保存为草稿。');
const validateDraft = () => runAction(() => client.validateDraft(), '草稿结构校验已完成。');
const simulateBuild = () => runAction(() => client.simulateBuild(), semanticSimulationMessage);
const publishModel = () => runAction(() => client.publish(), '语义模型版本已完成受控登记。');
const rollbackSnapshot = async () => {
  if (!rollbackTarget.value || rollbackPhrase.value !== '确认回滚') return;
  const target = rollbackTarget.value;
  try {
    const result = await client.rollbackSnapshot(target.id);
    if (result.error) throw new Error(result.error);
    message.value = result.message || `已恢复到快照 ${target.id} 之前的语义草稿。`;
    rollbackTarget.value = null;
    rollbackPhrase.value = '';
    await loadWorkspace({ preserveMessage: true });
  } catch (err) {
    error.value = err.message || '回滚失败，请刷新快照状态后重试。';
    await loadWorkspace({ preserveMessage: true });
  }
};

async function finishAuthentication(result) {
  graphLayout.value = null;
  currentUser.value = result.user;
  role.value = result.user?.roleId || client.roleId || result.access?.primaryRoleId || '';
  await client.registerDevice();
  authenticated.value = true;
  await loadWorkspace();
}

async function login() {
  if (authenticating.value) return;
  if (!account.value.trim() || !password.value) { error.value = '请输入运营账号和密码。'; return; }
  authenticating.value = true; error.value = '';
  try { await finishAuthentication(authMode.value === 'oa' ? await client.loginOA({ account: account.value.trim(), password: password.value }) : await client.loginLocal({ account: account.value.trim(), password: password.value })); }
  catch (err) { authenticated.value = false; currentUser.value = null; role.value = ''; access.value = null; error.value = semanticConnectionMessage(err); }
  finally { authenticating.value = false; loading.value = false; }
}

async function logout() {
  await client.logout(); authenticated.value = false; currentUser.value = null; role.value = ''; access.value = null; password.value = ''; error.value = '';
}

async function restoreSession() {
  if (authenticating.value) return;
  authenticating.value = true; error.value = '';
  const result = await restoreSemanticSession({ client, finishAuthentication });
  roles.value = result.roles;
  if (!result.authenticated) { authenticated.value = false; currentUser.value = null; role.value = ''; access.value = null; restoredView.value = null; graphLayout.value = null; error.value = result.message; }
  authenticating.value = false; loading.value = false;
}
onMounted(restoreSession);
</script>

<template>
  <div class="semantic-console">
    <section v-if="!authenticated" class="semantic-auth">
      <form @submit.prevent="login">
        <span>SEMANTIC OPERATIONS IDENTITY</span><h1>登录元域智语端</h1>
        <p>运营权限由企业身份和设备会话共同确定，界面不再允许手动切换角色。</p>
        <div class="auth-mode"><button type="button" :class="{ active: authMode === 'local' }" @click="authMode = 'local'">平台账号</button><button type="button" :class="{ active: authMode === 'oa' }" @click="authMode = 'oa'">OA 账号</button></div>
        <label>账号<input v-model="account" autocomplete="username" /></label><label>密码<input v-model="password" type="password" autocomplete="current-password" /></label>
        <div v-if="error" class="ops-error" role="alert">{{ error }}<button type="button" :disabled="authenticating" @click="restoreSession">重试连接</button></div><button class="auth-submit" :disabled="authenticating">{{ authenticating ? '正在校验身份与设备…' : '进入元域智语工作台' }}</button>
      </form>
    </section>
    <section v-else-if="embedOntology" class="ontology-embed"><p v-if="loading">正在核验身份、模型版本与视图…</p><p v-else-if="error" role="alert">{{ error }}</p><template v-else-if="restoredView"><h1>{{ restoredView.label }} · 只读模型视图</h1><p>当前登录身份授权的结构视图，不包含业务记录或原始资料。</p><OntologyGraph :objects="draft.objectTypes" :relationships="draft.relationshipTypes" :selected-id="graphSelectedId" :saved-layout="graphLayout" :model-fingerprint="draft.fingerprint" :ask-enabled="false" :layout-save-enabled="false" /></template></section>
    <template v-else>
    <aside class="ops-rail">
      <div class="ops-brand"><span>Σ</span><div><b>元域智脑</b><small>SEMANTIC OPERATIONS</small></div></div>
      <div class="ops-boundary"><i/><div><b>独立运营端</b><small>不属于业务端智脑</small></div></div>
      <nav>
        <button :class="{ active: activeView === 'system-access' }" @click="activeView = 'system-access'"><span>＋</span><div><b>系统接入</b><small>系统清单、连接配置与接入准备</small></div></button>
        <button :class="{ active: activeView === 'workflows' }" @click="activeView = 'workflows'"><span>↗</span><div><b>流程语义</b><small>钉钉与 OA 流程读取、版本同步</small></div></button>
        <button :class="{ active: activeView === 'agent' }" @click="activeView = 'agent'"><span>01</span><div><b>Agent 工作台</b><small>自然语言与多模态建模</small></div></button>
        <button v-if="role === 'executive'" :class="{ active: activeView === 'model-tasks' }" @click="activeView = 'model-tasks'"><span>◇</span><div><b>独立模型任务</b><small>模型隔离 · 分步本地校验</small></div></button>
        <button :class="{ active: activeView === 'model' }" @click="activeView = 'model'"><span>02</span><div><b>模型关系图</b><small>查看顶层对象与系统关联</small></div></button>
        <button :class="{ active: activeView === 'versions' }" @click="activeView = 'versions'"><span>03</span><div><b>版本与回滚</b><small>Diff、快照和恢复</small></div></button>
        <button :class="{ active: activeView === 'knowledge' }" @click="activeView = 'knowledge'"><span>04</span><div><b>知识资料</b><small>来源地图与原文依据</small></div></button>
      </nav>
      <section class="ops-flow"><span>当前治理流程</span><div v-for="(step, index) in workflow" :key="step.label" :class="step.status"><i>{{ index + 1 }}</i><b>{{ step.label }}</b></div></section>
      <footer><b>执行边界</b><span>Agent只能生成计划和调用受控工具；发布、删除、主键变更仍需显式确认。</span></footer>
    </aside>

    <main>
      <header class="ops-topbar"><div><span>SEMANTIC CONTROL PLANE</span><h1>{{ activeView === 'model-tasks' ? '独立模型任务 · 本地校验' : activeView === 'system-access' ? (accessTab === 'systems' ? '系统接入与生命周期' : '接入材料与场景准备') : activeView === 'workflows' ? '流程语义接入中心' : activeView === 'knowledge' ? '知识资料地图' : activeView === 'agent' ? '元域智语 Agent 工作台' : activeView === 'model' ? '语义模型关系图' : '模型版本与恢复' }}</h1></div><div class="ops-top-actions"><div v-if="!['system-access','workflows','model-tasks'].includes(activeView)" :class="['ops-live', deploymentDrift]"><i/>Semantica · {{ semanticaStatus }} · {{ deploymentDriftLabel }}</div><button v-if="!['system-access','workflows','model-tasks'].includes(activeView)" class="ops-logout" :disabled="refreshingStatus" @click="refreshSemanticStatus">{{ refreshingStatus ? '刷新中…' : '刷新服务状态' }}</button><label>已认证运营身份<strong>{{ currentUser?.name || currentUser?.account }}</strong><small>{{ roles.find(item => item.id === role)?.name || role }} · {{ client.deviceId.slice(-8) }}</small></label><button class="ops-logout" @click="logout">退出</button></div></header>

      <div v-if="error && activeView !== 'system-access'" class="ops-error">{{ error }}<button @click="loadWorkspace">重新加载</button></div>
      <div v-if="message && activeView !== 'system-access'" class="ops-message">{{ message }}</div>
      <div v-if="loading && activeView !== 'system-access'" class="ops-loading">正在校验身份、装载语义模型与Semantica状态…</div>

      <SemanticModelTaskBrowser v-if="activeView === 'model-tasks' && role === 'executive'" :key="`${access?.tenantId || currentUser?.tenantId || ''}:${currentUser?.id || currentUser?.account}:${role}`" :client="client" :can-validate="canValidate" :can-confirm="canModel && canValidate" :can-build="canModel" />
      <div v-else-if="activeView === 'system-access'" class="ops-onboarding-pane">
        <div class="ops-subtabs" role="tablist" aria-label="接入视图">
          <button type="button" role="tab" :aria-selected="accessTab === 'systems'" :class="{ active: accessTab === 'systems' }" @click="accessTab = 'systems'">系统接入</button>
          <button type="button" role="tab" :aria-selected="accessTab === 'materials'" :class="{ active: accessTab === 'materials' }" @click="accessTab = 'materials'; onboardingMounted = true">材料与场景准备</button>
        </div>
        <SystemAccessWorkspace
          v-show="accessTab === 'systems'"
          :client="client" :role="role" :button-permission-ids="buttonPermissionIds"
          :can-probe="buttonPermissionIds.includes('meta_model.draft.save')"
          :can-configure-mapping="buttonPermissionIds.includes('meta_model.draft.save')"
          :can-read-mapping="buttonPermissionIds.includes('page.semantic-operations.view')"
          @open-agent="openSystemInAgent" />
        <SemanticOnboardingWorkspace
          v-if="onboardingMounted" v-show="accessTab === 'materials'"
          :client="client" :can-write="buttonPermissionIds.includes('meta_model.draft.save')"
          @open-agent="onboardingTaskId = $event; activeView = 'agent'" @open-model="activeView = 'model'" />
      </div>
      <div v-else-if="activeView === 'workflows'" class="ops-onboarding-pane">
        <WorkflowSemanticCenter :client="client" :can-sync="buttonPermissionIds.includes('meta_model.draft.save')" :can-publish="buttonPermissionIds.includes('meta_model.publish')" :can-replay="buttonPermissionIds.includes('event.outbox.replay')" />
      </div>
      <div v-else-if="!error && !loading" :class="['ops-workspace', { 'ops-agent-workspace': activeView === 'agent' }]">
        <section class="ops-main-pane">
          <template v-if="activeView === 'agent'">
            <div class="ops-intro"><div><span>AGENT-FIRST AUTHORING</span><h2>告诉 Agent 想建设什么，不需要先理解配置表单</h2><p>Agent会读取自然语言和受控材料，形成语义对象关系图，并说明各对象来自哪些系统、系统间如何衔接。你可以直接说“修改关系”“审核通过”或“发布模型”。</p></div><div><b>{{ canModel ? '可执行建模' : '只读模式' }}</b><small>{{ profile?.role || role }}</small></div></div>
            <div class="ops-prompts"><span>可以这样提出任务</span><button v-for="prompt in suggestedPrompts" :key="prompt" @click="agentPanel?.setInput(prompt)">{{ prompt }}</button></div>
            <SemanticAgentWorkspace ref="agentPanel" :client="client" :initial-task-id="onboardingTaskId" :can-review="canReviewSemanticModels" @applied="refreshAfterAgent" @review-created="refreshSemanticNotifications"/>
          </template>

          <template v-else-if="activeView === 'model'">
            <div class="ops-section-head"><div><span>SEMANTIC MODEL OVERVIEW</span><h2>语义模型关系总览</h2><p>这里先看业务对象和对象关系。字段映射、主键、回放与 Semantica 细节保留在下方高级校验区。</p></div><button class="outline-button" @click="activeView = 'agent'">在 Agent 工作台审核与修改</button></div>
            <section class="model-overview-card">
              <header><div><span>{{ model?.name || '当前语义模型' }}</span><small>{{ model?.code || '模型草稿' }} · {{ draft?.objectTypes?.length || 0 }} 个对象 · {{ draft?.relationshipTypes?.length || 0 }} 条关系</small></div><b>{{ deploymentDriftLabel }}</b></header>
              <OAMetaModelStudio :meta-model="model" :draft="draft" :authoring-profile="profile" :simulation="simulation" :semantic-context="semanticContext" :role="role" :message="message" :replay-cases="client.replayOntologyCases" :knowledge-client="client.knowledge" :button-permission-ids="buttonPermissionIds" :focused-object-id="graphSelectedId" :saved-layout="graphLayout" @save-layout="graphLayout = $event" @select-object="graphSelectedId = $event" @save-draft="saveDraft" @validate-draft="validateDraft" @simulate-build="simulateBuild" @publish="publishModel" @ask="askOntologyWorkspace"/>
              <OntologyWorkspaceTools v-if="draft" :draft="draft" :can-edit="canModel" :selected-id="graphSelectedId" @locate="graphSelectedId = $event" @material="handoffOntologyMaterial" @ask="askOntologyWorkspace" />
              <OntologySavedViewsPanel v-if="draft" :client="client.knowledge" :draft="draft" :layout="graphLayout" :selected-id="graphSelectedId" :can-edit="canModel" :can-review="buttonPermissionIds.includes('meta_model.draft.review')" @restore="restoreModelView" />
            </section>
          </template>

          <KnowledgeLibraryPanel v-else-if="activeView === 'knowledge'" :client="client.knowledge" :can-write="buttonPermissionIds.includes('meta_model.draft.save')" :can-review="buttonPermissionIds.includes('meta_model.draft.review')" :can-model="canModel" @model-candidate="prepareKnowledgeModelCandidate" />
          <template v-else>
            <div class="ops-section-head"><div><span>GOVERNED HISTORY</span><h2>版本记录与草稿回滚</h2><p>共 {{ snapshots.length }} 个快照，不设固定数量上限。仅当前草稿指纹匹配的快照可回滚；回滚只恢复未发布草稿，不撤销已发布模型或业务数据。</p></div></div>
            <section class="version-list">
              <article v-for="snapshot in snapshots" :key="snapshot.id" :class="{ 'snapshot-rolled-back': snapshot.status === 'rolled_back', 'snapshot-stale': snapshot.status === 'active' && !snapshot.rollbackAllowed }">
                <div class="version-icon">{{ snapshot.status === 'rolled_back' ? '↶' : snapshot.rollbackAllowed ? 'V' : '!' }}</div>
                <div class="version-info">
                  <span>{{ snapshot.status === 'rolled_back' ? '已完成回滚' : !snapshot.rollbackAllowed ? '历史快照（草稿已继续变更）' : canModel ? '可回滚的当前快照' : '当前版本匹配 · 需草稿保存权限才能回滚' }}</span>
                  <b>{{ snapshot.id }}</b>
                  <small>{{ snapshot.sourceType === 'manual_save' ? '草稿保存时间' : '采纳时间' }} {{ snapshot.createdAt }} · {{ snapshot.sourceType === 'manual_save' ? '人工保存草稿' : `来源提案 ${snapshot.proposalId || '历史记录'}` }}</small>
                  <small>{{ snapshot.sourceType === 'manual_save' ? '操作人' : '采纳操作人' }} {{ snapshot.createdBySubjectId || '旧记录未留存' }}{{ snapshot.createdByRoleId ? ` · ${roles.find(item => item.id === snapshot.createdByRoleId)?.name || snapshot.createdByRoleId}` : '' }}</small>
                  <small v-if="snapshot.rolledBackAt">回滚时间 {{ snapshot.rolledBackAt }} · 操作人 {{ snapshot.rolledBackBySubjectId || '旧记录未留存' }}{{ snapshot.rolledBackByRoleId ? ` · ${roles.find(item => item.id === snapshot.rolledBackByRoleId)?.name || snapshot.rolledBackByRoleId}` : '' }}</small>
                  <small v-else-if="snapshot.status === 'active' && !snapshot.rollbackAllowed">当前草稿指纹与该快照不一致，为避免覆盖后续修改，已禁用回滚。</small>
                  <details><summary>查看结构差异</summary><p>基础指纹：{{ snapshot.diff?.baseFingerprint }}</p><ul><li v-for="item in snapshot.diff?.objectChanges?.filter(item => item.change !== 'unchanged')" :key="item.id">{{ item.change === 'added' ? '新增' : item.change === 'removed' ? '移除' : '更新' }}对象：{{ item.label }}（{{ item.id }}）</li><li v-for="item in snapshot.diff?.relationshipChanges?.filter(item => item.change !== 'unchanged')" :key="`${item.from}-${item.predicate}-${item.to}`">{{ item.change === 'removed' ? '移除' : item.change === 'added' ? '新增' : '更新' }}关系：{{ item.from }} —{{ item.predicate }}→ {{ item.to }}</li></ul></details>
                </div>
                <div class="version-diff"><b>+{{ snapshot.summary.addedObjects }}</b><span>对象</span><b>~{{ snapshot.summary.updatedObjects }}</b><span>更新</span><b>+{{ snapshot.summary.addedRelationships }}</b><span>关系</span><button v-if="snapshot.rollbackAllowed && canModel" class="version-rollback" @click="rollbackTarget = snapshot; rollbackPhrase = ''">恢复到本次操作之前</button><span v-else-if="snapshot.status === 'active' && !snapshot.rollbackAllowed" class="snapshot-locked">草稿已变化，不可直接回滚</span></div>
              </article>
              <p v-if="!snapshots.length">暂无本身份的模型变更快照。手动保存产生实际语义变更，或审核采纳 Agent 提案后会生成快照；回滚操作还需要“生成与保存草稿”权限。</p>
            </section>
            <section v-if="rollbackTarget" class="rollback-confirm"><span>受控恢复</span><h3>恢复到 {{ rollbackTarget.id }} 之前？</h3><p>将当前未发布草稿恢复为该次模型变更前的内容，不影响已发布版本或业务数据。若草稿在确认前发生变化，服务器会拒绝覆盖。</p><label>输入“确认回滚”<input v-model="rollbackPhrase" autocomplete="off" /></label><div><button class="outline-button" @click="rollbackTarget = null; rollbackPhrase = ''">取消</button><button class="danger-button" :disabled="rollbackPhrase !== '确认回滚'" @click="rollbackSnapshot">确认恢复草稿</button></div></section>
          </template>
        </section>

        <aside class="ops-context-pane">
          <section><span>当前语义草稿</span><div class="ops-kpis"><article><b>{{ draft?.objectTypes?.length || 0 }}</b><small>对象类型</small></article><article><b>{{ draft?.relationshipTypes?.length || 0 }}</b><small>关系类型</small></article><article><b>{{ activeSnapshots }}</b><small>可回滚快照</small></article><article><b>{{ semanticContext?.metrics?.openConflicts || 0 }}</b><small>待复核冲突</small></article></div></section>
          <section><span>权限闸门</span><div class="gate-list"><p :class="{ passed: canModel }"><i/>生成与保存草稿</p><p :class="{ passed: canValidate }"><i/>运行结构校验</p><p :class="{ passed: canSimulate }"><i/>Semantica模拟构建</p><p :class="{ passed: canPublish }"><i/>发布模型版本</p></div></section>
          <section><span>模型状态</span><div class="model-state"><b>{{ model?.name || '语义元模型' }}</b><small>{{ model?.code }} · {{ model?.status }}</small><p>{{ deploymentDriftLabel }}。{{ profile?.semanticDeployment?.detail || '模型变更先进入草稿，通过校验和审批后才会登记。' }}</p><code v-if="profile?.semanticDeployment?.draftFingerprint">草稿 {{ profile.semanticDeployment.draftFingerprint }}<br>部署 {{ profile.semanticDeployment.deploymentFingerprint || '—' }}</code></div></section>
          <section><span>执行原则</span><ul><li>不读取无授权业务明细</li><li>不把长期记忆当作执行授权</li><li>不允许Agent绕过Review Queue</li><li>所有变更保存证据、Diff和快照</li></ul></section>
          <SemanticOperationsCenter ref="operationsCenter" :client="client" @open-task="openSemanticReviewTask" />
        </aside>
      </div>
    </main>
    </template>
  </div>
</template>

<style scoped>
.ontology-embed{padding:18px;width:100%;min-width:0;box-sizing:border-box}.ontology-embed h1{font-size:18px}.ontology-embed p{font-size:12px;color:#91b2bf}
.ops-onboarding-pane { min-width: 0; padding: 24px; }
.model-overview-card{display:grid;gap:16px;padding:18px;border:1px solid #274e60;border-radius:12px;background:linear-gradient(145deg,#0c2634,#081a25)}
.model-overview-card>header{display:flex;align-items:center;justify-content:space-between;gap:12px}.model-overview-card>header>div{display:grid;gap:5px}.model-overview-card>header span{color:#e2f2f4;font-size:16px;font-weight:750}.model-overview-card>header small{color:#83a4b2;font-size:11px}.model-overview-card>header>b{padding:6px 9px;border-radius:999px;color:#73d5bd;background:#103a35;font-size:10px}
.model-object-list{display:flex;flex-wrap:wrap;gap:10px}.model-object-list article{display:grid;gap:5px;min-width:150px;padding:12px 14px;border:1px solid #316275;border-radius:9px;background:#0d2a39}.model-object-list b{color:#cde6e9;font-size:12px}.model-object-list small{color:#6bcab9;font-size:10px}
.model-relationship-list{display:grid;gap:8px}.model-relationship-list article{display:grid;grid-template-columns:auto minmax(150px,1fr) auto;align-items:center;gap:8px;padding:10px 12px;border:1px solid #264858;border-radius:8px;background:#081b26}.model-relationship-list b{color:#d1e4e8;font-size:11px}.model-relationship-list span{color:#9cb8c3;font-size:11px}.model-relationship-list small{grid-column:2 / 4;color:#62c8b4;font-size:10px}.model-relationship-list>p{color:#7995a2;font-size:12px}
.model-advanced{padding-top:12px;border-top:1px solid #274657}.model-advanced>summary{color:#83aab8;font-size:11px;cursor:pointer}
.ops-subtabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.ops-subtabs button { font-size: 12px; padding: 7px 13px; border: 1px solid #36556b; border-radius: 7px; background: #102637; color: #cfdfeb; cursor: pointer; }
.ops-subtabs button.active { border-color: #62a5b2; background: #143647; color: #eaf7fb; }
@media (max-width: 760px) { .ops-onboarding-pane { padding: 14px; } }
</style>

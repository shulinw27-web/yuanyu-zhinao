<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, subscribeAuthorizationInvalidated } from './api/client.js';
import AppShell from './components/AppShell.vue';
import RiskDrawer from './components/RiskDrawer.vue';
import DashboardPage from './features/dashboard/DashboardPage.vue';
import RiskCentrePage from './features/risk/RiskCentrePage.vue';
import WorldModelPage from './features/world-model/WorldModelPage.vue';
import ChannelsPage from './features/channels/ChannelsPage.vue';
import IntelligencePage from './features/intelligence/IntelligencePage.vue';
import ConfigManagementPage from './features/config/ConfigManagementPage.vue';
import ProcurementActionPage from './features/actions/ProcurementActionPage.vue';
import PrivateAgentPage from './features/agent/PrivateAgentPage.vue';
import PermissionManagementPage from './features/permission/PermissionManagementPage.vue';
import { accessSignature, canAccessPage, captureAccessGeneration, firstAccessiblePage, isCurrentAccessGeneration } from './permission-navigation.js';
import { applyPageData, fetchPageData } from './page-data-registry.js';
import { createAppActions } from './app-actions.js';

const page = ref('dashboard');
const role = ref('quality_manager');
const roles = ref([]); const dashboard = ref(null); const risks = ref([]); const notifications = ref([]); const world = ref(null); const access = ref(null); const systems = ref([]); const platform = ref(null); const configuration = ref(null); const procurement = ref(null); const agentRuntime = ref(null); const agentTools = ref([]); const agentRuns = ref([]); const agentModelConfig = ref(null);
const agentSkills = ref([]); const agentConnectors = ref(null);
const agentOperations = ref(null); const agentWorkItems = ref([]); const agentEvaluations = ref(null); const modelConfigMessage = ref(''); const simulation = ref(null); const simulationMessage = ref('');
const worldTemplates = ref([]); const worldTargets = ref([]); const worldDrafts = ref([]); const worldTemplateMessage = ref('');
const coreMetaObjects = ref(null); const metaModels = ref([]); const oaMetaSimulation = ref(null); const oaMetaDraft = ref(null); const oaMetaAuthoringProfile = ref(null); const metaModelMessage = ref('');
const accountCenter = ref(null); const permissionCenter = ref(null); const keyCenter = ref(null); const keyCenterMessage = ref(''); const semanticContext = ref(null);
const effectiveAccess = ref(null); const permissionWorkspace = ref(null); const permissionMessage = ref(''); const permissionSaving = ref(false);
const alertingWorkspace = ref(null); const alertingMessage = ref(''); const alertingSaving = ref(false);
const selectedRisk = ref(null); const message = ref(''); const procurementMessage = ref(''); const error = ref('');
const pageLoading = ref(true);
const pageDataState = {
  dashboard, risks, notifications, world, access, systems, platform, configuration, procurement,
  agentRuntime, agentTools, agentRuns, agentModelConfig, agentSkills, agentConnectors, agentOperations,
  agentWorkItems, agentEvaluations, simulation, worldTemplates, worldTargets, worldDrafts,
  coreMetaObjects, metaModels, oaMetaSimulation, oaMetaDraft, oaMetaAuthoringProfile,
  accountCenter, permissionCenter, keyCenter, semanticContext, permissionWorkspace, alertingWorkspace
};
const initialAssistantMessages = () => [{ role: 'assistant', text: '你好，我是健康运营私有 Agent。可协同生产、市场与内务子 Agent，在受控上下文中生成业务计划。', citations: ['当前授权角色', '世界模型受控上下文'] }];
const assistantMessages = ref(initialAssistantMessages());
const buttonPermissionIds = computed(() => effectiveAccess.value?.buttonPermissionIds || []);
const accessWorkspace = computed(() => effectiveAccess.value ? { effectiveAccess: effectiveAccess.value } : null);
const loadedPages = new Set();
let accessGeneration = 0;
let pageLoadGeneration = 0;
let authorizationRefreshPromise = null;
let authorizationFailClosedQueued = false;
let unsubscribeAuthorizationInvalidated = null;
let accessPollTimer = null;
let disposed = false;
const accessPollIntervalMs = 30_000;

function captureRequestAccess() {
  return captureAccessGeneration(accessGeneration, role.value);
}

function canCommitRequest(snapshot) {
  return isCurrentAccessGeneration(snapshot, accessGeneration, role.value);
}

function invalidatePendingResponses() {
  ++accessGeneration;
  ++pageLoadGeneration;
}

function enterFailClosedAuthorizationState() {
  if (effectiveAccess.value === null) return;
  invalidatePendingResponses();
  effectiveAccess.value = null;
  permissionSaving.value = false;
  alertingSaving.value = false;
  resetPageData();
  pageLoading.value = true;
  error.value = '';
}

async function runAccessGuarded(operation, commit, reportError) {
  const requestSnapshot = captureRequestAccess();
  try {
    const result = await operation(requestSnapshot.roleId);
    if (!canCommitRequest(requestSnapshot)) return false;
    await commit(result);
    return canCommitRequest(requestSnapshot);
  } catch (err) {
    if (canCommitRequest(requestSnapshot)) reportError?.(err);
    return false;
  }
}

function unwrapPermissionWorkspace(payload) {
  const candidate = payload?.workspace || payload?.permissionManagement || payload?.overview || payload;
  return candidate?.effectiveAccess && Array.isArray(candidate?.organizations) ? candidate : null;
}

function unwrapEffectiveAccess(payload) {
  const candidate = payload?.effectiveAccess || payload?.access || payload;
  return Array.isArray(candidate?.menuIds) && Array.isArray(candidate?.pagePermissionIds) && Array.isArray(candidate?.buttonPermissionIds) ? candidate : null;
}

function resetPageData() {
  loadedPages.clear();
  dashboard.value = null;
  risks.value = [];
  notifications.value = [];
  world.value = null;
  access.value = null;
  systems.value = [];
  platform.value = null;
  configuration.value = null;
  procurement.value = null;
  agentRuntime.value = null;
  agentTools.value = [];
  agentRuns.value = [];
  agentModelConfig.value = null;
  agentSkills.value = [];
  agentConnectors.value = null;
  agentOperations.value = null;
  agentWorkItems.value = [];
  agentEvaluations.value = null;
  simulation.value = null;
  worldTemplates.value = [];
  worldTargets.value = [];
  worldDrafts.value = [];
  coreMetaObjects.value = null;
  metaModels.value = [];
  oaMetaSimulation.value = null;
  oaMetaDraft.value = null;
  oaMetaAuthoringProfile.value = null;
  accountCenter.value = null;
  permissionCenter.value = null;
  keyCenter.value = null;
  semanticContext.value = null;
  permissionWorkspace.value = null;
  alertingWorkspace.value = null;
  selectedRisk.value = null;
}

function resetRoleMessages() {
  message.value = '';
  procurementMessage.value = '';
  modelConfigMessage.value = '';
  simulationMessage.value = '';
  worldTemplateMessage.value = '';
  metaModelMessage.value = '';
  keyCenterMessage.value = '';
  permissionMessage.value = '';
  alertingMessage.value = '';
  assistantMessages.value = initialAssistantMessages();
}

async function loadPage(pageId, { force = false } = {}) {
  const accessSnapshot = effectiveAccess.value;
  if (!accessSnapshot) return;
  if (!canAccessPage(pageId, accessSnapshot)) {
    const fallback = firstAccessiblePage(accessSnapshot);
    if (fallback && fallback !== page.value) page.value = fallback;
    return;
  }
  if (!force && loadedPages.has(pageId)) {
    error.value = '';
    pageLoading.value = false;
    return;
  }
  const requestId = ++pageLoadGeneration;
  const requestAccessGeneration = accessGeneration;
  const activeRole = role.value;
  pageLoading.value = true;
  error.value = '';
  try {
    const data = await fetchPageData({ pageId, activeRole, effectiveAccess: accessSnapshot, api, canAccessPage });
    if (requestId !== pageLoadGeneration || requestAccessGeneration !== accessGeneration || activeRole !== role.value || pageId !== page.value) return;
    applyPageData({ pageId, data, state: pageDataState, unwrapPermissionWorkspace });
    loadedPages.add(pageId);
  } catch (err) {
    if (requestId === pageLoadGeneration && requestAccessGeneration === accessGeneration && pageId === page.value) {
      error.value = err.message || '当前页面数据加载失败。';
    }
  } finally {
    if (requestId === pageLoadGeneration) pageLoading.value = false;
  }
}

async function reloadRoleAccess() {
  invalidatePendingResponses();
  const requestSnapshot = captureRequestAccess();
  const activeRole = role.value;
  pageLoading.value = true;
  error.value = '';
  effectiveAccess.value = null;
  permissionSaving.value = false;
  resetPageData();
  resetRoleMessages();
  try {
    const payload = await api.effectiveAccess(activeRole);
    if (!canCommitRequest(requestSnapshot)) return;
    const accessValue = unwrapEffectiveAccess(payload);
    if (!accessValue) throw new Error('有效权限接口返回的数据结构无效。');
    effectiveAccess.value = accessValue;
    const targetPage = canAccessPage(page.value, accessValue) ? page.value : firstAccessiblePage(accessValue);
    if (!targetPage) throw new Error('当前身份没有可访问页面。');
    if (page.value !== targetPage) page.value = targetPage;
    else await loadPage(targetPage, { force: true });
  } catch (err) {
    if (canCommitRequest(requestSnapshot)) {
      error.value = err.message || '后端服务不可用，请先启动 Demo API（npm.cmd run dev:api）。';
      pageLoading.value = false;
    }
  }
}

async function refreshAuthorization({ forceReload = false, failClosed = false } = {}) {
  if (authorizationRefreshPromise) return authorizationRefreshPromise;
  const activeRole = role.value;
  const previousSignature = accessSignature(effectiveAccess.value);

  if (failClosed) {
    enterFailClosedAuthorizationState();
  }
  let requestSnapshot = captureRequestAccess();

  authorizationRefreshPromise = (async () => {
    try {
      const payload = await api.effectiveAccess(activeRole);
      if (!canCommitRequest(requestSnapshot)) return false;
      const accessValue = unwrapEffectiveAccess(payload);
      if (!accessValue) throw new Error('有效权限接口返回的数据结构无效。');
      const changed = previousSignature !== accessSignature(accessValue);
      if (!changed && !forceReload && !failClosed) return false;

      if (!failClosed) {
        invalidatePendingResponses();
        requestSnapshot = captureRequestAccess();
        permissionSaving.value = false;
        resetPageData();
        pageLoading.value = true;
        error.value = '';
      }
      effectiveAccess.value = accessValue;
      const targetPage = canAccessPage(page.value, accessValue) ? page.value : firstAccessiblePage(accessValue);
      if (!targetPage) throw new Error('当前身份没有可访问页面。');
      if (page.value !== targetPage) page.value = targetPage;
      else await loadPage(targetPage, { force: true });
      return true;
    } catch (err) {
      if (canCommitRequest(requestSnapshot)) {
        if (failClosed) effectiveAccess.value = null;
        error.value = err.message || '权限状态刷新失败，请稍后重试。';
        pageLoading.value = false;
      }
      return false;
    } finally {
      authorizationRefreshPromise = null;
    }
  })();
  return authorizationRefreshPromise;
}

function handleAuthorizationInvalidated(detail) {
  if (disposed) return;
  enterFailClosedAuthorizationState();
  // The access refresh itself may be rejected when a session expires. Do not
  // recursively refresh the same endpoint; stay fail-closed and surface error.
  if (detail?.path === '/access/me') return;
  if (!authorizationRefreshPromise) {
    void refreshAuthorization({ forceReload: true, failClosed: true });
    return;
  }
  if (authorizationFailClosedQueued) return;
  authorizationFailClosedQueued = true;
  void authorizationRefreshPromise.finally(() => {
    authorizationFailClosedQueued = false;
    if (!disposed) void refreshAuthorization({ forceReload: true, failClosed: true });
  });
}

function pollAuthorization() {
  if (disposed) return;
  if (globalThis.document?.visibilityState === 'hidden') return;
  void refreshAuthorization();
}

function handleVisibilityChange() {
  if (globalThis.document?.visibilityState === 'visible') pollAuthorization();
}

async function refreshPermissionWorkspace(payload) {
  const requestSnapshot = captureRequestAccess();
  const candidate = unwrapPermissionWorkspace(payload) || unwrapPermissionWorkspace(await api.permissionManagement(requestSnapshot.roleId));
  if (!canCommitRequest(requestSnapshot)) return false;
  if (!candidate) throw new Error('权限管理接口返回的数据结构无效。');
  invalidatePendingResponses();
  pageLoading.value = true;
  error.value = '';
  resetPageData();
  effectiveAccess.value = candidate.effectiveAccess;
  permissionWorkspace.value = candidate;
  loadedPages.add('permissions');
  const targetPage = canAccessPage(page.value, candidate.effectiveAccess) ? page.value : firstAccessiblePage(candidate.effectiveAccess);
  if (!targetPage) throw new Error('权限更新后，当前身份没有可访问页面。');
  if (page.value !== targetPage) page.value = targetPage;
  else if (targetPage === 'permissions') pageLoading.value = false;
  else await loadPage(targetPage, { force: true });
  return true;
}

function navigateTo(nextPage) {
  if (!canAccessPage(nextPage, effectiveAccess.value)) return;
  if (page.value === nextPage) loadPage(nextPage, { force: Boolean(error.value) });
  else page.value = nextPage;
}

const {
  chooseRisk,
  act,
  executeProcurement,
  runAgentEvaluations,
  createWorldDraft,
  validateWorldDraft,
  publishWorldDraft,
  simulateOAMetaModel,
  publishOAMetaModel,
  saveOAMetaDraft,
  validateOAMetaDraft,
  saveAgentModelConfig,
  runSimulationScenario,
  decideSimulationApproval,
  setSimulationConnectorFault,
  resetSimulation,
  rotateKeyPolicy,
  revokeKeyLease,
  assignPermissionUser,
  savePermissionPolicy,
  saveAlertingConfiguration,
  simulateAlertRoute,
  testAlertVoice,
  recordAlertVoiceEvent
} = createAppActions({
  api,
  refs: {
    page, effectiveAccess, access, selectedRisk, message, procurementMessage, procurement,
    agentRuns, agentOperations, agentWorkItems, assistantMessages, agentEvaluations, error,
    worldTemplateMessage, worldDrafts, metaModels, oaMetaSimulation, metaModelMessage, oaMetaDraft,
    agentModelConfig, modelConfigMessage, simulation, simulationMessage, keyCenterMessage, keyCenter,
    permissionSaving, permissionMessage, alertingSaving, alertingMessage, alertingWorkspace, notifications
  },
  buttonPermissionIds,
  loadedPages,
  captureRequestAccess,
  canCommitRequest,
  loadPage,
  runAccessGuarded,
  canAccessPage,
  refreshPermissionWorkspace
});

onMounted(async () => {
  disposed = false;
  unsubscribeAuthorizationInvalidated = subscribeAuthorizationInvalidated(handleAuthorizationInvalidated);
  globalThis.document?.addEventListener('visibilitychange', handleVisibilityChange);
  accessPollTimer = globalThis.setInterval(pollAuthorization, accessPollIntervalMs);
  try {
    roles.value = await api.roles();
  } catch {
    error.value = '无法连接后端服务。';
    pageLoading.value = false;
    return;
  }
  await reloadRoleAccess();
});
onUnmounted(() => {
  disposed = true;
  unsubscribeAuthorizationInvalidated?.();
  unsubscribeAuthorizationInvalidated = null;
  globalThis.document?.removeEventListener('visibilitychange', handleVisibilityChange);
  if (accessPollTimer) globalThis.clearInterval(accessPollTimer);
  accessPollTimer = null;
  invalidatePendingResponses();
});
watch(role, reloadRoleAccess);
watch(page, (nextPage) => {
  if (effectiveAccess.value) loadPage(nextPage);
});
watch(effectiveAccess, (accessValue) => {
  if (!accessValue || canAccessPage(page.value, accessValue)) return;
  const fallback = firstAccessiblePage(accessValue);
  if (fallback && fallback !== page.value) page.value = fallback;
}, { deep: true });
</script>
<template>
  <AppShell v-model:role="role" :page="page" :roles="roles" :workspace="accessWorkspace" @navigate="navigateTo">
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-else-if="pageLoading" class="loading">正在按当前权限加载页面数据…</div>
    <DashboardPage v-else-if="page === 'dashboard'" :dashboard="dashboard" :notifications="notifications" :systems="systems" @select-risk="chooseRisk" @navigate="navigateTo"/>
    <RiskCentrePage v-else-if="page === 'risks'" :risks="risks" @select-risk="chooseRisk"/>
    <IntelligencePage v-else-if="page === 'intelligence'" :platform="platform" :systems="systems" :notifications="notifications" :risks="risks"/>
    <WorldModelPage v-else-if="page === 'world'" :graph="world" :access="access" :semantic-context="semanticContext" :role="role" :core-meta-objects="coreMetaObjects" :meta-models="metaModels" :oa-meta-simulation="oaMetaSimulation" :oa-meta-draft="oaMetaDraft" :oa-meta-authoring-profile="oaMetaAuthoringProfile" :meta-model-message="metaModelMessage" :button-permission-ids="buttonPermissionIds" @save-oa-meta-draft="saveOAMetaDraft" @validate-oa-meta-draft="validateOAMetaDraft" @simulate-oa-meta-model="simulateOAMetaModel" @publish-oa-meta-model="publishOAMetaModel" @refresh="loadPage('world', { force: true })"/>
    <PrivateAgentPage v-else-if="page === 'agent'" :runtime="agentRuntime" :tools="agentTools" :runs="agentRuns" :skills="agentSkills" :connectors="agentConnectors" :operations="agentOperations" :work-items="agentWorkItems" :evaluations="agentEvaluations" :role="role" :button-permission-ids="buttonPermissionIds" @run-evaluations="runAgentEvaluations"/>
    <ChannelsPage v-else-if="page === 'channels'" :notifications="notifications" :workspace="alertingWorkspace" :button-permission-ids="buttonPermissionIds" :message="alertingMessage" :saving="alertingSaving" @save-configuration="saveAlertingConfiguration" @simulate-alert="simulateAlertRoute" @test-voice="testAlertVoice" @voice-event="recordAlertVoiceEvent"/>
    <ProcurementActionPage v-else-if="page === 'procurement'" :scenario="procurement" :role="role" :action-message="procurementMessage" :button-permission-ids="buttonPermissionIds" @launch="executeProcurement('launch')" @approve="executeProcurement('approve')"/>
    <PermissionManagementPage v-else-if="page === 'permissions'" :workspace="permissionWorkspace" :role="role" :message="permissionMessage" :saving="permissionSaving" @assign-user="assignPermissionUser" @save-policy="savePermissionPolicy"/>
    <ConfigManagementPage v-else-if="page === 'config'" :configuration="configuration" :model-config="agentModelConfig" :model-config-message="modelConfigMessage" :simulation="simulation" :simulation-message="simulationMessage" :world-templates="worldTemplates" :world-targets="worldTargets" :world-drafts="worldDrafts" :account-center="accountCenter" :permission-center="permissionCenter" :key-center="keyCenter" :key-center-message="keyCenterMessage" :role="role" :button-permission-ids="buttonPermissionIds" :world-template-message="worldTemplateMessage" @run-simulation-scenario="runSimulationScenario" @decide-simulation-approval="decideSimulationApproval" @set-simulation-connector-fault="setSimulationConnectorFault" @reset-simulation="resetSimulation" @save-model-config="saveAgentModelConfig" @create-world-draft="createWorldDraft" @validate-world-draft="validateWorldDraft" @publish-world-draft="publishWorldDraft" @rotate-key-policy="rotateKeyPolicy" @revoke-key-lease="revokeKeyLease"/>
    <div v-else class="loading">当前页面不存在或不在有效权限范围内。</div>
  </AppShell>
  <RiskDrawer :risk="selectedRisk" :access="access || {}" :role="role" :message="message" :button-permission-ids="buttonPermissionIds" @close="selectedRisk = null" @acknowledge="act('acknowledge')" @approve="act('approve')"/>
</template>

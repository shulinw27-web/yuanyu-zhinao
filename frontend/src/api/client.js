export function resolveAdminApiBaseUrl(runtime = globalThis) {
  const configured = String(import.meta.env?.VITE_API_BASE_URL || runtime.__ZHINAO_RUNTIME_CONFIG__?.apiBaseUrl || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const origin = runtime.location?.origin;
  return origin && origin !== 'null' ? `${origin.replace(/\/$/, '')}/api` : 'http://127.0.0.1:3001/api';
}

const apiBaseUrl = resolveAdminApiBaseUrl();
const deviceStorageKey = 'healthcare-ai-admin-device-id';
const deviceId = globalThis.localStorage?.getItem(deviceStorageKey) || `web-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
globalThis.localStorage?.setItem(deviceStorageKey, deviceId);

export const AUTHORIZATION_INVALIDATED_EVENT = 'authorization-invalidated';
export { AUTHORIZATION_REJECTION_CODES };

const authorizationListeners = new Set();
let adminAccessTokenProvider = typeof globalThis.__ZHINAO_RUNTIME_CONFIG__?.getAccessToken === 'function'
  ? () => globalThis.__ZHINAO_RUNTIME_CONFIG__.getAccessToken()
  : null;

export function setAdminAccessTokenProvider(provider) {
  if (provider !== null && typeof provider !== 'function') throw new TypeError('Access Token provider 必须是函数或 null。');
  adminAccessTokenProvider = provider;
}

export function buildAdminAuthenticationHeaders(role, accessToken) {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : (role ? { 'x-demo-role': role } : {});
}

export function isAuthorizationRejection(status, code) {
  return status === 401 || (status === 403 && AUTHORIZATION_REJECTION_CODES.includes(code));
}

export function subscribeAuthorizationInvalidated(listener) {
  if (typeof listener !== 'function') throw new TypeError('授权失效监听器必须是函数。');
  authorizationListeners.add(listener);
  return () => authorizationListeners.delete(listener);
}

function emitAuthorizationInvalidated(detail) {
  authorizationListeners.forEach((listener) => {
    try {
      listener(detail);
    } catch {
      // A view listener must never alter the originating request result.
    }
  });
}

export class ApiError extends Error {
  constructor(message, { status, code, path, body }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || null;
    this.path = path;
    this.body = body;
  }
}

export const request = async (path, role, options = {}) => {
  const accessToken = adminAccessTokenProvider ? await adminAccessTokenProvider() : null;
  const response = await resilientFetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...buildAdminAuthenticationHeaders(role, accessToken), 'x-client-platform': 'web', 'x-client-device-id': deviceId, 'x-client-version': '0.1.0', ...(options.headers || {}) }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new ApiError(body.message || body.error || '请求失败', {
      status: response.status,
      code: body.code,
      path,
      body
    });
    if (isAuthorizationRejection(error.status, error.code)) {
      emitAuthorizationInvalidated({ status: error.status, code: error.code, path, role });
    }
    throw error;
  }
  return response.json();
};

export const api = {
  roles: () => request('/roles'),
  modules: () => request('/modules'),
  dashboard: (role) => request('/dashboard', role),
  risks: (role) => request('/risk-cases', role),
  risk: (id, role) => request(`/risk-cases/${id}`, role),
  world: (role) => request('/world-model', role),
  coreMetaObjects: (role) => request('/meta-objects', role),
  metaModels: (role) => request('/meta-models', role),
  metaModel: (id, role) => request(`/meta-models/${id}`, role),
  oaMetaModelAuthoringProfile: (role) => request('/meta-models/oa-governance/authoring-profile', role),
  oaMetaModelDraft: (role) => request('/meta-models/oa-governance/draft', role),
  saveOAMetaModelDraft: (payload, role) => request('/meta-models/oa-governance/draft', role, { method: 'POST', body: JSON.stringify(payload) }),
  validateOAMetaModelDraft: (role) => request('/meta-models/oa-governance/draft/validate', role, { method: 'POST' }),
  replayOntologyCases: (payload, role) => request('/meta-models/oa-governance/case-replay', role, { method: 'POST', body: JSON.stringify(payload) }),
  oaMetaModelSimulation: (role) => request('/meta-models/oa-governance/simulation', role),
  simulateBuildOAMetaModel: (role) => request('/meta-models/oa-governance/simulate-build', role, { method: 'POST' }),
  publishOAMetaModel: (role) => request('/meta-models/oa-governance/publish', role, { method: 'POST' }),
  worldTemplates: (role) => request('/world-model/templates', role),
  worldTemplate: (id, role) => request(`/world-model/templates/${id}`, role),
  worldConnectionTargets: (role) => request('/world-model/connection-targets', role),
  worldDrafts: (role) => request('/world-model/drafts', role),
  createWorldDraft: (payload, role) => request('/world-model/drafts', role, { method: 'POST', body: JSON.stringify(payload) }),
  validateWorldDraft: (id, role) => request(`/world-model/drafts/${id}/validate`, role, { method: 'POST' }),
  publishWorldDraft: (id, role) => request(`/world-model/drafts/${id}/publish`, role, { method: 'POST' }),
  notifications: (role) => request('/notifications', role),
  alertingWorkspace: (role) => request('/alerting/workspace', role),
  saveAlertingConfiguration: (payload, role) => request('/alerting/configuration', role, { method: 'POST', body: JSON.stringify(payload) }),
  simulateAlertRoute: (payload, role) => request('/alerting/simulations', role, { method: 'POST', body: JSON.stringify(payload) }),
  testVoiceCall: (payload, role) => request('/alerting/voice/test', role, { method: 'POST', body: JSON.stringify(payload) }),
  recordVoiceCallEvent: (id, action, role) => request(`/alerting/voice-calls/${encodeURIComponent(id)}/events`, role, { method: 'POST', body: JSON.stringify({ action }) }),
  systems: (role) => request('/systems', role),
  systemDataOverview: (role) => request('/system-data/overview', role),
  systemDataRecords: (id, role, limit = 100) => request(`/system-data/${id}/records?limit=${limit}`, role),
  simulationOverview: (role) => request('/simulation/overview', role),
  runSimulationScenario: (id, role) => request(`/simulation/scenarios/${id}/run`, role, { method: 'POST' }),
  decideSimulationApproval: (id, decision, role) => request(`/simulation/approvals/${id}/decision`, role, { method: 'POST', body: JSON.stringify({ decision }) }),
  setSimulationConnectorFault: (systemId, faultId, role) => request(`/simulation/connectors/${systemId}/fault`, role, { method: 'POST', body: JSON.stringify({ faultId }) }),
  resetSimulation: (role) => request('/simulation/reset', role, { method: 'POST' }),
  platformStatus: (role) => request('/platform-status', role),
  configurations: (role) => request('/configurations', role),
  semanticContext: (role) => request('/semantic-context', role),
  createSemanticOperationsProposal: (payload, role) => request('/semantic-operations/proposals', role, { method: 'POST', body: JSON.stringify(payload) }),
  applySemanticOperationsProposal: (proposalId, role) => request(`/semantic-operations/proposals/${encodeURIComponent(proposalId)}/apply`, role, { method: 'POST' }),
  semanticOperationsSnapshots: (role) => request('/semantic-operations/snapshots', role),
  rollbackSemanticOperationsSnapshot: (snapshotId, role) => request(`/semantic-operations/snapshots/${encodeURIComponent(snapshotId)}/rollback`, role, { method: 'POST' }),
  semanticOperationsTasks: (role, filters = {}) => {
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '' && value !== null && value !== undefined));
    return request(`/semantic-operations/tasks${query.size ? `?${query}` : ''}`, role);
  },
  semanticOperationsSources: (role, query = '') => request(`/semantic-operations/sources${query ? `?query=${encodeURIComponent(query)}` : ''}`, role),
  createSemanticOperationsTask: (payload, role) => request('/semantic-operations/tasks', role, { method: 'POST', body: JSON.stringify(payload) }),
  issueSemanticOperationsTaskConfirmation: (taskId, role) => request(`/semantic-operations/tasks/${encodeURIComponent(taskId)}/confirmation`, role, { method: 'POST' }),
  executeSemanticOperationsTask: (taskId, confirmationToken, role) => request(`/semantic-operations/tasks/${encodeURIComponent(taskId)}/execute`, role, { method: 'POST', body: JSON.stringify({ confirmationToken }) }),
  archiveSemanticOperationsTask: (taskId, role) => request(`/semantic-operations/tasks/${encodeURIComponent(taskId)}/archive`, role, { method: 'POST' }),
  reviseSemanticOperationsTaskProposal: (taskId, payload, role) => request(`/semantic-operations/tasks/${encodeURIComponent(taskId)}/proposal`, role, { method: 'PATCH', body: JSON.stringify(payload) }),
  keyCenter: (role) => request('/key-center/overview', role),
  rotateKeyPolicy: (id, role) => request(`/key-center/policies/${id}/rotate`, role, { method: 'POST' }),
  revokeKeyLease: (id, role) => request(`/key-center/leases/${id}/revoke`, role, { method: 'POST' }),
  procurementScenario: (role) => request('/procurement/scenario', role),
  launchProcurement: (role) => request('/procurement/launch', role, { method: 'POST' }),
  approveProcurement: (role) => request('/procurement/approve', role, { method: 'POST' }),
  assistantMessage: (text, role) => request('/assistant/message', role, { method: 'POST', body: JSON.stringify({ text }) }),
  assistantExecute: (commandId, role) => request('/assistant/execute', role, { method: 'POST', body: JSON.stringify({ commandId }) }),
  agentRuntime: (role) => request('/agent/runtime', role),
  agentModelConfig: (role) => request('/agent/model-config', role),
  saveAgentModelConfig: (payload, role) => request('/agent/model-config', role, { method: 'POST', body: JSON.stringify(payload) }),
  agentTools: (role) => request('/agent/tools', role),
  agentSkills: (role) => request('/agent/skills', role),
  agentConnectors: (role) => request('/agent/connectors', role),
  agentKnowledge: (role, query = '') => request(`/agent/knowledge${query ? `?query=${encodeURIComponent(query)}` : ''}`, role),
  agentOperations: (role) => request('/agent/operations', role),
  agentEvaluations: (role) => request('/agent/evaluations', role),
  runAgentEvaluations: (role) => request('/agent/evaluations/run', role, { method: 'POST' }),
  agentAuthorization: (role) => request('/agent/authorization', role),
  accountCenter: (role) => request('/account-center', role),
  permissionCenter: (role) => request('/permission-center', role),
  effectiveAccess: (role) => request('/access/me', role),
  permissionManagement: (role) => request('/permission-management', role),
  assignPermissionUser: (userId, payload, role) => request(`/permission-management/users/${encodeURIComponent(userId)}/roles`, role, { method: 'POST', body: JSON.stringify(payload) }),
  savePermissionPolicy: (roleId, payload, role) => request(`/permission-management/roles/${encodeURIComponent(roleId)}/policy`, role, { method: 'POST', body: JSON.stringify(payload) }),
  agentWorkItems: (role) => request('/agent/work-items', role),
  agentRuns: (role) => request('/agent/runs', role),
  agentMessage: (text, role) => request('/agent/message', role, { method: 'POST', body: JSON.stringify({ text }) }),
  agentExecute: (commandId, role, runId, confirmationToken) => request('/agent/execute', role, { method: 'POST', body: JSON.stringify({ commandId, runId, confirmationToken }) }),
  access: (role) => request('/authorization/explain', role),
  acknowledge: (id, role) => request(`/risk-cases/${id}/acknowledge`, role, { method: 'POST' }),
  approve: (id, role) => request(`/risk-cases/${id}/approve`, role, { method: 'POST' })
};
import { AUTHORIZATION_REJECTION_CODES } from '@healthcare-ai/api-contracts';
import { resilientFetch } from '@healthcare-ai/client-runtime';

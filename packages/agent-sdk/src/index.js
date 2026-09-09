import { API_ERROR_CODES } from '@healthcare-ai/api-contracts';
import { resilientFetch } from '@healthcare-ai/client-runtime';

export { API_ERROR_CODES };

const trimBaseUrl = (value) => String(value || '').trim().replace(/\/$/, '');

export function resolveAgentApiBaseUrl({ explicitBaseUrl, runtime = globalThis } = {}) {
  const configured = trimBaseUrl(explicitBaseUrl
    || runtime.__ZHINAO_RUNTIME_CONFIG__?.apiBaseUrl
    || runtime.zhinaoDesktop?.apiBaseUrl
    || import.meta.env?.VITE_AGENT_API_BASE_URL);
  if (configured) return configured;
  const origin = runtime.location?.origin;
  if (origin && origin !== 'null') {
    try {
      const url = new URL(origin);
      if (['http:', 'https:'].includes(url.protocol)) return `${trimBaseUrl(url.origin)}/api`;
    } catch {
      // Non-WebView origins fall through to the local Demo endpoint.
    }
  }
  // Packaged desktop applications have a file:// origin. The preload bridge
  // normally supplies an explicit address; this fallback only preserves the
  // local Demo experience.
  return 'http://127.0.0.1:3001/api';
}

const createDeviceId = (platform) => {
  const existing = globalThis.localStorage?.getItem('healthcare-ai-device-id');
  if (existing) return existing;
  const value = `${platform}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  globalThis.localStorage?.setItem('healthcare-ai-device-id', value);
  return value;
};

export function buildAgentAuthenticationHeaders({ role, identitySessionId, accessToken } = {}) {
  if (identitySessionId) return { 'x-identity-session': identitySessionId };
  if (accessToken) return { Authorization: `Bearer ${accessToken}` };
  return role ? { 'x-demo-role': role } : {};
}

export function resolveEnterpriseAccessTokenProvider(runtime = globalThis) {
  const provider = runtime.__ZHINAO_RUNTIME_CONFIG__?.getAccessToken
    || runtime.zhinaoDesktop?.auth?.getAccessToken;
  return typeof provider === 'function' ? () => provider() : null;
}

export const createAgentClient = ({ baseUrl, platform = 'web', appVersion = '0.1.0', role = 'quality_manager', accessTokenProvider = null, persistIdentity = true, identityProviderId = globalThis.__ZHINAO_RUNTIME_CONFIG__?.identityProviderId || null } = {}) => {
  if (accessTokenProvider !== null && typeof accessTokenProvider !== 'function') throw new TypeError('accessTokenProvider must be a function or null.');
  if (identityProviderId !== null && (typeof identityProviderId !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(identityProviderId))) throw new TypeError('Invalid identityProviderId.');
  const effectiveAccessTokenProvider = accessTokenProvider || resolveEnterpriseAccessTokenProvider();
  const resolvedBaseUrl = resolveAgentApiBaseUrl({ explicitBaseUrl: baseUrl });
  const deviceId = createDeviceId(platform);
  let currentRole = role;
  let session = null;
  const identityStorageKey = `healthcare-ai-identity-session-${platform}${identityProviderId ? `-${identityProviderId}` : ''}`;
  const legacyOAStorageKey = `healthcare-ai-oa-session-${platform}`;
  let identitySessionId = persistIdentity ? globalThis.localStorage?.getItem(identityStorageKey) || (!identityProviderId && globalThis.localStorage?.getItem(legacyOAStorageKey)) || null : null;
  let enterpriseAccessToken = null;
  let enterpriseAccessSuppressed = false;

  const resolveAccessToken = async () => (enterpriseAccessSuppressed
    ? null
    : enterpriseAccessToken || (effectiveAccessTokenProvider ? await effectiveAccessTokenProvider() : null));

  const request = async (path, options = {}, { requireEnterpriseToken = false } = {}) => {
    const accessToken = await resolveAccessToken();
    if (requireEnterpriseToken && !accessToken) {
      const error = new Error('企业身份尚未登录或令牌已失效。');
      error.status = 401;
      error.code = 'OIDC_TOKEN_MISSING';
      throw error;
    }
    const response = await resilientFetch(`${resolvedBaseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...buildAgentAuthenticationHeaders({ role: identityProviderId ? null : currentRole, identitySessionId, accessToken }),
        ...(identityProviderId ? { 'x-identity-provider': identityProviderId } : {}),
        'x-client-platform': platform,
        'x-client-device-id': deviceId,
        'x-client-version': appVersion,
        ...(session?.id ? { 'x-device-session': session.id } : {}),
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || '请求失败');
      error.status = response.status;
      error.code = payload.code || null;
      error.traceId = payload.traceId || null;
      error.evidenceTrace = payload.evidenceTrace || null;
      error.payload = payload;
      throw error;
    }
    return payload;
  };

  const dingTalkRequest = async (path, options = {}, timeoutMs = 20000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await request(path, { ...options, signal: controller.signal }); }
    catch (error) {
      if (controller.signal.aborted) throw new Error('钉钉登录服务响应超时，请检查网络后重试。', { cause: error });
      throw error;
    } finally { clearTimeout(timer); }
  };

  return {
    get deviceId() { return deviceId; },
    get role() { return currentRole; },
    get identitySessionId() { return identitySessionId; },
    get enterpriseAuthenticated() { return !enterpriseAccessSuppressed && Boolean(enterpriseAccessToken || effectiveAccessTokenProvider); },
    get oaSessionId() { return identitySessionId; },
    setRole(value) { currentRole = value; },
    setEnterpriseAccessToken(value) {
      enterpriseAccessToken = String(value || '').trim() || null;
      enterpriseAccessSuppressed = false;
      if (enterpriseAccessToken) {
        identitySessionId = null;
        globalThis.localStorage?.removeItem(identityStorageKey);
        globalThis.localStorage?.removeItem(legacyOAStorageKey);
      }
    },
    clearEnterpriseAccessToken() {
      enterpriseAccessToken = null;
      enterpriseAccessSuppressed = true;
      session = null;
    },
    async registerDevice({ pushToken, notificationChannel = 'in_app' } = {}) {
      session = await request('/session/device', {
        method: 'POST',
        body: JSON.stringify({ deviceId, platform, appVersion, pushToken, notificationChannel })
      });
      return session;
    },
    oaConnection: () => request('/oa/connection'),
    identityProviders: () => request('/auth/providers'),
    dingTalkConnection: () => dingTalkRequest('/auth/dingtalk/config', {}, 8000),
    dingTalkChallenge: () => dingTalkRequest('/auth/dingtalk/login/challenge', { method: 'POST', body: '{}' }, 8000),
    async loginDingTalk({ code, corpId, challengeId }) {
      const result = await dingTalkRequest('/auth/dingtalk/login', { method: 'POST', body: JSON.stringify({ code, corpId, challengeId }) });
      if (!result.sessionId || !result.user?.roleId || result.user.source !== 'dingtalk') throw new Error('钉钉登录未返回有效的平台会话。');
      identitySessionId = result.sessionId;
      currentRole = result.user.roleId;
      if (persistIdentity) globalThis.localStorage?.setItem(identityStorageKey, identitySessionId);
      return result;
    },
    accountCenter: () => request('/account-center'),
    async loginOA({ account, password }) {
      const result = await request('/auth/oa/login', { method: 'POST', body: JSON.stringify({ account, password }) });
      identitySessionId = result.sessionId;
      currentRole = result.user.roleId;
      globalThis.localStorage?.setItem(identityStorageKey, identitySessionId);
      return result;
    },
    async loginLocal({ account, password }) {
      const result = await request('/auth/local/login', { method: 'POST', body: JSON.stringify({ account, password }) });
      identitySessionId = result.sessionId;
      currentRole = result.user.roleId;
      globalThis.localStorage?.setItem(identityStorageKey, identitySessionId);
      return result;
    },
    async oaSession() {
      const result = await request('/auth/oa/session');
      currentRole = result.user.roleId;
      return result;
    },
    async identitySession() {
      const result = await request('/auth/oa/session');
      currentRole = result.user.roleId;
      return result;
    },
    async enterpriseSession() {
      const access = await request('/access/me', {}, { requireEnterpriseToken: true });
      currentRole = access.primaryRoleId || currentRole;
      return {
        user: {
          id: access.subjectId,
          account: access.account,
          name: access.account || '企业用户',
          roleId: access.primaryRoleId,
          roleName: access.primaryRoleId || '企业身份'
        },
        access
      };
    },
    async logoutOA() {
      try { await request('/auth/oa/logout', { method: 'POST' }); }
      finally {
        globalThis.localStorage?.removeItem(identityStorageKey);
        globalThis.localStorage?.removeItem(legacyOAStorageKey);
        identitySessionId = null;
        session = null;
      }
    },
    health: () => request('/health'),
    roles: () => request('/roles'),
    dashboard: () => request('/dashboard'),
    notifications: () => request('/notifications'),
    agentOperations: () => request('/agent/operations'),
    agentAuthorization: () => request('/agent/authorization'),
    agentWorkItems: () => request('/agent/work-items'),
    agentRuns: () => request('/agent/runs'),
    agentRuntimeTasks: () => request('/agent/runtime-tasks'),
    agentOrchestrations: () => request('/agent/orchestrations'),
    createAgentOrchestration: (input) => request('/agent/orchestrations', { method: 'POST', body: JSON.stringify(input) }),
    controlAgentOrchestration: (id, action) => request(`/agent/orchestrations/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { method: 'POST' }),
    controlAgentRuntimeTask: (taskId, action) => request(`/agent/runtime-tasks/${encodeURIComponent(taskId)}/${encodeURIComponent(action)}`, { method: 'POST' }),
    agentMemory: () => request('/agent/memory'),
    agentDesktopEndpoint: () => request('/agent/desktop-endpoint'),
    agentDesktopEndpointHeartbeat: (heartbeat) => request('/agent/desktop-endpoint/heartbeat', { method: 'POST', body: JSON.stringify(heartbeat) }),
    forgetAgentMemory: (memoryId) => request(`/agent/memory/${encodeURIComponent(memoryId)}`, { method: 'DELETE' }),
    agentLearningProfile: () => request('/agent/learning-profile'),
    updateAgentLearningProfile: (settings, expectedVersion = null) => request('/agent/learning-profile', { method: 'POST', body: JSON.stringify({ settings, expectedVersion }) }),
    forgetAgentWorkflowLearningSignal: (signalId) => request(`/agent/learning-signals/${encodeURIComponent(signalId)}`, { method: 'DELETE' }),
    recordAgentWorkflowLearningFeedback: (signalId, helpful) => request(`/agent/learning-signals/${encodeURIComponent(signalId)}/feedback`, { method: 'POST', body: JSON.stringify({ helpful }) }),
    agentConversations: () => request('/agent/conversations'),
    agentConversation: (conversationId) => request(`/agent/conversations/${encodeURIComponent(conversationId)}`),
    createAgentConversation: (title = '新的智脑任务') => request('/agent/conversations', { method: 'POST', body: JSON.stringify({ title }) }),
    archiveAgentConversation: (conversationId) => request(`/agent/conversations/${encodeURIComponent(conversationId)}/archive`, { method: 'POST' }),
    pinAgentConversation: (conversationId) => request(`/agent/conversations/${encodeURIComponent(conversationId)}/pin`, { method: 'POST' }),
    agentTraces: (limit = 20) => request(`/agent/traces?limit=${encodeURIComponent(limit)}`),
    agentTrace: (traceId) => request(`/agent/traces/${encodeURIComponent(traceId)}`),
    agentMessage: (input) => request('/agent/message', { method: 'POST', body: JSON.stringify({ input: typeof input === 'string' ? { text: input } : input }) }),
    agentExecute: (commandId, runId, confirmationToken, conversationId = null) => request('/agent/execute', { method: 'POST', body: JSON.stringify({ commandId, runId, confirmationToken, ...(conversationId ? { conversationId } : {}) }) }),
    agentDesktopReceipt: ({ commandId, runId, dispatchId, receipt }) => request('/agent/desktop-receipt', { method: 'POST', body: JSON.stringify({ commandId, runId, dispatchId, receipt }) }),
    agentCancel: (runId, conversationId = null) => request('/agent/cancel', { method: 'POST', body: JSON.stringify({ runId, ...(conversationId ? { conversationId } : {}) }) }),
    subscribeNotifications: (channel, target) => request('/notifications/subscriptions', { method: 'POST', body: JSON.stringify({ channel, target, deviceId }) })
  };
};

const trim = (value) => String(value || '').trim().replace(/\/$/, '');

export function resolveSemanticOperationsApiBaseUrl({ explicitBaseUrl, runtime = globalThis } = {}) {
  const configured = trim(explicitBaseUrl || runtime.__ZHINAO_RUNTIME_CONFIG__?.apiBaseUrl || runtime.semanticOperationsDesktop?.apiBaseUrl);
  if (configured) return configured;
  const origin = runtime.location?.origin;
  if (origin && origin !== 'null') {
    try { return `${trim(new URL(origin).origin)}/api`; } catch { /* use local development endpoint */ }
  }
  return 'http://127.0.0.1:3001/api';
}

const randomId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export function createSemanticOperationsClient({ baseUrl, platform = 'semantic-web', appVersion = '0.2.0', accessTokenProvider = null, identityProviderId = globalThis.__ZHINAO_RUNTIME_CONFIG__?.identityProviderId || null } = {}) {
  if (accessTokenProvider !== null && typeof accessTokenProvider !== 'function') throw new TypeError('accessTokenProvider must be a function or null.');
  if (identityProviderId !== null && (typeof identityProviderId !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(identityProviderId))) throw new TypeError('Invalid identityProviderId.');
  const apiBaseUrl = resolveSemanticOperationsApiBaseUrl({ explicitBaseUrl: baseUrl });
  const identityKey = `healthcare-ai-semantic-identity-session-${platform}${identityProviderId ? `-${identityProviderId}` : ''}`;
  const deviceKey = 'healthcare-ai-semantic-device-id';
  const deviceId = globalThis.localStorage?.getItem(deviceKey) || `${platform}-${randomId()}`;
  globalThis.localStorage?.setItem(deviceKey, deviceId);
  let identitySessionId = globalThis.localStorage?.getItem(identityKey) || null;
  let deviceSession = null;
  let roleId = null;
  const tokenProvider = accessTokenProvider || (typeof globalThis.__ZHINAO_RUNTIME_CONFIG__?.getAccessToken === 'function'
    ? () => globalThis.__ZHINAO_RUNTIME_CONFIG__.getAccessToken()
    : null);

  const request = async (path, options = {}) => {
    const accessToken = tokenProvider ? await tokenProvider() : null;
    const response = await resilientFetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(identitySessionId ? { 'x-identity-session': identitySessionId } : {}),
        ...(!identitySessionId && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(identityProviderId ? { 'x-identity-provider': identityProviderId } : {}),
        'x-client-platform': platform,
        'x-client-device-id': deviceId,
        'x-client-version': appVersion,
        ...(deviceSession?.id ? { 'x-device-session': deviceSession.id } : {}),
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || '元域智语请求失败。');
      error.status = response.status;
      error.code = payload.code || null;
      error.payload = payload;
      error.body = payload;
      error.traceId = payload.traceId || null;
      throw error;
    }
    return payload;
  };
  const post = (path, body) => request(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const localTaskPath = (modelId, taskId, action) => {
    if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)
      || typeof taskId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(taskId)) throw new TypeError('Invalid model task selector.');
    return `/semantic-operations/models/${encodeURIComponent(modelId)}/tasks/${encodeURIComponent(taskId)}/${action}`;
  };
  const localTaskBody = (body, keys) => body && typeof body === 'object' && !Array.isArray(body) && body.confirmed === true && Object.keys(body).every(key => keys.includes(key));
  const previewRecoveryPath = (modelId, requestId, body, action) => {
    if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)
      || typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(requestId)
      || !localTaskBody(body, ['confirmed', 'inputFingerprint', 'expectedCheckpointFingerprint', 'expectedDraftFingerprint'])
      || typeof body.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(body.inputFingerprint)
      || typeof body.expectedCheckpointFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(body.expectedCheckpointFingerprint)
      || typeof body.expectedDraftFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(body.expectedDraftFingerprint)) throw new TypeError('Invalid preview recovery request.');
    return `/semantic-operations/models/${encodeURIComponent(modelId)}/preview-requests/${encodeURIComponent(requestId)}/${action}`;
  };
  const modelSourcePath = (modelId, body, bind) => {
    if (typeof modelId !== 'string' || modelId === 'oa-governance' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)
      || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !(bind ? ['systemCodes', 'confirmed', 'expectedRevision', 'expectedSourceFingerprint'] : ['systemCodes']).includes(key))
      || !Array.isArray(body.systemCodes) || !body.systemCodes.length || body.systemCodes.length > 16 || new Set(body.systemCodes).size !== body.systemCodes.length
      || body.systemCodes.some(code => typeof code !== 'string' || !/^[A-Z][A-Z0-9_-]{0,39}$/u.test(code))
      || bind && (body.confirmed !== true || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || typeof body.expectedSourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(body.expectedSourceFingerprint))) throw new TypeError('Invalid model source binding request.');
    return `/semantic-operations/models/${encodeURIComponent(modelId)}/source-materials/${bind ? 'bind' : 'inspect'}`;
  };

  const applyUser = (result) => {
    roleId = result?.user?.roleId || result?.access?.primaryRoleId || roleId;
    return result;
  };

  return {
    inspectPreparedPreview: (modelId, requestId, body) => post(previewRecoveryPath(modelId, requestId, body, 'inspect-prepared'), body),
    resumePreparedPreview: (modelId, requestId, body) => post(previewRecoveryPath(modelId, requestId, body, 'resume'), body),
    recoverPreviewCommit: (modelId, requestId, body) => post(previewRecoveryPath(modelId, requestId, body, 'recover-commit'), body),
    inspectModelSources: (modelId, body) => post(modelSourcePath(modelId, body, false), body),
    bindModelSources: (modelId, body) => post(modelSourcePath(modelId, body, true), body),
    createStructuredPreview: (modelId, body) => {
      if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)
        || !localTaskBody(body, ['confirmed', 'requestId', 'text', 'systemCodes', 'attachments', 'expectedDraftFingerprint'])
        || typeof body.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(body.requestId)
        || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000
        || typeof body.expectedDraftFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(body.expectedDraftFingerprint)
        || !Array.isArray(body.systemCodes) || !body.systemCodes.length || body.systemCodes.length > 16 || new Set(body.systemCodes).size !== body.systemCodes.length
        || body.systemCodes.some(code => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{1,15}$/u.test(code))
        || body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length > 8 || body.attachments.some(item => !item || typeof item !== 'object' || Array.isArray(item)))) throw new TypeError('Invalid structured preview body.');
      return post(`/semantic-operations/models/${encodeURIComponent(modelId)}/structured-preview-tasks`, body);
    },
    recoverPreviewEvidence: (modelId, taskId, body) => {
      const path = localTaskPath(modelId, taskId, 'preview-evidence-recover');
      if (!localTaskBody(body, ['confirmed', 'expectedTaskFingerprint']) || typeof body.expectedTaskFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(body.expectedTaskFingerprint)) throw new TypeError('Invalid preview evidence recovery body.');
      return post(path, body);
    },
    getPreviewRequestStatus: (modelId, requestId) => {
      if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)
        || typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(requestId)) throw new TypeError('Invalid preview request selector.');
      return request(`/semantic-operations/models/${encodeURIComponent(modelId)}/preview-requests/${encodeURIComponent(requestId)}`);
    },
    knowledge: createKnowledgeClient(request, 'semantic-operations'),
    get apiBaseUrl() { return apiBaseUrl; },
    get deviceId() { return deviceId; },
    get identitySessionId() { return identitySessionId; },
    get roleId() { return roleId; },
    async loginOA(credentials) {
      const result = applyUser(await post('/auth/oa/login', credentials));
      identitySessionId = result.sessionId;
      globalThis.localStorage?.setItem(identityKey, identitySessionId);
      return result;
    },
    async loginLocal(credentials) {
      const result = applyUser(await post('/auth/local/login', credentials));
      identitySessionId = result.sessionId;
      globalThis.localStorage?.setItem(identityKey, identitySessionId);
      return result;
    },
    async identitySession() { return applyUser(await request('/auth/oa/session')); },
    async enterpriseSession() {
      const access = await request('/access/me');
      return applyUser({ user: { id: access.subjectId, account: access.account, name: access.account || '企业用户', roleId: access.primaryRoleId }, access });
    },
    async logout() {
      if (identitySessionId) await post('/auth/oa/logout').catch(() => null);
      identitySessionId = null; deviceSession = null; roleId = null;
      globalThis.localStorage?.removeItem(identityKey);
    },
    async registerDevice({ notificationChannel = 'in_app' } = {}) {
      deviceSession = await post('/session/device', { deviceId, platform, appVersion, notificationChannel });
      return deviceSession;
    },
    effectiveAccess: () => request('/access/me'),
    modelWorkspaces: () => request('/semantic-operations/models'),
    createLocalValidationTask: (modelId, body) => {
      if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId) || !localTaskBody(body, ['confirmed', 'kind', 'requestId', 'expectedDraftFingerprint'])
        || body.kind !== 'validate_model' || typeof body.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(body.requestId)
        || typeof body.expectedDraftFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(body.expectedDraftFingerprint)) throw new TypeError('Invalid local validation task request.');
      return post(`/semantic-operations/models/${encodeURIComponent(modelId)}/local-validation-tasks`, body);
    },
    confirmLocalValidationTask: (modelId, taskId, body) => {
      const path = localTaskPath(modelId, taskId, 'local-confirm');
      if (!localTaskBody(body, ['confirmed', 'expectedTaskFingerprint']) || typeof body.expectedTaskFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(body.expectedTaskFingerprint)) throw new TypeError('Invalid local confirmation request.');
      return post(path, body);
    },
    executeLocalValidationTask: (modelId, taskId, body) => {
      const path = localTaskPath(modelId, taskId, 'local-execute');
      if (!localTaskBody(body, ['confirmed', 'expectedTaskFingerprint', 'confirmationToken']) || typeof body.expectedTaskFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(body.expectedTaskFingerprint)
        || typeof body.confirmationToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(body.confirmationToken)) throw new TypeError('Invalid local execution request.');
      return post(path, body);
    },
    recoverLocalConfirmationEvidence: (modelId, taskId, body) => {
      const path = localTaskPath(modelId, taskId, 'confirmation-evidence-recover');
      if (!localTaskBody(body, ['confirmed'])) throw new TypeError('Invalid evidence recovery request.');
      return post(path, body);
    },
    registerModelWorkspace: (payload) => post('/semantic-operations/models', payload),
    inspectModelWorkspace: (modelId) => {
      if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(modelId)) throw new TypeError('Invalid model workspace ID.');
      return request(`/semantic-operations/models/${encodeURIComponent(modelId)}/workspace`);
    },
    modelDraft: (modelId) => {
      if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)) throw new TypeError('Invalid modelId.');
      return request(`/semantic-operations/models/${encodeURIComponent(modelId)}/draft`);
    },
    saveModelDraft: (modelId, payload) => {
      if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)) throw new TypeError('Invalid modelId.');
      return post(`/semantic-operations/models/${encodeURIComponent(modelId)}/draft`, payload);
    },
    validateModelDraft: (modelId, payload) => {
      if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)) throw new TypeError('Invalid modelId.');
      return post(`/semantic-operations/models/${encodeURIComponent(modelId)}/validate`, payload);
    },
    simulateModelDraft: (modelId, payload) => {
      if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)) throw new TypeError('Invalid modelId.');
      return post(`/semantic-operations/models/${encodeURIComponent(modelId)}/simulate`, payload);
    },
    publishModelWorkspace: (modelId, payload) => {
      if (typeof modelId !== 'string' || modelId === 'oa-governance' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)) throw new TypeError('Invalid modelId.');
      if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => !['confirmed', 'expectedFingerprint'].includes(key))
        || payload.confirmed !== true || typeof payload.expectedFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(payload.expectedFingerprint)) throw new TypeError('Explicit current fingerprint confirmation required.');
      return post(`/semantic-operations/models/${encodeURIComponent(modelId)}/publish`, payload);
    },
    modelSimulation: (modelId) => {
      if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)) throw new TypeError('Invalid modelId.');
      return request(`/semantic-operations/models/${encodeURIComponent(modelId)}/simulation`);
    },
    modelTasks: (modelId, filters = {}) => {
      if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)) throw new TypeError('Invalid modelId.');
      if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).some(key => !['offset', 'limit', 'includeArchived'].includes(key))) throw new TypeError('Invalid model task filters.');
      if (filters.offset !== undefined && (!Number.isSafeInteger(filters.offset) || filters.offset < 0 || filters.offset > 1000000)
        || filters.limit !== undefined && (!Number.isSafeInteger(filters.limit) || filters.limit < 1 || filters.limit > 100)
        || filters.includeArchived !== undefined && typeof filters.includeArchived !== 'boolean') throw new TypeError('Invalid model task pagination.');
      const query = new URLSearchParams(Object.entries(filters).map(([key, value]) => [key, String(value)]));
      return request(`/semantic-operations/models/${encodeURIComponent(modelId)}/tasks${query.size ? `?${query}` : ''}`);
    },
    modelTaskDialogue: (modelId, taskId) => {
      if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)
        || typeof taskId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(taskId)) throw new TypeError('Invalid model task selector.');
      return request(`/semantic-operations/models/${encodeURIComponent(modelId)}/tasks/${encodeURIComponent(taskId)}/dialogue`);
    },
    modelTask: (modelId, taskId) => {
      if (typeof modelId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(modelId)
        || typeof taskId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(taskId)) throw new TypeError('Invalid model task selector.');
      return request(`/semantic-operations/models/${encodeURIComponent(modelId)}/tasks/${encodeURIComponent(taskId)}`);
    },
    onboarding: () => request('/semantic-operations/onboarding'),
    createOnboardingProject: (payload) => post('/semantic-operations/onboarding', payload),
    onboardingProject: (id) => request(`/semantic-operations/onboarding/${encodeURIComponent(id)}`),
    saveOnboardingMaterial: (id, payload) => post(`/semantic-operations/onboarding/${encodeURIComponent(id)}/materials`, payload),
    testOnboardingConnection: (id, payload) => post(`/semantic-operations/onboarding/${encodeURIComponent(id)}/connection`, payload),
    onboardingPreview: (id, objectType) => request(`/semantic-operations/onboarding/${encodeURIComponent(id)}/preview${objectType ? `?${new URLSearchParams({ objectType })}` : ''}`),
    onboardingAlignment: (id) => request(`/semantic-operations/onboarding/${encodeURIComponent(id)}/alignment`),
    handoffOnboarding: (id, payload) => request(`/semantic-operations/onboarding/${encodeURIComponent(id)}/handoff`, { method: 'POST', body: JSON.stringify(payload) }),
    saveOnboardingAlignment: (id, payload) => post(`/semantic-operations/onboarding/${encodeURIComponent(id)}/alignment`, payload),
    onboardingCalculations: id => request(`/semantic-operations/onboarding/${encodeURIComponent(id)}/calculations`),
    previewOnboardingCalculation: (id, payload) => post(`/semantic-operations/onboarding/${encodeURIComponent(id)}/calculations`, payload),
    // ── 系统接入（阶段 2：从管理 Web config 页迁出的入口） ─────────────────────
    // 「元模型连接模板 / 映射草稿」仍是既有的受治理世界模型机制，本阶段只换入口与命名空间；
    // 旧端点 /api/world-model/* 保留一个版本周期，本端不再直接调用。
    systemAccess: () => request('/semantic-operations/systems'),
    systemAccessDetail: (code) => request(`/semantic-operations/systems/${encodeURIComponent(code)}`),
    registerSystemOnboarding: (payload) => post('/semantic-operations/systems', payload),
    systemAccessMappingTemplates: () => request('/semantic-operations/systems/mapping-templates'),
    systemAccessConnectionTargets: () => request('/semantic-operations/systems/connection-targets'),
    systemAccessMappingDrafts: () => request('/semantic-operations/systems/mapping-drafts'),
    probeSystemConnection: (code, payload) => post(`/semantic-operations/systems/${encodeURIComponent(code)}/probe`, payload),
    transitionSystemConnection: (code, payload) => post(`/semantic-operations/systems/${encodeURIComponent(code)}/lifecycle`, payload),
    createSystemMappingDraft: (code) => post(`/semantic-operations/systems/${encodeURIComponent(code)}/mapping-drafts`),
    validateSystemMappingDraft: (code, draftId) => post(`/semantic-operations/systems/${encodeURIComponent(code)}/mapping-drafts/${encodeURIComponent(draftId)}/validate`),
    publishSystemMappingDraft: (code, draftId) => post(`/semantic-operations/systems/${encodeURIComponent(code)}/mapping-drafts/${encodeURIComponent(draftId)}/publish`),
    supplementSystemMaterials: (code, payload) => post(`/semantic-operations/systems/${encodeURIComponent(code)}/materials`, payload),
    systemUnderstanding: (code) => request(`/semantic-operations/systems/${encodeURIComponent(code)}/understanding`),
    regenerateSystemUnderstanding: (code) => post(`/semantic-operations/systems/${encodeURIComponent(code)}/understanding`, { regenerate: true }),
    systemMonitoring: () => request('/semantic-operations/system-monitoring'),
    controlSystemMonitoring: (code, action) => post(`/semantic-operations/system-monitoring/${encodeURIComponent(code)}/${encodeURIComponent(action)}`),
    runSystemMonitoring: (payload = {}) => post('/semantic-operations/system-monitoring/run', payload),
    workflowOverview: () => request('/semantic-operations/workflows'),
    workflowDefinition: (code) => request(`/semantic-operations/workflows/${encodeURIComponent(code)}`),
    syncWorkflows: (payload = {}) => post('/semantic-operations/workflows/sync', payload),
    reviewWorkflowVersion: (code, version, action) => post(`/semantic-operations/workflows/${encodeURIComponent(code)}/versions/${encodeURIComponent(version)}/review`, { action }),
    replayWorkflowEvent: (eventId) => post(`/semantic-operations/workflows/events/${encodeURIComponent(eventId)}/replay`),
    workflowContext: (query) => request(`/agent/workflow-context?${new URLSearchParams({ query })}`),
    // ── 建模来源范围（阶段 3：范围必须是显式选择） ─────────────────────────────
    // scope=all_registered 是**显式**请求「全部已登记系统」，用于系统多选面板列清单；
    // 不是「没给范围就默认全量」——该回落行为已删除（selectionSource 会如实标注范围来源）。
    semanticSources: ({ query = '', scope = '' } = {}) => {
      const params = new URLSearchParams();
      if (query) params.set('query', query);
      if (scope) params.set('scope', scope);
      return request(`/semantic-operations/sources${params.size ? `?${params}` : ''}`);
    },
    roles: () => request('/roles'),
    authoringProfile: () => request('/meta-models/oa-governance/authoring-profile'),
    draft: () => request('/meta-models/oa-governance/draft'),
    metaModels: () => request('/meta-models'),
    simulation: () => request('/meta-models/oa-governance/simulation'),
    semanticContext: () => request('/semantic-context'),
    snapshots: () => request('/semantic-operations/snapshots'),
    saveDraft: (payload) => post('/meta-models/oa-governance/draft', payload),
    validateDraft: () => post('/meta-models/oa-governance/draft/validate'),
    simulateBuild: () => post('/meta-models/oa-governance/simulate-build'),
    replayOntologyCases: (payload) => post('/meta-models/oa-governance/case-replay', payload),
    ontologyCaseReplay: () => request('/meta-models/oa-governance/case-replay'),
    publish: () => post('/meta-models/oa-governance/publish'),
    rollbackSnapshot: (id) => post(`/semantic-operations/snapshots/${encodeURIComponent(id)}/rollback`),
    tasks: (filters = {}) => {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '' && value !== null && value !== undefined));
      return request(`/semantic-operations/tasks${query.size ? `?${query}` : ''}`);
    },
    createTask: (payload) => post('/semantic-operations/tasks', payload),
    getTask: (id) => request(`/semantic-operations/tasks/${encodeURIComponent(id)}`),
    confirmTask: (id) => post(`/semantic-operations/tasks/${encodeURIComponent(id)}/confirmation`),
    executeTask: (id, confirmationToken) => post(`/semantic-operations/tasks/${encodeURIComponent(id)}/execute`, { confirmationToken }),
    archiveTask: (id) => post(`/semantic-operations/tasks/${encodeURIComponent(id)}/archive`),
    modelReviewers: () => request('/semantic-operations/reviewers'),
    assignModelReview: (id, payload) => post(`/semantic-operations/tasks/${encodeURIComponent(id)}/review-assignment`, payload),
    reviseProposal: (id, payload) => request(`/semantic-operations/tasks/${encodeURIComponent(id)}/proposal`, { method: 'PATCH', body: JSON.stringify(payload) }),
    taskTrace: (id) => request(`/semantic-operations/tasks/${encodeURIComponent(id)}/trace`),
    inspections: () => request('/semantic-operations/inspections'),
    createInspection: (payload) => post('/semantic-operations/inspections', payload),
    controlInspection: (id, action) => post(`/semantic-operations/inspections/${encodeURIComponent(id)}/${encodeURIComponent(action)}`),
    notifications: () => request('/semantic-operations/notifications'),
    readNotification: (id) => post(`/semantic-operations/notifications/${encodeURIComponent(id)}/read`),
    recordReportExport: (taskId, receipt) => post(`/semantic-operations/tasks/${encodeURIComponent(taskId)}/report-export`, { receipt })
  };
}
import { resilientFetch, createKnowledgeClient } from '@healthcare-ai/client-runtime';

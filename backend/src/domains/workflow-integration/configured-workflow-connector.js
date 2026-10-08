import { isIP } from 'node:net';
import { normalizeWorkflowProviderPayload, WORKFLOW_RESPONSE_PROFILES } from './workflow-provider-normalizer.js';
import { configuredWorkflowWebhookProviderIds } from './workflow-webhook-service.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_DEFINITIONS = 500;
const MAX_INSTANCES = 5_000;
const MAX_PAGES = 20;
const ID_PATTERN = /^[a-z][a-z0-9_-]{1,48}$/u;
const PROCESS_TYPES = new Set(['internal_affairs', 'procurement', 'production_manufacturing', 'logistics', 'quality', 'sales', 'finance', 'unclassified']);

const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const privateHostname = hostname => hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')
  || /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(hostname)
  || (isIP(hostname) === 6 && (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd')));

const safeBaseUrl = (value, allowExternal) => {
  let url;
  try { url = new URL(value); } catch { throw failure('WORKFLOW_CONNECTOR_URL_INVALID', '流程连接器地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw failure('WORKFLOW_CONNECTOR_URL_INVALID', '流程连接器地址必须是不含凭据、查询和路径的 HTTP(S) 根地址。');
  if (url.protocol !== 'https:' && !privateHostname(url.hostname)) throw failure('WORKFLOW_CONNECTOR_TLS_REQUIRED', '非内网流程连接器必须使用 HTTPS。');
  if (!allowExternal && !privateHostname(url.hostname)) throw failure('WORKFLOW_CONNECTOR_EXTERNAL_DENIED', '外部流程连接器需要由部署配置显式允许。');
  return url;
};

const safePath = value => {
  const path = String(value || '').trim();
  if (!/^\/[a-zA-Z0-9/_-]{1,180}$/u.test(path) || path.includes('..') || path.startsWith('//')) throw failure('WORKFLOW_CONNECTOR_PATH_INVALID', '流程连接器路径无效。');
  return path;
};

export function readWorkflowConnectorConfiguration(env = process.env) {
  const raw = String(env.WORKFLOW_CONNECTORS_CONFIG_JSON || '').trim();
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw failure('WORKFLOW_CONNECTOR_CONFIG_INVALID', '流程连接器配置不是有效 JSON。'); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 10) throw failure('WORKFLOW_CONNECTOR_CONFIG_INVALID', '流程连接器配置必须包含 1 到 10 个连接器。');
  const ids = new Set();
  return parsed.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw failure('WORKFLOW_CONNECTOR_CONFIG_INVALID', '流程连接器配置项无效。');
    const allowed = new Set(['id', 'name', 'baseUrl', 'definitionsPath', 'responseProfile', 'authMode', 'credentialEnv', 'tokenPath', 'clientIdEnv', 'clientSecretEnv', 'scope']);
    if (Object.keys(item).some(key => !allowed.has(key))) throw failure('WORKFLOW_CONNECTOR_CONFIG_INVALID', '流程连接器包含未允许的配置字段。');
    const id = String(item.id || '').trim();
    const authMode = String(item.authMode || 'static_bearer').trim();
    const responseProfile = String(item.responseProfile || 'canonical_v1').trim();
    const credentialEnv = String(item.credentialEnv || '').trim();
    if (!ID_PATTERN.test(id) || ids.has(id)) throw failure('WORKFLOW_CONNECTOR_ID_INVALID', '流程连接器标识无效或重复。');
    if (!['static_bearer', 'oauth_client_credentials'].includes(authMode)) throw failure('WORKFLOW_CONNECTOR_AUTH_MODE_INVALID', '流程连接器授权方式无效。');
    if (!WORKFLOW_RESPONSE_PROFILES.includes(responseProfile)) throw failure('WORKFLOW_CONNECTOR_PROFILE_INVALID', '流程连接器响应适配档案无效。');
    if (authMode === 'static_bearer' && (!/^[A-Z][A-Z0-9_]{2,100}$/u.test(credentialEnv) || ['tokenPath', 'clientIdEnv', 'clientSecretEnv', 'scope'].some(key => Object.hasOwn(item, key)))) throw failure('WORKFLOW_CONNECTOR_CREDENTIAL_REF_INVALID', '静态 Bearer 连接器只能引用一个服务端凭据环境变量。');
    const oauth = authMode === 'oauth_client_credentials' ? {
      tokenPath: safePath(item.tokenPath),
      clientIdEnv: String(item.clientIdEnv || '').trim(),
      clientSecretEnv: String(item.clientSecretEnv || '').trim(),
      scope: String(item.scope || '').trim()
    } : null;
    if (oauth && (credentialEnv || !/^[A-Z][A-Z0-9_]{2,100}$/u.test(oauth.clientIdEnv) || !/^[A-Z][A-Z0-9_]{2,100}$/u.test(oauth.clientSecretEnv) || !/^[A-Za-z0-9:._/-]+(?: [A-Za-z0-9:._/-]+)*$/u.test(oauth.scope) || oauth.scope.length > 300)) throw failure('WORKFLOW_CONNECTOR_CREDENTIAL_REF_INVALID', 'OAuth 连接器必须引用服务端 Client ID/Secret，并声明有效 scope。');
    ids.add(id);
    return {
      id, name: String(item.name || id).trim().slice(0, 80),
      baseUrl: safeBaseUrl(item.baseUrl, env.WORKFLOW_CONNECTORS_ALLOW_EXTERNAL === 'true').toString(),
      definitionsPath: safePath(item.definitionsPath), responseProfile, authMode, credentialEnv: authMode === 'static_bearer' ? credentialEnv : null, oauth
    };
  });
}

const readBoundedResponse = async (response, limit, tooLargeMessage) => {
  const size = Number(response.headers.get('content-length') || 0);
  if (size > limit) throw failure('WORKFLOW_CONNECTOR_RESPONSE_TOO_LARGE', tooLargeMessage, 502);
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > limit) throw failure('WORKFLOW_CONNECTOR_RESPONSE_TOO_LARGE', tooLargeMessage, 502);
  return text;
};

const resolveAuthorizationHeader = async (connector, { fetchImpl, timeoutMs, env }) => {
  if (connector.authMode === 'static_bearer') {
    const token = String(env[connector.credentialEnv] || '').trim();
    if (!token) throw failure('WORKFLOW_CONNECTOR_CREDENTIAL_MISSING', `流程连接器 ${connector.id} 未配置服务端凭据。`, 503);
    return `Bearer ${token}`;
  }
  const clientId = String(env[connector.oauth.clientIdEnv] || '').trim();
  const clientSecret = String(env[connector.oauth.clientSecretEnv] || '').trim();
  if (!clientId || !clientSecret) throw failure('WORKFLOW_CONNECTOR_CREDENTIAL_MISSING', `流程连接器 ${connector.id} 未配置 OAuth 服务主体凭据。`, 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({ grant_type: 'client_credentials', scope: connector.oauth.scope }).toString();
    const response = await fetchImpl(new URL(connector.oauth.tokenPath, connector.baseUrl), {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` }, body
    });
    if (!response.ok) throw failure('WORKFLOW_CONNECTOR_TOKEN_FAILED', `流程连接器 ${connector.id} 的 OAuth 令牌刷新失败。`, 502);
    const text = await readBoundedResponse(response, MAX_TOKEN_RESPONSE_BYTES, 'OAuth 令牌响应超过大小限制。');
    let payload;
    try { payload = JSON.parse(text); } catch { throw failure('WORKFLOW_CONNECTOR_TOKEN_INVALID', 'OAuth 令牌响应不是有效 JSON。', 502); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.token_type !== 'Bearer' || typeof payload.access_token !== 'string' || payload.access_token.length < 20 || payload.access_token.length > 4096) throw failure('WORKFLOW_CONNECTOR_TOKEN_INVALID', 'OAuth 令牌响应契约无效。', 502);
    return `Bearer ${payload.access_token}`;
  } catch (error) {
    if (error?.name === 'AbortError') throw failure('WORKFLOW_CONNECTOR_TOKEN_TIMEOUT', 'OAuth 令牌刷新超时。', 504);
    throw error;
  } finally { clearTimeout(timer); }
};

const validDefinition = (value, provider) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || String(value.provider || '') !== provider
    || typeof value.sourceId !== 'string' || value.sourceId.length === 0 || value.sourceId.length > 160
    || typeof value.code !== 'string' || value.code.length === 0 || value.code.length > 160
    || typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 160
    || typeof value.version !== 'string' || value.version.length === 0 || value.version.length > 80
    || typeof value.purpose !== 'string' || value.purpose.length === 0 || value.purpose.length > 1000
    || typeof value.businessDomain !== 'string' || value.businessDomain.length === 0 || value.businessDomain.length > 160
    || !['management', 'business', 'hybrid'].includes(value.category)
    || (value.processType !== undefined && !PROCESS_TYPES.has(value.processType))
    || (value.systems !== undefined && (!Array.isArray(value.systems) || value.systems.length === 0 || value.systems.length > 20 || value.systems.some(system => typeof system !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,48}$/u.test(system))))
    || (value.crossSystemHandoffs !== undefined && (!Array.isArray(value.crossSystemHandoffs) || value.crossSystemHandoffs.length > 50))
    || !['low', 'medium', 'high', 'critical'].includes(value.riskLevel)
    || !['public', 'internal', 'confidential', 'personal_sensitive', 'business_restricted'].includes(value.dataClassification)
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || !Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > 200
    || !Array.isArray(value.edges) || value.edges.length > 500
    || !Array.isArray(value.fields) || value.fields.length > 300
    || !Array.isArray(value.bindings) || value.bindings.length > 100) return false;
  const nodeIds = new Set();
  for (const node of value.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.id !== 'string' || !node.id || node.id.length > 160 || nodeIds.has(node.id)
      || !['start', 'end', 'approval', 'condition', 'parallel', 'service_task'].includes(node.type) || typeof node.label !== 'string' || !node.label || node.label.length > 240
      || (node.actorRule !== undefined && (typeof node.actorRule !== 'string' || node.actorRule.length > 500))
      || (node.expression !== undefined && (typeof node.expression !== 'string' || node.expression.length > 500))
      || (node.systemId !== undefined && (typeof node.systemId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,48}$/u.test(node.systemId)))) return false;
    nodeIds.add(node.id);
  }
  if (value.edges.some(edge => !edge || typeof edge !== 'object' || Array.isArray(edge) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || (edge.condition !== undefined && (typeof edge.condition !== 'string' || edge.condition.length > 500)))) return false;
  if ((value.crossSystemHandoffs || []).some(handoff => !handoff || typeof handoff !== 'object' || Array.isArray(handoff)
    || typeof handoff.fromSystem !== 'string' || !(value.systems || []).includes(handoff.fromSystem)
    || typeof handoff.toSystem !== 'string' || !(value.systems || []).includes(handoff.toSystem)
    || typeof handoff.trigger !== 'string' || !handoff.trigger || handoff.trigger.length > 500
    || typeof handoff.objectType !== 'string' || !handoff.objectType || handoff.objectType.length > 160
    || typeof handoff.semanticKey !== 'string' || !handoff.semanticKey || handoff.semanticKey.length > 160)) return false;
  const fieldIds = new Set();
  for (const field of value.fields) {
    if (!field || typeof field !== 'object' || Array.isArray(field) || typeof field.id !== 'string' || !field.id || field.id.length > 160 || fieldIds.has(field.id)
      || typeof field.label !== 'string' || !field.label || field.label.length > 240 || typeof field.type !== 'string' || !field.type || field.type.length > 80
      || typeof field.required !== 'boolean' || typeof field.semanticTarget !== 'string' || !field.semanticTarget || field.semanticTarget.length > 240
      || typeof field.sensitivity !== 'string' || !field.sensitivity || field.sensitivity.length > 80) return false;
    fieldIds.add(field.id);
  }
  return value.bindings.every(binding => binding && typeof binding === 'object' && !Array.isArray(binding) && typeof binding.objectType === 'string' && binding.objectType.length > 0 && binding.objectType.length <= 160 && typeof binding.field === 'string' && binding.field.length > 0 && binding.field.length <= 160);
};

const TIMELINE_ACTIONS = new Set(['submitted', 'entered', 'approved', 'rejected', 'completed', 'cancelled', 'withdrawn', 'returned']);
const validTimeline = (timeline, definition) => {
  if (timeline === undefined) return true;
  if (!Array.isArray(timeline) || timeline.length > 100) return false;
  const nodeIds = new Set(definition.nodes.map(item => item.id));
  const eventIds = new Set();
  let previousTime = -Infinity;
  for (const event of timeline) {
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || typeof event.id !== 'string' || !event.id || event.id.length > 180 || eventIds.has(event.id)
      || typeof event.nodeId !== 'string' || !nodeIds.has(event.nodeId)
      || typeof event.label !== 'string' || !event.label || event.label.length > 240
      || !TIMELINE_ACTIONS.has(event.action)
      || (event.actorDisplay !== undefined && (typeof event.actorDisplay !== 'string' || event.actorDisplay.length > 160))
      || (event.comment !== undefined && (typeof event.comment !== 'string' || event.comment.length > 500))
      || typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt))) return false;
    const occurredAt = Date.parse(event.occurredAt);
    if (occurredAt < previousTime) return false;
    previousTime = occurredAt;
    eventIds.add(event.id);
  }
  return true;
};

const validInstance = (value, provider, definitionsByKey) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.provider !== provider
    || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 180
    || typeof value.definitionCode !== 'string' || value.definitionCode.length === 0 || value.definitionCode.length > 160
    || typeof value.definitionVersion !== 'string' || value.definitionVersion.length === 0 || value.definitionVersion.length > 80) return false;
  const definition = definitionsByKey.get(`${value.definitionCode}\u0000${value.definitionVersion}`);
  return Boolean(definition)
    && typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 240
    && typeof value.status === 'string' && ['running', 'completed', 'rejected', 'cancelled'].includes(value.status)
    && typeof value.currentNodeId === 'string' && definition.nodes.some(node => node.id === value.currentNodeId)
    && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
    && validTimeline(value.timeline, definition);
};

const fetchPayload = async (connector, { fetchImpl, timeoutMs, env }) => {
  const authorization = await resolveAuthorizationHeader(connector, { fetchImpl, timeoutMs, env });
  const definitions = [];
  const instances = [];
  const seenCursors = new Set();
  let nextCursor = '';
  let providerCursor = '';
  let instancesIncluded = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(connector.definitionsPath, connector.baseUrl);
      if (nextCursor) url.searchParams.set('cursor', nextCursor);
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', Authorization: authorization } });
      if (!response.ok) throw failure('WORKFLOW_CONNECTOR_UPSTREAM_FAILED', `流程连接器 ${connector.id} 返回 ${response.status}。`, 502);
      const text = await readBoundedResponse(response, MAX_RESPONSE_BYTES, '流程连接器响应超过大小限制。');
      let payload;
      try { payload = JSON.parse(text); } catch { throw failure('WORKFLOW_CONNECTOR_RESPONSE_INVALID', '流程连接器返回的不是有效 JSON。', 502); }
      payload = normalizeWorkflowProviderPayload(payload, connector);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.definitions)) throw failure('WORKFLOW_CONNECTOR_RESPONSE_INVALID', '流程连接器响应契约无效。', 502);
      if (payload.definitions.some(item => !validDefinition(item, connector.id))) throw failure('WORKFLOW_CONNECTOR_DEFINITION_INVALID', '流程连接器返回了不完整或跨来源的流程定义。', 502);
      definitions.push(...payload.definitions);
      if (definitions.length > MAX_DEFINITIONS) throw failure('WORKFLOW_CONNECTOR_RESPONSE_TOO_LARGE', '流程定义总数超过连接器限制。', 502);
      if (Object.hasOwn(payload, 'instances')) {
        instancesIncluded = true;
        if (!Array.isArray(payload.instances)) throw failure('WORKFLOW_CONNECTOR_INSTANCE_INVALID', '流程实例响应契约无效。', 502);
        instances.push(...payload.instances);
        if (instances.length > MAX_INSTANCES) throw failure('WORKFLOW_CONNECTOR_RESPONSE_TOO_LARGE', '流程实例总数超过连接器限制。', 502);
      }
      providerCursor = String(payload.cursor || providerCursor).slice(0, 240);
      const candidate = String(payload.nextCursor || '').trim();
      if (!candidate) { nextCursor = ''; break; }
      if (candidate.length > 240 || seenCursors.has(candidate)) throw failure('WORKFLOW_CONNECTOR_CURSOR_INVALID', '流程连接器游标无效或形成循环。', 502);
      seenCursors.add(candidate);
      nextCursor = candidate;
      if (page === MAX_PAGES - 1) throw failure('WORKFLOW_CONNECTOR_PAGE_LIMIT', '流程连接器分页超过单次同步限制。', 502);
    } catch (error) {
      if (error?.name === 'AbortError') throw failure('WORKFLOW_CONNECTOR_TIMEOUT', `流程连接器 ${connector.id} 请求超时。`, 504);
      throw error;
    } finally { clearTimeout(timer); }
  }
  const definitionsByKey = new Map(definitions.map(item => [`${item.code}\u0000${item.version}`, item]));
  if (definitionsByKey.size !== definitions.length) throw failure('WORKFLOW_CONNECTOR_DEFINITION_INVALID', '流程连接器返回了重复的流程定义版本。', 502);
  if (new Set(instances.map(item => item.id)).size !== instances.length) throw failure('WORKFLOW_CONNECTOR_INSTANCE_INVALID', '流程连接器返回了重复的流程实例。', 502);
  if (instances.some(item => !validInstance(item, connector.id, definitionsByKey))) throw failure('WORKFLOW_CONNECTOR_INSTANCE_INVALID', '流程连接器返回了跨来源、未声明版本、节点不一致或不完整的流程实例。', 502);
  return { providerCursor, definitions: structuredClone(definitions), instances: structuredClone(instances), instancesIncluded };
};

export async function discoverConfiguredWorkflowDefinitions({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  const connectors = readWorkflowConnectorConfiguration(env);
  const webhookProviderIds = configuredWorkflowWebhookProviderIds(env);
  if (!connectors.length) throw failure('WORKFLOW_CONNECTOR_NOT_CONFIGURED', '尚未配置真实 OA / 钉钉流程连接器。', 503);
  const results = [];
  for (const connector of connectors) results.push({ connector, payload: await fetchPayload(connector, { fetchImpl, timeoutMs, env }) });
  return {
    providerCursor: Object.fromEntries(results.map(item => [item.connector.id, item.payload.providerCursor])),
    definitions: results.flatMap(item => item.payload.definitions),
    instances: results.flatMap(item => item.payload.instances),
    instancesIncluded: results.some(item => item.payload.instancesIncluded),
    instanceProvidersIncluded: results.filter(item => item.payload.instancesIncluded).map(item => item.connector.id),
    providers: results.map(item => ({
      id: item.connector.id, name: item.connector.name, status: 'connected', cursor: item.payload.providerCursor,
      syncModes: webhookProviderIds.has(item.connector.id) ? ['event', 'scheduled', 'manual'] : ['scheduled', 'manual'],
      capabilities: { definitionDiscovery: true, definitionVersions: true, formSchema: true, runtimeInstances: item.payload.instancesIncluded, eventSubscription: webhookProviderIds.has(item.connector.id), incrementalCursor: true, writeActions: false }
    }))
  };
}

import { getMockScenarioSemanticFacts } from './mock-scenario-service.js';
import { semanticFingerprint } from './semantic-model-fingerprint.js';

const timeoutMs = 3500;
const defaultEndpoint = 'http://127.0.0.1:3011';

const endpoint = () => process.env.SEMANTIC_CONTEXT_ENDPOINT || defaultEndpoint;
const isEnabled = () => process.env.SEMANTICA_DEMO_BRIDGE_ENABLED === 'true' || (!process.env.NODE_ENV || process.env.NODE_ENV === 'development');

function localEndpoint() {
  try {
    const target = new URL(endpoint());
    return target.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(target.hostname);
  } catch {
    return false;
  }
}

function unavailable(reason, detail) {
  return { status: 'unavailable', engine: 'local-projection', reason, detail, checkedAt: new Date().toISOString() };
}

async function request(path, { method = 'GET', body } = {}) {
  const target = new URL(path, endpoint()).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function syncMockScenarioToSemantica(runId) {
  if (!isEnabled()) return unavailable('bridge_disabled', '当前运行环境未启用 Semantica Demo 桥接。');
  if (!localEndpoint()) return unavailable('unsafe_endpoint', '仅允许连接本机 Semantica 服务。');
  const fixture = await getMockScenarioSemanticFacts(runId);
  if (fixture.error) return unavailable('run_not_found', fixture.error);
  try {
    const result = await request('/demo/ingest', {
      method: 'POST',
      body: {
        runId,
        scenarioId: fixture.run.scenarioId,
        businessKey: fixture.businessKey,
        expectedSystems: fixture.expectedSystems,
        facts: fixture.facts
      }
    });
    return {
      status: result.status === 'verified' && result.validation?.passed ? 'verified' : 'failed',
      engine: result.engine || 'semantica',
      ingestedFacts: result.ingestedFacts || 0,
      graph: result.graph,
      run: result.run,
      validation: result.validation,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return unavailable('service_unavailable', `Semantica 未完成验证：${error.name === 'AbortError' ? '本机服务响应超时' : error.message}`);
  }
}

export async function resetSemanticaDemoGraph() {
  if (!isEnabled() || !localEndpoint()) return unavailable(isEnabled() ? 'unsafe_endpoint' : 'bridge_disabled', '未调用 Semantica 重置接口。');
  try {
    const result = await request('/demo/reset', { method: 'POST' });
    return { status: 'reset', engine: result.engine || 'semantica', graph: result.graph, checkedAt: new Date().toISOString() };
  } catch (error) {
    return unavailable('service_unavailable', `Semantica 重置未完成：${error.message}`);
  }
}

export async function getSemanticaModelDiscovery() {
  if (!isEnabled()) return unavailable('bridge_disabled', '当前运行环境未启用 Semantica Demo 桥接。');
  if (!localEndpoint()) return unavailable('unsafe_endpoint', '仅允许连接本机 Semantica 服务。');
  try {
    const result = await request('/demo/model-candidates');
    return {
      status: result.status || 'observed', engine: result.engine || 'semantica', graph: result.graph,
      observedRunCount: result.observedRunCount || 0, candidateObjects: result.candidateObjects || [],
      candidateRelationships: result.candidateRelationships || [], boundary: result.boundary,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return unavailable('service_unavailable', `无法读取 Semantica 模型候选：${error.name === 'AbortError' ? '本机服务响应超时' : error.message}`);
  }
}

export async function getSemanticaModelDeployment() {
  if (!isEnabled()) return unavailable('bridge_disabled', '当前运行环境未启用 Semantica Demo 桥接。');
  if (!localEndpoint()) return unavailable('unsafe_endpoint', '仅允许连接本机 Semantica 服务。');
  try {
    return await request('/demo/model-definition');
  } catch (error) {
    return unavailable('service_unavailable', `无法读取 Semantica 模型发布状态：${error.name === 'AbortError' ? '本机服务响应超时' : error.message}`);
  }
}

const semanticDefinition = (model, version = 'draft') => ({
  id: model.id,
  code: model.code,
  version,
  sourceFingerprint: semanticFingerprint(model),
  modelingProfile: model.modelingProfile || 'oa-approval',
  scenario: model.scenario || null,
  ...(model.worldModel ? { worldModel: model.worldModel } : {}),
  stateMachines: model.stateMachines || [],
  events: model.events || [],
  objectTypes: model.objectTypes,
  relationshipTypes: model.relationshipTypes,
  metrics: model.metrics || [],
  glossaryTerms: model.glossaryTerms || [],
  dataContracts: model.dataContracts || [],
  qualityRules: model.qualityRules || [],
  accessPolicies: model.accessPolicies || [],
  lineageEdges: model.lineageEdges || []
});

export async function validateSemanticaModelDefinition(model) {
  if (!isEnabled()) return unavailable('bridge_disabled', '当前运行环境未启用 Semantica Demo 桥接。');
  if (!localEndpoint()) return unavailable('unsafe_endpoint', '仅允许连接本机 Semantica 服务。');
  try {
    const result = await request('/demo/model-definition/validate', { method: 'POST', body: { definition: semanticDefinition(model) } });
    return { ...result, checkedAt: new Date().toISOString() };
  } catch (error) {
    return unavailable('service_unavailable', `Semantica 元模型校验未完成：${error.name === 'AbortError' ? '本机服务响应超时' : error.message}`);
  }
}

export async function publishSemanticaModelDefinition(model, version) {
  if (!isEnabled()) return { ...unavailable('bridge_disabled', '当前运行环境未启用 Semantica Demo 桥接。'), requestAttempted: false };
  if (!localEndpoint()) return { ...unavailable('unsafe_endpoint', '仅允许连接本机 Semantica 服务。'), requestAttempted: false };
  try {
    const result = await request('/demo/model-definition/publish', { method: 'POST', body: { definition: semanticDefinition(model, version) } });
    return { ...result, requestAttempted: true, checkedAt: new Date().toISOString() };
  } catch (error) {
    return { ...unavailable('service_unavailable', `Semantica 元模型发布未完成：${error.name === 'AbortError' ? '本机服务响应超时' : error.message}`), requestAttempted: true };
  }
}

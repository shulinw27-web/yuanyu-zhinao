import { connectedSystems } from '../data/seed.js';
import { getMockConnectorCatalog, getMockSystemRecords } from './mock-scenario-service.js';
import { createHash } from 'node:crypto';
import { businessIdDomains, extractQueryBusinessIds, matchingQueryBusinessIds, MAX_QUERY_BUSINESS_IDS, validateAgentReadInput } from './agent-query-service.js';
import { buildAgentQueryPlan, matchesQueryPlan, validQueryInstant } from './agent-query-plan-service.js';
import { admitSemanticRecord } from './semantic-record-contract-service.js';
import { ontologyQueryFingerprint } from './ontology-read-plan-service.js';

// Typed ontology reads use a stricter connector contract than legacy snippets.
// Fail closed on truncation, unverified coverage, redirects, or excess records.
export async function retrieveOntologyConnectorRecords(type, query, roleId, scope) {
  const systemId = type.sourceSystems[0].toLowerCase();
  const connector = configuredConnectors()[systemId];
  const endpoint = allowedEnterpriseEndpoint(connector?.endpoint);
  if (!endpoint || connector?.tokenEnv && !connectorToken(connector)) throw new Error('ONTOLOGY_CONNECTOR_NOT_CONFIGURED');
  const target = new URL(connector.path || '/agent/evidence', endpoint);
  if (target.origin !== endpoint.origin || target.username || target.password) throw new Error('ONTOLOGY_CONNECTOR_TARGET_REJECTED');
  const response = await fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(CONNECTOR_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', ...(connectorToken(connector) ? { Authorization: `Bearer ${connectorToken(connector)}` } : {}) },
    body: JSON.stringify({ systemId, query, access: { roleId, tenantId: scope.tenantId, subjectId: scope.subjectId } }) });
  if (!response.ok || !response.body) throw new Error('ONTOLOGY_CONNECTOR_UNAVAILABLE');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) throw new Error('ONTOLOGY_CONNECTOR_SIZE_LIMIT'); chunks.push(chunk); }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (payload.queryCoverage?.schemaVersion !== 'ontology-query.v1' || payload.queryCoverage?.complete !== true
    || payload.queryCoverage?.queryFingerprint !== ontologyQueryFingerprint(query)) throw new Error('ONTOLOGY_QUERY_COVERAGE_UNVERIFIED');
  return payload.records;
}

const CONNECTOR_TIMEOUT_MS = 8_000;
const MAX_CONNECTOR_RECORDS = 20;
const connectorTelemetry = new Map();
const connectorRuntimeState = new Map();
const lifecycleStates = new Set(['active', 'inactive', 'deleted', 'reversed', 'returned', 'recalled', 'cancelled', 'superseded', 'unknown']);

const roleSystems = {
  executive: ['lims', 'mes', 'erp', 'wms', 'qms', 'oms'],
  quality_manager: ['lims', 'mes', 'erp', 'wms', 'qms'],
  production_manager: ['lims', 'mes', 'erp', 'wms', 'qms'],
  procurement_manager: ['lims', 'erp', 'wms', 'qms'],
  marketing_manager: ['oms']
};

const intentSystemRules = [
  { systems: ['lims', 'qms', 'mes'], pattern: /检验|质量|放行|异常|偏差|capa|批次|原料|报警|告警|预警/i },
  { systems: ['erp', 'wms', 'mes', 'lims', 'qms'], pattern: /采购|补货|库存|仓库|仓储|入库|出库|供应商|预算|下单/i },
  { systems: ['oms'], pattern: /门店|零售|店员|巡店|store|retail/i },
  { systems: ['oms', 'qms'], pattern: /订单|履约|发运|退货|渠道|客户|投诉/i },
  { systems: ['mes', 'qms', 'lims'], pattern: /生产|设备|工艺|校准|维护/i }
];

const visibleSystemIds = (roleId) => roleSystems[roleId] || [];
const publicRecord = (record) => ({ ...record, payload: structuredClone(record.payload) });
const isPromiseLike = (value) => value && typeof value.then === 'function';
const resolveValues = (values, callback) => values.some(isPromiseLike) ? Promise.all(values).then(callback) : callback(values);
const clip = (value, length = 800) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length);
const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};
const connectorPolicy = () => ({
  maxConcurrentPerSystem: boundedInteger(process.env.CONNECTOR_MAX_CONCURRENT_PER_SYSTEM, 4, 1, 100),
  circuitFailureThreshold: boundedInteger(process.env.CONNECTOR_CIRCUIT_FAILURE_THRESHOLD, 3, 1, 20),
  circuitCooldownMs: boundedInteger(process.env.CONNECTOR_CIRCUIT_COOLDOWN_MS, 60_000, 1_000, 3_600_000),
  mockAllowed: process.env.NODE_ENV !== 'production' && process.env.CONNECTOR_MOCK_MODE !== 'disabled'
});
const connectorState = (systemId) => {
  if (!connectorRuntimeState.has(systemId)) connectorRuntimeState.set(systemId, { active: 0, consecutiveFailures: 0, openUntil: null });
  return connectorRuntimeState.get(systemId);
};
const connectorMetric = (systemId) => {
  if (!connectorTelemetry.has(systemId)) connectorTelemetry.set(systemId, { systemId, calls: 0, successes: 0, failures: 0, rejectedByCircuit: 0, rejectedByBulkhead: 0, totalLatencyMs: 0, lastStatus: 'not_called', lastCallAt: null });
  return connectorTelemetry.get(systemId);
};
const contentHash = (value) => createHash('sha256').update(String(value || '')).digest('hex');
const lifecycleState = (record) => {
  const value = clip(record.lifecycleState || record.status || 'unknown', 40).toLowerCase();
  return lifecycleStates.has(value) ? value : 'unknown';
};

const businessIdsFromInput = extractQueryBusinessIds;
const requestedSystemIds = (input) => {
  const byDomain = { production: ['lims', 'qms', 'mes', 'wms', 'erp'], marketing: ['oms', 'qms'], internal: ['erp', 'qms'] };
  const fromIdentifiers = extractQueryBusinessIds(input).flatMap((id) => /^STORE-/.test(id) ? ['oms'] : businessIdDomains(id).flatMap((domain) => byDomain[domain]));
  return [...new Set([...intentSystemRules.filter((rule) => rule.pattern.test(String(input))).flatMap((rule) => rule.systems), ...fromIdentifiers])];
};

const configuredConnectors = () => {
  try {
    const value = JSON.parse(process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

const allowedEnterpriseEndpoint = (endpoint) => {
  try {
    const url = new URL(String(endpoint || ''));
    const hostname = url.hostname.toLowerCase();
    const privateHost = hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
      || /^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || hostname.endsWith('.local');
    return ['http:', 'https:'].includes(url.protocol) && (privateHost || process.env.ENTERPRISE_CONNECTORS_ALLOW_EXTERNAL === 'true') ? url : null;
  } catch {
    return null;
  }
};

const connectorToken = (connector) => {
  const key = String(connector?.tokenEnv || '').trim();
  return /^[A-Z][A-Z0-9_]{1,120}$/.test(key) ? String(process.env[key] || '').trim() : '';
};

// This is a configuration/readiness view, not a probe that would generate
// downstream traffic while a user merely opens the workbench. A Connector is
// only reported as connected after an actual scoped retrieval succeeds.
export function getEnterpriseConnectorReadiness(roleId) {
  const configuration = configuredConnectors();
  return visibleSystemIds(roleId).map((systemId) => {
    const system = connectedSystems.find((item) => item.id === systemId);
    const connector = configuration[systemId];
    if (!connector) return {
      systemId, code: system?.code || systemId.toUpperCase(), name: system?.name || systemId,
      mode: 'local_mock', status: 'not_configured',
      message: '未配置企业 Connector；当前仅可使用本地受控模拟数据。'
    };
    if (!allowedEnterpriseEndpoint(connector.endpoint)) return {
      systemId, code: system?.code || systemId.toUpperCase(), name: system?.name || systemId,
      mode: 'enterprise_connector', status: 'rejected_endpoint',
      message: 'Connector 端点为空、格式无效或不属于允许的企业内网地址。'
    };
    if (connector.tokenEnv && !connectorToken(connector)) return {
      systemId, code: system?.code || systemId.toUpperCase(), name: system?.name || systemId,
      mode: 'enterprise_connector', status: 'missing_credential',
      message: 'Connector 已配置，但服务凭据尚未在服务端环境变量中提供。'
    };
    return {
      systemId, code: system?.code || systemId.toUpperCase(), name: system?.name || systemId,
      mode: 'enterprise_connector', status: 'ready_for_scoped_access',
      message: '企业 Connector 已配置；首次受控查询会验证可用性和返回的数据契约。'
    };
  });
}

const enterpriseEvidence = (systemId, records = []) => {
  const system = connectedSystems.find((item) => item.id === systemId);
  return records.slice(0, MAX_CONNECTOR_RECORDS).flatMap((record, index) => {
    if (!record || typeof record !== 'object') return [];
    const id = clip(record.id || record.recordId || `${systemId}-record-${index + 1}`, 220);
    const statement = clip(record.statement || record.summary || record.excerpt || '', 800);
    if (!id || !statement) return [];
    const occurredAt = record.occurredAt || record.updatedAt || null;
    const collectedAt = new Date().toISOString();
    const classification = clip(record.classification || 'internal', 80);
    const objectVersion = clip(record.version || record.objectVersion || record.etag || 'unknown', 120);
    return [{
      source: `${system?.code || systemId.toUpperCase()} 企业接入数据`,
      id,
      title: clip(record.title || record.objectType || '企业业务记录', 300),
      classification,
      statement,
      occurredAt,
      systemId,
      tenantId: record.tenantId || null,
      organizationId: record.organizationId || null,
      lifecycleState: lifecycleState(record),
      ...(Object.hasOwn(record, 'validFrom') ? { validTime: { from: record.validFrom, ...(Object.hasOwn(record, 'validTo') ? { toExclusive: record.validTo } : {}) } } : {}),
      provenance: { sourceSystem: systemId, businessKey: id, objectVersion, occurredAt, collectedAt, classification, contentHash: contentHash(statement), connectorMode: 'enterprise_connector' }
    }];
  });
};

async function retrieveEnterpriseConnectorEvidence({ systemId, roleId, identityScope, businessIds, connector, queryPlan }) {
  const endpoint = allowedEnterpriseEndpoint(connector?.endpoint);
  if (!endpoint) return { evidence: [], warning: `${systemId.toUpperCase()} Connector 端点未配置或不属于允许的企业内网地址。`, status: 'rejected_endpoint' };
  const token = connectorToken(connector);
  if (connector?.tokenEnv && !token) return { evidence: [], warning: `${systemId.toUpperCase()} Connector 服务凭据未配置。`, status: 'missing_credential' };
  const policy = connectorPolicy();
  const state = connectorState(systemId);
  const metric = connectorMetric(systemId);
  if (state.openUntil && state.openUntil > Date.now()) {
    metric.rejectedByCircuit += 1;
    metric.lastStatus = 'circuit_open';
    return { evidence: [], warning: `${systemId.toUpperCase()} Connector 熔断中，未读取模拟数据替代实时事实。`, status: 'circuit_open' };
  }
  if (state.openUntil && state.openUntil <= Date.now()) { state.openUntil = null; state.consecutiveFailures = 0; }
  if (state.active >= policy.maxConcurrentPerSystem) {
    metric.rejectedByBulkhead += 1;
    metric.lastStatus = 'bulkhead_rejected';
    return { evidence: [], warning: `${systemId.toUpperCase()} Connector 并发隔离舱已满，本次查询已受控降级。`, status: 'bulkhead_rejected' };
  }
  const startedAt = Date.now();
  state.active += 1;
  metric.calls += 1;
  metric.lastCallAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECTOR_TIMEOUT_MS);
  try {
    const target = new URL(String(connector.path || '/agent/evidence'), endpoint);
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      // Do not forward the raw user prompt. The connector receives only the
      // server-derived system, business identifiers and authenticated scope.
      body: JSON.stringify({
        systemId,
        query: { businessIds, ...(queryPlan?.timeRange ? { timeRange: queryPlan.timeRange } : {}), ...(queryPlan?.version ? { version: queryPlan.version } : {}), ...(queryPlan?.asOf ? { asOf: queryPlan.asOf } : {}) },
        access: { roleId, tenantId: identityScope?.tenantId || null, subjectId: identityScope?.subjectId || null }
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`connector status ${response.status}`);
    const payload = await response.json();
    if (queryPlan?.asOf) {
      const coverage = payload?.queryCoverage;
      const exactTargets = Array.isArray(coverage?.businessIds) && coverage.businessIds.length === businessIds.length && new Set(coverage.businessIds).size === businessIds.length && businessIds.every((id) => coverage.businessIds.includes(id));
      if (coverage?.schemaVersion !== 'connector-history.v1' || coverage.complete !== true || coverage.asOf !== queryPlan.asOf || !exactTargets || !Array.isArray(payload.records) || payload.records.length > MAX_CONNECTOR_RECORDS) {
        metric.lastStatus = 'history_unverified';
        metric.failures += 1;
        return { evidence: [], warning: `${systemId.toUpperCase()} 未提供该时点、该编号范围的完整历史覆盖声明，不能确认历史状态。`, status: 'history_unverified' };
      }
      // A rejected row could hide a conflicting version. Do not call a filtered
      // subset complete, or expose identifiers from the rejected response.
      if (payload.records.some((record) => !admitSemanticRecord(record, roleId, identityScope, true)
        || !businessIds.includes(record.id) || typeof record.statement !== 'string' || !record.statement.trim())) {
        metric.lastStatus = 'history_invalid_records';
        metric.failures += 1;
        return { evidence: [], warning: `${systemId.toUpperCase()} 的历史记录未全部通过范围和元数据核验，不能确认历史状态。`, status: 'history_invalid_records' };
      }
      const scoped = payload.records;
      if (scoped.some((record) => !validQueryInstant(record.validFrom) || !Object.hasOwn(record, 'validTo') || (record.validTo !== null && (!validQueryInstant(record.validTo) || Date.parse(record.validTo) <= Date.parse(record.validFrom))))) {
        metric.lastStatus = 'history_invalid_interval';
        metric.failures += 1;
        return { evidence: [], warning: `${systemId.toUpperCase()} 的历史有效时间区间不完整或无效。`, status: 'history_invalid_interval' };
      }
      payload.records = scoped;
    }
    state.consecutiveFailures = 0;
    metric.successes += 1;
    metric.lastStatus = 'connected';
    const normalized = enterpriseEvidence(systemId, (Array.isArray(payload?.records) ? payload.records : []).filter((record) => admitSemanticRecord(record, roleId, identityScope)));
    // The supplier may ignore query parameters. Apply the target boundary again
    // before any record becomes Agent evidence; never trust a claimed match flag.
    const evidence = businessIds.length ? normalized.filter((item) => matchingQueryBusinessIds({ id: item.id, title: item.title, statement: item.statement }, businessIds).length) : normalized;
    return { evidence: evidence.filter((item) => matchesQueryPlan(item, queryPlan)), warning: null, status: 'connected' };
  } catch {
    state.consecutiveFailures += 1;
    metric.failures += 1;
    metric.lastStatus = 'unavailable';
    if (state.consecutiveFailures >= policy.circuitFailureThreshold) state.openUntil = Date.now() + policy.circuitCooldownMs;
    return { evidence: [], warning: `${systemId.toUpperCase()} Connector 当前不可用，未将历史或模拟记录伪装为实时数据。`, status: 'unavailable' };
  } finally {
    clearTimeout(timeout);
    state.active = Math.max(0, state.active - 1);
    metric.totalLatencyMs += Date.now() - startedAt;
  }
}

export function getEnterpriseConnectorObservability() {
  const policy = connectorPolicy();
  return {
    policy: { ...policy, productionMockIsolation: true, serverDerivedScope: true, rawPromptForwarding: false },
    connectors: [...new Set([...connectorTelemetry.keys(), ...connectorRuntimeState.keys()])].sort().map((systemId) => {
      const metric = connectorMetric(systemId);
      const state = connectorState(systemId);
      return { ...metric, active: state.active, circuitState: state.openUntil && state.openUntil > Date.now() ? 'open' : 'closed', circuitOpenUntil: state.openUntil ? new Date(state.openUntil).toISOString() : null, successRate: metric.calls ? `${Math.round((metric.successes / metric.calls) * 100)}%` : 'n/a', averageLatencyMs: metric.calls ? Math.round(metric.totalLatencyMs / metric.calls) : 0 };
    })
  };
}

export function resetEnterpriseConnectorObservabilityForTest() {
  connectorTelemetry.clear();
  connectorRuntimeState.clear();
}

export function getSystemDataOverview(roleId) {
  const allowed = new Set(visibleSystemIds(roleId));
  const visibleSystems = connectedSystems.filter((system) => allowed.has(system.id));
  const values = [getMockConnectorCatalog(), ...visibleSystems.map((system) => getMockSystemRecords(system.id))];
  return resolveValues(values, ([catalog, ...recordSets]) => {
    const connectors = new Map(catalog.map((connector) => [connector.systemId, connector]));
    const systems = visibleSystems.map((system, index) => {
      const records = recordSets[index];
      const connector = connectors.get(system.id);
      return {
        systemId: system.id,
        code: system.code,
        name: system.name,
        domain: system.domain,
        recordCount: records.length,
        latestEventAt: records[0]?.occurredAt || null,
        eventTypes: [...new Set(records.map((record) => record.eventType))],
        connector: { health: connector?.health || 'unknown', faultId: connector?.faultId || 'none', faultName: connector?.faultName || '未知', statusMessage: connector?.statusMessage || '未找到 Connector 状态。' }
      };
    });
    return { mode: 'stateful_mock_connector_data', policy: '基础种子数据与运行时场景事件均仅用于本地流程演练；查询结果仍按当前角色的数据域范围裁剪。', totalRecords: systems.reduce((total, system) => total + system.recordCount, 0), systems };
  });
}

export function getSystemDataRecords(systemId, roleId, limit = 100) {
  if (!connectedSystems.some((system) => system.id === systemId)) return { error: '未找到该模拟接入系统。' };
  if (!visibleSystemIds(roleId).includes(systemId)) return { error: '当前角色无权查看该系统的模拟数据。' };
  return resolveValues([getMockSystemRecords(systemId), getMockConnectorCatalog()], ([records, catalog]) => {
  const connector = catalog.find((item) => item.systemId === systemId);
  if (connector?.health === 'unavailable') return {
    mode: 'stateful_mock_connector_data',
    systemId,
    connector,
    totalRecords: records.length,
    returnedRecords: 0,
    records: [],
    warning: `${connector.adapter} 当前模拟为不可用，业务记录未返回；请检查 Connector 审计与故障注入状态。`
  };
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, records.length));
  return {
    mode: 'stateful_mock_connector_data',
    systemId,
    connector,
    totalRecords: records.length,
    returnedRecords: safeLimit,
    records: records.slice(0, safeLimit).map(publicRecord)
  };
  });
}

export function retrieveAgentSystemEvidence(input, roleId) {
  const allowed = new Set(visibleSystemIds(roleId));
  const inputText = String(input || '');
  const matchingRule = intentSystemRules.filter((rule) => rule.pattern.test(inputText));
  const businessIds = businessIdsFromInput(inputText);
  if (businessIds.length > MAX_QUERY_BUSINESS_IDS || !validateAgentReadInput({ businessIds })) return { mode: 'query_rejected', systemIds: [], evidence: [], summary: '请核对编号长度，单次查询最多支持 10 个业务编号。' };
  const requestedIds = requestedSystemIds(inputText);
  // No explicit intent means no retrieval. The caller must ask for a domain or
  // business object instead of silently widening the query to every allowed system.
  const systemIds = requestedIds.filter((systemId) => allowed.has(systemId));
  if (!connectorPolicy().mockAllowed) return { mode: 'enterprise_connectors_only', systemIds, evidence: [], summary: '当前已禁用 Mock 数据，不能使用同步演示读取器提供业务事实。' };
  return resolveValues([getMockConnectorCatalog(), ...systemIds.map((systemId) => getMockSystemRecords(systemId))], ([catalog, ...recordSets]) => {
  const connectors = new Map(catalog.map((connector) => [connector.systemId, connector]));
  const recordsBySystem = new Map(systemIds.map((systemId, index) => [systemId, recordSets[index]]));
  const warnings = [];
  const evidence = systemIds.flatMap((systemId) => {
    const system = connectedSystems.find((item) => item.id === systemId);
    const connector = connectors.get(systemId);
    const connectorWarning = connector?.health !== 'healthy'
      ? [{ source: `${system.code} Mock Connector 健康状态`, id: `SIM-CONNECTOR-${system.code}`, title: `Connector ${connector.faultName}`, classification: '集成受限', statement: `health=${connector.health}；fault=${connector.faultId}；${connector.statusMessage}`, occurredAt: connector.changedAt || new Date().toISOString() }]
      : [];
    if (connector?.health !== 'healthy') warnings.push(`${system.code} Connector ${connector.faultName}`);
    if (connector?.health === 'unavailable') return connectorWarning;
    const records = recordsBySystem.get(systemId) || [];
    const matchingRecords = businessIds.length
      ? records.filter((record) => matchingQueryBusinessIds({ id: record.id, payload: record.payload }, businessIds).length)
      : [];
    const prioritized = (businessIds.length ? matchingRecords : records
      .filter((record) => ['review_required', 'maintenance_due', 'pending_approval', 'open', 'investigating', 'exception', 'held'].includes(record.status))
      .concat(records.filter((record) => !['review_required', 'maintenance_due', 'pending_approval', 'open', 'investigating', 'exception', 'held'].includes(record.status))))
      .filter((record, index, list) => list.findIndex((item) => item.id === record.id) === index)
      .slice(0, businessIds.length ? MAX_CONNECTOR_RECORDS : 3);
    return connectorWarning.concat(prioritized.map((record) => ({
      source: `${system.code} 模拟接入数据`,
      id: record.id,
      systemId,
      matchedBusinessIds: matchingQueryBusinessIds({ id: record.id, payload: record.payload }, businessIds),
      title: `${record.objectType} · ${record.eventType}`,
      classification: record.classification,
      statement: `recordStatus=${record.status}；${Object.entries(record.payload).slice(0, 12).map(([key, value]) => `${key}=${value}`).join('；')}`,
      occurredAt: record.occurredAt
    })));
  });
  return {
    mode: 'coherent_stateful_mock_data',
    systemIds,
    evidence,
    summary: systemIds.length
      ? `已从 ${systemIds.map((id) => connectedSystems.find((system) => system.id === id)?.code).join('、')} 读取 ${evidence.length} 条与当前意图相关的受控模拟记录${businessIds.length ? `，并按业务标识 ${businessIds.join('、')} 进行关联` : ''}${warnings.length ? `；同时检测到 ${warnings.join('、')}，相关结论需按 Connector 健康状态复核。` : ''}。`
      : matchingRule.length
        ? '当前角色未获相关系统数据域授权，未读取模拟记录。'
        : '当前请求未识别出明确的数据域或业务对象，未读取任何接入系统记录。'
  };
  });
}

// The synchronous reader remains available for existing local pages and tests.
// Agent execution uses this asynchronous variant so configured enterprise
// connectors can replace the matching mock system without widening access.
export async function retrieveAgentSystemEvidenceAsync(input, roleId, identityScope = null, queryPlan = buildAgentQueryPlan(input)) {
  if (queryPlan.status !== 'ready') return { mode: 'query_rejected', systemIds: [], evidence: [], summary: queryPlan.reason, queryPlan };
  if (queryPlan.asOf && !businessIdsFromInput(input).length) return { mode: 'query_rejected', systemIds: [], evidence: [], summary: '历史查询必须指定业务编号。', queryPlan };
  if (businessIdsFromInput(input).length > MAX_QUERY_BUSINESS_IDS || !validateAgentReadInput({ businessIds: businessIdsFromInput(input) })) return { mode: 'query_rejected', systemIds: [], evidence: [], summary: '请核对编号长度，单次查询最多支持 10 个业务编号。' };
  const mockAllowed = !queryPlan.asOf && connectorPolicy().mockAllowed && (!identityScope || identityScope.tenantId === 'demo-enterprise');
  const fallback = mockAllowed ? await retrieveAgentSystemEvidence(input, roleId) : (() => {
    const allowed = new Set(visibleSystemIds(roleId));
    const systemIds = requestedSystemIds(input).filter((systemId) => allowed.has(systemId));
    return { mode: 'enterprise_connectors_only', systemIds, evidence: [], summary: systemIds.length ? queryPlan.asOf ? '历史查询仅接受来源完整覆盖声明及有效区间；没有读取当前 Mock 数据代替历史。' : '当前模式不使用 Mock 数据；仅在企业 Connector 成功返回后提供事实。' : '当前请求未识别出明确的数据域或业务对象，未读取任何接入系统记录。' };
  })();
  const configuration = configuredConnectors();
  const configuredIds = fallback.systemIds.filter((systemId) => configuration[systemId]);
  fallback.evidence = fallback.evidence.filter((item) => matchesQueryPlan(item, queryPlan));
  if (!configuredIds.length) return { ...fallback, queryPlan, connectorObservability: getEnterpriseConnectorObservability() };
  const businessIds = businessIdsFromInput(input);
  const results = await Promise.all(configuredIds.map((systemId) => retrieveEnterpriseConnectorEvidence({ systemId, roleId, identityScope, businessIds, connector: configuration[systemId], queryPlan })));
  const replacementIds = new Set(configuredIds);
  const externalEvidence = results.flatMap((item) => item.evidence);
  const warnings = results.map((item) => item.warning).filter(Boolean);
  const retainedMockEvidence = fallback.evidence.filter((item) => ![...replacementIds].some((systemId) => {
    const code = connectedSystems.find((system) => system.id === systemId)?.code;
    return item.source?.startsWith(`${code} 模拟接入数据`) || item.source?.startsWith(`${code} Mock Connector`);
  }));
  return {
    ...fallback,
    queryPlan,
    mode: externalEvidence.length ? 'hybrid_enterprise_connector_data' : 'enterprise_connector_no_evidence',
    evidence: [...retainedMockEvidence, ...externalEvidence],
    summary: `已查询当前角色可访问的 ${fallback.systemIds.join('、')} 数据源：企业 Connector 返回 ${externalEvidence.length} 条匹配记录；其他未配置系统保留 ${retainedMockEvidence.length} 条已标识的 Mock 证据。${warnings.length ? ` ${warnings.join('；')}` : ''}`,
    connectorObservability: getEnterpriseConnectorObservability()
  };
}

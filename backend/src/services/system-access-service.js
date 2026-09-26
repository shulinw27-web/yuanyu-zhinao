// 系统接入服务：把「系统」当作一等治理对象，提供接入总览、单系统详情与连通性探测。
//
// 与注册表的职责分界（重要）：
//   * system-registry-service.js —— **事实源与状态机**：系统类型定义、角色可见性策略、
//     租户级接入生命周期（draft→registered→authorized→connected⇄suspended）。
//   * system-access-service.js（本文件）—— **面向运营视图的组装与探测**：把注册表
//     （含其中的连接器定义）、合成数据字典、接入配置样例拼成「一个系统长什么样」，
//     并提供真正会发请求的连通性探测。本文件不新增任何系统定义、不复制任何清单。
//     连接器信息一律读注册表 `definition.connector`，**不再单独派生连接器目录**
//     （否则同一份清单会在两个域里各存一份，违背阶段 0 的单一事实源收敛）。
//
// 多租户约定：
//   * 探测结果按租户隔离存储（semanticTenantStateKey），与注册表的生命周期状态同租户。
//   * 租户标识只取受信上下文，本文件不接受调用方传入的 tenantId。
//
// 边界（不得在界面或文档中弱化）：
//   * 连通性探测读取的是**内置的合成模拟 HTTP 数据源**，不是任何真实企业连接器。
//   * 「接入配置样例（责任人 / 同步频率 / 字段→对象映射）」当前仍来自 demo 种子，
//     属已知不洁项：尚未做到租户隔离。返回值以 source='demo_seed' 显式标注，
//     不伪装成租户自有配置。
import { systemConfigurations } from '../data/seed.js';
import { mockOnboardingScenarios } from '../data/mock-onboarding-catalog.js';
import { SYSTEM_CONNECTION_STATES, SYSTEM_CONNECTION_TRANSITIONS } from '../data/system-catalog.js';
import {
  getSystemByCode, getConnectorSurfaceSystemCodes, getTenantSystemConnections, getTenantSystemConnection, getDemoConnectedSystems,
  transitionSystemConnection
} from './system-registry-service.js';
import {
  readMockOnboardingSource, readMockScenarioDictionary, readMockScenarioSystems, mockOnboardingSourceFaults
} from './mock-onboarding-source-service.js';
import { readState, mutateState } from '../repositories/runtime-state-repository.js';
import { semanticTenantStateKey, currentSemanticTenant } from './semantic-tenant-context.js';

const NAMESPACE = 'system_access_runtime';
const PROBES_KEY = 'probes';
const MAX_PROBE_HISTORY = 24;

export const SYSTEM_ACCESS_BOUNDARY = '系统接入视图：接入状态与生命周期按租户隔离；连通性探测读取内置合成模拟数据源，不连接任何真实企业系统；接入配置样例与字段映射来自受控种子快照，仍需人工复核后才可用于生产。';

const LIFECYCLE_LABELS = Object.freeze({
  draft: '未登记', registered: '已登记', authorized: '已授权', connected: '已连通', suspended: '已停用'
});

const sourceIssueMessages = Object.freeze({
  MOCK_SOURCE_RATE_LIMITED: '模拟数据源返回限流（429），本次探测未取得完整结果。',
  MOCK_SOURCE_TIMEOUT: '模拟数据源读取超时，未接受不完整结果。',
  MOCK_SOURCE_MALFORMED: '模拟数据源响应不是有效 JSON。',
  MOCK_SOURCE_TENANT_MISMATCH: '模拟数据源返回了不属于当前租户的记录，已拒绝整批数据。',
  MOCK_SOURCE_INCOMPLETE: '模拟数据源分页或完整性声明不一致，已拒绝不完整数据。',
  MOCK_SOURCE_CONTRACT_INVALID: '模拟数据源不符合受支持的只读协议（mock-onboarding-query.v1）。',
  MOCK_SOURCE_TRANSPORT_FAILED: '模拟数据源传输失败，请重试。',
  MOCK_SOURCE_SANDBOX_ONLY: '模拟数据源仅在非生产环境开放。',
  MOCK_SOURCE_BUSY: '模拟数据源并发已达上限，请稍后重试。',
  MOCK_SOURCE_SCHEMA_DRIFT: '模拟数据源记录出现字典未声明的字段，字段目录已漂移。'
});

const demoConfigBySystemId = new Map(systemConfigurations.map((item) => [item.systemId, item]));
const demoConnectionById = new Map(getDemoConnectedSystems().map((item) => [item.id, item]));

// ── 本地合成数据集索引（按系统码 → 场景） ────────────────────────────────────
//
// 判据是「数据源里实际有没有该系统的记录」，而不是 mock-onboarding-catalog 里声明的
// scenario.systems —— 后者是材料准备阶段的声明范围，实测并不等于数据齐备范围
// （例如 LIMS 未出现在任何 scenario.systems 中，但 quality_incident 数据集里确有
// Inspection 记录）。用声明范围判定会把有数据的系统误报为「不可探测」。
//
// ESM 动态导入本身有缓存，这里仍做一次性记忆，避免每次渲染总览都重扫两个场景。
let datasetIndexPromise = null;

function resolveDatasetIndex() {
  datasetIndexPromise ??= (async () => {
    const recordScenario = new Map();
    const dictionaryScenarios = new Map();
    for (const scenario of mockOnboardingScenarios) {
      const { recordSystems, dictionarySystems } = await readMockScenarioSystems(scenario.id);
      for (const code of recordSystems) if (!recordScenario.has(code)) recordScenario.set(code, scenario.id);
      for (const code of dictionarySystems) {
        const list = dictionaryScenarios.get(code) || [];
        if (!list.includes(scenario.id)) list.push(scenario.id);
        dictionaryScenarios.set(code, list);
      }
    }
    return { recordScenario, dictionaryScenarios };
  })();
  return datasetIndexPromise;
}

/** 测试用：重置数据集索引，避免跨用例共享记忆化结果。 */
export function resetSystemAccessDatasetIndexForTest() {
  datasetIndexPromise = null;
}

const initialProbes = () => ({});

function readProbes() {
  return readState(NAMESPACE, semanticTenantStateKey(PROBES_KEY), initialProbes);
}

/** 当前租户最近一次连通性探测结果（按系统码索引）。 */
export function getSystemProbeResults() {
  return { tenantId: currentSemanticTenant(), probes: readProbes() };
}

function fieldsByObjectType(tables) {
  return new Map(tables.map((table) => [table.name, new Set(table.fields.map((field) => field.name))]));
}

/**
 * 用场景字典校验记录：字典未声明的字段属于结构漂移，必须显式上报而不是静默接受。
 * 只比对「多出的字段」；缺可选字段不视为漂移（必填缺失由材料校验链路负责）。
 */
function detectSchemaDrift(records, declared) {
  const drifted = [];
  for (const row of records) {
    const allowed = declared.get(row.objectType);
    if (!allowed) { drifted.push(`${row.objectType}（字典未声明的对象）`); continue; }
    const extra = Object.keys(row.payload || {}).filter((key) => !allowed.has(key));
    if (extra.length) drifted.push(`${row.objectType}.${extra.join('/')}`);
  }
  return [...new Set(drifted)];
}

function assembleSystemView(entry, { roleId, authorizedCodes, probes, datasets }) {
  const definition = getSystemByCode(entry.code);
  const configuration = demoConfigBySystemId.get(entry.id) || null;
  const demo = demoConnectionById.get(entry.id) || null;
  const authorized = authorizedCodes.includes(entry.code);
  const scenarioId = datasets.recordScenario.get(entry.code) || null;
  const probe = probes[entry.code] || null;

  const blockedReason = !definition.connector
    ? '该系统尚未登记受控连接器，仍可被识别为来源系统，但不能据此读取数据或建立来源映射。'
    : !authorized
      ? '当前运营身份未获该系统所属数据域授权，接入状态可读，但不可探测、不可建立映射。'
      : null;

  return {
    code: entry.code,
    id: entry.id,
    name: entry.name,
    domain: entry.domain,
    lifecycleState: entry.lifecycleState,
    lifecycleLabel: LIFECYCLE_LABELS[entry.lifecycleState] || entry.lifecycleState,
    catalogOnboardingStatus: entry.catalogOnboardingStatus,
    connectorRegistered: entry.connectorRegistered,
    connector: definition.connector ? { ...definition.connector } : null,
    authorized,
    authorizedByRole: roleId || null,
    health: demo ? { status: demo.status, health: demo.health, lastSync: demo.lastSync, mode: demo.mode, color: demo.color || null, alert: demo.alert || null } : null,
    objects: definition.connector ? [...definition.connector.objects] : [],
    worldObjectTypes: [...definition.worldObjectTypes],
    mappingCount: configuration?.mapping?.length || 0,
    owner: configuration?.owner || null,
    syncInterval: configuration?.syncInterval || null,
    enabled: configuration?.enabled ?? null,
    configurationSource: configuration ? 'demo_seed' : null,
    probe: { supported: Boolean(scenarioId && definition.connector && authorized), scenarioId, last: probe },
    blockedReason
  };
}

/**
 * 系统接入总览：每系统一行，覆盖 状态 / 授权 / 健康 / 最后同步 / 对象目录 / 映射数 / 责任人。
 * 系统类型与目录来自注册表（平台级）；生命周期状态与探测结果来自租户工作区。
 */
export async function getSystemAccessOverview({ roleId } = {}) {
  const connections = getTenantSystemConnections();
  const authorizedCodes = getConnectorSurfaceSystemCodes(roleId);
  const probes = readProbes();
  const datasets = await resolveDatasetIndex();
  const systems = connections.map((entry) => assembleSystemView(entry, { roleId, authorizedCodes, probes, datasets }));

  return {
    boundary: SYSTEM_ACCESS_BOUNDARY,
    tenantId: currentSemanticTenant(),
    roleId: roleId || null,
    policy: '接入生命周期按租户隔离；角色授权按数据域裁剪；连通性探测只读内置合成数据源。',
    summary: {
      total: systems.length,
      connected: systems.filter((item) => item.lifecycleState === 'connected').length,
      suspended: systems.filter((item) => item.lifecycleState === 'suspended').length,
      pending: systems.filter((item) => item.lifecycleState === 'registered' || item.lifecycleState === 'authorized').length,
      notRegistered: systems.filter((item) => item.lifecycleState === 'draft').length,
      authorized: systems.filter((item) => item.authorized).length,
      probeable: systems.filter((item) => item.probe.supported).length,
      mappedObjects: systems.reduce((total, item) => total + item.mappingCount, 0)
    },
    systems
  };
}

/** 单系统详情：连接配置、字段目录、字段→元模型对象映射、最近一次探测结果。 */
export async function getSystemAccessDetail({ code, roleId } = {}) {
  const definition = getSystemByCode(code);
  if (!definition) return { error: `未登记的系统码：${code}`, code: 'SYSTEM_NOT_REGISTERED', status: 404 };
  const overview = await getSystemAccessOverview({ roleId });
  const view = overview.systems.find((item) => item.code === definition.code);
  if (!view) return { error: `系统 ${definition.code} 不在当前租户的接入清单中。`, code: 'SYSTEM_ACCESS_MISSING', status: 404 };

  const datasets = await resolveDatasetIndex();
  const scenarioIds = [...(datasets.dictionaryScenarios.get(definition.code) || [])];
  // 字段目录按**对象类型**归并：同一个对象可能同时被多个合成场景声明（实测 WMS 的
  // StockPosition/Warehouse、OMS 的 SalesOrder 都在两个场景里出现）。早期实现直接
  // 逐场景 push，导致「对象目录」计数被重复项撑大（WMS 10→实际 8、OMS 8→实际 7），
  // 且前端以 name 作 :key 会出现重复键。此处改为按 name 归并；若两个场景对同一对象
  // 的字段声明**不一致**，不静默取其一，而是登记进 `conflicts` 由界面显式呈现。
  const normalizeFields = (table) => table.fields.map((field) => ({
    name: field.name, type: field.type, required: Boolean(field.required),
    primaryKey: Boolean(field.primaryKey), reference: field.reference || null
  }));
  const fieldSignature = (fields) => JSON.stringify(fields.map((field) => [field.name, field.type, field.required, field.primaryKey, field.reference]));
  const byObject = new Map();
  const catalogConflicts = [];
  for (const scenarioId of scenarioIds) {
    const dictionary = await readMockScenarioDictionary(scenarioId);
    for (const table of dictionary.tables) {
      if (table.system !== definition.code) continue;
      const fields = normalizeFields(table);
      const existing = byObject.get(table.name);
      if (!existing) {
        byObject.set(table.name, {
          name: table.name, label: table.label, granularity: table.granularity,
          primaryKey: table.primaryKey, scenarioIds: [scenarioId], fields
        });
        continue;
      }
      const declaredIn = [...existing.scenarioIds];
      if (!existing.scenarioIds.includes(scenarioId)) existing.scenarioIds.push(scenarioId);
      if (fieldSignature(existing.fields) !== fieldSignature(fields)) {
        catalogConflicts.push({
          objectType: table.name,
          scenarioIds: [...new Set([...declaredIn, scenarioId])],
          detail: `合成场景 ${[...new Set([...declaredIn, scenarioId])].join(' / ')} 对对象 ${table.name} 的字段声明不一致，未做自动合并。`
        });
      }
    }
  }
  const tables = [...byObject.values()];
  const configuration = demoConfigBySystemId.get(definition.id) || null;
  const connection = getTenantSystemConnection(definition.code);

  return {
    boundary: SYSTEM_ACCESS_BOUNDARY,
    tenantId: currentSemanticTenant(),
    system: view,
    lifecycle: {
      state: connection?.lifecycleState || view.lifecycleState,
      label: LIFECYCLE_LABELS[connection?.lifecycleState] || view.lifecycleLabel,
      reason: connection?.reason || null,
      updatedAt: connection?.updatedAt || null,
      updatedBy: connection?.updatedBy || null,
      transitions: [...(SYSTEM_CONNECTION_TRANSITIONS[connection?.lifecycleState] || [])]
    },
    connectionConfiguration: {
      source: configuration ? 'demo_seed' : null,
      owner: configuration?.owner || null,
      syncInterval: configuration?.syncInterval || null,
      enabled: configuration?.enabled ?? null,
      credentialRef: definition.connector?.credentialRef || null,
      transport: definition.connector?.transport || null,
      classification: definition.connector?.classification || null,
      writeMode: definition.connector?.writeMode || null,
      tools: definition.connector ? [...definition.connector.tools] : []
    },
    fieldCatalog: {
      available: tables.length > 0,
      scenarioIds,
      readScenarioId: datasets.recordScenario.get(definition.code) || null,
      objectTypes: tables.map((table) => table.name),
      tables: tables.map((table) => ({
        name: table.name, label: table.label, granularity: table.granularity, primaryKey: table.primaryKey,
        scenarioIds: [...table.scenarioIds], scenarioId: table.scenarioIds[0],
        fields: table.fields
      })),
      conflicts: catalogConflicts,
      unavailableReason: tables.length ? null : '该系统尚无本地合成数据字典，字段目录为空；不以前端占位数据替代。'
    },
    mappings: configuration?.mapping ? configuration.mapping.map((item) => ({ ...item })) : [],
    lastProbe: view.probe.last,
    faults: [...mockOnboardingSourceFaults]
  };
}

function lifecycleView(code) {
  const connection = getTenantSystemConnection(code);
  return {
    state: connection?.lifecycleState || null,
    label: LIFECYCLE_LABELS[connection?.lifecycleState] || connection?.lifecycleState || null,
    reason: connection?.reason || null,
    updatedAt: connection?.updatedAt || null,
    updatedBy: connection?.updatedBy || null,
    transitions: [...(SYSTEM_CONNECTION_TRANSITIONS[connection?.lifecycleState] || [])]
  };
}

/**
 * 接入生命周期操作面（2026-09-26 新增）：把注册表的状态机暴露为可执行的运营动作。
 *
 * 设计约束：
 *   * 状态机本身仍由 system-registry-service 定义（单一事实源），本函数只做
 *     「视图侧的门禁 + 审计字段组装」；不新增任何状态、不改任何跃迁规则。
 *   * 「接通（→connected）」必须有前置：该租户对同一系统的最近一次连通性探测
 *     结果为 verified。没有验证过的接通等于跳过验收门禁——这正是接入流程
 *     此前「不可执行、状态只能看种子值」的根因补齐。
 *   * 操作主体只取受信上下文（identityScope），与探测结果同租户记录。
 */
export function transitionTenantSystemConnection({ code, to, reason, identityScope } = {}) {
  const definition = getSystemByCode(code);
  if (!definition) return { error: `未登记的系统码：${code}`, code: 'SYSTEM_NOT_REGISTERED', status: 404 };
  if (typeof to !== 'string' || !SYSTEM_CONNECTION_STATES.includes(to)) {
    return { error: `未知的接入状态：${to}`, code: 'SYSTEM_STATE_UNKNOWN', status: 400 };
  }
  const trimmedReason = String(reason || '').trim();
  if (!trimmedReason) {
    return { error: '接入状态推进必须填写操作理由（不超过 200 字），供审计追溯。', code: 'SYSTEM_TRANSITION_REASON_REQUIRED', status: 400 };
  }
  if (to === 'connected') {
    const last = readProbes()[definition.code];
    if (last?.status !== 'verified') {
      return {
        error: `系统 ${definition.code} 在当前租户尚无一次通过验证的连通性探测，拒绝接通。请先执行连通性测试并取得 verified 结果。`,
        code: 'SYSTEM_CONNECT_PROBE_REQUIRED',
        status: 409
      };
    }
  }
  const actor = String(identityScope?.subjectId || identityScope?.tenantId || '').trim();
  if (!actor) return { error: '缺少操作主体，拒绝推进接入状态。', code: 'SYSTEM_ACTOR_REQUIRED', status: 400 };
  const outcome = transitionSystemConnection({ code: definition.code, to, actor, reason: trimmedReason });
  if (outcome.error) {
    const status = outcome.code === 'SYSTEM_TRANSITION_REJECTED' ? 409 : 400;
    return { ...outcome, status };
  }
  return { code: definition.code, from: outcome.from, to, lifecycle: lifecycleView(definition.code) };
}

/**
 * 连通性探测：对内置合成模拟 HTTP 数据源做一次真实的分页读取，并按场景字典校验结构。
 * 这是「真正接上」的行为——它会监听本地端口、发 HTTP 请求、校验响应契约与分页完整性；
 * 但它**不是**企业连接器验收，返回值与界面都必须标注为合成模拟。
 */
export async function probeSystemConnection({ code, faultMode = 'none', roleId, identityScope } = {}) {
  const definition = getSystemByCode(code);
  if (!definition) return { error: `未登记的系统码：${code}`, code: 'SYSTEM_NOT_REGISTERED', status: 404 };
  if (!definition.connector) return { error: `系统 ${definition.code} 尚未登记受控连接器，不能进行连通性探测。`, code: 'SYSTEM_CONNECTOR_NOT_REGISTERED', status: 409 };
  if (!mockOnboardingSourceFaults.includes(faultMode)) return { error: `不支持的响应模式：${faultMode}`, code: 'SYSTEM_PROBE_FAULT_UNKNOWN', status: 400 };
  if (!getConnectorSurfaceSystemCodes(roleId).includes(definition.code)) {
    return { error: `当前运营身份未获 ${definition.code} 所属数据域授权，拒绝探测。`, code: 'SYSTEM_PROBE_FORBIDDEN', status: 403 };
  }
  const scenario = (await resolveDatasetIndex()).recordScenario.get(definition.code) || null;
  if (!scenario) {
    return {
      code: definition.code, status: 'no_local_dataset', supported: false, faultMode,
      message: `${definition.code} 尚无本地合成数据源，无法进行连通性探测；这不代表系统不可用，只代表本次演示环境没有可读的合成数据集。`,
      checkedAt: new Date().toISOString()
    };
  }
  const tenantId = identityScope?.tenantId || currentSemanticTenant();
  let outcome;
  try {
    const read = await readMockOnboardingSource({ scenarioId: scenario, tenantId, projectId: `mock-onboarding-probe-${definition.id}`, faultMode });
    const records = read.records.filter((row) => row.system === definition.code);
    const declared = fieldsByObjectType((await readMockScenarioDictionary(scenario)).tables);
    const drift = detectSchemaDrift(records, declared);
    outcome = {
      code: definition.code, status: drift.length ? 'schema_drift' : 'verified', supported: true, faultMode,
      checkedAt: new Date().toISOString(), scenarioId: scenario,
      sourceKind: read.sourceKind, protocol: read.protocol,
      requests: read.requests, pageCount: read.pageCount,
      recordCount: records.length, readableRecords: read.records.length,
      objectTypes: [...new Set(records.map((row) => row.objectType))].sort(),
      issue: drift.length
        ? { code: 'MOCK_SOURCE_SCHEMA_DRIFT', message: sourceIssueMessages.MOCK_SOURCE_SCHEMA_DRIFT, detail: drift.slice(0, 8) }
        : null
    };
  } catch (error) {
    const safeCode = typeof error.code === 'string' && Object.hasOwn(sourceIssueMessages, error.code) ? error.code : 'MOCK_SOURCE_TRANSPORT_FAILED';
    outcome = {
      code: definition.code, status: 'failed', supported: true, faultMode,
      checkedAt: new Date().toISOString(), scenarioId: scenario,
      requests: error.requests || 0, pageCount: error.pageCount || 0,
      recordCount: 0, readableRecords: 0, objectTypes: [],
      issue: { code: safeCode, message: sourceIssueMessages[safeCode], detail: [] }
    };
  }
  mutateState(NAMESPACE, semanticTenantStateKey(PROBES_KEY), initialProbes, (probes) => {
    const history = (probes[definition.code]?.history || []).slice(0, MAX_PROBE_HISTORY - 1);
    probes[definition.code] = { ...outcome, tenantId, history: [outcome, ...history] };
    return { value: probes, result: { code: definition.code } };
  });
  return outcome;
}

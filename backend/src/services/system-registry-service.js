// 系统注册表服务：系统接入的**唯一入口**。
//
// 职责边界：
//   * 系统「类型」查询 → 读 data/system-catalog.js（平台级，全租户共享）
//   * 角色可见性策略   → 读 catalog 的 ROLE_DATA_DOMAINS / ROLE_RECORD_SYSTEMS
//   * 租户「接入实例」 → 本文件按租户隔离读写（多租户）
//
// 多租户的关键分界：**系统类型是平台资产，接入实例是租户资产。**
// 租户 A 接入了 ERP，不代表租户 B 也接入了；两者共用同一个 ERP 类型定义，
// 但各自持有独立的生命周期状态、凭据引用与授权范围。因此：
//   * 类型与角色策略：无租户上下文也可读（保证既有离线夹具与测试不变）
//   * 接入实例读写：必须经 semanticTenantStateKey 落到当前租户的工作区，
//     绝不接受请求体里传来的 tenantId（沿用 semantic-tenant-context 的既有约定）
import {
  systemDefinitions,
  ROLE_DATA_DOMAINS, ROLE_RECORD_SYSTEMS,
  SYSTEM_CONNECTION_STATES, SYSTEM_CONNECTION_TRANSITIONS, ONBOARDING_STATE_SEED,
  getDemoConnectedSystems, getConnectionTargets
} from '../data/system-catalog.js';
import { readState, mutateState } from '../repositories/runtime-state-repository.js';
import { semanticTenantStateKey, currentSemanticTenant } from './semantic-tenant-context.js';

const REGISTRY_NAMESPACE = 'system_registry_runtime';
const CONNECTIONS_KEY = 'connections';

const byId = new Map(systemDefinitions.map((item) => [item.id, item]));
const byCode = new Map(systemDefinitions.map((item) => [item.code, item]));

const frozen = (item) => Object.freeze({
  ...item,
  aliases: Object.freeze([...item.aliases]),
  connector: item.connector ? Object.freeze({ ...item.connector, dataDomains: Object.freeze([...item.connector.dataDomains]), objects: Object.freeze([...item.connector.objects]), tools: Object.freeze([...item.connector.tools]) }) : null,
  worldObjectTypes: Object.freeze([...item.worldObjectTypes]),
  demoConnection: item.demoConnection ? Object.freeze({ ...item.demoConnection }) : null
});

// ── 系统类型查询（平台级） ──────────────────────────────────────────────────

export const getSystemDefinitions = () => systemDefinitions.map(frozen);
export const getSystemByCode = (code) => { const item = byCode.get(String(code || '').toUpperCase()); return item ? frozen(item) : null; };
export const getSystemById = (id) => { const item = byId.get(String(id || '').toLowerCase()); return item ? frozen(item) : null; };

/** 已登记受控连接器的系统码（对应原 mcp-connector-service 的目录成员）。 */
export const getRegistrableSystemCodes = () => systemDefinitions.filter((item) => item.connector).map((item) => item.code);

/** 系统码 → 别名表。保留 systemDefinitions 的声明顺序（与原 systemAliases 对象键序一致）。 */
export const getSystemAliases = () => Object.fromEntries(systemDefinitions.map((item) => [item.code, [...item.aliases]]));

// ── 角色可见性策略 ──────────────────────────────────────────────────────────

export const getRoleDataDomains = (roleId) => [...(ROLE_DATA_DOMAINS[roleId] || [])];

/** 受控连接器目录中对该角色可见的系统码。 */
export function getConnectorSurfaceSystemCodes(roleId) {
  const allowed = ROLE_DATA_DOMAINS[roleId] || [];
  return systemDefinitions
    .filter((item) => item.connector && item.connector.dataDomains.some((domain) => allowed.includes(domain)))
    .map((item) => item.code);
}

/** 本地受控模拟记录对该角色可见的系统 id。 */
export const getRecordSurfaceSystemIds = (roleId) => [...(ROLE_RECORD_SYSTEMS[roleId] || [])];

// ── 兼容视图：demo 接入样例与连接目标（派生自目录，见 data/system-catalog.js） ──

export { getDemoConnectedSystems, getConnectionTargets };

// ── 文本中的系统识别 ────────────────────────────────────────────────────────

const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
const codePattern = (code) => new RegExp(`(?:^|[^a-z0-9])${code.toLowerCase()}(?:$|[^a-z0-9])`, 'i');

/**
 * 从自由文本中识别系统码。语义与原 detectRequestedSemanticSystems 完全一致：
 * 先按系统码精确词边界匹配，命中即返回；未命中再按别名子串匹配。
 * 注意：本函数只做「文本里提到了什么」的推断，**不得**被用作数据授权扩大的依据。
 */
export function detectSystemCodesInText(request) {
  const text = normalize(request);
  const explicit = systemDefinitions.filter((item) => codePattern(item.code).test(text)).map((item) => item.code);
  if (explicit.length) return explicit;
  return systemDefinitions
    .filter((item) => item.aliases.some((alias) => text.includes(alias)))
    .map((item) => item.code);
}

/**
 * **归属判定**专用的系统识别：只认系统码与系统名称，**不用业务词别名**。
 *
 * 为什么不复用 `detectSystemCodesInText`：它的别名表里有「采购」「供应商」「库存」「审批」「流程」
 * 这类通用业务词——用于「这段文本提到了什么系统」（只做提示素材）尚可容忍，
 * 用于「这张表属于哪个系统」（会写进 `sourceSystems`、参与范围裁剪）则会把
 * 「采购订单表」这类普通表述直接判成 ERP 归属。归属必须来自材料里**指名道姓**的那一句。
 */
export function detectDeclaredSystemCodes(request) {
  const text = normalize(request);
  const explicit = systemDefinitions.filter((item) => codePattern(item.code).test(text)).map((item) => item.code);
  if (explicit.length) return explicit;
  return systemDefinitions.filter((item) => text.includes(normalize(item.name))).map((item) => item.code);
}

// ── 租户接入实例（多租户隔离） ──────────────────────────────────────────────

const seedConnections = () => Object.fromEntries(systemDefinitions.map((item) => [item.code, {
  code: item.code,
  state: ONBOARDING_STATE_SEED[item.onboardingStatus],
  reason: '平台系统目录默认状态',
  updatedAt: null,
  updatedBy: 'system-registry'
}]));

const readConnections = () => readState(REGISTRY_NAMESPACE, semanticTenantStateKey(CONNECTIONS_KEY), seedConnections);

/** 当前租户对所有系统的接入生命周期状态。 */
export function getTenantSystemConnections({ includeUnregistered = true } = {}) {
  const tenantId = currentSemanticTenant();
  const state = readConnections();
  return systemDefinitions
    .filter((item) => includeUnregistered || item.onboardingStatus !== 'not_registered')
    .map((item) => {
      const row = state[item.code];
      return {
        code: item.code, id: item.id, name: item.name, domain: item.domain,
        tenantId,
        lifecycleState: row?.state || ONBOARDING_STATE_SEED[item.onboardingStatus],
        catalogOnboardingStatus: item.onboardingStatus,
        connectorRegistered: Boolean(item.connector),
        reason: row?.reason || null,
        updatedAt: row?.updatedAt || null,
        updatedBy: row?.updatedBy || null
      };
    });
}

export const getTenantSystemConnection = (code) => getTenantSystemConnections().find((item) => item.code === String(code || '').toUpperCase()) || null;

export const canTransitionSystemConnection = (from, to) => Boolean(SYSTEM_CONNECTION_TRANSITIONS[from]?.includes(to));

/**
 * 推进当前租户对某系统的接入状态。非法跃迁、未知系统、非对象输入一律拒绝，
 * 不做任何隐式修正（宁可显式失败，也不静默跳过门禁）。
 */
export function transitionSystemConnection({ code, to, actor, reason } = {}) {
  const item = byCode.get(String(code || '').toUpperCase());
  if (!item) return { error: `未登记的系统码：${code}`, code: 'SYSTEM_NOT_REGISTERED' };
  if (!SYSTEM_CONNECTION_STATES.includes(to)) return { error: `未知的接入状态：${to}`, code: 'SYSTEM_STATE_UNKNOWN' };
  const operator = String(actor?.id || actor || '').trim();
  if (!operator) return { error: '缺少操作主体，拒绝推进接入状态。', code: 'SYSTEM_ACTOR_REQUIRED' };
  let outcome = null;
  mutateState(REGISTRY_NAMESPACE, semanticTenantStateKey(CONNECTIONS_KEY), seedConnections, (state) => {
    const current = state[item.code];
    if (!canTransitionSystemConnection(current.state, to)) {
      // commit: false —— 被拒绝的跃迁不得写入任何行，也不得推进版本号。
      outcome = { error: `不允许的接入状态跃迁：${current.state} → ${to}`, code: 'SYSTEM_TRANSITION_REJECTED', from: current.state, to };
      return { commit: false, result: outcome };
    }
    state[item.code] = { code: item.code, state: to, reason: String(reason || '').slice(0, 200) || null, updatedAt: new Date().toISOString(), updatedBy: operator };
    outcome = { code: item.code, from: current.state, to };
    return { value: state, result: outcome };
  });
  return outcome;
}

// ── 一致性快照（测试与测绘用） ──────────────────────────────────────────────

/** 供测试断言「五处历史定义已收敛到唯一事实源」的稳定快照。 */
export function getSystemRegistrySnapshot() {
  return {
    definitionCount: systemDefinitions.length,
    codes: systemDefinitions.map((item) => item.code),
    ids: systemDefinitions.map((item) => item.id),
    connectorCodes: getRegistrableSystemCodes(),
    onboardingConnected: systemDefinitions.filter((item) => item.onboardingStatus === 'connected').map((item) => item.code),
    onboardingPending: systemDefinitions.filter((item) => item.onboardingStatus === 'pending_onboarding').map((item) => item.code),
    onboardingUnregistered: systemDefinitions.filter((item) => item.onboardingStatus === 'not_registered').map((item) => item.code),
    demoConnectionIds: getDemoConnectedSystems().map((item) => item.id),
    connectionTargetIds: getConnectionTargets().map((item) => item.id),
    roleDataDomains: Object.fromEntries(Object.keys(ROLE_DATA_DOMAINS).map((roleId) => [roleId, getRoleDataDomains(roleId)])),
    recordSurface: Object.fromEntries(Object.keys(ROLE_RECORD_SYSTEMS).map((roleId) => [roleId, getRecordSurfaceSystemIds(roleId)])),
    duplicateChecks: {
      uniqueCodes: new Set(systemDefinitions.map((item) => item.code)).size === systemDefinitions.length,
      uniqueIds: new Set(systemDefinitions.map((item) => item.id)).size === systemDefinitions.length,
      uniqueConnectorIds: new Set(systemDefinitions.filter((item) => item.connector).map((item) => item.connector.id)).size === systemDefinitions.filter((item) => item.connector).length
    }
  };
}

export const SYSTEM_REGISTRY_NAMESPACE = REGISTRY_NAMESPACE;

// 系统注册表服务：系统接入的**唯一入口**。
//
// 职责边界：
//   * 系统「类型」查询 → 读 data/system-catalog.js（平台级，全租户共享）
//   * 角色可见性策略   → 读 catalog 的 ROLE_DATA_DOMAINS / ROLE_RECORD_SYSTEMS
//   * 租户「接入实例」 → 本文件按租户隔离读写（多租户）
//   * 租户「自定义系统」→ 2026-09-26（ADR-024）起新增：接入清单不再预设备
//     待接入/未登记系统，租户通过「登记接入物料」自行创建任意命名的系统。
//
// 多租户的关键分界：**系统类型是平台资产，接入实例是租户资产。**
// 租户 A 接入了 ERP，不代表租户 B 也接入了；两者共用同一个 ERP 类型定义，
// 但各自持有独立的生命周期状态、凭据引用与授权范围。自定义系统更进一步：
// 它的**定义本身**也是租户资产（名称/物料/模拟数据源都只存在于本租户）。
// 因此：
//   * 类型与角色策略：无租户上下文也可读（保证既有离线夹具与测试不变）
//   * 接入实例与自定义系统读写：必须经 semanticTenantStateKey 落到当前租户的
//     工作区，绝不接受请求体里传来的 tenantId（沿用 semantic-tenant-context 的既有约定）
import {
  systemDefinitions,
  ROLE_DATA_DOMAINS, ROLE_RECORD_SYSTEMS,
  SYSTEM_CONNECTION_STATES, SYSTEM_CONNECTION_TRANSITIONS, ONBOARDING_STATE_SEED,
  DATA_DOMAIN_OPTIONS, SYSTEM_REGISTRATION_FIELDS,
  getDemoConnectedSystems, getConnectionTargets
} from '../data/system-catalog.js';
import { mockOnboardingScenarios } from '../data/mock-onboarding-catalog.js';
import { readState, mutateState, mutateStates } from '../repositories/runtime-state-repository.js';
import { semanticTenantStateKey, currentSemanticTenant } from './semantic-tenant-context.js';

const REGISTRY_NAMESPACE = 'system_registry_runtime';
const CONNECTIONS_KEY = 'connections';
const CUSTOM_SYSTEMS_KEY = 'custom_systems';

const byId = new Map(systemDefinitions.map((item) => [item.id, item]));
const byCode = new Map(systemDefinitions.map((item) => [item.code, item]));
// 平台目录保留码：自定义系统不得占用（保留码的类型语义归平台治理，如 ERP/OA）。
const PLATFORM_RESERVED_CODES = new Set(systemDefinitions.map((item) => item.code));
// 平台目录中演示接入样例（Mock 常用系统）：这些是租户接入清单唯一的预设成员，
// 状态固定 connected；除此之外不再预设备任何待接入/未登记系统（ADR-024）。
const TENANT_DEMO_CODES = systemDefinitions.filter((item) => item.onboardingStatus === 'connected').map((item) => item.code);

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
 * 只覆盖平台目录类型；租户自定义系统不参与文本识别（名字由租户命名，无别名治理）。
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

// ── 租户自定义系统（ADR-024：接入清单完全由租户自行登记） ────────────────────

const initialCustomSystems = () => ({});
const readCustomSystems = () => readState(REGISTRY_NAMESPACE, semanticTenantStateKey(CUSTOM_SYSTEMS_KEY), initialCustomSystems);

const MOCK_SCENARIO_IDS = new Set(mockOnboardingScenarios.map((scenario) => scenario.id));
const DATA_DOMAIN_IDS = new Set(DATA_DOMAIN_OPTIONS.map((option) => option.id));

/** 登记物料表（供接入总览透出给前端渲染表单）：字段 + 数据域选项 + 模拟场景选项。 */
export function getSystemRegistrationSchema() {
  return {
    policy: '接入清单不预设备任何待接入/未登记系统；登记需提交完整接入物料，使智脑能够理解系统名称、业务归类、定位、核心对象、授权边界、接入目的与责任人。系统码缺省自动生成且不得占用平台保留码。',
    fields: SYSTEM_REGISTRATION_FIELDS.map((field) => ({ ...field })),
    dataDomains: DATA_DOMAIN_OPTIONS.map((option) => ({ ...option })),
    mockScenarios: mockOnboardingScenarios.map((scenario) => ({ id: scenario.id, label: scenario.label, description: scenario.description }))
  };
}

const asTrimmedString = (value) => String(value ?? '').trim();

function parseKeyEntities(value) {
  if (Array.isArray(value)) return value.map(asTrimmedString).filter(Boolean);
  return String(value ?? '').split(/[、,，;；\n]/u).map((item) => item.trim()).filter(Boolean);
}

function validateRegistrationMaterials(materials) {
  const issues = [];
  const text = (key, { minLength = 0, maxLength = Infinity, label }) => {
    const value = asTrimmedString(materials?.[key]);
    if (value.length < minLength) issues.push({ field: key, message: `${label}不能少于 ${minLength} 字。` });
    if (value.length > maxLength) issues.push({ field: key, message: `${label}不能超过 ${maxLength} 字。` });
    return value;
  };

  const name = text('name', { minLength: 2, maxLength: 40, label: '系统名称' });
  const domain = text('domain', { minLength: 2, maxLength: 20, label: '业务域' });
  const description = text('description', { minLength: 10, maxLength: 400, label: '系统定位说明' });
  const accessIntention = text('accessIntention', { minLength: 10, maxLength: 400, label: '接入目的' });
  const businessOwner = text('businessOwner', { minLength: 2, maxLength: 30, label: '业务责任人' });
  const vendor = text('vendor', { minLength: 0, maxLength: 40, label: '厂商 / 供应商' });

  const keyEntities = [...new Set(parseKeyEntities(materials?.keyEntities))];
  if (!keyEntities.length) issues.push({ field: 'keyEntities', message: '核心业务对象至少填写 1 个（用顿号或逗号分隔）。' });
  if (keyEntities.length > 12) issues.push({ field: 'keyEntities', message: '核心业务对象最多 12 个。' });
  keyEntities.forEach((entity) => {
    if (entity.length > 40) issues.push({ field: 'keyEntities', message: `业务对象「${entity}」超过 40 字。` });
  });

  const dataDomains = [...new Set(Array.isArray(materials?.dataDomains) ? materials.dataDomains.map(asTrimmedString).filter(Boolean) : [])];
  if (!dataDomains.length) issues.push({ field: 'dataDomains', message: '覆盖数据域至少勾选 1 个。' });
  for (const id of dataDomains) {
    if (!DATA_DOMAIN_IDS.has(id)) issues.push({ field: 'dataDomains', message: `未知的数据域：${id}。` });
  }

  const requestedCode = asTrimmedString(materials?.code).toUpperCase();
  if (requestedCode && !/^[A-Z][A-Z0-9_]{1,15}$/u.test(requestedCode)) {
    issues.push({ field: 'code', message: '系统码须以字母开头，2–16 位大写字母 / 数字 / 下划线。' });
  }

  const mockScenarioId = asTrimmedString(materials?.mockScenarioId);
  if (mockScenarioId && !MOCK_SCENARIO_IDS.has(mockScenarioId)) {
    issues.push({ field: 'mockScenarioId', message: `未知的模拟数据源场景：${mockScenarioId}。` });
  }

  if (issues.length) {
    return { error: `接入物料校验未通过（${issues.length} 处）：${issues.map((issue) => issue.message).join(' ')}`, code: 'SYSTEM_MATERIALS_INVALID', issues };
  }
  return { name, domain, description, accessIntention, businessOwner, vendor: vendor || null, keyEntities, dataDomains, requestedCode: requestedCode || null, mockScenarioId: mockScenarioId || null };
}

/** 从系统名称派生候选系统码：取名称中的 ASCII 字母数字段，防撞由调用方完成。 */
function deriveSystemCode(name) {
  const base = ((String(name || '').match(/[A-Za-z0-9]+/g) || []).join('').toUpperCase().slice(0, 12).replace(/^[0-9]+/u, '')) || 'SYS';
  const normalized = base.length < 2 ? `${base}X` : base;
  return normalized;
}

/**
 * 登记一个租户自定义系统：接入物料校验 → 系统码生成/防撞 → 落自定义定义 + 生命周期行。
 *
 * 设计要点：
 *   * 创建即「登记接入」（registered），不是 draft——物料本身就是登记动作的输入；
 *     draft 只用于「退回 / 下线登记」后的重新登记场景。
 *   * 自定义定义与生命周期行在同一个事务里写入（mutateStates），不存在「有定义无状态」
 *     或「有状态无定义」的中间态。
 *   * 平台保留码与同租户已占用码都显式拒绝，不做静默改名（改名会让操作人对不上号）。
 */
export function registerTenantCustomSystem({ materials, actor } = {}) {
  const operator = String(actor?.id || actor || '').trim();
  if (!operator) return { error: '缺少操作主体，拒绝登记接入系统。', code: 'SYSTEM_ACTOR_REQUIRED' };
  const normalized = validateRegistrationMaterials(materials);
  if (normalized.error) return normalized;

  return mutateStates([
    { name: 'customSystems', namespace: REGISTRY_NAMESPACE, key: semanticTenantStateKey(CUSTOM_SYSTEMS_KEY), initialValue: initialCustomSystems },
    { name: 'connections', namespace: REGISTRY_NAMESPACE, key: semanticTenantStateKey(CONNECTIONS_KEY), initialValue: seedConnections }
  ], (values) => {
    const existing = values.customSystems;
    let code = normalized.requestedCode;
    if (code) {
      if (PLATFORM_RESERVED_CODES.has(code)) {
        return { commit: false, result: { error: `系统码 ${code} 是平台目录保留码，自定义系统请换一个（例如 ${code}2 或按业务命名）。`, code: 'SYSTEM_CODE_RESERVED' } };
      }
      if (existing[code]) {
        return { commit: false, result: { error: `系统码 ${code} 已被本租户登记使用（${existing[code].name}）。`, code: 'SYSTEM_CODE_TAKEN' } };
      }
    } else {
      const base = deriveSystemCode(normalized.name);
      code = base;
      for (let attempt = 2; PLATFORM_RESERVED_CODES.has(code) || existing[code]; attempt += 1) code = `${base}${attempt}`;
    }
    const registeredAt = new Date().toISOString();
    const record = {
      code,
      id: `custom-${code.toLowerCase()}`,
      name: normalized.name,
      registeredAt,
      registeredBy: operator,
      materials: {
        domain: normalized.domain,
        description: normalized.description,
        keyEntities: [...normalized.keyEntities],
        dataDomains: [...normalized.dataDomains],
        accessIntention: normalized.accessIntention,
        businessOwner: normalized.businessOwner,
        vendor: normalized.vendor,
        mockScenarioId: normalized.mockScenarioId,
        codeProvidedByTenant: Boolean(normalized.requestedCode)
      }
    };
    values.customSystems[code] = record;
    values.connections[code] = { code, state: 'registered', reason: '登记接入：租户提交接入物料', updatedAt: registeredAt, updatedBy: operator };
    return { values, result: { code, id: record.id, name: record.name, state: 'registered', registeredAt, registeredBy: operator } };
  });
}

/** 自定义系统的统一类型视图（与平台目录定义同构，供接入视图组装）。 */
function customDefinitionView(record) {
  const materials = record.materials;
  return {
    code: record.code,
    id: record.id,
    name: record.name,
    domain: materials.domain,
    aliases: [],
    connector: null,
    onboardingStatus: 'registered_by_tenant',
    worldObjectTypes: [...materials.keyEntities],
    demoConnection: null,
    origin: 'tenant_custom',
    custom: {
      ...materials,
      registeredAt: record.registeredAt,
      registeredBy: record.registeredBy
    }
  };
}

const platformDemoDefinition = (item) => ({ ...frozen(item), origin: 'platform_demo', custom: null });

// ── 租户接入实例（多租户隔离） ──────────────────────────────────────────────

// 接入清单的预设成员只有演示接入样例（6 个 Mock 常用系统，状态 connected）。
// 2026-09-26 起不再把 pending_onboarding / not_registered 的目录类型预设进租户清单：
// 接入什么系统完全由租户自己登记（ADR-024）。
const seedConnections = () => Object.fromEntries(TENANT_DEMO_CODES.map((code) => [code, {
  code,
  state: 'connected',
  reason: '演示租户默认接入样例（Mock）',
  updatedAt: null,
  updatedBy: 'system-registry'
}]));

const readConnections = () => readState(REGISTRY_NAMESPACE, semanticTenantStateKey(CONNECTIONS_KEY), seedConnections);

/** 当前租户接入清单的全部系统定义（平台演示样例在前，自定义系统按登记时间在后）。 */
export function getTenantSystemDefinitions() {
  const customs = Object.values(readCustomSystems())
    .sort((a, b) => String(a.registeredAt).localeCompare(String(b.registeredAt)) || a.code.localeCompare(b.code));
  return [
    ...TENANT_DEMO_CODES.flatMap((code) => { const item = byCode.get(code); return item ? [platformDemoDefinition(item)] : []; }),
    ...customs.map(customDefinitionView)
  ];
}

/** 按系统码解析当前租户接入清单里的系统定义（平台保留类型不在清单内则返回 null）。 */
export function getTenantSystemDefinition(code) {
  const normalized = String(code || '').toUpperCase();
  return getTenantSystemDefinitions().find((item) => item.code === normalized) || null;
}

/** 当前租户对所有系统的接入生命周期状态。 */
export function getTenantSystemConnections({ includeUnregistered = true } = {}) {
  const tenantId = currentSemanticTenant();
  const state = readConnections();
  return getTenantSystemDefinitions()
    .filter((item) => includeUnregistered || state[item.code]?.state !== 'draft')
    .map((item) => {
      const row = state[item.code];
      const seedState = item.origin === 'tenant_custom' ? 'registered' : ONBOARDING_STATE_SEED[item.onboardingStatus];
      return {
        code: item.code, id: item.id, name: item.name, domain: item.domain,
        tenantId,
        lifecycleState: row?.state || seedState,
        catalogOnboardingStatus: item.onboardingStatus,
        connectorRegistered: Boolean(item.connector),
        origin: item.origin,
        custom: item.custom,
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
 * 只接受接入清单内的系统（平台保留类型需先由租户登记为自定义系统）。
 */
export function transitionSystemConnection({ code, to, actor, reason } = {}) {
  const item = getTenantSystemDefinition(code);
  if (!item) {
    // 平台目录里存在但未被本租户接入的类型给出更精确的指引，而不是笼统的「未登记」。
    const platformKnown = byCode.has(String(code || '').toUpperCase());
    return {
      error: platformKnown
        ? `系统 ${String(code || '').toUpperCase()} 是平台目录保留类型，当前未在本租户接入清单中；请在「新增接入」中登记后再推进状态。`
        : `未登记的系统码：${code}`,
      code: platformKnown ? 'SYSTEM_ACCESS_MISSING' : 'SYSTEM_NOT_REGISTERED'
    };
  }
  if (!SYSTEM_CONNECTION_STATES.includes(to)) return { error: `未知的接入状态：${to}`, code: 'SYSTEM_STATE_UNKNOWN' };
  const operator = String(actor?.id || actor || '').trim();
  if (!operator) return { error: '缺少操作主体，拒绝推进接入状态。', code: 'SYSTEM_ACTOR_REQUIRED' };
  let outcome = null;
  mutateState(REGISTRY_NAMESPACE, semanticTenantStateKey(CONNECTIONS_KEY), seedConnections, (state) => {
    const current = state[item.code];
    if (!current || !canTransitionSystemConnection(current.state, to)) {
      // commit: false —— 被拒绝的跃迁不得写入任何行，也不得推进版本号。
      outcome = { error: `不允许的接入状态跃迁：${current?.state || '未知'} → ${to}`, code: 'SYSTEM_TRANSITION_REJECTED', from: current?.state || null, to };
      return { commit: false, result: outcome };
    }
    state[item.code] = { code: item.code, state: to, reason: String(reason || '').slice(0, 200) || null, updatedAt: new Date().toISOString(), updatedBy: operator };
    outcome = { code: item.code, from: current.state, to };
    return { value: state, result: outcome };
  });
  return outcome;
}

// ── 一致性快照（测试与测绘用） ──────────────────────────────────────────────

/** 供测试断言「五处历史定义已收敛到唯一事实源」的稳定快照（平台级，无租户上下文）。 */
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

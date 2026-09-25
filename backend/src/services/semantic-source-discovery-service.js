import { connectedSystems, systemConfigurations } from '../data/seed.js';
import { getMcpConnectors } from './mcp-connector-service.js';
import { getEnterpriseConnectorReadiness } from './system-integration-service.js';
import { detectDeclaredSystemCodes as registryDeclaredSystemCodes, detectSystemCodesInText, getSystemByCode } from './system-registry-service.js';

// 系统别名表已收敛到唯一事实源（data/system-catalog.js 的 definitions[].aliases）。
// 历史问题：此处曾独立维护 12 个系统的别名，与 seed.js / 连接器目录 / 连接目标
// 三处的成员都不一致。

const schemaAssets = [
  '接口或数据库只读访问说明',
  '对象与字段数据字典',
  '主键、外键和业务唯一键规则',
  '脱敏样例或事件样例',
  '字段分级与组织数据范围',
  '增量同步、删除和重放语义'
];
const connectorContract = (code, objects = []) => ({
  contractVersion: '1.0',
  sourceSystem: code,
  scope: 'metadata_and_authorized_records',
  authentication: 'server_side_short_lived_credential',
  transport: ['https_api', 'webhook', 'scheduled_compensation'],
  schemaModes: ['openapi', 'json_schema', 'csv_dictionary'],
  objectTypes: objects,
  requiredControls: ['endpoint_allowlist', 'credential_vault', 'field_classification', 'organization_scope', 'incremental_cursor', 'deletion_semantics', 'replay_idempotency'],
  prohibited: ['browser_held_secret', 'unscoped_bulk_read', 'direct_model_credential_access']
});

/**
 * 从自由文本推断用户提到了哪些系统。语义与实现均已委托给系统注册表，
 * 本处保留原函数名以维持既有调用方与测试契约不变。
 *
 * 重要：返回值只表示「文本里提到了什么」，**不得**作为数据授权范围或建模范围的依据。
 * 范围只能由 `discoverSemanticSources` 的 `systemCodes` / `includeAllRegistered` 显式给定；
 * 本函数在建模任务里已降级为「文本提到了 X 但未选择」的提示素材（阶段 3）。
 */
export function detectRequestedSemanticSystems(request = '') {
  return detectSystemCodesInText(request);
}

/**
 * 归属判定专用的系统识别（阶段 4c 第二段 / ADR-017）。转发自系统注册表，理由与上一处完全相同：
 * 语义域接触系统注册表只经**本文件**一处（`semantic-*-service.js -> system-registry-service.js`
 * 这条跨域边已在架构基线登记），新增消费者不应各自再开一条边。
 *
 * 与 `detectRequestedSemanticSystems` 的关键区别：它**不认业务词别名**。
 * 「采购订单表 purchase_order」用于「这段文本提到了什么系统」可以命中 ERP，
 * 用于「这张表属于哪个系统」则是彻头彻尾的猜测。
 */
export function detectDeclaredSystemCodes(text = '') {
  return registryDeclaredSystemCodes(text);
}

/** 目标系统编码是否已在系统注册表中（归属确认的合法性前提）。同样经本文件中转，不新开跨域边。 */
export const isRegisteredSystemCode = (code) => Boolean(getSystemByCode(code));

const registeredSystem = (code) => connectedSystems.find((item) => item.code === code);
const configuredMappings = (code) => {
  const system = registeredSystem(code);
  return systemConfigurations.find((item) => item.systemId === system?.id)?.mapping || [];
};

/**
 * 解析本次来源范围。范围只能来自两个**显式**入口，二者都没有时返回空范围，
 * 绝不回落到「全部可访问连接器」。
 *
 * 历史行为（阶段 3 删除）：`requestedSystems.length ? requestedSystems : 全部 accessible`。
 * 它把「文本里提到了 ERP」当成范围，又在什么都没提到时把范围放大到整个角色可见面——
 * 两者都会让一次建模任务的实际覆盖范围超出运营人员的选择，且界面上看不出来。
 *
 * @param {object} options
 * @param {string[]|null} options.systemCodes 运营人员显式勾选的系统（空数组＝显式选择为空）
 * @param {boolean} options.includeAllRegistered 是否显式请求「全部已登记系统」（巡检/来源清单预览）
 */
function resolveSelectionScope({ requestedSystems, knownCodes, systemCodes, includeAllRegistered }) {
  const explicitCodes = Array.isArray(systemCodes)
    ? [...new Set(systemCodes.map((code) => String(code || '').toUpperCase()).filter(Boolean))]
    : null;
  if (includeAllRegistered) return { selectionSource: 'all_registered', selectedCodes: [...knownCodes].sort(), explicitCodes };
  if (explicitCodes) return { selectionSource: explicitCodes.length ? 'explicit' : 'explicit_empty', selectedCodes: explicitCodes, explicitCodes };
  return { selectionSource: requestedSystems.length ? 'text_inference' : 'unspecified', selectedCodes: requestedSystems, explicitCodes: null };
}

const SCOPE_NOTICE = Object.freeze({
  explicit_empty: '本次未选择任何来源系统，范围为空；不会自动扩大到全部可访问连接器。',
  unspecified: '本次既未显式选择来源系统，也未在文本中识别到系统名，范围为空；不会自动扩大到全部可访问连接器。',
  text_inference: '当前范围来自文本中出现的系统名，属于推断而非显式选择；写入草稿前需要运营人员显式确认范围。'
});

export function discoverSemanticSources({ request = '', role, systemCodes = null, includeAllRegistered = false }) {
  const roleId = role?.id || role;
  const requestedSystems = detectRequestedSemanticSystems(request);
  const readiness = new Map(getEnterpriseConnectorReadiness(roleId).map((item) => [item.code, item]));
  const connectorCatalog = getMcpConnectors(roleId).connectors;
  const connectorByCode = new Map(connectorCatalog.map((item) => [item.system, item]));
  const knownCodes = new Set(connectorCatalog.map((item) => item.system));
  const { selectionSource, selectedCodes, explicitCodes } = resolveSelectionScope({ requestedSystems, knownCodes, systemCodes, includeAllRegistered });
  // 文本提到但未被选中：降级为提示素材，不作为范围依据（阶段 3）。
  const mentionedNotSelected = explicitCodes ? requestedSystems.filter((code) => !selectedCodes.includes(code)) : [];

  const sources = selectedCodes.map((code) => {
    const connector = connectorByCode.get(code);
    // registryKnown 区分两种「不可用」：编码根本不在系统注册表里（拼错/不存在），
    // 与登记了系统类型但没有受控连接器（如 SRM）。二者对运营人员是不同的问题，
    // 调用方需要据此给出不同提示，所以由本模块统一判定，不要求调用方各自查注册表。
    const definition = getSystemByCode(code);
    if (!connector) return {
      code,
      name: definition?.name || `${code} 待登记系统`,
      registryKnown: Boolean(definition),
      authorized: false,
      status: 'not_registered',
      mode: 'unavailable',
      message: definition
        ? '该系统类型已登记，但尚未进入受控连接器目录，不能据此读取数据或发布来源映射。'
        : '系统编码不在系统注册表中，无法作为来源范围。',
      objects: [],
      mappings: [],
      requiredAssets: schemaAssets
      ,connectorContract: connectorContract(code)
    };
    const access = connector.accessible;
    const state = readiness.get(code) || {
      status: 'not_configured',
      mode: 'local_mock',
      message: code === 'OA'
        ? 'OA/BPM 已登记受控工具目录，企业连接端点尚未配置。'
        : '未配置企业 Connector；当前仅可使用本地受控模拟数据。'
    };
    return {
      code,
      name: connector.name,
      registryKnown: true,
      authorized: access,
      status: access ? state.status : 'forbidden',
      mode: access ? state.mode : 'policy_denied',
      message: access ? state.message : '当前角色未获该系统所属数据域授权。',
      classification: access ? connector.classification : null,
      objects: access ? connector.objects : [],
      visibleTools: access ? connector.visibleTools : [],
      writeMode: access ? connector.writeMode : null,
      mappings: access ? configuredMappings(code).map((item) => ({ source: item.source, object: item.object, event: item.event, fields: item.fields })) : [],
      requiredAssets: schemaAssets
      ,connectorContract: connectorContract(code, access ? connector.objects : [])
    };
  });

  const blockers = sources.flatMap((source) => {
    if (source.status === 'forbidden') return [`${source.code}：当前角色无数据域权限`];
    if (source.status === 'not_registered') return [`${source.code}：尚未登记连接器和来源契约`];
    if (source.status === 'rejected_endpoint') return [`${source.code}：企业内网端点不符合安全策略`];
    if (source.status === 'missing_credential') return [`${source.code}：服务端凭据尚未配置`];
    return [];
  });
  const warnings = sources
    .filter((source) => source.authorized && source.status === 'not_configured')
    .map((source) => `${source.code} 当前只能使用受控模拟目录，不能宣称已读取真实系统。`);

  return {
    requestedSystems,
    registeredSystems: [...knownCodes].sort(),
    // 范围来源必须可审计：selectionSource 说明这次范围是怎么来的，
    // selectedSystemCodes 是实际生效的范围，explicitSystemCodes 是运营人员的原始勾选（未指定时为 null）。
    selectionSource,
    selectedSystemCodes: [...selectedCodes],
    explicitSystemCodes: explicitCodes,
    includeAllRegistered: Boolean(includeAllRegistered),
    mentionedNotSelected,
    scopeNotice: SCOPE_NOTICE[selectionSource] || null,
    sources,
    blockers,
    warnings,
    canDiscoverStructure: sources.some((item) => item.authorized),
    canUseEnterpriseData: sources.some((item) => item.authorized && item.status === 'ready_for_scoped_access'),
    readinessSummary: {
      ready: sources.filter((item) => item.status === 'ready_for_scoped_access').length,
      mockOnly: sources.filter((item) => item.authorized && item.status === 'not_configured').length,
      blocked: blockers.length,
      total: sources.length
    },
    policy: '来源发现只返回连接状态、对象目录和字段映射物料，不主动查询业务明细；真实读取仍需任务权限和服务端短时凭据。'
  };
}

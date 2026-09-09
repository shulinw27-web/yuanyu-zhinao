import { connectedSystems, systemConfigurations } from '../data/seed.js';
import { getMcpConnectors } from './mcp-connector-service.js';
import { getEnterpriseConnectorReadiness } from './system-integration-service.js';

const systemAliases = {
  OA: ['oa', 'bpm', '审批', '组织', '流程'],
  ERP: ['erp', '采购', '供应商', '财务', '库存'],
  WMS: ['wms', '仓储', '仓库', '库位', '入库', '出库'],
  MES: ['mes', '生产', '制造', '工单', '设备'],
  LIMS: ['lims', '实验室', '检验', '检测', '样品'],
  QMS: ['qms', '质量', '偏差', 'capa', '放行'],
  OMS: ['oms', '销售订单', '客户订单', '门店订单', '门店', '履约', '退货'],
  SRM: ['srm', '供应商协同'],
  MDM: ['mdm', '主数据'],
  PLM: ['plm', '产品生命周期'],
  EAM: ['eam', '资产管理'],
  IOT: ['iot', '物联网', '传感器']
};

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

const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

export function detectRequestedSemanticSystems(request = '') {
  const text = normalize(request);
  const explicitSystems = Object.keys(systemAliases).filter((code) => new RegExp(`(?:^|[^a-z0-9])${code.toLowerCase()}(?:$|[^a-z0-9])`, 'i').test(text));
  if (explicitSystems.length) return explicitSystems;
  return Object.entries(systemAliases)
    .filter(([, aliases]) => aliases.some((alias) => text.includes(alias)))
    .map(([code]) => code);
}

const registeredSystem = (code) => connectedSystems.find((item) => item.code === code);
const configuredMappings = (code) => {
  const system = registeredSystem(code);
  return systemConfigurations.find((item) => item.systemId === system?.id)?.mapping || [];
};

export function discoverSemanticSources({ request = '', role }) {
  const roleId = role?.id || role;
  const requestedSystems = detectRequestedSemanticSystems(request);
  const readiness = new Map(getEnterpriseConnectorReadiness(roleId).map((item) => [item.code, item]));
  const connectorCatalog = getMcpConnectors(roleId).connectors;
  const connectorByCode = new Map(connectorCatalog.map((item) => [item.system, item]));
  const knownCodes = new Set(connectorCatalog.map((item) => item.system));
  const selectedCodes = requestedSystems.length
    ? requestedSystems
    : connectorCatalog.filter((item) => item.accessible).map((item) => item.system);

  const sources = selectedCodes.map((code) => {
    const connector = connectorByCode.get(code);
    if (!connector) return {
      code,
      name: `${code} 待登记系统`,
      authorized: false,
      status: 'not_registered',
      mode: 'unavailable',
      message: '该系统尚未进入受控连接器目录，不能据此读取数据或发布来源映射。',
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

import { getSystemEventRecords } from '../data/system-event-records.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getRuntimeStoreInfo, mutateState, readState } from '../repositories/runtime-state-repository.js';

const scenarioCatalog = [
  { id: 'quality_batch_exception', name: '原料质量异常闭环', description: 'LIMS OOS → QMS 偏差 → MES 批次冻结 → OA 审批 → CAPA 草稿', businessKey: 'RMB-VC-20260801', systems: ['lims', 'qms', 'mes', 'oa'], approverRoles: ['quality_manager', 'executive'] },
  { id: 'production_equipment_exception', name: '生产设备异常闭环', description: 'MES 设备异常 → QMS 偏差 → OA 处置任务', businessKey: 'PB-202608-01-A', systems: ['mes', 'qms', 'oa'], approverRoles: ['production_manager', 'quality_manager', 'executive'] },
  { id: 'inventory_supply_risk', name: '供应与库存风险闭环', description: 'ERP 低库存 → WMS 库存批次 → MES 排产影响 → QMS 供应商质量约束 → OA 采购审批', businessKey: 'RMB-CA-20260802', systems: ['erp', 'wms', 'mes', 'qms', 'oa'], approverRoles: ['procurement_manager', 'executive'] },
  { id: 'order_fulfillment_risk', name: '订单履约风险闭环', description: 'OMS 履约异常 → ERP 库存影响 → QMS 放行约束 → OA 协同审批', businessKey: 'ORD-202608-00001', systems: ['oms', 'erp', 'qms', 'oa'], approverRoles: ['marketing_manager', 'quality_manager', 'executive'] }
];

const connectorFaultCatalog = [
  { id: 'none', name: '正常', health: 'healthy', description: 'Connector 正常响应，使用基础种子数据和运行时事件。' },
  { id: 'connector_outage', name: '接口不可用', health: 'unavailable', description: '模拟 Connector 无法建立连接；查询会返回可用性告警，不返回该系统的业务记录。' },
  { id: 'data_delay', name: '数据延迟', health: 'delayed', description: '模拟上游同步滞后；保留可读记录，但 Agent 会显式标记数据时效风险。' },
  { id: 'data_conflict', name: '主数据冲突', health: 'degraded', description: '模拟主数据校验失败；保留可读记录，但 Agent 会显式标记关联结果需人工复核。' }
];

const semanticEntityKeys = new Set(['materialBatchId', 'productionBatchId', 'finishedGoodsBatchId', 'batchId', 'sku', 'orderId', 'storeId', 'supplierId', 'equipmentId', 'eventId', 'capaId', 'purchaseOrderId', 'inventoryLotId', 'receiptId', 'warehouseCode', 'fulfillmentId', 'subject', 'approvalId']);

const initialRuntime = () => {
  const runtimeRecords = { lims: [], mes: [], erp: [], wms: [], qms: [], oms: [] };
  return {
    runtimeRecords,
    runs: [],
    approvals: [],
    audit: [],
    alerts: [],
    connectorFaults: Object.fromEntries(Object.keys(runtimeRecords).map((systemId) => [systemId, { faultId: 'none', changedAt: null, changedBy: null }])),
    sequence: 0
  };
};
const NAMESPACE = 'mock_simulation';
const WORKSPACE_KEY = 'workspace';
const simulationContext = new AsyncLocalStorage();
let postgresRepository = null;

const normalizeRuntime = (runtime) => {
  const value = runtime || initialRuntime();
  value.runtimeRecords ||= {};
  value.runs ||= []; value.approvals ||= []; value.audit ||= []; value.alerts ||= []; value.connectorFaults ||= {}; value.sequence ||= 0;
  for (const systemId of ['lims', 'mes', 'erp', 'wms', 'qms', 'oms']) {
    if (!Array.isArray(value.runtimeRecords[systemId])) value.runtimeRecords[systemId] = [];
    if (!value.connectorFaults[systemId]) value.connectorFaults[systemId] = { faultId: 'none', changedAt: null, changedBy: null };
  }
  return value;
};
const currentRuntime = () => {
  const runtime = simulationContext.getStore();
  if (!runtime) throw new Error('Simulation runtime context is not active.');
  return runtime;
};
const collectionProxy = (field) => new Proxy([], {
  get: (_target, property) => {
    const collection = currentRuntime()[field];
    const value = Reflect.get(collection, property, collection);
    return typeof value === 'function' ? value.bind(collection) : value;
  },
  set: (_target, property, value) => Reflect.set(currentRuntime()[field], property, value, currentRuntime()[field]),
  deleteProperty: (_target, property) => Reflect.deleteProperty(currentRuntime()[field], property),
  ownKeys: () => Reflect.ownKeys(currentRuntime()[field]),
  getOwnPropertyDescriptor: (_target, property) => Object.getOwnPropertyDescriptor(currentRuntime()[field], property) || { configurable: true, enumerable: true, writable: true, value: undefined }
});
const objectProxy = (field) => new Proxy({}, {
  get: (_target, property) => Reflect.get(currentRuntime()[field], property, currentRuntime()[field]),
  set: (_target, property, value) => Reflect.set(currentRuntime()[field], property, value, currentRuntime()[field]),
  ownKeys: () => Reflect.ownKeys(currentRuntime()[field]),
  getOwnPropertyDescriptor: (_target, property) => Object.getOwnPropertyDescriptor(currentRuntime()[field], property) || { configurable: true, enumerable: true, writable: true, value: undefined }
});
const runtimeRecords = objectProxy('runtimeRecords');
const connectorFaults = objectProxy('connectorFaults');
const runs = collectionProxy('runs');
const approvals = collectionProxy('approvals');
const audit = collectionProxy('audit');
const alerts = collectionProxy('alerts');

export function configureSimulationRepository(repository = null) {
  if (repository && typeof repository.mutateState !== 'function') throw new TypeError('Simulation repository does not implement the asynchronous runtime-state port.');
  postgresRepository = repository;
}
export const getSimulationStoreInfo = () => postgresRepository?.getInfo?.() || getRuntimeStoreInfo();
export const probeSimulationStore = () => postgresRepository ? postgresRepository.probe() : Promise.resolve({ ready: true });
const readRuntime = () => postgresRepository ? postgresRepository.readState(NAMESPACE, WORKSPACE_KEY, initialRuntime) : readState(NAMESPACE, WORKSPACE_KEY, initialRuntime);
const readInContext = (callback) => {
  const active = simulationContext.getStore();
  if (active) return callback();
  const runtime = readRuntime();
  return runtime && typeof runtime.then === 'function' ? runtime.then((value) => simulationContext.run(normalizeRuntime(value), callback)) : simulationContext.run(normalizeRuntime(runtime), callback);
};
const mutateInContext = (callback) => {
  const mutation = (runtime) => simulationContext.run(normalizeRuntime(runtime), () => ({ value: runtime, result: callback() }));
  return postgresRepository ? postgresRepository.mutateState(NAMESPACE, WORKSPACE_KEY, initialRuntime, mutation) : mutateState(NAMESPACE, WORKSPACE_KEY, initialRuntime, mutation);
};

const now = () => new Date().toISOString();
const scenarioById = (id) => scenarioCatalog.find((scenario) => scenario.id === id);
const faultById = (id) => connectorFaultCatalog.find((fault) => fault.id === id);
const nextSequence = () => ++currentRuntime().sequence;
const addAudit = (action, detail, actor = '模拟运行中心') => audit.unshift({ id: `SIM-AUD-${String(nextSequence()).padStart(4, '0')}`, at: now(), actor, action, detail });
const addAlert = ({ level, title, description, policy, roles, scenarioId = null, systemId = null }) => alerts.unshift({ id: `SIM-NT-${String(nextSequence()).padStart(4, '0')}`, channel: '模拟告警', target: '受控角色工作台', status: '已送达（模拟）', time: now(), severity: level, riskStatus: '待关注', title, description, policy, roles, scenarioId, systemId });
const createRecord = (systemId, { objectType, eventType, status, classification, payload, scenarioId, runId }) => {
  const sequence = nextSequence();
  const record = { id: `SIM-${systemId.toUpperCase()}-${String(sequence).padStart(4, '0')}`, system: systemId.toUpperCase(), sequence, objectType, eventType, status, classification, payload: { ...payload, scenarioId, runId }, occurredAt: now(), runtime: true };
  runtimeRecords[systemId].unshift(record);
  return record;
};

const createApproval = ({ scenario, runId, subject, title, detail }) => {
  const approval = { id: `OA-APP-${String(nextSequence()).padStart(4, '0')}`, runId, scenarioId: scenario.id, subject, title, detail, status: 'pending', approverRoles: scenario.approverRoles, createdAt: now(), decidedAt: null, decision: null, decidedBy: null };
  approvals.unshift(approval);
  return approval;
};

const buildScenario = (scenario, runId) => {
  if (scenario.id === 'quality_batch_exception') {
    const materialBatchId = scenario.businessKey;
    createRecord('lims', { objectType: 'TestResult', eventType: 'TestResultCompleted', status: 'review_required', classification: '质量受限', scenarioId: scenario.id, runId, payload: { sampleId: 'SMP-SIM-9001', materialBatchId, testItem: '微生物', decision: 'OOS 不合格', conclusion: '需质量复核' } });
    createRecord('qms', { objectType: 'QualityEvent', eventType: 'QualityEventRaised', status: 'open', classification: '质量受限', scenarioId: scenario.id, runId, payload: { eventId: 'QE-SIM-9001', category: '来料 OOS', severity: '高', materialBatchId, productionBatchId: 'PB-202608-01-A', owner: '质量保证组' } });
    createRecord('mes', { objectType: 'ProductionBatch', eventType: 'BatchStatusChanged', status: 'held', classification: '生产受限', scenarioId: scenario.id, runId, payload: { batchId: 'PB-202608-01-A', materialBatchId, finishedGoodsBatchId: 'FG-202608-01-A', sku: 'SKU-SLEEP-01', line: 'LINE-1', status: '质量冻结' } });
    return createApproval({ scenario, runId, subject: materialBatchId, title: '批准原料批次质量冻结与 CAPA 草稿', detail: '原料微生物检验触发 OOS，关联生产批次已在模拟 MES 中冻结。' });
  }
  if (scenario.id === 'production_equipment_exception') {
    createRecord('mes', { objectType: 'Equipment', eventType: 'EquipmentStatusChanged', status: 'exception', classification: '生产受限', scenarioId: scenario.id, runId, payload: { equipmentId: 'EQ-004', state: '非计划停机', impactBatchId: scenario.businessKey, line: 'LINE-2', oee: 51 } });
    createRecord('qms', { objectType: 'QualityEvent', eventType: 'QualityEventRaised', status: 'investigating', classification: '质量受限', scenarioId: scenario.id, runId, payload: { eventId: 'QE-SIM-9002', category: '设备异常偏差', severity: '中', productionBatchId: scenario.businessKey, owner: '生产质量组' } });
    return createApproval({ scenario, runId, subject: scenario.businessKey, title: '批准生产设备异常处置任务', detail: '设备 EQ-004 非计划停机，需确认批次影响评估与复产前检查。' });
  }
  if (scenario.id === 'inventory_supply_risk') {
    createRecord('erp', { objectType: 'Inventory', eventType: 'InventoryAllocated', status: 'review_required', classification: '供应链受限', scenarioId: scenario.id, runId, payload: { materialBatchId: scenario.businessKey, materialCode: 'CA', lotNo: 'LOT-SIM-9003', availableQty: 18, unit: 'kg', safetyStockQty: 120, risk: '低于安全库存' } });
    createRecord('wms', { objectType: 'InventoryLot', eventType: 'InventoryLotChanged', status: 'review_required', classification: '仓储运营受限', scenarioId: scenario.id, runId, payload: { inventoryLotId: 'INVLOT-SIM-9003', materialBatchId: scenario.businessKey, warehouseCode: 'WH-2', locationCode: 'LOC-018', quantity: 18, status: '低库存复核' } });
    createRecord('mes', { objectType: 'ProductionBatch', eventType: 'ProductionPlanRiskRaised', status: 'review_required', classification: '生产受限', scenarioId: scenario.id, runId, payload: { batchId: 'PB-202608-02-B', materialBatchId: scenario.businessKey, line: 'LINE-3', risk: '原料不足可能影响排产' } });
    createRecord('qms', { objectType: 'QualityEvent', eventType: 'SupplierQualityConstraintRaised', status: 'open', classification: '质量受限', scenarioId: scenario.id, runId, payload: { eventId: 'QE-SIM-9003', materialBatchId: scenario.businessKey, supplierId: 'SUP-002', constraint: '候选供应商仍需质量准入复核' } });
    return createApproval({ scenario, runId, subject: scenario.businessKey, title: '批准供应风险采购申请草稿', detail: '库存低于安全阈值，采购草稿须同时满足供应商质量准入。' });
  }
  createRecord('oms', { objectType: 'Fulfillment', eventType: 'FulfillmentStatusChanged', status: 'exception', classification: '订单运营受限', scenarioId: scenario.id, runId, payload: { fulfillmentId: 'FUL-SIM-9004', orderId: scenario.businessKey, storeId: 'STORE-SH-001', finishedGoodsBatchId: 'FG-202608-01-A', status: '配送异常', impact: '预计延迟 24 小时' } });
  createRecord('erp', { objectType: 'Inventory', eventType: 'InventoryAllocationRiskRaised', status: 'review_required', classification: '供应链受限', scenarioId: scenario.id, runId, payload: { materialBatchId: 'FG-202608-01-A', materialCode: 'SKU-SLEEP-01', availableQty: 32, unit: '箱', risk: '替代库存不足' } });
  createRecord('qms', { objectType: 'QualityEvent', eventType: 'ReleaseConstraintRaised', status: 'open', classification: '质量受限', scenarioId: scenario.id, runId, payload: { eventId: 'QE-SIM-9004', finishedGoodsBatchId: 'FG-202608-01-A', sku: 'SKU-SLEEP-01', constraint: '替代批次待放行确认' } });
  return createApproval({ scenario, runId, subject: scenario.businessKey, title: '批准订单履约风险协同方案', detail: '订单配送异常且替代批次存在放行约束，需要经营与质量共同确认。' });
};

function getMockSystemRecordsInContext(systemId) {
  if (!Object.hasOwn(runtimeRecords, systemId) || !Array.isArray(runtimeRecords[systemId])) return [];
  return [...runtimeRecords[systemId], ...getSystemEventRecords(systemId)];
}

// This is intentionally a server-only canonicalisation step.  The browser
// never supplies facts to Semantica, and the semantic service only receives
// synthetic records belonging to one Demo run.
function getMockScenarioSemanticFactsInContext(runId) {
  const run = runs.find((item) => item.id === runId);
  if (!run) return { error: '未找到模拟运行。' };
  const scenario = scenarioById(run.scenarioId);
  const records = Object.values(runtimeRecords).flat().filter((record) => record.payload?.runId === runId);
  const approval = approvals.find((item) => item.runId === runId);
  const toFact = (record) => ({
    id: record.id,
    sourceSystem: record.system,
    sourceRecordId: record.id,
    objectType: record.objectType,
    eventType: record.eventType,
    status: record.status,
    classification: record.classification,
    occurredAt: record.occurredAt,
    runId,
    payload: structuredClone(record.payload),
    entities: Object.entries(record.payload || {}).filter(([key, value]) => semanticEntityKeys.has(key) && value).map(([, value]) => String(value)),
    simulated: true
  });
  const facts = records.map(toFact);
  if (approval) {
    facts.push({
      id: `SIM-OA-${approval.id}`,
      sourceSystem: 'OA',
      sourceRecordId: approval.id,
      objectType: 'ApprovalInstance',
      eventType: approval.status === 'pending' ? 'ApprovalCreated' : 'ApprovalDecided',
      status: approval.status,
      classification: '流程受限',
      occurredAt: approval.decidedAt || approval.createdAt,
      runId,
      payload: { approvalId: approval.id, subject: approval.subject, scenarioId: approval.scenarioId, decision: approval.decision, decidedBy: approval.decidedBy },
      entities: [approval.id, approval.subject].filter(Boolean),
      simulated: true
    });
  }
  return {
    run: structuredClone(run),
    facts,
    expectedSystems: (scenario?.systems || []).map((system) => system.toUpperCase()),
    businessKey: run.businessKey
  };
}

function recordMockScenarioSemanticValidationInContext(runId, validation) {
  const run = runs.find((item) => item.id === runId);
  if (!run) return { error: '未找到模拟运行。' };
  run.semanticValidation = { ...structuredClone(validation), checkedAt: now() };
  return { run: structuredClone(run) };
}

function getMockConnectorCatalogInContext() {
  return Object.keys(runtimeRecords).map((systemId) => {
    const state = connectorFaults[systemId];
    const fault = faultById(state.faultId) || connectorFaultCatalog[0];
    return {
      systemId,
      adapter: `Mock${systemId.toUpperCase()}Connector`,
      capabilities: ['health_check', 'query', 'get_by_business_key', 'event_replay', 'approved_action'],
      mode: 'stateful_mock',
      health: fault.health,
      faultId: fault.id,
      faultName: fault.name,
      statusMessage: fault.description,
      changedAt: state.changedAt,
      changedBy: state.changedBy
    };
  });
}

function getMockSimulationOverviewInContext(roleId) {
  const canControl = roleId === 'executive';
  const visibleApprovals = approvals.filter((approval) => canControl || approval.approverRoles.includes(roleId));
  return { mode: 'stateful_process_simulation', policy: '所有事件、审批、故障注入、告警和写回仅存在于服务端模拟运行时；可安全重置，不会连接企业生产系统。', canControl, scenarios: scenarioCatalog, faultCatalog: connectorFaultCatalog, activeRuns: runs.slice(0, 12), approvals: visibleApprovals.slice(0, 12), alerts: getMockSimulationAlertsInContext(roleId).slice(0, 12), runtimeEventCount: Object.values(runtimeRecords).reduce((sum, records) => sum + records.length, 0), runtimeEvents: Object.values(runtimeRecords).flat().sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 12), audit: audit.slice(0, 12), connectors: getMockConnectorCatalogInContext() };
}

function getMockSimulationAlertsInContext(roleId) {
  return alerts.filter((alert) => roleId === 'executive' || alert.roles.includes(roleId)).map((alert) => ({ ...alert, roles: undefined }));
}

function setMockConnectorFaultInContext(systemId, faultId, roleId) {
  if (roleId !== 'executive') return { error: '仅管理角色可注入或清除模拟 Connector 故障。' };
  if (!Object.hasOwn(runtimeRecords, systemId)) return { error: '未找到该模拟 Connector。' };
  const fault = faultById(faultId);
  if (!fault) return { error: '未找到该模拟故障类型。' };
  const state = connectorFaults[systemId];
  if (state.faultId === fault.id) return { overview: getMockSimulationOverviewInContext(roleId), unchanged: true };
  state.faultId = fault.id;
  state.changedAt = now();
  state.changedBy = roleId;
  const systemCode = systemId.toUpperCase();
  createRecord(systemId, {
    objectType: 'ConnectorHealth',
    eventType: fault.id === 'none' ? 'ConnectorRecovered' : 'ConnectorFaultInjected',
    status: fault.id === 'none' ? 'normal' : 'exception',
    classification: fault.id === 'none' ? '正常' : '集成受限',
    payload: { systemId, systemCode, connector: `Mock${systemCode}Connector`, faultId: fault.id, faultName: fault.name, health: fault.health, impact: fault.description }
  });
  if (fault.id !== 'none') {
    const affectedRoles = systemId === 'oms' ? ['executive', 'marketing_manager'] : systemId === 'erp' ? ['executive', 'procurement_manager', 'production_manager'] : ['executive', 'quality_manager', 'production_manager'];
    addAlert({ level: fault.id === 'connector_outage' ? 'P1' : 'P2', title: `${systemCode} Connector ${fault.name}`, description: fault.description, policy: `模拟集成健康 · ${systemCode}`, roles: affectedRoles, systemId });
  }
  addAudit(fault.id === 'none' ? 'Connector 故障已清除' : 'Connector 故障已注入', `${systemCode} 已切换为「${fault.name}」：${fault.description}`, roleId);
  return { connector: getMockConnectorCatalogInContext().find((item) => item.systemId === systemId), overview: getMockSimulationOverviewInContext(roleId) };
}

function runMockScenarioInContext(id, roleId) {
  if (roleId !== 'executive') return { error: '仅管理角色可启动或注入模拟业务场景。' };
  const scenario = scenarioById(id);
  if (!scenario) return { error: '未找到该模拟业务场景。' };
  const run = { id: `SIM-RUN-${String(nextSequence()).padStart(4, '0')}`, scenarioId: scenario.id, scenarioName: scenario.name, businessKey: scenario.businessKey, status: 'awaiting_approval', startedAt: now(), completedAt: null };
  const approval = buildScenario(scenario, run.id);
  run.approvalId = approval.id;
  runs.unshift(run);
  const scenarioAlertRoles = {
    quality_batch_exception: ['executive', 'quality_manager', 'production_manager'],
    production_equipment_exception: ['executive', 'production_manager', 'quality_manager'],
    inventory_supply_risk: ['executive', 'procurement_manager', 'production_manager'],
    order_fulfillment_risk: ['executive', 'marketing_manager', 'quality_manager']
  };
  addAlert({ level: scenario.id === 'quality_batch_exception' ? 'P0' : 'P1', title: `${scenario.name}已启动`, description: `${scenario.description}。业务标识：${scenario.businessKey}；已创建模拟 OA 审批。`, policy: '模拟流程演练告警', roles: scenarioAlertRoles[scenario.id], scenarioId: scenario.id });
  addAudit('场景已启动', `${scenario.name} 已注入 ${scenario.systems.join('、')} 模拟事件并创建 OA 审批 ${approval.id}。`, roleId);
  return { run, approval, overview: getMockSimulationOverviewInContext(roleId) };
}

function decideMockApprovalInContext(id, decision, roleId) {
  const approval = approvals.find((item) => item.id === id);
  if (!approval) return { error: '未找到模拟 OA 审批任务。' };
  if (approval.status !== 'pending') return { error: '该模拟 OA 审批已处理。' };
  if (!approval.approverRoles.includes(roleId)) return { error: '当前角色无权处理该模拟 OA 审批。' };
  if (!['approved', 'rejected'].includes(decision)) return { error: '审批决定仅支持 approved 或 rejected。' };
  approval.status = decision;
  approval.decision = decision;
  approval.decidedBy = roleId;
  approval.decidedAt = now();
  const run = runs.find((item) => item.id === approval.runId);
  if (run) { run.status = decision === 'approved' ? 'completed' : 'rejected'; run.completedAt = now(); }
  if (decision === 'approved') createRecord('qms', { objectType: 'CAPA', eventType: 'CAPACreated', status: 'in_progress', classification: '质量受限', scenarioId: approval.scenarioId, runId: approval.runId, payload: { capaId: `CAPA-SIM-${String(currentRuntime().sequence + 1).padStart(4, '0')}`, subject: approval.subject, sourceApprovalId: approval.id, owner: '质量保证组', status: 'CAPA 草稿已创建' } });
  addAudit(decision === 'approved' ? '审批已通过' : '审批已驳回', `${approval.id} 已由 ${roleId} ${decision === 'approved' ? '批准；已生成受控模拟写回' : '驳回；未执行模拟写回'}。`, roleId);
  return { approval, run, overview: getMockSimulationOverviewInContext(roleId) };
}

function resetMockSimulationInContext(roleId) {
  if (roleId !== 'executive') return { error: '仅管理角色可重置模拟运行时。' };
  Object.values(runtimeRecords).forEach((records) => records.splice(0));
  Object.values(connectorFaults).forEach((state) => { state.faultId = 'none'; state.changedAt = null; state.changedBy = null; });
  runs.splice(0); approvals.splice(0); audit.splice(0); alerts.splice(0); currentRuntime().sequence = 0;
  addAudit('模拟运行时已重置', '已清除运行时事件、OA 审批、写回结果和审计；基础种子数据保持不变。', roleId);
  return { overview: getMockSimulationOverviewInContext(roleId) };
}

export const getMockSystemRecords = (systemId) => readInContext(() => getMockSystemRecordsInContext(systemId));
export const getMockScenarioSemanticFacts = (runId) => readInContext(() => getMockScenarioSemanticFactsInContext(runId));
export const getMockConnectorCatalog = () => readInContext(getMockConnectorCatalogInContext);
export const getMockSimulationOverview = (roleId) => readInContext(() => getMockSimulationOverviewInContext(roleId));
export const getMockSimulationAlerts = (roleId) => readInContext(() => getMockSimulationAlertsInContext(roleId));
export const recordMockScenarioSemanticValidation = (runId, validation) => mutateInContext(() => recordMockScenarioSemanticValidationInContext(runId, validation));
export const setMockConnectorFault = (systemId, faultId, roleId) => mutateInContext(() => setMockConnectorFaultInContext(systemId, faultId, roleId));
export const runMockScenario = (id, roleId) => mutateInContext(() => runMockScenarioInContext(id, roleId));
export const decideMockApproval = (id, decision, roleId) => mutateInContext(() => decideMockApprovalInContext(id, decision, roleId));
export const resetMockSimulation = (roleId) => mutateInContext(() => resetMockSimulationInContext(roleId));

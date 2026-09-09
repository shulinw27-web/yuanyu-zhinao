import { procurementScenario } from '../data/seed.js';
import { validateCoreObjectBindings } from './core-meta-object-service.js';
import { mutateRiskProcurementWithEvent, readRiskProcurementState } from './risk-procurement-store.js';

const NAMESPACE = 'procurement_runtime';
const SCENARIO_KEY = 'scenario';
const initialScenario = () => structuredClone(procurementScenario);

const getScenarioCoreBindings = () => [
  { type: 'Person', id: 'usr-004', status: 'active', source: 'OA' },
  { type: 'RawMaterial', id: 'RMB-VC-20260718', status: 'released', source: 'ERP/LIMS' },
  { type: 'Product', id: 'FG-SLEEP-20260812', status: 'released', source: 'MES/LIMS' }
];

const clone = (source) => {
  const scenario = structuredClone(source);
  scenario.execution.sourceMode = 'mock';
  scenario.execution.externalReceipt = null;
  scenario.execution.businessCompleted = false;
  scenario.execution.receiptStatus = 'simulated_only';
  const coreObjectBindings = getScenarioCoreBindings();
  scenario.coreMetaObjectBindings = coreObjectBindings;
  scenario.coreMetaObjectValidation = validateCoreObjectBindings({ processType: 'procurement', bindings: coreObjectBindings });
  return scenario;
};

export async function getProcurementScenario() { return clone(await readRiskProcurementState(NAMESPACE, SCENARIO_KEY, initialScenario)); }

export function launchProcurement(role, coreObjectBindings = getScenarioCoreBindings(), identityScope = {}) {
  if (process.env.NODE_ENV === 'production' || process.env.CONNECTOR_MOCK_MODE === 'disabled') return { error: '真实 ERP 写入适配器尚未接入；不能使用演示回执代替真实申请。', code: 'LIVE_PROCUREMENT_CONNECTOR_REQUIRED' };
  if (!['executive', 'procurement_manager'].includes(role.id)) return { error: '当前角色缺少“采购流程发起”条线权限，不能创建 ERP 采购申请。可先提交采购需求并路由采购负责人。' };
  const coreValidation = validateCoreObjectBindings({ processType: 'procurement', bindings: coreObjectBindings });
  if (coreValidation.status !== 'passed') return { error: `采购流程核心元对象校验未通过：${coreValidation.missing.join('、') || coreValidation.invalid.map((item) => item.reason).join('、')}。` };
  return mutateRiskProcurementWithEvent({ namespace: NAMESPACE, key: SCENARIO_KEY, initialValue: initialScenario, mutation: (scenario) => {
    if (scenario.execution.status !== '方案待发起') return { commit: false, result: clone(scenario) };
    scenario.execution.status = '审批中';
    scenario.execution.requisitionId = 'PR-2026-0810-VC01';
    scenario.workflow = scenario.workflow.map((step) => step.id === 'approval' ? { ...step, status: '审批中' } : step.id === 'erp' ? { ...step, status: '草稿已创建' } : step);
    scenario.audit.unshift({ time: '10:20', actor: role.name, action: '模拟发起原料采购协同', detail: '仅在本地演练创建采购草稿 PR-2026-0810-VC01 并模拟审批路由；未向真实 ERP 提交。' });
    const result = clone(scenario);
    return { value: scenario, result, event: {
      type: 'procurement.requisition.launched', version: 1, aggregateType: 'ProcurementRequisition', aggregateId: scenario.execution.requisitionId,
      tenantId: identityScope.tenantId, actor: { type: 'role', id: role.id, name: role.name },
      payload: { requisitionId: scenario.execution.requisitionId, status: scenario.execution.status, selectedSupplier: scenario.execution.selectedSupplier }
    }};
  }});
}

export function approveProcurement(role, coreObjectBindings = getScenarioCoreBindings(), identityScope = {}) {
  if (process.env.NODE_ENV === 'production' || process.env.CONNECTOR_MOCK_MODE === 'disabled') return { error: '真实 ERP 写入适配器尚未接入；不能使用演示回执代替真实申请。', code: 'LIVE_PROCUREMENT_CONNECTOR_REQUIRED' };
  if (!['executive'].includes(role.id)) return { error: '当前角色缺少“采购审批”条线权限，不能批准该采购协同。' };
  const coreValidation = validateCoreObjectBindings({ processType: 'procurement', bindings: coreObjectBindings });
  if (coreValidation.status !== 'passed') return { error: `采购审批缺少有效核心元对象引用：${coreValidation.missing.join('、') || '存在已失效对象'}。` };
  return mutateRiskProcurementWithEvent({ namespace: NAMESPACE, key: SCENARIO_KEY, initialValue: initialScenario, mutation: (scenario) => {
    if (scenario.execution.status !== '审批中') return { commit: false, result: clone(scenario) };
    scenario.execution.status = '已提交执行';
    scenario.workflow = scenario.workflow.map((step) => step.id === 'approval' ? { ...step, status: '已批准' } : step.id === 'erp' ? { ...step, status: '已创建' } : step.id === 'notify' ? { ...step, status: '已执行' } : step);
    scenario.audit.unshift({ time: '10:23', actor: role.name, action: '模拟批准采购协同', detail: '演练审批已通过；未取得真实 ERP 受理回执，也未向外部供应商或人员发送通知。' });
    const result = clone(scenario);
    return { value: scenario, result, event: {
      type: 'procurement.requisition.approved', version: 1, aggregateType: 'ProcurementRequisition', aggregateId: scenario.execution.requisitionId,
      tenantId: identityScope.tenantId, actor: { type: 'role', id: role.id, name: role.name },
      payload: { requisitionId: scenario.execution.requisitionId, status: scenario.execution.status, selectedSupplier: scenario.execution.selectedSupplier }
    }};
  }});
}

import { riskCases, dashboardMetrics, worldGraph, notificationRecords, connectedSystems, platformStatus } from '../data/seed.js';
import { canAccessRisk, redactRisk } from './authorization-service.js';
import { getMockSimulationAlerts, getMockSimulationOverview } from './mock-scenario-service.js';
import { getAlertingNotifications, getSeverityDefinition } from '../domains/alerting/alerting-service.js';
import { mutateRiskProcurementWithEvent, readRiskProcurementState } from './risk-procurement-store.js';

const initialRisks = () => structuredClone(riskCases);
const currentRisks = () => readRiskProcurementState('risk_runtime', 'cases', initialRisks);
const enrichRisk = async (risk, roleId, subjectId) => ({
  ...risk,
  severityDefinition: await getSeverityDefinition(risk.severity),
  notificationSummary: { channels: (await getAlertingNotifications(roleId, subjectId)).filter((item) => item.riskId === risk.id).map((item) => item.channel) }
});

export async function getDashboard(roleId, subjectId) {
  const visible = await Promise.all((await currentRisks()).filter((risk) => canAccessRisk(risk, roleId, subjectId)).map((risk) => enrichRisk(redactRisk(risk, roleId), roleId, subjectId)));
  const simulation = await getMockSimulationOverview(roleId);
  const unhealthy = simulation.connectors.filter((item) => item.health !== 'healthy');
  return { metrics: { ...dashboardMetrics, visibleRisks: visible.length + simulation.alerts.length, activeSimulationAlerts: simulation.alerts.length, runtimeEvents: simulation.runtimeEventCount }, risks: visible, systems: connectedSystems, platform: platformStatus, monitoring: {
    streamHealth: unhealthy.length ? '受限' : '正常', lastEvent: simulation.runtimeEvents[0]?.occurredAt || '09:48:22', eventsPerMinute: 36, modelStatus: unhealthy.length ? `总控 AI 在线 · ${unhealthy.length} 个 Mock Connector 受限` : '总控 AI 在线 · 3 个子模型可用'
  }};
}

export async function getRiskList(roleId, subjectId) {
  return Promise.all((await currentRisks()).filter((risk) => canAccessRisk(risk, roleId, subjectId)).map((risk) => enrichRisk(redactRisk(risk, roleId), roleId, subjectId)));
}

export async function getRiskById(id, roleId, subjectId) {
  const risk = (await currentRisks()).find((item) => item.id === id);
  if (!risk || !canAccessRisk(risk, roleId, subjectId)) return null;
  return enrichRisk(redactRisk(risk, roleId), roleId, subjectId);
}

export function acknowledgeRisk(id, role) {
  return mutateRiskProcurementWithEvent({ namespace: 'risk_runtime', key: 'cases', initialValue: initialRisks, mutation: (risks) => {
    const risk = risks.find((item) => item.id === id);
    if (!risk) return { commit: false, result: null };
    if (risk.status === '处理中' || risk.status === '已审批') return { commit: false, result: structuredClone(risk) };
    risk.status = '处理中';
    risk.audit.unshift({ time: '10:01', actor: role.name, action: '确认风险事件', detail: '确认进入人工处置流程；冻结建议仍需审批。' });
    const result = structuredClone(risk);
    return {
      value: risks,
      result,
      event: {
        type: 'risk.case.acknowledged', version: 1, aggregateType: 'RiskCase', aggregateId: risk.id,
        organizationId: risk.organizationId, actor: { type: 'role', id: role.id, name: role.name },
        payload: { riskId: risk.id, severity: risk.severity, status: risk.status }
      }
    };
  }});
}

export function approveRisk(id, role) {
  return mutateRiskProcurementWithEvent({ namespace: 'risk_runtime', key: 'cases', initialValue: initialRisks, mutation: (risks) => {
    const risk = risks.find((item) => item.id === id);
    if (!risk) return { commit: false, result: null };
    if (risk.status === '已审批') return { commit: false, result: structuredClone(risk) };
    risk.status = '已审批';
    risk.actions = risk.actions.map((item) => item.label === '冻结建议' ? { ...item, status: '已批准' } : item);
    risk.audit.unshift({ time: '10:03', actor: role.name, action: '批准冻结建议', detail: '模拟动作已写入审计；Demo 不调用真实生产系统。' });
    const result = structuredClone(risk);
    return {
      value: risks,
      result,
      event: {
        type: 'risk.case.disposition_approved', version: 1, aggregateType: 'RiskCase', aggregateId: risk.id,
        organizationId: risk.organizationId, actor: { type: 'role', id: role.id, name: role.name },
        payload: { riskId: risk.id, severity: risk.severity, status: risk.status, disposition: 'freeze_recommendation' }
      }
    };
  }});
}

export function getWorldModel(roleId) {
  const graph = structuredClone(worldGraph);
  if (roleId === 'marketing_manager') {
    graph.nodes = graph.nodes.filter((node) => !['raw', 'test', 'pb1', 'pb2'].includes(node.id));
    graph.edges = graph.edges.filter(([source, target]) => graph.nodes.some((node) => node.id === source) && graph.nodes.some((node) => node.id === target));
  }
  if (roleId === 'production_manager') {
    graph.nodes = graph.nodes.map((node) => node.id === 'test' ? { ...node, sub: '检验异常（指标受限）' } : node);
  }
  if (roleId === 'procurement_manager') {
    graph.nodes = graph.nodes.map((node) => node.id === 'test' ? { ...node, sub: '检验合规状态（指标受限）' } : node);
  }
  return graph;
}

export async function getNotifications(roleId, subjectId) {
  const risks = await currentRisks();
  let records = notificationRecords;
  if (roleId === 'marketing_manager') records = notificationRecords.filter((n) => n.policy.includes('订单'));
  if (roleId === 'production_manager') records = notificationRecords.filter((n) => n.policy.includes('生产') || n.policy.includes('值班'));
  if (roleId === 'procurement_manager') records = notificationRecords.filter((n) => n.policy.includes('采购'));
  const baseline = records.filter((notification) => {
    const risk = risks.find((item) => item.id === notification.riskId);
    return risk && canAccessRisk(risk, roleId, subjectId);
  }).map((notification) => {
    const risk = risks.find((item) => item.id === notification.riskId);
    return {
      ...notification,
      title: risk?.title || notification.policy,
      description: risk?.summary || `${notification.channel} 通知状态：${notification.status}`,
      severity: risk?.severity || 'P2',
      riskStatus: risk?.status || '已送达'
    };
  });
  const orchestrated = (await getAlertingNotifications(roleId, subjectId)).map((notification) => {
    const risk = risks.find((item) => item.id === notification.riskId);
    return risk ? { ...notification, title: risk.title, description: risk.summary, riskStatus: risk.status } : notification;
  });
  return [...await getMockSimulationAlerts(roleId), ...orchestrated, ...baseline];
}

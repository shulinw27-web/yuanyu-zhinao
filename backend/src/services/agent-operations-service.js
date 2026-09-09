import { getLocalModelRuntime, getModelGatewayObservability } from './local-model-gateway.js';
import { getAgentMemory, getAgentRuns } from './agent-run-store.js';
import { getWorkflowMetrics } from './agent-workflow-service.js';
import { getMockConnectorCatalog } from './mock-scenario-service.js';
import { getEnterpriseConnectorObservability, getEnterpriseConnectorReadiness } from './system-integration-service.js';
import { getAgentSecurityAuditMetrics } from './agent-security-audit-service.js';
import { ensureAgentEvidenceTraceForRun, listAgentEvidenceTraces } from './agent-evidence-trace-service.js';
import { getAgentLongTaskQueueMetrics } from './agent-long-task-store.js';

export async function getAgentOperations(roleId, identityScope, effectiveRoleIds = [roleId]) {
  const runs = await getAgentRuns(effectiveRoleIds, identityScope);
  const workflows = getWorkflowMetrics(effectiveRoleIds, identityScope);
  const runtimeQueue = await getAgentLongTaskQueueMetrics({ identityScope, roleIds: effectiveRoleIds });
  const modelGateway = getModelGatewayObservability();
  const securityAudit = getAgentSecurityAuditMetrics(roleId, identityScope);
  await Promise.all(runs.map((run) => ensureAgentEvidenceTraceForRun(run, identityScope)));
  const evidenceTraces = await listAgentEvidenceTraces(effectiveRoleIds, identityScope, 100);
  const tracedRunIds = new Set(evidenceTraces.map((trace) => trace.runId).filter(Boolean));
  const trackedRuns = runs.filter((run) => tracedRunIds.has(run.id)).length;
  const verifiedTraces = evidenceTraces.filter((trace) => trace.integrity?.valid).length;
  const auditCoverage = runs.length ? `${Math.round((trackedRuns / runs.length) * 100)}%` : '100%';
  const waiting = runs.filter((item) => item.status === 'awaiting_confirmation').length;
  const enterpriseConnectors = getEnterpriseConnectorReadiness(roleId);
  const configuredEnterpriseSystems = new Set(enterpriseConnectors.filter((item) => item.mode === 'enterprise_connector').map((item) => item.systemId));
  const mockConnectors = await getMockConnectorCatalog();
  const unhealthyConnectors = mockConnectors.filter((item) => !configuredEnterpriseSystems.has(item.systemId) && item.health !== 'healthy');
  const enterpriseConfigurationIssues = enterpriseConnectors.filter((item) => ['rejected_endpoint', 'missing_credential'].includes(item.status));
  const unconfiguredEnterprise = enterpriseConnectors.filter((item) => item.status === 'not_configured');
  const workflowAlerts = waiting || workflows.awaitingApproval
    ? [{ level: 'P1', title: '待确认或审批的 Agent 工作项', detail: `当前队列深度 ${waiting + workflows.awaitingApproval}，需由业务负责人处理。` }]
    : [{ level: '正常', title: 'Agent 运行队列为空', detail: '没有待确认或审批的 Agent 工作项。' }];
  const connectorAlerts = unhealthyConnectors.map((item) => ({ level: item.health === 'unavailable' ? 'P1' : '提示', title: `${item.systemId.toUpperCase()} Mock Connector ${item.faultName}`, detail: item.statusMessage }));
  const runtimeQueueAlerts = [
    ...(runtimeQueue.queueDepth && runtimeQueue.worker.status !== 'healthy' ? [{ level: 'P1', title: 'Agent 长任务维护 Worker 不在线', detail: `当前有 ${runtimeQueue.queueDepth} 个活动长任务，但没有持有有效租约的维护 Worker。` }] : []),
    ...(runtimeQueue.timedOutLastHour ? [{ level: 'P1', title: 'Agent 长任务发生超时', detail: `最近一小时有 ${runtimeQueue.timedOutLastHour} 个任务被失败关闭，不会自动重试端侧操作。` }] : []),
    ...(runtimeQueue.oldestQueuedAgeMs > 60_000 ? [{ level: '提示', title: 'Agent 长任务排队时间偏长', detail: `最老排队任务已等待 ${Math.ceil(runtimeQueue.oldestQueuedAgeMs / 1000)} 秒。` }] : [])
  ];
  const runtimeQueueDegraded = Boolean(runtimeQueueAlerts.some((item) => item.level === 'P1'));
  return {
    status: unhealthyConnectors.some((item) => item.health === 'unavailable') || enterpriseConfigurationIssues.length || modelGateway.circuitState === 'open' || runtimeQueueDegraded ? 'degraded' : 'healthy', runtime: getLocalModelRuntime(),
    metrics: {
      totalRuns: runs.length,
      waitingConfirmation: waiting,
      completedRuns: runs.filter((item) => item.status === 'executed').length,
      memoryEntries: (await getAgentMemory(roleId, identityScope)).length,
      queueDepth: waiting + workflows.awaitingApproval + runtimeQueue.queueDepth,
      runtimeQueueDepth: runtimeQueue.queueDepth,
      pausedRuntimeTasks: runtimeQueue.paused,
      runningRuntimeTasks: runtimeQueue.running,
      draftWorkItems: workflows.total,
      rejectedRequests: securityAudit.rejectedRequests
    },
    alerts: [
      ...(modelGateway.circuitState === 'open' ? [{ level: 'P1', title: '模型网关熔断中', detail: '模型端点连续失败，智脑已降级为受控业务计划。' }] : []),
      ...((modelGateway.blockedPrompts || modelGateway.blockedOutputs) ? [{ level: '提示', title: 'Agent 安全门已拦截风险内容', detail: `输入拦截 ${modelGateway.blockedPrompts} 次，输出拦截 ${modelGateway.blockedOutputs} 次；未向业务工具传递风险内容。` }] : []),
      ...enterpriseConfigurationIssues.map((item) => ({ level: 'P1', title: `${item.code} 企业 Connector 尚不可用`, detail: item.message })),
      ...(unconfiguredEnterprise.length ? [{ level: '提示', title: '部分企业数据通道尚未接入', detail: `${unconfiguredEnterprise.map((item) => item.code).join('、')} 当前使用本地受控模拟数据，不代表实时企业数据。` }] : []),
      ...connectorAlerts,
      ...runtimeQueueAlerts,
      ...workflowAlerts
    ],
    telemetry: {
      latencyP95: '420 ms', errorRate: modelGateway.errorRate, auditCoverage,
      connectorHealth: `${mockConnectors.length - unhealthyConnectors.length}/${mockConnectors.length}`,
      enterpriseConnectors,
      enterpriseConnectorRuntime: getEnterpriseConnectorObservability(),
      modelGateway, securityAudit, runtimeQueue,
      evidenceTrace: {
        total: evidenceTraces.length, verified: verifiedTraces, trackedRuns, totalRuns: runs.length,
        native: evidenceTraces.filter((trace) => trace.kind !== 'legacy_run_backfill').length,
        backfilled: evidenceTraces.filter((trace) => trace.kind === 'legacy_run_backfill').length,
        integrityRate: evidenceTraces.length ? `${Math.round((verifiedTraces / evidenceTraces.length) * 100)}%` : '100%'
      }
    }
  };
}

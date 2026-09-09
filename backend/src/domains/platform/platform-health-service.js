import { getRuntimeStoreInfo } from '../../repositories/runtime-state-repository.js';
import { getDomainEventOutboxMetrics, getDomainEventStoreInfo, probeDomainEventStore } from '../events/domain-event-outbox.js';
import { probeKmsAdapter } from '../../services/key-center/kms-adapter.js';
import { getIdentitySessionStoreInfo, probeIdentitySessionStore } from '../../services/identity-session-service.js';
import { getAgentLongTaskStoreInfo, probeAgentLongTaskStore } from '../../services/agent-long-task-store.js';
import { getAgentRunStoreInfo, probeAgentRunStore } from '../../services/agent-run-store.js';
import { getAgentEvidenceTraceStoreInfo, probeAgentEvidenceTraceStore } from '../../services/agent-evidence-trace-service.js';
import { getAgentConversationStoreInfo, probeAgentConversationStore } from '../../services/agent-conversation-service.js';
import { getAgentLearningStoreInfo, probeAgentLearningStore } from '../../services/agent-learning-governance-service.js';
import { getAgentOrchestrationStoreInfo, probeAgentOrchestrationStore } from '../../services/agent-orchestration-service.js';
import { getIAMStoreInfo, probeIAMStore } from '../../services/iam-store.js';
import { getRiskProcurementStoreInfo, probeRiskProcurementStore } from '../../services/risk-procurement-store.js';
import { getAlertingStoreInfo, probeAlertingStore } from '../alerting/alerting-store.js';
import { getSimulationStoreInfo, probeSimulationStore } from '../../services/mock-scenario-service.js';
import { getSemanticGovernanceStoreInfo, probeSemanticGovernanceStore } from '../../services/semantic-operations-task-service.js';

const startedAt = new Date().toISOString();

export const getPlatformLiveness = () => ({
  status: 'ok', service: 'healthcare-ai-demo-api', startedAt,
  uptimeSeconds: Math.floor(process.uptime()), time: new Date().toISOString()
});

export async function getPlatformReadiness() {
  try {
    const runtimeStore = getRuntimeStoreInfo();
    const outbox = await getDomainEventOutboxMetrics();
    const domainEventStore = getDomainEventStoreInfo();
    const domainEventStoreProbe = await probeDomainEventStore();
    const keyCenter = await probeKmsAdapter();
    const identitySessionStore = getIdentitySessionStoreInfo();
    const identitySessionProbe = await probeIdentitySessionStore();
    const agentLongTaskStore = getAgentLongTaskStoreInfo();
    const agentLongTaskStoreProbe = await probeAgentLongTaskStore();
    const agentRunStore = getAgentRunStoreInfo();
    const agentRunStoreProbe = await probeAgentRunStore();
    const evidenceTraceStore = getAgentEvidenceTraceStoreInfo();
    const evidenceTraceStoreProbe = await probeAgentEvidenceTraceStore();
    const agentConversationStore = getAgentConversationStoreInfo();
    const agentConversationStoreProbe = await probeAgentConversationStore();
    const agentLearningStore = getAgentLearningStoreInfo();
    const agentLearningStoreProbe = await probeAgentLearningStore();
    const agentOrchestrationStore = getAgentOrchestrationStoreInfo();
    const agentOrchestrationStoreProbe = await probeAgentOrchestrationStore();
    const iamStore = getIAMStoreInfo();
    const iamStoreProbe = await probeIAMStore();
    const riskProcurementStore = getRiskProcurementStoreInfo();
    const riskProcurementStoreProbe = await probeRiskProcurementStore();
    const alertingStore = getAlertingStoreInfo();
    const alertingStoreProbe = await probeAlertingStore();
    const simulationStore = getSimulationStoreInfo();
    const simulationStoreProbe = await probeSimulationStore();
    const semanticGovernanceStore = getSemanticGovernanceStoreInfo();
    const semanticGovernanceStoreProbe = await probeSemanticGovernanceStore();
    const dependenciesReady = keyCenter.available && domainEventStoreProbe.ready && identitySessionProbe.ready && iamStoreProbe.ready && riskProcurementStoreProbe.ready && alertingStoreProbe.ready && simulationStoreProbe.ready && semanticGovernanceStoreProbe.ready && agentLongTaskStoreProbe.ready && agentRunStoreProbe.ready && evidenceTraceStoreProbe.ready && agentConversationStoreProbe.ready && agentLearningStoreProbe.ready && agentOrchestrationStoreProbe.ready;
    return {
      status: dependenciesReady ? 'ready' : 'not_ready',
      checks: {
        runtimeStore: { status: 'ready', driver: runtimeStore.driver, persistence: runtimeStore.persistence, schemaVersion: runtimeStore.schemaVersion },
        domainEventOutbox: { status: outbox.deadLetter ? 'degraded' : 'ready', pending: outbox.pending, deadLetter: outbox.deadLetter },
        domainEventStore: { status: domainEventStoreProbe.ready ? 'ready' : 'failed', driver: domainEventStore.driver, persistence: domainEventStore.persistence, schemaVersion: domainEventStore.schemaVersion },
        externalBroker: { status: process.env.EVENT_BROKER_TYPE ? 'configured' : 'optional', type: process.env.EVENT_BROKER_TYPE || 'projection' },
        keyCenter: { status: keyCenter.available ? 'ready' : 'failed', provider: keyCenter.provider, mode: keyCenter.mode },
        identitySessionStore: { status: identitySessionProbe.ready ? 'ready' : 'failed', driver: identitySessionStore.driver, persistence: identitySessionStore.persistence },
        iamStore: { status: iamStoreProbe.ready ? 'ready' : 'failed', driver: iamStore.driver, persistence: iamStore.persistence, schemaVersion: iamStore.schemaVersion },
        riskProcurementStore: { status: riskProcurementStoreProbe.ready ? 'ready' : 'failed', driver: riskProcurementStore.driver, persistence: riskProcurementStore.persistence, schemaVersion: riskProcurementStore.schemaVersion },
        alertingStore: { status: alertingStoreProbe.ready ? 'ready' : 'failed', driver: alertingStore.driver, persistence: alertingStore.persistence, schemaVersion: alertingStore.schemaVersion },
        simulationStore: { status: simulationStoreProbe.ready ? 'ready' : 'failed', driver: simulationStore.driver, persistence: simulationStore.persistence, schemaVersion: simulationStore.schemaVersion },
        semanticGovernanceStore: { status: semanticGovernanceStoreProbe.ready ? 'ready' : 'failed', driver: semanticGovernanceStore.driver, persistence: semanticGovernanceStore.persistence, schemaVersion: semanticGovernanceStore.schemaVersion },
        agentLongTaskStore: { status: agentLongTaskStoreProbe.ready ? 'ready' : 'failed', driver: agentLongTaskStore.driver, persistence: agentLongTaskStore.persistence, schemaVersion: agentLongTaskStore.schemaVersion, transitionConsumer: agentLongTaskStoreProbe.transitionConsumer },
        agentRunStore: { status: agentRunStoreProbe.ready ? 'ready' : 'failed', driver: agentRunStore.driver, persistence: agentRunStore.persistence, schemaVersion: agentRunStore.schemaVersion },
        evidenceTraceStore: { status: evidenceTraceStoreProbe.ready ? 'ready' : 'failed', driver: evidenceTraceStore.driver, persistence: evidenceTraceStore.persistence, schemaVersion: evidenceTraceStore.schemaVersion },
        agentConversationStore: { status: agentConversationStoreProbe.ready ? 'ready' : 'failed', driver: agentConversationStore.driver, persistence: agentConversationStore.persistence, schemaVersion: agentConversationStore.schemaVersion },
        agentLearningStore: { status: agentLearningStoreProbe.ready ? 'ready' : 'failed', driver: agentLearningStore.driver, persistence: agentLearningStore.persistence, schemaVersion: agentLearningStore.schemaVersion },
        agentOrchestrationStore: { status: agentOrchestrationStoreProbe.ready ? 'ready' : 'failed', driver: agentOrchestrationStore.driver, persistence: agentOrchestrationStore.persistence, schemaVersion: agentOrchestrationStore.schemaVersion }
      },
      time: new Date().toISOString()
    };
  } catch {
    return { status: 'not_ready', checks: { runtimeStore: { status: 'failed' } }, time: new Date().toISOString() };
  }
}

export function getSystemCapabilities() {
  const runtimeStore = getRuntimeStoreInfo();
  const agentLongTaskStore = getAgentLongTaskStoreInfo();
  const agentRunStore = getAgentRunStoreInfo();
  const evidenceTraceStore = getAgentEvidenceTraceStoreInfo();
  const agentConversationStore = getAgentConversationStoreInfo();
  const agentLearningStore = getAgentLearningStoreInfo();
  const agentOrchestrationStore = getAgentOrchestrationStoreInfo();
  const iamStore = getIAMStoreInfo();
  const riskProcurementStore = getRiskProcurementStoreInfo();
  const alertingStore = getAlertingStoreInfo();
  const simulationStore = getSimulationStoreInfo();
  const semanticGovernanceStore = getSemanticGovernanceStoreInfo();
  const domainEventStore = getDomainEventStoreInfo();
  return {
    apiVersion: '0.3.0',
    runtime: { store: runtimeStore.driver, persistence: runtimeStore.persistence, multiProcessTransactions: runtimeStore.driver === 'sqlite', iamStore: iamStore.driver, iamPersistence: iamStore.persistence, riskProcurementStore: riskProcurementStore.driver, riskProcurementPersistence: riskProcurementStore.persistence, alertingStore: alertingStore.driver, alertingPersistence: alertingStore.persistence, simulationStore: simulationStore.driver, simulationPersistence: simulationStore.persistence, semanticGovernanceStore: semanticGovernanceStore.driver, semanticGovernancePersistence: semanticGovernanceStore.persistence, agentLongTaskStore: agentLongTaskStore.driver, agentLongTaskPersistence: agentLongTaskStore.persistence, agentRunStore: agentRunStore.driver, agentRunPersistence: agentRunStore.persistence, evidenceTraceStore: evidenceTraceStore.driver, evidenceTracePersistence: evidenceTraceStore.persistence, agentConversationStore: agentConversationStore.driver, agentConversationPersistence: agentConversationStore.persistence, agentLearningStore: agentLearningStore.driver, agentLearningPersistence: agentLearningStore.persistence, agentOrchestrationStore: agentOrchestrationStore.driver, agentOrchestrationPersistence: agentOrchestrationStore.persistence },
    domainEvents: { store: domainEventStore.driver, persistence: domainEventStore.persistence, transactionalOutbox: true, consumerLeases: true, idempotencyCheckpoints: true, deadLetterReplay: true, brokerAdapters: ['projection', 'kafka', 'rabbitmq', 'webhook'] },
    agent: { parallelConversations: true, contextCompaction: true, confirmationTokens: true, evidenceHashChain: true, toolReceipts: true, scheduledOrchestrations: true, dependencyGraph: true, resumableCheckpoints: true },
    clients: { adminWeb: true, zhinaoWeb: true, mobile: true, electron: true },
    demoConstraints: { productionDatabase: false, distributedBrokerBundled: false, realTelephonyEnabled: false }
  };
}

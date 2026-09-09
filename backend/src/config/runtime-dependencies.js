import { createPostgresRuntimeStateRepository } from '../repositories/postgres-runtime-state-repository.js';
import { createPostgresAgentLongTaskRepository } from '../repositories/postgres-agent-long-task-repository.js';
import { configureIdentitySessionRepository } from '../services/identity-session-service.js';
import { configureAgentLongTaskRepository } from '../services/agent-long-task-store.js';
import { configureAgentRunRepository } from '../services/agent-run-store.js';
import { configureAgentEvidenceTraceRepository } from '../services/agent-evidence-trace-service.js';
import { configureAgentConversationRepository } from '../services/agent-conversation-service.js';
import { configureAgentLearningRepository } from '../services/agent-learning-governance-service.js';
import { configureAgentOrchestrationRepository } from '../services/agent-orchestration-service.js';
import { configureIAMRepository } from '../services/iam-store.js';
import { configureRiskProcurementRepository } from '../services/risk-procurement-store.js';
import { configureDomainEventRepository } from '../domains/events/domain-event-outbox.js';
import { configureDomainEventConsumerRepository } from '../workers/domain-event-worker.js';
import { configureAlertingRepository } from '../domains/alerting/alerting-store.js';
import { configureSimulationRepository } from '../services/mock-scenario-service.js';
import { configureSemanticGovernanceRepository } from '../services/semantic-operations-task-service.js';
import { registerConfiguredRemoteCredentialProvider } from '../services/key-center/remote-credential-provider.js';

export async function configureRuntimeDependencies(configuration) {
  const resources = [];
  const runtimeRepository = async () => {
    const repository = await createPostgresRuntimeStateRepository();
    resources.push(repository);
    return repository;
  };
  if (configuration.identitySessionStoreDriver === 'postgres') configureIdentitySessionRepository(await runtimeRepository());
  if (configuration.iamStoreDriver === 'postgres') configureIAMRepository(await runtimeRepository());
  if (configuration.riskProcurementStoreDriver === 'postgres') configureRiskProcurementRepository(await runtimeRepository());
  if (configuration.alertingStoreDriver === 'postgres') configureAlertingRepository(await runtimeRepository());
  if (configuration.simulationStoreDriver === 'postgres') configureSimulationRepository(await runtimeRepository());
  if (configuration.semanticGovernanceStoreDriver === 'postgres') configureSemanticGovernanceRepository(await runtimeRepository());
  if (configuration.domainEventStoreDriver === 'postgres') {
    const repository = await runtimeRepository();
    configureDomainEventRepository(repository);
    configureDomainEventConsumerRepository(repository);
  }
  if (configuration.agentRuntimeTaskStoreDriver === 'postgres') {
    const repository = await createPostgresAgentLongTaskRepository();
    resources.push(repository);
    configureAgentLongTaskRepository(repository);
  }
  if (configuration.agentRunStoreDriver === 'postgres') configureAgentRunRepository(await runtimeRepository());
  if (configuration.evidenceTraceStoreDriver === 'postgres') configureAgentEvidenceTraceRepository(await runtimeRepository());
  if (configuration.agentConversationStoreDriver === 'postgres') configureAgentConversationRepository(await runtimeRepository());
  if (configuration.agentLearningStoreDriver === 'postgres') configureAgentLearningRepository(await runtimeRepository());
  if (configuration.agentOrchestrationStoreDriver === 'postgres') configureAgentOrchestrationRepository(await runtimeRepository());
  registerConfiguredRemoteCredentialProvider();
  return Object.freeze({
    close: async () => Promise.allSettled(resources.map((resource) => resource?.close?.()).filter(Boolean))
  });
}

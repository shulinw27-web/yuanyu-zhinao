const definitions = [
  ['anomaly.report.changed', 'AnomalyReport', ['reportId', 'revision', 'status', 'action']],
  ['knowledge.study.changed', 'KnowledgeStudy', ['documentId', 'revision']],
  ['knowledge.material_review.submitted', 'KnowledgeMaterialReview', ['revision', 'status']],
  ['knowledge.material_review.decided', 'KnowledgeMaterialReview', ['revision', 'status']],
  ['knowledge.material_review.archived', 'KnowledgeMaterialReview', ['revision', 'status']],
  ['knowledge.material_review.assigned', 'KnowledgeMaterialReview', ['revision', 'status']],
  ['knowledge.document.changed', 'KnowledgeDocument', ['documentId', 'revision', 'status', 'contentHash']],
  ['risk.case.acknowledged', 'RiskCase', ['riskId', 'severity', 'status']],
  ['risk.case.disposition_approved', 'RiskCase', ['riskId', 'severity', 'status', 'disposition']],
  ['procurement.requisition.launched', 'ProcurementRequisition', ['requisitionId', 'status']],
  ['procurement.requisition.approved', 'ProcurementRequisition', ['requisitionId', 'status']],
  ['iam.user.authorization_changed', 'IAMUser', ['userId', 'roleIds', 'status', 'policyVersion']],
  ['iam.role_policy.published', 'IAMRolePolicy', ['roleId', 'policyVersion', 'dataScopeMode']],
  ['agent.workflow.draft_created', 'AgentWorkItem', ['workItemId', 'commandId', 'runId', 'status']],
  ['agent.tool_execution.succeeded', 'AgentRun', ['commandId', 'status']],
  ['agent.tool_execution.failed', 'AgentRun', ['commandId', 'status', 'reasonCode']],
  ['alert.classified', 'Alert', ['severity', 'sourceSystem', 'eventType', 'deliveryCount']],
  ['alerting.configuration.published', 'AlertingConfiguration', ['configurationVersion']],
  ['alert.voice.receipt_recorded', 'VoiceCall', ['action', 'riskId', 'receiptStatus']],
  ['alert.escalation.requested', 'VoiceCall', ['action', 'riskId', 'receiptStatus', 'escalationDeliveryIds']],
  ['governance.meta_model.published', 'MetaModel', ['version', 'validationStatus']],
  ['governance.world_model.published', 'WorldModel', ['version', 'templateId', 'targetId', 'validationStatus']]
].map(([type, aggregateType, requiredPayload]) => Object.freeze({ type, version: 1, aggregateType, requiredPayload: Object.freeze(requiredPayload) }));

const contracts = new Map(definitions.map((item) => [`${item.type}@${item.version}`, item]));

export const getDomainEventContractCatalog = () => definitions.map((item) => structuredClone(item));

export function validateDomainEventContract(event) {
  if (process.env.NODE_ENV === 'test' && String(event.type || '').startsWith('test.')) return { valid: true, testOnly: true };
  const contract = contracts.get(`${event.type}@${event.version}`);
  if (!contract) throw new Error(`Domain event contract is not registered: ${event.type}@${event.version}.`);
  if (event.aggregateType !== contract.aggregateType) throw new Error(`Domain event ${event.type} requires aggregateType ${contract.aggregateType}.`);
  const missing = contract.requiredPayload.filter((field) => !Object.hasOwn(event.payload || {}, field));
  if (missing.length) throw new Error(`Domain event ${event.type} is missing payload fields: ${missing.join(', ')}.`);
  return { valid: true, contract: structuredClone(contract) };
}

const failure = (message) => Object.assign(new Error(message), { code: 'WORKFLOW_CONNECTOR_RESPONSE_INVALID', status: 502 });
const clone = value => structuredClone(value);
const array = value => Array.isArray(value) ? value : [];
const status = value => ({ RUNNING: 'running', COMPLETED: 'completed', REJECTED: 'rejected', TERMINATED: 'cancelled', CANCELED: 'cancelled', CANCELLED: 'cancelled' })[String(value || '').toUpperCase()] || String(value || '').toLowerCase();
const action = value => ({ START: 'submitted', SUBMIT: 'submitted', ENTER: 'entered', APPROVE: 'approved', AGREE: 'approved', REJECT: 'rejected', COMPLETE: 'completed', CANCEL: 'cancelled', WITHDRAW: 'withdrawn', RETURN: 'returned' })[String(value || '').toUpperCase()] || String(value || '').toLowerCase();

const definition = (item, provider, shape) => ({
  provider,
  sourceId: String(item[shape.sourceId] || ''),
  code: String(item[shape.code] || item[shape.sourceId] || ''),
  name: String(item[shape.name] || ''),
  version: String(item[shape.version] || ''),
  purpose: String(item.purpose || item.description || ''),
  category: String(item.category || 'business'),
  businessDomain: String(item.businessDomain || item.domain || ''),
  riskLevel: String(item.riskLevel || 'medium'),
  dataClassification: String(item.dataClassification || 'internal'),
  updatedAt: String(item.updatedAt || item.modifiedAt || ''),
  nodes: array(item[shape.nodes]).map(node => ({ id: String(node.id || node.activityId || node.stepId || ''), type: String(node.type || node.kind || 'approval').toLowerCase(), label: String(node.label || node.name || ''), ...(node.actorRule ? { actorRule: String(node.actorRule) } : {}), ...(node.expression ? { expression: String(node.expression) } : {}) })),
  edges: array(item[shape.edges]).map(edge => ({ from: String(edge.from || edge.source || ''), to: String(edge.to || edge.target || ''), ...(edge.condition ? { condition: String(edge.condition) } : {}) })),
  fields: array(item[shape.fields]).map(field => ({ id: String(field.id || field.fieldId || field.key || ''), label: String(field.label || field.name || ''), type: String(field.type || 'string').toLowerCase(), required: field.required === true, semanticTarget: String(field.semanticTarget || ''), sensitivity: String(field.sensitivity || 'internal') })),
  bindings: array(item.bindings).map(binding => ({ objectType: String(binding.objectType || ''), field: String(binding.field || '') }))
});

const instance = (item, provider, shape) => ({
  provider,
  id: String(item[shape.id] || ''),
  definitionCode: String(item[shape.definitionCode] || ''),
  definitionVersion: String(item[shape.definitionVersion] || ''),
  title: String(item.title || item.name || ''),
  status: status(item.status || item.state),
  currentNodeId: String(item[shape.currentNodeId] || ''),
  ...(item.applicantId ? { applicantId: String(item.applicantId) } : {}),
  ...(item.applicantName ? { applicantName: String(item.applicantName) } : {}),
  ...(item.startedAt ? { startedAt: String(item.startedAt) } : {}),
  updatedAt: String(item.updatedAt || item.modifiedAt || ''),
  ...(item.businessKey || item.businessId ? { businessKey: String(item.businessKey || item.businessId) } : {}),
  ...(Number.isFinite(item.amount) ? { amount: item.amount } : {}),
  ...(item.summary ? { summary: String(item.summary) } : {}),
  timeline: array(item[shape.timeline]).map(event => ({
    id: String(event.id || event.eventId || ''), nodeId: String(event.nodeId || event.activityId || event.stepId || ''),
    label: String(event.label || event.name || ''), action: action(event.action),
    ...(event.actorDisplay || event.actorName ? { actorDisplay: String(event.actorDisplay || event.actorName) } : {}),
    ...(event.comment ? { comment: String(event.comment) } : {}), occurredAt: String(event.occurredAt || event.time || '')
  }))
});

const PROFILES = Object.freeze({
  dingtalk_gateway_v1: {
    schema: 'yuanyu.workflow.dingtalk.v1', definitions: 'processes', instances: 'processInstances',
    definitionShape: { sourceId: 'processCode', code: 'code', name: 'processName', version: 'version', nodes: 'activities', edges: 'transitions', fields: 'formComponents' },
    instanceShape: { id: 'processInstanceId', definitionCode: 'processCode', definitionVersion: 'processVersion', currentNodeId: 'currentActivityId', timeline: 'history' }
  },
  oa_bpm_gateway_v1: {
    schema: 'yuanyu.workflow.oa-bpm.v1', definitions: 'processDefinitions', instances: 'cases',
    definitionShape: { sourceId: 'definitionId', code: 'definitionKey', name: 'displayName', version: 'deploymentVersion', nodes: 'steps', edges: 'transitions', fields: 'formFields' },
    instanceShape: { id: 'caseId', definitionCode: 'definitionKey', definitionVersion: 'deploymentVersion', currentNodeId: 'currentStepId', timeline: 'auditTrail' }
  }
});

export const WORKFLOW_RESPONSE_PROFILES = Object.freeze(['canonical_v1', ...Object.keys(PROFILES)]);

export function normalizeWorkflowProviderPayload(payload, connector) {
  if (connector.responseProfile === 'canonical_v1') return clone(payload);
  const profile = PROFILES[connector.responseProfile];
  if (!profile || payload?.schema !== profile.schema || !Array.isArray(payload?.[profile.definitions])) throw failure(`流程连接器 ${connector.id} 的适配网关响应契约无效。`);
  const normalized = {
    cursor: payload.cursor,
    nextCursor: payload.nextCursor,
    definitions: payload[profile.definitions].map(item => definition(item, connector.id, profile.definitionShape))
  };
  if (Object.hasOwn(payload, profile.instances)) {
    if (!Array.isArray(payload[profile.instances])) throw failure(`流程连接器 ${connector.id} 的实例数组无效。`);
    normalized.instances = payload[profile.instances].map(item => instance(item, connector.id, profile.instanceShape));
  }
  return normalized;
}

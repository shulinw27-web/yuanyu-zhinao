import { createHash } from 'node:crypto';
import { getRiskById } from './risk-service.js';

export async function resolveQualityDraftTarget(businessIds, roleId, identityScope) {
  if (businessIds?.length !== 1 || !/^RC-\d{4}-\d+$/.test(businessIds[0])) return null;
  // The current risk repository is a Demo source, not a production connector.
  if (process.env.NODE_ENV === 'production' || process.env.CONNECTOR_MOCK_MODE === 'disabled' || identityScope?.tenantId !== 'demo-enterprise') return null;
  const risk = await getRiskById(businessIds[0], roleId, identityScope);
  if (!risk || ['已关闭', '已审批'].includes(risk.status)) return null;
  const snapshot = { id: risk.id, status: risk.status, severity: risk.severity, title: risk.title, summary: risk.summary, organizationId: risk.organizationId };
  return { businessIds: [risk.id], expectedVersion: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), source: 'demo_risk_repository' };
}

export function validQualityDraftTarget(input) {
  return Boolean(input && Object.keys(input).every((key) => ['businessIds', 'expectedVersion', 'source'].includes(key))
    && Array.isArray(input.businessIds) && input.businessIds.length === 1 && /^RC-\d{4}-\d+$/.test(input.businessIds[0])
    && /^[a-f0-9]{64}$/.test(input.expectedVersion) && input.source === 'demo_risk_repository');
}

export async function verifyQualityDraftTarget(input, roleId, identityScope) {
  if (!validQualityDraftTarget(input)) return false;
  const current = await resolveQualityDraftTarget(input.businessIds, roleId, identityScope);
  return current?.expectedVersion === input.expectedVersion;
}

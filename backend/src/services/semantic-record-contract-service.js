import { canAccessOrganization } from './access-control-service.js';

export const semanticRecordContract = Object.freeze({
  schemaVersion: 'semantic-record.v1',
  requiredFields: ['id', 'tenantId', 'organizationId', 'version', 'occurredAt', 'classification', 'statement'],
  identityAuthority: 'authenticated_request_only',
  organizationAuthority: 'access_control_service',
  versionAuthority: 'source_connector',
  missingMetadata: 'reject_in_production',
  unknownObjectTypes: 'independent_type_not_permission_grant'
});

export function admitSemanticRecord(record, roleId, identityScope, strict = process.env.NODE_ENV === 'production') {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (record.tenantId && record.tenantId !== identityScope?.tenantId) return false;
  if (record.organizationId && (!identityScope?.subjectId || !canAccessOrganization(roleId, record.organizationId, identityScope))) return false;
  if (!strict) return true;
  return Boolean(identityScope?.tenantId && identityScope?.subjectId && record.tenantId === identityScope.tenantId && record.organizationId
    && typeof (record.id || record.recordId) === 'string' && (record.id || record.recordId).trim()
    && typeof record.classification === 'string' && record.classification.trim()
    && typeof (record.version || record.objectVersion || record.etag) === 'string' && (record.version || record.objectVersion || record.etag).trim() && (record.version || record.objectVersion || record.etag) !== 'unknown'
    && Number.isFinite(Date.parse(record.occurredAt || '')));
}

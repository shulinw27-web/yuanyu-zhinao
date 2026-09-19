import { requireOntologyObjectAccess, admitOntologyDataset, ontologyQueryFingerprint } from './ontology-read-plan-service.js';
import { getEffectiveAccess } from './access-control-service.js';

const fail = code => { throw new Error(code); };
const keysOnly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const scalar = value => typeof value === 'string' && value.length > 0 && value.length <= 2000 || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean';

// Internal, read-only adapter over ONE fully fetched synthetic snapshot. This is
// not a public connector endpoint, a permission grant, or a model publication.
// Caller must obtain the source through the scoped onboarding read workflow.
export function createMockOnboardingOntologyAdapter({ source, draft, scope, roleId }) {
  if (process.env.NODE_ENV === 'production') fail('MOCK_ONTOLOGY_SANDBOX_ONLY');
  if (!scope?.tenantId || !scope.subjectId || !roleId || !Array.isArray(draft?.objectTypes)
    || source?.sourceKind !== 'local_mock_http' || source.protocol !== 'mock-onboarding-query.v1'
    || typeof source.snapshotId !== 'string' || !source.snapshotId.startsWith('synthetic-')
    || !Array.isArray(source.records) || source.records.length > 500
    || source.records.some(row => !row || row.tenantId !== scope.tenantId || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload))) fail('MOCK_ONTOLOGY_SOURCE_INVALID');
  // Never allow the caller to mutate a captured snapshot/model between joins.
  const captured = structuredClone({ source, draft, scope });
  const querySnapshot = query => {
    if (process.env.NODE_ENV === 'production') fail('MOCK_ONTOLOGY_SANDBOX_ONLY');
    const access = getEffectiveAccess(roleId, captured.scope);
    if (!access.principalResolved || !access.roleIds.includes(roleId) || !access.pagePermissionIds.includes('page.world.view')) fail('MOCK_ONTOLOGY_ACCESS_DENIED');
    if (!keysOnly(query, ['schemaVersion', 'objectType', 'fields', 'filter', 'limit'])
      || query.schemaVersion !== 'ontology-query.v1' || typeof query.objectType !== 'string'
      || !Array.isArray(query.fields) || !query.fields.length || query.fields.length > 80 || new Set(query.fields).size !== query.fields.length
      || !keysOnly(query.filter, ['field', 'values']) || !Array.isArray(query.filter.values) || query.filter.values.length > 100
      || query.filter.values.some(value => !scalar(value)) || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) fail('MOCK_ONTOLOGY_QUERY_INVALID');
    // Re-evaluates server-managed grants on every query, never derives grants
    // from uploaded API documents or from source records.
    const { type, grant } = requireOntologyObjectAccess(captured.draft, query.objectType, roleId, captured.scope);
    if (!type.fields.includes(query.filter.field) || query.fields.some(field => !type.fields.includes(field))) fail('MOCK_ONTOLOGY_QUERY_INVALID');
    const candidates = captured.source.records.filter(row => row.objectType === type.id && query.filter.values.includes(row.payload[query.filter.field]));
    if (candidates.some(row => row.system !== grant.system)) fail('MOCK_ONTOLOGY_SOURCE_MISMATCH');
    // Validate and deduplicate before applying the bound. Never truncate a
    // matching result and then assert complete=true.
    const records = admitOntologyDataset({ draft: captured.draft, ds: { objectType: type.id }, query, records: candidates, roleId, scope: captured.scope });
    if (records.length > query.limit) fail('MOCK_ONTOLOGY_QUERY_INCOMPLETE');
    return {
      records: records.map(row => ({ ...row, payload: Object.fromEntries(query.fields.map(field => [field, row.payload[field]])) })),
      queryCoverage: { schemaVersion: 'ontology-query.v1', complete: true, queryFingerprint: ontologyQueryFingerprint(query), snapshotId: captured.source.snapshotId },
      sourceKind: 'local_mock_snapshot_adapter', synthetic: true, published: false
    };
  };
  return Object.freeze({ query: querySnapshot, retrieve: async (type, query) => {
    if (type?.id !== query?.objectType) fail('MOCK_ONTOLOGY_QUERY_INVALID');
    return querySnapshot(query).records;
  } });
}

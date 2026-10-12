import { getEffectiveAccess } from './access-control-service.js';
import { getRole, discoverSemanticSources } from '../domains/governance/public-api.js';
import { admitSemanticRecord } from './semantic-record-contract-service.js';
import { readSemanticGovernanceState } from './semantic-governance-store.js';
import { currentSemanticModel, currentSemanticTenant, DEFAULT_SEMANTIC_MODEL_ID } from './semantic-tenant-context.js';
import { assertCurrentSemanticModelAdmission } from './semantic-model-reference.js';
import { semanticFingerprint } from './semantic-model-fingerprint.js';

const reject = code => { throw Object.assign(new Error('合成事实准入预检未通过。'), { code }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u.test(value);
const scalar = value => value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
  || typeof value === 'string' && value.length <= 2000;
const authority = identityScope => {
  const access = getEffectiveAccess(null, identityScope);
  if (!access.principalResolved || !access.roleIds.includes('executive') || !access.buttonPermissionIds.includes('meta_model.draft.save')
    || !access.pagePermissionIds.includes('page.semantic-operations.view')) reject('SYNTHETIC_FACT_FORBIDDEN');
  return JSON.stringify(access);
};
const publication = async () => {
  const state = await readSemanticGovernanceState('oa_meta_model_runtime', 'workspace', {});
  const published = state.publishedModel;
  if (!published?.draft || published.tenantId !== currentSemanticTenant() || semanticFingerprint(published.draft) !== published.fingerprint) reject('SYNTHETIC_FACT_PUBLICATION_REQUIRED');
  return published;
};

// Read-only preview, not a transport payload, write authorization or live-data API.
export async function previewSyntheticFactAdmission({ identityScope, body }) {
  try {
    if (identityScope?.tenantId !== currentSemanticTenant() || currentSemanticModel() === DEFAULT_SEMANTIC_MODEL_ID) reject('SYNTHETIC_FACT_WORKSPACE_REQUIRED');
    await assertCurrentSemanticModelAdmission();
    const input = structuredClone(body);
    if (!plain(input) || Object.keys(input).some(key => !['modelId', 'version', 'fingerprint', 'records'].includes(key))
      || input.modelId !== currentSemanticModel() || !Array.isArray(input.records) || !input.records.length || input.records.length > 100
      || Buffer.byteLength(JSON.stringify(input)) > 262144) reject('SYNTHETIC_FACT_INPUT_INVALID');
    // The server caller must bind its verified IAM context; this preview cannot
    // create one from a body or impersonate an arbitrary tenant's principal.
    {
      const iamVersion = authority(identityScope);
      const published = await publication();
      if (input.version !== published.version || input.fingerprint !== published.fingerprint) reject('SYNTHETIC_FACT_PUBLICATION_STALE');
      const types = new Map(published.draft.objectTypes.map(type => [type.id, type]));
      const systems = new Set(); const ids = new Set();
      for (const record of input.records) {
        if (!plain(record) || Object.keys(record).some(key => !['id', 'tenantId', 'organizationId', 'version', 'occurredAt', 'classification', 'sourceSystem', 'objectType', 'simulated', 'payload'].includes(key))
          || record.simulated !== true || !identifier(record.id) || ids.has(record.id) || !identifier(record.version)
          || !['public', 'internal'].includes(record.classification) || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(record.occurredAt || '')
          || !admitSemanticRecord(record, 'executive', identityScope, true)) reject('SYNTHETIC_FACT_PROVENANCE_INVALID');
        const type = types.get(record.objectType); const data = record.payload;
        if (!type || !type.sourceSystems.includes(record.sourceSystem)) reject('SYNTHETIC_FACT_SOURCE_UNDECLARED');
        if (!plain(data) || Object.keys(data).some(key => !type.fields.includes(key)) || !Object.values(data).every(scalar)
          || !Object.hasOwn(data, type.key) || data[type.key] === null || typeof data[type.key] === 'boolean'
          || !String(data[type.key]).trim() || String(data[type.key]).length > 120) reject('SYNTHETIC_FACT_SCHEMA_INVALID');
        systems.add(record.sourceSystem); ids.add(record.id);
      }
      const sources = discoverSemanticSources({ role: getRole('executive'), systemCodes: [...systems] });
      if (sources.sources.length !== systems.size || sources.sources.some(source => !source.authorized)) reject('SYNTHETIC_FACT_SOURCE_FORBIDDEN');
      await assertCurrentSemanticModelAdmission();
      const fresh = await publication();
      if (fresh.version !== published.version || fresh.fingerprint !== published.fingerprint || authority(identityScope) !== iamVersion) reject('SYNTHETIC_FACT_CONTEXT_CHANGED');
      return { status: 'preview_passed', modelId: currentSemanticModel(), version: published.version, fingerprint: published.fingerprint,
        recordCount: input.records.length, sourceCount: systems.size, projectionScope: 'admission_preview', runtimeReadEnabled: false, requestAttempted: false };
    }
  } catch (error) {
    return { status: 'rejected', code: error.code || 'SYNTHETIC_FACT_INPUT_INVALID', requestAttempted: false };
  }
}

import { loadSemanticMaterials } from './semantic-material-workspace-service.js';
import { buildSemanticMappingContract, validateGovernedSemanticSamples, validateSemanticMappingContract } from './semantic-mapping-validation-service.js';

export function validateProposalSamples(draft, { sampleRefs = [], roleId, identityScope, requireEvidence = false } = {}) {
  if (!sampleRefs.length) return validateSemanticMappingContract(draft, { requireEvidence });
  const envelope = result => ({ contract: { ...buildSemanticMappingContract(draft), sourceMode: 'uploaded_scoped_samples' },
    summary: { objectCount: draft.objectTypes.length, verifiedObjectCount: 0, sampleCount: 0, successfulSampleCount: 0, observedCoveragePercent: 0, errorCount: 1 }, ...result });
  return loadSemanticMaterials(sampleRefs, identityScope, roleId).then(documents => {
    const records = new Map();
    const seen = new Map();
    let duplicates = 0;
    for (const document of documents) {
      const parsed = JSON.parse(document.text);
      if (!Array.isArray(parsed.records) || parsed.records.length > 1000) throw new Error('SAMPLE_SHAPE_INVALID');
      for (const row of parsed.records) {
        const id = JSON.stringify([row?.system, row?.id, row?.version]);
        const serialized = JSON.stringify(row);
        if (seen.has(id)) {
          if (seen.get(id) !== serialized) throw new Error('SAMPLE_VERSION_CONFLICT');
          duplicates += 1;
          continue;
        }
        seen.set(id, serialized);
        const system = String(row?.system || '').toLowerCase();
        if (!records.has(system)) records.set(system, []);
        records.get(system).push(row);
      }
    }
    const result = validateGovernedSemanticSamples(draft, records, { roleId, identityScope, sampleLimit: 10 });
    // An upload supplies test data, not authority or proof of a live Connector.
    return envelope({ ...result, source: 'uploaded_scoped_samples', duplicatesSkipped: duplicates,
      productionReady: false, policy: '用户上传并经扫描、脱敏及当前身份范围检查的有限样本；不代表企业连接器已接通，不授予数据或执行权限。' });
  }).catch(() => envelope({ status: 'failed', blocked: true, code: 'UPLOADED_SAMPLE_INVALID_OR_FORBIDDEN', source: 'uploaded_scoped_samples', objects: [], issues: [], productionReady: false }));
}

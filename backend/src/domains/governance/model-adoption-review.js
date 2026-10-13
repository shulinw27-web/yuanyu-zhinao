// Pure projection: caller must independently prove current owner, IAM,
// proposal, draft, source and evidence bindings before returning this DTO.
const text = (value, limit = 128) => typeof value === 'string' && value.length > 0 && value.length <= limit;
const relationKey = item => JSON.stringify([item.from, item.predicate, item.to]);
const relation = item => {
  if (!item || !text(item.from) || !text(item.to) || !text(item.predicate)) throw new Error('INVALID_REVIEW_RELATION');
  const extra = {};
  for (const key of ['sourceField', 'targetField', 'cardinality', 'label']) if (item[key] !== undefined) {
    if (!text(item[key], 256)) throw new Error('INVALID_REVIEW_RELATION'); extra[key] = item[key];
  }
  return { from: item.from, to: item.to, predicate: item.predicate, ...extra };
};
const object = (item, kind) => {
  if (!item || !text(item.id) || !text(item.label, 256) || !text(item.key) || !Array.isArray(item.fields) || item.fields.length > 100
    || item.fields.some(field => !text(field)) || !Array.isArray(item.sourceSystems) || item.sourceSystems.length > 16 || item.sourceSystems.some(system => !text(system, 40))
    || !Array.isArray(item.fieldDefinitions) || item.fieldDefinitions.length > 100) throw new Error('INVALID_REVIEW_OBJECT');
  const fields = item.fieldDefinitions.map(field => {
    if (!field || !text(field.name) || !text(field.type, 40) || field.sourceField !== undefined && field.sourceField !== null && !text(field.sourceField, 256)
      || field.mappingStatus !== undefined && !text(field.mappingStatus, 40)) throw new Error('INVALID_REVIEW_FIELD');
    return { name: field.name, type: field.type, sourceField: field.sourceField || null, mappingStatus: field.mappingStatus || 'pending', primaryKey: field.primaryKey === true, required: field.required === true };
  });
  return { id: item.id, label: item.label, key: item.key, sourceSystems: [...item.sourceSystems], fields, kind };
};

export function projectAdoptionReview({ task, proposal, draft, taskFingerprint }) {
  try {
    if (!['merge', 'replace'].includes(proposal.adoptionMode) || !Array.isArray(proposal.draft?.objectTypes) || proposal.draft.objectTypes.length > 40
      || !Array.isArray(proposal.draft.relationshipTypes) || proposal.draft.relationshipTypes.length > 200
      || !Array.isArray(draft.objectTypes) || draft.objectTypes.length > 200 || !Array.isArray(draft.relationshipTypes) || draft.relationshipTypes.length > 500) throw new Error('REVIEW_LIMIT');
    const candidates = proposal.draft.objectTypes; const base = new Map(draft.objectTypes.map(item => [item.id, item]));
    const nodes = candidates.map(item => object(item, 'candidate'));
    if (new Set(nodes.map(item => item.id)).size !== nodes.length) throw new Error('REVIEW_DUPLICATE');
    const edges = proposal.draft.relationshipTypes.map(relation);
    if (new Set(edges.map(relationKey)).size !== edges.length) throw new Error('REVIEW_DUPLICATE');
    const ids = new Set(nodes.map(item => item.id));
    for (const edge of edges) for (const id of [edge.from, edge.to]) {
      if (ids.has(id)) continue;
      if (proposal.adoptionMode === 'replace' || !base.has(id)) throw new Error('REVIEW_REFERENCE');
      nodes.push(object(base.get(id), 'existing_reference')); ids.add(id);
    }
    if (nodes.length > 200) throw new Error('REVIEW_LIMIT');
    const objectChanges = candidates.map(item => ({ id: item.id, change: !base.has(item.id) ? 'added' : JSON.stringify(base.get(item.id)) === JSON.stringify(item) ? 'unchanged' : 'updated' }));
    if (proposal.adoptionMode === 'replace') for (const item of draft.objectTypes) if (!ids.has(item.id)) objectChanges.push({ id: item.id, change: 'removed' });
    const oldRelations = new Map(draft.relationshipTypes.map(item => [relationKey(item), item])); const newKeys = new Set(edges.map(relationKey));
    const candidateRelations = new Map(proposal.draft.relationshipTypes.map(item => [relationKey(item), item]));
    const relationshipChanges = edges.map(item => ({ ...item, change: !oldRelations.has(relationKey(item)) ? 'added' : JSON.stringify(oldRelations.get(relationKey(item))) === JSON.stringify(candidateRelations.get(relationKey(item))) ? 'unchanged' : 'updated' }));
    if (proposal.adoptionMode === 'replace') for (const [key, item] of oldRelations) if (!newKeys.has(key)) relationshipChanges.push({ ...relation(item), change: 'removed' });
    const result = { modelId: task.modelId, taskId: task.id, taskFingerprint, draftFingerprint: draft.fingerprint, proposalId: proposal.id, proposalRevision: proposal.revision,
      adoptionMode: proposal.adoptionMode, confirmationEvidenceState: task.confirmation?.evidenceState || 'not_issued', graph: { nodes, edges }, diff: { objectChanges, relationshipChanges },
      checks: { criticStatus: proposal.critic?.status || 'unverified', mappingStatus: proposal.mappingValidation?.status || 'unverified', mappingBlocked: proposal.mappingValidation?.blocked !== false },
      contentScope: 'owned_candidate_structure_only', executionEnabled: false, runtimeReadEnabled: false };
    if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error('REVIEW_LIMIT');
    return result;
  } catch { return { error: '模型审阅结构无效或超限，未返回部分结果。', code: 'MODEL_ADOPTION_REVIEW_LIMIT_OR_FORMAT', status: 413 }; }
}

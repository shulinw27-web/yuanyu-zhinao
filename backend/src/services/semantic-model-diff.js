const signature = item => JSON.stringify([item.from, item.predicate, item.to]);
const relationshipValue = item => ({ label: item.label || '', cardinality: item.cardinality || '', evidence: item.evidence || '', provenanceType: item.provenanceType || 'declared', validFrom: item.validFrom || null, validTo: item.validTo || null, keyMapping: item.keyMapping || null });
export function relationshipDiff(base, candidate, replace = false) {
  const before = new Map((base || []).map(item => [signature(item), item]));
  const after = new Map((candidate || []).map(item => [signature(item), item]));
  const changes = [...after].map(([key, item]) => ({ ...item, before: before.has(key) ? relationshipValue(before.get(key)) : null, after: relationshipValue(item), change: !before.has(key) ? 'added' : JSON.stringify(relationshipValue(before.get(key))) === JSON.stringify(relationshipValue(item)) ? 'unchanged' : 'updated' }));
  if (replace) for (const [key, item] of before) if (!after.has(key)) changes.push({ ...item, before: relationshipValue(item), after: null, change: 'removed' });
  return changes;
}

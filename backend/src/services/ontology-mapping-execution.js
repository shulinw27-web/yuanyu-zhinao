import { createHash } from 'node:crypto';

const fail = code => { throw new Error(code); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipts = new WeakMap();
const recordKey = record => JSON.stringify([record.system, record.objectType, record.id]);
const time = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail('READ_MAPPING_TIME_INVALID');
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (new Date(value).toISOString() !== canonical) fail('READ_MAPPING_TIME_INVALID');
  return Date.parse(value);
};

// Explicit, versioned crosswalk only. lookupSource names a declared object, never a URL.
export function ontologyMappingBinding(draft, sourceType, targetType, clause) {
  const binding = clause.mapping;
  if (!binding || typeof binding !== 'object') fail('READ_MAPPING_BINDING_INVALID');
  const matches = (draft.relationshipTypes || []).filter(relation => relation.from === sourceType.id && relation.to === targetType.id && relation.predicate === binding.predicate);
  if (matches.length !== 1) fail('READ_MAPPING_RELATION_INVALID');
  const relation = matches[0]; const mapping = relation.keyMapping;
  const type = draft.objectTypes.find(item => item.id === binding.objectType);
  if (!mapping || mapping.basis !== 'master_data_lookup' || !mapping.version || mapping.lookupSource !== binding.objectType
    || mapping.fromField !== clause.sourceField || mapping.toField !== clause.field || !type || type.sourceSystems.length !== 1) fail('READ_MAPPING_BINDING_INVALID');
  const names = ['fromField', 'toField', 'statusField', 'versionField', 'validFromField', 'validToField'].map(key => binding[key]);
  if (names.some(name => typeof name !== 'string' || !type.fields.includes(name)) || new Set(names).size !== names.length) fail('READ_MAPPING_FIELDS_INVALID');
  for (const [name, endpoint, field] of [[binding.fromField, sourceType, clause.sourceField], [binding.toField, targetType, clause.field]]) {
    if (!type.fieldDefinitions?.some(def => def.name === name && def.reference === endpoint.id && (def.referenceField || endpoint.key) === field)) fail('READ_MAPPING_REFERENCE_INVALID');
  }
  time(binding.asOf);
  return { binding, relation, type };
}

export function resolveOntologyMappingRows(contract, sourceRecords, rows) {
  const { binding: b, relation } = contract; const at = time(b.asOf); const pairs = [];
  const values = new Set(sourceRecords.map(record => record.payload[relation.keyMapping.fromField]));
  if (values.has(null) || values.has(undefined)) fail('READ_MAPPING_SOURCE_MISSING');
  for (const value of values) {
    const candidates = rows.filter(row => row.payload[b.fromField] === value);
    if (!candidates.length) fail('READ_MAPPING_MISSING');
    const active = candidates.filter(row => {
      const p = row.payload; const start = time(p[b.validFromField]); const end = p[b.validToField] === null ? Infinity : time(p[b.validToField]);
      if (start >= end || time(row.occurredAt) > at) fail('READ_MAPPING_TIME_INVALID');
      if (p[b.versionField] !== relation.keyMapping.version) fail('READ_MAPPING_VERSION_MISMATCH');
      return start <= at && at < end;
    });
    if (!active.length) fail('READ_MAPPING_EXPIRED');
    if (active.length !== 1) fail('READ_MAPPING_CONFLICT');
    const row = active[0]; const target = row.payload[b.toField];
    if (row.payload[b.statusField] !== 'confirmed') fail('READ_MAPPING_UNCONFIRMED');
    if (typeof target !== 'string' || !target) fail('READ_MAPPING_TARGET_INVALID');
    pairs.push({ source: value, target, row });
  }
  return pairs;
}

// In-process capability: a serialized or forged receipt cannot produce graph edges.
export const ontologyMappingEvidence = {
  create(draft, records, runs) {
    const token = Object.freeze({});
    receipts.set(token, { draft: hash(draft), records: records.map(record => [recordKey(record), hash(record)]), runs: structuredClone(runs) });
    return token;
  },
  read(token, draft, records) {
    const stored = token && receipts.get(token); if (!stored || stored.draft !== hash(draft)) return [];
    const current = new Map(records.map(record => [recordKey(record), hash(record)]));
    if (stored.records.some(([key, fingerprint]) => current.get(key) !== fingerprint)) return [];
    return structuredClone(stored.runs);
  }
};

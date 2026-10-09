// Projection of already admitted records only. Never retrieves or authorizes data.
import { ontologyMappingEvidence } from './ontology-mapping-execution.js';
export function buildOntologyResultGraph(draft, records, modelVersion, modelFingerprint, mappingEvidence = []) {
  const id = record => JSON.stringify(['instance', record.system, record.objectType, record.id]);
  const types = new Map(draft.objectTypes.map(type => [type.id, type]));
  const objects = records.map(record => ({ id: id(record), label: `${types.get(record.objectType)?.label || record.objectType} · ${record.id}`, businessDomain: types.get(record.objectType)?.businessDomain || '', sourceSystems: [record.system], fields: [],
    description: `授权来源快照；类型 ${record.objectType}；记录版本 ${record.version}；时间 ${record.occurredAt}；模型 ${modelVersion}` }));
  const relationships = []; const seen = new Set(); const relationshipCoverage = [];
  const executedMappings = mappingEvidence.flatMap(token => ontologyMappingEvidence.read(token, draft, records));
  const requiresMapping = (from, fromField, to, toField) => (draft.relationshipTypes || []).some(relation => {
    const mapping = relation.keyMapping; if (!mapping) return false;
    const fieldsMatch = (a, b) => (!mapping.fromField || mapping.fromField === a) && (!mapping.toField || mapping.toField === b);
    return relation.from === from && relation.to === to && fieldsMatch(fromField, toField)
      || relation.from === to && relation.to === from && fieldsMatch(toField, fromField);
  });
  for (const record of records) for (const field of types.get(record.objectType)?.fieldDefinitions || []) {
    if (!field.reference || !Object.hasOwn(record.payload, field.name)) continue;
    const targetType = types.get(field.reference); if (!targetType) continue;
    // A declared lookup supersedes equality for that field pair in either direction.
    if (requiresMapping(record.objectType, field.name, targetType.id, field.referenceField || targetType.key)) continue;
    for (const target of records.filter(item => item.objectType === field.reference && Object.hasOwn(item.payload, field.referenceField || targetType.key)
      && item.payload[field.referenceField || targetType.key] === record.payload[field.name] && record.payload[field.name] !== null && record.payload[field.name] !== undefined)) {
      const relation = { from: id(record), to: id(target), predicate: `reference_${field.name}`, label: `字段关联 ${field.name}`, cardinality: '已读取记录的严格键匹配', evidence: `${record.system}.${record.objectType}.${field.name} = ${target.system}.${target.objectType}.${field.referenceField || targetType.key}；关联不证明根因或审批通过。` };
      const signature = JSON.stringify([relation.from, relation.predicate, relation.to]);
      if (!seen.has(signature)) { seen.add(signature); if (relationships.length < 2000) relationships.push(relation); }
    }
  }
  const admittedTypes = new Set(records.map(record => record.objectType));
  for (const semantic of draft.relationshipTypes || []) {
    // Do not disclose a type that was not admitted into this response.
    if (!admittedTypes.has(semantic.from) || !admittedTypes.has(semantic.to)) continue;
    const fromType = types.get(semantic.from); const toType = types.get(semantic.to); if (!fromType || !toType) continue;
    const descriptor = { from: semantic.from, predicate: semantic.predicate, to: semantic.to, matchedPairs: 0 };
    if (semantic.keyMapping) {
      const mapped = executedMappings.filter(run => run.fromType === semantic.from && run.toType === semantic.to && run.predicate === semantic.predicate);
      for (const run of mapped) {
        const signature = JSON.stringify([run.from, semantic.predicate, run.to]);
        if (!seen.has(signature)) { seen.add(signature); if (relationships.length < 2000) relationships.push({ from: run.from, to: run.to, predicate: semantic.predicate, label: semantic.label || semantic.predicate, cardinality: semantic.cardinality || '待核对', evidence: `已读取确认的主数据对照；映射版本 ${run.mappingVersion}，有效时点 ${run.asOf}，模型 ${modelVersion}；不证明因果。` }); }
      }
      relationshipCoverage.push({ ...descriptor, matchedPairs: new Set(mapped.map(run => JSON.stringify([run.from, run.to]))).size, status: mapped.length ? 'mapped_in_snapshot' : 'requires_mapping_execution', reason: mapped.length ? '仅覆盖本轮授权快照与确认映射，不证明完整业务影响范围。' : '该关系依赖映射定义；本次未读取或执行对照映射，不能以同值冒充对齐。' }); continue;
    }
    const mappings = [
      ...(fromType.fieldDefinitions || []).filter(f => f.reference === toType.id).map(f => ({ fromField: f.name, toField: f.referenceField || toType.key })),
      ...(toType.fieldDefinitions || []).filter(f => f.reference === fromType.id).map(f => ({ fromField: f.referenceField || fromType.key, toField: f.name }))
    ];
    const unique = [...new Map(mappings.filter(m => !requiresMapping(semantic.from, m.fromField, semantic.to, m.toField)).map(m => [JSON.stringify(m), m])).values()];
    if (unique.length !== 1) { relationshipCoverage.push({ ...descriptor, status: unique.length ? 'ambiguous_mapping' : 'mapping_not_declared', reason: '没有唯一已声明的字段关联；不按对象名称猜测业务关系。' }); continue; }
    const mapping = unique[0]; let count = 0;
    for (const from of records.filter(record => record.objectType === semantic.from)) for (const to of records.filter(record => record.objectType === semantic.to)) {
      const value = from.payload[mapping.fromField];
      if (value === null || value === undefined || typeof value === 'object' || !Object.hasOwn(to.payload, mapping.toField) || value !== to.payload[mapping.toField]) continue;
      const relation = { from: id(from), to: id(to), predicate: semantic.predicate, label: semantic.label || semantic.predicate, cardinality: semantic.cardinality || '待核对', evidence: `已发布关系；本轮严格键匹配 ${mapping.fromField} = ${mapping.toField}，模型 ${modelVersion}；不证明因果。` };
      const signature = JSON.stringify([relation.from, relation.predicate, relation.to]);
      if (!seen.has(signature)) { seen.add(signature); if (relationships.length < 2000) relationships.push(relation); }
      count++;
    }
    relationshipCoverage.push({ ...descriptor, matchedPairs: count, status: count ? 'matched_in_snapshot' : 'no_match_in_snapshot', reason: '只覆盖本轮已授权读取快照，不代表完整业务影响范围。' });
  }
  return { mode: 'authorized_instance_snapshot', modelVersion, modelFingerprint, objects, relationships, relationshipCoverage, truncated: seen.size > relationships.length, omittedRelationships: seen.size - relationships.length, globalEnterpriseCoverage: false, interpretation: `实际读取的记录、声明外键及本轮执行的确认对照映射；不代表完整影响范围，不证明因果。${seen.size > relationships.length ? '连线超过显示预算，部分关系未展示。' : ''}` };
}

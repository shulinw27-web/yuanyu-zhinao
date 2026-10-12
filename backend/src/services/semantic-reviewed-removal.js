// Schema-only change proposals. No source records, implicit cascade or grants.
import { collectSemanticFieldDependencies, collectSemanticObjectDependencies } from './semantic-object-dependencies.js';
const sameRelation = (item, target) => item.from === target.from && item.predicate === target.predicate && item.to === target.to;
const fail = (code, error) => ({ code: `SEMANTIC_REVIEWED_REMOVAL_${code}`, error });
export function prepareReviewedModelRemoval(proposal, baseline, target, original) {
  if (!target || typeof target !== 'object' || Array.isArray(target) || !['field', 'object', 'relationship'].includes(target.kind)
    || Object.keys(target).some(key => !['kind', 'objectId', 'fieldName', 'from', 'predicate', 'to'].includes(key))
    || !Array.isArray(proposal?.objectTypes) || !Array.isArray(proposal.relationshipTypes) || !Array.isArray(baseline?.objectTypes)) return fail('INVALID', '变更目标或基线无效。');
  const models = [{ scope: 'candidate', model: proposal }, { scope: 'draft', model: baseline }, ...(original ? [{ scope: 'original', model: original }] : [])];
  const body = structuredClone({ objectTypes: proposal.objectTypes, relationshipTypes: proposal.relationshipTypes });
  let report;
  if (target.kind === 'relationship') {
    if (Object.keys(target).length !== 4 || !['from', 'predicate', 'to'].every(key => /^[A-Za-z][A-Za-z0-9_]{0,47}$/u.test(target[key] || ''))) return fail('INVALID', '请使用起点/关系编码/终点。');
    const matches = proposal.relationshipTypes.filter(item => sameRelation(item, target));
    if (matches.length !== 1) return fail('INVALID', '关系不存在或有歧义。');
    const relation = matches[0];
    if (relation.derivedFrom || relation.keyMapping || relation.validFrom || relation.validTo || relation.provenanceType !== 'declared') return fail('GOVERNED', '带标识确认、映射或有效期的关系需专门治理变更，不能普通移除。');
    report = collectSemanticObjectDependencies(models.map(({ scope, model }) => ({ scope, model: { ...model, relationshipTypes: (model.relationshipTypes || []).filter(item => !sameRelation(item, target)) } })), { id: relation.predicate, label: relation.label }, { includeTargetObject: true });
    body.relationshipTypes = body.relationshipTypes.filter(item => !sameRelation(item, target));
  } else {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/u.test(target.objectId || '')) return fail('INVALID', '请使用稳定对象编码。');
    const matches = proposal.objectTypes.filter(item => item.id === target.objectId);
    if (matches.length !== 1) return fail('INVALID', '对象不存在或有歧义。');
    const object = matches[0];
    if (target.kind === 'field') {
      if (Object.keys(target).length !== 3 || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(target.fieldName || '') || object.fieldDefinitions?.filter(item => item.name === target.fieldName).length !== 1) return fail('INVALID', '请明确对象.字段编码。');
      if (models.some(({ model }) => model.objectTypes?.some(item => item.id === object.id && (item.key === target.fieldName || item.fieldDefinitions?.some(field => field.name === target.fieldName && field.primaryKey))))) return fail('KEY', '主键不能普通移除，包括草稿或原提案中的主键。');
      if (object.fields.length <= 2) return fail('INVALID', '移除后必须保留主键和至少一个普通字段。');
      report = collectSemanticFieldDependencies(models, object.id, target.fieldName);
      const changed = body.objectTypes.find(item => item.id === object.id);
      changed.fields = changed.fields.filter(name => name !== target.fieldName);
      changed.fieldDefinitions = changed.fieldDefinitions.filter(item => item.name !== target.fieldName);
    } else {
      if (Object.keys(target).length !== 2 || body.objectTypes.length < 2) return fail('INVALID', '不能移除最后一个对象或夹带参数。');
      report = collectSemanticObjectDependencies(models, object);
      body.objectTypes = body.objectTypes.filter(item => item.id !== object.id);
    }
  }
  if (report.error) return fail('BUDGET', '依赖检查失败或超出预算，未修改。');
  if (report.total) return { ...fail('DEPENDENCIES', '存在配置引用或同名提及，请显式处理依赖后再提案；不会级联清理。'), dependencies: report.dependencies.slice(0, 8) };
  return { body, modelRemoval: target, summary: '仅生成模型移除提案，需替换模式审核采纳并另行发布；不删除源系统数据。' };
}

// Conservative withdrawal of a newly added, unmapped candidate field only.
// Existing/source-backed fields and business records are never deleted here.
import { collectSemanticFieldDependencies } from './semantic-object-dependencies.js';
export function inspectCandidateFieldRemoval(proposal, baseline, objectId, fieldName) {
  if (!Array.isArray(proposal?.objectTypes) || typeof objectId !== 'string' || typeof fieldName !== 'string') return { code: 'SEMANTIC_FIELD_REMOVAL_TARGET_INVALID', error: '候选字段撤回目标无效。' };
  const objects = proposal.objectTypes.filter(item => item.id === objectId);
  const object = objects.length === 1 ? objects[0] : null;
  const fields = Array.isArray(object?.fieldDefinitions) ? object.fieldDefinitions.filter(item => item.name === fieldName) : [];
  const field = fields.length === 1 ? fields[0] : null;
  if (!baseline || !Array.isArray(baseline.objectTypes)) return { code: 'SEMANTIC_FIELD_REMOVAL_BASE_REQUIRED', error: '需要重新核对当前草稿，未撤回字段。' };
  if (!field) return { code: 'SEMANTIC_FIELD_REMOVAL_TARGET_INVALID', error: '对象或字段不存在或有歧义。' };
  if (object.key === fieldName || field.primaryKey) return { code: 'SEMANTIC_FIELD_REMOVAL_KEY_FORBIDDEN', error: '主键不能通过候选字段撤回指令删除。' };
  if (baseline.objectTypes.some(item => item.id === objectId && (item.fields?.includes(fieldName) || item.fieldDefinitions?.some(value => value.name === fieldName)))
      || field.mappingStatus !== 'pending' || field.sourceField || field.reference || field.referenceField) {
    return { code: 'SEMANTIC_FIELD_REMOVAL_EXISTING_FORBIDDEN', error: '仅允许撤回尚未映射、未进入当前草稿的新候选字段；已有或来源映射字段请走专门变更审核。' };
  }
  const report = collectSemanticFieldDependencies([{ scope: 'candidate', model: proposal }, { scope: 'draft', model: baseline }], objectId, fieldName);
  if (report.error) return { code: 'SEMANTIC_FIELD_REMOVAL_BUDGET', error: '依赖配置超出检查预算或结构无效，请走人工字段变更审核。' };
  if (report.total) return { code: 'SEMANTIC_FIELD_REMOVAL_DEPENDENCIES', error: '其他字段或业务配置存在引用/同名提及，未自动判断可以安全撤回。请先核对依赖。', dependencies: report.dependencies.slice(0, 8) };
  return { allowed: true };
}

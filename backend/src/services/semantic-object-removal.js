// Only withdraw an unmapped candidate. Never cascade or delete business records.
import { collectSemanticObjectDependencies } from './semantic-object-dependencies.js';
export function inspectCandidateObjectRemoval(proposal, baseline, objectId, originalDraft) {
  const fail = (code, error) => ({ code: `SEMANTIC_OBJECT_REMOVAL_${code}`, error });
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(objectId || '') || !Array.isArray(proposal?.objectTypes) || !Array.isArray(baseline?.objectTypes)) return fail('TARGET_INVALID', '撤回目标或当前草稿无效，请刷新后核对。');
  const matches = proposal.objectTypes.filter(item => item.id === objectId);
  if (matches.length !== 1 || proposal.objectTypes.length < 2) return fail('TARGET_INVALID', '对象不存在、有歧义或是最后一个候选对象，未撤回。');
  const object = matches[0];
  if ([baseline, originalDraft].some(model => model?.objectTypes?.some(item => item.id === objectId || item.label === object.label))) return fail('EXISTING_FORBIDDEN', '只能撤回本轮手动新增对象，不能删除原提案或当前草稿已有对象。');
  if (object.sourceSystems?.length !== 1 || object.sourceSystems[0] !== 'UNASSIGNED' || object.candidateSourceSystems?.length || object.candidateSourceEvidence
    || !Array.isArray(object.fieldDefinitions) || !object.fieldDefinitions.length || object.fieldDefinitions.some(field => field.mappingStatus !== 'pending' || field.sourceField || field.reference || field.referenceField)) return fail('MAPPED_FORBIDDEN', '对象存在来源、映射或字段引用，只能走专门变更审核，未撤回。');
  const report = collectSemanticObjectDependencies([{ scope: 'candidate', model: proposal }, { scope: 'draft', model: baseline }, ...(originalDraft ? [{ scope: 'original', model: originalDraft }] : [])], object);
  if (report.error) return fail('BUDGET', '依赖检查超出预算或结构无效，未撤回，请走人工变更审核。');
  if (report.total) return { ...fail('DEPENDENCIES', '存在对象引用或业务配置同名提及，请先人工核对依赖；不会自动级联删除。'), dependencies: report.dependencies.slice(0, 8) };
  return { allowed: true };
}

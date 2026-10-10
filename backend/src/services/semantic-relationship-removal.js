import { collectSemanticObjectDependencies } from './semantic-object-dependencies.js';
const same = (item, target) => item.from === target.from && item.predicate === target.predicate && item.to === target.to;
export function inspectCandidateRelationshipRemoval(proposal, baseline, target, originalDraft) {
  const fail = (code, error) => ({ code: `SEMANTIC_RELATION_REMOVAL_${code}`, error });
  if (!target || Object.keys(target).some(key => !['from', 'predicate', 'to'].includes(key)) || !['from', 'predicate', 'to'].every(key => /^[A-Za-z][A-Za-z0-9_]{0,47}$/u.test(target[key] || ''))
    || !Array.isArray(proposal?.relationshipTypes) || !Array.isArray(baseline?.relationshipTypes)) return fail('TARGET_INVALID', '请明确关系起点、编码和终点，并重新核对当前草稿。');
  const matches = proposal.relationshipTypes.filter(item => same(item, target));
  if (matches.length !== 1) return fail('TARGET_INVALID', '关系不存在或有歧义，未撤回。');
  const relation = matches[0];
  if ([baseline, originalDraft].some(model => model?.relationshipTypes?.some(item => same(item, target)))) return fail('EXISTING_FORBIDDEN', '不能撤回原提案或当前草稿已有关系，请走专门变更审核。');
  if (relation.derivedFrom || relation.keyMapping || relation.provenanceType !== 'declared' || relation.validFrom || relation.validTo) return fail('GOVERNED_FORBIDDEN', '标识确认生成、带映射或有效期的关系不能通过普通候选撤回指令移除。');
  const models = [{ scope: 'candidate', model: proposal }, { scope: 'draft', model: baseline }, ...(originalDraft ? [{ scope: 'original', model: originalDraft }] : [])]
    .map(({ scope, model }) => ({ scope, model: { ...model, relationshipTypes: (model.relationshipTypes || []).filter(item => !same(item, target)) } }));
  const report = collectSemanticObjectDependencies(models, { id: relation.predicate, label: relation.label }, { includeTargetObject: true });
  if (report.error) return fail('BUDGET', '依赖检查超出预算或结构无效，未撤回关系。');
  if (report.total) return { ...fail('DEPENDENCIES', '其他关系或业务配置存在关系编码/名称提及，未自动级联删除。'), dependencies: report.dependencies.slice(0, 8) };
  return { allowed: true };
}

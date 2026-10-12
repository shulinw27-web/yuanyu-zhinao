// A selector over reviewed declarations, not a permission grant or rule compiler.
// Never score a "best" match: each mentioned output must be covered by the same
// uniquely identified plan. Unknown/negated/ambiguous requests require clarification.
const contains = (text, value) => {
  if (typeof value !== 'string' || value.length < 2) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'iu').test(text);
};

export function selectPublishedReadPlan(plans, { input = '', planId } = {}) {
  const candidates = plans.map(p => ({ id: p.id, label: p.label, outputs: p.outputs.map(o => ({ id: o.id, label: o.label, unit: o.unit })) }));
  const reject = reason => ({ status: 'needs_input', code: 'ONTOLOGY_PLAN_SELECTION_REQUIRED', reason, candidates });
  if (!plans.length || plans.length > 3 || new Set(plans.map(p => p.id)).size !== plans.length) return reject('invalid_catalogue');
  if (typeof input !== 'string' || input.length > 12000) return reject('invalid_input');
  // Selection must not discard excluded options, infer negation scope or silently
  // replace an invalid explicit ID with a natural-language choice.
  const tokens = plans.flatMap(p => [p.id, p.label, ...p.outputs.map(o => o.label)]);
  const negated = input.split(/[，,。；;\n]/u).some(clause =>
    /不要|不用|别用|不使用|不查询|不读取|禁止|无需|不需要|不必|暂不|别查|别读|排除|除外|不是|并非|\b(?:not|except|exclude|without)\b/iu.test(clause)
    && (tokens.some(token => contains(clause, token)) || /读取|查询|方案|计划|数据|\b(?:read|query|plan)\b/iu.test(clause)));
  if (negated) return reject('negated_request');
  const named = plans.filter(p => contains(input, p.id) || contains(input, p.label));
  if (!named.length && /(?:按|使用|采用|选择|用).{0,50}(?:方案|计划)|(?:方案|计划)\s*[:：]/u.test(input)) return reject('unknown_named_plan');
  const labels = [...new Set(plans.flatMap(p => p.outputs.map(o => o.label)).filter(label => contains(input, label)))];
  const covers = p => labels.every(label => p.outputs.some(o => o.label === label));
  if (planId !== undefined) {
    const explicit = plans.find(p => p.id === planId);
    if (!explicit) return reject('unknown_plan');
    if (named.some(p => p.id !== planId) || !covers(explicit)) return reject('conflicting_request');
    return { status: 'ready', planId, basis: 'explicit_id' };
  }
  if (named.length > 1) return reject('multiple_named_plans');
  if (named.length === 1) return covers(named[0])
    ? { status: 'ready', planId: named[0].id, basis: 'declared_name' } : reject('conflicting_outputs');
  if (labels.length) {
    const matches = plans.filter(covers);
    return matches.length === 1 ? { status: 'ready', planId: matches[0].id, basis: 'declared_outputs' }
      : reject(matches.length ? 'ambiguous_outputs' : 'no_joint_plan');
  }
  return plans.length === 1 ? { status: 'ready', planId: plans[0].id, basis: 'only_published_plan' } : reject('no_declared_match');
}

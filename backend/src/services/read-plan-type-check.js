// Conservative static checks for known scalar types. Missing source values
// remain runtime errors; this does not infer business formulas or permissions.
export function checkReadPlanTypes(plan, draft) {
  let nodes = 0;
  const outputs = new Map();
  const fail = () => { throw new Error('READ_EXPRESSION_TYPE'); };
  const requireType = (types, type) => { if (types.some(t => t !== type && t !== 'unknown')) fail(); };
  const fieldType = (dataset, field) => {
    const type = draft.objectTypes.find(o => o.id === plan.datasets.find(ds => ds.id === dataset)?.objectType)?.fieldDefinitions?.find(f => f.name === field)?.type;
    return [['number', 'integer', 'decimal'].includes(type) ? 'number' : ['string', 'boolean'].includes(type) ? type : 'unknown'];
  };
  const visit = (e, depth = 0) => {
    if (++nodes > 800 || depth > 14 || !e) return fail();
    const next = item => visit(item, depth + 1);
    if (e.op === 'literal') return [e.value === null ? 'null' : typeof e.value];
    if (e.op === 'output') return outputs.get(e.id) || ['unknown'];
    if (['field', 'one'].includes(e.op)) return fieldType(e.dataset, e.field);
    if (e.op === 'lookup') { next(e.value); return fieldType(e.dataset, e.resultField); }
    if (e.op === 'if') { requireType(next(e.condition), 'boolean'); return [...new Set([...next(e.then), ...next(e.else)])]; }
    if (['sum', 'all'].includes(e.op)) {
      requireType(next(e.value), e.op === 'sum' ? 'number' : 'boolean');
      if (e.where) requireType(next(e.where), 'boolean');
      return [e.op === 'sum' ? 'number' : 'boolean'];
    }
    const args = e.args?.map(next) || [];
    if (['add', 'sub', 'mul', 'max', 'gt'].includes(e.op)) args.forEach(t => requireType(t, 'number'));
    if (['and', 'or'].includes(e.op)) args.forEach(t => requireType(t, 'boolean'));
    return [['add', 'sub', 'mul', 'max'].includes(e.op) ? 'number' : 'boolean'];
  };
  try {
    for (const e of plan.preconditions || []) requireType(visit(e), 'boolean');
    for (const o of plan.outputs) outputs.set(o.id, visit(o.expression));
    return { valid: true };
  } catch { return { valid: false, code: 'READ_EXPRESSION_TYPE' }; }
}

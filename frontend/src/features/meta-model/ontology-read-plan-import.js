// Client preview only. Server validation, replay and publication remain mandatory.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;
const scalar = value => value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || text(value, 2000);
const binary = new Set(['add', 'sub', 'mul', 'max', 'eq', 'ne', 'and', 'or', 'gt']);
function safePlanShape(plan) {
  if (!object(plan) || !id(plan.id) || !text(plan.label, 200) || !Array.isArray(plan.datasets) || !plan.datasets.length || plan.datasets.length > 24
    || !Array.isArray(plan.outputs) || !plan.outputs.length || plan.outputs.length > 24) return false;
  if (new Set(plan.datasets.map(ds => ds?.id)).size !== plan.datasets.length || new Set(plan.outputs.map(output => output?.id)).size !== plan.outputs.length) return false;
  for (const ds of plan.datasets) {
    if (!object(ds) || !id(ds.id) || !id(ds.objectType) || !Array.isArray(ds.where) || ds.where.length !== 1) return false;
    const clause = ds.where[0];
    if (!object(clause) || !id(clause.field) || !(clause.target === true || clause.target === undefined && id(clause.dataset) && id(clause.sourceField))) return false;
    if (ds.filter !== undefined && (!object(ds.filter) || !id(ds.filter.field) || !Array.isArray(ds.filter.values) || !ds.filter.values.length || ds.filter.values.length > 16 || !ds.filter.values.every(scalar))) return false;
    if (ds.expand !== undefined) {
      const expand = ds.expand;
      if (!object(expand) || !['edgeObjectType', 'fromField', 'toField', 'stateField'].every(key => id(expand[key]))
        || !Number.isInteger(expand.maxDepth) || expand.maxDepth < 1 || expand.maxDepth > 8
        || !Array.isArray(expand.activeStates) || !expand.activeStates.length || !Array.isArray(expand.inactiveStates)
        || expand.activeStates.length + expand.inactiveStates.length > 32
        || ![...expand.activeStates, ...expand.inactiveStates].every(value => text(value, 80))) return false;
    }
  }
  if (plan.coverage !== undefined && (!object(plan.coverage) || plan.coverage.mode !== 'bounded_declared_graph' || !Array.isArray(plan.coverage.requiredExpansions)
    || !plan.coverage.requiredExpansions.length || plan.coverage.requiredExpansions.length > 24 || !plan.coverage.requiredExpansions.every(id))) return false;
  if (plan.analysis !== undefined && (!object(plan.analysis) || typeof plan.analysis.enabled !== 'boolean')) return false;
  let nodes = 0;
  const expression = (value, depth = 0) => {
    if (!object(value) || depth > 14 || ++nodes > 800) return false;
    if (value.op === 'literal') return scalar(value.value) && (typeof value.value !== 'string' || value.value.length <= 200);
    if (value.op === 'output') return id(value.id);
    if (['field', 'one'].includes(value.op)) return id(value.dataset) && id(value.field);
    if (value.op === 'lookup') return id(value.dataset) && id(value.field) && id(value.resultField) && expression(value.value, depth + 1);
    if (['sum', 'all'].includes(value.op)) return id(value.dataset) && expression(value.value, depth + 1) && (value.where === undefined || expression(value.where, depth + 1));
    if (value.op === 'if') return ['condition', 'then', 'else'].every(key => expression(value[key], depth + 1));
    return binary.has(value.op) && Array.isArray(value.args) && value.args.length === 2 && value.args.every(arg => expression(arg, depth + 1));
  };
  if (plan.preconditions !== undefined && (!Array.isArray(plan.preconditions) || plan.preconditions.length > 24 || !plan.preconditions.every(value => expression(value)))) return false;
  return plan.outputs.every(output => object(output) && id(output.id) && text(output.label, 100) && text(output.unit, 100) && expression(output.expression));
}

export function parseReadPlanImport(value) {
  const plans = Array.isArray(value) ? value : value?.scenario?.readPlans || value?.readPlans || [value];
  if (!Array.isArray(plans) || plans.length < 1 || plans.length > 3
    || plans.some(plan => !safePlanShape(plan))
    || new Set(plans.map(plan => plan.id)).size !== plans.length) {
    throw new Error('方案结构无效或超过预览上限。支持1–3个不同编号的方案，datasets/outputs各最多24项；请检查关联条件、过滤、前置条件和表达式。结构通过仍需服务端校验与回放。');
  }
  return plans;
}

// Client preview only. Server validation, replay and publication remain mandatory.
export function parseReadPlanImport(value) {
  const plans = Array.isArray(value) ? value : value?.scenario?.readPlans || value?.readPlans || [value];
  if (!Array.isArray(plans) || plans.length < 1 || plans.length > 3
    || plans.some(plan => !plan || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(plan.id)
      || typeof plan.label !== 'string' || !Array.isArray(plan.datasets) || !plan.datasets.length || plan.datasets.length > 24
      || !Array.isArray(plan.outputs) || !plan.outputs.length || plan.outputs.length > 24)
    || new Set(plans.map(plan => plan.id)).size !== plans.length) {
    throw new Error('支持1–3个不同编号的只读方案；编号用字母开头的字母、数字或下划线，每个方案须含名称、datasets 和 outputs（各最多24项）。');
  }
  return plans;
}

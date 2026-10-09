import { getBusinessDecisionCatalog, replayBusinessDecision } from './business-decision-service.js';
import { validateDecisionBinding } from './decision-binding-service.js';
import { validateOntologyReadPlans } from './ontology-read-plan-service.js';

export const modelingProfiles = ['oa-approval', 'general'];
export const objectGranularities = ['unspecified', 'master', 'batch', 'inventory_item', 'transaction', 'event', 'organization'];
export const inferObjectGranularity = (id) => ({ Material: 'master', ProductSKU: 'master', RawMaterialBatch: 'batch', ProductionBatch: 'batch', FinishedGoodsBatch: 'batch', Inventory: 'inventory_item', InventoryLot: 'inventory_item', QualityEvent: 'event' }[id] || 'unspecified');

export function validateOntologyContract(draft) {
  const ids = new Set(draft.objectTypes.map((item) => item.id));
  const catalog = getBusinessDecisionCatalog();
  const scenario = draft.scenario || {};
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, status: passed ? 'passed' : 'failed', detail });
  const readPlans = validateOntologyReadPlans(draft);
  check('受控关联查询与计算', readPlans.status === 'passed', readPlans.code || '仅支持显式 FK、有限只读运算及绑定版本的案例回放；不执行任意脚本。');
  if (readPlans.targets) checks[checks.length - 1].targets = readPlans.targets;
  check('建模场景', modelingProfiles.includes(draft.modelingProfile), '选择通用业务场景或 OA 审批模板；模板选择不改变平台权限。');
  if (draft.modelingProfile === 'general') check('业务目标与验收问题', typeof scenario.objective === 'string' && Boolean(scenario.objective.trim())
    && Array.isArray(scenario.questions) && scenario.questions.length > 0 && scenario.questions.every((item) => typeof item === 'string' && item.trim()), '通用场景必须说明解决什么问题，并至少提供一个可验收的业务问题。');
  check('对象粒度', draft.objectTypes.every((item) => objectGranularities.includes(item.granularity || 'unspecified')),
    '粒度区分主数据、批次、库存项、交易和事件；未指定保持兼容，不自动更改历史主键。');
  check('状态机引用', Array.isArray(draft.stateMachines) && draft.stateMachines.every((machine) => ids.has(machine.object)
    && Array.isArray(machine.states) && machine.states.includes(machine.initial) && Array.isArray(machine.terminal)
    && machine.terminal.every((state) => machine.states.includes(state))), '状态机必须引用本模型对象，初态和终态必须在状态集合中。');
  const decisions = scenario.decisionBindings || [];
  const actions = scenario.actionBindings || [];
  check('案例回放门禁', scenario.requireCaseReplay === undefined || typeof scenario.requireCaseReplay === 'boolean', '案例回放门禁必须为布尔值。');
  check('判断能力绑定', Array.isArray(decisions) && decisions.every((binding) => ids.has(binding?.objectType)
    && catalog.some((item) => item.id === binding.capabilityId && item.version === binding.version)
    && validateDecisionBinding(binding, draft.objectTypes.find((object) => object.id === binding.objectType)))
    && new Set(decisions.map((binding) => `${binding.objectType}:${binding.capabilityId}`)).size === decisions.length, '只能绑定服务端注册的判断及精确版本；参数必须受限，输入映射只能引用当前对象字段，不执行任意表达式。');
  check('动作能力绑定', Array.isArray(actions) && actions.every((binding) => ids.has(binding?.objectType)
    && decisions.some((decision) => decision.objectType === binding.objectType && decision.capabilityId === binding.decisionId)
    && catalog.some((item) => item.id === binding.decisionId && item.toolIds.includes(binding.toolId))), '动作必须关联已绑定的判断；这里仅声明依赖，执行仍需 IAM、目标绑定与一次性确认。');
  check('关系证据与有效期', draft.relationshipTypes.every((relation) => {
    const start = relation.validFrom; const end = relation.validTo;
    return ['declared', 'observed', 'inferred', 'confirmed'].includes(relation.provenanceType || 'declared')
      && (!start || Number.isFinite(Date.parse(start))) && (!end || Number.isFinite(Date.parse(end)))
      && (!start || !end || Date.parse(start) < Date.parse(end))
      && (relation.provenanceType !== 'confirmed' || Boolean(relation.evidence?.trim()));
  }), '关系来源必须明确；有效期使用可解析时间且结束晚于开始。人工确认必须保留证据说明；这不是实例级历史追溯验收。');
  const sections = { '状态机引用': ['stateMachines'], '判断能力绑定': ['decisionBindings'], '动作能力绑定': ['actionBindings'] };
  const validEntry = {
    stateMachines: machine => ids.has(machine.object) && Array.isArray(machine.states) && machine.states.includes(machine.initial) && Array.isArray(machine.terminal) && machine.terminal.every(state => machine.states.includes(state)),
    decisionBindings: binding => ids.has(binding?.objectType) && catalog.some(item => item.id === binding.capabilityId && item.version === binding.version) && validateDecisionBinding(binding, draft.objectTypes.find(object => object.id === binding.objectType)) && decisions.filter(item => item.objectType === binding.objectType && item.capabilityId === binding.capabilityId).length === 1,
    actionBindings: binding => ids.has(binding?.objectType) && decisions.some(decision => decision.objectType === binding.objectType && decision.capabilityId === binding.decisionId) && catalog.some(item => item.id === binding.decisionId && item.toolIds.includes(binding.toolId))
  };
  for (const item of checks.filter(item => item.status === 'failed' && sections[item.name])) {
    item.targets = sections[item.name].flatMap(section => {
      const entries = ['decisionBindings', 'actionBindings'].includes(section) ? scenario[section] : draft[section];
      return (Array.isArray(entries) ? entries : []).flatMap((entry, index) => validEntry[section](entry) ? [] : [{ kind: 'section', section, index, field: 'definition' }]);
    });
  }
  const evidence = checks.find(item => item.name === '关系证据与有效期');
  if (evidence.status === 'failed') evidence.targets = draft.relationshipTypes.filter(relation => !['declared', 'observed', 'inferred', 'confirmed'].includes(relation.provenanceType || 'declared') || relation.provenanceType === 'confirmed' && !relation.evidence?.trim() || relation.validFrom && !Number.isFinite(Date.parse(relation.validFrom)) || relation.validTo && !Number.isFinite(Date.parse(relation.validTo)) || relation.validFrom && relation.validTo && Date.parse(relation.validFrom) >= Date.parse(relation.validTo)).map(relation => ({ kind: 'relation', from: relation.from, predicate: relation.predicate, to: relation.to, field: 'evidence / validFrom / validTo' }));
  return checks;
}

export function replayOntologyDecisions(draft) {
  const ids = [...new Set((draft.scenario?.decisionBindings || []).map((item) => item.capabilityId))];
  const results = ids.map(replayBusinessDecision);
  return { status: results.length ? (results.every((item) => item.status === 'passed') ? 'passed' : 'failed') : 'not_configured',
    coverage: 'synthetic_decision_cases_only', verifiesLiveSystems: false, results };
}

export function buildOntologyImpact(before, after) {
  const oldObjects = new Map(before.objectTypes.map((item) => [item.id, item]));
  const newObjects = new Map(after.objectTypes.map((item) => [item.id, item]));
  const changedObjects = [...new Set([...oldObjects.keys(), ...newObjects.keys()])].filter((id) => JSON.stringify(oldObjects.get(id)) !== JSON.stringify(newObjects.get(id)));
  const changed = new Set(changedObjects);
  const bindings = [...(before.scenario?.decisionBindings || []), ...(after.scenario?.decisionBindings || [])];
  const actions = [...(before.scenario?.actionBindings || []), ...(after.scenario?.actionBindings || [])];
  const contractChanged = JSON.stringify(before.scenario) !== JSON.stringify(after.scenario) || JSON.stringify(before.stateMachines) !== JSON.stringify(after.stateMachines)
    || JSON.stringify(before.relationshipTypes) !== JSON.stringify(after.relationshipTypes) || before.modelingProfile !== after.modelingProfile;
  return { scope: 'declared_model_dependencies_only', changedObjects,
    affectedDecisions: [...new Set(bindings.filter((binding) => contractChanged || changed.has(binding.objectType)).map((binding) => binding.capabilityId))],
    affectedActions: [...new Set(actions.filter((binding) => contractChanged || changed.has(binding.objectType)).map((binding) => binding.toolId))],
    requiresReplay: contractChanged || changedObjects.length > 0,
    externalDependencyCoverage: 'not_verified', businessWritesReverted: false };
}

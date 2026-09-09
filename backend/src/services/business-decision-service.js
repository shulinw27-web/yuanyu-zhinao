// Deterministic, read-only capabilities. Model configuration never grants tool permission.
const qualityDefinition = Object.freeze({
  id: 'quality_disposition', version: '1.0.0', name: '质量异常处置建议',
  description: '承接权威风险等级，给出调查建议；不重新计算缺陷严重度，不执行冻结或放行。',
  inputFields: ['id', 'severity', 'status', 'evidenceIds'],
  outputFields: ['outcome', 'reason', 'recommendations', 'requiresReview'],
  toolIds: ['create_quality_investigation'], mode: 'read_only'
});

const inventoryDefinition = Object.freeze({
  id: 'inventory_readiness', version: '1.0.0', name: '库存可用性核验',
  description: '只核验已授权单条库存快照和同单位需求；不聚合跨仓库存，不预留、不下单、不承诺可交付。',
  inputFields: ['id', 'availableQuantity', 'requiredQuantity', 'unit', 'requiredUnit', 'status', 'evidenceIds'],
  outputFields: ['outcome', 'reason', 'recommendations', 'requiresReview'], toolIds: [], mode: 'read_only'
});
const definitions = [qualityDefinition, inventoryDefinition];
const enums = {
  quality_disposition: { severity: ['P0', 'P1', 'P2', 'P3'], status: ['待确认', '处理中', '已审批', '已关闭', '已解决', 'closed', 'resolved'] },
  inventory_readiness: { status: ['available', 'blocked'] }
};
export const getBusinessDecisionCatalog = () => definitions.map(item => ({ ...structuredClone(item), valueMappingTargets: structuredClone(enums[item.id]) }));
export const getBusinessDecisionDefinition = (id) => getBusinessDecisionCatalog().find(item => item.id === id);

export function evaluateBusinessDecision(id, input = {}, parameters = {}) {
  const definition = getBusinessDecisionDefinition(id);
  if (!definition) return { error: '未注册的业务判断能力。', code: 'DECISION_NOT_REGISTERED' };
  if (!validateDecisionParameters(parameters, id)) return { error: '判断参数无效。', code: 'DECISION_PARAMETERS_INVALID' };
  const result = {
    capabilityId: id, version: definition.version, objectId: typeof input?.id === 'string' && input.id.trim() ? input.id : null,
    outcome: 'needs_review', reason: '', recommendations: [], requiresReview: true,
    evidenceIds: Array.isArray(input?.evidenceIds) ? input.evidenceIds.filter((value) => typeof value === 'string' && value.trim()).slice(0, 30) : [],
    sourceMode: input?.sourceMode === 'mock' ? 'mock' : 'governed_input', effects: [], executionStatus: 'not_requested'
  };
  if (id === inventoryDefinition.id) {
    const quantity = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
    const unit = value => typeof value === 'string' && value.trim().length > 0 && value === value.trim() && value.length <= 32;
    if (!result.objectId || !result.evidenceIds.length || !quantity(input.availableQuantity) || !quantity(input.requiredQuantity)
      || input.requiredQuantity === 0 || !unit(input.unit) || !unit(input.requiredUnit) || input.unit !== input.requiredUnit || !enums.inventory_readiness.status.includes(input.status)) {
      result.reason = '数量、单位、库存状态或证据不完整/不一致；不自动换算单位，也不把账面总量当成可用量。';
    } else if (input.status === 'blocked') {
      result.outcome = 'inventory_blocked'; result.reason = '该库存项受控，不用于需求满足判断；不能据此自动解除冻结。';
    } else {
      result.outcome = input.availableQuantity >= input.requiredQuantity ? 'sufficient_snapshot' : 'insufficient_snapshot';
      result.reason = '仅比较该时间点单条快照的可用量与同单位需求；不代表实时库存、跨仓汇总、已预留或交付承诺。';
    }
    return result;
  }
  if (!result.objectId || !result.evidenceIds.length || !['P0', 'P1', 'P2', 'P3'].includes(input?.severity)
    || !['待确认', '处理中', '已审批', '已关闭', '已解决', 'closed', 'resolved'].includes(input?.status)) {
    result.reason = '目标、风险等级、状态或证据不完整，不能据此建议业务写入。';
  } else if (['已关闭', '已解决', 'closed', 'resolved'].includes(input.status)) {
    result.outcome = 'closed'; result.requiresReview = false;
    result.reason = '异常已关闭；可复盘，不重复建议创建调查。';
  } else if (['处理中', '已审批'].includes(input.status)) {
    result.outcome = 'in_progress';
    result.reason = '异常正在处理或已审批；先查询已有任务与外部回执，不能将审批视为业务完成。';
  } else {
    result.outcome = (parameters.investigationSeverities || ['P0', 'P1']).includes(input.severity) ? 'investigation_recommended' : 'review_recommended';
    result.reason = `来源风险等级为 ${input.severity}；先复核影响范围与现有调查，质量放行、冻结和报废不自动执行。`;
    if (result.outcome === 'investigation_recommended') result.recommendations = [{ toolId: 'create_quality_investigation', stage: 'draft_only', requiresConfirmation: true }];
  }
  return result;
}

export function validateDecisionParameters(parameters = {}, capabilityId = 'quality_disposition') {
  return Boolean(parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    && definitions.some(item => item.id === capabilityId)
    && Object.keys(parameters).every((key) => (capabilityId === 'quality_disposition' ? ['investigationSeverities', 'maxEvidenceAgeMinutes'] : ['maxEvidenceAgeMinutes']).includes(key))
    && (parameters.investigationSeverities === undefined || (Array.isArray(parameters.investigationSeverities)
      && parameters.investigationSeverities.length > 0 && parameters.investigationSeverities.length <= 4
      && new Set(parameters.investigationSeverities).size === parameters.investigationSeverities.length
      && parameters.investigationSeverities.every((item) => ['P0', 'P1', 'P2', 'P3'].includes(item))))
    && (parameters.maxEvidenceAgeMinutes === undefined || (Number.isInteger(parameters.maxEvidenceAgeMinutes) && parameters.maxEvidenceAgeMinutes >= 1 && parameters.maxEvidenceAgeMinutes <= 10080)));
}

const qualityCases = [
  { id: 'critical', patch: {}, expected: 'investigation_recommended' },
  { id: 'high', patch: { severity: 'P1' }, expected: 'investigation_recommended' },
  { id: 'low', patch: { severity: 'P3' }, expected: 'review_recommended' },
  { id: 'already_processing', patch: { status: '处理中' }, expected: 'in_progress' },
  { id: 'approved_is_not_completed', patch: { status: '已审批' }, expected: 'in_progress' },
  { id: 'closed', patch: { status: '已关闭' }, expected: 'closed' },
  { id: 'missing_evidence', patch: { evidenceIds: [] }, expected: 'needs_review' },
  { id: 'unknown_severity', patch: { severity: '严重' }, expected: 'needs_review' },
  { id: 'unknown_state', patch: { status: '未知' }, expected: 'needs_review' }
];

export function replayBusinessDecision(id) {
  if (id === inventoryDefinition.id) {
    const samples = [
      [{}, 'sufficient_snapshot'], [{ requiredQuantity: 11 }, 'insufficient_snapshot'], [{ status: 'blocked' }, 'inventory_blocked'],
      [{ unit: 'g' }, 'needs_review'], [{ availableQuantity: '10' }, 'needs_review'], [{ requiredQuantity: 0 }, 'needs_review'], [{ evidenceIds: [] }, 'needs_review']
    ];
    const cases = samples.map(([patch, expected], index) => {
      const actual = evaluateBusinessDecision(id, { id: 'SYNTHETIC-INVENTORY', availableQuantity: 10, requiredQuantity: 10, unit: 'kg', requiredUnit: 'kg', status: 'available', evidenceIds: ['synthetic'], sourceMode: 'mock', ...patch });
      return { id: `inventory-${index + 1}`, expected, actual: actual.outcome, passed: actual.outcome === expected && actual.effects.length === 0 && actual.executionStatus === 'not_requested' };
    });
    return { capabilityId: id, version: inventoryDefinition.version, status: cases.every(item => item.passed) ? 'passed' : 'failed', coverage: 'synthetic_decision_cases_only', verifiesLiveSystems: false, cases };
  }
  if (id !== qualityDefinition.id) return { capabilityId: id, status: 'failed', cases: [], code: 'DECISION_NOT_REGISTERED' };
  const cases = qualityCases.map((item) => {
    const actual = evaluateBusinessDecision(id, { id: 'SYNTHETIC-RISK-001', severity: 'P0', status: '待确认', evidenceIds: ['synthetic-evidence'], sourceMode: 'mock', ...item.patch });
    return { id: item.id, expected: item.expected, actual: actual.outcome,
      passed: actual.outcome === item.expected && actual.effects.length === 0 && actual.executionStatus === 'not_requested' };
  });
  return { capabilityId: id, version: qualityDefinition.version, status: cases.every((item) => item.passed) ? 'passed' : 'failed',
    coverage: 'synthetic_decision_cases_only', verifiesLiveSystems: false, cases };
}

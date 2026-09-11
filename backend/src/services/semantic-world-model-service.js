import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 20);
const mentions = (text, token) => new RegExp(`(?<![A-Za-z0-9_])${String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`).test(text);
const categories = [
  ['metric', /金额|累计|库存|可用量|缺口|聚合|amount|aggregate/i],
  ['unit', /单位|计量|换算|\bkg\b|currency/i],
  ['state', /状态|隔离|审批|HOLD|approved|state/i],
  ['action_boundary', /授权|执行|放行|权限|不能|不得|不证明|receipt_id/i],
  ['temporal', /快照|时间|分钟|过期|去重|version|as_of/i],
  ['identity', /主数据|粒度|主键|批次|库位|tenant|organization/i]
];

// Requirements are evidence-backed review assets, NEVER executable expressions
// or IAM grants. All statements survive even if the category is unknown.
export function compileWorldModelRequirements(material, objectTypes) {
  const source = String(material || '');
  const statements = [...new Set(source.split(/\n|(?<=[。；;])/u).map(text => text.trim()).filter(Boolean))];
  const rules = statements.slice(0, 100).map(evidence => ({
    id: `requirement-${hash(evidence)}`,
    categories: categories.filter(([, pattern]) => pattern.test(evidence)).map(([kind]) => kind),
    objectTypes: objectTypes.filter(object => mentions(evidence, object.id)).map(object => object.id),
    evidence, sourceHash: hash(source), status: 'pending_review', executable: false
  }));
  const stateCandidates = objectTypes.flatMap(object => object.fieldDefinitions.filter(field => field.enum?.length).map(field => ({
    object: object.id, field: field.name, states: field.enum, initial: null, terminal: [], transitions: [],
    evidence: `${object.id}.${field.name} enum`, status: 'pending_review', executable: false
  })));
  const assets = kind => rules.filter(rule => rule.categories.includes(kind)).map(rule => ({
    id: `${kind}-${rule.id}`, objectTypes: rule.objectTypes,
    fields: objectTypes.filter(object => !rule.objectTypes.length || rule.objectTypes.includes(object.id)).flatMap(object => object.fieldDefinitions.filter(field => mentions(rule.evidence, field.name)).map(field => `${object.id}.${field.name}`)),
    evidence: rule.evidence, sourceRequirementId: rule.id, status: 'pending_review', executable: false
  }));
  return {
    schemaVersion: 'semantic-world-model.v1', status: 'pending_review', rules, stateCandidates,
    metricCandidates: assets('metric'), unitConstraints: assets('unit'), stateConstraints: assets('state'),
    actionBoundaries: assets('action_boundary'), temporalPolicies: assets('temporal'), identityConstraints: assets('identity'),
    coverage: { statementCount: statements.length, preservedCount: rules.length, complete: statements.length <= 100 },
    executionPolicy: '仅供校对；状态初终态、转换、指标和动作必须绑定经过校验的服务器能力，材料不能授予权限。'
  };
}

export function validateProposalEvidence(draft, discovery) {
  if (!discovery?.schemas?.length) return [];
  const failures = [];
  const objects = new Map(draft.objectTypes.map(item => [item.id, item]));
  if (discovery.conflicts?.length) failures.push('材料版本存在未解决冲突');
  for (const expected of discovery.objectTypes) {
    const actual = objects.get(expected.id);
    if (!actual || actual.key !== expected.key || actual.granularity !== expected.granularity
      || JSON.stringify(actual.sourceSystems) !== JSON.stringify(expected.sourceSystems)
      || expected.fieldDefinitions.some(field => !actual.fieldDefinitions.some(other => other.name === field.name && other.type === field.type && other.reference === field.reference && (other.unit || null) === (field.unit || null)))) failures.push(`${expected.id} 来源/粒度/主键/字段与材料不一致`);
  }
  for (const expected of discovery.relationshipTypes) {
    if (!draft.relationshipTypes.some(actual => actual.from === expected.from && actual.to === expected.to && actual.predicate === expected.predicate && actual.cardinality === expected.cardinality)) failures.push(`${expected.from}.${expected.predicate} 关系缺失或基数改变`);
  }
  for (const schema of discovery.schemas) for (const field of schema.fields) {
    if (field.reference && !objects.has(field.reference)) failures.push(`${schema.id}.${field.name} 引用目标尚未提供`);
  }
  failures.push(...(discovery.warnings || []));
  if (draft.worldModel && !draft.worldModel.coverage.complete) failures.push('需求条目超过处理上限，未完整编译');
  return [{ name: '材料语义保真与覆盖', status: failures.length ? 'failed' : 'passed', detail: failures.length ? [...new Set(failures)].join('；') : '对象来源、粒度、主键、字段及显式关系均与输入材料一致；不代表真实业务样本或执行规则已验收。' }];
}

export function proposalBusinessValidation(draft, critic, mapping) {
  const pending = draft.worldModel?.rules?.filter(item => item.status !== 'approved').length || 0;
  return { status: critic.status !== 'passed' ? 'failed' : mapping.status !== 'passed' || pending ? 'review_required' : 'sample_verified',
    structureVerified: critic.status === 'passed', samplesVerified: mapping.status === 'passed', pendingRequirementCount: pending,
    productionReady: false, executionAuthorized: false,
    detail: '结构、样本及需求评审分别列示；草稿采纳不是业务上线验收，也不是执行授权。' };
}

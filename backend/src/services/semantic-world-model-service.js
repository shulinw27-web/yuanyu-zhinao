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

// A reviewer may fill a missing key, never rewrite a declared source contract.
// Keep the discovery immutable: the correction is a separate, server-stamped assertion.
export function preparePrimaryKeyCorrections({ discovery, draft, previous = [], requested, actor, roleId, revision, time }) {
  if (requested === undefined) return { corrections: previous };
  if (!Array.isArray(requested) || requested.length > 40) return { error: '主键补充必须为最多 40 条记录。' };
  const corrections = new Map(previous.map(item => [item.objectId, item]));
  const seen = new Set();
  for (const item of requested) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['objectId', 'field', 'reason'].includes(key))
      || typeof item.reason !== 'string' || item.reason.trim().length < 12 || item.reason.length > 1000 || /[\u0000-\u001f\u007f]/u.test(item.reason)
      || seen.has(item.objectId)) return { error: '每个对象仅能补充一次；需填写 12–1000 字符的依据，不接受客户端审阅人或时间。' };
    seen.add(item.objectId);
    const source = discovery?.objectTypes?.find(object => object.id === item.objectId);
    const actual = draft.objectTypes.find(object => object.id === item.objectId);
    const field = source?.fieldDefinitions.find(field => field.name === item.field);
    const mapped = actual?.fieldDefinitions.find(field => field.name === item.field);
    if (!source || source.key || discovery.conflicts?.some(conflict => conflict.objectId === item.objectId)
      || !field || !['string', 'integer', 'number'].includes(field.type) || actual?.key !== item.field
      || mapped?.sourceField !== (field.sourceField || field.name) || !['mapped', 'manual'].includes(mapped?.mappingStatus)) return { error: '仅能为原材料缺主键且无版本冲突的对象，选择原材料已有的标量字段并绑定该源字段；必须与本次主键选择一致。' };
    corrections.set(item.objectId, { objectId: item.objectId, field: item.field, reason: item.reason.trim(),
      sourceFingerprint: hash(JSON.stringify(source)), actor, roleId, revision, time, kind: 'human_missing_key_assertion' });
  }
  return { corrections: [...corrections.values()] };
}

export function validateProposalEvidence(draft, discovery, primaryKeyCorrections = []) {
  if (!discovery?.schemas?.length) return [];
  const failures = [];
  const objects = new Map(draft.objectTypes.map(item => [item.id, item]));
  if (discovery.conflicts?.length) failures.push('材料版本存在未解决冲突');
  const corrected = new Set();
  for (const expected of discovery.objectTypes) {
    const actual = objects.get(expected.id);
    const correction = primaryKeyCorrections.find(item => item.objectId === expected.id && item.kind === 'human_missing_key_assertion'
      && item.sourceFingerprint === hash(JSON.stringify(expected)) && item.field === actual?.key
      && expected.fieldDefinitions.some(field => field.name === item.field && ['string', 'integer', 'number'].includes(field.type)
        && actual.fieldDefinitions.some(mapped => mapped.name === field.name && mapped.sourceField === (field.sourceField || field.name) && ['mapped', 'manual'].includes(mapped.mappingStatus))));
    if (!expected.key && correction && !discovery.conflicts?.some(item => item.objectId === expected.id)) corrected.add(expected.id);
    if (!actual || (actual.key !== expected.key && !corrected.has(expected.id)) || actual.granularity !== expected.granularity
      || JSON.stringify(actual.sourceSystems) !== JSON.stringify(expected.sourceSystems)
      || expected.fieldDefinitions.some(field => !actual.fieldDefinitions.some(other => other.name === field.name && other.type === field.type && other.reference === field.reference && (other.unit || null) === (field.unit || null)))) failures.push(`${expected.id} 来源/粒度/主键/字段与材料不一致`);
  }
  for (const expected of discovery.relationshipTypes) {
    if (!draft.relationshipTypes.some(actual => actual.from === expected.from && actual.to === expected.to && actual.predicate === expected.predicate && actual.cardinality === expected.cardinality)) failures.push(`${expected.from}.${expected.predicate} 关系缺失或基数改变`);
  }
  for (const schema of discovery.schemas) for (const field of schema.fields) {
    if (field.reference && !objects.has(field.reference)) failures.push(`${schema.id}.${field.name} 引用目标尚未提供`);
  }
  failures.push(...(discovery.warnings || []).filter(warning => ![...corrected].some(id => warning === `${id}：未识别主键，进入 Review Queue 后必须补充。`)));
  if (draft.worldModel && !draft.worldModel.coverage.complete) failures.push('需求条目超过处理上限，未完整编译');
  return [{ name: '材料语义保真与覆盖', status: failures.length ? 'failed' : 'passed', detail: failures.length ? [...new Set(failures)].join('；') : `对象来源、粒度、字段及显式关系与材料一致；${corrected.size ? `${corrected.size} 个缺失主键采用有记录的人工补充，不代表原材料已经声明或业务唯一性已证实` : '主键与材料一致'}；不代表真实业务样本或执行规则已验收。` }];
}

export function proposalBusinessValidation(draft, critic, mapping) {
  const pending = draft.worldModel?.rules?.filter(item => item.status !== 'approved').length || 0;
  return { status: critic.status !== 'passed' ? 'failed' : mapping.status !== 'passed' || pending ? 'review_required' : 'sample_verified',
    structureVerified: critic.status === 'passed', samplesVerified: mapping.status === 'passed', pendingRequirementCount: pending,
    productionReady: false, executionAuthorized: false,
    detail: '结构、样本及需求评审分别列示；草稿采纳不是业务上线验收，也不是执行授权。' };
}

// Structural references only: no business reads, scripts, or deletion decisions.
const sections = ['relationshipTypes', 'scenario', 'policies', 'stateMachines', 'events', 'metrics', 'dataContracts', 'qualityRules', 'glossaryTerms', 'accessPolicies', 'lineageEdges', 'worldModel', 'sourceAssignments', 'primaryKeyCorrections', 'identityLinkConfirmations'];
export function collectSemanticObjectDependencies(models, object, { includeTargetObject = false } = {}) {
  if (!object?.id || typeof object.id !== 'string' || !Array.isArray(models)) return { error: '依赖检查目标无效。', code: 'SEMANTIC_DEPENDENCY_TARGET_INVALID' };
  const tokens = [object.id, object.label].filter(value => typeof value === 'string' && value).map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const mentions = new RegExp(`(^|[^A-Za-z0-9_])(?:${tokens.join('|')})($|[^A-Za-z0-9_])`, 'u');
  const dependencies = []; let total = 0; let nodes = 0;
  function visit(value, path, section, scope, depth = 0) {
    if (++nodes > 20000 || depth > 24) throw new Error('budget');
    if (typeof value === 'string') {
      if (mentions.test(value)) add(path, section, scope, 'reference_or_mention');
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const part = Array.isArray(value) ? Number(key) : key.slice(0, 80);
      if (!Array.isArray(value) && mentions.test(key)) add([...path, part], section, scope, 'configuration_key');
      visit(item, [...path, part], section, scope, depth + 1);
    }
  }
  function add(path, section, scope, matchKind) {
    total += 1;
    if (dependencies.length < 100) dependencies.push({ scope, section, path, matchKind });
  }
  try {
    for (const { scope, model } of models) {
      if (!model || !['candidate', 'draft', 'original'].includes(scope)) return { error: '依赖检查模型范围无效。', code: 'SEMANTIC_DEPENDENCY_TARGET_INVALID' };
      for (const [index, item] of (model.objectTypes || []).entries()) if (includeTargetObject || item.id !== object.id) visit(item, ['objectTypes', index], 'objectTypes', scope);
      for (const section of sections) visit(model[section], [section], section, scope);
    }
  } catch { return { error: '模型依赖检查超出2万节点或24层预算，不能确认影响范围。', code: 'SEMANTIC_DEPENDENCY_BUDGET', complete: false, dependencies: [] }; }
  return { complete: true, dependencies, total, truncated: total > dependencies.length, inspectedNodes: nodes,
    boundary: '仅检查当前候选、草稿和原提案的配置引用/同名提及；不是外部系统依赖扫描或允许删除的证明。' };
}

export function collectSemanticFieldDependencies(models, objectId, fieldName) {
  if (!Array.isArray(models) || !/^[A-Za-z][A-Za-z0-9_]{0,47}$/u.test(objectId || '') || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(fieldName || '')) return { error: '字段依赖目标无效。', code: 'SEMANTIC_DEPENDENCY_TARGET_INVALID' };
  // Preserve array indices in reported paths; omit only the declaration itself.
  let filtered;
  try {
    let prepared = 0;
    filtered = models.map(({ scope, model }) => ({ scope, model: model && { ...model, objectTypes: (model.objectTypes || []).map(item => {
      if (++prepared > 20000) throw new Error('budget');
      if (item.id !== objectId) return item;
      prepared += (item.fields || []).length + (item.fieldDefinitions || []).length;
      if (prepared > 20000) throw new Error('budget');
      return { ...item, key: item.key === fieldName ? null : item.key,
        fields: (item.fields || []).map(name => name === fieldName ? null : name),
        fieldDefinitions: (item.fieldDefinitions || []).map(field => field.name === fieldName ? null : field) };
    }) } }));
  } catch { return { error: '字段依赖配置结构无效或超出处理预算。', code: 'SEMANTIC_DEPENDENCY_BUDGET', complete: false, dependencies: [] }; }
  return collectSemanticObjectDependencies(filtered, { id: fieldName, label: `${objectId}.${fieldName}` }, { includeTargetObject: true });
}

export const isSemanticDependencyCommand = text => /^(?:请)?检查(?:对象|字段)(?:删除|变更)影响/u.test(String(text).trim());
export function parseSemanticDependencyCommand(text) {
  const field = /^(?:请)?检查字段(?:删除|变更)影响([“"])([A-Za-z][A-Za-z0-9_]{0,47})\.([A-Za-z][A-Za-z0-9_]{0,63})([”"])[。！!]?$/u.exec(String(text).trim());
  if (field && field[4] === (field[1] === '“' ? '”' : '"')) return { objectId: field[2], fieldName: field[3] };
  const match = /^(?:请)?检查对象(?:删除|变更)影响([“"])([A-Za-z][A-Za-z0-9_]{0,47})([”"])[。！!]?$/u.exec(String(text).trim());
  if (!match || match[3] !== (match[1] === '“' ? '”' : '"')) return { error: '请明确对象或字段编码，例如：检查对象删除影响“Customer”或检查字段删除影响“Customer.name”。不接受混合执行指令。', code: 'SEMANTIC_DEPENDENCY_TARGET_INVALID' };
  return { objectId: match[2] };
}

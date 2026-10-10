// Local candidate editing only. No requests, authorization grants or publication.
export function mappingJoinChoices(draft, relation) {
  if (!relation) return [];
  const choices = [];
  for (const plan of draft?.scenario?.readPlans || []) for (const [index, dataset] of (plan.datasets || []).entries()) {
    const clause = dataset.where?.[0];
    const source = plan.datasets.slice(0, index).find(item => item.id === clause?.dataset);
    const forward = source?.objectType === relation.from && dataset.objectType === relation.to;
    const reverse = source?.objectType === relation.to && dataset.objectType === relation.from;
    if (dataset.where?.length === 1 && !clause.target && (forward || reverse)) choices.push({ key: JSON.stringify([plan.id, dataset.id]), planId: plan.id, datasetId: dataset.id, direction: forward ? 'forward' : 'reverse', label: `${plan.label || plan.id} · ${source.id} → ${dataset.id}${!forward ? '（反向查询）' : ''}`, sourceField: clause.sourceField, targetField: clause.field });
  }
  return choices;
}

export function proposeOntologyMapping(draft, selection) {
  const fail = message => { throw new Error(message); };
  const relation = draft?.relationshipTypes?.find(item => JSON.stringify([item.from, item.predicate, item.to]) === selection.relationKey);
  const join = mappingJoinChoices(draft, relation).find(item => item.key === selection.joinKey);
  if (!relation || !join) fail('请选择明确方向的业务关系和现有读取步骤；不会自动创建方案或猜测关联。');
  if (draft.scenario.decisionBindings?.length) fail('现有判断绑定需先由运营明确处理，不能自动移除。');
  const type = draft.objectTypes.find(item => item.id === selection.objectType);
  if (!type || type.sourceSystems?.length !== 1) fail('请选择已声明且仅有一个来源系统的对照对象。');
  const reverse = join.direction === 'reverse';
  const source = draft.objectTypes.find(item => item.id === (reverse ? relation.to : relation.from)); const target = draft.objectTypes.find(item => item.id === (reverse ? relation.from : relation.to));
  if (!source?.fields.includes(join.sourceField) || !target?.fields.includes(join.targetField)) fail('读取步骤两端字段已变化，请重新核对。');
  const names = ['fromField', 'toField', 'statusField', 'versionField', 'validFromField', 'validToField'];
  if (names.some(name => !type.fields.includes(selection[name])) || new Set(names.map(name => selection[name])).size !== names.length) fail('六个对照字段必须存在，且不能重复使用。');
  for (const [name, endpoint, field] of reverse ? [[selection.fromField, target, join.targetField], [selection.toField, source, join.sourceField]] : [[selection.fromField, source, join.sourceField], [selection.toField, target, join.targetField]]) {
    if (!type.fieldDefinitions?.some(def => def.name === name && def.reference === endpoint.id && (def.referenceField || endpoint.key) === field)) fail('对照编码字段必须已明确引用业务关系两端字段；请先补齐字段引用，不按名字猜测。');
  }
  const owner = selection.owner?.trim(); const version = selection.version?.trim();
  if (!owner || owner.length > 48 || !version || version.length > 24 || /[\u0000-\u001f\u007f]/.test(owner + version)) fail('维护人必填且最多48字，映射版本必填且最多24字。');
  const asOf = selection.asOf;
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(asOf) || !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== (asOf.includes('.') ? asOf : asOf.replace('Z', '.000Z'))) fail('请输入明确的UTC有效时点，例如2026-10-09T00:00:00Z。');
  const next = JSON.parse(JSON.stringify(draft));
  const nextRelation = next.relationshipTypes.find(item => JSON.stringify([item.from, item.predicate, item.to]) === selection.relationKey);
  nextRelation.keyMapping = { fromField: reverse ? join.targetField : join.sourceField, toField: reverse ? join.sourceField : join.targetField, basis: 'master_data_lookup', lookupSource: type.id, owner, version };
  const clause = next.scenario.readPlans.find(plan => plan.id === join.planId).datasets.find(dataset => dataset.id === join.datasetId).where[0];
  clause.mapping = { predicate: relation.predicate, objectType: type.id, ...Object.fromEntries(names.map(name => [name, selection[name]])), asOf };
  if (reverse) clause.mapping.direction = 'reverse';
  next.scenario.requireCaseReplay = true;
  const affectedSteps = mappingJoinChoices(draft, relation).length;
  return { draft: next, affectedSteps, summary: `${source.label || source.id}.${join.sourceField} → ${type.label || type.id}（${selection.fromField} → ${selection.toField}）→ ${target.label || target.id}.${join.targetField}；版本 ${version}，UTC时点 ${asOf}。` };
}

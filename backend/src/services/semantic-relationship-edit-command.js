// Explicit type-level declarations, not record joins or identity equivalence.
const fail = (code, error) => ({ code, error });
const cardinalities = { 一对一: '1:1', 一对多: '1:n', 多对一: 'n:1', 多对多: 'n:n' };
const pattern = /^(?:请)?新增关系([“"])([^”"\r\n]{1,100})([”"])[，,]\s*从([“"])([^”"\r\n]{1,100})([”"])到([“"])([^”"\r\n]{1,100})([”"])[，,]\s*名称([“"])([^”"\r\n]{1,60})([”"])[，,]\s*基数([“"])([^”"\r\n]{1,20})([”"])[，,]\s*依据([“"])([^”"\r\n]{1,100})([”"])[。！!]?$/u;

export function parseExplicitRelationshipAddition(text, proposal) {
  const match = pattern.exec(text);
  if (!match) return fail('SEMANTIC_EDIT_NEEDS_CLARIFICATION', '请明确关系编码、起点、终点、名称、基数与依据，例如：新增关系“supplies”，从“Supplier”到“PurchaseOrder”，名称“供货订单”，基数“一对多”，依据“采购制度规定供应商可关联多张订单”。');
  for (let index = 1; index <= 16; index += 3) {
    if (match[index + 2] !== (match[index] === '“' ? '”' : '"')) return fail('SEMANTIC_EDIT_NEEDS_CLARIFICATION', '关系指令引号未配对，未新增关系。');
  }
  const predicate = match[2]; const fromName = match[5]; const toName = match[8];
  const label = match[11]; const cardinality = cardinalities[match[14]] || match[14]; const evidence = match[17];
  if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/u.test(predicate) || ['constructor', 'prototype', '__proto__'].includes(predicate)
    || !['1:1', '1:n', 'n:1', 'n:n'].includes(cardinality) || !label.trim() || !evidence.trim()
    || /[\u0000-\u001f\u007f]/u.test(label + evidence)) return fail('SEMANTIC_EDIT_VALUE_INVALID', '关系编码、基数、名称或依据无效；不接收路径和脚本。');
  const resolve = name => (proposal.objectTypes || []).filter(object => object.id === name || object.label === name);
  const from = resolve(fromName); const to = resolve(toName);
  if (from.length !== 1 || to.length !== 1) return fail('SEMANTIC_EDIT_TARGET_AMBIGUOUS', '关系两端必须是本次候选中唯一的对象，请使用稳定对象编码。');
  const relationships = proposal.relationshipTypes;
  if (!Array.isArray(relationships) || relationships.length >= 40) return fail('SEMANTIC_EDIT_RELATION_BUDGET', '候选关系结构缺失或已达40条预算，未新增关系。');
  if (relationships.some(item => item.from === from[0].id && item.to === to[0].id && item.predicate === predicate)) return fail('SEMANTIC_EDIT_RELATION_CONFLICT', '同一方向及编码的关系已存在，请修改已有关系，不会覆盖原定义。');
  const body = structuredClone({ objectTypes: proposal.objectTypes, relationshipTypes: relationships });
  body.relationshipTypes.push({ from: from[0].id, predicate, to: to[0].id, label: label.trim(), cardinality, evidence: evidence.trim(), provenanceType: 'declared' });
  return { body, operationKey: JSON.stringify(['relationship-add', from[0].id, predicate, to[0].id]), summary: `${from[0].id}/${predicate}/${to[0].id} · 新增${cardinality}声明关系；依据为用户陈述，未建立数据匹配或验证业务事实` };
}

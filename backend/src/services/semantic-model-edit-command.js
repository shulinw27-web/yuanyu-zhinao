// Explicit single-item edits only. Never infer fields, keys, sources or authority.
export function parseSemanticModelEdit(text, proposal) {
  const match = /^(?:请)?(?:把|将)[“"]([^”"\n]{1,100})[”"](?:的)?(业务名称|业务域|业务说明|关系名称|关系基数|关系依据)(?:修改为|改为|设置为)[“"]([^”"\n]{1,300})[”"](?:[。！!])?$/.exec(String(text).trim());
  if (!match) return { error: '请明确单项修改，例如：将“原料批次”的业务域改为“采购”。新增/删除对象、字段与执行计划请在模型校对中配置，修改不代表发布。', code: 'SEMANTIC_EDIT_NEEDS_CLARIFICATION' };
  const [, name, field, value] = match;
  const relation = field.startsWith('关系');
  const list = relation ? proposal.relationshipTypes : proposal.objectTypes;
  const candidates = list.filter(item => relation ? item.label === name || item.predicate === name || JSON.stringify([item.from, item.predicate, item.to]) === name : item.id === name || item.label === name);
  if (candidates.length !== 1) return { error: '对象或关系不存在或同名，请使用稳定对象编码或唯一关系名称，不会猜测目标。', code: 'SEMANTIC_EDIT_TARGET_AMBIGUOUS' };
  const key = { '业务名称': 'label', '业务域': 'businessDomain', '业务说明': 'description', '关系名称': 'label', '关系基数': 'cardinality', '关系依据': 'evidence' }[field];
  const limit = key === 'description' ? 300 : key === 'evidence' ? 260 : relation ? 60 : 48;
  const cardinality = { '一对一': '1:1', '一对多': '1:n', '多对一': 'n:1', '多对多': 'n:n' }[value] || value;
  if (value.length > limit || /[\u0000-\u001f\u007f]/.test(value) || key === 'cardinality' && !['1:1', '1:n', 'n:1', 'n:n'].includes(cardinality)) return { error: '修改值超长或关系基数无效，未修订。', code: 'SEMANTIC_EDIT_VALUE_INVALID' };
  const body = structuredClone({ objectTypes: proposal.objectTypes, relationshipTypes: proposal.relationshipTypes });
  const index = list.indexOf(candidates[0]); body[relation ? 'relationshipTypes' : 'objectTypes'][index][key] = key === 'cardinality' ? cardinality : value;
  return { body, summary: `${name} · ${field} → ${value}` };
}

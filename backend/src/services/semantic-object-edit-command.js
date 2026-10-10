// Explicit structural candidate only. Never invent a source, grant or record.
const pattern = /^(?:请)?新增对象([“"])([^”"\r\n]{1,48})([”"])[，,]\s*名称([“"])([^”"\r\n]{1,48})([”"])[，,]\s*主键([“"])([^”"\r\n]{1,64})([”"])[，,]\s*类型([“"])([^”"\r\n]{1,20})([”"])[，,]\s*业务域([“"])([^”"\r\n]{1,48})([”"])[，,]\s*字段([“"])([^”"\r\n]{1,64})([”"])[，,]\s*字段类型([“"])([^”"\r\n]{1,20})([”"])[。！!]?$/u;
const fail = (code, error) => ({ code, error });
export function parseExplicitObjectAddition(text, proposal) {
  const match = pattern.exec(text);
  const clarification = () => fail('SEMANTIC_EDIT_NEEDS_CLARIFICATION', '请明确对象编码、名称、主键类型、业务域和至少一个普通字段，例如：新增对象“Customer”，名称“客户”，主键“customer_id”，类型“文本”，业务域“销售”，字段“name”，字段类型“文本”。来源和字段映射仍待确认。');
  if (!match) return clarification();
  for (let index = 1; index <= 19; index += 3) if (match[index + 2] !== (match[index] === '“' ? '”' : '"')) return clarification();
  const id = match[2]; const label = match[5].trim(); const key = match[8]; const domain = match[14].trim();
  const type = { 文本: 'string', 字符串: 'string', 整数: 'integer' }[match[11]] || match[11];
  const field = match[17]; const fieldType = { 文本: 'string', 字符串: 'string', 整数: 'integer', 数值: 'number', 布尔: 'boolean', 日期: 'date', 日期时间: 'datetime' }[match[20]] || match[20];
  const reserved = new Set(['constructor', 'prototype', '__proto__']);
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(id) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)
    || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(field) || field === key || reserved.has(field) || !['string', 'integer', 'number', 'boolean', 'date', 'datetime'].includes(fieldType)
    || reserved.has(id) || reserved.has(key) || !['string', 'integer'].includes(type) || !label || !domain || /[\u0000-\u001f\u007f]/u.test(label + domain)) return fail('SEMANTIC_EDIT_VALUE_INVALID', '对象/主键/字段编码、名称、业务域或类型无效；主键仅支持文本或整数，普通字段不能与主键重名，不接收脚本、路径或表达式。');
  if (!Array.isArray(proposal?.objectTypes) || !Array.isArray(proposal?.relationshipTypes) || proposal.objectTypes.length >= 40) return fail('SEMANTIC_EDIT_OBJECT_BUDGET', '候选对象结构缺失或已达40对象上限，未新增。');
  if (proposal.objectTypes.some(item => item.id === id || item.label === label || item.label === id || item.id === label)) return fail('SEMANTIC_EDIT_OBJECT_CONFLICT', '对象编码或名称与现有候选冲突，不会覆盖或推断同义对象。');
  const body = structuredClone({ objectTypes: proposal.objectTypes, relationshipTypes: proposal.relationshipTypes });
  body.objectTypes.push({ id, label, businessDomain: domain, source: '用户显式声明，来源待确认', sourceSystems: ['UNASSIGNED'], classification: 'internal',
    semanticType: id, coreObject: id, key, fields: [key, field], fieldDefinitions: [{ name: key, type, primaryKey: true, required: true, sourceField: '', mappingStatus: 'pending', reference: null },
      { name: field, type: fieldType, primaryKey: false, required: false, sourceField: '', mappingStatus: 'pending', reference: null }], description: '' });
  return { body, operationKey: JSON.stringify(['object-add', id]), summary: `${id} · 新增${label}候选，主键${key}（${type}）；来源、字段映射及业务依据待核对，未读取或创建业务记录` };
}

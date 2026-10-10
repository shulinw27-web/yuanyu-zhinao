// Explicit candidate edits only. Never infer keys, sources, mappings or authority.
import { inspectCandidateFieldRemoval } from './semantic-field-removal.js';
import { parseExplicitRelationshipAddition } from './semantic-relationship-edit-command.js';
import { parseExplicitObjectAddition } from './semantic-object-edit-command.js';
const propertyNames = '业务名称|业务域|业务说明|关系名称|关系基数|关系依据|字段说明|字段单位|字段类型|字段必填|字段枚举';
const propertyPattern = new RegExp(`^(?:请)?(?:把|将)([“"])([^”"\\r\\n]{1,100})([”"])(?:的)?(${propertyNames})(?:修改为|改为|设置为)([“"])([^”"\\r\\n]{1,300})([”"])(?:[。！!])?$`, 'u');
const typeAliases = { 文本: 'string', 字符串: 'string', 数值: 'number', 整数: 'integer', 布尔: 'boolean', 日期: 'date', 日期时间: 'datetime' };
const safeTypes = new Set(['string', 'number', 'integer', 'boolean', 'date', 'datetime']);
const quotePair = (opening, closing) => opening === '“' ? closing === '”' : closing === '"';
const failure = (code, error) => ({ code, error });
const candidateBody = proposal => structuredClone({ objectTypes: proposal.objectTypes, relationshipTypes: proposal.relationshipTypes });
const resolveObject = (proposal, name) => (proposal.objectTypes || []).filter(item => item.id === name || item.label === name);
export function isSemanticModelEditCommand(text) {
  const value = String(text).trim();
  return /^(?:请)?(?:把|将)[“"]/u.test(value) && new RegExp(`(?:${propertyNames})(?:修改为|改为|设置为)`, 'u').test(value)
    || /^(?:请)?(?:给|为)[“"]/u.test(value) && /(?:新增|添加)字段/u.test(value)
    || /^(?:请)?(?:撤回|删除)候选字段/u.test(value)
    || /^(?:请)?新增(?:关系|对象)/u.test(value);
}

function addExplicitField(text, proposal) {
  const match = /^(?:请)?(?:给|为)([“"])([^”"\r\n]{1,100})([”"])(?:新增|添加)字段([“"])([^”"\r\n]{1,64})([”"])[，,]\s*类型([“"])([^”"\r\n]{1,20})([”"])(?:[，,]\s*说明([“"])([^”"\r\n]{1,180})([”"]))?[。！!]?$/u.exec(text);
  if (!match || !quotePair(match[1], match[3]) || !quotePair(match[4], match[6]) || !quotePair(match[7], match[9]) || match[10] && !quotePair(match[10], match[12])) return failure('SEMANTIC_EDIT_NEEDS_CLARIFICATION', '请明确对象、字段和类型，例如：给“InventoryLot”新增字段“risk_score”，类型“number”，说明“待确认风险分”。');
  const [, , name, , , fieldName, , , inputType, , , description] = match;
  const objects = resolveObject(proposal, name); const type = typeAliases[inputType] || inputType;
  if (objects.length !== 1) return failure('SEMANTIC_EDIT_TARGET_AMBIGUOUS', '对象不存在或同名，请使用稳定对象编码。');
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(fieldName) || ['constructor', 'prototype', '__proto__'].includes(fieldName) || !safeTypes.has(type)) return failure('SEMANTIC_EDIT_VALUE_INVALID', '字段编码或类型无效，不能填写路径、表达式或脚本。');
  const object = objects[0];
  if (!Array.isArray(object.fieldDefinitions) || object.fieldDefinitions.length >= 80 || object.fieldDefinitions.some(field => field.name === fieldName) || object.fields?.includes(fieldName)) return failure('SEMANTIC_EDIT_FIELD_CONFLICT', '字段已存在、字段结构缺失或超过80字段预算，未修改候选。');
  if (description && /[\u0000-\u001f\u007f]/u.test(description)) return failure('SEMANTIC_EDIT_VALUE_INVALID', '字段说明包含无效控制字符。');
  const body = candidateBody(proposal); const changed = body.objectTypes.find(item => item.id === object.id);
  changed.fieldDefinitions.push({ name: fieldName, type, required: false, primaryKey: false, sourceField: '', mappingStatus: 'pending', reference: null, description: description || null });
  changed.fields = changed.fieldDefinitions.map(field => field.name);
  return { body, operationKey: JSON.stringify(['field-add', object.id, fieldName]), summary: `${object.id}.${fieldName} · 新增${type}字段；来源映射待确认，不可据此发布` };
}

export function parseSemanticModelEdit(text, proposal, baseline) {
  const input = String(text).trim();
  if (input.length > 4000) return failure('SEMANTIC_EDIT_BATCH_BUDGET', '修订指令最多4000字符、8项修改。');
  const commands = []; let quote = null; let start = 0;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (['“', '”', '"'].includes(char)) return failure('SEMANTIC_EDIT_NEEDS_CLARIFICATION', '引号未正确配对，整批未修改。');
    } else if (char === '“' || char === '"') quote = char === '“' ? '”' : '"';
    else if (char === '”') return failure('SEMANTIC_EDIT_NEEDS_CLARIFICATION', '引号未正确配对，整批未修改。');
    else if (char === ';' || char === '；') { commands.push(input.slice(start, index).trim()); start = index + 1; }
  }
  if (quote) return failure('SEMANTIC_EDIT_NEEDS_CLARIFICATION', '引号未正确配对，整批未修改。');
  commands.push(input.slice(start).trim());
  if (commands.length > 8) return failure('SEMANTIC_EDIT_BATCH_BUDGET', '每批最多8项修改，请分批预览和校验。');
  if (commands.some(command => !command)) return failure('SEMANTIC_EDIT_NEEDS_CLARIFICATION', '分号之间不能有空指令，整批未修改。');
  if (commands.length === 1) return parseSingleSemanticModelEdit(commands[0], proposal, baseline);
  if (commands.some(command => /^(?:请)?(?:撤回|删除)候选字段/u.test(command))) return failure('SEMANTIC_EDIT_BATCH_WITHDRAWAL_FORBIDDEN', '撤回候选字段需单独提交，以检查完整依赖；整批未修改。');
  let staged = proposal; const summaries = []; const operations = new Set();
  for (let index = 0; index < commands.length; index++) {
    const result = parseSingleSemanticModelEdit(commands[index], staged, baseline);
    if (result.error) return { ...result, commandIndex: index + 1, error: `第${index + 1}项：${result.error} 整批未修改。` };
    if (operations.has(result.operationKey)) return { ...failure('SEMANTIC_EDIT_BATCH_CONFLICT', '同一目标属性被重复修改，请消除冲突后重试；整批未修改。'), commandIndex: index + 1 };
    operations.add(result.operationKey); summaries.push(result.summary); staged = { ...staged, ...result.body };
  }
  return { body: candidateBody(staged), summary: `共${commands.length}项候选修订：${summaries.join('；')}` };
}

function parseSingleSemanticModelEdit(text, proposal, baseline) {
  const input = String(text).trim();
  if (/^(?:请)?新增对象/u.test(input)) return parseExplicitObjectAddition(input, proposal);
  if (/^(?:请)?新增关系/u.test(input)) return parseExplicitRelationshipAddition(input, proposal);
  if (/^(?:请)?(?:撤回|删除)候选字段/u.test(input)) {
    const removal = /^(?:请)?(?:撤回|删除)候选字段([“"])([^”"\r\n]{1,100})([”"])[。！!]?$/u.exec(input);
    if (!removal || !quotePair(removal[1], removal[3]) || removal[2].split('.').length !== 2) return failure('SEMANTIC_EDIT_NEEDS_CLARIFICATION', '请明确撤回单个候选字段，例如：撤回候选字段“Supplier.risk_score”。不删除底层数据。');
    const [name, fieldName] = removal[2].split('.'); const objects = resolveObject(proposal, name);
    if (objects.length !== 1 || objects[0].fieldDefinitions?.filter(field => field.name === fieldName).length !== 1) return failure('SEMANTIC_EDIT_TARGET_AMBIGUOUS', '对象或字段不存在或有歧义，未撤回候选字段。');
    const checked = inspectCandidateFieldRemoval(proposal, baseline, objects[0].id, fieldName);
    if (!checked.allowed) return checked;
    const body = candidateBody(proposal); const changed = body.objectTypes.find(item => item.id === objects[0].id);
    changed.fieldDefinitions = changed.fieldDefinitions.filter(field => field.name !== fieldName); changed.fields = changed.fieldDefinitions.map(field => field.name);
    return { body, withdrawal: { objectId: objects[0].id, fieldName }, summary: `${objects[0].id}.${fieldName} · 撤回未映射新候选字段；未删除草稿字段或底层数据` };
  }
  if (/^(?:请)?(?:给|为)[“"]/u.test(input)) return addExplicitField(input, proposal);
  const match = propertyPattern.exec(input);
  if (!match || !quotePair(match[1], match[3]) || !quotePair(match[5], match[7])) return { error: '请明确单项修改，例如：将“InventoryLot.quantity”的字段单位改为“kg”。修改不代表发布。', code: 'SEMANTIC_EDIT_NEEDS_CLARIFICATION' };
  const [, , name, , field, , value] = match;
  if (field.startsWith('字段')) {
    const pieces = name.split('.');
    if (pieces.length !== 2) return failure('SEMANTIC_EDIT_TARGET_AMBIGUOUS', '请用“对象编码.字段编码”明确指定字段，不猜测同名字段。');
    const objects = resolveObject(proposal, pieces[0]);
    const definitions = objects.length === 1 ? (objects[0].fieldDefinitions || []).filter(item => item.name === pieces[1]) : [];
    if (definitions.length !== 1) return failure('SEMANTIC_EDIT_TARGET_AMBIGUOUS', '对象或字段不存在或有歧义，未修改候选。');
    const target = definitions[0]; const key = { 字段说明: 'description', 字段单位: 'unit', 字段类型: 'type', 字段必填: 'required', 字段枚举: 'enum' }[field];
    let next = value;
    if (/[\u0000-\u001f\u007f]/u.test(value) || value.length > (key === 'description' ? 180 : key === 'unit' ? 80 : 300)) return failure('SEMANTIC_EDIT_VALUE_INVALID', '字段修改值超长或包含无效字符。');
    if (key === 'type') { next = typeAliases[value] || value; if (!safeTypes.has(next)) return failure('SEMANTIC_EDIT_VALUE_INVALID', '仅支持文本、数值、整数、布尔、日期和日期时间类型，不接收表达式。'); }
    if (key === 'required') { next = { 是: true, 否: false, true: true, false: false, 必填: true, 可选: false }[value]; if (next === undefined) return failure('SEMANTIC_EDIT_VALUE_INVALID', '字段必填请填写“是”或“否”。'); }
    if ((target.primaryKey || objects[0].key === target.name) && (key === 'type' || key === 'required' && !next)) return failure('SEMANTIC_EDIT_KEY_CHANGE_REQUIRES_REVIEW', '主键类型或必填约束不能通过普通字段指令修改，请使用专门的主键校对流程。');
    if (key === 'enum') {
      if ((typeAliases[target.type] || target.type || 'string') !== 'string') return failure('SEMANTIC_EDIT_VALUE_INVALID', '当前仅支持文本字段枚举，不自动转换数值或布尔类型。');
      next = value === '清空' ? [] : value.split(/[,，]/u).map(item => item.trim());
      if (next.length > 30 || next.some(item => !item || item.length > 120) || new Set(next).size !== next.length) return failure('SEMANTIC_EDIT_VALUE_INVALID', '枚举需为最多30个不重复的文本值，以逗号分隔。');
    }
    if (key === 'unit' && value === '清空') next = null;
    const body = candidateBody(proposal); body.objectTypes.find(item => item.id === objects[0].id).fieldDefinitions.find(item => item.name === target.name)[key] = next;
    return { body, operationKey: JSON.stringify(['field', objects[0].id, target.name, key]), summary: `${objects[0].id}.${target.name} · ${field} → ${value}${key === 'unit' ? '；单位标注不转换业务数据' : ''}` };
  }
  const relation = field.startsWith('关系');
  const list = relation ? proposal.relationshipTypes : proposal.objectTypes;
  const candidates = list.filter(item => relation ? item.label === name || item.predicate === name || [item.from, item.predicate, item.to].join('/') === name : item.id === name || item.label === name);
  if (candidates.length !== 1) return { error: '对象或关系不存在或同名，请使用稳定对象编码或唯一关系名称，不会猜测目标。', code: 'SEMANTIC_EDIT_TARGET_AMBIGUOUS' };
  if (relation && candidates[0].derivedFrom) return failure('SEMANTIC_EDIT_DERIVED_RELATION_REQUIRES_REVIEW', '确认标识对应生成的关系请在专门的标识校对流程修改或撤销，不能通过普通关系指令改写。');
  const key = { '业务名称': 'label', '业务域': 'businessDomain', '业务说明': 'description', '关系名称': 'label', '关系基数': 'cardinality', '关系依据': 'evidence' }[field];
  const limit = key === 'description' ? 300 : key === 'evidence' ? 260 : relation ? 60 : 48;
  const cardinality = { '一对一': '1:1', '一对多': '1:n', '多对一': 'n:1', '多对多': 'n:n' }[value] || value;
  if (value.length > limit || /[\u0000-\u001f\u007f]/.test(value) || key === 'cardinality' && !['1:1', '1:n', 'n:1', 'n:n'].includes(cardinality)) return { error: '修改值超长或关系基数无效，未修订。', code: 'SEMANTIC_EDIT_VALUE_INVALID' };
  const body = structuredClone({ objectTypes: proposal.objectTypes, relationshipTypes: proposal.relationshipTypes });
  const index = list.indexOf(candidates[0]); body[relation ? 'relationshipTypes' : 'objectTypes'][index][key] = key === 'cardinality' ? cardinality : value;
  return { body, operationKey: JSON.stringify([relation ? 'relationship' : 'object', relation ? [candidates[0].from, candidates[0].predicate, candidates[0].to] : candidates[0].id, key]), summary: `${name} · ${field} → ${value}` };
}

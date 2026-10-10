import test from 'node:test';
import assert from 'node:assert/strict';
import { isSemanticModelEditCommand, parseSemanticModelEdit } from '../src/services/semantic-model-edit-command.js';
import { inspectCandidateFieldRemoval } from '../src/services/semantic-field-removal.js';
import { inspectCandidateObjectRemoval } from '../src/services/semantic-object-removal.js';
import { collectSemanticObjectDependencies, isSemanticDependencyCommand, parseSemanticDependencyCommand } from '../src/services/semantic-object-dependencies.js';

const fixture = () => ({ objectTypes: [{ id: 'Stock', label: '库存', key: 'id', fields: ['id', 'qty', 'status'], sourceSystems: ['WMS'], fieldDefinitions: [
  { name: 'id', type: 'string', required: true, primaryKey: true, sourceField: 'stock_id', mappingStatus: 'mapped' },
  { name: 'qty', type: 'number', required: false, sourceField: 'quantity', mappingStatus: 'mapped', unit: 'kg' },
  { name: 'status', type: 'string', sourceField: 'status', mappingStatus: 'mapped' }
] }], relationshipTypes: [{ from: 'Stock', predicate: 'storedAt', to: 'Stock', label: '在库', cardinality: '1:n' }] });

test('batch edits stage ordered changes, preserve quoted semicolons and never mutate the input', () => {
  const proposal = fixture(); const before = structuredClone(proposal);
  const result = parseSemanticModelEdit('将“Stock”的业务说明改为“可用库存；不含冻结”;给“Stock”新增字段“risk”，类型“number”；将“Stock.risk”的字段说明改为“待确认风险”', proposal);
  assert.ok(!result.error, result.error); assert.deepEqual(proposal, before);
  assert.equal(result.body.objectTypes[0].description, '可用库存；不含冻结');
  assert.equal(result.body.objectTypes[0].fieldDefinitions.at(-1).description, '待确认风险');
  assert.equal(result.body.objectTypes[0].fieldDefinitions.at(-1).mappingStatus, 'pending');
});

const relationCommand = (predicate = 'reserves', from = 'Stock', to = 'Stock') => `新增关系“${predicate}”，从“${from}”到“${to}”，名称“预留库存”，基数“一对多”，依据“测试制度定义；尚未验证实例”`;
const objectCommand = '新增对象“Customer”，名称“客户”，主键“customer_id”，类型“文本”，业务域“销售”，字段“name”，字段类型“文本”';

test('dependency reports return bounded structural locations, not configuration content or deletion permission', () => {
  const model = fixture(); model.relationshipTypes.push({ from: 'Stock', to: 'Customer', predicate: 'owns' });
  model.metrics = [{ expression: 'count(Customer)', secret: 'private-rule-text' }, { expression: 'count(CustomerExtra)' }];
  const before = structuredClone(model);
  const report = collectSemanticObjectDependencies([{ scope: 'candidate', model }], { id: 'Customer', label: '客户' });
  assert.equal(report.complete, true); assert.equal(report.total, 2);
  assert.deepEqual(report.dependencies.map(item => item.path), [['relationshipTypes', 1, 'to'], ['metrics', 0, 'expression']]);
  assert.ok(!JSON.stringify(report).includes('private-rule-text')); assert.ok(!JSON.stringify(report).includes('count(Customer)')); assert.deepEqual(model, before);
  assert.equal(report.allowed, undefined);
  const escaped = collectSemanticObjectDependencies([{ scope: 'draft', model: { policies: ['客户[VIP]需审核'] } }], { id: 'Customer', label: '客户[VIP]' });
  assert.equal(escaped.total, 1);
});

test('dependency scans disclose truncated previews and never return a partial success on budget failure', () => {
  const model = { metrics: Array.from({ length: 120 }, () => ({ expression: 'Customer' })) };
  const report = collectSemanticObjectDependencies([{ scope: 'draft', model }], { id: 'Customer' });
  assert.equal(report.total, 120); assert.equal(report.dependencies.length, 100); assert.equal(report.truncated, true);
  model.worldModel = {}; let node = model.worldModel; for (let i = 0; i < 26; i++) { node.next = {}; node = node.next; }
  const blocked = collectSemanticObjectDependencies([{ scope: 'draft', model }], { id: 'Customer' });
  assert.equal(blocked.complete, false); assert.deepEqual(blocked.dependencies, []); assert.equal(blocked.code, 'SEMANTIC_DEPENDENCY_BUDGET');
  const fanout = { metrics: Array.from({ length: 20001 }, () => 'none') };
  assert.equal(collectSemanticObjectDependencies([{ scope: 'draft', model: fanout }], { id: 'Customer' }).code, 'SEMANTIC_DEPENDENCY_BUDGET');
  assert.equal(isSemanticDependencyCommand('检查对象删除影响'), true);
  assert.deepEqual(parseSemanticDependencyCommand('检查对象变更影响“Customer”'), { objectId: 'Customer' });
  for (const text of ['检查对象删除影响', '检查对象删除影响“Customer"', '检查对象删除影响“Customer”；发布模型', '检查对象删除影响“Customer”删除它']) assert.ok(parseSemanticDependencyCommand(text).error);
});

test('object withdrawal is single, non-cascading and leaves the baseline and input unchanged', () => {
  const baseline = fixture(); const added = parseSemanticModelEdit(objectCommand, baseline).body; const before = structuredClone(added);
  const removed = parseSemanticModelEdit('撤回候选对象“Customer”', added, baseline);
  assert.ok(!removed.error, removed.error); assert.deepEqual(removed.body, baseline); assert.deepEqual(added, before);
  assert.deepEqual(removed.objectWithdrawal, { objectId: 'Customer' });
  assert.equal(isSemanticModelEditCommand('撤回候选对象'), true);
  for (const text of ['撤回候选对象', '撤回候选对象“客户”', '撤回候选对象“Customer”，发布模型']) assert.ok(parseSemanticModelEdit(text, added, baseline).error);
  assert.equal(parseSemanticModelEdit(`撤回候选对象“Customer”；${objectCommand}`, added, baseline).code, 'SEMANTIC_EDIT_BATCH_WITHDRAWAL_FORBIDDEN');
  assert.equal(inspectCandidateObjectRemoval(added, baseline, 'Stock').code, 'SEMANTIC_OBJECT_REMOVAL_EXISTING_FORBIDDEN');
  assert.equal(inspectCandidateObjectRemoval(added, baseline, 'Customer', before).code, 'SEMANTIC_OBJECT_REMOVAL_EXISTING_FORBIDDEN');
  assert.equal(inspectCandidateObjectRemoval(added, null, 'Customer').code, 'SEMANTIC_OBJECT_REMOVAL_TARGET_INVALID');
  assert.equal(inspectCandidateObjectRemoval({ ...added, objectTypes: [added.objectTypes[1]] }, baseline, 'Customer').code, 'SEMANTIC_OBJECT_REMOVAL_TARGET_INVALID');
});

test('object withdrawal rejects mapping, references, configurations and excessive dependency depth', () => {
  const baseline = fixture(); const fresh = () => parseSemanticModelEdit(objectCommand, baseline).body;
  for (const mutate of [
    model => { model.relationshipTypes.push({ from: 'Stock', to: 'Customer', predicate: 'owns' }); },
    model => { model.objectTypes[0].fieldDefinitions[1].reference = 'Customer'; },
    model => { model.metrics = [{ expression: 'count(Customer)' }]; },
    model => { model.scenario = { readPlans: [{ objectType: 'Customer' }] }; },
    model => { model.accessPolicies = [{ description: '客户访问规则' }]; },
    model => { model.policies = ['客户修改必须审核']; },
    model => { model.sourceAssignments = [{ objectId: 'Customer', system: 'ERP' }]; }
  ]) { const model = fresh(); mutate(model); assert.equal(inspectCandidateObjectRemoval(model, baseline, 'Customer').code, 'SEMANTIC_OBJECT_REMOVAL_DEPENDENCIES'); }
  for (const mutate of [model => { model.objectTypes[1].sourceSystems = ['ERP']; }, model => { model.objectTypes[1].fieldDefinitions[0].sourceField = 'id'; }, model => { model.objectTypes[1].fieldDefinitions[1].mappingStatus = 'mapped'; }]) {
    const model = fresh(); mutate(model); assert.equal(inspectCandidateObjectRemoval(model, baseline, 'Customer').code, 'SEMANTIC_OBJECT_REMOVAL_MAPPED_FORBIDDEN');
  }
  const deep = fresh(); deep.worldModel = {}; let node = deep.worldModel; for (let i = 0; i < 26; i++) { node.next = {}; node = node.next; }
  assert.equal(inspectCandidateObjectRemoval(deep, baseline, 'Customer').code, 'SEMANTIC_OBJECT_REMOVAL_BUDGET');
  const neighbor = fresh(); neighbor.metrics = [{ expression: 'count(CustomerExtra)' }]; assert.equal(inspectCandidateObjectRemoval(neighbor, baseline, 'Customer').allowed, true);
});

test('explicit object addition preserves input and leaves source and key mapping pending without grants', () => {
  const proposal = fixture(); const before = structuredClone(proposal);
  const result = parseSemanticModelEdit(objectCommand, proposal);
  assert.ok(!result.error, result.error); assert.deepEqual(proposal, before);
  const object = result.body.objectTypes.at(-1);
  assert.equal(object.id, 'Customer'); assert.deepEqual(object.sourceSystems, ['UNASSIGNED']);
  assert.equal(object.coreObject, object.id);
  assert.equal(object.key, 'customer_id'); assert.equal(object.fieldDefinitions[0].mappingStatus, 'pending');
  assert.equal(object.fieldDefinitions[0].sourceField, ''); assert.equal(object.fieldDefinitions[0].required, true);
  assert.deepEqual(result.body.relationshipTypes, proposal.relationshipTypes); assert.equal(isSemanticModelEditCommand('新增对象'), true);
});

test('new objects support bounded batch field and relation additions, but invalid commands roll back the whole candidate', () => {
  const proposal = fixture(); const before = structuredClone(proposal);
  const result = parseSemanticModelEdit(`${objectCommand}；给“Customer”新增字段“phone”，类型“文本”；${relationCommand('belongsTo', 'Stock', 'Customer')}`, proposal);
  assert.ok(!result.error, result.error); assert.equal(result.body.objectTypes.at(-1).fields.length, 3); assert.equal(result.body.relationshipTypes.at(-1).to, 'Customer');
  const failed = parseSemanticModelEdit(`${objectCommand}；${objectCommand}`, proposal); assert.ok(failed.error); assert.equal(failed.body, undefined); assert.deepEqual(proposal, before);
});

test('object declarations reject conflicting names, unsafe identifiers, unsupported key types, extra authority and budgets', () => {
  for (const text of [objectCommand.replace('Customer', 'Stock'), objectCommand.replace('客户', '库存'), objectCommand.replace('Customer', 'constructor'),
    objectCommand.replace('customer_id', 'x.y'), objectCommand.replace('文本', '数值'), objectCommand.replace('Customer”', 'Customer"'), `${objectCommand}，发布模型`, `${objectCommand}，来源“ERP”`,
    objectCommand.replace('Customer', 'A'.repeat(33)), objectCommand.replace('字段“name”', '字段“customer_id”'), objectCommand.replace('字段类型“文本”', '字段类型“执行脚本”'), objectCommand.split('，字段“')[0]]) {
    assert.ok(parseSemanticModelEdit(text, fixture()).error, text);
  }
  const full = fixture(); full.objectTypes = Array.from({ length: 40 }, (_, i) => ({ ...full.objectTypes[0], id: `Object${i}`, label: `对象${i}` }));
  assert.equal(parseSemanticModelEdit(objectCommand, full).code, 'SEMANTIC_EDIT_OBJECT_BUDGET');
});

test('explicit relationship additions declare structure only, support batch followup and preserve input', () => {
  const proposal = fixture(); const before = structuredClone(proposal);
  assert.equal(isSemanticModelEditCommand('新增关系'), true);
  const result = parseSemanticModelEdit(`${relationCommand()}；将“Stock/reserves/Stock”的关系名称改为“库存预留”`, proposal);
  assert.ok(!result.error, result.error); assert.deepEqual(proposal, before);
  assert.deepEqual(result.body.relationshipTypes.at(-1), { from: 'Stock', predicate: 'reserves', to: 'Stock', label: '库存预留', cardinality: '1:n', evidence: '测试制度定义；尚未验证实例', provenanceType: 'declared' });
  assert.equal(result.body.relationshipTypes.at(-1).keyMapping, undefined);
  assert.equal(result.body.relationshipTypes.at(-1).derivedFrom, undefined);
  const ascii = relationCommand().replaceAll('“', '"').replaceAll('”', '"');
  assert.ok(!parseSemanticModelEdit(ascii, proposal).error);
});

test('relationship additions reject unknown or ambiguous endpoints, duplicates, scripts and budget overflow atomically', () => {
  const proposal = fixture(); const before = structuredClone(proposal);
  for (const command of [relationCommand('storedAt'), relationCommand('constructor'), relationCommand('x/y'), relationCommand('reserves', 'Missing'), relationCommand().replace('一对多', '任意'), relationCommand().replace('测试制度定义；尚未验证实例', ' '), `${relationCommand()}，立即发布`, '新增关系“reserves”']) {
    const result = parseSemanticModelEdit(command, proposal); assert.ok(result.error, command); assert.equal(result.body, undefined);
  }
  const duplicate = parseSemanticModelEdit(`${relationCommand()}；${relationCommand()}`, proposal);
  assert.equal(duplicate.code, 'SEMANTIC_EDIT_RELATION_CONFLICT'); assert.equal(duplicate.body, undefined);
  const ambiguous = fixture(); ambiguous.objectTypes.push({ ...structuredClone(ambiguous.objectTypes[0]), id: 'Other' });
  assert.equal(parseSemanticModelEdit(relationCommand('reserves', '库存'), ambiguous).code, 'SEMANTIC_EDIT_TARGET_AMBIGUOUS');
  const large = fixture(); large.relationshipTypes = Array.from({ length: 40 }, (_, i) => ({ from: 'Stock', predicate: `p${i}`, to: 'Stock' }));
  assert.equal(parseSemanticModelEdit(relationCommand(), large).code, 'SEMANTIC_EDIT_RELATION_BUDGET');
  assert.deepEqual(proposal, before);
});

test('invalid batches return no partial body and reject conflicts, withdrawal, injection and budget excess', () => {
  const proposal = fixture(); const before = structuredClone(proposal);
  const first = '将“Stock”的业务域改为“仓储”';
  for (const second of ['将“不存在”的业务域改为“仓储”', '发布模型', '撤回候选字段“Stock.qty”', '将“库存”的业务域改为“销售”', '将“Stock”的业务名称改为“名称"', '']) {
    const result = parseSemanticModelEdit(`${first}；${second}`, proposal);
    assert.ok(result.error, second); assert.equal(result.body, undefined); assert.deepEqual(proposal, before);
  }
  assert.equal(parseSemanticModelEdit(Array(9).fill(first).join('；'), proposal).code, 'SEMANTIC_EDIT_BATCH_BUDGET');
  assert.equal(parseSemanticModelEdit('x'.repeat(4001), proposal).code, 'SEMANTIC_EDIT_BATCH_BUDGET');
  assert.equal(parseSemanticModelEdit(`${first}；发布模型`, proposal).commandIndex, 2);
});

test('field edits alter only explicit candidate metadata and never change source, key or input', () => {
  for (const [property, value, key, expected] of [['字段说明', '库存可用数量', 'description', '库存可用数量'], ['字段单位', '件', 'unit', '件'], ['字段单位', '清空', 'unit', null], ['字段类型', '整数', 'type', 'integer'], ['字段必填', '是', 'required', true]]) {
    const proposal = fixture(); const before = structuredClone(proposal);
    const result = parseSemanticModelEdit(`将“Stock.qty”的${property}改为“${value}”`, proposal);
    assert.ok(!result.error, result.error); assert.deepEqual(proposal, before);
    assert.equal(result.body.objectTypes[0].fieldDefinitions[1][key], expected);
    assert.equal(result.body.objectTypes[0].fieldDefinitions[1].sourceField, 'quantity');
    assert.equal(result.body.objectTypes[0].key, 'id'); assert.deepEqual(result.body.relationshipTypes, proposal.relationshipTypes);
  }
});

test('field enums stay explicit strings, bounded and clearable; numeric enums are not coerced', () => {
  const proposal = fixture();
  assert.deepEqual(parseSemanticModelEdit('将“Stock.status”的字段枚举改为“正常，冻结”', proposal).body.objectTypes[0].fieldDefinitions[2].enum, ['正常', '冻结']);
  assert.deepEqual(parseSemanticModelEdit('将“Stock.status”的字段枚举改为“清空”', proposal).body.objectTypes[0].fieldDefinitions[2].enum, []);
  for (const [target, values] of [['Stock.status', '冻结,冻结'], ['Stock.status', '正常,,冻结'], ['Stock.qty', '1,2']]) assert.ok(parseSemanticModelEdit(`将“${target}”的字段枚举改为“${values}”`, proposal).error);
});

test('new field is pending, non-key, unmapped and never invents a connector source', () => {
  const proposal = fixture(); const result = parseSemanticModelEdit('给“Stock”新增字段“risk_score”，类型“number”，说明“待确认风险分”。', proposal);
  assert.ok(!result.error, result.error); const field = result.body.objectTypes[0].fieldDefinitions.at(-1);
  assert.deepEqual(field, { name: 'risk_score', type: 'number', required: false, primaryKey: false, sourceField: '', mappingStatus: 'pending', reference: null, description: '待确认风险分' });
  assert.equal(proposal.objectTypes[0].fields.length, 3); assert.equal(result.body.objectTypes[0].key, 'id');
  assert.deepEqual(result.body.objectTypes[0].sourceSystems, ['WMS']);
});

test('ambiguous targets, key mutation, scripts, duplicates, budgets and mixed quotes fail without mutation', () => {
  const proposal = fixture(); const before = structuredClone(proposal);
  for (const text of ['将“qty”的字段单位改为“kg”', '将“Missing.qty”的字段单位改为“kg”', '将“Stock.id”的字段必填改为“否”', '将“Stock.id”的字段类型改为“number”', '将“Stock.qty”的字段类型改为“eval(script)”', '将“Stock.qty”的字段必填改为“随便”', '将“Stock.qty"的字段单位改为“kg”', '给“Stock”新增字段“qty”，类型“number”', '给“Stock”新增字段“constructor”，类型“string”', '给“Stock”新增字段“x.y”，类型“number”', '给“Stock”新增字段“risk”，类型“number”，发布模型']) assert.ok(parseSemanticModelEdit(text, proposal).error, text);
  assert.deepEqual(proposal, before);
  proposal.objectTypes.push(structuredClone(proposal.objectTypes[0])); assert.ok(parseSemanticModelEdit('将“库存.qty”的字段单位改为“kg”', proposal).error);
  const large = fixture(); large.objectTypes[0].fieldDefinitions = Array.from({ length: 80 }, (_, i) => ({ name: `f${i}` }));
  assert.equal(parseSemanticModelEdit('给“Stock”新增字段“risk”，类型“number”', large).code, 'SEMANTIC_EDIT_FIELD_CONFLICT');
});

test('recognition gates malformed explicit edits before the general model planner', () => {
  assert.equal(isSemanticModelEditCommand('将“Stock.qty”的字段单位改为“kg”'), true);
  assert.equal(isSemanticModelEditCommand('给“Stock”新增字段“risk”，类型“number”'), true);
  assert.equal(isSemanticModelEditCommand('给“Stock”新增字段'), true);
  assert.equal(isSemanticModelEditCommand('分析库存'), false);
  assert.equal(parseSemanticModelEdit('将“Stock/storedAt/Stock”的关系基数改为“一对一”', fixture()).body.relationshipTypes[0].cardinality, '1:1');
  const derived = fixture(); derived.relationshipTypes[0].derivedFrom = 'confirmed-identity-link';
  assert.equal(parseSemanticModelEdit('将“在库”的关系名称改为“位置关系”', derived).code, 'SEMANTIC_EDIT_DERIVED_RELATION_REQUIRES_REVIEW');
});

test('withdrawal only removes a newly added pending field without touching the baseline or other fields', () => {
  const baseline = fixture(); const added = parseSemanticModelEdit('给“Stock”新增字段“risk_score”，类型“number”', baseline).body;
  const before = structuredClone(added);
  const result = parseSemanticModelEdit('撤回候选字段“Stock.risk_score”', added, baseline);
  assert.ok(!result.error, result.error); assert.deepEqual(result.body, baseline); assert.deepEqual(added, before);
  assert.deepEqual(result.withdrawal, { objectId: 'Stock', fieldName: 'risk_score' });
  assert.equal(isSemanticModelEditCommand('撤回候选字段“Stock.risk_score”'), true);
  assert.ok(parseSemanticModelEdit('删除候选字段“Stock.risk_score”，发布模型', added, baseline).error);
  assert.ok(parseSemanticModelEdit('撤回候选字段“Stock.risk_score”', added).error);
  assert.equal(parseSemanticModelEdit('撤回候选字段“Stock.id”', added, baseline).code, 'SEMANTIC_FIELD_REMOVAL_KEY_FORBIDDEN');
  assert.equal(parseSemanticModelEdit('撤回候选字段“Stock.qty”', added, baseline).code, 'SEMANTIC_FIELD_REMOVAL_EXISTING_FORBIDDEN');
});

test('withdrawal blocks incoming references, mapped sources, read plans, governance mentions and excess budget', () => {
  const baseline = fixture(); const fresh = () => parseSemanticModelEdit('给“Stock”新增字段“risk_score”，类型“number”', baseline).body;
  for (const change of [
    model => { model.objectTypes[0].fieldDefinitions[1].reference = 'Stock'; model.objectTypes[0].fieldDefinitions[1].referenceField = 'risk_score'; },
    model => { model.objectTypes[0].fieldDefinitions.at(-1).sourceField = 'risk_source'; },
    model => { model.scenario = { readPlans: [{ outputs: [{ expr: { field: 'risk_score' } }] }] }; },
    model => { model.metrics = [{ expression: 'sum(risk_score)' }]; },
    model => { model.relationshipTypes[0].keyMapping = { fromField: 'risk_score' }; }
  ]) { const candidate = fresh(); change(candidate); assert.ok(inspectCandidateFieldRemoval(candidate, baseline, 'Stock', 'risk_score').error); }
  const deep = fresh(); deep.worldModel = {}; let node = deep.worldModel;
  for (let i = 0; i < 26; i++) { node.next = {}; node = node.next; }
  assert.equal(inspectCandidateFieldRemoval(deep, baseline, 'Stock', 'risk_score').code, 'SEMANTIC_FIELD_REMOVAL_BUDGET');
  const neighboring = fresh(); neighboring.metrics = [{ expression: 'sum(risk_score_extra)' }];
  assert.equal(inspectCandidateFieldRemoval(neighboring, baseline, 'Stock', 'risk_score').allowed, true);
});

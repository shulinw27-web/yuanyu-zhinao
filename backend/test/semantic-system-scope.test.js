import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { getRole } from '../src/services/authorization-service.js';
import { createSemanticOperationsTask } from '../src/services/semantic-operations-task-service.js';
import { createSemanticOperationsProposal } from '../src/services/semantic-operations-agent-service.js';
import { discoverSemanticSources } from '../src/services/semantic-source-discovery-service.js';

// 阶段 3 验收：建模/来源预检的范围**只能**来自显式选择。
//
// 被删除的历史行为：`requestedSystems.length ? requestedSystems : 全部 accessible`。
// 它有两种坏情况——
//   1) 文本里碰巧出现系统名（甚至出现在「不要用 ERP」这种否定句里）就被当成范围；
//   2) 什么都没提到时把范围放大到整个角色可见面。
// 两者都让一次建模的实际覆盖范围超出运营人员的可见选择。
//
// 本文件覆盖方案要求的六类用例：单系统 / 多系统 / 空选择 / 部分越权 / 文本提到但未选 /
// 选了但系统未登记。全部为内置合成数据下的确定性断言，不涉及真实企业系统。

const identity = { tenantId: 'system-scope-test', subjectId: 'scope-reviewer', deviceId: 'scope-device' };
const buildText = '建立供应商、采购订单和原料批次的语义模型。';
const draftState = ['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime'];

const createTask = (body, role = getRole('executive')) => createSemanticOperationsTask({ body, role, identityScope: identity });

test('范围用例 1：单系统选择只覆盖该系统，且范围来源标注为显式', async () => {
  resetRuntimeState(draftState);
  const task = await createTask({ text: buildText, systemCodes: ['erp'] });
  assert.equal(task.intent, 'build_model');
  assert.equal(task.systemScope.selectionSource, 'explicit');
  // 大小写归一，便于与注册表/连接器目录比对。
  assert.deepEqual(task.systemScope.selected, ['ERP']);
  assert.deepEqual(task.sourceDiscovery.selectedSystemCodes, ['ERP']);
  assert.deepEqual(task.sourceDiscovery.sources.map((item) => item.code), ['ERP']);
  assert.equal(task.sourceDiscovery.scopeNotice, null);
  assert.deepEqual(task.planning.systems, ['ERP']);
  assert.deepEqual(task.systemScope.covered, ['ERP']);
});

test('范围用例 2：多系统选择按顺序保留，且每个对象都能追到范围内的系统', async () => {
  resetRuntimeState(draftState);
  const task = await createTask({ text: buildText, systemCodes: ['ERP', 'WMS'] });
  assert.deepEqual(task.systemScope.selected, ['ERP', 'WMS']);
  assert.deepEqual(task.sourceDiscovery.selectedSystemCodes, ['ERP', 'WMS']);
  const objects = task.proposal.objectTypes;
  assert.ok(objects.length > 0);
  // 覆盖标注断言（方案原文）：每个对象都能追到系统；未覆盖系统显式列出而非静默丢弃。
  for (const object of objects) {
    assert.ok(Array.isArray(object.sourceSystems) && object.sourceSystems.length, `${object.id} 缺少来源系统标注`);
    assert.ok(object.sourceSystems.every((code) => code && code !== 'UNASSIGNED'), `${object.id} 的来源系统未标注`);
  }
  const union = [...new Set(objects.flatMap((object) => object.sourceSystems))].sort();
  const inScope = union.filter((code) => ['ERP', 'WMS'].includes(code));
  assert.deepEqual(task.systemScope.covered, inScope);
  assert.deepEqual(
    task.systemScope.uncovered.map((item) => item.code).sort(),
    ['ERP', 'WMS'].filter((code) => !inScope.includes(code)).sort()
  );
  // ADR-013：范围是过滤器。过滤后提案里**不允许**存在「全部来源都在范围外」的对象；
  // 允许「部分来源在范围外」但必须被上报，所以需要同时看这两个字段才能断定过滤是完整的。
  const reportedOutside = new Set([
    ...task.systemScope.excludedObjects.map((item) => item.objectId),
    ...task.systemScope.partialScopeObjects.map((item) => item.objectId)
  ]);
  for (const object of objects) {
    const outside = object.sourceSystems.filter((code) => code !== 'UNASSIGNED' && !['ERP', 'WMS'].includes(code));
    assert.ok(outside.length < object.sourceSystems.filter((code) => code !== 'UNASSIGNED').length, `${object.id} 的全部来源都在范围外，本不该进入提案`);
    if (outside.length) assert.ok(reportedOutside.has(object.id), `${object.id} 有范围外来源却未被上报`);
  }
  assert.deepEqual(task.systemScope.unassignedObjects, []);
  assert.deepEqual(task.systemScope.excludedObjects, []);
  assert.deepEqual(task.systemScope.excludedRelationships, []);
  assert.deepEqual(task.systemScope.partialScopeObjects, []);
});

test('范围用例 3：空选择与未提供选择一律 400，绝不自动扩大到全部可访问连接器', async () => {
  resetRuntimeState(draftState);
  for (const body of [{ text: buildText }, { text: buildText, systemCodes: [] }]) {
    const task = await createTask(body);
    assert.equal(task.status, 400, JSON.stringify(body));
    assert.equal(task.code, 'SEMANTIC_SYSTEM_SCOPE_REQUIRED', JSON.stringify(body));
    assert.match(task.error, /不会自动扩大到全部可访问连接器/);
  }
  // 显式空范围在发现层也要如实标注为空，而不是回落到全量。
  const discovery = discoverSemanticSources({ request: buildText, role: getRole('executive'), systemCodes: [] });
  assert.equal(discovery.selectionSource, 'explicit_empty');
  assert.deepEqual(discovery.sources, []);
  assert.deepEqual(discovery.selectedSystemCodes, []);
  assert.match(discovery.scopeNotice, /范围为空/);
  // 不给 systemCodes 时，文本识别只作提示素材，selectionSource 必须如实标注为推断。
  const inferred = discoverSemanticSources({ request: '分析 ERP 和 WMS 的库存', role: getRole('executive') });
  assert.equal(inferred.selectionSource, 'text_inference');
  assert.match(inferred.scopeNotice, /推断而非显式选择/);
  const empty = discoverSemanticSources({ request: '', role: getRole('executive') });
  assert.equal(empty.selectionSource, 'unspecified');
  assert.deepEqual(empty.sources, []);
  assert.match(empty.scopeNotice, /范围为空/);
});

test('范围用例 4：部分越权整单拒绝，不静默裁到可见子集也不提权', async () => {
  resetRuntimeState(draftState);
  const role = getRole('marketing_manager');
  // 该角色的数据域只覆盖 OMS；同时选择 OMS 与 ERP 时整单拒绝。
  const task = await createSemanticOperationsTask({ body: { text: buildText, systemCodes: ['OMS', 'ERP'] }, role, identityScope: identity });
  assert.equal(task.status, 403);
  assert.equal(task.code, 'SEMANTIC_SYSTEM_SCOPE_FORBIDDEN');
  assert.match(task.error, /ERP/);
  assert.match(task.error, /不会被静默裁剪/);
  // 只保留授权范围内的系统即可通过：拒绝不等于把这些系统拉黑。
  // 注意诉求要选该角色范围内**确实有对象来源**的系统：范围过滤（ADR-013）之后，
  // 选了一个授权但毫无内容来源的系统会得到「对象全被排除」，那不是越权问题。
  const allowed = await createSemanticOperationsTask({ body: { text: '建立门店的语义模型。', systemCodes: ['OMS'] }, role, identityScope: identity });
  assert.equal(allowed.intent, 'build_model', JSON.stringify(allowed));
  assert.deepEqual(allowed.systemScope.selected, ['OMS']);
  assert.deepEqual(allowed.systemScope.covered, ['OMS']);
});

test('范围用例 5：文本提到但未选择的系统只提示、不进入范围', async () => {
  resetRuntimeState(draftState);
  // 文本里出现 ERP/WMS，但只选择 WMS：ERP 必须作为「提示」出现，不能进入范围。
  // 诉求同时命中 PurchaseOrder（ERP）与 Inventory（WMS），因此本用例还顺带验证
  // ADR-013 的过滤：ERP 的对象被排除，但必须出现在 excludedObjects 里。
  const text = '建立 ERP 和 WMS 的库存与采购订单语义模型。';
  const task = await createTask({ text, systemCodes: ['WMS'] });
  assert.deepEqual(task.systemScope.selected, ['WMS']);
  assert.deepEqual(task.sourceDiscovery.selectedSystemCodes, ['WMS']);
  assert.deepEqual(task.systemScope.mentionedNotSelected, ['ERP']);
  assert.match(task.response, /文本提到但未选择的系统：ERP/);
  assert.deepEqual(task.systemScope.excludedObjects.map((item) => item.objectId), ['PurchaseOrder']);
  assert.match(task.response, /按范围排除的对象/);
  assert.ok(task.events.some((event) => event.type === 'system_scope_coverage_reported'));
  // 反向：完全不给范围时，文本里提到 ERP/WMS 也不足以建任务。
  const blocked = await createTask({ text });
  assert.equal(blocked.code, 'SEMANTIC_SYSTEM_SCOPE_REQUIRED');
});

test('范围过滤：来源全部超范围的对象被排除，但必须显式列出（ADR-013）', async () => {
  resetRuntimeState(draftState);
  // 实测数据（内置合成材料）：诉求涉及供应商/采购订单/原料批次时得到 3 个对象，
  // 其中 Supplier / PurchaseOrder 的 sourceSystems 只有 ERP，原料批次的来源是 WMS。
  // ADR-013 之后范围是**过滤器**：只选 WMS 时这两个对象不再进入提案——
  // 但「被过滤」不等于「被静默丢弃」：它们必须出现在 excludedObjects 与任务回应里。
  const task = await createTask({ text: buildText, systemCodes: ['WMS'] });
  assert.equal(task.proposal.objectTypes.length, 1);
  assert.deepEqual(task.systemScope.covered, ['WMS']);
  assert.deepEqual(task.systemScope.uncovered, []);
  assert.deepEqual(task.systemScope.partialScopeObjects, []);
  assert.deepEqual(
    task.systemScope.excludedObjects.map((item) => item.objectId).sort(),
    ['PurchaseOrder', 'Supplier']
  );
  for (const item of task.systemScope.excludedObjects) assert.deepEqual(item.sourceSystems, ['ERP']);
  // 与阶段 3（过滤前）的分水岭：被排除的对象**确实不在提案里**。
  assert.ok(!task.proposal.objectTypes.some((object) => object.id === 'Supplier'));
  assert.ok(!task.proposal.objectTypes.some((object) => object.id === 'PurchaseOrder'));
  // 但「被排除」必须可读地上报，运营才能据此补选系统。
  assert.match(task.response, /按范围排除的对象/);
  assert.match(task.response, /补选系统后重跑/);
  assert.ok(task.events.some((event) => event.type === 'system_scope_coverage_reported'));
  // 关系随端点被排除，不留悬空边；且被丢弃的关系必须可归因（不能悄悄消失）。
  assert.ok(task.systemScope.excludedRelationships.length > 0);
  for (const item of task.systemScope.excludedRelationships) {
    assert.match(item.reason, /来源系统不在本次所选范围内被排除/);
  }
  for (const relationship of task.proposal.relationshipTypes) {
    const ids = new Set(task.proposal.objectTypes.map((object) => object.id));
    assert.ok(ids.has(relationship.from) && ids.has(relationship.to), `悬空边：${relationship.from}->${relationship.to}`);
  }
  assert.ok(!task.systemScope.covered.includes('ERP'));
});

test('范围用例 6：未登记系统与未知编码分别显式拒绝', async () => {
  resetRuntimeState(draftState);
  // SRM 在系统注册表中但尚未登记受控连接器。
  const unregistered = await createTask({ text: buildText, systemCodes: ['SRM'] });
  assert.equal(unregistered.status, 400);
  assert.equal(unregistered.code, 'SEMANTIC_SYSTEM_NOT_REGISTERED');
  assert.match(unregistered.error, /SRM/);
  // 完全不在注册表里的编码是另一个问题，错误码也不相同。
  const unknown = await createTask({ text: buildText, systemCodes: ['NOPE'] });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.code, 'SEMANTIC_SYSTEM_UNKNOWN');
  assert.match(unknown.error, /NOPE/);
  // 同一批里既有可用又有未登记系统时，整单拒绝并列出问题系统。
  const mixed = await createTask({ text: buildText, systemCodes: ['ERP', 'SRM'] });
  assert.equal(mixed.code, 'SEMANTIC_SYSTEM_NOT_REGISTERED');
  assert.match(mixed.error, /SRM/);
  assert.ok(!/ERP/.test(mixed.error.split('：').at(-1)), '可用的 ERP 不应出现在问题清单里');
});

test('范围请求体形状非法一律 400，不猜用户意图', async () => {
  resetRuntimeState(draftState);
  for (const systemCodes of ['ERP', ['ERP', 42], ['ERP', '   '], [{}]]) {
    const task = await createTask({ text: buildText, systemCodes });
    assert.equal(task.status, 400, JSON.stringify(systemCodes));
    assert.equal(task.code, 'SEMANTIC_SYSTEM_SCOPE_INVALID', JSON.stringify(systemCodes));
  }
});

test('范围只约束来源绑定意图，对话类诉求不受影响', async () => {
  resetRuntimeState(draftState);
  const greeting = await createTask({ text: '你好' });
  assert.equal(greeting.intent, 'conversation');
  assert.equal(greeting.systemScope, null);
  const status = await createTask({ text: '检查当前语义模型状态和快照情况。' });
  assert.equal(status.intent, 'inspect_status');
  assert.equal(status.systemScope, null);
  // 但在承接口语的上文里，文本仍不能替代范围。
  const followUp = await createTask({ text: '建立供应商语义模型。', parentTaskId: greeting.id });
  assert.equal(followUp.code, 'SEMANTIC_SYSTEM_SCOPE_REQUIRED');
});

test('承接口语时给出上文范围作为提示，但仍要求本轮显式确认', async () => {
  resetRuntimeState(draftState);
  const first = await createTask({ text: buildText, systemCodes: ['ERP'] });
  const next = await createTask({ text: '继续建模，补充采购订单。', parentTaskId: first.id });
  assert.equal(next.code, 'SEMANTIC_SYSTEM_SCOPE_REQUIRED');
  assert.match(next.error, /上文任务的范围是 ERP/);
  assert.match(next.error, /显式带上/);
  const resumed = await createTask({ text: '继续建模，补充采购订单。', parentTaskId: first.id, systemCodes: ['ERP'] });
  assert.equal(resumed.intent, 'build_model');
  assert.deepEqual(resumed.systemScope.selected, ['ERP']);
});

test('对象全被范围排除时给出独立错误码，不与「什么都没识别到」混为一谈', async () => {
  resetRuntimeState(draftState);
  // 诉求只涉及 ERP/WMS 的内容，却只选 LIMS：识别到了对象、但全被范围排除。
  // 这与「材料里根本没有可追溯对象」是两个问题——用同一个错误码会让运营去改材料，方向就错了。
  const excludedAll = await createTask({ text: buildText, systemCodes: ['LIMS'] });
  assert.equal(excludedAll.status, 422);
  assert.equal(excludedAll.code, 'SEMANTIC_PROPOSAL_SCOPE_EXCLUDED_ALL');
  // 报错必须点名是哪些对象、来自哪个系统，否则运营无法知道该补选什么。
  assert.match(excludedAll.error, /供应商/);
  assert.match(excludedAll.error, /ERP/);
  assert.match(excludedAll.error, /补选对应系统后重试/);
});

// 跨系统对象的候选集夹具：目录对象都只有单一来源，跨系统对象要到阶段 4 的结构化材料路径才常见，
// 因此直接构造候选集来验证 ADR-013 的边界规则本身。
const multiSourceFixture = () => ([
  { id: 'InventoryPosition', label: '库存持仓', source: 'wms.stock_position', key: 'stock_id', fields: ['stock_id', 'supplier_id'], classification: '运营受限', coreObject: 'RawMaterial', semanticType: 'InventoryPosition', sourceSystems: ['WMS', 'ERP'], fieldDefinitions: [{ name: 'stock_id', type: 'string', primaryKey: true, required: true }, { name: 'supplier_id', type: 'string', primaryKey: false, required: false }] },
  { id: 'SupplierLedger', label: '供应台账', source: 'erp.supplier_ledger', key: 'ledger_id', fields: ['ledger_id', 'status'], classification: '供应链受限', coreObject: 'Supplier', semanticType: 'SupplierLedger', sourceSystems: ['ERP'], fieldDefinitions: [{ name: 'ledger_id', type: 'string', primaryKey: true, required: true }, { name: 'status', type: 'string', primaryKey: false, required: false }] },
  { id: 'FreeText', label: '未标注来源表', source: 'unknown.table', key: 'row_id', fields: ['row_id', 'note'], classification: '待复核', coreObject: 'FreeText', semanticType: 'FreeText', sourceSystems: ['UNASSIGNED'], fieldDefinitions: [{ name: 'row_id', type: 'string', primaryKey: true, required: true }, { name: 'note', type: 'string', primaryKey: false, required: false }] }
]);
const multiSourceRelationships = () => ([{ from: 'InventoryPosition', predicate: 'belongsTo', to: 'SupplierLedger', label: '库存持仓归属供应台账', cardinality: '1:n' }]);

test('部分来源超出范围的对象保留并上报，不因一个超范围来源被整条排除', async () => {
  resetRuntimeState(draftState);
  const proposal = createSemanticOperationsProposal({
    input: '建立跨系统库存持仓与供应台账模型。',
    attachments: [],
    schemaDiscovery: { objectTypes: multiSourceFixture(), relationshipTypes: multiSourceRelationships(), schemas: [], files: [], summary: '范围过滤边界夹具', warnings: [] },
    identityScope: identity,
    requirements: '',
    sampleRefs: [],
    roleId: getRole('executive').id,
    adoptionMode: 'merge',
    scopeSystems: ['WMS']
  });
  assert.ok(!proposal.error, JSON.stringify(proposal));
  assert.deepEqual(proposal.objectTypes.map((item) => item.id).sort(), ['FreeText', 'InventoryPosition']);
  // 部分超出：保留，但必须报出超出的那一部分来源。
  assert.deepEqual(proposal.scopeExclusions.partialScopeObjects, [
    { objectId: 'InventoryPosition', sourceSystems: ['WMS', 'ERP'], outside: ['ERP'] }
  ]);
  // 全部超出：排除且列出。
  assert.deepEqual(proposal.scopeExclusions.excludedObjects, [
    { objectId: 'SupplierLedger', label: '供应台账', sourceSystems: ['ERP'] }
  ]);
  // UNASSIGNED（来源未标注）一律保留：把「未标注」当「超范围」会清空整条自然语言抽取路径。
  assert.deepEqual(proposal.scopeExclusions.unassignedObjects, ['FreeText']);
  // 关系随端点被排除，且能归因到「被范围排除」而不是「没识别到」。
  assert.deepEqual(proposal.relationshipTypes, []);
  assert.equal(proposal.scopeExclusions.excludedRelationships.length, 1);
  assert.match(proposal.scopeExclusions.excludedRelationships[0].reason, /SupplierLedger/);
  assert.match(proposal.scopeExclusions.excludedRelationships[0].reason, /来源系统不在本次所选范围内被排除/);
  // 未提供范围时（非建模路径）不得过滤。
  const unfiltered = createSemanticOperationsProposal({
    input: '建立跨系统库存持仓与供应台账模型。',
    attachments: [],
    schemaDiscovery: { objectTypes: multiSourceFixture(), relationshipTypes: multiSourceRelationships(), schemas: [], files: [], summary: '未提供范围夹具', warnings: [] },
    identityScope: identity, requirements: '', sampleRefs: [], roleId: getRole('executive').id, adoptionMode: 'merge'
  });
  assert.ok(!unfiltered.error, JSON.stringify(unfiltered));
  assert.equal(unfiltered.objectTypes.length, 3);
  assert.deepEqual(unfiltered.scopeExclusions.excludedObjects, []);
  assert.equal(unfiltered.scopeExclusions.appliedTo, null);
});

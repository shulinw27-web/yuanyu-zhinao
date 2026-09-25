import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { getRole } from '../src/services/authorization-service.js';
import { createSemanticOperationsTask, getSemanticOperationsTask, reviseSemanticOperationsTaskProposal } from '../src/services/semantic-operations-task-service.js';
import { buildConfirmedRelationships, buildSystemFieldCatalog, deriveIdentityLinking, resolveIdentityConflictRulings } from '../src/services/semantic-identity-link-service.js';

// 阶段 4a 验收：按选中系统的字段目录识别对象与标识，并推导跨系统标识对应与冲突。
//
// 全部为内置合成数据下的**确定性**断言（本模块不调用模型，因此结果可复现）。
// 这里只覆盖确定性的一半；「从非结构化材料抽取对象与标识」需要模型能力，属阶段 4b。
//
// 三条刻意守卫的性质：
//   1) 对象自己的标识必须与该对象自身概念一致——否则外键会被当成主键，
//      整条引用推导都建立在一个错误的主键上；
//   2) 标识对应只是**假设**，发现时绝不自动并入草稿关系（未确认前 `relationshipTypes` 不因本能力而增长）；
//   3) 同名、同义、粒度不一致都必须显式上报，不能静默合并或任选其一。
//
// 阶段 4b 追加第四条：假设**可以**在人工逐条确认后并入，但并入的边必须仍然看得出「这是推断」
// （`provenanceType: 'inferred'` + `derivedFrom`），不能被记成与材料证据同等的东西。
//
// 阶段 4c 追加第五条：支撑这些对应的**等价假设**必须先被裁定（见 ADR-016）。
// 实测 11 条对应里有 9 条站在「同一概念下的多个字段名指向同一实体」这个没人回答过的前提上。
// 裁定只改「哪些对应成立」（输入），不写草稿关系——写入仍必须走第四条的逐条确认。
//
// 阶段 4d 追加第六条：确认这一关要**问清人两件不同的事**（见 ADR-019）。
// 实测 11 条对应里 2 条（`OMS.Order.sku`、`QMS.QualityEvent.product`）的键形状压根判不出来——
// 它们是裸名，命名规则既认不出代理键也认不出业务键。4c 之前这条被记成「两端形状已知且不同」，
// 于是要求人写「映射依据」，而说明文案写着「两端键形状不同（null / agent）」——读不通，
// 且是在要求人为一件机器尚未判明的事作保。现在三态分开：未知先判形状，不同才交映射定义。
//
// 阶段 4e 追加第七条：上面那个问题**能不能问**，本身要先判（见 ADR-020）。
// 实测 11 条对应里只有 7 条这次写得进草稿——另外 4 条的来源对象（`LIMS.Sample`、`OMS.Order`、
// `QMS.QualityEvent`、`WMS.InboundReceipt`）只存在于系统配置声明里，没被抽成本次候选对象。
// 而旧口径用一个 `notInProposal` 同时回答「依据来自哪儿」与「能不能确认」，于是多标了 1 条：
// `ERP.Inventory.lot_no` 实测可确认（对象名 `Inventory` 与候选对象同名），却被标成
// 「来源系统本次未进入候选对象」——界面上的一句事实错误。现在资格判据**唯一**（两端对象都在
// 本次候选对象内，与服务端草案校验读同一个数组），不可确认的仍然列出但自带可行动原因。

const identity = { tenantId: 'identity-link-test', subjectId: 'identity-reviewer', deviceId: 'identity-device' };
const allSystems = ['ERP', 'WMS', 'LIMS', 'QMS', 'MES', 'OMS'];
const catalogText = '建立供应商、采购订单、采购需求、原料批次、生产批次、成品批次、检验结果、库存、设备、门店、物料主数据、产品主数据的语义模型。';
const draftState = ['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime'];

const createTask = (body, role = getRole('executive')) => createSemanticOperationsTask({ body, role, identityScope: identity });
const makeObject = (id, systems, fields, key) => ({
  id, label: id, source: `${systems[0].toLowerCase()}.${id.toLowerCase()}`, key: key || fields[0], fields,
  sourceSystems: systems, classification: '内部受限', semanticType: id, coreObject: id
});

test('标识用例 1：字段目录按所选系统收敛，未登记系统不出现', () => {
  const catalog = buildSystemFieldCatalog({
    objects: [makeObject('Supplier', ['ERP'], ['supplier_id', 'name', 'qualification_status', 'status'])],
    systems: ['ERP']
  });
  assert.deepEqual(catalog.map((entry) => entry.code), ['ERP']);
  const supplier = catalog[0].objects.find((item) => item.objectId === 'Supplier');
  assert.equal(supplier.identifier, 'supplier_id');
  assert.equal(supplier.identifierKind, 'primary');
  // 非标识列（name / status）不得被当成标识字段，否则会凭空产生「同义不同名」。
  assert.deepEqual(supplier.fields.filter((field) => field.identity).map((field) => field.name), ['supplier_id']);
  // 范围为空＝没有系统在范围内，**不是**「不限系统」。
  assert.deepEqual(buildSystemFieldCatalog({ objects: [], systems: [] }), []);
});

test('标识用例 2：全量系统下的对象数 / 标识 / 链接 / 冲突计数可复现', async () => {
  resetRuntimeState(draftState);
  const task = await createTask({ text: catalogText, systemCodes: allSystems });
  assert.equal(task.intent, 'build_model');
  const linking = task.proposal.identityLinking;
  assert.ok(linking, '显式给出范围时必须产生标识对应分析');
  assert.deepEqual(linking.systems, allSystems);
  // 受控词汇表 12 类对象 + 各系统配置映射声明的对象，去重后 21 个。
  assert.equal(linking.summary.objects, 21);
  assert.equal(linking.summary.links, 11);
  assert.equal(linking.summary.linkable, 4);
  // 阶段 4d（ADR-019）：`requires_mapping` 收窄为「两端形状**都已知且不同**」——
  // 形状未判定（裸名 `sku` / `product`，命名规则判不出代理键 / 业务键）单列为 `shape_unknown`。
  // 实测 7 条里 2 条属后者：把它们当成「已知不同」，就是让人为一件机器尚未判明的事写映射依据，
  // 而说明文案会写成「两端键形状不同（null / agent）」——读不通。
  assert.equal(linking.summary.requiresMapping, 5);
  assert.equal(linking.summary.shapeUnknown, 2);
  assert.deepEqual(
    linking.links.filter((item) => item.status === 'shape_unknown')
      .map((item) => `${item.from.field}(${item.from.shape})→${item.to.field}`).sort(),
    ['product(null)→product_id', 'sku(null)→product_id']
  );
  // 三态互斥且覆盖全部链接：任何一条链接都必须落在其中一态里。
  assert.equal(linking.summary.linkable + linking.summary.requiresMapping + linking.summary.shapeUnknown, linking.summary.links);
  // 阶段 4e（ADR-020）：**资格**是与三态正交的独立口径（「这次能不能用」vs「要用它得先做什么」）。
  // 必须单独计数，否则运营看到的分母里混着本次根本用不了的对应。
  assert.equal(linking.summary.eligible, 7);
  assert.equal(linking.summary.ineligible, 4);
  assert.equal(linking.summary.eligible + linking.summary.ineligible, linking.summary.links);
  assert.equal(linking.summary.conflicts, 14);
  assert.equal(linking.summary.keyGaps, 1);
  assert.deepEqual([...new Set(linking.conflicts.map((item) => item.kind))].sort(), [
    'alias_divergence', 'declaration_divergence', 'key_shape_incompatible'
  ]);
  // 方案原文举的例子必须真的出现：ERP PurchaseOrder ↔ WMS InboundReceipt.purchase_order_id。
  const purchaseOrder = linking.links.find((item) => item.concept === 'PurchaseOrder');
  // 阶段 4c 第二段：链接两端带出**来源依据**。这两端都来自已确认的系统声明/提案对象，
  // 所以是 `confirmed`；材料推断出的一端会是 `material_owner_candidate`（用例 18~22）。
  assert.deepEqual(purchaseOrder.from, { system: 'WMS', objectId: 'InboundReceipt', field: 'purchase_order_id', shape: 'agent', source: 'wms.inbound_receipt', sourceBasis: 'confirmed' });
  assert.deepEqual(purchaseOrder.to, { system: 'ERP', objectId: 'PurchaseOrder', field: 'purchase_order_id', shape: 'agent', source: 'erp.purchase_order', sourceBasis: 'confirmed' });
  assert.equal(purchaseOrder.sourceInferred, false);
  assert.equal(purchaseOrder.cardinality, 'n:1');
  assert.equal(purchaseOrder.status, 'linkable');
  // 阶段 4e（ADR-020）：方案原文举的这条例子**当前不可确认**——`WMS.InboundReceipt` 只存在于
  // WMS 的配置映射声明里，本次材料没有把它抽成候选对象，因此边写不进草稿。
  // 它仍然列出来（这条跨系统引用真实存在），但必须自带可行动的原因。
  assert.equal(purchaseOrder.eligible, false);
  assert.deepEqual(purchaseOrder.ineligibleEndpoints,
    [{ role: 'from', system: 'WMS', objectId: 'InboundReceipt', groundings: ['source_system_declaration'] }]);
  assert.match(purchaseOrder.ineligibleReason, /来源对象 WMS.InboundReceipt 的依据是系统配置声明/);
  // 标识对应是假设，**不**并入草稿关系：关系仍只来自受控词汇表与材料外键证据。
  assert.equal(task.proposal.relationshipTypes.length, 8);
  assert.ok(!task.proposal.relationshipTypes.some((item) => item.predicate.includes('purchase_order_id')));
});

test('标识用例 3：任务层按可读口径上报标识对应，且明细只在提案上出现一次', async () => {
  resetRuntimeState(draftState);
  const task = await createTask({ text: catalogText, systemCodes: allSystems });
  assert.equal(task.systemScope.identity.summary.links, 11);
  assert.deepEqual(task.systemScope.identity.conflictKinds, ['alias_divergence', 'declaration_divergence', 'key_shape_incompatible']);
  assert.match(task.response, /标识对应：跨系统标识对应 11 条/);
  assert.match(task.response, /未识别到自身标识的对象：Inventory（ERP）/);
  assert.match(task.response, /范围内被引用但没有对应实体：organization_id→Organization/);
  assert.ok(task.events.some((event) => event.type === 'system_identity_linking_reported'));
  // 任务上只放计数与冲突种类，完整清单留在提案里——两处各存一份迟早不一致。
  assert.equal(Object.hasOwn(task.systemScope.identity, 'links'), false);
  assert.ok(task.proposal.identityLinking.links.length);
});

test('标识用例 4：对象的标识必须指向它自身概念，外键不得被当作主键', async () => {
  resetRuntimeState(draftState);
  const task = await createTask({ text: catalogText, systemCodes: allSystems });
  const wms = task.proposal.identityLinking.fieldCatalog.find((entry) => entry.code === 'WMS');
  const receipt = wms.objects.find((item) => item.objectId === 'InboundReceipt');
  // InboundReceipt 有三个 _id 后缀字段；只有 receipt_id 指向 InboundReceipt 自己。
  assert.deepEqual(receipt.fields.filter((field) => field.identity).map((field) => field.name).sort(), ['material_batch_id', 'purchase_order_id', 'receipt_id']);
  assert.equal(receipt.identifier, 'receipt_id');
  assert.match(receipt.identifierBasis, /唯一指向 InboundReceipt/);
  // 反向：ERP 库存的 lot_no 指向**物料批次**，是引用而不是库存自身的标识；
  // 若把它当标识，它就会变成「物料批次」概念的对齐目标，引来一串虚假的跨系统引用。
  const erpInventory = task.proposal.identityLinking.fieldCatalog.find((entry) => entry.code === 'ERP').objects.find((item) => item.objectId === 'Inventory');
  assert.equal(erpInventory.identifier, null);
  assert.deepEqual(erpInventory.identifierCandidates, ['lot_no']);
  assert.match(erpInventory.identifierBasis, /都指向其他概念，属引用而非自身标识/);
  assert.deepEqual(task.proposal.identityLinking.keyGaps, [{
    system: 'ERP', objectId: 'Inventory', candidates: ['lot_no'],
    reason: '声明中没有指向 Inventory 的标识字段；lot_no 都指向其他概念，属引用而非自身标识'
  }]);
  // 未识别标识的对象**不得**成为任何链接的对齐目标。
  assert.ok(!task.proposal.identityLinking.links.some((item) => item.to.objectId === 'Inventory' && item.to.system === 'ERP'));
});

test('标识用例 5：同义不同名与键形状冲突必须显式上报，而不是任选一个名字', async () => {
  resetRuntimeState(draftState);
  const task = await createTask({ text: catalogText, systemCodes: allSystems });
  const { conflicts } = task.proposal.identityLinking;
  const aliases = conflicts.find((item) => item.kind === 'alias_divergence' && item.concept === 'MaterialBatch');
  assert.deepEqual(aliases.fields.map((field) => field.name), ['lot_no', 'material_batch_id', 'material_batch_no']);
  assert.ok(aliases.fields.every((field) => field.occurrences.length));
  const shapes = conflicts.find((item) => item.kind === 'key_shape_incompatible' && item.concept === 'MaterialBatch');
  assert.deepEqual(shapes.agent, ['material_batch_id']);
  assert.deepEqual(shapes.business, ['lot_no', 'material_batch_no']);
  assert.match(shapes.reason, /按值连接不成立/);
  // 同名不等于同一实体：清单里的 Inventory 被 ERP 与 WMS 同时声明，字段集不同。
  const collision = conflicts.find((item) => item.kind === 'declaration_divergence' && item.scope === 'object' && item.objectId === 'Inventory');
  assert.deepEqual([...new Set(collision.declarations.map((item) => item.system))].sort(), ['ERP', 'WMS']);
  assert.match(collision.reason, /同名不等于同一实体/);
});

test('标识用例 6：泛化标识必须报归属歧义，不能被静默归到某个概念', () => {
  // `id` 这类泛化名在不同系统指向不同实体——这正是「同名不同义」。
  const linking = deriveIdentityLinking({
    objects: [
      makeObject('Order', ['OMS'], ['id', 'store_id', 'channel'], 'id'),
      makeObject('Supplier', ['ERP'], ['id', 'qualification_status'], 'id')
    ],
    systems: ['OMS', 'ERP']
  });
  const ambiguous = linking.conflicts.find((item) => item.kind === 'ambiguous_identifier');
  assert.equal(ambiguous.field, 'id');
  assert.equal(ambiguous.blocksLink, true);
  assert.match(ambiguous.reason, /泛化标识/);
  assert.deepEqual(ambiguous.occurrences.sort(), ['ERP.Supplier.id', 'OMS.Order.id']);
  // 归属不明的字段不参与链接推导：不得因为两个对象都叫 `id` 就连起来。
  assert.deepEqual(linking.links.filter((item) => item.field === 'id'), []);
});

test('标识用例 7：未给出范围的路径不产生标识对应，修订字段后必须重算', async () => {
  resetRuntimeState(draftState);
  // 非建模路径（未提供范围）不得凭空推导「范围内的系统声明」。
  const unscoped = await createTask({ text: '建立供应商与原料批次的语义模型。' });
  assert.ok(unscoped.error, '空范围必须被拒绝，不能静默推导');
  // 显式范围 ≥1 的任务才有；且 `scopeSystems` 非数组时不推导。
  const scoped = await createTask({ text: '建立 WMS 库存与入库语义模型。', systemCodes: ['WMS'] });
  assert.ok(scoped.proposal.identityLinking, '给出范围时必须分析');
  assert.deepEqual(scoped.proposal.identityLinking.systems, ['WMS']);
  // 单系统范围内不存在跨系统引用（同系统的引用由受控词汇表关系表达，不重复计入跨系统链接）。
  assert.deepEqual(scoped.proposal.identityLinking.links, []);
  // 修订对象字段后，标识对应必须重算，不能停留在与当前草稿不符的旧结论上。
  const { reviseSemanticOperationsTaskProposal } = await import('../src/services/semantic-operations-task-service.js');
  const objects = structuredClone(scoped.proposal.objectTypes);
  const inventory = objects.find((item) => item.id === 'Inventory');
  inventory.fieldDefinitions = inventory.fieldDefinitions.map((field) => field.name === 'material_batch_id' ? { ...field, name: 'batch_ref', sourceField: 'batch_ref' } : field);
  inventory.fields = inventory.fieldDefinitions.map((field) => field.name);
  const revised = reviseSemanticOperationsTaskProposal({
    taskId: scoped.id, body: { revision: scoped.proposal.revision, objectTypes: objects, relationshipTypes: scoped.proposal.relationshipTypes },
    role: getRole('executive'), identityScope: identity
  });
  assert.ok(!revised.error, JSON.stringify(revised));
  const wmsInventory = revised.proposal.identityLinking.fieldCatalog.find((entry) => entry.code === 'WMS').objects.find((item) => item.objectId === 'Inventory');
  assert.ok(wmsInventory.fields.some((field) => field.name === 'batch_ref'));
  assert.equal(wmsInventory.fields.some((field) => field.name === 'material_batch_id'), false);
});

// ---- 阶段 4b：人工确认后并入 ----
// 接入点复用既有复核动作（PATCH 提案），因此并入的关系会一并经历 Schema Critic、Diff 与修订历史；
// 这意味着「并入」必须与普通修订共享同一套不变量，而不是走一条旁路。
const reviseTask = (taskId, body) => reviseSemanticOperationsTaskProposal({ taskId, body, role: getRole('executive'), identityScope: identity });
const derivedOf = (proposal) => proposal.relationshipTypes.filter((item) => item.derivedFrom);

const scopedFixture = async () => {
  resetRuntimeState(draftState);
  const task = await createTask({ text: catalogText, systemCodes: allSystems });
  assert.ok(!task.error, JSON.stringify(task));
  assert.ok(task.proposal.identityLinking.links.length > 0, '夹具必须含跨系统标识对应');
  return task;
};

test('标识用例 8：确认后并入的关系必须标为「推断」，与材料证据在草稿里可区分', async () => {
  const task = await scopedFixture();
  const before = task.proposal.relationshipTypes.length;
  const link = task.proposal.identityLinking.links.find((item) => item.status === 'linkable');
  const revised = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes, identityLinkConfirmations: [link.key] });
  assert.ok(!revised.error, JSON.stringify(revised));
  assert.equal(revised.proposal.relationshipTypes.length, before + 1);
  const [merged] = derivedOf(revised.proposal);
  assert.equal(merged.provenanceType, 'inferred', '推断不得被记成 declared/confirmed');
  assert.equal(merged.derivedFrom, link.key, '必须留回指链接 key 的凭据');
  assert.equal(merged.from, link.from.objectId);
  assert.equal(merged.to, link.to.objectId);
  assert.equal(merged.predicate, `references_${link.from.field}`);
  assert.equal(merged.cardinality, link.cardinality);
  assert.match(merged.evidence, /人工复核确认的标识对应/);
  assert.match(merged.evidence, /推断/);
  // 「可区分」是 ADR-014 退出条件 1 的核心要求：同一份草稿里两类边必须能分辨。
  assert.equal(revised.proposal.relationshipTypes.filter((item) => !item.derivedFrom).every((item) => item.provenanceType === 'declared'), true);
  assert.deepEqual(revised.proposal.identityLinkConfirmations, [{ key: link.key, evidence: '' }]);
  assert.deepEqual(revised.proposal.identityLinkConfirmationReport, { merged: 1, skippedExisting: [], droppedStale: [], shapeResolutions: [] });
  // 幂等：重复确认同一条不产生第二条边（否则每次保存都会堆一条重复边）。
  const again = reviseTask(task.id, { revision: revised.proposal.revision, relationshipTypes: revised.proposal.relationshipTypes, identityLinkConfirmations: [link.key] });
  assert.ok(!again.error, JSON.stringify(again));
  assert.equal(derivedOf(again.proposal).length, 1);
});

test('标识用例 9：形状已知且不同的对应必须给**结构化映射定义**，只给自由文本一律拒绝', async () => {
  const task = await scopedFixture();
  const link = task.proposal.identityLinking.links.find((item) => item.status === 'requires_mapping');
  assert.equal(link.from.shape, 'business');
  assert.equal(link.to.shape, 'agent');
  // 「确认但无定义」等于把一种已知不可按值连接的关系伪装成可连接，必须拒绝而不是放行。
  const rejected = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes, identityLinkConfirmations: [link.key] });
  assert.equal(rejected.code, 'SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID');
  // 阶段 4d（ADR-019）：**自由文本不再被接受**——它回答不了「这条边是否需要经映射、谁维护、哪一版」，
  // 而这三件事正是下游必须能机器读到的东西（旧码 `..._REQUIRES_MAPPING_EVIDENCE` 已被取代）。
  const textOnly = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes, identityLinkConfirmations: [{ key: link.key, evidence: 'WMS 入库单上的来源单号回填 ERP 采购订单号' }] });
  assert.equal(textOnly.code, 'SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID');
  // 四类非法定义各自拒绝，且原因可读。
  const missingOwner = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes, identityLinkConfirmations: [{ key: link.key, keyMapping: { fromField: link.from.field, toField: link.to.field, basis: 'manual_register', version: 'v1' } }] });
  assert.equal(missingOwner.code, 'SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID');
  assert.match(missingOwner.error, /责任人/);
  const missingVersion = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes, identityLinkConfirmations: [{ key: link.key, keyMapping: { fromField: link.from.field, toField: link.to.field, basis: 'manual_register', owner: '主数据组' } }] });
  assert.match(missingVersion.error, /版本/);
  const badBasis = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes, identityLinkConfirmations: [{ key: link.key, keyMapping: { fromField: link.from.field, toField: link.to.field, basis: '查过了', owner: '主数据组', version: 'v1' } }] });
  assert.match(badBasis.error, /映射依据类型/);
  // basis = master_data_lookup 时必须写明对照表来源。
  const noLookup = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes, identityLinkConfirmations: [{ key: link.key, keyMapping: { fromField: link.from.field, toField: link.to.field, basis: 'master_data_lookup', owner: '主数据组', version: 'v1' } }] });
  assert.match(noLookup.error, /对照表来源/);
  // 两端键必须与这条对应逐字一致：填成另一条对应的映射，在草稿里看不出来，只能挡在入口。
  const mismatched = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes, identityLinkConfirmations: [{ key: link.key, keyMapping: { fromField: 'material_code', toField: link.to.field, basis: 'manual_register', owner: '主数据组', version: 'v1' } }] });
  assert.match(mismatched.error, /逐字一致/);
  // 合法定义可以并入：结构化映射**进草稿**（下游可机器读），人写的补充说明仍留在 evidence 上。
  const mapping = { fromField: link.from.field, toField: link.to.field, basis: 'master_data_lookup', lookupSource: 'MDM 物料主数据对照表', owner: '主数据组', version: '2026-09-25' };
  const note = 'WMS 入库单上的来源单号回填 ERP 采购订单号';
  const accepted = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes, identityLinkConfirmations: [{ key: link.key, evidence: note, keyMapping: mapping }] });
  assert.ok(!accepted.error, JSON.stringify(accepted));
  const [merged] = derivedOf(accepted.proposal);
  assert.deepEqual(merged.keyMapping, mapping, '结构化映射必须进草稿，不能在净化时被静默丢掉');
  assert.equal(merged.provenanceType, 'inferred', '有了结构化映射也不得升格证据等级——映射是人给的，不是材料写明的外键');
  assert.match(merged.evidence, /不按值直接对齐/);
  assert.match(merged.evidence, /MDM 物料主数据对照表/);
  assert.match(merged.evidence, /主数据组/);
  assert.match(merged.evidence, /2026-09-25/);
  assert.match(merged.evidence, new RegExp(note));
  assert.match(accepted.response, /结构化映射定义/);
  // evidence 有长度上限；实测踩过「硬截断留半句」，因此这里反向锁死：截断必须发生在整句边界。
  assert.ok(merged.evidence.length <= 260, `evidence 超限：${merged.evidence.length}`);
  assert.ok(/基数 n:1$|声明$/.test(merged.evidence), `evidence 以半句结尾：${merged.evidence.slice(-12)}`);
  // 阶段 4e（ADR-020）：这条对应的依据来自**系统配置声明**（`ERP.Inventory` 只在配置映射里），
  // 于是 `declarationSourced` 为真；但它**可确认**（对象名 `Inventory` 与候选对象同名）。
  // 两个字段各答一个问题——这正是旧 `notInProposal` 合并两者时说出那句错话的地方。
  assert.equal(link.declarationSourced, true);
  assert.equal(link.eligible, true);
  assert.match(merged.evidence, /来源依据为系统配置声明$/);
  // 撤销确认即一并消失，不留孤儿映射定义。
  const revoked = reviseTask(task.id, { revision: accepted.proposal.revision, relationshipTypes: accepted.proposal.relationshipTypes, identityLinkConfirmations: [] });
  assert.ok(!revoked.error, JSON.stringify(revoked));
  assert.deepEqual(derivedOf(revoked.proposal), []);
});

test('标识用例 10：省略与空数组语义不同；界面塞进来的同源关系一律剔除', async () => {
  const task = await scopedFixture();
  const link = task.proposal.identityLinking.links.find((item) => item.status === 'linkable');
  const confirmed = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes, identityLinkConfirmations: [link.key] });
  // 省略＝本次不调整确认（普通字段修订不该顺手撤销此前的人工确认）。
  const omitted = reviseTask(task.id, { revision: confirmed.proposal.revision, relationshipTypes: confirmed.proposal.relationshipTypes });
  assert.ok(!omitted.error, JSON.stringify(omitted));
  assert.equal(derivedOf(omitted.proposal).length, 1, '省略确认字段不得清空既有确认');
  // 空数组＝撤销全部（显式为空，不是「未指定」——与 ADR-012 的范围语义同构）。
  const revoked = reviseTask(task.id, { revision: omitted.proposal.revision, relationshipTypes: omitted.proposal.relationshipTypes, identityLinkConfirmations: [] });
  assert.ok(!revoked.error, JSON.stringify(revoked));
  assert.deepEqual(derivedOf(revoked.proposal), []);
  assert.deepEqual(revoked.proposal.identityLinkConfirmations, []);
  // 并入的关系由服务端从确认集合重建：客户端自带 derivedFrom 的关系必须被剔除，
  // 否则「确认」这道人工关口可以被一次构造请求绕过。
  const forged = { ...derivedOf(confirmed.proposal)[0], derivedFrom: 'forged-by-client' };
  const bypass = reviseTask(task.id, { revision: revoked.proposal.revision, relationshipTypes: [...revoked.proposal.relationshipTypes, forged], identityLinkConfirmations: [] });
  assert.ok(!bypass.error, JSON.stringify(bypass));
  assert.deepEqual(derivedOf(bypass.proposal), []);
  // 形状非法同样拒绝，而不是静默当成空集合。
  const malformed = reviseTask(task.id, { revision: bypass.proposal.revision, relationshipTypes: bypass.proposal.relationshipTypes, identityLinkConfirmations: 'all' });
  assert.equal(malformed.code, 'SEMANTIC_IDENTITY_CONFIRMATION_INVALID');
});

test('标识用例 11：确认项失效必须显式——重新提交报错，继承失效上报后移除', async () => {
  const task = await scopedFixture();
  const link = task.proposal.identityLinking.links.find((item) => item.status === 'linkable');
  const confirmed = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes, identityLinkConfirmations: [link.key] });
  // 把该链接依赖的字段改名，对应关系即不复存在。
  const objects = structuredClone(confirmed.proposal.objectTypes);
  const owner = objects.find((item) => item.id === link.from.objectId);
  owner.fieldDefinitions = owner.fieldDefinitions.map((field) => field.name === link.from.field ? { ...field, name: `${link.from.field}_renamed`, sourceField: `${link.from.field}_renamed` } : field);
  owner.fields = owner.fieldDefinitions.map((field) => field.name);
  // 继承失效：不阻断本次修订，但必须出现在报告与任务回应里，不能悄悄消失。
  const inherited = reviseTask(task.id, { revision: confirmed.proposal.revision, objectTypes: objects, relationshipTypes: confirmed.proposal.relationshipTypes });
  assert.ok(!inherited.error, JSON.stringify(inherited));
  assert.deepEqual(derivedOf(inherited.proposal), []);
  // 阶段 4c：失效项由裸 key 升级为 `{ key, reason }`——「因字段修订失效」与「因等价裁定撤下」
  // 要运营做的事完全不同（去看字段 / 去看裁定），一个字符串说不清。
  assert.deepEqual(inherited.proposal.identityLinkConfirmationReport.droppedStale, [{
    key: link.key, reason: '字段或来源系统在本轮修订后不再形成该对应。'
  }]);
  assert.match(inherited.response, /已失效并被移除/);
  assert.match(inherited.response, /不再形成该对应/);
  // 显式重新提交一个已失效的 key 是硬错误：那说明界面拿的是一份过期结论。
  const stale = reviseTask(task.id, { revision: inherited.proposal.revision, objectTypes: objects, relationshipTypes: inherited.proposal.relationshipTypes, identityLinkConfirmations: [link.key] });
  assert.equal(stale.code, 'SEMANTIC_IDENTITY_CONFIRMATION_STALE');
  assert.match(stale.error, /不再形成该对应/);
});

test('标识用例 12：材料证据优先——同一条边已有证据时，推断不覆盖证据', () => {
  // 目录里不存在 `references_<field>` 形式的关系，因此这条性质用单元夹具锁死：
  // 若将来把「同一条边」交给推断覆盖证据，这里会失败。
  const links = deriveIdentityLinking({
    objects: [
      makeObject('PurchaseOrder', ['ERP'], ['purchase_order_id', 'supplier_id', 'status']),
      makeObject('InboundReceipt', ['WMS'], ['receipt_id', 'purchase_order_id', 'material_batch_id'], 'receipt_id')
    ],
    systems: ['ERP', 'WMS']
  }).links;
  assert.equal(links.length, 1);
  const [link] = links;
  const declared = [{ from: link.from.objectId, predicate: `references_${link.from.field}`, to: link.to.objectId, cardinality: link.cardinality, evidence: '受控数据字典：该字段标注为外键', provenanceType: 'declared' }];
  const result = buildConfirmedRelationships({ links, confirmations: [{ key: link.key, evidence: '' }], declaredRelationships: declared });
  assert.deepEqual(result.relationships, []);
  assert.deepEqual(result.skippedExisting, [link.evidence]);
  // 仍算「已接受」：重复提交同一条不会反复报错，只是不产生第二条边。
  assert.deepEqual(result.accepted, [{ key: link.key, evidence: '' }]);
  assert.deepEqual(result.unknown, []);
  // 没有证据声明时，同一条确认必须能够并入。
  const fresh = buildConfirmedRelationships({ links, confirmations: [{ key: link.key, evidence: '' }], declaredRelationships: [] });
  assert.equal(fresh.relationships.length, 1);
  assert.equal(fresh.relationships[0].provenanceType, 'inferred');
  assert.equal(fresh.relationships[0].derivedFrom, link.key);
});

// ── 阶段 4c：标识等价假设的裁定（ADR-016）──────────────────────────────────
//
// 裁定与确认是两个不同的关口，刻意分开锁死：
//   裁定回答「这个等价假设成立吗」——改链接推导的**输入**；
//   确认回答「这条对应要写进模型吗」——改**草稿关系**。
// 因此裁定绝不产生 `provenanceType`，也就不可能与 4b 的 `inferred` 混用。

test('标识用例 13：等价裁定为不同实体时，跨等价类的对应被撤下而不是保留为可疑项', async () => {
  const task = await scopedFixture();
  const baseline = task.proposal.identityLinking;
  assert.equal(baseline.summary.links, 11);
  assert.equal(baseline.summary.withdrawnLinks, 0);
  assert.equal(baseline.summary.ruledConcepts, 0);
  assert.deepEqual(baseline.rulingReport.unresolvedConcepts, ['Material', 'MaterialBatch', 'Product', 'ProductionBatch', 'TestResult']);
  // 「有多少条对应站在没人回答过的前提上」不能靠数 `ruling === null`——那会把本就没有等价分歧的
  // PurchaseOrder / Supplier 也算进来，从而高估问题规模。
  assert.equal(baseline.links.filter((link) => !link.ruling && baseline.rulingReport.unresolvedConcepts.includes(link.concept)).length, 9);
  assert.match(task.proposal.reviewNotes.join('\n'), /9 条标识对应建立在「同一概念下的多个字段名指向同一实体」这一\*\*尚未裁定\*\*的等价前提上/);

  const ruled = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes,
    identityConflictRulings: [{ concept: 'MaterialBatch', ruling: 'distinct_entity', groups: [['lot_no'], ['material_batch_no'], ['material_batch_id']] }] });
  assert.ok(!ruled.error, JSON.stringify(ruled));
  const linking = ruled.proposal.identityLinking;
  // 11 → 9：lot_no 与 material_batch_no 各自独立成组，与 material_batch_id 的对齐不成立。
  assert.equal(linking.summary.links, 9);
  assert.equal(linking.summary.withdrawnLinks, 2);
  assert.deepEqual(linking.withdrawnLinks.map((item) => item.from), ['ERP.Inventory.lot_no', 'LIMS.Sample.material_batch_no']);
  assert.match(linking.withdrawnLinks[0].reason, /人工裁定 MaterialBatch 下的 lot_no 与 material_batch_id 属不同实体/);
  // 撤下不等于静默消失：被撤下的对应不得再出现在可确认清单里，
  // 否则会留下一个「已知不成立但可以勾选」的采纳入口。
  assert.ok(linking.links.every((item) => item.key !== linking.withdrawnLinks[0].key));
  // 同组的对应保留，并标出所属概念的裁定——「等价前提已被看过」是审阅依据的一部分。
  const kept = linking.links.filter((item) => item.concept === 'MaterialBatch');
  assert.equal(kept.length, 2);
  assert.ok(kept.every((item) => item.ruling === 'distinct_entity'));
  // 冲突本身仍然上报（声明里确实有 3 个字段名），只标注已裁定——抹掉冲突会让人以为声明被改过。
  const aliases = linking.conflicts.find((item) => item.kind === 'alias_divergence' && item.concept === 'MaterialBatch');
  assert.equal(aliases.ruling, 'distinct_entity');
  assert.match(aliases.reason, /已由人工裁定为不同实体/);
  assert.equal(linking.summary.unresolvedAliasConcepts, 4);
  // 裁定不写草稿关系：关系数不因裁定而变化。
  assert.equal(ruled.proposal.relationshipTypes.length, 8);
  assert.equal(derivedOf(ruled.proposal).length, 0);
  assert.deepEqual(ruled.proposal.identityConflictRulings, [{ concept: 'MaterialBatch', ruling: 'distinct_entity', groups: [['lot_no'], ['material_batch_no'], ['material_batch_id']] }]);
  assert.match(ruled.response, /已裁定 1 个概念的标识等价关系（MaterialBatch＝不同实体）/);
  assert.match(ruled.response, /撤下 2 条跨等价类的标识对应/);
});

test('标识用例 14：裁定为同一实体关闭等价分歧；省略等于不调整，空数组等于撤销全部', async () => {
  const task = await scopedFixture();
  const same = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes,
    identityConflictRulings: [{ concept: 'MaterialBatch', ruling: 'same_entity' }] });
  assert.ok(!same.error, JSON.stringify(same));
  const linking = same.proposal.identityLinking;
  // 裁定为同一实体不撤下任何对应，只是把等价前提标成「已被看过」。
  assert.equal(linking.summary.links, 11);
  assert.equal(linking.summary.withdrawnLinks, 0);
  assert.equal(linking.summary.ruledConcepts, 1);
  assert.equal(linking.summary.unresolvedAliasConcepts, 4);
  assert.ok(linking.links.filter((item) => item.concept === 'MaterialBatch').every((item) => item.ruling === 'same_entity'));
  const aliases = linking.conflicts.find((item) => item.kind === 'alias_divergence' && item.concept === 'MaterialBatch');
  assert.equal(aliases.ruling, 'same_entity');
  assert.match(aliases.reason, /已由人工裁定为同一业务实体/);

  // 省略裁定集合＝本次不调整（与确认集合同构）：任何普通字段修订都不得顺手撤销裁定。
  const omitted = reviseTask(task.id, { revision: same.proposal.revision, relationshipTypes: same.proposal.relationshipTypes });
  assert.ok(!omitted.error, JSON.stringify(omitted));
  assert.deepEqual(omitted.proposal.identityConflictRulings, [{ concept: 'MaterialBatch', ruling: 'same_entity', groups: null }]);
  assert.equal(omitted.proposal.identityLinking.summary.ruledConcepts, 1);

  // 空数组＝撤销全部裁定（显式为空，不是「未指定」）。
  const revoked = reviseTask(task.id, { revision: omitted.proposal.revision, relationshipTypes: omitted.proposal.relationshipTypes, identityConflictRulings: [] });
  assert.ok(!revoked.error, JSON.stringify(revoked));
  assert.deepEqual(revoked.proposal.identityConflictRulings, []);
  assert.equal(revoked.proposal.identityLinking.summary.ruledConcepts, 0);
  assert.equal(revoked.proposal.identityLinking.summary.links, 11);
});

test('标识用例 15：等价类分组必须是严格划分——部分覆盖、重复、单组、陌生字段一律拒绝', async () => {
  const task = await scopedFixture();
  const revise = (rulings) => reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes, identityConflictRulings: rulings });
  // 未覆盖 material_batch_id：未提及的字段名会落进一个未声明的分组，等于服务器替人补了一次裁定。
  const uncovered = revise([{ concept: 'MaterialBatch', ruling: 'distinct_entity', groups: [['lot_no'], ['material_batch_no']] }]);
  assert.equal(uncovered.code, 'SEMANTIC_IDENTITY_RULING_GROUPS_INVALID');
  assert.match(uncovered.error, /未覆盖：material_batch_id/);
  const duplicated = revise([{ concept: 'MaterialBatch', ruling: 'distinct_entity', groups: [['lot_no', 'material_batch_id'], ['material_batch_id', 'material_batch_no']] }]);
  assert.equal(duplicated.code, 'SEMANTIC_IDENTITY_RULING_GROUPS_INVALID');
  assert.match(duplicated.error, /重复字段/);
  // 只给一组等于「同一实体」，是自相矛盾的裁定。
  const single = revise([{ concept: 'Product', ruling: 'distinct_entity', groups: [['sku', 'product', 'product_code', 'product_id']] }]);
  assert.equal(single.code, 'SEMANTIC_IDENTITY_RULING_GROUPS_INVALID');
  assert.match(single.error, /只给一组等同于「同一实体」/);
  // batch_no 属于 ProductionBatch 概念，不是 MaterialBatch 的字段名。
  const stray = revise([{ concept: 'MaterialBatch', ruling: 'distinct_entity', groups: [['lot_no', 'batch_no'], ['material_batch_no'], ['material_batch_id']] }]);
  assert.equal(stray.code, 'SEMANTIC_IDENTITY_RULING_GROUPS_INVALID');
  assert.match(stray.error, /不属于该概念：batch_no/);
  const badAction = revise([{ concept: 'MaterialBatch', ruling: 'merge' }]);
  assert.equal(badAction.code, 'SEMANTIC_IDENTITY_RULING_INVALID');
  assert.match(badAction.error, /只支持 same_entity \/ distinct_entity/);
  const duplicatedConcept = revise([{ concept: 'MaterialBatch', ruling: 'same_entity' }, 'MaterialBatch']);
  assert.equal(duplicatedConcept.code, 'SEMANTIC_IDENTITY_RULING_INVALID');
  // 以上全部被拒绝，且一条都没有落库。
  const after = getSemanticOperationsTask({ taskId: task.id, identityScope: identity });
  assert.deepEqual(after.proposal.identityConflictRulings, []);
});

test('标识用例 16：裁定集合的全量语义与失效分流（纯函数口径）', () => {
  const conflicts = [{ kind: 'alias_divergence', concept: 'MaterialBatch', fields: [{ name: 'lot_no' }, { name: 'material_batch_id' }] }];
  // 省略＝不调整：历史裁定原样保留，且不带 explicit（其失效不得阻断修订）。
  const omitted = resolveIdentityConflictRulings({ conflicts, inherited: [{ concept: 'MaterialBatch', ruling: 'same_entity', groups: null }] });
  assert.deepEqual(omitted.entries, [{ concept: 'MaterialBatch', ruling: 'same_entity', groups: null, explicit: false }]);
  assert.deepEqual(omitted.unknown, []);
  // 历史裁定对应的概念已无等价分歧 → 记入 unknown 且 explicit=false（由调用方写进 droppedStale）。
  const stale = resolveIdentityConflictRulings({ conflicts, inherited: [{ concept: 'Material', ruling: 'same_entity', groups: null }] });
  assert.deepEqual(stale.entries, []);
  assert.deepEqual(stale.unknown, [{ concept: 'Material', ruling: 'same_entity', groups: null, explicit: false }]);
  // 显式提交同一概念 → unknown 带 explicit=true（由调用方升级为硬错误）。
  assert.deepEqual(resolveIdentityConflictRulings({ conflicts, requested: ['Material'] }).unknown, [{ concept: 'Material', ruling: 'same_entity', explicit: true }]);
  // 只写概念名等价于「确认同一实体」——最常见的一种裁定，允许简写。
  assert.deepEqual(resolveIdentityConflictRulings({ conflicts, requested: ['MaterialBatch'] }).entries, [{ concept: 'MaterialBatch', ruling: 'same_entity', groups: null, explicit: true }]);
  // 形状非法一律拒绝，而不是静默当成空集合。
  assert.equal(resolveIdentityConflictRulings({ conflicts, requested: 'all' }).code, 'SEMANTIC_IDENTITY_RULING_INVALID');
  assert.equal(resolveIdentityConflictRulings({ conflicts, requested: [] }).entries.length, 0);
  // 显式提交一个当前没有等价分歧的概念是硬错误（界面拿的是过期结论）。
  const taskLevel = resolveIdentityConflictRulings({ conflicts, requested: ['PurchaseOrder'] });
  assert.equal(taskLevel.unknown[0].explicit, true);
});

test('标识用例 17：被裁定撤下的对应，此前的确认随之失效并给出原因', async () => {
  const task = await scopedFixture();
  const link = task.proposal.identityLinking.links.find((item) => item.evidence.startsWith('ERP.Inventory.lot_no'));
  assert.equal(link.status, 'requires_mapping');
  const confirmed = reviseTask(task.id, { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes,
    identityLinkConfirmations: [{ key: link.key, evidence: 'ERP 库存批号与 WMS 批次按物料批次编码对齐（人工核对）', keyMapping: { fromField: link.from.field, toField: link.to.field, basis: 'manual_register', owner: '主数据组', version: 'v1' } }] });
  assert.ok(!confirmed.error, JSON.stringify(confirmed));
  assert.equal(derivedOf(confirmed.proposal).length, 1);
  assert.equal(confirmed.proposal.relationshipTypes.length, 9);

  const ruled = reviseTask(task.id, { revision: confirmed.proposal.revision, relationshipTypes: confirmed.proposal.relationshipTypes,
    identityConflictRulings: [{ concept: 'MaterialBatch', ruling: 'distinct_entity', groups: [['lot_no'], ['material_batch_no'], ['material_batch_id']] }] });
  assert.ok(!ruled.error, JSON.stringify(ruled));
  // 对应被裁定撤下 → 服务端从确认集合重建时查不到该 key，并入的边随之消失。
  // 不阻断修订（否则一次裁定会让整个提案卡住），但必须留下可追问的原因。
  assert.equal(derivedOf(ruled.proposal).length, 0);
  assert.equal(ruled.proposal.relationshipTypes.length, 8);
  assert.deepEqual(ruled.proposal.identityLinkConfirmations, []);
  const report = ruled.proposal.identityLinkConfirmationReport;
  assert.equal(report.merged, 0);
  assert.equal(report.droppedStale.length, 1);
  assert.equal(report.droppedStale[0].key, link.key);
  // 原因必须能区分「字段修订」与「裁定撤下」——两者要运营做的事完全不同。
  assert.match(report.droppedStale[0].reason, /人工裁定 MaterialBatch 下的 lot_no 与 material_batch_id 属不同实体/);
  assert.match(ruled.response, /此前的确认随之失效/);
  // 若界面仍拿着旧结论显式重新提交这条 key，必须硬错误而不是静默按旧结论并入。
  const stale = reviseTask(task.id, { revision: ruled.proposal.revision, relationshipTypes: ruled.proposal.relationshipTypes, identityLinkConfirmations: [link.key] });
  assert.equal(stale.code, 'SEMANTIC_IDENTITY_CONFIRMATION_STALE');
});

// ── 阶段 4d：形状未判定的对应必须先判定形状（ADR-019）────────────────────────
//
// 这一组刻意把「未知」与「不同」分开锁死：两者都要人做点事，但要做的事完全不同。
//   `shape_unknown`   → 先判定这个裸名是代理键还是业务键；
//   `requires_mapping`→ 两端形状都已知且不同，交出结构化映射定义。
// 把前者并进后者（4c 之前的行为）会让人为一件机器尚未判明的事写「映射依据」。
//
// 阶段 4e 起**全部走纯函数级**（用例 19 走「判定后的重定级」，用例 21 走「三条拒绝路径」）：
// 实测两条 `shape_unknown` 对应的源对象（`OMS.Order`、`QMS.QualityEvent`）都不在本次候选对象内，
// 而资格检查（ADR-020）排在形状之前，因此任务级再也走不到形状分支——这不是测试退化，
// 而是「先问一条写不进草稿的边形状是什么」这件事被正确地拦掉了（见用例 18 ②）。

// ── 阶段 4e：不可确认的对应没有确认入口（ADR-020）────────────────────────────
//
// 资格与定级是**两个正交的问题**，一个 flag 承载不了：
//   `eligible`  → 这条对应**这次能不能写进草稿**（判据＝两端对象都在本次候选对象内）；
//   三态        → 要写它**得先做什么**（判形状 / 给映射 / 直接确认）。
// 旧的单一 `notInProposal` 拿「依据是不是来自系统声明」冒充资格，实测 5 条里 1 条误报：
// `ERP.Inventory.lot_no`（**可确认**，因对象名 `Inventory` 与候选对象同名）被标成
// 「来源系统本次未进入候选对象」——界面上的一句事实错误。

// 用例 21：形状那一组的三条**拒绝路径**在任务级已不可达（下面用例 18 的实测原因），
// 因此改在纯函数层取证。夹具与用例 19 同源：`OMS.Order` 是**候选对象**（与任务级不同，
// 那里它只在声明里存在），于是它可确认，形状分支才走得到。
test('标识用例 21：形状判定的三条拒绝路径（纯函数口径）', () => {
  const linking = deriveIdentityLinking({
    objects: [
      makeObject('Order', ['OMS'], ['order_id', 'sku', 'store_id'], 'order_id'),
      makeObject('Product', ['ERP'], ['product_id', 'status'], 'product_id')
    ],
    systems: ['OMS', 'ERP']
  });
  const [link] = linking.links;
  assert.equal(link.status, 'shape_unknown');
  assert.equal(link.eligible, true, '夹具里 Order 是候选对象，因此这条对应可确认');
  const confirm = (confirmation) => buildConfirmedRelationships({ links: linking.links, confirmations: [confirmation], declaredRelationships: [] });

  // ① 不判形状就确认＝让一条「还不知道能不能按值对齐」的边进草稿。
  const missing = confirm({ key: link.key });
  assert.deepEqual(missing.relationships, []);
  assert.equal(missing.missingShape.length, 1);
  assert.match(missing.missingShape[0].reason, /必须先判定形状再确认/);

  // ② 判定值必须在枚举内；写别的（哪怕是同义的英文词）一律拒绝，不得顺延到映射分支。
  const badShape = confirm({ key: link.key, shape: 'surrogate' });
  assert.deepEqual(badShape.relationships, []);
  assert.equal(badShape.invalidShapes.length, 1);
  assert.equal(badShape.invalidShapes[0].code, 'SEMANTIC_IDENTITY_CONFIRMATION_SHAPE_INVALID');
  assert.match(badShape.invalidShapes[0].reason, /只能是 agent \/ business/);
  assert.deepEqual(badShape.invalidMapping, [], '形状值非法时不该顺着往下要映射定义');

  // ③ 形状判定只能提交给「形状未判定」的对应：对一条两端已明确的边提交判定，
  //    说明界面拿的是一份过期结论（与 `_STALE` 同源），不能用一次多余的判定把它改级。
  const settled = { ...link, status: 'linkable', from: { ...link.from, shape: 'agent' } };
  const notApplicable = buildConfirmedRelationships({ links: [settled], confirmations: [{ key: link.key, shape: 'business' }], declaredRelationships: [] });
  assert.equal(notApplicable.invalidShapes.length, 1);
  assert.equal(notApplicable.invalidShapes[0].code, 'SEMANTIC_IDENTITY_CONFIRMATION_SHAPE_NOT_APPLICABLE');
  assert.match(notApplicable.invalidShapes[0].reason, /不需要形状判定/);
});

test('标识用例 18：端点对象不在本次候选内的对应没有确认入口，拒绝原因必须点名对象', async () => {
  const task = await scopedFixture();
  const links = task.proposal.identityLinking.links;
  const reviseFrom = (proposal, patch) => reviseTask(task.id, { revision: proposal.revision, relationshipTypes: proposal.relationshipTypes, ...patch });

  // 实测：4 条不可确认，且**三条形状拒绝路径在任务级已不可达**——两条 `shape_unknown`
  // （`OMS.Order.sku`、`QMS.QualityEvent.product`）的源对象都不在候选内，资格先于形状把它们挡在前面。
  // 这是把资格放在形状之前（决策 3）的**直接后果**，如实说明：先问一条写不进草稿的边「形状是什么」没有意义。
  const outside = links.filter((item) => !item.eligible);
  assert.equal(outside.length, 4);
  const blocked = outside.find((item) => item.status === 'shape_unknown');
  assert.deepEqual([blocked.from.system, blocked.from.objectId, blocked.from.field], ['OMS', 'Order', 'sku']);
  assert.deepEqual(blocked.ineligibleEndpoints, [{ role: 'from', system: 'OMS', objectId: 'Order', groundings: ['source_system_declaration'] }]);
  assert.match(blocked.ineligibleReason, /来源对象 OMS.Order 的依据是系统配置声明，不是本次候选对象，无法并入草稿/);
  assert.match(blocked.ineligibleReason, /如需并入，请先让 Order 成为本次候选对象/);

  // ① 显式确认它 = 硬错误，且**不再**落到通用草案校验上。
  const rejected = reviseFrom(task.proposal, { identityLinkConfirmations: [blocked.key] });
  assert.equal(rejected.code, 'SEMANTIC_IDENTITY_CONFIRMATION_ENDPOINT_OUT_OF_SCOPE');
  assert.match(rejected.error, /以下标识对应本次不可并入/);
  assert.match(rejected.error, /OMS\.Order/);
  assert.equal(/必须完整/.test(rejected.error), false,
    `「必须完整」不是事实（from / to / predicate 三者俱全）：${rejected.error}`);

  // ② 资格先于形状：连形状一起提交也仍然是资格错误——形状在这条边上不改变它的资格。
  const withShape = reviseFrom(task.proposal, { identityLinkConfirmations: [{ key: blocked.key, shape: 'agent' }] });
  assert.equal(withShape.code, 'SEMANTIC_IDENTITY_CONFIRMATION_ENDPOINT_OUT_OF_SCOPE');

  // ③ 拒绝不落库。
  const after = getSemanticOperationsTask({ taskId: task.id, identityScope: identity });
  assert.deepEqual(after.proposal.identityLinkConfirmations, []);
  assert.equal(after.proposal.relationshipTypes.length, 8);

  // ④ 对照组：可确认的照常可确认——资格判据不能把可用的一起挡住，且回应要**同时**说出
  //    「并入了 1 条」与「另有 4 条这次用不了」。只说前者会让后者变成一次静默损失。
  const usable = links.find((item) => item.eligible && item.status === 'requires_mapping');
  const mapping = { fromField: usable.from.field, toField: usable.to.field, basis: 'derived_rule', owner: '应用组', version: 'v1' };
  const ok = reviseFrom(task.proposal, { identityLinkConfirmations: [{ key: usable.key, keyMapping: mapping }] });
  assert.ok(!ok.error, JSON.stringify(ok));
  assert.equal(derivedOf(ok.proposal).length, 1);
  assert.match(ok.response, /已并入 1 条人工确认的标识对应/);
  assert.match(ok.response, /另有 4 条对应本次不可并入/);
  assert.match(ok.response, /LIMS\.Sample、OMS\.Order、QMS\.QualityEvent、WMS\.InboundReceipt/);
  assert.match(ok.response, /需先让这些对象成为候选对象/);

  // ⑤ 继承的确认若变成本次不可并入（端点对象后来被移出候选）→ **不阻断修订**，列入 `droppedStale`。
  //    若这里也硬错误，任何一次对象调整都会把整个提案卡死（与 ADR-015 决策 6 的分流同构）。
  const inherited = buildConfirmedRelationships({
    links: [blocked], confirmations: [{ key: blocked.key, explicit: false }], declaredRelationships: []
  });
  assert.deepEqual(inherited.relationships, []);
  assert.deepEqual(inherited.outOfScope, []);
  assert.equal(inherited.droppedStale.length, 1);
  assert.match(inherited.droppedStale[0].reason, /该对应本次不可并入/);
});

test('标识用例 19：形状判定的两个方向各自重新定级，且判定不写回声明', () => {
  // 纯函数夹具：OMS.Order（`sku` 是裸名，命名规则判不出形状）引用 ERP.Product（标识 `product_id`，代理键）。
  const linking = deriveIdentityLinking({
    objects: [
      makeObject('Order', ['OMS'], ['order_id', 'sku', 'store_id'], 'order_id'),
      makeObject('Product', ['ERP'], ['product_id', 'status'], 'product_id')
    ],
    systems: ['OMS', 'ERP']
  });
  assert.equal(linking.links.length, 1);
  const [link] = linking.links;
  assert.equal(link.status, 'shape_unknown');
  assert.equal(link.from.shape, null);
  assert.equal(link.to.shape, 'agent');
  const confirm = (confirmation) => buildConfirmedRelationships({ links: linking.links, confirmations: [confirmation], declaredRelationships: [] });

  // 判定为代理键 → 与另一端一致 → 重新定级为可按值对齐，**不**要求映射定义。
  const aligned = confirm({ key: link.key, shape: 'agent' });
  assert.deepEqual(aligned.missingShape, []);
  assert.deepEqual(aligned.invalidMapping, []);
  assert.deepEqual(aligned.shapeResolutions, [{ key: link.key, field: 'sku', shape: 'agent', resolvedStatus: 'linkable' }]);
  assert.deepEqual(aligned.accepted, [{ key: link.key, evidence: '', shape: 'agent' }]);
  assert.equal(aligned.relationships.length, 1);
  const [merged] = aligned.relationships;
  assert.equal(Object.hasOwn(merged, 'keyMapping'), false, '形状一致就不该要求映射定义');
  assert.match(merged.evidence, /人工判定 sku 为代理键，与另一端一致，可按值对齐/);

  // 判定为业务键 → 与另一端不同 → 重新定级为需映射，**这时**才要求结构化定义。
  const conflictOnly = confirm({ key: link.key, shape: 'business' });
  assert.equal(conflictOnly.invalidMapping.length, 1);
  assert.equal(conflictOnly.invalidMapping[0].code, 'SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID');
  assert.deepEqual(conflictOnly.relationships, []);
  assert.deepEqual(conflictOnly.shapeResolutions, [{ key: link.key, field: 'sku', shape: 'business', resolvedStatus: 'requires_mapping' }]);
  const mapping = { fromField: 'sku', toField: 'product_id', basis: 'derived_rule', owner: 'OMS 应用组', version: 'v2' };
  const remapped = confirm({ key: link.key, shape: 'business', keyMapping: mapping });
  assert.deepEqual(remapped.invalidMapping, []);
  assert.equal(remapped.relationships.length, 1);
  assert.deepEqual(remapped.relationships[0].keyMapping, mapping);
  // 说明里必须写**判定后**的形状：写 `null / agent` 正是本 ADR 要修的那句读不通的话。
  assert.match(remapped.relationships[0].evidence, /两端键形状不同（business \/ agent），不按值直接对齐/);
  assert.equal(/null/.test(remapped.relationships[0].evidence), false, `判定后仍写出未判定的形状：${remapped.relationships[0].evidence}`);

  // 不写回声明：`shape` 是**这条边上的结论**，不是字段的属性——写回会污染字段目录
  // （一处判定影响所有读该字段的地方）。判定前后链接对象本身必须原封不动。
  assert.equal(link.status, 'shape_unknown');
  assert.equal(link.from.shape, null);
  assert.equal(Object.hasOwn(link, 'keyMapping'), false);
  // 反向：用同一份声明重算，形状仍未判定——判定活在确认项与关系上，不活在推导里。
  const recomputed = deriveIdentityLinking({
    objects: [
      makeObject('Order', ['OMS'], ['order_id', 'sku', 'store_id'], 'order_id'),
      makeObject('Product', ['ERP'], ['product_id', 'status'], 'product_id')
    ],
    systems: ['OMS', 'ERP']
  });
  assert.equal(recomputed.links[0].status, 'shape_unknown');
  // 判定值本身随确认项返回，供服务端留档（下一版界面据此知道「这个裸名的形状是人判的」）。
  assert.deepEqual(remapped.accepted, [{ key: link.key, evidence: '', shape: 'business', keyMapping: mapping }]);
});

// 阶段 4e（ADR-020）：资格判据必须**唯一**，且与服务端草案校验同源。
//
// 旧口径用一个 `notInProposal` 同时回答两个问题（依据来自哪儿 / 能不能确认），
// 于是它在其中一个问题上必然说谎：实测 5 条被标不可确认，其中 `ERP.Inventory.lot_no` **可确认**
// （`ERP.Inventory` 是配置声明，但它的对象名 `Inventory` 与候选对象同名），真不可确认的是 4 条。
// 本用例把「判据与草案校验逐条一致、0 例外」钉死，并反向锁死旧字段不得复活。
test('标识用例 20：资格判据与服务端草案校验同源，「依据来自系统声明」不再冒充不可确认', async () => {
  const task = await scopedFixture();
  const linking = task.proposal.identityLinking;
  const candidateIds = new Set(task.proposal.objectTypes.map((item) => item.id));

  // 判据逐条一致：这是「推导层说得出」与「服务端写得进」不分叉的全部依据。
  for (const link of linking.links) {
    assert.equal(link.eligible, candidateIds.has(link.from.objectId) && candidateIds.has(link.to.objectId),
      `${link.evidence} 的资格判据与候选对象成员资格不一致`);
    if (link.eligible) {
      assert.equal(link.ineligibleReason, null);
      assert.deepEqual(link.ineligibleEndpoints, []);
    } else {
      assert.ok(link.ineligibleEndpoints.length, '不可确认必须点名是哪个端点，不能只说「不在范围内」');
      assert.match(link.ineligibleReason, /不是本次候选对象，无法并入草稿/);
      assert.match(link.ineligibleReason, /如需并入，请先让 .+ 成为本次候选对象/);
    }
  }

  // 误报消失：同一条对应上，「依据来自系统声明」与「本次可确认」**同时为真**——
  // 两个判据各答一个问题，这正是旧单一 flag 做不到的地方。
  const collision = linking.links.find((item) => item.evidence.startsWith('ERP.Inventory.lot_no'));
  assert.equal(collision.declarationSourced, true);
  assert.equal(collision.eligible, true);
  assert.equal(Object.hasOwn(collision, 'notInProposal'), false, '旧字段仍在：它把两个问题合并成一个答案');
  // 两个判据的规模各自可复现：5 条的依据来自系统声明（判据未变），其中 1 条仍可确认。
  assert.equal(linking.links.filter((item) => item.declarationSourced).length, 5);

  // 不可确认的 4 条逐个点名（`InboundReceipt` 是方案原文举的例子，也在其中）。
  assert.deepEqual(
    [...new Set(linking.links.filter((item) => !item.eligible)
      .flatMap((item) => item.ineligibleEndpoints.map((endpoint) => `${endpoint.system}.${endpoint.objectId}`)))].sort(),
    ['LIMS.Sample', 'OMS.Order', 'QMS.QualityEvent', 'WMS.InboundReceipt']);

  // 创建回应就要披露——否则「11 条对应里有 4 条用不了」只能靠运营自己试错发现。
  assert.match(task.response, /其中 4 条本次不可并入草稿/);
  assert.match(task.response, /LIMS\.Sample、OMS\.Order、QMS\.QualityEvent、WMS\.InboundReceipt/);

  // 披露而非隐藏：不可确认的仍在清单里（它是系统声明里真实存在的跨系统引用），只是没有确认入口。
  assert.equal(linking.links.length, 11);
  assert.equal(linking.links.filter((item) => !item.eligible).length, 4);
});

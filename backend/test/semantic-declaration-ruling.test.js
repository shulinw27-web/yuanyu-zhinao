import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { getRole } from '../src/services/authorization-service.js';
import { createSemanticOperationsTask, reviseSemanticOperationsTaskProposal } from '../src/services/semantic-operations-task-service.js';
import { deriveIdentityLinking, resolveDeclarationRulings } from '../src/services/semantic-identity-link-service.js';

// 阶段 4c 第三段（ADR-018）验收：同名声明不一致的「合并 / 区分粒度」裁定。
//
// 这一段的起点是一个**默认动作**：同一对象在同一系统里被多处声明而字段集不一致时，
// 目录对字段取**并集**。并集本身不是错，错在它①不可见、②参与标识识别——
// 于是产出一个谁也没声明过的复合体（实测：MES.ProductionBatch 被并集授予
// production_batch_id，而它的配置映射只声明 batch_no）。
//
// 因此本文件的用例分两组性质：
//   A. **披露**：未裁定时并集必须逐处列出（`declarations` / `exclusiveFields` / `declarationState`），
//      且 `identifierBasis` 要说清「这是在并集上识别的」——披露是让默认动作不再隐形的最低要求；
//   B. **裁定**：`merge` 把并集变成结论；`distinct` **不并集**（按组拆分，各自识别标识）；
//      两者都不写草稿、不产生证据等级（与 ADR-016 同立场），撤销必须双向完全回退。
//
// 全部为内置合成数据下的**确定性**断言（本模块不调用模型）。

const identity = { tenantId: 'declaration-ruling-test', subjectId: 'declaration-reviewer', deviceId: 'declaration-device' };
const allSystems = ['ERP', 'WMS', 'LIMS', 'QMS', 'MES', 'OMS'];
const catalogText = '建立供应商、采购订单、采购需求、原料批次、生产批次、成品批次、检验结果、库存、设备、门店、物料主数据、产品主数据的语义模型。';
const draftState = ['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime'];

const createTask = () => createSemanticOperationsTask({ body: { text: catalogText, systemCodes: allSystems }, role: getRole('executive'), identityScope: identity });
const revise = (task, body) => reviseSemanticOperationsTaskProposal({ taskId: task.id, body, role: getRole('executive'), identityScope: identity });
const reviseRulings = (task, declarationRulings) => revise(task, {
  revision: task.proposal.revision, objectTypes: task.proposal.objectTypes,
  relationshipTypes: task.proposal.relationshipTypes, declarationRulings
});
const fixture = async () => {
  resetRuntimeState(draftState);
  const task = await createTask();
  assert.ok(!task.error, JSON.stringify(task));
  const linking = task.proposal.identityLinking;
  assert.equal(linking.summary.declarationDivergences, 5, '夹具必须含同名声明分歧');
  return task;
};
const itemOf = (linking, key) => linking.conflicts.find((item) => item.kind === 'declaration_divergence' && item.key === key);
const objectOf = (linking, system, objectId) => linking.fieldCatalog.find((entry) => entry.code === system).objects.find((object) => object.objectId === objectId);
// 生产批次的「同一张表被两处声明」分歧：受控词汇表那份与已配置映射那份字段集完全不同。
const PRODUCTION_BATCH_KEY = 'source:ProductionBatch@mes.production_batch';
const productionBatchSplit = (names) => [{
  key: PRODUCTION_BATCH_KEY, ruling: 'distinct',
  groups: [
    { name: names[0], declarations: ['MES.ProductionBatch@proposal_object'] },
    { name: names[1], declarations: ['MES.ProductionBatch@source_system_declaration'] }
  ]
}];

test('声明用例 1：未裁定时，字段并集必须逐处披露，且标识依据要说明「这是在并集上识别的」', async () => {
  const task = await fixture();
  const linking = task.proposal.identityLinking;
  const object = objectOf(linking, 'MES', 'ProductionBatch');
  // 21 个对象 / 11 条链接 / 14 项冲突：未裁定路径不得因本段引入任何变化（回归护栏）。
  assert.equal(linking.summary.objects, 21);
  assert.equal(linking.summary.links, 11);
  assert.equal(linking.summary.conflicts, 14);
  assert.equal(linking.summary.mergedUnruledObjects, 4);
  assert.equal(object.declarationState, 'merged_unruled');
  assert.equal(object.declaredObjectId, 'ProductionBatch');
  // 并集结果是 7 个字段，但**没有任何一处声明**说过这句话——所以必须逐处列出。
  assert.deepEqual(object.declarations.map((item) => item.declarationKey), [
    'MES.ProductionBatch@proposal_object', 'MES.ProductionBatch@source_system_declaration'
  ]);
  assert.deepEqual(object.declarations[0].fields, ['production_batch_id', 'product_code', 'material_batch_id', 'status']);
  assert.deepEqual(object.declarations[1].fields, ['batch_no', 'formula_version', 'line', 'status']);
  assert.equal(object.fields.length, 7);
  // 只被其中一处声明列出的字段：并集最容易骗人的地方就在这里。
  assert.deepEqual(object.exclusiveFields, ['batch_no', 'formula_version', 'line', 'material_batch_id', 'product_code', 'production_batch_id']);
  assert.match(object.identifierBasis, /2 处声明取并集，尚未裁定/);
});

test('声明用例 2：并集参与标识识别，会授予一个该声明自己从未列出的标识（本段要消除的具体损害）', async () => {
  const task = await fixture();
  const linking = task.proposal.identityLinking;
  const object = objectOf(linking, 'MES', 'ProductionBatch');
  // 并集下的标识来自受控词汇表那一处声明，却被记在「两处声明的并集」这个复合体名下。
  assert.equal(object.identifier, 'production_batch_id');
  assert.equal(object.identifierKind, 'primary');
  assert.match(object.identifierBasis, /受控词汇表登记的主键 production_batch_id/);
  // 而 MES 的**已配置映射**那份声明里根本没有 production_batch_id。
  assert.ok(!object.declarations.find((item) => item.grounding === 'source_system_declaration').fields.includes('production_batch_id'));
  // 反向对照：只看配置映射那一份声明时，它自己的标识是 batch_no（业务键）。
  // 这正是裁定为「不同对象」后应当得到的结果（用例 6 断言这一点）。
  const isolated = deriveIdentityLinking({
    objects: [{
      id: 'ProductionBatch', label: 'ProductionBatch', source: 'mes.production_batch', key: null,
      fields: ['batch_no', 'formula_version', 'line', 'status'], sourceSystems: ['MES'],
      classification: '内部受限', semanticType: 'ProductionBatch', coreObject: 'ProductionBatch'
    }],
    systems: ['MES']
  });
  assert.equal(isolated.fieldCatalog[0].objects.find((object) => object.objectId === 'ProductionBatch').identifier, 'batch_no');
  assert.equal(isolated.fieldCatalog[0].objects.find((object) => object.objectId === 'ProductionBatch').identifierKind, 'business');
  // 未裁定 / 单处声明时不产生复合披露：`exclusiveFields` 只在多处声明时有意义。
  assert.equal(isolated.fieldCatalog[0].objects.find((object) => object.objectId === 'ProductionBatch').declarationState, null);
  assert.deepEqual(isolated.fieldCatalog[0].objects.find((object) => object.objectId === 'ProductionBatch').exclusiveFields, []);
});

test('声明用例 3：分歧项带稳定 key 与组成它的声明清单，两种粒度各自可辨', async () => {
  const task = await fixture();
  const linking = task.proposal.identityLinking;
  assert.deepEqual(linking.conflicts.filter((item) => item.kind === 'declaration_divergence').map((item) => item.key), [
    'object:Inventory', 'source:ProductionBatch@mes.production_batch', 'source:Store@oms.store',
    'source:Supplier@erp.supplier', 'source:TestResult@lims.test_result'
  ]);
  // 对象级：同名对象被**不同系统**声明（同名不同义的候选情形）。
  const collision = itemOf(linking, 'object:Inventory');
  assert.equal(collision.scope, 'object');
  assert.deepEqual(collision.systems, ['ERP', 'WMS']);
  assert.equal(collision.ruling, null);
  assert.deepEqual(collision.declarations.map((item) => item.declarationKey), [
    'ERP.Inventory@source_system_declaration', 'WMS.Inventory@proposal_object'
  ]);
  // 来源级：**同一张表**被两处声明（受控词汇表 vs 已配置映射），两处都在同一个系统里。
  const table = itemOf(linking, PRODUCTION_BATCH_KEY);
  assert.equal(table.scope, 'source');
  assert.equal(table.source, 'mes.production_batch');
  assert.deepEqual(table.systems, ['MES']);
  assert.match(table.reason, /受控词汇表与已配置映射必须核对后再建模/);
  // 未裁定项必须单独成为一项口径——不然运营只能从 14 条冲突里自己数。
  // 顺序是确定的：先按对象名的对象级分歧，再按来源字符串的来源级分歧（与分歧项生成顺序同源）。
  assert.deepEqual(linking.declarationReport.unresolvedItems, [
    'object:Inventory', 'source:Supplier@erp.supplier', 'source:TestResult@lims.test_result',
    PRODUCTION_BATCH_KEY, 'source:Store@oms.store'
  ]);
  assert.equal(linking.summary.unresolvedDeclarationItems, 5);
  assert.equal(linking.summary.ruledDeclarationItems, 0);
});

test('声明用例 4：裁定「合并」把并集从默认动作变成结论，且不改变目录组成', async () => {
  const task = await fixture();
  const revised = await reviseRulings(task, [{ key: 'object:Inventory', ruling: 'merge' }]);
  assert.ok(!revised.error, JSON.stringify(revised));
  const linking = revised.proposal.identityLinking;
  // 「合并」与「未裁定」的目录**完全一致**（只有是否已裁定这一项状态不同）——
  // 它把默认动作显式化，不是另一种组成。
  assert.equal(linking.summary.objects, 21);
  assert.equal(linking.summary.links, 11);
  assert.equal(linking.summary.conflicts, 14);
  assert.equal(linking.summary.mergedUnruledObjects, 4);
  assert.equal(linking.summary.ruledDeclarationItems, 1);
  assert.equal(linking.summary.unresolvedDeclarationItems, 4);
  const collision = itemOf(linking, 'object:Inventory');
  assert.equal(collision.ruling, 'merge');
  assert.match(collision.reason, /已由人工裁定为\*\*同一个对象\*\*/);
  // 裁定集合由服务端从请求重建并留档。
  assert.deepEqual(revised.proposal.declarationRulings, [{ key: 'object:Inventory', ruling: 'merge', groups: null }]);
  assert.deepEqual(revised.proposal.identityLinking.declarationReport.applied, [{ key: 'object:Inventory', ruling: 'merge', groups: null }]);
  assert.match(revised.response, /同名声明分歧/);
});

test('声明用例 5：合并裁定只出现在字段目录与冲突的上报字段上，不写草稿、不产生证据等级', async () => {
  const task = await fixture();
  const before = task.proposal.objectTypes.length;
  const revised = await reviseRulings(task, [{ key: 'object:Inventory', ruling: 'merge' }]);
  const linking = revised.proposal.identityLinking;
  // 裁定改的是**字段目录的组成**（链接推导的输入），不是草稿：对象与关系一个都不多。
  assert.equal(revised.proposal.objectTypes.length, before);
  assert.equal(revised.proposal.relationshipTypes.length, task.proposal.relationshipTypes.length);
  assert.ok(!revised.proposal.relationshipTypes.some((item) => item.derivedFrom), '裁定不得产生任何推断边');
  // 冲突仍然上报（声明里确实有两份不同字段集，这是事实），只是标注已裁定。
  assert.equal(linking.conflicts.filter((item) => item.kind === 'declaration_divergence').length, 5);
  // 目录条目的 `groundings` 也不因裁定而改（裁定是人的结论，不是声明的出处）。
  assert.deepEqual(objectOf(linking, 'ERP', 'Supplier').groundings, ['proposal_object', 'source_system_declaration']);
});

test('声明用例 6：裁定「区分粒度」后不再并集——按声明拆分，各自识别标识', async () => {
  const task = await fixture();
  const revised = await reviseRulings(task, productionBatchSplit(['ProductionBatch', 'MesBatch']));
  assert.ok(!revised.error, JSON.stringify(revised));
  const linking = revised.proposal.identityLinking;
  // 多出一个对象：原来的一处声明被拆成了独立对象。
  assert.equal(linking.summary.objects, 22);
  assert.equal(linking.summary.mergedUnruledObjects, 3);
  assert.equal(linking.summary.splitObjects, 1);
  assert.equal(linking.summary.ruledDeclarationItems, 1);
  // 两处声明各自成为对象，各自按自己声明的字段识别标识——虚假的并集标识随之消失。
  const kept = objectOf(linking, 'MES', 'ProductionBatch');
  const split = objectOf(linking, 'MES', 'MesBatch');
  assert.equal(kept.declarationState, 'split');
  assert.equal(split.declarationState, 'split');
  assert.equal(split.declaredObjectId, 'ProductionBatch');
  assert.equal(kept.identifier, 'production_batch_id');
  assert.deepEqual(kept.fields.map((field) => field.name), ['production_batch_id', 'product_code', 'material_batch_id', 'status']);
  assert.ok(!kept.fields.some((field) => field.name === 'batch_no'), '拆分后不得再出现跨声明并集');
  assert.equal(split.identifier, 'batch_no');
  assert.equal(split.identifierKind, 'business');
  assert.deepEqual(split.fields.map((field) => field.name), ['batch_no', 'formula_version', 'line', 'status']);
  // 拆分必须可读地列出：对象名变了而界面上一句解释都没有，运营只会看到「对象多了一个」。
  assert.deepEqual(linking.declarationReport.splitObjects, [{
    key: PRODUCTION_BATCH_KEY, scope: 'source', from: 'ProductionBatch', source: 'mes.production_batch',
    into: [
      { name: 'ProductionBatch', declarations: ['MES.ProductionBatch@proposal_object'], systems: ['MES'] },
      { name: 'MesBatch', declarations: ['MES.ProductionBatch@source_system_declaration'], systems: ['MES'] }
    ]
  }]);
  // 没有「被排除的声明」——拆分只是换了身份。
  assert.deepEqual(linking.declarationReport.droppedDeclarations, []);
  // 该对象的标识判据按**声明的原名**推导：裁定说的是「与别处声明不是同一个对象」，
  // 不是「这条声明换了名字」，所以判据不跟着改。
  assert.match(split.identifierBasis, /由对象名 ProductionBatch 派生|唯一指向 ProductionBatch 的业务键字段 batch_no/);
});

test('声明用例 7：裁定「区分粒度 + 排除某处声明」时，被排除的声明必须显式列出', async () => {
  const task = await fixture();
  const revised = await reviseRulings(task, [{
    key: PRODUCTION_BATCH_KEY, ruling: 'distinct',
    groups: [
      { name: 'ProductionBatch', declarations: ['MES.ProductionBatch@source_system_declaration'] },
      { drop: true, declarations: ['MES.ProductionBatch@proposal_object'] }
    ]
  }]);
  assert.ok(!revised.error, JSON.stringify(revised));
  const linking = revised.proposal.identityLinking;
  assert.equal(linking.summary.objects, 21);
  assert.equal(linking.summary.droppedDeclarations, 1);
  assert.deepEqual(linking.declarationReport.droppedDeclarations.map((item) => item.declarationKey), ['MES.ProductionBatch@proposal_object']);
  assert.match(linking.declarationReport.droppedDeclarations[0].reason, /被显式排除/);
  // 被排除的声明不再进目录：字段集回到「配置映射那一份」。
  const object = objectOf(linking, 'MES', 'ProductionBatch');
  assert.deepEqual(object.fields.map((field) => field.name), ['batch_no', 'formula_version', 'line', 'status']);
  assert.equal(object.identifier, 'batch_no');
  // 该声明原本支撑的两条链接随之消失，且冲突数量一并下降——这是「排除一份声明」的连带后果，
  // 必须在同一份报告里可见，不能只让人看到「链接少了两条」。
  assert.equal(linking.summary.links, 9);
  assert.equal(linking.summary.conflicts, 12);
  assert.ok(linking.declarationReport.droppedLinks.some((item) => item.evidence.includes('MES.ProductionBatch')));
});

test('声明用例 8：对象改名会让基于旧名的对应不再存在，此前的确认随之失效并给出原因', async () => {
  const task = await fixture();
  // 先确认一条以 ERP.Supplier 为目标的对应（linkable，无需映射依据）。
  const supplierLink = task.proposal.identityLinking.links.find((item) => item.to.objectId === 'Supplier' && item.to.system === 'ERP');
  assert.ok(supplierLink, '夹具必须含指向 ERP.Supplier 的对应');
  const confirmed = await revise(task, {
    revision: task.proposal.revision, objectTypes: task.proposal.objectTypes,
    relationshipTypes: task.proposal.relationshipTypes, identityLinkConfirmations: [supplierLink.key]
  });
  assert.ok(!confirmed.error, JSON.stringify(confirmed));
  assert.equal(confirmed.proposal.identityLinkConfirmationReport.merged, 1);
  assert.ok(confirmed.proposal.relationshipTypes.some((item) => item.derivedFrom === supplierLink.key));
  // 再把两处声明都改名（不保留原名）→ 旧对象名消失 → 旧 key 不再存在。
  // 注意这里**不再提交**那条确认（省略＝不调整）：它作为「继承的确认」失效，
  // 走 ADR-015 决策 6 的上报后移除路径；显式重新提交会（正确地）变成硬错误——
  // 那说明界面拿的是一份过期结论。
  const revised = await revise(confirmed, {
    revision: confirmed.proposal.revision, objectTypes: confirmed.proposal.objectTypes,
    relationshipTypes: confirmed.proposal.relationshipTypes,
    declarationRulings: [{
      key: 'source:Supplier@erp.supplier', ruling: 'distinct',
      groups: [
        { name: 'ErpSupplier', declarations: ['ERP.Supplier@proposal_object'] },
        { name: 'ErpSupplierProfile', declarations: ['ERP.Supplier@source_system_declaration'] }
      ]
    }]
  });
  assert.ok(!revised.error, JSON.stringify(revised));
  const linking = revised.proposal.identityLinking;
  const dropped = linking.declarationReport.droppedLinks.find((item) => item.key === supplierLink.key);
  assert.ok(dropped, '旧 key 必须出现在 droppedLinks 里，而不是静默消失');
  // 原因必须可读，且**指向裁定**而不是字段：两种情况要运营做的事完全不同。
  assert.match(dropped.reason, /裁定|改名|声明/);
  assert.equal(linking.declarationReport.applied.length, 1);
  // 继承的确认失去对应 → 走 ADR-015 的「继承失效」路径（上报并移除），不阻断本次修订；
  // 它并入的那条推断边也随之一并消失。
  assert.deepEqual(revised.proposal.identityLinkConfirmationReport.droppedStale.map((item) => item.key), [supplierLink.key]);
  assert.ok(!revised.proposal.relationshipTypes.some((item) => item.derivedFrom === supplierLink.key));
  // 显式重新提交同一个已失效的 key 时，必须是硬错误（与上面「继承」分流的口径一致）。
  const explicit = await revise(revised, {
    revision: revised.proposal.revision, objectTypes: revised.proposal.objectTypes,
    relationshipTypes: revised.proposal.relationshipTypes, identityLinkConfirmations: [supplierLink.key]
  });
  assert.equal(explicit.code, 'SEMANTIC_IDENTITY_CONFIRMATION_STALE');
});

test('声明用例 9：撤销（空数组）必须双向完全回退到与原稿逐项一致', async () => {
  const task = await fixture();
  const original = task.proposal.identityLinking.summary;
  const applied = await reviseRulings(task, productionBatchSplit(['ProductionBatch', 'MesBatch']));
  assert.equal(applied.proposal.identityLinking.summary.objects, 22);
  const revoked = await reviseRulings(applied, []);
  assert.ok(!revoked.error, JSON.stringify(revoked));
  const linking = revoked.proposal.identityLinking;
  // 「撤销」不是「只回退来源字段」：拆出来的对象必须消失、原始条目必须恢复并集。
  assert.deepEqual(revoked.proposal.declarationRulings, []);
  assert.equal(linking.summary.objects, original.objects);
  assert.equal(linking.summary.links, original.links);
  assert.equal(linking.summary.conflicts, original.conflicts);
  assert.equal(linking.summary.mergedUnruledObjects, original.mergedUnruledObjects);
  assert.equal(linking.summary.unresolvedDeclarationItems, 5);
  assert.equal(linking.summary.splitObjects, 0);
  assert.deepEqual(linking.fieldCatalog.find((entry) => entry.code === 'MES').objects.map((object) => object.objectId).filter((id) => id === 'MesBatch'), []);
  const restored = objectOf(linking, 'MES', 'ProductionBatch');
  assert.equal(restored.fields.length, 7);
  assert.equal(restored.declarationState, 'merged_unruled');
  assert.equal(restored.identifier, 'production_batch_id');
  // 逐项对照：字段与出处都要回来，不能只回来一个名字。
  assert.deepEqual(restored.declarations.map((item) => item.declarationKey), [
    'MES.ProductionBatch@proposal_object', 'MES.ProductionBatch@source_system_declaration'
  ]);
});

test('声明用例 10：分组必须是严格划分——单组 / 重复 / 部分覆盖 / 全部排除 / 留名 / 同名一律拒绝', async () => {
  const task = await fixture();
  const keys = ['MES.ProductionBatch@proposal_object', 'MES.ProductionBatch@source_system_declaration'];
  const cases = [
    ['只给一组等同于「同一个对象」', [{ key: PRODUCTION_BATCH_KEY, ruling: 'distinct', groups: [{ name: 'A', declarations: keys }] }], 'SEMANTIC_DECLARATION_RULING_GROUPS_INVALID'],
    ['重复声明', [{ key: PRODUCTION_BATCH_KEY, ruling: 'distinct', groups: [{ name: 'A', declarations: keys }, { name: 'B', declarations: [keys[1]] }] }], 'SEMANTIC_DECLARATION_RULING_GROUPS_INVALID'],
    ['部分覆盖（拆分项自己的声明未覆盖）', [{ key: PRODUCTION_BATCH_KEY, ruling: 'distinct', groups: [{ name: 'A', declarations: [keys[0]] }, { name: 'B', declarations: ['MES.Deviation@proposal_object'] }] }], 'SEMANTIC_DECLARATION_RULING_GROUPS_INVALID'],
    ['全部排除', [{ key: PRODUCTION_BATCH_KEY, ruling: 'distinct', groups: [{ drop: true, declarations: [keys[0]] }, { drop: true, declarations: [keys[1]] }] }], 'SEMANTIC_DECLARATION_RULING_GROUPS_INVALID'],
    ['保留组缺对象名', [{ key: PRODUCTION_BATCH_KEY, ruling: 'distinct', groups: [{ declarations: [keys[0]] }, { name: 'B', declarations: [keys[1]] }] }], 'SEMANTIC_DECLARATION_RULING_GROUPS_INVALID'],
    ['保留组同名', [{ key: PRODUCTION_BATCH_KEY, ruling: 'distinct', groups: [{ name: 'Same', declarations: [keys[0]] }, { name: 'Same', declarations: [keys[1]] }] }], 'SEMANTIC_DECLARATION_RULING_GROUPS_INVALID'],
    ['非法动作', [{ key: 'object:Inventory', ruling: 'same_object' }], 'SEMANTIC_DECLARATION_RULING_INVALID'],
    ['非数组', { key: 'object:Inventory', ruling: 'merge' }, 'SEMANTIC_DECLARATION_RULING_INVALID']
  ];
  for (const [label, payload, code] of cases) {
    const revised = await reviseRulings(task, payload);
    assert.equal(revised.code, code, `${label}：应被拒绝`);
    assert.ok(revised.error, `${label}：必须给出可读原因`);
  }
  // 明确不存在的分歧项 → 硬错误（界面拿的是一份过期结论）。
  const unknown = await reviseRulings(task, [{ key: 'source:Ghost@nowhere.nothing', ruling: 'merge' }]);
  assert.equal(unknown.code, 'SEMANTIC_DECLARATION_RULING_UNKNOWN_CONFLICT');
});

test('声明用例 11：组名不得与该系统里已有对象同名——那正是本裁定要消除的问题', async () => {
  const task = await fixture();
  // Deviation 已由 MES 的配置映射声明；把拆出来的组叫这个名字会把两个不同对象合成一个。
  const revised = await reviseRulings(task, [{
    key: PRODUCTION_BATCH_KEY, ruling: 'distinct',
    groups: [
      { name: 'ProductionBatch', declarations: ['MES.ProductionBatch@proposal_object'] },
      { name: 'Deviation', declarations: ['MES.ProductionBatch@source_system_declaration'] }
    ]
  }]);
  assert.equal(revised.code, 'SEMANTIC_DECLARATION_RULING_NAME_TAKEN');
  // 沿用原对象名是允许的：一组保留原名、另一组另起名字，这是最常见的拆分写法。
  const ok = await reviseRulings(task, productionBatchSplit(['ProductionBatch', 'MesBatch']));
  assert.ok(!ok.error, JSON.stringify(ok));
});

test('声明用例 12：纯函数口径的全量语义——省略＝不调整、空数组＝撤销、继承失效单独分流', () => {
  const items = [
    { key: 'object:Inventory', objectId: 'Inventory', declarations: [{ declarationKey: 'ERP.Inventory@source_system_declaration', system: 'ERP' }, { declarationKey: 'WMS.Inventory@proposal_object', system: 'WMS' }] },
    { key: PRODUCTION_BATCH_KEY, objectId: 'ProductionBatch', declarations: [{ declarationKey: 'MES.ProductionBatch@proposal_object', system: 'MES' }, { declarationKey: 'MES.ProductionBatch@source_system_declaration', system: 'MES' }] }
  ];
  const inherited = [
    { key: 'object:Inventory', ruling: 'merge', groups: null },
    { key: 'source:Gone@nowhere.nothing', ruling: 'merge', groups: null }
  ];
  // 省略 ≠ 清空：省略表示本次不调整，继承的裁定原样保留；失去对应分歧的进 `unknown`（由调用方记 droppedStale）。
  const kept = resolveDeclarationRulings({ items, inherited, requested: undefined });
  assert.deepEqual(kept.entries, [{ key: 'object:Inventory', ruling: 'merge', groups: null, explicit: false }]);
  assert.deepEqual(kept.unknown, [{ key: 'source:Gone@nowhere.nothing', ruling: 'merge', groups: null, explicit: false }]);
  // 空数组才是撤销全部。
  assert.deepEqual(resolveDeclarationRulings({ items, inherited, requested: [] }).entries, []);
  // 同一个分歧项在一次提交里只能一条。
  assert.equal(resolveDeclarationRulings({ items, inherited: [], requested: [{ key: 'object:Inventory', ruling: 'merge' }, { key: 'object:Inventory', ruling: 'merge' }] }).code, 'SEMANTIC_DECLARATION_RULING_INVALID');
  // 只写 key 字符串等价于「确认是同一个对象」。
  assert.deepEqual(resolveDeclarationRulings({ items, inherited: [], requested: ['object:Inventory'] }).entries, [{ key: 'object:Inventory', ruling: 'merge', groups: null, explicit: true }]);
  // 组名撞名由调用方传入的既有对象名集合判定（纯函数不自己猜「有哪些对象」）。
  const names = new Map([['MES', new Set(['ProductionBatch', 'Deviation'])]]);
  const taken = resolveDeclarationRulings({
    items, inherited: [], catalogNames: names, requested: [{
      key: PRODUCTION_BATCH_KEY, ruling: 'distinct',
      groups: [{ name: 'ProductionBatch', declarations: ['MES.ProductionBatch@proposal_object'] }, { name: 'Deviation', declarations: ['MES.ProductionBatch@source_system_declaration'] }]
    }]
  });
  assert.equal(taken.code, 'SEMANTIC_DECLARATION_RULING_NAME_TAKEN');
});

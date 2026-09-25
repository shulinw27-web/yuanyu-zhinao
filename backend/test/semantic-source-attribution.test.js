import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { getRole } from '../src/services/authorization-service.js';
import { validateNaturalSchema } from '../src/services/semantic-natural-schema-service.js';
import { createSemanticOperationsProposal, updateSemanticOperationsProposal } from '../src/services/semantic-operations-agent-service.js';
import { detectDeclaredSystemCodes, detectSystemCodesInText } from '../src/services/system-registry-service.js';

// 阶段 4c 第二段（ADR-017）：材料归属由模型取证、服务端判定。
//
// 这一段的起点是本机实测出的一个具体断裂：材料里逐字写着「ERP 采购订单表 purchase_order」
// 「WMS 收货表 inbound_receipt」，模型输出的表名/字段/主键/外键证据全部通过逐字校验，
// 但抽取出的对象一律 `sourceSystems: ['UNASSIGNED']`——于是
//   1) 4a 的字段目录显式跳过 UNASSIGNED，**跨系统标识对应恒为 0 条**；
//   2) Critic「受控来源系统」失败，草稿**无法采纳**。
// 卡住链路的信息就在材料里，只是从来没被要求给出。
//
// 六条刻意守卫的性质：
//   1) **归属判定只用系统码与系统名**，不用业务词别名——别名表含「采购」「库存」这类通用词，
//      用于归属会把「采购订单表」这种普通表述判成 ERP 所有权（用例 4 是这条的守卫）；
//   2) **模型不能给系统码**，只能给逐字的归属原文，判定由服务端做（契约里没有系统码字段）；
//   3) 判定结果一律是**候选**：不写 `sourceSystems`、不参与范围裁剪（用例 5）；
//   4) 候选**可以**进 4a 字段目录，否则跨系统连接永远建不起来（用例 6）；
//   5) 候选转事实**必须人工确认并留下依据**（用例 7、8）；
//   6) 确认一旦成为事实，才**有资格决定对象去留**——这时才按范围裁剪（用例 9、11）。
//
// 全部为**注入模型输出**的确定性断言：本文件不调用真实模型。真实模型在这份契约下是否稳定
// 给出逐字归属原文，尚未测量（ADR-017 明列的边界）。

const identity = { tenantId: 'source-attribution-test', subjectId: 'attribution-reviewer', deviceId: 'attribution-device' };
const role = getRole('executive');
const allSystems = ['ERP', 'WMS', 'LIMS', 'QMS', 'MES', 'OMS'];
const draftState = ['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_operations_agent_tasks', 'oa_meta_model_runtime'];

const MATERIAL = [
  '一、ERP 采购订单表 purchase_order',
  '表名：purchase_order',
  '主键：po_id，采购订单的唯一编号。',
  '字段：po_id（采购订单号）、supplier_id（供应商编号）、total_amount（金额）。',
  '',
  '二、WMS 收货表 inbound_receipt',
  '表名：inbound_receipt',
  '主键：receipt_id，收货单的唯一编号。',
  '字段：receipt_id（收货单号）、po_id（对应的采购订单号）、received_qty（收货数量）。',
  '外键：po_id 引用 purchase_order，一张收货单对应一张采购订单。'
].join('\n');

const MODEL_OUTPUT = {
  tables: [
    {
      name: 'purchase_order', label: '采购订单', evidence: 'ERP 采购订单表 purchase_order', key: 'po_id',
      keyEvidence: '主键：po_id，采购订单的唯一编号。', systemEvidence: 'ERP 采购订单表 purchase_order',
      fields: [
        { name: 'po_id', evidence: '字段：po_id（采购订单号）' },
        { name: 'supplier_id', evidence: 'supplier_id（供应商编号）' },
        { name: 'total_amount', evidence: 'total_amount（金额）' }
      ]
    },
    {
      name: 'inbound_receipt', label: '收货单', evidence: 'WMS 收货表 inbound_receipt', key: 'receipt_id',
      keyEvidence: '主键：receipt_id，收货单的唯一编号。', systemEvidence: 'WMS 收货表 inbound_receipt',
      fields: [
        { name: 'receipt_id', evidence: '字段：receipt_id（收货单号）' },
        { name: 'po_id', evidence: 'po_id（对应的采购订单号）', reference: 'purchase_order', referenceEvidence: '外键：po_id 引用 purchase_order' },
        { name: 'received_qty', evidence: 'received_qty（收货数量）' }
      ]
    }
  ]
};

const modelTables = (overrides = {}) => structuredClone(MODEL_OUTPUT).tables.map((table) => ({ ...table, ...(overrides[table.name] || {}) }));
const failedChecks = (proposal) => (proposal.critic?.checks || []).filter((check) => check.status === 'failed').map((check) => check.name);

const newProposal = async (tables = modelTables()) => {
  resetRuntimeState(draftState);
  return createSemanticOperationsProposal({
    input: '按材料建立采购订单与收货单的语义模型。', multimodalContent: null, attachments: [],
    schemaDiscovery: validateNaturalSchema({ tables }, MATERIAL, []), identityScope: identity,
    requirements: '', sampleRefs: [], roleId: role.id, adoptionMode: 'merge', scopeSystems: allSystems
  });
};

const reviseProposal = (proposal, extra) => updateSemanticOperationsProposal({
  proposalId: proposal.id, revision: proposal.revision, objectTypes: proposal.objectTypes,
  relationshipTypes: proposal.relationshipTypes, role, identityScope: identity, ...extra
});

test('归属用例 1：契约向后兼容——不给归属原文时行为与改造前完全一致', () => {
  const diagnostics = [];
  const bare = validateNaturalSchema({ tables: modelTables().map((table) => { const copy = { ...table }; delete copy.systemEvidence; return copy; }) }, MATERIAL, diagnostics);
  assert.deepEqual(diagnostics, []);
  // 没有归属原文 → 没有候选、没有归属报告，来源仍是 UNASSIGNED（原有语义一字未改）。
  assert.deepEqual(bare.attribution, { attributed: [], ambiguous: [], unattributed: [] });
  for (const object of bare.objectTypes) {
    assert.deepEqual(object.sourceSystems, ['UNASSIGNED']);
    assert.deepEqual(object.candidateSourceSystems, []);
    assert.equal(object.candidateSourceBasis, null);
  }
});

test('归属用例 2：归属原文必须逐字来自材料，编造与表名编造同等严重', () => {
  const forged = validateNaturalSchema({ tables: modelTables({ purchase_order: { systemEvidence: 'ERP 采购订单表（凭字段名推测）' } }) }, MATERIAL, []);
  assert.equal(forged, null);
  // 空字符串与 null 都表示「材料没有指名道姓地写」，是合法的——只有**给了但编造**才拒绝。
  for (const value of ['', null, undefined]) {
    const crafted = validateNaturalSchema({ tables: modelTables({ purchase_order: { systemEvidence: value } }) }, MATERIAL, []);
    assert.ok(crafted, `systemEvidence=${JSON.stringify(value)} 不应导致拒绝`);
    assert.deepEqual(crafted.objectTypes[0].candidateSourceSystems, []);
  }
});

test('归属用例 3：恰好一个系统→候选；多个→歧义；识别不到→未归属（都不猜）', () => {
  // 恰好一个（两份材料都带各自的系统名）。
  const attributed = validateNaturalSchema({ tables: modelTables() }, MATERIAL, []);
  assert.deepEqual(attributed.attribution.attributed, [
    { objectId: 'purchase_order', system: 'ERP', evidence: 'ERP 采购订单表 purchase_order' },
    { objectId: 'inbound_receipt', system: 'WMS', evidence: 'WMS 收货表 inbound_receipt' }
  ]);
  assert.deepEqual(attributed.attribution.ambiguous, []);
  assert.deepEqual(attributed.attribution.unattributed, []);

  // 多个系统出现在同一句归属原文里 → 不产出候选，报歧义（选哪个需要域知识，服务端不做）。
  const ambiguousMaterial = `${MATERIAL}\n三、ERP 与 WMS 之间的收货表 inbound_receipt`;
  const ambiguous = validateNaturalSchema({ tables: modelTables({ inbound_receipt: { systemEvidence: 'ERP 与 WMS 之间的收货表 inbound_receipt' } }) }, ambiguousMaterial, []);
  assert.deepEqual(ambiguous.attribution.ambiguous, [{ objectId: 'inbound_receipt', systems: ['ERP', 'WMS'], evidence: 'ERP 与 WMS 之间的收货表 inbound_receipt' }]);
  assert.deepEqual(ambiguous.objectTypes[1].candidateSourceSystems, []);

  // 一句都不指向系统 → 未归属（不挑一个最近的系统）。
  const looseMaterial = `${MATERIAL}\n三、由运维同事维护的收货表 inbound_receipt`;
  const loose = validateNaturalSchema({ tables: modelTables({ inbound_receipt: { systemEvidence: '由运维同事维护的收货表 inbound_receipt' } }) }, looseMaterial, []);
  assert.deepEqual(loose.attribution.unattributed, [{ objectId: 'inbound_receipt', evidence: '由运维同事维护的收货表 inbound_receipt' }]);
  assert.deepEqual(loose.objectTypes[1].candidateSourceSystems, []);
  assert.equal(loose.objectTypes[1].candidateSourceEvidence, '由运维同事维护的收货表 inbound_receipt');
});

test('归属用例 4：归属判定不认业务词别名（“采购订单表”不得被判成 ERP）', () => {
  // 这条守卫的是「复用 detectSystemCodesInText 会很方便、但会把普通业务表述判成系统所有权」。
  // 别名表里 ERP 的别名包含「采购」「供应商」「库存」，用于「这段文本提到了什么系统」尚可容忍。
  assert.deepEqual(detectDeclaredSystemCodes('采购订单表 purchase_order'), []);
  assert.deepEqual(detectDeclaredSystemCodes('库存台账 stock_ledger'), []);
  assert.deepEqual(detectDeclaredSystemCodes('审批流程 approval_flow'), []);
  // 对照：用途不同的那个函数确实会命中——所以两者不能混用。
  assert.deepEqual(detectSystemCodesInText('采购订单表 purchase_order'), ['ERP']);
  // 指名道姓才认：系统码本身，或系统全名。
  assert.deepEqual(detectDeclaredSystemCodes('ERP 采购订单表 purchase_order'), ['ERP']);
  assert.deepEqual(detectDeclaredSystemCodes('ERP 供应链与库存系统'), ['ERP']);
});

test('归属用例 5：候选不写来源系统、更不参与范围裁剪', async () => {
  const proposal = await newProposal();
  assert.deepEqual(proposal.objectTypes.map((item) => item.sourceSystems), [['UNASSIGNED'], ['UNASSIGNED']]);
  assert.deepEqual(proposal.objectTypes.map((item) => item.candidateSourceSystems), [['ERP'], ['WMS']]);
  assert.deepEqual(proposal.objectTypes.map((item) => item.candidateSourceBasis), ['material_owner_evidence', 'material_owner_evidence']);
  // 候选指向范围内 → 明确列出「它落在范围内，但归属还没人确认」。
  assert.deepEqual(proposal.scopeExclusions.candidateScopeObjects.inScope.map((item) => `${item.objectId}→${item.system}`), ['purchase_order→ERP', 'inbound_receipt→WMS']);
  assert.deepEqual(proposal.scopeExclusions.candidateScopeObjects.outOfScope, []);
  // 关键：候选**没有**让对象进入 excludedObjects（未确认的归属不能决定去留）。
  assert.deepEqual(proposal.scopeExclusions.excludedObjects, []);
  assert.match(proposal.reviewNotes.join('\n'), /2 个对象的来源归属由材料原文推断（purchase_order→ERP、inbound_receipt→WMS）/);
});

test('归属用例 6：候选归属进 4a 字段目录——跨系统对应从 0 条变为可建立', async () => {
  const proposal = await newProposal();
  const linking = proposal.identityLinking;
  // 候选进目录：两个对象分别落到 ERP / WMS 分组。
  const erp = linking.fieldCatalog.find((entry) => entry.code === 'ERP');
  const wms = linking.fieldCatalog.find((entry) => entry.code === 'WMS');
  assert.equal(erp.objects.find((item) => item.objectId === 'purchase_order').sourceBasis, 'material_owner_candidate');
  assert.equal(wms.objects.find((item) => item.objectId === 'inbound_receipt').sourceBasis, 'material_owner_candidate');
  assert.deepEqual(erp.objects.find((item) => item.objectId === 'purchase_order').groundings, ['material_owner_candidate']);
  // 方案原文举的例子在材料路径上第一次成立。
  const link = linking.links.find((item) => item.evidence === 'WMS.inbound_receipt.po_id → ERP.purchase_order.po_id');
  assert.ok(link, '材料里的跨系统引用必须产出一条标识对应');
  assert.equal(link.status, 'linkable');
  assert.equal(link.sourceInferred, true);
  assert.equal(link.from.sourceBasis, 'material_owner_candidate');
  assert.equal(link.to.sourceBasis, 'material_owner_candidate');
  assert.equal(linking.summary.inferredSourceObjects, 2);
  assert.equal(linking.summary.inferredSourceLinks, 2);
  // 候选链接仍然不进草稿关系——4b 的确认关口一步都没少。
  assert.equal(proposal.relationshipTypes.some((item) => item.predicate.includes('po_id') && item.derivedFrom), false);
  // 抽取路径的既有断点仍在：字段映射待复核，所以 Critic 依然不通过（这是设计，不是缺陷）。
  assert.deepEqual(failedChecks(proposal), ['受控来源系统', '字段来源映射']);
});

test('归属用例 7：归属确认写入事实，受控来源检查随之通过', async () => {
  const proposal = await newProposal();
  const confirmed = reviseProposal(proposal, { sourceAssignments: [
    { objectId: 'purchase_order', system: 'ERP', evidence: 'ERP 采购订单表 purchase_order' },
    { objectId: 'inbound_receipt', system: 'WMS', evidence: 'WMS 收货表 inbound_receipt' }
  ] });
  assert.ok(!confirmed.error, JSON.stringify(confirmed));
  assert.deepEqual(confirmed.objectTypes.map((item) => `${item.id}:${item.sourceSystems.join('/')}`), ['purchase_order:ERP', 'inbound_receipt:WMS']);
  assert.deepEqual(confirmed.sourceAssignments, [
    { objectId: 'purchase_order', system: 'ERP', evidence: 'ERP 采购订单表 purchase_order' },
    { objectId: 'inbound_receipt', system: 'WMS', evidence: 'WMS 收货表 inbound_receipt' }
  ]);
  // 归属落定后，候选不再上报（候选只在「没有已确认来源」时存在）。
  assert.deepEqual(confirmed.scopeExclusions.candidateScopeObjects, { inScope: [], outOfScope: [] });
  assert.equal(confirmed.objectTypes.every((item) => item.candidateSourceSystems.length === 0), true);
  // 来源变了，链接的依据跟着变：不再是「材料推断」，而是已确认来源。
  const link = confirmed.identityLinking.links.find((item) => item.evidence === 'WMS.inbound_receipt.po_id → ERP.purchase_order.po_id');
  assert.equal(link.sourceInferred, false);
  assert.equal(link.from.sourceBasis, 'confirmed');
  assert.equal(confirmed.identityLinking.summary.inferredSourceObjects, 0);
  // 「受控来源系统」从失败项里消失——这是本轮要闭合的那个断点。
  assert.deepEqual(failedChecks(confirmed), ['字段来源映射']);
});

test('归属用例 7b：任务层逐项说明归属确认结果（改事实的动作必须先说）', async () => {
  const { createSemanticOperationsTask, reviseSemanticOperationsTaskProposal } = await import('../src/services/semantic-operations-task-service.js');
  resetRuntimeState([...draftState, 'semantic_system_scope']);
  // 走任务链路时，抽取结果来自材料路径（本测试用系统声明路径的等价入口：显式给出范围 + 材料文本）。
  const task = await createSemanticOperationsTask({ body: { text: '按材料建立采购订单与收货单的语义模型。', systemCodes: allSystems, sourceMaterial: MATERIAL }, role, identityScope: identity });
  assert.ok(!task.error, JSON.stringify(task));
  // 这条链路的候选对象由材料/受控词汇表决定，不假设具体编码，取第一个对象。
  const target = task.proposal.objectTypes[0].id;
  const targetSystem = task.proposal.objectTypes[0].sourceSystems[0] === 'LIMS' ? 'SRM' : 'LIMS';
  const revised = reviseSemanticOperationsTaskProposal({ taskId: task.id, body: { revision: task.proposal.revision, relationshipTypes: task.proposal.relationshipTypes, sourceAssignments: [
    { objectId: target, system: targetSystem, evidence: '人工改判：该对象主数据由该系统维护' }
  ] }, role, identityScope: identity });
  assert.ok(!revised.error, JSON.stringify(revised));
  assert.match(revised.response, new RegExp(`已确认 1 个对象的来源归属（${target}→${targetSystem}）`));
  assert.match(revised.response, /来源系统已按确认写入/);
});

test('归属用例 8：归属确认的四类拒绝，且一条都不落库', async () => {
  const proposal = await newProposal();
  const revise = (sourceAssignments) => reviseProposal(proposal, { sourceAssignments });
  // 依据不得为空：「人点了一下」不是依据。
  const noEvidence = revise([{ objectId: 'purchase_order', system: 'ERP', evidence: '   ' }]);
  assert.equal(noEvidence.code, 'SEMANTIC_SOURCE_ASSIGNMENT_EVIDENCE_REQUIRED');
  assert.match(noEvidence.error, /必须留下依据/);
  // 目标系统必须已在系统注册表里。
  const unknownSystem = revise([{ objectId: 'purchase_order', system: 'XXERP', evidence: '材料原文' }]);
  assert.equal(unknownSystem.code, 'SEMANTIC_SOURCE_ASSIGNMENT_UNKNOWN_SYSTEM');
  // 对象必须还在提案里（界面拿的是过期结论）。
  const stale = revise([{ objectId: 'ghost_table', system: 'ERP', evidence: '材料原文' }]);
  assert.equal(stale.code, 'SEMANTIC_SOURCE_ASSIGNMENT_STALE');
  // 缺系统 / 重复提交 / 形状非法。
  assert.equal(revise([{ objectId: 'purchase_order', evidence: '材料原文' }]).code, 'SEMANTIC_SOURCE_ASSIGNMENT_INVALID');
  assert.equal(revise([{ objectId: 'purchase_order', system: 'ERP', evidence: 'a' }, { objectId: 'purchase_order', system: 'WMS', evidence: 'b' }]).code, 'SEMANTIC_SOURCE_ASSIGNMENT_INVALID');
  assert.equal(revise('ERP').code, 'SEMANTIC_SOURCE_ASSIGNMENT_INVALID');
  // 以上全部被拒，且来源系统一个字都没改。
  const after = reviseProposal(proposal, {});
  assert.ok(!after.error, JSON.stringify(after));
  assert.deepEqual(after.objectTypes.map((item) => item.sourceSystems), [['UNASSIGNED'], ['UNASSIGNED']]);
  assert.deepEqual(after.sourceAssignments, []);
});

test('归属用例 9：确认到范围外的系统，对象才被裁掉（未确认前不裁）', async () => {
  const proposal = await newProposal();
  // SRM 已登记但不在本次所选范围内。
  const confirmed = reviseProposal(proposal, { sourceAssignments: [{ objectId: 'purchase_order', system: 'SRM', evidence: '人工改判：该表由 SRM 维护' }] });
  assert.ok(!confirmed.error, JSON.stringify(confirmed));
  assert.deepEqual(confirmed.scopeExclusions.excludedObjects, [{ objectId: 'purchase_order', label: '采购订单', sourceSystems: ['SRM'] }]);
  // 关系随端点一并排除，并给出可归因的原因。
  assert.deepEqual(confirmed.scopeExclusions.excludedRelationships.map((item) => `${item.from}->${item.to}`), ['inbound_receipt->purchase_order']);
  assert.match(confirmed.scopeExclusions.excludedRelationships[0].reason, /因来源系统不在本次所选范围内被排除/);
  assert.deepEqual(confirmed.objectTypes.map((item) => item.id), ['inbound_receipt']);
  // 撤销后对象回来（这是「候选不参与裁剪」的对照：同一个对象，候选状态不裁、确认后才裁）。
  const revoked = reviseProposal(confirmed, { sourceAssignments: [] });
  assert.ok(!revoked.error, JSON.stringify(revoked));
  assert.deepEqual(revoked.sourceAssignments, []);
  assert.deepEqual(revoked.objectTypes.map((item) => `${item.id}:${item.sourceSystems.join('/')}`), ['purchase_order:UNASSIGNED', 'inbound_receipt:UNASSIGNED']);
  assert.deepEqual(revoked.scopeExclusions.excludedObjects, []);
  // 撤销后候选重新可见——回到「材料说它属于 ERP/WMS，但还没人确认」的状态。
  assert.deepEqual(revoked.scopeExclusions.candidateScopeObjects.inScope.map((item) => `${item.objectId}→${item.system}`), ['purchase_order→ERP', 'inbound_receipt→WMS']);
});

test('归属用例 10：全量语义——省略不调整、空数组撤销、部分提交则未提及项回退', async () => {
  const proposal = await newProposal();
  const confirmed = reviseProposal(proposal, { sourceAssignments: [
    { objectId: 'purchase_order', system: 'ERP', evidence: '材料原文 A' },
    { objectId: 'inbound_receipt', system: 'WMS', evidence: '材料原文 B' }
  ] });
  assert.ok(!confirmed.error, JSON.stringify(confirmed));
  // 省略＝不调整：任何普通字段修订都不得顺手撤销归属确认。
  const omitted = reviseProposal(confirmed, {});
  assert.ok(!omitted.error, JSON.stringify(omitted));
  assert.equal(omitted.sourceAssignments.length, 2);
  assert.deepEqual(omitted.objectTypes.map((item) => item.sourceSystems), [['ERP'], ['WMS']]);
  // 部分提交是全量语义的一部分：未提及项回退到创建时的来源，而不是被静默保留。
  const partial = reviseProposal(omitted, { sourceAssignments: [{ objectId: 'purchase_order', system: 'ERP', evidence: '材料原文 A' }] });
  assert.ok(!partial.error, JSON.stringify(partial));
  assert.deepEqual(partial.sourceAssignments.map((item) => item.objectId), ['purchase_order']);
  assert.deepEqual(partial.objectTypes.map((item) => `${item.id}:${item.sourceSystems.join('/')}`), ['purchase_order:ERP', 'inbound_receipt:UNASSIGNED']);
  // 空数组＝撤销全部。
  const cleared = reviseProposal(partial, { sourceAssignments: [] });
  assert.ok(!cleared.error, JSON.stringify(cleared));
  assert.deepEqual(cleared.sourceAssignments, []);
  assert.deepEqual(cleared.objectTypes.map((item) => item.sourceSystems), [['UNASSIGNED'], ['UNASSIGNED']]);
});

test('归属用例 11：确认后全部对象落到范围外时拒绝保存，而不是交出一份空提案', async () => {
  const proposal = await newProposal();
  const all = reviseProposal(proposal, { sourceAssignments: [
    { objectId: 'purchase_order', system: 'SRM', evidence: '人工改判' },
    { objectId: 'inbound_receipt', system: 'SRM', evidence: '人工改判' }
  ] });
  assert.equal(all.code, 'SEMANTIC_PROPOSAL_SCOPE_EXCLUDED_ALL');
  assert.match(all.error, /全部候选对象都落到本次所选范围之外/);
  assert.match(all.error, /未保存本次归属确认/);
  // 被拒绝后提案仍是原样（一条归属都没写进去）。
  const after = reviseProposal(proposal, {});
  assert.ok(!after.error, JSON.stringify(after));
  assert.deepEqual(after.sourceAssignments, []);
  assert.deepEqual(after.objectTypes.map((item) => item.sourceSystems), [['UNASSIGNED'], ['UNASSIGNED']]);
});

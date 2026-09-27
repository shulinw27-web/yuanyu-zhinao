// 受控对象链接（阶段 4h / ADR-025）的确定性用例。
//
// 全部用例**不调用模型**：跳过判定、逐字校验、结构合成都是纯函数（与 ADR-021 决策 4
// 同一条理由——环境相关判定若内联在异步编排里，一半分支永远测不到）。
// 集成用例把「真实 provider 已完成链接」的结果按契约注入 `createSemanticOperationsProposal`，
// 验证候选合并、兜底抑制、覆盖披露与 Critic 行为；mock 端到端行为与 4g 之前完全一致
// （链接在 mock 下跳过、候选集合不变），由 `test:semantic` 既有用例锁死。

import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { createSemanticOperationsProposal } from '../src/services/semantic-operations-agent-service.js';
import { buildMentionLinkCandidates, mentionLinkSkipReason, MENTION_LINK_SKIP_REASONS, registeredWorldObjectIndex, validateMentionLinks } from '../src/services/semantic-object-mention-service.js';

const identity = { tenantId: 'semantic-mention-test', subjectId: 'architect-01', deviceId: 'device-01' };

test('skip reasons are distinguishable and pure: mock, explicit empty scope, and runnable', () => {
  assert.equal(mentionLinkSkipReason({ mode: 'mock', systems: ['WMS'] }), 'mock_runtime');
  assert.equal(mentionLinkSkipReason({ mode: 'workbuddy', systems: [] }), 'no_scope');
  assert.equal(mentionLinkSkipReason({ mode: 'workbuddy', systems: ['WMS'] }), null);
  assert.equal(mentionLinkSkipReason({ mode: 'workbuddy', systems: null }), null);
  assert.ok(MENTION_LINK_SKIP_REASONS.mock_runtime.length > 10);
  assert.ok(MENTION_LINK_SKIP_REASONS.no_scope.length > 10);
});

test('registered world object index maps each type to exactly one system and respects explicit scope', () => {
  const all = registeredWorldObjectIndex(null);
  assert.equal(all.get('OutboundShipment')?.system, 'WMS');
  assert.equal(all.get('InboundReceipt')?.system, 'WMS');
  assert.equal(all.get('Order')?.system, 'OMS');
  assert.equal(all.get('CAPA')?.system, 'QMS');
  const wms = registeredWorldObjectIndex(['WMS']);
  assert.deepEqual([...wms.keys()].sort(), ['InboundReceipt', 'InventoryLot', 'OutboundShipment', 'Warehouse']);
  // 显式空范围 = 显式为空：池必须为空，不得放宽到全部系统（ADR-012）。
  assert.equal(registeredWorldObjectIndex([]).size, 0);
});

test('mention links are accepted only when evidence is verbatim, contains the mention, and the type is registered', () => {
  const material = '仓库系统的发运单记录了出库过程，供应商月度对账单同步归档。';
  const typeIndex = registeredWorldObjectIndex(null);
  const diagnostics = [];
  const valid = validateMentionLinks({
    mentions: [
      { mention: '发运单', evidence: '发运单记录了出库过程', objectType: 'OutboundShipment' },
      { mention: '供应商', evidence: '供应商月度对账单', objectType: 'Supplier' }
    ]
  }, material, typeIndex, diagnostics);
  assert.ok(valid, diagnostics.join(','));
  assert.equal(valid.links.length, 2);
  assert.equal(valid.links[0].system, 'WMS');
  assert.equal(valid.links[1].system, 'ERP');
  assert.equal(valid.truncated, false);
  assert.equal(valid.mergedDuplicates, 0);

  // 编造证据：整份拒绝，不做局部挽救。
  const fabricated = validateMentionLinks({
    mentions: [{ mention: '发运单', evidence: '材料里根本没有这句话', objectType: 'OutboundShipment' }]
  }, material, typeIndex, diagnostics);
  assert.equal(fabricated, null);
  assert.equal(diagnostics.at(-1), 'MENTION_EVIDENCE_INVALID');

  // 证据不包含提称：同样整份拒绝。
  const detached = validateMentionLinks({
    mentions: [{ mention: '出库单', evidence: '发运单记录了出库过程', objectType: 'OutboundShipment' }]
  }, material, typeIndex, diagnostics);
  assert.equal(detached, null);
  assert.equal(diagnostics.at(-1), 'MENTION_EVIDENCE_INVALID');

  // 名单外的类型：模型不能发明对象类型。
  const invented = validateMentionLinks({
    mentions: [{ mention: '发运单', evidence: '发运单记录了出库过程', objectType: 'ShipmentNote' }]
  }, material, typeIndex, diagnostics);
  assert.equal(invented, null);
  assert.equal(diagnostics.at(-1), 'MENTION_TYPE_UNKNOWN');

  // 同一类型的多条提及合并为一条，合并数必须披露。
  const duplicated = validateMentionLinks({
    mentions: [
      { mention: '发运单', evidence: '发运单记录了出库过程', objectType: 'OutboundShipment' },
      { mention: '发运单', evidence: '发运单记录了出库过程', objectType: 'OutboundShipment' }
    ]
  }, material, typeIndex, diagnostics);
  assert.ok(duplicated, diagnostics.join(','));
  assert.equal(duplicated.links.length, 1);
  assert.equal(duplicated.mergedDuplicates, 1);

  // 非数组：结构无效。
  assert.equal(validateMentionLinks({ mentions: '发运单' }, material, typeIndex, diagnostics), null);
  assert.equal(diagnostics.at(-1), 'MENTIONS_INVALID');
});

test('linked types become candidates only with declaration-backed structure; structureless links stay named gaps', () => {
  const { candidates, gaps } = buildMentionLinkCandidates({
    links: [
      { mention: '收货单', evidence: '收货单登记来料批次', objectType: 'InboundReceipt', system: 'WMS', systemName: '仓储管理系统' },
      { mention: '发运单', evidence: '发运单记录了出库过程', objectType: 'OutboundShipment', system: 'WMS', systemName: '仓储管理系统' },
      { mention: '订单', evidence: '订单状态由承运方回传', objectType: 'Order', system: 'OMS', systemName: '订单管理系统' }
    ]
  });
  // 收货单 → InboundReceipt：声明里有 receipt_id（自身概念判定），结构完整。
  const receipt = candidates.find((item) => item.id === 'InboundReceipt');
  assert.ok(receipt);
  assert.equal(receipt.key, 'receipt_id');
  assert.equal(receipt.sourceSystems.join('/'), 'WMS');
  assert.ok(receipt.fields.includes('received_qty'));
  assert.equal(receipt.fieldDefinitions.filter((field) => field.primaryKey).length, 1);
  assert.ok(receipt.fieldDefinitions.every((field) => field.mappingStatus === 'pending'));
  assert.equal(receipt.coreObject, 'InboundReceipt');
  assert.match(receipt.description, /收货单/);
  assert.match(receipt.description, /未经映射确认/);
  // 订单 → Order：声明里 order_id 由对象名派生。
  const order = candidates.find((item) => item.id === 'Order');
  assert.ok(order);
  assert.equal(order.key, 'order_id');
  // 发运单 → OutboundShipment：类型已登记但系统无字段声明——必须点名，不静默。
  const gap = gaps.find((item) => item.objectType === 'OutboundShipment');
  assert.ok(gap);
  assert.equal(gap.reason, 'no_declaration');
  assert.match(gap.detail, /没有任何字段声明/);
  assert.match(gap.suggestion, /声明|字典/);
});

test('injected linking results merge into candidates, suppress catalog fallback, and disclose everything', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'oa_meta_model_runtime']);
  const material = '仓库系统的发运单记录了出库过程，收货单登记来料批次。供应商主数据保持同步。';
  const links = [
    { mention: '发运单', evidence: '发运单记录了出库过程', objectType: 'OutboundShipment', system: 'WMS', systemName: '仓储管理系统' },
    { mention: '收货单', evidence: '收货单登记来料批次', objectType: 'InboundReceipt', system: 'WMS', systemName: '仓储管理系统' }
  ];
  const { candidates, gaps } = buildMentionLinkCandidates({ links });
  const mentionLinking = { links, total: links.length, truncated: false, mergedDuplicates: 0, candidates, gaps, basis: 'model_verbatim_linking' };
  const proposal = await createSemanticOperationsProposal({ input: material, identityScope: identity, mentionLinking, scopeSystems: ['WMS'] });
  assert.ok(!proposal.error, JSON.stringify(proposal).slice(0, 300));

  // ① 候选集合：只有结构完整的链接对象；结构缺口的 OutboundShipment 不进，也不因「仓库」
  //    词面命中而回落到目录兜底——链接候选生效时兜底必须被抑制。
  assert.deepEqual(proposal.objectTypes.map((item) => item.id), ['InboundReceipt']);
  assert.equal(proposal.candidateCoverage.fallbackApplied, false);
  assert.ok(proposal.candidateCoverage.matched.some((entry) => entry.id === 'Inventory'), '词面命中信息仍应披露（只是不生效）');

  // ② 覆盖披露：每条链接带 structured 标记，结构缺口逐条点名。
  const coverage = proposal.candidateCoverage.mentionLinking;
  assert.equal(coverage.basis, 'model_verbatim_linking');
  assert.equal(coverage.skipped, null);
  assert.equal(coverage.total, 2);
  const outbound = coverage.linked.find((item) => item.objectType === 'OutboundShipment');
  const inbound = coverage.linked.find((item) => item.objectType === 'InboundReceipt');
  assert.equal(outbound.structured, false);
  assert.equal(inbound.structured, true);
  assert.equal(coverage.structureGaps.length, 1);
  assert.equal(coverage.structureGaps[0].reason, 'no_declaration');

  // ③ 审阅说明：链接候选与结构缺口都必须可读。
  const candidateNote = proposal.reviewNotes.find((note) => note.includes('受控对象链接'));
  assert.ok(candidateNote, proposal.reviewNotes.join('\n'));
  assert.match(candidateNote, /InboundReceipt ← WMS/);
  assert.match(candidateNote, /字段映射尚未确认/);
  const gapNote = proposal.reviewNotes.find((note) => note.includes('给不出候选结构'));
  assert.ok(gapNote, proposal.reviewNotes.join('\n'));
  assert.match(gapNote, /发运单→OutboundShipment（系统无字段声明）/);

  // ④ Critic 的诚实性：声明结构 ≠ 映射已确认——字段映射检查必须失败，拦住未映射就采纳。
  const mappingCheck = proposal.critic.checks.find((item) => item.name === '字段来源映射');
  assert.equal(mappingCheck.status, 'failed');
});

test('skipped linking is disclosed structurally and mock-time candidate behavior stays unchanged', async () => {
  resetRuntimeState(['semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'oa_meta_model_runtime']);
  const skippedLinking = { skipped: 'mock_runtime', reason: MENTION_LINK_SKIP_REASONS.mock_runtime, links: [], total: 0, truncated: false, mergedDuplicates: 0, candidates: [], gaps: [] };
  const proposal = await createSemanticOperationsProposal({ input: '建立供应商和原料批次的语义模型。', identityScope: identity, mentionLinking: skippedLinking });
  assert.ok(!proposal.error, JSON.stringify(proposal).slice(0, 300));
  // mock 下链接没跑：披露前提必须说清，而不是让「linked 为空」被读成「材料没有已登记对象」。
  assert.equal(proposal.candidateCoverage.mentionLinking.skipped, 'mock_runtime');
  assert.equal(proposal.candidateCoverage.mentionLinking.basis, null);
  // 候选集合与 4g 之前完全一致：目录兜底照常生效。
  assert.equal(proposal.candidateCoverage.fallbackApplied, true);
  assert.ok(proposal.objectTypes.some((item) => item.id === 'Supplier'));
});

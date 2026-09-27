// 受控对象链接（阶段 4h / ADR-025）的真实模型评测。
//
// 测什么：模型在**非列举、无字典线索**的散文材料上，能否把逐字提到的业务对象称呼
// 链接到已登记对象类型，并且——
//   ① 提称与证据逐字可核对（编造被服务端整份拒绝）；
//   ② 名单外的概念不被发明（服务端只接受已登记类型）；
//   ③ 材料里没有可对应对象时弃权（不硬凑）。
//
// 不测什么：不代表真实企业材料或生产验收；结构合成与候选合并不调用模型（确定性），
// 由 `test:mention` 在 mock 下锁死。
//
// 运行：`npm run evaluate:mention-linking`（缺省 provider workbuddy/deepseek-v4-pro，
// 可用 AGENT_RUNTIME_MODE 覆盖；每变体 3 轮 + 1 次端到端提案）。

import { performance } from 'node:perf_hooks';
import { loadArkFileConfig } from './ark-file-config.mjs';

process.env.AGENT_RUNTIME_MODE = process.env.AGENT_RUNTIME_MODE || 'workbuddy';
if (process.env.AGENT_RUNTIME_MODE === 'ark') loadArkFileConfig();

const { discoverObjectMentionLinks } = await import('../backend/src/services/semantic-object-mention-service.js');
const { getLocalModelRuntime } = await import('../backend/src/services/local-model-gateway.js');
const runtime = getLocalModelRuntime();

const rounds = Math.max(1, Number.parseInt(process.env.MENTION_ROUNDS || '3', 10));

// ---- 合成材料（散文式，刻意不含「主键 / 字段 / PK」这类字典线索，
//      使自然语言抽取按 ADR-021 跳过、由受控对象链接接管）----
const VARIANTS = [
  {
    id: 'A',
    title: '散文材料提到已登记对象（正例：发运单/收货单须链接，客户投诉名单外须跳过）',
    // 范围取 WMS：池只有 InboundReceipt / InventoryLot / OutboundShipment / Warehouse 四类，
    // 「客户投诉」在池内没有对应类型——模型必须跳过它，而不是猜一个名字。
    systems: ['WMS'],
    material: `仓库日常运营说明（合成材料）

收货单登记来料入库，系统会记录收货数量与收货时间，并保留对方签收信息。
发运单跟踪出库过程，发货之后由承运方回传运输状态。
客户投诉会转给质量部门处理，一个月内需要关闭。`,
    expectLinks: [
      { mention: '收货单', objectType: 'InboundReceipt' },
      { mention: '发运单', objectType: 'OutboundShipment' }
    ],
    forbiddenMentions: ['客户投诉']
  },
  {
    id: 'B',
    title: '散文材料没有任何已登记对象（必须弃权，不得硬凑）',
    systems: null,
    material: `人事与行政说明（合成材料）

员工考勤由打卡机按月汇总，异常工时由主管复核。
报销单走财务审批流，通过后进入付款批次。`,
    expectLinks: [],
    forbiddenMentions: []
  }
];

function judge(variant, row) {
  if (row.outcome === 'error') return { passed: false, reason: `error:${row.code || ''}` };
  if (row.outcome === 'throw') return { passed: false, reason: 'throw' };
  const linked = row.linked || [];
  const expectHit = (variant.expectLinks || []).every(({ mention, objectType }) =>
    linked.some(item => item.mention === mention && item.objectType === objectType));
  if (!expectHit) return { passed: false, reason: 'expected-link-missed' };
  const forbidden = (variant.forbiddenMentions || []).filter(mention => linked.some(item => item.mention === mention));
  if (forbidden.length) return { passed: false, reason: `forbidden-linked:${forbidden.join('/')}` };
  if ((variant.expectLinks || []).length === 0 && linked.length > 0) return { passed: false, reason: 'fabricated-links' };
  return { passed: true, reason: (variant.expectLinks || []).length ? 'linked-as-expected' : 'abstained' };
}

const rows = [];
for (const variant of VARIANTS) {
  for (let round = 1; round <= rounds; round += 1) {
    const startedAt = performance.now();
    let result;
    try {
      result = await discoverObjectMentionLinks({ material: variant.material, systems: variant.systems });
    } catch (error) {
      rows.push({ variant: variant.id, round, outcome: 'throw', error: error.message, verdict: { passed: false, reason: 'throw' } });
      continue;
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    const row = {
      variant: variant.id,
      round,
      elapsedMs,
      outcome: result.error ? 'error' : 'linked',
      code: result.error ? String(result.error).match(/（([A-Z_]+)）/)?.[1] || null : null,
      error: result.error || null,
      linked: (result.links || []).map(item => ({ mention: item.mention, objectType: item.objectType, system: item.system })),
      total: result.total || 0,
      mergedDuplicates: result.mergedDuplicates || 0,
      structureGaps: (result.gaps || []).map(item => ({ objectType: item.objectType, reason: item.reason })),
      candidateIds: (result.candidates || []).map(item => item.id)
    };
    row.verdict = judge(variant, row);
    rows.push(row);
    console.error(`[${variant.id}-${round}] ${row.outcome} linked=${row.linked.map(item => `${item.mention}→${item.objectType}`).join(',') || '-'} candidates=${row.candidateIds.join(',') || '-'} verdict=${row.verdict.reason} ${elapsedMs}ms`);
  }
}

// ---- 端到端：真实模型输出走完整提案链路（散文材料 + 显式范围 WMS）----
const e2e = [];
const e2eVariant = VARIANTS.find(item => item.id === 'A');
if (e2eVariant) {
  const { createSemanticOperationsProposalFromRequest } = await import('../backend/src/services/semantic-operations-agent-service.js');
  const { getRole } = await import('../backend/src/services/authorization-service.js');
  const role = getRole('quality_manager');
  const identityScope = { tenantId: 'object-mention-eval', subjectId: 'eval-reviewer' };
  const startedAt = performance.now();
  let proposal;
  try {
    proposal = await createSemanticOperationsProposalFromRequest({ body: { text: e2eVariant.material, sourceMaterial: e2eVariant.material }, role, identityScope, scopeSystems: ['WMS'] });
  } catch (error) {
    e2e.push({ error: error.message });
  }
  const elapsedMs = Math.round(performance.now() - startedAt);
  if (proposal && !proposal.error) {
    const coverage = proposal.candidateCoverage?.mentionLinking || null;
    e2e.push({
      elapsedMs,
      objectIds: proposal.objectTypes.map(item => item.id),
      fallbackApplied: proposal.candidateCoverage?.fallbackApplied ?? null,
      mentionLinking: coverage && {
        basis: coverage.basis,
        linked: coverage.linked,
        structureGaps: coverage.structureGaps
      },
      critic: proposal.critic?.status ?? null,
      // 检查项用 `status: 'passed'|'failed'`（不是 `passed` 布尔——见 evaluate-source-attribution 的教训）。
      criticFailures: (proposal.critic?.checks || []).filter(item => item.status !== 'passed').map(item => item.name),
      reviewNotes: (proposal.reviewNotes || []).filter(note => note.includes('受控对象链接') || note.includes('给不出候选结构'))
    });
    console.error(`[E2E A] objects=${proposal.objectTypes.map(item => item.id).join(',')} critic=${proposal.critic?.status ?? '-'} ${elapsedMs}ms`);
  } else {
    e2e.push({ elapsedMs, error: proposal?.error || 'no-proposal', code: proposal?.code || null });
  }
}

const e2eRow = e2e[0] || null;
const e2eAssertions = e2eRow ? {
  // 散文材料应经链接产出已登记对象的候选（收货单→InboundReceipt，声明里有 receipt_id）。
  a_candidateFromLink: Boolean(e2eRow.objectIds?.includes('InboundReceipt')),
  // 链接候选生效时，目录兜底必须被抑制。
  a_fallbackSuppressed: e2eRow.fallbackApplied === false,
  // 名单外的「客户投诉」不得进入候选。
  a_forbiddenAbsent: !(e2eRow.objectIds || []).some(id => id === 'QualityEvent'),
  // 结构缺口必须点名（发运单→OutboundShipment，系统无字段声明）。
  a_structureGapNamed: Boolean((e2eRow.mentionLinking?.structureGaps || []).some(item => item.objectType === 'OutboundShipment' && item.reason === 'no_declaration')),
  // 声明结构 ≠ 映射已确认：字段映射检查必须失败（诚实性，不是缺陷）。
  a_mappingStillPending: Boolean((e2eRow.criticFailures || []).includes('字段来源映射'))
} : null;

const variants = VARIANTS.map(variant => {
  const own = rows.filter(row => row.variant === variant.id);
  const passed = own.filter(row => row.verdict.passed).length;
  return {
    id: variant.id,
    title: variant.title,
    rounds: own.length,
    passed,
    stable: passed === own.length,
    reasons: [...new Set(own.map(row => row.verdict.reason))]
  };
});

const summary = {
  timestamp: new Date().toISOString(),
  syntheticOnly: true,
  runtimeMode: process.env.AGENT_RUNTIME_MODE,
  provider: runtime.provider,
  model: runtime.model,
  roundsPerVariant: rounds,
  variantRounds: rows.length,
  e2eProposalRuns: e2e.length,
  passed: rows.filter(row => row.verdict.passed).length,
  failed: rows.filter(row => !row.verdict.passed).length,
  variants,
  e2e,
  e2eAssertions,
  rows,
  boundary: '合成材料 + 真实模型调用；只测量受控对象链接的契约分布与端到端候选产出，不代表真实企业材料或生产验收。'
};

console.log(JSON.stringify(summary, null, 2));
const e2eFailed = e2eAssertions ? Object.values(e2eAssertions).filter(value => !value).length : 0;
process.exit(summary.failed === 0 && e2eFailed === 0 ? 0 : 1);

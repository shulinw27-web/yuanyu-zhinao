// 归属契约的真实模型稳定性测量（ADR-017 复审条件 4）。
//
// 范围：走 production 抽取路径 `discoverNaturalSchema`（不是另写一份提示词），对四类合成材料变体
//       各跑多轮真实模型，测量该契约在真实模型下的行为分布：
//         attributed   模型给出了逐字原文且其中恰好一个已登记系统
//         ambiguous    模型给出了逐字原文且其中出现多个系统码
//         unattributed 模型给出了逐字原文但其中识别不到系统码
//         absent       模型填了 null / 空（= 正确弃权）
//         rejected     OWNER_EVIDENCE_INVALID —— 模型给了**非逐字**的归属原文（契约失败）
// 边界：只测量抽取契约本身，不验证完整建模链路、不写库、不发企业 URL；材料为合成材料，
//       结果不代表真实企业材料或生产验收。
//
// 缺省 provider 为 workbuddy（当前唯一可用通道）；可用 AGENT_RUNTIME_MODE 覆盖。
import { loadArkFileConfig } from './ark-file-config.mjs';

process.env.NODE_ENV = 'test';
process.env.RUNTIME_STORE_DRIVER = 'memory';
process.env.SEMANTIC_GOVERNANCE_STORE_DRIVER = 'runtime';
process.env.AGENT_RUNTIME_MODE = process.env.AGENT_RUNTIME_MODE || 'workbuddy';
process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = '{}';
process.env.SEMANTICA_DEMO_BRIDGE_ENABLED = 'false';
if (process.env.AGENT_RUNTIME_MODE === 'ark') loadArkFileConfig();

const { discoverNaturalSchema } = await import('../backend/src/services/semantic-natural-schema-service.js');
const { getLocalModelRuntime } = await import('../backend/src/services/local-model-gateway.js');

const rounds = Math.max(1, Number.parseInt(process.env.ATTRIBUTION_ROUNDS || '3', 10));

// ---- 合成材料（四类变体只有「归属那一句」不同；表 / 字段 / 主键 / 外键部分保持契约干净，
//      使唯一可失败项就是归属本身——初版材料声明了未定义表的外键，被 FOREIGN_KEY_TARGET_INVALID
//      拦下，那是契约在正确工作，属材料问题，已修正）----
const VARIANTS = [
  {
    id: 'A',
    title: '材料指名道姓写出所属系统（正例）',
    material: `来料与入库对接说明（合成材料）

一、ERP 采购订单表 purchase_order
采购订单表 purchase_order 归 ERP 管理，用于记录采购主体的订单。
主键：po_id，它是采购订单表的主键。
字段：po_id、supplier_id、material_code、order_qty、order_date。
字段说明：po_id 为采购订单号，supplier_id 为供应商编码，material_code 为物料编码，order_qty 为订单数量，order_date 为下单日期。

二、WMS 收货表 inbound_receipt
收货表 inbound_receipt 归 WMS 管理，记录仓库的实际收货。
主键：receipt_id，它是收货表的主键。
字段：receipt_id、po_id、warehouse_code、received_qty、received_at。
外键：po_id 引用 purchase_order（采购订单表）。
字段说明：po_id 为采购订单号，warehouse_code 为仓库编码，received_qty 为收货数量，received_at 为收货时间。`,
    expect: 'attributed',
    expectSystems: { purchase_order: 'ERP', inbound_receipt: 'WMS' }
  },
  {
    id: 'B',
    title: '材料完全没有写所属系统（必须弃权，不得硬凑）',
    material: `来料与入库对接说明（合成材料）

一、采购订单表 purchase_order
采购订单表 purchase_order 用于记录采购主体的订单。
主键：po_id，它是采购订单表的主键。
字段：po_id、supplier_id、material_code、order_qty、order_date。
字段说明：po_id 为采购订单号，supplier_id 为供应商编码，material_code 为物料编码，order_qty 为订单数量，order_date 为下单日期。

二、收货表 inbound_receipt
收货表 inbound_receipt 记录仓库的实际收货。
主键：receipt_id，它是收货表的主键。
字段：receipt_id、po_id、warehouse_code、received_qty、received_at。
外键：po_id 引用 purchase_order（采购订单表）。
字段说明：po_id 为采购订单号，warehouse_code 为仓库编码，received_qty 为收货数量，received_at 为收货时间。`,
    expect: 'absent'
  },
  {
    id: 'C',
    title: '材料只用业务词/别名描述归属（不得据业务词推测系统）',
    // 「采购」「库存」是 detectSystemCodesInText 的别名，但不是 detectDeclaredSystemCodes 认的判据：
    // 模型若逐字引用这些句子，服务端应判为 unattributed（不产出候选），而不是判成 ERP/WMS 所有权。
    material: `来料与入库对接说明（合成材料）

一、采购业务中的采购订单表 purchase_order
采购订单表 purchase_order 属于采购业务，用于记录采购主体的订单。
主键：po_id，它是采购订单表的主键。
字段：po_id、supplier_id、material_code、order_qty、order_date。
字段说明：po_id 为采购订单号，supplier_id 为供应商编码，material_code 为物料编码，order_qty 为订单数量，order_date 为下单日期。

二、库存管理中的收货表 inbound_receipt
收货表 inbound_receipt 属于库存管理，记录仓库的实际收货。
主键：receipt_id，它是收货表的主键。
字段：receipt_id、po_id、warehouse_code、received_qty、received_at。
外键：po_id 引用 purchase_order（采购订单表）。
字段说明：po_id 为采购订单号，warehouse_code 为仓库编码，received_qty 为收货数量，received_at 为收货时间。`,
    expect: 'not-attributed'
  },
  {
    id: 'D',
    title: '归属那一句里出现两个系统（必须报歧义，不得择一）',
    material: `对账说明（合成材料）

一、库存对账表 stock_reconciliation
库存对账表 stock_reconciliation 由 ERP 与 WMS 共同维护，用于核对两边的库存差异。
主键：recon_id，它是库存对账表的主键。
字段：recon_id、po_id、warehouse_code、diff_qty。
字段说明：recon_id 为对账编号，po_id 为采购订单号，warehouse_code 为仓库编码，diff_qty 为差异数量。`,
    expect: 'ambiguous',
    expectSystems: {}
  }
];

function classify(result) {
  if (!result) return { outcome: 'null' };
  if (result.error) {
    const code = String(result.error).match(/（([A-Z_]+)/)?.[1] || null;
    return { outcome: code === 'OWNER_EVIDENCE_INVALID' ? 'rejected' : 'error', code, error: result.error };
  }
  const attribution = result.attribution || { attributed: [], ambiguous: [], unattributed: [] };
  const tableIds = (result.objectTypes || []).map(object => object.id);
  const withCandidate = (result.objectTypes || []).filter(object => Array.isArray(object.candidateSourceSystems) && object.candidateSourceSystems.length).length;
  const anyEvidence = attribution.attributed.length + attribution.ambiguous.length + attribution.unattributed.length;
  // 单表变体（A/B/C/D 的主体只有一到两张表）只取本次实际抽到的表做归一。
  return {
    outcome: anyEvidence ? 'evidence' : 'absent',
    attributed: attribution.attributed.map(item => ({ objectId: item.objectId, system: item.system })),
    ambiguous: attribution.ambiguous.map(item => ({ objectId: item.objectId, systems: item.systems })),
    unattributed: attribution.unattributed.map(item => item.objectId),
    tableIds,
    withCandidate,
    candidates: (result.objectTypes || []).map(object => ({ id: object.id, candidateSourceSystems: object.candidateSourceSystems, basis: object.candidateSourceBasis, sourceSystems: object.sourceSystems }))
  };
}

function judge(variant, row) {
  if (row.outcome === 'rejected') return { passed: false, reason: 'OWNER_EVIDENCE_INVALID' };
  // 非归属类的契约拦截（如 FOREIGN_KEY_TARGET_INVALID）不算通过，但也不是归属失败——如实分开记。
  if (row.outcome === 'error' || row.outcome === 'null' || row.outcome === 'throw') {
    return { passed: false, reason: `${row.outcome}${row.code ? `:${row.code}` : ''}` };
  }
  if (variant.expect === 'attributed') {
    const hit = Object.entries(variant.expectSystems).every(([objectId, system]) => row.attributed.some(item => item.objectId === objectId && item.system === system));
    return { passed: hit, reason: hit ? 'attributed-as-declared' : 'attribution-missed' };
  }
  if (variant.expect === 'absent') {
    const hit = row.outcome === 'absent';
    return { passed: hit, reason: hit ? 'abstained' : 'fabricated-attribution' };
  }
  if (variant.expect === 'not-attributed') {
    // 必须**没有** attributed；报 unattributed（引用了不含系统名的原文）是允许的，那是「不认别名」的正确行为。
    const hit = row.attributed.length === 0;
    return { passed: hit, reason: hit ? 'no-business-word-attribution' : 'attribution-from-business-word' };
  }
  if (variant.expect === 'ambiguous') {
    const hit = row.ambiguous.length > 0 && row.attributed.length === 0;
    return { passed: hit, reason: hit ? 'ambiguity-reported' : 'ambiguity-not-reported' };
  }
  return { passed: false, reason: 'unknown-expectation' };
}

const runtime = getLocalModelRuntime();
const rows = [];
for (const variant of VARIANTS) {
  for (let round = 1; round <= rounds; round += 1) {
    const startedAt = performance.now();
    let classified;
    try {
      classified = classify(await discoverNaturalSchema(variant.material));
    } catch (error) {
      classified = { outcome: 'throw', error: error.message };
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    rows.push({ variant: variant.id, round, elapsedMs, ...classified, verdict: judge(variant, classified) });
    // 逐轮即时输出到 stderr，长跑时可见进度；stdout 保持为**纯 JSON**，便于直接落盘/解析。
    console.error(`[${variant.id} r${round}] ${classified.outcome} ${JSON.stringify(classified.attributed || classified.ambiguous || classified.error || '')} ${elapsedMs}ms ${rows[rows.length - 1].verdict.passed ? 'PASS' : 'FAIL'}`);
  }
}

// ---- 端到端：真实模型输出 → 提案（字段目录 / 跨系统标识对应 / 范围上报）----
// 只跑两个变体：A（材料写明归属）与 B（材料未写归属），用来回答 ADR-017 复审条件 4 的下半句——
// 真实模型轮次下，候选归属能否真的让跨系统标识对应从 0 变为非 0，且「未写归属」时保持 0。
const e2e = [];
if (process.env.ATTRIBUTION_E2E !== 'false') {
  const { createSemanticOperationsProposalFromRequest, updateSemanticOperationsProposal } = await import('../backend/src/services/semantic-operations-agent-service.js');
  const { getRole } = await import('../backend/src/services/authorization-service.js');
  const role = getRole('quality_manager');
  const identityScope = { tenantId: 'source-attribution-eval', subjectId: 'eval-reviewer' };
  const scopeSystems = ['ERP', 'WMS'];
  for (const variantId of ['A', 'B']) {
    const variant = VARIANTS.find(item => item.id === variantId);
    let proposal;
    const startedAt = performance.now();
    try {
      proposal = await createSemanticOperationsProposalFromRequest({ body: { text: variant.material, sourceMaterial: variant.material }, role, identityScope, scopeSystems });
    } catch (error) {
      e2e.push({ variant: variantId, error: error.message });
      continue;
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (!proposal || proposal.error) {
      e2e.push({ variant: variantId, elapsedMs, error: proposal?.error || 'no-proposal', code: proposal?.code || null });
      continue;
    }
    const linking = proposal.identityLinking?.summary || null;
    e2e.push({
      variant: variantId,
      elapsedMs,
      objectIds: proposal.objectTypes.map(item => item.id),
      fieldCatalogObjects: linking?.objects ?? null,
      crossSystemLinks: linking?.links ?? null,
      linkable: linking?.linkable ?? null,
      requiresMapping: linking?.requiresMapping ?? null,
      inferredSourceObjects: linking?.inferredSourceObjects ?? null,
      inferredSourceLinks: linking?.inferredSourceLinks ?? null,
      conflicts: linking?.conflicts ?? null,
      linkDetails: (proposal.identityLinking?.links || []).map(item => ({
        from: `${item.from.system}.${item.from.objectId}.${item.from.field}`,
        to: `${item.to.system}.${item.to.objectId}.${item.to.field}`,
        status: item.status,
        fromBasis: item.from.sourceBasis,
        toBasis: item.to.sourceBasis
      })),
      candidateInScope: proposal.scopeExclusions?.candidateScopeObjects?.inScope?.length ?? 0,
      critic: proposal.critic?.status ?? null,
      // 未通过的检查项必须逐条记下来：否则「Critic failed」会被读成「归属没起作用」。
      // ⚠️ 检查项用的是 `status: 'passed'|'failed'`，不是 `passed` 布尔——初版按 `item.passed` 过滤
      // 导致 undefined 使**全部**检查都被列为失败，误报过一次「确认归属后受控来源系统仍失败」。
      criticFailures: (proposal.critic?.checks || []).filter(item => item.status !== 'passed').map(item => `${item.name}: ${String(item.detail || '').slice(0, 160)}`),
      reviewNotes: (proposal.reviewNotes || []).slice(0, 6)
    });
    console.error(`[E2E ${variantId}] links=${linking?.links ?? '-'} inferred=${linking?.inferredSourceLinks ?? '-'} critic=${proposal.critic?.status ?? '-'} ${elapsedMs}ms`);

    // A 的第二步：按材料原文确认两处候选归属，测量「候选 → 事实」是否真的解掉「受控来源系统」检查。
    // 这一步是必要的对照：只取证不确认时，候选**不应该**解掉该检查（ADR-017 决策 2/3）。
    if (variantId === 'A') {
      const assignments = proposal.objectTypes
        .filter(item => Array.isArray(item.candidateSourceSystems) && item.candidateSourceSystems.length === 1)
        .map(item => ({ objectId: item.id, system: item.candidateSourceSystems[0], evidence: item.candidateSourceEvidence }));
      const confirmStartedAt = performance.now();
      const updated = updateSemanticOperationsProposal({ proposalId: proposal.id, revision: proposal.revision, sourceAssignments: assignments, role, identityScope });
      const confirmElapsedMs = Math.round(performance.now() - confirmStartedAt);
      e2e[e2e.length - 1].afterConfirm = updated?.error ? { error: updated.error, code: updated.code || null } : {
        elapsedMs: confirmElapsedMs,
        assignmentCount: assignments.length,
        sourceSystems: (updated.objectTypes || []).map(item => ({ id: item.id, sourceSystems: item.sourceSystems, candidateSourceSystems: item.candidateSourceSystems })),
        critic: updated.critic?.status ?? null,
        criticFailures: (updated.critic?.checks || []).filter(item => item.status !== 'passed').map(item => item.name),
        criticChecks: (updated.critic?.checks || []).map(item => ({ name: item.name, status: item.status, detail: String(item.detail || '').slice(0, 200) })),
        crossSystemLinks: updated.identityLinking?.summary?.links ?? null,
        inferredSourceObjects: updated.identityLinking?.summary?.inferredSourceObjects ?? null,
        inferredSourceLinks: updated.identityLinking?.summary?.inferredSourceLinks ?? null
      };
      console.error(`[E2E A confirm] assignments=${assignments.length} critic=${updated?.critic?.status ?? updated?.error ?? '-'} failures=${(updated?.critic?.checks || []).filter(i => i.status !== 'passed').length}`);
    }
  }
}

const e2eVariantA = e2e.find(item => item.variant === 'A');
const e2eVariantB = e2e.find(item => item.variant === 'B');
const e2eAssertions = e2e.length ? {
  // A：候选归属应让材料里的对象进字段目录，并产出跨系统标识对应（至少 1 条，且两端来自不同系统）。
  a_linksPositive: Boolean(e2eVariantA && (e2eVariantA.crossSystemLinks || 0) > 0),
  a_linkSpansTwoSystems: Boolean(e2eVariantA && (e2eVariantA.linkDetails || []).some(item => {
    const [fromSystem] = item.from.split('.');
    const [toSystem] = item.to.split('.');
    return fromSystem !== toSystem;
  })),
  // B：材料未写归属 → 无候选 → 跨系统标识对应保持 0（不得凭空产生）。
  b_linksZero: Boolean(e2eVariantB && (e2eVariantB.crossSystemLinks || 0) === 0 && (e2eVariantB.inferredSourceObjects || 0) === 0),
  // 只取证不确认：候选**不应该**解掉「受控来源系统」（否则候选就成了事实）。
  a_candidateDoesNotClearCheck: Boolean(e2eVariantA && (e2eVariantA.criticFailures || []).some(item => String(item).includes('受控来源系统'))),
  // 按材料原文确认后：写入事实、清空候选，且「受控来源系统」不再出现在失败项里。
  a_confirmClearsSourceSystemCheck: Boolean(e2eVariantA?.afterConfirm && !e2eVariantA.afterConfirm.error
    && !(e2eVariantA.afterConfirm.criticFailures || []).some(item => String(item).includes('受控来源系统'))),
  a_confirmWritesFact: Boolean(e2eVariantA?.afterConfirm && !e2eVariantA.afterConfirm.error
    && (e2eVariantA.afterConfirm.sourceSystems || []).every(item => item.sourceSystems.length === 1 && item.sourceSystems[0] !== 'UNASSIGNED' && (item.candidateSourceSystems || []).length === 0)),
  // 确认相对只取证的净效果：失败项应当**恰好减少 1 项**（受控来源系统），多减说明有检查被顺带绕过。
  a_confirmReducesFailuresByOne: Boolean(e2eVariantA?.afterConfirm && !e2eVariantA.afterConfirm.error
    && (e2eVariantA.afterConfirm.criticFailures || []).length === (e2eVariantA.criticFailures || []).length - 1)
} : null;

const variants = VARIANTS.map(variant => {
  const own = rows.filter(row => row.variant === variant.id);
  const passed = own.filter(row => row.verdict.passed).length;
  return {
    id: variant.id,
    title: variant.title,
    expect: variant.expect,
    rounds: own.length,
    passed,
    stable: passed === own.length,
    outcomes: own.reduce((acc, row) => ({ ...acc, [row.outcome]: (acc[row.outcome] || 0) + 1 }), {}),
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
  // 变体轮次＝每次恰好 1 次模型调用；端到端段每次提案也至少 1 次模型调用（不并入前者，避免少算）。
  variantRounds: rows.length,
  e2eProposalRuns: e2e.length,
  passed: rows.filter(row => row.verdict.passed).length,
  failed: rows.filter(row => !row.verdict.passed).length,
  variants,
  e2e,
  e2eAssertions,
  rows,
  boundary: '合成材料 + 真实模型调用（workbuddy/deepseek-v4-pro，采样温度 0.2）；只测量抽取契约分布与端到端标识对应计数，不代表真实企业材料或生产验收。'
};

console.log(JSON.stringify(summary, null, 2));
const e2eFailed = e2eAssertions ? Object.values(e2eAssertions).filter(value => !value).length : 0;
process.exit(summary.failed === 0 && e2eFailed === 0 ? 0 : 1);

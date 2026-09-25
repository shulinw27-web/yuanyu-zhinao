import { generateModelSummary, getLocalModelRuntime } from './local-model-gateway.js';
import { normalizeUntrustedText } from './prompt-security-service.js';
import { detectDeclaredSystemCodes } from './semantic-source-discovery-service.js';

/**
 * 归属候选推导（ADR-017 决策 1/6）。
 *
 * 模型只提供**归属原文**，系统码由服务端从这段原文里判定——契约里没有「系统码」字段，
 * 模型不能直接写 ERP，否则就是给它一个无法复核的断言入口。
 *
 * 判定只用系统码与系统名（`detectDeclaredSystemCodes`），**不用业务词别名**：别名表里有
 * 「采购」「库存」「审批」这类通用词，用于「这段文本提到什么系统」尚可容忍，
 * 用于归属会把「采购订单表」这种普通表述判成 ERP 所有权。
 *
 * 三种情形分别上报、**一律不猜**：恰好一个已登记系统 → 候选；多个 → 歧义（选哪个需要域知识）；
 * 零个 → 未归属（不挑一个最近的，那正是本重构一路在消除的行为）。
 */
function deriveOwnerCandidate(systemEvidence) {
  const evidence = typeof systemEvidence === 'string' ? systemEvidence.trim() : '';
  if (!evidence) return { code: 'absent', candidate: null };
  const codes = detectDeclaredSystemCodes(evidence);
  if (codes.length === 1) return { code: 'attributed', candidate: { system: codes[0], evidence } };
  if (codes.length > 1) return { code: 'ambiguous', candidate: null, codes };
  return { code: 'unattributed', candidate: null };
}

/**
 * Literal evidence is required for every table/field/key. Unknown source systems
 * remain UNASSIGNED and block publication; model suggestions never become facts.
 *
 * 阶段 4c 第二段（ADR-017）追加：归属同样要有逐字证据（`systemEvidence`），
 * 但判定出的归属**只是候选**（`candidateSourceSystems`），`sourceSystems` 仍是 UNASSIGNED——
 * 事实要等人确认才写，候选不得参与范围裁剪。
 */
export function validateNaturalSchema(value, material, diagnostics = []) {
  const reject = code => { diagnostics.push(code); return null; };
  if (!value || !Array.isArray(value.tables) || !value.tables.length || value.tables.length > 40) return reject('TABLES_INVALID');
  const normalizedMaterial = normalizeUntrustedText(material);
  const quotePresent = (quote, token) => typeof quote === 'string' && quote.includes(token) && normalizedMaterial.includes(normalizeUntrustedText(quote));
  // 归属原文没有「必须包含哪个 token」的要求（别名与系统名都可能出现），只要求逐字来自材料。
  const literalPresent = (quote) => typeof quote === 'string' && Boolean(quote.trim()) && normalizedMaterial.includes(normalizeUntrustedText(quote));
  const names = new Set(value.tables.map(table => table.name));
  if (names.size !== value.tables.length) return reject('TABLES_DUPLICATED');
  const objectTypes = [];
  const relationshipTypes = [];
  const attribution = { attributed: [], ambiguous: [], unattributed: [] };
  for (const table of value.tables) {
    if (typeof table.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,100}$/.test(table.name) || !quotePresent(table.evidence, table.name)
      || !Array.isArray(table.fields) || table.fields.length < 2 || table.fields.length > 80) return reject('TABLE_EVIDENCE_INVALID');
    // 给了归属原文就必须逐字来自材料：编造的归属证据与编造的表/字段证据同等严重——
    // 归属会被写进 sourceSystems 并参与范围裁剪，不能比表名宽松。
    // 空白字符串与 null 都表示「材料没有指名道姓地写」，属合法；只有**非空但编造**才拒绝。
    const ownerEvidence = typeof table.systemEvidence === 'string' ? table.systemEvidence.trim() : '';
    if (ownerEvidence && !literalPresent(table.systemEvidence)) return reject('OWNER_EVIDENCE_INVALID');
    const fields = table.fields.map(field => field.name);
    if (new Set(fields).size !== fields.length || !fields.includes(table.key) || !quotePresent(table.keyEvidence, table.key) || !/主键|primary.?key|\bPK\b/i.test(table.keyEvidence)) return reject('PRIMARY_KEY_EVIDENCE_INVALID');
    for (const field of table.fields) {
      if (typeof field.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,100}$/.test(field.name) || !quotePresent(field.evidence, field.name)) return reject('FIELD_EVIDENCE_INVALID');
      if (field.reference) {
        if (!names.has(field.reference)) return reject('FOREIGN_KEY_TARGET_INVALID');
        if (!quotePresent(field.referenceEvidence, field.name)) return reject('FOREIGN_KEY_QUOTE_INVALID');
        if (!/外键|foreign.?key|引用|关联|\bFK\b/i.test(`${field.referenceEvidence}\n${field.evidence}`)) return reject('FOREIGN_KEY_MARKER_INVALID');
        relationshipTypes.push({ from: table.name, to: field.reference, predicate: `references_${field.name}`, label: `${table.name}.${field.name} 引用 ${field.reference}`, cardinality: 'n:1', evidence: field.referenceEvidence });
      }
    }
    const owner = deriveOwnerCandidate(table.systemEvidence);
    if (owner.code === 'attributed') attribution.attributed.push({ objectId: table.name, system: owner.candidate.system, evidence: owner.candidate.evidence });
    else if (owner.code === 'ambiguous') attribution.ambiguous.push({ objectId: table.name, systems: owner.codes, evidence: String(table.systemEvidence || '').trim() });
    else if (owner.code === 'unattributed') attribution.unattributed.push({ objectId: table.name, evidence: String(table.systemEvidence || '').trim() });
    objectTypes.push({ id: table.name, label: table.label || table.name, source: `unassigned.${table.name}`, key: table.key, fields,
      classification: '内部受限（待复核）', semanticType: table.name, coreObject: table.name, sourceSystems: ['UNASSIGNED'],
      // 候选归属与它的逐字依据：只在「恰好判定出一个已登记系统」时存在。
      candidateSourceSystems: owner.candidate ? [owner.candidate.system] : [],
      candidateSourceEvidence: owner.candidate ? owner.candidate.evidence : (String(table.systemEvidence || '').trim() || null),
      candidateSourceBasis: owner.candidate ? 'material_owner_evidence' : null,
      fieldDefinitions: table.fields.map(field => ({ name: field.name, type: 'string', required: field.name === table.key, primaryKey: field.name === table.key, sourceField: field.name, mappingStatus: 'pending', reference: field.reference || null, description: `类型和映射待复核；原文：${field.evidence}` })),
      description: `原文字典候选，未连接企业系统。${table.evidence}` });
  }
  return { status: 'review_required', files: [], objectTypes, relationshipTypes, attribution, warnings: ['来源系统、字段类型及映射必须人工核实；没有执行来源验证。'], summary: '从用户材料抽取并逐字段核对原文的候选结构；尚未验证映射。' };
}

/**
 * 不尝试自然语言抽取的两种情形，以及它们的**可读原因**（阶段 4f）。
 *
 * 此前这两种情形都只 `return null`：调用方拿不到任何可区分的信息，于是「为什么本次没有候选对象」
 * 只能靠猜——是材料不对，还是模型没接上？现在两种情形各自带一个原因码与一句中文说明上报，
 * 由提案的审阅说明（`reviewNotes`）呈现给运营。
 *
 * 注意这两条**不是同一类问题**：`mock_runtime` 是「本轮没接模型」（要换 provider 或接受目录兜底），
 * `not_dictionary_like` 是「材料没给字典线索」（要补主键 / 字段名）。把它们并成一句
 * 「未生成候选对象」会让运营朝错误的方向改材料——这正是本阶段要消除的。
 */
export const NATURAL_SCHEMA_SKIP_REASONS = Object.freeze({
  mock_runtime: '当前模型运行时为模拟模式（未调用任何模型），候选对象只可能来自受控目录与结构化材料。',
  not_dictionary_like: '材料里没有出现「主键 / 字段」这类字典线索，未尝试自然语言抽取；若材料其实描述了对象与字段，请显式写出主键与字段名后重试。'
});

// 字典线索的粗筛。它只回答「值不值得去调一次模型」，**不是**「材料里有没有业务对象」的断言：
// 纯业务描述（「我们有订单、库存、发运三类数据」）会落在这里被判为不值得尝试。
// 因此它是**如实披露的跳过理由**，而不是一个静默的守门人。
const DICTIONARY_HINT = /主键|primary.?key|字段|\bfields\b|\bPK\b/i;

/**
 * 判定「本次是否跳过自然语言抽取」。抽成纯函数是为了让两条路径都能被确定性用例覆盖：
 * 测试环境恒为 mock 模式，若判定内联在 `discoverNaturalSchema` 里，
 * `not_dictionary_like` 这条分支会被 mock 分支永久遮住（永远测不到）。
 */
export function naturalSchemaSkipReason({ mode, material } = {}) {
  if (mode === 'mock') return 'mock_runtime';
  if (!DICTIONARY_HINT.test(String(material || ''))) return 'not_dictionary_like';
  return null;
}

export async function discoverNaturalSchema(material) {
  // 跳过必须说明理由，而不是静默返回 null（阶段 4f）。
  const skip = naturalSchemaSkipReason({ mode: getLocalModelRuntime().mode, material });
  if (skip) return { skipped: skip, reason: NATURAL_SCHEMA_SKIP_REASONS[skip] };
  const result = await generateModelSummary({
    prompt: `仅抽取材料明确给出的表、字段、主键、外键。不要补充默认 id/status，不确定则不生成。每个 evidence/keyEvidence/referenceEvidence 必须逐字引用材料的一段原文，并包含对应名称。reference 是明确的目标表名；没有外键证据则 null。字段类型不猜测。systemEvidence 必须逐字引用材料中说明该表**属于哪个业务系统**的那一句（例如「ERP 采购订单表 purchase_order」）；材料没有指名道姓地写出所属系统时填 null——绝不要根据字段名或业务含义推测系统，也不要直接写系统编码。\n材料：${material.slice(-20000)}\n在 answer 字段中返回 JSON 字符串：{"tables":[{"name":"原文表名","label":"中文名","evidence":"含表名的原文","key":"主键字段","keyEvidence":"明确该字段是主键的原文","systemEvidence":"含所属系统的原文或 null","fields":[{"name":"字段名","evidence":"含字段名的原文","reference":null,"referenceEvidence":null}]}]}`,
    fallback: '', safetyIdentifier: 'semantic-schema-discovery'
  });
  if (!['ark', 'local', 'openai', 'deepseek', 'compatible', 'workbuddy'].includes(result.source)) return { error: '模型未能提取可核对的结构，请重试或上传结构化数据字典。' };
  try {
    const diagnostics = [];
    return validateNaturalSchema(JSON.parse(result.text), material, diagnostics) || { error: `候选结构缺少可核对的原文证据（${diagnostics[0]}），请补充主外键定义或上传结构化字典；未使用默认模板代替。` };
  }
  catch { return { error: '模型未返回有效的结构化字典，未生成默认模板。' }; }
}

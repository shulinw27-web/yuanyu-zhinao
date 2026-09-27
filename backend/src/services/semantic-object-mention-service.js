// 受控对象链接（阶段 4h / ADR-025）：把「材料里逐字提到的业务对象称呼」链接到
// 系统目录里**已登记**的世界模型对象类型，让被点名的对象第一次能进入候选。
//
// ── 这个文件为什么存在 ──────────────────────────────────────────────────────
//
// 阶段 4f/4g（ADR-021/022）把「候选从哪来、缺了什么」变成了可读、可点名，
// 但点名的对象**一个都不进候选**（4g 决策 6）——「材料写『采购订单、发运单、出库单、
// 客户投诉』，候选只得 1 类」的根因仍然原封不动。本服务是那条根因的第一次直接处置。
//
// ── 模型能做什么、不能做什么（与 ADR-017 同一条纪律）────────────────────────
//
// 模型只做一件事：回答「材料里的这段原文说的是哪个已登记对象类型」。
// 它**不能**发明对象类型（服务端只接受系统目录 `worldObjectTypes` 里登记过的名字）、
// **不能**发明字段与主键（候选结构只来自该系统的既有声明）、**不能**断言归属系统
// （系统由类型登记关系决定，是平台事实，不给模型断言入口）。
// 提称与证据必须逐字来自材料（`normalizeUntrustedText` 口径），编造即整份拒绝——
// 与 `validateNaturalSchema` 的逐字证据要求同一严格度。
//
// ── 与既有决策的关系 ────────────────────────────────────────────────────────
//
// - ADR-021 决策 6「材料没有字典线索不触发抽取尝试」**不推翻**：字典线索材料的完整
//   抽取（表/字段/主键/外键）仍是 `discoverNaturalSchema` 的地盘；本服务只在
//   「没做抽取或抽取无产出」时运行，产出的是**链接**而不是结构化字典。
// - ADR-022 决策 6「点名的对象不进候选」**由本增量推翻并收窄为**：仅「已登记类型」
//   的点名经人工审阅进入候选；未登记提及仍只披露（词表治理仍不在本增量范围）。
// - ADR-013：链接产出的候选带 `sourceSystems`（来自类型登记），因此照常参与范围过滤；
//   被范围排除时与其它候选同样进 `excludedObjects` 显式列出。
// - 披露不等于补齐的立场不变：进入候选的仍是**待审阅草稿**，字段映射为 pending、
//   Critic 会拦住未映射就采纳的尝试——关口一个都没少。

import { generateModelSummary, getLocalModelRuntime } from './local-model-gateway.js';
import { normalizeUntrustedText } from './prompt-security-service.js';
import { inferObjectGranularity } from './ontology-contract-service.js';
import { buildSystemFieldCatalog } from './semantic-identity-link-service.js';
import { systemDefinitions } from '../data/system-catalog.js';

/**
 * 跳过对象链接的两种情形（阶段 4f 起的同一条纪律：跳过必须带可区分的原因）。
 *
 * `mock_runtime` 与自然语言抽取的跳过原因是**同一个码**：两条路径都「本轮没接模型」，
 * 分开起名只会让调用方多一种要区分的状态。`no_scope` 是本服务特有的：
 * 显式空范围（ADR-012）意味着「没有任何系统在范围内」，已登记类型的集合因此为空。
 */
export const MENTION_LINK_SKIP_REASONS = Object.freeze({
  mock_runtime: '当前模型运行时为模拟模式（未调用任何模型），受控对象链接不可用；候选对象只可能来自受控目录与结构化材料。',
  no_scope: '本次未选择任何系统，没有可用于链接的已登记对象类型；请补选系统后重试。'
});

/**
 * 判定「本次是否跳过受控对象链接」。抽成纯函数的理由与 `naturalSchemaSkipReason`
 * （ADR-021 决策 4）完全相同：测试环境恒为 mock，判定若内联在异步编排里，
 * `no_scope` 这条分支会被 mock 分支永久遮住。
 */
export function mentionLinkSkipReason({ mode, systems } = {}) {
  if (mode === 'mock') return 'mock_runtime';
  if (Array.isArray(systems) && !systems.length) return 'no_scope';
  return null;
}

/**
 * 已登记世界模型对象类型的索引：objectType → { system, systemName }。
 *
 * `systems` 为 `null` 表示调用方未给范围（非建模路径）——此时池取**全部**已登记类型，
 * 与受控目录兜底不受范围限制的行为一致；`systems` 为数组（含空数组）时池只含范围内系统，
 * 空数组的池就是空（显式为空不放宽，ADR-012）。
 */
export function registeredWorldObjectIndex(systems = null) {
  const selected = Array.isArray(systems) ? new Set(systems) : null;
  const index = new Map();
  for (const definition of systemDefinitions) {
    if (selected && !selected.has(definition.code)) continue;
    for (const objectType of definition.worldObjectTypes || []) {
      // worldObjectTypes 跨系统重复在系统目录里不存在（每类只登记在一个系统）；
      // 若将来出现重复，这里保留首个并让冲突可见，而不是静默覆盖。
      if (!index.has(objectType)) index.set(objectType, { system: definition.code, systemName: definition.name });
    }
  }
  return index;
}

// 单次链接上限：与未覆盖提及清单（ADR-022）同一取舍——超过就把总数说出来，不静默丢弃。
export const MENTION_LINK_LIMIT = 12;

/**
 * 校验模型返回的链接集合。**纯函数**，双向逐字校验：
 * ① `evidence` 必须逐字来自材料；② `evidence` 必须包含 `mention`；③ `objectType` 必须在
 * 已登记索引内。任何一条不满足都拒绝**整份**返回——与 `validateNaturalSchema` 同一立场：
 * 编造一条证据的模型输出，其余条目也不可信任，不做「把坏行删掉留下好行」的局部挽救
 * （那会让模型通过重试学会「丢掉证据不足的行就够了」）。
 *
 * 同一 `objectType` 的多条提及只保留首条（首次出现），`mergedDuplicates` 披露合并数——
 * 材料里三次提到「发运单」是一个对象，不是三个。
 *
 * @returns {{ links: Array<{mention, evidence, objectType, system, systemName}>, total: number, truncated: boolean, mergedDuplicates: number } | { error: string }}
 */
export function validateMentionLinks(value, material, typeIndex, diagnostics = []) {
  const reject = code => { diagnostics.push(code); return null; };
  if (!value || !Array.isArray(value.mentions)) return reject('MENTIONS_INVALID');
  if (value.mentions.length > 60) return reject('MENTIONS_OVERFLOW');
  const normalizedMaterial = normalizeUntrustedText(material);
  const links = [];
  const seen = new Set();
  let mergedDuplicates = 0;
  for (const entry of value.mentions) {
    const mention = typeof entry?.mention === 'string' ? entry.mention.trim() : '';
    const evidence = typeof entry?.evidence === 'string' ? entry.evidence.trim() : '';
    const objectType = typeof entry?.objectType === 'string' ? entry.objectType.trim() : '';
    if (!mention || mention.length > 48 || !evidence || evidence.length > 400) return reject('MENTION_EVIDENCE_INVALID');
    // 逐字校验用归一化口径（与 validateNaturalSchema 的 quotePresent 一致）：
    // 全角/半角标点差异不算编造，但内容必须真的在材料里。
    const normalizedEvidence = normalizeUntrustedText(evidence);
    const normalizedMention = normalizeUntrustedText(mention);
    if (!normalizedMaterial.includes(normalizedEvidence) || !normalizedEvidence.includes(normalizedMention)) return reject('MENTION_EVIDENCE_INVALID');
    const registered = typeIndex.get(objectType);
    if (!registered) return reject('MENTION_TYPE_UNKNOWN');
    if (seen.has(objectType)) { mergedDuplicates += 1; continue; }
    seen.add(objectType);
    links.push({ mention, evidence, objectType, system: registered.system, systemName: registered.systemName });
  }
  const total = links.length;
  return { links: links.slice(0, MENTION_LINK_LIMIT), total, truncated: total > MENTION_LINK_LIMIT, mergedDuplicates };
}

const snakeCase = (value) => String(value || '').replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * 把链接升级为**候选对象**。结构只来自该系统的既有声明
 * （`buildSystemFieldCatalog` 的声明侧目录：受控词汇表 + 已配置映射），
 * 主键用与 4a 完全相同的标识判据（`inferIdentifier`：登记主键 → `<对象>_id` → 自身概念）。
 *
 * 链接成立 ≠ 候选成立。两类「链接了但给不出结构」的情形必须分开点名：
 * - `no_declaration`：系统目录登记了类型，但该系统没有任何字段声明（如 OutboundShipment
 *   只有类型名）；建议：在系统配置里补映射声明，或上传结构化字典。
 * - `no_identifier`：有声明但标识判据不成立（声明里没有可判定的主键）；建议：补主键声明。
 * 这两类都**不进候选**（无主键对象过不了草案校验，也过不了 Critic），只披露。
 *
 * @returns {{ candidates: Array<object>, gaps: Array<{mention, objectType, system, reason, suggestion}> }}
 */
export function buildMentionLinkCandidates({ links = [] } = {}) {
  const systems = [...new Set(links.map((link) => link.system))];
  const catalog = buildSystemFieldCatalog({ objects: [], systems });
  const entryOf = (link) => {
    const inSystem = catalog.find((group) => group.code === link.system);
    return inSystem?.objects.find((entry) => entry.objectId === link.objectType) || null;
  };
  const candidates = [];
  const gaps = [];
  for (const link of links) {
    const entry = entryOf(link);
    // 目录条目的 `fields` 是带标识注解的对象数组（{name, shape, identity…}），候选要的是字段名。
    const fieldNames = (entry?.fields || []).map((field) => field?.name).filter(Boolean);
    if (!entry || !fieldNames.length) {
      gaps.push({ mention: link.mention, objectType: link.objectType, system: link.system, reason: 'no_declaration', detail: `系统 ${link.system} 已登记对象类型 ${link.objectType}，但没有任何字段声明（受控词汇表与已配置映射均未覆盖）。`, suggestion: '在系统接入的字段映射里为该对象补声明，或上传结构化数据字典后重跑。' });
      continue;
    }
    if (!entry.identifier || !fieldNames.includes(entry.identifier)) {
      gaps.push({ mention: link.mention, objectType: link.objectType, system: link.system, reason: 'no_identifier', detail: `系统 ${link.system} 对 ${link.objectType} 的声明里识别不出主键（候选：${(entry.identifierCandidates || []).join('、') || '无'}）。`, suggestion: '为该对象的声明补一个明确主键后重跑。' });
      continue;
    }
    candidates.push({
      id: entry.objectId,
      label: entry.label || entry.objectId,
      source: entry.source || `${link.system.toLowerCase()}.${snakeCase(entry.objectId)}`,
      key: entry.identifier,
      fields: fieldNames,
      granularity: inferObjectGranularity(entry.objectId),
      semanticType: entry.objectId,
      coreObject: entry.objectId,
      sourceSystems: [link.system],
      classification: '内部受限（待复核）',
      fieldDefinitions: fieldNames.map((name) => ({
        name, type: 'string', required: name === entry.identifier, primaryKey: name === entry.identifier,
        // pending 是有意的：结构来自声明不等于映射已确认——Critic 会拦住未映射就采纳的尝试，
        // 这与自然语言抽取路径（validateNaturalSchema 的 fieldDefinitions）行为一致。
        sourceField: null, mappingStatus: 'pending', reference: null,
        description: null
      })),
      description: `材料逐字提及「${link.mention}」，经受控对象链接对应到系统 ${link.system} 已登记对象 ${entry.objectId}（ADR-025）；字段与主键来自该系统的既有声明，未经映射确认。提及原文：${link.evidence}`.slice(0, 300)
    });
  }
  return { candidates, gaps };
}

/**
 * 编排入口：跳过判定 → 模型链接 → 校验 → 结构合成。
 *
 * 只在「结构化材料与自然语言抽取都没产出对象」之后由调用方触发（调用方保证）；
 * 字典线索材料的完整抽取（表/字段/主键/外键）仍是 `discoverNaturalSchema` 的地盘，
 * 两者不叠加运行。
 */
export async function discoverObjectMentionLinks({ material, systems = null } = {}) {
  const mode = getLocalModelRuntime().mode;
  const skip = mentionLinkSkipReason({ mode, systems });
  if (skip) return { skipped: skip, reason: MENTION_LINK_SKIP_REASONS[skip], links: [], total: 0, truncated: false, mergedDuplicates: 0, candidates: [], gaps: [] };
  const typeIndex = registeredWorldObjectIndex(systems);
  if (!typeIndex.size) return { skipped: 'no_scope', reason: MENTION_LINK_SKIP_REASONS.no_scope, links: [], total: 0, truncated: false, mergedDuplicates: 0, candidates: [], gaps: [] };
  const allowed = [...typeIndex.keys()].sort();
  const result = await generateModelSummary({
    prompt: `从材料里找出对业务对象的**称呼**，并把它对应到下面给出的已登记对象类型名单。规则：mention 必须逐字取自材料；evidence 必须逐字引用材料中包含该称呼的一段原文（不得改写、不得拼接）；objectType 只能从名单里选，材料提到的对象在名单里没有对应类型时**直接跳过它**，绝不要猜一个名单外的名字；不确定就不要输出。不要输出字段、主键或系统名。\n已登记对象类型名单：${allowed.join('、')}\n材料：${String(material || '').slice(-20000)}\n在 answer 字段中返回 JSON 字符串：{"mentions":[{"mention":"材料中的称呼","evidence":"包含该称呼的原文片段","objectType":"名单中的类型名"}]}；材料里没有可对应的对象时返回 {"mentions":[]}`,
    fallback: '', safetyIdentifier: 'semantic-object-mention-linking'
  });
  if (!['ark', 'local', 'openai', 'deepseek', 'compatible', 'workbuddy'].includes(result.source)) {
    return { error: '模型未能完成受控对象链接，请重试、补充材料或上传结构化数据字典。', links: [], total: 0, truncated: false, mergedDuplicates: 0, candidates: [], gaps: [] };
  }
  try {
    const diagnostics = [];
    const validated = validateMentionLinks(JSON.parse(result.text), material, typeIndex, diagnostics);
    if (!validated) return { error: `受控对象链接的模型输出未通过逐字校验（${diagnostics[0]}），未采用任何链接；请重试或人工核对材料表述。`, links: [], total: 0, truncated: false, mergedDuplicates: 0, candidates: [], gaps: [] };
    const { candidates, gaps } = buildMentionLinkCandidates({ links: validated.links });
    return { ...validated, candidates, gaps, basis: 'model_verbatim_linking' };
  }
  catch {
    return { error: '模型未返回有效的链接结果，未采用任何链接。', links: [], total: 0, truncated: false, mergedDuplicates: 0, candidates: [], gaps: [] };
  }
}

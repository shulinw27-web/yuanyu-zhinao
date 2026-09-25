// 语义候选对象的**受控目录**（关键词兜底）与它的**覆盖披露**（阶段 4g / ADR-022）。
//
// ── 这个文件为什么存在 ──────────────────────────────────────────────────────
//
// 下面这 12 类此前硬编码在 `semantic-operations-agent-service.js` 里，与提案组装、
// 标识推导、审阅说明生成混在同一个近千行文件内。抽出来的目的**不是「分文件」**，
// 而是让这件事可以单独被度量：
//
//   「材料里写了某个业务对象，候选里却没有」——这句话此前无人能解释。
//
// 阶段 4f（ADR-021）让**命中依据**可读（命中了哪几个词、受控目录共几类），
// 但**没命中的那些仍然是沉默的**：运营看得到「命中 2 类」，
// 看不到「目录里根本没有承载你要的那类对象的词条」——这是两种完全不同的处境，
// 要做的补救也完全不同（前者改材料用词，后者必须补词条或上传结构化字典）。
//
// ── 本文件提供的两项披露（都**不改变候选对象集合**）────────────────────────
//
// 1. `listCatalogGaps()`        —— **确定性**。把受控目录与系统目录里已登记的
//    「世界模型对象」（`data/system-catalog.js` 的 `worldObjectTypes`）求差集，
//    点名哪些**已被平台治理**的对象在候选目录里没有任何词条。
//    这一项零启发式：两边都是库里的既有事实，只是此前从没有人把它们对起来看过。
//
// 2. `listUncoveredMentions()`  —— **启发式**。材料里以列举分隔符切出的纯中文短短语中，
//    未被任何词条覆盖的那些。它回答的是「你这次写的这几个词，目录里一个都没有」。
//    它**不是对象抽取**（见 ADR-022 的边界一节）：会混入非对象词，也会漏掉
//    没有用分隔符列出的对象名。
//
// 两项都遵循同一条立场（与 ADR-018 / ADR-021 一致）：**披露不等于补齐**。
// 它们只让「缺失」可见，不替运营把缺失的东西补进候选——补进候选涉及
// 对象来源与范围的既有决策（ADR-012 / ADR-013 / ADR-017），不在这里做。

import { systemDefinitions } from '../data/system-catalog.js';

// ── 受控候选目录 ────────────────────────────────────────────────────────────
//
// 语义：`terms` 是**词面命中**用的词条；命中即把该条目作为候选对象（**兜底**，不是抽取结果）。
// 只在结构化材料与自然语言抽取**都没产出对象**时使用。
//
// 已知词表质量问题（记录在案，本阶段不改，见 ADR-021 边界三）：
// `PurchaseOrder` 的词条含「订单」，任何含「订单」的材料都会命中「采购订单」，
// 而在 OMS 语境里「订单」通常是**销售订单**。这是词表过泛，不是披露问题。
export const CANDIDATE_CATALOG = Object.freeze([
  { id: 'Material', label: '物料主数据', terms: ['物料主数据', '原料主数据'], source: 'erp.material', key: 'material_id', fields: ['material_id', 'name', 'status'], classification: '供应链受限', coreObject: 'Material' },
  { id: 'ProductSKU', label: '产品主数据', terms: ['产品主数据', 'SKU主数据'], source: 'erp.product', key: 'product_id', fields: ['product_id', 'name', 'status'], classification: '产品受限', coreObject: 'ProductSKU' },
  { id: 'Supplier', label: '供应商', terms: ['供应商', '供方'], source: 'erp.supplier', key: 'supplier_id', fields: ['supplier_id', 'name', 'qualification_status', 'status'], classification: '供应链受限', coreObject: 'Supplier' },
  { id: 'PurchaseDemand', label: '采购需求', terms: ['采购需求', '请购', '采购申请'], source: 'erp.purchase_demand', key: 'demand_id', fields: ['demand_id', 'material_code', 'qty', 'required_date', 'status'], classification: '运营受限', coreObject: 'RawMaterial' },
  { id: 'PurchaseOrder', label: '采购订单', terms: ['采购订单', '订单'], source: 'erp.purchase_order', key: 'purchase_order_id', fields: ['purchase_order_id', 'supplier_id', 'material_code', 'qty', 'status'], classification: '财务受限', coreObject: 'PurchaseOrder' },
  { id: 'RawMaterialBatch', label: '原料批次', terms: ['原料', '物料', '来料', '批次'], source: 'wms.raw_material_batch', key: 'material_batch_id', fields: ['material_batch_id', 'material_code', 'supplier_id', 'status'], classification: '质量受限', coreObject: 'RawMaterial' },
  { id: 'TestResult', label: '检验结果', terms: ['检验', '质检', '检测'], source: 'lims.test_result', key: 'test_result_id', fields: ['test_result_id', 'material_batch_id', 'item', 'result', 'status'], classification: '质量受限', coreObject: 'RawMaterial' },
  { id: 'ProductionBatch', label: '生产批次', terms: ['生产批次', '生产'], source: 'mes.production_batch', key: 'production_batch_id', fields: ['production_batch_id', 'product_code', 'material_batch_id', 'status'], classification: '生产受限', coreObject: 'Product' },
  { id: 'FinishedGoodsBatch', label: '成品批次', terms: ['成品', '放行'], source: 'qms.finished_goods_batch', key: 'finished_goods_batch_id', fields: ['finished_goods_batch_id', 'product_code', 'release_status', 'status'], classification: '质量受限', coreObject: 'Product' },
  { id: 'Inventory', label: '库存', terms: ['库存', '仓库'], source: 'wms.inventory', key: 'inventory_id', fields: ['inventory_id', 'material_batch_id', 'quantity', 'warehouse_code'], classification: '运营受限', coreObject: 'RawMaterial' },
  { id: 'Store', label: '门店', terms: ['门店', '店铺'], source: 'oms.store', key: 'store_id', fields: ['store_id', 'name', 'region', 'status'], classification: '门店运营受限', coreObject: 'Store' },
  { id: 'Equipment', label: '设备', terms: ['设备', '产线'], source: 'mes.equipment', key: 'equipment_id', fields: ['equipment_id', 'name', 'line_code', 'status'], classification: '生产受限', coreObject: 'Equipment' }
]);

export const CANDIDATE_CATALOG_SIZE = CANDIDATE_CATALOG.length;

/**
 * 词面命中：返回**命中条目**及其**命中词**，而不是只返回条目。
 *
 * 只返回条目是阶段 4f 之前的做法，其后果是「为什么没有发运单」无人能答——
 * 要回答它必须能看到**没命中**的那些，而没命中的前提是先知道命中的是**哪个词**。
 */
export function matchCandidateCatalog(sourceText) {
  const text = String(sourceText || '');
  return CANDIDATE_CATALOG
    .map((item) => ({ item, matchedTerms: item.terms.filter((term) => text.includes(term)) }))
    .filter((entry) => entry.matchedTerms.length);
}

/**
 * 目录空白：**平台已经治理、但候选目录没有词条**的对象类。
 *
 * 两边都是既有事实——左边是候选目录的 12 类，右边是系统目录里每个系统的
 * `worldObjectTypes`（世界模型里被建模的对象）。此前从没有人把它们对起来看过，
 * 于是「兜底路径能命中多少」这件事一直没有数量级。
 *
 * 之所以要披露而不是直接**补齐**：候选目录是关键词兜底的**词表**，
 * 补词条等于扩写受控词汇表，属词表治理决策（谁负责、依据什么、如何失效），
 * 不在本阶段擅自做（决策 6：不放宽任何门槛，也不自动补候选对象）。
 */
export function listCatalogGaps(definitions = systemDefinitions) {
  const declared = new Set(CANDIDATE_CATALOG.map((item) => item.id));
  return definitions.flatMap((definition) => (definition.worldObjectTypes || [])
    .filter((objectType) => !declared.has(objectType))
    .map((objectType) => ({ objectType, system: definition.code, systemName: definition.name })));
}

// ── 未覆盖提及（启发式）────────────────────────────────────────────────────

// 列举分隔符：顿号 / 中英文逗号 / 中英文分号 / 竖线 / 斜杠 / 换行。
// 只有出现分隔符（即材料里有**并列列举**）才取词——整段散文不产生任何提及，
// 这样「我们要根据这些资料建立语义模型」这类整句不会被当成对象名。
const ENUMERATION_SEPARATORS = /[、，,；;｜|/\\\n\r]+/;

// 非名词性线索字：短语中出现即认为它不是一个「对象名」。
// 这一层是必要的噪声门——没有它，「请核对是否遗漏」「目前已有的数据」这类
// 从句会全部挤进清单，把真正要看的「发运单」淹掉。
// 它是**黑名单式**启发式，必然有漏（例如「相关数据」不在其中），因此清单本身
// 必须带「启发式」标注（见 listUncoveredMentions 的返回字段）。
const NON_NOUN_HINTS = /[的了和与及或我你他她它们这那其某要需想把被在为由对给让使都也还就而则等些么吗呢吧啊是能会可并且因所以但如若即之上下多少类种项个]/;

const MENTION_MIN_LENGTH = 2;
const MENTION_MAX_LENGTH = 8;
// 清单长度上限：整段材料若被切成几十个短语，全列出来只会把审阅说明淹掉，
// 反而没人看。截断时必须**说明被截断**，不能静默丢弃（与 ADR-020 决策 2 同一条要求）。
export const UNCOVERED_MENTION_LIMIT = 12;

/**
 * 材料里出现、但**没有被任何受控词条覆盖**的列举项。
 *
 * 判定是**纯函数**且与目录内容解耦（只吃 `matchedTerms`），因此可以在不构造提案的
 * 前提下逐条取证——这与 ADR-021 决策 4（跳过判定抽成纯函数）是同一条理由：
 * 环境相关或数据相关的判定若内联在提案组装里，就只剩端到端一条取证路径。
 *
 * @returns {{ mentions: string[], total: number, truncated: boolean, basis: 'enumeration_heuristic' }}
 */
export function listUncoveredMentions({ sourceText, matchedTerms = [] } = {}) {
  const text = String(sourceText || '');
  const parts = text.split(ENUMERATION_SEPARATORS);
  // 单段（无分隔符）＝没有并列列举 → 不取词。这一条同时挡住了「整句被误当对象名」。
  if (parts.length < 2) return { mentions: [], total: 0, truncated: false, basis: 'enumeration_heuristic' };
  const covered = matchedTerms.filter((term) => typeof term === 'string' && term);
  const isCovered = (token) => covered.some((term) => token.includes(term) || term.includes(token));
  const seen = new Set();
  const mentions = [];
  let total = 0;
  for (const part of parts) {
    // 削掉两端非汉字（空白、标点、英文、数字、括号引号）：剩下的若不是汉字串就被下面排除。
    const token = String(part).replace(/^[^\u4e00-\u9fa5]+|[^\u4e00-\u9fa5]+$/g, '');
    if (token.length < MENTION_MIN_LENGTH || token.length > MENTION_MAX_LENGTH) continue;
    if (NON_NOUN_HINTS.test(token)) continue;
    if (isCovered(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    total += 1;
    if (mentions.length < UNCOVERED_MENTION_LIMIT) mentions.push(token);
  }
  return { mentions, total, truncated: total > mentions.length, basis: 'enumeration_heuristic' };
}

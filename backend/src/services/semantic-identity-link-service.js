import { systemConfigurations } from '../data/seed.js';
import { KEY_MAPPING_BASES, KEY_MAPPING_OWNER_MAX, KEY_MAPPING_VERSION_MAX, KEY_MAPPING_SOURCE_MAX, sanitizeKeyMapping } from '../domain-contracts/key-mapping.js';
export { sanitizeKeyMapping };

/**
 * 来源系统字段目录与跨系统标识对应（阶段 4a）。
 *
 * 阶段 4 要把「硬编码对象目录 + 关键词命中」升级为「按选中系统的字段目录抽取对象与标识」。
 * 本模块承担其中的**确定性一半**：
 *
 *   1. 字段目录：被选中的来源系统各自声明了哪些对象与字段，收敛为可枚举事实；
 *   2. 标识识别：每个对象的主键 / 唯一业务键 / 未识别（**绝不拿第一个字段顶替**）；
 *   3. 跨系统标识对应：同一业务实体在不同系统的标识对应，附方向、基数与逐字证据；
 *   4. 冲突与歧义：显式上报，**不做静默合并**。
 *
 * 刻意**不**依赖模型：标识对应若靠模型「猜」，就既不可复现也不可复核；模型只在本阶段的
 * 另一半（从非结构化材料抽取对象与标识）里出现。
 *
 * 输入事实只有两处，都是既有事实源，本模块不新增任何定义：
 *   - 提案候选对象（受控词汇表命中或材料抽取所得，自带 `source` 与 `sourceSystems`）；
 *   - 系统配置映射（`data/seed.js` 的 `systemConfigurations`，即各系统已配置的对象与字段）。
 *
 * 输出刻意**不**自动并入 `relationshipTypes`：字段名归一化推出的是**假设**，不是证据。
 * 把它静默写进草稿，正是本次重构一路在消除的「静默扩大事实」模式；合并动作需要有人的复核。
 *
 * 阶段 4b 补上「归纳出的对应"改为"人工确认后并入"」这一段（见 `buildConfirmedRelationships`）：
 * 每条链接带稳定 `key`，确认集合是**全量语义**，并入的关系一律标 `provenanceType: 'inferred'`
 * 并记录 `derivedFrom`，使「推断 + 人工确认」与「材料里逐字写明的外键」在草稿里仍可区分。
 *
 * 阶段 4c 补上「**支撑链接的等价假设先被裁定**」这一段（见 `resolveIdentityConflictRulings`）：
 * 实测 11 条链接里有 9 条建立在「同一概念下的多个字段名指向同一实体」这个从未被谁裁定过的假设上。
 * 裁定**不并入草稿、不产生证据等级**——它改变的是链接推导的输入（哪些链接存在），
 * 采纳仍必须走 4b 的确认入口。两个关口的职责因此不会混用（见 ADR-016）。
 */

// 标识字段后缀 → 标识形状。agent＝系统内部代理键（跨系统不可直接按值对齐）；
// business＝业务键（可跨系统对齐）。裸名（如 sku）不在此表内，只按下面的事物概念表判定。
const IDENTIFIER_SUFFIX_SHAPES = Object.freeze([
  ['_number', 'business'], ['_num', 'business'], ['_code', 'business'],
  ['_key', 'business'], ['_no', 'business'], ['_id', 'agent']
]);

// 泛化标识名：`id` / `no` / `code` 这类词干无法说明它指向哪个业务实体。
// 遇到它们必须报「归属歧义」，而不是挑一个概念。
const GENERIC_IDENTIFIER_STEMS = new Set(['', 'id', 'no', 'code', 'key', 'number', 'num', 'uuid', 'uid', 'ref', 'reference']);

/**
 * 事务概念别名表：标识字段词干 → 业务概念。
 *
 * 这是**显式登记的领域知识**，不是推断结果。它的唯一作用是回答「这个字段指向哪个业务实体」，
 * 从而使跨系统的标识对应可以被*陈述*出来供人复核。
 * 若将来某个词干同时属于两个概念，`CONCEPT_INDEX` 会把它标成歧义并在冲突里报出，
 * 而不是让某一方悄悄胜出——这是这张表必须保持「可审计」的原因。
 */
const CONCEPT_ALIAS_TABLE = Object.freeze({
  Material: ['material'],
  Product: ['product', 'sku'],
  MaterialBatch: ['material_batch', 'lot'],
  ProductionBatch: ['production_batch', 'batch'],
  PurchaseOrder: ['purchase_order', 'po'],
  PurchaseDemand: ['purchase_demand', 'demand'],
  Supplier: ['supplier', 'vendor'],
  Store: ['store', 'shop'],
  Order: ['order'],
  Fulfillment: ['fulfillment'],
  Equipment: ['equipment'],
  TestResult: ['test_result', 'result', 'inspection'],
  QualityEvent: ['quality_event', 'event'],
  Deviation: ['deviation'],
  CAPA: ['capa'],
  Inventory: ['inventory'],
  InventoryLot: ['inventory_lot'],
  InboundReceipt: ['inbound_receipt', 'receipt'],
  Sample: ['sample'],
  Person: ['person', 'employee', 'staff'],
  Organization: ['organization', 'org']
});

const CONCEPT_INDEX = (() => {
  const index = new Map();
  for (const [concept, stems] of Object.entries(CONCEPT_ALIAS_TABLE)) {
    for (const stem of stems) index.set(stem, [...(index.get(stem) || []), concept]);
  }
  return index;
})();

const snakeCase = (value) => String(value || '').replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();
const splitFields = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);

/** 对象自身所属的概念：由对象名派生。未登记则返回 null（例如 RawMaterialBatch / ProductSKU）。 */
const objectConceptOf = (objectId) => {
  const concepts = CONCEPT_INDEX.get(snakeCase(objectId)) || [];
  return concepts.length === 1 ? concepts[0] : null;
};

/** 标识形状：`agent`（代理键）/ `business`（业务键）/ `null`（不是标识字段）。 */
function identifierShape(name) {
  const lower = String(name || '').toLowerCase();
  const hit = IDENTIFIER_SUFFIX_SHAPES.find(([suffix]) => lower.endsWith(suffix));
  return hit ? hit[1] : null;
}

/** 标识词干：去掉标识后缀；裸名则整体作为词干（`sku` → `sku`）。 */
function identifierStem(name) {
  const lower = String(name || '').toLowerCase();
  const hit = IDENTIFIER_SUFFIX_SHAPES.find(([suffix]) => lower.endsWith(suffix));
  return hit ? lower.slice(0, -hit[0].length) : lower;
}

/**
 * 解析字段指向哪个业务概念。
 * - `generic_identifier`：词干是 `id`/`no`/`code` 这类泛化名，**归属歧义**；
 * - `multi_concept`：词干同时属于多个概念（别名表本身出现冲突时的守卫）；
 * - `unmapped`：词干可读但不在别名表里（例如 `stock`），既不连也不报歧义。
 */
function resolveConcept(name) {
  const stem = identifierStem(name);
  if (GENERIC_IDENTIFIER_STEMS.has(stem)) return { stem, concepts: [], reason: 'generic_identifier' };
  const concepts = CONCEPT_INDEX.get(stem) || [];
  // 别名表自身出现「一个词干两个概念」时，这里是唯一守卫：报歧义而不是让某一方胜出。
  if (concepts.length > 1) return { stem, concepts, reason: 'multi_concept' };
  if (!concepts.length) return { stem, concepts: [], reason: 'unmapped' };
  return { stem, concepts, reason: null };
}

/** 是否为「标识字段」：带标识后缀，或裸名但**显式登记**为标识名。
 * 裸名不能因为出现在概念别名表里就算标识——概念别名表里的 `result` / `order` / `product`
 * 既可能是标识也可能是普通列名，实测中 `lims.test_result.result` 这类值列会被误判成标识，
 * 于是凭空多出「同义不同名」冲突。裸名一律走这张白名单，不用别名表兜底。 */
const BARE_IDENTIFIER_NAMES = new Set(['sku', 'product', 'lot', 'batch', 'demand', 'store', 'vendor', 'employee', 'id', 'no', 'code', 'key']);
const isIdentityField = (name) => identifierShape(name) !== null || BARE_IDENTIFIER_NAMES.has(String(name || '').toLowerCase());

/**
 * 识别对象标识。三档，**不允许**在没有依据时挑一个字段充数：
 * 1. `primary`：受控词汇表登记的主键，或由对象名派生的 `<object>_id`；
 * 2. `business`：声明中**恰好一个**带 `_no`/`_code`/`_key` 后缀的字段（是否为完整业务键仍需人工确认）；
 * 3. `null`：以上都不成立 → 记入 keyGaps 并给出候选，但**不判定**。
 *
 * 反例（说明为什么必须有「自身概念」这条规则）：`WMS.InboundReceipt` 的声明里有
 * `receipt_id`、`purchase_order_id`、`material_batch_id` 三个代理键字段，没有一个由对象名派生。
 * 若按「第一个 `_id` 字段」处理，恰好在它的例子里选对了；但只要声明顺序换成采购订单号在前，
 * 就会把**外键**当主键，于是整条引用推导都建立在一个错误的主键上——对错取决于字段顺序的规则
 * 不是规则。这里改为按「是否指向对象自身概念」判定。
 */
function inferIdentifier({ objectId, fields, registeredKey }) {
  if (registeredKey && fields.includes(registeredKey)) {
    return { identifier: registeredKey, kind: 'primary', basis: `受控词汇表登记的主键 ${registeredKey}` };
  }
  const expected = `${snakeCase(objectId)}_id`;
  const matched = fields.find((field) => field.toLowerCase() === expected);
  if (matched) return { identifier: matched, kind: 'primary', basis: `由对象名 ${objectId} 派生的主键 ${matched}` };
  // 对象自己的标识必须与该对象自身概念一致——概念不同的标识字段一定是**引用**，不是它的标识。
  // 这条规则同时解决两个实测踩到的问题：
  //   1) `WMS.InboundReceipt` 有 receipt_id / purchase_order_id / material_batch_id 三个代理键，
  //      按「取第一个 _id」会把外键当主键，于是所有引用推导都建立在错误的主键上；
  //   2) `ERP.Inventory` 的 lot_no 是**物料批次的业务键**（引用），若当成库存自己的标识，
  //      它就会凭空变成「物料批次」这一概念的对齐目标，引来一串虚假的跨系统引用。
  const own = objectConceptOf(objectId);
  const selfAgent = own ? fields.filter((field) => identifierShape(field) === 'agent' && resolveConcept(field).concepts[0] === own) : [];
  const selfBusiness = own ? fields.filter((field) => identifierShape(field) === 'business' && resolveConcept(field).concepts[0] === own) : [];
  if (selfAgent.length === 1 && !selfBusiness.length) {
    return { identifier: selfAgent[0], kind: 'primary', basis: `声明中唯一指向 ${own} 的标识字段 ${selfAgent[0]}（命名未派生自对象名）` };
  }
  if (selfBusiness.length === 1 && !selfAgent.length) {
    return { identifier: selfBusiness[0], kind: 'business', basis: `声明中唯一指向 ${own} 的业务键字段 ${selfBusiness[0]}；是否为完整业务键需人工确认` };
  }
  const referenceFields = fields.filter((field) => identifierShape(field));
  const reason = !own
    ? `对象名 ${objectId} 未落到任何已登记概念上，无法判断哪个字段是它自己的标识`
    : selfAgent.length + selfBusiness.length > 1
      ? `指向 ${own} 的标识字段不止一个（${[...selfBusiness, ...selfAgent].join('、')}），无法判定哪个是对象自身标识`
      : `声明中没有指向 ${own} 的标识字段；${referenceFields.join('、') || '（没有任何标识字段）'} 都指向其他概念，属引用而非自身标识`;
  return { identifier: null, kind: null, basis: reason, candidates: [...new Set([...selfBusiness, ...selfAgent, ...referenceFields])] };
}

/** 目标对象的标识形状：主键＝代理键，其余（业务键）＝业务键。 */
const expectedShapeOf = (identifierKind) => (identifierKind === 'primary' ? 'agent' : 'business');

/**
 * 链接的定级（阶段 4d / ADR-019）。**三态**，因为形状有三个取值：
 *
 * - `linkable`：两端形状**都已知且一致**，可按值对齐；
 * - `requires_mapping`：两端形状**都已知且不同**（代理键 ↔ 业务键），必须先建立映射；
 * - `shape_unknown`：**至少一端形状未判定**（`null`，实测来自裸名 `sku` / `product`——
 *   它们在 `BARE_IDENTIFIER_NAMES` 白名单里算标识字段，但没有 `_id` / `_no` / `_code`
 *   这类后缀，命名规则判不出形状）。
 *
 * 第三态是刻意拆出来的：把「未知」并入「不同」会让两种风险相同、**动作完全不同**的事
 * 走同一入口——未知要做的是「先判形状」，不同要做的是「给出映射」。实测 7 条 `requires_mapping`
 * 里有 2 条（`OMS.Order.sku`、`QMS.QualityEvent.product`）其实属于未知：它们被迫填写的
 * 「映射依据」无从谈起，说明文案也写成「两端键形状不同（null / agent）」——读不通。
 */
const linkStatusOf = (fromShape, toShape) => {
  if (!fromShape || !toShape) return 'shape_unknown';
  return fromShape === toShape ? 'linkable' : 'requires_mapping';
};

/**
 * 归属依据的中文说法（阶段 4e / ADR-020）。用来把「这个对象为什么不在本次候选里」说成人话——
 * 只说「不在候选内」会把「系统没选」与「材料没抽到」两件事混成一件。
 */
const GROUNDING_LABELS = Object.freeze({
  proposal_object: '本次候选对象',
  material_owner_candidate: '材料推断的来源（尚未确认）',
  source_system_declaration: '系统配置声明'
});
const groundingLabel = (groundings = []) => [...new Set((groundings || []).map((item) => GROUNDING_LABELS[item] || String(item)))].join(' / ') || '未登记来源';

/**
 * 端点资格（阶段 4e / ADR-020）。**判据与服务端草案校验同源**：都读草案 `objectTypes` 的 id 集
 * （`sanitizeProposalDraft` 里的 `objectIds.has(item.from) && objectIds.has(item.to)`）。
 *
 * 因此「推导层说这条能确认」与「服务端真能写进去」不会分叉——资格不是第二个信号，
 * 而是**同一判据的两次读取**。不可确认的端点必须点名并给出可行动的原因，不能只说「不在范围内」。
 */
const linkEligibilityOf = (candidateObjectIds, fromEndpoint, toEndpoint) => {
  const endpoints = [
    { role: 'from', label: '来源', system: fromEndpoint.system, objectId: fromEndpoint.objectId, groundings: fromEndpoint.groundings },
    { role: 'to', label: '目标', system: toEndpoint.system, objectId: toEndpoint.objectId, groundings: toEndpoint.groundings }
  ].filter((endpoint) => !candidateObjectIds.has(endpoint.objectId))
    .map((endpoint) => ({ role: endpoint.role, system: endpoint.system, objectId: endpoint.objectId, groundings: [...new Set(endpoint.groundings || [])] }));
  if (!endpoints.length) return { eligible: true, ineligibleEndpoints: [], ineligibleReason: null };
  return {
    eligible: false,
    ineligibleEndpoints: endpoints,
    ineligibleReason: endpoints.map((endpoint) => {
      const role = endpoint.role === 'from' ? '来源' : '目标';
      return `${role}对象 ${endpoint.system}.${endpoint.objectId} 的依据是${groundingLabel(endpoint.groundings)}，不是本次候选对象，无法并入草稿；如需并入，请先让 ${endpoint.objectId} 成为本次候选对象。`;
    }).join(' ')
  };
};

/** 「为什么两个键能对上」的分类。机器不判对错，只要求人从这四类里选一个（ADR-019 决策 3）。 */
const SHAPE_VALUES = Object.freeze(['agent', 'business']);

/**
 * 声明的稳定身份：`${系统}.${对象}@${grounding}`。
 *
 * 同一个对象在同一系统里可能被**多处**声明（受控词汇表 + 已配置映射 + 材料抽取），
 * grounding 正是区分它们的维度。阶段 4c 第三段的裁定按声明集合给出，因此这个 key
 * 必须稳定且可读——它同时也是「这条声明去哪了」的唯一追查线索。
 */
const declarationKeyOf = (declaration) => `${declaration.system}.${declaration.objectId}@${declaration.grounding}`;

/** 把提案候选对象与既有系统声明统一成「声明」列表，供字段目录与冲突分析使用。 */
function collectDeclarations({ objects = [], systems = [] }) {
  const declarations = [];
  const seen = new Set();
  // 同一 (系统, 对象, grounding) 只登记一次：`sourceSystems` 里出现重复系统码时会产出
  // 内容完全相同、declarationKey 也相同的两条声明，那会让「声明数」虚增，
  // 也会让按声明的严格划分校验把同一个声明当成两个。
  const push = (declaration) => {
    const key = declarationKeyOf(declaration);
    if (seen.has(key)) return;
    seen.add(key);
    declarations.push({ ...declaration, declarationKey: key });
  };
  // `systems` 是**严格白名单**：空数组表示「本次没有任何系统在范围内」，
  // 而不是「不限系统」。范围一律由调用方显式给出（ADR-012），此处不得自行放宽。
  const inScope = (code) => systems.includes(code);
  for (const object of objects) {
    const fields = (object.fields || []).map(String);
    if (!object.id || !fields.length) continue;
    const confirmed = (object.sourceSystems || []).filter((item) => item && item !== 'UNASSIGNED');
    for (const code of confirmed) {
      if (!inScope(code)) continue;
      push({
        objectId: object.id, label: object.label || object.id, source: object.source || null, system: code,
        fields, grounding: 'proposal_object', registeredKey: object.key || null, sourceBasis: 'confirmed'
      });
    }
    // 阶段 4c 第二段（ADR-017 决策 4）：归属**候选**也进目录——不进的话，非结构化材料抽取出的对象
    // 在字段目录里根本不存在，跨系统标识对应恒为 0 条，阶段 4「跨系统连接」在材料路径上完全落空。
    // 与已确认来源并存时不再登记候选：已确认是事实，事实优先，且两者同时进目录会产生虚假的
    // `declaration_divergence`（同一对象在同一系统里出现两条「声明」）。
    if (!confirmed.length) {
      for (const code of (object.candidateSourceSystems || []).map((item) => String(item || '').toUpperCase()).filter(Boolean)) {
        if (!inScope(code)) continue;
        push({
          objectId: object.id, label: object.label || object.id, source: object.source || null, system: code,
          fields, grounding: 'material_owner_candidate', registeredKey: object.key || null,
          sourceBasis: 'material_owner_candidate', sourceEvidence: object.candidateSourceEvidence || null
        });
      }
    }
  }
  for (const configuration of systemConfigurations) {
    const code = String(configuration.systemId || '').toUpperCase();
    if (!inScope(code)) continue;
    for (const mapping of configuration.mapping || []) {
      const fields = splitFields(mapping.fields);
      if (!mapping.object || !fields.length) continue;
      push({
        objectId: mapping.object, label: mapping.object, source: mapping.source || null, system: code,
        fields, grounding: 'source_system_declaration', registeredKey: null, sourceBasis: 'confirmed'
      });
    }
  }
  return declarations;
}

/**
 * 同名声明不一致的分歧项（阶段 4c 第三段）。**唯一事实源**：冲突上报与裁定校验都读它，
 * 两处各写一套「哪些声明算一个分歧项」迟早会分叉。
 *
 * 两种粒度：
 * - `scope: 'object'`：同一个对象名被**不同系统**声明，字段集不一致（同名不同义）；
 * - `scope: 'source'`：**同一张表**被两处声明，字段集不一致（受控词汇表 vs 已配置映射）。
 *
 * 每一项都带稳定 `key`（裁定以此为准）与组成它的**声明清单**（严格划分按它对账）。
 */
function declarationDivergenceItems(declarations) {
  const items = [];
  const byDeclarationKey = (left, right) => left.declarationKey.localeCompare(right.declarationKey);
  const byObject = new Map();
  const bySource = new Map();
  for (const declaration of declarations) {
    if (!byObject.has(declaration.objectId)) byObject.set(declaration.objectId, []);
    byObject.get(declaration.objectId).push(declaration);
    if (declaration.source) {
      if (!bySource.has(declaration.source)) bySource.set(declaration.source, []);
      bySource.get(declaration.source).push(declaration);
    }
  }
  for (const [objectId, group] of [...byObject].sort((left, right) => left[0].localeCompare(right[0]))) {
    const systemsInvolved = [...new Set(group.map((item) => item.system))].sort();
    const shapes = new Set(group.map((item) => [...item.fields].sort().join(',')));
    if (systemsInvolved.length < 2 || shapes.size < 2) continue;
    items.push({
      key: `object:${objectId}`, scope: 'object', objectId, source: null, systems: systemsInvolved,
      reason: `对象名 ${objectId} 被 ${systemsInvolved.join('、')} 同时声明，但字段集不一致；同名不等于同一实体，需人工裁定是合并还是区分粒度`,
      declarations: group.map(declarationShape).sort(byDeclarationKey)
    });
  }
  for (const [source, group] of [...bySource].sort((left, right) => left[0].localeCompare(right[0]))) {
    const shapes = new Set(group.map((item) => [...item.fields].sort().join(',')));
    if (shapes.size < 2) continue;
    items.push({
      key: `source:${group[0].objectId}@${source}`, scope: 'source', objectId: group[0].objectId, source,
      systems: [...new Set(group.map((item) => item.system))].sort(),
      reason: `同一张表 ${source} 在两处声明中的字段集不一致；受控词汇表与已配置映射必须核对后再建模`,
      declarations: group.map(declarationShape).sort(byDeclarationKey)
    });
  }
  return items;
}

/**
 * 把裁定翻译成「声明 → 生效对象名」的映射。**只做翻译，不做校验**（校验在
 * `resolveDeclarationRulings` 里完成，那里才拿得到当前分歧事实）。
 * - 未裁定 / `merge`：沿用声明的原对象名（即并集）；
 * - `distinct`：按组给出对象名；`drop` 的组其声明直接不进目录。
 */
function resolveDeclarationComposition(rulings) {
  const nameOf = new Map();
  const dropped = new Set();
  const rulingKeyOf = new Map();
  const distinctKeys = new Set();
  for (const ruling of rulings) {
    if (ruling?.ruling !== 'distinct' || !Array.isArray(ruling.groups)) continue;
    distinctKeys.add(ruling.key);
    for (const group of ruling.groups) {
      for (const declarationKey of group.declarations || []) {
        rulingKeyOf.set(declarationKey, ruling.key);
        if (group.drop) { dropped.add(declarationKey); continue; }
        nameOf.set(declarationKey, group.name);
      }
    }
  }
  return { nameOf, dropped, rulingKeyOf, distinctKeys };
}

/** 只被其中**一处**声明列出的字段。并集最容易骗人的地方就在这里：「这 7 个字段」里每一个的出处都不同。 */
const exclusiveFieldsOf = (declarations) => {
  const counts = new Map();
  for (const declaration of declarations) {
    for (const field of new Set(declaration.fields)) counts.set(field, (counts.get(field) || 0) + 1);
  }
  return [...counts].filter(([, count]) => count === 1).map(([field]) => field).sort();
};

// 有标识的对象排前（人工核对时先看能连的），其余保持字典序。
const objectsInOrder = (items) => [...items].sort((left, right) => Number(Boolean(right.identifier)) - Number(Boolean(left.identifier)) || left.objectId.localeCompare(right.objectId));

/**
 * 构建按来源系统分组的字段目录。
 *
 * 口径说明：目录按**所选系统登记**，不按材料是否命中裁剪——它是「范围内的系统声明了什么」，
 * 与「本次材料提到了什么对象」是两个问题。对象本身仍按材料与范围生成（见 ADR-013）。
 *
 * 阶段 4c 第三段（ADR-018）：同一系统内同一 `objectId` 的多处声明**默认取字段并集**——
 * 这个默认动作过去完全不可见，且并集会参与标识识别，于是产出一个**谁也没声明过的复合体**
 * （实测：`MES.ProductionBatch` 被并集授予 `production_batch_id`，而它的配置映射只声明 `batch_no`）。
 * 现在三件事同时成立：
 *   1. 并集必须**披露**（`declarations` / `exclusiveFields` / `declarationState`）；
 *   2. `merge` 裁定把并集变成**显式结论**；
 *   3. `distinct` 裁定**不并集**——按组拆分，各自识别标识。
 */
export function buildSystemFieldCatalog({ objects = [], systems = [], declarationRulings = [] } = {}) {
  const declarations = collectDeclarations({ objects, systems });
  const composition = resolveDeclarationComposition(declarationRulings);
  const bySystem = new Map();
  for (const declaration of declarations) {
    // `distinct` + `drop` 的声明不进目录。它不会静默消失——`declarationReport.droppedDeclarations` 必须列出。
    if (composition.dropped.has(declaration.declarationKey)) continue;
    const effectiveName = composition.nameOf.get(declaration.declarationKey) || declaration.objectId;
    if (!bySystem.has(declaration.system)) bySystem.set(declaration.system, new Map());
    const entries = bySystem.get(declaration.system);
    // 同一对象在同一系统内可能有多条声明（受控词汇表 + 配置映射）；字段取并集，但两者都会被
    // declaration_divergence 检查，且**逐条记进 `declarations`**——合并不得掩盖出处。
    const existing = entries.get(effectiveName);
    if (existing) {
      for (const field of declaration.fields) if (!existing.fields.includes(field)) existing.fields.push(field);
      if (!existing.groundings.includes(declaration.grounding)) existing.groundings.push(declaration.grounding);
      existing.registeredKey = existing.registeredKey || declaration.registeredKey;
      existing.sourceEvidence ||= declaration.sourceEvidence || null;
      existing.declarations.push(declarationShape(declaration));
      continue;
    }
    entries.set(effectiveName, {
      objectId: effectiveName, declaredObjectId: declaration.objectId, label: declaration.label, source: declaration.source,
      groundings: [declaration.grounding], registeredKey: declaration.registeredKey, fields: [...declaration.fields],
      sourceEvidence: declaration.sourceEvidence || null, declarations: [declarationShape(declaration)],
      rulingKeys: [composition.rulingKeyOf.get(declaration.declarationKey)].filter(Boolean)
    });
  }
  const catalog = [];
  for (const code of [...bySystem.keys()].sort()) {
    const objectsInSystem = [...bySystem.get(code).values()].map((entry) => {
      // 标识判据（`<对象名>_id` 与「自身概念」）一律按**声明的原名**推导：裁定改名说的是
      // 「与别处声明不是同一个对象」，不是「这个声明换了名字」，所以判据不跟着改。
      const identity = inferIdentifier({ objectId: entry.declaredObjectId, fields: entry.fields, registeredKey: entry.registeredKey });
      // 来源依据只由 grounding 推导（不另存一份状态）：只要有一条非候选声明，归属就是已确认的。
      // 候选与已确认同时出现是真实情形——对象 X 已在系统声明里（事实），材料里抽出的 X 又带候选归属。
      const sourceBasis = entry.groundings.some((item) => item !== 'material_owner_candidate') ? 'confirmed' : 'material_owner_candidate';
      const rulingKeys = [...new Set(entry.rulingKeys)];
      // 「复合条目」的判据必须是**各处声明确有分歧**，而不只是「有多处声明」：
      // 两处声明字段集完全一致时，并集等于各自声明，既没有复合体、也没有需要裁定的分歧。
      // 只看声明条数会把这种情况也算进「有几个并集条目没人看过」，虚增运营要处理的工作量。
      const fieldSignatures = new Set(entry.declarations.map((declaration) => [...declaration.fields].sort().join(',')));
      const divergent = fieldSignatures.size > 1;
      const declarationState = rulingKeys.length
        ? (rulingKeys.some((key) => composition.distinctKeys.has(key)) ? 'split' : 'merged')
        : (divergent ? 'merged_unruled' : null);
      const mergedFrom = entry.declarations.length;
      return {
        objectId: entry.objectId, declaredObjectId: entry.declaredObjectId, label: entry.label, source: entry.source,
        groundings: entry.groundings,
        sourceBasis, sourceEvidence: sourceBasis === 'material_owner_candidate' ? entry.sourceEvidence : null,
        identifier: identity.identifier, identifierKind: identity.kind,
        // 未裁定的并集必须在依据里说出来：否则「这个标识是并集授予的」就又要靠人去比对字段。
        identifierBasis: declarationState === 'merged_unruled'
          ? `${identity.basis}（该字段集由 ${mergedFrom} 处声明取并集，尚未裁定「合并 / 区分粒度」）`
          : identity.basis,
        identifierCandidates: identity.candidates || [],
        // 并集披露：组成这个条目的每处声明，以及只被其中一处列出的字段。
        declarations: entry.declarations, exclusiveFields: divergent ? exclusiveFieldsOf(entry.declarations) : [],
        declarationState,
        fields: entry.fields.map((name) => {
          const concept = resolveConcept(name);
          return { name, shape: identifierShape(name), stem: concept.stem, concept: concept.concepts[0] || null, identity: isIdentityField(name) };
        })
      };
    });
    catalog.push({ code, objects: objectsInOrder(objectsInSystem) });
  }
  return catalog;
}

/**
 * 等价类：概念 → Map(字段名 → 组号)。只有 `distinct_entity` 裁定会产生它。
 * 裁定的语义是「该概念下的字段名被划成若干互不等价的实体」，于是**跨组对齐不成立**。
 */
const buildEquivalenceIndex = (rulings) => {
  const index = new Map();
  for (const ruling of rulings) {
    if (ruling.ruling !== 'distinct_entity' || !Array.isArray(ruling.groups)) continue;
    const groups = new Map();
    ruling.groups.forEach((group, position) => group.forEach((field) => groups.set(field, position)));
    index.set(ruling.concept, groups);
  }
  return index;
};

/**
 * 推导跨系统标识对应与冲突。返回值全部是**上报口径**，不修改任何草稿对象或关系。
 *
 * 两类裁定（都已规范化并校验过）各做一件事，互不越界：
 * - `rulings`（等价裁定，阶段 4c 第一段）：决定**哪些链接成立**；`distinct_entity` 下跨等价类的
 *   字段名对不再产生链接，而是进入 `withdrawnLinks`；
 * - `declarationRulings`（同名声明裁定，阶段 4c 第三段）：决定**字段目录的组成**（并集还是拆分），
 *   从而决定链接是在哪份字段集上推导出来的。
 */
export function deriveIdentityLinking({ objects = [], systems = [], rulings = [], declarationRulings = [] } = {}) {
  const scope = [...new Set((systems || []).map((code) => String(code || '').toUpperCase()).filter(Boolean))];
  // 阶段 4e（ADR-020）：资格判据的唯一事实源。与服务端草案校验读**同一个数组**（本函数的 `objects`
  // 就是草案的 `objectTypes`），因此「说得出可确认」与「写得进草稿」不可能分叉。
  const candidateObjectIds = new Set((objects || []).map((object) => String(object?.id || '')).filter(Boolean));
  const fieldCatalog = buildSystemFieldCatalog({ objects, systems: scope, declarationRulings });
  const declarations = collectDeclarations({ objects, systems: scope });
  const divergenceItems = declarationDivergenceItems(declarations);
  const rulingByItem = new Map(declarationRulings.map((ruling) => [ruling.key, ruling]));
  const equivalence = buildEquivalenceIndex(rulings);
  const rulingOfConcept = new Map(rulings.map((ruling) => [ruling.concept, ruling.ruling]));

  const conflicts = [];
  const keyGaps = [];
  const endpoints = [];
  const withdrawnLinks = [];

  for (const entry of fieldCatalog) {
    for (const object of entry.objects) {
      endpoints.push({
        system: entry.code, objectId: object.objectId, source: object.source,
        identifier: object.identifier, identifierKind: object.identifierKind,
        concept: object.identifier ? resolveConcept(object.identifier).concepts[0] || null : null,
        groundings: object.groundings, sourceBasis: object.sourceBasis
      });
      if (!object.identifier) keyGaps.push({
        system: entry.code, objectId: object.objectId,
        candidates: object.identifierCandidates, reason: object.identifierBasis
      });
    }
  }

  // 冲突 1：标识归属歧义——字段名归一化后无法说明它指向哪个业务实体。
  const ambiguousSeen = new Set();
  for (const entry of fieldCatalog) {
    for (const object of entry.objects) {
      for (const field of object.fields) {
        if (!field.identity) continue;
        const concept = resolveConcept(field.name);
        if (!concept.reason || concept.reason === 'unmapped') continue;
        const signature = `${field.name}:${concept.reason}`;
        if (ambiguousSeen.has(signature)) continue;
        ambiguousSeen.add(signature);
        conflicts.push({
          kind: 'ambiguous_identifier', blocksLink: true, field: field.name, stem: concept.stem,
          reason: concept.reason === 'generic_identifier'
            ? `字段名 ${field.name} 是泛化标识，无法判断它指向哪个业务实体`
            : `词干 ${concept.stem} 同时对应 ${concept.concepts.join('、')}，归属需要人工判定`,
          candidates: concept.concepts,
          occurrences: occurrencesOf(fieldCatalog, field.name)
        });
      }
    }
  }

  // 冲突 2：同义不同名——同一概念由多个字段名表达。这不是错误，但跨系统对接前必须确认是同一实体。
  // 冲突 3：键形状不可对齐——同一概念上代理键与业务键混用，跨系统不能直接按值连接。
  const byConcept = new Map();
  for (const entry of fieldCatalog) {
    for (const object of entry.objects) {
      for (const field of object.fields) {
        if (!field.identity) continue;
        const concept = resolveConcept(field.name);
        if (concept.reason) continue;
        const key = concept.concepts[0];
        if (!byConcept.has(key)) byConcept.set(key, new Map());
        const fields = byConcept.get(key);
        if (!fields.has(field.name)) fields.set(field.name, { shape: field.shape, occurrences: [] });
        fields.get(field.name).occurrences.push(`${entry.code}.${object.objectId}.${field.name}`);
      }
    }
  }
  for (const [concept, fields] of [...byConcept].sort((left, right) => left[0].localeCompare(right[0]))) {
    const names = [...fields.keys()].sort();
    if (names.length > 1) {
      // 裁定不消除冲突本身：「声明里确实有 N 个字段名」是事实，裁定只说明人怎么看它。
      // 把冲突抹掉会让运营以为声明被改过了。
      const ruling = rulingOfConcept.get(concept) || null;
      const rulingNote = ruling === 'same_entity'
        ? '已由人工裁定为同一业务实体，这些字段名视为同一实体的标识。'
        : ruling === 'distinct_entity'
          ? `已由人工裁定为不同实体，按 ${(equivalence.get(concept) ? Math.max(...equivalence.get(concept).values()) + 1 : 0)} 个等价类划分，跨组对齐不成立。`
          : '';
      conflicts.push({
        kind: 'alias_divergence', blocksLink: false, concept, ruling,
        reason: `同一业务实体在声明里由 ${names.length} 个字段名表达，跨系统对接前必须确认它们指向同一个实体。${rulingNote}`,
        fields: names.map((name) => ({ name, shape: fields.get(name).shape, occurrences: fields.get(name).occurrences }))
      });
    }
    const agentNames = names.filter((name) => fields.get(name).shape === 'agent');
    const businessNames = names.filter((name) => fields.get(name).shape === 'business');
    if (agentNames.length && businessNames.length) {
      conflicts.push({
        kind: 'key_shape_incompatible', blocksLink: false, concept,
        reason: `${concept} 上同时存在代理键（${agentNames.join('、')}）与业务键（${businessNames.join('、')}）；跨系统按值连接不成立，必须先建立标识映射`,
        agent: agentNames, business: businessNames
      });
    }
  }

  // 冲突 4：同名声明不一致——同一对象名/同一张表在两处声明里字段集不同。
  // 项目清单来自 `declarationDivergenceItems`（与裁定校验同一事实源），逐项带稳定 `key` 与裁定状态。
  for (const item of divergenceItems) {
    const ruling = rulingByItem.get(item.key) || null;
    // 裁定**不消除冲突本身**：「声明里确实有两份不同字段集」是事实，裁定只说明人怎么看它。
    const keptGroups = (ruling?.groups || []).filter((group) => !group.drop);
    const droppedGroups = (ruling?.groups || []).filter((group) => group.drop);
    const rulingNote = ruling?.ruling === 'merge'
      ? '已由人工裁定为**同一个对象**，字段并集成立（这不再是一个默认动作，而是一条结论）。'
      : ruling?.ruling === 'distinct'
        ? `已由人工裁定为**不同对象**：按 ${keptGroups.length} 个对象建模${droppedGroups.length ? `，另有 ${droppedGroups.length} 组声明被显式排除` : ''}，字段不再取并集。`
        : '';
    conflicts.push({
      kind: 'declaration_divergence', blocksLink: false, key: item.key, scope: item.scope, objectId: item.objectId,
      ...(item.source ? { source: item.source } : {}), systems: item.systems, ruling: ruling?.ruling || null,
      reason: `${item.reason}${rulingNote ? ` ${rulingNote}` : ''}`,
      declarations: item.declarations
    });
  }

  // 跨系统标识对应：A 的标识字段指向概念 C，B 的标识也指向 C，且两者来自不同系统。
  const links = [];
  const linked = new Set();
  const withdrawnSeen = new Set();
  for (const entry of fieldCatalog) {
    for (const object of entry.objects) {
      for (const field of object.fields) {
        if (!field.identity || field.name === object.identifier) continue;
        const concept = resolveConcept(field.name);
        if (concept.reason) continue;
        for (const target of endpoints) {
          if (target.concept !== concept.concepts[0] || target.system === entry.code) continue;
          const signature = `${concept.concepts[0]}:${entry.code}.${object.objectId}.${field.name}->${target.system}.${target.objectId}`;
          if (linked.has(signature) || withdrawnSeen.has(signature)) continue;
          // 裁定为不同实体后，跨等价类的对齐不成立：这条链接**不再存在**，而不是「存在但标注可疑」。
          // 保留一条已知不成立的边等于给它留了采纳入口——与 ADR-015 决策 4（不允许「确认但无依据」）同一立场。
          const groups = equivalence.get(concept.concepts[0]);
          if (groups && groups.get(field.name) !== groups.get(target.identifier)) {
            withdrawnSeen.add(signature);
            withdrawnLinks.push({
              key: signature, concept: concept.concepts[0], field: field.name,
              from: `${entry.code}.${object.objectId}.${field.name}`,
              to: `${target.system}.${target.objectId}.${target.identifier}`,
              reason: `人工裁定 ${concept.concepts[0]} 下的 ${field.name} 与 ${target.identifier} 属不同实体（第 ${(groups.get(field.name) ?? -1) + 1} / 第 ${(groups.get(target.identifier) ?? -1) + 1} 个等价类），对齐不成立。`
            });
            continue;
          }
          linked.add(signature);
          // 覆盖判定：任一端对象的归属是「材料推断」时整条链接都要标出来。
          // 否则界面会把一条「一端归属还没人确认」的对应与两条都已确认的对应长得一模一样。
          const sourceInferred = object.sourceBasis === 'material_owner_candidate' || target.sourceBasis === 'material_owner_candidate';
          // 阶段 4e（ADR-020）：两个**不同**的问题分开答，不再用一个 flag 承载两件事——
          //   `eligible`          → 这条对应能不能并入本次草稿（判据与服务端草案校验同源）；
          //   `declarationSourced`→ 这条对应的**依据**来自系统配置声明，而不是本次候选对象（只影响依据说明）。
          // 合并的代价实测过：旧 `notInProposal` 用声明 grounding 冒充资格，把 `ERP.Inventory.lot_no`
          // （**实测可确认**，因为对象名 `Inventory` 与候选对象同名）标成「来源系统未进入候选对象」——
          // 界面上一句事实错误，且 5 条「不可确认」里 4 条才是真的。
          const eligibility = linkEligibilityOf(candidateObjectIds,
            { system: entry.code, objectId: object.objectId, groundings: object.groundings },
            { system: target.system, objectId: target.objectId, groundings: target.groundings });
          links.push({
            // 稳定 key：确认集合以它为准（`signature` 已在上面用于去重，这里复用同一字符串，
            // 避免出现「两条字符串描述同一链接」的第二种格式）。
            key: signature,
            concept: concept.concepts[0], field: field.name,
            from: { system: entry.code, objectId: object.objectId, field: field.name, shape: field.shape, source: object.source, sourceBasis: object.sourceBasis },
            to: { system: target.system, objectId: target.objectId, field: target.identifier, shape: expectedShapeOf(target.identifierKind), source: target.source, sourceBasis: target.sourceBasis },
            cardinality: 'n:1',
            // 代理键指向业务键（或反之）不能按值对齐，必须经映射表——这与「同名字段就视作同一实体」是两回事。
            // **三态**而非二态：形状未知（裸名）既不是「可按值对齐」，也不是「已知不同」，见 ADR-019。
            status: linkStatusOf(field.shape, expectedShapeOf(target.identifierKind)),
            // 这条链接的等价前提是否被人看过（阶段 4c）：`null` 表示未裁定，是最需要被看见的状态。
            ruling: rulingOfConcept.get(concept.concepts[0]) || null,
            sourceInferred,
            ...eligibility,
            declarationSourced: !object.groundings.includes('proposal_object'),
            evidence: `${entry.code}.${object.objectId}.${field.name} → ${target.system}.${target.objectId}.${target.identifier}`
          });
        }
      }
    }
  }

  // 范围内被引用、但没有任何对象以该概念为标识：多半是漏选了系统，必须说清而不是留空。
  const resolvableConcepts = new Set(endpoints.map((endpoint) => endpoint.concept).filter(Boolean));
  const unresolvedReferences = [];
  const unresolvedSeen = new Set();
  for (const entry of fieldCatalog) {
    for (const object of entry.objects) {
      for (const field of object.fields) {
        if (!field.identity || field.name === object.identifier) continue;
        const concept = resolveConcept(field.name);
        if (concept.reason || resolvableConcepts.has(concept.concepts[0])) continue;
        const signature = `${field.name}:${concept.concepts[0]}`;
        if (unresolvedSeen.has(signature)) continue;
        unresolvedSeen.add(signature);
        unresolvedReferences.push({
          concept: concept.concepts[0], field: field.name, system: entry.code, objectId: object.objectId,
          reason: `本次范围内引用了 ${concept.concepts[0]}，但没有任何已选系统的对象以它为标识；可能是漏选系统或该对象未进入候选`
        });
      }
    }
  }

  const linkCount = links.length;
  // 仍有等价分歧、且没人裁定过的概念：这是「有多少条链接的前提还没被看过」的直接答案，
  // 必须单独成为一项口径，而不是靠运营从 14 条冲突里自己数。
  const unresolvedConcepts = conflicts.filter((item) => item.kind === 'alias_divergence' && !item.ruling).map((item) => item.concept);
  const settledConcepts = [...new Set(rulings.map((ruling) => ruling.concept))];
  // 仍未裁定的同名声明分歧项：这是「还有多少个复合条目没人看过」的直接答案（与上一项同一纪律）。
  const unresolvedDeclarationItems = divergenceItems.filter((item) => !rulingByItem.has(item.key)).map((item) => item.key);
  // 拆分与排除必须可读地列出来：对象名变了（或某份声明没了）而界面上没有一句解释，
  // 运营只会看到「对象少了一个 / 链接少了一条」。
  const splitObjects = [];
  const droppedDeclarations = [];
  for (const item of divergenceItems) {
    const ruling = rulingByItem.get(item.key);
    if (ruling?.ruling !== 'distinct') continue;
    const declarationByKey = new Map(item.declarations.map((declaration) => [declaration.declarationKey, declaration]));
    const kept = [];
    for (const group of ruling.groups || []) {
      if (group.drop) {
        for (const declarationKey of group.declarations) {
          const declaration = declarationByKey.get(declarationKey);
          if (!declaration) continue;
          droppedDeclarations.push({
            declarationKey, system: declaration.system, source: declaration.source, grounding: declaration.grounding,
            reason: `人工裁定 ${item.key} 为不同对象时被显式排除；它的字段不再进入系统 ${declaration.system} 的字段目录。`
          });
        }
        continue;
      }
      kept.push({
        name: group.name,
        declarations: [...group.declarations].sort(),
        systems: [...new Set(group.declarations.map((key) => declarationByKey.get(key)?.system).filter(Boolean))].sort()
      });
    }
    splitObjects.push({ key: item.key, scope: item.scope, from: item.objectId, source: item.source || null, into: kept });
  }
  return {
    systems: scope,
    fieldCatalog,
    links: links.sort((left, right) => left.evidence.localeCompare(right.evidence)).slice(0, 200),
    // 被裁定撤下的链接必须可读地列出：「上一版 4 条、这一版 2 条」的原因不能靠猜。
    withdrawnLinks: withdrawnLinks.slice(0, 200),
    conflicts: conflicts.sort((left, right) => left.kind.localeCompare(right.kind) || String(left.field || left.concept || left.objectId).localeCompare(String(right.field || right.concept || right.objectId))),
    keyGaps,
    unresolvedReferences: unresolvedReferences.slice(0, 20),
    rulingReport: {
      applied: settledConcepts.map((concept) => ({ concept, ruling: rulingOfConcept.get(concept) })),
      unresolvedConcepts,
      // 继承的裁定失去对应冲突时由调用方填入（本函数只看到「生效的裁定」）。
      droppedStale: []
    },
    declarationReport: {
      applied: declarationRulings
        .filter((ruling) => divergenceItems.some((item) => item.key === ruling.key))
        .map((ruling) => ({ key: ruling.key, ruling: ruling.ruling, groups: ruling.groups || null })),
      splitObjects,
      droppedDeclarations,
      unresolvedItems: unresolvedDeclarationItems,
      // 「因拆分 / 改名而不再存在的链接」需要与**基线**对比才知道，由调用方在能对比时填入
      // （与 `rulingReport.droppedStale` 同一惯例：本函数只看到「生效的裁定」）。
      droppedLinks: [],
      droppedStale: []
    },
    summary: {
      systems: scope.length,
      objects: fieldCatalog.reduce((total, entry) => total + entry.objects.length, 0),
      identityFields: new Set(fieldCatalog.flatMap((entry) => entry.objects).flatMap((object) => object.fields.filter((field) => field.identity).map((field) => field.name))).size,
      links: linkCount,
      linkable: links.filter((link) => link.status === 'linkable').length,
      requiresMapping: links.filter((link) => link.status === 'requires_mapping').length,
      // 「形状未判定」必须与「形状不同」分开计数：两者的风险等级相同，但人要做的事完全不同
      // （未知＝先判形状，不同＝给出结构化映射）。合并计数会让运营按错误的方式处理其中一类。
      shapeUnknown: links.filter((link) => link.status === 'shape_unknown').length,
      // 阶段 4e（ADR-020）：资格是**独立口径**。不看这两项，运营只能拿「11 条对应」减去自己
      // 试出来的失败数去反推有几条用不了——而「哪几条、为什么、怎么办」都无从得知。
      eligible: links.filter((link) => link.eligible).length,
      ineligible: links.filter((link) => !link.eligible).length,
      conflicts: conflicts.length,
      keyGaps: keyGaps.length,
      unresolvedReferences: unresolvedReferences.length,
      ruledConcepts: settledConcepts.length,
      withdrawnLinks: withdrawnLinks.length,
      unresolvedAliasConcepts: unresolvedConcepts.length,
      // 归属由材料推断（尚未经人确认）的对象数，以及有多少条链接的某一端站在这种归属上。
      // 这两项必须独立可见：否则「一端归属还是推断」的对应会与两端都已确认的对应长得一样。
      inferredSourceObjects: fieldCatalog.flatMap((entry) => entry.objects).filter((object) => object.sourceBasis === 'material_owner_candidate').length,
      inferredSourceLinks: links.filter((link) => link.sourceInferred).length,
      // 同名声明分歧与「仍由并集构成的复合条目」的规模：未裁定数不是内部状态，是运营要看的口径。
      declarationDivergences: divergenceItems.length,
      unresolvedDeclarationItems: unresolvedDeclarationItems.length,
      ruledDeclarationItems: declarationRulings.filter((ruling) => divergenceItems.some((item) => item.key === ruling.key)).length,
      splitObjects: splitObjects.length,
      droppedDeclarations: droppedDeclarations.length,
      mergedUnruledObjects: fieldCatalog.flatMap((entry) => entry.objects).filter((object) => object.declarationState === 'merged_unruled').length,
      policy: '标识对应来自字段名归一化与显式登记的事务概念别名表，属**假设**，不自动并入草稿关系；合并前需人工确认。支撑对应的等价前提（同义不同名）须先经人工裁定（阶段 4c）。对象归属来自材料原文推断，属**候选**，确认前不写入来源系统、不参与范围裁剪（阶段 4c 第二段）。同一对象在同一系统被多处声明时**默认取字段并集**，该并集必须逐处披露（`declarations` / `exclusiveFields`），并须经人工裁定「合并 / 区分粒度」（阶段 4c 第三段）。链接定级为**三态**：`linkable`（形状一致）/ `requires_mapping`（形状都已知且不同，须给结构化映射定义）/ `shape_unknown`（至少一端形状未判定，须先判形状并据此重定级）——「未知」不得并入「不同」（阶段 4d / ADR-019）。可确认性另由 `eligible` 单独判定：**两端对象都必须在本次候选对象内**（判据与服务端草案校验同源）；不可确认的对应**仍然列出**并带可行动原因，不得隐藏（阶段 4e / ADR-020）。'
    },
    // 录入界面用的枚举：由服务端给出，避免前端各存一份（新增一类依据就要改两处）。
    keyMappingOptions: {
      bases: Object.entries(KEY_MAPPING_BASES).map(([value, label]) => ({ value, label })),
      shapes: SHAPE_VALUES.map((value) => ({ value, label: value === 'agent' ? '代理键' : '业务键' }))
    }
  };
}

const declarationShape = (declaration) => ({
  declarationKey: declaration.declarationKey, system: declaration.system, source: declaration.source,
  grounding: declaration.grounding, fields: declaration.fields
});

const occurrencesOf = (fieldCatalog, fieldName) => fieldCatalog.flatMap((entry) => entry.objects
  .filter((object) => object.fields.some((field) => field.name === fieldName))
  .map((object) => `${entry.code}.${object.objectId}.${fieldName}`)).slice(0, 12);

const RULING_ACTIONS = Object.freeze(['same_entity', 'distinct_entity']);
const MAX_IDENTITY_CONFLICT_RULINGS = 40;
const cleanRulingText = (value, maxLength) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);

/**
 * 规范化并校验「标识等价裁定」请求（阶段 4c）。
 *
 * 只裁定 `alias_divergence`（同义不同名）：一个概念在声明里由多个字段名表达，人先回答
 * 「它们是不是同一个实体」，再谈跨系统对齐。另外三类冲突的裁定粒度与作用面各不相同，
 * 不在本函数范围内（见 ADR-016）。
 *
 * 返回值沿用 ADR-015 对确认集合的口径：
 * - `entries`：可应用的裁定（含 `explicit` 标志）；
 * - `unknown`：当前冲突里找不到对应概念。**显式提交的**由调用方升级为硬错误，
 *   **继承的**由调用方记入 `rulingReport.droppedStale`——静默丢弃会让「我裁定过它，怎么没了」无从追问。
 */
export function resolveIdentityConflictRulings({ conflicts = [], inherited = [], requested }) {
  // 只有存在 alias_divergence 的概念可以裁定。只有一个字段名时既没有分歧、也没有可声明的等价关系，
  // 把它记成「已生效的裁定」只会让报告虚增，并与「有多少前提还没被看过」这项口径相互污染。
  const concepts = new Map();
  for (const conflict of conflicts) {
    if (conflict.kind !== 'alias_divergence' || !conflict.concept) continue;
    concepts.set(conflict.concept, (conflict.fields || []).map((field) => String(field?.name || '')).filter(Boolean));
  }
  if (requested === undefined || requested === null) {
    // 省略 ≠ 清空：省略表示本次不调整（保持既有裁定），空数组才是撤销全部。
    const entries = [];
    const unknown = [];
    for (const item of inherited) {
      if (!item?.concept) continue;
      (concepts.has(item.concept) ? entries : unknown).push({ concept: item.concept, ruling: item.ruling, groups: item.groups || null, explicit: false });
    }
    return { entries, unknown };
  }
  if (!Array.isArray(requested)) return { error: '标识等价裁定必须是数组；空数组表示撤销全部裁定。', code: 'SEMANTIC_IDENTITY_RULING_INVALID' };
  if (requested.length > MAX_IDENTITY_CONFLICT_RULINGS) return { error: `单次提交的标识等价裁定不能超过 ${MAX_IDENTITY_CONFLICT_RULINGS} 条。`, code: 'SEMANTIC_IDENTITY_RULING_INVALID' };
  const entries = [];
  const unknown = [];
  const seen = new Set();
  for (const raw of requested) {
    const concept = cleanRulingText(typeof raw === 'string' ? raw : raw?.concept, 64);
    // 只写概念名等价于「确认它们是同一实体」——这是最常见的一种裁定，允许简写。
    const ruling = cleanRulingText(typeof raw === 'string' ? 'same_entity' : raw?.ruling, 32);
    if (!concept) return { error: '每条标识等价裁定都必须给出概念名。', code: 'SEMANTIC_IDENTITY_RULING_INVALID' };
    if (!RULING_ACTIONS.includes(ruling)) return { error: `标识等价裁定只支持 ${RULING_ACTIONS.join(' / ')}（收到「${ruling || '空'}」）。`, code: 'SEMANTIC_IDENTITY_RULING_INVALID' };
    if (seen.has(concept)) return { error: `同一个概念 ${concept} 在一次提交里只能给出一条裁定。`, code: 'SEMANTIC_IDENTITY_RULING_INVALID' };
    seen.add(concept);
    if (!concepts.has(concept)) { unknown.push({ concept, ruling, explicit: true }); continue; }
    if (ruling === 'same_entity') { entries.push({ concept, ruling, groups: null, explicit: true }); continue; }
    const fields = concepts.get(concept);
    const groups = (Array.isArray(raw?.groups) ? raw.groups : [])
      .map((group) => (Array.isArray(group) ? group.map((name) => cleanRulingText(name, 64)).filter(Boolean) : []));
    if (groups.length < 2 || groups.some((group) => !group.length)) {
      return { error: `概念 ${concept} 裁定为不同实体时必须给出至少两个非空的字段分组；只给一组等同于「同一实体」。`, code: 'SEMANTIC_IDENTITY_RULING_GROUPS_INVALID' };
    }
    const flat = groups.flat();
    if (new Set(flat).size !== flat.length) return { error: `概念 ${concept} 的字段分组里存在重复字段。`, code: 'SEMANTIC_IDENTITY_RULING_GROUPS_INVALID' };
    // 必须是**严格的划分**：部分覆盖会让未提及的字段名落进一个隐含的第三组，
    // 等于服务器替人补了一次没声明的裁定。
    const uncovered = fields.filter((name) => !flat.includes(name));
    const stray = flat.filter((name) => !fields.includes(name));
    if (uncovered.length || stray.length) {
      return {
        error: `概念 ${concept} 的字段分组必须恰好覆盖该概念下的全部标识字段${uncovered.length ? `；未覆盖：${uncovered.join('、')}` : ''}${stray.length ? `；不属于该概念：${stray.join('、')}` : ''}。`,
        code: 'SEMANTIC_IDENTITY_RULING_GROUPS_INVALID'
      };
    }
    entries.push({ concept, ruling, groups, explicit: true });
  }
  return { entries, unknown };
}

const DECLARATION_RULING_ACTIONS = Object.freeze(['merge', 'distinct']);
const MAX_DECLARATION_RULINGS = 40;

/**
 * 规范化并校验「同名声明裁定」请求（阶段 4c 第三段 / ADR-018）。
 *
 * 只裁定 `declaration_divergence`：同一个对象名（或同一张表）被多处声明而字段集不一致。
 * 它回答的问题与 ADR-016 的概念级裁定**不同层次**，因此键的粒度也不同：
 * 这里按**分歧项**（组成它的声明集合）裁定，而概念级裁定按概念裁定。
 *
 * 返回值沿用既有三套集合的口径：
 * - `entries`：可应用的裁定（含 `explicit` 标志）；
 * - `unknown`：当前分歧里找不到对应项。**显式提交的**由调用方升级为硬错误，
 *   **继承的**由调用方记入 `declarationReport.droppedStale`。
 */
export function resolveDeclarationRulings({ items = [], inherited = [], requested, catalogNames = new Map() }) {
  // 分歧项的事实源就是 `items`（由 `declarationDivergenceItems` 产出）——校验不另建一份判断，
  // 否则「什么样的声明算一个分歧项」会在两处慢慢分叉。
  const byKey = new Map(items.map((item) => [item.key, item]));
  if (requested === undefined || requested === null) {
    // 省略 ≠ 清空：省略表示本次不调整（保持既有裁定），空数组才是撤销全部。
    const entries = [];
    const unknown = [];
    for (const item of inherited) {
      if (!item?.key) continue;
      (byKey.has(item.key) ? entries : unknown).push({
        key: item.key, ruling: item.ruling, groups: item.groups || null, explicit: false
      });
    }
    return { entries, unknown };
  }
  if (!Array.isArray(requested)) return { error: '同名声明裁定必须是数组；空数组表示撤销全部裁定。', code: 'SEMANTIC_DECLARATION_RULING_INVALID' };
  if (requested.length > MAX_DECLARATION_RULINGS) return { error: `单次提交的同名声明裁定不能超过 ${MAX_DECLARATION_RULINGS} 条。`, code: 'SEMANTIC_DECLARATION_RULING_INVALID' };
  const entries = [];
  const unknown = [];
  const seen = new Set();
  for (const raw of requested) {
    const key = cleanRulingText(typeof raw === 'string' ? raw : raw?.key, 200);
    // 只写 key 等价于「确认它们是同一个对象」——这是最常见的一种裁定，允许简写。
    const ruling = cleanRulingText(typeof raw === 'string' ? 'merge' : raw?.ruling, 32);
    if (!key) return { error: '每条同名声明裁定都必须给出分歧项 key。', code: 'SEMANTIC_DECLARATION_RULING_INVALID' };
    if (!DECLARATION_RULING_ACTIONS.includes(ruling)) return { error: `同名声明裁定只支持 ${DECLARATION_RULING_ACTIONS.join(' / ')}（收到「${ruling || '空'}」）。`, code: 'SEMANTIC_DECLARATION_RULING_INVALID' };
    if (seen.has(key)) return { error: `同一个分歧项 ${key} 在一次提交里只能给出一条裁定。`, code: 'SEMANTIC_DECLARATION_RULING_INVALID' };
    seen.add(key);
    if (!byKey.has(key)) { unknown.push({ key, ruling, explicit: true }); continue; }
    if (ruling === 'merge') { entries.push({ key, ruling, groups: null, explicit: true }); continue; }
    const item = byKey.get(key);
    const declarationKeys = item.declarations.map((declaration) => declaration.declarationKey);
    const groups = (Array.isArray(raw?.groups) ? raw.groups : []).map((group) => ({
      name: cleanRulingText(group?.name, 64),
      drop: group?.drop === true,
      declarations: (Array.isArray(group?.declarations) ? group.declarations : []).map((value) => cleanRulingText(value, 200)).filter(Boolean)
    }));
    if (groups.length < 2 || groups.some((group) => !group.declarations.length)) {
      return { error: `分歧项 ${key} 裁定为不同对象时必须给出至少两个非空的分组；只给一组等同于「同一个对象」。`, code: 'SEMANTIC_DECLARATION_RULING_GROUPS_INVALID' };
    }
    const flat = groups.flatMap((group) => group.declarations);
    if (new Set(flat).size !== flat.length) return { error: `分歧项 ${key} 的分组里存在重复声明。`, code: 'SEMANTIC_DECLARATION_RULING_GROUPS_INVALID' };
    // 必须是**严格的划分**：部分覆盖会让未提及的声明落进一个隐含的第三组，
    // 等于服务器替人补了一次没声明的裁定。
    const uncovered = declarationKeys.filter((declarationKey) => !flat.includes(declarationKey));
    const stray = flat.filter((declarationKey) => !declarationKeys.includes(declarationKey));
    if (uncovered.length || stray.length) {
      return {
        error: `分歧项 ${key} 的分组必须恰好覆盖该分歧下的全部声明${uncovered.length ? `；未覆盖：${uncovered.join('、')}` : ''}${stray.length ? `；不属于该分歧：${stray.join('、')}` : ''}。`,
        code: 'SEMANTIC_DECLARATION_RULING_GROUPS_INVALID'
      };
    }
    // 全部排除等于把一个对象从目录里抹掉——那是排除语义，不是「区分粒度」。
    if (groups.every((group) => group.drop)) {
      return { error: `分歧项 ${key} 不能把全部分组都排除：那等于让该对象从字段目录里消失，属排除语义而非「区分粒度」。`, code: 'SEMANTIC_DECLARATION_RULING_GROUPS_INVALID' };
    }
    const kept = groups.filter((group) => !group.drop);
    for (const group of kept) {
      if (!group.name) return { error: `分歧项 ${key} 的每个保留分组都必须给出对象名（要丢弃该组请显式写 drop: true）。`, code: 'SEMANTIC_DECLARATION_RULING_GROUPS_INVALID' };
    }
    const names = kept.map((group) => group.name);
    if (new Set(names).size !== names.length) return { error: `分歧项 ${key} 的保留分组之间存在同名对象。`, code: 'SEMANTIC_DECLARATION_RULING_GROUPS_INVALID' };
    // 组名不得与该系统里**除本分歧项 objectId 之外**的既有对象名重合：两组同名会把两个不同对象
    // 合成一个名字，那正是本裁定要消除的问题。服务端只校验名字的结构（非空 / 唯一 / 不撞名），
    // 不校验名字是否「合适」——对象叫什么是域语义，只能由人给（同 ADR-016 决策 2 的取舍）。
    const declarationByKey = new Map(item.declarations.map((declaration) => [declaration.declarationKey, declaration]));
    for (const group of kept) {
      for (const declarationKey of group.declarations) {
        const system = declarationByKey.get(declarationKey)?.system;
        if (!system) continue;
        const taken = catalogNames.get(system);
        if (taken?.has(group.name) && group.name !== item.objectId) {
          return {
            error: `分歧项 ${key} 的组名「${group.name}」在系统 ${system} 里已存在同名对象；请另取名字，否则会把两个不同对象合成一个名字。`,
            code: 'SEMANTIC_DECLARATION_RULING_NAME_TAKEN'
          };
        }
      }
    }
    entries.push({ key, ruling, groups, explicit: true });
  }
  return { entries, unknown };
}

/** 与草稿层 `relationSignature` 保持同一口径；两处不一致会让「已存在同一条边」判断失效。 */
const relationshipSignatureOf = (item) => `${item?.from}:${item?.predicate}:${item?.to}`;


/**
 * `keyMapping` 的**白名单清洗**（导出给草稿净化使用）。
 *
 * 与 `normalizeKeyMapping` 的分工：本函数只回答「这个结构能不能作为一条合法的映射定义」
 * （返回 `null` 即丢弃），不解释原因——它用在**净化路径**上，那里的语义本来就是「不认识就丢」。
 * 给运营看的可读原因由 `normalizeKeyMapping` 在确认解析时给出。
 *
 * 两个函数共用同一份枚举与同一组长度上限，**不存在第二份清单**。
 */

/**
 * 规范化并校验「结构化映射定义」（阶段 4d / ADR-019 决策 3）。
 *
 * **为什么必须结构化**：实测确认一条 `requires_mapping` 后，草稿里那条边与一条 `linkable` 的边
 * **结构完全相同**（同样的 `predicate` / `cardinality` / `provenanceType: 'inferred'`），
 * 「不可按值连接、必须经外部映射」这件事只活在一段中文里——任何下游消费者都只能去解析自然语言。
 * 结构化后，`keyMapping` 让「需要映射」与「谁负责、哪一版」变成机器可读。
 *
 * 服务端只校验**结构**：两端键必须与链接**逐字一致**（防止把另一条对应的映射写到这里，
 * 那种错位在草稿里看不出来）、`basis` 在枚举内、`lookupSource` 在对应 basis 下必填、
 * `owner` / `version` 非空。**「这个映射对不对」不在机器能力范围内**——域语义只能由人给，
 * 与 ADR-016 / ADR-018 同立场。
 *
 * 返回 `{ value }` 或 `{ error, code }`；错误码统一为 `SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID`
 * （**取代** ADR-015 的 `SEMANTIC_IDENTITY_CONFIRMATION_REQUIRES_MAPPING_EVIDENCE`——契约破坏性变更，
 * 当前只有内置合成数据与用例在读它）。
 */
function normalizeKeyMapping(raw, link) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: '需要建立标识映射的对应必须给出结构化映射定义（keyMapping 对象）：两端键、映射依据类型、责任人、版本。', code: 'SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID' };
  }
  const fromField = cleanRulingText(raw.fromField, 64);
  const toField = cleanRulingText(raw.toField, 64);
  if (fromField !== link.from.field || toField !== link.to.field) {
    return { error: `映射定义的两端必须与这条对应逐字一致（本对应是 ${link.from.field} → ${link.to.field}），不能填写另一条对应的映射。`, code: 'SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID' };
  }
  const basis = cleanRulingText(raw.basis, 32);
  if (!Object.prototype.hasOwnProperty.call(KEY_MAPPING_BASES, basis)) {
    return { error: `映射依据类型必须是以下之一：${Object.keys(KEY_MAPPING_BASES).join(' / ')}。`, code: 'SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID' };
  }
  const lookupSource = cleanRulingText(raw.lookupSource, KEY_MAPPING_SOURCE_MAX);
  if (basis === 'master_data_lookup' && !lookupSource) {
    return { error: '映射依据选择「主数据对照表」时必须写明对照表来源（lookupSource）。', code: 'SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID' };
  }
  const owner = cleanRulingText(raw.owner, KEY_MAPPING_OWNER_MAX);
  if (!owner) return { error: '映射定义必须写明责任人（owner）——「谁维护这张映射」是它可核对的一部分。', code: 'SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID' };
  const version = cleanRulingText(raw.version, KEY_MAPPING_VERSION_MAX);
  if (!version) return { error: '映射定义必须写明版本（version）——没有版本就无法说清「这条边用的是哪一版映射」。', code: 'SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID' };
  // 收口到与净化路径**同一个**形状函数：两处各写一份字段清单，迟早会漂移。
  const cleaned = sanitizeKeyMapping({ fromField, toField, basis, lookupSource, owner, version });
  if (!cleaned) return { error: '映射定义不完整：需要两端键、依据类型、责任人与版本。', code: 'SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID' };
  return { value: cleaned };
}

/**
 * 把**人工确认过**的标识对应转成草稿关系（阶段 4b）。
 *
 * 三条性质是刻意的：
 *
 * 1. **只有确认过的才并入**。本函数不自行挑选：入参 `confirmations` 就是人的结论，
 *    函数只负责把结论翻译成带证据等级的关系，不做任何补全或推测。
 * 2. **并入的关系必须可追溯回假设**：`provenanceType: 'inferred'`（**不用** `confirmed`——
 *    本体契约里 `confirmed` 是「须附证据说明」的最高等级，用它会把一次字段名归一化
 *    与材料里逐字写明的外键混为一谈）+ `derivedFrom`（链接 key）。
 * 3. **材料证据优先**：同一条边若已由材料/词汇表以 `references_<field>` 声明过，
 *    推断不覆盖证据，只记入 `skippedExisting` 供上报。
 *
 * 确认项里 `explicit: false` 表示它来自上一次确认（本轮未重新提交）。这类 key 若因字段修订
 * 而失效，只记入 `droppedStale` 而不报错——否则任何普通字段修订都会被历史确认卡死。
 * 显式重新提交却失效的 key 则是硬错误：那说明界面拿的是一份过期结论。
 *
 * `staleReasons` 让「查不到 key」的原因可读（阶段 4c）：字段修订与裁定撤下对运营的动作完全不同，
 * 前者要去看字段、后者要去看裁定。因此失效项是 `{ key, reason }` 而不是一个裸字符串。
 *
 * 阶段 4e（ADR-020）：**端点资格先于形状判定**。端点对象不在本次候选内的对应写不进草稿
 * （草案要求关系两端引用候选对象），这类请求记入 `outOfScope` 并带可行动原因，
 * 而不是让它落到通用草案校验上报一句「关系端点必须完整」——那句话不是事实，也没说清缺哪个对象。
 */
export function buildConfirmedRelationships({ links = [], confirmations = [], declaredRelationships = [], staleReasons = new Map() } = {}) {
  const byKey = new Map(links.map((link) => [link.key, link]));
  const declared = new Set(declaredRelationships.map(relationshipSignatureOf));
  const relationships = [];
  const accepted = [];
  const unknown = [];
  const droppedStale = [];
  const invalidMapping = [];
  const missingShape = [];
  const invalidShapes = [];
  const outOfScope = [];
  const shapeResolutions = [];
  const skippedExisting = [];
  for (const confirmation of confirmations) {
    const key = String((typeof confirmation === 'string' ? confirmation : confirmation?.key) || '');
    const mappingEvidence = typeof confirmation === 'string' ? '' : String(confirmation?.evidence || '').trim();
    const explicit = typeof confirmation === 'string' ? true : confirmation?.explicit !== false;
    const submittedShape = typeof confirmation === 'string' ? '' : cleanRulingText(confirmation?.shape, 16).toLowerCase();
    const link = byKey.get(key);
    if (!link) {
      const reason = staleReasons.get(key) || '字段或来源系统在本轮修订后不再形成该对应。';
      if (explicit) unknown.push({ key, reason });
      else droppedStale.push({ key, reason });
      continue;
    }
    // 阶段 4e（ADR-020）决策 3：资格排在**形状之前**。一条端点对象都不在本次候选内的边，
    // 问它「形状是什么」没有意义，而且它写不进草稿；不给这条分支，它会落到通用草案校验上，
    // 报出「关系的起点、终点和谓词必须完整」——「必须完整」不是事实（三者俱全），
    // 且没说清缺哪个对象（实测 4 条：LIMS.Sample / OMS.Order / QMS.QualityEvent / WMS.InboundReceipt）。
    if (!link.eligible) {
      // 显式重新提交 → 硬错误（客户端拿的是过期结论，或忽略了界面上的「本次不可并入」标记）；
      // **继承**的确认 → 不阻断修订，列入 `droppedStale`：端点对象被移出候选会让一条旧确认失效，
      // 若在这里硬错误，任何一次对象调整都会把整个提案卡死（与 ADR-015 决策 6 的分流同构）。
      if (explicit) outOfScope.push({ key, reason: link.ineligibleReason, endpoints: link.ineligibleEndpoints });
      else droppedStale.push({ key, reason: `该对应本次不可并入：${link.ineligibleReason}` });
      continue;
    }
    // 形状判定只能提交给「形状未判定」的对应。对一条形状已明确的边提交判定，说明界面拿的是
    // 一份过期结论（与 ADR-015 决策 6 的 `_STALE` 同源）——不能用一次多余的判定把它改级。
    if (submittedShape && link.status !== 'shape_unknown') {
      invalidShapes.push({ key, reason: `本对应两端形状已明确（${link.from.shape || '未判定'} / ${link.to.shape || '未判定'}），不需要形状判定；请刷新后重试。`, code: 'SEMANTIC_IDENTITY_CONFIRMATION_SHAPE_NOT_APPLICABLE' });
      continue;
    }
    if (submittedShape && !SHAPE_VALUES.includes(submittedShape)) {
      invalidShapes.push({ key, reason: `形状判定只能是 ${SHAPE_VALUES.join(' / ')}。`, code: 'SEMANTIC_IDENTITY_CONFIRMATION_SHAPE_INVALID' });
      continue;
    }
    // 形状未判定就**必须先判定**：不判就确认，等于让一条「还不知道能不能按值对齐」的边进草稿。
    if (link.status === 'shape_unknown' && !submittedShape) {
      missingShape.push({ key, reason: `${link.from.system}.${link.from.objectId}.${link.from.field} 与 ${link.to.system}.${link.to.objectId}.${link.to.field} 之间有一端形状未判定（裸名，命名规则判不出代理键 / 业务键），必须先判定形状再确认。` });
      continue;
    }
    // 判定后**重新定级**：与另一端一致＝可按值对齐；不一致＝需要映射（这时才要结构化映射定义）。
    const effectiveStatus = link.status === 'shape_unknown'
      ? (submittedShape === link.to.shape ? 'linkable' : 'requires_mapping')
      : link.status;
    const resolution = link.status === 'shape_unknown' ? { shape: submittedShape, resolvedStatus: effectiveStatus } : null;
    if (resolution) shapeResolutions.push({ key, field: link.from.field, ...resolution });
    // 两端键形状都已知且不同 → **必须**交出结构化的「怎么对齐」（ADR-019 决策 3）。
    // 只给自由文本不再被接受：那正是本 ADR 要消除的「前提只活在一段中文里」。
    let keyMapping = null;
    if (effectiveStatus === 'requires_mapping') {
      const normalized = normalizeKeyMapping(typeof confirmation === 'string' ? null : confirmation?.keyMapping, link);
      if (normalized.error) { invalidMapping.push({ key, reason: normalized.error, code: normalized.code }); continue; }
      keyMapping = normalized.value;
    }
    accepted.push({ key, evidence: mappingEvidence, ...(resolution ? { shape: submittedShape } : {}), ...(keyMapping ? { keyMapping } : {}) });
    const relationship = {
      from: link.from.objectId,
      predicate: `references_${link.from.field}`,
      to: link.to.objectId,
      label: `${link.from.objectId}.${link.from.field} 引用 ${link.to.objectId}`,
      cardinality: link.cardinality,
      evidence: confirmedEvidence(link, mappingEvidence, { keyMapping, resolution }),
      provenanceType: 'inferred',
      derivedFrom: link.key,
      // 结构化映射**进草稿**：下游据此机器可读地知道「这条边需要经映射」，以及责任人与版本。
      // 证据等级不变（仍 `inferred`）——映射是人给的，不是材料里逐字写明的外键。
      ...(keyMapping ? { keyMapping } : {})
    };
    if (declared.has(relationshipSignatureOf(relationship))) { skippedExisting.push(link.evidence); continue; }
    relationships.push(relationship);
  }
  return { relationships, accepted, unknown, droppedStale, invalidMapping, missingShape, invalidShapes, outOfScope, shapeResolutions, skippedExisting };
}

/**
 * 关系的 `evidence` 同时承载两件事：这条边从哪来，以及人工为什么接受它。
 *
 * 草稿层会把 `evidence` 截断到固定长度（`sanitizeProposalDraft`），**硬截断会产生「；该来源系统」这种半句话**——
 * 实测踩到过。因此这里改为按优先级拼装、装不下就**整条舍弃**：宁可少一句说明，
 * 也不留一句读不懂的残句。优先级按「能否从数据重建」排：
 * 链接证据 > 键形状（不可直接对齐这个事实）> 结构化映射摘要 > 人补充的自由说明 > 归一化口径 > 来源grounding。
 *
 * 阶段 4d（ADR-019）：键形状那句必须写**判定后**的形状——若人判定了裸名的形状，
 * 写 `null / agent` 会让人读不懂，写判定值才是这条边上的事实。
 */
const EVIDENCE_BUDGET = 260;
const confirmedEvidence = (link, mappingEvidence, { keyMapping = null, resolution = null } = {}) => {
  const resolvedShape = resolution ? resolution.shape : '';
  const shapeClause = keyMapping
    ? `两端键形状不同（${resolvedShape || link.from.shape} / ${link.to.shape}），不按值直接对齐`
    : resolution
      ? `人工判定 ${link.from.field} 为${resolvedShape === 'agent' ? '代理键' : '业务键'}，与另一端一致，可按值对齐`
      : '';
  const mappingClause = keyMapping
    ? `映射依据：${KEY_MAPPING_BASES[keyMapping.basis]}${keyMapping.lookupSource ? `（${keyMapping.lookupSource}）` : ''}，责任人 ${keyMapping.owner}，版本 ${keyMapping.version}`
    : '';
  const clauses = [
    `人工复核确认的标识对应（推断，非材料写明的外键）：${link.evidence}`,
    shapeClause,
    mappingClause,
    mappingEvidence ? `人工补充说明：${mappingEvidence}` : '',
    `依据：字段名归一化到业务概念 ${link.concept}，基数 ${link.cardinality}`,
    // 阶段 4e（ADR-020）：原句是「该来源**系统**本次未进入候选对象，依据来自系统声明」——
    // 前半句陈述的是资格，而它由声明 grounding 推导，会误报（实测 ERP 在范围内却被告知未进入）。
    // 现在这句只说**依据来源**这一件它真正知道的事。
    link.declarationSourced ? '来源依据为系统配置声明' : ''
  ].filter(Boolean);
  const kept = [];
  for (const clause of clauses) {
    if ([...kept, clause].join('；').length > EVIDENCE_BUDGET) break;
    kept.push(clause);
  }
  return kept.join('；');
};

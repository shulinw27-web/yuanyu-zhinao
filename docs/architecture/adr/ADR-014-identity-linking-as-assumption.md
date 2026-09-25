# ADR-014: 跨系统标识对应先推导上报，不自动并入草稿关系

## Status

Accepted —— **决策 1（只上报、不自动并入）已由 [ADR-015](ADR-015-identity-link-confirmation.md) 承接**：并入现在允许，但只发生在人工逐条确认之后，且并入的边标 `provenanceType: 'inferred'` + `derivedFrom`，与本 ADR 要求的「假设与证据可区分」一致。本 ADR 的其余决策（2~6）与四类冲突上报仍然有效。

## Context

### 当时的约束

- [ADR-012](ADR-012-explicit-modeling-scope.md) 把建模范围收敛为显式契约，[ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md) 把它落为过滤器。两者解决的都是「范围从哪来、范围外怎么办」。
- 阶段 4 方案要求把「硬编码 12 对象目录 + 关键词命中」升级为「**按选中系统的字段目录/样本抽取对象与标识（主键 / 唯一键 / 业务键）**」，并「**跨系统连接**：识别同一业务实体在不同系统的标识对应，推导关系与基数」、「**冲突与歧义显式上报**（同名不同义、同义不同名、粒度不一致）」。
- 仓库已有一条明确纪律，来自 `semantic-natural-schema-service.js`：`Unknown source systems remain UNASSIGNED and block publication; model suggestions never become facts.` 即**模型/推断的产物不得直接变成事实**，必须带逐字证据才允许进入草稿。
- 本体草稿模型已支持 `provenanceType: 'confirmed' | 'inferred'`，说明「推断」在数据模型里有位置，但把它当什么用是决策，不是既有结论。

### 触发点

「识别同一业务实体在不同系统的标识对应」这一步，输出的是**对应关系**——例如 `WMS.InboundReceipt.purchase_order_id → ERP.PurchaseOrder.purchase_order_id`。它天然可以写成一条关系（`relationshipTypes` 新增一条边）。

但这条边**不是从材料里读到的**，而是从字段名的归一化（`purchase_order_id` → 概念 `PurchaseOrder`）加一张人工登记的概念别名表推出来的。把它直接写进草稿，等于让一次字符串匹配的结果获得了与「材料里逐字写明的外键」相同的地位。

同时，实测（内置合成数据，6 个系统）暴露出这一步必然伴随三类分歧：`MaterialBatch` 这一个概念在声明里由 `material_batch_id` / `material_batch_no` / `lot_no` 三个字段名表达；`Product` 由 `product_id` / `sku` / `product_code` / `product` 四个表达；`Inventory` 这一个对象名同时被 ERP 与 WMS 声明且字段集不同。**"名字对上了" 与 "它们真是同一个实体" 是两件事。**

### 需要回答的具体问题

1. 标识对应推导出来后，**进不进** `relationshipTypes`？
2. 推导用什么做依据——模型猜，还是确定性规则？
3. 上面那三类分歧，合并、丢弃，还是上报？

## Decision

### 1. 标识对应只上报，不自动并入草稿关系（本 ADR 的核心约束）

推导结果落在提案的 `identityLinking.links`，**不**写入 `relationshipTypes`。`relationshipTypes` 仍只容纳两类边：受控词汇表登记的关系，与材料里带逐字证据的外键（`references_<field>`）。

理由：字段名归一化得出的是**假设**，不是证据。自动并入会让「一次字符串匹配」与「材料里写明的外键」在草稿里不可区分，而这正是本次重构一路在消除的模式——让实际结论超出可见依据。合并动作需要有人的复核，落点在阶段 4b。

### 2. 推导必须确定性，不依赖模型

依据只有两处，都是既有事实源：提案候选对象（自带 `source` 与 `sourceSystems`），与系统配置映射（`data/seed.js` 的 `systemConfigurations`，各系统已声明的对象与字段）。

模型只在本阶段的**另一半**出现（从非结构化材料抽取对象与标识，属 4b）。标识对应若靠模型，就既不可复现也不可复核，而阶段 4 的验收明确要求「对象数 / 关系数 / 跨系统连接数 / 冲突数**可复现**」。

### 3. 对象自己的标识必须指向该对象自身概念（外键不得当主键）

判定顺序：受控词汇表登记的主键 → 由对象名派生的 `<object>_id` → 声明中**唯一**指向该对象自身概念的标识字段 → 否则**未识别**（记入 `keyGaps`，并给出候选，**不判定**）。

两个实测反例决定了这条规则：

- `WMS.InboundReceipt` 声明里有 `receipt_id`、`purchase_order_id`、`material_batch_id` 三个 `_id` 后缀字段。按「取第一个 `_id`」处理，恰好在它的例子里选对了；但只要声明顺序换成采购订单号在前，就会把**外键**当主键——对错取决于字段顺序的规则不是规则。
- `ERP.Inventory` 的 `lot_no` 指向**物料批次**，是引用而不是库存自身的标识。若把它当标识，它就会凭空变成「物料批次」这一概念的对齐目标，实测引来 6 条虚假的跨系统引用（修正后链接数 16 → 11）。修正后它正确落入 `keyGaps`：ERP 库存的复合业务键没有在映射里声明。

### 4. 三类分歧必须显式上报，禁止静默合并

| kind | 含义 | 处置 |
| --- | --- | --- |
| `ambiguous_identifier` | 字段名归一化后无法说明它指向哪个实体（`id` / `code` 这类泛化名，或别名表自身冲突） | `blocksLink: true`——该字段**不参与**链接推导 |
| `alias_divergence` | 同一概念由多个字段名表达（同义不同名） | 上报并附每个字段名的出现位置；**不**默认它们等价 |
| `key_shape_incompatible` | 同一概念上代理键与业务键混用 | 上报；链接标 `status: requires_mapping`，**不**标为可直接对齐 |
| `declaration_divergence` | 同一对象名（或同一张表）在两处声明中字段集不一致 | 上报；**同名不等于同一实体**，需人工裁定合并还是区分粒度 |

### 5. 字段目录按所选系统登记，不按材料命中裁剪

字段目录是「**范围内的系统声明了什么**」，与「本次材料提到了什么对象」是两个问题，因此不做命中裁剪，并在每条记录上带 `groundings`（`proposal_object` / `source_system_declaration`）与链接上的 `declarationSourced`，使「这条依据来自提案对象还是仅来自系统声明」可分辨。（该字段原名 `notInProposal`，阶段 4e 因「名字会被读成『不可确认』，而它只回答依据来源」而改名，并把「能不能确认」拆成独立判据 `eligible`——见 [ADR-020](ADR-020-identity-link-confirmation-eligibility.md)。）

### 6. 字段修订后必须重算

标识对应是从对象字段推出来的，字段一旦被修订就会过期。`updateSemanticOperationsProposal` 在修订后必须重算 `identityLinking`，否则界面上会显示一份与当前草稿不符的跨系统引用。

## Consequences

### 变简单的地方

- 标识对应的证据链是「字段路径 → 概念 → 概念别名表」，全程可枚举、可 diff、可在 mock 下复现，不需要模型通道。
- 冲突不再需要靠人「看出来」：`MaterialBatch` 一个概念三种名字、`Inventory` 同名不同体，都会出现在任务回应与界面上。
- `keyGaps` 让「系统不知道某个对象的标识」变成一条显式待办，而不是悄悄拿第一个字段顶上。

### 变复杂的地方（如实）

- `relationshipTypes` 不会因为本能力而变多，因此**跨系统连接的收益在当前是「可见但未生效」**——需要 4b 的复核动作才能真正进入草稿。这是刻意的，但确实延长了价值兑现的路径。
- 概念别名表是一张**必须维护的人工知识表**。它不准，对应关系就不准；因此它被设计为「可审计」：出现一词干两概念时运行时报歧义，而不是让某一方胜出。
- 冲突会带来噪音：内置合成数据下 6 系统就产出 14 项。当前全部上报，未做分级收敛。

### 明确不在本 ADR 范围内

- 从非结构化材料抽取对象与标识（需模型，属 4b）。
- 冲突的处理动作（合并、改名、区分粒度）——当前只上报，不给操作。
- 把 `links` 并入草稿关系的具体交互。

## 退出/复审条件

1. **若开始把 `links` 并入草稿关系**：必须先给出「人工确认」的落点与证据等级（是否用 `provenanceType: 'inferred'`），并重新决策「假设与证据在草稿里是否仍可区分」。本 ADR 明确当前不可区分，所以不允许自动并入。
   → **已由 [ADR-015](ADR-015-identity-link-confirmation.md) 解决（2026-09-25）**：确认落在既有复核动作（`PATCH .../proposal` 的 `identityLinkConfirmations`）；证据等级取 `inferred`（明确**不取** `confirmed`）；可区分性由 `provenanceType` 与 `derivedFrom` 两个字段保证。
2. **若概念别名表出现一个词干对应多个概念**：必须通过新 ADR 处理。运行时已把它报成 `ambiguous_identifier`；不得就地调整让某一方胜出。
3. **若标识对应的依据改为模型判断**（例如用它消解 `key_shape_incompatible`）：须重新评估可复现性验收，并说明模型结论以什么等级的「证据」进入草稿。
4. **若字段目录开始按材料命中裁剪**：须重新评估「范围内的系统声明了什么」这一问题的答案从哪里来，以及 `declarationSourced`（原 `notInProposal`）语义是否还有意义。

## 关联

- [ADR-012](ADR-012-explicit-modeling-scope.md)：范围必须显式给出（本 ADR 的输入前提）
- [ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md)：范围是过滤器（对象按范围进入提案，标识目录不裁剪）
- [ADR-015](ADR-015-identity-link-confirmation.md)：确认后并入与证据等级（**承接本 ADR 决策 1**）
- [系统接入重构方案](../SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md) 第 6 节阶段 4
- [ARCHITECTURE.md](../ARCHITECTURE.md)

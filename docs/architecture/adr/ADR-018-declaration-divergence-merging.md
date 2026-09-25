# ADR-018: 同名声明不一致要显式裁定「合并 / 区分粒度」；裁定决定字段目录的组成

## Status

Accepted

## Context

### 当时的约束

[ADR-016](ADR-016-identity-conflict-rulings.md) 的**明确不在其范围内**一节：

> **`declaration_divergence` 的合并 / 区分粒度**：这是**对象级**裁定，会改变字段目录的合并语义（当前实现是同一 `objectId` 的字段取并集）。它属于阶段 4c 的下一段。

[ADR-014](ADR-014-identity-linking-as-assumption.md) 把 `declaration_divergence` 定义为**只上报**：同一对象名在两处声明里字段集不同，冲突本身报出来，但没有任何处置动作。

[系统接入重构方案](../SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md) 阶段 4 范围第 3 条：**冲突与歧义显式上报（同名不同义、同义不同名、粒度不一致）**。`alias_divergence`（同义不同名）已在阶段 4c 第一段裁定；`declaration_divergence` 恰好就是「同名不同义 / 粒度不一致」——它至今没有任何入口。

### 触发点（本机实测，内置合成数据，6 个系统）

实测基线：21 个对象、33 个标识字段、11 条跨系统链接（4 条 `linkable` / 7 条 `requires_mapping`）、14 项冲突、1 项 `keyGaps`。

冲突分布：

| 类别 | 条数 | 处置入口 |
| --- | --- | --- |
| `alias_divergence` | 5 | **有**（阶段 4c 第一段 / ADR-016） |
| `declaration_divergence` | **5** | **无** |
| `key_shape_incompatible` | 4 | 间接（`requires_mapping` + 确认时的自由文本依据） |
| `ambiguous_identifier` | 0 | 无（无用例驱动） |

5 项 `declaration_divergence` 分两种粒度：

| scope | 项 | 两处声明 |
| --- | --- | --- |
| `object`（同名对象被不同系统声明） | `Inventory` | WMS `proposal_object`：`inventory_id, material_batch_id, quantity, warehouse_code`；ERP `source_system_declaration`：`sku, lot_no, available_qty, expiry_date` |
| `source`（同一张表被两处声明） | `mes.production_batch` | `proposal_object`：`production_batch_id, product_code, material_batch_id, status`；`source_system_declaration`：`batch_no, formula_version, line, status` |
| `source` | `oms.store` | `store_id, name, region, status` / `store_id, store_name, organization_id, region_code, operation_status` |
| `source` | `erp.supplier` | `supplier_id, name, qualification_status, status` / `supplier_id, qualification_status, expiry_date` |
| `source` | `lims.test_result` | `test_result_id, material_batch_id, item, result, status` / `result_id, test_item, result_value, decision` |

### 真正的问题不是「冲突没被上报」，而是「并集不可见，且并集在被当成事实用」

冲突一直被上报了（写得很清楚：「受控词汇表与已配置映射必须核对后再建模」）。缺的是两件事：

**第一，并集本身看不见。** `buildSystemFieldCatalog` 对同一系统内同一 `objectId` 的多处声明取**字段并集**，条目上只留下 `groundings: ['proposal_object','source_system_declaration']`——`fields` 是并集结果，但没有任何字段说明哪一条字段来自哪一处声明。运营看到的是「这个对象有 7 个字段」，而没有任何一处声明说过这句话。

**第二，并集在参与标识识别，于是产出了一个谁也没声明过的标识。** 实测（本机探针）：

| 对象 | 并集后的目录条目 | 并集授予的标识 | 该声明**自己**能推出的标识 |
| --- | --- | --- | --- |
| `MES.ProductionBatch` | 7 字段（两处声明的并集） | `production_batch_id`（primary，依据「受控词汇表登记的主键」） | 若只看配置映射那份声明（`batch_no, formula_version, line, status`）：`batch_no`（business） |
| `LIMS.TestResult` | 9 字段 | `test_result_id`（primary） | 配置映射那份：`result_id` |
| `ERP.Supplier` | 5 字段 | `supplier_id`（primary） | 两处都有 `supplier_id`，无分歧 |
| `OMS.Store` | 8 字段 | `store_id`（primary） | 两处都有 `store_id`，无分歧 |

即：`MES.ProductionBatch` 在目录里是「标识为 `production_batch_id` 的对象」，而 MES 的**已配置映射**里这张表的字段列表根本没有 `production_batch_id`。**标识是真实的（来自受控词汇表那一处声明），但它被记在了「两处声明的并集」这个复合体名下**——一个不存在的对象。

副产物还有一个不实标记：链接的 `notInProposal` 取的是「该条目有没有 `proposal_object` 这一项 grounding」，并集把两份声明合成一条之后，**只由配置映射声明的那部分字段也拿到了 `notInProposal: false`**（看起来像在提案里）。

这与本次重构一路在消除的模式同构：**「结论超出可见依据」**。阶段 4a 消除了「标识对应被当成结论」，4b 消除了「假设被当成证据」，4c 第一段消除了「等价前提从未被看见」，4c 第二段消除了「归属断言无法复核」。这里剩下的是**「两处声明被合成一个复合体、谁都没为这个复合体声明过」**。

### 需要回答的具体问题

1. 裁定落在哪个动作上——新端点，还是既有复核动作？
2. 「合并」与「区分粒度」分别是什么语义？区分粒度时拆出来的对象**叫什么**？
3. 裁定结果要不要进草稿、以什么证据等级？与 ADR-015 的 `inferred`、ADR-016 的裁定会不会混用？
4. 裁定集合的语义（省略 / 空 / 失效）与既有两套是否一致？
5. 未裁定时应该维持现状（静默并集），还是至少要把并集披露出来？

## Decision

### 1. 裁定落在**既有复核动作**上，不新增端点

通过 `PATCH /semantic-operations/tasks/:id/proposal` 完成，入参新增 `declarationRulings`，与 `objectTypes / primaryKeyCorrections / identityConflictRulings / identityLinkConfirmations / sourceAssignments` 并列。

理由与 ADR-015 / ADR-016 相同：裁定改变的是提案的**输入口径**，走既有通道才能免费获得版本冲突检测、Critic 重算、Diff / 影响分析与修订历史。

**两套裁定粒度必须能共存，且键的形状要能区分它们**（ADR-016 复审条件 3 要求「说明两套粒度如何共存」）：

| 集合 | 键 | 回答的问题 | 键的形状 |
| --- | --- | --- | --- |
| `identityConflictRulings`（ADR-016） | **概念** | 同一概念下的多个字段名是不是同一实体 | `MaterialBatch` |
| `declarationRulings`（本 ADR） | **分歧项** | 同名对象的两处声明是不是同一个对象 | `object:Inventory` / `source:ProductionBatch@mes.production_batch` |

分歧项的 `key` 由服务端生成、随冲突项一起上报（`item.key`），客户端只回传。两类集合各自独立校验、互不引用。

### 2. 两个动作，互斥：`merge` 与 `distinct`

- **`merge`**：确认这些声明描述**同一个对象**。字段取并集（即当前行为），但从此是**显式结论**而非默认动作。
- **`distinct`**：确认它们描述**不同对象**（同名不同义 / 粒度不一致）。必须给出 `groups`——这些**声明**的严格划分，每组成员非空、覆盖全部声明、不重复；每组成员二选一：
  - 给出 `name` → 该组建模为一个名为 `name` 的对象（可以就是原名，也可以改名）；
  - `drop: true` → 该组**显式排除**，其声明不再进入字段目录。

  至少一组必须保留（全部排除等于把一个对象抹掉，属排除语义，不在本 ADR 范围内）。

`groups` 必须是**严格划分**，与 ADR-016 对 `distinct_entity` 的要求同源：部分覆盖会让未提及的声明落进一个隐含的第三组，那等于让服务器替人补了一次未声明的裁定。

**`distinct` 的效果是「不并集」**：每组的字段集是**该组自身声明的并集**，绝不跨组取并集。于是 `MES.ProductionBatch` 不再被授予 `production_batch_id` —— 该标识留在它真正来自的那一组里。

### 3. 裁定**不并入草稿、不产生证据等级**——与 ADR-016 同立场

裁定改变的是**字段目录的组成**，即 `identityLinking` 的重算输入。它不写任何关系的 `provenanceType`，不产生第五条证据等级，也**不改动 `draft.objectTypes`**。

| | 回答的问题 | 作用层 | 效果 |
| --- | --- | --- | --- |
| `declarationRulings`（本 ADR） | 这些声明是不是同一个对象 | 字段目录（链接推导的输入） | 决定目录条目是并集还是拆分 |
| `identityConflictRulings`（ADR-016） | 这个等价假设成立吗 | 链接推导的输入 | 决定哪些链接存在 |
| `identityLinkConfirmations`（ADR-015） | 这条对应要写进模型吗 | 草稿关系 | 产生 `provenanceType: 'inferred'` 的边 |
| `sourceAssignments`（ADR-017） | 这个对象属于哪个系统 | 草稿对象的事实字段 | 改写 `sourceSystems`，参与范围裁剪 |

把「拆出来的对象」**建模进草稿**是对象编辑的事（或将来候选对象生成的事），不是本裁定的效果——所以被拆出的条目在链接上会如实标成 `notInProposal: true`（它只是一个来源系统的声明，还没进提案）。这比今天的「并集让它看起来在提案里」更准确。

### 4. 未裁定时，**并集必须披露**——不给「静默并集」留默认豁免

字段目录条目新增三项，三种状态下都必须出现：

- `declarations`：组成该条目的每处声明（`declarationKey` / `system` / `grounding` / `source` / `sourceBasis` / `fields`）；
- `exclusiveFields`：只被其中**一处**声明列出的字段（并集最容易骗人的地方就在这里）；
- `declarationState`：`merged_unruled`（未裁定，沿用并集）/ `merged`（已裁定为同一对象）/ `split`（已裁定为不同对象）。

且未裁定 + 多处声明时，`identifierBasis` 必须写明**字段是并集**。

理由：`declaration_divergence` 一直是「上报了但没入口」，而并集一直在悄悄发生。**披露是让「默认动作」不再隐形的最低要求**——ADR-013 要求被排除项显式列出，这里要求被合并项显式列出，是同一条纪律的两面。

### 5. 裁定集合是**全量语义**，与既有三套同构

- `declarationRulings` **省略** → 本次不调整裁定（保持既有）；
- **空数组** → 撤销全部裁定；
- 显式提交的 `key` 在当前分歧里不存在 → 硬错误 `SEMANTIC_DECLARATION_RULING_UNKNOWN_CONFLICT`（界面拿的是一份过期结论）；
- 继承的历史裁定失去对应分歧（字段被修订、冲突消失）→ 不阻断修订，写入 `declarationReport.droppedStale`。

### 6. 撤销 `distinct` 必须**双向完全回退**，拆分与回退都要可读列出

`declarationReport`：

- `applied`：本次生效的裁定（`key` / `scope` / `ruling` / 组）；
- `splitObjects`：因 `distinct` 而拆分或改名的对象（`from` / `into` / 涉及的声明）；
- `droppedDeclarations`：因 `distinct` + `drop` 而**被排除的声明**及其所属组（被排除的必须显式列出，不能静默消失）；
- `droppedLinks`：因拆分/改名而**不再存在**的链接 key 与原因；
- `unresolvedItems`：仍有 `declaration_divergence` 但未裁定的分歧项——这是「还有多少个复合条目没人看过」的直接答案；
- `droppedStale`：继承裁定失去对应分歧。

`droppedLinks` 是必需的：对象改名会让基于旧名的链接 key 失效，而此前如果有人确认过那条对应，确认会走 ADR-015 决策 6 的「继承失效」路径消失——**原因必须可读**（「去看裁定」而不是「去看字段」），与 ADR-016 决策 6 同源。

### 7. 组名必须校验，但不做语义校验

`name` 必须非空、在同一次提交内唯一，且**不得与该系统中除本分歧项 `objectId` 之外的既有对象名重合**（否则会把两个不同对象合成一个名字，正是本 ADR 要消除的问题）。

服务端只校验名字的**结构**（非空 / 唯一 / 不撞名），**不校验这个名字是否「合适」**——对象叫什么是域语义，只能由人给。代价与 ADR-016 决策 2 相同：裁定质量无法被机器兜底。

## Consequences

### 变简单的地方

- `declaration_divergence` 第一次有了入口，且四类冲突里最能改变目录组成的一类不再悬空。
- 「复合字段集」这件事第一次可见：`declarations` + `exclusiveFields` 让「这 7 个字段其实来自两处、其中 `batch_no` 只在一处出现」变成界面上一行可读的事实。
- 虚假标识被消除：并集不再能跨声明授予标识（实测的 `MES.ProductionBatch` → `production_batch_id`）。
- `declarationSourced`（阶段 4e 前叫 `notInProposal`）不再被骗：只有配置映射声明的那部分字段不会因为并集而看起来「在提案里」。注意它回答的只是**依据来源**，「这条对应能不能确认」是另一个判据（`eligible`，见 [ADR-020](ADR-020-identity-link-confirmation-eligibility.md)）。

### 变复杂的地方（如实）

- 提案上现在有**四类**人工结论（归属确认、等价裁定、同名声明裁定、对应确认），彼此有顺序依赖：先归属（决定对象属于谁）→ 再等价裁定（决定等价假设）→ 再同名声明裁定（决定目录组成）→ 最后确认（决定哪些对应进草稿）。界面上必须把顺序表达清楚。
- `distinct` 的命名是**自由命名**，人可以对同一分歧项给出完全不同的名字；服务端只校验结构。
- 拆分/改名会让对象名变化，因而**使基于旧名的链接 key 与其上的确认失效**。这是正确但会「凭空少掉一些已确认项」的行为，因此 `droppedLinks` 必须与撤销动作一样被看见。
- 默认（未裁定）仍是并集，只是披露了。这意味着**披露不等于修正**：在没有裁定的分歧项上，目录仍然输出复合条目。
- `drop` 会让声明从目录里消失，从而可能连带让某些链接、乃至某个对象从目录里消失（若它只有这一处声明）。

### 明确不在本 ADR 范围内

- **`key_shape_incompatible` 的结构化标识映射**：ADR-015 复审条件 2 的独立决策（映射表需要版本与责任人）。当前仍由 `requires_mapping` + 确认时的自由文本依据承载，本 ADR 不改它。
- **`ambiguous_identifier` 的按字段归属指派**：实测 0 条；ADR-016 复审条件 3 要求先给出按「系统.对象.字段」粒度的形式。
- **`drop` 后的对象级联**：若某对象只剩被排除的声明，它在目录里会消失；本 ADR 只如实列出 `droppedDeclarations` 与 `droppedLinks`，不做「这个对象现在没有声明了」的独立上报项。
- **跨修订的拆分对比**：只上报「本次拆了哪些」，不做「与上一版相比多了/少了哪些对象」的差异视图。
- **同名声明分歧的自动消解**：不做。永远由人裁定。

## 退出/复审条件

1. **若裁定要直接产生草稿对象**（把拆出的对象写进 `draft.objectTypes`）：须重新论证「裁定改输入、编辑改草稿」这条界线为什么还需要，以及新对象以什么证据等级进入草稿。
2. **若 `drop` 开始被当作「删除对象」的手段**：须重新评估其作用面（本 ADR 只排除**声明**，不排除对象）。
3. **若 `declarationRulings` 与 `identityConflictRulings` 的键需要合并成一套**：须先给出统一的「分歧项」概念，并说明按概念裁定与按声明集合裁定在被合并后各自如何表达。
4. **若默认（未裁定）改为「不并集」**：须重新评估对既有输出与用例的破坏面，并给出迁移口径——那等于把「区分粒度」变成默认，需要论证为什么默认不是「合并」。

## 关联

- [ADR-016](ADR-016-identity-conflict-rulings.md)：等价假设先裁定（**本 ADR 承接其「明确不在范围内」的 `declaration_divergence`**，并回答其复审条件 3 的「两套粒度如何共存」）
- [ADR-014](ADR-014-identity-linking-as-assumption.md)：标识对应先推导上报，冲突只上报（本 ADR 给 `declaration_divergence` 补上处置动作）
- [ADR-015](ADR-015-identity-link-confirmation.md)：确认后并入与证据等级（本 ADR 的 `droppedLinks` 走它的继承失效路径）
- [ADR-017](ADR-017-model-extraction-attribution.md)：材料归属由模型取证（顺序：归属 → 裁定 → 确认）
- [ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md)：范围是过滤器（**被合并项也必须显式列出**）
- [系统接入重构方案](../SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md) 第 6 节阶段 4c
- [SEMANTIC_MODEL_AUTHORING.md](../SEMANTIC_MODEL_AUTHORING.md)

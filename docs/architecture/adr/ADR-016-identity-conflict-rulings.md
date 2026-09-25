# ADR-016: 标识等价假设先裁定、再对齐；裁定改输入而不改证据等级

## Status

Accepted

## Context

### 当时的约束

[ADR-015](ADR-015-identity-link-confirmation.md) 的**复审条件 3**：

> 若冲突开始有处理动作：须重新决策「裁定结果是否也并入草稿、以什么证据等级」，并检查它与本 ADR 的 `inferred` 是否会被混用。

[ADR-014](ADR-014-identity-linking-as-assumption.md) 把四类冲突定义为**只上报**：`ambiguous_identifier`（归属歧义）、`alias_divergence`（同义不同名）、`key_shape_incompatible`（键形状不可对齐）、`declaration_divergence`（同名声明不一致）。ADR-015 又明确把「冲突的处理动作」列为**不在其范围内**（阶段 4c）。

### 触发点（本机实测，内置合成数据，6 个系统）

实测基线：21 个对象、33 个标识字段、11 条跨系统链接（4 条 `linkable` / 7 条 `requires_mapping`）、14 项冲突、1 项 `keyGaps`。

冲突分布：

| 类别 | 条数 | 涉及概念 / 对象 |
| --- | --- | --- |
| `alias_divergence` | 5 | Material、MaterialBatch、Product、ProductionBatch、TestResult |
| `declaration_divergence` | 5 | Inventory（对象级）、ProductionBatch / Store / Supplier / TestResult（来源级） |
| `key_shape_incompatible` | 4 | Material、MaterialBatch、Product、ProductionBatch |
| `ambiguous_identifier` | **0** | 当前数据下不出现 |

把这 11 条链接按概念归位，就暴露了真正的缺口：

- `MaterialBatch` 概念下有 3 个字段名（`lot_no` / `material_batch_id` / `material_batch_no`），支撑 **4 条**链接；
- `Product` 概念下有 4 个字段名（`product` / `product_code` / `product_id` / `sku`），支撑 **4 条**链接；
- `Material` 概念下有 2 个字段名（`material_id` / `material_code`），支撑 **1 条**链接；
- 不受等价假设影响的只有 `PurchaseOrder` 与 `Supplier` 各 1 条。

即：**11 条链接里有 9 条（82%）建立在「同一概念下的多个字段名指向同一实体」这个假设上，而这个假设从来没有被任何人裁定过。** `alias_divergence` 自己在 `reason` 里写的就是「跨系统对接前必须确认它们指向同一个实体」——界面把确认了的要求写出来了，却没有给出确认的入口。

这与本次重构一路在消除的模式同构，只是换了一层：4a/4b 解决的是「推导出的对应被当成结论」，这里剩下的是**「支撑推导的等价假设从未被看见」**。运营看到 4 条 `MaterialBatch` 链接并逐条确认（ADR-015 的入口），确认的却是一个组内等价前提——如果 `lot_no` 与 `material_batch_id` 本来就不是同一实体，那 4 条链接里 2 条是错的，而确认动作对此毫无提示。

### 需要回答的具体问题

1. 裁定落在哪个动作上——新端点，还是既有复核动作？
2. 裁定结果要不要进草稿关系？以什么证据等级？会不会与 ADR-015 的 `inferred` 混用？
3. `distinct_entity`（确认不是同一实体）时，已推导出的链接怎么办——保留并标注，还是撤下？
4. 裁定被撤销、或因字段修订而不再对应任何冲突，这些状态怎么表达？

## Decision

### 1. 裁定落在**既有复核动作**上，不新增端点

通过 `PATCH /semantic-operations/tasks/:id/proposal` 完成，入参新增 `identityConflictRulings`，与 `objectTypes / relationshipTypes / primaryKeyCorrections / identityLinkConfirmations` 并列。

理由与 ADR-015 决策 1 相同：裁定改变的是**提案的输入口径**，而不是旁路数据。走既有通道才能免费获得版本冲突检测（`SEMANTIC_PROPOSAL_REVISION_CONFLICT`）、Critic 重算、Diff / 影响分析与修订历史。

### 2. 本轮**只裁定 `alias_divergence`**，且只回答「是不是同一实体」

两类动作，互斥：

- `same_entity`：确认该概念下的全部字段名指向同一业务实体（关闭该项冲突）；
- `distinct_entity`：确认它们不是同一个实体，必须给出 `groups`——该概念下字段名的**等价类划分**。

`groups` 必须是严格的划分：覆盖该概念下**全部**字段名，不重复、不遗漏。缺字段或重复字段一律 400（`SEMANTIC_IDENTITY_RULING_GROUPS_INVALID`）——「部分覆盖」会让未提及的字段名落进一个隐含的第三组，那等于让服务器替人做了一次未声明的裁定。

其余三类冲突**不在本 ADR 范围内**，理由必须写明（见「明确不在本 ADR 范围内」），不能因为「顺手」就一起做掉。

### 3. 裁定**不并入草稿、不产生证据等级**——这是对 ADR-015 复审条件 3 的直接回答

裁定改变的是 `identityLinking` 的**重算输入**：它决定哪些链接存在、每条链接的等价前提是否已获裁定。它**不写任何关系的 `provenanceType`**，也不产生第五条证据等级。

因此裁定与 ADR-015 的 `inferred` 不可能混用：**两者不作用于同一层**。

| | 回答的问题 | 作用层 | 效果 |
| --- | --- | --- | --- |
| `identityConflictRulings`（本 ADR） | 这个等价假设成立吗 | 链接推导的输入 | 决定哪些链接存在、哪些被撤下 |
| `identityLinkConfirmations`（ADR-015） | 这条对应要写进模型吗 | 草稿关系 | 产生 `provenanceType: 'inferred'` 的边 |

顺序也是刻意的：**先裁定假设，再采纳结论**。裁定不产生边，确认仍必须逐条发生；一条链接即使其等价假设已裁定为 `same_entity`，也仍然需要人在 4b 的入口上确认才会进入草稿。裁定为 `distinct_entity` 而消失的链接，则在界面上连勾选项都不再存在。

### 4. `distinct_entity` 撤下跨组链接，**不保留为标注项**

属于同一概念、但落在不同等价类里的两个字段名，其对齐不成立——这条链接从 `links` 中**移除**，进入 `withdrawnLinks`（带 `from` / `to` / 原因）。

理由：留在 `links` 里并加一个「可疑」标记，会出现一条既能被确认、又已知不成立的边——ADR-015 决策 4 对 `requires_mapping` 已经采用过同样的立场（不允许「确认但无依据」）。**已知不成立的对应不应保留任何采纳入口。**

`withdrawnLinks` 必须显式列出而不是静默消失：运营上一版看到 4 条 `MaterialBatch` 链接、这一版只剩 2 条，原因必须可读——「哪两条、因为哪条裁定」。

### 5. 裁定集合是**全量语义**，与 4b 同构

- `identityConflictRulings` **省略** → 本次不调整裁定（保持既有）；
- **空数组** → 撤销全部裁定；
- 显式提交的 `concept` 在当前冲突里不存在 → 硬错误 `SEMANTIC_IDENTITY_RULING_UNKNOWN_CONFLICT`（界面拿的是一份过期结论）；
- **继承**的历史裁定失去对应冲突（例如字段被改名、冲突消失）→ 不阻断修订，写入 `rulingReport.droppedStale`。

### 6. 被撤下的链接若此前已被确认，确认**必须随之失效并说明原因**

`identityLinkConfirmations` 的 key 指向链接；链接被裁定撤下后 key 查不到，走 ADR-015 决策 6 已建立的「继承失效」路径写入 `droppedStale`。本 ADR 给它补上**原因**：`droppedStale` 由 key 字符串数组升级为 `{ key, reason }`，区分「因字段修订失效」与「因裁定撤下」。

这是必需的：两种情况对运营的动作完全不同——前者要去看字段，后者要去看裁定。

### 7. `same_entity` 裁定结果只出现在**链接与冲突的上报字段**上

- 链接新增 `ruling`：`'same_entity'` / `'unruled'`（无该概念的 `same_entity` 裁定）；
- `alias_divergence` 冲突项新增 `ruling`：`null` / `'same_entity'` / `'distinct_entity'`，冲突本身**仍然上报**（声明里确实有多个字段名，这是事实），只是标注已裁定；
- `rulingReport`：`applied` / `withdrawnLinks` / `unresolvedConcepts` / `droppedStale`。

`unresolvedConcepts`（仍有 `alias_divergence` 但未裁定的概念）是本轮最需要被看见的一项：它恰好就是「有多少条链接的等价前提还没人看过」的答案。

## Consequences

### 变简单的地方

- 「支撑链接的等价假设」第一次有了可见、可裁定的入口；裁定后链接的存在性随之一致变化，不会出现「界面显示 4 条、其中 2 条的前提已被否定」。
- 裁定与确认的职责边界清晰：裁定改输入、确认写草稿，两者不可能混用，也不需要引入新的证据等级。
- 撤销、重复保存、失效三种状态与 4b 同构，实现与用例可以复用同一套口径。

### 变复杂的地方（如实）

- 提案上现在有两类人工结论（裁定、确认），且**顺序有依赖**：先裁定、后确认。界面上必须把顺序表达清楚，否则运营可能在未裁定的等价前提上逐条确认 9 条链接。
- `distinct_entity` 的分组是**自由划分**，人可以对同一个概念给出完全不同的等价类；服务端只校验「是不是一个合法划分」，不校验「划得对不对」。这是刻意的（域语义只能由人给），但代价是裁定质量无法被机器兜底。
- `droppedStale` 从字符串数组变成对象数组，是对既有输出格式的**破坏性变更**（ADR-015 落地当天的输出）。当前只有内置合成数据与用例在读它，故直接改而不做兼容层；若已有外部消费方，需要单独评估。

### 明确不在本 ADR 范围内

- **`ambiguous_identifier` 的归属指派**：当前实测 0 条，且它的粒度与前两类不同——泛化标识（`id` / `code`）在同一对象的不同出现位置语义可以完全不同，裁定必须按「系统.对象.字段」而非按概念给出。没有真实用例驱动时先不做，避免设计一个没有验证场景的粒度。
- **`declaration_divergence` 的合并 / 区分粒度**：这是**对象级**裁定，会改变字段目录的合并语义（当前实现是同一 `objectId` 的字段取并集）。它属于阶段 4c 的下一段。
- **`key_shape_incompatible` 的结构化标识映射**：ADR-015 复审条件 2 已把它列为独立决策（映射表需要版本与责任人）。当前仍由 `requires_mapping` + 自由文本依据承载。
- **`withdrawnLinks` 的跨修订对比**：本 ADR 只上报「本次撤下了哪些」，不做「与上一版相比少了哪些」的差异视图。

## 退出/复审条件

1. **若裁定开始直接产生草稿关系**：须重新论证「先裁定、后确认」这两个关口为什么还需要分开，以及裁定的证据等级是什么。
2. **若 `distinct_entity` 的分组要参与跨系统对齐之外的判断**（例如影响对象粒度或数据授权）：须重新评估裁定的作用面。
3. **若 `ambiguous_identifier` 开始有归属指派入口**：须先给出按「系统.对象.字段」粒度裁定的形式，并说明它与本 ADR 按概念裁定的两套粒度如何共存。
4. **若 `droppedStale` 需要与外部消费方兼容**：须引入版本化输出或兼容层，不得静默改变语义。

## 关联

- [ADR-015](ADR-015-identity-link-confirmation.md)：确认后并入与证据等级（**本 ADR 解决其复审条件 3**）
- [ADR-014](ADR-014-identity-linking-as-assumption.md)：标识对应先推导上报，冲突只上报
- [ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md)：范围是过滤器（撤下与排除都必须显式）
- [ADR-012](ADR-012-explicit-modeling-scope.md)：范围必须显式给出（全量语义与省略/空的区分同源）
- [系统接入重构方案](../SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md) 第 6 节阶段 4c
- [SEMANTIC_MODEL_AUTHORING.md](../SEMANTIC_MODEL_AUTHORING.md)

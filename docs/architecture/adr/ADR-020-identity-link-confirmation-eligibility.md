# ADR-020: 一条标识对应「有没有资格被确认」的判据唯一化

## Status

Accepted

## Context

### 当时的约束

[ADR-015](ADR-015-identity-link-confirmation.md) 决策 1 规定：跨系统标识对应**只能经人工逐条确认后并入**草稿关系，确认动作复用既有复核动作（PATCH 提案）。[ADR-019](ADR-019-structured-key-mapping.md) 把确认这一关的输入从一类扩为三类（形状判定 / 结构化映射定义 / 直接确认），并在「实测边界 二」里把下面这件事**只钉住、未修**：

> 实测全量 11 条对应里有 **5 条** `notInProposal: true`……即接近一半的对应当前**不可并入草稿**……错误原因与事实**对不上**。

同一处留下了本 ADR 要回答的问题原话：**「哪些对应**有资格**被确认」（推导层就标为不可确认，还是给一个专用错误码并说清缺哪个对象）是一次独立决策。**

### 触发点（本机实测，内置合成数据 6 系统，确定性）

把 11 条对应逐条拿去单独确认（每条用一份新任务），再与字段目录的 grounding、草案候选对象 id 集对照，得到一张完整对照表：

| # | 对应（证据串） | 源端目录 grounding | 源对象在候选内 | 实测确认 |
| --- | --- | --- | --- | --- |
| 0 | `ERP.Inventory.lot_no` → `WMS.RawMaterialBatch.material_batch_id` | `source_system_declaration` | **是** | **成功** |
| 1 | `LIMS.Sample.material_batch_no` → `WMS.RawMaterialBatch.material_batch_id` | `source_system_declaration` | 否 | 失败 |
| 2 | `LIMS.TestResult.material_batch_id` → `WMS.RawMaterialBatch.material_batch_id` | `proposal_object` + `source_system_declaration` | 是 | 成功 |
| 3 | `MES.ProductionBatch.material_batch_id` → `WMS.RawMaterialBatch.material_batch_id` | `proposal_object` + `source_system_declaration` | 是 | 成功 |
| 4 | `MES.ProductionBatch.product_code` → `ERP.ProductSKU.product_id` | `proposal_object` + `source_system_declaration` | 是 | 成功 |
| 5 | `OMS.Order.sku` → `ERP.ProductSKU.product_id` | `source_system_declaration` | 否 | 失败 |
| 6 | `QMS.FinishedGoodsBatch.product_code` → `ERP.ProductSKU.product_id` | `proposal_object` | 是 | 成功 |
| 7 | `QMS.QualityEvent.product` → `ERP.ProductSKU.product_id` | `source_system_declaration` | 否 | 失败 |
| 8 | `WMS.InboundReceipt.purchase_order_id` → `ERP.PurchaseOrder.purchase_order_id` | `source_system_declaration` | 否 | 失败 |
| 9 | `WMS.RawMaterialBatch.material_code` → `ERP.Material.material_id` | `proposal_object` | 是 | 成功 |
| 10 | `WMS.RawMaterialBatch.supplier_id` → `ERP.Supplier.supplier_id` | `proposal_object` | 是 | 成功 |

**实测结论一：可确认 7 条 / 不可确认 4 条。** 判据与服务端草案校验（`sanitizeProposalDraft` 里 `objectIds.has(item.from) && objectIds.has(item.to)`）完全一致：**两端 `objectId` 都在本次候选对象内 ⟺ 可确认**。上表「源对象在候选内」一列与「实测确认」一列**逐行相同**，0 例外。

**实测结论二：`notInProposal`（5 条）与「不可确认」（4 条）不是同一件事——差的那一条是误报。**

`notInProposal` 的判据是 `!object.groundings.includes('proposal_object')`，即「**这条目录条目的声明依据里没有『本次候选对象』**」。它回答的是**证据来源**，而资格问的是**草案成员资格**：

- `ERP.Inventory` 这条目录条目只来自 ERP 的**系统配置声明**（grounding = `source_system_declaration`），于是被标 `notInProposal: true`；
- 但它的**对象名 `Inventory` 与本次候选对象 `Inventory` 同名**（后者来源为 WMS），草案校验因此通过，**实测确认成功**；
- 界面据此显示「该来源系统本次未进入候选对象，依据来自系统声明」——**这是一句事实错误**：ERP 在本次范围内，`Inventory` 也在候选对象里。运营看到这句话，会认为这条对应不可用，实际上它可用。

同时，剩下 4 条 `notInProposal: true` 是**真不可确认**，但原因说错了两层：

```
关系的起点、终点和谓词必须完整，并引用本次候选对象。
```

1. **「必须完整」不成立**——`from` / `to` / `predicate` 三者俱全，缺的不是完整性；
2. **没说清缺哪个对象**——`OMS.Order`、`LIMS.Sample`、`QMS.QualityEvent`、`WMS.InboundReceipt` 是四个来自系统配置声明、本次未被抽为候选对象的对象，运营需要知道的是**它们的名字**，而不是一句关于端点完整性的通用话术。

### 与本次重构一路的同型问题

这与 [ADR-018](ADR-018-declaration-divergence-merging.md) 的「复合条目判据不能只看声明条数」是**同一型**：**一个 flag 同时承载两个不同的问题，于是它在其中一个问题上必然说谎。**

具体到这里，一个 `notInProposal` 被三处同时读作三件事：

| 读它的地方 | 想表达的意思 | 实际来自 |
| --- | --- | --- |
| 界面 `<small>` | 「该来源**系统**本次未进入候选对象」 | 声明 grounding（**判据与表述都不对**） |
| 关系 `evidence` | 「依据来自系统声明」 | 声明 grounding（**这一处是对的**） |
| 确认结果（隐含） | 「这条能不能并入草稿」 | 完全没查，靠草案校验兜底报错 |

## Decision

### 1. 资格判据唯一化，且与草案校验**同源**

一条标识对应可确认，当且仅当**两端 `objectId` 都在本次候选对象内**：

```js
eligible = candidateObjectIds.has(link.from.objectId) && candidateObjectIds.has(link.to.objectId)
```

`candidateObjectIds` 由推导层从**它已经拿到的 `objects`**（即草案的 `objectTypes`）直接构造——与 `sanitizeProposalDraft` 构造 `objectIds` 的那一步读的是**同一个数组**。因此「推导层说可确认」与「服务端能写进去」不会分叉，这是本决策的**全部价值**：资格不再是一个需要被二次解释的信号，而是**同一判据的两次读取**。

### 2. 不可确认的对应**必须披露**，不得从清单里隐藏

它们在 `links` 里保留，带三个字段：

```js
eligible: false,
ineligibleEndpoints: [{ role: 'from', system: 'OMS', objectId: 'Order', groundings: ['source_system_declaration'] }],
ineligibleReason: '来源对象 OMS.Order 的依据是系统配置声明，不是本次候选对象，无法并入草稿；如需并入，请先让 Order 成为本次候选对象。'
```

**为什么是披露而不是过滤**：这条对应是**系统声明里真实存在的跨系统引用**——「OMS 的订单引用了 ERP 的产品」是一件事实，它只是此刻**写不进本次草稿**。把它从清单里删掉，运营看到的就是「本次没有 OMS 到 ERP 的引用」，而真相是「有，但 OMS.Order 这次没被抽出来」。这与本重构一路的「披露不等于修正」（[ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md) 的被排除清单、[ADR-018](ADR-018-declaration-divergence-merging.md) 的未裁定并集）同立场。

`ineligibleReason` 必须**可行动**：点名对象 + 说明它的依据来自哪里 + 给出让它可确认的动作。

### 3. 不可确认的确认请求 = **专用硬错误**

```
SEMANTIC_IDENTITY_CONFIRMATION_ENDPOINT_OUT_OF_SCOPE
```

- 文案点名对象并说明真实原因，**不得**再落到通用草案校验的「关系的起点、终点和谓词必须完整」上；
- 是**硬错误**而非静默跳过：界面已经把不可确认的对应标出并拦下，仍提交一条就说明客户端拿的是旧结论或忽略了标记——这与 ADR-015 决策 6 的 `_STALE` 同源；
- 检查次序固定为 **链接存在 → 资格 → 形状 → 映射 → 接受**。资格排在形状之前：一条连端点都写不进去的边，问它「形状是什么」没有意义。

### 4. 两个判据拆开，名字各自诚实

`notInProposal` **改名 `declarationSourced`**，判据不变（`!groundings.includes('proposal_object')`），职责收窄为**只回答「这条对应的依据来自系统配置声明，而不是本次候选对象」**，仅用于依据说明；**它不再是可确认性的任何信号**。

- 界面文案由「该来源**系统**本次未进入候选对象，依据来自系统声明」改为「来源端依据为系统配置声明」，**不再对资格作任何陈述**；
- 关系 `evidence` 里的同句改为「来源依据为系统配置声明」（原句把「系统未进入候选」写进去，正是那个误报的来源）；
- **保留这个字段而不是删除**：它是真的信息（依据是配置声明而非候选对象），只是它过去被误用作资格判据。

### 5. 计数进 `summary` 与任务回应

- `summary.eligible` / `summary.ineligible`：运营要知道「11 条里 7 条这次能确认」，而不是从错误码里反推；
- 任务回应新增一句：`另有 N 条对应本次不可并入（原因 + 缺哪个对象）`。缺了这句，`links` 从 11 变成 7 可用又是一次静默损失（与 [ADR-014](ADR-014-identity-linking-as-assumption.md) 的「推导结果数必须独立可见」同一纪律）。

### 6. 不为了让它们可确认而放宽草案校验

把「不在候选内的对象」当作端点写入，会产出**悬空边**（边的端点在草案 `objectTypes` 里不存在）。草案的对象成员资格是一条基础不变量（阶段 3 起），本 ADR **不动它**。

也不通过自动补对象来消除不可确认：把 `OMS.Order` 自动加进候选对象，等于让标识推导**反向决定对象抽取结果**，而对象来源与范围是 [ADR-012](ADR-012-explicit-modeling-scope.md) / [ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md) / [ADR-017](ADR-017-model-extraction-attribution.md) 三处已经定过的决策。

## Consequences

### 变简单的地方

- 界面上的那句**事实错误消失**：`ERP.Inventory.lot_no`（实测可确认）不再被标成「来源系统未进入候选对象」；
- 运营第一次能看到「**哪些对应这次能用、哪些不能用、为什么**」，且不可用的原因点名到对象并给出下一步动作；
- 标识对应这条路径不再被通用草案校验兜底：`SEMANTIC_PROPOSAL_INVALID` 回归它本来的职责（真的端点不完整 / 重复 / 引用不存在的对象），而不再替资格问题说一句不成立的话；
- 资格是**同一判据的两次读取**，不依赖任何人记得同步两处。

### 变复杂的地方（如实）

- 链接多三个字段（`eligible` / `ineligibleEndpoints` / `ineligibleReason`），`summary` 多两项；
- 界面要新增「不可确认」这一种呈现（且不能与 `shape_unknown` / `requires_mapping` 混在一起表达）——三态之上再叠一层资格，运营需要看懂「这条连确认入口都没有」；
- **不可确认的对应会长期存在**：只要系统配置声明里有候选对象之外的对象（字段目录里有 8 个对象只来自系统配置声明、不在本次候选内，其中 4 个产生了不可确认的对应），它们就会持续出现在清单里并持续不可确认。这是**如实披露的代价**，不是缺陷。

### 明确不在本 ADR 范围内

- **系统声明的对象自动进入候选**：即「按声明补齐候选对象」。这改的是对象来源与范围（ADR-012 / ADR-013 / ADR-017 的地盘），不是资格判据；当前也没有用例驱动。
- **`ERP.Inventory` 与候选 `Inventory` 的归属分歧**：两者同名、来源不同（前者是 ERP 配置声明，后者 `sourceSystems = ['WMS']`）。这是**归属**问题，属 ADR-017 归属关口的范畴；本 ADR 只保证「确认后的边落在草案里真实存在的对象上」，不为同名声明裁定归属。此处如实单独标注（见「实测边界 一」）。
- **`unresolvedReferences` 的合并**：现有 `unresolvedReferences` 说的是「被引用但没有实体以该概念为标识」；本 ADR 说的是「来源对象本身不在候选内」。两者原因与动作都不同，不合并。
- **`ambiguous_identifier` 的按字段归属指派**：ADR-016 复审条件 3 要求的「系统.对象.字段」粒度形式仍未给出（实测 **0 条**）。

### 实测边界（如实）

**一、`ERP.Inventory` 的同名巧合是一个未关闭的观察，不是已修问题。** 实测 `ERP.Inventory.lot_no → WMS.RawMaterialBatch.material_batch_id` 可确认，并入的边落在草案对象 `Inventory` 上，而该对象的 `sourceSystems = ['WMS']`。边本身是合法的（草案里只有这一个 `Inventory`），但「ERP 的库存表」与「WMS 的库存对象」是不是同一件事，**本 ADR 不回答**——它由 ADR-017 的归属关口处理，本次只把它记在这里，避免下次有人重新把它当成新发现。

**二、`ADR-019` 的两处描述就此修正。** ADR-019「实测边界 一」写的「`WMS.InboundReceipt` 那类则是归属被记为材料推断」**与实测不符**：`WMS.InboundReceipt` 的目录 grounding 是 `source_system_declaration`，`sourceBasis` 是 `confirmed`，它属于真不可确认的那 4 条，与「材料推断归属」无关；本 ADR 的对照表逐行为准。ADR-019 同处「5 条……即接近一半的对应当前不可并入草稿」中「5 条」的正确数为 **4 条**（第 5 条 `ERP.Inventory.lot_no` 实测可确认）。两处已在 ADR-019 就地标注。

**三、本增量的验收规模**：`test:identity` **21/21**（改写用例 20 为闭合缺口的用例、重写用例 18、新增用例 21），`test:declaration` 12/12、`test:attribution` 12/12 未受影响；`test:architecture` **10/10（未增跨域边）**；前端 `workspace-layout` **7/7**；`summary.eligible` **7** / `summary.ineligible` **4**（合计仍等于 `links = 11`）；`docs:check` **182 份 Markdown / 1104 个本地链接**；`npm run quality` 端到端 **EXIT=0**（1m48s，全量 35 个 Node 测试块 `fail=0`、0 处 `not ok`）；5 端构建通过（web 2.31s + 元域智语 2.98s、desktop 2.50s、mobile 2.53s、dingtalk 3.88s，分端调用避开沙箱 safe-delete 阈值）。

## 退出/复审条件

1. **若不可确认的对应被允许确认**（例如为了「先记下来」而放宽草案校验）：须重新论证草案的对象成员资格这条不变量为什么还需要，以及一条端点不在草案里的边在模型里意味着什么。
2. **若资格判据改为「按声明 grounding 判定」**（即回到 `notInProposal` 的老判据）：须重新评估同名巧合场景（`ERP.Inventory` / `Inventory`）的误判面，并说明如何向运营解释「可用却被标不可用」。
3. **若下游需要写入「只在系统声明里存在、未进入候选」的对象的跨系统引用**：须重新评估草案的对象成员资格模型——是否需要一个显式的「外部引用对象」概念，而不是靠现在的悬空边禁令。
4. **若不可确认的对应长期为 0**（例如抽取能力覆盖了全部声明对象）：须重新评估 `eligible` 这个显式字段是否还值得留在链接上。

## 关联

- [ADR-015](ADR-015-identity-link-confirmation.md)：确认后并入（**本 ADR 细化了这一关的前置条件**：确认的前提是端点对象在草案里）
- [ADR-019](ADR-019-structured-key-mapping.md)：标识映射结构化与三态定级（本 ADR 承接其「实测边界 二」只钉未修的那条口径，并修正其两处不实的描述）
- [ADR-014](ADR-014-identity-linking-as-assumption.md)：标识对应先推导上报（「推导结果数必须独立可见」的纪律被本 ADR 的 `summary.ineligible` 复用）
- [ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md)：范围作为过滤器与显式排除清单（「披露不等于修正」的同立场）
- [ADR-017](ADR-017-model-extraction-attribution.md)：材料归属由模型取证（`ERP.Inventory` 归属分歧属该关口的范畴）
- [ADR-018](ADR-018-declaration-divergence-merging.md)：同名声明合并 / 区分裁定（「一个判据承载两个问题必然说谎」的同型教训）
- [系统接入重构方案](../SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md) 第 6 节阶段 4e
- [SEMANTIC_MODEL_AUTHORING.md](../SEMANTIC_MODEL_AUTHORING.md)

# ADR-019: 标识映射改为结构化定义；「形状未判定」从「形状不同」里拆出来

## Status

Accepted

## Context

### 当时的约束

[ADR-015](ADR-015-identity-link-confirmation.md) 决策 4 规定：两端键形状不同的对应（`requires_mapping`）**必须随确认给出映射依据**，依据写进关系 `evidence`（自由文本，80 字）。同一 ADR 留下**复审条件 2**：

> **若 `requires_mapping` 的映射依据改为结构化映射定义**（而不是自由文本）：须重新评估「依据是否可核对」，并给出映射表的版本与责任人。

[ADR-016](ADR-016-identity-conflict-rulings.md) 把 `key_shape_incompatible`（同一概念上代理键与业务键混用）列为「不在本 ADR 范围内」，[ADR-018](ADR-018-declaration-divergence-merging.md) 同样把它留给后续。四类冲突里，这一类是**唯一仍由自由文本承载**的。

### 触发点（本机实测，内置合成数据 6 系统，确定性）

原判据下 `requires_mapping` 实测 7 条（`linkable` 4 条）。逐条看形状后，7 条里只有 5 条成立：

**（a）两端形状都已知且不同——真正的 `requires_mapping`，5 条：**

| 概念 | 源键 → 目标键 | 源形状 / 目标形状 |
| --- | --- | --- |
| MaterialBatch | `ERP.Inventory.lot_no` → `WMS.RawMaterialBatch.material_batch_id` | business / agent |
| MaterialBatch | `LIMS.Sample.material_batch_no` → `WMS.RawMaterialBatch.material_batch_id` | business / agent |
| Product | `MES.ProductionBatch.product_code` → `ERP.ProductSKU.product_id` | business / agent |
| Product | `QMS.FinishedGoodsBatch.product_code` → `ERP.ProductSKU.product_id` | business / agent |
| Material | `WMS.RawMaterialBatch.material_code` → `ERP.Material.material_id` | business / agent |

**（b）至少一端形状未判定——被原判据错并入 `requires_mapping`，2 条：**

| 概念 | 源键 → 目标键 | 源形状 / 目标形状 |
| --- | --- | --- |
| Product | `OMS.Order.sku` → `ERP.ProductSKU.product_id` | **null** / agent |
| Product | `QMS.QualityEvent.product` → `ERP.ProductSKU.product_id` | **null** / agent |

`key_shape_incompatible` 冲突 4 条：`Material`（`material_id` / `material_code`）、`MaterialBatch`（`material_batch_id` / `lot_no`、`material_batch_no`）、`Product`（`product_id` / `product_code`）、`ProductionBatch`（`production_batch_id` / `batch_no`）。

**改造前**确认一条 `requires_mapping` 后，草稿里那条边的实测形态（本 ADR 要修的就是它）：

```json
{
  "from": "Inventory", "predicate": "references_lot_no", "to": "RawMaterialBatch",
  "cardinality": "n:1", "provenanceType": "inferred",
  "derivedFrom": "MaterialBatch:ERP.Inventory.lot_no->WMS.RawMaterialBatch",
  "evidence": "人工复核确认的标识对应（推断，非材料写明的外键）：…；两端键形状不同（business / agent），不按值直接对齐；映射依据：<人写的 80 字自由文本>；依据：字段名归一化到业务概念 MaterialBatch，基数 n:1；…"
}
```

**改造后**同一条边多出一个机器可读的结构字段（证据等级不变）：

```json
{
  "from": "Inventory", "predicate": "references_lot_no", "to": "RawMaterialBatch",
  "cardinality": "n:1", "provenanceType": "inferred",
  "derivedFrom": "MaterialBatch:ERP.Inventory.lot_no->WMS.RawMaterialBatch",
  "keyMapping": { "fromField": "lot_no", "toField": "material_batch_id", "basis": "master_data_lookup", "lookupSource": "<对照表>", "owner": "<责任人>", "version": "<版本>" },
  "evidence": "…；两端键形状不同（business / agent），不按值直接对齐；映射依据：主数据对照表（<对照表>），责任人 <责任人>，版本 <版本>；…"
}
```

### 两个缺口，都不是「自由文本够不够好」的问题

**缺口一：「不可按值连接」这件事在草稿里不可读。**

上面那条边与一条 `linkable` 的边**结构完全相同**——同样的 `predicate`、`cardinality`、`provenanceType: 'inferred'`。区别只在一段中文里。任何下游消费者（治理链路的证据检查、Semantica 采纳、将来的数据通道按值连接）想区分这两类边，**只能去解析自然语言**。

这与本次重构一路在消除的模式同构：**结论（这条边可用）可见，支撑它的前提（必须先经外部映射表）不可见**。阶段 4a 消除了「对应被当成结论」，4b 消除了「假设被当成证据」，4c 第一段消除了「等价前提从未被看见」，4c 第二段消除了「归属断言无法复核」，4c 第三段消除了「两处声明被合成复合体」。这里剩下的是**「一条需要外部映射才能使用的边，在模型里与一条可直接使用的边长得一样」**。

**缺口二：`status` 判据把「形状未知」当成了「形状不同」。**

`status = field.shape === (target.identifierKind === 'primary' ? 'agent' : 'business') ? 'linkable' : 'requires_mapping'`——这是一个二元判定，而 `field.shape` 有三个取值：`agent` / `business` / `null`。`null` 的含义是「**这不是一个带标识后缀的字段**」；对裸名（`sku`、`product`，在 `BARE_IDENTIFIER_NAMES` 白名单里）来说，`null` 意味着**形状未被命名规则判定**，而不是「已知它与另一端不同」。

实测后果有两层：

1. **7 条 `requires_mapping` 里有 2 条（29%）的理由不成立**：`OMS.Order.sku`、`QMS.QualityEvent.product` 被要求填写「映射依据」，而机器其实还没判定它们的形状。**要求一个人回答机器尚未判明的问题**，答案的质量无法保证——运营可能填一句「按业务约定映射」，而真正该先做的是「这个字段到底是代理键还是业务键」。
2. **给出的说明文案读不通**：`两端键形状不同（null / agent），不按值直接对齐`——「null 形状」对运营不是一句话。

这与 [ADR-018](ADR-018-declaration-divergence-merging.md) 的「复合条目判据不能只看声明条数」同型：**判据必须落在内容上，不能在内容未知时给出结论**。

### 需要回答的具体问题

1. `requires_mapping` 的依据要不要结构化？结构化到什么程度——每条边内嵌定义，还是独立映射表？
2. 「形状未知」要不要成为一个独立状态？它的确认动作是什么？
3. 结构化定义进草稿后，证据等级是否改变？
4. 撤销、继承失效、非法输入怎么处理？
5. ADR-015 复审条件 2 里的「映射表的版本与责任人」如何满足？

## Decision

### 1. `status` 由二态改**三态**，「形状未判定」独立成状态

| status | 条件 | 确认时要求 |
| --- | --- | --- |
| `linkable` | 两端形状**都已知且一致** | 直接确认（无额外输入） |
| `requires_mapping` | 两端形状**都已知且不同** | 结构化映射定义（见决策 3） |
| `shape_unknown` | **至少一端形状未判定**（`null`） | 形状判定（见决策 2） |

`summary` 相应拆为 `linkable` / `requiresMapping` / `shapeUnknown` 三项。实测：7 条 → **5 条 `requires_mapping` + 2 条 `shape_unknown`**（源头两条正是 `OMS.Order.sku` 与 `QMS.QualityEvent.product`）。

**「未知」不能当「不同」**：把未知并入不同，会让风险等级相同但**动作完全不同**的两件事走同一入口——未知要做的是「先判形状」，不同要做的是「给出映射」。混在一起的直接代价就是实测那两条边的说明文案写不出来。

### 2. `shape_unknown` 的确认要求是「形状判定」，且**不写回声明**

确认项可带 `shape: 'agent' | 'business'`：

- 对 `shape_unknown` 的链接给出判定 → 服务端据此**重新定级**该条边：与另一端一致 → `linkable`；不同 → `requires_mapping`（这时才要求映射定义）；
- 对**非** `shape_unknown` 的链接提交 `shape` → 硬错误（`SEMANTIC_IDENTITY_CONFIRMATION_SHAPE_NOT_APPLICABLE`）——对一条形状已明确的边提交形状判定，说明界面拿的是一份过期结论（与 ADR-015 决策 6 的 `_STALE` 同源）；
- 判定值不在枚举内 → 硬错误（`..._SHAPE_INVALID`）。

**不写回字段声明**：形状判定是**这条边上的结论**，不是对系统声明的改写。写回声明会污染 `buildSystemFieldCatalog`（一处判定会影响所有读该字段的地方），而当前所有可判定的场景都只出现在具体一条边上。代价如实：同一个裸名字段若出现在多条边上，需要重复判定；当前实测无此情形（两个裸名字段各只出现一条边）。

### 3. `requires_mapping` 必须给出**结构化映射定义** `keyMapping`

```js
keyMapping: {
  fromField,        // 必填，服务端校验必须等于链接的 from.field
  toField,          // 必填，服务端校验必须等于链接的 to.field
  basis,            // 必填，枚举：master_data_lookup | manual_register | derived_rule | external_system
  lookupSource,     // basis = master_data_lookup 时必填（哪张对照表 / 哪个来源）
  owner,            // 必填，责任人
  version           // 必填，映射版本
}
```

- `fromField` / `toField` **必须与链接两端逐字一致**，否则硬错误——否则人可能把另一条边的映射写到这里，而草稿里看不出错位；
- `basis` 是**「为什么能对上」的分类**，不是「对不对」的判断：`master_data_lookup`（有对照表可查）/ `manual_register`（人工维护的对照登记）/ `derived_rule`（可由规则派生，如补零、加前缀）/ `external_system`（依赖外部系统提供的映射）。机器不判对错——与 ADR-016 / ADR-018 同立场；
- `evidence`（自由文本）**保留但降级为可选**，上限仍 80 字。它回答「人为什么这么判」，**不再承担表达结构的职责**。

### 4. 结构化映射**必须进草稿**，证据等级**不变**

- 关系新增 `keyMapping` 字段，并登记进 `sanitizeProposalDraft` 的关系白名单（**「新增字段不进白名单即被静默丢弃」这一缺口在 `publicTask`、`derivedFrom` 上各踩过一次，本 ADR 是第三次预防**）；
- 边仍标 `provenanceType: 'inferred'`，**不因有了结构化映射而升格**：映射表是人给的，不是材料里写明的外键；
- 于是下游可以**机器读**到「这条边需要经映射」，以及映射的**责任人与版本**；
- `evidence` 仍保留人可读串（其中的映射依据段落改为引用 `basis` 与责任人），但不再是唯一载体。

### 5. 全量语义、失效与撤销，与既有四套同构

- 确认集合**省略** → 不调整；**空数组** → 撤销全部；显式提交不存在的 key → 硬错误（ADR-015 决策 6 不变）；
- **形状判定与映射定义同属确认项**：撤销确认时两者一同消失，不留孤儿形状判定；
- **已判定 / 已给映射的确认项被继承时保持原级**：确认项上分别记了 `shape` 与 `keyMapping`，省略确认集合的那一轮会把它们原样带回并重新定级，因此「没重新提交」不会让一条已判定的边掉回未判定态。

> **实现后的自我修正**：本 ADR 起草时写了「继承的确认若其链接从 `requires_mapping` 降级为 `shape_unknown` → 写入 `droppedStale`，不阻断修订」。实现时核对发现这条**描述的是不可达状态，且与实际行为不符**：
>
> - **不可达**：链接 key 是 `概念:源系统.源对象.源字段->目标系统.目标对象`，而 `from.shape` 是**源字段名的纯函数**（裸名 → `null`）。key 稳定 ⟺ 源字段名稳定 ⟺ `from.shape` 稳定；`to.shape` 由目标对象标识类型决定，取值为 `agent` / `business`，**永不为 `null`**。因此一条 key 稳定的链接不可能从「两端已知」变成「形状未判定」。
> - **若真出现**，实际行为是硬错误 `SEMANTIC_IDENTITY_CONFIRMATION_SHAPE_REQUIRED`，而不是静默降级。
>
> 这个方向是保守的（宁可挡住，也不把一条形状未判定的边放进草稿），所以不改为静默 `droppedStale`；复审条件 2 因此仍是「不允许未判形状就确认」。此处如实修正，避免文档描述一个不存在的分支。

### 6. **不做独立映射表实体**——`owner` / `version` 是将来升格的钩子

ADR-015 复审条件 2 要求「给出映射表的版本与责任人」。本 ADR 的选择是：**把版本与责任人收在每条确认项里**，不新建映射表实体（存储、发布、审批、跨任务引用、失效传播全都不做）。

理由（如实）：

- **没有复用证据**：实测 7 条映射全部在各自任务内一次性给出，**没有一条被两条边共享**。为不存在的复用建表，是「为形式而形式」；
- 建表会**让追溯变难**：映射表由谁维护、某条边用的是哪一版，需要额外的引用与版本快照机制；而收在确认项里，「谁在什么时候为哪条边写了什么」与提案修订历史天然对齐；
- `owner` / `version` 两个字段**就是升格的钩子**：若将来真的出现复用（同一条映射被多条边引用，或跨任务复用），可由这两列反向聚合出映射表，而不必先建表再回填。

**这是对复审条件 2 的「部分满足」**：复审条件字面是「**若**改为结构化定义，须重新评估『依据是否可核对』并给出版本与责任人」。本 ADR 的结论是「**改为结构化定义，但不是改成映射表**」——「可核对」的含义相应收窄为：**结构与两端键逐字一致可由机器校验；`basis` 可选集合、`owner`、`version` 非空可校验；但「这个映射对不对」不在机器能力范围内**（对象叫什么、两个键怎么对上，是域语义）。

## Consequences

### 变简单的地方

- 「需要外部映射才能使用」第一次在草稿里**机器可读**（`keyMapping`），而不是只活在一段中文里；
- 「形状未判定」不再被伪装成「形状不同」：实测 2 条边（29%）的确认动作从「写映射依据」回到正确的「先判形状」；
- 映射的责任人与版本随边一起进入模型链路，`droppedStale` 能说清「为什么这条确认失效了」；
- 非法输入有明确拒绝：形状不适用、形状值非法、映射字段错位、映射字段缺失各有错误码。

### 变复杂的地方（如实）

- 确认入口从「一条边的依据」变成「三态各一种输入」，界面必须把三态表达清楚，否则运营会对着 `shape_unknown` 的边找「填依据的地方」；
- 草稿关系多一个结构字段，下游（Diff 阅读、治理检查、Semantica 采纳）需要理解它；这是「把前提写进模型」的必要代价；
- **形状判定不写回声明**意味着同一裸名字段出现在多条边上时要重复判定（当前实测无此情形，但这是真实的设计代价）；
- 服务端仍只校验**结构**（字段名一致、枚举、非空），**不校验映射是否正确**——`basis: 'manual_register'` 后面可能是一句空话，机器不拦。

### 明确不在本 ADR 范围内

- **独立映射表实体**（存储 / 版本发布 / 审批 / 跨任务引用 / 失效传播）：见决策 6 的理由，靠 `owner` / `version` 留钩子。
- **`key_shape_incompatible` 冲突的裁定动作**：本 ADR 让 `requires_mapping` 的确认变得可核对，但**冲突本身仍只有上报**（它是「声明里同时存在两种形状」这个事实）。是否需要一个「同一概念上以哪个键为准」的裁定动作，当前**没有用例驱动**（实测这 4 条冲突在 `declaration_divergence` 的 `distinct` 场景下会随字段拆分而消失）——留待需要时再决策。
- **`ambiguous_identifier` 的按字段归属指派**：ADR-016 复审条件 3 要求的「系统.对象.字段」粒度形式仍未给出。
- **映射正确性的机器校验**（例如真的去查那张对照表）：需要对数据通道的实际可访问性，属阶段 5 之后。

### 实测边界（如实）

**一、`shape_unknown` 的「判定后并入草稿」在现有合成数据下**不可达**。**

实测两条 `shape_unknown` 对应的**源对象都不在本次候选对象之内**（`OMS.Order`、`QMS.QualityEvent`）——任务级并入走到端点校验时会被 `SEMANTIC_PROPOSAL_INVALID` 挡下，因此「判形状 → 重定级 → 并入」这条路径只能在**纯函数层**取证（`backend/test/semantic-identity-link.test.js` 用例 19 用 `deriveIdentityLinking` + `buildConfirmedRelationships` 夹具锁死）。任务级用例（用例 18）只覆盖三条**拒绝路径**，它们与端点是否在范围内无关。

> **修正（2026-09-25，[ADR-020](ADR-020-identity-link-confirmation-eligibility.md)）**：本处原写「…；WMS.InboundReceipt 那类则是归属被记为材料推断」，**与实测不符**。实测 `WMS.InboundReceipt` 的目录 grounding 是 `source_system_declaration`、`sourceBasis` 是 `confirmed`，它属于「源对象不在候选内」的同一类，与「材料推断归属」无关（本轮 11 条对应里没有任何一条的 `sourceInferred` 为真）。

**二、`notInProposal` 的对应「列进可确认清单但确认不了」——本 ADR 之外，只钉不修。**

实测全量 11 条对应里有 **4 条**真不可并入草稿（`LIMS.Sample` / `OMS.Order` / `QMS.QualityEvent` / `WMS.InboundReceipt` 四个来源对象不在本次候选对象内）。界面把它们的 `notInProposal` 说明（「该来源系统本次未进入候选对象，依据来自系统声明」）显示出来，但真去确认时的错误是：

```
关系的起点、终点和谓词必须完整，并引用本次候选对象。
```

错误原因与事实**对不上**：真实问题是**来源对象本身不在本次范围内**，不是「关系端点不完整」。这是阶段 4b 起就存在的口径缺口，与形状 / 映射无关；「哪些对应**有资格**被确认」（推导层就标为不可确认，还是给一个专用错误码并说清缺哪个对象）是一次独立决策，不在本增量内顺手改。用例 20 把现状钉住并写明「修好它时这条用例会失败，应连同 ADR 一起更新，而不是删掉断言」。

> **修正（2026-09-25，[ADR-020](ADR-020-identity-link-confirmation-eligibility.md)）**：本处原写「**5 条** `notInProposal: true`……即接近一半的对应当前**不可并入草稿**」，两个数都要更正。`notInProposal` 实测确为 **5 条**，但其中 `ERP.Inventory.lot_no → WMS.RawMaterialBatch.material_batch_id` **实测确认成功**（`ERP.Inventory` 是配置声明，而其对象名 `Inventory` 与本次候选对象同名），真不可确认的是 **4 条**。即 `notInProposal` 用**声明 grounding** 冒充**候选资格**，多标了 1 条；该缺口已由 ADR-020 关闭（`declarationSourced` 与 `eligible` 拆开）。

**三、本增量的验收规模**：`test:identity` **20/20**（新增用例 18/19/20），`test:declaration` 12/12、`test:attribution` 12/12 未受影响；`test:architecture` **10/10（未增跨域边）**；前端 `workspace-layout` 7/7；`requiresMapping` **7 → 5**、`shapeUnknown` **0 → 2**，三态合计仍等于 `links = 11`；`docs:check` 181 份 Markdown / 1068 个本地链接；`npm run quality` 端到端 **EXIT=0**（1m41s，全量 35 个 Node 测试块 `fail=0`、0 处 `not ok`）；5 端构建通过（分端调用）。

## 退出/复审条件

1. **若同一条映射开始被多条边引用**（复用证据出现）：须重新评估「独立映射表实体」的形态，并给出迁移口径（现有 `keyMapping` 如何聚合为表、版本如何对齐）。
2. **若 `shape_unknown` 的边被允许在未判形状的情况下确认**：须重新论证「未知不能被当成已知」这条为什么还需要，以及一条形状未知的边进入草稿意味着什么。
3. **若形状判定改为写回字段声明**：须重新评估对 `buildSystemFieldCatalog` 的影响面（哪些读取方会被一处判定影响），并给出撤销口径。
4. **若下游开始依赖 `keyMapping` 做实际数据连接**：须重新评估证据等级（`inferred` 是否足够），并说明「映射由人给出」与「连接可执行」之间的距离由谁负责。

## 关联

- [ADR-015](ADR-015-identity-link-confirmation.md)：确认后并入与证据等级（**本 ADR 回答其复审条件 2**；决策 4 的「必须给映射依据」升级为结构化定义，决策 6 的 `_STALE` 口径被形状判定复用）
- [ADR-014](ADR-014-identity-linking-as-assumption.md)：标识对应先推导上报（本 ADR 收窄 `requires_mapping` 的判据）
- [ADR-016](ADR-016-identity-conflict-rulings.md)：等价假设先裁定（同立场：机器只校验结构，不判语义）
- [ADR-018](ADR-018-declaration-divergence-merging.md)：同名声明合并 / 区分裁定（「判据必须落在内容上」的同型教训；`distinct` 会消解部分 `key_shape_incompatible`）
- [系统接入重构方案](../SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md) 第 6 节阶段 4c
- [SEMANTIC_MODEL_AUTHORING.md](../SEMANTIC_MODEL_AUTHORING.md)

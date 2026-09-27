# ADR-022: 候选对象的**覆盖面**与「没被生成」的对象名必须可点名

## Status

Accepted（2026-09-26）

## Context

[ADR-021](ADR-021-candidate-provenance-disclosure.md) 把候选对象的**来源**与**跳过抽取的原因**披露了出来，
但它自己留了一条明确的边界：

> **披露是「覆盖率级」而非「清单级」**：改动后那组材料**仍然是 1 类候选**，只是多了一句「可能遗漏，请核对」。
> 从「无人能解释」变成「知道可能漏、但不知道漏了哪个」——**点名漏了哪个需要对象抽取能力本身**，属下一步。

于是运营实际看到的是一句**无法执行的指令**：「候选对象中有 1 类来自受控目录关键词命中（…），受控目录共 12 类。
这条路只按词面匹配：材料里写到、但目录未覆盖的业务对象**不会**出现在候选里，**请核对是否遗漏**。」

核对什么？拿什么核对？目录到底缺什么？——一个都没有。**披露了事实，但没有给出可执行的对象。**

### 触发点（本机实测，临时探针 `catalog-coverage-probe.mjs`，内置合成数据，确定性）

| 材料 | 受控目录命中 | 未被覆盖的列举项 |
| --- | --- | --- |
| 「根据 ERP 的采购订单与供应商资料建立候选模型。」 | `Supplier ← 供应商`、`PurchaseOrder ← 采购订单、订单` | （无分隔符，不取词） |
| 「我们有订单、库存、发运三类数据，订单有单号和客户。」 | `PurchaseOrder ← 订单`、`Inventory ← 库存` | 无（噪声门挡住了「发运三类数据」「订单有单号和客户」） |
| 「采购订单、**发运单、出库单、客户投诉**」 | `PurchaseOrder ← 采购订单、订单` | **`发运单`、`出库单`、`客户投诉`** |

第三行就是 ADR-021 留下的那个洞：运营写清了四个业务对象，候选里只有一个，
而**目录到底缺什么**在任何地方都查不到。

### 两个此前从未被对起来看过的事实（本机实测）

1. **受控目录 12 类**（`semantic-operations-agent-service.js` 里的硬编码 `catalog`）；
2. **系统目录里已登记为「世界模型对象」的 21 类**（`data/system-catalog.js` 的 `worldObjectTypes`，
   6 个已接入系统各 3~4 类）。

两者求差集＝ **14 类**：`InventoryLot`/`Warehouse`/`InboundReceipt`/`OutboundShipment`（WMS）、
`ProcessStep`/`Deviation`（MES）、`Specification`/`Sample`（LIMS）、
`CAPA`/`ChangeControl`/`QualityEvent`（QMS）、`Order`/`Fulfillment`/`ReturnOrder`（OMS）。

**「发运单 / 出库单」进不来不是运营没写清**：承载它们的 `OutboundShipment` 早已在系统目录里被登记，
只是在**候选词表**里没有任何词条。这个结论以前没有任何地方能看出来——
**平台自己的两份知识之间有多大缺口，从来没有人量过**。

### 与本次重构一路的同型问题链

| ADR | 毛病 |
| --- | --- |
| [ADR-019](ADR-019-structured-key-mapping.md) | 把「形状未知」当成「形状不同」 |
| [ADR-020](ADR-020-identity-link-confirmation-eligibility.md) | 一个 flag 承载两个问题，必然在其中一个上说谎 |
| [ADR-021](ADR-021-candidate-provenance-disclosure.md) | 把不同情形（没接模型 / 材料不似字典）合并成不可区分的表现 |
| **本 ADR** | **披露了事实，但没有给出可执行的对象**——「请核对」核对不了 |

前三次的修法是「让它们可区分」，第四次是「让缺失本身可见」，本次是**让缺失可以点名**。

## Decision

### 1. 受控目录连它的覆盖披露一起搬出提案组装文件

`CANDIDATE_CATALOG`（12 类）、`matchCandidateCatalog`、`listCatalogGaps`、`listUncoveredMentions`
落到 `backend/src/services/semantic-candidate-catalog-service.js`。

搬出去的理由**不是分文件**：此前它与提案组装、标识推导、审阅说明生成混在同一个近千行文件里，
**「兜底路径能命中什么、命中不到什么」没有任何独立的取证入口**。搬出后它有了纯函数面，
可以脱离提案逐条取证（与 [ADR-021](ADR-021-candidate-provenance-disclosure.md) 决策 4「判定抽成纯函数」同一条理由）。

### 2. 目录空白必须**可点名**（确定性，零启发式）

`listCatalogGaps()` ＝ 受控目录 id 集合 与 `systemDefinitions[].worldObjectTypes` 的差集，
逐条给出 `objectType` + `system`。两边都是库里的既有事实，**不需要任何判定**。

之所以披露而不**补齐**（不把 14 类写进词表）：候选词表是受控词汇表，
补词条属于词表治理决策（谁负责、依据什么、如何失效），本阶段不擅自做（见决策 6）。

### 3. 材料里**未被覆盖的列举项**必须可点名（启发式）

`listUncoveredMentions({ sourceText, matchedTerms })`：

| 环节 | 规则 | 为什么 |
| --- | --- | --- |
| 取词范围 | 只有出现列举分隔符（`、，,；;｜\|/\`换行）**且切成 ≥2 段**才取词 | 单段散文不产生任何提及，否则「我们要根据这些资料建立模型」会被当成对象名 |
| 形态 | 削掉两端非汉字后仍为**纯中文**、长度 2~8 | 英文标识符、数字、整句自动出局 |
| 噪声门 | 出现非名词性线索字（的/了/是/有/和/在/要/请/…）即排除 | 让「请核对是否遗漏」「订单有单号和客户」这类从句出局，否则清单会被淹掉 |
| 覆盖判定 | 提及与词条**双向包含**即算已覆盖 | 只判一向会让「物料」在命中「物料主数据」之后又被列进未覆盖清单 |
| 上限 | 最多 12 条，超出只报总数 | 整段材料切出几十个短语时，全列出来只会把审阅说明淹掉；但**必须说明被截断**（同 ADR-020 决策 2） |

返回 `{ mentions, total, truncated, basis }`——`basis` 恒为 `'enumeration_heuristic'`。

### 4. 启发式必须**自我标注**，且不得被读成抽取结果

`basis` 作为**字段**随清单走（不是一句注释），审阅说明与界面都写明
「**不是对象抽取结果**：可能混入非对象词，也可能漏掉没有用分隔符列出的对象名」。
下游（界面 / 报告 / 复算）要能按字段判断「这份清单该不该被当真」。

### 5. 覆盖面落**结构化字段**，不只写进中文

提案新增 `candidateCoverage`：

```js
{ catalogSize, fallbackApplied, matched: [{ id, matchedTerms }], gaps: [{ objectType, system, systemName }],
  uncoveredMentions, uncoveredTotal, uncoveredTruncated, uncoveredBasis }
```

- 进 `publicProposal` **白名单**——这个白名单此前已三次漏登记字段（`systemScope` / `derivedFrom` / `publicTask`），
  漏登记的后果不是报错而是**静默丢失**，因此新字段一律显式登记；
- `fallbackApplied` 是解读整份披露的**前提**：结构化材料或自然语言抽取产出了对象时，目录根本没被用到，
  此时报「命中 0 类」会被读成「目录能力不行」。实测：`fallbackApplied = false` 时 `gaps` 与
  `uncoveredMentions` 均为空数组。

### 6. **披露不等于补齐**：点名的对象一个都不进候选

不放宽任何门槛、不改候选集合、不补词条、不自动扩展范围。
把点名的对象补进候选涉及对象来源与范围的既有决策（[ADR-012](ADR-012-explicit-modeling-scope.md) /
[ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md) / [ADR-017](ADR-017-model-extraction-attribution.md)），
与本 ADR 是两件事。

### 7. 披露必须**到达界面**，否则等于没披露

运营控制台（`SemanticAgentWorkspace.vue`）**不渲染 `reviewNotes`**——
ADR-021 的披露只落在服务端字符串与智脑工作台一侧，运营这一侧看不到。
因此本 ADR 要求新增界面区块，把命中词、目录空白、未覆盖提及三块**直接渲染**。

#### 7.1 附带修正的一处死界面（如实记录）

新增界面区块时发现三处同类写法中的两处：

```html
<!-- 错的：selected 是 ref，模板中已解包，selected.value 恒为 undefined -->
<small v-if="selected.value?.proposal?.identityLinking?.declarationReport?.droppedLinks?.length" …>
```

`selected.value?.proposal?...` 在模板里恒为 `undefined`，因此
**「因对象改名或字段集改变，N 条标识对应已不再存在」与「因裁定区分粒度，N 条声明被显式排除」这两段失效披露
永远不会显示**。实测确认：模板内其余 100+ 处均写作 `selected.proposal?...`，只有这两处写错。

更值得注意的是**它为什么没被测出来**：既有断言 `assert.match(workspaceSource, /declarationReport\?\.droppedLinks/)`
用的是宽松的可选链匹配，组件里前一级写成 `selected.value` 也照样通过——
**断言盖住了「字段名存在」，却没有盖住「这块界面会不会渲染」**。
本次一并修正写法，并新增一条**反向锁死**断言：模板区块内不得出现 `selected.value`。

## Consequences

### 口径变化（实测）

| 口径 | 4f 末 | 4g 后 |
| --- | --- | --- |
| 受控目录实体 | 硬编码在 `semantic-operations-agent-service.js` 内 | 独立服务 `semantic-candidate-catalog-service.js`，有纯函数取证面 |
| 「目录未覆盖的对象不会出现在候选里，请核对是否遗漏」 | 有，但**不可执行** | 同句保留，并补上两侧清单 |
| 目录空白（平台已治理但目录无词条的类） | **不存在此口径** | **14 类**，逐条点名（对象 + 系统） |
| 材料里未被覆盖的列举项 | **不存在此口径** | 可点名（启发式，≤12 条，超限报总数） |
| `candidateCoverage` | 不存在 | 结构化字段，进 `publicProposal` 白名单 |
| 候选对象集合 | — | **不变**（披露不等于补齐） |
| 运营控制台 | 看不到任何覆盖披露 | 命中词 / 目录空白 / 未覆盖提及三块可见 |

### 验收（本机实测，确定性用例，未调模型）

- `test:semantic` **6/6 + 60/60 + 96/96**（第三组 94 → 96，`semantic-operations-agent.test.js` 31 → **33**）；
- 控制台 `workspace-layout` **7/7 → 8/8**（新增「覆盖面必须可见」组，含 `selected.value` 反向锁死）；
- `test:architecture` **10/10**（新增一次 `services → data` 导入，未增跨域边）；
- `test:events` **17/17**（模块化审计第 3 项迁移后的回归，见下）；
- `npm run lint` / `npm run typecheck` 干净；
- `docs:check` **184 份 Markdown / 1169 个本地链接**；
- `npm run quality` 端到端 **EXIT=0**（1m38s，全量 35 个 Node 测试块 **969 / 969 通过**、0 处 `not ok`）；
- **5 端构建通过**（web 2.04s + 元域智语 2.83s、desktop 2.22s、mobile 2.19s、dingtalk 3.47s，分端调用避开沙箱 `safe-delete` 单次阈值）。

### 顺带完成：模块化审计第 3 项

本轮的时机合适，一并做掉了 [MODULARIZATION_AUDIT](../MODULARIZATION_AUDIT.md) 第 9 节执行顺序里的第 3 项：
`backend/src/domains/events/` → `backend/src/infrastructure/domain-events/`。
`domains/events` 是事件出箱 / 存储这类**基础设施**，被 `services/` 与 `domains/platform` 反向依赖，
放在 `domains/` 下会让「领域层依赖基础设施」看起来像分层反转，实际只是它站错了目录。
迁移影响 **22 个文件**（19 处路径含 `domains/events` 字面量 + 3 处 `../events/` 相对引用），
相对深度不变（`domains/x` 与 `infrastructure/x` 距 `src/` 同为两层），因此域内相对导入无需改动。
`architecture-baseline.js` 的 `INFRASTRUCTURE_DOMAINS` 随之从 `new Set(['events'])` 收敛为**空集**——
即 `domains/` 下**每一个**目录都必须是带 public-api 的业务边界，不再有例外。

### 边界（如实）

1. **未覆盖提及是启发式，会误报也会漏报**。误报：噪声门是黑名单式的，「相关数据」这类词不在其中，会被列出。
   漏报：**没有被列举分隔符分开的对象名不会被点名**——「我们要建一个发运单模型」这种写法一个词都取不到。
   因此本 ADR 把「无人能解释」降为「知道大概漏了哪些词」，**没有消除漏报**。
   真正的消除要靠对象抽取（[ADR-021](ADR-021-candidate-provenance-disclosure.md) 边界二）。
2. **目录空白只回答「目录缺哪些类」，不回答「材料里的某个中文词对应哪一类」**。
   后者的映射需要中文词条，属词表治理（决策 2 已说明为何不在本阶段补）。
3. **截断阈值 12 是取舍**：超过就只报总数。代价是「第 13 个之后没看到」；收益是审阅说明不至于被淹没。
4. **`fallbackApplied = false` 时整块披露为空**——这是刻意的（避免误导），但也意味着
   结构化材料路径下「候选从哪来」仍只有 `schemaDiscovery` 一侧的信息，本 ADR 不覆盖。
5. **审阅说明变长**：兜底路径下一次响应会多出三条 note（命中依据 / 目录空白 / 未覆盖提及），
   其中目录空白那条在实测里单条约 300 字。这是披露的代价，不是缺陷。
6. 全部为**内置合成数据**验收，不代表真实企业系统验收。

### 复审条件（触发式，未触发不动）

1. 出现「未覆盖提及误报率高到运营整体忽略这条提示」的反馈 → 重新评估噪声门或改为选择性展示；
2. 对象抽取落地（[ADR-021](ADR-021-candidate-provenance-disclosure.md) 边界二）→ 本启发式应由抽取结果取代；—— **部分触发并关闭（2026-09-28，[ADR-025](ADR-025-object-mention-linking.md)）**：已登记类型的点名改由受控对象链接承担（进候选），启发式清单收窄为「未登记提及」的披露；同时本 ADR 决策 6「点名不进候选」被 ADR-025 收窄推翻（仅已登记类型、双侧逐字校验、人工审阅）。
3. `gaps` 长期非 0 却被反复忽略 → 说明披露位置不对，或该走词表治理而不是持续提示；
4. `CANDIDATE_CATALOG` 条目数变化（`CANDIDATE_CATALOG_SIZE ≠ 12`）→ 必须同步更新用例与文档中的实测数字。

## References

- [ADR-012](ADR-012-explicit-modeling-scope.md)（显式建模范围）、[ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md)（范围即过滤 + 显式排除）
- [ADR-017](ADR-017-model-extraction-attribution.md)（对象抽取的归属关口）
- [ADR-018](ADR-018-declaration-divergence-merging.md)（审议式披露不等于合并）
- [ADR-020](ADR-020-identity-link-confirmation-eligibility.md)（披露而非隐藏、截断必须说明）
- [ADR-021](ADR-021-candidate-provenance-disclosure.md)（候选来源与跳过原因披露；本 ADR 关闭其边界二的一半）
- [MODULARIZATION_AUDIT](../MODULARIZATION_AUDIT.md)（第 3 项：`domains/events` 概念错位）
- `backend/src/services/semantic-candidate-catalog-service.js`、`backend/src/data/system-catalog.js`

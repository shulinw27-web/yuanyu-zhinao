# ADR-021: 候选对象的来源与「没被生成」的原因必须可读

## Status

Accepted（2026-09-26）

## Context

系统接入重构的目标是把「硬编码对象目录 + 关键词命中」升级为「按选中系统的字段目录抽取对象与标识」（见 `semantic-identity-link-service.js` 模块头）。前四个增量（阶段 4a ~ 4e）把**确定性的一半**做完了：字段目录、标识识别、跨系统对应推导、人工确认并入、冲突与歧义的处置入口、以及「哪些对应有资格被确认」。

剩下的是**另一半**：从非结构化材料抽取对象。但在动它之前有一个更前置的问题——**今天的候选对象从哪来、为什么没有生成，这件事本身不可读**。审阅人拿到的只有一份对象清单，清单之外的一切都是沉默的。

### 触发点（本机实测，探针 `candidate-basis-probe.mjs`，内置合成数据，确定性）

用同一份实现分别喂三组诉求，观察候选对象与审阅说明：

| 材料诉求 | 候选对象 | 说明 |
| --- | --- | --- |
| 「采购订单、供应商」 | **2 类**：`PurchaseOrder`、`Supplier` | 两个词都在受控目录里 |
| 「采购订单、**发运单、出库单、客户投诉**」 | **1 类**：`PurchaseOrder` | 三个对象**静默消失** |
| 「发运单、出库单」 | 硬错误 `SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS` | 一个都没命中 |

第二行是问题所在：运营写清了四个业务对象，候选里只有一个。而**在此之前，界面上没有任何一句话解释另外三个去哪了**——分不清是「自己没说清」「目录没有这个词」还是「模型没接上」。

### 两条静默路径（代码证据）

`semantic-natural-schema-service.js` 的 `discoverNaturalSchema` 有两处 `return null`，调用方只拿到 `null`：

```js
if (getLocalModelRuntime().mode === 'mock' || !/主键|primary.?key|字段|\bfields\b|\bPK\b/i.test(material)) return null;
```

- **模拟运行时**：本轮不调模型（这是刻意的，测试要确定性）；
- **材料没有字典线索**：粗筛判定「不值得尝试一次模型」。

两者**要做的事完全不同**（前者要换 provider 或接受目录兜底，后者要补主键 / 字段名），却被合并成同一个不可区分的表现。

### 目录兜底不披露依据

`semantic-operations-agent-service.js` 的 `catalog.filter(item => includesAny(sourceText, item.terms))` 是「硬编码目录 + 关键词命中」的实体。它：
- 不记录**命中在哪个词上**（`'订单'` 命中 `PurchaseOrder` 这件事看不见）；
- 不说明自己是**兜底**而非抽取结果；
- 不说明**覆盖率**（受控目录共 12 类，命中 2 类意味着其余 10 类都没出现）。

### 与本次重构一路的同型问题

这与 [ADR-019](ADR-019-structured-key-mapping.md)「把『形状未知』当成『形状不同』」、[ADR-020](ADR-020-identity-link-confirmation-eligibility.md)「一个 flag 承载两个问题」**同型**：都是把**不同的情形**合并成一个**不可区分的表现**。前两次的教训是「先让它们可区分」，这次的前置问题更早一步——**先让缺失这件事可见**。

## Decision

### 1. 受控目录命中必须披露**命中词**与**覆盖率**

`catalogHits` 记录每条目录条目被哪几个词命中（`matchedTerms`），并在审阅说明里写出「命中 M / 共 N 类」与**每条的命中词**。

只说「命中 2 类」不足以回答「为什么没有发运单」——要看的是**没命中**的那些。因此覆盖率必须与命中词一起说。

### 2. 必须说明这条路是**兜底**，不是抽取结果

审阅说明写明：候选来自**受控目录关键词命中**，它只按**词面匹配**，「材料里写到、但目录未覆盖的业务对象**不会**出现在候选里，请核对是否遗漏」。

[ADR-018](ADR-018-declaration-divergence-merging.md) 的立场是「披露不等于修正」，这里同理：**披露不等于补齐**。本 ADR 不试图把漏掉的对象补出来（那需要对象抽取能力），只把「可能漏了」这件事说出来。

### 3. 自然语言抽取的跳过必须给出**可区分的原因**

`discoverNaturalSchema` 不再 `return null`，而是返回 `{ skipped, reason }`，原因码两种、各自一句中文说明：

| 原因码 | 说明（原文） |
| --- | --- |
| `mock_runtime` | 当前模型运行时为模拟模式（未调用任何模型），候选对象只可能来自受控目录与结构化材料。 |
| `not_dictionary_like` | 材料里没有出现「主键 / 字段」这类字典线索，未尝试自然语言抽取；若材料其实描述了对象与字段，请显式写出主键与字段名后重试。 |

原因码由调用方带进审阅说明（`reviewNotes`），而不是留在服务内部。

### 4. 跳过判定抽成**纯函数**（否则一半分支永远测不到）

`naturalSchemaSkipReason({ mode, material })` 独立于 `discoverNaturalSchema` 导出。

理由是可测性，而且是**实测出来的必要性**：测试环境恒为 `mock`（`process.env.AGENT_RUNTIME_MODE || 'mock'`），若判定内联在 `discoverNaturalSchema` 里，`not_dictionary_like` 这条分支会被 mock 分支**永久遮住**——用例看着覆盖了两条路径，实际只跑了一条。这与 [ADR-019](ADR-019-structured-key-mapping.md)「形状判定不写回声明，代价是重复判定」是同一类权衡：**为了让结论可被单独验证，把它从「顺带算出来的」变成「显式算出来的」**。

### 5. 披露落在既有的 `reviewNotes`，不新增实体、不改 schema

`reviewNotes` 已经是公开的审阅面（`publicProposal` 白名单内），也是这一路以来所有「人工结论 / 未决状态」的披露位置。本 ADR 不动它、不加新字段、不把命中信息塞进 `objectTypes`（那会进入草稿并触发下游校验）。

### 6. **不放宽任何门槛**

- 候选对象为空时仍是硬错误 `SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS`（不生成空候选、不用默认模板顶替）；
- 「材料没有字典线索」仍**不**触发抽取尝试（粗筛保留），只是把这件事说出来。

预筛本身是启发式，本 ADR **不声称它正确**，只声称它**不再是静默的**。

## Consequences

### 变简单的地方

- 审阅人能回答「为什么候选里没有 X」的**一部分**：至少知道这条路只是词面命中，以及本轮有没有尝试过模型抽取；
- `test:semantic` 的第三组从 **92 → 94**，两条新用例分别锁定「披露存在」与「两条跳过原因可区分」；
- `discoverNaturalSchema` 的返回值从 `null`（无信息）变为结构化原因，调用方不再需要靠猜。

### 变复杂的地方（如实）

- `reviewNotes` 在有目录兜底时多一句（含命中词清单），在跳过抽取时多一句；
- `catalogHits` 每次创建提案时多算一遍词面匹配——开销可忽略（12 条 × 若干词），换来的是可解释；
- `includesAny` 工具函数因此闲置并被删除（原来只服务这一处）。

### 明确不在本 ADR 范围内

- ~~**点名「漏了哪个对象」**：服务端不知道材料里哪些词是对象名——这正是「对象抽取」本身。本 ADR 只能说「可能漏」，**不能**说「漏了发运单」；~~ —— **已部分关闭（2026-09-26，阶段 4g / [ADR-022](ADR-022-candidate-coverage-disclosure.md)）**：现在能点名**两侧**——① 目录空白（确定性：受控目录 12 类 vs 系统目录 `worldObjectTypes` 21 类，实测差 **14 类**，逐条给对象名 + 系统）；② 材料里未被任何词条覆盖的**列举项**（启发式，实测能点名「发运单 / 出库单 / 客户投诉」）。**仍未关闭的一半**：启发式依赖列举分隔符，「我们要建一个发运单模型」这种写法一个词都取不到——真正的消除仍要靠对象抽取。
- **`not_dictionary_like` 粗筛的阈值是否合理**：它仍是启发式，**未测量**漏判率；
- **真实 provider 下自然语言抽取的质量**：需要模型轮次评测，属下一步；
- **`catalog` 本身是否该存在**：按系统字段目录生成对象是阶段 4 的目标形态，但那需要先有对象抽取能力。

### 实测边界（如实）

**一、`not_dictionary_like` 在测试环境下不可达。** 测试恒为 mock，该分支只能靠纯函数层的用例覆盖——这不是测试技巧，而是**如实反映**「这条路径在模拟环境里根本走不到」。真要去端到端验证它，必须接一个真实 provider。

**二、披露是「覆盖率」级别的，不是「清单」级别的。** 实测第二行（材料写四个对象、候选只有一个）在改动后仍然是「候选只有一个」，只是多了一句「目录未覆盖的业务对象不会出现在候选里，请核对是否遗漏」。**一个诚实的边界换一个诚实的问题**：从「无人能解释」变成「知道可能漏、但不知道漏了哪个」。—— **本条已被 [ADR-022](ADR-022-candidate-coverage-disclosure.md)（阶段 4g）部分关闭**：披露从「覆盖率级」提升到「清单级」，但清单**只覆盖列举式写法**且是启发式（会误报、也会漏报），因此「不知道漏了哪个」降低了面，没有消除。

**三、`'订单'` 命中 `PurchaseOrder` 是已知的过泛词，本 ADR 不处理。** 实测 `PurchaseOrder.terms` 含 `'订单'`，任何含「订单」的材料都会命中「采购订单」——而在 OMS 语境里「订单」通常是**销售订单**。这是受控目录的**词表质量**问题，与披露无关；已记在此，避免下次被当成新发现。

**四、本增量的验收规模**：`test:semantic` **6/6 + 60/60 + 94/94**（第三组 92 → 94，`semantic-operations-agent.test.js` 29 → **31**）；`npm run lint` 干净；`docs:check` **183 份 Markdown / 1125 个本地链接**；`npm run quality` 端到端 **EXIT=0**（1m39s，全量 35 个 Node 测试块 `fail=0`、0 处 `not ok`）；**5 端构建通过**（web 2.90s + 元域智营 2.62s、desktop 3.33s、mobile 3.10s、dingtalk 5.01s，分端调用避开沙箱 `safe-delete` 单次阈值）；全部为**内置合成数据**验收，**不代表真实企业系统验收**。

## 退出/复审条件

1. **若对象抽取能力落地并能在材料里点名「提到但未匹配的对象」** → 第 1 / 2 条决策的「可能遗漏，请核对」应升级为**具体清单**（「材料里出现 `发运单`，目录中无对应条目」）。—— **部分已提前实现（2026-09-26，阶段 4g / [ADR-022](ADR-022-candidate-coverage-disclosure.md)）**：清单已给出，但由**启发式**（列举切分）而非对象抽取取得。该条件仍**未完全满足**：依赖列举分隔符的写法取不到词，应在真正的抽取能力落地后由抽取结果取代启发式。
2. **若 `catalog` 被替换为「按选中系统的字段目录」**（阶段 4 的目标形态）→ 第 1 / 2 条决策中「受控目录」这个措辞需重写，且「兜底」性质描述随之改变。
3. **若 `reviewNotes` 被结构化字段取代** → 披露位置需迁移，且必须保持「公开可见」这一性质（参照 [ADR-019](ADR-019-structured-key-mapping.md) 的 `keyMapping` 必须进草稿）。
4. **若 `not_dictionary_like` 被实测出漏判率高**（真实 provider 下大量含对象描述的纯业务材料被判为「无字典线索」）→ 需重测粗筛阈值并修订第 6 条决策。

## 关联

- [ADR-012](ADR-012-explicit-modeling-scope.md) / [ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md)：范围与「被排除清单」——披露不等于修正的源头立场；
- [ADR-017](ADR-017-model-extraction-attribution.md)：模型只给逐字原文、判定在服务端——本 ADR 的「跳过原因」是同一路「模型能力边界必须显式」的延续；
- [ADR-018](ADR-018-declaration-divergence-merging.md)：披露不等于修正；
- [ADR-019](ADR-019-structured-key-mapping.md)：把不同的情形拆成不同状态（同型问题的上一次）；
- [ADR-020](ADR-020-identity-link-confirmation-eligibility.md)：一个判据只回答一个问题（同型问题的上一次）；
- [ADR-022](ADR-022-candidate-coverage-disclosure.md)：把本 ADR 的「覆盖率级披露」升级为「清单级点名」（同型问题的下一次：披露了事实，但没给出可执行的对象）；
- 代码：`backend/src/services/semantic-natural-schema-service.js`（`NATURAL_SCHEMA_SKIP_REASONS` / `naturalSchemaSkipReason`）、`backend/src/services/semantic-candidate-catalog-service.js`（受控目录与覆盖披露，阶段 4g 起从下方文件迁出）、`backend/src/services/semantic-operations-agent-service.js`（`catalogHits` / `naturalSchemaSkip` / `candidateCoverage` / `reviewNotes`）。

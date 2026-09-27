# ADR-025: 受控对象链接——材料逐字提及进入候选的受控通道

日期：2026-09-28　|　状态：已接受　|　关联阶段：系统接入重构阶段 4h

## 背景

阶段 4f/4g（[ADR-021](ADR-021-candidate-provenance-disclosure.md) / [ADR-022](ADR-022-candidate-coverage-disclosure.md)）把「候选对象从哪来、缺了什么」变成了可读、可点名，但留下一个共同根因原封不动：**材料里写到、但受控目录未覆盖的对象，一个都进不了候选**。

实测触发点（本机、内置合成数据、确定性）：材料写「采购订单、发运单、出库单、客户投诉」，候选只得 `PurchaseOrder` 1 类；「我们要建一个发运单模型」这类**非列举**写法连 4g 的启发式切词都取不到。4e 的「4/11 不可确认」与 4f 的「写四个对象只得 1 类」在此汇合：**候选对象仍来自硬编码 12 类目录 + 关键词命中**。

同时，平台两侧的既有事实从未被对起来用过：

- 系统目录（`data/system-catalog.js`，ADR-009 单一事实源）登记了 **20 类**世界模型对象（`worldObjectTypes`），其中 **14 类**在受控目录没有任何词条；
- 这 14 类中 8 类在系统声明（`data/seed.js` 的 `systemConfigurations`）里有**现成字段映射**（如 `wms.inbound_receipt` 6 字段），且主键可由 4a 的标识判据（`inferIdentifier`：登记主键 → `<对象>_id` → 自身概念）确定性识别——`InboundReceipt.receipt_id`、`InventoryLot.inventory_lot_id`、`Order.order_id` 等。

缺的只是一步：**把材料里的中文称呼链接到已登记类型**。这一步此前既不能确定性地做（中文词条属词表治理，ADR-022 明确留给用户决策），也不敢让模型自由地做（那是无法复核的断言入口）。

## 决策

用户于 2026-09-28 在三条路径（受控链接 / 词表治理补词条 / 阶段 6 权限收敛）中选定**受控对象链接**。核心契约与 [ADR-017](ADR-017-model-extraction-attribution.md) 同构：**模型只提供可核对的原文链接，事实与结构全部来自服务端既有登记。**

### 1. 模型只做「材料逐字提及 ↔ 已登记对象类型」的受控链接

模型输出 `{ mentions: [{ mention, evidence, objectType }] }`，三条硬校验（`validateMentionLinks`，纯函数）：

- `evidence` 必须逐字来自材料（`normalizeUntrustedText` 口径，与 `validateNaturalSchema` 同严格度）；
- `evidence` 必须包含 `mention`；
- `objectType` 必须在已登记索引（`registeredWorldObjectIndex`，来自系统目录 `worldObjectTypes`，按范围过滤）内。

任何一条不满足 → **整份拒绝**，不做「删坏行留好行」的局部挽救——否则模型会通过重试学会「丢掉证据不足的行就够了」。

**模型不能**：发明对象类型（名单外一律拒绝）、发明字段与主键（结构只来自声明，见决策 3）、断言归属系统（系统由类型登记关系决定，是平台事实，不给模型断言入口）。

### 2. 链接只在「抽取不可用或无产出」时运行，与既有路径不叠加

- 结构化材料与自然语言抽取（`discoverNaturalSchema`）已产出对象时，链接不运行——字典抽取的信息量严格大于链接；
- ADR-021 决策 6「材料没有字典线索不触发抽取尝试」**不推翻**：字典线索材料仍走完整抽取，本服务只接管**散文式材料**（`not_dictionary_like`）与模拟运行时之外的跳过场景；
- mock 运行时与显式空范围跳过并带原因（`mentionLinkSkipReason` 纯函数，理由与 ADR-021 决策 4 相同：否则分支被 mock 永久遮住）。

### 3. 候选结构只来自系统声明，主键用 4a 同一套判据

链接成立 ≠ 候选成立。`buildMentionLinkCandidates` 从声明侧字段目录（`buildSystemFieldCatalog({ objects: [] })`）取结构，`inferIdentifier` 定主键；两类「链接了但给不出结构」的情形**分开点名、不静默**：

- `no_declaration`：类型已登记但系统无字段声明（如 `OutboundShipment`）——建议补声明或上传字典；
- `no_identifier`：有声明但识别不出主键——建议补主键声明。

这两类**不进候选**（无主键对象过不了草案校验与 Critic），只进披露。候选对象一律 `mappingStatus: 'pending'`——声明结构 ≠ 映射已确认，Critic 的「字段来源映射」检查会拦住未映射就采纳的尝试（与自然语言抽取路径行为一致）。

### 4. 对 ADR-022 决策 6 的收窄推翻（记录在案）

ADR-022 决策 6 说「点名的对象一个都不进候选」。本 ADR 将其**收窄**为：只有「已登记类型 + 双侧校验 + 人工审阅」的链接才进候选。理由：4g 的披露是终点，运营拿到的是一份「请人工核对」的清单而没有下一步；本 ADR 给了下一步，同时**未放宽任何关口**（范围过滤照常、Critic 照常、字段映射必须人工补齐）。ADR-022 复审条件 2「对象抽取落地后启发式应由抽取结果取代」部分触发：已登记类型的点名由链接取代，未登记提及仍由启发式披露。

### 5. 披露结构化：`candidateCoverage.mentionLinking`

`{ skipped, skipReason, basis, linked[]（每条带 structured 标记）, total, truncated, mergedDuplicates, structureGaps[] }` 随 `candidateCoverage` 进 `publicProposal` 白名单（该字段整体已在白名单）。`skipped` 是解读前提（同 `fallbackApplied` 的理由）：模拟运行时下链接没跑，「linked 为空」不说明材料里没有已登记对象。审阅说明仅在**有行动项**时追加（链接候选的来源说明、结构缺口的可行动建议）；mock 跳过只在结构化字段披露，避免给每份提案无差别加注。

### 6. 真实模型评测属验收的一部分（不进 quality）

`npm run evaluate:mention-linking`：散文材料变体 × 3 轮 + 1 次端到端提案（provider `workbuddy`/`deepseek-v4-pro`，可用环境变量覆盖）。判定：期望链接逐条命中、名单外概念不被链接（「客户投诉」在 WMS 池内无对应类型）、无对象材料弃权、端到端候选产出与结构缺口点名。与 `evaluate:source-attribution` 同一边界：合成材料 + 真实模型，不进 `test:all`。

## 实测（本机）

**确定性（未调模型）**：`test:mention` **6/6**（跳过原因、登记索引与范围纪律、逐字三校验 + 编造整拒 + 合并披露、声明结构合成与两类缺口点名、注入式端到端候选合并 + 兜底抑制 + 披露、mock 行为不变）；`test:semantic` **6/6 + 61/61 + 98/98**（既有断言零改动全过——mock 下候选集合与 4g 完全一致）；`test:architecture` **10/10**（登记 2 条与 `semantic-natural-schema-service` 同性质的网关/提示安全边）；lint 干净。

**真实模型（`evaluate:mention-linking`，workbuddy/deepseek-v4-pro）**：见 [PROJECT_STATUS](../../overview/PROJECT_STATUS.md) 对应日期条目与 `workbuddy_work.md`；EXIT 码与逐轮结果以脚本输出为准。

## 后果与边界（如实）

**同日后续增量（2026-09-28 第二段，均不改变本 ADR 的核心契约）**：

- **词表治理第一轮已执行**（用户当日指示补齐）：8 类**有系统字段声明**的缺口对象补入受控目录词条（`fields`/`key` 逐类取自声明侧目录，与链接同源）；**无声明的 6 类不补**——词条带来词面命中带不来结构，空壳候选过不了审阅。目录 12→20 类，目录缺口 14→6。复审条件 2 据此**部分触发**：词表已是资产，但「词表优先、模型兜底」的链接降级未做（当前词表兜底与链接是两条独立通道，只在「都无产出」时互不叠加）；
- `no_identifier` 分支已补数据驱动用例：`buildMentionLinkCandidates` 增加声明透传缝（`objects` 参数，默认空＝行为不变），测试注入「有字段、无主键」声明直达该分支；
- 前端「受控对象链接」披露面板已加（元域智语 `SemanticAgentWorkspace.vue`）：与 4g 覆盖面并列展示，`skipped` 前提、逐条 structured 标记、结构缺口三类信息全部上界面。

仍然成立：

- 评测与 mock 之间隔着真实 provider：`discoverObjectMentionLinks` 的编排路径（模型调用 → 校验失败 → 整份拒绝）只有评测脚本覆盖，`test:all` 全绿**不含**这一层；
- 未登记提及（如「客户投诉」→ QMS `QualityEvent` 的语义合理性）仍只披露、不进候选，判定权在人；
- 词表治理第一轮只覆盖**有声明**的 8 类，且只解决「词面兜底命中不到」；「词表优先、模型兜底」的链接降级与 6 类无声明对象仍待后续。

## 退出/复审条件

1. 若真实评测显示链接误报率高（材料随口一提的对象被频繁链到已登记类型）→ 评估在契约中增加「该称呼是否为正式对象名」的自证字段，或改为仅在列举式写法上启用；
2. 若词表治理落地（14 类补齐中文词条与治理主体）→ 本服务的链接应优先匹配词表、模型只兜底非词条写法，且 `registeredWorldObjectIndex` 需与词表共用事实源；
3. 若系统目录 `worldObjectTypes` 出现跨系统重复登记 → `registeredWorldObjectIndex` 的「保留首个」策略必须升级为显式歧义上报（当前以注释声明该前提）；
4. 若链接候选的字段映射长期停留 pending → 说明「声明结构进候选」没有降低运营负担，需评估映射自动预填（以声明 `source` 为依据）。

## References

- [ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md)（范围即过滤——链接候选带登记来源，照常参与裁剪）
- [ADR-017](ADR-017-model-extraction-attribution.md)（模型只给逐字原文、判定在服务端——本 ADR 的同构前身）
- [ADR-021](ADR-021-candidate-provenance-disclosure.md)（候选来源披露；决策 6 的「不触发抽取尝试」不推翻）
- [ADR-022](ADR-022-candidate-coverage-disclosure.md)（覆盖点名；决策 6 由本 ADR 收窄推翻）
- 代码：`backend/src/services/semantic-object-mention-service.js`（新）、`backend/src/services/semantic-operations-agent-service.js`（接线）、`backend/test/semantic-object-mention.test.js`（新）、`scripts/evaluate-object-mention-linking.mjs`（新）、`backend/test/architecture-baseline.js`（2 条同性质边）

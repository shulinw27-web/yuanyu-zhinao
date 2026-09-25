# ADR-017: 材料归属由模型取证、服务端判定；候选不参与裁剪，确认后才成事实

## Status

Accepted

## Context

### 当时的约束

[ADR-014](ADR-014-identity-linking-as-assumption.md) 的**复审条件 3**：

> 若标识对应的依据改为模型判断（例如用它消解 `key_shape_incompatible`）：须重新评估可复现性验收，并说明模型结论以什么等级的「证据」进入草稿。

[系统接入重构方案](../SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md) 阶段 4c 第二段第 1 条：模型驱动的对象与标识抽取，**沿用 `validateNaturalSchema` 的逐字证据要求**。

### 触发点（本机实测，注入符合契约的模型输出，未调真实模型）

材料里逐字写着「ERP 采购订单表 purchase_order」「WMS 收货表 inbound_receipt」，且写明「外键：po_id 引用 purchase_order」——正是方案原文阶段 4 举的那个例子（ERP `PurchaseOrder` ↔ WMS `InboundReceipt.purchase_order_id`）。模型输出的表、字段、主键、外键证据全部通过逐字校验（`validateNaturalSchema` 返回 OK）。

实测结果：

| 观测项 | 实测值 |
| --- | --- |
| 抽取对象的 `sourceSystems` | `['UNASSIGNED']`（两张表都是） |
| 范围过滤归类 | `unassignedObjects: ['purchase_order', 'inbound_receipt']`，不排除 |
| 4a 字段目录 | 只有 6 个已登记系统的对象，**`purchase_order` / `inbound_receipt` 不在其中** |
| 跨系统标识对应 | **0 条** |
| Critic | `failed` —— 「受控来源系统：存在未登记来源系统：purchase_order:UNASSIGNED、inbound_receipt:UNASSIGNED」 |
| 采纳 | **被拒**（`SEMANTIC_PROPOSAL_CRITIC_FAILED`） |

即：**自然语言材料建模链路走不到终点，而卡住它的信息就在材料里。** 模型被要求逐字给出表名、字段名、主键与外键的证据，唯独没有被要求给出「这张表属于哪一处」的证据——于是 `validateNaturalSchema` 一律产出 `sourceSystems: ['UNASSIGNED']`。

两条抽取路径的策略不一致，是缺口的准确形状：

| 路径 | 归属来源 | 能进 4a 字段目录 |
| --- | --- | --- |
| 结构化字典（`discoverSchemasFromAttachments`） | 字典声明的 `system` → 文件名的系统码 → 输入文本的系统码 → 否则 `UNASSIGNED` | 能（若在范围内） |
| 自然语言材料（`discoverNaturalSchema`） | **无**（恒 `UNASSIGNED`） | **不能** |

而 `collectDeclarations` 里 `item !== 'UNASSIGNED'` 是显式跳过——这不是疏漏，是刻意的：`UNASSIGNED` 的含义是「来源未知」，让未知来源参与「范围内的系统声明了什么」会把两个不同的问题混成一个。

### 需要回答的具体问题

1. 归属由谁给——模型直接报系统码，还是模型只给证据、服务端判定？
2. 判定出的归属以什么等级进入草稿？会不会让模型的一句话决定对象的去留（范围裁剪）？
3. 归属未确认时，这个对象能不能参与跨系统标识对应？（不参与则阶段 4 第 2 条永远落空）
4. 归属从候选变成事实，走哪个动作？

## Decision

### 1. 模型只提供**归属原文**，系统码由服务端**确定性**判定

模型输出的每张表可选地给出 `systemEvidence`——材料中说明该表归属哪一处的**逐字原文**（与 `evidence` / `keyEvidence` 同一严格度：必须在材料里逐字出现，否则整表拒绝 `OWNER_EVIDENCE_INVALID`）。**契约里没有「系统码」字段**：模型不能直接写 `ERP`。

服务端用 `detectSystemCodesInText`（系统注册表的唯一事实源派生，带别名）从这段原文里判定系统码。

理由有两层。第一层是安全：让模型直接输出系统码，就是给它一个无法复核的断言入口；「哪段原文说明这张表属于哪个系统」才是可逐字核对的。第二层是事实源：系统码与别名的定义已经在系统注册表里（[ADR-009](ADR-009-system-registry-single-source.md)），把归属判定委托给它，就不必在抽取层再维护一份别名表。

粒度也是这个设计带来的：`detectSystemCodesInText` 若作用在**整篇材料**上，会一次识别出 ERP 与 WMS 两个码，无法回答「哪张表属于哪个」。把判定范围收窄到**模型引用的那一句原文**，粒度就落到了表级——这正是模型该提供的那部分能力。

### 2. 判定结果一律是**候选**，绝不写 `sourceSystems`

判定结果写入 `candidateSourceSystems` + `candidateSourceBasis`（`material_owner_evidence`）+ `candidateSourceEvidence`（那段原文）。对象的 `sourceSystems` **仍是 `['UNASSIGNED']`**。

理由：`sourceSystems` 在本系统里是**事实**——受控系统目录（Critic 的「受控来源系统」）与范围裁剪都读它。候选是推断，推断不得冒充事实，这与 ADR-014 决策 1（标识对应只上报）、ADR-016 决策 3（裁定不产生证据等级）是同一条纪律。

### 3. 候选**不参与范围裁剪**——这是本 ADR 最重要的一条

范围过滤（[ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md)）只看已确认的 `sourceSystems`。候选归属在范围内还是在范围外，**都不影响对象的去留**，只影响上报：

- 候选归属在所选范围内 → 记入 `candidateScopeObjects.inScope`；
- 候选归属不在所选范围内（或未登记）→ 记入 `candidateScopeObjects.outOfScope` / `unregistered`，**不排除该对象**。

理由：一旦让候选参与裁剪，模型在材料里「引用」一句归属于范围外的原文，就能把一个对象从提案里删掉——而人对这句话还没有任何确认动作。ADR-013 要求「被排除项必须显式列出」，前提是**排除的依据是事实**；候选不是事实，所以它不能成为排除的依据。

### 4. 候选**可以进入** 4a 字段目录，但全程标出来源依据

字段目录新增第三个 grounding：`material_owner_candidate`（既有两个是 `proposal_object` 与 `source_system_declaration`）。进入条件：对象有候选归属 **且** 候选系统在本次所选范围内。

对象与链接都带出 `sourceBasis`，链接的 `groundings` 里能看出「这一端来自材料推断的归属」。

理由：不进入目录，跨系统标识对应就永远是 0 条，阶段 4 第 2 条（跨系统连接）在非结构化材料上完全落空——而跨系统连接恰恰是建模里最需要材料的部分。进入目录的代价可控：产生的链接仍是**候选链接**，要经 [ADR-015](ADR-015-identity-link-confirmation.md) 的逐条确认才会进草稿，且要经受 [ADR-016](ADR-016-identity-conflict-rulings.md) 的等价裁定。三道关口都在，模型无从「直接写入」。

### 5. 候选转事实需要**人工确认**，确认必须带依据

复用既有复核动作（`PATCH /semantic-operations/tasks/:id/proposal`）新增 `sourceAssignments`：`{ objectId, system, evidence }`。确认后写入 `sourceSystems`，并按 ADR-013 重新过滤（这时对象才可能被范围排除）。

集合是**全量语义**，与 4b / 4c-1 同构：省略＝不调整、空数组＝撤销全部、显式提交一个无候选归属的对象＝硬错误（界面拿的是过期结论）。

`evidence` 默认取模型给的那段原文（`candidateSourceEvidence`），可改写——但**不得为空**。理由：归属是会参与裁剪的事实，写入它必须留下依据；「人点了一下」本身不是依据。

### 6. 零候选 / 多候选 / 未登记**分别上报**，不猜测

| 情形 | 处理 |
| --- | --- |
| 原文里识别出**恰好一个**已登记系统 | 产出该候选 |
| 原文里识别出**多个**系统码 | **不产出候选**，上报 `attributionAmbiguity`（含全部候选码与原文） |
| 原文里一个都识别不出，或只识别到未登记的系统名 | **不产出候选**，上报 `unattributed`（含原文，若原文含未登记系统名则一并列出） |

理由：多候选时「选哪个都对」的判断需要域知识，服务端不做；识别不到时不猜一个最近的系统——那正是本重构一路在消除的行为。

## Consequences

### 变简单的地方

- 材料里已经写明的归属终于被用上，不再要求运营对着一个空输入框从零填「ERP」（界面上的来源系统输入框保留，但它的角色从「从零填写」变成「确认或改判候选」）。
- 自然语言材料与结构化字典两条路径的归属策略对齐为同一句话：**归属要有依据，依据来自材料或系统声明**。
- 跨系统标识对应在非结构化材料上第一次能建立，且与确认识别共用同一套「候选 → 人工确认 → 事实」的口径。

### 变复杂的地方（如实）

- 提案上现在有**三类**人工结论（裁定、对应确认、归属确认），彼此有顺序依赖：先归属（决定对象属于谁）→ 再裁定（决定等价假设）→ 再确认（决定哪些对应进草稿）。界面上必须把顺序表达清楚。
  - **后续补充（2026-09-25）**：`declaration_divergence` 的合并 / 区分裁定落地后（[ADR-018](ADR-018-declaration-divergence-merging.md)），人工结论变为**四类**，顺序为**归属确认 → 等价裁定 → 同名声明裁定 → 对应确认**；[ADR-019](ADR-019-structured-key-mapping.md) 又把最后一关细化为「三态各一种输入」。原文保留以便追溯当时的判断边界。
- 同一对象可能同时有 `sourceSystems`（已确认）与 `candidateSourceSystems`（候选）。当前规则是**已确认优先且候选不再上报**，但两者不一致时（人把归属改成另一个系统）没有差异视图。
- 候选归属进入字段目录后，可能与系统声明产生新的 `declaration_divergence`（同一对象在两处字段不一致）。这是**期望行为**（阶段 4 第 3 条要求冲突显式上报），但会加剧本已偏大的冲突量级（6 系统下 14 项）。
- 本 ADR 的落地验收是**注入模型输出**的确定性验收；真实模型下的表现已单独测量（4 变体 × 3 轮，见「复审条件 4 的测量」）——**是否给出 `systemEvidence` 与是否逐字都稳定**，但「给的那句是否真的是在说明归属」只靠人工复核，契约不校验语义。

### 明确不在本 ADR 范围内

- **`declaration_divergence` 的合并 / 区分粒度**：对象级裁定，会改变字段目录的合并语义（ADR-016 已把它列为不在其范围内）。
- **`ambiguous_identifier` 的按字段归属指派**：ADR-016 复审条件 3 要求先给出「系统.对象.字段」粒度的形式，本 ADR 给的是**对象级**归属，两套粒度如何共存需独立决策。
- **候选归属的跨修订对比**：不做「与上一版相比归属变了几处」的差异视图。
- **多候选的自动择一**：不做，见决策 6。

## 退出/复审条件

1. **若候选归属要直接参与范围裁剪**：须重新论证——这等于把模型在材料里引用的一句话当成事实，必须先给出与范围裁剪相匹配的确认前置。
2. **若契约里要加入「模型直接给系统码」**：须先给出防幻觉机制与可逐字复核的依据，不得以「模型更省事」为由添加。
3. **若 `sourceAssignments` 需要审计签名或跨修订对比**：须独立决策其留档形式（当前只有「哪一版写了什么」的修订历史）。
4. **若真实模型轮次显示 `systemEvidence` 不稳定**（给的原文不逐字、或引用的是别处的句子）：须重新评估本契约的可行性，并考虑把归属证据的来源改为「材料分段 + 服务端判定」。——**已测量（2026-09-25），未触发**，见下节。

## 复审条件 4 的测量（2026-09-25，已执行）

脚本：`scripts/evaluate-source-attribution.mjs`（`npm run evaluate:source-attribution`）。走 **production 抽取路径** `discoverNaturalSchema`（不另写提示词），provider `workbuddy` / `deepseek-v4-pro`，采样温度 **0.2**（非确定性采样，故重复轮次有意义）。

四个合成材料变体 × 3 轮 = **12 次真实抽取轮次**，另加 2 次端到端提案轮次（A / B）。**12/12 符合预期，分布唯一、无抖动**：

| 变体 | 材料特征 | 期望 | 实测（3/3 轮一致） |
| --- | --- | --- | --- |
| A | 逐字写出「ERP 采购订单表」「WMS 收货表」 | 产出候选 | `attributed`：`purchase_order→ERP`、`inbound_receipt→WMS`；两对象的 `candidateSourceSystems` 均落上，`sourceSystems` **仍 `['UNASSIGNED']`** |
| B | **完全没写**所属系统 | 弃权 | `absent`——模型填 `null`，**没有硬凑一句** |
| C | 只用业务词（「采购业务中的」「库存管理中的」） | 不认 | `unattributed`——模型**引用了原文**，但其中不含系统码，服务端不据业务词判所有权；`attributed` 0、候选 0 |
| D | 归属那一句里出现**两个**系统 | 报歧义 | `ambiguous { systems: ['ERP','WMS'] }`；`attributed` 0，**未择一** |

**12 轮中一次 `OWNER_EVIDENCE_INVALID` 都没有出现**——即模型没有给出「非逐字」的归属原文。单次调用耗时 **3.3–5.6 秒**（均值 4.9 秒）。

**端到端（真实模型输出走完整提案链路，`scopeSystems=['ERP','WMS']`）**

| 观测项 | A（写明归属） | B（未写归属） |
| --- | --- | --- |
| 字段目录对象 | **4 → 6** | 4（不变） |
| 跨系统标识对应 | **0 → 2**（`linkable` 2 / `requires_mapping` 0） | **0** |
| 其中一条 | `WMS.inbound_receipt.po_id → ERP.purchase_order.po_id`（两端 `material_owner_candidate`） | — |
| 标识冲突 | 2 → 3 | 2 |
| 推断来源对象数 | **2** | **0** |
| Critic 失败项 | **2**（受控来源系统、字段来源映射） | **2**（同左） |

**只取证不解检查**：候选阶段 Critic 仍报「受控来源系统：存在未登记来源系统：purchase_order:UNASSIGNED、inbound_receipt:UNASSIGNED」——**这正是决策 2 要的**：候选不是事实。

**按材料原文确认两处归属后（端到端同一进程内）**：`sourceSystems` 写为 `ERP` / `WMS`、候选字段清空、`inferredSourceObjects` **2 → 0**、`inferredSourceLinks` **2 → 0**、Critic 失败项 **2 → 1**（只剩既有的「字段来源映射」）。**结论：本契约在真实模型下可用，复审条件 4 未触发，无需改为「材料分段 + 服务端判定」。**

**这次测量同时暴露了一个自己的错误（如实记录）**：脚本初版按 `item.passed` 过滤 Critic 检查项，而检查项用的是 `status: 'passed'|'failed'`——`undefined` 使**全部**检查都被列为「失败」，一度得出「确认归属后受控来源系统仍然失败」的结论，与代码（`critiqueProposalDraft` 第 3 项读 `draft.objectTypes[].sourceSystems`）和该检查的 detail 都矛盾。改为按 `status` 过滤后结论与注入测量的「2 → 1」一致。**教训：读「一组结果对象里的通过项」之前，先确认该字段叫什么，而不是先确认它是不是 falsy。**

**本次测量的边界（如实）**：① 样本小——4 变体 × 3 轮，且只有**一个** provider/模型（`workbuddy`/`deepseek-v4-pro`）；② 材料为**合成材料**；③ 只覆盖四类归属情形，未覆盖「系统名以别名 / 英文 / 缩写出现」等更宽情形（C 变体只覆盖「业务词」这一类）；④ 契约只保证归属原文**逐字来自材料**，**不保证那句话在语义上真的在说明归属**——模型若引用了一句「逐字但不相关」的句子，服务端会照判，这一层没有机器兜底，只有人工复核；⑤ 确认步骤在端到端测量中是脚本直接调用服务层完成的，未经界面。

## 关联

- [ADR-014](ADR-014-identity-linking-as-assumption.md)：标识对应先推导上报，冲突只上报（**本 ADR 回答其复审条件 3 的模型一半**）
- [ADR-015](ADR-015-identity-link-confirmation.md)：确认后并入与证据等级（本 ADR 的候选链接仍走它的确认关口）
- [ADR-016](ADR-016-identity-conflict-rulings.md)：等价假设先裁定（顺序：归属 → 裁定 → 确认）
- [ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md)：范围是过滤器（本 ADR 明确候选不参与裁剪）
- [ADR-012](ADR-012-explicit-modeling-scope.md)：范围必须显式给出
- [ADR-009](ADR-009-system-registry-single-source.md)：系统注册表单一事实源（归属判定的确定性来源）
- [系统接入重构方案](../SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md) 第 6 节阶段 4c
- [SEMANTIC_MODEL_AUTHORING.md](../SEMANTIC_MODEL_AUTHORING.md)

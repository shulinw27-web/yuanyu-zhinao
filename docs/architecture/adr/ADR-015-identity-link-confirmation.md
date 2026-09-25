# ADR-015: 标识对应在人工逐条确认后并入，并以证据等级保持可区分

## Status

Accepted

## Context

### 当时的约束

- [ADR-014](ADR-014-identity-linking-as-assumption.md) 决定「标识对应只上报、不自动并入草稿关系」，并留下**退出条件 1**：

  > 若开始把 `links` 并入草稿关系：必须先给出「人工确认」的落点与证据等级（是否用 `provenanceType: 'inferred'`），并重新决策「假设与证据在草稿里是否仍可区分」。本 ADR 明确当前不可区分，所以不允许自动并入。

- ADR-014 的 Consequences 里同时记着代价：`relationshipTypes` 不会因为标识对应能力而变多，**跨系统连接的收益是「可见但未生效」**，需要 4b 的复核动作才能真正进入草稿。
- 草稿模型与本体契约已经支持证据等级：`sanitizeProposalDraft` 原样保留 `provenanceType`，`ontology-contract-service` 接受 `declared / observed / inferred / confirmed`，并且**只有 `confirmed` 强制要求 `evidence` 非空**。
- 仓库既有纪律：`model suggestions never become facts`（`semantic-natural-schema-service.js`）。

### 触发点

阶段 4a 落地后，跨系统标识对应已经在界面上可读（实测 6 系统 11 条），但它**对模型没有任何影响**。运营人员看到的与最终草稿是两回事——这本身也是一种「结论超出可见依据」的变体：界面展示了对应关系，人自然会以为它们已经在模型里。

### 需要回答的具体问题

1. 人工确认落在哪个动作上——新端点，还是既有复核动作？
2. 并入的关系标成什么证据等级？`inferred` 还是 `confirmed`？
3. 「假设与证据仍可区分」具体靠什么字段保证？
4. 撤销、重复保存、字段修订后对应失效——这些状态怎么表达，能不能静默处理？

## Decision

### 1. 确认落在**既有复核动作**上，不新增端点

并入通过 `PATCH /semantic-operations/tasks/:id/proposal` 完成，入参新增 `identityLinkConfirmations`，与 `objectTypes / relationshipTypes / primaryKeyCorrections` 并列。

理由：并入本质上就是**修订草稿关系**。走既有通道可以免费获得版本冲突检测（`SEMANTIC_PROPOSAL_REVISION_CONFLICT`）、Schema Critic 重算、Diff / 影响分析、修订历史与「修订后确认凭证失效」这条既有纪律。新开一条旁路意味着这些不变量都必须在旁路里重新实现一遍，而漏掉任何一条都会产生一个「看起来已确认、实际未过 Critic」的状态。

### 2. 证据等级用 `provenanceType: 'inferred'`，**不用** `confirmed`

`confirmed` 在本体契约里是**最高等级**：`ontology-identity-service` 只把 `confirmed` 的映射视为无需复核，`ontology-contract-service` 要求它必须附证据说明。把它给一条由字段名归一化推出的边，等于宣布「一次字符串匹配达到了人工核实事实的地位」——正是 ADR-014 禁止的混淆。

因此：**人工接受一条推断，不改变它仍是推断这个事实。** 人在这个流程里的作用是「决定是否采纳这个推断」，而不是「把它变成材料证据」。

### 3. 可区分性由两个字段保证：`provenanceType` + `derivedFrom`

- `provenanceType`：材料/词汇表声明的边是 `declared`，标识对应并入的边是 `inferred`；
- `derivedFrom`：并入的边记录来源链接的稳定 `key`，可回指到 `identityLinking.links` 的具体一条。

`sanitizeProposalDraft` 的关系白名单新增 `derivedFrom`——**这类「新增字段不进白名单即被静默丢弃」的缺口在 `publicTask` 上已经踩过一次**，此处按同一纪律处理。

**ADR-014 退出条件 1 由此满足**：同一份草稿里两类边可以分辨，方向、基数、证据均可追溯。

### 4. 只能按值对齐的（`linkable`）可直接确认；两端键形状不同的（`requires_mapping`）**必须随确认给出映射依据**

`requires_mapping` 表达的是「代理键 ↔ 业务键，不能按值直接连接」。允许「确认但无依据」等于把一种已知不可直接连接的关系伪装成可连接关系——所以这条不是提示，是硬拒绝（`SEMANTIC_IDENTITY_CONFIRMATION_REQUIRES_MAPPING_EVIDENCE`），依据会写进关系的 `evidence`（不能只留在界面输入框里）。

### 5. 确认集合是**全量语义**，服务端从它重建；省略 ≠ 清空

- `identityLinkConfirmations` **省略** → 本次不调整（保持既有确认）；
- **空数组** → 撤销全部确认（显式为空，与 ADR-012 的「空选择 ≠ 未指定」同构）；
- 客户端传来的**同源关系**（带 `derivedFrom`）一律先剔除，再由服务端按确认集合重建。

这条同时给出一项安全性质：**「人工确认」这道关口不能被一次构造请求绕过**——自己伪造一条带 `derivedFrom` 的关系，保存时会被剔除。

### 6. 失效的确认必须显式，并区分两种来源

- **显式重新提交**却查不到的 key → 硬错误（`SEMANTIC_IDENTITY_CONFIRMATION_STALE`）。那说明界面拿的是一份过期结论，按旧结论并入等于写入一条不存在的对应。
- **继承的历史确认**失效 → 不阻断本次修订，但必须写入 `identityLinkConfirmationReport.droppedStale` 与任务回应。否则任何普通字段修订都会被历史确认锁死；而静默丢弃则会让「我确认过它，怎么没了」无从追问。

### 7. 材料证据优先，推断不覆盖证据

同一条边若已由材料/词汇表以 `references_<field>` 声明过，确认项记入 `skippedExisting` 而不产生第二条边。关系签名口径与草稿层的 `relationSignature` 保持一致，避免两处口径不一致导致「已存在同一条边」判断失效。

## Consequences

### 变简单的地方

- 跨系统标识对应从「可见但未生效」变成「确认即生效」，且生效的边**自带来源凭据**（`derivedFrom`）与**不可冒充的证据等级**（`inferred`）。
- 撤销、重复保存、字段修订后失效三种状态都有明确表达；幂等由「服务端重建」这一实现方式天然保证。
- 界面对这类边只有一个入口（勾选），不会出现「改了谓词但保存后被丢弃」的第二种表达方式。

### 变复杂的地方（如实）

- 草稿里现在有**两种来源的关系**，下游（治理、Diff 阅读、Semantics 采纳）都必须理解 `provenanceType` 的区别。这是 ADR-014 要求的代价，不是新增的。
- `evidence` 的长度上限由 100 放宽到 260：一条 `requires_mapping` 的边要同时容纳链接证据、键形状说明与人写下的映射依据。放宽的是**展示保真度上限**，不是安全边界。
- 映射依据文本上限 80 字（超出的部分在写入时截断）。这是刻意的：依据应当是一行可核对的说明，不是一篇论证。

### 明确不在本 ADR 范围内

- **冲突的处理动作**（`ambiguous_identifier` 的归属指派、`alias_divergence` 的等价裁定、`declaration_divergence` 的合并/区分粒度）——当前仍只上报，需要独立决策（阶段 4c）。
- **从非结构化材料抽取对象与标识**（需模型能力，阶段 4c）。
- 标识对应是否应影响**数据授权**（当前不影响，见 [ADR-012](ADR-012-explicit-modeling-scope.md) 4.5 决策）。

## 退出/复审条件

1. **若把 `inferred` 边也当成可发布的事实**（例如让治理链路的「关系证据」检查接受 `inferred` 而无需人工复核）：须重新论证 `inferred` 与 `declared` 的区别还有没有意义。
2. **若 `requires_mapping` 的映射依据改为结构化映射定义**（而不是自由文本）：须重新评估「依据是否可核对」，并给出映射表的版本与责任人。
3. **若冲突开始有处理动作**：须重新决策「裁定结果是否也并入草稿、以什么证据等级」，并检查它与本 ADR 的 `inferred` 是否会被混用。
   → **已由 [ADR-016](ADR-016-identity-conflict-rulings.md) 解决（2026-09-25，`alias_divergence` 的等价裁定）**：裁定**不并入草稿、不产生证据等级**——它改变的是链接推导的输入（哪些对应成立），采纳仍必须走本 ADR 的确认入口；两者不作用于同一层，因此不可能与 `inferred` 混用。其余三类冲突（`ambiguous_identifier` 归属指派、`declaration_divergence` 合并/区分粒度、`key_shape_incompatible` 结构化映射）仍待处理。
4. **若并入的关系不再由服务端从确认集合重建**（例如允许界面直接编辑 `derivedFrom` 边）：须重新论证「确认关口不可绕过」这一性质由什么保证。

## 关联

- [ADR-012](ADR-012-explicit-modeling-scope.md)：范围必须显式给出（`systemCodes` 的省略/空语义与本 ADR 的确认集合同构）
- [ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md)：范围是过滤器
- [ADR-014](ADR-014-identity-linking-as-assumption.md)：标识对应先推导上报（**本 ADR 解决其退出条件 1**）
- [ADR-019](ADR-019-structured-key-mapping.md) / [ADR-020](ADR-020-identity-link-confirmation-eligibility.md)：本 ADR 决策 4 的「映射依据」升级为结构化定义，并补上**确认这一关的前置条件**——只有两端对象都在本次候选对象内的对应才写得进草稿（`eligible`），不可确认的仍列出但无确认入口。
- [系统接入重构方案](../SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md) 第 6 节阶段 4
- [SEMANTIC_MODEL_AUTHORING.md](../SEMANTIC_MODEL_AUTHORING.md)

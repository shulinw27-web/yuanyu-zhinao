# 架构决策记录（ADR）

更新：2026-09-26。

本目录记录影响全局、难以逆转、需要长期维护的架构决策。ADR 的核心价值是保留 **WHY**——不只记录「选了什么」，更记录「为什么这样选、放弃了什么、什么条件下应当改变」。代码与能力文档说明「现状是什么」，ADR 说明「为什么是现在这样」。

## 什么时候需要新 ADR

满足以下任一条即应登记：

- 决策影响多个模块或整个系统（分层、持久化、通信方式、部署形态）；
- 决策难以逆转，或逆转成本显著；
- 存在多个合理选项，且团队曾就此讨论/争论；
- 引入新的外部依赖或技术栈。

不适用：局部实现细节、单个函数的写法、可随时替换的库选择。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| Proposed | 已提出，等待确认，尚未实施 |
| Accepted | 已采纳，当前有效 |
| Deprecated | 不再推荐，但尚未被替代 |
| Superseded by ADR-XXX | 已被新决策取代，保留历史 |

## 索引

| 编号 | 标题 | 状态 | 关键结论 |
| --- | --- | --- | --- |
| [ADR-001](ADR-001-semantic-permission-separation.md) | 语义与权限分离 | Accepted | 建立语义关系不扩大数据范围；两者独立演进 |
| [ADR-002](ADR-002-reasoning-side-effect-separation.md) | 推理与副作用分离 | Accepted | 模型只产出建议，执行由受控运行时裁决 |
| [ADR-003](ADR-003-state-fact-separation.md) | 状态与事实分离 | Accepted | 已回复/已排队/已审批/已完成是四种不同事实 |
| [ADR-004](ADR-004-json-blob-runtime-persistence.md) | 运行时持久化采用单表 JSON blob | Accepted（含退出条件） | 单机阶段最快路径；**已定义退出的触发条件与迁移前置** |
| [ADR-005](ADR-005-domain-public-api-layering.md) | 领域分层与 public-api 契约面 | Accepted（含收敛目标） | 路由→领域→服务单向；契约面需从重导出收敛为显式契约 |
| [ADR-006](ADR-006-dual-agent-independent-entry.md) | 双 Agent 独立入口 | Accepted | 业务与语义建设不共用授权语义，不合并为单一入口 |
| [ADR-007](ADR-007-modular-monolith-over-microservices.md) | 保持模块化单体，不拆微服务 | Accepted | 团队规模与业务阶段不支持分布式复杂度 |
| [ADR-008](ADR-008-persistence-port.md) | 持久化驱动选择收敛为端口 | Accepted | 消除 35 处重复分支；落地 ADR-004 的「仓储端口」前置条件 |
| [ADR-009](ADR-009-system-registry-single-source.md) | 系统接入的单一事实源、租户隔离与生命周期状态机 | Accepted | 收敛 5 处重复系统清单；系统类型属平台、接入实例属租户；发布不参与降级回落 |
| [ADR-010](ADR-010-agent-ui-package-extraction.md) | 跨端共享前端资产提升为 workspace 包 | Accepted | 8 处跨包穿透全部清偿、基线归零；依赖改声明式具名 exports；扫描面补 `.cjs`/`.css` |
| [ADR-011](ADR-011-system-onboarding-domain-extraction.md) | 接入能力独立成域，主视角从元域智营迁至元域智语端 | Accepted | 新建 `system-onboarding` 域且上限压到 4；连通性探测真发请求；三个空按钮全部接上；字段目录归并但冲突显式暴露 |
| [ADR-012](ADR-012-explicit-modeling-scope.md) | 建模范围必须显式给出，删除「推断为空即回落全量」 | Accepted | 范围只有 `systemCodes` 与显式 `includeAllRegistered` 两个入口；文本识别降级为提示；四类拒绝（含越权阻断）；覆盖如实上报，**决策 5「不按范围过滤对象」已被 [ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md) 取代** |
| [ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md) | 建模范围是过滤器，被排除项必须显式列出 | Accepted | 全部来源在范围外才排除；部分在范围外**保留**并上报 `partialScopeObjects`；`UNASSIGNED` 一律保留；关系随端点被排除；移除 `outOfScopeObjects` 字段名；越权阻断**先于**范围过滤 |
| [ADR-014](ADR-014-identity-linking-as-assumption.md) | 跨系统标识对应先推导上报，不自动并入草稿关系 | **部分取代**：结论 1（不并入）由 [ADR-015](ADR-015-identity-link-confirmation.md) 承接为「人工确认后并入」 | 推导确定性、不依赖模型；对象自身标识必须指向自身概念（外键不得当主键）；四类分歧（歧义/同义不同名/键形状不可对齐/同名声明不一致）显式上报；字段目录按所选系统登记不按材料裁剪；字段修订后必须重算 |
| [ADR-015](ADR-015-identity-link-confirmation.md) | 标识对应在人工逐条确认后并入，并以证据等级保持可区分 | Accepted | 确认落在既有复核动作（不新增端点）；证据等级用 `inferred`（**不用** `confirmed`）+ `derivedFrom` 保证可区分；`requires_mapping` 必须随确认给出映射依据；确认集合全量语义（省略＝不调整、空数组＝撤销）；服务端从确认集合重建，客户端自带 `derivedFrom` 一律剔除；失效确认区分「显式提交（400）」与「继承（上报后移除）」；材料证据优先。解决 ADR-014 退出条件 1 |
| [ADR-016](ADR-016-identity-conflict-rulings.md) | 标识等价假设先裁定、再对齐；裁定改输入而不改证据等级 | Accepted | 裁定落在既有复核动作的 `identityConflictRulings`；本轮只裁定 `alias_divergence`（`same_entity` / `distinct_entity` 等价类划分）；**裁定不并入草稿、不产生证据等级**，因此与 ADR-015 的 `inferred` 不可能混用（改输入 vs 写草稿）；`distinct_entity` 撤下跨组链接并显式列出；`droppedStale` 由字符串升级为 `{ key, reason }` 以区分「字段修订」与「裁定撤下」。解决 ADR-015 复审条件 3 |
| [ADR-017](ADR-017-model-extraction-attribution.md) | 材料归属由模型取证、服务端判定；候选不参与裁剪，确认后才成事实 | Accepted | 模型只给**归属原文**（`systemEvidence`，逐字校验），系统码由服务端用 `detectSystemCodesInText` 确定性判定（契约里**没有**系统码字段）；判定一律是候选（`candidateSourceSystems`），**绝不写 `sourceSystems`**；候选**不参与范围裁剪**（未确认的归属不足以决定对象去留），只做范围内/外上报；候选**可以**进 4a 字段目录（新增 grounding `material_owner_candidate`）使跨系统对应可建立；零/多/未登记三类分别上报不猜测；候选转事实走既有复核动作的 `sourceAssignments`（全量语义、依据不得为空）。回答 ADR-014 复审条件 3 的模型一半 |
| [ADR-018](ADR-018-declaration-divergence-merging.md) | 同名声明不一致要显式裁定「合并 / 区分粒度」；裁定决定字段目录的组成 | Accepted | 裁定落在既有复核动作的 `declarationRulings`（键＝分歧项 `object:Inventory` / `source:ProductionBatch@mes.production_batch`，与 ADR-016 的概念键**两套粒度共存**）；动作两个互斥：`merge`（并集显式化）/ `distinct`（严格划分声明，每组命名或不命名而 `drop`）；`distinct` 的效果是**不并集**——消除「复合字段集被当成一个对象」与它授予的虚假标识；裁定仍**不写草稿、不产生证据等级**；未裁定也必须**披露**并集（`declarations` + `exclusiveFields` + `declarationState`）；撤销双向回退，拆分 / 排除 / 失效链接全部显式列出。承接 ADR-016「明确不在范围内」的 `declaration_divergence` |
| [ADR-019](ADR-019-structured-key-mapping.md) | 标识映射改为结构化定义；「形状未判定」从「形状不同」里拆出来 | Accepted | 链接 `status` 由二态改**三态**（`linkable` / `requires_mapping` / `shape_unknown`）——把裸名的「形状未判定」从「形状不同」里拆出（实测 7 条 `requires_mapping` 中 2 条源于此，文案「形状不同（null / agent）」读不通）；`shape_unknown` 的确认要求是**形状判定**（`shape` 枚举，服务端据此重定级，**不写回声明**）；`requires_mapping` 必须给**结构化映射定义** `keyMapping`（`fromField`/`toField` 须与链接逐字一致 + `basis` 四类枚举 + `owner` + `version`），自由文本降级为可选说明；结构化映射**必须进草稿**（关系白名单），证据等级仍 `inferred`；**不做独立映射表实体**（无复用证据，`owner`/`version` 为升格钩子）。回答 ADR-015 复审条件 2 |
| [ADR-020](ADR-020-identity-link-confirmation-eligibility.md) | 一条标识对应「有没有资格被确认」的判据唯一化 | Accepted | 资格判据唯一化为「**两端 `objectId` 都在本次候选对象内**」，与草案校验读**同一个数组**（实测 11 条：可确认 7 / 不可确认 4，0 例外）；不可确认的对应**必须披露**（`eligible` / `ineligibleEndpoints` / 可行动 `ineligibleReason`），不得从清单隐藏（那是系统声明里真实存在的引用）；确认请求给**专用硬错误** `SEMANTIC_IDENTITY_CONFIRMATION_ENDPOINT_OUT_OF_SCOPE`，检查次序 **链接存在 → 资格 → 形状 → 映射**；`notInProposal` 改名 `declarationSourced`——它回答**证据来源**，不再承载资格（原判据让 `ERP.Inventory.lot_no` 这条**实测可确认**的对应被标成「来源系统未进入候选对象」，是一句界面事实错误）；**不放宽草案校验**（会产出悬空边），也不自动补候选对象（那会让标识推导反向决定对象抽取）。关闭 ADR-019「实测边界 二」只钉未修的缺口，并修正其两处不实的计数与归因 |
| [ADR-021](ADR-021-candidate-provenance-disclosure.md) | 候选对象的来源与「没被生成」的原因必须可读 | Accepted | 补齐阶段 4 剩下一半（对象抽取）的**前置**：先让「候选从哪来、为什么没生成」可见。实测（探针三组诉求）：材料写「采购订单、发运单、出库单、客户投诉」时候选只有 **1 类**，三个对象**静默消失**且无任何解释。**六条决策**：① 受控目录命中披露**命中词**（`matchedTerms`）与**覆盖率**（命中 M / 共 12 类）；② 说明它是**词面匹配的兜底**、不是抽取结果（「材料里写到、但目录未覆盖的业务对象不会出现在候选里」）——**披露不等于补齐**；③ 自然语言抽取的跳过给**可区分的原因**（`mock_runtime` / `not_dictionary_like`，各自一句中文说明），不再 `return null`；④ 跳过判定抽成**纯函数** `naturalSchemaSkipReason`——测试恒为 mock，内联会让另一条分支**永久遮住**；⑤ 披露落在既有 `reviewNotes`，不新增实体、不改 schema、不进 `objectTypes`；⑥ **不放宽任何门槛**（候选为空仍是硬错误）。**边界如实**：① `not_dictionary_like` 在测试环境**不可达**（只能纯函数层覆盖）；② 披露是**覆盖率级**而非**清单级**——从「无人能解释」变成「知道可能漏、但不知道漏了哪个」；③ `'订单'` 命中 `PurchaseOrder` 是已知过泛词，属词表质量，本 ADR 不处理 |
| [ADR-022](ADR-022-candidate-coverage-disclosure.md) | 候选对象的**覆盖面**与「没被生成」的对象名必须可点名 | Accepted | 关闭 ADR-021 边界二的一半：那句「请核对是否遗漏」此前**核对不了**。**七条决策**：① 受控目录连覆盖披露一起搬到 `semantic-candidate-catalog-service.js`——让「兜底能命中什么」有独立取证面；② **目录空白可点名**（确定性）：受控目录 12 类 与 系统目录 `worldObjectTypes` 21 类求差集 ＝ **14 类**（`OutboundShipment`/`InboundReceipt`/`Order`/`QualityEvent` 等），逐条点名对象 + 系统——「发运单/出库单」进不来**不是运营没写清**；③ **未被覆盖的列举项可点名**（启发式：列举切分 + 纯中文 2~8 字 + 噪声门 + 双向覆盖判定，≤12 条且超限必须说明）；④ 启发式**自我标注**（`uncoveredBasis = enumeration_heuristic`，明说「不是对象抽取结果」）；⑤ 落结构化字段 `candidateCoverage`（含 `fallbackApplied` 前提位）并进 `publicProposal` 白名单；⑥ **披露不等于补齐**：点名的对象一个都不进候选；⑦ **披露必须到达界面**——运营控制台不渲染 `reviewNotes`，故新增界面区块。顺带修正一处**死界面**：两段失效披露写成 `selected.value?.proposal?...`（模板中 ref 已解包，恒为 `undefined`，永不显示），且既有断言用宽松可选链匹配**盖住了**它；新增反向锁死。顺带完成 [MODULARIZATION_AUDIT](../MODULARIZATION_AUDIT.md) 第 3 项：`domains/events` → `infrastructure/domain-events`（22 个文件），`INFRASTRUCTURE_DOMAINS` 收敛为**空集** |
| [ADR-023](ADR-023-lifecycle-operation-surface.md) | 接入生命周期操作面：新增接入与已接通系统管理 | Accepted | 状态机早已在注册表定义却**从未暴露为可执行动作**——界面接入状态只能看种子值。**七条决策**：① 域契约 4 → 5（显式抬棘轮，不预留增长空间）；② 状态机仍是单一事实源，新函数只做视图侧门禁与审计组装；③ **接通必须先验证**：任何 `→ connected` 要求该租户最近一次探测 `verified`（409 `SYSTEM_CONNECT_PROBE_REQUIRED`）；④ 理由必填（≤200 字）+ 操作人取受信上下文；⑤ 权限沿用 `meta_model.draft.save`（与探测同闸门），数据域授权不约束治理动作；⑥ 前端渲染服务端返回的 `lifecycle.transitions`，不本地硬编码；「＋ 新增接入」一键聚焦未登记系统；总览/筛选补「已停用」维度；⑦ 不引入任意自定义系统注册（**已被 [ADR-024](ADR-024-custom-system-registration.md) 取代**）。实测：`system-access.test.js` 12 项（9→12）、`workspace-layout` 9 项（8→9）、architecture 10/10（未增跨域边） |
| [ADR-024](ADR-024-custom-system-registration.md) | 自定义系统登记：去预设接入清单与登记物料契约 | Accepted | 接入清单此前是**预设备出来的**（12 目录类型全部种进每个租户），且只能推进既有成员状态。**六条决策**：① **接入清单去预设**——预设成员只剩 6 个 Mock 演示样例（connected），OA/SRM/MDM/PLM/EAM/IOT 转为平台保留码（未登记操作 404 `SYSTEM_ACCESS_MISSING` 并指引走「新增接入」）；② **登记物料契约**——七必填项（名称/业务域/定位说明/核心对象/数据域/接入目的/责任人）单一定义于 `SYSTEM_REGISTRATION_FIELDS`，经总览下发，前端按 schema 渲染不复制规则；③ 自定义系统是**租户资产**（定义+生命周期行同事务原子写入，创建即 `registered`，失败逐字段 `issues`）；④ 域契约 5 → 6（`registerSystemOnboarding`，`POST /api/semantic-operations/systems`，闸门 `meta_model.draft.save`）；⑤ 接通门禁不变——不挂接模拟场景不可探测（409 `SYSTEM_PROBE_DATASET_NOT_ATTACHED`）也到不了 `connected`，挂接后探测读整场景（`simulatedScope: 'attached_scenario'`）；⑥ 授权按声明数据域推导。实测：`system-access` 13 项（12→13）、`system-registry` 8 项（多租户/登记/状态机改由自定义系统驱动）、`workspace-layout` 9 项、architecture 棘轮 5→6 显式变更 |
| [ADR-025](ADR-025-object-mention-linking.md) | 受控对象链接：材料逐字提及进入候选的受控通道 | Accepted | 4f/4g 点名了「缺了什么」，但点名的对象一个都进不了候选（「写四个对象只得 1 类」的根因）。**六条决策**：① 模型只做「材料逐字提及 ↔ 已登记对象类型」的受控链接，服务端三重校验（证据逐字、证据含提称、类型在登记索引内），任一不满足**整份拒绝**；② 只在「结构化材料与自然语言抽取都没产出对象」时运行，ADR-021 决策 6 不推翻；③ 候选结构只来自系统声明，主键用 4a 同一套判据；两类结构缺口（无声明 / 无主键）分开点名不进候选；④ 对 ADR-022 决策 6 的收窄推翻（记录在案），未放宽任何关口；⑤ 披露落 `candidateCoverage.mentionLinking`（含 skipped 前提位与逐条 structured 标记）；⑥ 真实模型评测 `evaluate:mention-linking` 不进 quality。实测：`test:mention` 6/6（新增）、`test:semantic` 6/6+61/61+98/98（既有断言零改动）、`test:architecture` 10/10（登记 2 条同性质边）；真实模型评测因云服务限流待重跑 |
| [ADR-026](ADR-026-permission-equivalence-merge.md) | world.draft.* 并入 meta_model.* 的等价合并与权限单一权威 | Accepted | 阶段 6：用户在三策略中选定**等价合并**（create→draft.save、validate→draft.validate、publish→publish）。**三条决策**：① world.draft.* 权限条目与代码引用全删，menu.world 按钮清空（页面去留属 4.3 未决）；② 删除服务层隐藏的第二道闸门（canConfigure/canPublish 白名单），权限系统成为唯一权威，发布仍由 meta_model.publish（仅 executive）把守；③ 前端闸门换码、模板配置角色白名单保留（持权角色可见性零变化）。如实披露：另三角色（本就持接入侧写入权限）的映射草稿入口随「同一把闸门」语义打开；动作角色从 executive 回退变为持权主角色本人。实测：test:permissions 29/29、test:access 13/13、test:semantic 6+61+98、test:events 17/17、test:scope 12/12 |
| [ADR-027](ADR-027-document-material-registration.md) | 阶段 5a 文档类材料登记：提取文本与解析取证持久化 | Accepted | 登记通道 `saveMockOnboardingMaterial` 扩展接受 `{attachment}`（与 text 二选一），走对话面同一套安全闸门；**只持久化提取文本 + 解析取证 source，原文件不落地**；超限/不完整**整份拒绝**（多模态报告新增 parserTruncated 区分解析器截断与上下文预算截断）；XLSX/DOCX 字典经 `parseOfficeTableRows` 与 CSV 同路径进结构化候选；PDF 只走 NL 并点名披露。**连带修复**：lowerKeys 把中文表头清洗为空串（中文别名列从不生效）。dictionary/samples 仍限 JSON（后由 ADR-029 对 dictionary 收窄推翻）。实测：mock-onboarding-document 6/6、semantic-schema-discovery-document 7/7、quality EXIT=0 |
| [ADR-028](ADR-028-system-onboarding-connection-config.md) | 阶段 8 系统接入连接配置段：attachmentDocuments/heartbeat/auth 三段扩展 | Accepted | 登记物料从「业务描述性」扩展到「连接配置段」：`attachmentDocuments`（文档物料登记即入库、复用 5a 解析）+ `heartbeat`（endpoint 必填）+ `auth`（scheme 枚举，credentialRef 必须 kms://、scope 必填）。探测升级：自定义系统带 heartbeat.endpoint 优先真实心跳（user_token_passthrough 转发 X-On-Behalf-Of 不持凭据；service_principal 从 Key Center 取 opaque Bearer），心跳失败但有 mockScenarioId 降级模拟场景带 heartbeatIssue；登记时自动注册凭据策略（按租户隔离）。接通门禁仍=人工签字。**补充实施（2026-10-07）**：8-5 文档提取文本串入 schema 发现候选链；8-6 心跳定时探测 Worker（连续 3 次失败自动降级 degraded，状态机新增 connected⇄degraded）；8-7 auth.scheme 2→5（+api_key/oauth_authorization_code/mTLS，凭据策略注册扩展到全部 4 种凭据持有方案）。实测：registry 15/15、heartbeat 15/15、worker 5/5、document-discovery 5/5、quality EXIT=0 |
| [ADR-029](ADR-029-document-dictionary-strong-chain.md) | 文档字典进入 mock 强校验链（对 5a 决策点 3 的收窄推翻） | Accepted | 2026-10-07：XLSX/DOCX 文档字典经 `parseOfficeTableRows` 还原后**直接进 mock 强校验链**（连接/样本/对齐与 JSON 字典同语义），推翻 ADR-027 对 dictionary 保留 JSON 契约的决策点 3（samples 仍限 JSON）；`validateDictionary` 加文档形态分支与行式别名映射（严格类型别名不静默默认）；前端 dictionary 类别开放 XLSX/DOCX（不开放 PDF，客户端 kind 级 mime 收窄）。实测：mock-onboarding-document 9/9、console 63/63、quality EXIT=0 |
| [ADR-030](ADR-030-semantic-operations-permission-independence.md) | 元域智语权限语义独立：page.world.view 保留期结束删除 | Accepted | 2026-10-07：4.3 决策 A 的「保留一个版本周期」兑现——权限目录新增 `menu.semantic-operations`（元域智语，page.semantic-operations.view），删除 `menu.world`/`page.world.view`；quality_manager 菜单 world→semantic-operations；8 处后端 + 2 处前端 + 4 处测试换码；老前端 AppShell「语义层」死链导航项删除。单一页面权限粒度（全端一致访问预期），细粒度拆分待真实需求触发。实测：test:permissions 31/31、test:knowledge 56/56、test:multitenant 75/75、quality EXIT=0 |

## 模板

```markdown
# ADR-XXX: [决策标题]

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-XXX

## Context
是什么问题促使我们做这个决策？约束是什么？

## Decision
我们提议/正在做的改变是什么？

## Consequences
因此什么变简单了？什么变困难了？放弃了什么？

## 退出/复审条件（可选但强烈建议）
什么条件下应当重新审视或推翻此决策？
```

## 维护约定

- 决策变更时**不修改原 ADR 的结论**，而是新增 ADR 并标注 `Superseded by`；
- 每条 ADR 必须在 `Context` 中写明当时的约束（团队规模、阶段、外部限制），否则后人无法判断决策是否仍然成立；
- 涉及可逆性差的决策（尤其持久化、通信方式）必须写退出条件；
- ADR 与能力文档冲突时，以 ADR 的「为什么」与能力文档的「是什么」分别理解，冲突处应更新能力文档。

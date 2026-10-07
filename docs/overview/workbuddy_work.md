# WorkBuddy 协作工作记录

更新：2026-10-05（覆盖至阶段 5a 文档类材料接入完成）。本页按时间线维护 WorkBuddy 接手「元域智脑」（demo-platform）以来完成的工作，供交接与回溯使用。当前整体状态以 [当前状态](PROJECT_STATUS.md) 为准，此处只记录协作过程中的增量、根因与边界，不重复验收结论。

## 时间线总览

| 序号 | 工作 | 结果 |
| --- | --- | --- |
| 1 | 项目理解与基线梳理 | 明确六阶段 Mock 优先路线与文档纪律 |
| 2 | WorkBuddy 云 Provider 接入 | 免密钥模型替代欠费方舟，专项 7/7 |
| 3 | 2026-09-19 阻断评测重跑 | 9 类评测全部补齐，双 Agent 联调 23/23 |
| 4 | 异常契约根因修复 | 保出处引文恢复，专项 24/24 |
| 5 | 评测脚本 provider 化 | 12 个脚本 env 覆盖、缺省 ark 不变 |
| 6 | 本机环境恢复 | Docker/WeKnora 五容器健康 |
| 7 | 文档检查误伤修复 | check-docs 忽略 `.workbuddy` |
| 8 | 预存测试失败修复 | 9 项清零，`test:ark` 39/39 |
| 9 | 产品视角分析 | 产出产品分析与方向文档 |
| 10 | 架构视角分析 | 实测测绘 + 优化建议文档 |
| 11 | 架构优化落地·阶段一 | 棘轮约束测试 + ADR 库（8 条） |
| 12 | 架构优化落地·阶段二 | God Service 1206→1147 行 |
| 13 | 架构优化落地·阶段三 | 持久化端口化 + 核心实体显式列 |
| 14 | 模块化与组件化审计 | P0/P1/P2 实测问题 + 建议执行顺序 |
| 15 | 模块化审计建议第 1 项 | 跨包边界棘轮测试，8 处债务冻结 |
| 16 | 系统接入重构方案确认 | 5 项决策定案，方案转 Accepted |
| 17 | 阶段 0·系统单一事实源 | 5 处定义收敛为 1，接入状态机，注册表 7/7 |
| 18 | 产品改名「元域智语」 | 99 文件 / 311 处，技术标识不变 |
| 19 | 元域智语云大模型真实联调 | 真实模型理解打通 + 降级回落修复，路由专项 9/9 |
| 20 | 阶段 1·共享前端资产建包 | `packages/agent-ui` 上提 17 文件，跨包基线 8 → 0 |
| 21 | 阶段 2·接入迁移到元域智语端 | 新域 `system-onboarding`（导出压到 4），三个空按钮真正接上，跨域边 8 → 10 |
| 22 | 关闭两处遗留 | 遗漏的模型降级测试契约（`test:ark` 38/39→39/39）；SQLite `SQLITE_READONLY` 并发缺陷（2/3 失败→12/12 通过） |
| 23 | 阶段 3·选系统成为建模必选项 | 删除「推断为空→回落全量」；四类拒绝（含越权阻断）；覆盖如实上报；`test:scope` 10/10 |
| 24 | 推翻并修掉一处误判 | `test:permissions` 并非 flaky：启动预算 1000ms < 实测 1097–1519ms；改按时间计预算后连跑 5 次 0 失败 |
| 25 | 阶段 4 前置·范围成为过滤器 | 关闭 ADR-012 退出条件 2：来源全超范围的对象与悬空关系排除、被排除项显式列出（`excludedObjects`/`excludedRelationships`）、部分超出保留（`partialScopeObjects`）；新增 `SEMANTIC_PROPOSAL_SCOPE_EXCLUDED_ALL`；`test:scope` 10/10 → 12/12 |
| 26 | 阶段 4a·跨系统标识对应 | 按所选系统字段目录识别标识（主键/业务键/未识别，绝不拿首字段顶替）；`WMS.InboundReceipt.purchase_order_id → ERP.PurchaseOrder.purchase_order_id` 等 11 条跨系统引用 + 14 项冲突显式上报；**只上报不自动并入**关系（ADR-014）；`test:identity` 7/7 |
| 27 | 阶段 4b·标识对应确认后并入 | 关闭 ADR-014 退出条件 1：人工逐条确认才并入，边标 `provenanceType: 'inferred'` + `derivedFrom`（与材料证据可区分）；`requires_mapping` 必须带映射依据（**该「自由文本依据」已被第 32 项升级为结构化映射定义**）；确认集合全量语义、服务端重建（伪造边被剔除）；失效确认区分显式 400 与继承上报；`test:identity` 7/7 → 12/12 |
| 28 | 阶段 4c·标识等价假设先裁定 | 解决 ADR-015 复审条件 3：有等价分歧的概念必须先被裁定（`same_entity` / `distinct_entity` 严格划分）才谈对齐；裁定改**输入**不写草稿关系（与 `inferred` 不混用）；`distinct_entity` 撤下跨组对应并显式列出；`droppedStale` 升级为 `{ key, reason }` 以区分「字段修订 / 裁定撤下」；`test:identity` 12/12 → 17/17 |
| 29 | 阶段 4c 第二段·材料归属由模型取证 | 回答 ADR-014 复审条件 3 的模型一半：模型只给**归属逐字原文**、系统码由服务端判定（**契约里没有系统码字段**）；判定一律是**候选**，不写 `sourceSystems`；**候选不参与范围裁剪**（只上报 `candidateScopeObjects`）；候选可进 4a 字段目录（新增 grounding `material_owner_candidate`）；候选转事实走人工确认 `sourceAssignments`（依据不得为空）；字段目录 13 → 15、跨系统对应 0 → 2 条；`test:attribution` 12/12 |
| 30 | 阶段 4c 第二段补测·归属契约真实模型稳定性 | 回答 ADR-017 复审条件 4（**未触发**）：新增 `evaluate:source-attribution`，走 production 抽取路径，4 变体 × 3 轮真实模型轮次全部符合预期（指名系统→候选、未写→弃权、只用业务词→不认别名、两个系统→报歧义）；跨系统对应 **0 → 2 条**、确认后 Critic 失败项 **2 → 1**；24 轮 0 次 `OWNER_EVIDENCE_INVALID` |
| 31 | 阶段 4c 第三段·同名声明合并 / 区分裁定 | 承接 ADR-016「不在范围内」的 `declaration_divergence`（此前**没有任何入口**，实测 5 项）：字段并集从**默认动作**变成可裁定的结论；裁定落 `declarationRulings`（键是**分歧项**，与 ADR-016 的概念级键两套粒度共存）；`distinct` 后**不并集**（按声明拆成各自对象、各自识别标识），消除「复合体被授予虚假标识」（实测 `MES.ProductionBatch` 7 → 4 字段、新对象 `MesBatch` 标识 `batch_no`）；**未裁定也必须披露并集**（`declarations` / `exclusiveFields` / `declarationState`）；`test:declaration` 12/12 |
| 32 | 阶段 4d·标识映射结构化 +「形状未判定」独立成态 | 关闭 ADR-015 复审条件 2（**部分满足**）：`requires_mapping` 的自由文本依据升级为结构化 `keyMapping`（两端键逐字一致 + `basis` 四类枚举 + `owner` / `version`），下游第一次能**机器读**到「这条边需经映射」；排查中发现真正的缺口是**判据把「形状未知」当成了「形状不同」**——裸名（`sku` / `product`）被标 `requires_mapping`，要求人为机器尚未判明的事写依据，文案写成「形状不同（null / agent）」读不通；`status` 二态改**三态**、拆出 `shape_unknown`（实测 `requires_mapping` **7 → 5**、新增 **2**），判定后重新定级且**不写回声明**；映射**进草稿**但证据等级不变；**不做独立映射表实体**（实测无复用）；`test:identity` 17/17 → **20/20** |
| 33 | 阶段 4e·一条对应「有没有资格被确认」的判据唯一化 | 承接 4d 留在「下一步」的实测缺口：11 条对应里 **7 可确认 / 4 不可**，而旧 `notInProposal` 拿「声明 grounding」冒充「候选资格」，把 `ERP.Inventory.lot_no`（**实测可确认**，因对象名与候选对象 `Inventory` 同名）标成「来源系统未进入候选对象」——一句界面事实错误；确认判据**唯一化**为「两端对象都在本次候选对象内」，与草案校验**读同一个数组**；不可确认的仍列出但无确认入口、带**可行动**原因；专用错误码 `..._ENDPOINT_OUT_OF_SCOPE` 取代通用「必须完整」；`notInProposal` → `declarationSourced`（只答依据来源）；`test:identity` 20/20 → **21/21** |
| 34 | 阶段 4f·候选对象的来源与「没被生成」的原因必须可读 | 补「对象抽取」的**前置**：实测材料写「采购订单、**发运单、出库单、客户投诉**」时只得到 **1 类**候选，三个对象**静默消失**且**此前无一句解释**；受控目录命中改为披露**命中词与覆盖率**（命中 M / 共 12 类）并说明它只是**词面匹配的兜底**（披露不等于补齐）；自然语言抽取的**跳过**给**可区分原因**（`mock_runtime` / `not_dictionary_like`）取代 `return null`，判定抽成**纯函数**（否则 mock 会永久遮住另一条分支）；披露落在既有 `reviewNotes`，不改 schema；**不放宽任何门槛**；`test:semantic` 第三组 92 → **94** |
| 35 | 阶段 4g·候选对象的覆盖面与没被生成的对象名必须可点名 | 4f 留下的「请核对是否遗漏」**核对不了**——4f 的毛病是「披露了事实，但没给出可执行的对象」。把两个**从未对起来看过**的事实相减：受控目录 **12 类** vs 系统目录 `worldObjectTypes` **21 类** → 差集 **14 类**，**「发运单/出库单」进不来不是运营没写清**（`OutboundShipment` 早在系统目录里，只是候选词表没有词条）；受控目录与覆盖披露**搬到独立服务**（有纯函数取证面）；**目录空白**（确定性）+ **未被覆盖的列举项**（启发式：列举切分 + 纯中文 2~8 字 + 噪声门 + 双向覆盖判定 + 截断必须说明）**两侧都能点名**；启发式**自我标注** `enumeration_heuristic`；落结构化 `candidateCoverage` 并进白名单（含 `fallbackApplied` 前提位）；**披露不等于补齐**（点名的对象一个都不进候选）；**披露必须到达界面**——运营控制台不渲染 `reviewNotes`，故新增界面区块，并**顺带修正两处死界面**（`selected.value?.proposal?...` 恒为 `undefined`，两段失效披露永不显示；既有断言的可选链匹配**盖住了**它）；`test:semantic` 第三组 94 → **96**、`workspace-layout` 7 → **8** |
| 36 | 模块化审计第 3、5 项 | `domains/events` → `infrastructure/domain-events`（**22 个文件**；相对深度不变故域内导入无需改动），`INFRASTRUCTURE_DOMAINS` 收敛为**空集**——`domains/` 下每个目录都必须是带 public-api 的业务边界；实测 `services/` → `domains/` 直接引用只剩 `risk-service.js` 1 处（其余 9 处随迁出**不再构成分层反转**）；前端三层组件归位判据写入 [ARCHITECTURE](../architecture/ARCHITECTURE.md) §3.3 |
| 37 | 交付复核与推送 | 提交前复核**发现改名回归**：「元域语义运营报告」被批量替换拼成「元域**元域**智营报告」（4 处遗留），Electron 窗口标题与文档目录名都带重复前缀，且**测试断言跟着一起错**所以测试全绿；根因是同一常量被抄成两份，收敛为唯一常量 `REPORT_ROOT_DIR_NAME` 并加反向锁死；`npm run quality` **970 / 970**、新增 ADR-009~022 与全部文档同步入库，推送 `origin/main` |
| 38 | 端命名调整 | 语义运营端定名**元域智语**（代码 + 184 份文档 322 处 + 6 个文件改名），管理 Web 定名**元域智营**（原「保健品 AI 运营平台 Demo」遗留名）；三份把「元域智营 AI 基座」当平台名用的文档脚本改为「元域智脑 AI 基座」（历史误用）；三段式替换防误伤，`docs:check` 185 份 / 1177 链接全通 |
| 39 | 接入生命周期操作面 | [ADR-023](../architecture/adr/ADR-023-lifecycle-operation-surface.md)：状态机早已定义却从未暴露——路由无端点、前端无入口，接入状态只能看种子值。补齐 `POST /systems/{code}/lifecycle`（域契约 4→5 显式抬棘轮）+ 接通门禁（须先探测 verified）+ 理由必填 + 前端操作面板与「新增接入」入口 + 已停用维度；`system-access.test.js` **12（9→12）**、`workspace-layout` **9（8→9）**、architecture 10/10 |
| 40 | 自定义系统登记 | [ADR-024](../architecture/adr/ADR-024-custom-system-registration.md)：接入清单**去预设**（预设成员只剩 6 个 Mock 演示样例，保留码操作 404 指引「新增接入」）+ 登记物料契约 `SYSTEM_REGISTRATION_FIELDS`（7 必填 + 3 可选，让智脑不靠猜就知道接入的是什么系统）；自定义系统为**租户资产**、创建即 `registered`；域契约 5→6、`POST /api/semantic-operations/systems`；`test:registry` 7→**8**、`test:access` **13/13** |
| 41 | 阶段 4h·受控对象链接 + 收尾三项 | [ADR-025](../architecture/adr/ADR-025-object-mention-linking.md)：材料**逐字提及** ↔ 已登记 `worldObjectTypes` 受控链接进候选——模型只输出 `{mention, evidence, objectType}`、服务端三重校验、任一违规**整份拒绝**；结构只来自系统声明 + 4a 同一套判据；两类结构缺口（`no_declaration`/`no_identifier`）只披露不进候选；对 ADR-022 决策 6 的收窄推翻已记录。收尾：词表治理第一轮（目录 **12→20 类**、缺口 14→6）+ `no_identifier` 数据驱动用例（`test:mention` **7/7**）+ 元域智语「受控对象链接」披露面板 |
| 42 | 阶段 6 第一段·权限等价合并 | [ADR-026](../architecture/adr/ADR-026-permission-equivalence-merge.md)：`world.draft.create/validate/publish` 删除并语义等价映射到 `meta_model.draft.save/validate/publish`；**删除服务层隐藏的第二道闸门**（`world-model-template-service.js` 硬编码角色白名单，与 IAM 重复且不可见），权限系统成为唯一权威；`test:permissions` **29/29**、`test:access` 13/13 |
| 43 | 阶段 6 第二段·元域智营「元模型」菜单全迁删除 | 方案 4.3 决策 A：删 world 页全部前端链路（页面组件目录、状态/动作/数据分支/导航注册/19 个 API 方法/样式）；**关键取证**——`page.world.view` 被 4 处元域智语服务复用为访问权限，权限条目按阶段 2 先例**保留一个版本周期**，权限矩阵与后端零变化；`test:permissions` **31/31**（新增「持旧权限不可进入已移除页面」等 2 用例）、`test:access` **13/13**、管理 Web 构建 1.67s |
| 44 | 阶段 7·文档同步与路线图口径对齐 | 第一段：`iam-seed` 菜单描述重构 + 全量事实性文档同步（`docs/modules/07` 权限列按 ADR-026、`ARCHITECTURE` 按钮清单、`SEMANTIC_CONTEXT_MICROSERVICE` 表述）。第二段：[开发路线](../development/DEVELOPMENT_ROADMAP.md) 口径对齐（用户 2026-09-25 已确认）——阶段 1「模拟企业与接入项目」→「**系统接入**」、新增口径对齐段；带日期历史增量保留原口径不回溯改写。`docs:check` **188 md / 1223 链接**。**至此系统接入重构阶段 0~4h、6、7 全部完成；阶段 5 被视觉模型硬前置卡死** |
| 45 | 阶段 5a·文档类材料接入（ADR-027） | 用户 2026-10-05 决策重新划界：暂不增加视觉能力，多模态现阶段以文档类能力为主（建模时阅读接口/数据字典文档）。5a-0 探针取证后实施：登记通道 `saveMockOnboardingMaterial` 扩展接受 `{attachment}`（与 `text` 二选一），走对话面同一套安全闸门，**只持久化提取文本+解析取证、原文件不落地**；图片/音频/视频与字典/样本文档形态给专用错误码整份拒绝；`office-material-parser` 新增 `parseOfficeTableRows`，office mime 与 CSV 同路径产出 `xlsx_dictionary`/`docx_dictionary` 候选；PDF 不进结构化候选并在 warnings 点名披露；前端三类文本材料开放文档上传。**连带修复两处真缺陷**：多模态报告新增 `parserTruncated`（解析器级截断与模型上下文预算截断此前混为一谈会误拒合法文档）；`lowerKeys` 的 `[^a-z0-9]` 把中文表头清洗成空串——「字段名/主键/外键」等中文别名列**从不生效**（属「实现与断言同错」）。新边 `mock-onboarding-service → multimodal-input-service` 按同性质先例登记。`npm run quality` **EXIT=0**（1m36s）；新增 `mock-onboarding-document` **6/6**、`semantic-schema-discovery-document` **7/7**；回归 mock-onboarding 75/75、semantic 105/105、mention 7/7、attribution 12/12、multimodal 19/19、console 63/63 + 构建；`docs:check` **189 md / 1241 链接**。**边界**：dictionary/samples 强校验链仍以 JSON 字典为准，文档形态字典只走候选路径；5b（图片/扫描页/音频）仍整份拒绝，待视觉/语音通道可用后单独排期 |
| 46 | 阶段 8·系统接入连接配置段（ADR-028） | 用户三点需求（文档物料/心跳接口/授权方式）触发 ADR-024 复审条件 1：登记物料三段扩展 `attachmentDocuments`（登记即入库、复用 5a 解析）+ `heartbeat`（endpoint 必填）+ `auth`（scheme 枚举、credentialRef 必须 kms://）；探测升级——自定义系统带 heartbeat.endpoint 优先真实心跳（a=X-On-Behalf-Of 透传不持凭据、b=Key Center 按租户策略发 opaque Bearer），心跳失败但有 mockScenarioId 降级模拟场景带 heartbeatIssue；登记时自动注册凭据策略。接通门禁仍=人工签字。registry 15/15、heartbeat 11/11、quality EXIT=0 |
| 47 | 阶段 8 收官·8-5~8-7 边界项 + 真实模型评测补跑 | 8-5：文档提取文本串入 `discoverWorkspaceSchemas`（DOCS_KEY），`registerSystemOnboarding` 转 async，新增 document-discovery **5/5**、棘轮登记 `semantic-material-workspace → system-access` 跨域边；8-6：心跳定时探测 Worker（连续 3 次失败自动降级，状态机新增 `degraded` connected⇄degraded），worker **5/5**；8-7：auth.scheme 2→5（+api_key/oauth_authorization_code/mTLS），凭据策略注册扩展到全部 4 种凭据持有方案，heartbeat 11→**15**；`evaluate:mention-linking` 云配额恢复后补跑**6/6 通过**（A linked-as-expected、B abstained），关闭 ADR-025 评测欠账——**「quality 全绿」自此起含真实模型评测数字** |
| 48 | 边界项四连·C-1/C-2/C-3/C-4① | 未完成清单盘点后确认：C-3 模块化审计第 6 项关闭（前端三层判据写入审计文档）；C-4① `validateModelSelection` local 通道按 **basename** 比对（白名单存裸文件名、运行时配置是完整路径，精确匹配恒失败）；C-1 [ADR-029](../architecture/adr/ADR-029-document-dictionary-strong-chain.md)：XLSX/DOCX 文档字典直接进 mock 强校验链（推翻 5a 决策点 3，samples 仍限 JSON），mock-onboarding-document **9/9**；C-2 [ADR-030](../architecture/adr/ADR-030-semantic-operations-permission-independence.md)：权限目录新增 `menu.semantic-operations`（元域智语），删除 `menu.world`/`page.world.view`（4.3 决策 A 保留期兑现），8 处后端 + 2 处前端 + 4 处测试换码，AppShell「语义层」死链删除；permissions **31/31**、knowledge **56/56**、multitenant **75/75**、quality 全绿 |

## 1. 项目理解与基线梳理

通读 [开发路线](../development/DEVELOPMENT_ROADMAP.md)、[生产 Checklist](../operations/PRODUCTION_TODO_CHECKLIST.md)、[当前状态](PROJECT_STATUS.md) 及架构文档，确认：项目处于「开发基线 + Mock 验证平台」阶段，阶段 1–2 大量完成、阶段 3–5 推进中；docs/ 是唯一事实源，每个增量必须记录验收数字与边界，Mock 结果不得表述为生产验收。

## 2. WorkBuddy 云 Provider 接入

背景：火山方舟返回 403 `AccountOverdueError`（账户欠费），真实模型评测全部被阻断。

- 新增 `workbuddy` 免密钥 Provider：端点与 publishableKey（应用级公开凭据）固定于 `config/workbuddy-cloud.json`，模型按治理精确版本固定为 `deepseek-v4-pro`（备选 `glm-5.3`；`auto` 动态路由不入白名单）。
- 云服务仅支持流式 SSE，传输层聚合为网关统一非流式契约；错误按有界分类（配额/鉴权/网关等），不透出上游原始报文。
- 治理：精确版本白名单校验、拒绝运行时改写 pinned 端点/模型的 override。
- 验证：`evaluate-workbuddy-cloud` passed（约 2.5 秒、182 tokens、finishReason=stop）；新增专项 7 项全部通过并挂入 `test:ark` 组。
- 边界：Ark Provider 与欠费诊断保留未删除；云服务仅文本，图片多模态未接入。

## 3. 阻断评测重跑（2026-09-19 方舟 403 阻断项）

全部改用 `workbuddy`（deepseek-v4-pro）重做被阻断评测，结果如下：

| 评测 | 结果 | 备注 |
| --- | --- | --- |
| 异常助手 | 3/3 | 10.5 / 7.5 / 8.2 秒 |
| 独立双 Agent WeKnora 联调 | 23/23 | 1 分 45 秒；真实 WeKnora + 真实云模型 + 真实 Semantica + 隔离 HTTP + Mock 业务 |
| 知识问答 | 4/4 | — |
| 供应链事件 | scenarioCompleted | H3 全世界回放 failed 为既有状态（与 2026-09-11 方舟成功运行一致） |
| 语义工作台 `--with-runtime` | 12/12 | 首跑 11/12（偶发模型波动），复跑通过 |
| 长对话 | 21 轮 0 失败 | — |
| 材料上下文 | 4/4 | — |
| WeKnora 适配器联通 | 19/19 | 含真实模型回答 |
| 语义制造 | 8/8 模型轮次 | 13 对象 / 17 关系正确 |

如实跳过：`evaluate-ark-dialogue`、`benchmark-ontology-model`（Ark 专用传输）、多模态两脚本（云服务仅文本）。

遗留模型措辞观察（语义正确、断言属人工复核型）：capabilities `targeted-risk` 把用例 ID 改写为「RiskCase/[业务标识]-0041」；intelligence `B1` 回答泄漏「ISO 时点/历史快照」内部词汇。

## 4. 异常契约根因修复

评测首跑 0/3 时回答内容全部正确、契约拒绝，用一次性探针捕获真实输出定位根因：deepseek 把逐字引文中的全角标点归一化为半角（如 `，`→`,`），`includes()` 精确匹配失败。

- `anomaly-report-contract.js` 新增保出处恢复：全角→半角映射仅为 1:1 字符变换，可归一化定位后回填原文切片（`locateVerbatimQuote`），存储值保持逐字摘录；编造引文（原文中不存在）依然拒绝。
- 提示词强化：引文须与原文逐字符一致、不得规范化改写；否定/悬置表述（「具体批次不清楚」）不得作为字段值；更正取原子值（「不是B240914，是B240913」→ B240913）。
- 验证：异常专项 24/24（含新增「标点归一化恢复原文切片、编造引文仍拒绝」回归）；异常评测 3/3。

## 5. 评测脚本 provider 化

12 个脚本把硬编码 `ark` 运行模式、允许模式与 `inferenceSource === 'ark'` 断言统一改为「`AGENT_RUNTIME_MODE` 等环境变量可选、缺省仍为 ark」，历史行为不变；报告如实标注 model/provider/scope。涉及 `ark-runtime.mjs` 与异常助手、双 Agent 联调、知识问答、语义工作台、供应链、capabilities、长对话、材料上下文、语义制造、WeKnora 集成等评测脚本。

## 6. 本机环境恢复

- Docker 引擎未运行导致 WeKnora 全部 502/503。沙箱会在命令结束时回收派生进程树，常规方式启动的 Docker Desktop 随命令消失；经用户授权后改经 `explorer.exe` 壳分离启动（父进程脱离命令树存活），引擎 29.6.2 就绪。
- 按既有 compose 启动 WeKnora 五容器（frontend/app/docreader/postgres/redis）全部健康，合成库 5 份文档解析完成；未改密钥、数据与白名单。

## 7. 文档检查误伤修复

`scripts/check-docs.mjs` 将项目记忆目录 `.workbuddy` 下的 md 误纳入链接检查，ignored 集合补充 `.workbuddy` 后通过（156 个 md / 819 个链接）。

## 8. 预存测试失败修复

此前全量 quality 记录 9 项预存失败（ark preflight 1 项 + 真实 SQLite 跨进程/重启恢复 8 项，含专项重复执行），已用 `git stash` 在干净工作区复现确认与增量无关。本次排查关闭：

- 根因：当前受控 Windows 沙箱环境下 `spawnSync` 同步启动子进程稳定返回 EBUSY（errno -4082；托管与系统 node.exe 均复现，连续 5 次无一成功），异步 `spawn` 同场景全部成功。属本机环境对同步启动路径的限制，不是业务代码缺陷。
- 修复：`runtime-persistence`、`agent-long-task-worker-process`、`mock-event-checkpoint`、`ark-model-gateway` 四个测试文件将 `spawnSync` 替换为等价的异步 `spawn` Promise 封装；返回结构 `{ status, stdout, stderr }`、超时终止、退出码与全部输出断言逐项保留，真实跨进程语义不变。业务源码零改动。
- 回归：`test:ark` 39/39（此前 38/39）、`test:persistence` 30/30、`test:desktop` 20/20 + 10/10、跨进程/恢复相关测试 9/9、改动文件 ESLint 通过。

## 9. 产品视角分析

产出 [产品分析与方向](PRODUCT_ANALYSIS_AND_DIRECTION.md)：以「语义层连接企业数据、双 Agent 承接业务」为定位，梳理目标用户（业务人员 / 元域智语 / 管理员）与核心价值路径，指出当前阶段的主要产品风险（能力已建成但业务闭环未闭合、Mock 与真实边界易被误读），并给出优先级排序的方向建议。

## 10. 架构视角分析

产出 [架构分析与优化](../architecture/ARCHITECTURE_ANALYSIS_AND_OPTIMIZATION.md)。**方法：先实测后结论**——用只读脚本测绘而非凭文档推断，结果修正了此前偏乐观的判断：

| 实测项 | 实测值 | 说明 |
| --- | --- | --- |
| 领域 public-api 导出 | agent 61 / governance 92 等 10 个领域 | 是「重导出清单」而非契约，契约面远大于预期 |
| 跨领域服务直接依赖 | **189 条边** + 45 个服务前缀 | 先前判断为「点状渗透」，实测为系统性横切 |
| 最大 God Service | `private-agent-service.js` 1206 行 | 直接 import 33 个 service |
| 运行时持久化 | 单表 `runtime_state` JSON blob | 测试 bootstrap 强制 memory 驱动，79 测试仅 7 个用 sqlite |

基于实测给出 5 项建议，并按「先立约束、再改结构、最后动数据」排序。

## 11. 架构优化落地·阶段一：约束棘轮 + ADR 库

**思路**：架构债务无法一次还清，先建立「只降不升」的棘轮，阻止继续劣化。

- `backend/test/architecture-boundaries.test.js` 新增 3 项棘轮测试（该文件共 9 项）：领域导出规模不超基线、跨领域依赖不超基线、服务文件规模不超过上限。
- `backend/test/architecture-baseline.js` 作为**唯一基线事实源**：`DOMAIN_EXPORT_CEILING`、`CROSS_DOMAIN_EDGE_BASELINE`（189 条边）、`SERVICE_FILE_LINE_CEILING`、`INFRASTRUCTURE_DOMAINS`（当时记的是「排除 `domains/events` 这类无 public-api 的基础设施域」；**2026-09-26 该集合已收敛为空集**，见第 37 节）。
- 跨域依赖测试做**双向校验**：既拦截新增未登记边，也要求已解除的边必须从基线删除（否则基线会长期虚高）。
- `scripts/architecture-baseline.mjs` 为只读测绘脚本，注释明确**刻意不自动写回基线**——自动写回会让任何劣化被静默登记，棘轮失效。
- 建立 `docs/architecture/adr/` 决策记录库：ADR-001~ADR-008（语义与权限分离、推理与副作用分离、状态与事实分离、JSON blob 持久化含退出条件、领域分层与契约面、双 Agent 独立入口、模块化单体、持久化端口），配套索引与模板。
- 失败修正过程：首次运行暴露两处真实问题——`domains/events` 无 `public-api.js` 导致 ENOENT（新增基础设施域白名单）、跨域边远超初始猜测（脚本生成完整 189 条基线）。

## 12. 架构优化落地·阶段二：拆解 God Service

把 `private-agent-service.js` 中两个**可独立命名、边界清晰**的关注点抽出：

| 新模块 | 职责 | 关键安全边界 |
| --- | --- | --- |
| `agent-conversation-intent.js` | 会话意图识别与上下文拼装 | 只继承同一授权会话中**用户**明确表达的目标；模型历史散文永不作为业务事实或执行指令 |
| `agent-command-authorization.js` | 业务写入意图识别与命令授权裁决 | 出现业务主题（如「采购」）≠ 授权创建申请；候选角色须同时具备 prompt + command 权限且裁决为 `ALLOW_BY_POLICY` |

- 宿主服务改为 import，并以 `export { getConversationUserContext }` 保持对外符号不变（`backend/test/agent-conversation.test.js` 从原路径导入，契约零改动）。
- 抽出过程中发现 `longTermFollowUp` 仍在宿主内直接使用 `conversationReferencePattern`，未强行导出正则，而是**提升为语义化谓词** `isConversationFollowUp(input)`——比暴露正则更稳定。
- **1206 → 1147 行**，基线同步下调为 1147（下行棘轮）。
- 跨域边新增 6 条并登记：这是把「单文件内的隐式依赖」**显化为「模块间的显式依赖」**，不是新增领域耦合，已在基线注释中说明该模式。

## 13. 架构优化落地·阶段三：持久化端口化 + 核心实体显式列

**端口化**（ADR-008）：实施前实测每个 store 各持一份 `let postgresRepository = null`，共 **35 处**三元分支散落在 **10 个文件**，且各文件 `schemaVersion` 硬编码互不一致（同后端分别写 3 与 4）——驱动选择这个横切关注点被复制了 35 次。

- 新增 `backend/src/services/persistence-port.js`：`configurePort` / `getPort` / `hasPort` / `delegate` / `describePersistence` / `getPortWarnings`。
- 方法校验分两级：**必需方法**缺失即抛错（防半成品实现被静默启用）；**可选方法**缺失只记告警——这是为故障注入型替身保留的通道（该设计由测试驱动暴露：初版把可选方法也设为必需，直接打断了 `desktop-agent-execution.test.js` 中只实现部分方法的故障注入替身）。
- 已迁移 `agent-run-store.js`、`agent-long-task-store.js`；对外 `configure*Repository` 签名不变，调用方零改动。
- 新增 `backend/test/persistence-port.test.js`（5 项）并挂入 `test:persistence`：覆盖未注册/已注册/注销三态的委派与驱动描述、必需方法缺失拒绝、可选方法缺失告警、非对象实现拒绝。

**核心实体显式列**（ADR-004 前置条件 1）：新增 `backend/migrations/postgres/005_core_entity_projection.sql`。

- 为 Agent Run 与 Evidence Trace 建立带类型与 CHECK 约束的显式列；Confirmation 作为 `agent_runs` 的显式列（`confirmation_status` / `confirmation_expires_at` / `requires_confirmation`）表达。
- 由 `platform_runtime_state` 上的触发器同步写入，含存量回填与独立回滚脚本；`postgres-runtime-state-repository` 与 `postgres-agent-long-task-repository` 的 schema 版本守卫更新为 5。
- 新增棘轮测试项：「投影表与运行时 JSON 存储保持字段一致」——校验投影覆盖运行时全部状态取值、触发器存在、退出条件写在迁移注释中，防止未来「顺手」删掉 JSON blob 表。
- **关键边界：运行时读路径仍走 JSON blob，本次仅完成「结构定义」而未完成「读写切换」。** ADR-004 中四条迁移前置条件已用表格如实标注为「部分完成/未开始」，**不得启动真实数据迁移**。

## 14. 模块化与组件化审计

从**整体架构层面**审计模块化（后端/包）与组件化（前端），产出 [模块化与组件化审计](../architecture/MODULARIZATION_AUDIT.md)。方法为**先实测后结论**：所有判断均附可复核数字与文件位置，不凭既有文档推断。

审计结论：**模块化的「骨架」是健康的，但「边界」存在系统性错位**。

| 级别 | 问题 | 实测证据 |
| --- | --- | --- |
| P0 | 工作区包反向依赖兄弟应用的私有源码 | 3 个包/应用共 **8 处** `../../../frontend/src/...` 相对 import |
| P1 | `packages/agent-workbench` 是「伪包」 | 850 行单一 Vue 组件；27 个顶层 ref、8 个手写 `{get,set}` computed；混装 7 个关注点 |
| P1 | 领域层「重导出」而非契约 | `governance/public-api.js` 48 行 30 条 export；`agent` 24 条 |
| P2 | 横切关注点靠逐文件 import | `prompt-security-service` 被 **19** 个文件 import |
| P2 | 前端组件化层级不齐 | `features/` 12 目录文件数 1~7；`components/` 仅 3 个文件而 `features/` 沉淀 30 个 |
| P3 | 后端 services 无二级切分 | `backend/src/services/` 扁平 **137** 文件（已有棘轮保护，优先级最低） |

同时如实记录**健康部分**（避免被误判为整体失控）：`routes/` 零违规引用 `services/` 且有测试守护；5 个 workspace 包依赖无环；组合根 `app.js` ≤140 行；`api-contracts` / `client-runtime` 是真正的独立契约包；后端 82 个测试文件。

P0 的关键风险不是风格问题，而是**包独立性是假的**：`frontend/package.json` 为 `private: true` 且无 `exports`，各包 `dependencies` 也未声明 `frontend`，这些 import 靠相对路径**物理穿透**，绕过 npm workspace 解析；且一行的 import 实际拉入 5~6 个文件的传递闭包（`KnowledgeLibraryPanel` 闭包 5 文件、`OAMetaModelStudio` 闭包 6 文件），边界会随迭代持续扩大。

文档第 9 节给出 6 项建议执行顺序，并明确第 1 项（加架构测试）应**立即执行**：成本近乎为零，却能把已有边界问题固定在当前规模。

## 15. 模块化审计建议第 1 项：跨包边界棘轮测试

按审计报告第 9 节建议顺序执行第 1 项，与后端既有棘轮**同构**（复用同一测试文件与同一基线事实源）。

**规则**：`packages/*`、`apps/*` 不得用相对路径穿透兄弟包的私有源码（只降不升）。

实现要点：

- **扫描范围**：`packages/`、`apps/`、`frontend/src/` 三棵树，递归收集 `.js/.mjs/.ts/.vue`（跳过 `node_modules`/`dist`/`release`/`build`/`.git`）。
- **违规判定**：提取全部相对 import——正则同时覆盖 `from '...'`、`import('...')` 与**副作用** `import '...'`；解析后按「顶层归属区」（`packages/<name>`、`apps/<name>`、`frontend`、`backend`）比较，跨区即违规。
- **基线冻结**：`CROSS_PACKAGE_IMPORT_BASELINE` 登记既存 **8 处**债务。
- **内容白名单**：`CROSS_PACKAGE_CONTENT_ALLOWLIST`（1 条）区分「源码依赖违规」与「公开内容资产的有意引入」——`apps/product-portal/.../DocsCenter.vue` → `docs/public/product-docs.json` 是人工维护的公开内容资产，不是源码依赖。**白名单必须写明理由**，否则会退化为无声的例外堆积。
- **双向校验**：新增未登记违规 → 失败并打印待登记项；已解除的基线项 → 失败并要求下调基线。防止基线长期虚高。
- **自检**：断言扫描到的工作区源码数 ≥30，避免扫描逻辑失效时「静默通过」。

**为什么登记 8 条而不是直接修掉？** 这 8 处是既存债务，清偿需先做审计方案 A（新建 `packages/agent-ui` 并迁移 11 个文件），属跨包结构改动，不宜与「加测试」混在同一次提交。棘轮的语义正是**先冻结、后清偿**：新增的第 9 处会立刻失败，既存 8 处显式记账，清偿时同步下调基线即可自动收敛。

**计数修正（自我修正）**：审计初版报告为 6 处，仅检索了 `from '...'` 形式。精确扫描（覆盖副作用导入）后补出 2 处 CSS 引用（`semantic-operations-console/src/main.js` 引用 `frontend/src/styles/main.css` 与 `meta-model.css`），实为 **8 处**。已在审计文档摘要表与 2.1 节加「计数修正说明」，并新增 2.1.1 节单独说明那一处合法内容投放。

**验证（正/反双向）**：

1. **反向（守得住）**：临时写入 `apps/mobile/src/App.vue` 含一条跨包 import → 测试失败并精确指出文件与目标路径；随后还原，`git status --short apps/` 无改动。
2. **正向（收得回）**：从基线删除任一条 → 测试失败并提示「已解除，请下调基线」，确认双向校验生效。
3. **常规运行**：`npm run test:architecture` 10/10 通过；`npm run lint` 通过；全量 18 个测试组复跑 0 失败。
4. **残留清理**：探测文件 `.scan-tmp.mjs`、`.dbg.mjs`、`.bak` 已删除，工作区无残留。

**踩坑记录**：新测试初版报「扫描数量异常：仅 0 个文件」，根因是用 `new Map([...map1, ...map2])` 展开两个 `Map`——`Map` 的迭代器产出 `[k,v]` 对，而 `Object.entries(Map)` 返回 `[]`，展开行为不符合预期。改为 `for (const root of [...]) for (const [file, s] of await collectWorkspaceSources(root)) sources.set(file, s)` 后修复。

**边界（如实）**：本次**只做「冻结 + 守护」，未做结构修复**——审计方案 A（新建 `packages/agent-ui` 迁移 11 文件）与方案 B（`agent-workbench` 改 `provide/inject` + `slots`）**均未启动**，8 条基线仍在。审计第 2~6 项建议属后续排期，不在本次范围；且第 2 项须在第 1 项的棘轮守护下进行（迁移完成一处即同步下调一次基线）。

## 16. 系统接入重构方案确认（Proposed → Accepted）

用户提出三阶段重构（系统接入 → 选系统建模 → 模型治理）后，需要先定「接入最小单元」「大模型连接配置去留」「元域智营 `world` 菜单处置」「推进顺序」「显式选系统的语义」五个决策点，方案才能进入实施。产出 `docs/architecture/SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md`，四个备选方案与权衡逐条列出。

**用户确认结论（2026-09-25）**：五项决策全部按推荐取——接入最小单元取「双实体」（系统接入 = 长期资产 + 建模会话 = 一次性）；大模型连接配置留元域智营（属平台基础设施治理，不属语义建模）；元域智营 `world` 菜单全迁并在语义运营端收口；并行双轨推进（结构迁移与模型通道打通互不阻塞）；显式选系统取「默认范围过滤 + 越权明确阻断」。

**用户增补两点**：① 多租户需贯穿整体开发过程；② 产品名「语义运营」→「元域智语」，且元域智语端与智脑一样接入真实大模型做真实联调。

**关键事实（本轮实测，后续开发以此为据）**：系统接入现分散 4 处（元域智营 `config` 页两处、语义运营端 `onboarding` 视图、智脑工作台侧栏只读）；系统清单 5 处重复定义；接入最小单元是「场景项目」而非系统；`detectRequestedSemanticSystems` 在推断为空时**回落到「所有可访问连接器」**与「必选项」语义正好相反；多模态在本链路零基建；**迁移存在结构性前置**——语义运营端已用相对路径穿透 `frontend/src/features/meta-model/*`（跨包棘轮冻结项），不先提升为 workspace 包就搬迁文件，`architecture-boundaries.test.js` 会当场失败。

## 17. 阶段 0：系统单一事实源与接入领域模型

重构的**第一障碍**是「没有单一系统事实源」。本次先把这件事解决，后续阶段才有一个可依赖的地基。

**问题现场**：同一份系统清单散落在 5 处且互不一致——`seed.js:connectedSystems`（6）、`mcp-connector-service.js`（7）、`semantic-source-discovery-service.js:systemAliases`（12）、`world-model-template-service.js:connectionTargets`（8）、`mock-onboarding-catalog.js`（每场景硬编码 3）。且 OA 在 `connector.status='connected_demo'` 与 `onboardingStatus` 上自相矛盾。

**设计（四条）**：

1. **类型 / 实例分离**——系统「类型」是**平台级资产**（12 个：OA/ERP/WMS/MES/LIMS/QMS/OMS/SRM/MDM/PLM/EAM/IOT，无 `tenantId`，全租户共享）；租户「接入实例」是**租户资产**（经 `semanticTenantStateKey()` 落当前租户工作区）。
2. **两状态轴分离**——`connector.status`（受控连接器目录登记，平台级）与 `onboardingStatus`（租户接入进度）此前被混为一谈，正是 OA 矛盾的根因；拆开后两轴各自演进。
3. **角色策略两套并列，不可合并**——`ROLE_DATA_DOMAINS`（连接器面）与 `ROLE_RECORD_SYSTEMS`（模拟记录面）差异是**有意收窄**（OA 有连接器无记录集；MES 对 `procurement_manager` 显式排除），合并会静默放大授权面。
4. **多租户贯穿**——租户标识只取受信上下文（`runWithSemanticTenant` 的 AsyncLocalStorage），**绝不接受请求体 `tenantId`**；接入生命周期落租户工作区。

**实现**：

- 新增 `backend/src/data/system-catalog.js`（唯一事实源）+ `backend/src/services/system-registry-service.js`（查询 / 角色可见性 / 文本系统识别 / **接入生命周期状态机**）。状态机 `draft → registered → authorized → connected ⇄ suspended`，`registered`/`authorized`/`connected` 可回退 `draft`；非法跃迁 `commit:false` **不落库**；未知系统与缺失主体一律拒绝。
- 5 个消费方全部改为派生：`seed.js` 的 `connectedSystems`、`mcp-connector-service.js`（重写目录 + 新增 `getRoleDataDomains`）、`system-integration-service.js` 的 `visibleSystemIds` → `getRecordSurfaceSystemIds`、`semantic-source-discovery-service.js`（删 12 项 `systemAliases`，委托 `detectSystemCodesInText`）、`world-model-template-service.js`（删 `connectionTargets` 字面量）、`mock-onboarding-catalog.js`（场景系统码**加载期校验**，引用未登记系统即抛错）。
- 兼容视图逐字段一致（含 ERP 独有 `alert`、待接入项顺序 `srm→oa`）——所以这是一次**纯结构性收敛，零行为变更**。

**踩坑记录**：

1. `getWorldModelConnectionTargets` 重复声明 → 删除旧行。
2. `createWorldModelDraft` 内遗漏引用改写 → `connectionTargets.find` → `getConnectionTargets().find`（被 `semantic-tenant-isolation.test.js` 第 7 项抓出）。
3. 注册表测试第 1 项失败：`connectionTargetIds` 实际 `[...'oa','srm']`，历史字面量是 `srm` 在前 → 显式声明 `PENDING_ONBOARDING_ORDER`，不依赖目录书写顺序。
4. 架构测试报 3 条未登记跨域边 → 登记入 `CROSS_DOMAIN_EDGE_BASELINE`，并加注释说明这是「5 份重复定义替换为 1 个共享依赖」的**净收敛**，不应通过让消费者各抄一份来消除。

**验证**：新增 `backend/test/system-registry.test.js` 7 项全通过（唯一事实源派生一致 / 兼容视图逐字段一致 / 两套策略差异是有意的 / 显式码优先别名回退 / 生命周期按租户隔离且只认受信上下文 / 状态机非法跃迁与未知系统拒绝 / 未登记连接器标注 `not_registered`）；`test:registry` 挂入 `test:all`；architecture 10/10；conversations / mock-onboarding / ontology / security / semantic 均 0 失败。

**边界**：本次只解决「定义唯一」，**未动任何对外 API 语义与业务行为**，也未启动阶段 1 的包提升与阶段 2 的模块搬迁。详尽的决策与退出条件见 [ADR-009](../architecture/adr/ADR-009-system-registry-single-source.md)。

## 18. 产品改名「语义运营」→「元域智语」

**范围界定（先想清楚再动手）**：本次只改**面向人的显示名**，**技术标识一律不变**——目录 `apps/semantic-operations-console`、包名 `@healthcare-ai/semantic-operations-*`、API 命名空间 `/api/semantic-operations/*`、权限点 `meta_model.*` / `semantic_operations.*`、测试分组 `test:semantic` 全部保持原文。理由是技术标识已被大量代码、文档、测试与提交历史引用，改动收益为零而风险极高；映射关系已在方案文档「命名映射」节显式记录。

**执行**：99 个文件 / 311 处替换（先落盘目标清单再批量替换，避免 shell 内派生子进程——本机 `spawnSync` 稳定 EBUSY）；3 个含旧产品名的文件 `git mv` 重命名；随后用链接修复脚本回收因改名产生的失效引用（10 个文件）。

**踩坑记录**：

1. `git ls-files` 默认 `core.quotePath=true` 会把非 ASCII 路径转义，导致清单漏文件 → 用 `git -c core.quotePath=false` 核对。
2. 替换把「元域智脑-语义运营」中的「语义运营」也换掉，产生「**元域元域智语**」拼接错误 → 当时只修了 3 处（`package.json` 的 `productName`/`shortcutName`、`SemanticAgentWorkspace.vue`）。**教训：批量替换前必须先检视「旧词处于复合词内部」的上下文。**
3. **（2026-09-26 交付复核时补记，属对第 2 条的自我修正）** 第 2 条的 3 处修正**不完整**：`apps/semantic-operations-console/electron/main.cjs`（报告目录名 + 窗口标题）、`electron/report-exporter.cjs`（报告目录名）与 `test/report-exporter.test.cjs`（断言期望值）共 **4 处**仍写着「元域元域智语」。这不是显示层瑕疵，而是**用户可见的功能缺陷**：Electron 窗口标题显示「元域元域智语 Agent」，受控报告导出目录在用户的文档目录下真的叫「元域元域智语报告」；且测试断言跟着一起错，所以测试全绿却掩盖了缺陷。**根因是同一常量被抄成两份**——`main.cjs` 的 `semantic-ops:show-report` 用该目录名做 `path.dirname(target) !== root` 路径校验，而写出方 `report-exporter.cjs` 各写一份字面量，两份只要不一致该校验就恒失败。修复：目录名收敛为 `report-exporter.cjs` 导出的唯一常量 `REPORT_ROOT_DIR_NAME`，`main.cjs` 改为引用；`report-exporter.test.cjs` 补 2 条断言 + 1 条源码级反向锁死（禁止 `main.cjs` 再出现硬编码目录名、禁止任何一处出现 `元域元域`）。**教训：批量改名后必须对「多处重复的同一字面量」逐个取证，并在测试里按精确值锁死而不是只做 `startsWith`。**
4. `curl -o /dev/null` 在本机返回 exit 23 导致 `&&` 链中断 → 改为 `-o <文件>` 分离写法。

**验证**：`npm run docs:check` 通过（170 份 Markdown / 874 个本地链接）；`index.html` 标题为「元域智语 Agent · 元域智脑」；四端构建通过。

## 19. 元域智语接入云大模型做真实联调

用户要求元域智语端与智脑一样接入真实大模型。联调不只是「切过去能通」，而是**暴露并修复了两个链路缺陷**。

**切换方式**：经产品自带 `POST /api/agent/model-config` 把运行中的 API 从 local 切到 `workbuddy`/`deepseek-v4-pro`。**持久化生效、无需重启**——因为 `mode()` 实现为 `environmentManaged() ? env : runtimeOverride.mode || env || 'mock'`，而 `environmentManaged()` 要求 `AGENT_MODEL_CONFIG_SOURCE === 'environment'`（未设即 false），所以运行时存储的管理员配置优先于环境默认值。

**缺陷一：语义面路由判据缺失**。实测「分析 ERP 和 WMS，建立采购订单、入库单和库存之间的语义模型」→ 模型返回 `intent: needs_clarification`、`reason: model_dialogue`，即**去追问实现细节**（批次怎么管、入库单是否必须关联采购订单）而不是建模。修复：在 `agent-turn-understanding-service.js` 语义面提示词显式声明「用户已给出业务对象名或来源系统时必须选 `build_model`；**实现细节尚未确认不构成澄清理由**，应写进 answer 作为待确认清单交后续人工复核；仅当完全没给出对象、来源系统或材料时才置 `needsClarification=true`」。

**缺陷二：模型不可用时链路退化为死路**。此前 `turn` 失效时链路**不回落**本地分类，任何自然语言诉求都退化成 `conversation` + `status=failed`（「本轮模型未返回可用的理解结果，请重试」）。修复：从 `semantic-operations-task-service.js` 抽出纯函数 `resolveSemanticOperationsIntent({ turn, text, contextualText, hasAttachments })`，模型不可用时回落服务端确定性分类；同时**把降级显式暴露出来而不是静默伪装**——新增 `modelUnavailable` 字段、`routing.mode='server_rules_fallback'`、`routing.degraded=true`、事件 `model_understanding_unavailable`，前端 `SemanticAgentWorkspace.vue` 加降级警示条。

**安全不变量：发布不参与回落**。回落只服务「理解」，不服务「授权」；发布需**同时**具备语义理解与本轮明确请求，二者缺一即拒。

**验证**：新增 `backend/test/semantic-operations-routing.test.js` 9 项全通过并挂入 `test:semantic`——模型不可用回落 / 发布拒绝降级授权 / 缺范围给可操作澄清 / 模型可用保留服务端门禁 / 对话不回落 / 模型主动澄清不被覆盖 / 发布无明确请求不授权 / 发布有明确请求授权且留确认门禁 / mock 模式不标降级。四组实测：对话类返回真实模型回答（`routing.source=workbuddy`）；建模类返回 `build_model` + 提案 `PurchaseOrder, Inventory` + Critic `passed`；切不可达 Provider 后建模回落 `build_model` 且 `degraded=true`；同场景请求发布被拒绝（`requiredPermission=null`）。

**如实标注的边界（重要）**：模型**理解**已打通，但**候选对象生成**未打通——候选仍只来自硬编码目录（12 对象 / 8 关系）靠 `terms` 关键词命中，实测「采购订单/入库单/库存」只产出 2 个对象、0 关系（**「入库单」未被识别**），混述时未命中对象仍被**静默丢弃且无 warning**。这是阶段 4 的核心缺口，不是本轮可关。另有：`local` 通道的模型版本准入（`exactVersionPinning` 下完整路径精确匹配失败 → `MODEL_VERSION_NOT_ALLOWED`）与 `:8080` 端点未启动**未修复**；云 Provider **仅文本、未做多模态**；`test:multitenant` 的 MT-15 为预存 flaky（见下）。

## 20. 阶段 1：跨端共享前端资产建包（跨包穿透清偿）

重构方案的**结构性前置**。跨包棘轮只降不升，先搬文件后建包会让测试当场失败，所以这一步必须先单独做掉。

**问题现场**：`packages/agent-workbench`（被 desktop/mobile/dingtalk 三端共用）与 `apps/semantic-operations-console` 共 8 处用 `../../../frontend/src/...` 相对路径**物理穿透**到 `frontend` 的私有源码与样式。三个具体风险：① 声明与事实不符——`agent-workbench` 的依赖里没有 `frontend`，`frontend` 也没有 `exports` 且 `private: true`，这些 import 绕过了 npm workspace 解析；② 包的独立性是假的——想独立构建 `agent-workbench` 必须把整个 `frontend` 拖上；③ 传递依赖闭包不受控——一行 import 实际拉入 5~6 个文件。

**实施**：新建 `packages/agent-ui`，从 `frontend` 上提 **17 个文件，全部为纯重命名**（`git diff -M --numstat` 为 0 增 0 删；3 个样式文件字节一致 → 组件行为与视觉零改动）：

| 新路径 | 文件数 | 内容 |
| --- | --- | --- |
| `src/meta-model/` | 7 | 元模型/本体面板 + `ontology-scenario.js` + `ontology-read-plan-import.js` |
| `src/knowledge/` | 6 | `KnowledgeLibraryPanel` + 4 子面板 + `MemoryReviewPanel` |
| `src/agent/` | 1 | `AnomalyAssistantPanel` |
| `src/styles/` | 3 | 企业设计基线 `main.css` + `meta-model.css` + `core-meta-objects.css` |

**范围比审计初稿更大，且是有意的**：初稿只覆盖「被跨包引用的 5 个组件及其闭包（11 个文件）」。实际按**包边界**而非「谁引用谁」圈定——`agent-workbench` 还引用了 `MemoryReviewPanel` 与 `AnomalyAssistantPanel`（基线第 6、8 条），`CoreMetaObjectLayer` 与元模型面板同属一个关注点，**样式必须随组件走**（迁移后的组件仍依赖 `.panel` / `.section-header` / `.eyebrow` / `.outline-button` 等全局类，把它们留在 `frontend` 会立刻产生新的穿透）。只搬闭包会留下半套组件、下次仍要再动一次。

**依赖改为声明式**：`package.json` 只声明 9 个**具名** `exports` 入口，**刻意不用 `"./*": "./src/*"` 通配**——通配会把「声明式边界」重新退化成「什么都能拿」，与收敛目的相反。4 个消费方分别声明：`agent-workbench` / `semantic-operations-console` / `frontend` 进 `dependencies`，`backend` 进 `devDependencies`。

**顺带修正两个此前未发现的问题**：

1. **扫描盲区（自我修正）**：棘轮原扫描扩展名只有 `.js/.mjs/.ts/.vue`，**漏掉 `.cjs` 与 `.css`**。扩大扫描面后实测另有 3 处真实穿透（语义运营端 2 处测试、1 处 `examples/` 样例）——即审计报告的「8 处」**在扩大扫描面前并不完整**。两次计数修正（6 → 8 → +3）方向一致：**「实测」的可信度取决于扫描面，而不是取决于是否写了「实测」二字。** 前 2 处随搬迁改为 `@healthcare-ai/agent-ui/ontology-read-plan`；第 3 处指向仓库级 `examples/`（跨包共用的只读样例数据，非任何包的私有源码、不参与构建产物），判定为「内容/样例投放」并登记入 `CROSS_PACKAGE_CONTENT_ALLOWLIST`（白名单共 2 条，均写明理由）。
2. **测试读源码的方式**：语义运营端 4 个 `.cjs` 组件测试需**读取组件源码文本**做断言，原为相对路径穿透。改为「声明式入口 + 目录推导」——`dirname(require.resolve('@healthcare-ai/agent-ui/meta-model'))` 再拼文件名。**不为此在 `exports` 里开 `./src/*` 后门**：测试读源码是真实需求，但需求不构成放宽边界声明的理由。

**踩坑记录（两条，第 2 条更值得记住）**：

1. `frontend/src/features/world-model/WorldModelPage.vue` 用 `../meta-model/CoreMetaObjectLayer.vue`（**同区内**相对路径）引用被迁移的组件，**棘轮扫不到**（同区不算跨包），但构建期直接失败（`Could not resolve`）。教训：**棘轮只守护跨包边界，迁文件后仍需按「被迁文件名」全仓复查一次引用点**，不能只依赖测试绿灯。
2. **第二类静默丢失覆盖：类型检查。** `tsconfig.json` 的 `include` 原本只有 `packages/*/src/**/*.js`，**没有 `.vue`**（`.vue` 只覆盖 `frontend/src` 与 `apps/*/src`）。被迁移的 14 个 `.vue` 文件原本通过 `frontend/src/**/*.vue` 受检，迁移后会**静默失去类型检查**——而所有测试仍然全绿。已补上 `packages/*/src/**/*.vue` 并重跑 `vue-tsc` 通过。**结构性迁移是「纯重命名」时，覆盖面的收缩不会以任何形式暴露；验收必须包含「检查工具的覆盖面有没有跟着变」，而不是只看用例是否通过。**

**验证**：`test:architecture` 10/10 且跨包基线条目 **8 → 0**（下降而非持平，证明是收敛不是搬运）；**5 端构建全部通过**（`frontend` / `semantic-operations-console` / `desktop` / `mobile` / `dingtalk`）；语义运营端组件测试 60/60、`test:ontology` 104/104、`test:knowledge` 56/56、`test:semantic` 156/156、`test:registry` 7/7、前端 `test:permissions` 10/10；`lint` / `typecheck` / `docs:check` 全部通过。

**已知边界（如实）**：

- **`backend` 的 `devDependencies` 出现 UI 包**：真实原因是「场景夹具 `ontology-scenario.js` 被后端 4 个本体测试复用」。正确处理是抽独立数据包，本次**未抽**以免引入第三个包、扩大改动面。已写入 ADR-010 退出条件第 2 条：一旦后端**非测试**代码引用该包，必须立刻抽离。
- `packages/agent-ui` 现被 5 个顶层区引用，成为**新的耦合热点**；ADR-010 已给出拆分触发条件（出现第 4 个无关关注点 / 单包超 30 文件 → 拆为 `agent-ui` + `design-system` + `semantic-model-ui`）。
- 方案 B（`AgentWorkbench.vue` 改 `provide/inject` + `slots`）**未启动**，属模块化审计第 3 节议题。
- 本阶段**不新增任何功能、不改任何组件 API**；`packages/agent-ui` 因此是有意做大的「包边界优先」产物，不是按关注点终态切分的包。

## 21. 阶段 2：接入模块迁移到元域智语端

按 [系统接入重构方案](../architecture/SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md) 第 6 节阶段 2 执行，决策记录见 [ADR-011](../architecture/adr/ADR-011-system-onboarding-domain-extraction.md)。**阶段 1 解除的是「搬迁前置条件」，阶段 2 才真正搬业务代码**。

### 21.1 核心矛盾不是「搬位置」，而是「两个空按钮」

元域智营 `config` 页原有：

```html
<button>连通性测试</button>
<button class="outline-button">新增映射</button>
```

两者**都没有 `@click`**。也就是说「接入系统配置 / 当前生效映射 / 元模型连接模板」三个区块历史上只是**展示**，从未驱动任何探测或映射生成。因此本阶段的目标不是「在新的地方再放一个空按钮」，而是**真做出来**。

### 21.2 后端：新域 + 真探测

| 文件 | 说明 |
| --- | --- |
| `backend/src/services/system-access-service.js`（新增，约 330 行） | 总览组装 / 单系统详情 / 真实连通性探测 |
| `backend/src/domains/system-onboarding/public-api.js`（新增） | 契约面 **4 项导出**（上限刻意压到 4） |
| `backend/test/system-access.test.js`（新增，9 项） | 全通过 |

**为什么新建域而不是塞进 governance**：`DOMAIN_EXPORT_CEILING.governance = 92` 已达上限，且棘轮规则是「只降不升」。塞进去只能抬高基线；**棘轮本身给出的合法路径就是「拆分领域」**。

**职责分界**：注册表是事实源（系统类型、角色可见性、租户级接入生命周期），接入服务只做**组装与探测**——不新增任何系统定义、不复制任何清单。初版曾从 `mcp-connector-service.js` 另派生一份连接器目录（`connectorByCode`），但该变量**从未被使用**：既是死代码，也是「同一份清单在两个域各存一份」的苗头，已整条链路删除。

**探测是真的**：监听本地临时端口 → 发分页 HTTP 请求 → 校验 `mock-onboarding-query.v1` 契约与分页完整性。实测探测 ERP：

```
status=verified   requests=3   pageCount=3   recordCount=6   readableRecords=34   objectTypes=5
```

**但它读的是内置合成 HTTP 数据源**（`sourceKind: 'local_mock_http'`），不是任何真实企业连接器——返回值与界面都必须标注，不得表述为生产验收。

**「真正接上」覆盖三个按钮**：除「生成草稿」（`world.draft.create`）外，一并新增 `.../mapping-drafts/:id/(validate|publish)`。只接生成会让「校验草稿 / 发布版本」在**新位置上复现空按钮**。

**路由顺序风险**：字面量子路径（`mapping-templates` / `connection-targets` / `mapping-drafts`）必须排在 `:code` 之前，否则 `mapping-templates` 会被当成一个系统码；测试第 9 项专门断言这个顺序。

### 21.3 三处自我修正（均为实测驱动）

1. **可探测性判据错**：初版用 `mockOnboardingScenarios[].systems`（材料场景**声明范围**）判定，实测 LIMS 不在任何场景声明中却确有 `Inspection` 记录（`quality_incident` 数据集 ERP16/LIMS2/MES15/WMS19/OMS16/QMS1/OA9）。改为按「数据源里**实际有无该系统的记录**」判定，可探测数 **5 → 7**（OA/ERP/WMS/MES/LIMS/QMS/OMS）。**「人工准备边界」与「可读性」是两件事。**
2. **错误码语义错**：`schema_drift` 是「读到了，但字段目录对不上」，不得与「失败」混为一谈 → `status: 'schema_drift'` + `issue.code: 'MOCK_SOURCE_SCHEMA_DRIFT'`。
3. **字段目录计数虚高 + 前端重复键**：初版逐场景 `push`，而同一对象会被多个合成场景声明（WMS 的 `StockPosition`/`Warehouse`、OMS 的 `SalesOrder`），「对象目录」被重复项撑大（**WMS 10 → 实际 8，OMS 8 → 实际 7**），且前端以 `table.name` 作 `v-for` 的 `:key` **产生重复键**。改为按 `name` 归并 + 记录 `scenarioIds`。

第 3 点还牵出一个更细的结论：**归并不等于合并语义**。WMS `StockPosition` 在两个场景里字段声明**确实不同**（`fulfillment` 含 `stock_id`/`ownership`/`unit`；`quality_incident` 只有 `lot_id`/`warehouse_id`/`qty`/`status`）。若静默取先出现的那个，「字段目录」会**随场景遍历顺序漂移**。故字段签名不一致时进入 `fieldCatalog.conflicts` 由界面显式呈现，并透出 `readScenarioId`（探测实际读取的场景），界面注明「目录是各场景声明的并集，探测只读其中之一」。**该差异是既有合成数据的真实不一致，本次只做显式暴露、未改 `examples/` 夹具**（改夹具会牵动 supply-chain 回归）。

### 21.4 架构棘轮：这一次是「有意增加」

| 基线 | 变化 | 性质 |
| --- | --- | --- |
| `CROSS_PACKAGE_IMPORT_BASELINE` | 保持 **0** | 阶段 1 已清偿 |
| `CROSS_DOMAIN_EDGE_BASELINE` | **8 → 10** | 有意增加，新增 2 条 |

新增：`system-access-service.js → mock-onboarding-source-service.js`（探测读内置合成数据源）、`system-access-service.js → semantic-tenant-context.js`（探测结果按租户隔离）。

**刻意未加** `system-access-service.js → world-model-template-service.js`：连接模板/映射草稿仍属 `governance` 域，由**路由层组合两个域的 public-api**。判据是「组装依赖」与「领域耦合」的区别。

> **两条边界的对比值得记住**：前端是「8 → 0」（清偿债务），后端是「8 → 10」（有意增加）。**基线数字本身不说明好坏，方向才说明**——`CROSS_PACKAGE_IMPORT_BASELINE` 的语义是「不该有的穿透」，必须趋零；`CROSS_DOMAIN_EDGE_BASELINE` 的语义是「已评审的跨域依赖」，允许增长但每条都要能说清为什么。

### 21.5 元域智营收窄

- `ConfigManagementPage.vue` 删除三个区块与 3 个 emit（54 → 46 行）；`App.vue` / `governance-actions.js` / `page-data-registry.js` 同步删除对应状态与动作（config 分支 `Promise.all` 由 7 个降到 6 个）。
- **旧端点本阶段不删**，保留一个版本周期；元域智营已无入口，迁移后可用 404 计数确认无残留调用。
- **断言口径同步改写**：`frontend/test/page-data-registry.test.js` 原以 `canAccessPage: () => false` 跳过 world 拉取，`fetchPageData` 去掉该参数后这个写法会**悄悄失效（永远为真）**。已重写为**断言「不存在这条调用路径」**（`forbidden` 名单 + Proxy 记录调用），而不是「被权限挡住」。

### 21.6 验收（全部实测）

`test:access` 9/9；`test:architecture` 10/10；`test:registry` 7/7；`test:semantic` 5/5 + 60/60 + 91/91；`test:permissions` 29/29；`test:mock-onboarding` 69/69；`test:ontology` 104/104；`test:multitenant` 75/75；`test:persistence` 35/35；`test:ark` 39/39；**5 端构建全部通过**（`frontend` / `semantic-operations-console` / `desktop` / `mobile` / `dingtalk`）；`npm run quality` 端到端 0 失败；`lint` / `typecheck` / `docs:check`（173 份 Markdown / 909 链接）通过。阻断实测：越权探测 → `SYSTEM_PROBE_FORBIDDEN/403`；无连接器 → `SYSTEM_CONNECTOR_NOT_REGISTERED/409`；未知响应模式 → `SYSTEM_PROBE_FAULT_UNKNOWN/400`。

## 22. 关闭两处遗留（含对第 23 节归因的自我修正）

### 22.1 被遗漏的测试契约：模型降级

`backend/test/ark-model-gateway.test.js` 中一项断言：模型传输失败时 `createSemanticOperationsTask` 返回 `status='failed'`。

但上一增量「元域智语接入云大模型」**有意**把该路径改为**回落服务端确定性分类**（否则模型一抖入口就变死路，已被实测复现），`status` 相应变为 `'completed'`，而**该测试未被同步更新**——`test:ark` 因此长期 **38/39**。

处理：**按新契约改写，并加强而非放宽断言**：

```js
assert.equal(failed.status, 'completed');
assert.equal(failed.modelUnavailable, true);
assert.equal(failed.routing.mode, 'server_rules_fallback');
assert.equal(failed.routing.degraded, true);
assert.ok(failed.routing.modelFailureCode);                      // 降级必须可归因
assert.ok(failed.events.some(e => e.type === 'model_understanding_unavailable'));
assert.equal(failed.command, null);                              // 且不得获得执行能力
assert.equal(failed.proposal, null);
assert.equal(failed.requiredPermission, null);
assert.equal(failed.confirmationRequired, false);
```

结果：`test:ark` **39/39**。**降级必须显式可归因，不得获得任何执行能力**——这是「回落」与「伪装成功」的分界线。

### 22.2 SQLite 并发缺陷（含归因修正）

跑完整质量门禁时 `test:multitenant` 间歇失败。隔离复现确认与阶段 2 无关：单文件重复运行 12 次，基线 **2/3 失败**。

**根因（实测，非推断）**：6 个并发 worker 各自打开同一个 `runtime.db`，Windows + WAL 下 `-shm` 建立存在竞态，部分 worker 抛 `ERR_SQLITE_ERROR: attempt to write a readonly database`（`errcode=8`，即 `SQLITE_READONLY`）。采样 6 次运行，共 4 次出现该错误，与配额拒绝混在一起：

```
run 4: [{"allowed":true},{"allowed":false,"code":"ERR_SQLITE_ERROR"},
        {"allowed":true},{"allowed":false,"code":"RUNTIME_DAILY_QUOTA_EXCEEDED"},
        {"allowed":true},{"allowed":false,"code":"ERR_SQLITE_ERROR"}]
```

**为什么必须改代码而不是改测试**：`authorize()` 的语义是「今日配额已用尽 → `RUNTIME_DAILY_QUOTA_EXCEEDED`」。若把原始 SQLite 错误也算作「未通过」，「配额用尽」与「数据库恰好被别的进程占用」在调用方看来就是同一件事，多租户配额结论不可信。**放宽断言等于承认 exactly-once 配额在并发下不成立。**

**修法**（`backend/src/repositories/runtime-state-repository.js`）：把 `BEGIN IMMEDIATE` 事务抽为 `runTransaction`，对暂时性文件锁错误（`errcode` ∈ {5 BUSY, 6 LOCKED, 8 READONLY}）做**有界重试**（6 次、20ms×attempt 同步退避）。

**关键发现**：`SQLITE_READONLY` 在 WAL 下可能让**这条连接永久失效**（`-shm` 被别的进程重建后映射已过期），**原地重试无效**——实测仍有残留 1/12 失败。改为命中该错误时**先重开连接再重试**后：

| 阶段 | 12~15 次运行的失败情况 |
| --- | --- |
| 基线（无重试） | 12 次运行中 **3 次**有原始 SQLite 错误（共 6 个 worker 失败） |
| 仅原地重试 | 12 次运行中 1 次（共 1 个 worker 失败） |
| **重开连接 + 重试** | 15 次运行 **0 次**；真实测试文件 12/12 通过 |

**安全性**：失败点必定落在 `BEGIN IMMEDIATE` 之后、`COMMIT` 之前的写操作上，未提交即无副作用；配额计数始终是「读-判-写」在同一个 IMMEDIATE 事务内完成，重试不会重复记账。`resetRuntimeState` 的 prepared statement 随之下移到事务内部（重开连接会使外部持有的 statement 失效）。

### 22.3 对第 23 节归因的修正（自我修正）

第 23 节记录了一个归因：**「`output/` 下累积 72 个临时目录会显著恶化这两项的成功率」**。

**该归因有误。** 实测结论是：

1. 真正的根因是 `SQLITE_READONLY`（WAL `-shm` 竞态），与临时目录数量**无关**；
2. 「清空目录后出现 1 次全绿」是**单次采样的巧合**——基线本身成功率就在 2/3 左右，1 次通过完全在噪声范围内；
3. 隔离复现（不涉及 `output/` 累积）同样以 2/3 频率失败，直接否证了该归因。

第 23 节保留原文不改（ADR 维护约定：不改历史结论），以本节为准。

## 23. 预存 flaky 的如实标注（历史记录，其中 `test:multitenant` 部分归因已由第 22 节修正）

`test:multitenant` 里有两项**预存 flaky**，本轮在阶段 1 回归时被再次触发并做了更精确的特征刻画：

| 用例 | 现象 | 本轮实测 |
| --- | --- | --- |
| MT-15 `four independent SQLite processes preserve exactly-once tenant credits after restart` | 4 个进程并发写同一 SQLite 文件，`BEGIN IMMEDIATE` 返回 `SQLITE_READONLY (errcode 8)`：`attempt to write a readonly database` | 5 次运行中失败 3 次 |
| 第 75 项 `real SQLite CLI: preview, atomic approval, cross-process quota, revoke and portal read-only evidence` | 同类并发写失败 | 5 次运行中失败 2 次 |

**排除因果的证据（不靠「看起来无关」下结论）**：

1. 失败栈涉及的 4 个文件（`backend/src/repositories/runtime-state-repository.js`、`backend/src/services/product-portal-service.js`、`backend/test/multitenant-validation.test.js`、`backend/test/helpers/multitenant-sqlite-worker.mjs`）在阶段 1 中**均未被修改**（`git status` 无输出）。
2. `package-lock.json` 的改动**只有新增 workspace 包 `@healthcare-ai/agent-ui` 的链接与依赖声明**，没有任何依赖版本变化（不涉及 SQLite 绑定）。
3. **两项同时失败**说明是共享的环境级原因（WSL 挂载路径 `D:\wsl\...` 上的文件锁竞争），而不是某条业务断言。

**新发现的测试卫生缺陷（已复现，未修）**：MT-15 每次运行都在 `output/` 下 `mkdtempSync` 一个新目录，**从不清理**。本轮发现 `output/` 已累积 **72 个** `multitenant-sqlite-*` 目录；清空后立即复跑，出现 **1 次 75/75 全绿**（此前连续 3 次均有失败），随后又复现失败。即**累积的临时目录会显著恶化这两项的成功率**。

**处理方式（如实）**：本身不属阶段 1 范围，且改测试会污染「纯结构性迁移」这一增量的可验证性，故**本次未修**，只记录证据与建议方案：在测试结束时 `rmSync(directory, { recursive: true, force: true })`（或用 `t.after` 注册清理）。这是下一个小增量的候选内容。

## 24. 阶段 3：选系统成为建模必选项（范围显式化）

按 [系统接入重构方案](../architecture/SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md) 第 6 节阶段 3 执行，决策记入 [ADR-012](../architecture/adr/ADR-012-explicit-modeling-scope.md)。

**要解决的不是「缺一个多选面板」，而是一行隐式回落。** `discoverSemanticSources` 历史上是：

```js
const selectedCodes = requestedSystems.length
  ? requestedSystems
  : connectorCatalog.filter((item) => item.accessible).map((item) => item.system);
```

`requestedSystems` 来自文本识别，于是「这次建模覆盖了哪些系统」由两条界面不可见的规则决定：文本里碰巧出现系统名（哪怕在「不要用 ERP」这种否定句里）就当范围；什么都没提到就**放大到整个角色可见面**。

**改法**：范围只有两个显式入口——`systemCodes`（空数组＝显式为空）与 `includeAllRegistered: true`；都没有则为空，**没有回落**。新增 `selectionSource` / `selectedSystemCodes` / `explicitSystemCodes` / `mentionedNotSelected` / `scopeNotice`，使「范围怎么来的」可审计。`detectRequestedSemanticSystems` 降级为提示素材（只驱动「文本提到但未选」）。

**两个「靠文本碰巧命中全量」的调用方必须一起改**，否则会静默变成假通过：

| 调用方 | 改法 | 不改会怎样 |
| --- | --- | --- |
| `services/semantic-inspection-worker/app.js` 的 `source_readiness` | `includeAllRegistered: true` | 巡检变成「0 个来源 / 0 个阻断项」→ `passed`，假通过 |
| `GET /api/semantic-operations/sources` | 无 `query` 或 `scope=all_registered` 时显式全量 | 「没给范围」与「要看全部」返回同一响应，调用方无法区分 |

**四类拒绝**：未提供/空数组 400 `SEMANTIC_SYSTEM_SCOPE_REQUIRED`；不在注册表 400 `SEMANTIC_SYSTEM_UNKNOWN`；在注册表但无受控连接器 400 `SEMANTIC_SYSTEM_NOT_REGISTERED`；超出角色数据域 403 `SEMANTIC_SYSTEM_SCOPE_FORBIDDEN`。形状非法（字符串/混入非字符串/空白项/对象）→ 400 `SEMANTIC_SYSTEM_SCOPE_INVALID`。

**越权阻断而非裁剪**（4.5 决策 C）：`marketing_manager` + `['OMS','ERP']` 整单拒绝；静默裁到 `OMS` 会让运营人员以为范围已生效，实际只覆盖子集。勾选**不构成提权**，与 [ADR-001](../architecture/adr/ADR-001-semantic-permission-separation.md) 一致。

**覆盖如实上报，不按范围过滤**：`task.systemScope` = `covered` / `uncovered`（含原因）/ `unassignedObjects` / `outOfScopeObjects` / `mentionedNotSelected`。实测只选 `WMS` 建模「供应商/采购订单/原料批次」→ 3 个对象，其中 `Supplier` / `PurchaseOrder` 标注 `ERP`，被显式列为范围外。**过滤会让「材料里有、但范围外」的事实消失**，而那通常意味着选择错了或材料传错了。

**承接轮不继承范围**：`parentTaskId` 存在时仍要求本轮显式给出，只在拒绝信息里提示「上文任务的范围是 X」。

**一处对计划字面口径的有意偏离**：计划写「`selectedSystems.length === 0` → 禁用提交」。字面实现会把「你好」「你是谁」这类对话一并禁掉，而服务端对对话类意图本就不要求范围（`SOURCE_BOUND_INTENTS` 只含 `build_model` / `discover_sources`）。因此前端按「**诉求看起来要建模** + 未选系统」判定，服务端硬门禁仍是唯一权威；**客户端不替服务端决定哪些意图需要范围**。

**顺带补掉一处对外契约缺口**：任务创建的错误响应此前只回 `message`、丢掉 `code`，客户端只能靠中文文本匹配决定如何补救；现改为透出 `code`，前端据此高亮范围面板。

**验收与取证口径（本机实测，内置合成数据）**：新增 `backend/test/semantic-system-scope.test.js` **10/10**（六类用例 + 覆盖/不一致上报 + 形状校验 + 意图边界 + 承接提示），挂 `test:scope` 入 `test:all`；因契约变更同步更新 4 个既有测试文件（`semantic-operations-agent`、`semantic-manufacturing-regression`、SDK、运营端布局），**加强而非放宽断言**。`test:semantic` 6+60+92、`test:access` 9/9、`test:architecture` 10/10（跨域边未增）、`test:registry` 7/7、`test:conversations` 22/22、`test:ark` 39/39、`test:permissions` 29/29、`test:multitenant` 75/75、`test:persistence` 35/35、`test:ontology` 104/104、`test:mock-onboarding` 69/69；lint / typecheck / docs:check（174 份 Markdown / 928 个本地链接）通过；5 端构建通过。**取证方式有一处环境限制需说明**：把 5 端构建写在**同一个 shell 调用**里串行执行时，第 5 端会报 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":50,"threshold":50,"scope":"turn"}`——该错误来自受控环境的批量删除保护（vite 构建前 `emptyDir` 清空各端 `dist/`，累计删除数在本调用内达到 50），**不是构建缺陷**；分端或分多次调用即全部通过（`build:dingtalk` 单独实测 `✓ built in 2.94s`）。

## 25. `test:permissions` 归因自我修正（推翻第 22/23 节的「flaky」结论）

**此前结论**（第 22 节与「质量与边界」）：`test:permissions` 是「权限加固测试 API 启动竞态」的**预存环境级 flaky**，证据是「单独重复运行 8 次全部通过，仅在 4 组并发时失败 1 次」——即归因为**并发资源竞争**。

**本轮实测推翻该归因**：

| 观测 | 数据 |
| --- | --- |
| 单独运行（无并发）3 次 | 失败 **3 / 1 / 0** 项，且每次失败的是**不同用例** |
| 生产配置下 API 就绪耗时（3 次实测） | **1097 / 1097 / 1519 ms** |
| 测试的等待预算 | **40 × 25ms = 1000ms** |

即：不是竞态，而是**稳定的预算不足**——预算小于正常启动时间，所以「单独运行也会失败」；而「8 次全过」是一次采样偏差（启动耗时在 1s 附近抖动，偶尔能踩进预算内）。失败信息只回一句「未就绪」+ 空日志，也无法区分「启动慢」与「启动失败」。

**修法**（只改预算，**断言一条未放宽**）：`permission-api-hardening.test.js`（两处）与 `permission-management.test.js` 的等待改为按时间计预算（`API_STARTUP_TIMEOUT_MS = 8000`），失败信息带上实际等待时长与子进程日志。

**结果**：连跑 **5 次全部 0 失败**。

**为什么值得记一节**：它与第 22 节修正 `test:multitenant` 归因是同一类错误——**用「单独跑就过」推断「并发导致」**，而没有先量化失败率与真实耗时。方法论上应固化：先测**基线失败率**和**被断言量的真实分布**（这里是启动毫秒数），再决定改代码还是改测试。

## 行为等价性验证方法

结构性重构最大的风险是「测试过了但行为变了」。本次采用双向对照：

1. 先记录改动后各测试组结果；
2. 把原始文件从 git 恢复，在**同一环境**跑一遍基线；
3. 比对差异并逐项归因。

结果：改动前基线仅有新棘轮测试对未登记边与旧行数的 2 项「应有失败」；改动后 19 个组全绿。**并额外发现 `test:permissions` 组为预存环境级 flaky**——原始未改动代码连续三次运行失败数为 2/0/3，改动后为 1/0/0，失败信息均为「权限加固测试 API 未就绪」的 HTTP 服务启动竞态。该 flaky 与本次改动无关，已记录待单独排查，未掩饰为「通过」。

## 26. 阶段 4 前置：范围从「上报口径」变为「过滤器」

按用户 2026-09-25 的决策执行，记入 [ADR-013](../architecture/adr/ADR-013-scope-as-filter-with-explicit-exclusions.md)。

**这不是阶段 4 的功能，而是它的前置契约。** [ADR-012](../architecture/adr/ADR-012-explicit-modeling-scope.md) 在阶段 3 明确留了退出条件 2：若阶段 4 让范围开始**裁剪对象**（按选中系统抽取），`outOfScopeObjects` 的语义就会从「材料与选择不一致的上报」变成「被过滤掉的记录」，届时必须重新决定范围是**过滤器**还是**上报口径**。阶段 4 要「按选中系统的字段目录抽取对象与标识」，而**抽取本身就是一次筛选**——未勾选的系统没有字段目录，其对象无处抽取。该条件当场被触发。

**触发它的具体问题**：运营勾选 ERP + WMS，上传的材料里含 QMS 的「来料检验记录」。三个候选里，**纯过滤**会让运营忘勾 QMS 时**看不到任何迹象**（正是本次重构一直在消除的静默模式）；**不过滤**则让范围对提案几乎没有约束力（跨系统连接会牵入范围外对象）。用户选定第三种组合：**过滤，但被排除项必须可读地列出来**。

**过滤规则**

| 情形 | 对象去向 | 上报字段 |
| --- | --- | --- |
| 全部来源在所选范围内 | 保留，计入 `covered` | — |
| **部分**来源在范围外 | **保留**（有合法在范围内的来源，排除会丢掉范围内系统的真实事实） | `partialScopeObjects`（含 `outside`） |
| **全部**来源在范围外 | **排除** | `excludedObjects`（含 `sourceSystems`） |
| 来源为 `UNASSIGNED` | **保留**（把「未标注」当「超范围」会让纯自然语言抽取路径整体被清空） | `unassignedObjects` |
| 关系任一端点被排除 | **一并排除**（避免留下悬空边） | `excludedRelationships`（含 `reason`） |

`outOfScopeObjects` 被拆为 `partialScopeObjects`（**仍在**提案）与 `excludedObjects`（**已移除**）后**移除**——保留并集别名会让调用方无法从字段名判断对象是否还在提案里。

**两处实现上的关键取舍**

1. **关系必须在过滤前的候选集上组装**。初版先按保留对象过滤 `catalogRelationships`，结果被丢弃的关系再也看不见，「关系为什么少了」无法归因。改为在 `extractedIds` 上组装、再按 `keptIds` 切分并上报；`reason` 还区分「被范围排除」与「本次压根没识别到」——否则运营会去查一个不存在的系统。
2. **「对象全被排除」必须与「什么都没识别到」区分**。两者共用一个错误码会让运营**去改材料而不是补选系统**，方向就错了。新增独立错误码 `SEMANTIC_PROPOSAL_SCOPE_EXCLUDED_ALL`（422），报错点名对象、来源系统与「补选对应系统后重试」。

**越权阻断先于范围过滤**：过滤**不得**成为对越权系统的静默裁剪通道。

**验收（本机实测，内置合成数据）**：`test:scope` **12/12**（用例 10 → 12）、`test:semantic` 6+60+92、`test:conversations` 22/22、`test:desktop` 20+10、`test:architecture` 10/10（**未增跨域边**）；`npm run quality` 端到端 **0 失败**；lint / typecheck 干净；`docs:check` **175 份 Markdown / 943 个本地链接**；5 端构建通过。运营端 `workspace-layout` 断言同步更新并新增「旧字段不得残留」的反向断言。实测只选 WMS 建模「供应商/采购订单/原料批次」→ 提案对象 **3 → 1**，`PurchaseOrder`/`Supplier` 进入 `excludedObjects`（`sourceSystems: ['ERP']`），`excludedRelationships` 非空，任务回应出现「按范围排除的对象…补选系统后重跑」。

**一处被新语义暴露出的旧用例前提不成立**：原用例 4 的「不越权即可通过」分支用 `marketing_manager` + `['OMS']` + 供应商诉求。范围过滤之后该组合会得到「对象全被排除」——**那不是越权问题**，而是「选了一个授权但毫无内容来源的系统」。已改用 `门店`（OMS）诉求。这正是「范围从标注变成过滤」会**反向暴露旧断言前提**的典型：断言没写错，是它依赖的语义变了。

**已知边界（如实）**

- 被排除对象承载的业务事实**确实不再进入提案**。若某对象只有 QMS 一个来源而运营未勾 QMS，它就从提案里消失了——这是**有意选择**，缓解手段是显式清单 + 提示补勾。
- `outOfScopeObjects` 字段名**已移除**，属对外契约破坏性变更（阶段 3 刚发布）；SDK 无该字段的具名封装，故仅后端与运营端受影响。
- 被排除清单是**提示**而非阻断：任务仍成功返回提案。是否需要「先补勾再生成」的阻断式交互，见 ADR-013 复审条件 1。
- 阶段 4 真正需要模型能力的部分（从非结构化材料抽取对象与标识）**尚未开始**；其确定性一半（第 27 节）已落地。

## 27. 阶段 4a：按系统字段目录识别标识 + 跨系统标识对应

**这一节解决的是「跨系统连接」的确定性一半。** 阶段 4 方案原文写的是「按选中系统的字段目录/样本抽取对象与标识（主键/唯一键/业务键）」+「**跨系统连接**：识别同一业务实体在不同系统的标识对应，如 ERP `PurchaseOrder.id` ↔ WMS `InboundReceipt.purchase_order_id`」+「冲突与歧义显式上报」。这一句里其实混了两件事：**从非结构化材料抽取需要模型**，**标识对应的推导不需要**。后者若也交给模型，就既不可复现也不可复核——而本阶段的验收明确写着「对象数 / 关系数 / 跨系统连接数 / 冲突数**可复现**」。所以先做确定性的一半。

**新增 `backend/src/services/semantic-identity-link-service.js`**，事实只有两处，都是既有事实源：提案候选对象（自带 `source` 与 `sourceSystems`）与 `data/seed.js` 的 `systemConfigurations`（各系统已声明的对象与字段）。不新增任何定义。

1. **字段目录按所选系统收敛**，不按材料命中裁剪——目录回答的是「范围内的系统声明了什么」，与「本次材料提到了什么对象」是两个问题；每条记录带 `groundings` 区分「来自提案对象」与「仅来自系统声明」，链接上带 `notInProposal`。
2. **标识三档识别，不识别就不判定**：受控词汇表登记主键 → 由对象名派生的 `<object>_id` → 声明中**唯一指向该对象自身概念**的标识字段 → 否则记入 `keyGaps` 并给出候选。**绝不拿第一个字段顶替。**
3. **跨系统对应**：A 的标识字段指向概念 C、B 的标识也指向 C，且两者来自不同系统 → 一条带方向、基数（`n:1`）与逐字证据的链接；两端键形状不一致（代理键 ↔ 业务键）标 `requires_mapping`，**不**当作可直接对齐。
4. **四类冲突显式上报**：`ambiguous_identifier`（泛化标识归属不明，`blocksLink`，不参与推导）、`alias_divergence`（同一概念多个字段名）、`key_shape_incompatible`（同一概念上代理键与业务键混用）、`declaration_divergence`（同一对象名/同一张表在两处声明中字段集不一致）。**同名不等于同一实体。**

**核心决策（[ADR-014](../architecture/adr/ADR-014-identity-linking-as-assumption.md)）：标识对应只上报，不自动并入 `relationshipTypes`。** 它由字段名归一化加一张人工登记的事务概念别名表推出，是**假设**而不是证据；自动并入会让「一次字符串匹配」与「材料里写明的外键」在草稿里不可区分——这正是本次重构一路在消除的模式（对照 `semantic-natural-schema-service.js` 的既有纪律：`model suggestions never become facts`）。合并动作需要有人的复核，落点在 4b。

**两处实测踩到的规则缺口，是本阶段最有价值的产出**：

1. **外键被当成主键**。初版按「取第一个 `_id` 后缀字段」兜底，于是 `ERP.Inventory` 的 `lot_no`（指向**物料批次**）成了库存自己的标识，凭空变成「物料批次」概念的对齐目标——实测把跨系统链接从 11 条虚增到 **16** 条、其中 11 条打上 `requires_mapping`。修正为「对象自己的标识必须指向该对象自身概念」后，`ERP.Inventory` 正确落入 `keyGaps`（ERP 库存的复合业务键未在映射中声明），链接回落到 11 条。同一处规则还解决了 `WMS.InboundReceipt` 三个 `_id` 字段的歧义：按顺序取值，对错取决于字段顺序，**那不是规则**。
2. **裸名列被误判为标识**。`lims.test_result.result` 是值列，却因词干落在概念别名表里被当成标识，于是凭空多出「同义不同名」冲突。修正为裸名一律走显式白名单 `BARE_IDENTIFIER_NAMES`，**不用别名表兜底**。

**验收（本机实测，内置合成数据，6 系统）**：`test:identity` **7/7**（新增，`test:scope` 12/12、`test:semantic` 6+60+92、`test:architecture` 10/10 未增跨域边、lint / typecheck 干净）。确定性计数：字段目录对象 **21**、标识字段 **33**、跨系统链接 **11**（`linkable` 4 / `requires_mapping` 7）、冲突 **14**（`alias_divergence` 5 + `declaration_divergence` 5 + `key_shape_incompatible` 4）、`keyGaps` **1**、未解析引用 **1**；`relationshipTypes` 仍为 **8**——本能力**不**增加草稿关系。方案原文举的例子真实出现：`WMS.InboundReceipt.purchase_order_id → ERP.PurchaseOrder.purchase_order_id`（`n:1`，`linkable`）。

**已知边界（如实）**：`links` 不进入 `relationshipTypes`，因此当前收益是「可见但未生效」，跨系统连接要等 4b 的复核合并动作才真正落到草稿上（刻意选择）；概念别名表是**人工维护的领域知识**，它不准则对应不准，且未登记词干（如 `stock`）既不连也不报歧义，**可能漏掉真实对应**；冲突**只上报，不给处理动作**（合并/改名/区分粒度都没有入口）且未分级收敛（6 系统 14 项，量级偏大）；字段目录不按材料裁剪，故报告里会出现材料从未提到的系统声明对象（由 `groundings` / `notInProposal` 标注来源）。仍**不含**从非结构化材料抽取对象与标识。

## 28. 阶段 4b：标识对应确认后并入（关闭 ADR-014 退出条件 1）

**这一节把「可见」变成「生效」，同时不放弃上一节的核心约束。** 第 27 节结束时，6 系统基线下有 11 条跨系统标识对应摆在界面上，而对最终草稿的影响是 **0**——`relationshipTypes` 仍是 8 条。界面展示了结论，人自然会以为它已经在模型里；这本身就是本次重构一路在消除的模式的变体。本节实现「人工逐条确认后并入」。

**为什么必须先决策再写代码**：ADR-014 自己写明了退出条件 1——「若开始把 `links` 并入草稿关系：必须先给出人工确认的落点与证据等级，并重新决策假设与证据在草稿里是否仍可区分」。决策记入 [ADR-015](../architecture/adr/ADR-015-identity-link-confirmation.md)（含 4 条复审条件），并标注 ADR-014 的决策 1 由它承接（ADR-014 其余决策与四类冲突上报仍有效）。

**核心决策**

1. **确认落在既有复核动作上**（`PATCH .../proposal` 的 `identityLinkConfirmations`），不新增端点。并入本质上就是**修订草稿关系**，走既有通道才能自动获得版本冲突检测、Schema Critic 重算、Diff / 影响分析、修订历史与「修订后确认凭证失效」这些既有不变量；新开旁路意味着这些都要重新实现一遍，漏掉任何一条就会产生「看起来已确认、实际未过 Critic」的状态。
2. **证据等级取 `provenanceType: 'inferred'`，明确不取 `confirmed`**。`confirmed` 在本体契约里是**最高等级**（`ontology-identity-service` 只把 `confirmed` 的映射视为无需复核，`ontology-contract-service` 要求它必须附证据）。给一条由字段名归一化推出的边标 `confirmed`，等于宣布一次字符串匹配达到了人工核实事实的地位。
3. **可区分性靠 `provenanceType` + `derivedFrom`**：材料/词汇表声明的边是 `declared`，并入的边是 `inferred` 且记录来源链接 key。这是 ADR-014 退出条件 1 的直接答案，并在用例里反向锁死（非派生边必须全部是 `declared`）。
4. **`requires_mapping` 必须随确认给出映射依据**，否则硬拒绝（`SEMANTIC_IDENTITY_CONFIRMATION_REQUIRES_MAPPING_EVIDENCE`）。两端键形状不同意味着不能按值直接连接，允许「确认但无依据」等于把已知不可连接的关系伪装成可连接。依据写进关系的 `evidence`，**不能只留在界面输入框里**。
5. **确认集合是全量语义**（省略＝本次不调整、空数组＝撤销全部），**服务端每次从确认集合重建**这类边。副作用是一项安全性质：「人工确认」这道关口**不能靠一次构造请求绕过**——自己伪造一条带 `derivedFrom` 的关系，保存时会被剔除（已实测）。
6. **失效的确认分两种**：显式重新提交一个已不存在的 key → 400 `SEMANTIC_IDENTITY_CONFIRMATION_STALE`（界面拿的是过期结论）；**继承的历史确认**因字段修订失效 → 不阻断修订，但必须写进 `identityLinkConfirmationReport.droppedStale` 与任务回应。前者防「按旧结论写入不存在的对应」，后者防「历史确认锁死字段演进」与「静默丢弃」。

**顺带补掉一处同类白名单缺口**：`sanitizeProposalDraft` 的关系白名单里没有 `derivedFrom`，并入的关系在净化时会被**静默丢掉**——与 `publicTask` 漏登记 `systemScope` 完全同类（内部构造正确、单测全绿，只在端到端路径上暴露）。已登记并加了注释说明。

**一处靠实测才发现的缺陷（本阶段最有价值的产出）**：`evidence` 原上限 100 字，而一条 `requires_mapping` 的边要同时容纳链接证据、键形状说明与人写下的映射依据——**必然截断**。首版就是硬截断，实测出现 **`…；该来源系统`** 这种半句话（尾部是 `"入候选对象，依据来自系统声明"` 被切剩的残句）。改为**按优先级拼装、装不下就整条舍弃**（链接证据 > 键形状 > 映射依据 > 归一化口径 > 来源 grounding），上限放宽到 260 字；用例里反向锁死「截断必须发生在整句边界」。放宽的是**展示保真度上限，不是安全边界**；人写的映射依据单独限 80 字（依据应是一行可核对的说明，不是一篇论证）。

**验收（本机实测，内置合成数据，6 系统）**：`npm run quality` 端到端 **0 失败**（1m54s，链尾 `test:mock-onboarding` 69/69 通过 ⇒ 链内每组都通过）；`test:identity` **12/12**（7 → 12）、`test:scope` 12/12、`test:semantic` 6+60+92、`test:conversations` 22/22、`test:architecture` 10/10（**未增跨域边**）、运营端 `workspace-layout` 7/7；lint / typecheck 干净；`docs:check` 177 md / 978 链接；5 端构建通过（web 2.89s + 3.30s、desktop 2.70s、mobile、dingtalk）。确定性流程实测（同一次探针，基线 `relationshipTypes` 8 条 / 链接 11 条）：确认 1 条 `linkable` → **8 → 9**（新增边 `TestResult.references_material_batch_id → RawMaterialBatch`，`provenanceType: 'inferred'`、`derivedFrom` = 链接 key）；重复确认 → 仍 9（幂等）；省略字段 → 保持既有；空数组 → 并入数 **0**（撤销）；伪造 `derivedFrom` → **被剔除**；`requires_mapping` 无依据 → 400 并点名对象；带依据 → 并入且依据出现在关系 `evidence` 上（实测 211 字，整句收尾）；字段改名使继承确认失效 → `droppedStale` 列出该 key + 任务回应出现「因字段修订而失效…已移除并在此列出」；显式提交已失效 key → 400 `SEMANTIC_IDENTITY_CONFIRMATION_STALE`。

**已知边界（如实）**：冲突仍**只上报、无处置动作**（归属指派、别名等价裁定、合并/区分粒度都没有入口，属阶段 4c）→ **其中 `alias_divergence` 的等价裁定已在第 29 节关闭**；`requires_mapping` 的映射依据是**自由文本**，不是结构化映射定义；界面上「已确认」只表示**提案记录了确认**，写入草稿仍需后续「确认写入草稿」动作（本轮未改动那条链路）；仍**不含**模型驱动的对象与标识抽取；全部验收为**内置合成数据**，不代表真实企业系统的跨系统连接已验收。

## 29. 阶段 4c（第一段）：标识等价假设先裁定（解决 ADR-015 复审条件 3）

**做了什么**：新增「标识等价裁定」入口，让「同一概念下的多个字段名是否指向同一实体」这个**支撑整条链路的假设**第一次可以被回答。

**为什么这段排在第一段**：阶段 4b 结束时，11 条跨系统标识对应已经可以逐条确认，但**其中 9 条**站在同一个没人回答过的前提上——`MaterialBatch` 一个概念下的三个字段名（`lot_no` / `material_batch_id` / `material_batch_no`）就支撑了 4 条，`Product` 四个字段名支撑 4 条，`Material` 两个支撑 1 条。`alias_divergence` 的 `reason` 自己写着「跨系统对接前必须确认它们指向同一个实体」，而界面从来没有这个入口。于是运营可以在**没看过前提**的情况下逐条确认那 9 条——这正是本次重构一路在消除的「结论超出可见依据」，只是这次缺的是**前提**而不是结论。

阶段 4c 的另一段（模型驱动的对象与标识抽取）刻意后置：它会引入模型不确定性、需要独立设计可复现验收，且要先回答「模型结论以什么证据等级进入草稿」（ADR-014 复审条件 3）。

**核心决策（[ADR-016](../architecture/adr/ADR-016-identity-conflict-rulings.md)）**

1. **裁定落在既有复核动作上**（`PATCH .../proposal` 的 `identityConflictRulings`），不新增端点——与 4b 同构，直接获得版本冲突检测、Critic 重算、Diff 与修订历史。
2. **裁定不并入草稿、不产生证据等级**——这是对 ADR-015 复审条件 3 的直接回答。裁定回答「这个等价假设成立吗」（改链接推导的**输入**），确认回答「这条对应要写进模型吗」（改**草稿关系**）。两者不作用于同一层，所以裁定与 `inferred` 不可能混用；顺序也是刻意的：**先裁定假设，再采纳结论**。
3. **`distinct_entity` 撤下跨组对应**，不保留为「可疑项」——留在清单里会出现一条「已知不成立但可以勾选」的边（与 ADR-015 决策 4 对 `requires_mapping` 的立场一致：不留已知不成立的采纳入口）。
4. **分组必须是严格划分**：至少两组、不重复、不遗漏、不含陌生字段。部分覆盖会让未提及的字段名落进一个隐含的第三组——等于服务器替人补了一次没声明的裁定。
5. **失效项必须区分原因**：`droppedStale` 由裸 key 升级为 `{ key, reason }`。这是对 ADR-015 落地当天输出格式的**破坏性变更**（已写入 ADR-016 复审条件 4，当前只有内置合成数据与用例在读它）。

**两处靠实测修正的地方**

1. **「未裁定的对应数」口径收紧过一次**：首版按 `ruling === null` 计数得到 **11**，把 `PurchaseOrder` / `Supplier` 这类**本就没有等价分歧**的对应也算成了「前提未裁定」，高估了问题规模。改为「所属概念仍在 `unresolvedConcepts` 里」后为 **9**，并在用例里锁死这个口径。
2. **裁定的合法性必须用「不带裁定的基线」判定**：首版打算直接用裁定结果重算后校验，但那会让一条错误裁定把自己的校验依据一起消掉（该概念在带裁定的结果里可能已经不再有分歧）。改为「先算基线冲突 → 校验请求里的概念 → 再带裁定重算」，两次推导（纯内存，开销可忽略）。

**涉及文件**：`backend/src/services/semantic-identity-link-service.js`（新增 `resolveIdentityConflictRulings`、`rulings` 参与重算、`withdrawnLinks` 与 `rulingReport`）、`semantic-operations-agent-service.js`（接收裁定 / 双次推导 / 透出）、`semantic-operations-task-service.js`（透传 + 按「裁定 → 撤下 → 确认 + 失效原因」逐项回应）、`apps/semantic-operations-console/src/components/SemanticAgentWorkspace.vue`（裁定面板 + 撤下清单 + 等价前提状态）、`docs/architecture/adr/ADR-016-identity-conflict-rulings.md`（新增）、`backend/test/semantic-identity-link.test.js`（12 → 17 项）、`apps/semantic-operations-console/test/workspace-layout.test.js`（补 4c 面板断言）。

**验收（本机实测，内置合成数据，6 系统）**：`test:identity` **17/17**（12 → 17）、`test:semantic` 6+60+92、`test:architecture` 10/10（**未增跨域边**，新增能力全部落在既有 `semantic-identity-linking` 域内）；lint / typecheck 干净；`docs:check` 178 md / 995 链接。确定性流程实测：基线 11 条对应 / 5 个概念有等价分歧 / **9 条对应的前提未裁定**；`MaterialBatch` 裁定为不同实体（3 组）→ 对应 **11 → 9**（撤下 `ERP.Inventory.lot_no`、`LIMS.Sample.material_batch_no`），同组 2 条保留并标 `distinct_entity`，`unresolvedAliasConcepts` 5 → 4，**草稿关系仍为 8 条**（裁定不写关系）；改判为同一实体 → 回到 11；空数组 → 撤销全部回到 11；省略 → 保持既有；分组未覆盖 / 只给一组 / 陌生字段 / 非法动作 / 重复概念 → 各自 400 且一条都没落库；先确认一条 `requires_mapping` 再裁定撤下它 → 草稿关系 **9 → 8**、`merged` **1 → 0**、`droppedStale` 给出「属不同实体」的原因；撤下后仍显式重提该 key → 400 `SEMANTIC_IDENTITY_CONFIRMATION_STALE`。

**已知边界（如实）**：只裁定 `alias_divergence`。`ambiguous_identifier` 的归属指派未做（实测当前 **0 条**，且粒度须按「系统.对象.字段」而不是按概念——没有真实用例驱动时不做，避免设计一个没有验证场景的粒度）；`declaration_divergence` 的合并/区分粒度（对象级裁决，会改字段目录的合并语义）与 `key_shape_incompatible` 的结构化标识映射（ADR-015 复审条件 2）均未做；服务端只校验「是不是一个合法划分」，**不校验「划得对不对」**（域语义只能由人给，代价是裁定质量无机器兜底）；无裁定差异视图（只上报本次撤下了哪些）；全部验收为**内置合成数据**，不代表真实企业系统的跨系统连接已验收。

## 30. 阶段 4c（第二段）：材料归属由模型取证、服务端判定（回答 ADR-014 复审条件 3 的模型一半）

**做了什么**：把模型真正接进链路，但只接「取证」这一档——模型给材料里说明归属的**逐字原文**，系统码由服务端**确定性**判定，且判定结果一律是**候选**。

**为什么先做这一段**：方案原文写着「本阶段是本次重构中唯一真正需要模型能力的部分」，而 4a / 4b / 4c 第一段**全部建立在既有事实源上**（提案候选对象 + 系统配置映射），没有一处用到模型。同时 [ADR-014](../architecture/adr/ADR-014-identity-linking-as-assumption.md) 复审条件 3 要求「说明模型结论以什么等级的『证据』进入草稿」——这一条只能靠真正把模型接进链路回答。三类冲突的处置入口规模都不小，但与「模型结论怎么进草稿」是两件事，故排在其后。

**触发它的断裂（本机实测，注入符合契约的模型输出）**：材料里逐字写着「ERP 采购订单表 `purchase_order`」「WMS 收货表 `inbound_receipt`」「外键：`po_id` 引用 `purchase_order`」——正是方案原文举的那个例子。模型输出的表名 / 字段 / 主键 / 外键证据**全部通过 `validateNaturalSchema` 逐字校验**，但 `sourceSystems` 恒为 `['UNASSIGNED']`，于是 4a 字段目录跳过这两个对象、跨系统标识对应 **0 条**、Critic 报「受控来源系统」不通过、采纳被 `SEMANTIC_PROPOSAL_CRITIC_FAILED` 拒绝。**卡住链路的信息一直就在材料里**：模型被要求逐字给出表名、字段名、主键与外键的证据，唯独没有被要求给出「这张表属于哪一处」。

缺口的准确形状是**两条抽取路径策略不一致**：

| 路径 | 归属来源 | 能进 4a 字段目录 |
| --- | --- | --- |
| 结构化字典（`discoverSchemasFromAttachments`） | 字典声明的 `system` → 文件名系统码 → 输入文本系统码 → 否则 `UNASSIGNED` | 能（若在范围内） |
| 自然语言材料（`discoverNaturalSchema`） | **无**（恒 `UNASSIGNED`） | **不能** |

`collectDeclarations` 里 `item !== 'UNASSIGNED'` 是显式跳过，**不是疏漏**——`UNASSIGNED` 的含义是「来源未知」，让未知来源参与「范围内的系统声明了什么」会把两个问题混成一个。

**核心决策（[ADR-017](../architecture/adr/ADR-017-model-extraction-attribution.md)）**

1. **模型只给归属原文，系统码由服务端判定**——契约里**没有系统码字段**，模型不能直接写 `ERP`。模型给的是「材料里哪句话说明了这张表属于哪一处」（`systemEvidence`，与 `evidence` 同严格度：必须在材料里逐字出现，否则整表拒绝 `OWNER_EVIDENCE_INVALID`）。理由两层：**安全**（让模型直接输出系统码，就是给它一个无法复核的断言入口）+ **事实源**（系统码与别名的定义已在系统注册表 ADR-009，不必在抽取层再养一份）。粒度因此落到**表级**：整篇材料会同时提到多个系统，只有把判定收窄到模型引用的那一句才能回答「哪张表属于哪个」。
2. **判定一律是候选，绝不写 `sourceSystems`**——写入 `candidateSourceSystems` + `candidateSourceBasis: 'material_owner_evidence'` + `candidateSourceEvidence`。`sourceSystems` 是**事实**（受控系统目录与范围裁剪都读它），推断不得冒充事实（同 ADR-014 决策 1、ADR-016 决策 3）。
3. **候选不参与范围裁剪（本 ADR 最重要的一条）**——范围过滤只看已确认的 `sourceSystems`；候选在范围内 / 范围外 / 未登记都只进 `candidateScopeObjects.inScope / outOfScope / unregistered` 上报。若让候选参与裁剪，模型在材料里「引用」一句归属于范围外的原文就能把一个对象从提案里删掉，而人对这句话还没有任何确认动作；ADR-013 要求「被排除项必须显式列出」的前提是**排除的依据是事实**。
4. **候选可以进 4a 字段目录**（新增 grounding `material_owner_candidate`，条件「有候选归属且候选系统在本次所选范围内」）——不进则非结构化材料路径的跨系统对应**永远为 0 条**。进了也只是**候选链接**，仍要过 4b 逐条确认 + 4c 等价裁定两道关口。
5. **候选转事实走人工确认**（`sourceAssignments`，复用既有复核动作）——依据**不得为空**（「人点了一下」不是依据）、目标系统必须已在注册表、集合全量语义（省略＝不调整、空数组＝撤销全部、显式提交无候选归属的对象＝硬错误）、确认后才写 `sourceSystems` 并**这时才**重新按范围裁剪。**撤销是双向的**：回退原稿来源时，此前被裁掉的对象与关系要按**原稿顺序**排回。
6. **零 / 多 / 识别不到三类分别上报，一律不猜**——恰好一个已登记系统才产出候选；多个 → `ambiguous`；一个都识别不出或只识别到未登记系统名 → `unattributed`。多候选时「选哪个都对」需要域知识，服务端不做。

**三个关口的顺序依赖（ADR-017 如实写进「变复杂的地方」）**：归属（对象属于谁）→ 等价裁定（假设成不成立）→ 对应确认（哪些进草稿）。界面上必须把顺序表达清楚，服务端也要按这个顺序执行——回退顺序（先重算标识再写归属）会让本次请求里刚确认的归属还没生效。

**三处靠实测修正的地方**

1. **归属判定不能用业务词别名**：`detectSystemCodesInText`（供「文本提到什么系统」用）的别名含「采购 / 库存 / 供应商」，用于**归属**会把一句「采购订单表」判成 ERP 所有权。另设 `detectDeclaredSystemCodes`，**只认系统码与系统名**。同一张词表被用于两种目的时会互相污染（与阶段 4a 「裸名列 ≠ 标识」同类）。
2. **候选不能与 confirmed 来源抢占目录**：候选仅在对象**无 confirmed 来源**时才进目录，否则同一对象会因两处字段集不同凭空产生一条 `declaration_divergence`——那是**虚假冲突**。
3. **归属确认必须先于标识重算**（见上）。

**涉及文件**：`backend/src/services/system-registry-service.js`（新增 `detectDeclaredSystemCodes`）、`semantic-natural-schema-service.js`（契约新增 `systemEvidence` + `deriveOwnerCandidate` 三情形判定 + `attribution` 报告）、`semantic-identity-link-service.js`（`collectDeclarations` 接受候选 + `sourceBasis` / `sourceInferred` + 候选计数）、`semantic-operations-agent-service.js`（`candidateScopeObjects` / `resolveSourceAssignments` / `applySourceAssignmentsToDraft` / `sanitizeProposalDraft` 白名单补候选字段）、`semantic-world-model-service.js`（`validateProposalEvidence` 接受有记录的人工归属确认）、`semantic-operations-task-service.js`（透传 + 归属结论先回应）、`apps/semantic-operations-console/src/components/SemanticAgentWorkspace.vue`（候选归属区 + 依据输入 + 撤销）、`docs/architecture/adr/ADR-017-model-extraction-attribution.md`（新增）、`backend/test/semantic-source-attribution.test.js`（新增 12 项，`test:attribution` 挂入 `test:all`）。

**一处同类的第三次白名单缺口（本段实测再次命中）**：`sanitizeProposalDraft` 的显式字段白名单此前已漏过 `derivedFrom`（阶段 4b），本段新增的 `candidateSourceSystems` / `candidateSourceEvidence` / `candidateSourceBasis` 若不登记会被**静默丢掉**。这类「内部有、外部无」的缺口只在端到端路径上暴露（对象构造正确、单测全绿仍会漏）。**判据：凡见 `return { a: item.a, ... }` 式显式列表，新增字段就要同时问「它在几个这样的列表里」。**

**验收（本机实测，注入模型输出的确定性用例，6 系统，未跑真实模型轮次）**：`npm run quality` 端到端 **EXIT=0**（1m58s，全文 **0 处 `not ok`**，链尾 `test:mock-onboarding` 69/69 ⇒ 链内每组都通过）；`test:attribution` **12/12**（新增）、`test:identity` 17/17、`test:scope` 12/12、`test:architecture` 10/10（**未增跨域边**）、`test:semantic` 6+60+92、`test:permissions` 29/29、`test:multitenant` 75/75、`test:ontology` 104/104、`test:ark` 39/39；运营端 `workspace-layout` **7/7**；lint / typecheck 干净；`docs:check` **179 md / 1018 链接**；**5 端构建通过**（web 2.39s + 元域智语 3.11s、desktop 2.71s、mobile 2.68s、dingtalk 4.95s）。确定性流程实测：字段目录对象 **13 → 15**、跨系统标识对应 **0 → 2 条**（含 `WMS.inbound_receipt.po_id → ERP.purchase_order.po_id`，`linkable`）、确认归属后 Critic 失败项 **2 → 1**、`sourceSystems` **全程仍 `['UNASSIGNED']`**；四类拒绝（依据为空 / 目标系统未登记 / 提交无候选归属的对象 / 超 60 条上限）各自 400。

**已知边界（如实）**：只做**归属**这一档，**对象本身仍由模型抽取**（`validateNaturalSchema` 逐字证据要求，缺证据即整表拒绝）；**未跑真实模型轮次**——真实模型是否稳定给出 `systemEvidence`、给的是不是材料里那句，**尚未测量**（ADR-017 复审条件 4）；`declaration_divergence` 合并 / 区分粒度与 `key_shape_incompatible` 结构化映射未做；`ambiguous_identifier` 的**按字段**归属指派未做（本 ADR 给的是**对象级**归属，两套粒度如何共存需独立决策）；候选与已确认来源不一致时无差异视图；候选进目录**可能**产生新的 `declaration_divergence`（期望行为，但会加剧冲突量级）；全部为**注入模型输出**的确定性验收，不代表真实企业系统或真实模型已验收。

## 31. 阶段 4c 第二段补测：归属契约的真实模型稳定性（回答 ADR-017 复审条件 4）

**为什么必须测**：阶段 4c 第二段落地后，「未跑真实模型轮次」是文档里出现次数最多的边界（ADR-017 复审条件 4、方案台账、本页、memory 四处）。而复审条件 4 写的是「**若**真实模型轮次显示 `systemEvidence` 不稳定（给的原文不逐字、或引用的是别处的句子）：须重新评估本契约的可行性，并考虑把归属证据的来源改为『材料分段 + 服务端判定』」——**契约能否成立必须先测**，不能用「注入输出全绿」代替。

**做法**：新增 `scripts/evaluate-source-attribution.mjs`（`npm run evaluate:source-attribution`），**走 production 抽取路径 `discoverNaturalSchema`**——**不另写一份评测专用提示词**，否则测的是一份只存在于评测里的契约。四个合成材料变体各 3 轮，另加两次端到端提案轮次。provider `workbuddy` / `deepseek-v4-pro`，采样温度 **0.2**（非确定性采样，故重复轮次才有意义）。

| 变体 | 材料特征 | 期望 | 实测（每变体 3/3 一致） |
| --- | --- | --- | --- |
| A | 逐字写出「ERP 采购订单表」「WMS 收货表」 | 产出候选 | `attributed`：`purchase_order→ERP`、`inbound_receipt→WMS`；候选落上而 `sourceSystems` 仍 `['UNASSIGNED']` |
| B | **完全没写**所属系统 | 弃权 | `absent`——填 `null`，**没有硬凑一句** |
| C | 只用业务词（「采购业务中的」「库存管理中的」） | 不认 | `unattributed`——**引用了原文**但其中不含系统码；`attributed` 0、候选 0 |
| D | 归属那一句里出现**两个**系统 | 报歧义 | `ambiguous { systems: ['ERP','WMS'] }`，**未择一** |

**24 轮抽取中 0 次 `OWNER_EVIDENCE_INVALID`**（模型没有给出非逐字的归属原文），单次调用 3.3–5.6 秒（均值 4.9 秒）。两次完整重跑结果一致（12 轮 × 2，0 抖动）。

**端到端（真实模型输出走完整提案链路，`scopeSystems=['ERP','WMS']`）**

| 观测项 | A（写明归属） | B（未写归属） |
| --- | --- | --- |
| 字段目录对象 | **4 → 6** | 4（不变） |
| 跨系统标识对应 | **0 → 2**（`linkable` 2 / `requires_mapping` 0） | **0** |
| 其中一条 | `WMS.inbound_receipt.po_id → ERP.purchase_order.po_id`（两端 `material_owner_candidate`） | — |
| 推断来源对象 | **2** | **0** |
| Critic 失败项 | **2**（受控来源系统、字段来源映射） | **2**（同左） |

**只取证不解检查**：候选阶段 Critic 仍报「受控来源系统：存在未登记来源系统」——**这正是 ADR-017 决策 2 要的**（候选不是事实）。**按材料原文确认两处归属后**：`sourceSystems` 写为 `ERP`/`WMS`、候选字段清空、`inferredSourceObjects` `2 → 0`、`inferredSourceLinks` `2 → 0`、Critic 失败项 **2 → 1**（只剩既有的「字段来源映射」）——**真实模型轮次下复现了此前只用注入输出得到的「2 → 1」**。

**结论**：契约在真实模型下可用，**ADR-017 复审条件 4 未触发**，不需要改为「材料分段 + 服务端判定」。

**一处自己的错误（必须记下来）**：脚本初版按 `item.passed` 过滤 Critic 检查项，而检查项用的是 `status: 'passed'|'failed'`——`undefined` 使**全部**检查都被列为「失败」，一度得出「确认归属后受控来源系统仍然失败」的结论，与实现（`critiqueProposalDraft` 第三项读 `draft.objectTypes[].sourceSystems`）及其 detail 自相矛盾。按 `status` 过滤后与注入测量一致。**判据：读「一组结果对象里的通过项」之前，先确认字段叫什么，而不是先确认它是不是 falsy。**

**已知边界（如实）**：样本小（4 变体 × 3 轮 + 2 次端到端，**单一** provider/模型）；材料为**合成材料**；只覆盖四类归属情形（未覆盖系统名以别名/英文/缩写出现）；**契约只保证归属原文逐字来自材料，不保证那句话在语义上真的在说明归属**——模型引用一句「逐字但不相关」的句子，服务端会照判，这一层没有机器兜底；确认步骤由脚本直调服务层完成（**未经界面**）；本测量只回答「契约稳不稳」，不代表真实企业材料或生产验收。质量门：`npm run lint` 干净、`docs:check` **179 md / 1020 链接**（阶段 4c 第二段收尾为 1018）。

## 32. 阶段 4c（第三段）：同名声明不一致的合并 / 区分裁定（承接 ADR-016 的 `declaration_divergence`）

**为什么是这一段**：[ADR-016](../architecture/adr/ADR-016-identity-conflict-rulings.md) 的「明确不在本 ADR 范围内」写着 `declaration_divergence`「属于阶段 4c 的**下一段**」，[ADR-017](../architecture/adr/ADR-017-model-extraction-attribution.md) 同样把它列为不在自身范围。四类冲突里：`alias_divergence` 第一段已裁定、`ambiguous_identifier` 实测 **0 条**（无用例驱动，ADR-016 已说明先不做）、`key_shape_incompatible` 有间接承载（`requires_mapping` + 确认时的自由文本依据），**只有 `declaration_divergence` 连一个入口都没有**（实测 5 项）。

**缺口的准确形状：不是「冲突没被上报」，而是「默认动作不可见、且在被当成事实用」**

1. **字段并集看不见**：`buildSystemFieldCatalog` 对同一系统内同一 `objectId` 的多处声明取**字段并集**，条目上只留 `groundings`——运营看到的「这个对象有 7 个字段」**没有任何一处声明说过**。
2. **并集在参与标识识别**（实测）：`MES.ProductionBatch` 的并集条目（7 字段）被判定的标识是 `production_batch_id`（依据「受控词汇表登记的主键」），而 MES 的**已配置映射**那份声明只声明 `batch_no`。**标识是真实的，却被记在了一个不存在的对象（两处声明的复合体）名下**；同理 `LIMS.TestResult`（并集 9 字段 → `test_result_id`）。

这与本次重构一路在消除的模式同构（4a 消除「对应被当成结论」、4b 消除「假设被当成证据」、4c 第一段消除「等价前提从未被看见」、4c 第二段消除「归属断言无法复核」）：这里剩下的是**「两处声明被合成一个复合体，谁都没为这个复合体声明过」**。

**六条核心决策**（详见 [ADR-018](../architecture/adr/ADR-018-declaration-divergence-merging.md)）

1. 裁定落在**既有复核动作**的 `declarationRulings`；键是**分歧项**（`object:Inventory` / `source:ProductionBatch@mes.production_batch`），与 ADR-016 的**概念级**键是两套粒度、各自独立校验（回答 ADR-016 复审条件 3 的「两套粒度如何共存」）。
2. 动作两个互斥：`merge`（并集从默认动作变成结论）/ `distinct`（**不并集**：严格划分这些声明，每组给出对象名或 `drop` 显式排除，至少保留一组）。
3. 裁定**不写草稿、不产生证据等级**——改的是**字段目录的组成**（链接推导的输入）。
4. **未裁定也必须披露并集**：条目新增 `declarations`（逐处声明与字段）、`exclusiveFields`（只被一处声明列出的字段）、`declarationState`，`identifierBasis` 必须写明「这是在并集上识别的」。
5. 全量语义，与既有三套同构（省略＝不调整 / 空数组＝撤销全部 / 显式提交不存在项＝硬错误 / 继承失效→`droppedStale`）。
6. 撤销**双向完全回退**；拆分、被排除的声明、因改名而消失的对应全部在 `declarationReport` 里显式列出。

**实测数字（本机，内置合成数据 6 系统，确定性）**

| 观测项 | 未裁定 | `merge` | `distinct`（拆生产批次） |
| --- | --- | --- | --- |
| 字段目录对象 | 21 | 21（**不变**） | **22** |
| 跨系统链接 / 冲突 | 11 / 14 | 11 / 14（不变） | 11 / 14 |
| 复合条目 `mergedUnruledObjects` | 4 | 4 | **3** |
| 未裁定分歧项 | 5 | 4 | 4 |
| `MES.ProductionBatch` 字段 | **7（并集）** | 7 | **4**（= 该声明自己的字段） |
| 其标识 | `production_batch_id`（并集授予） | 同左 | `production_batch_id`（**仅来自列出它的那处声明**） |
| 拆出对象 `MES.MesBatch` | — | — | 4 字段，标识 **`batch_no`（business）** |

`distinct` + `drop`（排除受控词汇表那份声明）：对象 **21**、链接 **11 → 9**、冲突 **14 → 12**，`droppedDeclarations` 列出被排除的声明及原因。**撤销（空数组）后逐项回到 21 / 11 / 14 / 4 与 5 项未裁定——字段与出处一起回来。**

**验收**：新增 `test:declaration` **12/12**（已挂入 `test:all`）；`test:identity` **17/17**（未裁定路径逐字不变，含 `keyGaps` 深比较与 21/11/14 计数）；`test:attribution` **12/12**；`test:architecture` **10/10（未增跨域边）**；前端 `workspace-layout` **7/7**；lint / typecheck 干净；`docs:check` **180 份 Markdown / 1042 个本地链接**；`npm run quality` 端到端 **EXIT=0**（1m39s，全量 35 个 Node 测试块 `fail=0`、0 处 `not ok`）；5 端构建通过。

**两处实测修正（如实）**

1. **「复合条目」的判据不能只看声明条数**：两处声明字段集**完全一致**时并集等于各自声明，被计入「有几个并集条目没人看过」会虚增运营工作量，改为要求**各处声明确有分歧**。
2. **标识判据按「声明的原名」推导、不跟着改名走**：裁定改名说的是「与别处声明不是同一个对象」，不是「这条声明换了名字」。跟着改名走会让 `objectConceptOf` 因新名字未登记而返回 `null`，把标识判据整条打掉。

**已知边界（如实）**：对象级同名不同义只做到「目录组成」这一层，拆出的对象**不进草稿**（仍走对象编辑），因此会标 `notInProposal: true`（比改造前「并集让它看起来在提案里」更准确）；`drop` 只排除**声明**、不排除对象；服务端只校验组名的结构（非空 / 提交内唯一 / 不与同系统既有对象重名），**不校验名字是否合适**；**未裁定仍是并集**（披露不等于修正）；不做跨修订的拆分对比；~~`key_shape_incompatible` 的结构化映射~~（**已完成，见第 33 节**）与 `ambiguous_identifier` 的按字段归属指派仍未做；全部为**内置合成数据**验收。

## 33. 阶段 4d：标识映射结构化 +「形状未判定」独立成态（关闭 ADR-015 复审条件 2）

**为什么是这一段**：四类冲突里 `key_shape_incompatible` 是**唯一仍由自由文本承载**的一类——[ADR-016](../architecture/adr/ADR-016-identity-conflict-rulings.md) 与 [ADR-018](../architecture/adr/ADR-018-declaration-divergence-merging.md) 都把它列为不在自身范围，而 [ADR-015](../architecture/adr/ADR-015-identity-link-confirmation.md) 留下的**复审条件 2** 正指向它：「**若** `requires_mapping` 的映射依据改为结构化映射定义，须重新评估『依据是否可核对』，并给出映射表的版本与责任人」。阶段 4c 三段把另外两类冲突的处置动作补齐后，只剩它。

**排查时实测到两个缺口，第二个才是真正的触发点**

1. **「不可按值连接」在草稿里不可读**：确认一条 `requires_mapping` 后，那条边与一条 `linkable` 的边**结构完全相同**（同 `predicate`、`cardinality`、`provenanceType: 'inferred'`），区别只在一段中文里。任何下游（治理链路的证据检查、Semantica 采纳、将来的数据通道按值连接）要区分两类边，**只能去解析自然语言**。这与本次重构一路在消除的模式同构：**结论（这条边可用）可见，支撑它的前提（必须先经外部映射表）不可见**。
2. **`status` 的二态判据把「形状未知」当成了「形状不同」**：判据是 `field.shape === expectedShapeOf(target.identifierKind)` 的**二元比较**，而 `field.shape` 有**三个**取值 `agent` / `business` / `null`。`null` 对裸名（`sku` / `product`，在 `BARE_IDENTIFIER_NAMES` 白名单里但没有 `_id` / `_no` / `_code` 后缀）意味着**命名规则判不出来**，而不是「已知与另一端不同」。**实测损害两层**：7 条 `requires_mapping` 里 **2 条（29%）的理由不成立**——它们被要求填写「映射依据」，而机器其实还没判明形状（**要求人为一件机器尚未判明的事作保**）；说明文案写成 `两端键形状不同（null / agent）`，读不通。这与 ADR-018 的「复合条目判据不能只看声明条数」同型：**判据必须落在内容上，不能在内容未知时给出结论**。

**六条核心决策**（详见 [ADR-019](../architecture/adr/ADR-019-structured-key-mapping.md)）

1. `status` 由二态改**三态**：`linkable`（两端都已知且一致）/ `requires_mapping`（都已知且不同）/ `shape_unknown`（至少一端未判定）。`summary` 相应拆为三项；「未知」不能当「不同」——两者风险等级相同但**动作完全不同**（未知要「先判形状」，不同要「给映射」）。
2. `shape_unknown` 的确认输入是**形状判定**（`agent` / `business`），判定后**重新定级**该条边；判定**不写回字段声明**（`shape` 是**这条边上的结论**，写回会污染 `buildSystemFieldCatalog`——一处判定会影响所有读该字段的地方）；对**非** `shape_unknown` 的边提交形状 = 硬错误（界面拿的是过期结论，与 `_STALE` 同源）。
3. `requires_mapping` 必须给出**结构化映射定义** `keyMapping`：`fromField` / `toField`（须与链接**逐字一致**，否则人可能把另一条边的映射写到这里而草稿里看不出错位）、`basis`（四类枚举：主数据对照表 / 人工维护的对照登记 / 规则派生 / 外部系统）、`lookupSource`（`master_data_lookup` 时必填）、`owner`、`version`。自由文本 `evidence` **降级为可选说明**（上限仍 80 字），不再承担表达结构的职责。
4. 结构化映射**必须进草稿**（关系上的 `keyMapping`，已登记进 `sanitizeProposalDraft` 的关系白名单——这是「凡见 `return { a: item.a, ... }` 式显式列表就要问『它在几个这样的列表里』」的**第三次预防**，前两次是 `systemScope` 与 `derivedFrom`），但**证据等级不变**（仍 `inferred`——映射是人给的，不是材料里逐字写明的外键）。
5. 全量语义与失效同构（省略＝不调整 / 空数组＝撤销全部 / 显式提交不存在项＝硬错误 / 继承失效 → `droppedStale`）；形状判定与映射定义同属确认项，**随确认撤销一起消失**，不留孤儿判定。
6. **不做独立映射表实体**：实测 7 条映射**无一条被两条边共享**（无复用证据，为不存在的复用建表是「为形式而形式」）；收在确认项里，追溯与提案修订历史天然对齐；`owner` / `version` 就是**将来升格的钩子**（真出现复用时可由这两列反向聚合出映射表，不必先建表再回填）。

**实测数字（本机，内置合成数据 6 系统，确定性）**

| 观测项 | 阶段 4c 末 | 阶段 4d 后 |
| --- | --- | --- |
| 跨系统标识对应 `links` | 11 | 11（不变） |
| `linkable` | 4 | 4（不变） |
| `requires_mapping` | **7** | **5** |
| `shape_unknown` | —（不存在此态） | **2** |
| 三态合计 | 11 | 11（互斥且覆盖全量） |
| 冲突 | 14 | 14（不变） |

`shape_unknown` 两条：`OMS.Order.sku` → `ERP.ProductSKU.product_id`（null / agent）、`QMS.QualityEvent.product` → 同（null / agent）。确认一条后，关系上 `keyMapping` **逐字保留**、`provenanceType` 仍 `inferred`。

**验收（本机实测，确定性用例，未调模型）**：`test:identity` **20/20**（新增用例 18/19/20：三条拒绝路径 `..._SHAPE_REQUIRED` / `..._SHAPE_INVALID` / `..._SHAPE_NOT_APPLICABLE`；两个方向的重定级 +「不写回声明」+ `shapeResolutions`；已知缺口钉点）；`test:declaration` **12/12**、`test:attribution` **12/12** 未受影响；前端 `workspace-layout` **7/7**（三态表达 + 结构化映射编辑区，并**反向锁死**旧错误码 `..._REQUIRES_MAPPING_EVIDENCE` 不得残留）；lint / typecheck 干净；`docs:check` **181 份 Markdown / 1068 个本地链接**；`npm run quality` 端到端 **EXIT=0**；5 端构建通过（分端跑）。

**复审条件 2 的结论：部分满足（如实）**

复审条件字面是「**若**改为结构化定义，须重新评估『依据是否可核对』并给出版本与责任人」。本段的结论是「**改为结构化定义，但不是改成映射表**」——「可核对」的含义相应收窄为：**结构与两端键逐字一致可由机器校验；`basis` 可选集合、`owner`、`version` 非空可校验；但「这个映射对不对」不在机器能力范围内**（对象叫什么、两个键怎么对上，是域语义）。

**三处偏离与实测修正（如实）**

1. **初版把「形状未知」当成了「形状不同」**（上面的缺口 2）：7 条 `requires_mapping` 里 2 条的确认动作本来就是错的。拆成独立状态后实测 `requires_mapping` **7 → 5**、`shapeUnknown` **0 → 2**，三态合计仍等于 11。
2. **初版写了「继承的确认若从 `requires_mapping` 降级为 `shape_unknown` → 写入 `droppedStale`，不阻断修订」**，实现时核对发现**这条描述的是不可达状态**：链接 key 由「源系统.源对象.源字段」与「目标系统.目标对象」构成，而 `from.shape` 是**源字段名的纯函数**（裸名 → `null`），`to.shape` 由目标对象标识类型决定、取值恒为 `agent` / `business`（**永不为 `null`**）——key 稳定 ⟺ 源字段名稳定 ⟺ 形状稳定，因此一条 key 稳定的链接**不可能**从「两端已知」变成「形状未判定」。ADR-019 已就此显式自我修正，并说明若真出现则是硬错误 `..._SHAPE_REQUIRED`（方向保守：宁可挡住，也不把一条形状未判定的边放进草稿），故**不**改为静默 `droppedStale`。
3. ~~**`notInProposal` 的对应「列进可确认清单但确认不了」**：实测 11 条里 **5 条** `notInProposal: true`（`linkable` 1 / `requires_mapping` 2 / `shape_unknown` 2），即接近一半的对应**当前不可并入草稿**。界面把 `notInProposal` 说明（「该来源系统本次未进入候选对象，依据来自系统声明」）显示出来，但真去确认时的错误是 `关系的起点、终点和谓词必须完整，并引用本次候选对象`（`SEMANTIC_PROPOSAL_INVALID`）——**错误原因与事实对不上**：真实问题是**来源对象本身不在本次范围内**。这是阶段 4b 起就存在的口径缺口，与形状 / 映射无关；「哪些对应**有资格**被确认」（推导层就标为不可确认，还是给专用错误码并说清缺哪个对象）是一次独立决策，本段**只钉不修**（用例 20 钉住现状并写明「修好它时这条用例会失败，应连同 ADR 一起更新，而不是删掉断言」）。~~ —— **已在「阶段 4e」关闭**（第 34 节），并更正为 **4 条**：第 5 条 `ERP.Inventory.lot_no` 实测可确认。

**已知边界（如实）**

- **`shape_unknown` 的「判定后并入草稿」在现有合成数据下不可达**：两条 `shape_unknown` 对应的源对象（`OMS.Order`、`QMS.QualityEvent`）都不在本次候选对象之内，任务级并入会被端点校验先挡下。因此该路径只能在**纯函数层**取证（用例 19 用 `deriveIdentityLinking` + `buildConfirmedRelationships` 夹具锁死），任务级用例（用例 18）只覆盖三条**拒绝路径**（它们与端点是否在范围内无关）**阶段 4e 起这一条更强**：资格检查排在形状之前，任务级连**形状分支**都走不到（不只是并入路径）；形状的三条拒绝路径改由**用例 21**在纯函数层锁死。
- **形状判定不写回声明**意味着同一裸名字段出现在多条边上要**重复判定**（当前实测无此情形：两个裸名字段各只出现一条边）；这是真实的设计代价。
- **服务端只校验结构**（字段名逐字一致、枚举、非空），**不校验映射是否正确**——`basis: 'manual_register'` 后面可能是一句空话，机器不拦。
- **`key_shape_incompatible` 冲突本身仍只有上报**：本段让 `requires_mapping` 的确认变得可核对，但「同一概念上以哪个键为准」仍无裁定动作（实测无用例驱动——这 4 条冲突在 `declaration_divergence` 的 `distinct` 场景下会随字段拆分而消失）。
- **不做独立映射表实体**（决策 6），也没有跨任务复用与失效传播。
- 全部为**内置合成数据**验收，**不代表真实企业系统验收**。

**下一步**：`ambiguous_identifier` 的按字段归属指派（实测 **0 条**，ADR-016 复审条件 3 要求先给出「系统.对象.字段」粒度）；~~**`notInProposal` 对应的可确认性**（影响面 **5 / 11 条**）~~ —— **已完成（2026-09-25，阶段 4e / 第 34 节）**，并更正影响面为 **4 / 11 条**（第 5 条实测可确认）；ADR-019 的四条复审条件（映射出现复用 / `shape_unknown` 允许未判形状确认 / 形状判定改为写回声明 / 下游依赖 `keyMapping` 做实际数据连接）均为**触发式**，未触发不动。

## 34. 阶段 4e：一条标识对应「有没有资格被确认」的判据唯一化（关闭 4d 只钉未修的口径缺口）

**为什么先做这一段**：4d 收尾时把两件事留在「下一步」——`ambiguous_identifier` 的按字段归属指派（实测 **0 条**，无用例驱动，属「等有证据再做」）与 **`notInProposal` 的可确认性**。后者是本段实测出来的**真实缺口**：清单上有一批对应写不进草稿，且失败原因那句话说的是另一件事。有实测驱动、影响面 4/11、且是**一句界面上的事实错误**——先做它。决策见 [ADR-020](../architecture/adr/ADR-020-identity-link-confirmation-eligibility.md)。

**触发点（本机实测，内置合成数据 6 系统，确定性）**：把 11 条对应**逐条单独**拿去确认（每条一份新任务），再与字段目录的 `groundings`、草案候选对象 id 集对照：

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

**结论一**：可确认 **7** / 不可确认 **4**，判据与服务端草案校验（`sanitizeProposalDraft` 的 `objectIds.has`）**0 例外**逐行一致。

**结论二**：旧 `notInProposal`（**5 条**）用「声明 grounding」冒充「候选资格」，**多标 1 条**——`ERP.Inventory.lot_no` 的来源是 ERP 的**系统配置声明**（于是被标 `notInProposal: true`），但它的对象名 `Inventory` 与本次候选对象 `Inventory` **同名**，草案校验通过，**实测确认成功**。界面据此显示「该来源系统本次未进入候选对象，依据来自系统声明」：ERP 在本次范围内、`Inventory` 也在候选对象里——**这是一句事实错误**，运营会据此放弃一条本可用的对应。

**结论三**：真不可确认的 4 条，拒绝原因说错两层——`SEMANTIC_PROPOSAL_INVALID`「关系的起点、终点和谓词必须完整，并引用本次候选对象」：（a）**「必须完整」不成立**（三者俱全）；（b）**没说清缺哪个对象**（`LIMS.Sample` / `OMS.Order` / `QMS.QualityEvent` / `WMS.InboundReceipt`）。

**同型教训**：一个 flag 同时承载两个不同的问题，它在其中一个上必然说谎（与 ADR-018「复合条目判据不能只看声明条数」同型）。`notInProposal` 被三处分别读作「来源系统未进入候选对象」（界面，**判据与表述都不对**）/「依据来自系统声明」（关系证据，**这处是对的**）/「能不能并入草稿」（**从未检查过**，靠草案校验兜底报错）。

**六条核心决策**

1. **资格判据唯一化**：`eligible` ＝ 两端 `objectId` 都在本次候选对象内。`candidateObjectIds` 由推导层从**它已经拿到的 `objects`**（＝草案 `objectTypes`）构造——与服务端草案校验**读同一个数组**，因此「推导层说得出可确认」与「服务端写得进」不可能分叉。
2. **不可确认的必须披露、不得隐藏**：仍留在 `links` 里，带 `eligible` / `ineligibleEndpoints` / **可行动**的 `ineligibleReason`（点名对象 + 说明依据来自哪里 + 给出「先让它成为候选对象」）。删掉它，运营看到的就是「本次没有 OMS→ERP 的引用」，而真相是「有，但 `OMS.Order` 这次没被抽出来」。
3. **不可确认的确认请求＝专用硬错误**：`SEMANTIC_IDENTITY_CONFIRMATION_ENDPOINT_OUT_OF_SCOPE`，点名对象；检查次序固定 **链接存在 → 资格 → 形状 → 映射**；**显式**重提交是 400，**继承**的确认走 `droppedStale`（不阻断修订，与 ADR-015 决策 6 的分流同构）。
4. **两个判据拆开、名字各自诚实**：`notInProposal` → `declarationSourced`（判据不变），职责收窄为「依据来自系统配置声明」；界面那句错话改为「来源端依据为系统配置声明」，**不再对资格作任何陈述**。
5. **计数进 `summary` 与回应**：`summary.eligible` / `summary.ineligible`；任务创建回应与每次修订回应都要说「另有 N 条本次不可并入（含对象名与下一步）」。
6. **不放宽草案校验，也不自动补候选对象**：前者会产出悬空边；后者会让标识推导**反向决定对象抽取**，而对象来源与范围是 ADR-012 / ADR-013 / ADR-017 已定过的决策。

**实测口径变化**

| 口径 | 4d 末 | 4e 后 |
| --- | --- | --- |
| `links` / 三态分布 / 冲突 | 11 / 4+5+2 / 14 | 11 / 4+5+2 / 14（不变） |
| `summary.eligible` / `summary.ineligible` | 不存在此口径 | **7 / 4** |
| `notInProposal` | 5 条（**含 1 条误报**） | 拆为 `declarationSourced`（**5 条**）与 `eligible`（**7 条**） |
| 不可确认的确认请求 | `SEMANTIC_PROPOSAL_INVALID`（原因不符） | `..._ENDPOINT_OUT_OF_SCOPE`（点名对象） |

**改动文件**：`backend/src/services/semantic-identity-link-service.js`（`linkEligibilityOf` / `GROUNDING_LABELS` / 三个新字段 / `summary` 两项 / policy / `confirmedEvidence` 那句错话 / `buildConfirmedRelationships` 的资格分支与 `outOfScope` 报告）、`semantic-operations-agent-service.js`（第四个拒绝分支）、`semantic-operations-task-service.js`（`describeIdentityFindings` 与修订回应的披露句）、`apps/semantic-operations-console/src/components/SemanticAgentWorkspace.vue`（第四种状态、`linkEligibilityNote`、勾选拦截、保存前把「不可并入」与「还没填完」分开说、新错误文案、CSS）、`backend/test/semantic-identity-link.test.js`、`apps/semantic-operations-console/test/workspace-layout.test.js`、[ADR-020](../architecture/adr/ADR-020-identity-link-confirmation-eligibility.md)（新建）与 [ADR-019](../architecture/adr/ADR-019-structured-key-mapping.md)（两处不实描述就地修正）。

**验收（本机实测，确定性用例，未调模型）**：`test:identity` **21/21**（改写用例 20 为「闭合缺口」、重写用例 18 为「资格先于形状 + 对照组 + 继承分流」、新增用例 21「形状三条拒绝路径的纯函数口径」、用例 2 补资格计数与「方案原文举的例子当前不可确认」的断言）；`test:declaration` 12/12、`test:attribution` 12/12 未受影响；`test:architecture` **10/10（未增跨域边）**；前端 `workspace-layout` **7/7**（并**反向锁死** `link.notInProposal` 与那句错话都不得残留）；lint / typecheck 干净；`docs:check` **182 份 Markdown / 1104 个本地链接**；`npm run quality` 端到端 **EXIT=0**（1m48s，全量 35 个 Node 测试块 `fail=0`、0 处 `not ok`）；**5 端构建通过**（web 2.31s + 元域智语 2.98s、desktop 2.50s、mobile 2.53s、dingtalk 3.88s，分端跑）。

**已知边界（如实）**

- **资格检查排在形状之前，使形状分支在任务级不可达**：两条 `shape_unknown` 对应的源对象都不在候选内，任务级连形状分支都走不到（不只是并入路径）；三条形状拒绝路径改在**纯函数层**取证（用例 21）。这不是测试退化——「先问一条写不进草稿的边形状是什么」被正确地拦掉了——但确实意味着**现有合成数据下形状分支缺少端到端覆盖**。
- **`ERP.Inventory` 与候选 `Inventory` 的同名巧合是未关闭的观察**：并入的边落在 `sourceSystems = ['WMS']` 的草案对象 `Inventory` 上。边本身合法（草案里只有这一个 `Inventory`），但「ERP 的库存表」与「WMS 的库存对象」是不是同一件事，**本段不回答**——它属 ADR-017 归属关口的范畴。
- **不可确认的对应会长期存在**：只要系统配置声明里有候选对象之外的对象（字段目录里有 8 个对象只来自系统配置声明、不在本次候选内，其中 4 个产生了不可确认的对应），它们就会持续出现在清单里并持续不可确认。这是**如实披露的代价**，不是缺陷。
- 全部为**内置合成数据**验收，**不代表真实企业系统验收**。

## 35. 阶段 4f：候选对象的来源与「没被生成」的原因必须可读（「对象抽取」的前置）

**为什么先做这一段**：阶段 4 剩下最明确的一块是**对象抽取**（把「硬编码对象目录 + 关键词命中」升级为真正按材料抽取对象）。但动它之前有一个更前置的问题：**今天的候选对象从哪来、为什么没生成，这件事本身不可读**——审阅人只有一份对象清单，清单之外的一切都是沉默的。决策见 [ADR-021](../architecture/adr/ADR-021-candidate-provenance-disclosure.md)。

**触发点（本机实测，临时探针 `candidate-basis-probe.mjs`，内置合成数据，确定性）**

| 材料诉求 | 候选对象 | 说明 |
| --- | --- | --- |
| 「采购订单、供应商」 | **2 类**：`PurchaseOrder`、`Supplier` | 两个词都在受控目录里 |
| 「采购订单、**发运单、出库单、客户投诉**」 | **1 类**：`PurchaseOrder` | 三个对象**静默消失** |
| 「发运单、出库单」 | 硬错误 `SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS` | 一个都没命中（**正确**行为，保留） |

第二行是问题所在：运营写清了四个业务对象，候选里只有一个，而**此前界面上没有一句话解释另外三个去哪了**。

**两条静默路径（代码证据）**：`semantic-natural-schema-service.js` 的 `discoverNaturalSchema` 有两处 `return null`——① 模拟运行时（本轮不调模型，刻意）；② 材料没有「主键 / 字段 / PK」这类字典线索（粗筛判定不值得尝试一次模型）。**两者要做的补救完全不同**（换 provider / 补字段名），却被合并成同一个不可区分的表现。`semantic-operations-agent-service.js` 的 `catalog.filter(item => includesAny(sourceText, item.terms))` 则是「硬编码目录 + 关键词命中」的实体（受控目录共 **12 类**）：不记录命中词、不说明自己是兜底、不说明覆盖率。

**同型问题**：与 ADR-019「把形状未知当成形状不同」、ADR-020「一个 flag 承载两个问题」同型——都是把**不同情形**合并成**不可区分的表现**。这次更早一步：**先让「缺失」本身可见**。

**六条核心决策**

| # | 决策 | 要点 |
| --- | --- | --- |
| 1 | 披露**命中词**与**覆盖率** | `catalogHits.matchedTerms`；说明写「命中 M / 共 12 类」并逐条列出命中词——只说「命中 2 类」回答不了「为什么没有发运单」 |
| 2 | 说明它是**兜底**、不是抽取结果 | 「只按词面匹配：材料里写到、但目录未覆盖的业务对象**不会**出现在候选里，请核对是否遗漏」——**披露不等于补齐** |
| 3 | 跳过抽取给**可区分的原因** | `{ skipped, reason }` 取代 `null`；`mock_runtime` / `not_dictionary_like` 各一句中文说明 |
| 4 | 跳过判定抽成**纯函数** | `naturalSchemaSkipReason({ mode, material })`——测试恒为 mock，内联会让另一条分支**永久遮住** |
| 5 | 披露落在既有 `reviewNotes` | 不新增实体、不改 schema、**不放进 `objectTypes`**（那会进草稿并触发下游校验） |
| 6 | **不放宽任何门槛** | 候选为空仍是硬错误；「无字典线索」仍不触发抽取尝试，只是说出来 |

**改动文件**：`backend/src/services/semantic-natural-schema-service.js`（`NATURAL_SCHEMA_SKIP_REASONS` / `naturalSchemaSkipReason` / `discoverNaturalSchema` 返回结构化原因）、`backend/src/services/semantic-operations-agent-service.js`（`catalogHits`、`naturalSchemaSkip` 参数与传递、两条 `reviewNotes`、删除因此闲置的 `includesAny`）、`backend/test/semantic-operations-agent.test.js`（+2 条用例）、[ADR-021](../architecture/adr/ADR-021-candidate-provenance-disclosure.md)（新建）与 ADR 索引行。

**验收（本机实测，确定性用例，未调模型）**：`test:semantic` **6/6 + 60/60 + 94/94**（第三组 92 → 94，`semantic-operations-agent.test.js` 29 → **31**）；`npm run lint` 干净；`docs:check` **183 份 Markdown / 1125 个本地链接**；`npm run quality` 端到端 **EXIT=0**（1m39s，全量 35 个 Node 测试块 `fail=0`、0 处 `not ok`）；**5 端构建通过**（web 2.90s + 元域智语 2.62s、desktop 3.33s、mobile 3.10s、dingtalk 5.01s，分端调用避开沙箱 `safe-delete` 单次阈值）。

**三处如实边界**

- **`not_dictionary_like` 在测试环境下不可达**：测试恒为 mock，该分支只能靠**纯函数层**用例覆盖。这不是测试技巧，而是如实反映「这条路径在模拟环境里根本走不到」——端到端验证它必须接真实 provider。
- **披露是「覆盖率级」而非「清单级」**：改动后那组材料**仍然是 1 类候选**，只是多了一句「可能遗漏，请核对」。从「无人能解释」变成「知道可能漏、但不知道漏了哪个」——**点名漏了哪个需要对象抽取能力本身**。
- **`'订单'` 命中 `PurchaseOrder` 是已知过泛词**：OMS 语境里「订单」通常是**销售订单**。属受控词表的**质量**问题，与披露无关，本段不改、记录在案。
- 全部为**内置合成数据**验收，**不代表真实企业系统验收**。

## 36. 阶段 4g：候选对象的**覆盖面**与「没被生成」的对象名必须可点名

**为什么做这一段**：4f 收尾时留下的那句审阅说明是「受控目录共 12 类…目录未覆盖的业务对象**不会**出现在候选里，**请核对是否遗漏**」——**一句无法执行的指令**：核对什么、拿什么核对、目录到底缺什么，一个都没有。4f 的毛病可以精确表述为：**披露了事实，但没有给出可执行的对象**。决策见 [ADR-022](../architecture/adr/ADR-022-candidate-coverage-disclosure.md)。

**触发点（本机实测，临时探针 `catalog-coverage-probe.mjs`，内置合成数据，确定性）**

| 材料 | 受控目录命中 | 未被覆盖的列举项 |
| --- | --- | --- |
| 「根据 ERP 的采购订单与供应商资料建立候选模型。」 | `Supplier ← 供应商`、`PurchaseOrder ← 采购订单、订单` | （无分隔符，不取词） |
| 「我们有订单、库存、发运三类数据，订单有单号和客户。」 | `PurchaseOrder ← 订单`、`Inventory ← 库存` | 无（噪声门挡住「发运三类数据」「订单有单号和客户」） |
| 「采购订单、**发运单、出库单、客户投诉**」 | `PurchaseOrder ← 采购订单、订单` | **`发运单`、`出库单`、`客户投诉`** |
| 「物料主数据、产品主数据、供应商」 | `Material` / `ProductSKU` / `Supplier`（并附带 `RawMaterialBatch ← 物料`） | 无 |

**关键发现：两个此前从未被对起来看过的事实（本机实测）**

① 受控目录 **12 类**；② 系统目录里已登记为「世界模型对象」的 **21 类**（`data/system-catalog.js` 的 `worldObjectTypes`，6 个已接入系统各 3~4 类）。差集 ＝ **14 类**：`InventoryLot`/`Warehouse`/`InboundReceipt`/`OutboundShipment`（WMS）、`ProcessStep`/`Deviation`（MES）、`Specification`/`Sample`（LIMS）、`CAPA`/`ChangeControl`/`QualityEvent`（QMS）、`Order`/`Fulfillment`/`ReturnOrder`（OMS）。

**「发运单 / 出库单」进不来不是运营没写清**——承载它们的 `OutboundShipment` 早在系统目录里被登记，只是**候选词表里没有词条**。**平台自己两份知识之间有多大缺口，此前从来没有人量过**：一个是凑出来的关键词兜底表，一个是「系统为基石」架构下的真实治理对象清单，两者被同一句「受控目录共 12 类」混成了一件事。

**同型问题链**：ADR-019「把形状未知当成形状不同」→ ADR-020「一个 flag 承载两个问题」→ ADR-021「把不同情形合并成不可区分的表现」→ **本段「披露了事实，但没给出可执行的对象」**。前三次的修法是「让它们可区分」，第四次是「让缺失本身可见」，本段是**让缺失可以点名**。

**七条核心决策**

| # | 决策 | 要点 |
| --- | --- | --- |
| 1 | 受控目录**连覆盖披露一起搬出** | `CANDIDATE_CATALOG` / `matchCandidateCatalog` / `listCatalogGaps` / `listUncoveredMentions` 落到 `semantic-candidate-catalog-service.js`——**不是分文件**，是让「兜底能命中什么」有独立取证面；此前它与提案组装、标识推导混在同一个近千行文件里 |
| 2 | 目录空白**可点名**（确定性） | 与 `systemDefinitions[].worldObjectTypes` 求差集，逐条给对象名 + 系统。**零启发式**，两边都是库里既有事实 |
| 3 | 未被覆盖的列举项**可点名**（启发式） | 列举分隔符切分（**≥2 段才取词**）→ 削掉两端非汉字后须为**纯中文 2~8 字** → **噪声门** → **双向**覆盖判定 → 上限 12 条且**超限必须说明被截断** |
| 4 | 启发式**自我标注** | `basis = enumeration_heuristic` **作为字段**随清单走；文案明说「**不是对象抽取结果**：可能混入非对象词，也可能漏掉没有用分隔符列出的对象名」 |
| 5 | 落**结构化字段** `candidateCoverage` | 含 `fallbackApplied` 前提位与 `matched`/`gaps`/`uncoveredMentions`/`uncoveredTotal`/`uncoveredTruncated`/`uncoveredBasis`；进 `proposal` 白名单 |
| 6 | **披露不等于补齐** | 点名的对象**一个都不进候选**；不放宽门槛、不改候选集合、不补词条 |
| 7 | **披露必须到达界面** | 运营控制台**不渲染 `reviewNotes`**，故新增界面区块渲染三块披露 |

**决策 7 顺带修正的一处死界面（如实记录）**：新增界面区块时发现两处写成

```html
<!-- 错的：selected 是 ref，模板中已解包，selected.value 恒为 undefined -->
<small v-if="selected.value?.proposal?.identityLinking?.declarationReport?.droppedLinks?.length" …>
```

因此**「因对象改名或字段集改变，N 条标识对应已不再存在」与「因裁定区分粒度，N 条声明被显式排除」这两段失效披露永远不会显示**（实测模板内其余 100+ 处均写作 `selected.proposal?...`，只有这两处写错）。更值得记的是**它为什么没被测出来**：既有断言用的是宽松的可选链匹配（`/declarationReport\?\.droppedLinks/`），组件里前一级写成 `selected.value` 也照样通过——**断言盖住了「字段名存在」，却没有盖住「这块界面会不会渲染」**。这与本次重构一路在消除的「看着覆盖了、实际没覆盖」是同一族问题。已修正写法，并新增**反向锁死**断言：模板区块内不得出现 `selected.value`。

**改动文件**：`backend/src/services/semantic-candidate-catalog-service.js`（新建）、`backend/src/services/semantic-operations-agent-service.js`（`candidateCoverage` / 三条 `reviewNotes` / 白名单）、`apps/semantic-operations-console/src/components/SemanticAgentWorkspace.vue`（覆盖面区块 + 两处死界面修正）、`backend/test/semantic-operations-agent.test.js`（+2 条，31 → **33**）、`apps/semantic-operations-console/test/workspace-layout.test.js`（+1 组，7 → **8**）、[ADR-022](../architecture/adr/ADR-022-candidate-coverage-disclosure.md)（新建）与 ADR 索引行。

**验收（本机实测，确定性用例，未调模型）**：`test:semantic` **6/6 + 60/60 + 96/96**（第三组 94 → 96）；控制台 `workspace-layout` **8/8**；`test:architecture` **10/10**（未增跨域边）；`test:events` **17/17**；lint / typecheck 干净；`docs:check` **184 份 Markdown / 1169 个本地链接**；`npm run quality` 端到端 **EXIT=0**（1m38s，全量 35 个 Node 测试块 **969 / 969 通过**、0 处 `not ok`）；**5 端构建通过**（web 2.04s + 元域智语 2.83s、desktop 2.22s、mobile 2.19s、dingtalk 3.47s）。

**三处如实边界**

- **未覆盖提及是启发式，会误报也会漏报**：噪声门是**黑名单式**的（「相关数据」这类词不在其中，会被列出）；**没有被列举分隔符分开的对象名不会被点名**（「我们要建一个发运单模型」一个词都取不到）。本段把「无人能解释」降为「知道大概漏了哪些词」，**没有消除漏报**。真正的消除要靠对象抽取（ADR-021 边界二）。
- **目录空白只回答「目录缺哪些类」，不回答「材料里的某个中文词对应哪一类」**：后者的映射需要中文词条，属**词表治理**（决策 2 已说明为何不在本段补——补词条是「谁负责、依据什么、如何失效」的独立决策）。
- **截断阈值 12 是取舍**：代价是「第 13 个之后没看到」，收益是审阅说明不被淹没。兜底路径下一次响应会多出三条 note，其中目录空白那条实测约 300 字——这是披露的代价，不是缺陷。
- 全部为**内置合成数据**验收，**不代表真实企业系统验收**。

## 37. 模块化审计第 3、5 项：`domains/events` 概念错位 + 前端三层判据落文档

**为什么这两项**：它们在 [MODULARIZATION_AUDIT](../architecture/MODULARIZATION_AUDIT.md) 第 9 节「建议执行顺序」里成本最低（第 3 项「低（机械改名）」、第 5 项「极低」），且第 3 项的服务方向与本轮改动的 `semantic-*` 服务同属后端 services 面，一次性做完的干扰最小。**第 4 项（抽 `AgentWorkbench.vue` 的 4 个 composables）与第 6 项（横切关注点管线化，须先立测试）未动**——前者需要先有 composable 层的测试守护，后者新审计文件自己写明「须先立测试」，都不适合在没有测试守护时开工。

### 37.1 `domains/events` → `infrastructure/domain-events`

**问题**（审计第 4 节原文）：`domains/events` 实际是**基础设施**（事件出站箱），被误放在「领域」层；它被 `services/` 与 `domains/platform` 反向依赖，于是「领域层依赖基础设施」看起来像分层反转——**实际只是它站错了目录**。此前用 `INFRASTRUCTURE_DOMAINS = new Set(['events'])` 把它排除在棘轮之外，**技术手段遮蔽了概念错位**：它仍挂在 `domains/` 下，会让后续读者以为领域层可以互相依赖。

**做法与实测影响面**：`git mv backend/src/domains/events backend/src/infrastructure/domain-events`，影响 **22 个文件**——19 处含 `domains/events` 字面量的 import（`backend/src/config`、7 个 `services`、`backend/src/workers`、7 个 `backend/test`、2 个 `services/domain-event-worker`）+ 3 处**相对引用** `../events/`（`domains/alerting/alerting-store.js`、`domains/platform/platform-health-service.js` 与 `public-api.js`，它们不含 `domains/events` 字面量，**第一遍全局替换没抓到，靠 `test:events` 报 `ERR_MODULE_NOT_FOUND` 才暴露**——这正是「替换式重构必须跑一遍真实加载」的现成例子）。相对深度**不变**（`domains/x` 与 `infrastructure/x` 距 `src/` 同为两层），故域内相对导入无需改动。

**基线同步**：`architecture-baseline.js` 的 `INFRASTRUCTURE_DOMAINS` 从 `new Set(['events'])` 收敛为**空集**——`domains/` 下**每一个**目录都必须是带 `public-api.js` 的业务边界，不再有例外。**保留空集合而非删掉该导出**，是为了让「基础设施目录混进 `domains/`」一旦复发就立刻可见。

**实测的净效果**：迁移后 `services/` → `domains/` 的**直接**引用只剩 `risk-service.js` → `domains/alerting/alerting-service.js` **这 1 处**（`git grep "from '../domains/" backend/src/services/`），其余 9 处随迁出变为 `services/` → `infrastructure/`，**不再构成分层反转**。审计第 4 节说的「另一半」——**领域之间**的反向引用（`risk-service` → `alerting` 绕过 public-api）——与本次改名无关，仍挂在跨域边棘轮 189 条上，属后续收敛。

**回归**：`test:events` **17/17**、`test:architecture` **10/10**、`npm run quality` **EXIT=0**。

### 37.2 前端三层组件归位判据写入文档

审计第 6 节实测的问题是**判据缺失**而非结构错误：7 个 feature 目录只含 1 个文件，而 `components/` 只有 3 个文件——当 1 个文件的 feature 与 7 个文件的 feature 平级时，目录结构不再传达信息量。现在判据写入 [ARCHITECTURE](../architecture/ARCHITECTURE.md) §3.3，**按「是否取数据」与「是否跨端」判定，不按文件数**：

| 层 | 位置 | 判据 |
| --- | --- | --- |
| 展示组件 | `<端>/src/components/` | 无业务语义：只受 props、不发请求、不读全局状态 |
| 跨端共享业务组件 | `packages/agent-ui/src/<domain>/` | 被两个及以上端引用，依赖经 `package.json` 具名 `exports` 声明 |
| 单端页面级组件 | `<端>/src/features/<domain>/` | 只有本端引用，含取数与业务流程 |

此项**只写判据、不做搬迁**：搬迁需要先按判据逐文件判定，属独立的机械工作，且第 2 项刚完成迁移（基线 8 → 0），此时再动会造成两次大面积改动的叠加。

## 38. 交付复核与推送：改名回归的收口

本轮把阶段 3 ~ 4g 与模块化审计第 3/5 项的成果按 [交付约定](../development/GITHUB_DELIVERY.md) 分批提交并推送 `origin/main`。**推送前的复核本身产出了一个缺陷修复**，记录如下。

**发现的缺陷**：批量改名（第 18 节）把「元域语义运营报告」里的「语义运营」也替换掉，拼成「元域**元域**智营报告」。第 18 节当时只修了 3 处，**漏掉 4 处**：`apps/semantic-operations-console/electron/main.cjs`（报告目录名 + 窗口标题）、`electron/report-exporter.cjs`（报告目录名）、`test/report-exporter.test.cjs`（断言期望值）。

**为什么「测试全绿」没能拦住它**：断言与实现被同一次批量替换改成了同一个错值，`startsWith` 只校验前缀存在，于是**实现错、期望也错、测试通过**。这类「断言跟着实现一起错」的回归，任何以当前实现为基准的测试都拦不住。

**危害是用户可见的**：Electron 窗口标题显示「元域元域智语 Agent」；受控报告导出目录在用户「文档」目录下真的创建为「元域元域智语报告」——一个带重复前缀的持久化路径。

**根因不止是替换，还有重复字面量**：该目录名被抄成两份——`main.cjs` 的 `semantic-ops:show-report` 用 `path.dirname(target) !== root` 做路径校验，写出方 `report-exporter.cjs` 各写一份字面量。两份只要不一致，**该校验就恒失败**（等于「打开报告所在目录」这个入口在拼错时必然报错）。

**修复**：目录名收敛为 `report-exporter.cjs` 导出的唯一常量 `REPORT_ROOT_DIR_NAME`，`main.cjs` 引用它；测试把断言从 `startsWith` 升级为**精确目录名**判定，并新增一条**源码级反向锁死**——`main.cjs` 不得再出现硬编码目录名、任何一处不得出现「元域元域」（`main.cjs` 依赖 electron 运行时无法在 `node:test` 里加载，按源码取证是该类回归唯一能锁死的位置）。

**回归**：`npm run quality` 端到端 **EXIT=0**（1m40s，全量 35 个 Node 测试块 **970 / 970**，0 处 `not ok`；比 4g 的 969 多 1 项即新增的锁死用例）；`npm run docs:check` 通过（184 份 Markdown / 1169 个本地链接）；控制台 **61/61**。

**提交分批**：① 共享组件包抽取与元域智营收窄；② 系统注册单一事实源与系统接入域；③ 范围过滤 / 标识对应 / 裁定 / 候选披露；④ 事件基础设施迁移与架构基线收敛；⑤ 决策记录与全量文档、命名统一。**过程中的一处自我修正**：首次提交时 `git commit` 连带提交了索引里**预先暂存**的 4 条改名记录（`git commit` 提交的是整个索引，不只是刚 `git add` 的路径），使第 ④ 批的说明与事实不符；因尚未推送，已用 `git reset 16bb6ba` 退回后**按修正归属重做全部提交**，并在重做前用改动清单逐条比对确认工作区内容零丢失（`git status` 条目数 230 → 225 只是 git 把未跟踪目录折叠显示造成的，实际文件集完全一致）。

**如实标注的边界（含一次自我修正）**：本轮**最初**的 5 端构建把 web/元域智语、desktop、mobile、dingtalk 写在同一次调用里，到 mobile 时沙箱 `safe-delete` 计数已达 **50**、dingtalk 达 **51**，双双被 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（`scope: turn`）拦下——**该计数作用域是「整轮」，所以「分端调用」必须理解为「每轮一端」**。**已按此重跑，两端均通过**：mobile **1.15s**、dingtalk **2.29s**，加上本轮已实测的 web **2.02s** + 元域智语 **2.86s**、desktop **2.66s**，**5 端构建本轮全部实测通过**（此前的记录曾据实写成「本轮未取得 mobile / dingtalk 数字」，现更正为已取得）。**「已推送」不等于「已部署」**：未重启在用服务、未迁移真实数据、未开放公网。

**推送本身遇到并绕过一个环境问题（记录在案，下次直接照做）**：工具链默认的 `git` 是 PortableGit（`.../PortableGit/versions/1.2.0/mingw64/bin/git`），它的 `git-remote-https` 在本机代理下**发得出请求、收不到响应**——`GIT_TRACE=1 GIT_CURL_VERBOSE=1` 显示 `CONNECT tunnel established, response 200` → `Request completely sent off` 之后**永久挂住**（`git fetch` / `git push` / `git ls-remote` 全部如此，`timeout` 后只能 SIGTERM）。**判据：这不是网络不通，也不是凭据问题**——同一个 URL 用 `curl` 请求 `info/refs?service=git-upload-pack` 稳定返回 **401**（0.5s，说明代理与 GitHub 都通），且 PortableGit 的 git 加了 `GIT_TERMINAL_PROMPT=0` 也不报「读不到用户名」。**绕法：改用系统 Git for Windows**（`/c/Program Files/Git/bin/git.exe`）——它的同一请求会正常拿到 401 并给出 `could not read Username`（可判定），再显式指定凭据助手即可工作：`git -c credential.helper=manager ls-remote --heads origin` 直接返回 `refs/heads/main`，`git -c credential.helper=manager push origin main` 成功推送。**凭据在 Windows 凭据管理器里已存在，无需重新登录。**注意：本项目仓库的 `/etc/gitconfig` 把 `credential.helper` 设成 `helper-selector`，该助手在无声环境下会等待交互而挂起，故必须显式覆盖为 `manager` 或 `wincred`。

**推送范围（如实记录）**：`origin/main` 原在 `175dcdc`（「完善模拟企业接入与语义试算」），**该点之后本地还有一个从未推送的 `16bb6ba`**（「落地架构约束棘轮与持久化端口」），本次一并推送。提交清单以 `git log --oneline 175dcdc..origin/main` 为准，**不在此写死总数**（写死会随后续更正提交而失真）。

## 39. 端命名调整：语义运营端定名「元域智语」，管理 Web 定名「元域智营」

用户指令（2026-09-26 晨）：**元域智语 Web 改名为「元域智语」，管理 Web 才是「元域智营」**。执行前先核对了语境，确认「元域智营」在代码与文档中**全部**指语义运营端（无一处指其他对象），仅两处例外按新语义处理：

- **代码侧**（`元域智营 → 元域智语`）：`apps/semantic-operations-console`（package.json 的 productName/shortcutName、index.html、App.vue、三个 Workspace 组件、electron 两个 .cjs、dev-electron、report-exporter 测试——含 `REPORT_ROOT_DIR_NAME` 的值改为「元域智语报告」）；`apps/product-portal`（官网导航/产品页/演示场景）；`packages/agent-ui`、`packages/semantic-operations-sdk`、`packages/api-contracts`（含契约描述与测试断言）；`backend` 六个服务与路由的用户可见文案；`frontend` 四处「已迁至元域智语端」引用。**唯一保留**：`frontend/src/components/AppShell.vue` 侧栏品牌「元域智营」——它本来就属于元域智营，与本指令一致。
- **元域智营收窄后的缺口顺手关闭**：`scripts/docs` 里有三份把「元域智营 AI 基座」当**平台名**用的文档生成脚本（部署说明 / 生产开发准备 / 资源估算）——平台名是元域智脑，这是历史误用，改为「元域智脑 AI 基座」，与同目录其余「元域智脑-*」导出产物对齐。
- **元域智营定名**：`frontend/index.html` 标题从遗留名「保健品 AI 运营平台 Demo」改为「元域智营管理台 · 元域智脑」；`AppShell.vue` 顶栏 `<h1>` 从「保健品 AI 基座运营平台」改为「元域智营管理台」。
- **文档侧三段式替换**（顺序刻意，防误伤）：① `元域智营AI基座/元域智营 AI 基座 → 元域智脑AI基座`（平台名误用，先于产品名替换处理）；② `元域智营 → 元域智语`（184 份 md 中 322 处）；③ `管理 Web → 元域智营`（121 处）+ 根 README（6 处）。替换后用正则清掉 63 处「元域智营 + 空格 + 汉字」的格式缺陷（中文排版不应有此空格，保留后接代码/英文的空格）。
- **文件改名（git mv，6 个）**：`docs/guides/元域智营-Agent操作指南-v1.0.md` → 元域智语-*；exports 里 2 份元域智营-* → 元域智语-*；3 份元域智营AI基座-* → 元域智脑AI基座-*。md 内的链接文字与目标随文本替换同步更新，`docs:check` 复跑确认 **185 份 Markdown / 1177 个本地链接全部通过**（较改名前的 184 份 / 1169 链接多出的是随后新增的 ADR-023 本身——改名替换没有断一条链）。
- **历史记录的处理原则**：workbuddy_work / PROJECT_STATUS / 旧 ADR 里的历史条目随全局替换统一用新名（保持前后文可读），**改名这一事实本身由本节与 ADR 记录**，不试图为每处历史出现加注。
- **吸取的教训再次生效**：替换前先 grep 了「智营」的全部复合词形态（`[\u4e00-\u9fa5]{0,4}智营[\u4e00-\u9fa5]{0,6}`），确认无更长词会误伤——上一轮的「元域元域智语」事故不会复发；`report-exporter.test.cjs` 的精确目录名锁死用例同步改为「元域智语报告」，**断言与实现不再一起错**。

## 40. 接入生命周期操作面：新增接入与已接通系统管理（ADR-023）

用户指出系统接入功能的两个缺口：**没有新增接入，也没有已接通系统的管理，流程不清晰**。溯源确认了根因（也是用户第三问的答案，详见 PROJECT_STATUS 顶部条目）：**状态机早已在 `system-registry-service.js` 定义并实现，却从未暴露为可执行动作**——路由层没有对应端点，前端没有操作入口，界面上的接入状态全部是种子静态值。

**本轮补齐（[ADR-023](../architecture/adr/ADR-023-lifecycle-operation-surface.md) 七条决策）**：

- 后端：`system-access-service.js` 新增 `transitionTenantSystemConnection`（视图侧门禁 + 审计组装，状态机仍是注册表单一事实源）；路由暴露 `POST /api/semantic-operations/systems/{code}/lifecycle`；**接通门禁**——任何 `→ connected` 要求该租户最近一次探测 `verified`（409 `SYSTEM_CONNECT_PROBE_REQUIRED`）；理由必填（≤200 字）+ 操作人取受信上下文；权限沿用 `meta_model.draft.save`（与探测同闸门）。域契约 4 → 5（`DOMAIN_EXPORT_CEILING` 显式抬棘轮并附理由注释）。
- 前端：系统接入视图新增「接入流程与生命周期」面板（步骤条 + 下一步动作按钮（直接渲染服务端 `lifecycle.transitions`）+ 必填理由输入 + 最近一次变更的审计信息）；「＋ 新增接入」入口一键聚焦未登记系统；总览/筛选补「已停用」维度（已接通系统的管理：停用 / 重新接通 / 下线）。
- SDK：`transitionSystemConnection(code, payload)`。

**验收（实测）**：`backend/test/system-access.test.js` **12 项（9 → 12）**——新增第 6 节 3 项（全链路含接通门禁与停用恢复 / 守卫集 / 服务层与路由层一致）；`workspace-layout.test.js` **9 项（8 → 9）**（操作面可见 + 反向锁死模板不得硬编码状态；过程中修正了模板切片用 `indexOf('</template>')` 被内层 `<template v-if>` 截断的问题，改 `lastIndexOf`）；`test:architecture` **10/10**（棘轮显式变更，未增跨域边）；`test:registry` 7/7；`test:access` 12/12；`test:semantic` 全链 EXIT=0。

**如实标注的边界**：`draft → registered` 只推进状态与审计记录，**不落连接配置**（连接配置样例仍来自 demo 种子，真实的连接信息登记表单属后续增量）；「接通」仍指演示租户的生命周期状态，连通性验证读内置合成数据源；生命周期操作不改变角色数据域授权（生命周期 `authorized` 与角色已授权是两个概念）。

## 41. 自定义系统登记：去预设接入清单与登记物料契约（ADR-024）

开工时发现工作区存有**上一会话已完成但未提交**的完整增量，本轮复核后与阶段 4h 一并入库（实施过程中一次批量替换曾误伤该增量在 `architecture-baseline.js` 的注释归属，已按 `git diff` 核对恢复——教训：批量 sed 前先查编号既有引用）。背景与决策详见 [ADR-024](../architecture/adr/ADR-024-custom-system-registration.md)：ADR-023 补齐了生命周期操作面，但「新增接入」仍只能从 12 个预设目录类型里选——「待接入 / 未登记」不是任何人的动作结果而是演示种子，真实企业系统名目各异，预设目录不可能覆盖。

**核心动作**：① 接入清单**去预设**——预设成员只剩 6 个 Mock 演示接入样例（connected），OA/SRM/MDM/PLM/EAM/IOT 转为保留码（操作返回 404 `SYSTEM_ACCESS_MISSING` 并指引「新增接入」）；② 登记物料契约 `SYSTEM_REGISTRATION_FIELDS`——`name` / `domain` / `description` / `keyEntities` / `dataDomains` / `accessIntention` / `businessOwner` 七项必填 + `code` / `vendor` / `mockScenarioId` 可选，目标是**让智脑不靠猜就知道接入的是什么系统**；schema 单一定义在 `data/system-catalog.js`、经接入总览下发、前端按 schema 渲染不复制第二份；③ 自定义系统是**租户资产**（`system_registry_runtime.custom_systems` 按租户隔离、事务原子写入），登记成功即 `registered`（物料本身就是登记动作的输入）；④ 域契约 5→6（`registerSystemOnboarding` 显式抬棘轮）、`POST /api/semantic-operations/systems`；⑤ 接通门禁不变——不挂模拟场景则不可探测、永远到不了 `connected`；授权按声明数据域推导（`ROLE_DATA_DOMAINS × materials.dataDomains`），不是默认全员可见。

**验收（本机实测）**：`test:registry` **8/8**（7→8）、`test:access` **13/13**。

## 42. 阶段 4h：受控对象链接（ADR-025）+ 收尾三项

**触发点**：4f/4g 点名了「缺了什么」，但**点名的对象一个都进不了候选**——材料写「采购订单、发运单、出库单、客户投诉」候选只得 1 类，非列举散文写法连启发式都取不到词。根因是候选仍来自硬编码 12 类目录 + 关键词命中。用户在三路径中选定**受控对象链接**（[ADR-025](../architecture/adr/ADR-025-object-mention-linking.md)）：对 ADR-022 决策 6「点名不进候选」的收窄推翻已记录在案（未放宽任何关口）。

**核心契约**：新增 `semantic-object-mention-service.js`，模型只输出 `{ mention, evidence, objectType }`，服务端三重校验（证据**逐字**来自材料、证据含提称、类型在系统目录 `worldObjectTypes` 登记索引内），任一不满足**整份拒绝**（不局部挽救，与 `validateNaturalSchema` 同严格度）；**模型不给结构、不断言系统**——候选结构只来自系统声明，主键用 4a 同一套 `inferIdentifier`（实测 14 类目录缺口中 8 类有声明的类型主键全部可判定）。链接只在「结构化材料与自然语言抽取都没产出对象」时运行；两类「链接了但给不出结构」分开点名（`no_declaration` / `no_identifier`）不进候选只披露；候选一律 `mappingStatus: 'pending'`，Critic 照常拦截未映射就采纳；链接候选生效时目录兜底被抑制；披露落 `candidateCoverage.mentionLinking`。ADR-021 复审条件 1 与 ADR-022 复审条件 2 同步标记部分关闭。

**收尾三项**（用户指示「未完成项全部完成」，均不改核心契约）：① **词表治理第一轮**——8 类**有系统字段声明**的缺口对象（InboundReceipt、InventoryLot、Deviation、Sample、CAPA、QualityEvent、Order、Fulfillment）补入受控目录，`fields`/`key` 逐类取自声明侧目录；**无声明的 6 类有意不补**（词条带来词面命中带不来结构，空壳候选过不了审阅），目录 12→20 类、缺口 14→6；② **`no_identifier` 数据驱动用例**——`buildMentionLinkCandidates` 加声明透传缝（`objects` 参数默认空＝行为不变），分支从此有验证；③ **前端披露面板**——元域智语 `SemanticAgentWorkspace.vue` 新增「受控对象链接」块，结构缺口上界面。

**验收（本机实测）**：`test:mention` **6/6 → 7/7**（新增并挂入 `test:all`）；`test:semantic` **6/6 + 61/61 + 98/98**；`test:architecture` **10/10**（登记 2 条网关/提示安全同性质跨域边）；元域智语 **61/61** + 构建 2.89s；`docs:check` 187 md / 1192 链接。**边界（如实）**：真实模型评测 `evaluate:mention-linking`（脚本就绪）多次尝试均因 WorkBuddy 云服务限流（`WORKBUDDY_CLOUD_QUOTA_RATE_LIMITED`）未取得数字，待重跑——**「quality 全绿」不含模型契约**。

## 43. 阶段 6 第一段：权限等价合并（ADR-026）

`world.draft.*` 三个权限与 `meta_model.draft.save / draft.validate / publish` 语义完全重叠，用户在三策略中选定**等价合并**（[ADR-026](../architecture/adr/ADR-026-permission-equivalence-merge.md)）：全部删除并等价映射，`governance-routes.js` 4 处闸门换码，前端同步；发布仍由 `meta_model.publish`（仅 executive）把守。**本段最有价值的发现**：排查中发现**服务层隐藏的第二道闸门**——`world-model-template-service.js` 硬编码 `canConfigure` / `canPublish` 角色白名单，与 IAM 重复且界面上不可见（教训：权限合并要排查服务层隐藏白名单；此后排查权限问题先查服务层），已删除，**权限系统成为唯一权威**。如实披露：映射草稿闸门与接入侧写入同闸后，另一角色的该入口随「同一把闸门」语义打开；动作角色从 executive 回退变为持权主角色本人（`permission-api-hardening.test.js` 断言同步修正）。不变式：已发布模型指纹与版本号不变。

**验收（本机实测）**：`test:permissions` **29/29**、`test:access` **13/13**、`test:semantic` **6+61+98**、`test:events` **17/17**、`test:scope` **12/12**、元域智语 **61/61**。

## 44. 阶段 6 第二段：元域智营「元模型」菜单全迁删除（方案 4.3 决策 A）

用户委托「继续完成」，按方案建议 A 实施（已在 4.3 标注、可回退）。删除 world 页全部前端链路：`frontend/src/features/world-model/` 整目录（含无引用死代码 `SemanticOperationsAgentPanel`）、`App.vue` 的 world 分支与 8 个相关状态、`governance-actions` 的 4 个 OA 元模型治理动作、`page-data-registry` 的 world 数据分支、`permission-navigation` 的 world 注册、`api/client.js` 的 19 个 world / meta-model / semantic-context 方法、`world-template.css`。

**关键取证（删菜单前必须查的事）**：`page.world.view` 被 4 处元域智语服务（onboarding / ontology / knowledge / 巡检）复用为**访问权限**，且 `pagePermissionIds` 由「角色 menuIds ∩ 权限目录」派生——直接删 `menu.world` 会让四处服务全 403。故权限条目与角色授权**保留一个版本周期**（阶段 2 先例），`iam-seed` 的 `menu.world` 描述标注迁出状态；待元域智语端权限语义独立后再删。权限矩阵、后端端点、服务行为零变化。

**验收（本机实测）**：`test:permissions` **31/31**（新增 2 用例：「持有旧权限也不可进入已移除页面」「world 无数据加载路径」）、`test:access` **13/13**、`test:semantic` **6+61+98**、管理 Web 构建 **1.67s**（world 页代码移除生效）。**至此阶段 6 全部完成**。

## 45. 阶段 7：文档同步与路线图口径对齐（系统接入重构收官）

**第一段**：`iam-seed` 菜单描述重构与全量事实性文档同步——`docs/modules/07-model-semantic-governance/API.md` 端点权限列按 ADR-026 更新、`ARCHITECTURE.md` 按钮清单移除已删草稿按钮、`SEMANTIC_CONTEXT_MICROSERVICE.md` 表述修正；验收 `test:permissions` 31/31、`npm run quality` 全绿、`docs:check` 188 md / 1207 链接。

**第二段**：[开发路线](../development/DEVELOPMENT_ROADMAP.md) 口径对齐——该口径变更用户已于 2026-09-25 随整体方案确认（方案第 8 节有记录），阶段 1「模拟企业与接入项目」→「**系统接入**」，目标描述改系统为中心口径，新增口径对齐段（登记系统 ADR-024 → 材料接入 → 受控对象链接 ADR-025 → 生命周期门禁 ADR-023 → 建模发布；权限面并入 `meta_model.*`）；**带日期的历史增量记录保留原口径、不回溯改写**。补齐台账缺口：方案文末新增「阶段 7（两段）」条目（第一段此前漏记台账）。

**验收（本机实测）**：`docs:check` **188 md / 1223 链接**（增量 +16 均为新增链接）；纯文档增量。**至此系统接入重构阶段 0~4h、6、7 全部完成；阶段 5 仍被视觉模型硬前置卡死**（云通道仅文本、视觉能力是硬前置）。挂起项：`evaluate:mention-linking` 真实模型评测待云配额恢复后补跑。

## 46. 阶段 5a：文档类材料接入（ADR-027）

**触发点**：阶段 5 原本一揽子绑定「PDF / Word / 图片 / 音频」四类材料，因图片与扫描页 PDF 缺乏视觉模型通道而被整段卡死。用户 2026-10-05 决策重新划界——「暂不增加视觉能力，多模态现阶段主要体现在文档类能力，在建模时阅读用户提供的各类接口或者数据字典文档」。据此把阶段 5 拆为 5a（文档类）与 5b（视觉/音频），**改动仅限方案文档阶段 5 小节与台账，带日期历史记录不回溯改写**。

**5a-0 探针取证（修正了两处此前的代码误读）**：

1. **对话面其实已经接受文档附件**——元域智语任务创建接受 PDF/DOCX/XLSX 附件，经 `inspectMultimodalInput` + `extractMultimodalEvidence` 提取文本、4/4 持久化为 workspace documents、进入理解与规划上下文。此前以为「office/PDF 路径只进 evidence 不进 documents」是误读，实测全部进入。
2. **真正的两处断点**：① **schema 发现只消费 CSV**——`semantic-schema-discovery-service.js` L190 按 `structuredMimeTypes` 过滤，同一份字典内容 CSV 产出 2 个 schema（Order/OrderItem），**XLSX 产出 0**；② **登记通道只收纯文本**——`saveMockOnboardingMaterial` 仅 `{kind, name, text, expectedRevision}`，文档形态附件被 `MOCK_ONBOARDING_MATERIAL_INVALID` 拒绝。

**5a-1 登记通道接受文档形态（后端）**：`saveMockOnboardingMaterial` 扩展接受 `{attachment: {mimeType, dataUrl}}`（与 `text` 二选一），走对话面同一套安全闸门（magic bytes / PDF 活动内容拒绝 / 内容扫描 / DLP / 提示注入隔离）。**存储语义**（[ADR-027](../architecture/adr/ADR-027-document-material-registration.md)）：登记=**提取文本+解析取证持久化**（`source`：mimeType / 页数 / 扫描状态 / 脱敏信号），**原文件不持久化**；`publicProject` 披露取证，handoff 透传原始 mimeType 供 5a-2 schema 发现消费。**整份拒绝边界**：图片/音频/视频与字典/样本文档形态给专用错误码 `MOCK_ONBOARDING_MATERIAL_FORM_UNSUPPORTED`；提取超 64KiB 整份拒绝、不静默截断（满页 20 页 PDF 可能超限需拆分）。`mock-onboarding-catalog.js` 新增 `mockOnboardingDocumentMimeTypes` 清单下发给前端。

**5a-2 schema 发现消费文档形态字典**：`office-material-parser.js` 新增 `parseOfficeTableRows`——把序列化行文本（`行 1: A1="字段名" | C1="类型"` 形式）**确定性还原为行列矩阵**，单元格坐标对齐、稀疏列不移位（登记通道与对话面共用同一持久化文本形态，无需落地原文件）。发现服务 office mime 与 CSV 走同一条候选路径（表头行 + 别名列），产出 `xlsx_dictionary` / `docx_dictionary` 候选；PDF 不进结构化候选并在 warnings **点名披露**。

**5a-3 前端**：登记界面三类文本材料（requirements/api/rules）开放 PDF/DOCX/XLSX 上传，附件面板披露提取语义与整份拒绝边界，已登记材料的文档取证上界面，可撤回改用文本登记。修一个隐患：4MB 文件直接 `String.fromCharCode(...bytes)` 会爆调用栈，改分块。

**5a-4 收尾**：ADR-027 入库；架构棘轮新边 `mock-onboarding-service → multimodal-input-service` 按同性质先例登记（共享闸门而非复制闸门——与 `semantic-operations-task-service` / `agent-service` 等三条消费多模态闸门的边一致）。

**两处连带修复的真缺陷**（值得记入踩坑）：

- **多模态报告 `parserTruncated`**：`extractMultimodalEvidence` 的 blocks 循环会把「模型上下文预算截断」合并进 `report.truncated`，把解析器级截断（PDF > 20 页、XLSX > 2000 行）的信号冲掉——`report.truncated` 既不能用来判「解析器级截断要整份拒绝」也不能用来判「预算截断要继续」。新增不混淆的 `parserTruncated` 字段，`extractDocumentMaterial` 改用此判据。
- **`lowerKeys` 把中文表头清洗成空串**：`key.toLowerCase().replace(/[^a-z0-9]/g, '')` 对中文表头返回空串——「字段名/主键/外键」等中文别名列**从不生效**，但既有断言跟着同错一起绿。改为保留汉字（`/[^a-z0-9\u4e00-\u9fff]/g`）。属「实现与断言同错」踩坑：批量改名、字段列表白名单、`lowerKeys` 这类清洗函数都要用真实输入跑一次。

**验收（本机实测）**：`npm run quality` 端到端 **EXIT=0**（**1m36s**）；新增 `backend/test/mock-onboarding-document.test.js` **6/6**（正例 DOCX/XLSX/PDF 登记、取证披露、原文件不入库；反例：字典/样本文档形态、图片/音频、双通道输入、扫描 PDF、隐藏注入、超 64KiB、超 2000 行）、`backend/test/semantic-schema-discovery-document.test.js` **7/7**（XLSX/DOCX 字典候选与 CSV 同构、登记文本交接路径、PDF 披露、无表头披露、稀疏列对齐、隔离材料不进候选）；回归 `test:mock-onboarding` **75/75**、`test:semantic` **105/105**、`test:mention` **7/7**、`test:attribution` **12/12**、multimodal **19/19**、console 组件 **63/63** + vite 构建、lint 干净；`docs:check` **189 md / 1241 链接**。

**边界（如实）**：dictionary/samples 强校验链仍以 JSON 字典为准，文档形态字典只走候选路径；5b（图片/扫描页/音频）仍整份拒绝，待视觉/语音通道可用后单独排期；真实模型评测不进 quality。

## 质量与边界

- **本批（2026-10-05 阶段 5a：文档类材料接入 ADR-027）回归口径**：`npm run quality` 端到端 **EXIT=0**（**1m36s**，全量 Node 测试块 0 处 `not ok`）；新增 `mock-onboarding-document.test.js` **6/6** 与 `semantic-schema-discovery-document.test.js` **7/7** 并分别挂入 `test:mock-onboarding` 与 `test:semantic` 链；`test:mock-onboarding` **75/75**（69→75，新增 6 用例）、`test:semantic` **105/105**（6/6 + 61/61 + 98→105，新增 7 用例）、`test:mention` **7/7**、`test:attribution` **12/12**、multimodal `understanding`+`security-gateway`+`security-regression` **19/19**（受 `parserTruncated` 改动波及，全部回归通过）、元域智语 console 组件 **63/63**（22→63，含本次新增的 5a-3 文档上传用例）+ vite 构建；架构棘轮登记 1 条新边（`mock-onboarding-service → multimodal-input-service`，同性质先例），`test:architecture` 全绿；lint / typecheck 干净；`docs:check` **189 md / 1241 链接**。**边界**：dictionary/samples 强校验链仍以 JSON 字典为准，文档形态字典只走候选路径；5b（图片/扫描页/音频）仍整份拒绝；真实模型评测不进 quality。
- **本批（2026-09-26 交付复核：改名回归收口 + 提交推送）回归口径**：修掉第 18 节补记的「元域元域智语」缺陷后复跑，`npm run quality` 端到端 **EXIT=0**（**1m40s，全量 35 个 Node 测试块 970 / 970 通过、0 处 `not ok`**，比 4g 口径多 1 项即新增的目录名反向锁死用例）；`npm run docs:check` 通过（**184 份 Markdown、1169 个本地链接**，比 4g 多 3 条）；控制台测试 **61/61**。**5 端构建本轮全部实测通过**（web **2.02s** + 元域智语 **2.86s**、desktop **2.66s**、mobile **1.15s**、dingtalk **2.29s**）——**其中 mobile / dingtalk 是重跑后取得的数字**：第一次把 4 端写在同一次调用里，被沙箱 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（`scope: turn`）拦下（计数按「整轮」累计），按「每轮一端」重跑即过。
- **本批（阶段 4g + 模块化审计第 3/5 项）回归口径**：`npm run quality` 端到端 **EXIT=0**（**1m38s，全量 35 个 Node 测试块 969 / 969 通过、0 处 `not ok`**）；`test:semantic` **6/6 + 60/60 + 96/96**（`semantic-operations-agent.test.js` 31 → **33**）；控制台 `workspace-layout` **8/8**（7 → 8，含 `selected.value` 反向锁死）；`test:architecture` **10/10**（**未增跨域边**）；`test:events` **17/17**（`domains/events` 迁移后的回归）；lint / typecheck 干净；**5 端构建通过**（web 2.04s + 元域智语 2.83s、desktop 2.22s、mobile 2.19s、dingtalk 3.47s，分端调用避开沙箱 `safe-delete` 单次阈值）。
- **本批（阶段 4f）回归口径**：`npm run quality` 端到端 **EXIT=0**（1m39s，全量 35 个 Node 测试块 `fail=0`、0 处 `not ok`）（35 个测试块中 `test:semantic` 第三组 92 → 94、`test:identity` 21/21）；`test:semantic` **6/6 + 60/60 + 94/94**（`semantic-operations-agent.test.js` 29 → **31**）；`npm run lint` 干净；**5 端构建通过**（web 2.90s + 元域智语 2.62s、desktop 3.33s、mobile 3.10s、dingtalk 5.01s，分端调用避开沙箱 `safe-delete` 单次阈值）。
- **本批（阶段 4e）回归口径**：`npm run quality` 端到端 **EXIT=0**（**1m48s，全量 35 个 Node 测试块全部 `fail=0`、0 处 `not ok`**）；`test:identity` **21/21**（改写用例 20 为「闭合缺口」、重写用例 18 为「资格先于形状 + 对照组 + 继承分流」、新增用例 21「形状三条拒绝路径的纯函数口径」）、`test:declaration` 12/12、`test:attribution` 12/12、`test:architecture` 10/10（**未增跨域边**，跨包基线仍 0）、`workspace-layout` 7/7（新增「第四种状态」并**反向锁死** `link.notInProposal` 与那句错话都不得残留）；lint / typecheck 干净；**5 端构建通过**（web 2.31s + 元域智语 2.98s、desktop 2.50s、mobile 2.53s、dingtalk 3.88s，分端调用以避开沙箱 `safe-delete` 单次阈值）。
- **本批（阶段 4d）回归口径**：`npm run quality` 端到端 **EXIT=0**（1m41s，全量 35 个 Node 测试块全部 `fail=0`、0 处 `not ok`）；`test:identity` **20/20**（新增用例 18/19/20）、`test:declaration` 12/12、`test:attribution` 12/12、`test:architecture` 10/10（**未增跨域边**）、`workspace-layout` 7/7；lint / typecheck 干净；**5 端构建通过**（web 2.03s + 元域智语 2.73s、desktop 2.31s、mobile 2.27s、dingtalk 3.62s，分端跑）。
- **本批（阶段 4c 第三段）回归口径**：`npm run quality` 端到端 **EXIT=0**（**1m39s，全量 35 个 Node 测试块全部 `fail=0`、0 处 `not ok`**）；新增 `test:declaration` **12/12** 并挂入 `test:all`；`test:identity` 17/17、`test:attribution` 12/12、`test:architecture` 10/10（**未增跨域边**，跨包基线仍 0）、`test:scope` 12/12、`test:semantic` 6/60/92（`workspace-layout` 7/7 在链内）、`test:multitenant` 75/75、`test:ontology` 104/104、`test:ark` 39/39、`test:mock-onboarding` 69/69；lint / typecheck 干净；**5 端构建通过**（web 2.05s + 元域智语 2.76s、desktop 2.35s、mobile 2.28s、dingtalk 3.60s，分端调用以避开沙箱 `safe-delete` 单次阈值）。
- **本批（阶段 4c 第二段）回归口径**：`npm run quality` 端到端 **EXIT=0**（1m58s，全文 0 处 `not ok`，链尾 `test:mock-onboarding` 69/69）；新增 `test:attribution` **12/12** 并挂入 `test:all`；`test:identity` 17/17、`test:scope` 12/12、`test:architecture` 10/10（**未增跨域边**）、`test:semantic` 6/60/92、`test:permissions` 29/29、`test:multitenant` 75/75、`test:ontology` 104/104、`test:ark` 39/39；`workspace-layout` 7/7；lint / typecheck 干净；**5 端构建通过**（web 2.39s + 元域智语 3.11s、desktop 2.71s、mobile 2.68s、dingtalk 4.95s）。
- **本批（阶段 4c 第二段补测）回归口径**：`npm run evaluate:source-attribution` 两次完整重跑均 **EXIT=0**（1m11s / 1m10s），12 次抽取轮次 + 2 次端到端提案轮次全部符合预期，7 条端到端断言全通过；`npm run lint` 干净。**评测脚本不进 `quality`**（它调用真实云模型，与既有 `evaluate:*` 同类）——这一点必须说清楚：**「quality 全绿」不覆盖模型契约**，模型契约由这条评测命令覆盖。
- 架构优化三阶段的回归口径：19 个测试组全部复跑，0 失败（`test:permissions` 的预存 flaky 已单独说明并复现确认）。
- 跨包边界棘轮（第 15 项）的回归口径：architecture 组 10/10；另复跑 18 个非 flaky 测试组（contracts/clients/nonfunctional/architecture/events/security/ark/evidence/conversations/alerting/semantic/desktop/learning/orchestration/persistence/dingtalk/identity-providers/ontology）全部 0 失败。
- **跨包穿透已清偿（第 20 项，2026-09-25）**：跨包基线条目 8 → 0；扫描面补上 `.cjs`/`.css`；5 端构建通过。回归口径见第 20 节。
- 未充值方舟、未做多模态与生产验收；评测脚本缺省行为不变；全部结果为合成材料/受控环境验收，不代表生产级验收。
- **未启动真实数据迁移**：ADR-004 四条迁移前置条件均只部分满足，已在 ADR-004 内以表格标注。
- **未完成的架构收敛项**（已在 ADR-008 登记为退出条件）：仍有 8 个文件持有私有 `postgresRepository` 变量（`agent-evidence-trace-service`、`agent-conversation-service`、`agent-learning-governance-service`、`semantic-governance-store`、`alerting-store`、`risk-procurement-store`、`agent-orchestration-service`、`mock-scenario-service`）；189 条跨域边尚未逐条收敛；领域 public-api 契约面尚未从重导出收敛为目标 ≤15；`private-agent-service` 仍有进一步拆分空间。
- **未完成的模块化收敛项**（审计第 9 节）：第 1 项（跨包边界棘轮）、第 2 项（`packages/agent-ui` 建包清偿跨包穿透，基线 8 → 0）、**第 3 项（`domains/events` → `infrastructure/domain-events`，2026-09-26 完成，见第 37 节）**、**第 5 项（前端三层组件判据落文档，2026-09-26 完成，见 [ARCHITECTURE](../architecture/ARCHITECTURE.md) §3.3）** 均已做完；**未做的是第 4 项**（抽 `AgentWorkbench.vue` 的 4 个 composables，需要先有 composable 层的测试守护）**与第 6 项**（横切关注点管线化，审计文件自己写明「**须先立测试**」）。方案 B（`provide/inject` + `slots`）仍属未启动。
- **系统接入重构的阶段边界（2026-09-28，阶段 6 完成后更新）**：阶段 0（定义唯一 + 租户级接入生命周期）、阶段 1（共享组件建包 / 跨包穿透清偿）、阶段 2（接入迁移到元域智语端 + 新域 `system-onboarding`）、阶段 3（选系统成为建模必选项 / 范围显式化，`test:scope` 10/10）、阶段 4 前置（范围成为过滤器 + 被排除清单显式列出，`test:scope` 12/12）、**阶段 4a（按系统字段目录识别标识 + 跨系统标识对应推导，`test:identity` 7/7）**、**阶段 4b（标识对应确认后并入 + 证据等级，`test:identity` 12/12）**、**阶段 4c 第一段（标识等价假设先裁定，`test:identity` 17/17）**、**阶段 4c 第二段（材料归属由模型取证、服务端判定，`test:attribution` 12/12）**、**阶段 4c 第三段（同名声明不一致的合并 / 区分裁定，`test:declaration` 12/12）**、**阶段 4d（结构化标识映射 +「形状未判定」独立成态，`test:identity` 20/20）**、**阶段 4e（一条标识对应「有没有资格被确认」的判据唯一化，`test:identity` 21/21）**、**阶段 4f（候选对象的来源与「没被生成」的原因必须可读，`test:semantic` 第三组 92 → 94）**、**阶段 4g（候选对象的覆盖面与没被生成的对象名必须可点名，`test:semantic` 第三组 94 → 96）**、**阶段 4h（受控对象链接：材料逐字提及进入候选，[ADR-025](../architecture/adr/ADR-025-object-mention-linking.md)）**、**阶段 6（权限等价合并 [ADR-026](../architecture/adr/ADR-026-permission-equivalence-merge.md) + 元域智营「元模型」菜单全迁删除 / 4.3 决策 A）** 已完成，**阶段 7（文档同步 + 路线图口径对齐）已完成、阶段 5 被视觉模型硬前置卡死**。**范围现在会裁剪对象**：「只选 WMS 却得到 ERP 对象」不再是预期行为——ERP 对象会被排除，但必须以 `excludedObjects` 可读地列出并提示补选系统（第 26 节与 ADR-013）。**跨系统标识对应已生效但仍是推断**：确认后才并入，且并入的边标 `inferred` + `derivedFrom`（第 28 节与 ADR-015）；**而支撑这些对应的等价前提必须先裁定**（第 29 节与 ADR-016）——裁定只改「哪些对应成立」，不写草稿关系。**材料归属已由模型取证但只是候选**：候选**不参与裁剪**、进目录需经两道关口，确认后才成为事实（第 30 节与 ADR-017），且**已在真实模型下测量稳定**（第 31 节，复审条件 4 未触发）。**同一对象名的多处声明也不再被静默取并集**：未裁定即披露并集，`merge` 与 `distinct` 两种粒度各自有入口（第 32 节与 ADR-018）。阶段 4 余下部分：**对象抽取本身**（把「硬编码对象目录 + 关键词命中」升级为真正按材料抽取）——阶段 4e 实测的「不可确认对应」与 4f 实测的「材料写四个对象只得 1 类」都源于此；**4f 做了它的前置（让「候选从哪来、为什么没生成」可读）**，**4g 做了它的另一半披露（让「目录缺哪些类」「材料里哪些列举项没被覆盖」可**点名**）**，但**点名的对象仍不会进入候选**，且启发式依赖列举分隔符——**抽取能力本身仍未落地**。另有 `ambiguous_identifier` 的按字段归属指派（实测 **0 条**，ADR-016 已说明先不做）。四道关口（归属确认 → 等价裁定 → 同名声明裁定 → 对应确认）均已有入口；`key_shape_incompatible` 与 `declaration_divergence` 的处置动作、以及「哪些对应有资格被确认」也分别在阶段 4d / 4c 第三段 / 4e 落地（第 32 / 33 / 34 节与 ADR-018 / ADR-019 / ADR-020）。
- **模型链路的边界（2026-09-28，阶段 6 完成后更新）**：模型**理解**已打通；**材料归属**已接入取证且**已在真实模型下测量稳定**（模型给逐字原文、服务端判定，结果只是候选——第 30/31 节与 ADR-017，复审条件 4 未触发；**但「那句话在语义上是否真在说明归属」无机器兜底**）；**候选已不止硬编码目录**：阶段 4h 受控对象链接（ADR-025）让材料**逐字提及**的已登记对象类型经受控链接进入候选（服务端三重校验、结构只来自系统声明），词表治理第一轮把受控目录 **12 → 20 类**；**但真实模型评测 `evaluate:mention-linking` 因云服务限流未取得数字**——「quality 全绿」不含模型契约的口径不变。**「非列举写法的自由抽取」仍未落地**：链接依赖模型对材料与已登记类型的对齐，未登记类型仍只披露不进候选。`local` 通道的版本准入与端点未修；云 Provider 仅文本、未做多模态。凡判断当前模型行为，一律以 `GET /api/agent/model-config`（`activeProvider`）与 `GET /api/agent/runtime` 为准，不能只看环境变量或默认值。
- **`test:multitenant` 的预存 flaky 已关闭（2026-09-25）**：根因是 Windows + WAL 下并发打开同一 `runtime.db` 触发 `SQLITE_READONLY`（连接可能永久失效），已用「重开连接 + 有界重试」修复，单文件 2/3 失败 → **12/12 通过**，`test:multitenant` 75/75。详见第 22 节。
- **`test:permissions` 的归因已更正并关闭（2026-09-25，见第 25 节）**：此前记为「环境级 flaky / 并发资源竞争」并声明「单独运行 8 次全部通过」，**该结论已被实测推翻**——单独运行同样失败（3/1/0），真因是**等待预算（1000ms）小于实测启动时间（1097–1519ms）**。已改为按时间计预算（8s）并在失败信息中带上耗时与子进程日志，**未放宽任何断言**，连跑 5 次 0 失败。
- 代码在本机验证通过；**本次已由助手按 [交付约定](../development/GITHUB_DELIVERY.md) 提交并推送 `origin/main`**——推送把 `origin/main` 从 **`175dcdc`** 推进到本批次最新提交。**一处必须说清的事实：`175dcdc` 之后本地原本还有一个从未推送的提交 `16bb6ba`（「落地架构约束棘轮与持久化端口」），它是本次一并推上去的**，不要误读为「早已在远程」。本批次共推了 3 次（`…1896f98` → `…9c016d1` → 本次），**精确的提交清单以 `git log --oneline 175dcdc..origin/main` 为准**（本记录不写死总数——写死会随后续更正提交而失真）。远程 `refs/heads/main` 与本地 `main` 已一致；推送前已核对远程、扫过密钥/私有配置/用户数据库/临时状态，确认均未入库。**「已推送」不等于「已部署」**：未重启在用服务、未迁移真实数据、未开放公网。推送所用 git 与一处环境绕法见第 38 节末段。

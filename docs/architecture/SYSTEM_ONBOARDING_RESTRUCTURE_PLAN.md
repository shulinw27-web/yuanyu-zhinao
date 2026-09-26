# 「系统接入 → 选系统建模 → 模型治理」整体重构方案

状态：**已确认并实施中（Accepted）**。更新：2026-09-25。

本文是对「企业接入升级为系统接入、Agent 工作台以选中的系统为必选前提开展建模、模型与版本管理收敛到元域智语」这一整体方案的分析与实施草案。文中的现状数字均为 2026-09-25 本机实测所得。**实施进度见文末「实施台账」**；未在台账中标注完成的条目均为计划，不代表已完成的能力。

**产品命名变更（2026-09-25）**：该运营端产品名由「语义运营」改为「**元域智语**」（与业务端「元域智脑」成对：智脑承接业务、智营承接运营）。技术标识保持不变，映射关系见下方「命名映射」。

关联阅读：[整体架构说明](ARCHITECTURE.md)、[语义层元模型与元对象建设说明](SEMANTIC_MODEL_AUTHORING.md)、[模块化与组件化审计](MODULARIZATION_AUDIT.md)、[架构分析与优化](ARCHITECTURE_ANALYSIS_AND_OPTIMIZATION.md)、[Mock 企业接入](../development/MOCK_ENTERPRISE_ONBOARDING.md)、[开发路线](../development/DEVELOPMENT_ROADMAP.md)、[ADR-009 系统注册表](adr/ADR-009-system-registry-single-source.md)、[ADR-010 共享前端包](adr/ADR-010-agent-ui-package-extraction.md)、[ADR-011 接入独立成域](adr/ADR-011-system-onboarding-domain-extraction.md)、[ADR-012 建模范围显式化](adr/ADR-012-explicit-modeling-scope.md)、[ADR-013 范围作为过滤器](adr/ADR-013-scope-as-filter-with-explicit-exclusions.md)、[ADR-014 标识对应作为假设](adr/ADR-014-identity-linking-as-assumption.md)。

## 命名映射（改名不改技术标识）

| 层面 | 变更后 | 说明 |
| --- | --- | --- |
| 产品/界面显示名 | **元域智语** | 导航、标题、文档口径、Electron `productName`、快捷方式名 |
| 目录 | `apps/semantic-operations-console`（不变） | 改目录名会波及 workspace 配置、脚本、测试与棘轮基线中的 5 条路径，收益不足以抵消风险 |
| npm 包名 | `@healthcare-ai/semantic-operations-console` / `-sdk`（不变） | 技术标识 |
| API 命名空间 | `/api/semantic-operations/*`（不变） | 对外契约 |
| 权限点 | `meta_model.*`（不变） | 权限矩阵与测试绑定 |
| 测试脚本 | `test:semantic`（不变） | 组合分组名 |

即：**「元域智语」= 显示名，「semantic-operations」= 技术标识，二者指同一端。** 新增代码优先使用显示名于文案层，技术标识沿用既有约定，避免一次性重命名造成大面积不可控改动。

## 需求增补（2026-09-25，用户确认）

除本方案原有的三点要求外，追加两条横切要求：

| # | 要求 | 落地方式 |
| --- | --- | --- |
| 4 | **整体开发过程必须考虑多租户** | 凡「可被租户持有」的新实体一律：状态经 `semanticTenantStateKey()` 落租户工作区；租户标识只取受信上下文（`runWithSemanticTenant` 的 AsyncLocalStorage），绝不接受请求体传入；平台级共享资产（系统类型、角色策略、模板目录）显式标注无租户维度。已写入 ADR-009「多租户贯穿原则」 |
| 5 | 元域智语端与智脑一样**接入大模型做真实联调** | 已把运行中 API 的模型通道由 `local`（端点未起、版本精确匹配被拒）切换为 `workbuddy` 云 Provider（`deepseek-v4-pro`，免密钥），并修复「模型不可用时入口变成死路」的回落缺陷。实测证据见实施台账 |

---

## 0. 一句话结论

**方向成立，且比现有实现更接近目标态；但当前「接入」的最小单元不是系统而是「场景项目」，系统是硬编码常量，所以第一条要求不是"改名搬家"，而是"重构接入的领域模型"。** 同时，第三条「模型管理迁到元域智语」存在一个结构性前置：元域智语端已经在用相对路径穿透 `frontend/src/features/meta-model/*`（模块化审计 P0，已冻结在跨包棘轮基线 8 处中），**不先建包就直接搬迁文件，会让棘轮测试当场失败**。

---

## 1. 你的思路：我的规范化表述

把你说的三点整理成可执行的定义：

| # | 你的原话要义 | 规范化表述 | 性质 |
| --- | --- | --- | --- |
| 1 | 流程第一步必须是系统层面接入，系统接入是基石 | **接入的原子单位 = 单个业务系统**（ERP / QMS / LIMS / WMS / MES / OMS / OA…）。每个系统有独立的接入生命周期：登记 → 授权 → 连通 → 字段/对象目录 → 状态与健康。语义建模的一切输入都必须可追溯到某个已接入系统。 | 领域模型重构 |
| 1b | 「企业接入」改成「系统接入」 | 概念与命名、菜单、权限点、文档口径统一替换；「企业」只作为**租户归属**（不可由界面切换），不再作为接入单元。 | 命名 + 数据模型 |
| 1c | 所有系统接入模块从元域智营迁到元域智语（Web + 桌面端） | 元域智营 `config` 页的「接入系统配置 / 当前生效映射」与「元模型连接模板」整体迁出；元域智语端新增「系统接入」视图，Web 与 Electron 两版同源。 | 模块迁移 |
| 2 | Agent 工作台选 1~N 个系统建模，作为必选项 | **建模会话（Modeling Session）** 必须携带非空 `selectedSystems[]`。空选择不允许提交。选择是显式的用户动作，不再只靠自然语言推断。 | 前后端契约 + UI 门禁 |
| 2b | 用户可通过自然语言和多模态内容建模 | 材料通道需从「5 类文本/JSON 材料」扩展到 **PDF / Word / 图片 / 音频**，并保留脱敏、出域、注入与大小防护。 | 能力扩展（有硬前置） |
| 2c | Agent 按所选单/多系统分析，连接解释出的要素，整理成真实业务模型 | 从「结构化材料解析 / 硬编码对象目录」升级为：**按系统范围抽取对象与标识 → 跨系统连接同义业务实体 → 推导关系与基数 → 形成业务模型提案**。 | 核心算法（最难） |
| 2d | 交给 Semantica 抽离规范世界模型 | 沿用既有链路：提案 → Schema Critic → `simulate-build` → Semantica 定义二次校验 → 规范世界模型。 | 已实现，复用 |
| 2e | 用户复核确认是否理解正确并发布模型 | 沿用既有人工复核 → 确认令牌 → 发布闸门，不新增旁路。 | 已实现，复用 |
| 3 | 已有模型管理、版本管理模块迁到元域智语 | 元模型草稿/精调画布/快照/版本/回滚统一只存在于元域智语端；元域智营不再持有模型写入入口。 | 模块迁移 + 权限合并 |

---

## 2. 实测现状地图（2026-09-25）

### 2.1 端与包的拓扑

| 端 | 路径 | 端口 | 现有内容 |
| --- | --- | --- | --- |
| 元域智营 | `frontend/` | 5173 | 8 页：dashboard / intelligence / agent / risks / world / channels / config / permissions |
| 元域智语 Web | `apps/semantic-operations-console/` | 5174 | 5 视图：企业接入 / Agent 工作台 / 模型校对 / 版本与回滚 / 知识资料 |
| 元域智语 Electron | 同上 | — | `pack:semantic-ops-electron` |
| 业务智脑 Web/桌面 | `apps/desktop/` | 5184 | 仅 `import { AgentWorkbench }`，无自有页面 |
| 移动 H5 | `apps/mobile/` | 5175 | — |
| 钉钉 H5 | `apps/dingtalk/` | — | — |

### 2.2 「系统接入」现分散在 4 处，且定义互相重复

| 位置 | 载体 | 是否有写动作 | 实测证据 |
| --- | --- | --- | --- |
| 元域智营 `config` 页 | `ConfigManagementPage.vue:48-51`「接入系统配置 + 当前生效映射」 | **否**。「连通性测试」「新增映射」两个按钮**无事件绑定**，纯静态展示 | 源码 `<button>连通性测试</button>` 无 `@click` |
| 元域智营 `config` 页 | `WorldModelTemplateConfig.vue`「元模型连接模板」 | **是**（唯一）`world.draft.create/validate/publish` | 模板 × 目标系统 → 生成草稿 → 校验 → 发布 |
| 元域智语端 `onboarding` 视图 | `SemanticOnboardingWorkspace.vue`（556 行）「模拟企业接入」 | **是**，`meta_model.draft.save` | 场景 × 五类材料 × Mock HTTP 连接 × 业务对齐 × 交接 |
| 业务智脑工作台侧栏 | `AgentWorkbench.vue:839`「企业数据通道」 | 否，只读状态条 | `operations.telemetry.enterpriseConnectors` |

**系统清单在三处独立定义，互不一致：**

| 定义处 | 系统数 | 成员 |
| --- | --- | --- |
| `backend/src/data/seed.js:connectedSystems` | 6 | LIMS / MES / ERP / WMS / QMS / OMS |
| `backend/src/services/mcp-connector-service.js` | 7 | OA / ERP / WMS / MES / LIMS / QMS / OMS |
| `backend/src/services/semantic-source-discovery-service.js:systemAliases` | 12 | OA / ERP / WMS / MES / LIMS / QMS / OMS / SRM / MDM / PLM / EAM / IOT |
| `world-model-template-service.js:connectionTargets` | 8 | 上述 6 个 + SRM + OA（标注「待接入」） |
| `mock-onboarding-catalog.js:mockOnboardingScenarios` | 每场景 3 个硬编码 | 订单履约=OMS/ERP/WMS；批次异常=QMS/MES/WMS |

**这是本次重构最需要先解决的问题**：没有单一系统事实源，就不可能有「以系统为基石」。

### 2.3 「选系统」的能力已存在一半，但语义相反

`semantic-source-discovery-service.js`（134 行）已经具备：

- `detectRequestedSemanticSystems(request)`：**从自然语言推断**用户提到哪些系统（12 系统 × 别名表）
- `discoverSemanticSources({request, role})`：返回每个系统的 `authorized` / `status`（`ready_for_scoped_access` / `not_configured` / `not_registered` / `forbidden`）、`objects`、`mappings`、`blockers`、`warnings`、`readinessSummary`
- 但第 64-66 行：**推断为空时回落到「所有可访问连接器」** —— 这与「必选项」要求正好相反

同理，`mock-onboarding-catalog.js` 明确写着「目前不接受 PDF、Word、图片、音频；既有多模态能力尚未接入本页面」。

### 2.4 「模型管理 / 版本管理」现状

| 能力 | 位置 | 状态 |
| --- | --- | --- |
| 元模型精调画布 `OAMetaModelStudio` | 元域智营 `world` 页 **且** 元域智语端（相对路径穿透 `../../../frontend/src/...`） | 两处共用同一文件 |
| 核心元对象层 `CoreMetaObjectLayer` | 元域智营 `world` 页 | 未迁 |
| 语义上下文面板 `SemanticContextPanel` | 元域智营 `world` 页 | 未迁 |
| 草稿 / 快照 / 版本 Diff / 回滚 | 元域智语端 `App.vue` 内联 | **已迁** |
| 元模型连接模板草稿/版本 | 元域智营 `config` 页 `WorldModelTemplateConfig.vue` | 未迁 |
| 大模型连接配置（mock/ark/local/openai/deepseek） | 元域智营 `config` 页 | 属性待定，见 4.2 |

元域智营 `world` 页自身已声明：「元域智语 Agent 已迁移到独立运营端……自然语言建模、Schema Critic、Diff 与回滚请在元域智语端执行」——即**迁移方向早已确立，只是没有收口**。

### 2.5 结构性前置：跨包棘轮基线

`backend/test/architecture-baseline.js:CROSS_PACKAGE_IMPORT_BASELINE` 冻结了 8 处跨包相对路径穿透，其中 **5 处正是本次要迁移的对象**：

```
apps/semantic-operations-console/src/App.vue -> ../../../frontend/src/features/meta-model/OAMetaModelStudio.vue
apps/semantic-operations-console/src/App.vue -> ../../../frontend/src/features/knowledge/KnowledgeLibraryPanel.vue
apps/semantic-operations-console/src/App.vue -> ../../../frontend/src/features/meta-model/ontology-scenario.js
apps/semantic-operations-console/src/main.js -> ../../../frontend/src/styles/main.css
apps/semantic-operations-console/src/main.js -> ../../../frontend/src/styles/meta-model.css
```

棘轮规则是**只降不升**：新增任何跨包穿透都会让 `architecture-boundaries.test.js` 失败。**结论：迁移模型管理前，必须先把这些共享组件提升为真正的 workspace 包**（对应模块化审计建议第 2 项，原计划新建 `packages/agent-ui`）。

> **2026-09-25 已解除该前置**：`packages/agent-ui` 已建成，8 条基线**全部清偿归零**（含此处的 5 条），扫描面同时补上此前漏掉的 `.cjs`/`.css`。阶段 2/6 的搬迁前置条件已消除。见 [ADR-010](adr/ADR-010-agent-ui-package-extraction.md) 与模块化审计 2.6 节。

### 2.6 可复用、不需要重做的部分

- 建模治理链路：提案 → Schema Critic → Diff → 人工复核 → 确认令牌 → `simulate-build` → 发布 → 快照回滚（`ontology-runtime-service` 等）**完整可用**
- 材料与连接的既有能力：材料校验、隔离 Mock HTTP 连接、六类故障演练、跨租户拒绝、材料原文摘录引用（SHA-256 绑定）
- 系统来源发现：`discoverSemanticSources` 的就绪度模型可直接作为「选系统面板」的数据源
- 权限体系：`menu.*` / `page.*.view` / 按钮权限三级模型完整

---

## 3. 合理性判断

### 3.1 成立的部分（我同意，且有代码证据支持）

1. **「系统接入是基石」在架构上更正确。** 现状把系统当场景的属性（`scenarios[].systems`），导致「接入」实际描述的是「一个项目的材料准备度」，而不是「系统能不能被读懂」。以系统为单元后，就绪度、授权、字段目录、映射、健康才有地方挂。
2. **「必选项」是对的，而且比现状更安全。** 现状 `detectRequestedSemanticSystems` 推断为空时回落到全部可访问连接器（`semantic-source-discovery-service.js:64-66`），这在语义上是「用户没说清 → 系统替他放大了范围」。改为显式必选是**收窄默认授权**，方向正确。
3. **「多系统要素连接 → 真实业务模型」抓住了当前的真正短板。** 上一轮实测（`.runtime/probe/nl-modeling-probe.mjs`）已证明：候选对象只来自「结构化材料解析」或「硬编码 12 对象目录 + 关键词命中」，**没有任何跨系统连接推导**。这是能力缺口，不是配置问题。
4. **「模型/版本管理收敛到元域智语」与项目已有意图一致。** 元域智营 `world` 页自己就写着让用户去元域智语端做建模；元域智语端也已承载草稿/快照/回滚。

### 3.2 需要修正的部分（我认为你的表述需要改）

**修正 1：第一条不是「迁移」，是「重构」——两者工作量差一个量级。**
把 `mockOnboardingScenarios.systems` 从常量变成用户可选的系统集合，意味着接入项目的数据模型、材料归属（材料属于系统还是属于项目？）、连接测试对象、对齐规则作用域、交接范围全部要重新定义。**「改名 + 搬家」约占 20%，「系统为中心的数据模型重构」约占 80%。**

**修正 2：「系统接入是第一步」与「模型通道是前置」冲突——顺序上要并行，不能串行。**
上一轮实测结论：元域智语端任何自然语言建模请求当前都返回 `intent: conversation / status: failed`（本地模型端点未起 + 模型版本精确匹配被治理拒绝）。如果严格按「接入 → 选系统 → 建模」串行推进，**第 2 条会在验收时被模型通道卡死，而第 1 条本身不依赖模型**。所以第 1 条（接入重构与迁移）与「打通模型通道」应并行，第 2 条排在两者之后。

**修正 3：「多模态」当前是零基建，且依赖模型具备视觉能力。**
现状：`multimodal-understanding.js` / `multimodal-security-gateway.js` 存在且有测试组，但**未接入接入或建模链路**；`mock-onboarding-catalog.js` 明确拒绝 PDF/Word/图片/音频；09-24 评测记录「workbuddy 图片多模态未接入（仅文本）」。所以「自然语言 + 多模态建模」应拆成两条：**自然语言建模（依赖文本模型通道）** 与 **多模态材料（依赖视觉模型通道 + 安全闸门）**，后者单独排期。

**修正 4：「所有模型管理」边界不清，其中有一个不该迁。**
「模型」在本项目有**两种完全不同的含义**：
- **语义模型 / 元模型**（业务定义）→ 迁元域智语，**正确**；
- **大模型连接配置**（`mock/ark/local/openai/deepseek` provider，`agent.model.configure` 权限，仅 executive）→ 这是**出网通道与数据出域策略**，属平台基础设施治理。若一并迁入元域智语，该端将同时持有「定义业务语义」和「配置数据出网」两类高风险权限，**建议不迁**（见 4.2）。

**修正 5：「包括 web 和桌面端」有歧义。**
我理解为「元域智语的 Web 版与 Electron 版都要有系统接入视图」（该端已有两个打包，同源代码，成本近乎为零）。但如果你的意思是「业务智脑桌面端（`apps/desktop`）也要有系统接入」，那性质完全不同——业务端出现接入配置入口会打破「业务端不做建模治理」的既有边界（`AgentWorkbench.vue:175` 明确写「独立运营端，不属于业务端智脑」）。**需你确认。**

**修正 6：元域智营迁移后会出现权限目录空洞。**
`iam-seed.js` 中 `menu.config` 描述为「连接、密钥与模型治理」、`menu.world` 为「对象、关系与事实层」。迁走后这两个菜单的语义与按钮权限（`world.draft.create/validate/publish`）需要同步重构，涉及 5 个角色的权限矩阵（executive / quality_manager / production_manager / procurement_manager / marketing_manager）。**不是删几个组件就完事。**

---

## 4. 需要你决策的问题

### 4.1 接入的最小单元怎么定？

- **A. 系统为中心（我建议）**：`SystemConnection` 独立生命周期；项目/会话只是「选了哪几个系统 + 一次建模尝试」。材料归属到系统或会话。
- **B. 保留项目为中心，系统作为项目属性**：改动小，但「系统接入」仍然不是一个能被单独治理、单独看状态的实体，与「基石」定位不符。
- **C. 双实体并存**：系统接入（长期资产）+ 建模会话（一次性），项目降级为会话。**A 的完整版**。

> 我的建议：**C**。因为「接入」是长期资产（一次接好，反复建模），「建模会话」是一次性动作。混在一个实体里是当前最大的概念问题（`mock-onboarding` 的项目同时承担材料容器、连接对象、对齐范围、交接来源四种角色）。

### 4.2 大模型连接配置（provider / endpoint / apiKey / 出域策略）去留？

- **A. 留在元域智营（我建议）**：属平台基础设施 + 数据出域治理，与元域智语的高风险业务定义权分离。
- **B. 迁到元域智语**：元域智语端闭环更完整，但权限集中风险升高。
- **C. 迁到元域智语但拆权限**：配置只读在元域智语，写入仍在元域智营。

### 4.3 元域智营的 `world`（元模型）菜单如何处置？

- **A. 全迁 + 删菜单（我建议）**：模型相关只存在于元域智语端，元域智营不再有模型入口。
- **B. 全迁 + 保留只读指针页**：元域智营保留「去元域智语端建模」的引导与已发布模型只读摘要。
- **C. 部分迁**：只迁草稿/精调/版本，保留「核心元对象层 + 语义上下文 + 模型实例风险图」作为业务观察视图。

> 注意：C 中的「模型实例风险图」是**业务侧观察**语义模型的产物，与「模型管理」（定义）性质不同，可考虑保留。

### 4.4 推进顺序？

- **A. 并行（我建议）**：轨道一「接入领域模型重构 + 迁移」，轨道二「打通模型通道（workbuddy 云 Provider 最小验证）」，第 2 条在两者完成后端到端验收。
- **B. 严格串行**：先接入 → 再选系统 → 再建模。风险：第 2 条验收被模型通道阻塞。
- **C. 先打通模型通道**：最快看到「自然语言建模」有反应，但接入仍以场景为中心，选系统无载体。

### 4.5 「显式选系统」的语义是哪种？（这条只能在正文提，需要你给方向）

- **A. 仅建模范围过滤**：用户选的系统只影响 Agent 分析范围与提案来源标注，不改变数据授权。
- **B. 数据授权门禁**：选中的系统同时成为本次任务的授权范围，越权系统直接拒绝（现有 `connector.domains` → 角色数据域映射已具备判定基础）。
- **C. A + 显式告知**：默认 A，但若所选系统超出角色数据域，明确提示并阻断。

> 我倾向 **C**：既不让 UI 选择变成隐式提权，也不让用户选了却拿不到数据却不知道为什么。

---

## 5. 目标模型（建议）

三层分离，对应你三点要求：

| 层 | 实体 | 生命周期 | 归属 |
| --- | --- | --- | --- |
| 接入层 | `SystemConnection`（每系统一条） | 长期资产：登记 → 授权 → 连通 → 字段目录 → 健康 | 元域智语端 |
| 建模层 | `ModelingSession`（一次建模尝试） | 一次性：选系统(N≥1) + 材料 + 诉求 → 提案 → 复核 → 采纳/驳回 | 元域智语端 Agent 工作台 |
| 治理层 | `SemanticModel` / `Version` / `Snapshot` | 长期资产：草稿 → 校验 → 确认 → 发布 → 回滚 | 元域智语端 |

统一事实源：单一系统注册表（收敛 2.2 表的 5 处重复定义）。

---

## 6. 实施方案

> 每阶段独立可验证、可回退。数字口径：现有 `quality` 全量测试组为 19 组；本机实测基线为全组 0 失败。**（2026-09-25 阶段 3 更正：此处原写「`test:permissions` 存在预存环境级 flaky，已单列」，该归因经实测为误——真实原因是启动等待预算小于实测启动时间，已在阶段 3 修掉，连跑 5 次 0 失败。详见阶段 3 台账。）**

### 阶段 0：口径冻结与单一系统事实源（1 个增量，不碰 UI）

**范围**
- 定义 `SystemConnection` 领域模型与状态机（草稿 → 已登记 → 已授权 → 已连通 → 已停用）
- 新建 `backend/src/services/system-registry-service.js` 作为**系统唯一事实源**，收敛 5 处重复定义
- 把 `seed.js:connectedSystems`、`mcp-connector-service`、`semantic-source-discovery-service:systemAliases`、`world-model-template-service:connectionTargets`、`mockOnboardingScenarios.systems` 改为从注册表读取

**产物**：ADR（系统注册表与接入状态机）+ 注册表服务 + 收敛后的引用点

**验收**
- 新增注册表测试：三处历史定义一致性快照、角色数据域过滤、未登记系统拒绝、状态机非法跃迁拒绝
- `test:security` / `test:semantic` / `test:mock-onboarding` / `test:orchestration` 全绿
- 跨包棘轮基线**不新增**条目

**边界**：本阶段只做定义收敛，不改任何 UI，不改对外 API 响应结构（可加字段，不删字段）。

---

### 阶段 1：共享组件提升为真正的包（结构性前置）—— **已完成（2026-09-25）**

> 状态：已完成。实际落地为 `packages/agent-ui`（采用方案允许的审计命名），迁移 17 个文件，基线 8 → 0。台账见第 9 节。

**范围**
- 新建 `packages/semantic-model-ui`（或并入模块化审计建议的 `packages/agent-ui`），承载被两端共用的组件：`OAMetaModelStudio` / `CoreMetaObjectLayer` / `OntologyCaseReplay` / `OntologyReadPlanPanel` / `OntologyScenarioPanel` / `ontology-scenario.js` / `ontology-read-plan-import.js` / `KnowledgeLibraryPanel` / 相关样式
- 两端改为声明式依赖（`package.json` dependencies + `exports`）
- 从 `CROSS_PACKAGE_IMPORT_BASELINE` **删除**对应条目（棘轮下行）

**产物**：新包 + 两端 import 改写 + 基线下调 + 受影响测试路径修正（`apps/semantic-operations-console/test/*.cjs` 中 5 处引用 frontend 路径）

**验收**
- `test:architecture` 通过且基线条目**减少**（不是持平）——证明是收敛而非搬运
- 两端构建通过；`test:semantic`（元域智语端测试）全绿
- 前端组件行数上限棘轮不违反

**边界**：纯结构性搬迁，组件行为与视觉**零改动**；不新增功能。

---

### 阶段 2：接入模块迁移到元域智语端 —— **已完成（2026-09-25）**

**范围**
- 元域智语端导航：`企业接入` → `系统接入`（替换 `SemanticOnboardingWorkspace` 的主视角）
  - 系统列表视图：每系统显示 状态 / 授权 / 健康 / 最后同步 / 对象目录 / 映射数 / 责任人
  - 系统详情：连接配置、字段目录、字段→元模型对象映射、连通性测试（**把元域智营那两个空按钮真正接上**）
- 从元域智营 `config` 页迁出「接入系统配置」「当前生效映射」「元模型连接模板」
- 元域智营 `config` 页保留：监控策略 / 安全策略 / 账号权限中心 / Key Center / 模拟控制中心 /（大模型连接配置按 4.2 决策）
- Web 与 Electron 两版同源（同一组件，无需分支）

**产物**：元域智语端「系统接入」视图 + 元域智营 `config` 页收窄 + 迁出的后端端点按元域智语命名空间重整

**验收**
- 浏览器实测 1440/1024/768/390 无横向溢出，两版（Web + Electron `dev:electron`）均可打开
- 权限测试：接入写入仍需 `meta_model.draft.save`；页面读取权限判定不变
- 元域智营 `test:permissions`（含 `frontend/test/page-data-registry.test.js`）同步更新并通过
- 全组回归 0 失败

**边界**：本阶段**不删**旧端点（保留一个版本周期），但元域智营不再有入口；迁移后可观测 404 计数确认无残留调用。

---

### 阶段 3：选系统成为建模必选项 —— **已完成（2026-09-25）**

**范围**
- `SemanticAgentWorkspace.vue` 增加系统多选面板（数据源 = 阶段 0 注册表 + `discoverSemanticSources` 就绪度）
- 前端门禁：`selectedSystems.length === 0` → 禁用提交并给出可读原因
- 后端 `createSemanticOperationsTask` 接受 `systemCodes[]`：
  - 显式选择优先；`detectRequestedSemanticSystems` 降级为「提示用户在文本里提到了 X 但未选择」的辅助
  - **删除「推断为空 → 回落到全部可访问连接器」的行为**（`semantic-source-discovery-service.js:64-66`）
  - 空选择 → 400 + 明确原因（不能静默放大范围）
  - 越权系统 → 按 4.5 决策处理
- 提案中每个对象/关系标注来源系统，未覆盖的系统显式列出（**禁止静默丢弃**——上一轮实测用例 C 已复现该风险）

**验收**
- 用例：单系统 / 多系统 / 空选择 / 部分越权 / 文本提到但未选 / 选了但系统未登记（6 类）
- 提案来源标注断言：每个对象都能追到系统；未覆盖系统显式出现
- 回归 19 组 0 失败

**边界**：本阶段**不**改变建模算法，只改「范围从哪来」。跨系统连接推导在阶段 4。

> **实施结果见文末台账阶段 3**。两处与本节字面口径的差异已在那里记录并给出理由：①前端门禁按「建模意图 + 空范围」判定（字面口径会把对话类诉求一并禁掉，而服务端对对话类意图本就不要求范围）；②4.5 决策取 **C**：勾选不构成提权，但超出角色数据域时**阻断**而非静默裁剪。跨域系统间连接推导仍留在阶段 4。

---

### 阶段 4：跨系统要素连接与真实业务模型整理（核心）

**范围**
- 从「硬编码 12 对象目录 + 关键词命中」升级为：
  1. 按选中系统的字段目录/样本抽取对象与标识（主键 / 唯一键 / 业务键）
  2. **跨系统连接**：识别同一业务实体在不同系统的标识对应（如 ERP `PurchaseOrder.id` ↔ WMS `InboundReceipt.purchase_order_id`），推导关系与基数
  3. 冲突与歧义显式上报（同名不同义、同义不同名、粒度不一致）
  4. 形成业务模型提案 → 交既有治理链路（Schema Critic → Diff → 复核 → Semantica 校验 → 发布）
- 输入必须带证据（原文/字段路径引用），沿用现有 `validateNaturalSchema` 的逐字证据要求

**验收**
- 合成材料 + 指定系统的确定性用例：对象数 / 关系数 / 跨系统连接数 / 冲突数可复现
- **如实标注为合成材料验收**，不得表述为真实企业系统验收
- 反向用例：缺主键、粒度冲突、同名不同义必须显式上报而非静默合并

**前置**：阶段 3 + **模型通道可用**（见轨道二）+ **「范围过滤」决策已定**（见文末台账「阶段 4 前置」与 [ADR-013](../architecture/adr/ADR-013-scope-as-filter-with-explicit-exclusions.md)）。
**边界**：本阶段是本次重构中唯一真正需要模型能力的部分，其余阶段均可在 mock 下验证。

> **实施结果见文末台账「阶段 4 前置：范围成为过滤器」「阶段 4a：跨系统标识对应」「阶段 4b：标识对应确认后并入」「阶段 4c（第一段）：标识等价假设先裁定」与「阶段 4c（第二段）：材料归属由模型取证、服务端判定」**。范围过滤与「被排除清单」已先行落地；本阶段的**确定性部分**分三段落地——阶段 4a（按选中系统的字段目录识别对象标识、跨系统标识对应推导、四类冲突上报）、阶段 4b（人工确认后并入、证据等级与可区分性）与阶段 4c 第一段（支撑对应的等价假设先裁定，裁定改输入而不改证据等级）。**需要模型能力的那一段已落地**：模型只提供逐字的「归属原文」，系统码由服务端判定成**候选**，候选不写来源系统、不参与范围裁剪，人工确认并留下依据后才成为事实（阶段 4c 第二段 / [ADR-017](../architecture/adr/ADR-017-model-extraction-attribution.md)）。**四类冲突的处置动作已全部落地**：`alias_divergence` 的等价裁定（阶段 4c 第一段）、`declaration_divergence` 的合并 / 区分粒度（阶段 4c 第三段）、`key_shape_incompatible` 的结构化标识映射与「形状未判定」独立成态（阶段 4d / [ADR-019](../architecture/adr/ADR-019-structured-key-mapping.md)）。**确认这一关的前置条件也已唯一化**：一条对应能不能并入草稿，判据只有一个——**两端对象都在本次候选对象内**，由推导层给出（`eligible`，与服务端草案校验读同一个数组），不可确认的仍然列出并带可行动原因（阶段 4e / [ADR-020](../architecture/adr/ADR-020-identity-link-confirmation-eligibility.md)）。**候选对象的来源与「没被生成」的原因也已可读**：受控目录命中披露**命中词与覆盖率**并说明它是**词面匹配的兜底**，自然语言抽取的跳过给出**可区分的原因**（模拟运行时 / 材料无字典线索）——这是「对象抽取」那一半的**前置**（阶段 4f / [ADR-021](../architecture/adr/ADR-021-candidate-provenance-disclosure.md)）。唯余 `ambiguous_identifier` 的按字段归属指派（实测 **0 条**，无用例驱动）与**对象抽取本身**（材料里提到、目录未覆盖的对象仍抽不出来，4f 只能提示「可能漏」，见阶段 4f 末尾「下一步」）。

---

### 阶段 5：多模态材料接入（独立排期）

**范围**
- 复用 `multimodal-understanding.js` / `multimodal-security-gateway.js`，接入 PDF / Word / 图片 / 音频
- 材料登记、脱敏、出域策略、大小/类型/注入/病毒防护
- 撤销 `mock-onboarding-catalog.js` 中「不接受 PDF/Word/图片/音频」的限制

**验收**：多模态安全测试 + 脱敏断言 + 出域策略断言

**前置（硬）**：模型通道具备视觉能力。现状「workbuddy 图片多模态未接入（仅文本）」。
**边界**：无法在无视觉模型时验收；不应提前把 UI 做出来挂空。

---

### 阶段 6：模型管理 / 版本管理收敛到元域智语

**范围**
- 按 4.3 决策处置元域智营 `world` 页
- 权限合并：`world.draft.*` → `meta_model.*`（需决定合并策略，涉及 5 个角色矩阵）
- 「元模型连接模板」的草稿/发布权限并入语义建模权限体系
- `iam-seed.js` 菜单描述与按钮权限同步重构

**验收**：`test:permissions` + `test:semantic` + 权限矩阵回归；文档全量同步

**边界**：已发布的模型指纹与版本号**不得变化**（结构迁移，不产生新版本）。

---

### 阶段 7：元域智营收口与文档同步

**范围**
- 元域智营菜单收缩（按 4.3 决策）
- 全量文档同步：`PROJECT_STATUS.md` / `workbuddy_work.md` / `DEVELOPMENT_ROADMAP.md`（六阶段路线需与本次重构对齐）/ `MOCK_ENTERPRISE_ONBOARDING.md` / `SEMANTIC_MODEL_AUTHORING.md` / `ARCHITECTURE.md` / `docs/modules/*`
- `docs:check` 通过

**边界**：路线图改写属**决策变更**，需你确认后才能动，我不单方面重写。

---

## 7. 依赖与风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 跨包棘轮阻断 | 不先建包直接搬迁会当场失败 | 阶段 1 前置；基线只降不升是**保护**而非障碍 |
| 模型通道未通 | 阶段 4 / 5 无法端到端验收 | 轨道二并行；阶段 0-3 全部可在 mock 下验证 |
| 权限矩阵破坏 | 5 个角色 × 菜单 × 按钮，迁移易漏 | 每阶段跑 `test:permissions` + 前端权限导航测试 |
| 旧端点残留调用 | 迁移后元域智营可能仍调旧接口 | 保留一个版本周期 + 观测 404 |
| 概念混淆回流 | 「项目 / 会话 / 系统」三个词被混用 | 阶段 0 冻结术语，写入 ADR |
| 合成数据被误读为生产验收 | 本项目历史高发风险 | 每阶段验收报告显式标注「合成材料 / 受控环境」 |

**本方案不涉及**：真实企业连接器、真实收款与商业控制面、生产多租户验收、真实数据迁移（ADR-004 四条前置仍未完全满足）。

---

## 8. 与现有文档的关系（需要后续同步）

| 文档 | 需要的变更 | 时机 |
| --- | --- | --- |
| `DEVELOPMENT_ROADMAP.md` | 六阶段路线的阶段 1「模拟企业与接入」口径需改为「系统接入」 | 阶段 7（用户已于 2026-09-25 确认整体方案，含此处口径变更，但仍在阶段 7 统一执行以避免中途口径不一致） |
| `MOCK_ENTERPRISE_ONBOARDING.md` | 改名 + 内容重写（系统为中心） | 阶段 2 |
| `SEMANTIC_MODEL_AUTHORING.md` | 补充「选系统为必选项」与新建模链 | 阶段 3-4 |
| `ARCHITECTURE.md` | 三层目标模型（接入 / 建模 / 治理） | 阶段 0 |
| `MODULARIZATION_AUDIT.md` | 建议第 2 项（新建 `packages/*`）由本方案阶段 1 承接，需交叉引用 | 阶段 1 |
| `PROJECT_STATUS.md` / `workbuddy_work.md` | 每阶段增量记录 | 每阶段 |

---

## 9. 实施台账

> 口径：所有数字均为本机实测。未列入本表的阶段即为**未开始**。不得把 Mock/合成材料的验证结果表述为生产验收。

### 阶段 0：口径冻结与单一系统事实源 —— **已完成（2026-09-25）**

**产物**

| 文件 | 说明 |
| --- | --- |
| `backend/src/data/system-catalog.js`（新增） | 系统目录：唯一事实源，12 个系统类型 + 两套角色可见性策略 + 生命周期状态机定义 + 派生视图 |
| `backend/src/services/system-registry-service.js`（新增） | 注册表服务：类型查询、角色可见性、文本识别、**租户级接入生命周期读写**、一致性快照 |
| `backend/test/system-registry.test.js`（新增，7 项） | 唯一事实源一致性、兼容视图逐字段一致、双策略差异、文本识别语义、租户隔离、状态机、来源发现 |
| `docs/architecture/adr/ADR-009-system-registry-single-source.md`（新增） | 决策理由、放弃项、退出条件 |
| `package.json` | 新增 `test:registry` 并挂入 `test:all` |

**收敛点（5 → 1）**：`seed.js`、`mcp-connector-service.js`、`semantic-source-discovery-service.js`、`world-model-template-service.js`、`mock-onboarding-catalog.js` 五处定义改为从注册表读取或派生；`system-integration-service.js` 的 `roleSystems` 改为读注册表。

**实测验收**

| 项 | 结果 |
| --- | --- |
| 注册表测试 | 7/7 通过 |
| 架构组（含棘轮） | 10/10 通过；跨域基线新增 3 条（指向注册表），跨包基线**未新增** |
| `test:security` / `test:semantic` / `test:mock-onboarding` / `test:orchestration` / `test:ontology` | 全绿，0 失败 |
| 兼容性 | `connectedSystems` 与连接目标视图字段、顺序与历史逐字段一致（含 ERP 独有 `alert`、待接入项 SRM 在 OA 之前） |
| 多租户 | A 租户推进 OA 接入状态不影响 B 租户；租户标识只取受信上下文（测试已断言） |
| `lint` / `typecheck` | 通过 |
| `docs:check` | 通过（170 份 Markdown / 874 链接） |

**已知边界**

- 接入生命周期状态机**未接真实审批链**：`authorized → connected` 目前无凭据校验，接真实连接器时必须补（ADR-009 退出条件 3）；
- `worldObjectTypes` 与 `connector.objects` 的差异**刻意保留未合并**（6 个系统中两组清单均不完全一致），需业务确认（ADR-009 退出条件 2）；
- 两套角色可见性策略是否统一，需业务确认（ADR-009 退出条件 1）；
- 租户接入状态暂存于运行时 JSON 存储，迁移 PostgreSQL 时需按 ADR-004 前置一并处理。

### 元域智语接入云大模型（对应需求增补第 5 条）—— **已完成（2026-09-25）**

**动作**

1. 运行中 API 的模型通道由 `local`（端点 `127.0.0.1:8080` 未起 + 版本精确匹配被拒）切换为 `workbuddy` 云 Provider（`deepseek-v4-pro`，免密钥），经产品自带的 `POST /api/agent/model-config` 写入，**持久化于运行时存储，无需重启**。
2. 修复缺陷「模型不可用时入口变成死路」：`understandAgentTurn` 在模型不可用/输出不合契约时返回 `source='understanding_failed'`，历史上该结果仍被当作一次有效的 dialogue 判定，于是任何自然语言诉求都退化为「本轮模型未返回可用的理解结果」。现改为**回落服务端确定性分类**（与 mock 模式同一条路径），并把降级事实显式暴露（`routing.mode='server_rules_fallback'`、`routing.degraded=true`、`modelUnavailable=true`、事件 `model_understanding_unavailable`），前端以警示条呈现，不静默伪装成模型理解成功。
3. 裁决逻辑抽为纯函数 `resolveSemanticOperationsIntent`，新增 9 项测试（`backend/test/semantic-operations-routing.test.js`），已挂入 `test:semantic`。

**实测证据（真实调用云模型）**

| 场景 | 实测结果 |
| --- | --- |
| 对话类（"你好，你能做什么？"） | `intent=conversation`、`status=completed`、`routing.source=workbuddy`，返回真实模型回答 |
| 建模类（"分析 ERP 和 WMS，建立采购订单、入库单和库存之间的语义模型。"） | `intent=build_model`、`status=waiting_confirmation`、`routing.source=workbuddy`、`requiredPermission=meta_model.draft.save`、`confirmationRequired=true`；生成提案 `PurchaseOrder, Inventory`，Critic `passed` |
| **模型不可用时同一条建模诉求** | `routing.mode=server_rules_fallback`、`degraded=true`、`modelUnavailable=true`、`intent=build_model`、`status=waiting_confirmation`（**不再是死路**），事件含 `model_understanding_unavailable` |
| 模型不可用时请求发布 | `intent=needs_clarification`、`requiredPermission=null`、`confirmationRequired=false`，明确拒绝降级授权发布 |

**同期修正**：语义面提示词原先未区分「实现细节未确认」与「缺失建模范围」，导致模型对明确的建模诉求回退为澄清（实测复现）。已补充路由判据：诉求中已给出业务对象或来源系统时必须选 `build_model`，实现细节的不确定性写入 answer 作为待确认清单。

**边界（重要）**

- 建模提案的**候选对象生成仍是硬编码目录 + 关键词命中**：实测"采购订单/入库单/库存"只产出 `PurchaseOrder, Inventory` 两个对象且关系为 0，**"入库单"未被识别**。模型理解已通，候选生成未通——这正是阶段 4 要解决的能力缺口，不得因为 `intent=build_model` 已成立就宣称自然语言建模已完成。
- 模型通道当前指向**云服务**（数据出域策略 `redacted`）；本地 `local` 通道的版本准入问题（管理员写入完整 Windows 路径、白名单为清单名，精确匹配失败）**未修复**。
- 未做多模态：云 Provider 仅文本。

### 阶段 1：共享组件提升为真正的包 —— **已完成（2026-09-25）**

**产物**

| 文件 | 说明 |
| --- | --- |
| `packages/agent-ui/package.json`（新增） | 9 个**具名** `exports` 入口（**刻意不用 `"./*"` 通配**，避免边界重新退化为「什么都能拿」） |
| `packages/agent-ui/src/{meta-model,knowledge,agent}/`（新增） | 14 个组件/模块（原 `frontend/src/features/{meta-model,knowledge,agent}/`） |
| `packages/agent-ui/src/styles/`（新增） | 3 个样式（`main.css` 企业设计基线 / `meta-model.css` / `core-meta-objects.css`） |
| `packages/agent-ui/src/{index,meta-model/index,knowledge/index,agent/index}.js`（新增） | 统一出口与分子目录出口 |
| `docs/architecture/adr/ADR-010-agent-ui-package-extraction.md`（新增） | 决策理由、放弃项、4 条退出/复审条件 |
| `tsconfig.json` | `include` 补 `packages/*/src/**/*.vue`（见下「覆盖静默收缩」） |

**实际迁移 17 个文件，全部为纯重命名**（`git diff -M --numstat` 为 0 增 0 删；3 个样式文件字节一致 → 组件行为与视觉零改动）。

**范围比方案初稿更大，原因**：方案写的是「被两端共用的组件」（含 `semantic-model-ui` 备选名），实际按**包边界**而非「谁引用谁」圈定——`agent-workbench` 还引用了 `MemoryReviewPanel` 与 `AnomalyAssistantPanel`，`CoreMetaObjectLayer` 与元模型面板同属一个关注点，样式随组件走。只搬被引用者会留下半套组件。最终按模块化审计的建议命名为 `agent-ui`（方案第 6 节已显式允许）。

**依赖改为声明式**

| 消费方 | 声明位置 | 用途 |
| --- | --- | --- |
| `packages/agent-workbench` | `dependencies` | 智脑工作台的知识/异常面板 |
| `apps/semantic-operations-console` | `dependencies` | 元模型校对 + 知识资料 + 设计基线样式 |
| `frontend` | `dependencies` | 世界模型页 + 治理动作 + 设计基线样式 |
| `backend` | **`devDependencies`** | 仅 4 个本体测试取场景夹具（**已知不洁，见下**） |

**实测验收**

| 项 | 结果 |
| --- | --- |
| `test:architecture` | 10/10 通过，且跨包基线条目 **8 → 0**（**下降而非持平**，证明是收敛不是搬运） |
| 5 端构建 | `frontend` / `semantic-operations-console` / `desktop` / `mobile` / `dingtalk` 全部通过 |
| 语义运营端组件测试 | 60/60（含 4 个「读取组件源码文本」的测试，已改为「声明式入口 + 目录推导」） |
| `test:ontology` / `test:knowledge` / `test:semantic` / `test:registry` | 104/104、56/56、156/156、7/7 |
| 前端 `test:permissions` | 10/10 |
| `lint` / `typecheck` / `docs:check` | 全部通过 |
| 视觉/行为 | 纯重命名 + 样式字节一致 + import 顺序不变 → **零改动** |

**同时修正了一个扫描盲区（自我修正）**：棘轮原扫描扩展名为 `.js/.mjs/.ts/.vue`，**漏掉 `.cjs` 与 `.css`**。扩大后实测发现另有 3 处真实穿透（语义运营端 2 处测试、1 处 `examples/` 样例）——即审计报告的「8 处」**在扩大扫描面前并不完整**。前 2 处随本次搬迁改为 `@healthcare-ai/agent-ui/ontology-read-plan`；第 3 处指向仓库级只读样例数据，登记入 `CROSS_PACKAGE_CONTENT_ALLOWLIST` 并写明理由（白名单共 2 条）。

**同时修正了一处类型检查覆盖的静默收缩**：`tsconfig.json` 的 `include` 原只有 `packages/*/src/**/*.js`、**没有 `.vue`**。被迁移的 14 个 `.vue` 文件原本靠 `frontend/src/**/*.vue` 受检，迁移后会**静默失去类型检查**——而所有测试仍然全绿。已补上 `packages/*/src/**/*.vue` 并重跑 `vue-tsc` 通过。**结构性迁移若是「纯重命名」，覆盖面的收缩不会以任何形式暴露；验收必须包含「检查工具的覆盖面有没有跟着变」，不能只看用例是否通过。**

**已知边界（如实）**

- **`backend` 的 `devDependencies` 出现 UI 包**：真实原因是「场景夹具（`ontology-scenario.js`）被后端 4 个本体测试复用」。正确处理是把夹具抽到独立数据包，本次**未抽**以免引入第三个包、扩大改动面。已写入 ADR-010 退出条件第 2 条：一旦后端**非测试**代码引用该包，必须立刻抽离。
- 方案 B（`AgentWorkbench.vue` 改 `provide/inject` + `slots`）**未启动**，属模块化审计第 3 节议题，不在本阶段范围。
- `packages/agent-ui` 现被 5 个顶层区引用，成为新的耦合热点；ADR-010 已给出拆分触发条件（第 4 个无关关注点 / 单包超 30 文件）。
- 本阶段**不新增任何功能**，也不改变任何组件 API。

### 阶段 2：接入模块迁移到元域智语端 —— **已完成（2026-09-25）**

**产物**

| 文件 | 说明 |
| --- | --- |
| `backend/src/services/system-access-service.js`（新增，约 330 行） | 接入服务：总览组装、单系统详情、**真实连通性探测**。不新增系统定义、不复制任何清单 |
| `backend/src/domains/system-onboarding/public-api.js`（新增） | 新域契约面，4 项导出（上限刻意压到 4，避免抬高 governance 的 92） |
| `backend/test/system-access.test.js`（新增，9 项） | 单一事实源派生、字段目录归并、多租户、授权裁剪、真实探测、可探测性判据、六种故障模式、路由权限 |
| `apps/semantic-operations-console/src/components/SystemAccessWorkspace.vue`（新增） | 系统接入主视图：6 类筛选 + 7 项汇总 + 系统卡列表 + 详情（连接配置 / 连通性测试 / 字段目录 / 字段→元模型对象映射） |
| `packages/agent-ui/src/system-access/WorldModelTemplateConfig.vue`（迁移） | 原 `frontend/src/features/world-model/WorldModelTemplateConfig.vue`，`git mv` 纯重命名并登记具名 exports |
| `docs/architecture/adr/ADR-011-system-onboarding-domain-extraction.md`（新增） | 决策理由、放弃项、5 条退出/复审条件 |
| `package.json` | 新增 `test:access` 并挂入 `test:all` |

**核心动作：把两个「空按钮」真正接上**

元域智营 `config` 页原有的「连通性测试」「新增映射」是**无 `@click` 的装饰性按钮**（历史上从未实现）。本阶段不是换位置重放，而是真做：

| 能力 | 实现 | 实测 |
| --- | --- | --- |
| 连通性探测 | `probeSystemConnection` 监听本地临时端口、发**分页 HTTP 请求**、校验 `mock-onboarding-query.v1` 契约与分页完整性 | ERP：`status=verified`、3 请求 / 3 页 / 6 条记录 / 34 条可读 / 5 类对象 |
| 映射草稿生成 | 新建 `POST /systems/:code/mapping-drafts`（`world.draft.create`） | 由路由层组合 `system-onboarding` 与 `governance` 两个域的 public-api |
| 草稿校验 / 发布 | 新建 `POST /systems/:code/mapping-drafts/:id/(validate\|publish)` | **刻意一并接上**——只接生成会让这两个键在新位置上复现空按钮 |

**路由匹配顺序（顺序风险）**：字面量子路径（`mapping-templates` / `connection-targets` / `mapping-drafts`）必须排在 `:code` 之前，否则 `mapping-templates` 会被当成一个系统码。测试第 9 项专门守住这一点。

**元域智营收窄**

- `ConfigManagementPage.vue` 删除「接入系统配置」「当前生效映射」「元模型连接模板」三区块与 3 个 emit（54 → 46 行）；`App.vue` / `governance-actions.js` / `page-data-registry.js` 同步删除对应状态与动作（config 分支的 `Promise.all` 由 7 个降到 6 个）。
- **旧端点本阶段不删**，保留一个版本周期；元域智营已无入口，迁移后可用 404 计数确认无残留调用。
- 断言口径同步改写：`frontend/test/page-data-registry.test.js` 原以 `canAccessPage: () => false` 跳过 world 拉取，签名去掉该参数后这个写法会**悄悄失效（永远为真）**。已重写为「断言**不存在**这条调用路径」（`forbidden` 名单 + Proxy 记录调用），而不是「被权限挡住」。

**实测验收**

| 项 | 结果 |
| --- | --- |
| `test:access` | 9/9 |
| `test:architecture` | 10/10；跨包基线保持 **0**；跨域边 **8 → 10**（新增 2 条，见下） |
| `test:registry` | 7/7 |
| `test:semantic` | 5/5（SDK）+ 60/60（运营端）+ 91/91（后端与路由） |
| `test:permissions` | 29/29（含重写后的 page-data-registry 三项） |
| `test:mock-onboarding` / `test:ontology` | 69/69 / 104/104 |
| 5 端构建 | `frontend` / `semantic-operations-console` / `desktop` / `mobile` / `dingtalk` 全部通过 |
| `lint` / `typecheck` / `docs:check` | 通过 |
| 可探测系统 | **5 → 7**（OA/ERP/WMS/MES/LIMS/QMS/OMS） |
| 阻断实测 | 越权探测 → `SYSTEM_PROBE_FORBIDDEN/403`；无连接器 → `SYSTEM_CONNECTOR_NOT_REGISTERED/409`；未知响应模式 → `SYSTEM_PROBE_FAULT_UNKNOWN/400` |

**跨域边登记（有意增加，非耦合）**：新增 `system-access-service → mock-onboarding-source-service`（探测读内置合成数据源）与 `system-access-service → semantic-tenant-context`（探测结果按租户隔离）。**刻意未加** `→ world-model-template-service`：连接模板/映射草稿仍属 governance 域，由**路由层组合两个域**，不制造第三条边。

**三处自我修正（均为实测驱动）**

1. **可探测性判据错**：初版用 `mockOnboardingScenarios[].systems`（材料场景**声明范围**）判定，实测 LIMS 不在任何场景声明中却确有 `Inspection` 记录（`quality_incident` 数据集 ERP16/LIMS2/MES15/WMS19/OMS16/QMS1/OA9）。改为按「数据源里**实际有无该系统的记录**」判定（`readMockScenarioSystems`），可探测数 5 → 7。**「材料声明的范围」与「数据源里实际有的数据」是两件事，前者是人工准备边界，后者才是可读性。**
2. **错误码语义错**：`schema_drift` 是「读到了，但字段目录对不上」，**不得与「失败」混为一谈**，故生成 `status: 'schema_drift'` + `issue.code: 'MOCK_SOURCE_SCHEMA_DRIFT'`，而不是 `status: 'failed'`。
3. **字段目录计数虚高 + 重复键**：初版逐场景 `push`，而同一对象会被多个合成场景声明（WMS 的 `StockPosition`/`Warehouse`、OMS 的 `SalesOrder`），导致「对象目录」被重复项撑大（**WMS 10 → 实际 8，OMS 8 → 实际 7**），且前端以 `table.name` 作 `v-for` 的 `:key` **产生重复键**。改为按 `name` 归并并记录 `scenarioIds`。进一步实测发现归并**不等于**合并语义：WMS `StockPosition` 在两个场景里字段声明**确实不同**（`fulfillment` 含 `stock_id`/`ownership`/`unit`；`quality_incident` 只有 `lot_id`/`warehouse_id`/`qty`/`status`），因此字段签名不一致时进入 `fieldCatalog.conflicts` 由界面显式呈现，**不静默取先出现的那个**（否则「字段目录」会随场景遍历顺序漂移）。同时透出 `readScenarioId`（探测实际读取的场景），界面注明「目录是各场景声明的并集，探测只读其中之一」。

**同时修正了一处被遗漏的测试契约（与阶段 2 无关，属前一增量遗留）**：`backend/test/ark-model-gateway.test.js` 中一项断言 `createSemanticOperationsTask` 在模型传输失败时 `status === 'failed'`。但「元域智语接入云大模型」增量**有意**把该路径改为**回落服务端确定性分类**（否则模型一抖入口就变死路，已被实测复现），`status` 相应变为 `'completed'`，而该测试**未被同步更新**——`test:ark` 因此长期为 38/39。已按新契约改写，并**加强**而非放宽断言：要求 `modelUnavailable === true`、`routing.mode === 'server_rules_fallback'`、`routing.degraded === true`、`routing.modelFailureCode` 非空、事件含 `model_understanding_unavailable`，同时 `command` / `proposal` / `requiredPermission` 均为 `null`、`confirmationRequired === false`。**降级必须显式可归因，不得获得任何执行能力。**

**同时修正了一处既有并发缺陷（与阶段 2 无关，但会污染验收结论，故一并修掉）**：跑完整质量门禁时 `test:multitenant` 的 `MT-15` 与 `tenant-runtime-sqlite` 会**间歇性**失败（`real SQLite CLI: ... cross-process quota`）。隔离复现确认与阶段 2 无关：单文件重复运行 12 次，基线 **2/3 失败**。

- **根因（实测，非推断）**：6 个并发 worker 各自打开同一个 `runtime.db`，Windows + WAL 下 `-shm` 建立存在竞态，部分 worker 抛 `ERR_SQLITE_ERROR: attempt to write a readonly database`（`errcode=8`，即 `SQLITE_READONLY`）。采样 6 次运行，出现 4 次 `{allowed:false, code:'ERR_SQLITE_ERROR'}` 与配额拒绝混在一起。
- **为什么必须修而不是改测试**：`authorize()` 的语义是「今日配额已用尽 → `RUNTIME_DAILY_QUOTA_EXCEEDED`」。若把原始 SQLite 错误也算作「未通过」，则「配额用尽」与「数据库恰好被别的进程占用」在调用方看来是同一件事，多租户配额的结论就不可信了。**放宽断言等于承认 exactly-once 配额在并发下不成立**，这是不能接受的。
- **修法**：`backend/src/repositories/runtime-state-repository.js` 把 `BEGIN IMMEDIATE` 事务抽为 `runTransaction`，对**暂时性文件锁错误**（`errcode` ∈ {5 BUSY, 6 LOCKED, 8 READONLY}）做**有界重试**（6 次，20ms×attempt 同步退避）。关键点：`SQLITE_READONLY` 在 WAL 下可能让**这条连接永久失效**（`-shm` 被别的进程重建后映射过期），**原地重试无效**——实测残留 1/12 失败；改为命中该错误时**先重开连接再重试**后，15 次运行 0 错误。
- **安全性**：失败点必定落在 `BEGIN IMMEDIATE` 之后、`COMMIT` 之前的写操作上，未提交即无副作用；配额计数始终是「读-判-写」在同一个 IMMEDIATE 事务内完成，重试不会重复记账。`resetRuntimeState` 的 prepared statement 随之下移到事务内部（重开连接会使外部持有的 statement 失效）。
- **实测结果**：单文件 12 次运行 **12/12 通过**（基线 2/3）；`test:multitenant` **75/75**、`test:persistence` **35/35**。

**已知边界（如实）**

- `systemConfigurations`（责任人 / 同步频率 / 字段→对象映射）**仍来自 demo 种子、尚未租户隔离**，返回 `configurationSource: 'demo_seed'`，界面显示「来源：demo 种子样例」。属阶段 6 范围。
- 探测读的是**内置合成 HTTP 数据源**（`sourceKind: 'local_mock_http'`），**不是真实企业连接器**；返回值与界面均显式标注，不得表述为生产验收。
- `fieldCatalog.conflicts` 中的 `StockPosition` 差异是**既有合成数据的真实不一致**，本阶段只做显式暴露，**未修改 `examples/` 下的夹具数据**（改夹具会牵动 supply-chain 回归）。
- 元域智营中 `.config-menu` / `.ontology-mapping` / `.integration-settings` / `.mapping-*` 等 CSS 规则**已成为死代码，尚未清理**。
- 「材料与场景准备」降为同页次级标签（`SemanticOnboardingWorkspace` 保留，改懒挂载）。

---

### 阶段 3：选系统成为建模必选项 —— **已完成（2026-09-25）**

**产物**

| 文件 | 说明 |
| --- | --- |
| `backend/src/services/semantic-source-discovery-service.js`（改写范围解析） | 新增 `systemCodes` / `includeAllRegistered` 两个**显式**入口；新增 `selectionSource` / `selectedSystemCodes` / `explicitSystemCodes` / `mentionedNotSelected` / `scopeNotice`；每个 source 新增 `registryKnown` |
| `backend/src/services/semantic-operations-task-service.js`（新增范围门禁） | `resolveSemanticSystemScope` 四类拒绝 + `summarizeSystemScopeCoverage` 覆盖上报 + `describeScopeFindings` 可读摘要；任务新增 `systemScope` 字段并进入 `publicTask` 白名单 |
| `backend/src/routes/governance-routes.js` | `/sources` 支持显式 `scope=all_registered`；任务创建的错误响应**透出 `code`**（此前只回 `message`，前端只能靠文本匹配补救） |
| `services/semantic-inspection-worker/app.js` | 巡检的「全部已登记来源」改为**显式**声明 |
| `packages/semantic-operations-sdk/src/index.js` | 新增 `semanticSources({ query, scope })` |
| `apps/semantic-operations-console/src/components/SemanticAgentWorkspace.vue` | 建模范围多选面板 + 前端门禁 + 覆盖结果展示 |
| `backend/test/semantic-system-scope.test.js`（新增，10 项） | 六类范围用例 + 覆盖/不一致上报 + 形状校验 + 意图边界 + 承接提示 |
| `package.json` | 新增 `test:scope` 并挂入 `test:all` |

**核心动作：删掉「范围从哪来」的隐式回落**

历史行为是一行三元表达式：

```js
requestedSystems.length ? requestedSystems : connectorCatalog.filter(item => item.accessible).map(item => item.system)
```

它有两种坏情况，都会让一次建模的**实际覆盖范围超出运营人员的可见选择**，且界面上看不出来：

1. 文本里碰巧出现系统名（哪怕出现在「不要用 ERP」这种否定句里）就被当成范围；
2. 什么都没提到时把范围放大到**整个角色可见面**。

现在范围只有两个显式入口：请求体的 `systemCodes`（空数组＝显式选择为空），或调用方显式声明 `includeAllRegistered: true`。两者都没有时范围为空，**没有回落**。`selectionSource` 如实记录范围来源（`explicit` / `explicit_empty` / `text_inference` / `unspecified` / `all_registered`），`scopeNotice` 对非显式来源给出可读说明。`detectRequestedSemanticSystems` 降级为**提示素材**：`mentionedNotSelected` 只用于告知「文本提到 WMS 但未选择」，不进入范围。

**四类拒绝（实测错误码）**

| 情形 | 状态码 | 错误码 | 实测 |
| --- | --- | --- | --- |
| 未提供 / 空数组 | 400 | `SEMANTIC_SYSTEM_SCOPE_REQUIRED` | `{ text: 建模诉求 }` 与 `systemCodes: []` 均拒绝 |
| 编码不在注册表 | 400 | `SEMANTIC_SYSTEM_UNKNOWN` | `['NOPE']` |
| 在注册表但无受控连接器 | 400 | `SEMANTIC_SYSTEM_NOT_REGISTERED` | `['SRM']`（`registryKnown: true`） |
| 超出角色数据域（4.5 决策 C：阻断） | 403 | `SEMANTIC_SYSTEM_SCOPE_FORBIDDEN` | `marketing_manager` + `['OMS','ERP']` 整单拒绝，**不静默裁到 OMS** |

请求体形状非法（字符串、混入非字符串、空白项、对象）→ 400 `SEMANTIC_SYSTEM_SCOPE_INVALID`，不猜用户意图。

**覆盖上报（禁止静默丢弃）**

提案生成后计算 `task.systemScope`，**不按范围过滤对象**——过滤会让「材料里有、但范围外」的事实消失，而那通常意味着选择错了或材料传错了：

| 字段 | 含义 | 实测示例 |
| --- | --- | --- |
| `covered` | 有对象标注该系统的 | `['ERP']` / `['ERP','WMS']` |
| `uncovered` | 选了但一个对象都没有（含原因） | — |
| `unassignedObjects` | 材料未声明来源、无法追溯的对象 | `[]`（制造业夹具全覆盖） |
| `outOfScopeObjects` | 来源系统不在所选范围内的对象 | 只选 `WMS` 建模「供应商/采购订单/原料批次」→ 3 个对象中 `Supplier`/`PurchaseOrder` 标注 `ERP`，显式列出 |
| `mentionedNotSelected` | 文本提到但未选择的系统 | 文本含 ERP+WMS、只选 ERP → `['WMS']` |

**与计划字面口径的一处偏离（如实记录）**：计划写「`selectedSystems.length === 0` → 禁用提交」。按字面实现会把「你好」「你是谁」这类**对话类诉求**也一起禁掉，而服务端对对话类意图本就不要求范围（`SOURCE_BOUND_INTENTS` 只含 `build_model` / `discover_sources`）。因此前端按「**诉求看起来要建模** + 未选系统」判定禁用，并保留服务端硬门禁作为唯一权威；其他意图收到 `SEMANTIC_SYSTEM_SCOPE_REQUIRED` 时前端高亮范围面板并显示原文原因。**客户端不替服务端决定哪些意图需要范围。**

**承接上文不继承范围**：`parentTaskId` 存在时仍要求本轮显式给出，但错误信息会带上「上文任务的范围是 X，如仍要沿用请在本轮显式带上」。范围**不得靠继承静默生效**（实测断言）。

**验收（本机实测，内置合成数据）**

`npm run quality` 端到端 **0 失败**：`test:scope` 10/10、`test:access` 9/9、`test:architecture` 10/10、`test:registry` 7/7、`test:semantic` 6+60+92、`test:conversations` 22/22、`test:ark` 39/39、`test:permissions` 29/29、`test:multitenant` 75/75、`test:persistence` 35/35、`test:ontology` 104/104、`test:mock-onboarding` 69/69；5 端构建全通过；lint / typecheck / docs:check 通过。

**因契约变更同步更新的既有测试（4 文件）**：`semantic-operations-agent.test.js`（+范围断言与「非来源绑定意图不得被动获得范围」）、`semantic-manufacturing-regression.test.js`（SM04/05：承接轮不继承范围 + 六系统全覆盖 + `uncovered` 为空）、`semantic-source-discovery` 相关断言（`selectionSource` 必须标注为 `text_inference`）、`packages/semantic-operations-sdk` 与 `apps/semantic-operations-console` 各 +1 项。

**同时修正了一处被误判为「偶发竞态」的测试卫生缺陷（与阶段 3 无关，但会污染验收结论）**：`test:permissions` 在整链运行时偶发失败。阶段 2 的台账把它记为「预存 flaky：权限加固测试 API 启动竞态」，并写下「单独运行 8/8 通过」。**本轮实测推翻了这个归因**：单独运行同样会失败，三次连跑分别失败 **3 / 1 / 0** 项，且每次失败的是不同用例——说明不是竞态，而是**稳定的预算不足**。

- **实测根因**：生产配置（`NODE_ENV=production` + `RUNTIME_STORE_DRIVER=sqlite`）下 API 从 spawn 到 `/api/health` 就绪需 **1097 / 1097 / 1519 ms**，而测试的等待预算是 **40 × 25ms = 1000ms**，且失败信息只回一句「未就绪」+ 空日志，无法区分「启动慢」与「启动失败」。
- **修法**（改测试的预算，不改断言口径）：`permission-api-hardening.test.js`（两处）与 `permission-management.test.js` 的等待改为**按时间计预算**（`API_STARTUP_TIMEOUT_MS = 8000`），失败信息带上实际等待时长与子进程日志。断言本身一条未放宽。
- **实测结果**：`test:permissions` 连跑 **5 次全部 0 失败**（此前 3/1/0）。

**已知边界（如实）**

- 本阶段**只改「范围从哪来」，不改建模算法**：范围不裁剪对象（按范围抽取对象与跨系统连接推导属阶段 4）。因此「只选 WMS 却得到 ERP 对象」在**本阶段**是**预期行为**，由 `outOfScopeObjects` 显式上报，而不是静默保留或清除。→ **该边界已在「阶段 4 前置」中关闭**（范围改为过滤器，`outOfScopeObjects` 拆为 `partialScopeObjects` 与 `excludedObjects`）。
- 前端的「文本提到但未选」提示只按**系统编码**匹配，不含别名；权威判定始终在服务端（服务端用注册表别名表）。
- 范围仍不改变**数据授权**（4.5 决策 A+C）：勾选不构成提权，越权只是被拒绝而不是被授予。
- `discoverSemanticSources` 的 `sources` 仍返回连接器目录里的 `objects`（候选对象名），这是既有的只读来源清单语义，未做租户隔离（属阶段 6）。

---

### 阶段 4 前置：范围成为过滤器（ADR-012 退出条件 2 的解决）—— **已完成（2026-09-25）**

**为什么单独记一节**：这不是阶段 4 的功能本身，而是它的**前置契约**。阶段 3 的 ADR-012 明确留了退出条件 2——「若阶段 4 让范围开始裁剪对象，则 `outOfScopeObjects` 的语义会从『材料与选择不一致的上报』变成『被过滤掉的记录』，届时必须重新决定范围是**过滤器**还是**上报口径**」。阶段 4 要「按选中系统的字段目录抽取对象」，**抽取本身就是一次筛选**，该条件当场被触发。用户于 2026-09-25 选择**「过滤 + 被排除清单显式列出」**，决策记入 [ADR-013](../architecture/adr/ADR-013-scope-as-filter-with-explicit-exclusions.md)。

**触发它的具体问题**：运营勾选 ERP + WMS，上传的材料里含 QMS 的「来料检验记录」。三个候选里，纯过滤会在运营忘勾 QMS 时**看不到任何迹象**（正是本次重构一直在消除的静默模式）；不过滤则让范围对提案几乎没有约束力；选定的是第三种的组合——**过滤，但被排除项必须可读地列出来**。

**产物**

| 文件 | 说明 |
| --- | --- |
| `backend/src/services/semantic-operations-agent-service.js` | 新增 `applyScopeFilterToObjects`（对象判定）与 `partitionRelationshipsByScope`（关系随端点排除）；`createSemanticOperationsProposal` / `...FromRequest` 新增 `scopeSystems` 入参；提案新增 `scopeExclusions`；新增错误码 `SEMANTIC_PROPOSAL_SCOPE_EXCLUDED_ALL` |
| `backend/src/services/semantic-operations-task-service.js` | `summarizeSystemScopeCoverage` / `describeScopeFindings` 改为报告过滤结果；`systemScope` 字段集更新 |
| `apps/semantic-operations-console/src/components/SemanticAgentWorkspace.vue` | 展示被排除对象 / 随对象排除的关系 / 部分超出对象；范围类错误识别扩到提案阶段 |
| `docs/architecture/adr/ADR-013-*.md`（新增） | 决策记录（含 3 条复审条件） |
| `backend/test/semantic-system-scope.test.js` | 用例由 10 项扩到 **12 项**（+ 全被排除的独立错误码、部分超出保留与上报） |

**过滤规则（实测口径）**

| 情形 | 对象去向 | 上报字段 |
| --- | --- | --- |
| 全部来源在所选范围内 | 保留，计入 `covered` | — |
| **部分**来源在范围外 | **保留**（有合法在范围内的来源，排除会丢掉范围内系统的真实事实） | `partialScopeObjects`（含 `outside`） |
| **全部**来源在范围外 | **排除** | `excludedObjects`（含 `sourceSystems`） |
| 来源为 `UNASSIGNED` | **保留**（把「未标注」当「超范围」会让纯自然语言抽取路径整体被清空） | `unassignedObjects` |
| 关系任一端点被排除 | **一并排除**（避免留下悬空边） | `excludedRelationships`（含 `reason`） |

**两处实现上的关键取舍**

1. **关系必须在过滤前的候选集上组装**。若先按保留对象过滤，被丢弃的关系就再也看不见了，「关系为什么少了」无法归因；改为在 `extractedIds` 上组装、再按 `keptIds` 切分并上报，`reason` 还区分「被范围排除」与「本次压根没识别到」——否则运营会去查一个不存在的系统。
2. **「对象全被排除」必须与「什么都没识别到」区分**。两者都用 `SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS` 会让运营去改材料，方向就错了；前者是范围问题（补选系统即可解决），故新增独立错误码 `SEMANTIC_PROPOSAL_SCOPE_EXCLUDED_ALL`，并在报错里点名是哪些对象、来自哪个系统。

**验收（本机实测，内置合成数据）**

`test:scope` **12/12**（含新增的 2 项）、`test:semantic` 6+60+92、`test:conversations` 22/22、`test:desktop` 20+10、`test:architecture` 10/10（**未增跨域边**）；`npm run quality` 端到端 **0 失败**；lint / typecheck 干净；`docs:check` 175 份 Markdown / 943 个本地链接；5 端构建通过。运营端 `workspace-layout` 断言同步更新（并新增「旧字段不得残留」的反向断言）。实测：只选 WMS 建模「供应商/采购订单/原料批次」→ 提案对象 **3 → 1**，`PurchaseOrder`/`Supplier` 进入 `excludedObjects` 且 `sourceSystems: ['ERP']`，`excludedRelationships` 非空，任务回应出现「按范围排除的对象…补选系统后重跑」。

**因契约变更同步更新的既有测试**：`semantic-system-scope.test.js` 的用例 2/4/5/6 与运营端 `workspace-layout.test.js`。用例 4 的「不越权即可通过」分支改用 `门店`（OMS）诉求——**范围过滤之后，选一个授权但毫无内容来源的系统会得到「对象全被排除」，那不是越权问题**，原用例被这一新语义暴露出了前提不成立。

**已知边界（如实）**

- 被排除对象承载的业务事实**确实不再进入提案**。若某对象只有 QMS 一个来源而运营未勾 QMS，它就从提案里消失了——这是**有意选择**，缓解手段是显式清单 + 提示补勾。
- `outOfScopeObjects` 字段名**已移除**，属对外契约破坏性变更（阶段 3 刚发布）；SDK 无该字段的具名封装，故仅后端与运营端受影响。
- 被排除清单是**提示**，不是阻断：任务仍然成功返回提案。是否需要「先补勾再生成」的阻断式交互，见 ADR-013 复审条件 1。
- 阶段 4 真正需要模型能力的部分（从非结构化材料抽取对象与标识）**尚未开始**；其确定性一半记在下面的阶段 4a，已落地。

---

### 阶段 4a：按系统字段目录识别标识 + 跨系统标识对应 —— **已完成（2026-09-25）**

**为什么先做这一半**：阶段 4 要求「按选中系统的字段目录/样本抽取对象与标识」并「识别同一业务实体在不同系统的标识对应、推导关系与基数」。这一句里其实混了两件事——**从非结构化材料抽取需要模型**，而**标识对应的推导不需要**。后者如果也交给模型，就既不可复现也不可复核，而本阶段的验收明确写着「对象数 / 关系数 / 跨系统连接数 / 冲突数**可复现**」。因此先落地确定性的一半（4a），模型那一半单独排期（4b）。

**产物**

| 文件 | 说明 |
| --- | --- |
| `backend/src/services/semantic-identity-link-service.js`（新增） | `buildSystemFieldCatalog`（按所选系统收敛字段目录）+ `deriveIdentityLinking`（标识识别、跨系统对应、四类冲突、未解析引用） |
| `backend/src/services/semantic-operations-agent-service.js` | 提案新增 `identityLinking`；`publicProposal` 白名单补该字段；修订提案后**重算**（字段变了对应就会过期） |
| `backend/src/services/semantic-operations-task-service.js` | `summarizeSystemScopeCoverage` 输出 `identity.{summary, conflictKinds}`；新增 `describeIdentityFindings` 与事件 `system_identity_linking_reported` |
| `apps/semantic-operations-console/src/components/SemanticAgentWorkspace.vue` | 展示跨系统引用（`requires_mapping` 单独标注）、四类冲突、未识别标识、未解析引用 |
| `docs/architecture/adr/ADR-014-identity-linking-as-assumption.md`（新增） | 决策记录（含 4 条复审条件） |
| `backend/test/semantic-identity-link.test.js`（新增） | 7 项确定性用例，`test:identity` 并挂入 `test:all` |

**核心动作**

1. **字段目录按所选系统收敛**：事实只有两处，都是既有事实源——提案候选对象与 `data/seed.js` 的 `systemConfigurations`（各系统已声明的对象与字段）。不新增定义；每条记录带 `groundings` 区分「来自提案对象」与「仅来自系统声明」。
2. **标识三档识别，不识别就不判定**：受控词汇表登记主键 → 由对象名派生的 `<object>_id` → 声明中**唯一**指向该对象自身概念的标识字段 → 否则记入 `keyGaps` 并给出候选。
3. **跨系统对应**：A 的标识字段指向概念 C，B 的标识也指向 C，且两者来自不同系统 → 产出一条带方向、基数（`n:1`）与逐字证据（`WMS.InboundReceipt.purchase_order_id → ERP.PurchaseOrder.purchase_order_id`）的链接；形状不一致时标 `requires_mapping`。
4. **只上报，不自动并入** `relationshipTypes`（ADR-014 决策 1）。

**四类冲突（全部显式上报）**

| kind | 含义 | 处置 |
| --- | --- | --- |
| `ambiguous_identifier` | 字段名归一化后无法说明指向哪个实体（`id`/`code` 这类泛化名） | `blocksLink`，**不参与**链接推导 |
| `alias_divergence` | 同一概念由多个字段名表达（同义不同名） | 上报并附出现位置，**不**默认等价 |
| `key_shape_incompatible` | 同一概念上代理键与业务键混用 | 上报；链接标 `requires_mapping` |
| `declaration_divergence` | 同一对象名（或同一张表）在两处声明中字段集不一致 | 上报；**同名不等于同一实体** |

**两处实测踩到的规则缺口（已修，是本阶段最有价值的产出）**

1. **外键被当成主键**。初版按「取第一个 `_id` 后缀字段」兜底，于是 `ERP.Inventory` 的 `lot_no`（指向**物料批次**）成了库存自己的标识，凭空变成「物料批次」概念的对齐目标，实测把跨系统链接从 11 条虚增到 **16** 条、11 条打上 `requires_mapping`。修正为「对象自己的标识必须指向该对象自身概念」后，`ERP.Inventory` 正确落入 `keyGaps`（ERP 库存的复合业务键未在映射中声明），链接回落到 11 条。**同一处还解决了 `WMS.InboundReceipt` 三个 `_id` 字段的歧义**：按顺序取值的规则，对错取决于字段顺序，那不是规则。
2. **裸名列被误判为标识**。`lims.test_result.result` 是值列，却因词干落在概念别名表里被当成标识，于是凭空多出「同义不同名」冲突。修正为：裸名一律走显式的 `BARE_IDENTIFIER_NAMES` 白名单，不用别名表兜底。

**验收（本机实测，内置合成数据，6 系统）**

`test:identity` **7/7**（新增）；`test:scope` 12/12；`test:semantic` 6+60+92；`test:architecture` 10/10（**未增跨域边**）；lint / typecheck 干净。

确定性计数：字段目录对象 **21**（受控词汇表 12 + 系统声明去重）、标识字段 **33**、跨系统链接 **11**（`linkable` 4 / `requires_mapping` 7）、冲突 **14**（`alias_divergence` 5 + `declaration_divergence` 5 + `key_shape_incompatible` 4）、`keyGaps` **1**、未解析引用 **1**。`relationshipTypes` 仍为 **8**（本能力**不**增加草稿关系）。

方案原文举的例子真实出现：`WMS.InboundReceipt.purchase_order_id → ERP.PurchaseOrder.purchase_order_id`（`n:1`，`linkable`）。

**已知边界（如实）**

- `links` **不进入** `relationshipTypes`，因此当前收益是「可见但未生效」——跨系统连接要等 4b 的复核合并动作才真正落到草稿上。这是刻意选择（ADR-014 决策 1）。
- 概念别名表是**人工维护的领域知识**，它不准则对应不准。设计上把「一词干两概念」交给运行时歧义上报，但表本身的覆盖度仍靠人补。
- 冲突**只上报，不给处理动作**（合并 / 改名 / 区分粒度都还没有入口），且未分级收敛——6 系统下 14 项，量级偏大。
- 字段目录**不按材料命中裁剪**，因此报告里会出现材料从未提到的系统声明对象；这是刻意的（目录回答的是「范围内的系统声明了什么」），并已由 `groundings` / `declarationSourced` 标注来源（阶段 4e 起由 `notInProposal` 改名而来——旧名字容易被读成「不可确认」，而它只回答「依据来自哪儿」）。
- 事务概念归属只覆盖别名表内的词干；未登记词干（如 `stock`）既不连也不报歧义——**可能漏掉真实对应**，属已知覆盖缺口。
- 归属候选进目录会带来新的 `declaration_divergence`：同一对象在材料与系统声明里字段不一致时会被上报。这是期望行为（阶段 4 第 3 条要求冲突显式上报），但会加剧本已偏大的冲突量级。
- 仍**不含**「从非结构化材料抽取对象与标识」的证据链之外的模型判断——模型只被要求给逐字原文（含归属原文），所有判定都在服务端做（阶段 4c 第二段）。

---

### 阶段 4b：标识对应确认后并入 —— **已完成（2026-09-25）**

**为什么单独记一节**：4a 把标识对应推导出来了，但它**对模型没有任何影响**——运营在界面上看到 11 条跨系统引用，最终草稿一条也没多。这本身就是本次重构一直在消除的模式的变体：**界面展示了结论，人自然会以为它已经在模型里**。本阶段把「可见」变成「确认即生效」，同时不放弃 4a 的核心约束（假设不得冒充证据）。决策记入 [ADR-015](../architecture/adr/ADR-015-identity-link-confirmation.md)，它**承接 [ADR-014](../architecture/adr/ADR-014-identity-linking-as-assumption.md) 决策 1**（ADR-014 自己写明「不允许自动并入」，退出条件 1 要求先定确认落点与证据等级）。

**触发它的具体问题**：ADR-014 留的三个问题——确认落在哪个动作上、并入的边标什么证据等级、假设与证据怎么才算「仍可区分」。三条都必须在写代码前定，否则并入会把一次字符串匹配洗成材料事实。

**产物**

| 文件 | 说明 |
| --- | --- |
| `backend/src/services/semantic-identity-link-service.js` | 链接新增稳定 `key`；新增 `buildConfirmedRelationships`（确认 → 关系、材料证据优先、失效分类） |
| `backend/src/services/semantic-operations-agent-service.js` | `updateSemanticOperationsProposal` 接受 `identityLinkConfirmations`：先剔除客户端同源关系、重算标识对应、再按确认集合重建；`sanitizeProposalDraft` 关系白名单补 `derivedFrom`（原先会被静默丢弃）；`publicProposal` 透出确认集合与报告 |
| `backend/src/services/semantic-operations-task-service.js` | 透传 `identityLinkConfirmations`；任务回应逐项说明并入/被证据挡住/因修订失效 |
| `apps/semantic-operations-console/src/components/SemanticAgentWorkspace.vue` | 新增「跨系统标识对应复核」面板（逐条勾选 + `requires_mapping` 映射依据输入）；并入的边在关系编辑器与关系建议中标注「推断（人工确认）」且**不可直接编辑** |
| `docs/architecture/adr/ADR-015-*.md`（新增） | 决策记录（含 4 条复审条件） |
| `backend/test/semantic-identity-link.test.js` | 用例由 7 项扩到 **12 项**（+ 并入与可区分、键形状与映射依据、撤销与幂等、失效分类、材料证据优先） |

**核心决策**

- **确认落在既有复核动作上**（`PATCH .../proposal` 的 `identityLinkConfirmations`），不新增端点：并入本质是修订草稿关系，走既有通道才能自动获得版本冲突检测、Schema Critic 重算、Diff 与「修订后确认凭证失效」这些不变量。
- **证据等级取 `inferred`，明确不取 `confirmed`**：`confirmed` 在本体契约里是最高等级（只有它无须复核）。给一条字段名归一化推出的边标 `confirmed`，等于宣布一次字符串匹配达到了人工核实事实的地位。
- **可区分性靠 `provenanceType` + `derivedFrom`**：材料声明的边是 `declared`，并入的是 `inferred` 且带来源链接 key。这是 ADR-014 退出条件 1 的直接答案。
- **`requires_mapping` 必须随确认给出映射依据**：两端键形状不同意味着不能按值直接连接，允许「确认但无依据」等于把已知不可连接的关系伪装成可连接。
- **确认集合是全量语义**（省略＝不调整、空数组＝撤销全部），且**服务端从确认集合重建**、客户端自带的同源关系一律剔除——「人工确认」这道关口因此不能被一次构造请求绕过。

**验收（本机实测，内置合成数据，6 个系统）**

`npm run quality` 端到端 **0 失败**；`test:identity` **12/12**（7 → 12）、`test:scope` 12/12、`test:semantic` 6+60+92、`test:conversations` 22/22、`test:architecture` 10/10（**未增跨域边**）、运营端 `workspace-layout` 7/7；lint / typecheck 干净；`docs:check` 177 md / 978 链接；5 端构建通过。

确定性流程实测（同一次探针，6 系统基线下 `relationshipTypes` 8 条、链接 11 条）：

| 场景 | 实测结果 |
| --- | --- |
| 确认 1 条 `linkable` | 关系 **8 → 9**，新增边 `TestResult.references_material_batch_id → RawMaterialBatch`，`provenanceType: 'inferred'`、`derivedFrom` = 链接 key |
| 重复确认同一条 | 仍为 9（幂等，不堆重复边） |
| 省略 `identityLinkConfirmations` | 保持既有确认（普通字段修订不会顺手撤销） |
| 提交空数组 | 并入数 **→ 0**，确认集合清空（撤销） |
| 客户端伪造带 `derivedFrom` 的关系 | 保存后 **被剔除**（并入数 0） |
| `requires_mapping` 无映射依据 | 400 `SEMANTIC_IDENTITY_CONFIRMATION_REQUIRES_MAPPING_EVIDENCE`，点名对象 |
| `requires_mapping` 带依据 | 并入成功，依据出现在关系 `evidence` 上（实测 211 字，整句收尾） |
| 字段改名使继承确认失效 | 不阻断修订，`droppedStale` 列出该 key，任务回应出现「因字段修订而失效…已移除并在此列出」 |
| 显式重新提交已失效 key | 400 `SEMANTIC_IDENTITY_CONFIRMATION_STALE` |

**偏离记录（如实）**

1. **`evidence` 上限由 100 放宽到 260**：一条 `requires_mapping` 的边要同时容纳链接证据、键形状说明与人写下的映射依据，100 字必然截断。首版按硬截断实现，实测出现 **「；该来源系统」** 这种半句话——改为按优先级拼装、装不下就整条舍弃，并在用例里反向锁死「截断必须发生在整句边界」。放宽的是展示保真度上限，不是安全边界。
2. **映射依据上限 80 字**：依据应是一行可核对的说明，不是一篇论证；超出部分写入时截断（未在界面提示剩余字数，属已知粗糙处）。
3. **界面对并入的边禁用编辑**：既然服务端每次都从确认集合重建，允许直接改谓词/端点/删除只会让人以为改成功了。这是刻意收窄交互，不是遗漏。

**已知边界（如实）**

- **冲突仍只上报、无处置动作**：`ambiguous_identifier` 的归属指派、`alias_divergence` 的等价裁定、`declaration_divergence` 的合并/区分粒度都没有入口（见 ADR-015 复审条件 3，属阶段 4c）。`requires_mapping` 的「依据」是自由文本，不是结构化映射定义。→ **`alias_divergence` 的等价裁定已在「阶段 4c（第一段）」关闭；`declaration_divergence` 的合并 / 区分粒度已在「阶段 4c（第三段）」关闭；`key_shape_incompatible` 的结构化标识映射已在「阶段 4d」关闭**（`requires_mapping` 的依据升级为结构化 `keyMapping`，并拆出 `shape_unknown` 态）；唯余 `ambiguous_identifier`（实测 0 条）。
- **界面上的「已确认」只表示提案记录了确认**，写入草稿仍需后续「确认写入草稿」动作；本轮没有改动那条链路。
- **模型驱动的抽取已接入，但只到「归属」这一档**：模型被要求逐字给出表名、字段、主键、外键与**归属原文**，所有判定（含归属）都在服务端做；归属一律是候选，确认后才写来源系统（「阶段 4c（第二段）」）。**真实模型轮次已补测（2026-09-25，4 变体 × 3 轮，两次重跑一致）**：`systemEvidence` 的给出与逐字性稳定；**但契约只校验逐字，不校验那句话在语义上是否真在说明归属**。
- 本阶段验收全部为**内置合成数据**，不代表真实企业系统的跨系统连接已验收。

**下一步（阶段 4c）**：
1. ~~另外三类冲突的处置入口~~ —— `declaration_divergence` 的合并 / 区分粒度**已完成（2026-09-25，阶段 4c 第三段）**；`key_shape_incompatible` 的结构化标识映射**已完成（2026-09-25，阶段 4d）**；余下 `ambiguous_identifier` 的按字段归属指派（实测 0 条）。
2. ~~真实模型轮次下归属契约的稳定性测量（ADR-017 复审条件 4）~~ —— **已完成（2026-09-25）**。（`alias_divergence` 的等价裁定已在「阶段 4c（第一段）」落地；模型驱动的归属取证已在「阶段 4c（第二段）」落地。）
3. ~~`notInProposal` 对应的可确认性~~ —— **已完成（2026-09-25，阶段 4e）**：资格判据唯一化（`eligible`）＋ 专用错误码，并更正影响面 5 → **4** 条。

---

### 阶段 4c（第一段）：标识等价假设先裁定 —— **已完成（2026-09-25）**

**为什么先做这一段**：ADR-015 把「冲突的处理动作」留给了阶段 4c，而四类冲突里只有一类是**链接推导的前提**——`alias_divergence`。它的 `reason` 写着「跨系统对接前必须确认它们指向同一个实体」，界面却从未给出确认入口。于是 4a/4b 建成的链路有一个空洞：**11 条对应里有 9 条站在这个没人回答过的前提上**（`MaterialBatch` 一个概念下 3 个字段名支撑 4 条，`Product` 4 个字段名支撑 4 条，`Material` 2 个支撑 1 条）。运营可以逐条确认这 9 条，却看不到它们其实共享少数几个等价假设——这正是本次重构一路在消除的「结论超出可见依据」，只是换了一层。

**为什么先做「裁定」而不是先做「模型抽取」**：模型抽取（4c 第二段）会引入模型不确定性、需要单独的可复现验收设计，且它要回答「模型结论以什么证据等级进入草稿」（[ADR-014](../architecture/adr/ADR-014-identity-linking-as-assumption.md) 复审条件 3）。裁定是纯确定性的、与既有 4a/4b 同构，能在本轮就端到端验收并立刻补上那个空洞。

**产物**

| 文件 | 说明 |
| --- | --- |
| `backend/src/services/semantic-identity-link-service.js` | 新增 `resolveIdentityConflictRulings`（两类动作 + 严格划分校验 + 全量语义 + 失效分流）；`deriveIdentityLinking` 接受 `rulings`，产出 `withdrawnLinks` 与 `rulingReport`，链接与冲突标注 `ruling`；`buildConfirmedRelationships` 的失效项由裸 key 升级为 `{ key, reason }` |
| `backend/src/services/semantic-operations-agent-service.js` | `updateSemanticOperationsProposal` 接受 `identityConflictRulings`：先用**不带裁定**的基线校验概念（不能拿裁定自己的结果判自己），带裁定重算，再把撤下原因传给确认重建；`publicProposal` 透出裁定集合与重算报告 |
| `backend/src/services/semantic-operations-task-service.js` | 透传 `identityConflictRulings`；任务回应按「裁定 → 撤下 → 确认 + 失效原因」的顺序逐项说明；标识发现摘要给出「N 条对应尚未裁定」 |
| `apps/semantic-operations-console/src/components/SemanticAgentWorkspace.vue` | 新增「标识等价假设裁定」面板（逐概念两类裁定 + `distinct_entity` 分组输入 + 撤销）；对应条目标出等价前提状态；被撤下的对应显式列出并注明不再可确认 |
| `docs/architecture/adr/ADR-016-identity-conflict-rulings.md`（新增） | 决策记录（含 4 条复审条件） |
| `backend/test/semantic-identity-link.test.js` | 用例由 12 项扩到 **17 项**（+ 撤下与同组保留、同实体与撤销、分组严格划分、全量语义与失效分流、撤下导致确认失效） |

**核心决策**

- **裁定落在既有复核动作上**（`PATCH .../proposal` 的 `identityConflictRulings`），不新增端点——与 ADR-015 同构，直接获得版本冲突检测、Critic 重算、Diff 与修订历史。
- **裁定不并入草稿、不产生证据等级**：这是对 ADR-015 复审条件 3 的直接回答。裁定回答「这个等价假设成立吗」（改**输入**），确认回答「这条对应要写进模型吗」（改**草稿关系**）——两者不作用于同一层，因此裁定与 `inferred` 不可能混用。顺序也是刻意的：**先裁定假设，再采纳结论**。
- **`distinct_entity` 撤下跨组对应，不保留为可疑项**：留在清单里会出现一条「已知不成立但可以勾选」的边——与 ADR-015 决策 4 对 `requires_mapping` 的立场一致（不留已知不成立的采纳入口）。
- **分组必须是严格划分**：至少两组、不重复、不遗漏、不含陌生字段。部分覆盖会让未提及的字段名落进一个隐含的第三组，等于服务器替人补了一次没声明的裁定。
- **失效项必须区分原因**：`droppedStale` 由裸 key 升级为 `{ key, reason }`。被裁定撤下的对应若此前已被确认，确认随之失效——但「去看裁定」和「去看字段」是两件完全不同的事，一个字符串说不清。

**验收（本机实测，内置合成数据，6 个系统）**

`test:identity` **17/17**（12 → 17）；`test:scope` 12/12；`test:architecture` 10/10（**未增跨域边**，本段新增能力全部落在既有 `semantic-identity-linking` 域内）。确定性流程实测：

| 场景 | 实测结果 |
| --- | --- |
| 基线 | 21 对象、33 标识字段、11 条对应（4 `linkable` / 7 `requires_mapping`）、14 项冲突、5 个概念有等价分歧、**9 条对应的等价前提未裁定** |
| `MaterialBatch` 裁定为不同实体（3 组） | 对应 **11 → 9**，撤下 2 条（`ERP.Inventory.lot_no`、`LIMS.Sample.material_batch_no`），同组 2 条保留并标 `distinct_entity`；`unresolvedAliasConcepts` 5 → 4；草稿关系**仍为 8 条**（裁定不写关系） |
| 同概念改判为同一实体 | 对应回到 **11**，撤下 0，等价前提标 `same_entity`，冲突仍上报但注明已裁定 |
| 提交空数组 | 裁定集合清空，对应回到 11（撤销全部） |
| 省略裁定集合 | 保持既有裁定（普通字段修订不顺手撤销） |
| 分组未覆盖全部字段 | 400 `SEMANTIC_IDENTITY_RULING_GROUPS_INVALID`，点名未覆盖的字段 |
| 只给一组 | 400 同上，提示「只给一组等同于同一实体」 |
| 显式裁定一个无等价分歧的概念 | 400 `SEMANTIC_IDENTITY_RULING_UNKNOWN_CONFLICT` |
| 先确认一条 `requires_mapping` 对应再裁定撤下它 | 草稿关系 9 → **8**，`merged` 1 → **0**，`droppedStale` 列出该 key 并给出「属不同实体」的原因 |
| 撤下后仍显式重新提交该 key | 400 `SEMANTIC_IDENTITY_CONFIRMATION_STALE` |

**偏离记录（如实）**

1. **`droppedStale` 由字符串数组改为对象数组**：ADR-015 落地当天的输出格式被破坏。当前只有内置合成数据与用例在读它，故不做兼容层；若已有外部消费方，需单独评估（已写入 ADR-016 复审条件 4）。
2. **「未裁定的对应数」口径收紧过一次**：首版按 `ruling === null` 计数，得到 11 —— 把 `PurchaseOrder` / `Supplier` 这类**本就没有等价分歧**的对应也算成了「前提未裁定」，高估了问题规模。改为「所属概念仍在 `unresolvedConcepts` 里」后为 **9**，并在用例里锁死。
3. **裁定的合法性用「不带裁定的基线」判定**：首版想直接用裁定结果重算后校验，但那会让一条错误裁定把自己的校验依据一起消掉（概念在带裁定的结果里可能不再出现）。改为先算基线冲突、校验概念、再带裁定重算（两次推导，纯内存开销可忽略）。

**已知边界（如实）**

- **只裁定 `alias_divergence`**。`ambiguous_identifier` 的归属指派未做：实测当前 **0 条**，且它的粒度与按概念裁定不同（泛化标识在同一对象的不同出现位置语义可以完全不同，裁定须按「系统.对象.字段」）；没有真实用例驱动时不做，避免设计一个没有验证场景的粒度。
- **`declaration_divergence` 的合并/区分粒度未做**：这是**对象级**裁决，会改变字段目录的合并语义（当前是同一 `objectId` 的字段取并集）。
- **`key_shape_incompatible` 的结构化标识映射未做**：仍由 `requires_mapping` + 自由文本依据承载（ADR-015 复审条件 2）。
- **服务端只校验「是不是一个合法划分」，不校验「划得对不对」**：域语义只能由人给，代价是裁定质量无机器兜底。
- **无裁定差异视图**：只上报「本次撤下了哪些」，不做与上一版的对比。
- 本阶段验收全部为**内置合成数据**，不代表真实企业系统的跨系统连接已验收。

### 阶段 4c（第二段）：材料归属由模型取证、服务端判定 —— **已完成（2026-09-25）**

**为什么先做这一段，而不是先做另外三类冲突的处置入口**：阶段 4 的方案原文写着「本阶段是本次重构中唯一真正需要模型能力的部分」，而 4a/4b/4c 第一段全部建立在**既有事实源**上（提案候选对象 + 系统配置映射），没有一处用到模型。同时 ADR-014 复审条件 3 要求「说明模型结论以什么等级的『证据』进入草稿」——这一条只能靠真正把模型接进链路来回答，且它正是链路**唯一还断着**的地方。三类冲突的处置入口（归属指派 / 合并或区分粒度 / 结构化映射）规模都不小，但与「模型结论怎么进草稿」是两件事，故排在其后。

**触发它的具体断裂（本机实测，注入符合契约的模型输出）**

材料里逐字写着「ERP 采购订单表 purchase_order」「WMS 收货表 inbound_receipt」「外键：po_id 引用 purchase_order」——正是方案原文举的那个例子。模型输出的表名 / 字段 / 主键 / 外键证据全部通过 `validateNaturalSchema` 的逐字校验，但：

| 观测项 | 改造前 | 改造后 |
| --- | --- | --- |
| 抽取对象的 `sourceSystems` | `['UNASSIGNED']` | 仍是 `['UNASSIGNED']`（候选不写事实） |
| 归属候选 | **不存在这个概念** | `purchase_order→ERP`、`inbound_receipt→WMS`，各带逐字依据 |
| 4a 字段目录对象数 | 13（只有 6 个已登记系统的对象） | **15**（材料里的两个对象进来了） |
| **跨系统标识对应** | **0 条** | **2 条**（含方案原文举例的 `WMS.inbound_receipt.po_id → ERP.purchase_order.po_id`，`linkable`） |
| Critic 失败项 | 受控来源系统、字段来源映射 | 确认归属后只剩「字段来源映射」（既有的待复核设计） |
| 能否采纳 | **不能**（`SEMANTIC_PROPOSAL_CRITIC_FAILED`） | 补齐字段映射后可（归属这一项不再阻断） |

即：**自然语言材料建模链路走不到终点，而卡住它的信息一直就在材料里。** 模型被要求逐字给出表名、字段名、主键与外键的证据，唯独没有被要求给出「这张表属于哪一处」。

**产物**

| 文件 | 说明 |
| --- | --- |
| `backend/src/services/system-registry-service.js` | 新增 `detectDeclaredSystemCodes`：归属判定专用的系统识别（只认系统码与系统名，**不用业务词别名**） |
| `backend/src/services/semantic-natural-schema-service.js` | 契约新增 `systemEvidence`（逐字校验）+ `deriveOwnerCandidate`（三情形判定）+ 返回 `attribution` 报告 |
| `backend/src/services/semantic-identity-link-service.js` | `collectDeclarations` 接受候选归属（新增 grounding `material_owner_candidate`）；对象与链接带 `sourceBasis` / `sourceInferred`；summary 新增候选计数 |
| `backend/src/services/semantic-operations-agent-service.js` | 范围过滤新增 `candidateScopeObjects`（候选不参与裁剪，只上报）；新增 `resolveSourceAssignments` / `applySourceAssignmentsToDraft`；提案新增 `sourceAssignments`；`sanitizeProposalDraft` 白名单补候选字段 |
| `backend/src/services/semantic-world-model-service.js` | `validateProposalEvidence` 接受「有记录的人工归属确认」（与人工补主键同口径） |
| `backend/src/services/semantic-operations-task-service.js` | 透传 `sourceAssignments`；任务回应先说归属确认结果 |
| `apps/semantic-operations-console/src/components/SemanticAgentWorkspace.vue` | 归属候选区：一键按材料确认、依据输入、撤销；候选在范围外单独列出 |
| `docs/architecture/adr/ADR-017-model-extraction-attribution.md`（新增） | 决策记录（含 4 条复审条件） |
| `backend/test/semantic-source-attribution.test.js`（新增） | 12 项确定性用例，`test:attribution` 并挂入 `test:all` |

**核心动作**

1. **模型只给归属原文，判定由服务端做**：契约里没有系统码字段——让模型直接输出 `ERP` 就是给它一个无法复核的断言入口。模型给的是「材料里哪句话说明了这张表属于哪一处」，服务端用系统注册表（ADR-009）判定系统码。粒度也因此落到**表级**：整篇材料会同时提到多个系统，只有收窄到模型引用的那一句才能回答「哪张表属于哪个」。
2. **判定一律是候选**：`candidateSourceSystems` + 逐字依据，`sourceSystems` 仍是 `UNASSIGNED`。归属是事实，候选是推断，两者不混。
3. **候选不参与范围裁剪**：模型在材料里引用一句归属于范围外的原文，不能因此把对象删掉——未确认的归属不足以决定去留。候选在范围内 / 范围外都只上报（`candidateScopeObjects`）。
4. **候选可以进 4a 字段目录**（新增 grounding `material_owner_candidate`）：不进的话，非结构化材料路径的跨系统标识对应恒为 0 条，阶段 4 第 2 条完全落空。进了也只是**候选链接**，仍要经 4b 逐条确认、4c 等价裁定两道关口。
5. **候选转事实要走人工确认**（`sourceAssignments`，复用既有复核动作）：依据不得为空；确认后才写入 `sourceSystems`，并**这时才**按范围重新裁剪。
6. **零 / 多 / 识别不到三类分别上报，一律不猜**（`attribution` 报告）。

**验收（确定性用例 + 真实模型轮次，均本机实测）**

确定性部分（注入模型输出）：`test:attribution` **12/12**（新增）；`test:identity` **17/17**；`test:semantic` / `test:scope` / `test:architecture` 不变；前端 `workspace-layout` **7/7**；lint / typecheck 干净。

**真实模型轮次（2026-09-25 补测，[ADR-017](../architecture/adr/ADR-017-model-extraction-attribution.md) 复审条件 4）**：`npm run evaluate:source-attribution`（`scripts/evaluate-source-attribution.mjs`，走 production 抽取路径，`workbuddy`/`deepseek-v4-pro`，温度 0.2）——4 变体 × 3 轮 = **12 次抽取轮次全部符合预期且 3/3 稳定**（指名系统→产出候选；未写系统→弃权不硬凑；只用业务词→不认别名；一句含两个系统→报歧义不择一），**0 次 `OWNER_EVIDENCE_INVALID`**，单次 3.3–5.6s；端到端（真实模型输出走完整提案链路）：**字段目录对象 4 → 6、跨系统标识对应 0 → 2 条**（`linkable`，含 `WMS.inbound_receipt.po_id → ERP.purchase_order.po_id`），未写归属的对照变体**保持 0 条**；只取证时 Critic 仍报「受控来源系统」（候选不是事实），**按材料原文确认两处归属后 Critic 失败项 2 → 1**（只剩既有的「字段来源映射」）、`inferredSourceObjects` 2 → 0。两次完整重跑结果一致（合计 24 轮抽取，0 抖动）。**真实材料下的归属质量仍未测量**（契约只保证原文逐字来自材料，不保证那句话在语义上真在说明归属）。

关键实测：

| 场景 | 实测结果 |
| --- | --- |
| 材料带逐字归属原文 | 候选 2 个；字段目录 13 → **15** 个对象；跨系统对应 **0 → 2 条**（`linkable`，两端 `sourceBasis: material_owner_candidate`，`sourceInferred: true`） |
| **不给**归属原文 | 无候选、无归属报告、`sourceSystems` 仍 `UNASSIGNED`——与改造前逐字一致（向后兼容） |
| 归属原文**编造**（非逐字） | 整表拒绝 `OWNER_EVIDENCE_INVALID`（与编造表名同等严重） |
| 归属原文提到**两个**系统 | 不产出候选，`attribution.ambiguous` 列出全部候选码与原文 |
| 归属原文识别不到系统 | 不产出候选，`attribution.unattributed` 列出原文（不挑一个最近的） |
| 确认归属（带材料原文依据） | `sourceSystems` 写入 ERP/WMS；Critic 失败项 **2 → 1**（「受控来源系统」通过）；链接 `sourceBasis` 由候选转 `confirmed`；`inferredSourceObjects` 2 → 0 |
| 确认到**范围外**的系统（SRM） | 该对象**这次才**被排除，引用了它的关系随之排除并给出原因 |
| 全部对象落范围外 | 400 `SEMANTIC_PROPOSAL_SCOPE_EXCLUDED_ALL`，拒绝保存（不交出一份空提案） |
| 依据为空 / 未登记系统 / 对象已不在提案 / 重复提交 | 各自 400（`..._EVIDENCE_REQUIRED` / `..._UNKNOWN_SYSTEM` / `..._STALE` / `..._INVALID`），一条都不落库 |
| 省略 / 空数组 / 部分提交 | 省略＝不调整；空数组＝撤销全部并**恢复**被裁掉的对象与关系；部分提交＝未提及项回退到创建时来源 |

**四处偏离与实测修正（如实）**

1. **归属判定不能复用 `detectSystemCodesInText`**。它的别名表里有「采购」「供应商」「库存」「审批」「流程」这类通用业务词——用于「这段文本提到了什么系统」（只做提示素材）尚可容忍，用于归属会把「采购订单表 purchase_order」直接判成 ERP 所有权。新增 `detectDeclaredSystemCodes`（只认系统码与系统名），并用例 4 把两者的差异锁死。
2. **`sanitizeProposalDraft` 白名单漏登记候选字段**。这是同类缺口第三次出现（`systemScope`、`derivedFrom`）。白名单式重建每加一个字段都要登记，漏登记的后果不是报错而是**静默丢失**——只在重算结果与上一版不一致时才暴露。已在代码里标注。
3. **撤销必须是双向的**。确认到范围外的对象会被范围过滤器移出草稿，若不从原稿恢复，「撤销」就成了单向操作（对象一旦被裁就再也回不来）。修法：只恢复**此前被人确认过归属**的对象及其关系（不会把用户手动删除的对象悄悄加回来），并按原稿顺序排回——否则每次撤销都会让对象表重排一次，Diff 里全是位置噪声。
4. **`validateProposalEvidence` 的来源比较必须接受归属确认**。否则人确认归属的那一刻，「材料语义保真」检查立刻失败，链路又断在最后一步。口径与人工补主键完全相同：有记录的人工断言被接受，但在 detail 里注明「材料只声明了归属候选，不代表材料已声明来源系统」。

**已知边界（如实）**

- **真实模型轮次已补测（2026-09-25）**，但样本小（4 变体 × 3 轮，单一 provider/模型，合成材料）：结论是**「是否给出 `systemEvidence`、是否逐字」稳定**，而**「给的那句是否真的在说明归属」没有机器兜底**——契约只校验逐字来自材料，语义正确性仍只靠人工复核（ADR-017 复审条件 4 未触发，但边界已写入）。
- **归属是对象级**，不是「系统.对象.字段」级。`ambiguous_identifier` 的按字段归属指派仍未做（ADR-016 复审条件 3 要求先给出那套粒度的形式）。
- **服务端只校验系统码是否已登记，不校验归属对不对**：域语义只能由人给。人被模型误导而确认错误归属，机器不会拦住（只是留了依据可追）。
- **候选归属进目录会带来新的 `declaration_divergence`**：同一对象在材料与系统声明里字段不一致时会被上报。这是期望行为（阶段 4 第 3 条要求冲突显式上报），但会加剧本已偏大的冲突量级。
- **无候选归属的跨修订差异视图**；非结构化材料的字段映射（`mappingStatus: pending`）仍需人工逐条完成，本段未改这条链路。
- 全部验收为**内置合成数据 + 注入模型输出**，不代表真实企业系统的跨系统连接已验收。

**下一步（阶段 4c 其余部分）**：~~`key_shape_incompatible` 的结构化标识映射（ADR-015 复审条件 2 的独立决策）~~ —— **已完成（2026-09-25，阶段 4d）**；~~`notInProposal` 对应的可确认性~~ —— **已完成（2026-09-25，阶段 4e）**；余下 `ambiguous_identifier` 的按字段归属指派（实测 0 条，ADR-016 复审条件 3 要求先给出「系统.对象.字段」粒度的形式）。（`declaration_divergence` 的合并 / 区分粒度已在「阶段 4c（第三段）」落地；真实模型轮次下归属契约的稳定性测量**已完成**，见上「真实模型轮次」段。）

---

### 阶段 4c（第三段）：同名声明不一致的合并 / 区分裁定 —— **已完成（2026-09-25）**

**为什么先做这一段**：[ADR-016](../architecture/adr/ADR-016-identity-conflict-rulings.md) 的「明确不在本 ADR 范围内」写着 `declaration_divergence`「属于阶段 4c 的**下一段**」；[ADR-017](../architecture/adr/ADR-017-model-extraction-attribution.md) 同样把它列为不在自身范围。四类冲突里，`alias_divergence` 已在第一段裁定、`ambiguous_identifier` 实测 **0 条**（没有用例驱动，ADR-016 已说明先不做）、`key_shape_incompatible` 有间接承载（`requires_mapping` + 确认时的自由文本依据），**只有 `declaration_divergence` 连一个入口都没有**（实测 5 项）。

**缺口的准确形状不是「冲突没被上报」，而是「默认动作不可见，且在被当成事实用」**

冲突一直上报了（「受控词汇表与已配置映射必须核对后再建模」）。真正的问题有两层：

1. **字段并集看不见**：同一系统内同一 `objectId` 的多处声明会被**取字段并集**，条目上只留 `groundings`，没有任何字段说明哪个字段来自哪一处声明。运营看到的「这个对象有 7 个字段」——**没有任何一处声明说过这句话**。
2. **并集在参与标识识别**：本机实测 `MES.ProductionBatch` 的并集条目被判定的标识是 `production_batch_id`（依据「受控词汇表登记的主键」），而 MES 的**已配置映射**那份声明只声明 `batch_no`。同理 `LIMS.TestResult`（并集 9 字段，标识 `test_result_id`）。**标识是真实的，但它被记在了一个不存在的对象（两处声明的复合体）名下**。

这与本次重构一路在消除的模式同构（4a 消除「对应被当成结论」、4b 消除「假设被当成证据」、4c 第一段消除「等价前提从未被看见」、4c 第二段消除「归属断言无法复核」）：这里剩下的是**「两处声明被合成一个复合体，谁都没为这个复合体声明过」**。

**六条核心决策**（详见 [ADR-018](../architecture/adr/ADR-018-declaration-divergence-merging.md)）

1. 裁定落在**既有复核动作**（`PATCH .../proposal`）的 `declarationRulings`，键是**分歧项**（`object:Inventory` / `source:ProductionBatch@mes.production_batch`）——与 ADR-016 的**概念级**键是两套粒度，各自独立校验（回答 ADR-016 复审条件 3 的「两套粒度如何共存」）。
2. 动作两个互斥：`merge`（并集从默认动作变成结论）/ `distinct`（**不并集**：按声明严格划分成组，每组给出对象名或 `drop` 显式排除，至少保留一组）。
3. 裁定**不写草稿、不产生证据等级**——它改的是**字段目录的组成**（链接推导的输入），与等价裁定各自作用在不同层。
4. **未裁定也必须披露并集**：条目新增 `declarations`（逐处声明与字段）、`exclusiveFields`（只被一处声明列出的字段）、`declarationState`，且 `identifierBasis` 必须写明「这是在并集上识别的」。
5. 裁定集合是**全量语义**，与既有三套同构（省略＝不调整 / 空数组＝撤销全部 / 显式提交不存在项＝硬错误 / 继承失效→`droppedStale`）。
6. 撤销 `distinct` **双向完全回退**；拆分、被排除的声明、因改名而消失的链接全部在 `declarationReport` 里显式列出。

**实测数字（本机，内置合成数据 6 系统，确定性）**

| 观测项 | 未裁定 | 裁定 `merge` | 裁定 `distinct`（拆生产批次） |
| --- | --- | --- | --- |
| 字段目录对象 | 21 | 21（**不变**） | **22** |
| 跨系统链接 | 11 | 11（不变） | 11 |
| 冲突 | 14 | 14（不变） | 14 |
| 复合条目（`merged_unruled_objects`） | 4 | 4 | **3** |
| 未裁定分歧项 | 5 | 4 | 4 |
| `MES.ProductionBatch` 字段 | **7（并集）** | 7 | **4**（= 该声明自己的字段） |
| 其标识 | `production_batch_id`（并集授予） | 同左 | `production_batch_id`（**仅来自列出它的那处声明**） |
| 拆出对象 `MES.MesBatch` | — | — | 4 字段，标识 **`batch_no`（business）** |

`distinct` + `drop`（排除受控词汇表那份声明）下另测：对象 **21**、链接 **11 → 9**、冲突 **14 → 12**（`Product` / `ProductionBatch` 的等价分歧与键形状冲突随字段消失），`droppedDeclarations` 列出被排除的声明及原因。撤销（空数组）后逐项回到未裁定的 21 / 11 / 14 / 4 与 5 项未裁定——**字段与出处一起回来**，不只是回来一个名字。

**验收（本机实测，确定性用例，未调模型）**：`npm run quality` 端到端 **EXIT=0**（1m39s，全量 35 个测试块 `fail=0`、0 处 `not ok`）；`test:declaration` **12/12**（新增，已挂入 `test:all`）；`test:identity` **17/17**（未裁定路径逐字不变，含 `keyGaps` 深比较与 21/11/14 计数）；`test:attribution` **12/12**；`test:architecture` **10/10**（**未增跨域边**）；前端 `workspace-layout` **7/7**（在 `test:semantic` 链内）；lint / typecheck 干净；`docs:check` **180 份 Markdown / 1042 个本地链接**。

**两处偏离与实测修正（如实）**

1. **「复合条目」的判据不能只看声明条数**：初版把「有多处声明」就当复合条目，于是两处声明字段集**完全一致**时也被计入「有几个并集条目没人看过」，虚增运营要处理的工作量。改为要求**各处声明确有分歧**（字段集签名不同）才算——并集等于各自声明时既没有复合体、也没有需要裁定的分歧。
2. **标识判据按「声明的原名」推导，不跟着改名走**：裁定改名说的是「与别处声明不是同一个对象」，不是「这条声明换了名字」。若跟着改名走，`objectConceptOf` 会因新名字未登记而返回 `null`，把标识判据整条打掉（`ProductionBatch` 拆出来的那份就再也推不出 `batch_no`）。

**已知边界（如实）**

- **对象级同名不同义只做到「目录组成」这一层**：裁定 `distinct` 会让两处声明各自成为目录对象，但**不会**把拆出的对象写进草稿（那是对象编辑或将来候选对象生成的事）。因此被拆出的条目在链接上会标 `declarationSourced: true`（阶段 4e 前叫 `notInProposal`）——这比改造前「并集让它看起来在提案里」更准确；**且它是否可确认是另一个问题**（`eligible`，判据是两端对象都在候选内，见阶段 4e）。
- **`drop` 只排除「声明」，不排除对象**：若某对象只剩被排除的声明，它会从字段目录里消失；本段只如实列出 `droppedDeclarations` 与 `droppedLinks`，不做「这个对象现在没有声明了」的独立上报项。
- **服务端只校验组名的结构**（非空 / 同一次提交内唯一 / 不与同系统既有对象重名），**不校验名字是否「合适」**：对象叫什么是域语义，只能由人给。
- **未裁定仍是并集**：披露不等于修正。没有裁定的分歧项上，目录仍输出复合条目（这正是 `merged_unruled_objects` 与 `unresolvedDeclarationItems` 两项口径存在的意义）。
- **不做跨修订的拆分对比**（只报「本次拆了哪些」）；`key_shape_incompatible` 的结构化映射（ADR-015 复审条件 2）与 `ambiguous_identifier` 的按字段归属指派仍未做。
- 全部为**内置合成数据**验收，不代表真实企业系统验收。

**下一步（阶段 4c 其余部分）**：~~`key_shape_incompatible` 的结构化标识映射（ADR-015 复审条件 2 的独立决策，映射表需要版本与责任人）~~ —— **已完成（2026-09-25，阶段 4d）**；余下 `ambiguous_identifier` 的按字段归属指派（实测 0 条，需先给出「系统.对象.字段」粒度并与现有的**对象级**归属共存）。

### 阶段 4d：标识映射结构化 + 「形状未判定」独立成态 —— **已完成（2026-09-25）**

**为什么先做这一段**：四类冲突里，`key_shape_incompatible` 是**唯一仍由自由文本承载**的一类——[ADR-016](../architecture/adr/ADR-016-identity-conflict-rulings.md) 与 [ADR-018](../architecture/adr/ADR-018-declaration-divergence-merging.md) 都把它列为不在自身范围，而 [ADR-015](../architecture/adr/ADR-015-identity-link-confirmation.md) 留下的**复审条件 2** 正是指向它：「**若** `requires_mapping` 的映射依据改为结构化映射定义，须重新评估『依据是否可核对』，并给出映射表的版本与责任人」。阶段 4c 三段把另外两类冲突的处置动作补齐后，只剩它。

落地过程中实测发现**两个缺口**，第二个是本段真正的触发点（详见 [ADR-019](../architecture/adr/ADR-019-structured-key-mapping.md)）：

1. **「不可按值连接」在草稿里不可读**：确认一条 `requires_mapping` 后，那条边与一条 `linkable` 的边**结构完全相同**（同 `predicate`、`cardinality`、`provenanceType: 'inferred'`），区别只在一段中文里——下游要区分只能解析自然语言。
2. **`status` 的二态判据把「形状未知」当成了「形状不同」**：判据是 `field.shape === expected` 的二元比较，而 `field.shape` 有三个取值 `agent` / `business` / `null`。于是裸名（`sku` / `product`，在 `BARE_IDENTIFIER_NAMES` 白名单里但没有 `_id` / `_no` / `_code` 后缀）被判 `requires_mapping`，**要求人为一件机器尚未判明的事写映射依据**，而说明文案写成「两端键形状不同（null / agent）」——读不通。

**六条核心决策**（详见 ADR-019）

1. `status` 由二态改**三态**：`linkable`（两端都已知且一致）/ `requires_mapping`（都已知且不同）/ `shape_unknown`（至少一端未判定）；
2. `shape_unknown` 的确认输入是**形状判定**（`agent` / `business`），判定后**重新定级**该条边；判定**不写回字段声明**（`shape` 是**这条边上的结论**，写回会污染 `buildSystemFieldCatalog`）；
3. `requires_mapping` 必须给出**结构化映射定义** `keyMapping`：`fromField` / `toField`（须与链接**逐字一致**）、`basis`（四类枚举）、`lookupSource`（`master_data_lookup` 时必填）、`owner`、`version`；自由文本 `evidence` 降级为可选说明；
4. 结构化映射**必须进草稿**（关系白名单 `sanitizeProposalDraft`），**证据等级不变**（仍 `inferred`——映射是人给的，不是材料写明的外键）；
5. 全量语义与失效同构：省略＝不调整、空数组＝撤销全部、显式提交不存在项＝硬错误、继承失效 → `droppedStale`；形状判定与映射定义同属确认项，随确认撤销一起消失；
6. **不做独立映射表实体**：实测 7 条映射**无一条被两条边共享**，无复用证据；`owner` / `version` 是将来升格的钩子。ADR-015 复审条件 2 因此是「**部分满足**」——「可核对」收窄为「结构与两端键一致可机器校验；映射对不对不在机器能力内」。

**实测数字（内置合成数据 6 系统，确定性用例，未调模型）**

| 口径 | 阶段 4c 末 | 阶段 4d 后 |
| --- | --- | --- |
| 跨系统标识对应 `links` | 11 | 11（不变） |
| `linkable` | 4 | 4（不变） |
| `requires_mapping` | **7** | **5** |
| `shape_unknown` | —（不存在此态） | **2** |
| 三态合计 | 11 | 11（互斥且覆盖全量） |
| 冲突 | 14 | 14（不变） |

`shape_unknown` 两条：`OMS.Order.sku`（null / agent）与 `QMS.QualityEvent.product`（null / agent）。

**验收（本机实测，确定性用例，未调模型）**：`test:identity` **20/20**（新增用例 18/19/20：形状判定的三条拒绝路径 + 两个方向的重定级与「不写回声明」+ 已知缺口钉点）；`test:declaration` **12/12**、`test:attribution` **12/12** 未受影响；前端 `workspace-layout` **7/7**（三态表达与结构化映射编辑区，并**反向锁死**旧错误码 `..._REQUIRES_MAPPING_EVIDENCE` 不得残留）；lint / typecheck 干净；`docs:check` **181 份 Markdown / 1068 个本地链接**；`npm run quality` 端到端 **EXIT=0**（1m41s，全量 35 个 Node 测试块 `fail=0`、0 处 `not ok`）；**5 端构建通过**（web 2.03s + 元域智语 2.73s、desktop 2.31s、mobile 2.27s、dingtalk 3.62s，分端调用避开沙箱 safe-delete 阈值）。`test:architecture` **10/10（未增跨域边**，跨包基线仍为 0）。

**三处偏离与实测修正（如实）**

1. **初版把「形状未知」当成了「形状不同」**（上面缺口 2）：7 条 `requires_mapping` 里有 2 条（29%）的确认动作本来就是错的——它们要的是「先判形状」，不是「写映射依据」。本段把它拆成独立状态，实测 `requires_mapping` 7 → 5。
2. **初版写了「继承的确认若从 `requires_mapping` 降级为 `shape_unknown` → 写入 `droppedStale`，不阻断修订」**：实现时核对发现**这条描述的是不可达状态**——链接 key 由「源系统.源对象.源字段」与「目标系统.目标对象」构成，而 `from.shape` 是**源字段名的纯函数**，`to.shape` 取值恒为 `agent` / `business`（**永不为 `null`**）；key 稳定则形状稳定。ADR-019 已就此显式自我修正，并说明若真出现则是硬错误 `..._SHAPE_REQUIRED`（保守方向，不改）。
3. ~~**`notInProposal` 的对应「列进可确认清单但确认不了」**：实测 11 条对应里 **5 条** `notInProposal: true`（`linkable` 1 / `requires_mapping` 2 / `shape_unknown` 2），确认时被端点校验以 `SEMANTIC_PROPOSAL_INVALID`（「关系的起点、终点和谓词必须完整，并引用本次候选对象」）挡下——**错误原因与事实不符**（真实问题是来源对象不在本次范围内）。这是阶段 4b 起就存在的口径缺口，与形状 / 映射无关，本段**只钉不修**（用例 20 钉住现状并写明「修好它时这条用例会失败，应连同 ADR 一起更新」）。~~ —— **已在「阶段 4e」关闭**（[ADR-020](../architecture/adr/ADR-020-identity-link-confirmation-eligibility.md)）。**本段记的两个数都要更正**：`notInProposal` 确为 5 条，但真不可确认的是 **4 条**——第 5 条 `ERP.Inventory.lot_no` **实测可确认**（`ERP.Inventory` 是配置声明，而其对象名 `Inventory` 与本次候选对象同名）。即旧判据拿「声明 grounding」冒充「候选资格」，多标了 1 条，且在界面写成「该来源系统本次未进入候选对象」——**一句事实错误**。

**已知边界（如实）**

- **`shape_unknown` 的「判定后并入草稿」在现有合成数据下不可达**：两条 `shape_unknown` 对应的源对象（`OMS.Order`、`QMS.QualityEvent`）都不在本次候选对象之内。**阶段 4e 之后这一条更强**：资格检查排在形状之前，因此任务级连**形状分支**都走不到（不只是并入路径）。「判形状 → 重定级 → 并入」与「三条形状拒绝路径」都只能在**纯函数层**取证（用例 19 / 用例 21 用 `deriveIdentityLinking` + `buildConfirmedRelationships` 夹具锁死）。这不是测试退化，而是「先问一条写不进草稿的边形状是什么」被正确地拦掉了。
- **形状判定不写回声明意味着同一裸名字段出现在多条边上要重复判定**（当前实测无此情形：两个裸名字段各只出现一条边）。
- **服务端只校验结构**（字段名逐字一致、枚举、非空），**不校验映射是否正确**——`basis: 'manual_register'` 后面可能是一句空话，机器不拦。
- **`key_shape_incompatible` 冲突本身仍只有上报**：本段让 `requires_mapping` 的确认变得可核对，但「同一概念上以哪个键为准」仍无裁定动作（实测无用例驱动——这 4 条冲突在 `declaration_divergence` 的 `distinct` 场景下会随字段拆分而消失）。
- **不做独立映射表实体**（决策 6），也没有跨任务复用与失效传播。
- 全部为**内置合成数据**验收，不代表真实企业系统验收。

**下一步（阶段 4c / 4d / 4e / 4f 收尾后）**：
1. `ambiguous_identifier` 的按字段归属指派——实测 **0 条**，ADR-016 复审条件 3 要求先给出「系统.对象.字段」粒度的形式；**当前无用例驱动**，属「等有证据再做」。
2. ~~**`notInProposal` 对应的可确认性**（本段实测的缺口）：推导层就标为「不可确认」，还是给一个专用错误码说清缺哪个对象？这是「**哪些对应有资格被确认**」的独立决策。实测影响面 **5 / 11 条**。~~ —— **已完成（2026-09-25，阶段 4e）**，两个都做了：推导层标 `eligible` + 专用错误码 `..._ENDPOINT_OUT_OF_SCOPE`；顺带更正影响面为 **4 / 11 条**（第 5 条实测可确认）。
3. ADR-019 的四条复审条件（映射出现复用 / `shape_unknown` 允许未判形状确认 / 形状判定改为写回声明 / 下游依赖 `keyMapping` 做实际数据连接）与 [ADR-020](../architecture/adr/ADR-020-identity-link-confirmation-eligibility.md) 的四条复审条件（不可确认被允许确认 / 资格判据回到声明 grounding / 下游需写入未进候选的对象的引用 / `eligible` 长期为 0）——均为**触发式**，未触发不动。
4. ~~**对象抽取本身**（阶段 4f 刚做掉的是它的**前置**）：4f 让「候选从哪来、为什么没生成」可读了，但**材料里写的对象仍可能一个都抽不出来**——实测「采购订单、发运单、出库单、客户投诉」只得到 **1 类**。下一步是让「材料里提到、目录未覆盖」的对象能被**点名**，而不是只提示「可能漏」。~~ —— **已部分完成（2026-09-26，阶段 4g）**：两侧都能点名了（目录空白 14 类 + 材料未覆盖列举项），但**取得方式是启发式而非抽取**。**仍未关闭的一半**：对象抽取能力本身——启发式依赖列举分隔符，「我们要建一个发运单模型」这种写法取不到词，而且点名的对象**仍不会进入候选**。[ADR-022](../architecture/adr/ADR-022-candidate-coverage-disclosure.md) 的四条复审条件均为**触发式**，未触发不动。

### 阶段 4e：一条标识对应「有没有资格被确认」的判据唯一化 —— **已完成（2026-09-25）**

**为什么先做这一段**：阶段 4d 收尾时把两件事留在了「下一步」，其中 `ambiguous_identifier` 实测 **0 条**（没有用例驱动，属于「等有证据再做」），而 **`notInProposal` 的可确认性**是本段实测出来的真实缺口：**11 条对应里有 4 条列在可确认清单上却确认不了**，且失败原因那句话说的是另一件事。有实测驱动、影响面 4/11、且是**一句界面上的事实错误**——先做它。

**触发点（本机实测，内置合成数据 6 系统，确定性）**：把 11 条对应逐条单独拿去确认（每条一份新任务），再与字段目录 grounding、草案候选对象 id 集对照，得到完整对照表（见 [ADR-020](../architecture/adr/ADR-020-identity-link-confirmation-eligibility.md)）。

1. **可确认 7 条 / 不可确认 4 条**，判据与服务端草案校验（`sanitizeProposalDraft` 的 `objectIds.has`）**0 例外**逐行一致：两端 `objectId` 都在候选对象内 ⟺ 可确认。
2. **旧 `notInProposal`（5 条）用「声明 grounding」冒充「候选资格」，多标 1 条**：`ERP.Inventory.lot_no → WMS.RawMaterialBatch.material_batch_id` 的来源是 ERP 的**系统配置声明**（`source_system_declaration`），于是被标 `notInProposal: true`；但它的对象名 `Inventory` 与本次候选对象 `Inventory` **同名**，草案校验通过，**实测确认成功**。界面据此显示「该来源系统本次未进入候选对象，依据来自系统声明」——ERP 在本次范围内、`Inventory` 也在候选对象里，**这是一句事实错误**，运营会据此放弃一条本可用的对应。
3. **剩下 4 条的拒绝原因说错两层**：真去确认报的是 `SEMANTIC_PROPOSAL_INVALID`「关系的起点、终点和谓词必须完整，并引用本次候选对象」——（a）**「必须完整」不成立**（三者俱全）；（b）**没说清缺哪个对象**（`LIMS.Sample` / `OMS.Order` / `QMS.QualityEvent` / `WMS.InboundReceipt`）。

**同型教训**：一个 flag 同时承载两个不同的问题，它在其中一个上必然说谎（与 ADR-018「复合条目判据不能只看声明条数」同型）。`notInProposal` 被三处分别读作「来源系统未进入候选对象」（界面，**判据与表述都不对**）/「依据来自系统声明」（关系证据，**这处是对的**）/「能不能并入草稿」（**从未检查过**，靠草案校验兜底报错）。

**六条核心决策**（详见 ADR-020）

| # | 决策 | 要点 |
| --- | --- | --- |
| 1 | 资格判据**唯一化** | `eligible` ＝ 两端 `objectId` 都在本次候选对象内；`candidateObjectIds` 由推导层从**它已经拿到的 `objects`**（＝草案 `objectTypes`）构造——与服务端草案校验**读同一个数组**，不可能分叉 |
| 2 | 不可确认**必须披露**，不得隐藏 | 仍留在 `links` 里，带 `eligible` / `ineligibleEndpoints` / **可行动**的 `ineligibleReason`（点名对象 + 说明依据来自哪里 + 给出「先让它成为候选对象」的下一步）。删掉它，运营看到的就是「本次没有 OMS→ERP 的引用」 |
| 3 | 不可确认的确认请求 ＝ **专用硬错误** | `SEMANTIC_IDENTITY_CONFIRMATION_ENDPOINT_OUT_OF_SCOPE`，点名对象；检查次序固定 **链接存在 → 资格 → 形状 → 映射**；**继承**的确认走 `droppedStale`（不阻断修订） |
| 4 | 两个判据**拆开**，名字各自诚实 | `notInProposal` → `declarationSourced`（判据不变，职责收窄为「依据来自系统配置声明」）；界面那句错话改为「来源端依据为系统配置声明」，**不再对资格作任何陈述** |
| 5 | 计数进 `summary` 与回应 | `summary.eligible` / `summary.ineligible`；任务创建回应与每次修订回应都要说「另有 N 条本次不可并入（含对象名与下一步）」 |
| 6 | **不放宽草案校验**，也不自动补候选对象 | 前者会产出悬空边（端点不在草案里）；后者会让标识推导**反向决定对象抽取**，而对象来源与范围是 ADR-012 / ADR-013 / ADR-017 已定过的决策 |

**实测口径变化**

| 口径 | 阶段 4d 末 | 阶段 4e 后 |
| --- | --- | --- |
| `links` / 三态分布 / 冲突 | 11 / 4+5+2 / 14 | 11 / 4+5+2 / 14（不变） |
| `summary.eligible` / `summary.ineligible` | 不存在此口径 | **7 / 4** |
| `notInProposal` | 5 条（**含 1 条误报**） | 字段已拆为 `declarationSourced`（**5 条**，判据不变，只答「依据来自哪儿」）与 `eligible`（**7 条**，答「这次能不能并入」） |
| 不可确认的确认请求 | `SEMANTIC_PROPOSAL_INVALID`（原因不符） | `..._ENDPOINT_OUT_OF_SCOPE`（点名对象） |

**验收（本机实测，确定性用例，未调模型）**：`test:identity` **21/21**（改写用例 20 为「闭合缺口」，重写用例 18 为「资格先于形状 + 对照组 + 继承分流」，新增用例 21「形状三条拒绝路径的纯函数口径」；用例 2 补 `eligible` / `ineligible` 计数与「方案原文举的例子当前不可确认」的断言）；`test:declaration` 12/12、`test:attribution` 12/12 未受影响；`test:architecture` **10/10（未增跨域边）**；前端 `workspace-layout` **7/7**（新增「第四种状态」表达与反向锁死：`link.notInProposal` 与那句错话都不许残留）；lint / typecheck 干净；`docs:check` **182 份 Markdown / 1104 个本地链接**；`npm run quality` 端到端 **EXIT=0**（1m48s，全量 35 个 Node 测试块 `fail=0`、0 处 `not ok`）；**5 端构建通过**（web 2.31s + 元域智语 2.98s、desktop 2.50s、mobile 2.53s、dingtalk 3.88s，分端调用避开沙箱 safe-delete 阈值）。

**两处如实边界**

- **资格检查排在形状之前，使形状分支在任务级不可达**：两条 `shape_unknown` 对应的源对象都不在候选内，因此任务级连形状分支都走不到（不只是并入路径）。三条形状拒绝路径改在纯函数层取证（用例 21）。这不是测试退化，而是「先问一条写不进草稿的边形状是什么」被正确地拦掉了——但它确实意味着**现有合成数据下形状分支缺少端到端覆盖**。
- **`ERP.Inventory` 与候选 `Inventory` 的同名巧合是一个未关闭的观察**：并入的边落在草案对象 `Inventory` 上，而该对象 `sourceSystems = ['WMS']`。边本身合法（草案里只有这一个 `Inventory`），但「ERP 的库存表」与「WMS 的库存对象」是不是同一件事，**本段不回答**——它属 ADR-017 归属关口的范畴，此处只记下以免下次被当成新发现。
- **不可确认的对应会长期存在**：只要系统配置声明里有候选对象之外的对象（字段目录里有 8 个对象只来自系统配置声明、不在本次候选内，其中 4 个产生了不可确认的对应），它们就会持续出现在清单里并持续不可确认。这是**如实披露的代价**，不是缺陷。
- 全部为**内置合成数据**验收，不代表真实企业系统验收。

### 阶段 4f：候选对象的来源与「没被生成」的原因必须可读 —— **已完成（2026-09-26）**

**为什么先做这一段**：阶段 4e 收尾后，「对象抽取」是阶段 4 剩下最明确的一块。但动它之前有一个更前置的问题：**今天的候选对象从哪来、为什么没生成，这件事本身不可读**。审阅人只有一份对象清单，清单之外的一切都是沉默的——分不清是「自己没说清」「目录没这个词」还是「模型没接上」。决策见 [ADR-021](../architecture/adr/ADR-021-candidate-provenance-disclosure.md)。

**触发点（本机实测，临时探针 `candidate-basis-probe.mjs`，内置合成数据，确定性）**：同一份实现喂三组诉求——

| 材料诉求 | 候选对象 | 说明 |
| --- | --- | --- |
| 「采购订单、供应商」 | **2 类**：`PurchaseOrder`、`Supplier` | 两个词都在受控目录里 |
| 「采购订单、**发运单、出库单、客户投诉**」 | **1 类**：`PurchaseOrder` | 三个对象**静默消失** |
| 「发运单、出库单」 | 硬错误 `SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS` | 一个都没命中 |

第二行是问题所在：运营写清了四个业务对象，候选里只有一个，而**此前界面上没有任何一句话解释另外三个去哪了**。

**两条静默路径（代码证据）**：`semantic-natural-schema-service.js` 的 `discoverNaturalSchema` 有两处 `return null`——① 模拟运行时（本轮不调模型，刻意）；② 材料没有「主键 / 字段」这类字典线索（粗筛判定不值得尝试）。**两者要做的补救完全不同**（换 provider / 补字段名），却被合并成同一个不可区分的表现。`semantic-operations-agent-service.js` 的 `catalog.filter(item => includesAny(sourceText, item.terms))` 则是「硬编码目录 + 关键词命中」的实体：不记录命中词、不说明自己是**兜底**而非抽取结果、不说明覆盖率。

**六条核心决策**

| # | 决策 | 要点 |
| --- | --- | --- |
| 1 | 披露**命中词**与**覆盖率** | `catalogHits` 记录 `matchedTerms`，说明写「命中 M / 共 12 类」并逐条列出命中词。只说「命中 2 类」回答不了「为什么没有发运单」——要看的是**没命中**的那些 |
| 2 | 说明它是**兜底**、不是抽取结果 | 写明「只按词面匹配：材料里写到、但目录未覆盖的业务对象**不会**出现在候选里，请核对是否遗漏」。**披露不等于补齐**（同 ADR-018 立场） |
| 3 | 跳过抽取给**可区分的原因** | `{ skipped, reason }` 取代 `null`；两种原因码 `mock_runtime` / `not_dictionary_like`，各自一句中文说明 |
| 4 | 跳过判定抽成**纯函数** | `naturalSchemaSkipReason({ mode, material })`——测试恒为 mock，内联会让另一条分支**永久遮住**（看着覆盖了两条，实际只跑一条） |
| 5 | 披露落在既有 `reviewNotes` | 不新增实体、不改 schema、**不把命中信息塞进 `objectTypes`**（那会进草稿并触发下游校验） |
| 6 | **不放宽任何门槛** | 候选为空仍是硬错误；「材料无字典线索」仍**不**触发抽取尝试，只是把这件事说出来 |

**实测口径变化**

| 口径 | 4e 末 | 4f 后 |
| --- | --- | --- |
| 材料「采购订单、供应商」 | 2 类候选，**无说明** | 2 类候选 + 命中词 + 覆盖率 + 兜底性质说明 |
| 材料「采购订单、发运单、出库单、客户投诉」 | 1 类候选，**无说明** | 1 类候选 + **「目录未覆盖的业务对象不会出现在候选里，请核对是否遗漏」** |
| `discoverNaturalSchema` 跳过时的返回 | `null`（无信息） | `{ skipped, reason }`（两种原因各自可读） |
| 候选为空 | 硬错误（不变） | 硬错误（不变） |

**改动文件**：`backend/src/services/semantic-natural-schema-service.js`（`NATURAL_SCHEMA_SKIP_REASONS` / `naturalSchemaSkipReason` / `discoverNaturalSchema` 返回结构化原因）、`backend/src/services/semantic-operations-agent-service.js`（`catalogHits`、`naturalSchemaSkip` 参数与传递、两条 `reviewNotes`、删除因此闲置的 `includesAny`）、`backend/test/semantic-operations-agent.test.js`（新增 2 条用例，29 → **31**）、[ADR-021](../architecture/adr/ADR-021-candidate-provenance-disclosure.md)（新建）与 ADR 索引行。

**验收（本机实测，确定性用例，未调模型）**：`test:semantic` **6/6 + 60/60 + 94/94**（第三组 92 → 94，`semantic-operations-agent.test.js` 29 → **31**）；`npm run lint` 干净；`docs:check` **183 份 Markdown / 1125 个本地链接**；`npm run quality` 端到端 **EXIT=0**（1m39s，全量 35 个 Node 测试块 `fail=0`、0 处 `not ok`）；**5 端构建通过**（web 2.90s + 元域智语 2.62s、desktop 3.33s、mobile 3.10s、dingtalk 5.01s，分端调用避开沙箱 `safe-delete` 单次阈值）；全部为**内置合成数据**验收。

**三处如实边界**

- **`not_dictionary_like` 在测试环境下不可达**：测试恒为 mock，该分支只能靠**纯函数层**用例覆盖。这不是测试技巧，而是如实反映「这条路径在模拟环境里根本走不到」——端到端验证它必须接真实 provider。
- **披露是「覆盖率级」而非「清单级」**：改动后那组材料**仍然是 1 类候选**，只是多了一句「可能遗漏，请核对」。从「无人能解释」变成「知道可能漏、但不知道漏了哪个」——**点名漏了哪个需要对象抽取能力本身**，属下一步。
- **`'订单'` 命中 `PurchaseOrder` 是已知过泛词**：`PurchaseOrder.terms` 含 `'订单'`，任何含「订单」的材料都会命中「采购订单」，而在 OMS 语境里「订单」通常是**销售订单**。这是受控目录的**词表质量**问题，与披露无关，本段不改、已记录在案。

### 阶段 4g：候选对象的**覆盖面**与「没被生成」的对象名必须可点名 —— **已完成（2026-09-26）**

**为什么先做这一段**：4f 收尾时留下的那句话是「目录未覆盖的业务对象**不会**出现在候选里，**请核对是否遗漏**」——**一句无法执行的指令**：核对什么、拿什么核对、目录到底缺什么，一个都没有。即「**披露了事实，但没有给出可执行的对象**」。决策见 [ADR-022](../architecture/adr/ADR-022-candidate-coverage-disclosure.md)。

**触发点（本机实测，临时探针 `catalog-coverage-probe.mjs`，内置合成数据，确定性）**：同一份实现喂四组材料——

| 材料 | 受控目录命中 | 未被覆盖的列举项 |
| --- | --- | --- |
| 「根据 ERP 的采购订单与供应商资料建立候选模型。」 | `Supplier ← 供应商`、`PurchaseOrder ← 采购订单、订单` | （无分隔符，不取词） |
| 「我们有订单、库存、发运三类数据，订单有单号和客户。」 | `PurchaseOrder ← 订单`、`Inventory ← 库存` | 无（噪声门挡住「发运三类数据」「订单有单号和客户」） |
| 「采购订单、**发运单、出库单、客户投诉**」 | `PurchaseOrder ← 采购订单、订单` | **`发运单`、`出库单`、`客户投诉`** |
| 「物料主数据、产品主数据、供应商」 | 3 类（`Material` / `ProductSKU` / `Supplier`，并附带 `RawMaterialBatch ← 物料`） | 无 |

**两个此前从未被对起来看过的事实（本机实测）**：① 受控目录 **12 类**；② 系统目录里已登记为「世界模型对象」的 **21 类**（`data/system-catalog.js` 的 `worldObjectTypes`）。差集 ＝ **14 类**：`InventoryLot`/`Warehouse`/`InboundReceipt`/`OutboundShipment`（WMS）、`ProcessStep`/`Deviation`（MES）、`Specification`/`Sample`（LIMS）、`CAPA`/`ChangeControl`/`QualityEvent`（QMS）、`Order`/`Fulfillment`/`ReturnOrder`（OMS）。**「发运单 / 出库单」进不来不是运营没写清**——承载它们的 `OutboundShipment` 早在系统目录里被登记，只是候选词表里没有词条。

**同型问题链**：ADR-019「把形状未知当成形状不同」→ ADR-020「一个 flag 承载两个问题」→ ADR-021「把不同情形合并成不可区分的表现」→ **本段「披露了事实，但没给出可执行的对象」**。前三次的修法是「让它们可区分」，第四次是「让缺失本身可见」，本段是**让缺失可以点名**。

**七条核心决策**

| # | 决策 | 要点 |
| --- | --- | --- |
| 1 | 受控目录**连覆盖披露一起搬出** | `CANDIDATE_CATALOG` / `matchCandidateCatalog` / `listCatalogGaps` / `listUncoveredMentions` 落到 `semantic-candidate-catalog-service.js`——**不是分文件**，是让「兜底能命中什么」有独立取证面 |
| 2 | 目录空白**可点名**（确定性） | 与 `systemDefinitions[].worldObjectTypes` 求差集，逐条给对象名 + 系统。零启发式，两边都是库里既有事实 |
| 3 | 未覆盖列举项**可点名**（启发式） | 列举分隔符切分（≥2 段）→ 纯中文 2~8 字 → 噪声门（非名词性线索字）→ **双向**覆盖判定 → 上限 12 条且**超限必须说明** |
| 4 | 启发式**自我标注** | `basis = enumeration_heuristic` **作为字段**随清单走；文案明说「**不是对象抽取结果**：可能混入非对象词，也可能漏掉没有用分隔符列出的对象名」 |
| 5 | 落**结构化字段** `candidateCoverage` | 含 `fallbackApplied`（目录是否真被用到）、`matched` / `gaps` / `uncoveredMentions` / `uncoveredTotal` / `uncoveredTruncated` / `uncoveredBasis`；进 `publicProposal` 白名单 |
| 6 | **披露不等于补齐** | 点名的对象**一个都不进候选**；不放宽门槛、不改候选集合、不补词条 |
| 7 | **披露必须到达界面** | 运营控制台**不渲染 `reviewNotes`**，故新增界面区块（命中词 / 目录空白 / 未覆盖提及三块）——否则等于没披露 |

**实测口径变化**

| 口径 | 4f 末 | 4g 后 |
| --- | --- | --- |
| 受控目录 | 硬编码在近千行的 `semantic-operations-agent-service.js` 内 | 独立服务，有纯函数取证面 |
| 目录空白（已治理但目录无词条的类） | **不存在此口径** | **14 类**，逐条点名 |
| 材料里未被覆盖的列举项 | **不存在此口径** | 可点名（启发式，≤12 条，超限报总数） |
| 候选对象集合 | — | **不变**（披露不等于补齐） |
| 运营控制台 | 看不到任何覆盖披露 | 三块披露可见 |

**改动文件**：`backend/src/services/semantic-candidate-catalog-service.js`（新建：受控目录 + 两项披露）、`backend/src/services/semantic-operations-agent-service.js`（导入替换、`candidateCoverage`、三条 `reviewNotes`、`publicProposal` 白名单）、`apps/semantic-operations-console/src/components/SemanticAgentWorkspace.vue`（新增覆盖面区块与样式；**顺带修正两处死界面**：`selected.value?.proposal?...` 在模板中恒为 `undefined`，使两段失效披露永不显示）、`backend/test/semantic-operations-agent.test.js`（+2 条用例，31 → **33**）、`apps/semantic-operations-console/test/workspace-layout.test.js`（+1 组，7 → **8**）、[ADR-022](../architecture/adr/ADR-022-candidate-coverage-disclosure.md)（新建）与 ADR 索引行。

**验收（本机实测，确定性用例，未调模型）**：`test:semantic` **6/6 + 60/60 + 96/96**（第三组 94 → 96）；控制台 `workspace-layout` **8/8**；`test:architecture` **10/10**（未增跨域边）；`test:events` **17/17**（本段顺带完成模块化审计第 3 项后的回归）；`npm run lint` / `typecheck` 干净；`docs:check` **184 份 Markdown / 1169 个本地链接**；`npm run quality` 端到端 **EXIT=0**（1m38s，全量 35 个 Node 测试块 **969 / 969 通过**、0 处 `not ok`）；**5 端构建通过**（web 2.04s + 元域智语 2.83s、desktop 2.22s、mobile 2.19s、dingtalk 3.47s，分端调用避开沙箱 `safe-delete` 单次阈值）；全部为**内置合成数据**验收。

**三处如实边界**

- **未覆盖提及是启发式，会误报也会漏报**：噪声门是黑名单式的（「相关数据」这类词不在其中，会被列出）；**没有被列举分隔符分开的对象名不会被点名**（「我们要建一个发运单模型」一个词都取不到）。本段把「无人能解释」降为「知道大概漏了哪些词」，**没有消除漏报**。
- **目录空白只回答「目录缺哪些类」，不回答「材料里的某个中文词对应哪一类」**：后者的映射需要中文词条，属词表治理（决策 2 已说明为何不在本段补）。
- **截断阈值 12 是取舍**：代价是「第 13 个之后没看到」，收益是审阅说明不被淹没。兜底路径下一次响应会多出三条 note，其中目录空白那条实测约 300 字——这是披露的代价，不是缺陷。




### 阶段 2 补记（2026-09-26 晨）：接入生命周期操作面（ADR-023）

阶段 2 迁出主视角时留下一个未闭合的缺口（用户 2026-09-26 指出）：**系统接入视图只能「看」**——状态机（draft→registered→authorized→connected⇄suspended）早在 `system-registry-service.js` 定义并实现，却从未暴露为可执行动作：路由层没有生命周期端点、前端没有操作入口，界面上的「已连通 / 待接入 / 未登记 / 可探测 / 未授权」全部是 `ONBOARDING_STATE_SEED` 给的种子静态值。由此产生两个产品缺口：**没有新增接入**（无法把目录里未登记的系统推入流程）、**没有已接通系统的管理**（无法停用 / 恢复 / 下线）。

本段补齐：域契约 4 → 5（`transitionTenantSystemConnection`，`DOMAIN_EXPORT_CEILING` 显式抬棘轮）；路由 `POST /api/semantic-operations/systems/{code}/lifecycle`（权限沿用 `meta_model.draft.save`）；**接通门禁**——任何 `→ connected` 要求该租户最近一次探测 `verified`（409 `SYSTEM_CONNECT_PROBE_REQUIRED`），「先验证再接通」成为流程强制而非口头约定；理由必填（≤200 字）+ 操作人取受信上下文审计；前端新增「接入流程与生命周期」面板（渲染服务端 `lifecycle.transitions`，不本地硬编码）、「＋ 新增接入」入口（聚焦未登记系统）与「已停用」维度。**边界**：`draft→registered` 只推进状态不落连接配置（连接配置样例仍来自 demo 种子）；系统类型仍只能来自平台目录。

**验收（本机实测，确定性用例，未调模型）**：`backend/test/system-access.test.js` **12 项（9 → 12）**；`workspace-layout` **9 项（8 → 9）**；`test:architecture` **10/10**（棘轮显式变更，未增跨域边）；`test:registry` 7/7；`test:access` 12/12；`test:semantic` 全链 EXIT=0。决策记录见 [ADR-023](adr/ADR-023-lifecycle-operation-surface.md)。

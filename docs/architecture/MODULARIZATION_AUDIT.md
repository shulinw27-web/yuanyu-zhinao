# 模块化与组件化审计（2026-09-24）

[返回架构文档](README.md)

本页从**整体架构层面**审计项目当前的模块化（后端/包）与组件化（前端）状况。方法：**先实测后结论**——所有判断均给出可复核的实测数字与文件位置，不做凭文档推断的结论。审计范围覆盖 `backend/`、`frontend/`、`apps/`、`packages/`、`services/`。

## 0. 结论摘要

项目**模块化的"骨架"是健康的，但"边界"存在系统性错位**。具体表现为三类问题，按严重度排序：

| 级别 | 问题 | 实测证据 | 影响 |
| --- | --- | --- | --- |
| **P0** | 工作区包反向依赖兄弟应用的私有源码 | 3 个包/应用共 **8 处** `../../../frontend/src/...` 相对路径 import（已加棘轮冻结，见 2.5） | 包边界名义化，构建与发布均不安全 |
| **P1** | `packages/agent-workbench` 是"伪包" | 850 行单一 Vue 组件，且其 3 个依赖来自 frontend | 复用承诺与实际耦合不符，无法独立复用 |
| **P1** | 领域层"重导出"而非契约 | `governance/public-api.js` 48 行 30 条 export；`agent` 24 条 | 契约面无约束力，模块边界不可验证 |
| **P2** | 横切关注点靠逐文件 import | `prompt-security-service` 被 **19** 个文件 import | 新增能力需改 19 处，易漏 |
| **P2** | 前端组件化层级不齐 | `features/` 12 个目录，文件数 1~7 不等；3 个通用组件 vs 30 个 feature 文件 | 复用与归位无统一判据 |
| **P3** | 后端 services 无二级切分 | `backend/src/services/` 扁平 **137** 文件 | 认知负荷；但已有棘轮保护，优先级低 |

**健康的部分**（不应因上表被误判为整体失控）：路由层边界真实且有测试守护（`routes/` 零违规引用 `services/`）；5 个 workspace 包依赖无环；组合根 `app.js` ≤140 行；`api-contracts` / `client-runtime` 是真正的独立契约包；后端有 82 个测试文件守护。

---

## 1. 量化基线

### 1.1 模块规模

| 模块 | 文件数 | 说明 |
| --- | --- | --- |
| `backend/src` | 201 | 其中 `services/` 137、`domains/` 11 目录 |
| `frontend/src` | 43 | `features/` 30、`styles/` 19（含 CSS）、`actions/` 4 |
| `apps/*` | 25 | desktop 2 / dingtalk 3 / mobile 2 / product-portal 9 / semantic-operations-console 9 |
| `packages/*` | 13 | agent-sdk 1 / agent-workbench 2 / api-contracts 2 / client-runtime 5 / semantic-operations-sdk 3 |
| `services/*`（独立服务） | 9 目录 | key-center、semantic-context 及 7 个 worker |

### 1.2 工作区拓扑

```
workspaces: ["frontend","backend","packages/*","apps/*"]

依赖方向（实测）：
  apps/desktop|dingtalk|mobile  →  packages/agent-sdk + packages/agent-workbench
  apps/semantic-operations-console → packages/api-contracts + packages/semantic-operations-sdk
  frontend  → packages/api-contracts + packages/client-runtime
  apps/product-portal → 仅 vue（无内部包）
```

依赖图**无环**。问题不在环，而在**跨越声明的依赖边界**（见第 2 节）。

### 1.3 领域层契约面

| 领域 | public-api.js 行数 | export 条数 |
| --- | --- | --- |
| governance | 48 | 30 |
| agent | 34 | 24 |
| identity | 10 | 10 |
| platform | 6 | 6 |
| simulation | 6 | 6 |
| alerting | 10 | 4 |
| procurement | 4 | 3 |
| iam / risk / key-management | 2~3 | 1~2 |

**观察**：`governance` 与 `agent` 的 public-api 是"重导出清单"（48 行里 30 条 export，几乎无逻辑），不是经过设计的契约。真正的契约面应有显式的输入/输出与稳定性承诺，而不是把内部实现原样透出。

### 1.4 耦合热点（被 import 的文件数）

| 文件 | 消费者数 | 性质 |
| --- | --- | --- |
| `prompt-security-service.js` | **19** | 横切关注点（安全） |
| `iam-store.js` | 18 | 数据访问 |
| `local-model-gateway.js` | 15 | 横切关注点（模型调用） |
| `authorization-service.js` | 14 | 横切关注点（授权） |
| `access-control-service.js` | 14 | 横切关注点（权限） |
| `agent-query-service.js` | 13 | 领域服务 |

前 5 名里有 4 个是横切关注点。这不是"耦合坏味道"，而是**缺少统一管线**的信号：横切能力靠每个消费者手动 import 并手动调用。

---

## 2. P0：工作区包反向依赖兄弟应用的私有源码

### 2.1 实测违规清单

**8 处**（由 `backend/test/architecture-boundaries.test.js` 的同款扫描算法复现，可用 `npm run test:architecture` 随时复核）：

```
packages/agent-workbench/src/AgentWorkbench.vue:4  → ../../../frontend/src/features/knowledge/KnowledgeLibraryPanel.vue
packages/agent-workbench/src/AgentWorkbench.vue:5  → ../../../frontend/src/features/knowledge/MemoryReviewPanel.vue
packages/agent-workbench/src/AgentWorkbench.vue:6  → ../../../frontend/src/features/agent/AnomalyAssistantPanel.vue
apps/semantic-operations-console/src/App.vue:7     → ../../../frontend/src/features/meta-model/OAMetaModelStudio.vue
apps/semantic-operations-console/src/App.vue:8     → ../../../frontend/src/features/knowledge/KnowledgeLibraryPanel.vue
apps/semantic-operations-console/src/App.vue:9     → ../../../frontend/src/features/meta-model/ontology-scenario.js
apps/semantic-operations-console/src/main.js:3     → ../../../frontend/src/styles/main.css
apps/semantic-operations-console/src/main.js:4     → ../../../frontend/src/styles/meta-model.css
```

> **计数修正说明**：本审计初版报告为 6 处，仅检索了 `from '...'` 形式。精确扫描（同时覆盖 `import '...'` 副作用导入）后追加发现 2 处 CSS 引用，共 8 处。这是一个自我修正：CSS 的副作用导入同样穿透包边界。

### 2.1.1 一处不构成违规的跨区引用

```
apps/product-portal/src/components/DocsCenter.vue → ../../../../docs/public/product-docs.json
```

**判定为合法**：这是**内容投放**而非源码依赖。依据 `docs/guides/PRODUCT_PORTAL.md`：「公开文档的受控来源是产品公开内容，由官网显式打包，不向浏览器暴露整个 docs 目录」。该 JSON 是人工维护的公开内容资产，且 packages 的 `exports` 机制不适用于内容包。已登记在 `CROSS_PACKAGE_CONTENT_ALLOWLIST` 并在基线文件中写明理由——**白名单必须带理由，否则会退化为无声的例外堆积**。

### 2.2 为什么这是 P0

**这不是风格问题，是三个具体的工程风险：**

1. **声明与事实不符。** `packages/agent-workbench/package.json` 的依赖里**没有** `frontend`；`frontend/package.json` 也**没有** `exports` 字段且 `private: true`。也就是说，这些 import **绕过了 npm workspace 的解析机制**，靠相对路径"物理穿透"到另一个包的 `src/`。任何一次目录调整都会静默打断（构建时才报错，且报错位置与真实原因分离）。

2. **包的独立性是假的。** `packages/agent-workbench` 声称是可复用的跨端工作台（被 desktop / dingtalk / mobile 三端共用），但它实际依赖 `frontend/src/features/` 下的私有源码。这意味着：想单独发布或独立构建 agent-workbench 是不可能的——它必须把 `frontend` 一起拖上。`frontend` 是 `private: true` 的应用，不是库。

3. **传递依赖闭包不受控。** 实测依赖闭包：
   - `KnowledgeLibraryPanel.vue` → 4 个同目录子面板（`KnowledgeStudyPanel` / `KnowledgeConversationPanel` / `KnowledgeMaterialReviewPanel` / `KnowledgeBusinessBriefPanel`），闭包 **5 文件**；
   - `OAMetaModelStudio.vue` → `OntologyScenarioPanel` / `OntologyCaseReplay` / `OntologyReadPlanPanel` + `ontology-scenario.js`，闭包 **6 文件**。
   
   即：**一行的 import 实际拉入 5~6 个文件**。这些文件又各自继续依赖 frontend 内部结构，边界会随迭代持续扩大。今天的 8 处 import 是一只脚，明天的 20 处才是问题——但现在正是修复成本最低的时刻（且已被 2.5 节的棘轮冻结，不会继续扩大）。

### 2.3 根因

项目里存在**两个都想当"组件库"的地方**：

- `packages/agent-workbench`：想承载"智脑工作台"这一跨端共享 UI；
- `frontend/src/features/*`：实际沉淀了绝大多数业务面板组件。

当初把面板放在 `frontend/src/features/` 下是合理的（先服务主 Web），等到 desktop/mobile/dingtalk/semantic-console 都要复用时，**没有把组件上提到可共享层级**，而是用相对路径直接引用——这是"复用压力"遇到"缺少共享层"时的典型妥协路径。

### 2.4 建议（按成本递增，可分期）

**方案 A（最小改动，推荐先做）：把共享面板提升到 `packages/agent-ui`。**

- 新建 `packages/agent-ui`，把被跨包引用的 5 个组件及其闭包（11 个文件）迁移进去：`KnowledgeLibraryPanel` + 4 子面板、`OAMetaModelStudio` + 3 子面板 + `ontology-scenario.js`。
- 在 `package.json` 声明 `exports`，并在 `agent-workbench` 与 `semantic-operations-console` 的 `dependencies` 里显式声明 `"@healthcare-ai/agent-ui": "*"`。
- 好处：依赖关系从"物理穿透"变为"声明式依赖"，可被工具校验。

**方案 B（结构更干净但改动大）：让 `agent-workbench` 接收面板而非内嵌。**

- `AgentWorkbench.vue` 当前在顶层直接 import 3 个面板（见 1.1 节实测第 4~6 行）。改为通过 `provide/inject` 或 `slots` + 注册表接收，由各端 App.vue 注入自己要用的面板。
- 好处：工作台与具体面板解耦，各端可差异化组装；代价是 `AgentWorkbench.vue`（850 行）需改造，改动面较大。

**方案 C（兜底）：至少加测试守护。**

无论选 A 还是 B，都应当立即增加一条架构测试，禁止 `packages/*` 与 `apps/*` 出现指向上层目录的跨包相对 import。这条测试成本极低（正则扫描），却能锁住边界不再劣化——与已在后端落地的棘轮机制同构。

> **落地状态：已完成（2026-09-24）。** 见 2.5 节。

### 2.5 落地：跨包边界棘轮测试（已完成）

2026-09-24 落地方案 C，与后端既有棘轮（`architecture-boundaries.test.js`）同构，复用同一测试文件与同一基线事实源。

**测试项**：`backend/test/architecture-boundaries.test.js` 第 6 项
「工作区包之间不得用相对路径穿透彼此的私有源码（只降不升）」。

**实现要点**：

| 关注点 | 做法 |
| --- | --- |
| 扫描范围 | `packages/`、`apps/`、`frontend/src/` 三棵树，递归收集 `.js/.mjs/.ts/.vue`（跳过 `node_modules/dist/release/build/.git`） |
| 违规判定 | 提取所有相对 import（正则同时覆盖 `from '...'`、`import('...')` 与副作用 `import '...'`），解析后按「顶层归属区」比较：`packages/<name>`、`apps/<name>`、`frontend`、`backend` 各自为一个区，跨区即为违规 |
| 基线冻结 | `CROSS_PACKAGE_IMPORT_BASELINE`（8 条，见 2.1 节实测清单） |
| 内容白名单 | `CROSS_PACKAGE_CONTENT_ALLOWLIST`（1 条，见 2.1.1 节）——区分「源码依赖违规」与「公开内容资产的有意引入」 |
| 双向校验 | **新增**未登记违规 → 失败并打印待登记项；**已解除**的基线项 → 失败并要求下调基线。防止基线长期虚高 |
| 自检 | 断言扫描到的工作区源码数 `>= 30`，避免扫描逻辑失效时「静默通过」 |

**关键取舍——为什么登记 8 条而不是直接修掉？**
这 8 处是既存债务，修掉需要先做 2.4 方案 A（新建 `packages/agent-ui` 并迁移 11 个文件），属跨包结构改动，不宜与「加测试」混在同一次提交里。棘轮的语义正是**先冻结、后清偿**：现在新增的第 9 处会立刻失败，而既存 8 处被显式记账，清偿时同步下调基线即可自动收敛。

**验证记录（正/反双向）**：

1. **反向验证（守得住）**：临时写入 `apps/mobile/src/App.vue`，内含一条 `import '../../frontend/src/...'` → 测试失败，且精确指出该文件与目标路径；随后还原文件，`git status --short apps/` 无改动。
2. **正向验证（收得回）**：从 `CROSS_PACKAGE_IMPORT_BASELINE` 中删除任意一条 → 测试失败并提示「该条已解除，请下调基线」，确认双向校验生效。
3. **常规运行**：`npm run test:architecture` 10/10 通过；`npm run lint` 通过。
4. **残留清理**：探测文件 `.scan-tmp.mjs`、`.dbg.mjs`、`.bak` 均已删除，工作区无残留。

**遗留（未完成，不属本次范围）**：2.4 方案 A/B 的实际结构修复尚未启动，8 条基线仍在。真正清偿需单独排期。

---

## 3. P1：`packages/agent-workbench` 的结构问题
### 3.1 实测

```
packages/agent-workbench/src/AgentWorkbench.vue  850 行
packages/agent-workbench/src/style.css           421 行
packages/agent-workbench/src/index.js            （仅导出）
```

`AgentWorkbench.vue` 的 `<script setup>` 中：
- **27 个** `ref()` 顶层状态（`view`/`loading`/`error`/`workItems`/`notices`/`operations`/`memories`/`learningProfile`/`conversations`/`taskStates`/`chatViewport`/`contextOpen`/`desktopCapabilities`/`desktopArtifacts`/`desktopEndpointStatus`/`runtimeTasks` 等）；
- 8 个 `computed` 双向绑定包装（`messages`/`pending`/`sending`/`executing`/`input`/`attachments` 等），每个都是 `{ get, set }` 手写形式；
- 混装：登录/认证（`account`/`password`/`loginMode`）、会话管理、任务状态、桌面端能力探测、长期记忆、学习画像、附件、语音（`listening`）。

### 3.2 问题

**这是一个"包"，但实际形状是"单体页面"。**

- 它同时承担：布局壳、认证流程、会话编排、任务队列视图、桌面桥接、记忆管理、学习画像。这些是**七个不同生命周期**的关注点，共享一个 850 行的 `<script setup>`。
- 8 个 `{ get, set }` computed 是状态设计信号：`taskStates` 用 `activeConversationId` 索引 + `ensureTaskState()` 惰性填充，说明"每个会话的任务状态"这一概念没有独立建模，而是散在组件局部状态里。正确形状应是一个 `useConversationTaskStates()` composable（或 Pinia store）。
- 结果为：**改登录会影响聊天，改桌面桥接会影响记忆**——不是因为逻辑耦合，而是因为没有按关注点切分边界。

### 3.3 建议

按关注点抽出 composables（不改行为、可逐个迁移）：

| composable | 吸收的状态 | 约可减行数 |
| --- | --- | --- |
| `useWorkbenchAuth` | `authenticated`/`account`/`password`/`loginMode`/`loginLoading`/`oaConnection`/`profile` | ~100 |
| `useConversationTasks` | `conversations`/`activeConversationId`/`taskStates`/`emptyTaskState`/`ensureTaskState`/6 个 get-set computed | ~150 |
| `useDesktopBridge` | `desktopCapabilities`/`desktopArtifacts`/`desktopEndpointStatus`/`runtimeTasks`/`runtimeTaskWorkerBusy` | ~80 |
| `useMemoryAndLearning` | `memories`/`learningProfile`/`savingLearningProfile`/`pinningMemory`/`currentGoalPinned` | ~60 |

目标：`AgentWorkbench.vue` 收敛到 ≤400 行（仅保留布局与组装）。这与后端 `private-agent-service` 的拆解是同一套方法论——**在改行为之前先划边界**。

---

## 4. P1：领域层是"重导出"而非契约

已在 [架构分析与优化](ARCHITECTURE_ANALYSIS_AND_OPTIMIZATION.md) 与 [ADR-005](adr/ADR-005-domain-public-api-layering.md) 记录，此处补充**模块化视角**的观察：

- `routes/` → `domains/*/public-api.js` 的纪律**执行得很好**（实测 `routes/*.js` 中零处直接 import `services/`）。
- 但 `services/` → `domains/` 存在**反向引用**：实测 9 个 service 文件 import `domains/events/domain-event-outbox.js`，另有 `risk-service.js` import `domains/alerting/alerting-service.js`。这构成了**分层反转**——底层服务依赖上层领域。

**判断**：`domains/events` 实际是**基础设施**（事件出站箱），被误放在"领域"层。这已在阶段一以 `INFRASTRUCTURE_DOMAINS = new Set(['events'])` 的技术手段排除在棘轮之外，但**概念上的错位仍在**：它挂在 `domains/` 下会让后续读者以为领域层可以互相依赖。

**建议**：把 `domains/events/` 重命名为 `infrastructure/domain-events/`（或 `shared/`），物理位置与概念层级对齐。这是一次机械重构（改路径 + 改 import），成本低但能消除一个持续误导后来者的结构信号。

---

## 5. P2：横切关注点缺少管线

实测 `prompt-security-service.js` 被 **19 个**文件 import，`local-model-gateway` 15 个，`authorization-service` / `access-control-service` 各 14 个。

看 19 个消费者的构成，可以读出真实意图：

```
knowledge-*（8 个）  → 都属于"知识问答/知识库"链路
agent-*（5 个）      → 都属于"智脑 Agent"链路
semantic-*（3 个）   → 都属于"语义建模"链路
其余（3 个）         → multimodal / local-model-gateway / conversation-material-index
```

**问题不是"被 import 19 次"，而是**：每条链路有 3~8 个文件都要各自记得调用提示词安全检查。这带来两个具体风险：

1. **遗漏风险**：新增一个 `knowledge-*` 服务时，是否还记得 import 并调用？如果忘记，安全检查静默失效——且**没有任何测试会失败**，因为缺少的是"调用"，不是"行为改变"。
2. **无法回答全局问题**：想知道"哪些输入路径经过了安全筛查"，必须遍历 19 个文件人工推断。

**建议**：把提示词安全从"手动调用"改为"管线必经"。最低成本做法是在 Agent 与知识链路的**入口**（`runPrivateAgent` / 知识问答 service 的公共方法）统一施加，内部函数不再各自检查。这与 [ADR-002](adr/ADR-002-reasoning-side-effect-separation.md)（推理与副作用分离）的既有思路一致——**约束应放在收窄的咽喉处，而不是分散在每个出口**。

> 注意：此项改动涉及安全语义，**不应与结构重构混在同一次变更中**。建议先立测试（枚举所有应受保护的入口，断言各自被调用），再改实现。

---

## 6. P2：前端组件化层级不齐

### 6.1 实测

`frontend/src/features/` 下 12 个目录，文件数差异极大：

| feature | 文件数 | feature | 文件数 |
| --- | --- | --- | --- |
| meta-model | 7 | config | 4 |
| knowledge | 6 | world-model | 4 |
| agent | 2 | actions / assistant / channels / dashboard / intelligence / permission / risk | 各 1 |

同时 `frontend/src/components/` 只有 3 个组件（`AppShell.vue` / `MetricCard.vue` / `RiskDrawer.vue`）。

### 6.2 问题

**"什么进 components/、什么留在 features/"没有可复用的判据。**

- 7 个 feature 目录仅含 1 个文件——这本身不是错（feature 可以很小），但当 1 个文件的 feature 与 7 个文件的 feature 平级时，目录结构不再传达任何信息量。
- `components/` 只有 3 个文件，而 `features/` 下沉淀了 30 个文件。说明"通用组件"这一层实际上是空的：真正被复用的组件（如 `KnowledgeLibraryPanel`）没有上提，而是留在 feature 内并被跨包穿透引用（见第 2 节）。

**建议**：明确三层判据并写进文档：

1. `components/` —— **无业务语义**的展示组件（只受 props，不取数据）；
2. `packages/agent-ui`（新建）—— **跨端共享**的业务组件（见 2.4 方案 A）；
3. `features/<domain>/` —— **单端专用**的页面级组件。

---

## 7. P3：后端 services 扁平 137 文件

`backend/src/services/` 是扁平目录，137 个文件，最大 `private-agent-service.js` 1146 行（本次已从 1206 拆出两个关注点，见 [ADR-008](adr/ADR-008-persistence-port.md)）。

**判断：优先级最低，不建议现在动。** 理由：

- 已有棘轮测试（`SERVICE_FILE_LINE_CEILING`）阻止继续膨胀，风险已被锁定；
- 文件数多本身不等于设计差——137 个文件里绝大多数是单一职责的（如各 `*-contract.js`、`*-registry.js`）；
- **按文件数切目录是伪优化**：如果只是把 137 个文件分到 8 个子目录，依赖关系不变、认知负荷不减。真正要解决的是**依赖关系**，这已由跨域边棘轮（189 条基线）度量；
- 后端真正的结构问题是"缺少明确的二层切分（application / domain）"，而这需要先有清晰的领域模型边界——当前语义层仍在演进，过早切分大概率返工。

**建议**：保持现状，让棘轮继续压。等跨域边开始收敛（189 → 目标值）时，收敛后残留的强连通簇才是拆分的正确依据。

---

## 8. 与既有文档的关系

| 已记录 | 本页新增 |
| --- | --- |
| [架构分析与优化](ARCHITECTURE_ANALYSIS_AND_OPTIMIZATION.md)：后端为主（God Service / JSON blob / 领域边界 / 测试金字塔） | **前端与包边界**：跨包相对路径穿透（P0）、agent-workbench 单体化（P1）、组件三层判据缺失（P2） |
| [ADR-005](adr/ADR-005-domain-public-api-layering.md)：领域分层与契约面 | 补充"重导出 vs 契约"的实测条数，及 `domains/events` 概念错位 |
| [ADR-008](adr/ADR-008-persistence-port.md)：持久化端口化 | — |

**本页的三条新发现（此前未被记录）**：
1. **P0 跨包目录穿透**——6 处实测违规，是当前模块化最严重的边界问题；
2. `packages/agent-workbench` 850 行单体 + 7 个混合关注点；
3. 横切关注点（安全/模型/权限）缺乏统一管线，遗漏风险无测试守护。

---

## 9. 建议执行顺序

| 顺序 | 动作 | 成本 | 收益 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | **加架构测试**：禁止 `packages/*`、`apps/*` 向上跨包相对 import | 极低（正则扫描） | 立即锁住 P0 不再恶化 | **已完成（2026-09-24，见 2.5）** |
| 2 | 新建 `packages/agent-ui`，迁移 11 个被跨包引用的组件与闭包 | 中 | 消除 P0，依赖变声明式 | 未开始 |
| 3 | `domains/events` → `infrastructure/domain-events` | 低（机械改名） | 消除分层反转的概念误导 | 未开始 |
| 4 | 抽 `AgentWorkbench.vue` 的 4 个 composables | 中 | 850 → ≤400 行，关注点分离 | 未开始 |
| 5 | 前端三层组件判据写入文档 | 极低 | 后续归位有依据 | 未开始 |
| 6 | 横切关注点管线化（**须先立测试**） | 高 | 消除安全遗漏风险 | 未开始 |

第 1 项已执行完毕——它成本近乎为零，把已经存在的边界问题固定在当前规模（8 处），防止在修复前继续扩大。这与后端阶段一落地棘轮是同一个判断：**先冻结，再收敛。**

第 2~6 项属后续排期，**本次范围不含**；且第 2 项须在第 1 项的棘轮守护下进行（迁移完成一处即同步下调一次基线）。

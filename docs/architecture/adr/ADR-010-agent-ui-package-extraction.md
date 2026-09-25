# ADR-010: 跨端共享前端资产提升为 workspace 包（`packages/agent-ui`）

## Status

Accepted

## Context

### 当时的约束

- 项目是**多端共享 UI**：智脑工作台（desktop / mobile / dingtalk 三端共用 `packages/agent-workbench`）、元域智营端（`apps/semantic-operations-console`，Web + Electron 同源）、主 Web（`frontend`）。
- 团队规模小、阶段早：`frontend` 是 `private: true` 的**应用**，不是库；`packages/*` 才是可复用单元。
- 已落地跨包边界棘轮（2026-09-24），规则是**只降不升**：`packages/*`、`apps/*` 不得用相对路径穿透兄弟包的私有源码。

### 实测问题：8 处跨包穿透

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

这不是风格问题，是三个具体工程风险：

1. **声明与事实不符**。`packages/agent-workbench/package.json` 的依赖里没有 `frontend`，`frontend/package.json` 也没有 `exports`。这些 import 绕过了 npm workspace 解析机制，靠相对路径物理穿透到另一个包的 `src/`；任何一次目录调整都会静默打断，且只在构建期才暴露、报错位置与真实原因分离。
2. **包的独立性是假的**。`agent-workbench` 声称是可跨端复用的工作台，实际依赖 `frontend/src/features/` 下的私有源码——想独立构建或发布必须把整个 `frontend` 拖上。
3. **传递依赖闭包不受控**。一行 import 实际拉入 5~6 个文件（`KnowledgeLibraryPanel` → 4 个子面板；`OAMetaModelStudio` → 3 个子面板 + `ontology-scenario.js`），这些文件又各自继续依赖 `frontend` 内部结构，边界会随迭代持续扩大。

### 为什么现在必须做（结构性前置）

「系统接入 → 选系统建模 → 模型治理」重构（[方案](../SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md)）的**阶段 2（接入模块迁移到元域智营端）与阶段 6（模型/版本管理收敛）都要搬文件**。棘轮只降不升，**先迁文件后建包，`architecture-boundaries.test.js` 会当场失败**；同时「选系统建模」要复用元模型面板，双端共用是既成事实。所以这一步是纯结构性前置，不是可选项。

### 一个此前未被发现的扫描盲区

棘轮初版的扫描扩展名是 `.js/.mjs/.ts/.vue`，**漏了 `.cjs` 与 `.css`**。实测这两类里另有 3 处真实穿透（语义运营端 2 处测试 `import('../../../frontend/src/features/meta-model/...')`；1 处 `examples/` 样例）。也就是说，审计报告的「8 处」**在扩大扫描面前并不完整**——这是一处需要显式记录的自我修正。

## Decision

### 1. 新建 `packages/agent-ui`，承载双端共用资产

选名 `agent-ui` 而非方案文档初拟的 `semantic-model-ui`：该包同时承载元模型/本体面板、知识资料面板、异常助手面板与设计基线样式，**已超出「语义模型 UI」的语义**。方案文档第 6 节阶段 1 已显式允许「或并入模块化审计建议的 `packages/agent-ui`」，此处按审计命名执行。

```
packages/agent-ui/
  package.json          # exports 显式声明 9 个入口
  src/index.js          # 统一出口（样式不走此出口）
  src/meta-model/       # 7 个文件：CoreMetaObjectLayer / OAMetaModelStudio /
                        #   OntologyCaseReplay / OntologyReadPlanPanel / OntologyScenarioPanel /
                        #   ontology-scenario.js / ontology-read-plan-import.js
  src/knowledge/        # 6 个文件：KnowledgeLibraryPanel + 4 子面板 + MemoryReviewPanel
  src/agent/            # 1 个文件：AnomalyAssistantPanel
  src/styles/           # 3 个文件：main.css（企业设计基线）/ meta-model.css / core-meta-objects.css
```

共迁移 17 个文件（14 个组件/模块 + 3 个样式），**全部为纯重命名**（`git diff -M --numstat` 显示 0 增 0 删；样式文件字节一致）。

### 2. 依赖改为声明式，显式 `exports` 而非通配

`package.json` 只声明 9 个具名入口（`.`, `./meta-model`, `./knowledge`, `./agent`, `./ontology-scenario`, `./ontology-read-plan`, `./styles/*.css` ×3），**刻意不使用 `"./*": "./src/*"` 通配**。

理由：通配会把「声明式边界」重新退化成「什么都能拿」，与本次收敛的目的相反。具名入口的代价是新增文件需同步登记 exports，这正是想要的可审计性。

消费方全部改为声明式依赖：

| 消费方 | 声明 | 用途 |
| --- | --- | --- |
| `packages/agent-workbench` | `dependencies` | 智脑工作台的知识/异常面板 |
| `apps/semantic-operations-console` | `dependencies` | 元模型校对 + 知识资料 + 设计基线样式 |
| `frontend` | `dependencies` | 世界模型页 + 治理动作 + 设计基线样式 |
| `backend` | **`devDependencies`** | 仅 4 个本体测试需要的场景夹具（非运行时依赖） |

### 3. 棘轮基线归零并扩大扫描面

- `CROSS_PACKAGE_IMPORT_BASELINE` 由 8 条**降为 0 条**（全部清偿，非持平）。
- `WORKSPACE_IMPORT_EXTENSIONS` 增加 `.cjs` 与 `.css`，把上述盲区纳入守护。
- 新增 1 条 `CROSS_PACKAGE_CONTENT_ALLOWLIST`：语义运营端测试读取仓库级 `examples/semantic-schemas/` 样例。判定理由是**内容而非源码**——`examples/` 是跨包共用的只读样例数据，不属任何包的私有源码、不参与构建产物，且 packages 的 exports 机制不适用于纯数据文件。白名单必须写明理由，否则会退化为无声的例外堆积。

### 4. 测试读取源码的方式随之改为「声明式入口 + 目录推导」

语义运营端 4 个 `.cjs` 组件测试需要**读取组件源码文本**做断言。改为：

```js
const metaModelDir = dirname(require.resolve('@healthcare-ai/agent-ui/meta-model'));
const filename = resolve(metaModelDir, 'OntologyCaseReplay.vue');
```

不使用相对路径穿透，也不为此在 `exports` 里开 `"./src/*"` 后门。理由：测试读源码是真实需求，但需求不构成放宽边界声明的理由；用已声明的入口解析出目录即可兼顾两者。

### 5. 样式随组件走，而不是留在 `frontend`

`main.css`（21KB 企业设计基线）、`meta-model.css`、`core-meta-objects.css` 一并迁入包内 `src/styles/`，由 `frontend` 与元域智营端各自显式 import。

理由：迁移后的组件仍然依赖这些全局类（`.panel` / `.section-header` / `.eyebrow` / `.outline-button` 等），把它们留在 `frontend` 会立刻产生新的穿透。**共享组件与它依赖的设计基线必须同属一个可共享单元**——这也是方案文档在阶段 1 范围里列出「相关样式」的原因。

### 6. 迁移必须同步扩大静态检查的覆盖面

实施中发现两类**静默丢失覆盖**，都必须在同一次改动中修掉：

1. **类型检查**：`tsconfig.json` 的 `include` 原本只有 `packages/*/src/**/*.js`，**没有 `.vue`**。被迁移的 14 个 `.vue` 文件原本通过 `frontend/src/**/*.vue` 受检，迁移后会静默失去类型检查。已补上 `packages/*/src/**/*.vue`。
2. **跨包棘轮**：扫描扩展名漏 `.cjs`/`.css`（见上）。已补全。

**为什么这类问题危险**：迁移是「纯重命名」，所有测试仍然绿——如果只以「测试通过」作为验收，覆盖面的收缩不会以任何形式暴露出来。**结构性迁移的验收必须包含「检查工具的覆盖面有没有跟着变」这一条**，而不是只看用例是否通过。

## Consequences

### 变简单了

- 依赖关系从「物理穿透」变为「声明式依赖」，可被工具校验；`frontend` 不再需要被当作库引用。
- 棘轮基线归零，后续新增任何跨包穿透立即失败；扫描面扩大后不再有 `.cjs`/`.css` 盲区。
- 阶段 2/6 的搬迁前置条件已消除，可以只搬业务代码而不必同时处理共享层。
- 双端（智脑三端 + 元域智营端 + 主 Web）共用同一份组件与样式，视觉一致性由构造保证，不再依赖「改一处记得改另一处」。

### 变困难了

- **新增共享组件必须同步改 `exports`**，否则消费方无法引入。这是有意的摩擦。
- `packages/agent-ui` 成为新的耦合热点：它被 5 个顶层区引用（3 个 app + frontend + backend 测试）。**风险是它可能长成「什么都能放」的杂物包**——缓解办法是子目录按关注点划分（meta-model / knowledge / agent），新增无关关注点时先评估是否应另开包。
- `frontend` 现在对外部包有构建期依赖（设计基线样式），构建顺序上 `packages/agent-ui` 必须先被解析到（workspace 软链解决，但发布/打包场景需要显式声明）。
- `backend` 的 `devDependencies` 里出现了 UI 包，属于**已知不洁**：真实原因是「场景夹具被后端测试复用」。正确处理不是把 UI 包塞给后端，而是把夹具抽到独立数据包。本次不抽，理由见下。

### 放弃了什么

- **放弃了「随手加相对路径就能复用」的便利**。这正是要放弃的。
- **放弃了把 `main.css` 留在 `frontend` 的选择**。副作用是 `frontend` 的入口文件不再自持设计基线；如果将来要独立发布 `frontend` 的样式，需要再拆一次。
- **未抽出夹具包**：`ontology-scenario.js` 同时被 UI 与后端测试使用，本次随组件进了 `agent-ui`，后端以 `devDependencies` 引入。这是一处妥协——代价是后端多一个 dev 依赖，收益是本次不引入第三个包、改动面保持可控。

## 退出/复审条件

出现以下任一情形时重新审视：

1. **`packages/agent-ui` 出现第 4 个以上互不相关的关注点**，或单包文件数超过 30 —— 说明应拆分为 `agent-ui`（面板）+ `design-system`（样式/令牌）+ `semantic-model-ui`（元模型）。
2. **后端非测试代码开始引用 `@healthcare-ai/agent-ui`** —— 说明夹具抽取被拖延到危险程度，必须立刻把 `ontology-scenario.js` 一类数据抽到独立包。
3. **出现第二个需要「读取源码文本做断言」的消费方测试** —— 说明「声明式入口 + 目录推导」这个折中不够用，应改为把待断言的契约显式导出为可测函数。
4. **需要独立发布/打包 `frontend`** —— 届时 `main.css` 的归属需要重定（当前把它放进了共享包）。

## 关联

- 落地依据：[模块化与组件化审计](../MODULARIZATION_AUDIT.md) 2.4 方案 A、第 9 节第 2 项
- 触发场景：[「系统接入 → 选系统建模 → 模型治理」整体重构方案](../SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md) 阶段 1（结构性前置）
- 前置决策：[ADR-005](ADR-005-domain-public-api-layering.md)（分层与显式契约）、[ADR-007](ADR-007-modular-monolith-over-microservices.md)（模块化单体的边界纪律）
- 棘轮实现：`backend/test/architecture-boundaries.test.js`、`backend/test/architecture-baseline.js`
- 包本体：`packages/agent-ui/`

# WorkBuddy 协作工作记录

更新：2026-09-24。本页按时间线维护 WorkBuddy 接手「元域智脑」（demo-platform）以来完成的工作，供交接与回溯使用。当前整体状态以 [当前状态](PROJECT_STATUS.md) 为准，此处只记录协作过程中的增量、根因与边界，不重复验收结论。

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

产出 [产品分析与方向](PRODUCT_ANALYSIS_AND_DIRECTION.md)：以「语义层连接企业数据、双 Agent 承接业务」为定位，梳理目标用户（业务人员 / 语义运营 / 管理员）与核心价值路径，指出当前阶段的主要产品风险（能力已建成但业务闭环未闭合、Mock 与真实边界易被误读），并给出优先级排序的方向建议。

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
- `backend/test/architecture-baseline.js` 作为**唯一基线事实源**：`DOMAIN_EXPORT_CEILING`、`CROSS_DOMAIN_EDGE_BASELINE`（189 条边）、`SERVICE_FILE_LINE_CEILING`、`INFRASTRUCTURE_DOMAINS`（排除 `domains/events` 这类无 public-api 的基础设施域）。
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

## 行为等价性验证方法

结构性重构最大的风险是「测试过了但行为变了」。本次采用双向对照：

1. 先记录改动后各测试组结果；
2. 把原始文件从 git 恢复，在**同一环境**跑一遍基线；
3. 比对差异并逐项归因。

结果：改动前基线仅有新棘轮测试对未登记边与旧行数的 2 项「应有失败」；改动后 19 个组全绿。**并额外发现 `test:permissions` 组为预存环境级 flaky**——原始未改动代码连续三次运行失败数为 2/0/3，改动后为 1/0/0，失败信息均为「权限加固测试 API 未就绪」的 HTTP 服务启动竞态。该 flaky 与本次改动无关，已记录待单独排查，未掩饰为「通过」。

## 质量与边界

- 每批改动均运行对应专项与 ESLint；文档检查（docs:check）通过（当前 168 份 Markdown、855 个本地链接）。
- 架构优化三阶段的回归口径：19 个测试组全部复跑，0 失败（`test:permissions` 的预存 flaky 已单独说明并复现确认）。
- 跨包边界棘轮（第 15 项）的回归口径：architecture 组 10/10；另复跑 18 个非 flaky 测试组（contracts/clients/nonfunctional/architecture/events/security/ark/evidence/conversations/alerting/semantic/desktop/learning/orchestration/persistence/dingtalk/identity-providers/ontology）全部 0 失败。
- 未充值方舟、未做多模态与生产验收；评测脚本缺省行为不变；全部结果为合成材料/受控环境验收，不代表生产级验收。
- **未启动真实数据迁移**：ADR-004 四条迁移前置条件均只部分满足，已在 ADR-004 内以表格标注。
- **未完成的架构收敛项**（已在 ADR-008 登记为退出条件）：仍有 8 个文件持有私有 `postgresRepository` 变量（`agent-evidence-trace-service`、`agent-conversation-service`、`agent-learning-governance-service`、`semantic-governance-store`、`alerting-store`、`risk-procurement-store`、`agent-orchestration-service`、`mock-scenario-service`）；189 条跨域边尚未逐条收敛；领域 public-api 契约面尚未从重导出收敛为目标 ≤15；`private-agent-service` 仍有进一步拆分空间。
- **未完成的模块化收敛项**（审计第 9 节第 2~6 项）：跨包穿透 8 处仅被冻结、未清偿（方案 A/B 均未启动）；`domains/events` → `infrastructure/domain-events` 改名未做；`AgentWorkbench.vue` 4 个 composables 未抽；前端三层组件判据未落文档；横切关注点管线化未启动（须先立枚举入口的测试）。
- 代码在本机验证通过，提交与推送由维护者按 [交付约定](../development/GITHUB_DELIVERY.md) 执行。

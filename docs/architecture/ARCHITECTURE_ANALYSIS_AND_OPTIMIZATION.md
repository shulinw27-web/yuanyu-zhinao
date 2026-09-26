# 元域智脑架构分析：测绘、问题诊断与优化建议

编制日期：2026-09-24｜视角：软件架构（DDD / 模块边界 / 质量属性 / ADR）

> 本文结论基于对仓库的实际测绘（文件结构、导入图、测试配置、持久化实现），非文档转述。所有数字为本次实测，命令可复现。

---

## 一、实测测绘（先看事实）

### 1.1 规模与形状

| 指标 | 实测值 | 备注 |
| --- | --- | --- |
| 后端源码文件（`backend/src/**/*.js`） | **198** | 其中 `services/` **137** 个 |
| 后端测试文件 | **79** | 测试/源码比 ≈ 0.40，工程纪律良好 |
| `domains/` 目录 | **11** 个 | 其中 9 个仅含一个 `public-api.js` |
| 路由文件 | 13 | 全部只依赖 `domains/*/public-api.js` ✅ |
| 工作区包 | 5 | 依赖图 **无环、方向干净** ✅ |
| 最大后端文件 | `private-agent-service.js` **1206 行** | 直接 import **33** 个 service |
| 前端文件（元域智营） | 43 | 最大 `App.vue` 404 行 ✅ |
| Python 语义服务 | 10 个 py | 通过 HTTP 通信，边界清晰 ✅ |

### 1.2 依赖图实测

```
routes/*.js  ──全部──▶  domains/*/public-api.js  ✅ 纪律严格（有测试守护）
                              │
                              ▼  re-export
                      services/*.js  （137 个）
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  services/*.js          repositories/      infrastructure/
  （互相直接 import，     （仅 4 个文件）      domain-events/
   无中介、无接口）                            （outbox/broker）
```

> **2026-09-26 更新**：末列原为 `domains/events`，已迁到 `infrastructure/domain-events/`（见 [MODULARIZATION_AUDIT](MODULARIZATION_AUDIT.md) 第 3 节，已完成）。

**关键观测**：路由层到领域层的边界是真实的（且有回归测试守护）；但**领域层内部是「扁平服务汤」**——137 个 service 通过相对路径 `./xxx-service.js` 自由互相 import，没有任何接口契约或依赖倒置。

### 1.3 被依赖热点（实测扇入）

| 服务 | 被 import 次数 | 性质 |
| --- | --- | --- |
| `prompt-security-service.js` | **19** | 横切关注点（应为中间件/装饰器） |
| `local-model-gateway.js` | 14 | 横切（模型网关） |
| `semantic-governance-store.js` | 12 | 存储 |
| `agent-query-service.js` | 12 | 领域 |
| `iam-store.js` | 11 | 存储 |
| `access-control-service.js` | 9 | 横切（鉴权） |

### 1.4 持久化实测

```sql
-- runtime-state-repository.js 实际 schema
CREATE TABLE runtime_state (
  namespace TEXT, state_key TEXT, value_json TEXT,  -- ← 整个领域对象序列化进单列
  version INTEGER, updated_at TEXT,
  PRIMARY KEY (namespace, state_key)
);
```

**全库只有一张 JSON blob 表。** 业务实体（Agent Run、证据链、确认 Token、告警、模型治理）都以 `(namespace, state_key) → JSON 字符串` 形式存储。

### 1.5 测试环境实测

`backend/test/runtime-test-bootstrap.js` 全文只有两行，强制 `RUNTIME_STORE_DRIVER=memory`：

```js
process.env.NODE_ENV = 'test';
process.env.RUNTIME_STORE_DRIVER = 'memory';
```

79 个测试文件中**仅 7 个**显式覆盖为 sqlite。即 **约 91% 的测试从未经过真实持久化路径**。

---

## 二、五处结构性问题

### P1｜领域边界是「名义的」，不是「约束的」🔴 高

**证据**：实测各域 `public-api.js` 导出规模：**governance 30 条、agent 24 条**、identity 10、platform/simulation 各 6、alerting 4、其余 1–3 条。`domains/agent/public-api.js` 从 33 个不同 service 重导出，内容横跨模型网关、审计导出、安全检测、桌面端点、编排、学习治理。`domains/governance/public-api.js` 同时服务 anomaly 与 knowledge 两条路由（异构关注点合并）。

**为什么这是问题**：

- `public-api.js` 是**重导出清单**，不是**边界契约**。它没有减少任何耦合——调用方仍拿到具体实现，无法替换、无法 mock、无法约束。
- 「agent 领域」实际包含 33 个概念，「governance 领域」导出 30 条——它们不是 bounded context，是**按路由倒推的目录**。
- 后果：任何跨域改动都会引发大范围涟漪；团队无法按领域分工；新人无法从目录理解系统。

**判据**：真正的模块边界应满足「内部变更不影响外部」。当前 `public-api.js` 任何一行改动都可能影响路由（因为导出即实现）。**这是最值得优先处理的一项。**

**补充实测**：跨域直接 import 确实存在但数量有限——`semantic-context-service` 与 `semantic-operations-task-service` 导入 `agent-*`；`knowledge-library-service` 与 `knowledge-study-service` 导入 `semantic-*`。说明耦合是**点状渗透**而非全面失控，这降低了治理成本（无需大手术），但也意味着**边界约束一旦缺失就会持续扩散**——正好支撑建议 1 的「加测试约束」优先级。

### P2｜核心编排器退化为中心辐射（God Service）🔴 高

**证据**：`private-agent-service.js` = 1206 行（是第二大 service 的 2.1 倍），直接 import 33 个 service，覆盖：鉴权、意图识别、证据、记忆、编排、查询、长任务、技能注册、工具注册、桌面、多模态、模型网关、租户控制。

**为什么这是问题**：

- 违反 SRP 且**无法测试** —— 33 个依赖意味着任何单测都要准备 33 个替身，实践中只能整体集成测试。
- **变更放大器**：33 个依赖中的任意一个改签名，这个文件就要改。
- **团队瓶颈**：两个开发者同时改它会持续冲突。
- 这也解释了为什么需要「全量 860 次执行」才能有质量信心——缺少可隔离的单元边界。

**判据**：健康的编排器应是**薄协调层**（依赖 ≤ 7，行数 < 300），把逻辑下沉到领域服务。当前它把领域逻辑与编排混在一起。

### P3｜持久化是 JSON blob，生产迁移成本被低估 🟠 中高

**证据**：单表 `runtime_state(namespace, state_key, value_json)`。

**为什么这是问题**：

- **无法用数据库能力**：不能建外键、唯一约束、业务索引；无法做 SQL 级查询；并发正确性靠应用层 `version` 字段手工实现。
- **迁移到 PostgreSQL 不是「换驱动」而是「重做数据模型」**。生产清单里 P0 项「拆分 JSONB 迁移桥梁，建立带 tenant key、外键、唯一键和业务索引的正式领域表」正是这个成本——它是 P0 且工作量大，因为**当前没有任何领域表**。
- **占位锁**：`busy_timeout = 5000` + WAL 是单机缓解手段，多实例下不成立（清单已承认）。

**说明**：这不是「错误决策」——单机 Mock 阶段选 JSON blob 是**合理的最快路径**。问题是当前没有**领域表 DDL 的雏形**，导致迁移没有起点。

### P4｜横切关注点靠「import 19 次」实现 🟠 中

**证据**：`prompt-security-service.js` 被 19 个文件 import；`access-control-service.js` 8 个；`local-model-gateway.js` 14 个。

**为什么这是问题**：

- 安全策略、鉴权、模型网关调用是**横切关注点**，应通过**管线/中间件/装饰器**统一注入。
- 当前每个 service 自行 import 并自行决定何时调用 → **策略一致性靠人工纪律**，新增 service 容易漏调。
- 安全类代码尤其危险：漏一次 `prompt-security` 调用就是一个漏洞面。

**判据**：安全与鉴权不应「可选」，应是**不可绕过的必经路径**。

### P5｜测试策略与运行时现实偏离 🟠 中

**证据**：91%（72/79）测试跑在 `memory` 驱动上；全量约 860 次执行。

**为什么这是问题**：

- memory ≈ Map，sqlite ≈ 真实事务/锁/序列化。**测过的路径不等于上线跑的路径**。
- 这正是前一轮发现的 9 项预存失败（跨进程/重启恢复）能潜伏的原因——它们只在真实 sqlite 下暴露。
- 单机 Mock 阶段可接受，但**随 PostgreSQL 迁移会集中爆发**（JSON blob → 领域表的差异全部未测）。

---

## 三、优化建议（按投入产出排序）

### 建议 1｜把 `public-api.js` 从「重导出」改为「真契约」🔴 先做

**做法**（渐进，不重写）：

```js
// 现状：重导出（= 无边界）
export { runPrivateAgent } from '../../services/private-agent-service.js';

// 建议：显式契约对象（= 有边界、可替换、可 mock）
export const agentApi = {
  run: (input) => runPrivateAgent(input),
  // 只暴露领域对外需要的，不暴露内部细节
};
```

**配套约束（关键）**：新增一条架构测试，断言
- 每个 `public-api.js` 导出的符号数 ≤ 15（超限需拆分域）；
- `services/` 之间**禁止**跨域 import（如 `agent-*` 不得 import `semantic-*`），跨域必须走对方 `public-api.js`。

**收益**：把「纪律」变成「编译/测试期约束」，这是当前项目最缺的一环。
**成本**：低（改导出形式 + 加测试），可在 1–2 个增量内完成。
**风险**：低，可分批。

### 建议 2｜拆解 `private-agent-service`（God Service）🔴 紧随其后

**做法**：按现有 import 群聚特征拆为三个薄协调器 + 一个管线：

| 新模块 | 职责 | 承接现有逻辑 |
| --- | --- | --- |
| `agent-turn-pipeline.js` | 单轮对话管线（理解→鉴权→证据→回答） | 主体流程 |
| `agent-task-coordinator.js` | 长任务/编排/工作项 | 长任务、orchestration、workflow |
| `agent-capability-resolver.js` | 技能/工具/端点解析 | skill-registry、tool-registry、desktop、endpoint |

**目标指标**：单文件 ≤ 300 行、直接依赖 ≤ 7。**先拆是最有价值的重构**，因为它同时解开测试瓶颈（可单测）和团队瓶颈（可并行）。

**重要前提**：拆解必须在**行为等价**前提下，靠现有 79 个测试文件守护。建议先补一层「管线级」契约测试再拆。

### 建议 3｜横切关注点收敛为显式管线 🟠

**做法**：
- 建立统一的 **请求/模型调用管线**：`promptSecurity → authorization → modelGateway → governance`。
- 领域服务**不得**直接 import `local-model-gateway` / `prompt-security`；只能经管线获得已完成安全检查的能力。
- 加测试断言：`services/` 下除管线外，无文件 import `prompt-security-service`。

**收益**：安全一致性从「人工纪律」变「结构保证」；这是本项目**信任资产**的技术底座。

### 建议 4｜为持久化建立「领域表雏形」，让迁移有起点 🟠

**做法**（不要求立刻迁 PostgreSQL）：
1. 在 `repositories/` 下为 3–5 个**核心实体**（Agent Run、Evidence Trace、Confirmation Token）定义**显式列结构**，即使底层仍写 JSON blob。
2. 定义**存储端口（port）**：`AgentRunRepository`、`EvidenceTraceRepository` 接口；当前 SQLite/JSON 是实现，PostgreSQL 将来是另一实现。
3. 加迁移一致性测试：同一组操作在 memory / sqlite 下产出相同结果（把 P5 的 7 个测试扩到核心实体全覆盖）。

**收益**：把「迁移 = 重做数据模型」降为「迁移 = 新增实现 + 数据搬运」，这是当前最大的隐藏成本项。

### 建议 5｜测试金字塔重建 🟠

| 层 | 现状 | 建议 |
| --- | --- | --- |
| 单元（领域逻辑） | 被 God Service 阻塞 | 拆解后补，目标覆盖领域规则 |
| 契约（端口/管线） | 缺失 | 新增，守护重构 |
| 集成（真实 sqlite/PG） | 仅 7 个文件 | 核心实体全覆盖，memory/sqlite 对照 |

### 建议 6｜补一份 ADR 库 🟢

**现状**：项目文档极其详尽（能力范围、验收、边界），但**决策记录（WHY）分散**。README 有「三个关键设计选择」，但格式不是 ADR，且只覆盖 3 条。

**建议**：建立 `docs/architecture/adr/`，至少补齐以下决策（模板见下方附录）：
- ADR-001 语义与权限分离
- ADR-002 推理与副作用分离
- ADR-003 状态与事实分离
- ADR-004 单表 JSON blob 持久化（**含明确的退出条件**）
- ADR-005 domains/public-api 分层
- ADR-006 双 Agent 独立入口
- ADR-007 多端（Web/Electron/移动/钉钉）共享契约

**价值**：ADR-004 尤其重要——把「当时为什么选 JSON blob + 何时必须退出」写清楚，否则这个决策会被无意识地长期沿用。

---

## 四、值得保留的架构优点（不要动）

必须明确：**这个项目的架构基础远高于平均水平**，以下是有价值的决策，优化时不得破坏：

| 优点 | 证据 | 为什么珍贵 |
| --- | --- | --- |
| 路由层边界真实且有测试守护 | 13 个路由全部只依赖 `public-api`，`architecture-boundaries.test.js` 守护 | 多数项目这一层会腐化 |
| 依赖图无环、包方向干净 | 5 个包线性依赖，无循环 | 可安全重构 |
| 组合根职责清晰 | `app.js` ≤ 140 行，有测试断言 | 启动路径可理解 |
| 配置集中校验 + 生产开关强制 | `runtime-config.js` 阻止生产携带 Demo 开关 | 安全默认值正确 |
| 前后端契约独立 | `packages/api-contracts` 独立包 | 多端复用基础 |
| 多语言边界清晰 | Python 语义服务经 HTTP 通信 | 无跨语言耦合 |
| 横切关注点已有独立模块 | `prompt-security` / `access-control` / `model-gateway` 已存在 | 只需收敛调用方式，不需重写 |
| 事件基础设施已就位 | `infrastructure/domain-events`（原 `domains/events`，2026-09-26 迁出）有 outbox + broker | 生产演进已备好骨架 |

**结论：当前架构需要的是「收敛与约束」，不是「重写」。**

---

## 五、质量属性评估

| 属性 | 现状评级 | 主要制约 | 优化后预期 |
| --- | --- | --- | --- |
| **可维护性** | 🟠 中 | God Service（1206 行/33 依赖）+ 扁平服务汤 | 拆解后显著提升 |
| **可测试性** | 🟠 中 | 单元层被阻塞，91% 测试在 memory | 拆解 + 端口化后改善 |
| **可演进性** | 🟠 中高 | 领域边界名义化，跨域改动涟漪大 | 契约化后改善 |
| **可扩展性** | 🔴 低（生产） | 单表 JSON blob + 进程内限流 + 单机 SQLite | 端口化后可平滑迁 PG |
| **可靠性** | 🟠 中 | 已有 outbox/幂等/回执，但真实持久化测试覆盖低 | 集成测试补齐 |
| **安全性** | 🟢 高 | 分层访问控制、密钥外部化设计、配置强校验 | 保持，管线化再加固 |
| **可观测性** | 🟢 中高 | 结构化日志、Prometheus、审计链、SIEM 导出 | 保持 |
| **一致性/可追溯** | 🟢 高 | 证据链与四态语义是本项目最强项 | 保持 |

---

## 六、演进路线（三阶段，每步可独立交付）

### 阶段 1：加约束（低成本、高收益，建议立即做）
- 契约化 `public-api.js`（建议 1）
- 新增架构测试：域导出数上限、跨域 import 禁止、横切服务调用白名单
- 建 ADR 目录，先落 ADR-004（持久化退出条件）

**不变量**：不改业务行为，全部现有测试必须继续通过。

### 阶段 2：拆核心（中成本）
- 拆解 `private-agent-service` 为 3 个薄协调器（建议 2）
- 横切关注点管线化（建议 3）
- 同步补管线级契约测试

**验收**：单文件 ≤ 300 行、依赖 ≤ 7；79 个测试文件全绿；新增单元测试覆盖领域规则。

### 阶段 3：持久化端口化（为生产铺路）
- 核心实体定义显式列结构与 Repository 端口（建议 4）
- memory/sqlite/PG 三实现对照测试（建议 5）
- 与生产清单 P0「正式领域表 + RLS」对接

---

## 七、风险提示

| 编号 | 风险 | 等级 | 应对 |
| --- | --- | --- | --- |
| AR-01 | 继续在 1206 行 God Service 上叠加功能，重构成本指数上升 | 高 | 立即冻结该文件新增依赖，新能力进新模块 |
| AR-02 | 先迁 PostgreSQL 再做端口抽象 → 数据模型返工 | 高 | 严格按阶段 3 顺序：端口先行，迁移后随 |
| AR-03 | 契约化改造误伤现有行为 | 中 | 行为等价红线：不增删测试，只增不改 |
| AR-04 | 领域拆分过度（为拆而拆）导致分布式复杂度 | 中 | 保持模块化单体，**不引入微服务**（当前团队与阶段不需要） |
| AR-05 | 测试长期停在 memory，生产差异集中爆发 | 中高 | 核心实体强制 sqlite 覆盖 |

---

## 八、明确不建议做的事

- ❌ **不拆微服务**。当前是模块化单体（modular monolith），这是**正确选择**；团队规模与业务阶段都不支持微服务，拆分会引入分布式事务、网络分区与服务发现成本，收益为负。
- ❌ **不引入重型 DDD 框架/ORM**。当前原生 SQL + 显式代码风格一致，引入 ORM 会与现有 `runtime-state-repository` 冲突。
- ❌ **不重写现有安全与治理层**。这部分是本项目最强资产，只做管线化收敛（调用方式），不动实现。
- ❌ **不在阶段 1 之前动持久化**。顺序错了会导致数据模型返工（见 AR-02）。

---

## 附录：ADR 模板与示例

```markdown
# ADR-004: 使用单表 JSON blob 作为运行时持久化

## Status
Accepted（含退出条件）

## Context
单机 Mock 验证阶段需要最快路径支撑 198 个后端文件的持久化需求；
领域模型仍在快速变化，过早定义表结构会导致频繁迁移。

## Decision
使用单表 runtime_state(namespace, state_key, value_json)，
以 (namespace, state_key) 为主键，version 字段做乐观锁。

## Consequences
**变简单**：新增领域对象零 DDL 成本；schema 演进无迁移负担；单文件实现。
**变困难**：无法用外键/唯一约束/业务索引；并发正确性靠应用层；
无法 SQL 查询；迁移 PostgreSQL 需重做数据模型。

## 退出条件（必须满足其一即启动迁移）
1. 需要多实例部署（busy_timeout/WAL 失效）；
2. 任一实体的查询需要 SQL 级过滤/聚合；
3. 需要数据库级租户隔离（RLS）；
4. 数据量超出单机 SQLite 舒适区。

## 迁移前置（不满足则不得启动迁移）
核心实体已定义显式列结构与 Repository 端口（见架构分析建议 4）。
```

---

本分析为架构设计参考，具体实施请结合团队规模、交付节奏与公司合规要求确认。

# ADR-008: 持久化驱动选择收敛为端口（persistence port）

## Status

Accepted

## Context

[ADR-004](ADR-004-json-blob-runtime-persistence.md) 决定运行时状态存于单表 JSON blob，并把「仓储端口已抽象」列为迁移到 PostgreSQL 的**前置条件之一**。本 ADR 记录该前置条件如何落地。

实施前的实测状况：

- 每个 Agent 侧 store 服务各自持有 `let postgresRepository = null` 私有变量，并各自提供 `configureXxxRepository()`；
- 实测 **35 处** `postgresRepository ? 远程分支 : 本地分支` 三元判断，散落在 **10 个文件**中（`agent-run-store` 37 处引用、`agent-long-task-store` 34 处、`agent-evidence-trace-service` 19 处、`agent-conversation-service` 17 处、`agent-learning-governance-service` 14 处等）；
- 各文件对 `getInfo()` 的 `schemaVersion` 硬编码互不一致（同为 PostgreSQL 后端却分别写 3 与 4）；
- 新增一个持久化能力时，必须再复制一遍「注入仓库 / 未注入」双分支。

即：**驱动选择是横切关注点，却被复制了 35 次**。这使 ADR-004 要求的「当前实现只是端口的一种实现」在代码上并不成立——没有单一位置可以回答「现在用的是哪个驱动」。

## Decision

引入 `backend/src/services/persistence-port.js`，把驱动选择收敛为一处：

- 端口注册表：`configurePort(portName, repository, { methods, optionalMethods })` / `getPort` / `hasPort`；
- 委派原语：`delegate(portName, { remote, local })`，消除 `?:` 双分支；
- 驱动描述：`describePersistence(portName, localInfo)`，统一 `getInfo()` 输出；
- 已登记端口：`RUNTIME_STATE_PORT`（运行时状态读写）与 `LONG_TASK_PORT`（长任务队列）。

方法校验分两级：

- **必需方法**缺失 → 抛 `TypeError`，阻止半成品实现被静默启用；
- **可选方法**缺失 → 记入 `getPortWarnings()`，不阻断。这是为故障注入型替身（只实现被调用到的那几个方法）保留的通道。

已迁移的调用点：`agent-run-store.js`、`agent-long-task-store.js`。二者对外导出的 `configureAgentRunRepository` / `configureAgentLongTaskRepository` 签名不变，因此调用方零改动。

## Consequences

**变简单**：

- 驱动选择有单一事实源，新增持久化能力不再复制分支；
- `getInfo()` 的 `schemaVersion` 不再各写各的；
- 端口契约可被独立测试（`backend/test/persistence-port.test.js`，5 项）；
- ADR-004 的「仓储端口已抽象」前置条件由此项落地。

**变困难 / 放弃的**：

- 引入一层间接：阅读 store 文件时需跳到端口模块才能确认驱动来源；
- 剩余 8 个仍持有私有 `postgresRepository` 变量的文件**尚未迁移**（`agent-evidence-trace-service`、`agent-conversation-service`、`agent-learning-governance-service`、`semantic-governance-store`、`alerting-store`、`risk-procurement-store`、`agent-orchestration-service`、`mock-scenario-service`）。本次刻意不一次性全改，以避免单次变更面过大难以定位回归；
- `delegate` 的 `local` 分支保持同步语义（不强行 Promise 化），因此调用处仍需自行处理同步/异步差异——这是刻意的，因为把本地路径改为异步会波及全部 Demo 调用链。

## 退出/复审条件

1. 其余 8 个文件完成迁移，全仓库不再出现私有 `postgresRepository` 变量（可用 `grep -c postgresRepository` 度量，目标为 0）；
2. 端口方法校验从「人工维护方法清单」改为由接口定义自动推导；
3. 若 `delegate` 的同步/异步双语义持续造成调用处复杂度上升，应改为统一异步端口并一次性迁移本地路径。

## 关联

- ADR-004（本 ADR 落地其前置条件 2「仓储端口已抽象」）；
- ADR-005（领域分层；本模块属服务层内部关注点，未新增跨领域边）；
- 迁移脚本 `backend/migrations/postgres/005_core_entity_projection.sql` 落地 ADR-004 前置条件 1「核心实体已定义显式列结构」。

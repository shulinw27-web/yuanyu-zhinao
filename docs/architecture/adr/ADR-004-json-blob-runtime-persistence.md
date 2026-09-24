# ADR-004: 运行时持久化采用单表 JSON blob

## Status
Accepted（**含明确退出条件**）

## Context

项目处于开发基线与 Mock 验证阶段，约束如下：

- 领域模型仍在快速变化（Agent Run、证据链、确认 Token、告警、模型治理等实体字段频繁调整）；
- 需要同时支持 198 个后端文件、79 个测试文件的持久化需求，且不引入外部依赖（SQLite 内置于 Node `node:sqlite`）；
- 单机运行即可满足当前验收（无可用的多节点环境）；
- 研发重点是语义建模与 Agent 编排，持久化层不希望成为进度瓶颈。

若此时为每个实体设计正式表结构，需要频繁 DDL 迁移，成本高且在模型未稳定时几乎必然返工。

## Decision

采用**单表 JSON blob** 作为运行时持久化：

```sql
CREATE TABLE runtime_state (
  namespace TEXT NOT NULL,
  state_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, state_key)
);
```

- 以 `(namespace, state_key)` 定位实体，整个领域对象序列化为 `value_json`；
- `version` 字段做应用层乐观锁；
- 同时支持 `memory` 驱动（测试用）与 `sqlite` 驱动（真实持久化）；
- 单机并发通过 `PRAGMA busy_timeout = 5000` + WAL 缓解。

## Consequences

**变简单**：

- 新增领域对象零 DDL 成本，模型演进无迁移负担；
- 单一文件实现（`runtime-state-repository.js`），概念极少；
- 实体以完整对象存储，读取即得完整聚合，无需 join 重组；
- 状态快照天然支持「按 namespace 整体重置」的测试诉求。

**变困难 / 放弃的**：

- **无法使用数据库能力**：无外键、无唯一约束、无业务索引，无法做 SQL 级过滤/聚合/分页；
- 并发正确性完全依赖应用层的 `version` 乐观锁，缺少数据库级保证；
- 无法做数据库级租户隔离（RLS）；
- **迁移到 PostgreSQL 不是「换驱动」而是「重做数据模型」**——当前没有任何领域表可作为迁移起点，这是最大的隐藏成本；
- `busy_timeout`/WAL 仅对单机有效，多实例部署下不成立；
- 无法按字段查询/统计，运维排查需读出完整 JSON。

## 退出条件（满足其一即应启动迁移评审）

1. **需要多实例/多节点部署** —— `busy_timeout` + WAL 的单机假设失效；
2. **任一实体需要 SQL 级过滤、聚合或分页** —— 例如按租户/时间范围查询证据链；
3. **需要数据库级租户隔离（RLS 或等效强制隔离）** —— 生产多租户合规要求；
4. **数据量或并发超出单机 SQLite 舒适区**；
5. **出现跨实体的事务一致性要求** —— 需要在同一事务内保证多实体原子提交。

## 迁移前置条件（不满足则不得启动迁移）

在启动实际迁移前，必须先完成：

1. **核心实体已定义显式列结构** —— 至少覆盖 Agent Run、Evidence Trace、Confirmation Token；
2. **仓储端口已抽象** —— 存在 `Repository` 接口，当前 SQLite/JSON 只是其一种实现，PostgreSQL 可作为新增实现接入；
3. **一致性测试就绪** —— 同一组操作在 memory / sqlite 下产出相同结果，并可在 PostgreSQL 下复跑；
4. 迁移演练方案确定（含校验与回滚），Mock 数据不得混入生产事实库。

> 前置条件的工程落点见 [架构分析与优化](../ARCHITECTURE_ANALYSIS_AND_OPTIMIZATION.md) 建议 4（持久化端口化）与建议 5（测试金字塔重建）。

### 前置条件推进状态（2026-09-24）

| 前置条件 | 状态 | 落地物 |
| --- | --- | --- |
| 1. 核心实体显式列结构 | **部分完成** | `backend/migrations/postgres/005_core_entity_projection.sql`：新增 `agent_runs`、`agent_evidence_traces` 显式列表 + 同步触发器 + 回填；Confirmation 作为 `agent_runs` 的显式列（`confirmation_status` / `confirmation_expires_at` / `requires_confirmation`）表达。**运行时读路径仍走 JSON blob**，故仅完成「结构定义」而未完成「读写切换」 |
| 2. 仓储端口已抽象 | **部分完成** | [ADR-008](ADR-008-persistence-port.md)：`persistence-port.js` 收敛驱动选择，`agent-run-store` 与 `agent-long-task-store` 已迁移；仍有 8 个文件持有私有 `postgresRepository` 变量 |
| 3. 一致性测试就绪 | **部分完成** | `backend/test/persistence-port.test.js`（5 项，端口契约）+ 既有 `postgres-runtime-repository.test.js`（真实 PG 路径）；尚未建立「同组操作在 memory/sqlite/postgres 三驱动下产出相同结果」的对照测试 |
| 4. 迁移演练方案 | **未开始** | 迁移 005 已含回滚脚本，但未在预发环境演练 |

**结论：四条前置条件均未完全满足，因此不得启动真正的数据迁移。** 本表的作用是防止把「已定义显式列」误读为「已可迁移」。

## 重要提示

本决策**不是错误决策**——在单机 Mock 阶段选择 JSON blob 是合理的最快路径。风险在于：若无退出条件约束，该决策会被无意识地长期沿用，使迁移成本随时间指数上升。**因此本 ADR 的核心产物是上面两组条件，而非「选 JSON blob」这一结论本身。**

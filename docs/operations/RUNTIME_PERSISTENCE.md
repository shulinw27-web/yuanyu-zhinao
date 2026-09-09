# Mock 运行时持久化与重置

## 1. 目标

项目继续使用状态化 Mock 数据跑通流程，但关键状态不再依赖单个 Node 进程中的数组或 Map。开发环境默认使用 Node SQLite 本地数据库，领域服务通过统一状态仓储读写；自动化测试使用 Memory 驱动保持用例隔离。

当前持久化范围包括：

- IAM 组织、人员、角色策略、版本与审计；
- 身份会话、设备会话与通知订阅；
- Agent run、Evidence Trace、Run/Trace 索引、一次性确认状态、受控记忆与工作项；
- 风险处置状态、状态化 Mock Connector 场景、审批、事件与告警；
- Key Center 策略版本、租约和审计；
- OA 元模型、世界模型草稿与模拟构建状态；
- 语义运营提案、任务、版本快照、校验结果与发布 Outbox；
- 状态化模拟场景、连接器记录、故障注入与审批；
- Agent 单次/周期任务编排、租约和检查点；
- 模型连接的非敏感运行配置。

模型 API Key 不写入 SQLite。密钥只允许由部署环境/KMS 注入，或在当前 API 进程内短暂使用。

## 2. 驱动与路径

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `RUNTIME_STORE_DRIVER` | `sqlite` | 当前应用运行时仅允许 `sqlite` 或 `memory` |
| `RUNTIME_SQLITE_PATH` | `backend/.data/runtime.db` | SQLite 文件绝对或工作目录相对路径 |
| `RUNTIME_POSTGRES_URL` | 无 | PostgreSQL 迁移 CLI 与已完成异步化模块使用；通用 Runtime Store 仍不能直接选择 PostgreSQL |
| `IDENTITY_SESSION_STORE_DRIVER` | `runtime` | `runtime` 使用当前 SQLite/Memory；`postgres` 仅迁移身份会话 |
| `IAM_STORE_DRIVER` | `runtime` | `runtime` 使用当前 SQLite/Memory；`postgres` 迁移 IAM 主数据、策略、版本和审计 |
| `RISK_PROCUREMENT_STORE_DRIVER` | `runtime` | `runtime` 使用当前 SQLite/Memory；`postgres` 迁移风险处置与采购协同聚合 |
| `ALERTING_STORE_DRIVER` | `runtime` | `runtime` 使用当前 SQLite/Memory；`postgres` 迁移告警、通知、电话、升级策略与审计链 |
| `SIMULATION_STORE_DRIVER` | `runtime` | `postgres` 时共享状态化 Mock 场景、连接器记录与故障注入 |
| `SEMANTIC_GOVERNANCE_STORE_DRIVER` | `runtime` | `postgres` 时共享语义草稿、提案、任务、快照与发布状态 |
| `AGENT_ORCHESTRATION_STORE_DRIVER` | `runtime` | `postgres` 时共享定时/周期编排、租约和最小化检查点 |

SQLite 使用 WAL、`busy_timeout` 和 schema `user_version=1`。`GET /api/health` 只公开驱动、持久化类型和 schema 版本，不公开数据库文件路径。

## 3. 初始化与重置

首次启动 API 时自动创建数据库和表；各领域第一次读取时自动写入对应种子基线。

```powershell
# 重置所有 Mock 运行时状态
npm.cmd run reset:runtime -w backend

# 只重置指定命名空间
npm.cmd run reset:runtime -w backend -- mock_simulation agent_runs agent_workflow
```

重置会删除本地运行态，下一次读取会重新初始化种子。它不会调用或修改任何真实 OA、ERP、MES、LIMS、QMS、OMS 系统。

## 4. 一次性确认一致性

Agent 确认状态通过 `BEGIN IMMEDIATE` 事务完成条件迁移：只有仍处于 `awaiting_confirmation + pending`、命令一致、身份/会话/设备一致、Token 正确且未过期的 run 才能进入 `executing`。多个 API 进程共享同一 SQLite 文件时，同一确认最多一个调用能够占用成功。

SQLite 是本地开发与单节点演示基线，不是最终生产数据库。Phase 1 PostgreSQL 实现位于 `postgres-runtime-state-repository.js`，提供 JSONB、版本号、`SELECT ... FOR UPDATE`、确定性多行锁顺序、聚合与 Outbox 同事务及失败回滚。迁移脚本为 `backend/migrations/postgres/001_runtime_state.sql`：

```powershell
$env:RUNTIME_POSTGRES_URL='postgresql://...'
npm.cmd run migrate:postgres
```

通用 `RUNTIME_STORE_DRIVER` 仍保持 SQLite/Memory；已完成异步仓储适配的领域通过独立开关灰度到 PostgreSQL。身份会话可通过 `IDENTITY_SESSION_STORE_DRIVER=postgres` 独立灰度；登录、每请求校验、注销和失效删除会进入 PostgreSQL，健康/就绪接口会公开非敏感驱动状态并探测连接。

IAM 现可通过 `IAM_STORE_DRIVER=postgres` 独立切换。API 在每个请求开始时读取一份一致性 IAM 快照，访问控制、角色目录、身份映射和权限管理在同一请求内复用该快照；成功写入后会刷新当前请求快照。人员、组织、角色策略、审计、Schema 迁移和权限变更 Outbox 使用同一 PostgreSQL Repository，乐观锁冲突不会产生事件，事件契约失败会整体回滚。“最后一个管理层账号”约束已下沉到持有数据库行锁的聚合事务内，避免两个节点并发移除时绕过服务层预检查。生产启用 IAM PostgreSQL 时必须同时启用 `DOMAIN_EVENT_STORE_DRIVER=postgres`，并使用同一数据库。JSONB 状态表仍是迁移桥梁；最终还要按领域拆分 tenant key、外键、索引、RLS、数据保留和归档策略。

风险与采购现可通过 `RISK_PROCUREMENT_STORE_DRIVER=postgres` 共享。风险确认/审批、采购发起/审批都使用数据库行锁串行化，聚合状态和领域事件 Outbox 在同一事务提交；重复请求返回当前结果但不重复发布事件。生产启用该开关时必须同时设置 `DOMAIN_EVENT_STORE_DRIVER=postgres`。风险看板和通知仍会组合未迁移的模拟运行/告警数据，因此该开关解决的是风险与采购事实源一致性，不代表整个平台已可无条件水平扩展。

`DOMAIN_EVENT_STORE_DRIVER=postgres` 现在同时接管 API 管理面与 Worker 执行面：事件列表、Outbox 指标、消费者投影和死信重放都读写 Worker 使用的同一 PostgreSQL，就绪探针会真实检查该连接。`ALERTING_STORE_DRIVER=postgres` 让告警与领域 Outbox 同事务提交；`SEMANTIC_GOVERNANCE_STORE_DRIVER=postgres` 让语义草稿、提案、任务、版本快照与发布 Outbox 使用同一共享事实源，生产启用时必须同步启用 PostgreSQL Domain Event Store。`SIMULATION_STORE_DRIVER=postgres` 支持多个 API 实例共享 Mock 连接器状态；`AGENT_ORCHESTRATION_STORE_DRIVER=postgres` 支持编排 Worker 使用数据库行锁领取到期任务。外部 ERP/WMS/QMS、真实图数据库和模型训练基础设施仍属于部署集成，不因这些开关自动具备。

## 5. 验证

```powershell
npm.cmd run test:persistence
npm.cmd run test:all
```

持久化测试覆盖：PostgreSQL schema 校验、JSONB/版本、原子多行变更与回滚、异步身份会话、IAM 请求快照、写后可见、并发最后管理账号约束、风险/采购并发幂等迁移及聚合-Outbox 原子性；以及 SQLite 跨进程写入/读取、命名空间重置、两个进程并发竞争同一个 Agent 确认、Evidence Trace 事件/Run 索引/哈希完整性跨进程恢复和 API 重启后原身份会话继续有效。

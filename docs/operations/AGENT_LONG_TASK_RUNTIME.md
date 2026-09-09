# 元域智脑长任务运行时 v0.1

## 目标

桌面操作不再在用户确认接口内直接派发。用户确认只消费一次性确认凭据并创建持久化队列记录；当前设备的 Worker 之后独立领取任务。这样，排队、暂停、恢复、取消和超时均由服务端状态机决定，页面刷新或桌面应用重启不会把任务状态重置。

## 状态机

```text
awaiting_confirmation
  -> queued
     -> paused -> queued
     -> cancelled
     -> timed_out
     -> running -> succeeded / failed / timed_out
```

- `queued`：已确认，尚未向电脑派发；可以暂停或取消。
- `paused`：保留剩余排队时间，最多暂停 30 分钟；可以恢复或取消。
- `running`：Worker 已领取或端侧派发已发出。为避免“本地动作可能已经执行但服务端误判”的重复操作，此时不能取消，也不会自动重试。
- `timed_out`：排队截止时间、暂停上限或 Worker 租约已过期；服务端失败关闭。
- `succeeded/failed/cancelled`：终态。

## 身份与并发边界

每个任务绑定 `tenant + subject + session + device + original role + run + command`。列表、控制和 Worker 领取均重新校验这些字段；其他设备即使属于同一用户，也不能领取或修改当前设备的任务。领取使用 Repository 原子变更，同一任务只能有一个 Worker 从 `queued` 进入 `running`。

## 超时策略

- 默认总排队时限：10 分钟，可用 `AGENT_LONG_TASK_TIMEOUT_MS` 在 1–60 分钟内调整。
- 默认 Worker 租约：3 分钟，可用 `AGENT_LONG_TASK_LEASE_MS` 在 30 秒–10 分钟内调整。
- 暂停最长 30 分钟，恢复后继续使用暂停前剩余时限。
- Worker 租约过期后不自动重新执行端侧动作，防止重复创建文件或重复导航。

## 独立维护 Worker

`services/agent-runtime-worker/app.js` 是独立 Node 进程，默认每 5 秒写入心跳并尝试续租单活 Sweeper。多个实例可以同时部署，但只有持有 SQLite/PostgreSQL 原子租约的实例执行超时回收；Leader 失联后，Standby 在租约到期时自动接管。

```powershell
npm run dev:agent-runtime-worker
npm run run:agent-runtime-worker
```

运维投影提供活动队列深度、排队/暂停/运行数量、最老等待时间、最近一小时失败与超时数量、活动 Worker 实例数、Leader 和租约到期时间。存在活动任务但没有健康 Leader，或最近一小时出现超时，会生成 P1 运维提示。

### PostgreSQL 任务平面

`002_agent_runtime.sql` 提供规范化任务表、活动 Run 唯一约束、端点与到期索引、Worker 心跳、单活租约和 Agent Run 状态迁移 Outbox；`003_agent_run_transition_delivery.sql` 增加状态迁移事件的领取租约与幂等确认。API 任务生产、列表、暂停/恢复/取消、桌面领取、派发和回执，以及维护 Worker 均通过同一个可切换端口访问任务平面。

```powershell
npm.cmd run migrate:postgres
$env:AGENT_RUNTIME_TASK_STORE_DRIVER='postgres'
$env:AGENT_RUN_STORE_DRIVER='postgres'
$env:DOMAIN_EVENT_STORE_DRIVER='postgres'
$env:EVIDENCE_TRACE_STORE_DRIVER='postgres'
$env:AGENT_CONVERSATION_STORE_DRIVER='postgres'
$env:AGENT_LEARNING_STORE_DRIVER='postgres'
$env:IAM_STORE_DRIVER='postgres'
$env:RISK_PROCUREMENT_STORE_DRIVER='postgres'
$env:ALERTING_STORE_DRIVER='postgres'
$env:RUNTIME_POSTGRES_URL='postgresql://user:password@db.example.internal/agent?sslmode=verify-full'
npm.cmd run start
npm.cmd run dev:agent-runtime-worker
npm.cmd run dev:agent-run-transition-worker
npm.cmd run dev:event-worker
```

API 和三个 Worker 必须指向同一个 PostgreSQL 集群。启动会校验 migration 3，模式缺失时直接退出，不能回退 SQLite 冒充 PostgreSQL。`/api/health/ready` 同时探测长任务仓储与 Agent Run 仓储，并返回实际 driver、persistence 和 schemaVersion。

Agent Run 主记录现在可通过 `AGENT_RUN_STORE_DRIVER=postgres` 灰度到 PostgreSQL。创建、主体隔离查询、确认过期、一次性确认消费、取消、执行中止、端侧派发/回执和成功/失败落账均经过异步存储端口；确认消费使用数据库行锁，成功/失败与对应领域事件 Outbox 在同一事务提交。`DOMAIN_EVENT_STORE_DRIVER=postgres` 使独立事件 Worker 消费同一 Outbox，避免 API 与 Worker 各读一份本地状态。详细设计与切流检查见 [Agent Run PostgreSQL 执行控制面](AGENT_RUN_POSTGRES_RUNTIME.md)。

Evidence Trace 也可通过 `EVIDENCE_TRACE_STORE_DRIVER=postgres` 使用共享存储，保持跨 API 节点的事件顺序、Run 索引和哈希完整性。Agent Run PostgreSQL 模式同时承载用户明确固定的长期目标记忆，提供去重、过期清理、主体隔离和撤销。活动对话窗口与压缩摘要可通过 `AGENT_CONVERSATION_STORE_DRIVER=postgres` 共享，任务创建和归档使用主体索引事务控制活动槽位。学习授权和最小化成功信号可通过 `AGENT_LEARNING_STORE_DRIVER=postgres` 共享，授权撤回和信号清理同事务提交。IAM 主数据与访问控制可通过 `IAM_STORE_DRIVER=postgres` 共享，风险处置与采购协同可通过 `RISK_PROCUREMENT_STORE_DRIVER=postgres` 共享，告警编排可通过 `ALERTING_STORE_DRIVER=postgres` 共享，并均与 Outbox 原子提交。当前仍不等于整个平台已经多节点化：模拟运行和治理等剩余聚合继续使用通用 Runtime Repository；当 `RUNTIME_STORE_DRIVER=sqlite` 时，生产配置仍强制 `SINGLE_NODE_DEPLOYMENT=true`。这些剩余状态迁移、消费者探针和故障演练完成后，才能解除整个平台的单节点限制。

## 接口

- `GET /api/agent/runtime-tasks`：当前会话和设备的任务列表。
- `POST /api/agent/runtime-tasks/{id}/pause`：暂停排队任务。
- `POST /api/agent/runtime-tasks/{id}/resume`：恢复暂停任务。
- `POST /api/agent/runtime-tasks/{id}/cancel`：在派发前取消。
- `POST /api/agent/runtime-tasks/{id}/claim`：可信桌面 Worker 原子领取并获取短时端侧派发。

任务确认、入队、领取、端侧派发和执行回执继续进入同一个 Evidence Trace。队列不改变原权限、确认、Endpoint Runtime 和端侧工具白名单边界。

# Agent Run PostgreSQL 执行控制面 v0.1

## 1. 建设目的

Agent Run 是一次智脑任务的权威执行记录。它保存发起主体、原始角色、会话与设备、待确认命令、一次性确认状态、端侧派发和最终回执。该记录如果只存在 API 进程的本地 SQLite 中，不同节点可能各自接受一次确认或看见不同执行状态。因此本阶段将 Agent Run 与长任务队列、状态迁移和领域事件放到同一个 PostgreSQL 数据边界。

## 2. 已覆盖范围

- 创建 Agent Run，并按 `tenant + subject` 隔离列表和来源查询。
- 待确认任务过期、用户主动取消和执行前中止。
- 绑定 `role + tenant + subject + session + device + command` 的一次性确认消费。
- 桌面任务派发、派发标识校验、超时拒绝和执行回执。
- 服务端工具执行成功或失败的权威落账。
- 执行结果与 `agent.tool_execution.succeeded/failed` 领域事件 Outbox 同事务提交。
- 用户明确固定的长期目标记忆共享存储、去重、90 天过期清理、主体隔离和随时撤销。
- 独立事件 Worker 的领取租约、失败重试、死信和幂等消费检查点。
- API 就绪探针对 Agent Run PostgreSQL 连接进行真实探测。

## 3. 一致性模型

```text
用户确认
   ↓
Agent Run 行锁（SELECT ... FOR UPDATE）
   ├─ 校验原角色、主体、会话、设备、命令和 Token Hash
   ├─ pending → consumed / executing
   └─ 同一事务提交

工具完成
   ↓
同一数据库事务
   ├─ Agent Run → executed / execution_failed
   └─ Domain Event Outbox → pending
             ↓
独立 Event Worker → Broker → 幂等 Checkpoint
```

数据库事务是并发边界。两个 API 节点同时提交相同确认时，后到事务在取得行锁后会看到确认已经消费并失败关闭。确认 Token 只保存哈希，不能从数据库记录恢复明文。

## 4. 启动配置

先执行数据库 migration，再让 API 和 Worker 使用同一个连接地址：

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
$env:AGENT_RUN_TRANSITION_CONSUMER_ENABLED='true'
$env:RUNTIME_POSTGRES_URL='postgresql://user:password@db.example.internal/agent?sslmode=verify-full'

npm.cmd run start
npm.cmd run dev:agent-runtime-worker
npm.cmd run dev:agent-run-transition-worker
npm.cmd run dev:event-worker
```

生产连接必须使用 `sslmode=require`、`verify-ca` 或 `verify-full`。任何一个 PostgreSQL 开关缺少有效连接、Schema 版本不匹配或连接探测失败时，进程必须退出或就绪探针返回失败，不允许静默回退到 SQLite。

API 的 Outbox 列表、指标、消费者投影和死信重放也由 `DOMAIN_EVENT_STORE_DRIVER` 选择数据源。开启 PostgreSQL 后，运维管理端与 Event Worker 不再分别读取 SQLite 和 PostgreSQL。

## 5. 灰度与回滚

1. 在独立测试库执行 migration 1–3，验证备份、恢复和连接池容量。
2. 先停止写入或进入维护窗口，避免 SQLite 与 PostgreSQL 双写分叉。
3. 启动 Event Worker、transition worker 和维护 worker，再启动 API。
4. 检查 `/api/health/ready` 中 `domainEventStore`、`iamStore`、`riskProcurementStore`、`alertingStore`、`agentLongTaskStore` 与 `agentRunStore` 均为 `postgres / ready`。
5. 用同一确认 Token 并发提交两次，验收只能一次成功；再验证取消、超时、端侧迟到回执和 Worker 重启。
6. 核对 Agent Run 终态、长任务终态、Outbox 发布状态和 Broker 投影一致。

当前版本没有提供 SQLite Agent Run 的自动搬迁脚本，因此灰度库只适用于新建测试任务。需要保留历史 Run 时，必须先提供带校验和、数量对账和可重放记录的迁移程序。回滚只能在确认 PostgreSQL 不再接受新写入后进行；不得让两个存储同时成为权威源。

## 6. 生产边界

本能力不能单独解除整个平台的单节点限制。以下状态仍在通用 Runtime Repository 中：

- 模拟运行、治理和其他领域聚合；
- 仍由同步 Outbox 写入的非 Agent Run 领域事件。

当 `RUNTIME_STORE_DRIVER=sqlite` 时，配置校验仍要求 `SINGLE_NODE_DEPLOYMENT=true`。完整多节点上线还需要迁移上述状态、建立分布式缓存失效和撤销机制、补齐 Event Worker 活性探针，并完成数据库故障、Worker 接管、重复投递和跨节点并发演练。

## 7. 验收证据

- migration 版本、数据库 TLS 和最小权限账号检查记录；
- 一次性确认、主体隔离、成功/失败事务 Outbox 自动化测试；
- API 与三个 Worker 指向同一数据库的配置清单；
- 就绪探针、队列指标、死信和 Broker 投影截图或采样记录；
- 故障演练、数据对账、回滚演练和遗留风险清单。

# 智脑执行证据追踪

## 1. 目标

智脑的每次任务和每次受控执行都必须能够回答：谁在什么身份、租户、会话和设备下发起；读取了哪些证据；通过了哪些安全与权限判断；调用了哪些只读或写入工具；是否经过本人确认；最终产生了哪个业务草稿、审批路由或失败结果。

本能力记录结构化业务决策依据，不记录也不展示模型内部思维链。密码、API Key、Cookie、Authorization、确认 Token 和真实密钥材料会在写入证据追踪前被字段级剔除。

## 2. 追踪范围

下列路径均生成证据事件：

- 请求接收、附件接入与文件安全预检；
- 用户输入提示词安全检查；
- 意图路由、范围澄清与默认拒绝；
- 企业知识、语义上下文和接入系统检索；
- 外部上下文的间接提示词注入检查与隔离；
- 每个专业能力只读工具的开始、成功或拒绝；
- 模型调用开始、完成、安全替换或因风险跳过；
- 证据汇总、计划生成、业务决策与语义决策记录；
- Agent run 持久化和待确认命令签发；
- 每次确认尝试、拒绝、接受和一次性凭据消费；
- 执行前业务权限与核心对象状态复核；
- 写入工具开始、成功、失败、业务主键和审批路由；
- 任务完成、只读降级、拒绝或执行失败。

没有命中业务范围、提示词被拒绝或附件不合规的请求也会生成独立 Trace，但不会读取业务系统。没有执行权限、原任务不可见或原角色被撤销的 `/agent/execute` 请求会生成独立的拒绝执行 Trace，且只保存被引用 Run 的指纹，不泄露他人的 Run ID。

Evidence Trace 上线前已经存在的 Run 会在首次读取时生成 `legacy_run_backfill` 迁移追踪，只导入原 Run 中真实保存的计划、证据、状态和执行回执，并明确标注迁移时间及原始 Run 时间；系统不会为旧 Run 伪造当时并不存在的模型、检索或工具细粒度事件。运营指标同时返回原生 Trace 和回填 Trace 数量。

## 3. 数据模型

Trace 使用独立命名空间 `agent_evidence_traces` 持久化；Run 通过 `evidenceTraceId` 与 Trace 关联，并在 `agent_evidence_trace_run_index` 中建立索引。

Trace 公开字段包括：

- `id`、`runId`、`requestId`、`kind`；
- `roleId`、`subjectFingerprint`、`platform`、`domain`；
- `inputFingerprint` 与 `inputLength`，不依赖保存原始攻击内容；
- `status`、`createdAt`、`updatedAt`、`completedAt`；
- `eventCount`、`headHash`、`manifestHash`、`events`；
- `integrity.valid`、校验事件数、算法和失败原因。

每个 Event 包括：

- 全局事件 ID、Trace ID 和从 1 开始的 `sequence`；
- `type`、`stage`、`status`、责任主体和摘要；
- 已脱敏的结构化 `details`；
- 证据快照数组；
- `createdAt`、`previousHash` 与 `hash`。

证据快照至少包括 `source`、业务记录 `id`、`title`、内容摘要 `statement`、`classification`、`systemId`、`version`、`capturedAt`、`organizationId` 和 `contentHash`。当前响应不再只返回来源和 ID，也不会在智脑客户端截断为前 6 条。

## 4. 完整性

事件采用按序 SHA-256 哈希链：当前事件哈希覆盖事件内容与前序哈希。Trace Manifest 另行覆盖 Trace ID、Run ID、角色、租户、主体指纹、状态、事件数、头哈希和时间字段。读取时会重新计算事件链与 Manifest；任何事件内容、顺序、前序哈希或 Trace 元数据变化都会使 `integrity.valid=false`。

该机制能在 SQLite 或 PostgreSQL 运行态中检测误改和普通篡改，但不等同于生产级不可篡改存储。生产环境应将相同事件契约写入只追加审计仓，并使用企业 KMS/HSM 对批次头签名，结合 WORM/Object Lock、可信时间戳、Outbox、异地归档和审计保留策略。

## 5. API

- `POST /api/agent/message`：响应新增 `traceId` 和完整 `evidenceTrace`；旧字段保持兼容。
- `POST /api/agent/execute`：成功、确认失败和授权拒绝响应均可携带 `traceId`、`evidenceTrace`。
- `GET /api/agent/traces?limit=20`：列出当前有效角色集合与当前 `tenant + subject` 交集内的追踪。
- `GET /api/agent/traces/{traceId}`：读取单条完整追踪；跨租户、跨主体或无有效角色返回 404。
- `GET /api/agent/runs`：每条 Run 增量携带 `evidenceTrace`，旧 Run 没有 Trace 时保持 `null`。
- `GET /api/agent/operations`：`telemetry.auditCoverage` 由真实 Run/Trace 覆盖计算，`telemetry.evidenceTrace` 返回总数、校验通过数、Run 覆盖数与完整性比例。

## 6. 多端展示

移动端、桌面 Web 与 Electron 共用 `@healthcare-ai/agent-workbench`：

- 展示全部业务证据，不再截断为 6 条；
- 展示证据摘要、版本、密级、采集时间和内容哈希；
- 展示 Trace ID、状态、事件数量和完整性校验；
- 时间线展示每个事件、时间、阶段、结果、证据引用、当前哈希与前序哈希；
- 可展开查看经过脱敏的事件字段；
- 执行被拒绝时也插入系统消息并显示对应拒绝 Trace。

管理 Web 的“智脑运营 → 任务运行与完整证据链”展示历史 Run 的业务证据、执行计划、事件时间线、事件字段、执行状态和业务记录主键。

## 7. 访问与保留

Trace 与 Run 使用同一安全边界：只允许当前有效角色集合内、同一 `tenant + subject` 的主体访问。执行确认继续额外绑定原始角色、`session + device`、原命令和一次性 Token。角色撤销后，相应 Run 与 Trace 会立即退出当前主体的有效可见集。

Demo 最多保留 500 条 Trace、单条最多 160 个事件、单事件最多 120 个证据快照；运行态默认存入本地 SQLite，也可用 `EVIDENCE_TRACE_STORE_DRIVER=postgres` 独立灰度到共享 PostgreSQL。PostgreSQL 模式通过同一 Trace 的异步变更队列与数据库行锁串行追加事件，Run 索引和 Trace 绑定在同一事务提交；API 就绪探针会报告实际 driver 并探测连接。生产连接必须启用 PostgreSQL TLS，API 节点必须使用同一个数据库，且禁止无提示回退本地存储。

```powershell
$env:EVIDENCE_TRACE_STORE_DRIVER='postgres'
$env:RUNTIME_POSTGRES_URL='postgresql://user:password@db.example.internal/agent?sslmode=verify-full'
```

当前未提供 SQLite Trace 历史数据的自动搬迁，切流时应停止写入并完成数量、Run 索引、事件数、头哈希和 Manifest 哈希对账。生产环境还必须按法规和数据分类设计冷热分层、法务保全、删除例外、租户密钥和长期归档，不能直接沿用 Demo 上限。

## 8. 验证

运行：

```powershell
npm.cmd run test:evidence
npm.cmd run test:all
```

专项回归覆盖只读任务完整时间线、确认失败后成功执行、提示词拒绝不保存攻击原文、租户/主体/角色隔离、事件与 Manifest 篡改检测、无权限执行的独立拒绝 Trace，以及旧 Run 的显式迁移追踪。持久化回归另覆盖 PostgreSQL 并发追加顺序、Run 索引绑定、哈希链完整性和跨主体不可见。

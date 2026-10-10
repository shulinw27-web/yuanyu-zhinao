# 证据与审计模块说明

本页集中维护需求、架构、接口和开发约束；“当前”与“目标”沿用原说明，不因合并改变完成状态。

## 需求与验收

### 目标

保证每次 Agent 请求、授权、检索、模型调用、计划、确认、工具执行和回执均有完整、可验证、可按权限检索的证据链。

### 需求与验收

- 每个任务，包括拒绝、范围澄清和权限拒绝，都创建唯一 trace。
- 事件按顺序记录时间、类型、状态、来源引用、输入/输出摘要和 correlation ID。
- 事件使用前序哈希链，manifest 保护 run/角色/租户/主体指纹、状态和头哈希。
- 读取时实时校验，篡改返回明确 integrity 状态。
- 原始攻击内容、密钥、Token、私钥和内部系统提示词不得进入审计正文。
- trace 按 `tenant + subject + 当前有效角色` 隔离；管理员访问也需独立审计权限。
- 关键业务执行保留 authoritative receipt，而不是相信模型“已执行”声明。

### 非功能要求

生产审计需要追加写、WORM/对象锁、外部时间戳/签名锚定、SIEM 导出、保留策略、Legal Hold 和按分类擦除流程。

## 架构与实现

### 当前代码

`agent-evidence-trace-service.js` 管理 Trace 与哈希链，`agent-security-audit-service.js` 管理安全遥测；状态通过 `runtime-state-repository.js` 持久化。Agent 运行时在各阶段显式写事件。

### 数据所有权

本模块拥有 Trace、TraceEvent、TraceManifest、SecurityAuditEvent、ExecutionReceiptReference。它只保存证据快照和业务引用，不成为风险、采购或 IAM 的事实主库。

### 目标设计

```text
领域模块 → Audit Port → 脱敏/规范化 → Append-only Store
                         → Hash Chain → Daily Merkle/Signature Anchor
读取者 → IAM/Data Scope → Query Projection → Integrity Verify
```

目标结构分为 event ingestion、redaction policy、integrity service、query/export 和 WORM adapter。业务事务通过 Outbox 发布审计事件，避免业务成功但审计丢失。

### 边界

- hash 只证明本存储内的顺序和内容一致性；没有外部锚定前不能宣称不可抵赖。
- 审计失败对高风险写操作应 fail-closed；低风险只读可按策略降级并告警。
- details 使用 allowlist Schema，不接受任意对象或原始 prompt。

## 接口契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agent/traces?limit=20` | 当前主体可见 Trace 列表 |
| GET | `/api/agent/traces/:id` | 完整事件、manifest、integrity |

响应核心字段：`id`、`runId`、`status`、`events[]`、`manifest`、`integrity`、`createdAt`、`completedAt`。事件至少含 `sequence`、`type`、`status`、`occurredAt`、`previousHash`、`hash` 和脱敏 details。

常见事件：`input.received`、`input.safety_checked`、`authorization.evaluated`、`evidence.retrieved`、`tool.read_completed`、`model.completed|skipped`、`plan.created`、`confirmation.requested|rejected|accepted`、`tool.write_completed`、`receipt.recorded`。

### 目标接口

- `GET /api/audit/traces`：管理员按时间/类型/组织筛选，需独立权限；
- `POST /api/audit/exports`：异步生成签名审计包；
- `GET /api/audit/anchors/:date`：外部锚定证明；
- 事件写入采用内部 port，不向普通客户端开放任意 append API。

错误码：`EVIDENCE_TRACE_NOT_FOUND`、`TRACE_INTEGRITY_FAILED`、`AUDIT_EXPORT_FORBIDDEN`。

## 开发约束与验证

重点文件：`domains/agent/public-api.js`、`routes/evidence-routes.js`、`agent-evidence-trace-service.js`、`agent-security-audit-service.js`、`agent-runtime-store.js` 和 `backend/test/evidence-trace.test.js`。

不可破坏：事件序号单调、previous hash 正确、manifest 与 tenant/subject/role 绑定、读取实时校验、拒绝事件不保存攻击原文、跨主体不可见。不要把哈希链描述为外部不可抵赖，除非已实现 WORM/外部锚定。

验证：

```powershell
npm.cmd run test:evidence
npm.cmd run test:security
npm.cmd run test:persistence
```

新增 Agent 阶段或业务写工具时，必须增加对应 evidence event 和成功/失败测试。

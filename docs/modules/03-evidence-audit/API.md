# 证据与审计 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agent/traces?limit=20` | 当前主体可见 Trace 列表 |
| GET | `/api/agent/traces/:id` | 完整事件、manifest、integrity |

响应核心字段：`id`、`runId`、`status`、`events[]`、`manifest`、`integrity`、`createdAt`、`completedAt`。事件至少含 `sequence`、`type`、`status`、`occurredAt`、`previousHash`、`hash` 和脱敏 details。

常见事件：`input.received`、`input.safety_checked`、`authorization.evaluated`、`evidence.retrieved`、`tool.read_completed`、`model.completed|skipped`、`plan.created`、`confirmation.requested|rejected|accepted`、`tool.write_completed`、`receipt.recorded`。

## 目标接口

- `GET /api/audit/traces`：管理员按时间/类型/组织筛选，需独立权限；
- `POST /api/audit/exports`：异步生成签名审计包；
- `GET /api/audit/anchors/:date`：外部锚定证明；
- 事件写入采用内部 port，不向普通客户端开放任意 append API。

错误码：`EVIDENCE_TRACE_NOT_FOUND`、`TRACE_INTEGRITY_FAILED`、`AUDIT_EXPORT_FORBIDDEN`。

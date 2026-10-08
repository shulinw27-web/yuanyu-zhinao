# 系统接入与模拟 API

| 方法 | 路径 | 权限/说明 |
| --- | --- | --- |
| GET | `/api/systems` | 接入系统目录 |
| GET | `/api/system-data/overview` | 配置页面、按角色裁剪 |
| GET | `/api/system-data/:id/records?limit=100` | 系统记录；目标增加 cursor 和组织过滤 |
| GET | `/api/simulation/overview` | Mock 场景/运行/审批/故障概览 |
| POST | `/api/simulation/scenarios/:id/run` | `simulation.run` |
| POST | `/api/simulation/approvals/:id/decision` | `simulation.approval.decide`；body `{decision}` |
| POST | `/api/simulation/connectors/:id/fault` | `simulation.fault.manage`；body `{faultId}` |
| POST | `/api/simulation/reset` | `simulation.reset` |
| GET | `/api/agent/connectors` | Agent 可用 MCP Connector 目录 |
| GET | `/api/semantic-operations/workflows` | 流程目录、具体业务类别、跨系统统计、实时/定时/手动同步策略与同步记录；`page.semantic-operations.view` |
| GET | `/api/semantic-operations/workflows/:code` | 最新定义/候选、流程类别、参与系统、跨系统交接、版本历史、确定性流程图、字段映射和运行实例 |
| POST | `/api/semantic-operations/workflows/sync` | `meta_model.draft.save`；人工立即同步，Mock body `{scenario: baseline|changed}`，已配置真实连接器 body `{mode: configured}`；连接器支持有界定义/实例游标分页，发现候选但不自动发布 |
| POST | `/api/semantic-operations/workflows/:code/versions/:version/review` | `meta_model.publish`；body `{action: publish|reject}` |
| POST | `/api/integrations/workflows/webhooks/:providerId` | 公开但必须 HMAC 验签；只把变更通知按部署绑定租户入队，不采信正文业务事实 |
| POST | `/api/semantic-operations/workflows/events/:eventId/replay` | `event.outbox.replay`；只允许当前租户死信重新入队 |
| GET | `/api/agent/workflow-context?query=...` | `page.agent.view`；只读取已发布版本、流程类别、跨系统链路、授权内实例和有界流转记录；旧版本在途实例按自身版本解释，不执行审批 |

目标 Connector 内部契约：`query(request, authContext, lease)`、`execute(command, authContext, lease, idempotencyKey)`、`health()`。统一错误码：`CONNECTOR_UNAVAILABLE`、`CONNECTOR_TIMEOUT`、`DATA_SCOPE_DENIED`、`SIMULATION_PERMISSION_DENIED`、`APPROVAL_NOT_FOUND`。

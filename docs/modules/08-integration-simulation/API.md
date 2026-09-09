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

目标 Connector 内部契约：`query(request, authContext, lease)`、`execute(command, authContext, lease, idempotencyKey)`、`health()`。统一错误码：`CONNECTOR_UNAVAILABLE`、`CONNECTOR_TIMEOUT`、`DATA_SCOPE_DENIED`、`SIMULATION_PERMISSION_DENIED`、`APPROVAL_NOT_FOUND`。

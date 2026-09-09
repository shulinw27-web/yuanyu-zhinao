# 全局 API 归属目录

本文件只做路由归属和导航，字段级契约以各模块 `API.md` 为准。每个端点必须只有一个 owner；组合根负责注册，不拥有业务接口。

| 路径前缀/端点 | Owner 模块 | 详细文档 |
| --- | --- | --- |
| `/api/auth/*`、`/api/oa/connection`、`/api/session/*` | 身份与访问 | [API](01-identity-access/API.md) |
| `/api/account-center`、`/api/access/me`、`/api/permission-*`、`/api/roles`、`/api/modules` | 身份与访问 | [API](01-identity-access/API.md) |
| `/api/agent/runtime|operations|evaluations|tools|skills|authorization` | Agent 运行时 | [API](02-agent-runtime/API.md) |
| `/api/agent/conversations*`、`/api/agent/message`、`/api/agent/execute`、`/api/agent/runs`、`/api/agent/work-items` | Agent 运行时 | [API](02-agent-runtime/API.md) |
| `/api/assistant/message`、`/api/assistant/execute` | Agent 运行时 | 旧兼容接口，迁移至 Agent 契约 |
| `/api/agent/traces*` | 证据与审计 | [API](03-evidence-audit/API.md) |
| `/api/alerting/*`、`/api/notifications*` | 告警与值班 | [API](04-alerting-oncall/API.md) |
| `/api/dashboard`、`/api/risk-cases*`、`/api/authorization/explain` | 风险运营 | [API](05-risk-operations/API.md) |
| `/api/procurement/*` | 采购协同 | [API](06-procurement-workflow/API.md) |
| `/api/meta-objects`、`/api/meta-models*`、`/api/world-model*`、`/api/semantic-context`、`/api/agent/knowledge` | 模型与语义治理 | [API](07-model-semantic-governance/API.md) |
| `/api/systems`、`/api/system-data*`、`/api/simulation*`、`/api/agent/connectors` | 接入与模拟 | [API](08-integration-simulation/API.md) |
| `/api/key-center/*` | 密钥与凭据 | [API](09-key-credential/API.md) |
| `/api/health`、`/api/platform-status`、`/api/configurations`、`/api/domain-events/outbox` | 平台运行基础 | [API](11-runtime-platform/API.md) |

多端客户端不拥有后端路由，统一消费上述契约；SDK 规则见 [多端客户端 API](10-client-platform/API.md)。

## 已清理的历史入口

未被真实启动链路引用的 `backend/src/routes/api.js` 已删除。当前唯一 HTTP 组合根是 `backend/src/app.js`，业务路由分别由 `backend/src/routes/*-routes.js` 拥有。

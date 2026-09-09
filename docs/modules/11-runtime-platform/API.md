# 平台运行基础 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | Public；服务、时间、runtime store driver/schema |
| GET | `/api/health/live` | Public；仅反映 API 进程存活，不探测外部依赖 |
| GET | `/api/health/ready` | Public；检查 Runtime Store 与 Outbox，供容器就绪探针使用 |
| GET | `/api/system/capabilities` | `page.config.view`；返回非敏感功能能力与 Demo 约束 |
| GET | `/api/platform-status` | 受页面权限保护的平台状态投影 |
| GET | `/api/configurations` | `page.config.view`；不得包含 secret |
| GET | `/api/domain-events/outbox` | `page.config.view` + `event.outbox.view`；仅返回当前租户事件，支持 status/limit |
| GET | `/api/domain-events/contracts` | `page.config.view` + `event.outbox.view`；返回事件 type/version、聚合类型和必填载荷字段 |
| POST | `/api/domain-events/outbox/{id}/replay` | `event.outbox.replay`；仅允许重放当前租户的 dead_letter 事件，记录操作者、原因与次数 |

通用响应头应包含 `x-request-id`；限流返回 429 与 `Retry-After`；请求体超限返回 413。CORS 只回显 allowlist origin。

后续目标：`/metrics` 仅面向内部网络与服务身份；生产就绪探针继续增加 PostgreSQL、Broker 与 KMS 的强依赖检查。死信数量只把 Outbox 标记为 degraded，不直接让实例退出就绪状态，避免通过重启掩盖业务投递故障。

配置 API 只返回业务可公开配置，环境变量、连接串和密钥状态由内部管理面提供脱敏摘要。

领域事件字段、认领/确认/重试状态机和生产 Worker 边界见 [DOMAIN_EVENT_OUTBOX.md](DOMAIN_EVENT_OUTBOX.md)。浏览器不开放 claim/ack；死信重放是独立高风险按钮权限，服务端仍校验租户和事件状态。

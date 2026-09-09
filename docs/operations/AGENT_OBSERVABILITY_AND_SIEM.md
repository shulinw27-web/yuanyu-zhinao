# 智脑可观测性与 SIEM 接入

## Prometheus 指标

API 提供标准文本端点 `GET /metrics`。指标只使用固定状态标签，不包含 tenant、subject、device、run、command 等高基数字段：

- `zhinao_agent_long_tasks{status=...}`：长任务状态数量；
- `zhinao_agent_long_task_queue_depth`：活动队列深度；
- `zhinao_agent_long_task_oldest_queued_seconds`：最老排队时间；
- `zhinao_agent_long_task_worker_active_instances` 与 `worker_leader_healthy`：Worker 集群状态；
- `zhinao_agent_run_transition_consumer_active_instances` 与 `consumer_healthy`：PostgreSQL 超时状态回写消费者；
- `zhinao_agent_long_task_timeouts_last_hour` 与 `failures_last_hour`：近期失败；
- `zhinao_siem_outbox_events{status=...}`、`oldest_pending_seconds`、`failed_attempts_total`：安全事件出口积压。

开发环境未配置令牌时只允许本机回环地址访问。生产环境必须配置长度至少 32 个字符的 `OBSERVABILITY_METRICS_TOKEN`，采集器使用 `Authorization: Bearer <token>`；缺少或过短时端点返回 503，错误令牌返回 401。指标端点不接受浏览器身份 Header，也不以 CORS 作为鉴权手段。

## SIEM Outbox

提示词或多模态安全门拒绝请求时，安全审计服务会同步写入持久化 Outbox。出口采用接近 ECS 的结构：事件类型、动作、结果、严重度、组件、主体指纹、角色、风险技术、内容指纹和数据处理声明。以下内容不会进入出口：用户原文、附件内容、租户原始标识、账号、会话、设备和凭据。

一次性执行：

```powershell
$env:SIEM_EXPORT_URL='https://siem.example.internal/ingest/zhinao'
$env:SIEM_EXPORT_TOKEN='<secret from workload secret store>'
npm.cmd run run:siem-export-worker
```

Worker 以 `application/x-ndjson` 批量发送，支持 Bearer Token 和 `SIEM_EXPORT_HMAC_SECRET` 的 SHA-256 HMAC 签名。生产强制 HTTPS，并要求至少配置一种凭据。批次领取带 Worker 租约；失败后指数退避，其他实例只能在租约过期后接管。成功回执记录 export id，避免把“HTTP 请求发出”误标为“SIEM 已接收”。未配置 URL 时只报告 `not_configured`，不会丢弃 Outbox。

推荐告警：队列有活动任务但 Leader 不健康；一小时内任务超时大于 0；SIEM 最老待发送事件超过 300 秒；SIEM failed attempts 持续增长。生产部署还需把 Worker 交给 systemd、Windows Service 或 Kubernetes 管理，并将凭据放在 Vault/KMS，不写入仓库或桌面端。

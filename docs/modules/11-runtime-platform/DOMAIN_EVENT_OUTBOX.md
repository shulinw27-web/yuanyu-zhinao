# 领域事件 Outbox 契约

## 1. 目标

`backend/src/domains/events/domain-event-outbox.js` 为模块化单体提供持久化领域事件出口。业务聚合变更和 Outbox 记录通过 `runtime-state-repository.mutateStates` 在同一 SQLite 事务提交，避免“业务成功但事件丢失”。Memory 驱动用于隔离测试，生产数据库应以同样方式在一个数据库事务写业务表和 outbox 表。

告警模块原有 `outbox` 是通知、电话等“送达任务队列”；本模块是跨领域的“事实事件队列”，二者职责不同。事件消费者可以把 `risk.case.acknowledged` 转换成告警、证据、搜索投影或外部消息，但不能反向修改事件事实。

## 2. 事件信封

```json
{
  "eventId": "uuid",
  "type": "risk.case.acknowledged",
  "version": 1,
  "tenantId": "demo-enterprise",
  "organizationId": "org-quality-dept",
  "aggregateType": "RiskCase",
  "aggregateId": "RC-2026-0042",
  "correlationId": null,
  "causationId": null,
  "actor": { "type": "role", "id": "quality_manager" },
  "payload": { "riskId": "RC-2026-0042", "severity": "P0", "status": "处理中" },
  "status": "pending",
  "attempts": 0,
  "occurredAt": "ISO-8601"
}
```

事件 `type + version` 是稳定契约。Payload 只保存消费者需要的业务标识和状态，不放 Prompt、附件、手机号、凭据、Token 或大对象快照。

事件发布前由 `domain-event-contracts.js` 强制校验注册版本、聚合类型与必填载荷。未注册事件、错误聚合类型或缺少字段会让业务聚合与 Outbox 一并回滚。`GET /api/domain-events/contracts` 向获授权开发者公开当前注册表；同一版本只允许增加可选字段，删除/改名/改变语义必须发布新版本。

## 3. 状态机

```text
pending ──claim lease──> processing ──ack──> published
   ▲                         │
   └──── retry/backoff ──────┤
                             └── attempts >= 5 ──> dead_letter
```

- `claimDomainEvents` 使用消费者 ID 和短时租约认领；未过期事件不会被第二消费者重复认领。
- `acknowledgeDomainEvent`、`failDomainEvent` 必须匹配认领消费者。
- 失败只记录稳定错误码，不保存异常堆栈或敏感响应。
- 消费者仍必须用 `eventId` 建立幂等表；Outbox 提供至少一次送达语义，不承诺外部系统恰好一次。

## 4. 管理读取

`GET /api/domain-events/outbox` 要求：

- 页面权限 `page.config.view`；
- 按钮权限 `event.outbox.view`；
- 服务端强制使用当前身份 `tenantId`，客户端不能指定其他租户；
- 支持 `status` 与 `limit` 查询。

读取响应同时包含按状态汇总、最早待处理时间和消费者检查点指标。浏览器不公开 claim/ack；`POST /api/domain-events/outbox/{id}/replay` 只接受当前租户的 `dead_letter` 事件，要求高风险权限 `event.outbox.replay`，并保存重放人、原因、时间与次数。独立 Worker 位于 `services/domain-event-worker/app.js`，使用 `backend/src/workers/domain-event-worker.js` 保存消费者幂等检查点。生产 Worker 应使用服务身份、mTLS/工作负载身份和独立网络入口。

```powershell
# 开发监听模式
npm.cmd run dev:event-worker

# 只消费一个批次后退出，适合任务调度和验证
npm.cmd run run:event-worker
```

## 5. 当前接入与后续

当前事件类型：

- `risk.case.acknowledged`、`risk.case.disposition_approved`；
- `procurement.requisition.launched`、`procurement.requisition.approved`；
- `iam.user.authorization_changed`、`iam.role_policy.published`；
- `agent.workflow.draft_created`。
- `alert.classified`、`alerting.configuration.published`；
- `alert.voice.receipt_recorded`、`alert.escalation.requested`。
- `governance.meta_model.published`、`governance.world_model.published`。
- `agent.tool_execution.succeeded`、`agent.tool_execution.failed`。

`backend/src/domains/events/brokers/domain-event-broker.js` 提供四种 Broker。Demo 使用进程内投影适配器；Webhook 采用 CloudEvents 风格 Header、`eventId` 幂等键、HMAC-SHA256 签名、超时和非 2xx 重试/死信。Kafka 使用 `kafkajs` 幂等 Producer、`acks=-1`、事件 ID Header 和聚合键；RabbitMQ 使用 `amqplib` durable topic exchange、persistent message、publisher confirm 和 messageId。生产 Webhook/Kafka/RabbitMQ 分别要求 HTTPS、TLS/SASL、AMQPS；凭据由 KMS/Secret Manager 或工作负载身份注入，健康信息和日志不包含凭据。元模型和世界模型运行态已去除模块级可变缓存，草稿/校验使用持久化聚合，发布使用同事务 Outbox。Agent run 的成功/失败终态也与工具回执事件原子提交，Payload 仅含业务记录标识和稳定状态，不包含 Prompt、密钥或原始错误。每个新事件必须补充 Schema、幂等消费者测试、回滚测试和数据分级评审。

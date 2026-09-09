# 告警与值班技术架构

## 当前代码

后端已形成相对完整的领域目录：`backend/src/domains/alerting`，包含 classification、service、store、Provider registry 和 Mock voice provider；HTTP 位于 `routes/alerting-routes.js`，管理 UI 位于告警相关 feature/style。

## 数据所有权

本模块拥有 AlertPolicy、SeverityDefinition、OnCallSchedule、EscalationPolicy、NotificationOutbox、VoiceCall 和 DeliveryEvidence。风险模块拥有 RiskCase，只通过 `risk.case.raised/updated` 事件触发告警。

## 目标链路

```text
领域事件 → 分类/去重 → 责任组织/值班解析 → Outbox
→ 渠道编排 → Provider → 回执/Webhook → 升级/关闭
```

Provider 接口只接受脱敏后的模板参数和不透明目标引用。生产 Outbox、重试和幂等应落数据库/消息队列，不能依赖进程内循环。

## 依赖

允许读取 IAM 的组织/人员只读投影；允许发布通知给客户端；禁止通过电话回执修改风险审批或采购审批。

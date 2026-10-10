# 告警与值班模块说明

本页集中维护需求、架构、接口和开发约束；“当前”与“目标”沿用原说明，不因合并改变完成状态。

## 需求与验收

### 目标

将跨系统事件确定性分为 P0/P1/P2，依据组织责任、值班表和升级策略生成多渠道通知；P0 可自动虚拟电话，电话回执不替代业务审批。

### 核心需求

- P0 紧急、P1 中风险、P2 低风险；等级定义、阈值和渠道策略可版本化配置。
- 告警关联租户、组织、来源系统、对象、责任人、SLA 和业务风险。
- P0 按策略立即通知和电话；P1/P2 依策略通知，不默认立即电话。
- 支持值班表、升级链、静默时段、去重/抑制、重试和送达证据。
- 电话 Provider 可插拔；DTMF 只确认收到或转人工，不能批准高风险业务动作。
- 管理员可模拟路由和测试电话，所有配置与调用进入审计。

### 验收标准

相同规则输入得到相同等级；配置版本冲突返回 409；告警、电话和值班信息按组织范围过滤；Provider 故障可见且不伪造成功；P2 配置为立即电话时被拒绝或需显式合规规则。

## 架构与实现

### 当前代码

后端已形成相对完整的领域目录：`backend/src/domains/alerting`，包含 classification、service、store、Provider registry 和 Mock voice provider；HTTP 位于 `routes/alerting-routes.js`，管理 UI 位于告警相关 feature/style。

### 数据所有权

本模块拥有 AlertPolicy、SeverityDefinition、OnCallSchedule、EscalationPolicy、NotificationOutbox、VoiceCall 和 DeliveryEvidence。风险模块拥有 RiskCase，只通过 `risk.case.raised/updated` 事件触发告警。

### 目标链路

```text
领域事件 → 分类/去重 → 责任组织/值班解析 → Outbox
→ 渠道编排 → Provider → 回执/Webhook → 升级/关闭
```

Provider 接口只接受脱敏后的模板参数和不透明目标引用。生产 Outbox、重试和幂等应落数据库/消息队列，不能依赖进程内循环。

### 依赖

允许读取 IAM 的组织/人员只读投影；允许发布通知给客户端；禁止通过电话回执修改风险审批或采购审批。

## 接口契约

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/alerting/workspace` | `page.channels.view`，按组织过滤 |
| POST | `/api/alerting/configuration` | `notification.policy.publish` / `oncall.schedule.manage` |
| POST | `/api/alerting/simulations` | `notification.route.simulate` |
| POST | `/api/alerting/voice/test` | `notification.voice.test` |
| POST | `/api/alerting/voice-calls/:id/events` | `notification.voice.test` 且电话在可见组织内 |
| GET | `/api/notifications` | 当前用户可见通知投影 |
| POST | `/api/notifications/subscriptions` | 注册推送渠道 |

配置写入携带 `expectedVersion`，可包含 `severityLevels`、`voiceProviders`、`escalationPolicies`、`onCallSchedules`。电话事件 body 为 `{ "action": "answered|acknowledged|failed|completed" }`。

错误码：`VERSION_CONFLICT`、`BUTTON_PERMISSION_DENIED`、`VOICE_CALL_NOT_FOUND`、`INVALID_SEVERITY_POLICY`、`VOICE_PROVIDER_UNAVAILABLE`。

目标增加告警游标分页、单告警确认/静默/转派接口、Provider webhook 验签接口，以及 `Idempotency-Key` 防重复拨打。

## 开发约束与验证

入口：`backend/src/domains/alerting/**`、`routes/alerting-routes.js`、`data/alerting-seed.js`、`backend/test/alerting-orchestration.test.js`。

不可破坏：P0/P1/P2 确定性；P0 才默认立即电话；DTMF 不等于业务审批；配置乐观锁；组织范围过滤；Provider 结果必须记录真实状态；测试电话不能污染生产告警。

验证：

```powershell
npm.cmd run test:alerting
npm.cmd run test:permissions
```

新增 Provider 时实现统一接口、超时、重试分类、回执验签和脱敏日志，不把电话号码或密钥发送给模型。

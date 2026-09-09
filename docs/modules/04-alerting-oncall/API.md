# 告警与值班 API

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

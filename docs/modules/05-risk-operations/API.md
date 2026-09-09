# 风险运营 API

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/dashboard` | `page.dashboard.view`，组织过滤 |
| GET | `/api/risk-cases` | `page.risks.view` |
| GET | `/api/risk-cases/:id` | 页面权限 + `risk.detail.view` |
| POST | `/api/risk-cases/:id/acknowledge` | 可见资源 + `risk.acknowledge` |
| POST | `/api/risk-cases/:id/approve` | 可见资源 + `risk.approve` |
| GET | `/api/authorization/explain` | 风险/世界页面之一 |

风险响应建议稳定字段：`id`、`severity`、`status`、`title`、`sourceSystem`、`organizationId`、`objectRefs[]`、`impact`、`owner`、`evidenceRefs[]`、`createdAt`、`updatedAt`、`version`。

目标写接口携带 `{expectedVersion, comment}` 与 `Idempotency-Key`；列表增加 severity/status/org/time/cursor 过滤；错误码包括 `RISK_NOT_FOUND`、`RISK_VERSION_CONFLICT`、`BUTTON_PERMISSION_DENIED`。

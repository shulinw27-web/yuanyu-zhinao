# 密钥与凭据 API

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/key-center/overview` | `page.config.view`；仅元数据和状态 |
| POST | `/api/key-center/policies/:id/rotate` | `key.policy.rotate` |
| POST | `/api/key-center/leases/:id/revoke` | `key.lease.revoke` |

`requestKeyLease` 当前是内部服务调用，不应直接暴露给普通客户端。内部请求包含 connectorId、operation、purpose、role/auth context、taskId、TTL；返回不透明 lease 元数据，绝不返回 secret。

目标管理接口增加策略 CRUD/发布、审计查询和 Provider health；内部 capability API 采用 mTLS/service identity，并返回 `leaseId/expiresAt/scope`。错误码：`KEY_POLICY_DENIED`、`KEY_LEASE_EXPIRED`、`KEY_LEASE_REVOKED`、`KMS_UNAVAILABLE`。

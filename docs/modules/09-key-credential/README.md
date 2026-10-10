# 密钥与凭据模块说明

本页集中维护需求、架构、接口和开发约束；“当前”与“目标”沿用原说明，不因合并改变完成状态。

## 需求与验收

### 目标

为模型网关、Connector 和通知 Provider 提供策略化、短时、不透明的凭据能力，真实密钥始终停留在 Vault、云 KMS 或 HSM 边界。

### 核心需求

- 管理 KeyPolicy：允许的 connector、operation、角色/服务主体、TTL、环境和用途。
- 通过已授权任务申请一次性/短时 lease；调用方只获得句柄或代理能力。
- 支持轮换策略、吊销 lease、过期、并发限制和完整审计。
- 密钥、Token、私钥不得出现在 API 响应、模型上下文、日志、证据或 SQLite。
- KMS Provider 可插拔，Demo adapter 只生成不具生产能力的不透明凭据。

### 验收标准

越权 operation/connector/role 拒绝；过期或吊销 lease 不可用；轮换不返回旧/新密钥；客户端无法申请任意 lease；生产未配置 KMS 时高风险写入 fail-closed。

## 架构与实现

外部 `KEY_CENTER_PROVIDER` 只表示选择目标，不代表适配器已经可用。运行时可通过 `registerKmsCredentialProvider` 注册定制 Vault、云 KMS 或 HSM 适配器，也可配置 `KEY_CENTER_PROVIDER_URL` 使用内置异步远程凭据 Broker。Broker 契约为 `POST /v1/credential-handles`，请求只携带受管引用、租约 ID、过期时间和工作负载身份，响应只采信 opaque `handle`。未注册、超时、非 2xx 或无句柄均失败关闭。

API 与独立 Key Center 的就绪探针调用 Broker `GET /health/ready`。外部 Provider 不可达时实例返回 not-ready，租约接口返回 503；IAM/业务授权不通过仍返回 403。这样编排系统不会通过重启或权限错误掩盖依赖故障。

### 当前代码

`services/key-center/key-center-service.js`、`kms-adapter.js`，可选独立控制面 `services/key-center/app.js`，管理 UI 为 `KeyCenterPanel.vue`。

### 数据所有权

本模块只拥有 policy、lease metadata、rotation/revocation audit 和 Provider 状态。真实 secret 由外部 KMS/Vault/HSM 拥有，业务模块不能读取。

### 目标链路

```text
业务用例已授权 → Key Policy PDP → KMS/Proxy 生成短时能力
→ Connector/Model Provider 使用 → 过期/吊销 → 审计
```

生产建议独立部署，使用服务身份、mTLS、网络隔离和独立审计。业务调用最好通过代理执行或 workload identity，避免即使是短时 secret 落入应用内存。

### 边界

IAM 判定用户身份，Key 模块判定凭据用途；两者都通过才签发。Key Center 不审批业务动作，也不相信客户端提供的 role/authorization 对象。

## 接口契约

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/key-center/overview` | `page.config.view`；仅元数据和状态 |
| POST | `/api/key-center/policies/:id/rotate` | `key.policy.rotate` |
| POST | `/api/key-center/leases/:id/revoke` | `key.lease.revoke` |

`requestKeyLease` 当前是内部服务调用，不应直接暴露给普通客户端。内部请求包含 connectorId、operation、purpose、role/auth context、taskId、TTL；返回不透明 lease 元数据，绝不返回 secret。

目标管理接口增加策略 CRUD/发布、审计查询和 Provider health；内部 capability API 采用 mTLS/service identity，并返回 `leaseId/expiresAt/scope`。错误码：`KEY_POLICY_DENIED`、`KEY_LEASE_EXPIRED`、`KEY_LEASE_REVOKED`、`KMS_UNAVAILABLE`。

## 开发约束与验证

入口：`services/key-center/**`、`services/key-center/app.js`、`mcp-connector-service.js`、采购/Agent 工具中的 lease 调用。

不可破坏：永不返回密钥明文；lease 绑定 connector、operation、task、角色/服务主体和 TTL；过期/吊销立即拒绝；生产 KMS 不可用时 fail-closed；日志和测试 fixture 不包含真实 secret。

验证：

```powershell
npm.cmd run test:security
npm.cmd run test:permissions
```

修改 policy 字段时检查所有 Connector 调用方，并更新 `docs/architecture/KEY_CENTER_MICROSERVICE.md`。

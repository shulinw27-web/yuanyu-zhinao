# 密钥中心微服务 v0.1

## 服务边界

密钥中心负责策略、租约、轮换、吊销和审计；真实密钥材料只由 Vault、云 KMS 或 HSM 保存和使用。业务服务、MCP 连接器、模型网关和浏览器均不得存储或接收密钥明文。

## 生产部署契约

- 服务名：`key-center`
- 建议端口：`3010`（仅内网，经 API Gateway / mTLS 访问）
- 认证：工作负载身份（Kubernetes ServiceAccount、SPIFFE 或云 IAM）
- API：`POST /v1/leases`、`POST /v1/leases/{id}/revoke`、`POST /v1/policies/{id}/rotate`、`GET /v1/overview`
- 事件：`key.lease.issued`、`key.lease.revoked`、`key.lease.expired`、`key.policy.rotated`

## 当前可执行服务

仓库已提供 `services/key-center/app.js`，可单独启动密钥控制面：

```powershell
npm.cmd run dev:key-center
```

- 健康检查：`GET http://127.0.0.1:3010/health`
- 控制面 API：`GET /v1/overview`、`POST /v1/leases`、`POST /v1/leases/{id}/revoke`、`POST /v1/policies/{id}/rotate`
- API 在非生产环境允许本机演练调用；生产环境要求 `x-service-principal` 位于 `KEY_CENTER_TRUSTED_PRINCIPALS`。该 Header 仅是开发期服务身份接口，生产必须由 mTLS、SPIFFE 或云 IAM 认证注入，不能让调用方自行伪造。
- 当前业务 API 仍以进程内适配器保持本地演练兼容，但策略版本、租约和审计已通过统一 Repository 写入 SQLite 并支持重启恢复。迁移到独立控制面时，应由业务 API 使用工作负载身份调用上述 `/v1` 契约，并将本地 SQLite 替换为生产事务数据库与 Vault/KMS/HSM。
- 生产可设置 `KEY_CENTER_PROVIDER=<provider>`、`KEY_CENTER_PROVIDER_URL=https://...`、`KEY_CENTER_WORKLOAD_ID=<workload>` 和超时；可选短期 `KEY_CENTER_PROVIDER_BEARER_TOKEN` 必须由工作负载 Secret 注入，不能写入仓库。内置 Broker 适配器异步请求 `/v1/credential-handles`，只接收不透明句柄，并通过 `/health/ready` 驱动 API/Key Center 就绪状态。
- 远程 Provider 超时、拒绝或不健康时租约签发失败关闭并返回 503，不创建活跃租约；业务授权失败保持 403。生产优先使用 mTLS/SPIFFE 或云工作负载身份，静态 Bearer 仅作为过渡。

## 安全不变量

1. 返回不透明凭据句柄和租约，绝不返回真实密钥。
2. 每张租约绑定服务主体、用户角色、连接器、操作、任务、用途和 TTL。
3. 写入类连接器凭据只在审批门禁通过后签发。
4. 所有签发、续租、吊销和轮换必须进入不可篡改审计流。
5. Demo 的进程内调用仅用于开发；生产必须拆分部署并改为 mTLS 调用。

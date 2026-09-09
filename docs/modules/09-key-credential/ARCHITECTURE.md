# 密钥与凭据技术架构

外部 `KEY_CENTER_PROVIDER` 只表示选择目标，不代表适配器已经可用。运行时可通过 `registerKmsCredentialProvider` 注册定制 Vault、云 KMS 或 HSM 适配器，也可配置 `KEY_CENTER_PROVIDER_URL` 使用内置异步远程凭据 Broker。Broker 契约为 `POST /v1/credential-handles`，请求只携带受管引用、租约 ID、过期时间和工作负载身份，响应只采信 opaque `handle`。未注册、超时、非 2xx 或无句柄均失败关闭。

API 与独立 Key Center 的就绪探针调用 Broker `GET /health/ready`。外部 Provider 不可达时实例返回 not-ready，租约接口返回 503；IAM/业务授权不通过仍返回 403。这样编排系统不会通过重启或权限错误掩盖依赖故障。

## 当前代码

`services/key-center/key-center-service.js`、`kms-adapter.js`，可选独立控制面 `services/key-center/app.js`，管理 UI 为 `KeyCenterPanel.vue`。

## 数据所有权

本模块只拥有 policy、lease metadata、rotation/revocation audit 和 Provider 状态。真实 secret 由外部 KMS/Vault/HSM 拥有，业务模块不能读取。

## 目标链路

```text
业务用例已授权 → Key Policy PDP → KMS/Proxy 生成短时能力
→ Connector/Model Provider 使用 → 过期/吊销 → 审计
```

生产建议独立部署，使用服务身份、mTLS、网络隔离和独立审计。业务调用最好通过代理执行或 workload identity，避免即使是短时 secret 落入应用内存。

## 边界

IAM 判定用户身份，Key 模块判定凭据用途；两者都通过才签发。Key Center 不审批业务动作，也不相信客户端提供的 role/authorization 对象。

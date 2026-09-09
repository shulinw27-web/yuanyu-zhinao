# 密钥与凭据模块需求

## 目标

为模型网关、Connector 和通知 Provider 提供策略化、短时、不透明的凭据能力，真实密钥始终停留在 Vault、云 KMS 或 HSM 边界。

## 核心需求

- 管理 KeyPolicy：允许的 connector、operation、角色/服务主体、TTL、环境和用途。
- 通过已授权任务申请一次性/短时 lease；调用方只获得句柄或代理能力。
- 支持轮换策略、吊销 lease、过期、并发限制和完整审计。
- 密钥、Token、私钥不得出现在 API 响应、模型上下文、日志、证据或 SQLite。
- KMS Provider 可插拔，Demo adapter 只生成不具生产能力的不透明凭据。

## 验收标准

越权 operation/connector/role 拒绝；过期或吊销 lease 不可用；轮换不返回旧/新密钥；客户端无法申请任意 lease；生产未配置 KMS 时高风险写入 fail-closed。

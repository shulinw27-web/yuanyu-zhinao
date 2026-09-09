# 运行配置契约

## 配置入口

API 组合根只通过 `backend/src/config/runtime-config.js` 解析通用运行配置。非法端口、请求体上限、存储驱动、Broker 类型或通配 CORS 会在监听端口前失败。业务服务仍可读取自己的专用配置，但新增通用配置必须先进入该 Schema。

## 开发与 Mock

开发默认使用 SQLite、Mock 身份、Mock 模型、Demo KMS 和内置投影 Worker。`.env.example` 只提供变量名称与非敏感示例；真实 API Key、数据库口令和证书不得写入仓库。

火山方舟提供方为 `ark`，通过 `ARK_API_KEY`、`ARK_MODEL`、`ARK_BASE_URL` 及精确模型白名单接入。`npm run start:ark` 强制本进程使用环境托管配置，忽略数据库中的旧本地模型选择；`npm run check:ark` 只发送合成预检。步骤、数据出网边界和真实验收结果见 [火山方舟接入指南](../../development/ARK_MODEL_INTEGRATION.md)。

`MULTIMODAL_VISUAL_PROVIDER` 默认 disabled；配置为 model 仍须满足云端图片策略 approved、获准视觉模型和企业扫描明确 allow。生产/required 模式未配置 `MULTIMODAL_SECURITY_SCAN_ENDPOINT` 则拒绝附件。`MULTIMODAL_OCR_ENDPOINT` 是另一条受控文字提取路径，不授予原图出网权；完整要求见 [多模态接入指南](../../guides/AGENT_MULTIMODAL_GUIDE.md)。不要将测试脚本的合成文件扫描替身配给真实服务。

## 生产强制条件

- `DEMO_ALLOW_ROLE_HEADER=false`；
- `OA_AUTH_MODE`、`ACCOUNT_AUTH_MODE` 不得为 `mock`；
- 必须配置 `OIDC_ISSUER`、`OIDC_AUDIENCE`、`OIDC_JWKS_URI`、`OIDC_TENANT_ID`，并锁定非对称签名算法白名单；
- `AGENT_RUNTIME_MODE` 不得为 `mock`；
- `KEY_CENTER_PROVIDER` 不得为 `demo-kms`；
- 必须配置 HTTPS `KEY_CENTER_PROVIDER_URL` 与 `KEY_CENTER_WORKLOAD_ID`；超时由 `KEY_CENTER_PROVIDER_TIMEOUT_MS` 控制，Bearer 只允许从工作负载 Secret 动态注入；
- `RUNTIME_STORE_DRIVER=memory` 被拒绝；
- 必须显式配置无通配符的 `CORS_ALLOWED_ORIGINS`；
- SQLite 仅允许显式单节点部署；多节点必须先完成 PostgreSQL Repository 适配。

PostgreSQL 使用 `RUNTIME_POSTGRES_URL`、`RUNTIME_POSTGRES_POOL_MAX` 和 `RUNTIME_POSTGRES_STATEMENT_TIMEOUT_MS`。`IDENTITY_SESSION_STORE_DRIVER=postgres` 可迁移身份会话，`IAM_STORE_DRIVER=postgres` 可迁移 IAM 主数据与访问控制，`RISK_PROCUREMENT_STORE_DRIVER=postgres` 可迁移风险处置与采购协同，`ALERTING_STORE_DRIVER=postgres` 可迁移告警编排；生产上述业务 PostgreSQL 模式必须同时设置 `DOMAIN_EVENT_STORE_DRIVER=postgres`。生产 URL 必须显式启用 TLS。模拟运行和治理等领域尚未全部完成异步化，因此 `RUNTIME_STORE_DRIVER=postgres` 仍被拒绝。

当前验证器不会把 secret 回显到健康接口或能力清单。生产环境应由 Secret Manager、Vault、云 KMS 或工作负载身份注入，不使用 `.env` 明文分发。

## 探针

- `/api/health/live` 仅用于进程存活；
- `/api/health/ready` 检查 Runtime Store、Outbox、Domain Event Store、身份会话 Store、IAM Store、风险/采购 Store、Alerting Store 与 Key Center Provider；
- `DOMAIN_EVENT_STORE_DRIVER=postgres` 时，API 事件列表、指标、消费者状态和死信重放与 Event Worker 使用同一 PostgreSQL 事实源；
- 死信导致 Outbox 显示 `degraded`，但不会触发容器重启；
- `/api/system/capabilities` 需要配置页权限，只返回非敏感能力和部署约束。

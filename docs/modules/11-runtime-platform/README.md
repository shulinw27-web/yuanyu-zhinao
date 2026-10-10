# 平台运行基础模块说明

本页集中维护需求、架构、接口和开发约束；“当前”与“目标”沿用原说明，不因合并改变完成状态。

## 需求与验收

### 目标

提供模块组合、HTTP、配置、持久化、限流、日志、健康检查、部署和 CI 基础，使各业务模块可以独立开发、测试并稳定组合。

### 核心需求

- `app.js` 只负责启动、通用中间件和注册模块，不包含业务规则。
- 环境配置有 Schema、默认值、敏感项来源和启动校验；生产禁止 Demo 安全开关。
- Repository 为每模块提供独立 namespace/transaction，支持测试 Memory 与开发 SQLite。
- 请求具备 request/correlation ID、结构化日志、指标和依赖健康状态。
- 限流按登录、Agent、写操作和普通读分级；请求体和附件有上限。
- 每模块可独立运行单测/契约测试，完整 CI 能构建所有客户端。

### 验收标准

业务模块不直接操作其他 namespace；配置错误启动失败；SQLite 重启持久化和确认并发测试通过；生产可替换 PostgreSQL；错误响应不泄露堆栈；CORS 使用明确 allowlist。

## 架构与实现

### 当前代码

`backend/src/app.js` 是原生 Node HTTP 组合根，只负责通用请求控制、身份上下文、页面读取门禁和模块 route adapter 注册；业务接口已迁入 `backend/src/routes/*-routes.js`。旧 Express 路由已删除。`http/http-utils.js` 和 `route-security.js` 提供基础能力，`runtime-state-repository.js` 提供当前同步 Memory/SQLite 基线；`postgres-runtime-state-repository.js` 提供 Phase 1 异步 PostgreSQL 契约与事务实现，根 package scripts 编排测试和构建。

### 目标组合根

```text
loadConfig → createLogger/metrics → createRepository
→ register(identity, agent, evidence, alerting, risk, ...)
→ common error handler → listen
```

模块注册返回 route descriptors，平台统一完成认证前置、Schema 验证、错误映射和 request ID。业务模块负责自己的页面/按钮/数据/业务权限 use case。

### 持久化

当前 SQLite 是单节点 Demo 基线。PostgreSQL 已提供 schema migration、连接池、JSONB 状态、行锁、版本与聚合/Outbox 原子提交测试。身份会话、IAM 访问控制、风险处置、采购协同和告警编排均可通过独立驱动接入 PostgreSQL；Agent run、trace、对话、学习控制和长任务平面也已有独立开关。总配置继续拒绝虚假的 `RUNTIME_STORE_DRIVER=postgres`，因为模拟运行和治理等聚合尚未全部迁移。生产最终所有业务表必须含 tenant key；敏感数据使用加密，启用 RLS、备份恢复和连接池。

### 可观测性

日志只记录 ID、状态、耗时、错误码和安全摘要；不得记录 prompt 原文、附件、Token 或 secret。指标按模块、路由、模型、Connector 和队列维度；traceId 连接 Agent 证据与平台 telemetry。

API 已通过 `observability/structured-logger.js` 输出单行 JSON 完成日志，字段限定为 requestId、method、无查询参数的 path、statusCode、durationMs 和客户端平台。请求体、查询参数、Cookie、Authorization、身份 Header 与异常堆栈不进入访问日志。

### 运行配置

`backend/src/config/runtime-config.js` 是 API 组合根的统一配置入口，集中校验端口、CORS、请求体上限、存储和 Broker 类型。生产环境如果仍启用 Demo 角色 Header、Mock 登录、Mock 模型、内存存储或 Demo KMS，进程会在监听端口前失败。单节点生产临时使用 SQLite 必须显式声明 `SINGLE_NODE_DEPLOYMENT=true`；多节点目标仍为 PostgreSQL。

### 协作改造优先级

P0 的业务路由拆分、共享契约、静态门禁和 OpenAPI 已完成。P1 已建立领域出口、角色 IAM 投影、通用 Outbox、消费者监控、死信重放和独立幂等 Worker；风险、采购、IAM、Agent 工作项与工具回执、告警及模型治理发布均原子发布事件，并提供 Kafka/RabbitMQ/Webhook 注入边界。存活、就绪和能力清单也已拆分。P2 的 PostgreSQL schema、异步 Repository、身份会话、IAM 请求级访问控制、风险/采购、告警聚合和 Agent 控制面接管已完成；后续迁移模拟运行和治理聚合，并补齐真实数据库集成测试、RLS、备份恢复和多节点部署。

## 接口契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | Public；服务、时间、runtime store driver/schema |
| GET | `/api/health/live` | Public；仅反映 API 进程存活，不探测外部依赖 |
| GET | `/api/health/ready` | Public；检查 Runtime Store 与 Outbox，供容器就绪探针使用 |
| GET | `/api/system/capabilities` | `page.config.view`；返回非敏感功能能力与 Demo 约束 |
| GET | `/api/platform-status` | 受页面权限保护的平台状态投影 |
| GET | `/api/configurations` | `page.config.view`；不得包含 secret |
| GET | `/api/domain-events/outbox` | `page.config.view` + `event.outbox.view`；仅返回当前租户事件，支持 status/limit |
| GET | `/api/domain-events/contracts` | `page.config.view` + `event.outbox.view`；返回事件 type/version、聚合类型和必填载荷字段 |
| POST | `/api/domain-events/outbox/{id}/replay` | `event.outbox.replay`；仅允许重放当前租户的 dead_letter 事件，记录操作者、原因与次数 |

通用响应头应包含 `x-request-id`；限流返回 429 与 `Retry-After`；请求体超限返回 413。CORS 只回显 allowlist origin。

后续目标：`/metrics` 仅面向内部网络与服务身份；生产就绪探针继续增加 PostgreSQL、Broker 与 KMS 的强依赖检查。死信数量只把 Outbox 标记为 degraded，不直接让实例退出就绪状态，避免通过重启掩盖业务投递故障。

配置 API 只返回业务可公开配置，环境变量、连接串和密钥状态由内部管理面提供脱敏摘要。

领域事件字段、认领/确认/重试状态机和生产 Worker 边界见 [DOMAIN_EVENT_OUTBOX.md](DOMAIN_EVENT_OUTBOX.md)。浏览器不开放 claim/ack；死信重放是独立高风险按钮权限，服务端仍校验租户和事件状态。

## 开发约束与验证

入口：根/后端 `package.json`、`eslint.config.js`、`tsconfig.json`、`.github/CODEOWNERS`、`backend/src/app.js`、`backend/src/domains/*/public-api.js`、`http/*`、`repositories/runtime-state-repository.js`、`repositories/async-runtime-state-repository.js`、`repositories/postgres-runtime-state-repository.js`、`backend/migrations/postgres/*`、`backend/test/architecture-boundaries.test.js`、`backend/test/runtime-persistence.test.js`、`backend/test/postgres-runtime-repository.test.js`、`deploy/*`。

运行配置变更先阅读 [CONFIGURATION.md](CONFIGURATION.md)；领域写操作或跨模块集成先阅读 [DOMAIN_EVENT_OUTBOX.md](DOMAIN_EVENT_OUTBOX.md)。

不可破坏：真实入口是原生 HTTP app，业务路由只能加入对应 `*-routes.js`；公共路径保持最小；CORS allowlist；生产关闭 Demo 登录/header；Repository mutation 保证原子确认；聚合和领域事件使用同一 Repository 的 `mutateStates` 同事务；IAM 同步/异步实现共享 `iam-workspace-model.js`；异步化模块不得重新引用同步仓；总 PostgreSQL 驱动在全部模块迁移前保持禁用；事件消费者按 eventId 幂等且不能跨租户；错误不泄露内部堆栈；配置/健康接口不返回 secret。

验证：

```powershell
npm.cmd run test:all
npm.cmd run test:events
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
npm.cmd run build:desktop
npm.cmd run build:mobile
```

修改平台基础时优先保持模块 API 不变。涉及 Repository Schema 时提供迁移、回滚、重启和并发测试。

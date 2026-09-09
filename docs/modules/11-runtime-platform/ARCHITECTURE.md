# 平台运行基础技术架构

## 当前代码

`backend/src/app.js` 是原生 Node HTTP 组合根，只负责通用请求控制、身份上下文、页面读取门禁和模块 route adapter 注册；业务接口已迁入 `backend/src/routes/*-routes.js`。旧 Express 路由已删除。`http/http-utils.js` 和 `route-security.js` 提供基础能力，`runtime-state-repository.js` 提供当前同步 Memory/SQLite 基线；`postgres-runtime-state-repository.js` 提供 Phase 1 异步 PostgreSQL 契约与事务实现，根 package scripts 编排测试和构建。

## 目标组合根

```text
loadConfig → createLogger/metrics → createRepository
→ register(identity, agent, evidence, alerting, risk, ...)
→ common error handler → listen
```

模块注册返回 route descriptors，平台统一完成认证前置、Schema 验证、错误映射和 request ID。业务模块负责自己的页面/按钮/数据/业务权限 use case。

## 持久化

当前 SQLite 是单节点 Demo 基线。PostgreSQL 已提供 schema migration、连接池、JSONB 状态、行锁、版本与聚合/Outbox 原子提交测试。身份会话、IAM 访问控制、风险处置、采购协同和告警编排均可通过独立驱动接入 PostgreSQL；Agent run、trace、对话、学习控制和长任务平面也已有独立开关。总配置继续拒绝虚假的 `RUNTIME_STORE_DRIVER=postgres`，因为模拟运行和治理等聚合尚未全部迁移。生产最终所有业务表必须含 tenant key；敏感数据使用加密，启用 RLS、备份恢复和连接池。

## 可观测性

日志只记录 ID、状态、耗时、错误码和安全摘要；不得记录 prompt 原文、附件、Token 或 secret。指标按模块、路由、模型、Connector 和队列维度；traceId 连接 Agent 证据与平台 telemetry。

API 已通过 `observability/structured-logger.js` 输出单行 JSON 完成日志，字段限定为 requestId、method、无查询参数的 path、statusCode、durationMs 和客户端平台。请求体、查询参数、Cookie、Authorization、身份 Header 与异常堆栈不进入访问日志。

## 运行配置

`backend/src/config/runtime-config.js` 是 API 组合根的统一配置入口，集中校验端口、CORS、请求体上限、存储和 Broker 类型。生产环境如果仍启用 Demo 角色 Header、Mock 登录、Mock 模型、内存存储或 Demo KMS，进程会在监听端口前失败。单节点生产临时使用 SQLite 必须显式声明 `SINGLE_NODE_DEPLOYMENT=true`；多节点目标仍为 PostgreSQL。

## 协作改造优先级

P0 的业务路由拆分、共享契约、静态门禁和 OpenAPI 已完成。P1 已建立领域出口、角色 IAM 投影、通用 Outbox、消费者监控、死信重放和独立幂等 Worker；风险、采购、IAM、Agent 工作项与工具回执、告警及模型治理发布均原子发布事件，并提供 Kafka/RabbitMQ/Webhook 注入边界。存活、就绪和能力清单也已拆分。P2 的 PostgreSQL schema、异步 Repository、身份会话、IAM 请求级访问控制、风险/采购、告警聚合和 Agent 控制面接管已完成；后续迁移模拟运行和治理聚合，并补齐真实数据库集成测试、RLS、备份恢复和多节点部署。

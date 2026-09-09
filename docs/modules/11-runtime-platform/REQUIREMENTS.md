# 平台运行基础模块需求

## 目标

提供模块组合、HTTP、配置、持久化、限流、日志、健康检查、部署和 CI 基础，使各业务模块可以独立开发、测试并稳定组合。

## 核心需求

- `app.js` 只负责启动、通用中间件和注册模块，不包含业务规则。
- 环境配置有 Schema、默认值、敏感项来源和启动校验；生产禁止 Demo 安全开关。
- Repository 为每模块提供独立 namespace/transaction，支持测试 Memory 与开发 SQLite。
- 请求具备 request/correlation ID、结构化日志、指标和依赖健康状态。
- 限流按登录、Agent、写操作和普通读分级；请求体和附件有上限。
- 每模块可独立运行单测/契约测试，完整 CI 能构建所有客户端。

## 验收标准

业务模块不直接操作其他 namespace；配置错误启动失败；SQLite 重启持久化和确认并发测试通过；生产可替换 PostgreSQL；错误响应不泄露堆栈；CORS 使用明确 allowlist。

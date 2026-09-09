# Codex Context：平台运行基础

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

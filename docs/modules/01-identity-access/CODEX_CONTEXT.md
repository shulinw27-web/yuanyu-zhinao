# Codex Context：身份与访问控制

企业 Bearer 验证必须通过 `enterprise-oidc-service.js`；不得解析未验证 JWT，不得采信 Token 内 role/group 作为平台权限。账号映射后始终重新读取 IAM 人员、角色策略和组织数据范围。

## 修改前必读

`backend/src/domains/identity/public-api.js`、`domains/iam/public-api.js`、`routes/identity-routes.js`、`permission-routes.js`、`services/access-control-service.js`、`services/identity-session-service.js`、`services/permission-management-service.js`、`services/iam-workspace-model.js`、`services/async-iam-store.js`、`data/iam-seed.js`。HTTP 层只能从领域 public-api 导入。

## 不可破坏约束

- 真实未知主体 fail-closed；Demo fallback 仅非生产 `demo_header`。
- 人员、角色或策略版本变化必须使旧会话失效。
- 身份会话服务必须保持异步 Repository 端口；新增调用方必须 `await`，不得重新直接依赖同步状态仓。
- IAM 同步/异步实现必须共享 `iam-workspace-model.js`；异步人员/策略变更和 Outbox 必须通过同一 Repository 的 `mutateStates` 原子提交。所有 IAM 读取者迁移完成前，不得开放 IAM 或总 PostgreSQL 驱动开关。
- 多角色动作必须选择一个真实持有按钮权限的有效角色。
- self/current org/descendants 不能被客户端 `organizationIds` 覆盖。
- 不能自我提权、越租户或移除最后一个超级管理员。
- 401/权限类 403 必须保留稳定 `code`，供客户端 fail-closed。

## 常用验证

```powershell
npm.cmd run test:permissions
npm.cmd run test:security
npm.cmd run build -w frontend
```

## 修改完成检查

同步更新权限目录 seed、后端门禁、前端显隐、API 文档和允许/拒绝成对测试。不要只修改前端权限矩阵。

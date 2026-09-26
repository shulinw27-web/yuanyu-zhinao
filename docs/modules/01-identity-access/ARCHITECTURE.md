# 身份与访问控制技术架构

## 当前代码

- 路由：`backend/src/routes/identity-routes.js`、`permission-routes.js`
- 身份：`request-identity-service.js`、`identity-session-service.js`、`oa-auth-service.js`、`account-center-service.js`
- 权限：`access-control-service.js`、`role-catalog-service.js`、`permission-management-service.js`、`permission-center-service.js`
- 数据：`data/iam-seed.js`、`iam-workspace-model.js`、`iam-store.js`、`async-iam-store.js`、`runtime-state-repository.js`
- 前端：`features/permission`、`permission-navigation.js`

## 企业 OIDC Bearer

`enterprise-oidc-service.js` 使用 IdP JWKS 校验签名，并强制验证 issuer、audience、`sub/iat/exp`、算法白名单和租户 claim。Token 中的 role/group claim 不参与业务授权；验证后只使用 email、preferred_username 或 upn 映射本地 IAM 人员，再实时计算人员状态、角色策略和组织数据范围。身份会话优先于 Bearer，Bearer 优先于仅开发可用的 Demo Header。生产必须配置 `OIDC_ISSUER`、`OIDC_AUDIENCE`、`OIDC_JWKS_URI` 和 `OIDC_TENANT_ID`。元域智营与 Agent SDK 都支持由宿主注入异步 Access Token Provider；令牌按请求读取、仅放入 `Authorization`，不会写入 localStorage。移动/Web 宿主通过 `__ZHINAO_RUNTIME_CONFIG__.getAccessToken`，Electron 通过隔离 preload 暴露的 `zhinaoDesktop.auth.getAccessToken` 接入企业登录组件。

当前完成的是资源服务端 Bearer 验证和三端令牌传输边界；Authorization Code + PKCE 跳转、回调处理、静默续期、MFA/step-up 和 IdP 全局注销仍需按企业 IdP SDK 实施。客户端不得自行解析 JWT 作为授权依据，也不得把 Token 中的角色或组直接映射为平台权限。

## 异步会话与 IAM 存储

`identity-session-service.js` 已改为 Promise-based Repository 端口并支持构造器注入；登录、校验、资料查询、过期/权限变更失效和注销均已异步化。默认 `IDENTITY_SESSION_STORE_DRIVER=runtime` 仍使用 SQLite/Memory 兼容适配器；执行 PostgreSQL migration 后可单独设置 `IDENTITY_SESSION_STORE_DRIVER=postgres`，先把分布式登录会话迁移到 PostgreSQL。启动时会检查 schema，运行就绪探针会检查数据库连通性。

`async-iam-store.js` 已实现 IAM 的 Promise-based Repository 端口，并在 PostgreSQL 契约测试中覆盖人员授权、角色策略、乐观版本冲突、Schema 迁移、审计，以及 IAM 聚合与领域事件 Outbox 的同库原子提交。事件契约校验失败时，权限变更与 Outbox 都会回滚。同步与异步实现共享 `iam-workspace-model.js` 的种子和 Schema 迁移规则，避免双轨漂移。

`IAM_STORE_DRIVER=postgres` 已接管运行时访问控制。API 每个请求先取得一致性 IAM 快照，角色目录、身份映射、页面和按钮权限、组织范围及权限管理都在该快照上计算；权限写入使用异步 Store，成功后刷新当前请求视图。数据库行锁事务同时保护乐观版本、最后管理账号约束和权限变更 Outbox。生产必须让 `DOMAIN_EVENT_STORE_DRIVER=postgres` 指向同一数据库，并使用 `sslmode=require|verify-ca|verify-full`。`RUNTIME_STORE_DRIVER=postgres` 仍被拒绝，因为模拟运行和治理等剩余领域聚合尚未完成迁移。

## 数据所有权

本模块唯一拥有 User、Organization、RolePolicy、UserRoleBinding、IdentitySession、IAMAudit。业务模块只能读取 `EffectiveAuthorizationContext`，不得读取 IAM 内部 seed 或自行解析角色。

`role-catalog-service.js` 是角色目录唯一读取边界：静态名称、颜色、条线等展示元数据必须与当前 IAM RolePolicy 合并后才成为有效角色。请求身份、授权、权限工作区和 `/api/roles` 均使用该投影；其他服务不得直接读取 `data/seed.js` 的 `roles`。

人员授权变更和角色策略发布分别产生 `iam.user.authorization_changed`、`iam.role_policy.published`，与 IAM 版本更新原子提交；消费者不得使用事件缓存绕过每请求实时权限计算。

## 核心链路

```text
凭据/SSO → 身份源适配 → 签发会话 → 每请求实时验证版本
→ 计算有效多角色 → 页面/按钮权限 → 组织范围 → 业务模块
```

## 目标结构

```text
modules/identity-access/
  api/{identity-routes,permission-routes,schemas}.js
  application/{login,resolve-access,assign-roles,save-policy}.js
  domain/{user,role-policy,data-scope,errors}.js
  infrastructure/{iam-repository,idp-adapter,session-store}.js
  index.js
```

## 边界规则

- 业务模块接收完整 identity context，不接收可伪造的 role 字符串作为唯一依据。
- 所有 `organizationIds` 都与同租户组织树验证；数据查询统一注入允许组织集。
- 会话只保存身份快照/版本，不永久缓存撤销前权限。
- 元域智营的权限矩阵不是策略引擎，策略真相位于服务端。

## 演进

身份会话和 IAM 已可分别灰度到 PostgreSQL；下一步是 tenant 列、外键、索引和 RLS，以及与企业主数据的增量同步。IdP 适配器仍需替换 Mock 登录；权限计算可独立为 PDP，但应用服务仍负责把决策落实到查询和写用例。

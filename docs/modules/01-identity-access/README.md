# 身份与访问控制模块说明

本页集中维护需求、架构、接口和开发约束；“当前”与“目标”沿用原说明，不因合并改变完成状态。

## 需求与验收

### 目标

为元域智营、桌面 Web、Electron、移动端和 Agent 服务提供统一身份、组织、角色、页面/按钮/API 权限和组织数据域，确保权限变更能够实时失效。

### 用户故事

1. 员工可通过平台账号或 OA/BPM 登录并获得统一身份会话。
2. 管理员可维护人员的多角色绑定，角色可附带不同组织范围。
3. 管理员可配置菜单、页面、按钮/API 权限和 `SELF/CURRENT_ORG/ORG_AND_DESCENDANTS/SELECTED_ORGS/ALL` 数据范围。
4. 普通用户只看到自己有效范围内的数据和操作；直接构造 API 也不能绕过。
5. 人员停用、角色撤销或策略版本变化后，旧会话在下一次请求立即失效。
6. 审计人员在具备独立权限时查看 IAM 变更记录。

### 范围

包含登录、注销、会话验证、设备绑定、组织树、用户、角色策略、权限计算、权限管理工作区。企业 IdP、MFA、HR 主数据同步属于生产适配，但接口边界归本模块。

不包含业务动作审批、模型授权细节、业务数据本身和密钥材料。

### 验收标准

- 未认证的受保护 API 返回 401；未知真实主体默认空权限。
- 页面、按钮和组织范围均在后端执行，前端只做体验控制。
- 多角色权限和组织范围按策略合并，但始终限制在同一租户。
- `CURRENT_ORG` 和后代范围强制锚定 IAM 用户直属组织。
- 变更使用 `expectedVersion`，并发冲突返回 409。
- 禁止自我提权、越租户组织绑定和停用最后一个超级管理员。
- 所有变更记录操作者、前后版本、时间和差异。

### 非功能要求

- 生产认证采用 OIDC/OAuth 2.1 或企业 IAM；高风险管理操作支持 MFA step-up。
- 权限计算 P95 小于 50ms，可缓存但必须按用户/策略版本精准失效。
- 管理 API 和审计日志满足租户隔离、最小权限和敏感字段脱敏。

## 架构与实现

### 当前代码

- 路由：`backend/src/routes/identity-routes.js`、`permission-routes.js`
- 身份：`request-identity-service.js`、`identity-session-service.js`、`oa-auth-service.js`、`account-center-service.js`
- 权限：`access-control-service.js`、`role-catalog-service.js`、`permission-management-service.js`、`permission-center-service.js`
- 数据：`data/iam-seed.js`、`iam-workspace-model.js`、`iam-store.js`、`async-iam-store.js`、`runtime-state-repository.js`
- 前端：`features/permission`、`permission-navigation.js`

### 企业 OIDC Bearer

`enterprise-oidc-service.js` 使用 IdP JWKS 校验签名，并强制验证 issuer、audience、`sub/iat/exp`、算法白名单和租户 claim。Token 中的 role/group claim 不参与业务授权；验证后只使用 email、preferred_username 或 upn 映射本地 IAM 人员，再实时计算人员状态、角色策略和组织数据范围。身份会话优先于 Bearer，Bearer 优先于仅开发可用的 Demo Header。生产必须配置 `OIDC_ISSUER`、`OIDC_AUDIENCE`、`OIDC_JWKS_URI` 和 `OIDC_TENANT_ID`。元域智营与 Agent SDK 都支持由宿主注入异步 Access Token Provider；令牌按请求读取、仅放入 `Authorization`，不会写入 localStorage。移动/Web 宿主通过 `__ZHINAO_RUNTIME_CONFIG__.getAccessToken`，Electron 通过隔离 preload 暴露的 `zhinaoDesktop.auth.getAccessToken` 接入企业登录组件。

当前完成的是资源服务端 Bearer 验证和三端令牌传输边界；Authorization Code + PKCE 跳转、回调处理、静默续期、MFA/step-up 和 IdP 全局注销仍需按企业 IdP SDK 实施。客户端不得自行解析 JWT 作为授权依据，也不得把 Token 中的角色或组直接映射为平台权限。

### 异步会话与 IAM 存储

`identity-session-service.js` 已改为 Promise-based Repository 端口并支持构造器注入；登录、校验、资料查询、过期/权限变更失效和注销均已异步化。默认 `IDENTITY_SESSION_STORE_DRIVER=runtime` 仍使用 SQLite/Memory 兼容适配器；执行 PostgreSQL migration 后可单独设置 `IDENTITY_SESSION_STORE_DRIVER=postgres`，先把分布式登录会话迁移到 PostgreSQL。启动时会检查 schema，运行就绪探针会检查数据库连通性。

`async-iam-store.js` 已实现 IAM 的 Promise-based Repository 端口，并在 PostgreSQL 契约测试中覆盖人员授权、角色策略、乐观版本冲突、Schema 迁移、审计，以及 IAM 聚合与领域事件 Outbox 的同库原子提交。事件契约校验失败时，权限变更与 Outbox 都会回滚。同步与异步实现共享 `iam-workspace-model.js` 的种子和 Schema 迁移规则，避免双轨漂移。

`IAM_STORE_DRIVER=postgres` 已接管运行时访问控制。API 每个请求先取得一致性 IAM 快照，角色目录、身份映射、页面和按钮权限、组织范围及权限管理都在该快照上计算；权限写入使用异步 Store，成功后刷新当前请求视图。数据库行锁事务同时保护乐观版本、最后管理账号约束和权限变更 Outbox。生产必须让 `DOMAIN_EVENT_STORE_DRIVER=postgres` 指向同一数据库，并使用 `sslmode=require|verify-ca|verify-full`。`RUNTIME_STORE_DRIVER=postgres` 仍被拒绝，因为模拟运行和治理等剩余领域聚合尚未完成迁移。

### 数据所有权

本模块唯一拥有 User、Organization、RolePolicy、UserRoleBinding、IdentitySession、IAMAudit。业务模块只能读取 `EffectiveAuthorizationContext`，不得读取 IAM 内部 seed 或自行解析角色。

`role-catalog-service.js` 是角色目录唯一读取边界：静态名称、颜色、条线等展示元数据必须与当前 IAM RolePolicy 合并后才成为有效角色。请求身份、授权、权限工作区和 `/api/roles` 均使用该投影；其他服务不得直接读取 `data/seed.js` 的 `roles`。

人员授权变更和角色策略发布分别产生 `iam.user.authorization_changed`、`iam.role_policy.published`，与 IAM 版本更新原子提交；消费者不得使用事件缓存绕过每请求实时权限计算。

### 核心链路

```text
凭据/SSO → 身份源适配 → 签发会话 → 每请求实时验证版本
→ 计算有效多角色 → 页面/按钮权限 → 组织范围 → 业务模块
```

### 目标结构

```text
modules/identity-access/
  api/{identity-routes,permission-routes,schemas}.js
  application/{login,resolve-access,assign-roles,save-policy}.js
  domain/{user,role-policy,data-scope,errors}.js
  infrastructure/{iam-repository,idp-adapter,session-store}.js
  index.js
```

### 边界规则

- 业务模块接收完整 identity context，不接收可伪造的 role 字符串作为唯一依据。
- 所有 `organizationIds` 都与同租户组织树验证；数据查询统一注入允许组织集。
- 会话只保存身份快照/版本，不永久缓存撤销前权限。
- 元域智营的权限矩阵不是策略引擎，策略真相位于服务端。

### 演进

身份会话和 IAM 已可分别灰度到 PostgreSQL；下一步是 tenant 列、外键、索引和 RLS，以及与企业主数据的增量同步。IdP 适配器仍需替换 Mock 登录；权限计算可独立为 PDP，但应用服务仍负责把决策落实到查询和写用例。

## 接口契约

2026-09-08：新增 `GET /api/auth/providers`，公开脱敏身份适配器目录。Bearer 请求支持 `x-identity-provider` 精确选择配置中的身份源；不指定时只采用已配置的默认项，失败不探测其他来源。新托管模式通过不可变 subject 绑定平台账号，钉钉原路由兼容。详见 [配置与接口边界](../../guides/IDENTITY_PROVIDER_ADAPTERS.md)。

受保护接口支持 `Authorization: Bearer <access_token>`。Bearer 必须由配置的企业 OIDC issuer 签发，并通过远程 JWKS、audience、有效期和算法白名单校验；服务端不会采信 Token 中的角色声明。

### 当前接口

| 方法 | 路径 | 权限/说明 |
| --- | --- | --- |
| GET | `/api/oa/connection` | Public；身份源状态 |
| GET | `/api/auth/dingtalk/config` | Public；仅配置就绪状态、CorpId、Client ID，不返回 secret 或成员映射 |
| POST | `/api/auth/dingtalk/login/challenge` | Public；精确来源、设备和钉钉客户端类型绑定，120 秒一次性挑战 |
| POST | `/api/auth/dingtalk/login` | Public；`{challengeId,code,corpId}`，服务端验证免登码并映射 IAM 账号 |
| POST | `/api/auth/local/login` | Public；`{account,password}`，Demo only |
| POST | `/api/auth/oa/login` | Public；OA Mock/适配登录 |
| GET | `/api/auth/oa/session` | 当前会话与设备校验 |
| POST | `/api/auth/oa/logout` | 注销当前会话 |
| POST | `/api/session/device` | 注册设备会话 |
| GET | `/api/account-center` | 需认证及 `page.config.view` |
| GET | `/api/access/me` | 当前主体有效角色、菜单、页面、按钮、组织范围 |
| GET | `/api/permission-center` | 权限摘要，`page.config.view` |
| GET | `/api/permission-management` | `page.permissions.view` |
| POST | `/api/permission-management/users/:id/roles` | `permission.user.assign` |
| POST | `/api/permission-management/roles/:id/policy` | `permission.policy.save` |
| GET | `/api/roles`、`/api/modules` | Demo 公共目录；角色由 IAM 策略实时投影，包含 policyVersion 和权限摘要 |

### 关键请求

钉钉请求须带 `x-client-platform=dingtalk-mobile` 或 `dingtalk-pc`、`x-client-version=0.3.0`、`x-client-device-id` 和精确 Origin。钉钉客户端即使在开发环境也不采用 Demo 角色头兜底。成功后使用 `x-identity-session` 调用原有业务 API，会话及注销复用既有接口。未配置返回 503，来源或账号映射不满足要求返回 403，失效挑战/重放返回 401，上游验证失败返回脱敏的 502。部署及边界见 [钉钉指南](../../guides/DINGTALK_INTEGRATION.md)。

角色分配：

```json
{
  "expectedVersion": 3,
  "roleBindings": [
    { "roleId": "quality_manager", "scopeMode": "current_org", "organizationIds": [] }
  ]
}
```

角色策略：

```json
{
  "expectedVersion": 5,
  "menuIds": ["risks"],
  "pagePermissionIds": ["page.risks.view"],
  "buttonPermissionIds": ["risk.detail.view", "risk.acknowledge"],
  "dataScope": { "mode": "org_and_descendants", "organizationIds": [] }
}
```

### 关键错误码

`IDENTITY_USER_INACTIVE`、`IDENTITY_ROLE_REVOKED`、`IDENTITY_AUTHORIZATION_STALE`、`PAGE_PERMISSION_DENIED`、`BUTTON_PERMISSION_DENIED`、`VERSION_CONFLICT`、`LAST_ADMIN_GUARD`、`DATA_SCOPE_ORGANIZATION_OVERRIDE`。

### 目标改进

- 将 `/auth/oa/session` 泛化为 `/auth/session`，旧路径保留兼容期。
- 新增用户/组织 CRUD、策略草稿/发布和游标分页。
- 在 `api-contracts` 固化 `EffectiveAuthorizationContext` Schema。
- 登录限流、MFA challenge、会话撤销和 IdP webhook 使用独立契约。

## 开发约束与验证

企业 Bearer 验证必须通过 `enterprise-oidc-service.js`；不得解析未验证 JWT，不得采信 Token 内 role/group 作为平台权限。账号映射后始终重新读取 IAM 人员、角色策略和组织数据范围。

### 修改前必读

`backend/src/domains/identity/public-api.js`、`domains/iam/public-api.js`、`routes/identity-routes.js`、`permission-routes.js`、`services/access-control-service.js`、`services/identity-session-service.js`、`services/permission-management-service.js`、`services/iam-workspace-model.js`、`services/async-iam-store.js`、`data/iam-seed.js`。HTTP 层只能从领域 public-api 导入。

### 不可破坏约束

- 真实未知主体 fail-closed；Demo fallback 仅非生产 `demo_header`。
- 人员、角色或策略版本变化必须使旧会话失效。
- 身份会话服务必须保持异步 Repository 端口；新增调用方必须 `await`，不得重新直接依赖同步状态仓。
- IAM 同步/异步实现必须共享 `iam-workspace-model.js`；异步人员/策略变更和 Outbox 必须通过同一 Repository 的 `mutateStates` 原子提交。所有 IAM 读取者迁移完成前，不得开放 IAM 或总 PostgreSQL 驱动开关。
- 多角色动作必须选择一个真实持有按钮权限的有效角色。
- self/current org/descendants 不能被客户端 `organizationIds` 覆盖。
- 不能自我提权、越租户或移除最后一个超级管理员。
- 401/权限类 403 必须保留稳定 `code`，供客户端 fail-closed。

### 常用验证

```powershell
npm.cmd run test:permissions
npm.cmd run test:security
npm.cmd run build -w frontend
```

### 修改完成检查

同步更新权限目录 seed、后端门禁、前端显隐、API 文档和允许/拒绝成对测试。不要只修改前端权限矩阵。

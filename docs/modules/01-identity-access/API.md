# 身份与访问控制 API

2026-09-08：新增 `GET /api/auth/providers`，公开脱敏身份适配器目录。Bearer 请求支持 `x-identity-provider` 精确选择配置中的身份源；不指定时只采用已配置的默认项，失败不探测其他来源。新托管模式通过不可变 subject 绑定平台账号，钉钉原路由兼容。详见 [配置与接口边界](../../guides/IDENTITY_PROVIDER_ADAPTERS.md)。

受保护接口支持 `Authorization: Bearer <access_token>`。Bearer 必须由配置的企业 OIDC issuer 签发，并通过远程 JWKS、audience、有效期和算法白名单校验；服务端不会采信 Token 中的角色声明。

## 当前接口

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

## 关键请求

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

## 关键错误码

`IDENTITY_USER_INACTIVE`、`IDENTITY_ROLE_REVOKED`、`IDENTITY_AUTHORIZATION_STALE`、`PAGE_PERMISSION_DENIED`、`BUTTON_PERMISSION_DENIED`、`VERSION_CONFLICT`、`LAST_ADMIN_GUARD`、`DATA_SCOPE_ORGANIZATION_OVERRIDE`。

## 目标改进

- 将 `/auth/oa/session` 泛化为 `/auth/session`，旧路径保留兼容期。
- 新增用户/组织 CRUD、策略草稿/发布和游标分页。
- 在 `api-contracts` 固化 `EffectiveAuthorizationContext` Schema。
- 登录限流、MFA challenge、会话撤销和 IdP webhook 使用独立契约。

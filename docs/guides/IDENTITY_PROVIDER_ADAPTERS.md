# 企业身份源与权限适配指南

更新：2026-09-17。适用于智脑、钉钉 H5 和语义运营共用的 API。已补齐IAM工作区租户隔离及认证链路回归，不代表真实企业单点登录或门户自动开通已验收。

## 租户绑定与升级注意事项

人员、组织、角色策略、权限版本和IAM审计现在按租户保存。存储中的 `demo-enterprise` 仍使用旧 `iam/workspace`，其他租户使用包含租户ID的独立键。新企业的工作区为空，不复制演示人员、组织或管理员权限。

认证与授权顺序：

1. OIDC先验签并核对发行方、受众和企业声明，再使用服务端身份源配置中的平台 `tenantId` 查找该租户账号；钉钉先验证企业免登码，再使用服务端配置的租户和成员绑定查找账号。
2. 不透明会话从服务端记录恢复租户。请求头、请求体中的租户ID和外部管理员标志不能选择IAM工作区。
3. HTTP页面、按钮和业务权限在该租户的请求级快照中计算；同时绑定相同租户的语义工作区。显式绑定后不能在同一上下文切换到其他租户。
4. 会话记录绑定租户、用户版本及角色策略版本。人员停用、角色或策略变更会在**下一次会话验证**时拒绝并删除旧会话；其他租户的同名账号不受影响。

这次升级会使没有租户授权绑定的旧会话失效，需要重新登录。原先非Demo身份源若只映射到全局演示账号，升级后会被拒绝；这属于修复，不能通过把新租户改成Demo租户来规避。正式切换前需完成企业自己的人员、组织、角色策略和不可变subject绑定，并用独立测试账号验证。

已提供部署人员使用的[沙箱审核式IAM初始化/账号映射流程](TENANT_RUNTIME_CONTROL.md)，支持OIDC和钉钉映射、摘要确认与原子写入；没有把门户owner或付费记录直接变成业务管理员的接口。不要直接修改生产数据库或复制测试夹具来开通。完整企业开通预检中的业务IAM仍阻断，见[开通指南](PORTAL_RUNTIME_PROVISIONING.md)。

后台Worker或内部调用必须显式恢复可信租户上下文后再读取IAM；缺少正确上下文的非Demo身份不能继续读取Demo权限。编排步骤与语义巡检已接入执行前/结果采纳前复验，已登记沙箱的门户停用和成员变化会阻止后续准入。真实PostgreSQL多租户RLS、全部Worker贯通、已发出外部请求的撤回、完整在途任务停机和商业计费联动仍未验收。

## 设计边界

身份来源不再与钉钉绑定。平台分三层处理：

```text
钉钉免登 / 企业 OIDC / 后续专用适配器
                    ↓ 验证外部身份
身份源 ID + 外部 subject → 服务端配置租户内的平台账号
                    ↓ 查询平台 IAM
账号状态、角色、页面权限、数据范围、执行确认与审计
```

钉钉的管理员、外部 Token 中的 roles/groups、邮箱和姓名都不能直接变成平台权限。运营端建模、发布权限与业务端数据访问仍分别校验。外部平台负责认证，平台 IAM 负责授权。

同一员工可以从不同身份源绑定到同一租户中的平台账号，不必为每个入口复制角色。相同租户和平台账号可以延续原有任务与记忆范围。不同身份源的相同subject不自动视为同一个人，须逐项配置绑定。IAM应用层租户隔离已实现，但企业开户、商业权益、在途撤权和数据库生产隔离仍不完整。

## 已支持与未支持

按终端部署见 [各端接入指南](CLIENT_ACCESS_GUIDE.md)，按国内平台准备见 [协同平台接入指南](DOMESTIC_PLATFORM_ACCESS_GUIDE.md)。后者包含钉钉、企业微信、飞书、WeLink、WPS 365 的准备及开发边界，不代表这些专用协议均已实现。

| 接入方式 | 当前实现 | 还需要什么 |
| --- | --- | --- |
| 钉钉 | 企业 H5 免登、账号绑定、会话校验；手机和 PC 共用入口 | 企业应用凭据、HTTPS 入口、成员绑定及真机验收 |
| 企业 OIDC | 可配置多个 issuer；验签、audience、有效期、subject 绑定；两端 SDK 可选择身份源 | 可信 issuer/JWKS、API audience、账号绑定，以及宿主提供的合法访问令牌 |
| 企业微信、飞书等专用协议 | 已有统一适配器边界，未实现其专用免登 API | 新增相应服务端验码及宿主登录适配器；不能只改平台名称 |
| LDAP/AD、SAML | 未实现直接登录适配器 | 企业可自行提供 OIDC 联邦出口，或另行开发协议适配 |
| 外部组织、角色同步 | 不自动同步，不自动赋权 | 后续应通过受审计的 IAM 管理流程导入、审批及回收 |

OIDC 当前实现的是 API Bearer 验证，不是完整的浏览器授权码、PKCE、刷新令牌或身份平台全局注销流程。应用宿主需要提供这些登录生命周期能力。钉钉的原生协议也不会因为启用 OIDC 就自动被覆盖。

## 配置准备

使用仓库内 [配置样例](../../config/identity-providers.example.json)，填写后保存在仓库外，例如 `D:\wsl\private\yuanyu-zhinao\identity-providers.json`。不要把真实绑定表、应用密钥或访问令牌提交到项目。

每个 OIDC 身份源需要：

1. 固定的 `id` 和显示名称 `name`，例如 `company-sso`。上线后不要随意修改 ID。
2. 完全匹配的 `issuer`、可信 HTTPS `jwksUri`、本 API 的 `audience`。
3. 平台 `tenantId`。同一企业多个入口应使用一致的平台租户范围。
4. `bindings`：已经核实的外部 `subject` 与已有平台 `account`。不按邮箱或显示名称自动合并账号。
5. 可选 `tenantClaim` 与 `externalTenantId`，必须成对设置。例如多企业发行方通过 `tid` 区分企业时，设置需要接受的准确值。这里的外部企业 ID 与平台 tenantId 分开；标准 OIDC 没有 tid 时不必虚构该声明。

`defaultBearerProviderId` 是未指定请求头时唯一采用的 OIDC 身份源。设为 null 时，Bearer 请求必须带准确的 `x-identity-provider`。验证失败不会尝试其他身份源。

钉钉使用固定 `id: dingtalk`、`type: dingtalk`。在清单中启用后，还需按 [钉钉指南](DINGTALK_INTEGRATION.md) 配置 `DINGTALK_ENABLED` 和服务端 `DINGTALK_CONFIG_FILE`。目前只支持这一个钉钉应用配置，不支持同时挂多家企业钉钉应用。

API 启动环境配置：

```powershell
$env:IDENTITY_PROVIDERS_FILE = 'D:\wsl\private\yuanyu-zhinao\identity-providers.json'
$env:DEMO_ALLOW_ROLE_HEADER = 'false'
```

配置了 `IDENTITY_PROVIDERS_FILE` 即进入托管身份模式：清单之外的身份源不会生效，OA/本地 Mock 登录和 Demo 角色回退均关闭，包括开发环境。配置损坏也不会回退。正式部署仍须满足现有 KMS、持久化、CORS、运行模式等生产门禁；钉钉挑战仍要求单节点。

不设置此变量时保留旧的单 OIDC 环境变量和钉钉配置兼容行为。旧 OIDC 模式仍按原来的账号声明映射；建议新接入采用上述显式 subject 绑定。身份模式首次切换需要重启 API；之后外部绑定在后续请求中重新读取，配置变更应使用完整文件的原子替换，并在所有节点同步。

## 客户端与服务端接口

智脑和语义运营 SDK 均接受 `identityProviderId`，也可从 `__ZHINAO_RUNTIME_CONFIG__.identityProviderId` 读取。`getAccessToken` 应返回企业宿主取得的访问令牌；浏览器不保存应用密钥。

```javascript
const client = createAgentClient({
  identityProviderId: 'company-sso',
  accessTokenProvider: () => enterpriseHost.getAccessToken(),
  role: null
});
```

示例中的 enterpriseHost 由企业宿主实现，不是仓库内置登录 SDK。语义端使用 `createSemanticOperationsClient`，参数相同。切换身份源应销毁旧客户端并重新初始化；缓存按身份源隔离，令牌不写入 localStorage。

- `GET /api/auth/providers`：返回已启用适配器的名称、类型、能力、配置状态及默认 Bearer 身份源，不返回 issuer、账号绑定、文件路径或密钥。
- Bearer 请求：`Authorization: Bearer ...`，可带 `x-identity-provider: company-sso`。该请求头只选择服务端白名单，不证明身份。
- 钉钉继续使用原有 config/challenge/login 接口，保持现有 H5 兼容。
- 内部会话带有外部身份来源。身份源、应用或账号绑定失效会撤销会话；平台停用账号、回收角色、修改权限版本仍会触发原有校验。

仅改变某个外部平台自己的权限不会自动修改平台 IAM。停用员工时，需要同步停用平台账号或删除对应绑定；否则已有有效外部 Token 可能在到期前仍通过验证。即时目录停用通知、Token introspection、全局单点注销属于后续企业集成范围。

## 后续接入新平台的开发位置

服务端适配器契约位于 `backend/src/services/identity-provider-registry.js`；内置组合位于 `identity-provider-service.js`。适配器负责验证外部凭据及绑定，统一会话服务只调用 `validateSessionBinding`，不再包含钉钉配置判断。

新增协议时：增加服务端配置校验和适配器、必要的公开登录路由及限流，再由客户端宿主提供登录函数。不要让浏览器提交任意 issuer/JWKS 地址，不要通过字符串加载任意模块。新协议必须补充跨身份源、跨企业、撤销绑定、重放、权限提升和失败不降级测试，再加入生产启动门禁。

验收准备：普通业务用户、运营用户、管理员、未绑定用户和停用用户各一组；核对各端数据范围、运营发布权限、切换身份后的任务记录和撤销绑定效果。已有本地证据见 [适配测试报告](../development/IDENTITY_PROVIDER_ACCEPTANCE_2026-09-08.md)。

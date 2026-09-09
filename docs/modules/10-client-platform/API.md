# 多端客户端 API 与 SDK 契约

## 共享包

- `@healthcare-ai/agent-sdk`：认证会话、设备标识、Agent/通知/证据 API；
- `@healthcare-ai/agent-workbench`：Web/Electron/移动端共享 Vue 工作台；
- `frontend/src/api/client.js`：管理 Web API 客户端。

SDK 自动携带 `x-client-platform`、`x-client-version`、稳定设备 ID 和身份会话。默认使用同源 `/api`；桌面容器可通过安全 bridge/显式配置覆盖，禁止把 `file://` 等非 HTTP origin 当 API。

企业客户端可向 `createAgentClient` 传入 `accessTokenProvider: async () => token`，或由宿主提供 `__ZHINAO_RUNTIME_CONFIG__.getAccessToken` / `zhinaoDesktop.auth.getAccessToken`。SDK 每次请求即时读取令牌并发送 `Authorization: Bearer …`；存在身份会话时不同时发送 Bearer，存在 Bearer 时不发送 `x-demo-role`。`setEnterpriseAccessToken` 只保存进程内短时值，`clearEnterpriseAccessToken` 会抑制宿主 Provider，直到重新创建客户端或显式设置新 Token。

`enterpriseSession()` 只有在 Provider 实际返回非空 Token 时才调用 `GET /api/access/me`，否则以 `OIDC_TOKEN_MISSING` 失败关闭，避免开发环境误走 Demo 默认身份。它使用服务端已验证主体与实时 IAM 投影初始化工作台，绝不从客户端解析 Token 中的 role/group。

SDK 的错误对象至少包含 `status`、`code`、`message`，权限类错误触发授权失效事件，但不自动重试写请求。

## 目标契约

- API client 从 `packages/api-contracts` 生成类型/Schema，保留薄封装用于会话和设备头。
- Admin 和 Agent SDK 分包，避免管理接口进入员工客户端 bundle。
- Event Stream SDK 支持 `run.updated`、`trace.appended`、`alert.received`、`permission.changed`，带 cursor 断线续传。
- Electron bridge 仅允许 `getApiBaseUrl/openExternal/getAppVersion` 等 allowlist 能力。

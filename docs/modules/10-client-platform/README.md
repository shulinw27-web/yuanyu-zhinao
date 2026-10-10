# 多端客户端模块说明

本页集中维护需求、架构、接口和开发约束；“当前”与“目标”沿用原说明，不因合并改变完成状态。

## 需求与验收

### 目标

提供四种一致体验：运营治理元域智营、浏览器智脑、Electron 智脑、移动智脑。Agent 能力共享 SDK 和 Workbench，业务真相与权限始终在服务端。

### 核心需求

- 元域智营按页面懒加载，按有效菜单+页面权限导航，按钮按权限显示。
- 桌面 Web、Electron、移动端共享任务、对话、证据、告警、待办、附件和确认协议。
- 多任务响应回填原任务，切换任务不串消息；权限撤销后清缓存并 fail-closed。
- Electron 使用安全容器、同源/明确 API 地址、外链系统浏览器打开，不暴露 Node 能力。
- 移动端适配小屏任务切换、语音/附件、告警和高风险确认。
- 所有客户端展示完整证据引用和 trace integrity，不宣称模型建议已执行。

### 验收标准

三端共享协议构建通过；401/权限类 403 不重试原写请求并触发 access 刷新；旧权限代际响应不能回填；Electron `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`；客户端不保存模型/系统/KMS 密钥。

## 架构与实现

### 当前结构

```text
frontend/                 元域智营，Vue/Vite
apps/desktop/             桌面 Web + Electron 容器
apps/mobile/              移动 Web/Tauri 容器
packages/agent-sdk/       Agent API 客户端
packages/agent-workbench/ 三端共享交互
```

元域智营的页面查询注册位于 `page-data-registry.js`；`app-actions.js` 只组合 `actions/risk-procurement-actions.js`、`agent-actions.js`、`governance-actions.js` 和 `administration-actions.js`。`App.vue` 已从 667 行降到约 400 行，只保留壳层、授权生命周期、页面协调和状态绑定。Agent 三端继续共享 Workbench。

### 状态边界

服务端拥有任务、run、权限、告警和业务状态；客户端只保存 UI 草稿、当前任务、展示缓存和稳定设备 ID。缓存 key 必须包含 subject/role/access generation，注销后清除。

### 企业认证通道

元域智营和共享 Agent SDK 使用同一优先级：统一身份会话优先，企业 Bearer 次之，非生产 Demo 角色头最后。企业 Token 只能由宿主的异步 Provider 或短时内存注入，不能落入 localStorage、URL、日志或错误对象。共享 Workbench 能以 `/access/me` 初始化 OIDC 用户及实时 IAM 权限；退出时清空内存态并调用可选的企业注销回调。

浏览器宿主使用运行时 `getAccessToken` 回调，避免将 Token 作为全局字符串暴露；Electron 只能通过 context-isolated preload allowlist 提供同名能力，主进程应把 refresh token 交给操作系统凭据库或企业认证 SDK 保管。

### Electron/Tauri

容器只提供最小桥接；启用 CSP、上下文隔离、沙箱、签名更新和外链白名单。生产增加代码签名、自动更新签名验证、企业证书分发和 OS 凭据库。不得把 refresh token 通过普通 IPC 广播给渲染进程。

### 测试

共享 Workbench 建立组件测试和三端契约套件；元域智营补页面 loader 的取消/权限撤销竞态测试；Electron 增加安全配置静态检查。

## 接口契约

### 共享包

- `@healthcare-ai/agent-sdk`：认证会话、设备标识、Agent/通知/证据 API；
- `@healthcare-ai/agent-workbench`：Web/Electron/移动端共享 Vue 工作台；
- `frontend/src/api/client.js`：元域智营 API 客户端。

SDK 自动携带 `x-client-platform`、`x-client-version`、稳定设备 ID 和身份会话。默认使用同源 `/api`；桌面容器可通过安全 bridge/显式配置覆盖，禁止把 `file://` 等非 HTTP origin 当 API。

企业客户端可向 `createAgentClient` 传入 `accessTokenProvider: async () => token`，或由宿主提供 `__ZHINAO_RUNTIME_CONFIG__.getAccessToken` / `zhinaoDesktop.auth.getAccessToken`。SDK 每次请求即时读取令牌并发送 `Authorization: Bearer …`；存在身份会话时不同时发送 Bearer，存在 Bearer 时不发送 `x-demo-role`。`setEnterpriseAccessToken` 只保存进程内短时值，`clearEnterpriseAccessToken` 会抑制宿主 Provider，直到重新创建客户端或显式设置新 Token。

`enterpriseSession()` 只有在 Provider 实际返回非空 Token 时才调用 `GET /api/access/me`，否则以 `OIDC_TOKEN_MISSING` 失败关闭，避免开发环境误走 Demo 默认身份。它使用服务端已验证主体与实时 IAM 投影初始化工作台，绝不从客户端解析 Token 中的 role/group。

SDK 的错误对象至少包含 `status`、`code`、`message`，权限类错误触发授权失效事件，但不自动重试写请求。

### 目标契约

- API client 从 `packages/api-contracts` 生成类型/Schema，保留薄封装用于会话和设备头。
- Admin 和 Agent SDK 分包，避免管理接口进入员工客户端 bundle。
- Event Stream SDK 支持 `run.updated`、`trace.appended`、`alert.received`、`permission.changed`，带 cursor 断线续传。
- Electron bridge 仅允许 `getApiBaseUrl/openExternal/getAppVersion` 等 allowlist 能力。

## 开发约束与验证

入口：`frontend/src/App.vue`、`page-data-registry.js`、`app-actions.js`、`api/client.js`、`permission-navigation.js`、`packages/api-contracts`、`packages/agent-sdk`、`packages/agent-workbench`、`apps/desktop`、`apps/mobile`。

不可破坏：三端 Agent 功能协议一致；服务端为授权真相；权限代际变化丢弃旧响应；401/权限 403 不重试原写；任务响应回填原 conversation；附件/证据/command 字段兼容；Electron 不开放 Node 或任意 shell/URL；不在客户端存密钥。

验证：

```powershell
npm.cmd run test:permissions
npm.cmd run build -w frontend
npm.cmd run build:desktop
npm.cmd run build:mobile
```

修改 Workbench 时必须同时检查桌面与移动布局；修改 SDK 错误契约时检查元域智营的授权失效逻辑。

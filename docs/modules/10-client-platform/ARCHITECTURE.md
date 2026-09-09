# 多端客户端技术架构

## 当前结构

```text
frontend/                 管理 Web，Vue/Vite
apps/desktop/             桌面 Web + Electron 容器
apps/mobile/              移动 Web/Tauri 容器
packages/agent-sdk/       Agent API 客户端
packages/agent-workbench/ 三端共享交互
```

管理 Web 的页面查询注册位于 `page-data-registry.js`；`app-actions.js` 只组合 `actions/risk-procurement-actions.js`、`agent-actions.js`、`governance-actions.js` 和 `administration-actions.js`。`App.vue` 已从 667 行降到约 400 行，只保留壳层、授权生命周期、页面协调和状态绑定。Agent 三端继续共享 Workbench。

## 状态边界

服务端拥有任务、run、权限、告警和业务状态；客户端只保存 UI 草稿、当前任务、展示缓存和稳定设备 ID。缓存 key 必须包含 subject/role/access generation，注销后清除。

## 企业认证通道

管理 Web 和共享 Agent SDK 使用同一优先级：统一身份会话优先，企业 Bearer 次之，非生产 Demo 角色头最后。企业 Token 只能由宿主的异步 Provider 或短时内存注入，不能落入 localStorage、URL、日志或错误对象。共享 Workbench 能以 `/access/me` 初始化 OIDC 用户及实时 IAM 权限；退出时清空内存态并调用可选的企业注销回调。

浏览器宿主使用运行时 `getAccessToken` 回调，避免将 Token 作为全局字符串暴露；Electron 只能通过 context-isolated preload allowlist 提供同名能力，主进程应把 refresh token 交给操作系统凭据库或企业认证 SDK 保管。

## Electron/Tauri

容器只提供最小桥接；启用 CSP、上下文隔离、沙箱、签名更新和外链白名单。生产增加代码签名、自动更新签名验证、企业证书分发和 OS 凭据库。不得把 refresh token 通过普通 IPC 广播给渲染进程。

## 测试

共享 Workbench 建立组件测试和三端契约套件；管理 Web 补页面 loader 的取消/权限撤销竞态测试；Electron 增加安全配置静态检查。

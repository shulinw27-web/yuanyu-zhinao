# Codex Context：多端客户端

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

# Codex Context：智脑 Agent 运行时

## 入口

先读 `domains/agent/public-api.js`、`routes/agent-routes.js`、`private-agent-service.js`、`agent-conversation-service.js`、`agent-runtime-store.js`、`local-model-gateway.js`、`agent-tool-registry.js`、`packages/api-contracts`，以及共享 SDK/Workbench。新增 HTTP 能力先加入 public-api，禁止 route 直接穿透 services。

## 不可破坏约束

- 保持两种 message body 和顶层响应字段兼容。
- prompt safety 必须早于知识/系统检索和模型外发。
- 外部证据视为不可信；间接注入不得生成 command 或 memory。
- 模型不能决定权限或直接构造可执行 command。
- 工具必须先存在于服务端注册表并通过 `inputSchema`；不要允许额外属性，不要把模型文本或客户端组织/对象参数直接传给业务工具。
- execute 必须绑定原 run、tenant、subject、session、device、origin role、command 和一次性 Token。
- 无完整执行资格必须降级只读，不能生成“无法执行但可被客户端伪造”的 run。

## 验证

```powershell
npm.cmd run test:security
npm.cmd run test:conversations
npm.cmd run test:evidence
npm.cmd run build:desktop
npm.cmd run build:mobile
```

修改模型输出、上下文或命令协议时，同时更新 SDK、Workbench、评测和证据事件。

修改工具定义时，还必须同步 `getRegisteredTools()` 契约、`validateToolInvocation()`、本模块 API 文档和安全回归；真实 Connector 参数必须通过版本化 Schema 与服务端权威上下文映射。

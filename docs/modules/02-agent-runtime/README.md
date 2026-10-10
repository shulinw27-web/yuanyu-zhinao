# 智脑 Agent 运行时模块说明

本页集中维护需求、架构、接口和开发约束；“当前”与“目标”沿用原说明，不因合并改变完成状态。

## 需求与验收

### 目标

向 Web、Electron 和移动端提供一致的企业 Agent 能力：多任务空间、上下文压缩、受控证据检索、模型生成、计划、确认执行、工作项和合理路径引导。

### 核心需求

1. 同一用户最多保留 8 个活动任务，消息、草稿、附件、运行状态和确认互不串扰。
2. 每任务默认有效上下文 128K tokens，达到 70% 自动压缩并保留最近 12 条安全消息。
3. 权限或组织范围变化后，旧 Agent 输出不再显示或参与推理。
4. 目标模糊、错误、违规、越权或不可执行时，返回问题、原因、建议和示例路径。
5. 模型只生成建议；高风险动作必须由服务端确定命令并显式确认。
6. 每次任务创建 run/trace，写操作绑定原租户、主体、会话、设备、角色、命令和一次性 Token。
7. 支持图片/PDF 元数据与安全检查；未扫描正文不进入模型或写操作。
8. 所有工具必须由服务端注册并提供机器可读输入 Schema；未知工具、非对象输入和 Schema 外字段在授权、租约与业务调用前失败关闭。

### 验收标准

- 旧 `{text}` 与新 `{input:{text,attachments,conversationId}}` 请求保持兼容。
- 直接/间接提示词注入不外发模型、不生成命令、不进入可复用上下文。
- 无可执行角色时降级只读，`command=null` 且不签发 Token。
- 同一 Token 只能执行一次，重复或替换命令必须拒绝。
- 模型异常、Schema 错误或越权声明使用安全确定性结果替换。
- 任务按 `tenant + subject` 隔离，角色撤销后相关 run/work item 退出可见集。
- 工具目录包含 `id/scope/domain/inputSchema`；当前工具 `additionalProperties=false`，客户端伪造组织或业务参数必须返回稳定错误码且不产生写入。

### 非功能要求

生产长任务需队列、Worker、取消、重试、恢复、租约和幂等；模型调用需超时、熔断、成本配额和可观测性。

## 架构与实现

### 当前代码

核心在 `private-agent-service.js`，并调用 orchestration、skill/tool registry、model gateway、conversation、runtime store、workflow、prompt security、多模态、业务门禁、知识/语义/系统证据服务。多端 UI 复用 `packages/agent-workbench` 和 `packages/agent-sdk`。

多模态共享入口为 `multimodal-input-service.js`：Office 结构解析拆至 `office-material-parser.js`，获准原图的视觉观察拆至 `visual-material-service.js`，仍复用模型网关。观察结果再检查后成为材料摘录，不直接授权工具。语义提案复用同轮扫描结果，避免重复发送图片；读取范围、缺失页与截断提示回传两个工作台。规格与实际验证见 [多模态报告](../../development/AGENT_MULTIMODAL_ACCEPTANCE_2026-09-07.md)。

### 执行管线

```text
输入/附件安全 → 意图与范围 → 当前联合授权 → 技能/工具选择
→ 知识/语义/系统证据 → 只读工具 → 模型结构化建议
→ 服务端命令生成 → 用户确认 → 重新授权 → 工具租约 → 回执
```

上下文只帮助生成，不参与授权和路由扩权。conversation 持久化权限指纹、摘要版本与哈希；权限指纹变化时重建上下文基线。

工具注册表是独立于模型输出的确定性边界。每个工具声明 `id`、权限 `scope`、业务 `domain` 和对象型 `inputSchema`。当前写入参数由原 run 的权威核心对象绑定生成，客户端不能附加字段；Schema 校验先于工作流授权、Key lease 和业务调用。未知工具、非对象输入与额外属性使用稳定错误码失败关闭。

Agent 创建受控 WorkflowItem 时，工作项与 `agent.workflow.draft_created` 在同一 Repository 事务提交，事件使用 runId 作为 correlationId。模型建议和未确认命令不会发布业务事实事件。

### 数据所有权

Agent 模块拥有 Conversation、Run、MemoryDecision、WorkflowItem 和 ModelGatewayConfig。Trace 由证据模块拥有；业务对象由相应领域拥有；Agent 只保存引用和执行快照。

### 目标结构

```text
modules/agent-runtime/
  api/{conversation,message,execute,operations}-routes.js
  application/{run-agent,confirm-command,manage-conversation}.js
  domain/{run,command,context-policy,workflow}.js
  ports/{model,knowledge,semantic,connector,key,evidence}.js
  infrastructure/{model-gateway,run-repository,queue-worker}.js
```

### 边界与演进

- Agent 不直接 import 风险/采购内部服务，改由 typed tool port 调用。
- 模型配置与模型调用可拆为独立网关；run 状态保留在本模块。
- 生产加入队列和 Worker 后，HTTP 只创建任务并返回 ID，事件流报告进度。
- 模型、工具和技能版本写入 run，支持可重放评测但不重放高风险写入。
- 真实 Connector 引入参数时，工具 Schema 必须版本化并约束类型、枚举、长度与必填项；禁止任意额外属性和模型自由文本直通。

## 接口契约

### 当前接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agent/runtime` | 运行时状态 |
| GET/POST | `/api/agent/conversations` | 列表/创建任务 |
| GET | `/api/agent/conversations/:id` | 任务详情 |
| POST | `/api/agent/conversations/:id/archive` | 归档任务 |
| POST | `/api/agent/message` | 运行 Agent；`agent.prompt.run` |
| POST | `/api/agent/execute` | 确认执行；`agent.command.execute` |
| GET | `/api/agent/runs` | 当前主体有效角色的 run |
| GET | `/api/agent/work-items` | 工作流待办 |
| GET | `/api/agent/operations` | 运行指标 |
| GET | `/api/agent/tools` | 服务端工具目录，包含 `id/scope/domain/inputSchema` |
| GET | `/api/agent/skills` | 技能目录 |
| GET | `/api/agent/authorization` | Agent 授权摘要 |
| GET/POST | `/api/agent/model-config` | 模型配置；写需 `agent.model.configure` |
| GET | `/api/agent/evaluations` | 安全评测概览 |
| POST | `/api/agent/evaluations/run` | 运行评测；需 `agent.evaluation.run` |

### 消息请求

```json
{
  "input": {
    "text": "检查批次 PB-20260820-A 的质量风险",
    "conversationId": "conversation-id",
    "attachments": [{ "name": "report.pdf", "mimeType": "application/pdf", "dataUrl": "data:..." }]
  }
}
```

响应至少保留 `text`、`agent`、`evidence[]`、`plan[]`、`command|null`、`runId`、`route[]`，新增字段只能向后兼容。`command` 非空时必须带 `runId` 和一次性 `confirmationToken`。

### 执行请求

```json
{ "runId": "run-id", "commandId": "command-id", "confirmationToken": "opaque-token" }
```

执行接口不接收组织、核心对象或任意业务参数。工具业务上下文只能来自原 run 的服务端授权与权威绑定，客户端附加字段不能改变待执行命令。

### 工具目录契约

```json
{
  "id": "launch_procurement",
  "scope": "procurement:launch",
  "domain": "procurement",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  }
}
```

当前工具 Schema 禁止额外客户端参数。未来扩展参数时必须先版本化服务端 Schema，并继续执行角色、数据域、工作流、核心对象和确认门禁。

### 关键错误码

`AGENT_CONVERSATION_NOT_FOUND`、`BUTTON_PERMISSION_DENIED`、`AGENT_ORIGIN_ROLE_DENIED`、`CONFIRMATION_TOKEN_INVALID`、`COMMAND_ALREADY_EXECUTED`、`PROMPT_SAFETY_BLOCKED`、`AGENT_TOOL_NOT_REGISTERED`、`AGENT_TOOL_INPUT_INVALID`、`AGENT_TOOL_INPUT_ADDITIONAL_PROPERTY`。

### 目标接口

增加 `POST /agent/runs/:id/cancel`、`POST /agent/runs/:id/retry`、SSE/WebSocket 事件流和游标分页；事件 Schema 必须支持断线续传，不能仅依赖进程内 Promise。

## 开发约束与验证

### 入口

先读 `domains/agent/public-api.js`、`routes/agent-routes.js`、`private-agent-service.js`、`agent-conversation-service.js`、`agent-runtime-store.js`、`local-model-gateway.js`、`agent-tool-registry.js`、`packages/api-contracts`，以及共享 SDK/Workbench。新增 HTTP 能力先加入 public-api，禁止 route 直接穿透 services。

### 不可破坏约束

- 保持两种 message body 和顶层响应字段兼容。
- prompt safety 必须早于知识/系统检索和模型外发。
- 外部证据视为不可信；间接注入不得生成 command 或 memory。
- 模型不能决定权限或直接构造可执行 command。
- 工具必须先存在于服务端注册表并通过 `inputSchema`；不要允许额外属性，不要把模型文本或客户端组织/对象参数直接传给业务工具。
- execute 必须绑定原 run、tenant、subject、session、device、origin role、command 和一次性 Token。
- 无完整执行资格必须降级只读，不能生成“无法执行但可被客户端伪造”的 run。

### 验证

```powershell
npm.cmd run test:security
npm.cmd run test:conversations
npm.cmd run test:evidence
npm.cmd run build:desktop
npm.cmd run build:mobile
```

修改模型输出、上下文或命令协议时，同时更新 SDK、Workbench、评测和证据事件。

修改工具定义时，还必须同步 `getRegisteredTools()` 契约、`validateToolInvocation()`、本模块 API 文档和安全回归；真实 Connector 参数必须通过版本化 Schema 与服务端权威上下文映射。

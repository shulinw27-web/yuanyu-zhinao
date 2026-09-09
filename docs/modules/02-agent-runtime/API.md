# 智脑 Agent 运行时 API

## 当前接口

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

## 消息请求

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

## 执行请求

```json
{ "runId": "run-id", "commandId": "command-id", "confirmationToken": "opaque-token" }
```

执行接口不接收组织、核心对象或任意业务参数。工具业务上下文只能来自原 run 的服务端授权与权威绑定，客户端附加字段不能改变待执行命令。

## 工具目录契约

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

## 关键错误码

`AGENT_CONVERSATION_NOT_FOUND`、`BUTTON_PERMISSION_DENIED`、`AGENT_ORIGIN_ROLE_DENIED`、`CONFIRMATION_TOKEN_INVALID`、`COMMAND_ALREADY_EXECUTED`、`PROMPT_SAFETY_BLOCKED`、`AGENT_TOOL_NOT_REGISTERED`、`AGENT_TOOL_INPUT_INVALID`、`AGENT_TOOL_INPUT_ADDITIONAL_PROPERTY`。

## 目标接口

增加 `POST /agent/runs/:id/cancel`、`POST /agent/runs/:id/retry`、SSE/WebSocket 事件流和游标分页；事件 Schema 必须支持断线续传，不能仅依赖进程内 Promise。

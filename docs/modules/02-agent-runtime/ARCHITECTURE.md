# 智脑 Agent 运行时技术架构

## 当前代码

核心在 `private-agent-service.js`，并调用 orchestration、skill/tool registry、model gateway、conversation、runtime store、workflow、prompt security、多模态、业务门禁、知识/语义/系统证据服务。多端 UI 复用 `packages/agent-workbench` 和 `packages/agent-sdk`。

多模态共享入口为 `multimodal-input-service.js`：Office 结构解析拆至 `office-material-parser.js`，获准原图的视觉观察拆至 `visual-material-service.js`，仍复用模型网关。观察结果再检查后成为材料摘录，不直接授权工具。语义提案复用同轮扫描结果，避免重复发送图片；读取范围、缺失页与截断提示回传两个工作台。规格与实际验证见 [多模态报告](../../development/AGENT_MULTIMODAL_ACCEPTANCE_2026-09-07.md)。

## 执行管线

```text
输入/附件安全 → 意图与范围 → 当前联合授权 → 技能/工具选择
→ 知识/语义/系统证据 → 只读工具 → 模型结构化建议
→ 服务端命令生成 → 用户确认 → 重新授权 → 工具租约 → 回执
```

上下文只帮助生成，不参与授权和路由扩权。conversation 持久化权限指纹、摘要版本与哈希；权限指纹变化时重建上下文基线。

工具注册表是独立于模型输出的确定性边界。每个工具声明 `id`、权限 `scope`、业务 `domain` 和对象型 `inputSchema`。当前写入参数由原 run 的权威核心对象绑定生成，客户端不能附加字段；Schema 校验先于工作流授权、Key lease 和业务调用。未知工具、非对象输入与额外属性使用稳定错误码失败关闭。

Agent 创建受控 WorkflowItem 时，工作项与 `agent.workflow.draft_created` 在同一 Repository 事务提交，事件使用 runId 作为 correlationId。模型建议和未确认命令不会发布业务事实事件。

## 数据所有权

Agent 模块拥有 Conversation、Run、MemoryDecision、WorkflowItem 和 ModelGatewayConfig。Trace 由证据模块拥有；业务对象由相应领域拥有；Agent 只保存引用和执行快照。

## 目标结构

```text
modules/agent-runtime/
  api/{conversation,message,execute,operations}-routes.js
  application/{run-agent,confirm-command,manage-conversation}.js
  domain/{run,command,context-policy,workflow}.js
  ports/{model,knowledge,semantic,connector,key,evidence}.js
  infrastructure/{model-gateway,run-repository,queue-worker}.js
```

## 边界与演进

- Agent 不直接 import 风险/采购内部服务，改由 typed tool port 调用。
- 模型配置与模型调用可拆为独立网关；run 状态保留在本模块。
- 生产加入队列和 Worker 后，HTTP 只创建任务并返回 ID，事件流报告进度。
- 模型、工具和技能版本写入 run，支持可重放评测但不重放高风险写入。
- 真实 Connector 引入参数时，工具 Schema 必须版本化并约束类型、枚举、长度与必填项；禁止任意额外属性和模型自由文本直通。

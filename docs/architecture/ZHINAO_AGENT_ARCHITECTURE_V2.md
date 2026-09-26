# 元域智脑多端 Agent 架构技术说明书

2026-09-07 实现补充：对话理解与工具执行已分离。两端共享 `agent-turn.v1` 理解入口，智脑使用权限过滤后的任务历史，语义咨询走模型对话，候选结构需核对原文，服务器独立约束动作与确认。以下历史预算数字不是每次实际送给模型的文本量；当前理解入口历史有 28,000 字符上限。实现与回归边界见 [双端智能修复](../development/AGENT_INTELLIGENCE_REPAIR_2026-09-07.md)。

> 版本：2.1（2026-08-25）  
> 范围：桌面 Web、Electron、移动端、共享 SDK、Agent API、模型网关、证据链、IAM 与数据权限  
> 状态：Demo 可运行基线；生产化差距在第 12 章单独说明

## 1. 产品定位

元域智脑不是“给业务系统套一层聊天框”，而是企业业务目标进入数据、模型、审批与执行链路的受控入口。三端共享任务、身份、上下文、证据与确认协议；元域智营负责策略、模型、权限、接入和审计治理。

核心价值由五个能力闭环构成：

1. 多任务：同一用户最多并行保留 8 个活动任务，任务消息、草稿、运行状态和确认动作互不串扰。
2. 受控上下文：按模型硬上限和产品预算的较小值计算有效上下文，达到 70% 自动压缩。
3. 合理路径引导：错误、越权或违规请求不仅拒绝，还解释不合理之处并给出可执行替代建议。
4. 证据与执行分离：模型生成建议；服务端根据身份、组织、按钮和工作流权限生成一次性确认动作。
5. 全链路追溯：输入校验、检索、推理、计划、确认、工具调用与回执使用同一条哈希链记录。

## 2. 上下文容量结论

上下文必须区分两个数字：

| 指标 | 当前值 | 含义 |
| --- | ---: | --- |
| 模型硬上限 | 1,050,000 tokens | 以 OpenAI GPT-5.6 Sol/Terra/Luna 官方模型页为参考；其他模型按供应商元数据配置 |
| 智脑默认有效预算 | 128,000 tokens/任务 | 产品默认值，可通过 `AGENT_CONTEXT_BUDGET_TOKENS` 配置 |
| 自动压缩阈值 | 89,600 tokens（70%） | 超过后保留最近消息，并生成版本化摘要 |
| 硬压缩阈值 | 108,800 tokens（85%） | 为模型输出、工具返回和安全策略保留空间 |
| 活动任务数 | 8 个/用户 | 由 `MAX_ACTIVE_CONVERSATIONS` 控制 |

有效上限计算公式：

```text
effective_context = min(provider_context_window, product_context_budget)
```

因此，本项目当前对用户承诺的最大有效上下文是 **128K tokens/任务**，不是无条件承诺 1.05M。1.05M 是所选 OpenAI GPT-5.6 模型系列的硬窗口；产品限制更低是为了稳定时延、成本、证据密度和安全复核。切换本地模型、DeepSeek 或兼容模型时，以该模型登记的窗口为准。

官方依据：<https://developers.openai.com/api/docs/models>

## 3. 总体架构

```mermaid
flowchart LR
  subgraph Clients[多端体验层]
    Mobile[移动端]
    Web[桌面 Web]
    Electron[Electron]
    Admin[元域智营]
  end
  WB[共享 Agent Workbench]
  SDK[共享 Agent SDK]
  API[Node API / Agent 控制面]
  Conv[任务与上下文服务]
  Guard[提示词与输出安全]
  IAM[IAM + 组织数据域]
  Orch[Agent 编排 / 技能 / 工具门禁]
  Trace[证据链 / 审计]
  Model[模型网关]
  KMS[Key Center / 短时租约]
  Connectors[MCP / 受控连接器]
  Systems[OA ERP MES LIMS QMS OMS]

  Mobile --> WB
  Web --> WB
  Electron --> WB
  WB --> SDK --> API
  Admin --> API
  API --> Conv
  API --> IAM
  API --> Orch
  Orch --> Guard --> Model
  Orch --> Trace
  Orch --> KMS --> Connectors --> Systems
```

## 4. 工程模块映射

| 模块 | 代码位置 | 责任 |
| --- | --- | --- |
| 共享工作台 | `packages/agent-workbench` | 三端一致的任务、对话、证据、告警、待办与确认交互 |
| 共享 SDK | `packages/agent-sdk` | 身份会话、设备标识、任务与 Agent API 契约 |
| 移动端 | `apps/mobile` | 小屏任务切换、语音/附件、告警与待办 |
| Web/Electron | `apps/desktop` | 浏览器工作台与 Electron 安全容器 |
| Agent API | `backend/src/app.js` | HTTP 门禁、身份解析、按钮权限、任务与执行路由 |
| 会话上下文 | `agent-conversation-service.js` | 任务隔离、上下文估算、压缩、权限变更失效 |
| 路径引导 | `agent-guidance-service.js` | 错误/越权/违规请求的结构化解释和替代建议 |
| Agent 运行时 | `private-agent-service.js` | 安全预检、意图路由、检索、规划、模型、确认与运行记录 |
| 工具注册与门禁 | `agent-tool-registry.js` | 定义工具 ID、Scope、Domain、机器可读输入 Schema；未知工具和额外参数失败关闭 |
| 模型网关 | `local-model-gateway.js` | Mock/本地/OpenAI/DeepSeek/兼容模型、结构化输出、熔断与安全检查 |
| 证据链 | `agent-evidence-trace-service.js` | 事件序列、证据快照、哈希完整性、按身份/角色查询 |
| IAM | `access-control-service.js` 等 | 多角色、按钮权限、组织数据范围与实时撤权 |

## 5. 多任务并行设计

### 5.1 任务模型

每个任务是一个服务端持久化 `conversation`，包含：

- 租户、用户主体和任务角色；
- 标题、活动/归档状态；
- 安全准入后的用户消息和智脑答复；
- runId、traceId、证据引用、计划与待确认动作关联；
- 上下文预算、估算占用、摘要版本、摘要哈希和压缩次数；
- 生成答复时的权限指纹。

前端为每个任务维护独立的 `messages / pending / sending / executing / draft / attachments` 状态。发出请求后即使切换到另一个任务，响应仍回填原任务，从而实现并行工作。

### 5.2 并行边界

- 当前已实现多任务空间并行、Node 请求并发和可切换的 PostgreSQL 对话存储。
- PostgreSQL 模式以 `tenant + subject` 主体索引和 Conversation 记录共同构成事务边界；创建任务时原子校验最多 8 个活动任务，归档时原子释放槽位。
- 同一 Conversation 的消息、任务阶段、Run/Trace 关联和压缩摘要通过数据库行锁串行更新；跨主体读取返回不可见。
- 同一任务不鼓励同时发送多个写请求；一次性确认令牌保证业务写操作只能执行一次。
- 长耗时桌面任务已由持久化队列、Worker 租约和取消/超时状态机承载，不依赖单个 API 请求保持连接。

### 5.3 共享存储配置

```powershell
$env:AGENT_CONVERSATION_STORE_DRIVER='postgres'
$env:RUNTIME_POSTGRES_URL='postgresql://user:password@db.example.internal/agent?sslmode=verify-full'
```

生产连接必须使用 TLS。API 就绪探针会返回 `agentConversationStore` 的实际 driver、持久化类型和连接状态。当前没有 SQLite 历史对话自动搬迁程序，切流前需要停止写入，并对任务数、活动/归档状态、消息数、摘要版本、Run/Trace 关联和主体索引进行对账。

### 5.4 任务 API

| API | 用途 |
| --- | --- |
| `GET /api/agent/conversations` | 列出当前主体可见任务及上下文策略 |
| `POST /api/agent/conversations` | 创建活动任务 |
| `GET /api/agent/conversations/:id` | 读取任务详情 |
| `POST /api/agent/conversations/:id/archive` | 归档任务 |
| `POST /api/agent/message` | 传入 `conversationId` 后在指定任务中运行 |

旧版 `{text}` 和新版 `{input:{text,attachments,conversationId}}` 消息契约继续兼容。

## 6. 自动上下文压缩

### 6.1 压缩内容

系统保留：

1. 系统安全与授权策略（不进入可被用户修改的摘要）。
2. 当前用户目标、已验证事实、runId/traceId 和决策结果。
3. 最近 12 条安全准入消息。
4. 旧消息形成的确定性摘要，带 `summaryVersion` 与 SHA-256 `summaryHash`。

系统不保留到可复用上下文：

- 被提示词安全策略拒绝的原始输入；
- 密钥、令牌或私钥；
- 权限变化前的智脑答复；
- 模型内部思维链；
- 未经过内容扫描的附件正文。

### 6.2 权限变化处理

任务消息保存生成时的权限指纹，指纹覆盖角色、组织、页面、按钮和数据范围。当前权限指纹变化时：

- 历史智脑答复在 UI 中被隐藏；
- 历史摘要不再进入模型上下文；
- 下次有效交互重新建立上下文基线；
- 旧证据只能通过当前仍有效的 run/trace 权限门禁访问。

这避免了“曾经有权限，所以以后永久可见”的数据越权。

## 7. 错误路径与违规操作引导

智脑响应新增 `guidance`：

```json
{
  "type": "policy_violation | permission_boundary | invalid_path | controlled_downgrade",
  "severity": "warning | blocked",
  "title": "请求包含违规或高风险操作路径",
  "problem": "不合理之处",
  "why": "风险与规则原因",
  "suggestions": ["合理动作 1", "合理动作 2"],
  "example": "可直接改写使用的示例问法"
}
```

四类路径按以下原则处理：

| 场景 | 系统动作 | 用户看到的替代路径 |
| --- | --- | --- |
| 目标模糊 | 不读取业务系统 | 补充领域、对象、时间和期望结果 |
| 提示词注入/绕过审批 | 拒绝，记录安全事件，不入上下文 | 改为合法业务目标或只读影响评估 |
| 超出数据/按钮权限 | 默认拒绝 | 查询本人/本组织，或申请角色与数据域 |
| 能分析但不能执行 | 降级为只读，不签发确认令牌 | 由具备完整权限的角色重新发起或走人工审批 |

安全说明：界面不会展示命中的正则、系统提示词或内部安全规则原文，避免把检测器细节变成攻击指南。

## 8. Agent 执行与证据链

```text
任务输入
  → 附件与提示词安全
  → 当前输入意图路由（历史上下文不能扩大路由）
  → 身份/角色/组织/按钮/工作流联合授权
  → 企业知识、语义与系统证据检索
  → 外部上下文注入检查
  → 只读工具
  → 模型网关结构化输出与输出安全
  → 确定性命令生成
  → 一次性确认令牌
  → 业务工具/KMS 短时租约
  → 审批、回执、哈希链审计
```

模型从不直接决定权限，也不能把历史上下文中的“已批准”当成本次授权。命令必须由服务端技能、工作流和业务门禁确定，并绑定用户、租户、会话、设备、runId、commandId、有效期和单次消费状态。

工具调用还必须先通过服务端注册表与输入 Schema。当前业务参数完全由原 run 的授权快照和权威核心对象绑定生成，因此客户端执行请求只提交 `runId + commandId + confirmationToken`，不允许携带组织、核心对象或连接器写入参数。所有当前工具均声明对象型 `inputSchema` 且 `additionalProperties=false`；未知工具、非对象输入和额外字段分别以稳定错误码失败关闭，不会进入权限、租约或业务写入链路。未来真实 Connector 增加参数时，应使用版本化 Schema、严格类型/枚举/长度约束和服务端上下文映射。

## 9. 与 Codex 桌面端的相关能力差距

Codex 的官方资料显示，其与本项目最相关的能力包括：并行子 Agent、可检查的 Agent 线程、Git worktree 隔离、长时间后台任务、定时任务、通知、Skills、MCP、浏览器/Computer Use、文件与图像处理、记忆等。参考：

- <https://learn.chatgpt.com/docs/agent-configuration/subagents.md>
- <https://learn.chatgpt.com/docs/environments/git-worktrees>
- <https://learn.chatgpt.com/docs/automations.md>
- <https://developers.openai.com/>

| Codex 能力 | 智脑现状 | 是否适合本项目 | 建议 |
| --- | --- | --- | --- |
| 并行任务/Agent 线程 | 已有多任务空间；专业 Agent 仅显示路由摘要 | 是 | 增加可查看的子任务树、负责人、输入输出证据和暂停/取消 |
| Worktree 隔离 | 无代码 worktree；业务场景只有 Mock 运行态 | 思想适用 | 引入“业务沙箱分支”，模拟策略/流程变更后再合并发布 |
| 长运行后台任务 | 当前为 HTTP 请求 + 运行记录 | 是，P0 | 引入队列、Worker、任务租约、断点恢复、取消和幂等 |
| Scheduled tasks | 告警规则可自动触发，但无通用计划任务 | 是 | 增加经审批的计划任务模板、运行日历和额度 |
| 通知 | 已有站内/推送/虚拟电话 | 已满足主路径 | 补通知偏好、升级策略和回执 SLA |
| Skills/MCP | 已有技能注册与连接器目录 | 是 | 增加版本、签名、审批、沙箱测试和灰度发布 |
| Browser/Computer Use | 未开放 | 有限适用 | 仅对白名单遗留系统引入受控 RPA，录屏/回放且禁用任意桌面控制 |
| 文件产物工作区 | 支持图片/PDF输入；输出以消息为主 | 是 | 增加报告/表格/审批材料的版本化 Artifact 工作区 |
| App snapshot/回滚 | 无 | 是 | 为任务、策略和模拟世界状态增加检查点与回滚 |
| 通用代码评审/Git 操作 | 无 | 非核心 | 不纳入近期范围，避免偏离业务 Agent 定位 |

## 10. 多端体验策略

### 桌面 Web

- 左侧任务空间、中央对话/证据、右侧实时上下文。
- 浏览器零安装，适合日常办公和跨平台访问。
- 不持有模型、系统或 KMS 密钥。

### Electron

- 与 Web 共用 Vue Workbench，具备原生标题栏和最小化/最大化能力。
- `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`；外部链接只允许 HTTPS 并由系统浏览器打开。
- 生产前需要代码签名、自动更新签名验证、企业证书分发和系统凭据保险箱。

### 移动端

- 顶部横向任务切换、快捷任务、告警、待办、附件和语音输入。
- 保留同一任务 ID、证据链和确认协议。
- 高风险确认应叠加设备生物识别/二次认证（生产项）。

## 11. 安全与数据权限复审

### 已闭环

- 用户、租户、会话和设备绑定；身份会话实时检查角色/策略版本。
- 菜单、页面、按钮/API 与组织数据域均由后端执行，不依赖前端隐藏。
- Agent 直接/间接提示词注入、模型输出越权声明、敏感凭据均有拦截。
- 命令与 run 绑定、一次性确认令牌、过期、幂等和原任务角色复核。
- 任务上下文按用户主体隔离；权限/组织变化后旧答复隐藏且不再进入推理。
- 证据链按租户、主体和有效角色隔离，事件哈希可验证。

### 生产前必须优化

| 优先级 | 风险 | 当前限制 | 优化方案 |
| --- | --- | --- | --- |
| P0 | 数据持久化与多租户隔离 | Demo 使用本地 SQLite，未启用数据库级 RLS/TDE | PostgreSQL/企业数据库；tenant_id 强制键；RLS；KMS 包络加密；备份与恢复演练 |
| P0 | 长任务可靠性 | HTTP 进程内运行，缺取消/断点恢复 | 队列 + Worker；任务状态机；租约、心跳、重试、死信和幂等键 |
| P0 | 全接入数据域覆盖 | 部分 Mock/Connector 仍按角色或场景分发 | 所有记录强制 `tenant_id/org_id/owner_id/classification`；查询层统一策略注入 |
| P0 | 审计不可抵赖 | 哈希链在业务存储内，可被高权限数据库操作者整体替换 | WORM/对象锁、外部时间戳、签名锚定、SIEM 导出和审计员独立密钥 |
| P1 | 上下文准确计量 | 当前是保守字符估算 | 按模型使用真实 tokenizer；计入工具 schema、附件和输出预留；超限可解释降级 |
| P1 | 模型与连接器供应链 | 配置化连接已具备，缺完整制品签名与准入 | 模型/Skill/MCP SBOM、签名、版本锁、评测门禁、灰度与回滚 |
| P1 | Electron 分发 | 容器安全基线已做，缺生产签名和更新链 | Windows 代码签名、签名更新清单、企业软件分发、OS 凭据库 |
| P1 | 高风险身份保证 | 当前确认绑定会话和设备 | P0/写操作叠加 MFA/生物识别、step-up、双人复核和超时重认证 |
| P2 | 数据保留 | 任务上限存在，缺企业保留策略 | 按分类配置 TTL、Legal Hold、导出/删除审批和可验证擦除 |

## 12. 推荐演进路线

### P0：生产底座（4–6 周）

1. 持久化迁移、RLS/TDE、备份恢复和多租户自动化测试。
2. 队列/Worker、取消/恢复、幂等与任务运行监控。
3. Connector 全字段组织化、查询策略统一注入、权限变更回放测试。
4. 审计 WORM、外部签名锚定、SIEM 接入。

### P1：核心卖点强化（4–6 周）

1. 可观察的子任务树与专业 Agent 并行编排。
2. 通用定时任务、审批模板、额度与通知升级策略。
3. Artifact 工作区：报告、表格、审批材料、版本与来源。
4. 精确 tokenizer、模型路由、成本/时延/质量自适应策略。

### P2：体验与生态（持续）

1. Electron 签名更新、系统托盘、全局快捷键和企业凭据库。
2. 受控 RPA、业务沙箱分支、检查点和回滚。
3. Skill/MCP 市场化治理、签名与灰度发布。

## 13. 验证基线

任务上下文、长期记忆、权限隔离、回答治理、证据链、学习治理和 PostgreSQL 控制面已进入自动化回归；共享契约、客户端兼容、非功能工具、架构、领域事件、告警、元域智语、桌面执行和持久化也有对应测试。当前数量与结果以 `npm run test:all` 输出为准，静态检查和各端构建应在每次变更后分别验证，不能沿用旧版本通过记录。

# 智脑 Agent 提示词安全与执行门禁

> 状态：Demo 已实现，可自动回归
>
> 适用范围：`backend/src/services/private-agent-service.js`、模型网关、知识/语义/系统证据、多模态输入、Agent 记忆与确认执行接口
>
> 更新：2026-09-07，补充受控多模态解析、视觉观察与原图独立出网校验

## 1. 安全目标

提示词注入无法仅依靠系统提示词或关键词过滤彻底消除。本项目采用的目标是：即使模型受到恶意文本、文件、知识片段或工具结果影响，也不能因此获得额外数据权限、调用未授权工具、替换待确认命令、重复执行写操作或把恶意指令写入可复用记忆。

以下能力始终由确定性服务端代码控制，而不是由模型决定：

- 身份、角色、数据域和字段可见性；
- 智脑服务主体的短时授权；
- 核心元对象绑定与权威状态校验；
- 工具允许列表、参数和业务动作类型；
- 用户确认、审批、密钥租约与连接器写入；
- Agent run 状态、命令绑定、执行幂等和审计。

## 2. 威胁范围

| 威胁 | 例子 | 当前处理 |
| --- | --- | --- |
| 直接提示词注入 | 用户要求忽略系统规则、泄露提示词或绕过审批 | 在检索和模型调用前拒绝 |
| 混淆注入 | 零宽字符、拆字、英文错拼、Base64/Hex 编码 | 标准化、紧凑匹配、模糊词与编码载荷检查 |
| 间接提示词注入 | OA 邮件、QMS 备注、知识文档、系统记录中隐藏指令 | 按证据项扫描并隔离；任务降级为只读 |
| 多模态注入 | 文件名、PDF 字节或图片像素中的指令 | 文件准入、企业扫描、受控文本/视觉解析、提取内容安全检查分层处理；附件指令不授予写权限，原图另须出网审批 |
| 输出污染 | 模型回显系统指令、密钥、脚本或虚构“已执行” | 输出清理、敏感模式检查和确定性结果替换 |
| 长期记忆污染 | 要求把恶意规则永久记住并影响后续会话 | 不安全任务只保留指纹化审计，不进入可复用记忆 |
| 动作替换 | 客户端用只读任务的 runId 请求创建其他工作项 | 命令必须与原 run 的 `proposedCommand` 完全一致 |
| 多角色权限拼接 | 一个角色只有 Agent 发起权，另一个角色只有命令执行权，客户端尝试合并两者生成动作 | 必须由同一个有效原角色同时持有 prompt/execute 权限，并以该角色通过数据域、工作流和业务校验；否则不生成命令或 Token |
| 重放执行 | 重复提交同一 runId 和命令 | 一次性确认凭据和 run 状态原子占用，第二次拒绝 |
| 同角色跨用户越权 | 同一角色的另一用户查看或确认他人 run | run 与查询按 `tenant + subject` 隔离；确认额外绑定 `session + device` |
| 过度检索 | “帮我处理一下”等没有业务范围的请求 | 要求补充业务域或对象，不进行知识、语义或 Connector 检索 |

## 3. 处理链路

```text
用户文字 / 文件
    ↓
内容标准化、直接注入与编码载荷检测
    ↓
业务域/对象明确性检查（不明确则要求澄清并停止检索）
    ↓
身份授权与数据域裁剪
    ↓
知识、语义事实、Connector 记录逐条扫描与隔离
    ↓
不可信上下文封装
    ↓
模型摘要（模型没有业务凭据，也不直接调用工具）
    ↓
结构化输出封装、泄密/脚本/虚假执行声明检查
    ↓
服务端确定性业务计划
    ↓
同一有效原角色的 prompt + execute + 数据域 + 工作流 + 业务联合门禁
    ↓（任一失败：command = null、无 Token、降级只读）
一次性确认凭据 + 原命令绑定 + 有效期
    ↓
重新校验权限/核心对象 → Key Center lease → 受控工具
```

任何安全层返回高风险结果时，后续行为遵循“权限不升级、动作不生成、记忆不复用”的原则。

## 4. 输入安全服务

统一实现位于 `backend/src/services/prompt-security-service.js`。

### 4.1 标准化

- 使用 Unicode NFKC 归一化；
- 移除零宽字符和不允许的控制字符；
- 对拆字文本生成去空白/标点的紧凑表示；
- 限制可处理字符数；
- 识别可打印的 Base64 和 Hex 载荷，并对解码内容再次检测；
- 对常见英文攻击词错拼进行字符签名匹配。

### 4.2 风险结果

安全评估返回：

```json
{
  "safe": false,
  "action": "deny",
  "riskLevel": "high",
  "score": 100,
  "reason": "尝试覆盖或忽略系统指令。",
  "signals": ["instruction_override"],
  "source": "user_input",
  "fingerprint": "不可逆内容指纹"
}
```

接口和运行日志不记录攻击正文。早期拒绝事件只保留租户标识、主体不可逆指纹、风险信号、次数和内容不可逆指纹，不保存用户原文。当前 `deny` 与需要人工安全复核的输入均不会进入检索、模型、工具规划或记忆。

当前检测是确定性规则、归一化与编码解码的组合，不是生产级语义分类器；不能把“未命中规则”视为内容可信。

## 5. 间接注入隔离

`private-agent-service.js` 对以下上下文分别扫描：

- 企业知识标题与摘录；
- 语义事实、关系和来源；
- OA/MES/LIMS/ERP/QMS/OMS 等系统证据；
- Connector 汇总信息；
- 最终组合后的模型输入。

发现可疑证据后：

1. 从本次可用证据中移除该条内容；
2. 返回不包含原文的隔离元数据；
3. 不调用模型或使用确定性结果替代；
4. 不生成 `command`；
5. 不写入可复用 Agent memory；
6. 在 plan 和语义决策中记录安全降级。

## 6. 多模态材料

`multimodal-input-service.js` 在原有数量、大小、MIME 和 data URL 检查之外，新增：

- JPEG、PNG、WEBP、PDF 魔数检查，防止只修改 MIME 的文件伪装；
- 文件名提示词注入检查；
- 对文件中可打印字节片段进行基础注入检查；
- 材料安全检查状态和指纹只保留在服务端任务上下文。

基础检查不等于内容安全。后续受控解析支持 PDF 文本、Office 正文/表格、结构化材料、企业 OCR 和获准的视觉模型；提取结果再次检查和脱敏。长文件与混合页面携带读取范围，不能把摘录说成全文。生产或强制模式缺少企业扫描则失败关闭；开发模式的基础扫描不代表 AV/DLP。原图只有在视觉模式启用、企业扫描 `clean=true, dlpAction=allow`、云端图片策略 approved 时才可发送；OCR 文字通过不能给原图授权，redact 也不放行原图。测试扫描替身只用于合成材料，详见 [多模态报告](../development/AGENT_MULTIMODAL_ACCEPTANCE_2026-09-07.md)。当前 PDF 解析与渲染不是独立进程沙箱，真实不可信文件仍需企业恶意文件隔离设施。

默认 `API_MAX_BODY_BYTES` 为 18 MiB；附件最多 5 个、单个 4 MiB、合计 12 MiB，用于容纳 Base64 膨胀与 JSON 开销。传输容量不代表附件内容已安全。

## 7. 模型输出安全

OpenAI、DeepSeek、compatible 和 local 外部模型必须直接返回严格 `agent-summary.v1` JSON；Mock 模式则由服务端封装为同一结构。结构通过后，服务端仍使用 `validateModelOutputSafety` 对 `answer` 进行二次内容验证：

```json
{
  "schemaVersion": "agent-summary.v1",
  "answer": "已校验的展示文本",
  "proposedAction": null,
  "claimsExecution": false,
  "executionReceipt": null
}
```

五个字段均为必填；`schemaVersion` 只能是 `agent-summary.v1`，`answer` 必须是受长度约束的字符串，`proposedAction` / `executionReceipt` 必须为 `null`，`claimsExecution` 必须为 `false`，且拒绝所有未知字段。非 JSON、字段缺失、类型错误、额外字段或不合规内容均会直接使用确定性 fallback。

以下情况会使用确定性 fallback 替换模型内容：

- 回显模型网关安全标识或系统指令；
- 出现 API Key、私钥、Bearer Token 等敏感材料；
- 声称已经绕过审批、删除数据或下发正式生产/采购指令；
- 声称业务写操作“已生成、已创建、已提交、已删除或已完成”，但没有来自服务端工具链的 execution receipt；
- 输出包含新的提示词覆盖指令；
- 输出超过安全长度限制。

HTML 脚本、事件属性和 `javascript:` 协议会在展示前清理。任何没有 execution receipt 的执行声明都不会作为成功结果展示；模型输出中的动作字段永远不会直接覆盖服务端生成的 `command`。

## 8. 服务端工具 Schema 与调用门禁

工具定义集中在 `backend/src/services/agent-tool-registry.js`。`GET /api/agent/tools` 返回的每个工具至少包含：

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

当前可执行工具不接收客户端提供的组织、核心对象或业务写入参数；这些数据只能来自原 run 保存的服务端授权、核心对象绑定和业务门禁结果。因此当前 Schema 使用空对象并禁止额外字段。`validateToolInvocation` 在工作流授权、Key Center 租约和业务服务调用之前执行：

- 未注册工具返回 `AGENT_TOOL_NOT_REGISTERED`；
- 参数不是对象返回 `AGENT_TOOL_INPUT_INVALID`；
- 出现 Schema 外字段返回 `AGENT_TOOL_INPUT_ADDITIONAL_PROPERTY`；
- Schema 通过后仍必须继续通过有效原角色、数据域、工作流、业务动作、核心对象和一次性确认门禁。

后续真实 Connector 如需参数，必须先在服务端版本化 Schema 中声明类型、枚举、长度、格式和必填字段，再从受信业务上下文组装；不得把 `additionalProperties` 放开，也不得将模型自由文本直接映射为连接器参数。

## 9. 记忆写入门禁

Agent run 与可复用 memory 已分开：

- 安全输入默认只产生审计 run，自动写入可复用 memory 默认关闭；
- 不安全输入的 run 仅保存替代文本、风险等级和指纹；
- 间接上下文或模型输出触发安全门时，本次用户请求也不会写入可复用记忆；
- run 的创建与查询使用 `tenant + subject` 作为隔离边界，同角色不代表同一主体；多角色查询仅合并当前有效角色集合中的 run/operations/work-items，跨主体不可见，次角色撤销后立即收敛；memory 继续按主角色与主体隔离；
- 未来若启用 memory，条目仍需经过明确审核/发布，并具备来源、可信等级、TTL、撤销和租户/主体隔离。

## 10. 确认与执行安全

当服务端确定性规则形成可写动作候选时，会先选择一个有效原角色并同时验证：

1. 同一个角色明确持有 `agent.prompt.run` 与 `agent.command.execute`；
2. 以该角色计算的智脑授权允许当前数据域；
3. 工作流定义允许该角色发起候选命令；
4. 业务权限、工作流工具与核心元对象校验全部通过。

任一条件失败时，服务端取消待确认计划，返回 `command: null`，不创建/返回 `confirmationToken`，并把本次任务降级为只读建议。不同角色的 prompt 与 execute 权限不能拼接成一条可执行命令。

全部通过后，`createAgentRun` 才会：

1. 将动作 ID 记录为 `proposedCommand`；
2. 生成高熵一次性确认凭据；
3. run 内只保存凭据 SHA-256 哈希；
4. 默认设置 10 分钟有效期；
5. 只把原始凭据返回给本次确认卡，不在 `/agent/runs` 中暴露。

客户端执行时必须提交：

```json
{
  "runId": "run-...",
  "commandId": "create_procurement_demand",
  "confirmationToken": "一次性凭据"
}
```

服务端先用 `tenant + subject` 确认 run 所有者，再确认原 run 角色仍是当前主体的有效角色且仍持有 `agent.command.execute`，然后按顺序验证：原始 `session + device`、`awaiting_confirmation` 状态、原始命令完全匹配、有效期和凭据哈希，并使用原角色重新执行业务动作门禁，最后将状态原子切换为 `executing`。不能在执行阶段换成另一个新角色。成功后进入 `executed`，失败进入 `execution_failed`；凭据均不能再次使用。

原 run 角色已失效、被移除或被撤销执行按钮时，HTTP API 返回 `AGENT_ORIGIN_ROLE_DENIED`。Web 将该错误视为权限失效，立即进入 fail-closed 权限刷新，不重试原执行请求。

可通过 `AGENT_CONFIRMATION_TTL_MS` 调整有效期，服务端会将配置限制在 30 秒到 30 分钟之间。

## 11. 测试与验证

执行：

```powershell
npm.cmd run test:security
```

当前安全专项自动回归共 31 项，覆盖：

- Mock 身份安全与生产禁用；
- 身份会话不能被角色 Header 提权；
- 同角色不同主体的 run 查询隔离，以及确认阶段的会话/设备绑定；
- 核心对象防伪造；
- Connector 故障与角色化通知；
- 直接、Unicode、拆字、编码和错拼提示词注入；
- 防御性安全讨论的误报回归；
- 间接上下文隔离；
- 输入中的敏感凭据，以及模型提示词泄漏、密钥、不安全 fallback、虚假执行声明和脚本输出；
- 安全输入只保留审计 run，高风险输入不进入 memory；
- 无明确业务域/对象时不检索；
- 文件签名、文件名、可打印字节基础检查与 `unscanned` 内容状态；
- 原命令绑定、无命令 run 防动作替换、错误凭据和重复执行；
- 服务端工具目录的机器可读输入 Schema，以及未知工具、非对象输入和附加参数失败关闭；
- 同一有效原角色必须同时持有 prompt/execute 权限并通过数据域、工作流和业务门禁；权限分散在不同角色或联合校验失败时 `command: null`、无 Token，并降级只读；
- `/agent/message` 两种请求体兼容及 `/agent/execute` HTTP 闭环；
- 管理端 Agent 控制评测。

三端构建命令：

```powershell
npm.cmd run build
npm.cmd run build:mobile
npm.cmd run build:desktop
```

## 12. 生产环境仍需补齐

1. 使用独立的内容安全分类模型或策略服务，并维护组织级攻击样本库。
2. 对真实 OA、邮件、网页、MCP 和 Connector 返回内容执行入库前扫描与来源签名。
3. 接入恶意文件扫描、OCR 安全检查、DLP 和文档隔离审批。
4. 将 run、确认状态和幂等键放入支持事务/条件更新的 PostgreSQL 或工作流引擎，避免多实例竞态。
5. 将当前 `tenant + subject + session + device` Demo 绑定替换为可验证的企业用户/组织标识，并继续绑定业务对象版本。
6. 为模型与工具分别使用最小权限工作负载身份和网络出口策略。
7. 增加红队测试、攻击告警、隔离事件处置、Kill Switch 和审计仓对账。
8. 对误报/漏报持续评测；规则命中不能作为唯一安全控制。

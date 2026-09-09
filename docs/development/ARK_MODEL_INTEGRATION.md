# 火山方舟模型接入

更新：2026-09-07。

多模态最新记录：已补齐受控视觉观察和扫描 PDF 路径，合成文件的双端理解/追问 40/40、边界 8/8、候选模型 2/2 通过；原图云端调用仅在隔离合成测试中启用，正式 API 默认仍为 metadata_only。配置前提、修复清单与限制见 [多模态专项报告](AGENT_MULTIMODAL_ACCEPTANCE_2026-09-07.md)。以下旧阶段的“未启动”“尚未切换”等描述保留作为当时记录，不能作为当前运行状态；本机 API 与两个 Web 端已运行。

最新进展：两端已增加共享的 `agent-turn.v1` 会话理解入口（封装在既有 `agent-summary.v1.answer` 内），接收权限过滤的对话与受控材料。普通语义咨询不再只返回固定话术；工具、权限与确认仍由服务器决定。此前下方的 3 项追问专项没有覆盖通用上下文，后续失败及修复经过见 [双端修复与验收](AGENT_INTELLIGENCE_REPAIR_2026-09-07.md)。模型连通、离线协议通过和真实对话通过应分别判断。

## 最新修复：报告对话与追问（2026-09-07）

用户实测“我需要最新的 ERP 系统报告”被误判为历史快照；随后“这是什么意思？”未承接上一条回复。现已修复并更新运行中的 API：

- 无明确业务编号的宽泛业务报告请求先澄清报告范围，不进入精确历史快照解析。不会因此读取数据、声称已生成报告或绕过审批。带编号的历史、版本查询仍按原规则核验。
- “这是什么意思”“解释一下”“我没看懂”等仅解释当前会话的回复。历史文本经过权限过滤和提示安全检查，只供解释，不参与工具路由或业务授权；角色/组织访问范围变化后不提供旧对话说明文本。
- 方舟瞬时连接错误最多重试一次，两次共享原超时上限；不重试 HTTP 拒绝、已到期请求或业务写入。该机制不能保证网络永不失败。
- 对话模型失败时记录 `conversation_failed`，界面标注“模型未返回回答 · 备用说明”，不显示已完成，也不拿失败回复生成本机写入内容。

验证结果：全量自动化 **314/314 通过**，含新增方舟 15 项；Lint、类型检查、桌面构建通过。日志：[本轮全量回归](../../output/dialogue-regression-20260907.log)。真实模型独立测试 `node scripts/evaluate-ark-dialogue.mjs` 使用隔离内存和 3 条合成输入，**3/3 通过**，均为 `source=ark`：

| 场景 | 实际结果 |
| --- | --- |
| 最新 ERP 报告 | 约 4.2 秒，询问综合概览还是专项，说明会核验来源/更新时间；未读数据、未生成报告 |
| 紧接着追问“这是什么意思？” | 约 4.9 秒，解释上一句的报告范围选择和示例数据标注，而不是重新介绍能力 |
| 解释修复前的历史快照提示 | 基于当前会话中的旧回复解释限制，未触发业务操作 |

本轮没有重跑此前 7 项业务效果评测，编号脱敏后的安全回填仍待处理；以上结果不能理解为所有业务能力、长会话和多模态验收完成。当前 Web 测试地址为智脑 `http://127.0.0.1:15184/`、语义运营 `http://127.0.0.1:15174/`，API 为本机 3001。默认开发端口处于 Windows 保留范围，本次运行使用两个指定本机来源，不关闭 CORS 或浏览器安全检查。

## 当前状态

已新增独立的 `ark` 模型提供方，业务智脑的回答、只读工具规划以及语义运营规划共用现有模型网关。前端能够区分“火山方舟已生成”“火山方舟规划”和安全回退，不再把云端规划显示为确定性规划。

**真实方舟连通预检已通过，业务回归尚未全部通过，运行实例尚未切换。** 2026-09-07 已在用户登录的北京区控制台创建 `yuanyu-zhinao`，仅授权 `Doubao-Seed-2.1-pro`，自定义推理接入点为 0，后续新增模型及接入点均不自动授权。原有 `wsl-video` 密钥未改动。用户已自行保存项目外的 `D:\wsl\private\yuanyu-zhinao\ark.json`；实机检查文件存在，ACL 仅当前 Windows 用户可访问。运行预检已从文件加载配置，密钥未回显到聊天、源码或日志。

控制台确认已开通的模型 ID 为 `doubao-seed-2-1-pro-260628`，真实调用已使用该模型。下方启动示例已填入该 ID，并用精确白名单固定版本。本机项目服务当前未运行，后台启动此前被工具策略拦截；本次没有重试后台启动。测试通过独立命令调用真实模型，仅使用合成消息、Mock 业务事实及合成 CSV，未读取真实企业 Connector、上传真实企业文件、购买额度或删除 D 盘本地模型。

### 2026-09-07 真实联调记录

- 最初网关请求回退；独立合成消息请求返回 HTTP 200，证明密钥、端点与模型权限可用。
- 进一步定位到 JSON-object 模式只提供格式名称、没有提供完整字段定义，模型将 `agent-summary.v1` 当作外层键。已为 Ark 和 DeepSeek 的 JSON-object 请求补充完整 Schema；保留严格输出校验，没有放宽动作或执行声明限制。
- 修复后 `npm run check:ark` 退出码 0，返回 `status=passed`、`inferenceSource=ark`、`modelActuallyUsed=true`、`warning=null`。
- 真实模型合成业务评测：**5/7 通过**，整体退出码 1，不是全量业务验收通过。通过项：未知对象不编造、历史时点澄清、否定写入、权限拒绝、CSV 附件说明。未知对象和权限拒绝等无需模型的项由服务端规则完成，不计为模型生成。
- 待处理项：普通对话一次请求回退（约 10.7 秒，未取得可用模型回答，不能仅据时长断言原因）；定向报警分析虽真实使用 Ark，但 `RC-2026-0041` 被替换为 `[业务标识]-0041`，未满足目标编号完整显示断言。需要在保持出网脱敏的前提下设计服务端安全回填，不能为通过测试直接关闭脱敏。
- 方舟专项 12/12、安全回归 48/48、Lint 通过。此前 306 项全量回归是上一轮记录，本次未重跑全量套件。桌面/语义运营运行实例、视觉输入和长会话仍需独立验收。

## 需要准备的两项配置

1. 方舟标准推理服务的 API Key。可由运行环境注入，或保存在项目外受限权限的配置文件中；禁止写入源码、前端、聊天或普通日志。
2. 控制台已开通的精确模型 ID，或 `ep-…` 推理接入点 ID。若使用接入点，仍须在方舟控制台固定其绑定模型，单独固定接入点 ID 不能阻止远端更换模型。

本轮适配标准 Chat Completions，默认地址为 `https://ark.cn-beijing.volces.com/api/v3`，使用 Bearer API Key。依据：[方舟产品与调用说明](https://www.volcengine.com/docs/82379/1795150)、[对话 API](https://www.volcengine.com/docs/82379/1494384?lang=zh)。这里不是 Coding Plan 订阅地址，也不直接支持其他区域或代理；需要其他地址时应先补充安全准入和契约测试。

模型在账号中是否开通、是否支持图片、JSON 输出和思考开关，以实际控制台和调用结果为准。本次不把更换供应商直接视为回答质量提升已验收。

## 本机启动

### 方式一：保存一次，以后从文件读取

在项目根目录的 PowerShell 执行：

```powershell
& .\scripts\save-ark-config.ps1
```

按提示粘贴 `yuanyu-zhinao` 的密钥，输入过程隐藏，不把明文作为命令参数。脚本保存到 `D:\wsl\private\yuanyu-zhinao\ark.json`，仅授予当前 Windows 用户访问目录的权限，不覆盖已有文件。文件是**明文 JSON，不是加密保险库**；不要共享、纳入备份同步或随项目打包。同用户运行的软件仍能读取它。ACL 设置失败时脚本停止，不保存密钥。

保存后直接执行：

```powershell
npm run check:ark
# 预检成功后启动 API
npm run start:ark
```

Windows 下这两个命令自动查找上述文件；也可用 `ARK_CONFIG_FILE` 指定另一绝对路径。文件仅接受 `apiKey`、`model`、`baseUrl`、`allowedModels` 四个字段，不执行脚本，不注入任意环境变量。模型必须在文件的明确授权列表内，接口仍限北京区标准地址。显式环境变量优先，包括空值；如果使用文件配置，应先清除终端中旧的 `ARK_API_KEY`、`ARK_MODEL` 或白名单覆盖项。

缺少默认文件时沿用原环境变量流程；显式指定文件不存在、JSON 损坏、文件过大或权限配置无效时停止启动，日志不包含文件内容。读取器不自动修改自定义文件的系统权限，使用其他路径时需自行配置访问控制。普通 `npm start` 不自动读取该文件。

### 方式二：仅在当前进程配置

在项目根目录的 PowerShell 中配置**同一进程**的环境变量。密钥输入使用隐藏方式，不将明文放入命令历史：

```powershell
$arkSecret = Read-Host '请输入方舟 API Key' -AsSecureString
$arkPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($arkSecret)
try {
  $env:ARK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($arkPointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($arkPointer)
  $arkSecret.Dispose()
}
$env:ARK_MODEL = 'doubao-seed-2-1-pro-260628'
$env:ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
$env:MODEL_ALLOWLIST_JSON = @{ ark = @($env:ARK_MODEL) } | ConvertTo-Json -Compress
$env:AGENT_EXTERNAL_DATA_MODE = 'redacted'
$env:AGENT_EXTERNAL_MULTIMODAL_MODE = 'metadata_only'

npm run check:ark
# 预检成功后，在同一个窗口启动 API
npm run start:ark
```

上述白名单只用于本次专用方舟进程。若服务仍需其他提供方，应在已有白名单中添加 `ark`，不要误删其他已审批项。`.env.example` 只是变量说明，当前启动命令不会自动加载 `.env`。

`check:ark` 仅发送一条合成连通测试，检查真实回复是否通过项目的输出契约；使用隔离内存，不修改工作区数据库。即便这条预检成功，也不代表复杂业务效果已验收。退出码：0 成功、1 调用或输出校验失败、2 配置不完整。

`start:ark` 启动现有 API，强制本进程使用 `ark` 和环境托管配置。这样数据库中旧的 local 配置不会覆盖方舟；没有改写或删除旧配置。不要与占用同一端口的旧 API 并行启动，应先由服务管理方式停掉旧实例。Web/Electron 继续连接原 API 地址，不需要把密钥下发到各端。

环境托管时管理页面只读。若使用普通启动方式而不是 `start:ark`，需要显式设置 `AGENT_RUNTIME_MODE=ark`、`AGENT_MODEL_CONFIG_SOURCE=environment`，或由有权限的管理员在配置中心选择火山方舟并保存。后者的非密钥配置可持久化，界面提交的密钥只存当前 API 进程内存。

## 调用与安全边界

- 仅允许北京区标准 HTTPS 推理地址，拒绝 URL 内凭据、查询参数、其他域名及 HTTP；不跟随重定向，避免把密钥转发到其他地址。
- 精确白名单、主体配额、并发限制、超时、熔断、输入安全和输出校验继续生效。方舟不可用或输出违规时显示受控回退，不标成方舟成功生成，也不转而调用本地模型。
- 使用 `json_object` 请求并在服务端校验 `agent-summary.v1`。模型不能通过额外字段发起动作、声称执行成功或伪造回执。回复中的 `reasoning_content` 不返回给用户。
- 默认 `ARK_MAX_TOKENS=2048`，受治理层预留输出额度约束；可设置 64～16384。`ARK_THINKING_MODE=disabled` 为当前低延迟 JSON 配置；模型支持时可设 `enabled`，随后应重测超时和输出长度。主请求超时默认 30 秒，规划子请求仍为 10 秒。
- 默认只发送规则脱敏文本及材料元数据。现有正则脱敏不是企业 DLP，不能保证识别所有商业秘密；真实敏感内容出网前仍需企业审批与更完整的脱敏策略。
- 原图视觉需要 `MULTIMODAL_VISUAL_PROVIDER=model`、`AGENT_EXTERNAL_MULTIMODAL_MODE=approved` 和企业扫描明确返回 `clean=true, dlpAction=allow`，模型也须获准并支持视觉。仅 OCR 文字通过不授予原图出网权；DLP 要求 redact 时原图不发送。正式实例默认未开启，步骤见 [多模态接入](../guides/AGENT_MULTIMODAL_GUIDE.md)。
- 方舟计费参数未默认填入市场价格。未配置时现有成本估算中的 0 不能理解为免费；真实账单以方舟控制台为准，需要另行设置 `MODEL_INPUT_COST_PER_MILLION_USD_JSON` 的 `ark` 单价。

## 测试与验收

```powershell
# 离线协议与安全测试，不访问方舟
npm run test:ark
npm run test:all

# 真实配置完成后，运行合成业务评测；不使用企业 Connector
$env:AGENT_RUNTIME_MODE = 'ark'
node scripts/evaluate-agent-capabilities.mjs
```

真实评测仍需人工检查各案例的 `rubric`。只有 `inferenceSource=ark` 且通过输出契约的结果计为该模型成功生成；降级文本不计为模型验收通过。

本轮结果：

| 验证 | 结果 |
|---|---|
| 新增方舟专项测试 | 8/8 通过：协议、脱敏、密钥不回显、准入拒绝、超时、违规输出、图片门禁、两端规划与配置优先级 |
| 文件配置补充回归 | 方舟专项合计 12/12 通过；覆盖文件读取、环境覆盖、缺失/损坏/超限/越权配置拒绝、错误不泄漏密钥；用户手动保存的真实配置已加载并通过连通预检 |
| 全量回归 | 306/306 通过，失败、跳过、取消均为 0；[日志](../../output/ark-integration-regression-2026-09-07.log) |
| Lint / 类型检查 | 通过 |
| Web、语义运营、桌面智脑、移动端构建 | 通过；不等于 Electron 实机或安装包验收 |
| 方舟真实预检 | 本次通过：`source=ark`，无 warning。早前缺配置的 [预检记录](../../output/ark-preflight-2026-09-07.log) 保留为历史，不代表当前结果 |

专项测试替换传输层返回合成响应，不等于真实 API 验收；真实连通和 7 项业务评测的结果见上方联调记录。模型效果全通过及两端实机检查仍未完成。

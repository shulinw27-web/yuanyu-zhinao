# ADR-028: 系统接入连接配置段——文档物料、心跳接口与授权方式

- 状态：Accepted
- 日期：2026-10-06
- 关联：[ADR-024](ADR-024-custom-system-registration.md)（触发式复审第 1 条）、[ADR-023](ADR-023-lifecycle-operation-surface.md)（接通门禁）、[ADR-027](ADR-027-document-material-registration.md)（5a 文档解析）、[ADR-009](ADR-009-system-registry-single-source.md)（智脑不提权）

## 背景

ADR-024 边界第 3 条明确写了「登记物料是**业务描述性物料**，不是连接配置：没有端点、凭据、协议字段（那些属真实企业连接器阶段）」，并在触发式复审第 1 条预告「若引入真实企业连接器，登记物料需扩展连接配置段（端点 / 凭据引用 / 协议）」。

用户 2026-10-06 提出三点需求，提前触发了这条复审：

1. 系统接入时应可选附加文档型物料（数据字典 / 接口文档）——让智脑在登记时就获得系统的接口与数据结构说明。
2. 系统接入时必选填写一个心跳接口做连通性测试——当前探测读内置合成模拟数据源，不是真实系统的连通性验证。
3. 系统接入时要考虑授权方式——智脑侧如何获得访问目标系统的凭据。当前自定义系统无凭据/端点/协议字段，授权仅靠 `ROLE_DATA_DOMAINS × materials.dataDomains` 推导可见性。

## 决策

### 1. 文档型物料（方案 A：系统登记时附带）

登记物料 `SYSTEM_REGISTRATION_FIELDS` 新增可选 `attachmentDocuments`（0–N 份 PDF/DOCX/XLSX）。复用 5a（[ADR-027](ADR-027-document-material-registration.md)）的 `inspectMultimodalInput` + `extractMultimodalEvidence` 安全闸门与提取文本持久化契约：**只持久化提取文本 + 解析取证、原文件不落地**；只进理解上下文与 schema 发现候选、**不进 mock 强校验链**（dictionary/samples 仍以 JSON 字典为准）。文档跟着系统走、任何接入项目可复用。

### 2. 心跳接口（必填）

登记物料新增必填 `heartbeat`：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `endpoint` | 是 | 目标系统健康检查 URL（http/https） |
| `method` | 否（默认 GET） | GET / POST / HEAD |
| `expectedStatus` | 否（默认 200） | 预期 HTTP 状态码（100–599） |
| `expectedBody` | 否 | 可选子串断言（如 `"status":"ok"`）——避免 200 但服务降级 |
| `timeoutMs` | 否（默认 5000） | 500–30000ms |

**探测升级**：`probeSystemConnection` 双路径——① 自定义系统有 heartbeat 时优先走真实 HTTP 探测（按 `auth.scheme` 取凭据、调 `heartbeat.endpoint`、断言 `expectedStatus` + `expectedBody`）；② 心跳失败 + 挂接了模拟场景 → 降级到模拟场景路径（`simulatedScope` 标注 + `probeKind: 'heartbeat_fallback_to_scenario'` + `heartbeatIssue` 带心跳失败原因）；③ 平台系统（无 heartbeat 字段）仍走模拟数据源。

**接通门禁不放宽**：ADR-023「最近探测 verified」仍生效；接通仍需 `reason` 必填（人工签字语义，ADR-023 第 4 条）。心跳通过只证明网络可达 + 服务应答，**不证明业务接口可用**。

### 3. 授权方式（a + b 组合）

登记物料新增必填 `auth`：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `scheme` | 是 | `user_token_passthrough` \| `service_principal` |
| `credentialRef` | service_principal 必填 | `kms://` Key Center 引用（user_token_passthrough 不填） |
| `scope` | service_principal 必填 | 声明访问范围数组（如 `['read:supplier']`） |
| `writeApprovalRequired` | 否（默认 true） | 写操作是否仍需用户审批 |

**a. 用户令牌透传（user_token_passthrough，默认推荐）**：智脑**不持有任何凭据**，调用目标系统时转发当前用户会话的 SSO 令牌（请求头 `X-On-Behalf-Of`）。**服从「智脑不提权」（ADR-009）**——智脑能调用的，当前用户自己也能调用；凭据不落智脑侧，最小泄露面。要求目标系统与智脑共用 IdP（SSO）。

**b. 服务主体凭据（service_principal，后台场景）**：智脑在目标系统注册为受信应用，凭据存 Key Center（`credentialRef` kms:// 引用）。与用户会话解耦，可后台执行。**必须声明 scope + 写操作仍需用户审批**，否则违反「智脑不提权」。

**凭据永不进登记物料**，只存 `credentialRef`（Key Center 引用），与平台系统 `connector.credentialRef` 一致。登记 service_principal 系统时自动在 Key Center 注册凭据策略（`registerCustomSystemCredentialPolicy`，按租户隔离、版本递增）。

**不实现的方式**（属触发式复审）：~~OAuth 授权码（d）、mTLS（e）、Token Exchange（f）、API Key（c）~~。`auth.scheme` 枚举需扩展时复审本 ADR。**2026-10-07 兑现（8-7）**：API Key（c）、OAuth 授权码（d）、mTLS（e）已实现（见下方补充实施）；Token Exchange（f）仍属触发式复审。

### 4. 心跳凭据解析（heartbeat-credential-resolver）

新增 `heartbeat-credential-resolver.js`：service_principal 路径按 `credentialRef` 从 Key Center 读凭据策略，返回 opaque Bearer token（`source: 'tenant_registration'`，不暴露凭据明文）。真实 KMS 适配器对接（kms:// 协议解析）属触发式复审；本阶段默认实现返回 opaque handle 占位。

user_token_passthrough 路径不取凭据，由 `executeHeartbeatProbe` 直接转发当前用户身份（`X-On-Behalf-Of` 头）。

## 实测口径

- `backend/test/system-registry.test.js` 15 项（8 → 15）：新增 7 项——schema 下发 authSchemes、正例登记带 heartbeat/auth 落库与披露、service_principal 凭据策略自动注册、反例（endpoint 缺失/非法 URL、auth 缺失/未知 scheme/缺 credentialRef/缺 scope、user_token_passthrough 带 credentialRef、文档 dataUrl 非法/超 8 份）。
- `backend/test/system-access-heartbeat.test.js` 11 项（新增）：executeHeartbeatProbe 正例（user_token_passthrough + service_principal）、反例（transport failed / status mismatch / body mismatch / fetcher unavailable）、probeSystemConnection 优先走心跳路径、接通门禁（心跳 verified 后可接通、未通过不可接通）、降级路径（平台系统仍走模拟数据源）、凭据策略注册边界。
- `backend/test/system-access.test.js` 13 项（已适配）：schema 必填项加 heartbeat/auth；SRMB（无 mockScenarioId）从「探测被拒绝 409」改为「走心跳路径返回 failed 200」（ADR-028 设计变化）。
- `workspace-layout.test.js` 9 项（8 → 9）：登记表单心跳/授权/文档字段渲染断言、authSchemes 服务端下发、接通门禁文案升级。

## 边界（不得在界面或文档中弱化）

1. **心跳通过 ≠ 业务接口可用**——接通仍保留 reason 必填（人工签字语义，ADR-023 第 4 条）；心跳只证明网络可达 + 服务应答符合预期契约。
2. **用户令牌透传（a）路径智脑不持有凭据**，服从「智脑不提权」纪律；服务主体凭据（b）路径智脑获得服务身份权限，**必须声明 scope + 写操作仍需用户审批**，否则违反纪律。
3. **凭据永不进登记物料**，只存 `credentialRef`（Key Center 引用）；登记物料是描述性 + 连接配置引用，不是凭据保险柜。
4. **文档型物料复用 5a 边界**：原文件不落地、只进理解上下文与 schema 发现候选、不进 mock 强校验链（dictionary/samples 仍以 JSON 字典为准）。
5. **真实 HTTP 探测只在沙箱内验证**（demo 环境）；生产验收需真实企业连接器阶段，本阶段不覆盖。降级到模拟场景是开发环境行为，生产环境无模拟场景则心跳失败即 failed。
6. **Key Center 凭据保管最小化**：本阶段只做凭据策略注册（`registerCustomSystemCredentialPolicy`）与 opaque handle 返回，不完整实现 lease 签发流程（authorization + role + purpose + taskId + workflow）；完整 lease 属真实企业连接器阶段。

## 触发式复审

- ~~若引入 OAuth 授权码（d）、mTLS（e）、Token Exchange（f）、API Key（c）授权方式，`auth.scheme` 枚举需扩展、Key Center 需支持对应凭据类型；本阶段只实现 a + b。~~ **已兑现（8-7，2026-10-07）**：c/d/e 三种已实现（凭据解析 + 请求头装配层面）；Token Exchange（f）仍保留。
- ~~若心跳契约需扩展（如定时探测、告警阈值、探测历史可视化），属独立增量；本阶段只做手动探测。~~ **部分兑现（8-6，2026-10-07）**：定时探测 Worker 已落地（可配周期 + 连续失败自动降级 degraded）；告警阈值与探测历史可视化仍属独立增量。
- 若文档型物料需进入 mock 强校验链（dictionary/samples），[ADR-027](ADR-027-document-material-registration.md) 边界需复审；本阶段保持 5a 边界不变。
- 若真实 KMS 适配器对接（kms:// 协议解析、HSM 密钥操作）落地，`heartbeat-credential-resolver` 的 opaque handle 占位需替换为真实凭据；本阶段标注 `source: 'tenant_registration'`。

## 补充实施（2026-10-07）：授权方案扩展、心跳定时 Worker 与文档发现链（8-5 ~ 8-7）

三个边界项按用户确认（「做这三个」）实施，均不改变上文核心决策：

- **8-5 文档 → schema 发现消费链**：`storeSystemDocumentTexts` / `getSystemDocumentTexts` / `getAllSystemDocumentTexts`（DOCS_KEY 状态）把登记文档提取文本串入 `semantic-material-workspace-service.js` 的 `discoverWorkspaceSchemas`——文档物料从「仅持久化与披露」升级为「进 schema 发现候选消费链」（候选路径边界不变，仍不进 mock 强校验链）；`registerSystemOnboarding` 随文档解析由同步转 async（路由层加 `await`）。**架构棘轮**：新增跨域边 `semantic-material-workspace-service → system-access-service` 已登记基线（同性质先例：共享消费而非复制清单）。
- **8-6 心跳定时探测 Worker**：新增 `backend/src/workers/heartbeat-probe-worker.js`——可配周期（默认 5min）、遍历已接通系统对有心跳的执行 `executeHeartbeatProbe`、连续 N 次失败（默认 3）自动把连接状态降级为 `degraded`；fetcher / credentialResolver 可注入。**状态机扩展**：`SYSTEM_CONNECTION_STATES` 新增 `degraded`（`connected ⇄ degraded`，合法迁移由 system-registry-service 执行）——降级是可恢复状态，非接通撤销。**边界**：定时探测只改生命周期状态与披露，不改接通门禁（人工签字语义不变）；degraded 系统的心跳恢复成功即自动回到 connected。
- **8-7 授权方案扩展**：`AUTH_SCHEME_OPTIONS` 2 → 5（新增 `api_key` / `oauth_authorization_code` / `mTLS`）；登记校验——api_key / oauth_authorization_code / mTLS 均需 `credentialRef`（kms://），oauth_authorization_code 另需 `redirectUri`（https:// 开头），scope 对非 service_principal 方案可选（有则校验格式）；凭据策略注册从 service_principal 扩展到**全部凭据持有方案**（4 种）；`executeHeartbeatProbe` 按 scheme 分支——service_principal / oauth_authorization_code 走 `Authorization: Bearer`、api_key 走 `X-API-Key` 头、mTLS 不设特殊请求头（TLS 层签名，证书注入属触发式复审）、user_token_passthrough 仍转发 `X-On-Behalf-Of`；`heartbeat-credential-resolver` 按 scheme 区分返回 `apiKey` 或 `authorizationHeader`。**边界**：三种新方案均为「凭据解析 + 请求头装配」层面的实现——真实 KMS 凭据签发、mTLS 客户端证书在 fetcher 层注入、OAuth 授权码换 token 的完整流程仍属触发式复审，本阶段 opaque handle 占位不变。

**实测口径（2026-10-07 补充）**：

- `backend/test/system-registry.test.js` 15/15（authSchemes 断言 2 → 5 项；未知 scheme 反例改用 `basic_auth`——`api_key` 从反例转正例）。
- `backend/test/system-access-heartbeat.test.js` 11 → **15**：新增 4 项——api_key（X-API-Key 头 + 不设 Authorization）、oauth_authorization_code（Bearer 头）、mTLS（无特殊请求头）、三种新方案凭据策略自动注册。
- `backend/test/system-access.test.js`：authSchemes 断言同步 5 项。
- `backend/test/heartbeat-probe-worker.test.js` **5/5**（新增）：调度（配置周期 / 立即触发）、连续失败降级 degraded、恢复回 connected、无心跳系统跳过、注入 fetcher 不发真实请求。
- `backend/test/system-access-document-discovery.test.js` **5/5**（新增）：文档登记 → 提取文本落库 → schema 发现候选消费链。
- `npm run quality` 端到端 **EXIT=0** 全绿（架构棘轮通过）。
- **真实模型评测 `evaluate:mention-linking` 补跑成功（2026-10-07，云配额恢复）**：变体轮 **6/6 通过、0 失败**——变体 A 3/3 `linked-as-expected`、变体 B 3/3 `abstained`（弃权不硬凑）；E2E 断言 5 项全 true（候选来自链接 / 兜底抑制 / 缺口点名 / 映射仍 pending）；Critic 仅剩既有「字段来源映射」（候选 pending 待人工确认，非缺陷）。**关闭 ADR-025 实施以来「真实模型评测未取得数字」的欠账**。

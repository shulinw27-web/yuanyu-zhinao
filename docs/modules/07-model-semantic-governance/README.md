# 模型与语义治理模块说明

本页集中维护需求、架构、接口和开发约束；“当前”与“目标”沿用原说明，不因合并改变完成状态。

## 需求与验收

### 目标

统一管理核心元对象、OA 元模型、世界模型模板/草稿、企业知识和语义上下文，为 Agent 提供有来源、有时间语义、按权限裁剪的只读证据。

### 核心需求

- 人员、原材料、产品、设备、门店是核心对象锚点，业务流程使用权威投影校验；门店还必须携带组织归属并接受组织数据范围约束。
- 元模型支持草稿、校验、模拟构建、发布和版本回滚。
- 世界模型支持模板、连接目标、草稿、校验和发布。
- 语义事实记录来源、业务时间、记录时间、分类、组织和对象引用。
- 企业知识检索按角色/组织裁剪，外部内容先做间接注入安全分区。
- 治理模块提供证据，不负责认证、业务审批、密钥或系统写入。
- 元域智语使用独立 Agent 端；业务端智脑不得获得建模、模拟构建或发布工具。
- 运营人员可用自然语言和受控 PDF/图片发起建模、状态检查、校验、模拟与发布任务。
- Agent 必须展示计划、固定工具命令、所需权限、Schema Critic、Diff 和事件时间线；未执行步骤不得显示为完成。
- 只读任务可自动返回，写任务必须明确确认并在服务器端重新授权，任务不得重复执行。
- 本地模型规划必须使用固定 JSON 契约；解析失败、模型不可用或输出冲突时自动降级为确定性规划。
- 来源预检必须区分已登记目录、受控 Mock、企业 Connector 待验证、缺少凭据、不安全端点、未登记和无权限状态。
- 来源预检不能主动访问业务记录；真实连接材料至少包含访问说明、数据字典、键规则、脱敏样例、字段分级和增量/删除语义。
- WMS Mock Connector 必须提供库存批次、仓库、入库单和出库单目录，并以状态化事件支持 ERP→WMS→MES/QMS/OA 的模拟闭环。
- OpenAPI 和数据字典解析必须识别对象、字段、主键和引用关系；缺失主键或来源未登记时不得采纳草稿。
- 运营人员必须能在待确认阶段可视化修改字段类型、必填约束、主键、数据分级、核心元对象和关系基数；每次保存后重新运行 Critic 与 Diff。
- 提案必须提供可点击的对象关系图，节点选择与字段检查器联动，并展示来源系统和字段映射完整度。
- 每个字段必须声明源字段及映射方式；新增字段默认待确认，主键只能使用稳定源字段的自动或人工映射。
- 修订必须生成确定性影响分析，至少覆盖主键变化、对象/字段删除、关系影响、待确认映射及 Semantica 重新校验要求。
- 每个提案必须生成版本化字段映射契约，并以服务端受控 Mock 样本演练 Canonical Fact 转换；浏览器不得提交或伪造验证结论。
- 映射演练必须检查必填源值、字段类型、主键非空和样本内唯一性，并清楚区分通过、失败和无样本未验证。
- 映射演练存在错误时，前端确认入口和服务端草稿采纳均必须阻断；无样本只能作为准备提醒，不能标记为生产可用。
- 提案修订必须使用服务端版本号进行乐观并发控制；跨身份、过期版本、重复字段、无效主键、重复关系和断裂关系不得保存。
- 结构化 Schema 成功解析后不得根据材料正文中的相似词自动增加范围外对象；模型建议的系统范围必须由服务端来源预检裁剪。

### 验收标准

草稿与发布权限分离；无效关系/来源不可发布；发布版本不可原地覆盖；查询证据带 source/id/version/classification；权限变化后旧语义证据不继续进入 Agent 上下文；不同身份不能查看、修订或执行彼此任务；未保存修改、Critic 失败或样本映射演练失败时不能确认；任何自然语言写诉求在确认前均不改变模型状态。

## 架构与实现

2026-09-10 全链路修复：执行器在当前对象数据集上执行逐跳授权的前向闭包，再读取下游事实；三根以内独立计算，不按供应商外部批号合并。发布消费桥接层在确定性结果后调用受控证据解释，并在回答前重新核验权限和模型指纹。图范围完整、企业全局覆盖和解释成功是不同状态。会话材料通过独立有界索引检索，不能把旧模型回答当成实时企业事实。详细边界见 [发布消费指南](../../guides/PUBLISHED_MODEL_WORKBENCH.md)。

2026-09-10 闭环增量：人工审阅的 `scenario.readPlans` 经有界表达式校验、同执行器正反例回放、Semantica 回执校验后发布；智脑只消费租户匹配的发布定义。新服务 `ontology-read-plan-service` 负责受控计算，`published-ontology-agent-service` 负责业务入口桥接。对象部署授权、模型策略、IAM 范围独立核验，样本和模型不能自授权限。见 [闭环指南](../../guides/PUBLISHED_MODEL_WORKBENCH.md) 和 [回归报告](../../development/SEMANTIC_WORKBENCH_LOOP_REPAIR.md)。

2026-09-10：新增材料工作区、输入证据保真校验、授权上传样本演练及需求候选编译服务；保持原治理存储、身份、确认与发布链路。结构化解析不再依赖模型截断摘要，见 [架构增量](../../architecture/SEMANTIC_MODEL_AUTHORING.md) 与 [修复回归](../../development/SEMANTIC_MANUFACTURING_REPAIR.md)。

### 当前代码

`core-meta-object-service.js`、`meta-model-service.js`、`world-model-template-service.js`、`semantic-context-service.js`、`enterprise-knowledge-service.js`、`semantic-operations-agent-service.js`、`semantic-operations-task-service.js`，以及独立 `services/semantic-context/app.py`。

元域智语 UI 已从业务管理前端拆出，独立应用位于 `apps/semantic-operations-console`（开发端口 `5174`）。业务端智脑不承担建模和发布职责，原世界模型页面只保留已登记语义上下文和人工精调入口。

### 子域与所有权

- Meta Model：Schema、关系、来源映射、治理规则；
- World Model：模板、实例草稿、连接目标、发布版本；
- Semantic Context：事实/关系/时间/来源的检索投影；
- Knowledge：文档目录、分块引用和分类。

四者可以同属治理模块，但各自 Repository namespace 独立。语义服务不拥有 IAM 或业务系统主数据，只保存已授权投影及来源。

核心对象 Schema `1.1.0` 新增 `Store`。门店的稳定标识为 `store_id`，权威来源为 MDM/OMS/POS/ERP；`Store → sells → Product`、`Person → manages → Store` 和 `Equipment → located_at → Store` 进入关系契约。市场角色可检索经组织范围裁剪的 OMS 门店事实，生产/采购角色不会因输入门店 ID 自动获得 OMS 数据域。

### 目标依赖

治理写入 → IAM 权限 → Schema 校验 → 来源白名单 → 版本仓 → 发布事件。Agent 通过只读 `EvidenceProvider` 访问，经安全分区后的内容才能进入模型。

独立 Python 服务应拥有明确 OpenAPI、健康检查、版本和契约测试；生产可拆分部署，但本仓的 domain contract 保持一致。

### Agent 驱动的运营闭环

自然语言或受控材料先转成持久化运营任务。服务器识别建设模型、检查状态、校验、模拟构建和发布五类意图，并为任务绑定固定命令与所需权限。浏览器不能在确认时替换命令。

```text
运营诉求/材料
    ↓
意图识别与受控任务
    ↓
计划 + Schema Critic + Diff
    ↓
可视化字段、主键与关系复核
    ↓
Review Queue / 明确确认
    ↓
服务器权限校验
    ↓
草稿、校验、Semantica 模拟或发布
    ↓
快照、结果与审计事件
```

只读状态任务可以自动完成。所有写任务必须处于 `waiting_confirmation`，执行时再次校验任务所属身份和权限；任务只能执行一次。建模建议先落未发布草稿，发布、回滚及其他高风险动作不能由模型文本直接触发。

任务按租户、主体和设备隔离。附件仅接收规定的 PDF/图片类型与大小，进入模型发现前执行内容安全检查；长期记忆、历史对话和附件内容都不能充当授权凭据。

待确认提案具有独立 `revision`。运营人员可以修改对象名称、来源、数据分级、核心元对象、字段名、字段类型、必填约束、主键、关系谓词和基数。每次保存都必须提交期望版本，服务端重新执行清洗、关系闭合校验、Schema Critic 和双重 Diff；旧版本更新会以版本冲突拒绝。浏览器存在未保存修改或 Critic 未通过时，确认入口不可用。

提案编辑器同时维护对象关系图和属性检查器。图节点按候选对象生成，连线直接来自 `relationshipTypes`；点击节点只切换当前编辑对象，不执行写入。节点显示来源系统、字段总数和待确认映射数，字段检查器维护 `sourceField + mappingStatus`。新增字段和对象默认进入 `pending`，在绑定源字段、声明派生或明确忽略前不能通过 Critic。

服务端为每次修订生成 `impactAnalysis`，区分主键变化、对象/字段删除、关系影响和待确认映射。高影响修改提示索引与历史引用迁移，中影响修改提示兼容性复核；分析只描述风险和必要动作，不自动读取明细、重建索引或调用 Semantica 发布。

提案同时生成 `semantic-mapping-contract.v1` 映射契约，并在服务端使用状态化 Mock Connector 样本执行只读转换演练。演练按 `sourceSystem + sourceObjectType` 选择最多 3 条样本，解析 `sourceField`，检查必填值、目标类型、主键非空和样本内唯一性，再生成不含原始记录正文的 Canonical Fact 预览。没有样本的对象标记为 `unverified`，不能宣称已验证；存在必填缺失、类型冲突、待确认映射或主键问题时，`mappingValidation.blocked=true`，最终采纳接口也会拒绝写入草稿。当前演练明确限于 Mock 数据，不能代替真实系统脱敏样本验收。

### 本地模型规划与来源发现

元域智语 Agent 复用平台模型网关调用本地 Qwen3-8B。模型只返回 `semantic-operations-plan.v1` 结构化建议，包括目标、相关系统、规划依据和必要澄清问题。服务器的确定性分类和来源预检结果仍是权威边界；模型建议与服务器冲突时，任务保留冲突记录并采用服务器绑定的命令、权限、系统范围和确认策略。

来源发现由 `semantic-source-discovery-service.js` 完成，汇总 MCP 连接器目录、角色数据域、企业 Connector 配置就绪度和已有字段映射。发现过程只读取结构元数据，不访问业务明细，也不探测下游接口。未登记系统、越权数据域、不安全端点和缺失凭据会成为显式阻断项；仅有 Mock 目录时必须标记为准备提醒，不能宣称已连接真实系统。

当前已登记来源目录为 OA、ERP、WMS、MES、LIMS、QMS、OMS。WMS 已具备受控 MCP 目录、短时凭据策略、字段映射和状态化 Mock 数据；企业 Connector 未配置时仍必须标明为 Mock。SRM、MDM、PLM、EAM、IoT 可被诉求识别，但在连接器、来源契约和字段分级登记完成前只显示为待准备来源。

### 结构化 Schema 材料发现

运营端支持 PDF、图片以及 JSON、YAML、CSV 结构化材料。JSON/YAML 可识别 OpenAPI `components.schemas` 或对象式数据字典，CSV 可按表名/对象名分组字段。解析器提取对象、字段类型、必填约束、主键和 `$ref`/外键关系，再转成待审阅元对象和关系建议。

材料先经过类型签名、大小、编码和提示注入检查。解析只保留结构摘要，不持久化原文件正文。缺失主键、未分配来源、未知引用或字段分级待确认时，Schema Critic 必须阻止采纳。示例材料位于 `examples/semantic-schemas/wms-openapi.json`。

结构化材料成功发现对象后，该 Schema 是本次候选对象集合的权威来源，模型上下文中的相似业务词不能额外补出材料之外的 ERP/WMS 对象。运营人员仍可在可视化编辑器中显式新增对象，并通过保存修订触发完整校验。

## 接口契约

### 2026-09-12 引用式解释契约

现有智脑消息接口的 `semanticContext.analysis` 增加以下字段，不新增端点、不改变身份和授权要求：

- `citations[]`：`ref/key/system/objectType/id/version`，只列解释引用到的来源记录标识。计算和查询范围仍以 `comparisons` 为准。
- `verification`：`schemaVersion="ontology-claims.v2"`、`contextId`、`sourceReferencesVerified`、`metricReferencesVerified`、`gapClaimsVerified`；通过时前三类核验为 true，`narrativeEntailmentVerified=false`，不声称任意自然语言已获证实。
- `evidenceValidation`：仅含 `passed/signals`，不包含模型原文。
- `code=ANALYSIS_CLAIM_CONTRACT_INVALID`：JSON、快照、引用或边界校验失败；`ANALYSIS_EVIDENCE_CONFLICT`：命中已有财务矛盾防护。均为解释 incomplete、整体 partial，不返回被拒绝的解释正文。

`semanticContext.timing.analysisProposalCharacters` 统计安全网关返回的提案字符数，`analysisAnswerCharacters` 统计渲染结果（解释拒绝时为 0）；`analysisMs` 包括生成、校验和渲染。未进入阶段时字段可能缺省。模型网关新增服务端内部选项 `answerContract="ontology_claims"`，该调用的 `agent-summary.v1.answer` 为原生 JSON 对象，网关再序列化供业务校验。其他聊天调用仍使用字符串，不能由用户消息切换内部协议。客户端只消费服务端渲染的可读解释。字段和上限见 [解释核验指南](../../guides/PUBLISHED_MODEL_WORKBENCH.md)。

2026-09-11 耗时诊断：`turn_understanding_completed` 证据事件的 `details.timing` 返回 `understandingMs` 与 `modelAttempts`（理解阶段网关调用次数，包含格式修复）；成功走到计算/解释阶段的 `semanticContext.timing` 返回 `sourceReadMs`（来源读取与确定性计算）及 `analysisMs`（证据解释调用）。均为毫秒，不包含原始模型输出或凭据，不代表执行授权。没有进入相应阶段时字段可缺省，不应显示成“已完成且耗时为零”。模型未启用解释或预算拒绝前未调用解释时 `analysisMs=0`，须结合 `analysis.status` 判断。

2026-09-10 只读联调增量：`scenario.readPlans` 支持 `datasets[].filter`、`datasets[].expand`、计划 `coverage` 与 `analysis.enabled`，契约与示例见 [发布消费指南](../../guides/PUBLISHED_MODEL_WORKBENCH.md)。智脑响应 `semanticContext` 增加 `coverage/analysis/comparisons`；单根保留 `calculations`，多根结果分别位于 `comparisons[].results`。`partial` 表示范围或解释未完成，`incomplete` 表示源数据/权限/图闭包核验失败，均不授权写入。回放 `expectedError` 新增环、断链、未知边状态和深度耗尽；仍需正反例及草稿指纹匹配。

### 2026-09-10 关联计算与发布消费

新增 `POST /api/meta-models/oa-governance/read-plan-replay`，需要 `meta_model.publish` 及执行角色检查。正文 `{candidateFingerprint,cases}`；每例 `planId/target/records` 加完整 `expected` 或 `expectedError`，2–24 例。原 `case-replay` 兼容 `mode=ontology-read`，不能借原校验入口绕过发布角色检查。存储回放摘要及指纹，不存原始记录。

草稿 `scenario.readPlans` 最多三个不同编号的方案，强制 `requireCaseReplay=true`，每个须正例和反例，不混用旧 `decisionBindings`。每轮只执行明确选定的一个；业务知识页通过 `GET /api/agent/knowledge-library/joint-plans` 获取目录，再向 `joint-brief` 提交 `planId`、`expectedModelVersion`、`expectedModelFingerprint`（24位），旧选择变化则拒绝读取。主聊天尚无多方案选择控件，不自动猜选。创建运营提案可传 `adoptionMode=merge|replace`，缺省 merge，采纳时使用已存模式，不允许确认参数偷换。智脑 `/api/agent/message` 响应包含 `semanticContext` 计算和版本证据。连接器 `ontology-query.v1`、部署权限与错误边界见 [完整指南](../../guides/PUBLISHED_MODEL_WORKBENCH.md)。

### 2026-09-10 提案与材料兼容扩展

任务创建仍使用原接口及 `parentTaskId`，材料引用由服务器维护，不接受请求体伪造 workspace。提案新增只读 `businessValidation`、`worldModel`、`scenario` 与 `stateMachines` 字段；世界模型需求是带原文证据的待评审候选，不是执行指令。附件报告新增 `extractionComplete` / `contextTruncated`；保留原 `truncated` 兼容展示。上传样本结果标为 `uploaded_scoped_samples`，身份以当前认证为准。对象/字段上限统一为40/80，关系上限仍为40。详见 [操作指南](../../guides/SEMANTIC_MATERIAL_WORKSPACE.md)。

### 2026-09-09 兼容扩展

仍使用 `/api/meta-models/oa-governance/draft`，未新增公共执行接口。保存体新增 `modelingProfile`（`oa-approval` / `general`）、`scenario`（`objective`、`questions`、`decisionBindings`、`actionBindings`），并允许保存状态机和事件。对象可带 `granularity`；关系可带 `provenanceType`、`evidence`、`validFrom`、`validTo`。旧草稿默认为 OA 校验，不静默迁移。

判断绑定示例：`{ "capabilityId": "quality_disposition", "version": "1.0.0", "objectType": "QualityEvent" }`；动作依赖示例：`{ "toolId": "create_quality_investigation", "decisionId": "quality_disposition", "objectType": "QualityEvent" }`。这些仅是受控声明，不开放工具调用、不改变 IAM。

可执行的只读绑定增加 `inputMapping: { id: "risk_id", severity: "severity", status: "status" }` 和可选 `parameters: { investigationSeverities: ["P0", "P1"], maxEvidenceAgeMinutes: 60 }`。映射仅引用对象字段，禁止脚本与嵌套路径；参数仅允许这两个键。`scenario.requireCaseReplay` 为可选布尔值。读取、保存、校验草稿返回 `draft.fingerprint`。

`POST /api/meta-models/oa-governance/case-replay` 接收 `{candidateFingerprint,cases}`；`GET` 同路径读取当前租户/主体的最近报告。要求 `page.semantic-operations.view` 和 `meta_model.draft.validate`。样本准入使用服务端身份上下文；上传失败返回 `status: failed`，不是业务动作失败，且没有业务执行。草稿过期返回 409 / `REPLAY_DRAFT_STALE`。样本格式见操作指南，OpenAPI 已纳入此接口。

发布入口先校验可选回放门禁，再保留固定操作版本，核对独立服务的版本和指纹并对本地草稿执行比较后提交。`PUBLICATION_BUSY`、`PUBLICATION_REPLAY_REQUIRED`、`PUBLICATION_ALREADY_COMPLETED`、`PUBLICATION_RECEIPT_UNCONFIRMED`、`PUBLICATION_OUTCOME_UNKNOWN`、`PUBLICATION_RECONCILIATION_REQUIRED` 和 `ONTOLOGY_PUBLICATION_STALE` 均返回 409；结果不确定后只读查询，不重复调用外部发布。不得将其显示为已完成或自动补偿成功。

`authoring-profile` 返回允许的场景、粒度和内置判断目录。模拟响应增加 `decisionReplay`、`sourceMode: synthetic`、`verifiesLiveSystems: false`。保存返回的 `draft.dependencyImpact` 只覆盖声明的模型依赖。发布 HTTP 路径仍要求独立语义服务登记成功。完整步骤与限制见 [场景建模指南](../../guides/ONTOLOGY_SCENARIO_MODELING.md)。

### 当前接口

`case-replay` 支持第三种联合类型 `identity_mapping`：要求 `knownAt/query.left/query.right/records/mappings`，每条来源引用为 `{system,objectType,id}`，映射含 source、canonical、granularity、时间/范围/证据元数据。每案例最多 200 条来源记录与 500 条映射。`expected` 为 `same_entity/different_entity/unresolved/conflict/needs_review`。报告附 `identity` 和可选 `baselineIdentity`，只包含左右解析状态、时刻及有效映射数，不回传原始记录或统一编号。错误模型、重分配、重复修订等返回案例 `actual: IDENTITY_*`，不能作为正常预期结果计为通过。整批权限和指纹门禁保持不变。

`case-replay` 新增联合类型 `kind: relation_history`，不要求判断案例的 `objectType/record`，改用 `knownAt/query/records/relations`。`expected` 可为 `related/not_related/conflict/needs_review`；结果附 `temporal`（有效时刻、已知截止、可见修订数、有效关系数、命中数及冲突原因），有发布基线时附 `baselineTemporal`。未指定 kind 的旧判断案例兼容。模型指纹过期及整批权限拒绝沿用原规则。

每案例最多 200 个端点和 500 条修订；修订必须有来源、版本、有效期、记录时间及证据引用。查询、有效期和记录时间使用带时区 ISO 格式。输入格式错误为 `REPLAY_CASES_INVALID`，越权为 `REPLAY_SCOPE_INVALID` 且无部分案例结果。单案例模型引用等错误体现在 `actual` 的 `RELATION_*` 错误码，不计为预期业务结果通过。完整格式见指南和 OpenAPI。

| 方法 | 路径 | 说明/写权限 |
| --- | --- | --- |
| GET | `/api/meta-objects` | 核心元对象层；Schema `1.1.0` 包含 `Person/RawMaterial/Product/Equipment/Store` |
| GET | `/api/meta-models`、`/:id` | 元模型目录/详情 |
| GET | `/api/meta-models/oa-governance/authoring-profile` | 当前角色建模能力、约束，以及经本机 Semantica 脱敏投影的候选对象/关系；不返回原始业务记录 |
| GET/POST | `/api/meta-models/oa-governance/draft` | 草稿；写需 `meta_model.draft.save` |
| POST | `/api/meta-models/oa-governance/draft/validate` | `meta_model.draft.validate` |
| GET | `/api/meta-models/oa-governance/simulation` | 最近模拟构建结果或待构建状态 |
| POST | `/api/meta-models/oa-governance/simulate-build` | `meta_model.simulate` |
| POST | `/api/meta-models/oa-governance/publish` | `meta_model.publish` |
| GET | `/api/world-model` | 世界图投影（2026-09-28 阶段 6 起：管理 Web 无入口，端点保留一个版本周期） |
| GET | `/api/world-model/templates`、`/:id` | 模板（同上，保留一个版本周期） |
| GET | `/api/world-model/connection-targets` | 允许连接目标（同上） |
| GET/POST | `/api/world-model/drafts` | 草稿；写需 `meta_model.draft.save`（原 `world.draft.*` 已按 [ADR-026](../../architecture/adr/ADR-026-permission-equivalence-merge.md) 等价并入，条目删除） |
| POST | `/api/world-model/drafts/:id/validate|publish` | 分别需 `meta_model.draft.validate` / `meta_model.publish` |
| GET | `/api/semantic-context` | 语义概览 |
| GET | `/api/semantic-operations/tasks` | 当前身份的元域智语任务窗口与审计时间线 |
| GET | `/api/semantic-operations/sources?query=` | 按角色和自然语言范围返回来源目录、连接就绪度、已有映射和接入物料；不查询业务明细 |
| POST | `/api/semantic-operations/tasks` | 从自然语言或 PDF/图片/JSON/YAML/CSV 受控材料生成任务；写类意图只形成待确认计划 |
| PATCH | `/api/semantic-operations/tasks/:id/proposal` | 修订待确认提案的对象、字段、主键和关系；需 `meta_model.draft.save`、当前 `revision` 与任务所属身份 |
| POST | `/api/semantic-operations/tasks/:id/execute` | 执行任务预绑定命令；按任务声明的业务权限再次授权，且只能执行一次 |
| POST | `/api/semantic-operations/proposals` | 生成带 Schema Critic 与 Diff 的待审阅模型建议 |
| POST | `/api/semantic-operations/proposals/:id/apply` | 将当前身份的建议保存为未发布草稿；需 `meta_model.draft.save` |
| GET | `/api/semantic-operations/snapshots` | 当前身份可见的草稿快照 |
| POST | `/api/semantic-operations/snapshots/:id/rollback` | 回滚到指定快照；需显式权限与确认 |
| GET | `/api/agent/knowledge?query=` | 企业知识目录/检索 |

写请求应携带 `expectedVersion`；目标发布接口支持幂等键、变更说明和审批引用。错误码：`MODEL_VALIDATION_FAILED`、`MODEL_VERSION_CONFLICT`、`SOURCE_NOT_ALLOWED`、`SEMANTIC_EVIDENCE_FORBIDDEN`。

元域智语任务执行接口不接受客户端命令参数。命令、权限和目标建议均来自服务器端已持久化任务，避免确认请求被篡改为另一项操作。

任务中的 `planning` 是模型建议，`authoritativeIntent` 才是服务器权威意图；`sourceDiscovery` 记录来源状态、阻断项、准备提醒和所需接入物料。客户端不能使用 `suggestedIntent` 构造执行请求。

结构化材料形成的提案在 `proposal.schemaDiscovery` 中返回文件格式、来源系统、对象、字段约束、引用关系和警告，不返回附件 Base64 或原始文档正文。

提案返回 `revision`、`fieldDefinitions`、`editDiff`、`impactAnalysis`、`mappingValidation` 和最近修订记录。字段定义中的 `sourceField` 表示源系统字段，`mappingStatus` 只允许 `mapped/manual/derived/ignored/pending`。PATCH 请求体仅接受 `revision`、`objectTypes`、`relationshipTypes`；服务端会重新构造 `fields` 与唯一主键标记。旧 revision 返回 `SEMANTIC_PROPOSAL_REVISION_CONFLICT`，无效对象/关系返回 `SEMANTIC_PROPOSAL_INVALID`，两种情况都不会修改元模型草稿。

`impactAnalysis` 返回风险等级、变化对象、主键变化、删除对象/字段、受影响关系、待确认映射和必要人工动作。它是确定性结构比较结果，不是模型生成结论。

`mappingValidation` 使用 `semantic-mapping-validation.v1`，其中 `contract` 为 `semantic-mapping-contract.v1`。响应包含对象验证状态、字段观察覆盖率、样本转换数、聚合问题和最多 3 条 Canonical Fact 预览。`sourceMode=stateful_mock_only` 表示结果只来自服务端 Mock；`blocked=true` 时采纳接口返回 `SEMANTIC_PROPOSAL_MAPPING_VALIDATION_FAILED`。无 Mock 样本返回 `unverified` 警告，但不会伪装为通过。

## 开发约束与验证

入口：core/meta/world/semantic/knowledge 服务、`semantic-operations-agent-service.js`、`semantic-operations-task-service.js`、`semantic-operations-planner-service.js`、`semantic-source-discovery-service.js`、`semantic-schema-discovery-service.js`、`services/semantic-context`、独立 `apps/semantic-operations-console`，以及 `docs/architecture/CORE_META_OBJECTS.md`、`OA_META_MODEL.md`。

不可破坏：核心对象使用权威投影；`Store` 必须保留权威 `store_id + organizationId`，门店数据域不能由客户端声明；草稿/校验/发布权限分离；发布不可静默覆盖；证据必须带来源与分类；语义服务不能认证或执行工作流；外部知识和系统记录视为不可信，必须经过间接注入检查；客户端不能指定任务执行命令或权限；写任务确认前不得改变模型；任务、建议和快照必须按当前身份隔离；提案修订必须校验 owner、pending 状态和 revision；字段、主键与关系只能经服务端清洗和 Critic 后保存；字段映射必须保留 `sourceField/mappingStatus`，新增映射默认 pending；影响分析必须由确定性结构比较产生，不能被模型文本覆盖；映射验证只能从服务端受控样本产生，浏览器不能声明验证通过；必填、类型或主键样本校验失败必须同时阻止前端确认和服务端采纳；无样本只能标记 unverified；结构化 Schema 成功发现后不得自动补入材料范围外对象；模型规划是建议而不是授权；来源预检不得产生下游业务查询。

验证：

```powershell
npm.cmd run test:security
npm.cmd run test:permissions
npm.cmd run test:semantic
npm.cmd run typecheck
npm.cmd run build
```

修改 Schema 时说明向后兼容、数据迁移、索引重建和 Agent evidence 映射影响。

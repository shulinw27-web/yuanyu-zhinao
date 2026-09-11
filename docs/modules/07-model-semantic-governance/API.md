# 模型与语义治理 API

## 2026-09-12 引用式解释契约

现有智脑消息接口的 `semanticContext.analysis` 增加以下字段，不新增端点、不改变身份和授权要求：

- `citations[]`：`ref/key/system/objectType/id/version`，只列解释引用到的来源记录标识。计算和查询范围仍以 `comparisons` 为准。
- `verification`：`schemaVersion="ontology-claims.v2"`、`contextId`、`sourceReferencesVerified`、`metricReferencesVerified`、`gapClaimsVerified`；通过时前三类核验为 true，`narrativeEntailmentVerified=false`，不声称任意自然语言已获证实。
- `evidenceValidation`：仅含 `passed/signals`，不包含模型原文。
- `code=ANALYSIS_CLAIM_CONTRACT_INVALID`：JSON、快照、引用或边界校验失败；`ANALYSIS_EVIDENCE_CONFLICT`：命中已有财务矛盾防护。均为解释 incomplete、整体 partial，不返回被拒绝的解释正文。

`semanticContext.timing.analysisProposalCharacters` 统计安全网关返回的提案字符数，`analysisAnswerCharacters` 统计渲染结果（解释拒绝时为 0）；`analysisMs` 包括生成、校验和渲染。未进入阶段时字段可能缺省。模型网关新增服务端内部选项 `answerContract="ontology_claims"`，该调用的 `agent-summary.v1.answer` 为原生 JSON 对象，网关再序列化供业务校验。其他聊天调用仍使用字符串，不能由用户消息切换内部协议。客户端只消费服务端渲染的可读解释。字段和上限见 [解释核验指南](../../guides/PUBLISHED_MODEL_WORKBENCH.md)。

2026-09-11 耗时诊断：`turn_understanding_completed` 证据事件的 `details.timing` 返回 `understandingMs` 与 `modelAttempts`（理解阶段网关调用次数，包含格式修复）；成功走到计算/解释阶段的 `semanticContext.timing` 返回 `sourceReadMs`（来源读取与确定性计算）及 `analysisMs`（证据解释调用）。均为毫秒，不包含原始模型输出或凭据，不代表执行授权。没有进入相应阶段时字段可缺省，不应显示成“已完成且耗时为零”。模型未启用解释或预算拒绝前未调用解释时 `analysisMs=0`，须结合 `analysis.status` 判断。

2026-09-10 只读联调增量：`scenario.readPlans` 支持 `datasets[].filter`、`datasets[].expand`、计划 `coverage` 与 `analysis.enabled`，契约与示例见 [发布消费指南](../../guides/PUBLISHED_MODEL_WORKBENCH.md)。智脑响应 `semanticContext` 增加 `coverage/analysis/comparisons`；单根保留 `calculations`，多根结果分别位于 `comparisons[].results`。`partial` 表示范围或解释未完成，`incomplete` 表示源数据/权限/图闭包核验失败，均不授权写入。回放 `expectedError` 新增环、断链、未知边状态和深度耗尽；仍需正反例及草稿指纹匹配。

## 2026-09-10 关联计算与发布消费

新增 `POST /api/meta-models/oa-governance/read-plan-replay`，需要 `meta_model.publish` 及执行角色检查。正文 `{candidateFingerprint,cases}`；每例 `planId/target/records` 加完整 `expected` 或 `expectedError`，2–24 例。原 `case-replay` 兼容 `mode=ontology-read`，不能借原校验入口绕过发布角色检查。存储回放摘要及指纹，不存原始记录。

草稿 `scenario.readPlans` 最多一个方案，强制 `requireCaseReplay=true`，不混用旧 `decisionBindings`。创建运营提案可传 `adoptionMode=merge|replace`，缺省 merge，采纳时使用已存模式，不允许确认参数偷换。智脑 `/api/agent/message` 响应新增 `semanticContext` 计算和版本证据。连接器 `ontology-query.v1`、部署权限与错误边界见 [完整指南](../../guides/PUBLISHED_MODEL_WORKBENCH.md)。

## 2026-09-10 提案与材料兼容扩展

任务创建仍使用原接口及 `parentTaskId`，材料引用由服务器维护，不接受请求体伪造 workspace。提案新增只读 `businessValidation`、`worldModel`、`scenario` 与 `stateMachines` 字段；世界模型需求是带原文证据的待评审候选，不是执行指令。附件报告新增 `extractionComplete` / `contextTruncated`；保留原 `truncated` 兼容展示。上传样本结果标为 `uploaded_scoped_samples`，身份以当前认证为准。对象/字段上限统一为40/80，关系上限仍为40。详见 [操作指南](../../guides/SEMANTIC_MATERIAL_WORKSPACE.md)。

## 2026-09-09 兼容扩展

仍使用 `/api/meta-models/oa-governance/draft`，未新增公共执行接口。保存体新增 `modelingProfile`（`oa-approval` / `general`）、`scenario`（`objective`、`questions`、`decisionBindings`、`actionBindings`），并允许保存状态机和事件。对象可带 `granularity`；关系可带 `provenanceType`、`evidence`、`validFrom`、`validTo`。旧草稿默认为 OA 校验，不静默迁移。

判断绑定示例：`{ "capabilityId": "quality_disposition", "version": "1.0.0", "objectType": "QualityEvent" }`；动作依赖示例：`{ "toolId": "create_quality_investigation", "decisionId": "quality_disposition", "objectType": "QualityEvent" }`。这些仅是受控声明，不开放工具调用、不改变 IAM。

可执行的只读绑定增加 `inputMapping: { id: "risk_id", severity: "severity", status: "status" }` 和可选 `parameters: { investigationSeverities: ["P0", "P1"], maxEvidenceAgeMinutes: 60 }`。映射仅引用对象字段，禁止脚本与嵌套路径；参数仅允许这两个键。`scenario.requireCaseReplay` 为可选布尔值。读取、保存、校验草稿返回 `draft.fingerprint`。

`POST /api/meta-models/oa-governance/case-replay` 接收 `{candidateFingerprint,cases}`；`GET` 同路径读取当前租户/主体的最近报告。要求 `page.world.view` 和 `meta_model.draft.validate`。样本准入使用服务端身份上下文；上传失败返回 `status: failed`，不是业务动作失败，且没有业务执行。草稿过期返回 409 / `REPLAY_DRAFT_STALE`。样本格式见操作指南，OpenAPI 已纳入此接口。

发布入口先校验可选回放门禁，再保留固定操作版本，核对独立服务的版本和指纹并对本地草稿执行比较后提交。`PUBLICATION_BUSY`、`PUBLICATION_REPLAY_REQUIRED`、`PUBLICATION_ALREADY_COMPLETED`、`PUBLICATION_RECEIPT_UNCONFIRMED`、`PUBLICATION_OUTCOME_UNKNOWN`、`PUBLICATION_RECONCILIATION_REQUIRED` 和 `ONTOLOGY_PUBLICATION_STALE` 均返回 409；结果不确定后只读查询，不重复调用外部发布。不得将其显示为已完成或自动补偿成功。

`authoring-profile` 返回允许的场景、粒度和内置判断目录。模拟响应增加 `decisionReplay`、`sourceMode: synthetic`、`verifiesLiveSystems: false`。保存返回的 `draft.dependencyImpact` 只覆盖声明的模型依赖。发布 HTTP 路径仍要求独立语义服务登记成功。完整步骤与限制见 [场景建模指南](../../guides/ONTOLOGY_SCENARIO_MODELING.md)。

## 当前接口

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
| GET | `/api/world-model` | 世界图投影 |
| GET | `/api/world-model/templates`、`/:id` | 模板 |
| GET | `/api/world-model/connection-targets` | 允许连接目标 |
| GET/POST | `/api/world-model/drafts` | 草稿；写需 `world.draft.create` |
| POST | `/api/world-model/drafts/:id/validate|publish` | 对应按钮权限 |
| GET | `/api/semantic-context` | 语义概览 |
| GET | `/api/semantic-operations/tasks` | 当前身份的语义运营任务窗口与审计时间线 |
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

语义运营任务执行接口不接受客户端命令参数。命令、权限和目标建议均来自服务器端已持久化任务，避免确认请求被篡改为另一项操作。

任务中的 `planning` 是模型建议，`authoritativeIntent` 才是服务器权威意图；`sourceDiscovery` 记录来源状态、阻断项、准备提醒和所需接入物料。客户端不能使用 `suggestedIntent` 构造执行请求。

结构化材料形成的提案在 `proposal.schemaDiscovery` 中返回文件格式、来源系统、对象、字段约束、引用关系和警告，不返回附件 Base64 或原始文档正文。

提案返回 `revision`、`fieldDefinitions`、`editDiff`、`impactAnalysis`、`mappingValidation` 和最近修订记录。字段定义中的 `sourceField` 表示源系统字段，`mappingStatus` 只允许 `mapped/manual/derived/ignored/pending`。PATCH 请求体仅接受 `revision`、`objectTypes`、`relationshipTypes`；服务端会重新构造 `fields` 与唯一主键标记。旧 revision 返回 `SEMANTIC_PROPOSAL_REVISION_CONFLICT`，无效对象/关系返回 `SEMANTIC_PROPOSAL_INVALID`，两种情况都不会修改元模型草稿。

`impactAnalysis` 返回风险等级、变化对象、主键变化、删除对象/字段、受影响关系、待确认映射和必要人工动作。它是确定性结构比较结果，不是模型生成结论。

`mappingValidation` 使用 `semantic-mapping-validation.v1`，其中 `contract` 为 `semantic-mapping-contract.v1`。响应包含对象验证状态、字段观察覆盖率、样本转换数、聚合问题和最多 3 条 Canonical Fact 预览。`sourceMode=stateful_mock_only` 表示结果只来自服务端 Mock；`blocked=true` 时采纳接口返回 `SEMANTIC_PROPOSAL_MAPPING_VALIDATION_FAILED`。无 Mock 样本返回 `unverified` 警告，但不会伪装为通过。

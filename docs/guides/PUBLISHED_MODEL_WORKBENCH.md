# 已发布语义模型接入智脑：操作与开发指南

适用版本：2026-09-12。此链路让运营端定义业务，智脑按发布定义解释术语、读取授权事实和计算指标。它不是让大模型凭常识猜企业规则，也不赋予模型新的数据权限。

## 解释结果怎样核验

启用读计划解释后，模型不再直接撰写来源事实和计算值。服务端为本轮已授权快照建立引用目录；专用 `answerContract: "ontology_claims"` 让模型在 `agent-summary.v1.answer` 中返回原生 `ontology-claims.v2` 对象，而不是再套一层 JSON 字符串。网关完成外层/安全校验后将对象序列化供来源校验器使用，最后由服务端生成用户可读文字。业务客户端收到的仍是可读解释，而不是原始 JSON。

普通聊天和意图理解的原有协议不变。当前方舟仍使用现有 `json_object` 请求模式，并在系统提示中提供完整对象 Schema；不能宣称方舟已强制全部 Schema 约束。原生对象消除“外层 JSON 合法、内层字符串漏引号”的双重序列化问题，但来源引用、长度与授权始终由服务端验证，不依赖供应商保证。

| 引用 | 可选择的内容 | 服务端保证 |
| --- | --- | --- |
| `r` | 记录及实际字段名 | 记录属于本轮授权快照，字段值从原记录填入；同号不同系统不合并 |
| `m` | 已声明的计算指标 | 值来自确定性执行器，不接受模型自填指标值 |
| `d` | 根对象下的查询数据集 | 明确当前查询范围和记录数，可作为核查建议的上下文 |
| `g` | 服务端预先列出的缺口 | 只包括实际为 null/空字符串的字段和本轮零记录数据集；0、false、pending 不自动成为缺失 |

提案必须原样返回 `contextId`，最多选择 24 条记录（每条 12 个字段）、30 个指标、16 个缺口；待验证解释和建议各最多 6 条，每条建议不超过 240 字、协议硬上限 600 字符（含编号、单位、状态码），引用 1–12 个有效 `r/m/d/g`。整个提案仍限制 16,000 字符，不截断后冒充完整答案。建议引用 `g` 时仍校验实际缺口，并展开来源字段或查询范围；陌生缺口编号拒绝。引用仅用于本次解释，不是凭据，不授权后续读取。提案不能增加工具或执行动作。

非法字段、陌生引用、旧快照、过量内容或错误 JSON 返回 `ANALYSIS_CLAIM_CONTRACT_INVALID`；已复现的财务矛盾模式继续返回 `ANALYSIS_EVIDENCE_CONFLICT`。解释标为 incomplete，整体 partial，不展示错误正文；仍保留经过授权的确定性结果。不会为了得到全绿而自动追加模型修补调用。模型返回后仍重新检查访问权限和发布版本。

核销表只直接保存 `bank_id` 不代表缺少发票/订单关联：应沿真实 `bank_id→invoice_id→order_id` 核对。当前有限冲突检查在所有 matched 记录均可连接时，拒绝已复现的“仅直接存 bank_id 所以未提供完整链路”措辞；有断链、缺发票或要求更细行级凭证不据此拒绝。它仍不是任意措辞的通用事实识别器。

`analysis.citations` 是所引用的来源记录标识，不是额外明细；`analysis.verification` 区分来源、指标、缺口引用核验与自然语言推理核验。`narrativeEntailmentVerified=false` 必须保留：建议引用存在，不代表建议一定正确或因果已经证实。界面中的“待验证解释”和“建议（尚未执行）”不可改标为已确认事实/已完成任务。

隔离诊断继续使用 `npm run benchmark:ontology-model -- --evidence-regression`（12 次有界逻辑调用）；可加 `--case=finance` 仅跑财务四组合。输出中的 `syntheticProposal` 只记录该脚本内置合成样本的安全提案，方便定位契约问题；生产日志不记录原始提案。`analysisProposalCharacters` 与 `analysisAnswerCharacters` 分别统计提案和最终可读解释，拒绝输出时后者为 0；`analysisMs` 包括校验和渲染。具体实测与保留的失败见 [修复报告](../development/SUPPLY_CHAIN_INCIDENT_REPAIR.md)。

无需重复调用模型时，可运行 `node scripts/replay-ontology-claims.mjs output/ontology-model-ab/<批次>`，以当前内置合成快照重验该批保存的 v2 提案。它不加载密钥、不读企业系统，另写带时间戳的 replay 报告，不覆盖原结果；旧快照不匹配、坏 JSON、未知引用和超限继续失败。离线重放通过不是新一次模型成功生成，也不能恢复 v1 未保存的提案。

## 一、运营人员怎样完成一次配置

1. 在语义运营工作台上传 API、数据字典、合成或明确授权的样本，以及业务需求。选择“合并当前草稿”或“替换当前草稿”。替换会展示被移除对象，并在采纳时保存回滚快照；不是新建第二个并行模型。
2. 检查对象、主键、字段类型、来源系统、外键关系和统计粒度。保留冲突与未确认项，不能把默认模板当成业务事实。审批通过不等于执行完成，零库存也不是质量隔离证据。
3. 在模型人工校对页的关联计算面板导入经审阅的 JSON 方案。可导入方案数组、`{ "readPlans": [...] }` 或包含 `scenario.readPlans` 的完整定义。导入只预览，应用只修改当前未保存草稿；不会自动保存、发布或授权。
4. 逐项核对查询顺序、外键和指标公式。将方案保存到 `scenario.readPlans`，并保留 `scenario.requireCaseReplay=true`。现有 `decisionBindings` 不能和新方案混用，需明确选择本次模型的执行方式。
5. 管理员在部署配置中批准对象、字段、来源和密级；模型访问策略再配置允许角色和 `condition: "iam_scope"`。两者及 IAM 范围取交集，缺任何一层都拒绝。导入模型本身不授权。
6. 保存、结构校验，使用案例回放面板导入正反例数组。每个方案至少一个正确结果案例、一个缺失或冲突案例；必须具备发布权限，报告需绑定当前草稿指纹。改公式、字段或权限后须重新回放。
7. 回放通过后模拟构建、发布到 Semantica。仅发布成功且回执匹配的定义进入业务消费；编辑中的草稿不会覆盖已发布口径。
8. 在智脑中提问，例如“只读分析 ORD-X900 的需求、可用量、缺口和曙光额度，说明模型版本”。智脑收到的是实际发布定义，不必再次上传建模材料。继续追问“信用缺口呢”，沿用订单目标，但重新按当前发布口径读取。

测试材料与方案在 `examples/semantic-schemas/cross-channel-fulfillment/`；`read-plan.mjs` 只构造示例方案，不被产品服务导入。运行下文联测后，输出目录中的 `*-reviewed-definition.json`、`*-replay-cases.json` 可用于人工校对页的演练。它们是合成数据，不能冒充真实企业记录。

## 二、读计划是什么

当前一个活动工作区模型最多启用一个读计划，每次接受 1–3 个明确根对象编号。多根逐一核验，响应 `comparisons` 分别返回指标，不将共享后代数量直接相加。计划包含 `id`、`label`、`datasets`、可选 `preconditions`、`outputs`，也可声明下述闭包、覆盖和证据解释。

```json
{
  "id": "order-total",
  "label": "订单金额核对",
  "datasets": [{
    "id": "orders", "objectType": "SalesOrder",
    "where": [{ "field": "order_id", "target": true }]
  }],
  "outputs": [{
    "id": "amount", "label": "订单金额", "unit": "CNY",
    "expression": { "op": "one", "dataset": "orders", "field": "amount" }
  }]
}
```

示例需配套真实字段定义和币种前置检查，不能只把展示单位写成 CNY 就视为完成换汇。复杂示例提供件/箱及 CNY 前置检查，未知单位或币种拒绝计算。

后续数据集通过 `where: [{field, dataset, sourceField}]` 关联已查询数据集。连接双方必须在 `fieldDefinitions.reference/referenceField` 中声明外键，不按同名字段猜关系。一个对象只允许一个来源系统。

表达式支持 `literal/field/one/lookup/sum/all/if/output/add/sub/mul/max/eq/ne/and/or/gt`。`one` 和 `lookup` 要求唯一命中，`output` 只能引用前面指标。没有 SQL、脚本、动态 URL 或 `eval`。目前最多 24 个数据集、24 个前置条件和 24 个输出，深度 14、800 个表达式节点，执行最多 100,000 步。方案语义仍由业务人员审阅；自然语言需求候选不会自动变为这些表达式。

## 三、开发需要配置什么

### 对象权限

服务端环境变量 `ONTOLOGY_RUNTIME_GRANTS_JSON` 默认不设置，即默认拒绝新链路。结构示意如下，字段应按实际模型收窄；不要把示例角色推广给全员：

```json
{
  "your-tenant": {
    "executive": {
      "metadata": true,
      "objects": {
        "SalesOrder": {
          "system": "ERP",
          "fields": ["order_id", "amount", "currency"],
          "classifications": ["internal"]
        }
      }
    }
  }
}
```

`metadata` 单独允许读取模型定义，不等于允许查业务记录。模型策略需要明确 allow；适用 deny 优先。不支持的条件和字段脱敏策略目前拒绝，不能悄悄退化为全字段读取。权限来自认证请求，正文传入 tenant/subject 不能覆盖身份。发布定义记录发布租户，跨租户不加载。

部署授权配置变更会使旧助手上下文失效；这不等于可以撤回用户已经看过的内容，也不代表已经完成所有模型策略变更的历史消息逐字段清理。

### 企业连接器

沿用服务端 `ENTERPRISE_CONNECTORS_CONFIG_JSON`。地址、令牌引用和路径由管理员设置，模型和附件不能提供任意目标地址。类型化查询要求连接器支持下列请求与响应，不接受普通 Demo 检索冒充成功：

```json
{
  "schemaVersion": "ontology-query.v1",
  "objectType": "SalesOrder",
  "fields": ["order_id", "amount", "currency"],
  "filter": { "field": "order_id", "values": ["ORD-X900"] },
  "limit": 100
}
```

上例是 `query` 子对象。实际 POST 正文为 `{systemId, query, access: {roleId, tenantId, subjectId}}`；systemId 为小写系统码，access 由服务端认证上下文构造。连接器仍须核验服务凭据，不能接受公网匿名请求伪造的 access。

响应包含 `records` 与 `queryCoverage`。后者必须声明 `schemaVersion: "ontology-query.v1"`、`complete: true` 和 `queryFingerprint`（仅收到的 `query` 对象按 `JSON.stringify` 序列化后的 SHA-256，不是整个 POST 正文）。记录必须携带 id、system、objectType、tenantId、organizationId、classification、version、occurredAt 和 payload；id 必须匹配 payload 的模型主键。服务端仍重新校验字段、范围与过滤条件；覆盖声明不是绕过核验的凭证。

每跳最多 100 条记录、100 个关联值；每个根对象最多处理 500 条原始返回记录（重复投递也计入预算）、64 个查询步骤。每次连接超时 8 秒、响应上限 1 MiB，每根计划在各跳及计算前检查 60 秒期限。最多三根分别受限，并非整个请求只需 60 秒。拒绝重定向、来源不符、缺失字段、跨范围记录及冲突版本；不自动切换 Mock，不用截断结果计算“全量”。

### 拆合批后代与按问题解释

数据集可增加 `filter: {field, values}`，准入校验后按状态过滤，例如领料只纳入 `issued`。有同类型后代关系时增加：

```json
{
  "expand": {
    "edgeObjectType": "LotGenealogy",
    "fromField": "parent_id", "toField": "child_id", "stateField": "status",
    "activeStates": ["executed"], "inactiveStates": ["planned", "revoked"],
    "maxDepth": 8
  }
}
```

边两端必须声明指向当前对象主键的外键。执行器逐跳重新授权，前向展开后再查询下游库存/订单等；不会反向污染合批的其他父批次。收敛路径去重；环、未知状态、断链、冲突版本、深度或数量耗尽均拒绝完整结论。人工校对面板显示过滤状态、展开方向和深度，仍需审阅 JSON，尚不是任意自然语言自动编译。

计划可声明 `coverage: {mode: "bounded_declared_graph", requiredExpansions: ["lot"]}`，其中 `lot` 是带展开的数据集别名。完成状态仅指**声明的图范围**，`globalEnterpriseCoverage` 始终为 false。展开回执中的 `depth` 为实际遍历深度，`maxDepth` 为安全上限；`remainingFrontier: 0`、`termination: "no_new_descendants"` 表示已遍历至无新后代，并非“因为到达实际深度而截断”。未声明闭包的计划被问及完整范围时返回 `partial`；闭包无法核验时返回 `incomplete`，不会把缺失记录当零。

`analysis: {enabled: true}` 在确定性计算后调用模型，依据当前授权记录回答原因、疑点、联系人和建议。证据投影上限 38,000 字符，模型解释预算 60 秒；超限或输出校验失败保留计算但标记 `partial`。回答后再次核验权限和发布指纹。模型解释不是因果证明或业务执行回执，建议仍需人工核实和后续独立审批。

读计划反例回放允许验证 `READ_GRAPH_CYCLE`、`READ_DANGLING_EDGE`、`READ_EDGE_STATE_UNKNOWN`、`READ_EXPANSION_DEPTH_LIMIT`，并仍要求同指纹正例通过。完整供销存示例见 `examples/semantic-schemas/supply-chain-incident/read-plan.mjs` 的 `fullReadPlan`；原 `readPlan` 是保留的直接范围对照。

### 解释性能与观测

无需修改读计划即可使用证据表格编码：仅去除发送给解释模型的重复元数据与字段名，不丢记录、不改变确定性指标或客户端证据。原始证据仍受 38,000 字符上限约束，网关扫描、脱敏、配额和回答后的权限/版本复核保持有效。多根图成员由计算引擎提供给模型，不让模型从合并记录自行猜测共同后代。

追问只关心人员时，回答会优先列岗位、人员和有效指派；只问原因时，优先解释确认事实、疑点、证据缺口和下一步分工。明确要求完整范围或数值时仍需完整回答。这是表述优化，不是更改业务规则或少查系统。

排查延迟时查看：

- 证据事件 `turn_understanding_completed.details.timing`：理解耗时和网关调用次数。
- `semanticContext.timing.sourceReadMs/analysisMs`：读取计算和模型解释耗时。
- `analysisPromptCharacters/evidenceOriginalCharacters/evidenceSentCharacters/evidenceFormat/analysisAnswerCharacters`：解释输入、证据编码及输出长度。字符数不是 token 数，不能当计费依据。

2026-09-12 起，`semanticContext.timing.model` 和理解阶段的 `timing.modelCalls` 还包含单次网关计时：`preparationMs/responseHeadersMs/bodyReadMs/validationMs/totalMs`、Ark `transport.attempts` 的白名单失败类别，以及可用时的 `usage.prompt_tokens/completion_tokens/total_tokens`。缺少用量不是零；`firstContentMs=null` 表示当前非流式通道无法测量首段内容，不能用响应头时间代替。

若需小范围同期对照，可运行 `npm run benchmark:ontology-model`。该命令会实际调用已配置的方舟模型，最多 12 次逻辑调用（原有受控连接重试可能增加传输尝试）；只使用项目合成材料，不创建用户会话或修改发布模型。输出在 `output/ontology-model-ab/<批次>/`，原始记录/表格按 ABBA 对照，另行记录隔离 SSE 的首段和末段时间。SSE 适配器只在诊断脚本生效，生产回复协议不变；全部内容收齐并通过原安全校验前不展示。`allPassed` 仅代表基础自动断言，仍须阅读答案核对明细、汇总和证据边界。

运行 `npm run evaluate:supply-chain -- --repair` 后，在该批次目录查看 `performance.json` 和实际问答文件。至少同时检查语义正确性和阶段耗时；一次变快不代表 P95 达标，缩短输出也不能掩盖丢失证据。实测与限制见 [全链路性能及修复记录](../development/SUPPLY_CHAIN_INCIDENT_REPAIR.md)。

### 明细与证据缺口复核

只读解释会携带从本轮授权来源行计算的对象/系统/记录数清单，不从模型定义推断“某对象一定有记录”。原始与表格编码使用同一清单。没有分组指标、本轮没有展开说明、记录不存在、字段为空、外部凭证未验证是不同情况，不能互相替代；到账、核销与订单/发票金额也不能混用。逐笔答复列原始字段和状态，差额计算仍以服务端声明计划提供的指标为准。

运行 `npm run benchmark:ontology-model -- --evidence-regression` 可复验“原因追问 / 财务逐笔核对 / 移除全部核销记录”三个问题，各跑原始和表格编码、非流式和隔离 SSE，共最多 12 次逻辑模型调用。无核销反例在内存合成样本中移除 Allocation，再由实际只读引擎重新计算；不是把正确答案塞入提示词。该模式是证据保真回归，不是 ABBA 性能对照，费用和隔离边界与上文相同。

检查每条 `answer` 与 `evidenceChecks`，既要核对实际流水与核销的编号、金额、状态和关联，也要检查是否把待核销说成未到账。断言仅针对已复现错误，不是通用语义真实性判定器；生产端不按这组测试正则替换模型答案，也不增加纠错模型调用。`summary.json.allPassed=true` 仍须人工复核。真实服务生效需要加载更新后的后端代码，诊断命令不会重启已有桌面或服务进程。

生产解释另有有限的证据冲突检查。若 `analysis.code=ANALYSIS_EVIDENCE_CONFLICT`，含义是解释与已读取的财务记录存在已知模式的矛盾，系统保留可信计算和授权证据，但不返回错误解释正文，整体为 partial；不是没有读取到任何数据，也不是业务已执行。可查看 `analysis.evidenceValidation` 的受控信号，核对原始来源后继续处理。它只覆盖当前 BankReceipt/Allocation/Invoice/SalesOrder 契约的已观察模式，不能代替人工审阅或认定其他句子已验证；小数金额与歧义差额仍需专门的账务计算能力。

### 回放 API

`POST /api/meta-models/oa-governance/read-plan-replay`，正文为 `{candidateFingerprint, cases}`。原 `case-replay` 接口也接受 `mode: "ontology-read"`，但此模式仍要求发布权限。

每例包含 `planId/target/records`，以及所有输出指标的 `expected` 对象，或允许的 `expectedError`。2–24 例，每例最多 500 条授权记录。样本不提交模型，不保存原始业务记录；存储当前主体的回放结果与指纹。正例全对但没有反例仍不能发布。

## 四、复现与边界

```powershell
npm run test:ontology
npm run evaluate:semantic-workbench -- --with-runtime
```

真实联测需要外部方舟配置文件和 `.venv-semantica`；脚本只对自己的回环 Mock 连接器开放合成数据权限，启动隔离 API/Semantica，结束后关闭自己的进程，不替换用户正在运行的服务。

已支持的是“人工校对规则 + 有界只读计算 + 发布驱动消费”。尚不承诺多租户独立模型注册中心、并行多模型自动选路、任意自然语言规则自动编译、跨源一致时点快照、任意历史查询、生产货币高精度账务或业务写入。多跳数据来自不同来源时点，回答必须保留来源时间，不称为全公司实时真相。

修复及实测证据见 [闭环修复报告](../development/SEMANTIC_WORKBENCH_LOOP_REPAIR.md)。

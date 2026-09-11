# 模型与语义治理技术架构

2026-09-10 全链路修复：执行器在当前对象数据集上执行逐跳授权的前向闭包，再读取下游事实；三根以内独立计算，不按供应商外部批号合并。发布消费桥接层在确定性结果后调用受控证据解释，并在回答前重新核验权限和模型指纹。图范围完整、企业全局覆盖和解释成功是不同状态。会话材料通过独立有界索引检索，不能把旧模型回答当成实时企业事实。详细边界见 [发布消费指南](../../guides/PUBLISHED_MODEL_WORKBENCH.md)。

2026-09-10 闭环增量：人工审阅的 `scenario.readPlans` 经有界表达式校验、同执行器正反例回放、Semantica 回执校验后发布；智脑只消费租户匹配的发布定义。新服务 `ontology-read-plan-service` 负责受控计算，`published-ontology-agent-service` 负责业务入口桥接。对象部署授权、模型策略、IAM 范围独立核验，样本和模型不能自授权限。见 [闭环指南](../../guides/PUBLISHED_MODEL_WORKBENCH.md) 和 [回归报告](../../development/SEMANTIC_WORKBENCH_LOOP_REPAIR.md)。

2026-09-10：新增材料工作区、输入证据保真校验、授权上传样本演练及需求候选编译服务；保持原治理存储、身份、确认与发布链路。结构化解析不再依赖模型截断摘要，见 [架构增量](../../architecture/SEMANTIC_MODEL_AUTHORING.md) 与 [修复回归](../../development/SEMANTIC_MANUFACTURING_REPAIR.md)。

## 当前代码

`core-meta-object-service.js`、`meta-model-service.js`、`world-model-template-service.js`、`semantic-context-service.js`、`enterprise-knowledge-service.js`、`semantic-operations-agent-service.js`、`semantic-operations-task-service.js`，以及独立 `services/semantic-context/app.py`。

语义运营 UI 已从业务管理前端拆出，独立应用位于 `apps/semantic-operations-console`（开发端口 `5174`）。业务端智脑不承担建模和发布职责，原世界模型页面只保留已登记语义上下文和人工精调入口。

## 子域与所有权

- Meta Model：Schema、关系、来源映射、治理规则；
- World Model：模板、实例草稿、连接目标、发布版本；
- Semantic Context：事实/关系/时间/来源的检索投影；
- Knowledge：文档目录、分块引用和分类。

四者可以同属治理模块，但各自 Repository namespace 独立。语义服务不拥有 IAM 或业务系统主数据，只保存已授权投影及来源。

核心对象 Schema `1.1.0` 新增 `Store`。门店的稳定标识为 `store_id`，权威来源为 MDM/OMS/POS/ERP；`Store → sells → Product`、`Person → manages → Store` 和 `Equipment → located_at → Store` 进入关系契约。市场角色可检索经组织范围裁剪的 OMS 门店事实，生产/采购角色不会因输入门店 ID 自动获得 OMS 数据域。

## 目标依赖

治理写入 → IAM 权限 → Schema 校验 → 来源白名单 → 版本仓 → 发布事件。Agent 通过只读 `EvidenceProvider` 访问，经安全分区后的内容才能进入模型。

独立 Python 服务应拥有明确 OpenAPI、健康检查、版本和契约测试；生产可拆分部署，但本仓的 domain contract 保持一致。

## Agent 驱动的运营闭环

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

## 本地模型规划与来源发现

语义运营 Agent 复用平台模型网关调用本地 Qwen3-8B。模型只返回 `semantic-operations-plan.v1` 结构化建议，包括目标、相关系统、规划依据和必要澄清问题。服务器的确定性分类和来源预检结果仍是权威边界；模型建议与服务器冲突时，任务保留冲突记录并采用服务器绑定的命令、权限、系统范围和确认策略。

来源发现由 `semantic-source-discovery-service.js` 完成，汇总 MCP 连接器目录、角色数据域、企业 Connector 配置就绪度和已有字段映射。发现过程只读取结构元数据，不访问业务明细，也不探测下游接口。未登记系统、越权数据域、不安全端点和缺失凭据会成为显式阻断项；仅有 Mock 目录时必须标记为准备提醒，不能宣称已连接真实系统。

当前已登记来源目录为 OA、ERP、WMS、MES、LIMS、QMS、OMS。WMS 已具备受控 MCP 目录、短时凭据策略、字段映射和状态化 Mock 数据；企业 Connector 未配置时仍必须标明为 Mock。SRM、MDM、PLM、EAM、IoT 可被诉求识别，但在连接器、来源契约和字段分级登记完成前只显示为待准备来源。

## 结构化 Schema 材料发现

运营端支持 PDF、图片以及 JSON、YAML、CSV 结构化材料。JSON/YAML 可识别 OpenAPI `components.schemas` 或对象式数据字典，CSV 可按表名/对象名分组字段。解析器提取对象、字段类型、必填约束、主键和 `$ref`/外键关系，再转成待审阅元对象和关系建议。

材料先经过类型签名、大小、编码和提示注入检查。解析只保留结构摘要，不持久化原文件正文。缺失主键、未分配来源、未知引用或字段分级待确认时，Schema Critic 必须阻止采纳。示例材料位于 `examples/semantic-schemas/wms-openapi.json`。

结构化材料成功发现对象后，该 Schema 是本次候选对象集合的权威来源，模型上下文中的相似业务词不能额外补出材料之外的 ERP/WMS 对象。运营人员仍可在可视化编辑器中显式新增对象，并通过保存修订触发完整校验。

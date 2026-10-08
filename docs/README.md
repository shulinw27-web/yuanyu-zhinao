# 项目文档中心

2026-09-19 草稿试算与生命周期：[操作和验证](development/MOCK_ENTERPRISE_ONBOARDING.md)。接入项目已支持人工方案只读试算；隔离 HTTP 7 项、发布生命周期 10 项通过。生命周期发布回执为测试替身。真实方舟联调返回 `AccountOverdueError`，未取得模型回答；现已补充两端明确欠费提示，不再误导用户拆分问题。

2026-09-19 审阅修复：[企业接入操作与验证](development/MOCK_ENTERPRISE_ONBOARDING.md)。读取方案面板新增操作代次保护，阻断旧导入、旧模型提案和旧策略响应覆盖当前候选；客户端、草稿或权限改变时清除候选与发送确认。完整自动建模、发布与智脑问答仍未完成。

2026-09-18 Mock 接入更新：[企业接入操作与验证](development/MOCK_ENTERPRISE_ONBOARDING.md)。已有材料、连接、可视化映射、原文版本引用及到元域智语 Agent 的待审阅建模交接，修复缺主键有依据补充后的审阅阻塞。新增完整合成快照到受控对象查询的内部适配，交接草稿配合测试授权和人工方案通过跨系统计算及 16 个回放分支；全量 quality 820 次执行通过。面向用户的计算方案生成、完整发布及智脑问答仍待推进，不能视为自动建模或真实企业连接器已完成。

2026-09-17 计划调整：[Mock 优先开发路线](development/DEVELOPMENT_ROADMAP.md)。当前无真实企业验证场景，先用合成材料和模拟接口完成接入、业务对齐、世界模型、双 Agent、持续更新和场景复用验证。本次仅调整计划，未新增功能或重跑业务验收；真实接入和生产门禁保持。

2026-09-17 调度与通知：[报告第18节](development/MULTITENANT_VALIDATION.md#18-调度扫描与巡检通知一致性2026-09-17) · [运行说明](operations/WORKER_EXECUTION_BOUNDARIES.md)。补齐后段任务领取、巡检与通知原子保存、主体级保留及身份编码防碰撞，731次Node执行通过。旧歧义归属需核验迁移，大规模调度和外部送达未验收。

2026-09-17 后台任务：[Worker执行与升级边界](operations/WORKER_EXECUTION_BOUNDARIES.md) · [报告第17节](development/MULTITENANT_VALIDATION.md#17-后台编排与巡检租约修复2026-09-17)。取消、租约过期和旧轮次不能推进任务，巡检内部准入及异常脱敏已补齐；722次Node执行通过，生产门禁保持。

2026-09-17 终端撤权：[实时信任与派发说明](operations/DESKTOP_ENDPOINT_RUNTIME.md) · [报告第16节](development/MULTITENANT_VALIDATION.md#16-终端派发撤权复验2026-09-17)。修复旧心跳信任缓存，执行入口与派发返回前复验；709次Node执行通过，生产门禁保持。

协作约定：[GitHub提交与交付](development/GITHUB_DELIVERY.md)——每次上传使用简短中文说明，附验证范围，不提交私有配置与运行数据。

2026-09-17 沙箱准入增量：[初始化与运行控制指南](guides/TENANT_RUNTIME_CONTROL.md) · [报告第15节](development/MULTITENANT_VALIDATION.md#15-沙箱初始化运行准入与门户申请界面2026-09-17)。补齐审核式人员初始化、有限功能配额、门户撤权复验及客户中心申请/取消界面；并非正式商业开通。以下为历史记录。

2026-09-17 IAM隔离补充：[认证与升级注意事项](guides/IDENTITY_PROVIDER_ADAPTERS.md) · [报告第14节](development/MULTITENANT_VALIDATION.md#14-执行面iam租户隔离2026-09-17)。IAM按租户隔离，新企业不继承Demo权限；OIDC/钉钉、HTTP授权及会话版本验证已回归，全量683次通过。门户到企业人员的初始化、权益和在途撤权未完成，不能理解为自动开通。下方为历史记录。

2026-09-17 开通流程首批：[申请与资源预检指南](guides/PORTAL_RUNTIME_PROVISIONING.md) · [报告第13节](development/MULTITENANT_VALIDATION.md#13-门户开通申请与资源预检子流程2026-09-17)。已实现后端申请/取消、版本与权限失效、只读预检和SQLite记录恢复；全量671次、真实进程16个测试计数通过。业务IAM/权益/撤权及激活仍未实现，不代表已经自动开通。以下为历史记录。

2026-09-17 备份恢复补充：[运维操作说明](guides/SEMANTIC_TENANT_INSTANCES.md) · [报告第12节](development/MULTITENANT_VALIDATION.md#12-停机备份与新库恢复演练2026-09-17)。已提供停机校验、手动备份和恢复到新库，并通过真实实例恢复演练；全量659次、进程14个测试计数、Python32项通过。未开启自动备份，未操作现有业务库。以下为历史记录。

2026-09-17 语义实例持久化：[配置及故障处理](guides/SEMANTIC_TENANT_INSTANCES.md) · [报告第11节](development/MULTITENANT_VALIDATION.md#11-单实例持久化与故障恢复2026-09-17)。已实现租户绑定SQLite原子快照、重启恢复、损坏拒绝与提交失败停读写；全量659次、真实进程14个测试计数、Python23项通过。自动开通、备份/高可用和生产隔离仍未完成。以下为此前阶段记录。

2026-09-16 独立语义实例：[接入指南](guides/SEMANTIC_TENANT_INSTANCES.md) · [真实双进程回归](development/MULTITENANT_VALIDATION.md#10-独立语义实例接入与真实联调2026-09-16)。已实现租户实例映射、服务认证、预检与操作回执；全量659次执行、独立进程7个测试计数及Python10项通过。仍为内存实例，门户自动开通与生产隔离未完成。下面为此前阶段记录。

2026-09-16 多租户修复：[报告第9节](development/MULTITENANT_VALIDATION.md#9-修复实现与回归2026-09-16)。共享草稿应用层隔离、日常限流和旧提示已修复；649次全量执行通过，含28项专项。非Demo共享Semantica访问已阻断，自动开通和独立语义实例仍未交付，不代表生产多租户就绪。

产品改版：[元域产品官网改版方案](development/PRODUCT_WEBSITE_REDESIGN.md)——首页、独立产品详情、合成案例和文档阅读首批已实施；客户中心深度改版等后续范围及验收分开记录。

新增：[产品官网与客户中心](guides/PRODUCT_PORTAL.md) · [产品化范围与验收](development/PRODUCT_PORTAL_ACCEPTANCE.md)——官网、公开技术文档、账号、租户、会员、测试充值与优惠券；不是可公开收款的生产服务。

新增：[异常助手](guides/ANOMALY_ASSISTANT.md)——非结构化汇报、来源追溯、字段校对、确认与撤回；第一阶段为个人工作区，未连接真实钉钉群或下游系统。

最新修复：[双 Agent × WeKnora 回归](development/DUAL_AGENT_WEKNORA_REPAIR.md)。已补齐问答契约/诊断、规则召回、双端选定文档补查和运营只读方案候选；简单授信方案已完成生成到发布后业务读取验证，仍需人工校对和独立回放。

2026-09-13 最新实测：[双 Agent × WeKnora 合成业务联调](development/DUAL_AGENT_WEKNORA_MOCK_TEST.md)。18 类对象、22 条关系候选及人工审定后的业务解释通过；首轮 21/23，问答、Wiki 稳定性及关键词漏检仍待修复，不代表全自动建模验收。

第七批：[发布方案目录与只读联合核验](guides/KNOWLEDGE_WORKSPACE_GUIDE.md) · [实现与测试边界](development/WEKNORA_UPGRADE_ACCEPTANCE.md)。最多三个经回放方案，每轮明确选一个，模型变更拒绝旧选择；不属于自动联合推理或生产放行。

最新第五批（2026-09-13）：[真实 WeKnora 项目接入验收](development/WEKNORA_UPGRADE_ACCEPTANCE.md) · [本机复现与使用](guides/KNOWLEDGE_WORKSPACE_GUIDE.md)。专用只读 Key/合成文档绑定已启用，双端检索及各三轮方舟回答通过；生产共享与业务联合规划仍待完成。下文旧批次“尚未接入”指当时状态。

最新第四批：[知识工作区指南](guides/KNOWLEDGE_WORKSPACE_GUIDE.md) · [WeKnora 第四批验收](development/WEKNORA_UPGRADE_ACCEPTANCE.md)。来源问答、Wiki 生成/历史恢复和多模态校对已交付，真实方舟四例通过；项目 WeKnora Key/映射尚未启用。下文第三批条目保留历史范围。

最新知识能力：[知识工作区指南](guides/KNOWLEDGE_WORKSPACE_GUIDE.md) · [WeKnora 第三批验收](development/WEKNORA_UPGRADE_ACCEPTANCE.md)。已交付资料界面、来源草稿、记忆校对与私有配置代码；真实项目 Key/映射未启用，独立实例三轮合成问答已通过。

整理日期：2026-09-03。项目说明、设计、操作指南和交付文件统一保存在本目录；源码目录不再各自保存一套说明。

## 从这里开始

最新复杂联调：[采购到门店/财务/人员全链路场景](development/SUPPLY_CHAIN_INCIDENT_SCENARIO.md) · [修复前问题](development/SUPPLY_CHAIN_INCIDENT_EVALUATION.md) · [SC-01–SC-06 修复与回归](development/SUPPLY_CHAIN_INCIDENT_REPAIR.md)。声明图核验完成不等于全企业实时覆盖。

2026-09-12 更新：[引用式解释契约与操作](guides/PUBLISHED_MODEL_WORKBENCH.md) · [当前交付、真实模型失败及回归记录](development/SUPPLY_CHAIN_INCIDENT_REPAIR.md)。历史阶段记录保留，不将已知问题被拦截等同模型总能答对。

| 你要做什么 | 先读 |
| --- | --- |
| 了解项目、接手开发 | [项目交接](overview/PROJECT_HANDOFF.md) → [当前状态](overview/PROJECT_STATUS.md) |
| 启动本地环境 | [开发与启动](development/GETTING_STARTED.md) |
| 现阶段用 Mock 推进开发与业务验证 | [阶段计划与验收规则](development/DEVELOPMENT_ROADMAP.md) → [模拟运行时](development/MOCK_SIMULATION_RUNTIME.md) |
| 准备未来真实系统联调 | [开发准备事项](development/DEVELOPMENT_READINESS.md) |
| 理解整体设计 | [整体架构](architecture/ARCHITECTURE.md) → [模块文档](modules/README.md) |
| 接入并理解 OA / 钉钉流程 | [流程语义接入架构](architecture/WORKFLOW_SEMANTIC_INTEGRATION.md) |
| 了解参考 WeKnora 的升级方向 | [采纳点与验证路线](architecture/WEKNORA_UPGRADE_REFERENCE.md) · [分批实施与接口验收](development/WEKNORA_UPGRADE_ACCEPTANCE.md) · [D 盘本地部署](operations/WEKNORA_LOCAL_DEPLOYMENT.md)（聊天与 2048 维 Embedding 原生调用通过；双端只读适配器已开发，真实集成未启用） |
| 使用智脑或元域智语端 | [操作指南目录](guides/README.md) |
| 按业务场景建设本体、配置质量判断 | [场景建模指南](guides/ONTOLOGY_SCENARIO_MODELING.md) · [验收记录](development/ONTOLOGY_MODELING_ACCEPTANCE.md) |
| 模拟真实业务材料并评估快速建模 | [制造案例需求与材料](development/SEMANTIC_MANUFACTURING_REQUIREMENTS.md) · [初测问题](development/SEMANTIC_MANUFACTURING_EVALUATION.md) · [修复回归](development/SEMANTIC_MANUFACTURING_REPAIR.md) · [操作指南](guides/SEMANTIC_MATERIAL_WORKSPACE.md) |
| 验证语义建模后智脑是否真正理解新业务 | [跨仓履约复杂场景](development/SEMANTIC_WORKBENCH_COMPLEX_SCENARIO.md) · [修复前联测](development/SEMANTIC_WORKBENCH_LOOP_EVALUATION.md) · [闭环修复报告](development/SEMANTIC_WORKBENCH_LOOP_REPAIR.md) · [配置指南](guides/PUBLISHED_MODEL_WORKBENCH.md) |
| 确认两个 Agent 的能力与边界 | [智脑能力范围](overview/ZHINAO_CAPABILITY_SCOPE.md) · [元域智语能力范围](overview/SEMANTIC_OPERATIONS_CAPABILITY_SCOPE.md) |
| 连续对话、字典追问与更正目标 | [对话及上下文使用说明](guides/AGENT_DIALOGUE_AND_CONTEXT.md) |
| 上传文件、理解图片、核对多模态能力 | [多模态指南](guides/AGENT_MULTIMODAL_GUIDE.md) · [验证与修复报告](development/AGENT_MULTIMODAL_ACCEPTANCE_2026-09-07.md) |
| 部署、回滚或判断能否上线 | [运维目录](operations/README.md) → [生产 Checklist](operations/PRODUCTION_TODO_CHECKLIST.md) |
| 查 Word、PPT、测试数据字典 | [参考与交付文件](reference/README.md) |
| 查过去的验收与演进依据 | [历史记录](archive/README.md) |

## 目录约定

```text
docs/
├─ overview/       项目概览、交接、当前状态
├─ architecture/   整体设计及跨模块技术约束
├─ modules/        11 个模块的需求、API 与实现边界
├─ development/    本地开发、准备事项、测试与开发路线
├─ operations/     部署、持久化、观测、回滚与上线检查
├─ guides/         面向使用者的操作指南
├─ reference/      文档维护规则、Word/PPT 交付文件
└─ archive/        仍有追溯价值的历史验收记录
```

当前状态以 [PROJECT_STATUS](overview/PROJECT_STATUS.md) 为导航，以代码和可复核测试为事实依据；生产待办只在 [生产 Checklist](operations/PRODUCTION_TODO_CHECKLIST.md) 维护。历史记录和旧日期的 Word/PPT 不表示当前全部能力已经上线。

新增或移动文档后运行 `npm run docs:check`。文档维护方式见 [维护规则](reference/DOCUMENTATION_POLICY.md)；本次变更与恢复方式见 [整理记录](overview/REPOSITORY_CLEANUP.md)。

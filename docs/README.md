# 项目文档中心

第六批：[业务端只读联合核验](guides/KNOWLEDGE_WORKSPACE_GUIDE.md) · [实现与测试边界](development/WEKNORA_UPGRADE_ACCEPTANCE.md)。知识来源和业务计算分列、明确编号和逐次确认；不属于自动联合推理或生产放行。

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
| 准备真实系统联调 | [开发准备事项](development/DEVELOPMENT_READINESS.md) → [开发路线](development/DEVELOPMENT_ROADMAP.md) |
| 理解整体设计 | [整体架构](architecture/ARCHITECTURE.md) → [模块文档](modules/README.md) |
| 了解参考 WeKnora 的升级方向 | [采纳点与验证路线](architecture/WEKNORA_UPGRADE_REFERENCE.md) · [分批实施与接口验收](development/WEKNORA_UPGRADE_ACCEPTANCE.md) · [D 盘本地部署](operations/WEKNORA_LOCAL_DEPLOYMENT.md)（聊天与 2048 维 Embedding 原生调用通过；双端只读适配器已开发，真实集成未启用） |
| 使用智脑或语义运营端 | [操作指南目录](guides/README.md) |
| 按业务场景建设本体、配置质量判断 | [场景建模指南](guides/ONTOLOGY_SCENARIO_MODELING.md) · [验收记录](development/ONTOLOGY_MODELING_ACCEPTANCE.md) |
| 模拟真实业务材料并评估快速建模 | [制造案例需求与材料](development/SEMANTIC_MANUFACTURING_REQUIREMENTS.md) · [初测问题](development/SEMANTIC_MANUFACTURING_EVALUATION.md) · [修复回归](development/SEMANTIC_MANUFACTURING_REPAIR.md) · [操作指南](guides/SEMANTIC_MATERIAL_WORKSPACE.md) |
| 验证语义建模后智脑是否真正理解新业务 | [跨仓履约复杂场景](development/SEMANTIC_WORKBENCH_COMPLEX_SCENARIO.md) · [修复前联测](development/SEMANTIC_WORKBENCH_LOOP_EVALUATION.md) · [闭环修复报告](development/SEMANTIC_WORKBENCH_LOOP_REPAIR.md) · [配置指南](guides/PUBLISHED_MODEL_WORKBENCH.md) |
| 确认两个 Agent 的能力与边界 | [智脑能力范围](overview/ZHINAO_CAPABILITY_SCOPE.md) · [语义运营能力范围](overview/SEMANTIC_OPERATIONS_CAPABILITY_SCOPE.md) |
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

# 项目文档中心

本地分类阅读入口：启动 `npm run dev:docs`，打开 <http://127.0.0.1:15200/>。支持按目录分类、标题与正文搜索、章节目录、文档间跳转和原文件下载。历史归档默认隐藏，不移动或复制现有文件。详见[本地文档中心使用说明](guides/LOCAL_DOCUMENT_READER.md)。

## 从这里开始

| 你要做什么 | 先读 |
| --- | --- |
| 了解项目、接手开发 | [项目交接](overview/PROJECT_HANDOFF.md) → [当前状态](overview/PROJECT_STATUS.md) |
| 启动本地环境 | [开发与启动](development/GETTING_STARTED.md) |
| 现阶段用 Mock 推进开发与业务验证 | [阶段计划与验收规则](development/DEVELOPMENT_ROADMAP.md) → [模拟运行时](development/MOCK_SIMULATION_RUNTIME.md) |
| 准备未来真实系统联调 | [开发准备事项](development/DEVELOPMENT_READINESS.md) |
| 理解整体设计 | [整体架构](architecture/ARCHITECTURE.md) → [模块文档](modules/README.md) |
| 接入并理解 OA / 钉钉流程 | [流程语义接入架构](architecture/WORKFLOW_SEMANTIC_INTEGRATION.md) |
| 了解参考 WeKnora 的升级方向 | [采纳点与验证路线](architecture/WEKNORA_UPGRADE_REFERENCE.md) · [分批实施与接口验收](development/WEKNORA_UPGRADE_ACCEPTANCE.md) · [D 盘本地部署](operations/WEKNORA_LOCAL_DEPLOYMENT.md)（当前能力与验收边界以实施记录为准） |
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

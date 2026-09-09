# 项目文档中心

整理日期：2026-09-03。项目说明、设计、操作指南和交付文件统一保存在本目录；源码目录不再各自保存一套说明。

## 从这里开始

| 你要做什么 | 先读 |
| --- | --- |
| 了解项目、接手开发 | [项目交接](overview/PROJECT_HANDOFF.md) → [当前状态](overview/PROJECT_STATUS.md) |
| 启动本地环境 | [开发与启动](development/GETTING_STARTED.md) |
| 准备真实系统联调 | [开发准备事项](development/DEVELOPMENT_READINESS.md) → [开发路线](development/DEVELOPMENT_ROADMAP.md) |
| 理解整体设计 | [整体架构](architecture/ARCHITECTURE.md) → [模块文档](modules/README.md) |
| 使用智脑或语义运营端 | [操作指南目录](guides/README.md) |
| 按业务场景建设本体、配置质量判断 | [场景建模指南](guides/ONTOLOGY_SCENARIO_MODELING.md) · [验收记录](development/ONTOLOGY_MODELING_ACCEPTANCE.md) |
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

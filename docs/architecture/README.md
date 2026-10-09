# 架构与设计

[返回文档中心](../README.md)

先读整体架构，再根据需要阅读 Agent、语义层、权限和执行协议。文档中的目标与生产要求不代表已经完成外部验收。

**架构决策记录（ADR）**：影响全局、难以逆转的决策及其理由与退出条件，见 [ADR 索引](adr/README.md)。读架构文档前建议先读 ADR，理解「为什么这样设计」。

**现状测绘与收敛建议**：[架构分析与优化](ARCHITECTURE_ANALYSIS_AND_OPTIMIZATION.md)（含实测数据、结构性问题和分阶段优化路线）。**模块化与组件化审计**：[模块化与组件化审计](MODULARIZATION_AUDIT.md)（前端与包边界、跨包引用穿透、组件分层判据）。**系统接入与建模重构方案**：[「系统接入 → 选系统建模 → 模型治理」整体重构方案](SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md)（状态：待确认，未实施）。

**约束与守护**：架构债务已登记为「只降不升」的棘轮基线，见 `backend/test/architecture-baseline.js`；违反基线的改动会在 `backend/test/architecture-boundaries.test.js` 直接失败。测绘当前实况用 `node scripts/architecture-baseline.mjs`（只读，刻意不自动写回基线）。已落地棘轮：领域导出规模上限、跨领域依赖边、服务文件规模、跨包相对路径穿透（`CROSS_PACKAGE_IMPORT_BASELINE`，8 处，见审计 2.5 节）。

- [智脑回答治理规范](AGENT_ANSWER_GOVERNANCE.md)
- [智脑执行证据追踪](AGENT_EVIDENCE_TRACE.md)
- [智脑 Agent 提示词安全与执行门禁](AGENT_PROMPT_SECURITY.md)
- [告警分级与虚拟电话模块](ALERTING_VIRTUAL_VOICE.md)
- [元域智脑：整体架构说明](ARCHITECTURE.md)
- [核心元对象层](CORE_META_OBJECTS.md)
- [IAM 权限中心说明](IAM_PERMISSION_CENTER.md)
- [密钥中心微服务 v0.1](KEY_CENTER_MICROSERVICE.md)
- [OA 组织、权限与审批元模型（Demo）](OA_META_MODEL.md)
- [OA / 钉钉流程语义接入架构](WORKFLOW_SEMANTIC_INTEGRATION.md)
- [语义上下文微服务（Semantica）v0.1](SEMANTIC_CONTEXT_MICROSERVICE.md)
- [语义层元模型与元对象建设说明](SEMANTIC_MODEL_AUTHORING.md)
- [元域智脑多端 Agent 架构技术说明书](ZHINAO_AGENT_ARCHITECTURE_V2.md)
- [元域智脑学习与数据使用控制面](ZHINAO_LEARNING_GOVERNANCE.md)
- [参考 WeKnora 升级：采纳点、设计理由与验证路线](WEKNORA_UPGRADE_REFERENCE.md)
- [Ontology Playground 融合方案](ONTOLOGY_PLAYGROUND_INTEGRATION_PLAN.md)：OP-01～12 首版及 Mock/组件回归状态，包含系统映射、资料依据、实例子图和受限格式交换。

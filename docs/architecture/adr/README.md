# 架构决策记录（ADR）

更新：2026-09-24。

本目录记录影响全局、难以逆转、需要长期维护的架构决策。ADR 的核心价值是保留 **WHY**——不只记录「选了什么」，更记录「为什么这样选、放弃了什么、什么条件下应当改变」。代码与能力文档说明「现状是什么」，ADR 说明「为什么是现在这样」。

## 什么时候需要新 ADR

满足以下任一条即应登记：

- 决策影响多个模块或整个系统（分层、持久化、通信方式、部署形态）；
- 决策难以逆转，或逆转成本显著；
- 存在多个合理选项，且团队曾就此讨论/争论；
- 引入新的外部依赖或技术栈。

不适用：局部实现细节、单个函数的写法、可随时替换的库选择。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| Proposed | 已提出，等待确认，尚未实施 |
| Accepted | 已采纳，当前有效 |
| Deprecated | 不再推荐，但尚未被替代 |
| Superseded by ADR-XXX | 已被新决策取代，保留历史 |

## 索引

| 编号 | 标题 | 状态 | 关键结论 |
| --- | --- | --- | --- |
| [ADR-001](ADR-001-semantic-permission-separation.md) | 语义与权限分离 | Accepted | 建立语义关系不扩大数据范围；两者独立演进 |
| [ADR-002](ADR-002-reasoning-side-effect-separation.md) | 推理与副作用分离 | Accepted | 模型只产出建议，执行由受控运行时裁决 |
| [ADR-003](ADR-003-state-fact-separation.md) | 状态与事实分离 | Accepted | 已回复/已排队/已审批/已完成是四种不同事实 |
| [ADR-004](ADR-004-json-blob-runtime-persistence.md) | 运行时持久化采用单表 JSON blob | Accepted（含退出条件） | 单机阶段最快路径；**已定义退出的触发条件与迁移前置** |
| [ADR-005](ADR-005-domain-public-api-layering.md) | 领域分层与 public-api 契约面 | Accepted（含收敛目标） | 路由→领域→服务单向；契约面需从重导出收敛为显式契约 |
| [ADR-006](ADR-006-dual-agent-independent-entry.md) | 双 Agent 独立入口 | Accepted | 业务与语义建设不共用授权语义，不合并为单一入口 |
| [ADR-007](ADR-007-modular-monolith-over-microservices.md) | 保持模块化单体，不拆微服务 | Accepted | 团队规模与业务阶段不支持分布式复杂度 |
| [ADR-008](ADR-008-persistence-port.md) | 持久化驱动选择收敛为端口 | Accepted | 消除 35 处重复分支；落地 ADR-004 的「仓储端口」前置条件 |

## 模板

```markdown
# ADR-XXX: [决策标题]

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-XXX

## Context
是什么问题促使我们做这个决策？约束是什么？

## Decision
我们提议/正在做的改变是什么？

## Consequences
因此什么变简单了？什么变困难了？放弃了什么？

## 退出/复审条件（可选但强烈建议）
什么条件下应当重新审视或推翻此决策？
```

## 维护约定

- 决策变更时**不修改原 ADR 的结论**，而是新增 ADR 并标注 `Superseded by`；
- 每条 ADR 必须在 `Context` 中写明当时的约束（团队规模、阶段、外部限制），否则后人无法判断决策是否仍然成立；
- 涉及可逆性差的决策（尤其持久化、通信方式）必须写退出条件；
- ADR 与能力文档冲突时，以 ADR 的「为什么」与能力文档的「是什么」分别理解，冲突处应更新能力文档。

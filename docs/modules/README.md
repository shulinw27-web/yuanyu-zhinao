# 元域智脑模块文档中心

> 基线日期：2026-08-21  
> 适用代码库：`demo-platform`  
> 架构策略：模块化单体优先，按演进需要拆分服务

本目录是多人协同开发的唯一模块文档入口。每个模块只维护一份 `README.md`，集中为四个章节：

- 需求与验收：业务目标、用户故事、范围、验收标准和非功能要求；
- 架构与实现：领域边界、数据所有权、依赖方向、当前代码与目标结构；
- 接口契约：当前 HTTP/SDK 接口、鉴权、请求响应和错误契约；
- 开发约束与验证：最小上下文、不可破坏约束和验证命令。

## 推荐阅读顺序

1. [整体协作架构](COLLABORATION_ARCHITECTURE.md)
2. [模块所有权矩阵](OWNERSHIP_MATRIX.md)
3. [API 设计标准](API_STANDARDS.md)
4. [Codex 快速索引](CODEX_INDEX.md)
5. 目标模块的一份说明；修改前优先阅读“开发约束与验证”章节

## 模块目录

| 编号 | 模块 | 责任边界 | 文档 |
| --- | --- | --- | --- |
| 01 | 身份与访问控制 | 登录、会话、组织、角色、页面/按钮/数据权限 | [identity-access](01-identity-access/README.md) |
| 02 | 智脑 Agent 运行时 | 任务、上下文、编排、模型、工具、确认执行 | [agent-runtime](02-agent-runtime/README.md) |
| 03 | 证据与审计 | Trace、哈希链、安全事件、执行回执 | [evidence-audit](03-evidence-audit/README.md) |
| 04 | 告警与值班 | P0/P1/P2、通知路由、值班升级、虚拟电话 | [alerting-oncall](04-alerting-oncall/README.md) |
| 05 | 风险运营 | 驾驶舱、风险事件、确认、审批、组织过滤 | [risk-operations](05-risk-operations/README.md) |
| 06 | 采购协同 | 采购场景、发起、审批、ERP 草稿 | [procurement-workflow](06-procurement-workflow/README.md) |
| 07 | 模型与语义治理 | 元模型、世界模型、知识、语义上下文 | [model-semantic-governance](07-model-semantic-governance/README.md) |
| 08 | 系统接入与模拟 | OA/MES/QMS/OMS 等接入、Mock 场景与故障 | [integration-simulation](08-integration-simulation/README.md) |
| 09 | 密钥与凭据 | KMS 适配、策略、短时租约、轮换与吊销 | [key-credential](09-key-credential/README.md) |
| 10 | 多端客户端 | 元域智营、桌面 Web、Electron、移动端、共享 SDK | [client-platform](10-client-platform/README.md) |
| 11 | 平台运行基础 | HTTP 宿主、配置、Repository、限流、部署与测试 | [runtime-platform](11-runtime-platform/README.md) |

## 文档状态约定

- `现状`：当前代码真实行为；
- `目标`：多人协同需要达到的模块边界；
- `迁移`：允许分阶段完成的结构调整；
- API 表中的 `Current` 表示已存在，`Target` 表示建议新增，不能由客户端假定已经可用。

## 变更规则

模块行为变化须同步更新对应模块说明中的相关章节。新增跨模块依赖必须更新 `OWNERSHIP_MATRIX.md`，新增或修改 HTTP 接口必须更新“接口契约”章节和 API 契约测试。运行配置、Outbox 等独立详细契约继续保留，不为减少数量合并掉它们的适用边界。

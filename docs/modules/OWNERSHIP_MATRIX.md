# 模块所有权与依赖矩阵

## 1. 所有权建议

| 模块 | 建议主责角色 | 数据 Owner | 可修改的主要代码 |
| --- | --- | --- | --- |
| 身份与访问 | IAM/安全后端 | 用户、组织、角色策略、会话 | identity/access/permission 相关服务与路由 |
| Agent 运行时 | Agent 平台组 | conversation、run、work item、memory | agent-*、private-agent、model gateway |
| 证据与审计 | 安全平台组 | trace、security event、receipt | evidence/audit 服务 |
| 告警与值班 | 运维产品组 | alert policy、on-call、voice call | `domains/alerting` |
| 风险运营 | 业务运营组 | risk case、dashboard projection | risk 服务和风险页面 |
| 采购协同 | 供应链组 | procurement request/approval | procurement 服务与页面 |
| 模型语义治理 | 数据与模型治理组 | meta/world/semantic/knowledge | meta/world/semantic 服务 |
| 接入与模拟 | 集成平台组 | connector、system record、scenario | system/mock/MCP 服务 |
| 密钥凭据 | 安全平台组 | key policy、lease metadata | key-center/KMS adapter |
| 多端客户端 | 客户端体验组 | 本地 UI 状态，不拥有业务真相 | frontend/apps/packages workbench/sdk |
| 平台运行基础 | 平台工程组 | runtime state infrastructure/config | HTTP、repository、deploy、CI |

`.github/CODEOWNERS` 已按上述模块提供团队句柄模板；接入实际 GitHub/GitHub Enterprise 组织时必须替换为真实团队。本文定义职责，不绑定个人姓名。

## 2. 允许依赖

| 调用方 | 允许依赖 | 禁止行为 |
| --- | --- | --- |
| 客户端 | API Contracts、Agent SDK | import 后端源码、持有系统密钥 |
| Agent | IAM、治理只读端口、Connector 端口、Key lease、Evidence | 直接改 IAM 或跨域业务状态 |
| 风险 | IAM、Alert 事件发布端口 | 直接修改告警配置或电话记录 |
| 告警 | IAM 组织投影、Provider 接口 | 代替风险/业务审批 |
| 采购 | IAM、核心对象校验、Key/Connector | 绕过确认或直接读取密钥 |
| 治理 | IAM、Connector 元数据 | 执行业务写入或认证用户 |
| 集成 | IAM 数据域输入、Key lease | 自行扩大数据范围 |
| 证据 | 各模块发布的审计事件 | 成为业务数据主库 |

## 3. 跨模块变更流程

1. 先在调用方和提供方 `API.md` 中提出契约变化。
2. 提供方向 `api-contracts` 增加向后兼容 Schema 和契约测试。
3. 调用方只依赖公开契约，不依赖提供方内部对象。
4. 数据字段迁移采用 expand → migrate → contract 三阶段。
5. 合并前由两个模块 owner 共同审核，安全相关变更追加安全 reviewer。

## 4. 高冲突文件

以下文件在完成迁移前应设置高等级 review：

- `backend/src/app.js`：所有后端模块的当前组合根；
- `frontend/src/App.vue`：管理 Web 的当前页面协调器；
- `backend/src/data/seed.js`：多个领域共享的 Demo 数据；
- `backend/src/data/iam-seed.js`：权限目录与初始策略；
- `frontend/src/api/client.js`：管理 Web 公共 API 契约；
- `packages/agent-sdk/src/index.js`：三端智脑公共契约；
- `backend/src/repositories/runtime-state-repository.js`：所有运行态持久化基础。

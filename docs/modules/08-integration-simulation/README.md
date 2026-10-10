# 系统接入与模拟模块说明

本页集中维护需求、架构、接口和开发约束；“当前”与“目标”沿用原说明，不因合并改变完成状态。

## 需求与验收

### 目标

以统一 Connector 契约接入 OA、ERP、MES、QMS、OMS、LIMS、WMS、SRM；真实系统未接入时使用状态化 Mock 数据完整跑通读取、审批、故障和受控写回。

### 核心需求

- 每个 Connector 声明系统 ID、能力、数据分类、组织映射、健康状态、限流和所需 Key policy。
- 系统记录必须携带 tenantId、organizationId、ownerId、classification、sourceId、sourceVersion 和时间。
- Mock 每系统约百条真实形态记录，支持场景运行、OA 待办、审批、写回、故障注入和重置。
- OMS 记录覆盖 `Store`、订单与履约，并通过 `storeId` 关联；门店查询只向具备市场域和对应组织范围的主体开放。
- 生产/Mock 适配器使用同一端口，响应明确标记 mode 和 provenance。
- 读取和写入均应用组织数据域；写入只接受短时能力租约和幂等业务键。
- Connector 错误进入 Agent 证据，不能被模型当作成功或隐藏。

### 验收标准

非管理角色不可注入故障或重置；不同组织只读自身记录；审批角色匹配；重启后 Mock 状态保留；生产模式不允许误连 Demo Connector；所有写回带回执和审计。

## 架构与实现

### 当前代码

`system-integration-service.js`、`mock-scenario-service.js`、`mcp-connector-service.js`、`data/system-event-records.js`、`routes/simulation-routes.js`。当前系统目录主要来自 `data/seed.js`。

### 数据所有权

本模块拥有 ConnectorDefinition、ConnectorHealth、SystemRecordProjection、SimulationScenario、SimulationRun、MockApproval 和 ConnectorFault。业务系统主数据仍由外部系统拥有。

OMS 模拟连接器同时提供门店、订单与履约事实。`StoreStatusChanged` 使用稳定 `storeId`，订单/履约记录通过同一 `storeId` 关联门店；MCP 只读能力包括 `read_store_status`，对应 Key Center 策略不向终端暴露凭据。生产门店主数据仍由 MDM/OMS/POS/ERP 权威源拥有。

### 目标结构

```text
modules/integration-simulation/
  application/{query-system,execute-command,run-scenario,decide-approval}.js
  domain/{connector,system-record,scenario}.js
  ports/connector.js
  infrastructure/adapters/{oa,erp,mes,qms,oms,mock}.js
  workers/{poller,webhook,outbox-consumer}.js
```

### 边界

- 适配器不得自己做最终权限判定，但必须验证传入 capability/lease。
- 每条记录从接入开始就携带租户和组织，不允许查询后再猜组织。
- Connector 返回原始数据前完成字段 allowlist 和分类；Agent 只能拿证据投影。
- 生产将轮询/webhook/写回放到 Worker，API 进程不持有长连接任务。

## 接口契约

| 方法 | 路径 | 权限/说明 |
| --- | --- | --- |
| GET | `/api/systems` | 接入系统目录 |
| GET | `/api/system-data/overview` | 配置页面、按角色裁剪 |
| GET | `/api/system-data/:id/records?limit=100` | 系统记录；目标增加 cursor 和组织过滤 |
| GET | `/api/simulation/overview` | Mock 场景/运行/审批/故障概览 |
| POST | `/api/simulation/scenarios/:id/run` | `simulation.run` |
| POST | `/api/simulation/approvals/:id/decision` | `simulation.approval.decide`；body `{decision}` |
| POST | `/api/simulation/connectors/:id/fault` | `simulation.fault.manage`；body `{faultId}` |
| POST | `/api/simulation/reset` | `simulation.reset` |
| GET | `/api/agent/connectors` | Agent 可用 MCP Connector 目录 |
| GET | `/api/semantic-operations/workflows` | 流程目录、具体业务类别、跨系统统计、实时/定时/手动同步策略与同步记录；`page.semantic-operations.view` |
| GET | `/api/semantic-operations/workflows/:code` | 最新定义/候选、流程类别、参与系统、跨系统交接、版本历史、确定性流程图、字段映射和运行实例 |
| POST | `/api/semantic-operations/workflows/sync` | `meta_model.draft.save`；人工立即同步，Mock body `{scenario: baseline|changed}`，已配置真实连接器 body `{mode: configured}`；连接器支持有界定义/实例游标分页，发现候选但不自动发布 |
| POST | `/api/semantic-operations/workflows/:code/versions/:version/review` | `meta_model.publish`；body `{action: publish|reject}` |
| POST | `/api/integrations/workflows/webhooks/:providerId` | 公开但必须 HMAC 验签；只把变更通知按部署绑定租户入队，不采信正文业务事实 |
| POST | `/api/semantic-operations/workflows/events/:eventId/replay` | `event.outbox.replay`；只允许当前租户死信重新入队 |
| GET | `/api/agent/workflow-context?query=...` | `page.agent.view`；只读取已发布版本、流程类别、跨系统链路、授权内实例和有界流转记录；旧版本在途实例按自身版本解释，不执行审批 |

目标 Connector 内部契约：`query(request, authContext, lease)`、`execute(command, authContext, lease, idempotencyKey)`、`health()`。统一错误码：`CONNECTOR_UNAVAILABLE`、`CONNECTOR_TIMEOUT`、`DATA_SCOPE_DENIED`、`SIMULATION_PERMISSION_DENIED`、`APPROVAL_NOT_FOUND`。

## 开发约束与验证

入口：`domains/simulation/public-api.js`、`routes/simulation-routes.js`、system/mock/MCP 服务、`data/system-event-records.js`、`docs/development/MOCK_SIMULATION_RUNTIME.md`。

不可破坏：Mock 与生产明确隔离；故障必须可见；记录携带租户/组织/分类；数据域在查询层执行；非管理员不能运行/故障/重置；审批不能由任意角色处理；连接器不接收明文长期密钥；所有写回幂等并有 receipt。

验证：

```powershell
npm.cmd run test:security
npm.cmd run test:permissions
npm.cmd run test:persistence
```

新增系统时同时更新 connector catalog、数据 Schema、组织映射、权限矩阵、Mock fixture、故障用例和 API 文档。

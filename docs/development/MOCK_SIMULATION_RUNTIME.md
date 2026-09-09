# 状态化 Mock 流程模拟运行时

> 状态：当前 Demo 的默认集成模式。它不连接企业生产系统，也不保存真实业务凭据。

## 目标

在真实 OA、MES、QMS、LIMS、ERP、OMS 尚未接入前，用与未来 Connector 相同的查询、事件、审批和受控写回边界，演练跨系统业务流程。基础种子数据保持确定性；运行时事件、审批和写回通过统一 Repository 保存。默认使用本地 SQLite，也可通过 `SIMULATION_STORE_DRIVER=postgres` 切换到共享 PostgreSQL，支持多 API 实例一致读取和行锁串行化变更。

## 架构

```text
基础种子数据（每系统约 100 条）
  + 运行时场景事件
          ↓
Mock Connector 契约
  health_check / query / get_by_business_key / event_replay / approved_action
          ↓
系统数据 API 与 Agent 受控证据检索
          ↓
模拟 OA 审批 → QMS/MES/ERP/OMS 的受控模拟写回 → 审计事件
```

场景和 Connector 故障还会触发按业务角色裁剪的运行时模拟告警，分别进入 PC 管理端通知中心，以及移动端、桌面 Web 和 Electron 共用的智脑告警页；重置模拟运行时会一并清除这些告警。

OMS 的约 100 条基础记录现包含门店、订单与履约三类真实形态事件：`StoreStatusChanged` 提供 `storeId/storeName/organizationId/regionCode/operationStatus`，订单与履约记录携带同一 `storeId`。市场角色可按 `STORE-SH-001` 等稳定标识检索；无 OMS 数据域的生产角色不会因输入门店 ID 而自动扩权。

## 支持的场景

| 场景 | 注入事件 | 审批通过后的模拟写回 |
| --- | --- | --- |
| 原料质量异常 | LIMS OOS、QMS 偏差、MES 批次冻结 | QMS CAPA 草稿 |
| 生产设备异常 | MES 非计划停机、QMS 设备偏差 | QMS CAPA 草稿 |
| 供应与库存风险 | ERP 低库存、MES 排产风险、QMS 供应商约束 | QMS CAPA 草稿（后续可扩展 ERP 采购草稿） |
| 订单履约风险 | OMS 配送异常、ERP 替代库存风险、QMS 放行约束 | QMS CAPA 草稿（后续可扩展 OMS 协同任务） |

## API

| 方法 | 路径 | 权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/api/simulation/overview` | 已认证角色 | 查看可见场景、运行时事件和可处理审批 |
| POST | `/api/simulation/scenarios/{id}/run` | `executive` | 启动场景并生成模拟 OA 审批 |
| POST | `/api/simulation/approvals/{id}/decision` | 任务指定角色 | `approved` 或 `rejected` |
| POST | `/api/simulation/connectors/{systemId}/fault` | `executive` | 注入或清除 Connector 故障，Body 为 `{ "faultId": "..." }` |
| POST | `/api/simulation/reset` | `executive` | 清空运行时数据与故障状态，保留基础种子数据 |

## Connector 故障演练与审计回放

模拟运行中心可针对 LIMS、MES、ERP、QMS、OMS 注入以下故障，并将操作与状态变更写入运行时事件流和审计轨迹：

| 故障 | Connector 健康状态 | 检索行为 | 适合验证的流程 |
| --- | --- | --- | --- |
| 正常（`none`） | `healthy` | 正常返回种子数据和场景事件 | 正常闭环 |
| 接口不可用（`connector_outage`） | `unavailable` | Agent 仅收到可用性告警；系统数据接口不返回业务记录 | 降级、人工接管、重试策略 |
| 数据延迟（`data_delay`） | `delayed` | 保留记录，并在 Agent 证据与摘要中标记时效风险 | 延迟容忍度、时效提示 |
| 主数据冲突（`data_conflict`） | `degraded` | 保留记录，并在 Agent 证据与摘要中提示人工复核 | 标识映射、人工复核 |

这使同一业务问题可以在“数据齐备”“数据迟到”“接口不可用”三个条件下回放。智脑不会把故障系统的数据沉默地当作正常证据：它会产出带有 `Mock Connector 健康状态` 来源的受控告警证据，并在面向用户的回答中提示结论需要等待 Connector 恢复或完成数据复核。Agent 运营指标也会同步呈现非健康 Connector 数量。

## 约束与替换路径

- `Mock*Connector` 是未来 `Real*Connector` 的接口前身；业务页面与 Agent 不得直接读取种子文件。
- 所有模拟写回只影响当前 Mock Repository，不调用企业生产系统；需要恢复基线时使用模拟中心重置或 `npm.cmd run reset:runtime -w backend`。
- Agent 会检索运行时事件，因此可直接询问对应批次、订单或生产批的最新模拟状态。
- 管理员可启动/重置场景、注入/清除 Connector 故障；审批仍按场景配置的角色范围控制。
- 生产接入时保持 Connector/Repository 契约不变，用 PostgreSQL、消息队列和 Outbox 替换本地 SQLite，并将模拟 OA 审批替换为 OA/BPM 待办和签名审计。

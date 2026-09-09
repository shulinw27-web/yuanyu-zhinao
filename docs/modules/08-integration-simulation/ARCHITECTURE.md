# 系统接入与模拟技术架构

## 当前代码

`system-integration-service.js`、`mock-scenario-service.js`、`mcp-connector-service.js`、`data/system-event-records.js`、`routes/simulation-routes.js`。当前系统目录主要来自 `data/seed.js`。

## 数据所有权

本模块拥有 ConnectorDefinition、ConnectorHealth、SystemRecordProjection、SimulationScenario、SimulationRun、MockApproval 和 ConnectorFault。业务系统主数据仍由外部系统拥有。

OMS 模拟连接器同时提供门店、订单与履约事实。`StoreStatusChanged` 使用稳定 `storeId`，订单/履约记录通过同一 `storeId` 关联门店；MCP 只读能力包括 `read_store_status`，对应 Key Center 策略不向终端暴露凭据。生产门店主数据仍由 MDM/OMS/POS/ERP 权威源拥有。

## 目标结构

```text
modules/integration-simulation/
  application/{query-system,execute-command,run-scenario,decide-approval}.js
  domain/{connector,system-record,scenario}.js
  ports/connector.js
  infrastructure/adapters/{oa,erp,mes,qms,oms,mock}.js
  workers/{poller,webhook,outbox-consumer}.js
```

## 边界

- 适配器不得自己做最终权限判定，但必须验证传入 capability/lease。
- 每条记录从接入开始就携带租户和组织，不允许查询后再猜组织。
- Connector 返回原始数据前完成字段 allowlist 和分类；Agent 只能拿证据投影。
- 生产将轮询/webhook/写回放到 Worker，API 进程不持有长连接任务。

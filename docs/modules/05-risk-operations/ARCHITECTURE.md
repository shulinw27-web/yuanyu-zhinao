# 风险运营技术架构

## 当前代码

`risk-service.js` 同时处理 seed 风险、运行态状态、Mock 告警、组织过滤、脱敏和驾驶舱投影；HTTP 已集中到 `routes/risk-routes.js`。前端包括 Dashboard、RiskCentre 和 RiskDrawer。

## 数据所有权

本模块拥有 RiskCase、RiskAction、RiskProjection 和 DashboardProjection。Alert 模块拥有通知/电话，Integration 模块拥有系统原始记录，Evidence 模块拥有 Trace；风险只保存引用。

## 目标结构

```text
modules/risk-operations/
  api/risk-routes.js
  application/{list,get,acknowledge,approve,dashboard}.js
  domain/{risk-case,risk-policy,events}.js
  infrastructure/{risk-repository,projection}.js
```

风险创建/更新通过 Outbox 发布事件。查询层始终注入 IAM 的 allowedOrgIds，并在 Repository 查询阶段过滤。驾驶舱使用同一过滤条件构建投影，避免侧信道泄露全局数量。

## 当前耦合待解

从 `risk-service` 移除对 alerting/mock 的直接聚合，由 projection handler 消费事件；从 Agent 工具注册器通过 RiskQueryPort 访问，而不是 import 内部函数。

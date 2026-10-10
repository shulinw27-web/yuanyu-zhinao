# 风险运营模块说明

本页集中维护需求、架构、接口和开发约束；“当前”与“目标”沿用原说明，不因合并改变完成状态。

## 需求与验收

### 目标

汇聚生产、质量、供应链、订单和市场风险，提供驾驶舱、风险列表/详情、确认和审批，并按组织、角色和字段策略裁剪。

### 核心需求

- 风险包含等级、状态、来源、组织、业务对象、影响、责任人、时间和证据引用。
- 驾驶舱指标必须基于当前主体可见风险计算，不能先全量聚合后泄露。
- 用户可查看详情、确认收到；具备审批权限的角色可审批。
- 写入后按同一主体重新读取、过滤和脱敏再返回。
- 风险变化发布领域事件，告警和 Agent 通过事件/只读端口消费。
- Mock 运行态告警与基础风险投影可合并，但必须标明来源。

### 验收标准

同角色不同组织只能看到各自范围；详情需 `risk.detail.view`；确认需 `risk.acknowledge`；审批需 `risk.approve`；不可见资源返回 404；写后响应不返回内部原始对象。

## 架构与实现

### 当前代码

`risk-service.js` 同时处理 seed 风险、运行态状态、Mock 告警、组织过滤、脱敏和驾驶舱投影；HTTP 已集中到 `routes/risk-routes.js`。前端包括 Dashboard、RiskCentre 和 RiskDrawer。

### 数据所有权

本模块拥有 RiskCase、RiskAction、RiskProjection 和 DashboardProjection。Alert 模块拥有通知/电话，Integration 模块拥有系统原始记录，Evidence 模块拥有 Trace；风险只保存引用。

### 目标结构

```text
modules/risk-operations/
  api/risk-routes.js
  application/{list,get,acknowledge,approve,dashboard}.js
  domain/{risk-case,risk-policy,events}.js
  infrastructure/{risk-repository,projection}.js
```

风险创建/更新通过 Outbox 发布事件。查询层始终注入 IAM 的 allowedOrgIds，并在 Repository 查询阶段过滤。驾驶舱使用同一过滤条件构建投影，避免侧信道泄露全局数量。

### 当前耦合待解

从 `risk-service` 移除对 alerting/mock 的直接聚合，由 projection handler 消费事件；从 Agent 工具注册器通过 RiskQueryPort 访问，而不是 import 内部函数。

## 接口契约

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/dashboard` | `page.dashboard.view`，组织过滤 |
| GET | `/api/risk-cases` | `page.risks.view` |
| GET | `/api/risk-cases/:id` | 页面权限 + `risk.detail.view` |
| POST | `/api/risk-cases/:id/acknowledge` | 可见资源 + `risk.acknowledge` |
| POST | `/api/risk-cases/:id/approve` | 可见资源 + `risk.approve` |
| GET | `/api/authorization/explain` | 风险/世界页面之一 |

风险响应建议稳定字段：`id`、`severity`、`status`、`title`、`sourceSystem`、`organizationId`、`objectRefs[]`、`impact`、`owner`、`evidenceRefs[]`、`createdAt`、`updatedAt`、`version`。

目标写接口携带 `{expectedVersion, comment}` 与 `Idempotency-Key`；列表增加 severity/status/org/time/cursor 过滤；错误码包括 `RISK_NOT_FOUND`、`RISK_VERSION_CONFLICT`、`BUTTON_PERMISSION_DENIED`。

## 开发约束与验证

入口：`domains/risk/public-api.js`、`routes/risk-routes.js`、`services/risk-service.js`、`authorization-service.js`、`features/risk`、`RiskDrawer.vue`。

不可破坏：查询先按组织过滤；详情同时检查按钮权限；确认/审批前检查资源可见；多角色选择真实动作角色；写后重新按请求主体读取和脱敏；不可见返回 404 以减少枚举。

验证：

```powershell
npm.cmd run test:permissions
npm.cmd run test:alerting
npm.cmd run build -w frontend
```

新增字段时标明数据分类、来源系统和组织 owner，并同步 Agent evidence 映射。

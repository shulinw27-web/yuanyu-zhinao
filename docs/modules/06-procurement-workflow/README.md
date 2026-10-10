# 采购协同模块说明

本页集中维护需求、架构、接口和开发约束；“当前”与“目标”沿用原说明，不因合并改变完成状态。

## 需求与验收

### 目标

将供应风险或业务需求转为受控采购草稿与审批流程，在未连接生产 ERP 时用状态化 Mock 跑通，在生产接入时保持相同业务契约。

### 核心需求

- 查看采购场景、建议数量、供应商、库存和影响证据。
- 发起采购前校验核心元对象绑定、角色权限、组织范围和 ERP Connector 租约。
- 发起只创建草稿/申请，不等同于批准；批准需独立权限和工作流身份。
- Agent 发起时必须经历 plan、确认、审批和执行回执。
- Mock 与真实 ERP 适配返回统一业务结果并明确 `mode/source`。

### 验收标准

`procurement.launch` 和 `procurement.approve` 分离；Key lease 短时、不透明且限定 operation；重复请求不创建重复采购单；失败不伪造已执行；所有写入产生 evidence receipt。

## 架构与实现

### 当前代码

`procurement-service.js` 以 seed 初始化 `procurement_runtime` Repository，发起/审批状态和 Outbox 事件在同一事务提交；HTTP 与 Key lease 编排位于 `routes/procurement-routes.js`；前端位于 `features/actions/ProcurementActionPage.vue`。Agent tool registry 仍直接调用采购服务，后续替换为 typed port。

### 数据所有权

本模块拥有 ProcurementRequest、ProcurementApproval 和业务状态；Key 模块拥有 lease；Integration 模块拥有 ERP adapter；Evidence 只保存回执引用。

### 目标设计

```text
API/Agent Tool → Procurement Use Case → IAM/Business Policy
→ Core Object Validation → Key Lease → ERP Port → Receipt/Outbox
```

下一阶段把 route adapter 中的授权后业务编排与租约申请继续下沉到 application use case，使 HTTP 和 Agent 工具调用同一 use case。ERP 使用 port/adaptor，Mock 与生产适配器不能改变领域规则。

### 事务

本地状态与 Outbox 同事务；外部 ERP 调用使用幂等业务键和 saga 状态，不能尝试跨数据库强事务。批准动作再次读取最新版本和权限。

## 接口契约

| 方法 | 路径 | 权限/说明 |
| --- | --- | --- |
| GET | `/api/procurement/scenario` | `page.agent.view`，当前 Demo 场景 |
| POST | `/api/procurement/launch` | `procurement.launch`；申请 `create_procurement_draft` 租约 |
| POST | `/api/procurement/approve` | `procurement.approve`；申请 `approve_procurement` 租约 |

当前 POST 不接收业务 body，使用 Demo 场景状态。目标契约：

```json
{
  "requestId": "business-request-id",
  "items": [{ "materialId": "material-id", "quantity": 100, "unit": "kg" }],
  "supplierId": "supplier-id",
  "organizationId": "org-id",
  "reason": "风险补货",
  "expectedVersion": 2
}
```

返回 `procurementId`、`status`、`mode`、`connectorReceipt`、`evidenceRefs`、`version`。错误码：`CORE_OBJECT_BINDING_INVALID`、`PROCUREMENT_PERMISSION_DENIED`、`KEY_LEASE_DENIED`、`VERSION_CONFLICT`、`CONNECTOR_UNAVAILABLE`。

## 开发约束与验证

入口：`routes/procurement-routes.js`、`procurement-service.js`、`agent-tool-registry.js`、`ProcurementActionPage.vue`、核心元对象和 key-center 服务。

不可破坏：发起与审批权限分离；模型不能直接批准；核心对象校验必须使用 authoritative projection；租约限制 connector/operation/task/TTL；Mock 明确标记；失败不能返回执行成功；写操作需幂等和证据回执。

验证：

```powershell
npm.cmd run test:security
npm.cmd run test:permissions
npm.cmd run build -w frontend
```

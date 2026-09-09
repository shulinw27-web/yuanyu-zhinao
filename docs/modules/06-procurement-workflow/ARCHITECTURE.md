# 采购协同技术架构

## 当前代码

`procurement-service.js` 以 seed 初始化 `procurement_runtime` Repository，发起/审批状态和 Outbox 事件在同一事务提交；HTTP 与 Key lease 编排位于 `routes/procurement-routes.js`；前端位于 `features/actions/ProcurementActionPage.vue`。Agent tool registry 仍直接调用采购服务，后续替换为 typed port。

## 数据所有权

本模块拥有 ProcurementRequest、ProcurementApproval 和业务状态；Key 模块拥有 lease；Integration 模块拥有 ERP adapter；Evidence 只保存回执引用。

## 目标设计

```text
API/Agent Tool → Procurement Use Case → IAM/Business Policy
→ Core Object Validation → Key Lease → ERP Port → Receipt/Outbox
```

下一阶段把 route adapter 中的授权后业务编排与租约申请继续下沉到 application use case，使 HTTP 和 Agent 工具调用同一 use case。ERP 使用 port/adaptor，Mock 与生产适配器不能改变领域规则。

## 事务

本地状态与 Outbox 同事务；外部 ERP 调用使用幂等业务键和 saga 状态，不能尝试跨数据库强事务。批准动作再次读取最新版本和权限。

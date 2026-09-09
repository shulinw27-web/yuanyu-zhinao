# 采购协同模块需求

## 目标

将供应风险或业务需求转为受控采购草稿与审批流程，在未连接生产 ERP 时用状态化 Mock 跑通，在生产接入时保持相同业务契约。

## 核心需求

- 查看采购场景、建议数量、供应商、库存和影响证据。
- 发起采购前校验核心元对象绑定、角色权限、组织范围和 ERP Connector 租约。
- 发起只创建草稿/申请，不等同于批准；批准需独立权限和工作流身份。
- Agent 发起时必须经历 plan、确认、审批和执行回执。
- Mock 与真实 ERP 适配返回统一业务结果并明确 `mode/source`。

## 验收标准

`procurement.launch` 和 `procurement.approve` 分离；Key lease 短时、不透明且限定 operation；重复请求不创建重复采购单；失败不伪造已执行；所有写入产生 evidence receipt。

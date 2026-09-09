# 系统接入与模拟模块需求

## 目标

以统一 Connector 契约接入 OA、ERP、MES、QMS、OMS、LIMS、WMS、SRM；真实系统未接入时使用状态化 Mock 数据完整跑通读取、审批、故障和受控写回。

## 核心需求

- 每个 Connector 声明系统 ID、能力、数据分类、组织映射、健康状态、限流和所需 Key policy。
- 系统记录必须携带 tenantId、organizationId、ownerId、classification、sourceId、sourceVersion 和时间。
- Mock 每系统约百条真实形态记录，支持场景运行、OA 待办、审批、写回、故障注入和重置。
- OMS 记录覆盖 `Store`、订单与履约，并通过 `storeId` 关联；门店查询只向具备市场域和对应组织范围的主体开放。
- 生产/Mock 适配器使用同一端口，响应明确标记 mode 和 provenance。
- 读取和写入均应用组织数据域；写入只接受短时能力租约和幂等业务键。
- Connector 错误进入 Agent 证据，不能被模型当作成功或隐藏。

## 验收标准

非管理角色不可注入故障或重置；不同组织只读自身记录；审批角色匹配；重启后 Mock 状态保留；生产模式不允许误连 Demo Connector；所有写回带回执和审计。

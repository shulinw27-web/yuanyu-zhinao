# 精密制造跨系统语义建模：合成需求与业务契约

修复后复测见 [回归报告](SEMANTIC_MANUFACTURING_REPAIR.md)，运营人员操作见 [材料工作区指南](../guides/SEMANTIC_MATERIAL_WORKSPACE.md)。以下权威业务规则保持原样，未为通过测试修改预期答案。

日期：2026-09-10。案例为虚构的精密零部件工厂，不含真实企业记录。用于检验现有元域智营 Agent 的材料理解、建模与连续补料能力，不修改生产系统或当前用户的工作草稿。

## 1. 公开依据与改编范围

案例参考 Odoo 官方文档中的三项实际业务流程：采购可分批收货，未收完部分可生成后续收货；收货、质量检查、入库存放可分为不同环节，质检区物料尚不可用于后续处理；批号用来追踪一组收货或生产物料。

- [分批收货与后续收货](https://www.odoo.com/documentation/13.0/applications/inventory_and_mrp/purchase/purchases/rfq/reception.html)
- [收货—质检—入库三步流程](https://www.odoo.com/documentation/17.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/receipts_three_steps.html)
- [批号与追踪](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/product_management/product_tracking/lots.html)

本案例不是 Odoo 部署案例，也不声称原厂提供下述接口。跨 ERP/WMS/LIMS/QMS/MES/OA 的拆分、字段、编号、API 路径、数量、审批和执行回执约定均为此次评测自行构造。

## 2. 业务目标与能力问题

工厂希望快速回答：采购是否收齐？在当前库存快照下能否满足指定生产需求？异常物料实际影响哪些库存项，是否已经被生产领用？质量处置的审批与外部执行分别处于什么状态？

业务模型须包含对象、主键、来源、粒度、关系、单位、状态、口径、证据时间和动作权限。抽出表结构只是第一步，不能据此声称已经建成可执行业务世界模型。

## 3. 权威业务规则（模型输入）

1. 采购订单头 PurchaseOrder 的 amount 是订单总金额，currency 是币种。关联订单行、收货单或收货明细时，金额仍按 po_id 粒度聚合，不重复累计。
2. PurchaseLine 可以分多次收货；ReceiptLine 同时引用 Receipt、PurchaseLine 与 MaterialLot，不能用采购订单头直接代替批次或行级关系。
3. Material 是物料主数据，MaterialLot 是来料批次，StockItem 是批次在仓库/库位上的库存快照，三者不能合并。Supplier 是组织型业务供应商，不是人员。
4. 本案例物料计量换算明确为 1000 g = 1 kg。该规则不适用于币种；未约定的单位不得猜测转换。
5. WMS 的 on_hand 是账面量，reserved 是预留量，available 是已计算的可用量。AVL 表示正常，HOLD 表示隔离，HOLD 的 available 必须为 0。不把 on_hand 当成可用量；未知状态码需复核。
6. 采购收货累计和当前账面库存是不同口径，实际领料会减少库存。不能把历史已领料再次从已更新的库存快照扣除。
7. ProductionOrder 的 required_qty 是该工单当前需求；已有预留量属于其他需求，不可再次用于指定工单。仅 MaterialIssue 才是实际领料证据。计划使用同一物料不证明领用了异常批次。
8. QualityCase 是异常处置记录，Inspection 是检验事实，Approval 是审批过程。approved 仅表示审批通过，execution_receipt_id 为 null 表示没有外部执行成功凭据。
9. 每条事件具有 system、id、version、tenantId、organizationId、classification、occurredAt；重复投递按 system+id+version 去重。快照时间以 payload.as_of 为准，不能用查询时间冒充事实更新时间。
10. 当前分析时点为 2026-09-10T09:00:00+08:00。快照超过15分钟需明确过期；新增授权或解除隔离不能由上传材料、模型回答或审批文本隐式获得。

## 4. 输入材料与工程契约

材料目录：[manufacturing-case](../../examples/semantic-schemas/manufacturing-case/)。

| 材料 | 用途 |
| --- | --- |
| [综合 OpenAPI](../../examples/semantic-schemas/manufacturing-case/combined-openapi.json) | 13 类对象、6 个系统、分页 GET、鉴权及错误契约；标量外键用说明与 x-foreign-key 明示 |
| erp/wms/lims/qms/mes/oa-openapi.json | 按真实系统分工拆分，测试分批上传和跨系统关联保留 |
| [数据字典](../../examples/semantic-schemas/manufacturing-case/data-dictionary.json) | 对象主键、字段类型、reference、逐对象来源系统与粒度 |
| [事件样本](../../examples/semantic-schemas/manufacturing-case/sample-events.json) | 合成采购、分批收货、库存、质检、领料、审批以及一次重复投递 |
| [验收基准](../../examples/semantic-schemas/manufacturing-case/expected-world-model.json) | 人工定义的预期对象/关系/计算答案，仅用于结果比较，不能作为模型输入 |

这些接口是离线契约文档，域名使用 example.invalid，不可调用。返回页不等于全量，403 不回退为管理员，429 按 Retry-After 处理。没有提供任何真实登录凭据。

## 5. 快速模拟的操作顺序

1. 在独立任务提交上述需求与数据字典，只要求解释业务，禁止保存或发布。
2. 补充事件样本，追问金额、累计收货、现有账面量、可用量和工单缺口；核对单位、重复事件与库存粒度。
3. 追问审批能否证明已放行，以及能否证明异常批次已经投产。
4. 不重新上传材料，要求沿用前文生成候选；记录原文保留和截断提示。
5. 新任务用综合 OpenAPI 单独建模，再以综合 API 加字典建模，比较对象、来源、粒度、外键、规则的保留率。
6. 新任务先上传 ERP/WMS，再补充 LIMS/QMS/MES/OA，要求合并成完整候选，检查是否丢弃前一批对象。
7. 仅对隔离进程中的候选执行结构校验，不自动采纳或发布。记录“结构通过但业务语义错误”的情况。

本轮实际运行记录与问题清单见 [模拟报告](SEMANTIC_MANUFACTURING_EVALUATION.md)。

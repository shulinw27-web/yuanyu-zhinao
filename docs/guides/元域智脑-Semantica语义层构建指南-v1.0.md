# 元域智脑 Semantica 语义层构建指南

版本：v1.1  
日期：2026-08-27  
适用范围：元域智脑、OA/BPM、ERP、MES、LIMS、QMS、OMS，以及后续 WMS、SRM、PLM 等系统接入

## 1. 目的和边界

语义层不是把各系统的数据复制一份到“知识库”。它负责把已经授权、可追溯的业务事实组织成可查询的对象和关系，让智脑能够回答“这批原料影响了哪些批次、订单和待审批事项”，并在回答中保留来源和时效。

本项目中，Semantica 只负责图谱、关系、影响追踪和决策溯源；它不承担登录、角色授权、凭据申请或业务写入。调用顺序必须保持为：身份与权限裁剪 → Connector 读取事实 → 内容安全与数据分级 → Semantica 入图/检索 → 智脑生成建议 → 本人确认与 OA 审批。任何一层都不能被模型绕过。

## 2. 当前基础与建设目标

现有项目已经具备以下基础：

1. OA、ERP、MES、LIMS、QMS、OMS 的状态化 Mock Connector 和跨系统场景；
2. 统一的业务事件记录结构：系统、对象类型、事件类型、状态、分级、发生时间、业务负载；
3. Node 侧角色过滤的语义投影和 Agent 证据链；
4. 独立 Python Semantica 服务及 `ContextGraph`；
5. 已完成的跨系统 Mock 验证：12 条事实、33 个节点、71 条关系，质量链和订单链均能追踪到 OA 审批。

建设目标不是一次性建一个“大而全的企业知识图谱”，而是先服务四类高价值任务：质量异常影响分析、供应/库存风险分析、生产异常分析、订单履约分析。每个任务先做到“查得到、说得清、回链得到、不能越权”，再扩展对象与系统。

## 3. 推荐总体架构

```text
OA / ERP / MES / LIMS / QMS / OMS / WMS
        │
        │  受控 Connector：字段映射、短时凭据、超时、幂等、来源记录
        ▼
事实接入层
  ├─ 数据分级、脱敏、提示词注入检测
  ├─ 行列权限裁剪
  └─ Canonical Fact 标准化
        │
        ▼
Semantica 语义层
  ├─ 核心对象与业务实体
  ├─ 事实节点、关系、时间和来源
  ├─ 冲突提示与影响路径
  └─ 决策溯源
        │
        ▼
智脑编排层
  ├─ 语义检索 + Connector 证据
  ├─ 方案、澄清、受控动作草稿
  └─ 本人确认、OA 审批、审计回执
```

Semantica 必须部署在内网服务边界内。浏览器不得直接查询图谱；Node API 负责传入已经验证的身份上下文和已裁剪事实。图中不保存 Token、密码、原始附件、原始 Prompt 或未经处理的敏感字段。

## 4. 先定义统一事实，而不是直接导表

所有系统记录进入语义层前，统一转换为 `Canonical Fact`。最小字段如下：

| 字段 | 说明 | 例子 |
| --- | --- | --- |
| `factId` | 全局唯一事实 ID | `erp:INV-202608-001` |
| `sourceSystem` | 来源系统 | `ERP` |
| `sourceRecordId` | 源系统主键 | `INV-202608-001` |
| `objectType` | 业务对象类型 | `Inventory` |
| `eventType` | 事实/事件类型 | `InventoryAllocated` |
| `status` | 当前状态 | `review_required` |
| `occurredAt` | 业务发生时间 | ISO 8601 时间 |
| `recordedAt` | 被平台接收时间 | ISO 8601 时间 |
| `classification` | 数据分级 | `供应链受限` |
| `tenantId` / `organizationId` | 租户、组织边界 | `demo-enterprise` / `org-procurement-dept` |
| `entities` | 已校验的核心实体引用 | 原料批次、生产批次、订单、门店等 |
| `payloadVersion` | 字段映射版本 | `erp.inventory.v1` |
| `contentHash` | 原始载荷摘要 | SHA-256 |

示例（经过权限裁剪后的事实）：

```json
{
  "factId": "erp:SIM-ERP-0010",
  "sourceSystem": "ERP",
  "sourceRecordId": "SIM-ERP-0010",
  "objectType": "Inventory",
  "eventType": "InventoryAllocated",
  "status": "review_required",
  "occurredAt": "2026-08-25T14:53:30Z",
  "classification": "供应链受限",
  "entities": ["RMB-CA-20260802", "SUP-002"],
  "payloadVersion": "erp.inventory.v1"
}
```

事实中必须保留来源与版本。没有 `sourceSystem`、`sourceRecordId`、时间、分级或实体绑定的记录，不进入生产语义层，只能进入隔离队列等待补全。

## 5. 核心对象和关系设计

首批对象以项目已定义的五个核心元对象为锚点，并增加高频业务实体：

| 类别 | 首批对象 | 主键示例 |
| --- | --- | --- |
| 人与组织 | Person、Organization、Role、Approval | `usr-004`、`org-quality-dept` |
| 供应与物料 | RawMaterial、MaterialLot、Supplier、Inventory、PurchaseOrder | `RMB-VC-20260801`、`SUP-002` |
| 生产与设备 | ProductionBatch、FinishedGoodsBatch、SKU、Equipment、ProductionLine | `PB-202608-01-A`、`EQ-004` |
| 质量 | Sample、TestResult、QualityEvent、CAPA、ReleaseDecision | `QE-SIM-9001`、`CAPA-2026-0001` |
| 履约与渠道 | Order、Fulfillment、Store、CustomerComplaint | `ORD-202608-00001`、`STORE-SH-001` |
| 过程与审计 | Scenario、Approval、DecisionRecord、EvidenceTrace | `OA-APP-0006`、`trace-*` |

关系要表达业务含义，避免用一个泛化的 `related_to` 覆盖所有情况。首批建议采用：

| 关系 | 起点 → 终点 | 作用 |
| --- | --- | --- |
| `referenced_by` | 实体 → 来源事实 | 从业务标识找到全部相关记录 |
| `affects_entity` | 来源事实 → 实体 | 沿影响方向继续追踪下游对象 |
| `produced_fact` | 场景/流程 → 来源事实 | 汇集同一业务流程的证据 |
| `uses_material` | 生产批次 → 原料批次 | 原料到生产的可追溯关系 |
| `produces_product` | 生产批次 → 成品批次 | 生产到成品的可追溯关系 |
| `blocks_release` | 质量事件 → 成品批次/订单 | 表达放行和履约约束 |
| `requires_approval` | 风险/草稿 → OA 审批 | 显示人机边界 |
| `resolved_by` | 质量事件 → CAPA/处置任务 | 形成闭环 |

双向关系不是数据重复。Semantica 的影响遍历有方向，必须同时维护“实体 → 事实”与“事实 → 受影响实体”两类关系，才能从订单追到履约事件、成品批次、库存与质量约束。

## 6. Semantica 入图模式

每条 Canonical Fact 在 Semantica 中至少生成一个事实节点，并按其 `entities` 生成或复用业务实体节点：

```python
graph.add_node(
    "record:SIM-QMS-0004", "QualityEvent",
    "QMS 来料 OOS；materialBatchId=RMB-VC-20260801",
    source_system="QMS", source_record_id="SIM-QMS-0004",
    occurred_at="2026-08-25T14:53:30Z",
    classification="质量受限", payload_version="qms.quality-event.v1"
)
graph.add_node("entity:RMB-VC-20260801", "MaterialLot", "RMB-VC-20260801")
graph.add_edge("entity:RMB-VC-20260801", "record:SIM-QMS-0004", "referenced_by")
graph.add_edge("record:SIM-QMS-0004", "entity:RMB-VC-20260801", "affects_entity")
```

实施时遵守四条规则：

1. 实体 ID 由源系统主数据或统一主数据服务校验，模型不得自己创造实体；
2. 同一源记录按 `sourceSystem + sourceRecordId + payloadVersion` 幂等写入；
3. 变更和撤销不能直接覆盖历史事实，应记录新版本、有效期与失效原因；
4. 图中事实只代表“系统报告了什么”，不代表“业务结论已经成立”。冲突和低置信事实必须显示待复核状态。

## 7. 分阶段建设路径

在真实事实入图前，先在独立元域智营端完成模型发现与人工复核。运营人员上传 OpenAPI、JSON/YAML 数据字典或 CSV 字段表后，系统提取对象、字段、主键和引用关系，并绘制候选对象关系图。点击节点可以检查业务名称、核心元对象、数据分级以及字段来源映射。

字段映射使用五种状态：自动匹配、人工映射、派生字段、明确忽略、待确认。新增字段默认待确认；主键必须绑定稳定源字段。任何待确认映射都会使 Schema Critic 失败并关闭确认入口。保存修订时系统生成相对原提案和当前草稿的 Diff，以及主键迁移、字段删除、关系影响和 Semantica 重新校验提示。该流程只形成未发布草稿，不读取真实业务明细，也不自动发布。

结构检查通过后，系统还会生成一份 `semantic-mapping-contract.v1`，用现有状态化 Mock Connector 的少量样本做映射演练。演练不是简单检查“源字段是否填写”，而是实际取值并生成 Canonical Fact 预览，检查必填字段、类型和主键。运营人员可以按对象查看样本转换结果，直接定位“源字段写错”“样本没有该值”“类型不兼容”等问题。存在错误时，前端确认和服务端采纳都会被阻断；没有 Mock 样本时显示“未验证”，不会被包装成通过。当前结果只说明 Mock 数据闭环可运行，真实接入仍需使用企业提供的脱敏样本重新验收。

### 阶段一：语义契约和 Mock 基线（现在即可开始）

1. 为 OA、ERP、MES、LIMS、QMS、OMS 定义 Canonical Fact Schema、字段字典、实体映射和关系清单；
2. 将现有 Mock 场景通过 `export_mock_fixture.mjs` 输出为可重复的语义夹具；
3. 用 `evaluate_mock_data.py` 验证检索、影响链、来源字段、决策溯源和权限前置裁剪；
4. 固化质量异常、库存风险、订单履约三个回归场景。

放行条件：任一业务标识都能回链来源；任一跨系统结论都能列出链路；没有权限的事实不进图。

### 阶段二：实时事实接入

1. 先选 ERP 库存、MES 批次状态、QMS 质量事件、OA 审批四类只读事实；
2. 每个 Connector 在读取后生成 Canonical Fact，写入消息队列或 outbox，再由语义入图 Worker 消费；
3. 引入去重、版本、重放、延迟监控和死信队列；
4. 用合成或脱敏的企业测试数据核验字段、编码、时间和组织边界。

放行条件：同一事实重复到达不产生重复节点；源系统断开时保留最后成功时间但不伪装为实时；权限撤销后后续检索不返回旧范围。

### 阶段三：影响分析和决策闭环

1. 将风险规则、Agent 计划、本人确认、OA 审批和外部回执写成 `DecisionRecord`；
2. 为原料→批次→成品→订单、设备→批次→质量事件、库存→排产→采购申请建立路径模板；
3. 智脑回答中的关键判断显示来源系统、事实时间、关系路径和不确定性；
4. 在业务方确认后把有效处置写为受控决策，但不将模型推测升级为事实。

## 8. 权限、数据安全和治理

语义服务不是权限系统。推荐的职责划分如下：

| 控制项 | 负责层 | 要求 |
| --- | --- | --- |
| 身份、角色、组织、行列范围 | IAM / Node API | 在查询和入图前裁剪 |
| Connector 凭据 | Key Center | 只使用短时不透明租约 |
| 字段脱敏、分级、附件安全 | 数据接入层 | 未通过校验的内容不入图 |
| 图谱关系、影响路径、决策溯源 | Semantica | 保留来源、时间、版本和分级 |
| 草稿、确认、审批、写入 | 工作流与业务系统 | 模型无直接写权限 |

生产环境应按租户/组织隔离图数据或通过强制过滤实现同等隔离；审计记录使用只追加存储；敏感节点内容应引用受控字段或摘要，不存放密钥、完整个人信息、配方原文和未脱敏附件。

## 9. 验收用例

首批每次发布至少执行以下用例：

| 用例 | 输入 | 预期 |
| --- | --- | --- |
| 原料质量异常 | `RMB-VC-20260801` | 关联 LIMS、QMS、MES、OA；列出来源与时间 |
| 供应风险 | `RMB-CA-20260802` | 关联 ERP 库存、MES 排产风险、QMS 供应商约束、OA 审批 |
| 履约风险 | `ORD-202608-00001` | 关联 OMS 配送、ERP 替代库存、QMS 放行约束、OA 审批 |
| 权限隔离 | 市场角色查询供应/质量对象 | 不向 Semantica 输入 ERP/QMS 受限事实，也不在回答中泄露 |
| 来源完整性 | 任意返回事实 | 必须含来源系统、记录 ID、发生时间、分级、映射版本 |
| 冲突处理 | 同一实体出现冲突状态 | 标记待复核，不自动选择一方或触发写入 |

当前可重复执行的命令：

```powershell
.\.venv-semantic-test\Scripts\python.exe services\semantic-context\evaluate_mock_data.py
```

## 10. 首期交付清单

1. 每个系统一份字段字典和 Canonical Fact 映射表；
2. 核心对象、关系、枚举和版本治理说明；
3. Connector → Outbox → 语义入图 Worker 的技术设计；
4. 语义事实存储、版本、删除、重放和审计策略；
5. 20 至 30 条脱敏跨系统验收样本；
6. 角色/组织/字段三级权限测试报告；
7. 语义层健康、延迟、入图失败、死信、事实冲突和检索命中率看板；
8. 业务方签字的“可读、可建议、可创建草稿、禁止自动写入”动作白名单。

## 11. 结论

最快的路径不是先采购图数据库或堆积数据，而是先用现有 Mock 把事实标准、实体映射、双向关系、来源链和权限边界跑通。随后以 ERP、MES、QMS、OA 的只读事实作为第一批真实接入对象，让智脑能在可审计的范围内完成跨系统分析。WMS、SRM、PLM 等系统在首批模型、权限和验收标准稳定后再接入，避免把尚未治理的数据源扩大成新的风险面。

# Semantica 跨系统 Mock 验证报告

日期：2026-08-25  
执行引擎：`semantica==0.6.5` 的 `ContextGraph`（非 projection fallback）  
数据性质：仅使用本项目状态化 Mock 运行时生成的合成事件；不读取、不写入任何真实企业系统或桌面端 SQLite 运行数据。

## 1. 验证范围

测试夹具在 Node 测试内存运行时启动以下三个现有业务场景，并把 LIMS、MES、ERP、QMS、OMS 与 OA 审批对象转换为带来源、时间、分级和业务标识的 Semantica 事实：

| 场景 | 业务标识 | 跨系统链路 |
| --- | --- | --- |
| 原料质量异常 | `RMB-VC-20260801` | LIMS OOS → QMS 偏差 → MES 批次冻结 → OA 审批 |
| 供应与库存风险 | `RMB-CA-20260802` | ERP 低库存 → MES 排产风险 → QMS 供应商约束 → OA 审批 |
| 订单履约风险 | `ORD-202608-00001` | OMS 配送异常 → ERP 替代库存不足 → QMS 放行约束 → OA 审批 |

当前项目没有独立 WMS Mock Connector，因此本轮不把 WMS 标记为“已验证”；库存事实由 ERP Mock 提供。

## 2. 实测结果

| 项目 | 结果 |
| --- | --- |
| Mock 事实数 / 场景数 | 12 / 3 |
| Semantica 图节点 / 边 | 33 / 71 |
| 节点类型 | Scenario、BusinessEntity、TestResult、ProductionBatch、Inventory、QualityEvent、Fulfillment、Approval、Decision 等 |
| 原料批次检索 | 通过：以 `RMB-VC-20260801` 检索到质量上下文 |
| 原料异常影响追踪 | 通过：可关联 LIMS、QMS、MES、OA |
| 订单履约影响追踪 | 通过：可关联 OMS、ERP、QMS、OA |
| 事实溯源完整性 | 通过：每条 Mock 事实包含来源系统、来源记录、发生时间、数据分级 |
| 决策溯源 | 通过：3 条“等待人工审批”的决策均附带业务实体和场景元数据 |
| 权限边界 | 通过：测试仅向 Semantica 输入上游按角色裁剪后的事实；Semantica 不承担角色授权判定 |

## 3. 发现与修正

首次运行中，按订单标识只能追到 OMS 和 OA，无法继续看到 ERP/QMS 约束。原因是 `ContextGraph` 的影响遍历为有向关系，而初始映射仅建立了“业务实体 → 来源事实”。

测试映射已补齐“来源事实 → 受影响业务实体”的 `affects_entity` 关系。这样订单可以沿“订单 → OMS 履约事件 → 成品批次 → ERP/QMS 约束”继续追踪。修正后全部检查通过。

这也给生产接入提出明确要求：每个 Connector 映射不应只上传字段，还必须声明事实与核心实体的双向引用/影响关系，以及来源、版本、有效时间和分级。

## 4. 运行方式

首次安装依赖：

```powershell
python -m venv .venv-semantic-test
.\.venv-semantic-test\Scripts\python.exe -m pip install -r services\semantic-context\requirements.txt
```

执行验证：

```powershell
.\.venv-semantic-test\Scripts\python.exe services\semantic-context\evaluate_mock_data.py
```

脚本文件：

- `services/semantic-context/export_mock_fixture.mjs`：在测试内存运行时生成跨系统 Mock 夹具。
- `services/semantic-context/evaluate_mock_data.py`：使用实际 Semantica `ContextGraph` 建图、检索、追踪与验证。

## 5. 当前边界与下一步

本次证明了 Semantica 可处理项目现有 Mock 的实体建模、跨系统关系追踪、业务标识检索和决策溯源；它不证明真实生产连接器已经可用。

## 6. 已接入的 Demo 验证闭环

Mock 场景现在不再只由离线脚本验证。用户在“模拟运行中心”启动场景后，后端会从当前运行时提取该 `runId` 的合成事件和模拟 OA 审批，交由本机 Semantica 建图；返回结果包含事实数、来源系统、图统计和四项校验（来源完整、预期系统齐全、跨系统上下文、全部为合成事实）。审批后新增的 QMS CAPA 会再次入图并复校验。

闭环状态分为：

- `verified`：Semantica 已建图且校验通过；
- `failed`：服务响应但校验未通过；
- `unavailable`：服务未启动、响应超时、桥接被关闭或目标不安全。此时场景本身仍可演练，但 UI 明确标注未验证，Agent 不会把本地投影说成 Semantica 结果。

桥接只允许本机 HTTP 服务，并且仅传输 `simulated=true`、属于该运行的 Mock 事实；浏览器输入、真实业务数据、角色授权和凭据不会进入该接口。

下一步应在企业测试环境为 OA、ERP、MES、WMS、QMS 提供已脱敏的字段字典、主数据映射、事实版本、时效和数据分级，并由权限层完成行列裁剪后再把事实送入独立部署的语义服务。真实 Connector 仍必须经过网络、凭据、权限、超时、重复事件与对账验收。

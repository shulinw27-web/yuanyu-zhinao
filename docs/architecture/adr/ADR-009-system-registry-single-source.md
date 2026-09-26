# ADR-009: 系统接入的单一事实源、租户隔离与生命周期状态机

## Status

Accepted

## Context

「以系统为基石的语义建模」要求系统本身可被单独治理。实施前的实测状况（2026-09-25 本机）：

**系统清单分散在 5 处，成员与属性互不一致：**

| 定义处 | 系统数 | 成员 |
| --- | --- | --- |
| `data/seed.js:connectedSystems` | 6 | LIMS / MES / ERP / WMS / QMS / OMS |
| `services/mcp-connector-service.js:connectorCatalog` | 7 | OA / ERP / WMS / MES / LIMS / QMS / OMS |
| `services/semantic-source-discovery-service.js:systemAliases` | 12 | 上述 7 个 + SRM / MDM / PLM / EAM / IOT |
| `services/world-model-template-service.js:connectionTargets` | 8 | 6 个已接入 + SRM / OA（待接入） |
| `data/mock-onboarding-catalog.js` | 每场景硬编码 3 个 | 订单履约=OMS/ERP/WMS；批次异常=QMS/MES/WMS |

**同一系统在不同处被赋予互相矛盾的属性**：OA 在受控连接器目录中为 `connected_demo`，在连接目标中却是「待接入」；ERP 的「世界模型建模对象」（Inventory / PurchaseOrder / Supplier）与「连接器暴露对象」（RawMaterial / Product / Supplier / Budget）不同，且无处声明这是两个不同的集合。

**没有租户维度**：`connectedSystems` 是模块级常量，健康度、同步时间、状态被当作全局事实。而项目其余部分（事件、Agent 存储、语义工作区）早已按租户隔离（`semantic-tenant-context.js` + `semanticTenantStateKey`），系统接入是唯一没有租户边界的概念域。

**结论**：没有单一系统事实源，就不可能有「以系统为基石的接入」，也无法回答「这个租户接了哪些系统、各自处于什么状态」。

## Decision

### 1. 类型与实例分离

系统**类型**（ERP/WMS/QMS… 这类产品类型）属**平台级资产**，全租户共享，定义在 `backend/src/data/system-catalog.js`，不带 `tenantId`。
租户对某系统的**接入实例**（生命周期状态、凭据引用、授权范围）属**租户资产**，由 `backend/src/services/system-registry-service.js` 按租户读写。

理由：租户不应修改系统类型本身，但必须各自持有独立接入状态。把两者混在一个实体里，正是此前「接入」无法被单独治理的根因。

### 2. 两个状态轴显式分离

- `connector.status`：**受控连接器目录**是否登记该系统的连接器（平台级）；
- `onboardingStatus`：**租户接入**是否完成（`connected` / `pending_onboarding` / `not_registered`）。

此前把两者混为一谈，直接造成 OA 的「connected_demo vs 待接入」矛盾。分离后矛盾消失，两侧都是真值。

### 3. 接入生命周期状态机

`draft → registered → authorized → connected ⇄ suspended`，`registered`/`authorized`/`connected` 均可回退 `draft`。

非法跃迁、未登记系统码、缺少操作主体一律**拒绝且不落库**（`commit: false`，不推进版本号）。宁可显式失败，也不静默跳过门禁。

### 4. 两套角色可见性策略并列声明，不合并

- `ROLE_DATA_DOMAINS`：角色 → 数据域，决定**受控连接器目录**可见性；
- `ROLE_RECORD_SYSTEMS`：角色 → 可读取的**本地受控模拟记录**系统 id。

二者差异是**有意的策略收窄**，不是遗漏：OA 有连接器但无模拟记录集；MES 虽属 `production` 数据域，但 `procurement_manager` 的模拟读取范围被有意排除（采购角色不需要生产执行详情），该收窄无法从数据域推导。

### 5. 派生视图保持向后兼容

`data/seed.js:connectedSystems` 与 `getWorldModelConnectionTargets()` 改为由目录**派生**，字段、顺序与历史逐字段一致（含 ERP 的 `alert` 键只在 ERP 出现、待接入项 SRM 在 OA 之前）。展示顺序显式声明为 `DEMO_CONNECTION_ORDER` / `PENDING_ONBOARDING_ORDER`，避免调整目录条目顺序时静默改变接口输出。

### 6. 多租户贯穿原则（本次重构的横切要求）

凡新增「可被租户持有」的实体，一律：

1. 状态读写经 `semanticTenantStateKey()` 落到当前租户工作区；
2. 租户标识**只取受信上下文**（`runWithSemanticTenant` 的 AsyncLocalStorage），**绝不**接受请求体中的 `tenantId`；
3. 平台级共享资产（系统类型、角色策略、模板目录）明确标注为无租户维度，避免被误当作租户资产。

## Consequences

**变简单**：

- 系统清单有唯一事实源；「这个系统叫什么、属哪个域、连接器暴露什么对象」只有一个答案；
- 接入生命周期可被单独治理，为「选系统建模」提供数据源；
- 租户边界补齐：多租户不再是「除系统接入外都隔离」；
- 矛盾属性得到显式建模而非被复制。

**变困难 / 放弃的**：

- 引入 `system-registry-service.js` 这一被多方依赖的模块，新增 3 条跨领域边（已登记入 `CROSS_DOMAIN_EDGE_BASELINE`）。这是**净收敛**：5 份重复定义替换为 1 个共享依赖，不应通过「让消费者各抄一份」来消除这些边；
- 系统目录成为热点文件，修改需同时考虑 12 个系统的全部属性；
- `worldObjectTypes` 与 `connector.objects` 的差异**被保留**而非合并——合并会改变建模行为，需业务确认。

## 退出/复审条件

1. `ROLE_DATA_DOMAINS` 与 `ROLE_RECORD_SYSTEMS` 是否统一，需业务确认；确认后应只保留一套策略并删除另一套；
2. `worldObjectTypes` 与 `connector.objects` 是否应合并为单一对象清单，需业务确认（当前 6 个系统的两组清单均不完全一致）；
3. 接入生命周期状态机尚未接入真实审批链（`authorized → connected` 目前无凭据校验），接真实连接器时必须补；
4. 租户级接入状态目前落在运行时 JSON 存储，迁移到 PostgreSQL 时需按 ADR-004 前置条件一并处理。

## 关联

- [系统接入 → 选系统建模 → 模型治理整体重构方案](../SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md)（本 ADR 对应其阶段 0）；
- [模块化与组件化审计](../MODULARIZATION_AUDIT.md)（跨包棘轮与包边界）；
- ADR-004（运行时 JSON 持久化；本 ADR 的租户接入状态沿用同一存储）；
- ADR-006（双 Agent 独立入口；元域智语端是系统接入的唯一写入端）。

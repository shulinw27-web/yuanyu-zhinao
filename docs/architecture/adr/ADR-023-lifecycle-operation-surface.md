# ADR-023: 接入生命周期操作面——新增接入与已接通系统管理

- 状态：Accepted
- 日期：2026-09-26
- 关联：[ADR-011](ADR-011-system-onboarding-domain-extraction.md)（接入能力独立成域）、[ADR-018](ADR-018-declaration-divergence-merging.md)、[ADR-021](ADR-021-candidate-provenance-disclosure.md)

## 背景

ADR-011 把系统接入主视角迁到元域智语端时，接入生命周期状态机（draft→registered→authorized→connected⇄suspended）**已经在注册表定义并实现了**（`system-registry-service.js#transitionSystemConnection`），但它从未被暴露为可执行动作：

1. **路由层没有对应端点**——`/api/semantic-operations/systems` 只有读取、探测与映射草稿，没有生命周期操作。
2. **前端没有操作入口**——界面上的「已连通 / 待接入 / 未登记 / 可探测 / 未授权」全部是种子静态值，运营无法登记新接入、无法管理已接通系统。
3. 由此产生了「流程不清晰」的真实缺口：**新增接入**（把目录里未登记的系统推入流程）与**已接通系统的管理**（停用 / 恢复 / 下线）在产品里都不存在。

## 决策

1. **暴露第 5 项域契约**：`system-onboarding` 域新增导出 `transitionTenantSystemConnection`（边界声明 + 总览 + 详情 + 探测 + 生命周期操作）。架构棘轮 `DOMAIN_EXPORT_CEILING` 相应从 4 抬到 5——这是补齐「状态机可执行」的最小契约面，仍不预留增长空间；下一次抬高必须先说明现有 5 项为何不够。
2. **状态机仍是单一事实源**：新函数只做「视图侧门禁 + 审计字段组装」，不新增状态、不改跃迁规则；非法跃迁由注册表原样拒绝（409 `SYSTEM_TRANSITION_REJECTED`）。
3. **接通必须先验证**：任何 `→ connected` 跃迁（含 `authorized → connected` 与 `suspended → connected`）要求该租户对同一系统的最近一次连通性探测为 `verified`，否则 409 `SYSTEM_CONNECT_PROBE_REQUIRED`。没有验证过的接通等于跳过验收门禁。
4. **理由必填**：每次推进必须携带操作理由（≤200 字），操作人取受信上下文（`identityScope`），与探测结果同租户落盘，供审计追溯。
5. **权限闸门**：与连通性探测同一把闸门 `meta_model.draft.save`（接入侧写入），不新开权限位；数据域授权（`ROLE_DATA_DOMAINS`）不约束生命周期操作——那是读取侧的裁剪，不是治理动作的门槛。
6. **前端操作面**：系统接入视图新增「接入流程与生命周期」面板（状态步骤条 + 下一步动作 + 必填理由），动作直接渲染服务端返回的 `lifecycle.transitions`，不本地硬编码；新增「＋ 新增接入」入口（一键聚焦未登记系统）；筛选与总览新增「已停用」维度。接通按钮在无 verified 探测时禁用并说明原因，而不是点了才报错。
7. **「披露不等于补齐」同样适用于此**：操作面只暴露既有状态机；系统类型仍只能来自平台目录（`data/system-catalog.js`），本 ADR 不引入「任意自定义系统注册」。

## 实测口径

- `backend/test/system-access.test.js` 12 项（9 → 12）：新增第 6 节 3 项——全链路可执行（含接通门禁与停用/恢复）、守卫集（理由必填 / 未知状态 / 未知系统 / 越权 / 租户隔离）、服务层直调与路由层一致。
- `workspace-layout.test.js` 9 项（8 → 9）：操作面必须可见（新增接入入口 / 生命周期面板 / 停用筛选 / 服务端状态机调用 / 反向锁死模板不得硬编码状态）。
- `test:architecture` 10/10：导出上限 4 → 5 属显式棘轮变更（带理由注释），未新增跨域边。
- `test:registry` 7/7、`test:access` 12/12、`test:semantic` 全链 EXIT=0。

## 边界（不得在界面或文档中弱化）

1. 「接通」仍指**演示租户的接入生命周期状态**，连通性验证读的是内置合成数据源，不是真实企业连接器验收。
2. `draft → registered` 只推进状态与审计记录，**不落任何连接配置**（连接配置样例仍来自 demo 种子，`source='demo_seed'`）——真实的连接信息登记表单属后续增量。
3. 生命周期操作不改变角色数据域授权（`authorized` 字段是角色策略的只读呈现，与生命周期状态 `authorized` 是两个概念，界面文案已区分）。
4. 系统类型清单只能由平台目录变更，租户不能自建系统类型。

## 触发式复审

- 若阶段 6 权限合并把 `meta_model.draft.save` 与 `world.draft.*` 收敛，本操作面闸门需同步评估。
- 若引入真实企业连接器验收，接通门禁的「verified 探测」需升级为「真实连接器验收记录」，本 ADR 的第 3 条决策随之复审。
- 若允许租户自建系统类型（当前明确禁止），`SYSTEM_NOT_REGISTERED` 的语义与目录种子逻辑需重设计。

# ADR-024: 自定义系统登记——去预设接入清单与登记物料契约

- 状态：Accepted
- 日期：2026-09-26
- 关联：[ADR-011](ADR-011-system-onboarding-domain-extraction.md)（接入能力独立成域）、[ADR-023](ADR-023-lifecycle-operation-surface.md)（生命周期操作面）

## 背景

ADR-023 补齐了接入生命周期的操作面，但「新增接入」仍然只能从平台目录预设的成员里选：

1. **接入清单是预设备出来的**：12 个目录类型按 `onboardingStatus`（6 connected / 2 pending / 4 not_registered）全部被种进每个租户的接入清单。界面上「待接入（OA/SRM）」「未登记（MDM/PLM/EAM/IOT）」不是任何人的动作结果，是演示种子——用户无法接入清单之外的系统，也无法理解「为什么一上来就有 6 个系统等着接入」。
2. **不能新增任意系统**：登记只能推进既有目录成员的状态；系统类型只能来自平台目录（ADR-023 边界第 4 条明确禁止租户自建类型）。真实企业的系统名目各异（自研中台、行业 SaaS、集团统建），预设目录不可能覆盖。
3. **登记不落任何物料**：ADR-023 边界第 2 条指出 `draft → registered` 只推进状态不落连接配置——即使能登记，智脑也不知道「接入的是什么系统」。

## 决策

1. **接入清单去预设**：租户接入清单的预设成员只剩 6 个 Mock 演示接入样例（connected）；`pending_onboarding` / `not_registered` 的目录类型（OA/SRM/MDM/PLM/EAM/IOT）不再进入租户清单、连接目标与总览。平台目录本身保留（类型语义、连接器目录、文本识别仍归平台治理），这些类型转为「保留码」：对未登记类型的操作返回 404 `SYSTEM_ACCESS_MISSING` 并指引走「新增接入」。
2. **登记物料契约（本 ADR 的核心）**：新增系统必须提交一组必填物料，目标是**让智脑不靠猜就能明白接入的是什么系统**：
   - `name` 系统名称（2–40 字）——怎么称呼它；
   - `domain` 业务域（2–20 字）——业务归类，衔接模块 / 子模型概念；
   - `description` 系统定位说明（≥10 字）——是什么系统、管什么流程；
   - `keyEntities` 核心业务对象（≥1 项）——里面有什么数据，同时作为世界建模对象面；
   - `dataDomains` 覆盖数据域（⊆ production/marketing/internal，≥1）——授权与裁剪边界，角色授权按声明数据域推导；
   - `accessIntention` 接入目的（≥10 字）——智脑被期望用它做什么；
   - `businessOwner` 业务责任人（2–30 字）——出了问题找谁。
   可选项：`code` 系统码（缺省按名称自动生成并防撞，不得占用平台保留码）、`vendor`、`mockScenarioId`（演示环境的模拟数据源场景）。物料 schema 由 `data/system-catalog.js` 的 `SYSTEM_REGISTRATION_FIELDS` 单一定义，经接入总览下发，前端按 schema 渲染表单、不复制第二份字段规则。
3. **自定义系统是租户资产**：定义与生命周期行存于租户工作区（`system_registry_runtime.custom_systems`，按 `semanticTenantStateKey` 隔离），在一个事务内原子写入；登记成功即 `registered`（创建即登记，不是 draft——物料本身就是登记动作的输入）。校验失败逐字段返回 `issues`（`SYSTEM_MATERIALS_INVALID`），保留码 `SYSTEM_CODE_RESERVED`、占用码 `SYSTEM_CODE_TAKEN`。
4. **暴露第 6 项域契约**：`system-onboarding` 域新增导出 `registerSystemOnboarding`；路由 `POST /api/semantic-operations/systems`（闸门与生命周期操作同为 `meta_model.draft.save`）。架构棘轮 `DOMAIN_EXPORT_CEILING` 5 → 6，理由：没有这项契约，去预设后的接入流程没有入口。仍不预留增长空间。
5. **接通门禁不变，自定义系统同样受制**：自定义系统不挂接模拟场景则不可探测（409 `SYSTEM_PROBE_DATASET_NOT_ATTACHED`），也就永远到不了 `connected`；挂接场景后探测读取**整场景**作为该系统的模拟数据面（结果带 `simulatedScope: 'attached_scenario'` 标注）。接通仍要求最近一次探测 `verified`（ADR-023 第 3 条）。
6. **授权按声明数据域推导**：平台系统沿用连接器面（`ROLE_DATA_DOMAINS × connector.dataDomains`）；自定义系统按 `ROLE_DATA_DOMAINS × materials.dataDomains`——登记时声明的数据域决定哪些角色可探测，而不是默认全员可见。

## 实测口径

- `backend/test/system-registry.test.js` 8 项：多租户测试改为「清单＝6 演示样例＋租户登记，不预设待接入/未登记」；新增「登记：必填物料逐字段点名、系统码防撞与自动生成」；状态机测试改由自定义系统起步。
- `backend/test/system-access.test.js` 13 项（12 → 13）：总览钉死 6 成员与登记 schema 七必填项；新增「登记：必填物料、系统码防撞、越权与未挂接场景探测各自显式失败」；生命周期全链路改由「登记 SRMX → 授权 → 探测 → 接通 → 停用 → 恢复」驱动。
- `workspace-layout.test.js` 9 项：系统接入测试改为钉住登记表单按服务端 schema 渲染、`registerSystemOnboarding` 调用与去预设表述；生命周期断言保留。
- `test:architecture`：`system-onboarding` 导出上限 5 → 6 属显式棘轮变更（带理由注释），未新增跨域边。

## 边界（不得在界面或文档中弱化）

1. 6 个预设成员是 **Mock 演示接入样例**（`demoConnection` / demo 种子配置），不是生产验收；其余系统全部由租户登记产生。
2. 自定义系统的「连通性探测」读取挂接的合成场景**整场景**，不代表真实企业系统验收；`connected` 仍指演示租户生命周期状态。
3. 登记物料是**业务描述性物料**，不是连接配置：没有端点、凭据、协议字段（那些属真实企业连接器阶段）；`connectionConfiguration` 对自定义系统标注 `source='tenant_registration'`。
4. 自定义系统不参与文本系统识别（`detectSystemCodesInText` 只覆盖平台目录类型）——租户命名无别名治理，用它做推断会把普通表述误判成系统归属。
5. 自定义系统无元模型连接模板，不能生成映射草稿（409 `SYSTEM_MAPPING_TEMPLATE_MISSING` 路径不变）；为自定义系统生成模板属后续增量。

## 触发式复审

- 若引入真实企业连接器，登记物料需扩展连接配置段（端点 / 凭据引用 / 协议），且「自动生成系统码」需与对方系统标识对齐。
- 若阶段 6 权限合并收敛 `meta_model.draft.save`，登记闸门需同步评估。
- 若自定义系统需要参与建模来源选择（`systemCodes` 范围），`detectSystemCodesInText` 与 `discoverSemanticSources` 的注册系统集合需引入租户上下文，属独立的权限边界改造。

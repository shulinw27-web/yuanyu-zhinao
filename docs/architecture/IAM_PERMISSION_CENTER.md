# IAM 权限中心说明

> 状态：Demo 已实现，支持 SQLite 单节点与 PostgreSQL IAM 独立灰度
>
> 适用范围：PC Web 权限管理页、组织/人员/角色策略、页面与按钮权限、组织数据范围、风险查询裁剪与变更审计

## 1. 设计目标

权限中心将“能打开哪个页面、能点哪个按钮、能查哪个组织的数据”从前端固定角色判断中分离，收敛为服务端可版本化的 IAM 策略。当前 Demo 用于跑通以下闭环：

1. 按组织树管理人员归属，一名人员可同时承担多个角色。
2. 为角色配置页面/菜单 RBAC 和按钮级权限。
3. 为角色配置组织数据范围，请求时合并当前人员的多角色有效策略。
4. 前端仅在菜单和页面权限同时满足时加载页面数据；后端对页面读取与按钮写操作分别再次校验，不信任浏览器传值。
5. 风险列表、风险详情及风险操作同时受角色基线和组织数据范围限制。
6. 人员分配与角色策略使用期望版本号保存，每次成功变更记录操作人、原因、变更前后值与时间。
7. 未知显式主体默认拒绝；仅服务端识别的可信 Demo 身份可使用角色基线 fallback，账号、角色或策略版本变化会使旧身份会话立即失效。
8. Web 对授权拒绝 fail-closed 刷新权限，在页面可见时周期复核，并用权限代际阻止延迟响应回填旧数据。

## 2. 工程结构

| 模块 | 主要文件 | 职责 |
| --- | --- | --- |
| Web 权限管理页 | `frontend/src/features/permission/PermissionManagementPage.vue` | 组织树、人员多角色、角色权限矩阵、数据范围与审计记录。 |
| Web 菜单/页面/按钮消费 | `App.vue`、`permission-navigation.js`、`AppShell.vue`、`RiskDrawer.vue`、`PrivateAgentPage.vue`、`ProcurementActionPage.vue`、`ConfigManagementPage.vue` 及其 Simulation / Key / OA Meta Model / World Model 子组件 | 仅为有效页面懒加载数据；处理授权失效、30 秒可见态权限轮询和异步响应代际保护，并使用服务端返回的有效权限控制导航和治理操作入口。 |
| API 客户端 | `frontend/src/api/client.js` | 查询权限工作区，保存人员角色和角色策略。 |
| IAM 种子数据 | `backend/src/data/iam-seed.js` | 组织、人员、权限目录、数据范围和初始角色策略。 |
| IAM Repository | `backend/src/services/iam-store.js`、`async-iam-store.js` | 版本化更新人员/策略并保留最近审计；默认 SQLite，可通过独立开关接入 PostgreSQL。 |
| 有效权限计算 | `backend/src/services/access-control-service.js` | 合并人员多角色的页面、按钮和组织数据范围。 |
| 权限管理服务 | `backend/src/services/permission-management-service.js` | 工作区裁剪、输入校验、管理权限二次校验、乐观并发控制与变更审计。 |
| 权限回归 | `backend/test/permission-management.test.js`、`backend/test/iam-service-hardening.test.js`、`backend/test/permission-api-hardening.test.js`、`frontend/test/permission-navigation.test.js` | 覆盖工作区裁剪、多角色、组织锚定、会话失效、账号中心认证、页面读取门禁、有效动作角色、Agent 原 run 角色绑定、写回脱敏、前端授权失效/代际保护和 HTTP 策略即时生效。 |

## 3. 组织、人员与多角色

组织使用 `parentId` 形成树，节点可表示集团、中心、部门或工厂。人员记录包含：

- `orgUnitId`：当前直属组织，是 `CURRENT_ORG` 类策略的解析起点。
- `roleIds`：已分配角色集合，允许一人多角色。
- `primaryRoleId`：主角色，用于兼容当前仍以单角色展示的 Demo 界面和业务契约。
- `status` 与 `version`：非激活人员不产生有效角色；版本号用于防止覆盖并发变更。

多角色的菜单、页面、按钮和可访问组织集按并集合并。只有任一有效角色持有 `ALL` 范围时，最终数据范围才标记为不受组织限制。

业务动作也使用同一有效角色集合判断，不再仅使用 UI 选中的主角色。所有关键写操作会从有效角色集合中选择一个实际授予目标按钮权限的角色，并把该角色传入下游业务、工作流和密钥租约门禁；`primaryRoleId` 只承担兼容展示和旧契约用途，不能压低或扩大人员通过其他已分配角色获得的业务能力。Agent 命令使用更严格的单一原角色规则：只有同一个有效角色同时持有 `agent.prompt.run` 与 `agent.command.execute`，且以该角色重新通过智脑数据域、工作流角色和业务动作校验，才生成 `command` 与一次性 Token；否则 `command: null`、不签发 Token，并降级为只读建议。执行时仍必须使用这个原 run 角色，并继续绑定原 `tenant + subject + session + device`、原命令和一次性 Token，不能借新增角色替换任务起源角色。若命令绑定的是次角色，`/agent/runs`、运行统计和工作项会按当前主体的有效角色集合聚合，但仍强制 `tenant + subject` 一致；次角色撤销后对应记录立即不可见，memory 不跨角色合并。

### 3.1 主体、Demo fallback 与会话失效

- 请求显式携带了主体但主体不在 IAM 人员目录时，服务端返回空角色、空菜单、空页面和空按钮权限，即 fail-closed。
- 角色基线 fallback 仅限非生产环境，且身份来源必须是服务端请求解析器标记的可信 `demo_header`；客户端任意填写主体字符串或携带普通身份会话都不能触发 fallback。
- 身份会话保存人员版本、有效角色集合和角色策略版本快照。账号/人员归属、角色集合或角色策略成功变更后，旧会话在下一次校验时立即失效，必须重新认证。身份会话与 IAM 同时使用 PostgreSQL 时，该失效判断可跨 API 节点生效。

## 4. 页面与按钮 RBAC

权限目录以页面/菜单为父级，按钮为最小操作粒度：

- `menuIds` 决定可打开的 PC 端功能页。
- `pagePermissionIds` 是页面权限的明确标识，例如 `page.risks.view`。
- `buttonPermissionIds` 决定可发起的操作，例如 `risk.acknowledge`、`risk.approve`、`permission.user.assign` 和 `permission.policy.save`。

前端导航要求 `menuIds` 与对应 `pagePermissionIds` 同时满足，并且只为有效页面懒加载接口数据；权限被撤销时会清除旧页面数据并回落到第一个可访问页面。前端隐藏未授权入口仍只是交互层控制：后端对纳入策略映射的 GET 页面资源重新校验页面读取权限，对可写 API 使用当前主体的有效 `buttonPermissionIds` 重新校验，因此直接构造 URL 或 HTTP 请求不能越过权限门禁。`GET /api/account-center` 不是匿名概览接口，必须先通过身份认证并具备 `page.config.view`；`GET /api/permission-management` 必须具备 `page.permissions.view`；`GET /api/risk-cases/{id}` 还必须具备 `risk.detail.view`。管理角色还必须保留权限管理页、人员分配与策略保存权限，避免系统自锁。

`permission.audit.view` 是独立的敏感读权限：权限管理服务无论返回完整管理工作区还是服务层裁剪快照，都会在缺少该权限时把 `audits` 裁剪为空；Web 同时隐藏“审计记录”页签，并在权限被动态撤销时退出已打开的审计页签。`page.permissions.view` 或人员/策略编辑权不会隐式包含审计查看权。

### 4.1 Web 授权失效与异步代际

- 任意 `401` 以及页面、按钮或业务权限拒绝类 `403` 都会发布授权失效事件，请求不会自动重试；Web 立即进入 fail-closed 权限刷新，并清理已加载但不再可信的受保护数据。`AGENT_ORIGIN_ROLE_DENIED` 明确属于该集合，原 run 角色失效或被撤权时会即时收敛前端权限状态。
- 页面处于可见状态时，每 30 秒重新获取当前有效权限；页面隐藏时暂停轮询，重新可见时立即复核，以兼顾权限收敛时效与后台请求开销。
- 页面加载、权限刷新、保存后的工作区重取等所有异步回填都记录权限代际、角色和必要的页面/请求标识。代际、角色或页面变化后才返回的旧响应会被丢弃，防止已撤权数据或旧角色数据重新写回 UI。

当前 Web 按钮权限不只应用于风险和采购，已覆盖：

- Agent 安全评测与模型连接配置；
- 模拟场景运行、模拟 OA 审批、Connector 故障配置和运行时重置；
- Key 策略轮换和活跃租约吊销；
- OA 元模型草稿保存、校验、模拟构建和发布；
- 世界模型草稿创建、校验和发布。

## 5. 组织数据范围

文档使用大写名称表示五种策略语义；当前 JSON 实现分别使用 `self`、`current_org`、`org_and_descendants`、`selected_orgs`、`all`。

| 范围 | 当前解析语义 |
| --- | --- |
| `SELF` | 强制以当前 IAM 人员的直属组织为基础边界，不能被客户端或策略携带的组织 ID 覆盖；当业务资源具备人员/所有者字段时，生产实现还应进一步收窄至本人。 |
| `CURRENT_ORG` | 强制锚定当前 IAM 人员的直属组织，不能被客户端或策略携带的组织 ID 覆盖；不自动包含下级组织。 |
| `ORG_AND_DESCENDANTS` | 拒绝客户端或策略提交 `organizationIds` override；运行时始终锚定当前 IAM 人员直属组织，再展开组织树中的全部下级节点。即使存储中出现遗留/注入的组织 ID，也不会改变解析起点。 |
| `SELECTED_ORGS` | 仅策略中明确选中的组织 ID，当前不隐式扩展其下级节点。 |
| `ALL` | 全部组织，应仅授予受控管理角色。 |

对于没有可验证组织归属的业务数据，生产实现应默认拒绝，而不是回退到仅角色判断。

## 6. 风险查询与操作门禁

基础风险资源具备服务端组织归属。风险列表、详情和大盘中的基础风险集使用同一主体的有效组织 ID 过滤，并保留原有角色可见基线；这样可防止“拥有质量角色即看到全部质量风险”。状态化 Mock 运行时告警仍按演练场景角色分发，尚未纳入组织行级过滤。

风险详情除页面读取和组织过滤外，还在 `GET /api/risk-cases/{id}` 路由单独校验 `risk.detail.view`；没有详情按钮权限时返回权限拒绝，不能通过直接构造详情 URL 绕过前端隐藏。

风险确认与批准不仅在 Web 端隐藏按钮；后端会同时校验：

1. 当前主体是否可访问该风险所属组织。
2. 是否拥有 `risk.acknowledge` 或 `risk.approve` 按钮权限。
3. 原有业务角色/状态条件是否仍然满足。

风险写操作完成后不会直接返回 Repository 中的内部原始对象。服务端会按同一请求主体重新读取资源，再次执行角色基线、组织过滤与响应脱敏后返回，避免写接口成为越权字段或内部字段旁路。

## 7. 版本化保存与审计

人员和角色策略都包含独立 `version`。写请求必须带 `expectedVersion`；当 Repository 中的当前版本已变化时，请求返回版本冲突，要求刷新后重新编辑。成功保存后：

- 对象版本与全局 IAM 配置版本递增。
- 人员分配审计记录组织、多角色、主角色、状态和变更前后版本。
- 角色策略审计记录页面、按钮、数据范围、操作主体、变更原因和时间。
- 审计中不存储密码、会话令牌或业务系统凭据。
- 人员/账号状态、组织归属、角色集合或角色策略版本变化后，旧身份会话的版本快照不再匹配，下一次使用即被拒绝。

## 8. API 契约

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/access/me` | 返回当前主体合并多角色后的页面、按钮、数据范围与有效组织 ID。 |
| `GET /api/account-center` | 必须通过身份认证并具备 `page.config.view`，返回账号中心概览。 |
| `GET /api/permission-management` | 必须具备 `page.permissions.view`，返回当前主体裁剪后的权限管理工作区、有效权限与版本。 |
| `POST /api/permission-management/users/{userId}/roles` | 版本化保存人员组织归属和多角色分配；后端校验 `permission.user.assign`。 |
| `POST /api/permission-management/roles/{roleId}/policy` | 版本化保存页面、按钮和组织数据范围；后端校验 `permission.policy.save`。 |

权限管理服务层保留“按当前主体裁剪只读快照”的能力：仅返回自身人员记录、可见组织路径、有效权限目录与策略，不返回全部人员或审计日志；它用于服务级测试及未来可能拆出的个人权限自助接口。当前公开的 `GET /api/permission-management` 是管理页面接口，仍必须具备 `page.permissions.view`，普通业务角色不能直接调用。

## 9. 测试与验证

```powershell
npm.cmd run test:permissions
npm.cmd run test:all
```

`test:permissions` 当前共 28 项，覆盖权限管理、IAM 服务加固、真实 HTTP 权限门禁、客户端运行配置、页面数据注册和前端导航/失效处理：

- 管理员完整编辑工作区、管理 API 页面门禁，以及服务层非管理主体裁剪只读快照；
- 人员多角色分配、管理权限拒绝、乐观锁冲突和最后管理员防护；
- 角色策略更新、防自锁、风险/通知组织过滤和基线恢复；
- 真实 HTTP 子进程中的管理权限、多角色即时生效、`409` 版本冲突、按钮权限拒绝和组织范围即时生效。
- 未知显式主体 fail-closed 与仅可信 `demo_header` 可用的 Demo fallback；
- `SELF` / `CURRENT_ORG` 强制锚定当前 IAM 人员直属组织；`ORG_AND_DESCENDANTS` 拒绝 `organizationIds` override，并在运行时始终从人员直属组织展开；
- 账号/人员、角色集合和角色策略变化使旧身份会话立即失效；
- 多角色业务动作、服务器端 GET 页面读取门禁、`risk.detail.view` 详情按钮门禁，以及风险写回后的重新读取、组织过滤和响应脱敏；
- `permission.audit.view` 同时控制服务端审计数组裁剪与前端审计页签可见性；
- 账号中心拒绝生产环境匿名访问，`account-center` / `permission-management` 分别执行 `page.config.view` / `page.permissions.view` 页面门禁；
- 关键写操作选择实际授予目标按钮的有效角色；Agent 只有在同一有效原角色同时拥有 prompt/execute 权限并通过数据域、工作流和业务校验时才生成命令，否则无 Token 降级只读，execute 继续绑定该原 run 角色与 `tenant + subject + session + device + 一次性 Token`；
- 前端菜单与页面权限联合导航、采购页面继承智脑页面边界、权限撤销后的确定性回落和按有效页面懒加载；
- 任意 `401` / 权限类 `403`（包含 `AGENT_ORIGIN_ROLE_DENIED`）触发 fail-closed 授权刷新且不重试原请求，以及异步响应在权限代际变化后不能回填旧数据。

`test:all` 的执行结果和数量以本次运行输出为准。PostgreSQL 专项覆盖 IAM 乐观锁、Schema 迁移/checksum、策略审计、IAM-Outbox 原子提交与失败回滚，以及请求快照写后可见和并发最后管理账号约束；不以开发环境测试替代真实数据库验收。

## 10. 当前 Demo 限制与生产替换

当前组织、人员、角色策略、版本号和审计记录可通过 `IAM_STORE_DRIVER=postgres` 进入共享 PostgreSQL；身份会话使用独立开关。API 每次请求读取一次 IAM 快照，请求内不重复漂移，写入成功后刷新当前快照。“最后一个管理层账号”在数据库行锁事务中复核，不能依赖容易被并发绕过的服务层预检查。该实现仍是企业 IAM 接入前的运行底座，不替代企业 IdP、主数据同步、不可篡改审计和 RLS。

生产环境至少需要：

1. 将当前 JSONB 迁移桥梁拆分为带 tenant key、外键、索引和 RLS 的正式 IAM 表，并把审计投递到不可篡改审计仓。
2. 对接 OIDC/OAuth 2.1 或企业 IdP，从可验证的主体、组织和组声明生成角色映射，并禁用 Demo 角色 Header。
3. 引入可版本化的策略发布与缓存层；策略变更后按 tenant/subject 精准失效，不允许长时间使用旧权限。
4. 将角色/组织或人员状态变更与会话撤销、Token 有效期和设备信任联动，确保高风险权限被移除后旧会话无法继续使用。
5. 对所有业务资源强制补齐 tenant、organization 和 owner 归属，在查询层使用统一行级策略，而不是仅由单个服务人工调用过滤函数。

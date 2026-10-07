# ADR-030：元域智语权限语义独立——page.world.view 保留期结束删除

- 状态：Accepted（2026-10-07）
- 关联：ADR-024（自定义系统登记）、ADR-026（world.draft.* 等价合并）、ADR-027（文档材料登记）、ADR-028（系统接入连接配置段）
- 触发：2026-09-28 阶段 6 第二段（方案 4.3 决策 A）删除元域智营「元模型」页时，`page.world.view` 被 4 处元域智语服务复用为访问权限，按阶段 2 先例**保留一个版本周期**；2026-10-07 该保留期结束，兑现删除。

## 背景

`pagePermissionIds` 由「角色 menuIds ∩ 权限目录」派生（`access-control-service`）。元域智营的「元模型」页迁出后，`menu.world` / `page.world.view` 权限条目成为元域智语端语义页面与服务的**访问载体**——权限语义挂靠在元域智营的菜单目录下，与「元域智语是独立语义运营端」的定位不符。保留期内元域智语端自身没有可归属的权限条目。

## 决策

1. **新权限条目**：`iam-seed.js` 权限目录新增 `menu.semantic-operations`（menuId `semantic-operations`，名称「元域智语」，页面权限 `page.semantic-operations.view`），描述点名语义运营端工作台（语义建模、系统接入、知识库与巡检）。**单一页面权限粒度**：元域智语端现有服务的访问预期一致（一个页面门槛覆盖全端），细粒度拆分（如巡检/接入单独权限）待真实需求触发再复审。
2. **删除旧条目**：`menu.world` / `page.world.view` 从权限目录删除；角色策略同步——`quality_manager` 的 menuIds `world → semantic-operations`（原本持有），其余角色原本不持有、零变化；executive 由 allMenuIds 计算自动包含。
3. **换码面（8 处后端 + 2 处前端 + 4 处测试）**：`route-security.js`（语义 API 路由组 + 授权解释）、`governance-routes.js`（canReadWorldModel + denyButton）、`knowledge-routes.js`（semantic 分支页面门槛）、`mock-onboarding-service.js`（页面 403）、`mock-onboarding-ontology-adapter.js`（访问校验）、`semantic-inspection-schedule-service.js`（巡检执行权限）；元域智语 `App.vue` / `SystemAccessWorkspace.vue` 注释；测试 `knowledge-evidence` / `system-access` / `tenant-runtime-control`。
4. **老前端死链清理**：管理 Web `AppShell.vue` 的「语义层」导航项删除（world 页面数据已不拉取，该项为死链），导航图标顺移；`permission-navigation.js` 注释同步（保留期结束、条目已删）。

## 后果

- **权限语义独立完成**：元域智语端权限不再挂靠元域智营菜单目录，4.3 决策 A 的「保留一个版本周期」兑现结束。
- **权限矩阵可见变化**：权限管理界面出现「元域智语」菜单条目、「元模型」条目消失；quality_manager 菜单清单 `world → semantic-operations`（实际可见页面集合不变，该角色本就没有 world 前端页面）。
- **不变式**：`runWithTenantExecution` 的受信执行、页面门槛（菜单 ∩ 页面权限）判定逻辑、`test:permissions` 的「持旧权限也不可进入已移除页面」用例（构造输入不再来自真实 seed，断言恒 false 的语义不变）均不放宽。
- **边界**：真实企业 IdP 对接、权限矩阵的细粒度拆分、跨端 SSO 属生产化范围，保留。

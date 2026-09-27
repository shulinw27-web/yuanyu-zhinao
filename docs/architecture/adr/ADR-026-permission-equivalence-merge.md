# ADR-026：`world.draft.*` 并入 `meta_model.*` 的等价合并与权限单一权威

- 状态：Accepted（2026-09-28）
- 关联：阶段 6（模型管理 / 版本管理收敛到元域智语）；[ADR-023](ADR-023-lifecycle-operation-surface.md)（接入生命周期操作面——其「同一把闸门」语义由本 ADR 补全）；[ADR-024](ADR-024-custom-system-registration.md)（自定义系统登记）

## 背景（Context）

系统接入重构方案（阶段 6）要求把世界模型草稿权限 `world.draft.create / validate / publish` 并入元模型权限体系。合并前的权限事实（`iam-seed.js` 实测取证）：

| 权限 | 持有角色 |
| --- | --- |
| `world.draft.create` / `world.draft.validate` | executive、quality_manager |
| `world.draft.publish` | executive（经 allButtonIds） |
| `meta_model.draft.save` / `draft.validate` / `simulate` | 全部 5 角色 |
| `meta_model.publish` | executive（经 allButtonIds） |

同时存在**两道闸门**：路由层按权限码闸（`governance-routes.js` 的 `selectActionRole`），服务层又有一套**硬编码角色白名单**（`world-model-template-service.js` 的 `canConfigure`/`canPublish`）——后者是隐藏的第二道闸门，与 IAM 重复且不可见。

## 决策（Decision）

用户于 2026-09-28 在三策略（等价合并 / 收窄合并 / 模板专用权限）中选定**等价合并**：

1. **语义等价映射**：`world.draft.create → meta_model.draft.save`、`world.draft.validate → meta_model.draft.validate`、`world.draft.publish → meta_model.publish`。`world.draft.*` 权限条目与全部代码引用删除；`menu.world` 的按钮清单清空（页面本身去留属 4.3 决策，另行处理）。
2. **权限系统成为唯一权威**：删除服务层 `canConfigure` / `canPublish` 白名单。创建/校验由路由闸门 `meta_model.draft.save` / `meta_model.draft.validate` 把守，发布由 `meta_model.publish` 把守（仅 executive 持有，语义不变）。读侧按角色的数据可见性（`visibleCategories`）不受影响——那是数据可见域，不是写入权威。
3. **前端闸门同步换码**：`canConfigureMapping` 等改挂 `meta_model.*`；`WorldModelTemplateConfig` 的角色白名单保留——对既有持权角色（executive / quality_manager）按钮可见性零变化。

## 后果（Consequences）

**如实披露的能力变化**：对原持 `world.draft.*` 的两角色（executive / quality_manager）**零变化**。映射草稿闸门与接入侧写入同闸后，另三角色（production / procurement / marketing manager，本就持有接入侧写入权限）的映射草稿创建/校验入口随之打开——这正是 ADR-023 以来「接入侧写入同一把闸门」的既定语义，不是放宽。

**动作角色语义变化**（`permission-api-hardening` 实测暴露）：合并前多角色用户的创建动作经回退落到持 `world.draft.create` 的 executive（草稿 `createdBy` 为管理层）；合并后 `selectEffectiveRoleForPermission` 优先返回持有权限的**主角色本人**（如 marketing_manager）。「谁持有闸门权限，谁就是动作责任人」——与连通性探测 / 生命周期操作的既有行为一致。

**不变式**：已发布模型指纹与版本号不变（结构迁移）；`meta_model.publish` 仅 executive 持有，发布权威未稀释。

## 复审条件

1. 若映射草稿被证明需要与系统接入写入不同的授权粒度（如接入人员不应能建模板草稿）→ 引入 `meta_model.template.*` 细分（即被否决的第三策略），需新 ADR；
2. 4.3 的元域智营 `world` 菜单去留（全迁删页 / 只读指针 / 部分保留）仍是未决决策，菜单处置落地时须复核本 ADR 的按钮清空是否需要跟随。

## References

- 代码：`backend/src/data/iam-seed.js`（权限条目删除）、`backend/src/routes/governance-routes.js`（闸门换码）、`backend/src/services/world-model-template-service.js`（白名单删除）、`packages/agent-ui/src/system-access/`、`apps/semantic-operations-console/src/`
- 测试：`test:permissions` 29/29、`test:access` 13/13、`test:semantic` 6+61+98、`test:events` 17/17、`test:scope` 12/12

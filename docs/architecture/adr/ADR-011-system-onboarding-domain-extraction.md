# ADR-011: 接入能力独立成域，主视角从元域智营迁至元域智语端

## Status

Accepted

## Context

### 当时的约束

- 「系统接入 → 选系统建模 → 模型治理」重构的**阶段 0 已把系统清单收敛为单一事实源**（[ADR-009](ADR-009-system-registry-single-source.md)）：系统类型与连接器定义属平台，接入生命周期与探测结果属租户。
- **阶段 1 已把跨端共享前端资产提升为声明式包**（[ADR-010](ADR-010-agent-ui-package-extraction.md)）：跨包穿透基线归零，迁文件不再触发棘轮失败。
- 架构棘轮的 `DOMAIN_EXPORT_CEILING.governance` 已达 **92 上限且规则是「只降不升」**。
- 双端职责在方案里已划定：**元域智语端是语义建设与运营的入口**，元域智营是平台治理入口。

### 实测问题一：两个「空按钮」

元域智营 `config` 页（`frontend/src/features/config/ConfigManagementPage.vue`）原有：

```html
<button>连通性测试</button>
<button class="outline-button">新增映射</button>
```

两者**都没有 `@click`**——是纯装饰性按钮。也就是说，历史上「接入系统配置」「当前生效映射」「元模型连接模板」三个区块只是**展示**，从未真正驱动任何探测或映射生成。这不是迁移问题，是**从未实现**。

### 实测问题二：主视角错位

接入是「每个企业各自为政」的业务运营行为（租户隔离的生命周期 + 租户自有的连接配置），却被放在**平台级元域智营**里。同时模型/版本治理要收敛到元域智语端（阶段 6），若接入留在元域智营，运营人员将在两个系统间来回跳转。

### 实测问题三：把服务塞进 governance 域会抬高基线

`system-registry-service.js` 之上需要一个面向运营视图的组装层（总览 / 详情 / 探测）。若放进 `governance` 域，其导出上限 92 已被占满，只能抬高基线——而棘轮规则明确是**只降不升**。架构测试本身给出的合法路径是**拆分领域**。

## Decision

### 1. 新建 `backend/src/domains/system-onboarding/` 域，上限刻意压到 4 项导出

```js
// backend/src/domains/system-onboarding/public-api.js
export { SYSTEM_ACCESS_BOUNDARY, getSystemAccessOverview, getSystemAccessDetail, probeSystemConnection }
  from '../../services/system-access-service.js';
```

`DOMAIN_EXPORT_CEILING['system-onboarding'] = 4`。**刻意不把 3 个实现细节（探测历史读取、数据集索引重置）放进契约面**——它们分别为 UI 轮询与测试复位服务，不是领域契约。

### 2. 职责分界：注册表是事实源，接入服务只做组装与探测

| 文件 | 职责 | 不做什么 |
| --- | --- | --- |
| `system-registry-service.js` | 系统类型定义、角色可见性策略、租户级接入生命周期状态机 | 不组装运营视图、不发请求 |
| `system-access-service.js`（新） | 组装「一个系统长什么样」+ 真实连通性探测 | **不新增任何系统定义、不复制任何清单** |

后者所有系统类型信息一律读注册表 `definition.connector`。实施中发现初版仍从 `mcp-connector-service.js` 单独派生了一份连接器目录（`connectorByCode`），**但整个变量从未被使用**——这既是死代码，也是「同一份清单在两个域各存一份」的苗头，已整条链路删除并在文件头写明不这样做的理由。

### 3. 连通性探测是真的会发请求

`probeSystemConnection` 经 `readMockOnboardingSource` **监听本地临时端口、发分页 HTTP 请求、校验 `mock-onboarding-query.v1` 契约与分页完整性**，返回 `requests / pageCount / recordCount / readableRecords / objectTypes`。实测（`roleId='executive'`，探测 ERP）：

```
status=verified  requests=3  pageCount=3  recordCount=6  readableRecords=34  objectTypes=5
```

**这不是企业连接器验收**：它读的是内置合成 HTTP 数据源（`sourceKind: 'local_mock_http'`），返回值与界面都显式标注，口径不得弱化。

### 4. 「真正接上」覆盖三个按钮，不只一个

若只把「生成草稿」接到新界面，`WorldModelTemplateConfig` 的「校验草稿 / 发布版本」会**在新位置上复现空按钮**。因此一并新增路由：

```
POST /api/semantic-operations/systems/:code/mapping-drafts          (world.draft.create)
POST /api/semantic-operations/systems/:code/mapping-drafts/:id/validate  (world.draft.validate)
POST /api/semantic-operations/systems/:code/mapping-drafts/:id/publish   (world.draft.publish)
```

### 5. 权限沿用既有闸门，合并推迟到阶段 6

- 接入读取（总览/详情/映射模板）→ `page.world.view`
- **探测 → `meta_model.draft.save`**（探测是读行为，但它会写入租户的探测历史，按既有草稿权限门禁）
- 映射草稿生成/校验/发布 → 既有 `world.draft.create` / `validate` / `publish`

**刻意不新增权限标识，也不提前合并两套权限模型**——合并属阶段 6 范围，本阶段沿用既有闸门可让回归结论只归因于迁移本身。

### 6. 路由匹配顺序：字面量必须先于 `:code`

```js
/api/semantic-operations/systems(?:/([^/]+))?$          // 总览 / 详情
/api/semantic-operations/systems/([^/]+)/(probe|mapping-drafts)$
/api/semantic-operations/systems/([^/]+)/mapping-drafts/([^/]+)/(validate|publish)$
```

字面量子路径（`mapping-templates` / `connection-targets` / `mapping-drafts`）必须排在 `:code` 之前，否则 `mapping-templates` 会被当成一个系统码。测试第 9 项专门断言这个顺序风险。

### 7. 字段目录按对象名归并，声明冲突显式暴露

实施中实测到一处**自有缺陷**：字段目录原实现逐场景 `push`，而同一个对象会被多个合成场景声明（WMS 的 `StockPosition`/`Warehouse`、OMS 的 `SalesOrder`），于是：

- 「对象目录」计数被重复项撑大（**WMS 10 → 实际 8，OMS 8 → 实际 7**）；
- 前端以 `table.name` 作 `v-for` 的 `:key`，**产生重复键**。

改为按 `name` 归并，每个对象记录 `scenarioIds`。进一步实测发现：WMS 的 `StockPosition` 在两个场景里**字段声明真的不同**（`fulfillment` 含 `stock_id`/`ownership`/`unit`，`quality_incident` 只有 `lot_id`/`warehouse_id`/`qty`/`status`）——因此归并**不等于**合并语义：字段签名不一致时进入 `fieldCatalog.conflicts` 由界面显式呈现，**不静默取先出现的那个**（否则界面上的「字段目录」会随场景遍历顺序漂移）。

同时透出 `readScenarioId`（探测实际读取的那个场景），界面如实注明「目录是各场景声明的并集，探测只读其中之一」。

### 8. 元域智营收窄，旧端点本阶段不删

- `ConfigManagementPage.vue` 删除三个区块与 3 个 emit，54 → 46 行；`App.vue`、`governance-actions.js`、`page-data-registry.js` 删除对应状态与动作；config 页的 `Promise.all` 从 7 个降到 6 个。
- **旧端点保留一个版本周期**，但元域智营不再有入口，迁移后可通过 404 计数确认无残留调用。

### 9. 迁移与收窄必须同步更新测试的断言口径

`frontend/test/page-data-registry.test.js` 原以 `canAccessPage: () => false` 跳过 world 拉取。`fetchPageData` 去掉该参数后，这个写法会**悄悄失效（永远为真）**。已重写为**断言「不存在这条调用路径」**：用 `forbidden` 名单 + Proxy API 记录调用，断言相关字段的调用集合为空——口径从「被权限挡住」改为「结构上不存在」。

## Consequences

### 变简单了

- 接入能力有了独立域与显式契约面，`governance` 域导出上限**未被抬高**（仍为 92）。
- 运营人员在一个系统内完成「看系统 → 探连通 → 建映射 → 校验/发布草稿」，且**三个按钮都有真实行为**。
- 系统清单不再有第二份（删除了 `mcp-connector-service` 派生链路），与 ADR-009 的收敛方向一致。
- 跨域依赖被显式登记为 2 条边（`system-access → mock-onboarding-source`、`system-access → semantic-tenant-context`），组装依赖不再藏在代码里。

### 变困难了

- **跨域边基线 8 → 10**（新增 2 条）。这是「只降不升」规则下的**有意增加**，理由是两条边均为组装依赖而非领域耦合；**刻意没有新增** `system-access → world-model-template` 那条边——连接模板仍属 governance 域，由**路由层组合两个域的 public-api**。这条判断需要在评审时能说清楚。
- 接入视图与材料视图在元域智语端成为**主/次双标签**，`SemanticOnboardingWorkspace` 从主视角降为次级；两个视图共享 `open-agent` 出口，行为一致性需要测试守住。
- 「真正接上」意味着探测会**真的占用本地端口并发请求**，测试必须覆盖六种故障模式，不能让「探测失败」被伪装成成功。

### 放弃了什么

- **放弃了「元域智营也是接入入口」的双入口便利**。接入只在元域智语端，元域智营的 config 页只保留监控/安全/账号/Key Center/模拟运行时/大模型连接。
- **放弃了在 governance 域里顺手放 3 个导出的省事做法**。代价是多一个域与一条棘轮登记，收益是基线不被抬高。
- **放弃了本阶段合并两套权限模型**（推迟到阶段 6），因此现阶段同一屏内会出现两套权限标识并存的情况。
- **放弃了自动合并跨场景字段声明**。代价是界面上会看到冲突提示，收益是不会有「目录随遍历顺序漂移」的静默错误。

## 已知边界（如实）

- `systemConfigurations`（责任人 / 同步频率 / 字段→对象映射）**仍来自 demo 种子、尚未租户隔离**，返回值以 `configurationSource: 'demo_seed'` 标注，界面显示「来源：demo 种子样例」。属阶段 6 范围。
- 字段目录中的 `StockPosition` 类冲突**是既有合成数据的真实不一致**，本阶段只做显式暴露，**未修改 `examples/` 下的夹具数据**（改夹具会牵动 supply-chain 回归，超出本阶段范围）。
- 元域智营中 `.config-menu` / `.ontology-mapping` / `.integration-settings` / `.mapping-*` 等 CSS 规则**已成为死代码，尚未清理**。
- 本阶段**未做**真实企业连接器、未做生产多租户验收；所有探测结论均为内置合成数据源。

## 退出/复审条件

出现以下任一情形时重新审视：

1. **`system-onboarding` 域导出超过 8 项** —— 说明组装层正在吞并注册表职责，应重新划线而不是再抬上限。
2. **出现第三个消费 `system-access-service` 的界面/服务** —— 说明「面向运营视图的组装」被复用到非运营场景，应拆出探测能力为独立服务。
3. **真实企业连接器接入** —— 探测路径必须从 `mock-onboarding-source` 切换到真实连接器，`sourceKind` 与界面文案同步更新（ADR-009 退出条件 3 的凭据校验同时到期）。
4. **`fieldCatalog.conflicts` 长期非空且无人处理** —— 说明合成场景的字典需要先收敛，届时应把两个夹具字典统一为一份，而不是继续在界面上标注冲突。
5. **元域智营旧端点在一个版本周期后仍有调用** —— 说明迁移不彻底，需先清理调用方再删除端点。

## 关联

- 落地依据：[「系统接入 → 选系统建模 → 模型治理」整体重构方案](../SYSTEM_ONBOARDING_RESTRUCTURE_PLAN.md) 阶段 2
- 前置决策：[ADR-009](ADR-009-system-registry-single-source.md)（单一事实源，阶段 0）、[ADR-010](ADR-010-agent-ui-package-extraction.md)（共享包，阶段 1）
- 相关决策：[ADR-005](ADR-005-domain-public-api-layering.md)（分层与契约面）、[ADR-006](ADR-006-dual-agent-independent-entry.md)（双 Agent 独立入口）
- 棘轮实现：`backend/test/architecture-baseline.js`（`DOMAIN_EXPORT_CEILING['system-onboarding']`、`CROSS_DOMAIN_EDGE_BASELINE` 新增 2 条）
- 域本体：`backend/src/domains/system-onboarding/`

## 实施台账（2026-09-25 实测）

| 项 | 结果 |
| --- | --- |
| `test:access`（新增） | 9/9 |
| `test:architecture` | 10/10；跨包基线 0；跨域边 8 → 10 |
| `test:registry` | 7/7 |
| `test:semantic` | 5/5（SDK）+ 60/60（运营端）+ 91/91（后端与路由） |
| `test:permissions` | 29/29 |
| `test:mock-onboarding` / `test:ontology` | 69/69 / 104/104 |
| 5 端构建 | `frontend` / `semantic-operations-console` / `desktop` / `mobile` / `dingtalk` 全部通过 |
| `lint` / `typecheck` / `docs:check` | 通过 |
| 探测实测 | ERP：`verified`，3 请求 / 3 页 / 6 条记录 / 34 条可读 / 5 类对象 |
| 阻断实测 | 越权探测 → `SYSTEM_PROBE_FORBIDDEN/403`；无连接器 → `SYSTEM_CONNECTOR_NOT_REGISTERED/409`；未知模式 → `SYSTEM_PROBE_FAULT_UNKNOWN/400` |
| 可探测系统 | 5 → 7（OA/ERP/WMS/MES/LIMS/QMS/OMS） |

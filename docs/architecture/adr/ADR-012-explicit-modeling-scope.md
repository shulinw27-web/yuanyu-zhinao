# ADR-012: 建模范围必须显式给出，删除「推断为空即回落全量」

## Status

Accepted

## Context

### 当时的约束

- 「系统接入 → 选系统建模 → 模型治理」重构的阶段 0 已把系统清单收敛为单一事实源（[ADR-009](ADR-009-system-registry-single-source.md)），阶段 1 已清偿跨包穿透（[ADR-010](ADR-010-agent-ui-package-extraction.md)），阶段 2 已把接入主视角迁到元域智营端（[ADR-011](ADR-011-system-onboarding-domain-extraction.md)）。
- 语义层的一条既有原则是**语义关系不扩大数据范围**（[ADR-001](ADR-001-semantic-permission-separation.md)）：建立语义关系与提升数据授权是两件独立的事。
- 方案 4.5 给出的三个选项：A 仅建模范围过滤 / B 数据授权门禁 / C = A + 超出角色数据域时明确阻断。方案倾向 C，用户在 2026-09-25 确认整体方案。

### 实测问题：范围有三个来源，其中两个是隐式的

`backend/src/services/semantic-source-discovery-service.js` 的 `discoverSemanticSources` 历史上这样决定范围：

```js
const selectedCodes = requestedSystems.length
  ? requestedSystems
  : connectorCatalog.filter((item) => item.accessible).map((item) => item.system);
```

`requestedSystems` 来自 `detectRequestedSemanticSystems(request)`，即**文本里出现的系统名**。于是「这次建模覆盖了哪些系统」实际由两条隐式规则决定：

1. **文本命中**：诉求里出现系统名（哪怕出现在「不要用 ERP」这类否定句里）就被当作范围；
2. **推断为空即放大**：什么都没提到时，范围被放大到**整个角色可见面**（全部 `accessible` 连接器）。

两种情况下，实际覆盖范围都可能**超出运营人员的可见选择**，而界面上没有任何地方显示「这次范围是怎么定下来的」。项目历史上已复现过与「静默」相关的风险（阶段 2 实测用例 C：材料里声明了、但未被任何场景覆盖的对象会被静默丢弃）。

### 为什么这一行值得写 ADR

它同时触及三件难以逆转的事：建模任务的**范围语义**、`detectRequestedSemanticSystems` 的**权威等级**、以及越权选择时是**阻断还是裁剪**。三者都影响对外契约与授权语义，且改动会波及既有测试与调用方（巡检 worker、来源清单端点、管理 Web 客户端）。

## Decision

### 1. 范围只有两个显式入口

`discoverSemanticSources({ request, role, systemCodes, includeAllRegistered })`：

| 入口 | 含义 |
| --- | --- |
| `systemCodes: string[]` | 运营人员显式勾选的系统。**空数组＝显式选择为空**，不是「未指定」 |
| `includeAllRegistered: true` | 调用方**显式**声明「我要全部已登记系统」（只读巡检、来源清单预览） |

两者都没有时范围为空，**没有回落**。返回值新增 `selectionSource`（`explicit` / `explicit_empty` / `text_inference` / `unspecified` / `all_registered`）、`selectedSystemCodes`、`explicitSystemCodes`、`mentionedNotSelected`、`scopeNotice`，使「范围是怎么来的」可审计、可测试。

### 2. 文本识别降级为提示素材

`detectRequestedSemanticSystems` 的返回值只表示「文本里提到了什么」，**不再**作为范围依据。它在建模任务中只驱动 `mentionedNotSelected`（「文本提到 WMS 但未选择」），用于提示，不进入范围。

### 3. 范围绑定意图由服务端单一常量决定

`SOURCE_BOUND_INTENTS = ['build_model', 'discover_sources']`。只有这两个意图需要范围；对话类、状态查询类诉求不因文本里出现系统名而被动获得范围。**客户端不替服务端决定哪些意图需要范围**。

### 4. 四类拒绝（不放大、不裁剪、不提权）

| 情形 | 状态码 | 错误码 |
| --- | --- | --- |
| 未提供 / 空数组 | 400 | `SEMANTIC_SYSTEM_SCOPE_REQUIRED` |
| 编码不在系统注册表 | 400 | `SEMANTIC_SYSTEM_UNKNOWN` |
| 在注册表但无受控连接器 | 400 | `SEMANTIC_SYSTEM_NOT_REGISTERED` |
| 超出角色数据域 | 403 | `SEMANTIC_SYSTEM_SCOPE_FORBIDDEN` |

请求体形状非法 → 400 `SEMANTIC_SYSTEM_SCOPE_INVALID`。任务创建的错误响应必须透出 `code`，否则客户端只能靠中文文本匹配来决定如何补救。

越权采取**阻断**（4.5-C）而非裁剪：把一个越权系统静默裁掉，会让运营人员以为「范围已经生效」，而实际只覆盖了子集。

### 5. 覆盖结果如实上报，不按范围过滤对象

> **该条已被 [ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md) 取代（2026-09-25）**：阶段 4 要「按选中系统的字段目录抽取对象」，抽取本身就是一次筛选，范围由此从「标注口径」变成事实上的过滤器，退出条件 2 被触发。用户选定「**过滤 + 被排除清单显式列出**」——范围外对象不进提案，但必须以可读形式列出并提示补勾。本条「不按范围过滤」的结论不再有效，`outOfScopeObjects` 字段名随之移除。

提案生成后计算 `task.systemScope = { selected, covered, uncovered, unassignedObjects, outOfScopeObjects, mentionedNotSelected }`。**不**按范围过滤对象：过滤会让「材料里有、但范围外」的事实消失，而那通常意味着选择错了或材料传错了。

### 6. 承接上文不继承范围

`parentTaskId` 存在时仍要求本轮显式给出；错误信息带上「上文任务的范围是 X，如仍要沿用请在本轮显式带上」。范围**不得靠继承静默生效**。

## Consequences

**变简单/变可靠**

- 「这次建模覆盖了哪些系统、为什么是这些」在任务上可查（`systemScope.selectionSource` + `selected`），可被证据链与审计引用。
- 越权不再产生「看起来成功了但只读了一部分」的中间态：要么按所选范围做，要么明确失败。
- 调用方无法再靠「传一句包含系统名的文本」碰巧获得全量范围；需要全量必须写 `includeAllRegistered: true`，这是可 grep 的显式声明（巡检 worker 已改）。

**代价/变得更难**

- **建模任务现在必须携带 `systemCodes`**：这是对外契约的破坏性变更。既有调用方（含测试夹具）必须同步；承接轮也不能省略。
- `detectRequestedSemanticSystems` 仍然被两处非建模路径使用（材料文件名→来源系统的归属、规划建议里的 `systems`），这些路径的语义未变，**容易误读为「文本仍能定范围」**——已在函数注释里写明。
- 前端门禁按「诉求看起来要建模 + 未选系统」判定，这是**客户端启发式**，与服务端的权威判定可能不一致。这是有意选择：字面实现（无选择即禁用提交）会把「你好」「你是谁」这类对话一起禁掉，而服务端对对话类意图本就不要求范围。服务端硬门禁仍是唯一权威。
- 前端「文本提到但未选」的提示只按系统编码匹配、不含别名，属于**降级提示**，权威判定在服务端。

**放弃的选项**

- **保留回落但标注**：仍会让「没给范围」与「要看全部」产生同一个响应，调用方无法区分。
- **越权时静默裁剪到可见子集**：产生「看起来成功」的假象，正是本次重构要消除的模式。
- **把范围做成数据授权门禁**（4.5-B）：会让 UI 勾选变成隐式提权，与 [ADR-001](ADR-001-semantic-permission-separation.md) 冲突。

## 退出/复审条件

1. **当前角色在系统接入里没有任何已授权系统**时，面板为空、任何建模诉求都无解——若真实企业环境出现这种常态（而非配置缺失），需要重新审视「阻断」是否应改为「提示 + 由具备权限的人员处理」。
2. ~~若阶段 4 让范围开始**裁剪对象**（按选中系统抽取），则 `outOfScopeObjects` 的语义会从「材料与选择不一致的上报」变成「被过滤掉的记录」。届时必须重新决定：范围是**过滤器**还是**上报口径**——当前明确是后者。~~ **已于 2026-09-25 触发并解决**：范围确定为**过滤器**，被排除项必须显式列出，`outOfScopeObjects` 拆为 `partialScopeObjects` 与 `excludedObjects`。见 [ADR-013](ADR-013-scope-as-filter-with-explicit-exclusions.md)。
3. 若前端启发式门禁与服务端权威判定出现**可复现的不一致**（用户按提示操作仍被 400，或未被提示却拿到 400），应改为由服务端提供一个廉价的「本诉求是否需要范围」判定端点，而不是继续扩充客户端正则。
4. 若权限合并（阶段 6）改变了角色数据域与按钮权限的关系，本 ADR 第 4 条的越权判定需要重新核对来源（当前复用 `discoverSemanticSources` 的 `authorized`）。

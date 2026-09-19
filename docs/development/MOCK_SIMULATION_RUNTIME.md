# 状态化 Mock 流程模拟运行时

> 状态：当前 Demo 的默认集成模式。它不连接企业生产系统，也不保存真实业务凭据。

2026-09-17 开发安排：本运行时是 [Mock 优先阶段计划](DEVELOPMENT_ROADMAP.md) 的复用资产之一，不代表完整企业接入项目已经实现。旧场景服务使用固定 `mock_simulation/workspace` 存储键，角色裁剪不能替代租户隔离；多企业测试在可信租户作用域改造并验收前须使用独立测试实例和存储，不在共享实例混用租户数据。

## 目标

### 2026-09-19：文件检查点与跨进程恢复

在事件回放工具上新增 `scripts/lib/mock-event-checkpoint.mjs`，仍仅用于测试：

- 保存为带格式版本、SHA-256 校验和及事件日志的 JSON 文件，使用排他创建，不覆盖已存在文件；写完执行文件同步后才返回成功。
- 文件上限 2.1 MB；读取先检查文件类型和大小，再有界读取，拒绝截断、损坏、内容与校验和不一致及超限数据。
- 恢复必须由调用方明确给出租户和项目，不能直接信任文件声明。校验通过后重新执行事件契约检查，不直接注入最终状态。
- 测试启动新的 Node 进程，通过 `scripts/mock-event-recovery-probe.mjs` 读取真实临时文件，核对快照、删除墓碑及重复事件回执；父进程另核对恢复后迟到事件仍被忽略。
- 校验和不带密钥，只能检测损坏，不认证来源，不能防止攻击者连同校验和一起改写。文件路径来自测试程序，不开放给上传接口。

复现：`npm.cmd run test:mock-onboarding`。新增 4 项测试，接入专项合计 68 项通过。临时文件由测试创建、仅清理自身文件和空临时目录；不修改项目业务数据库、密钥或运行配置。

此增量取代下方旧批次“只做同进程恢复”的范围限制，但依然不是断电/磁盘故障、目录元数据持久化或数据库事务恢复验收。写入中断可能留下不完整的新文件，加载会拒绝，不会自动修复。没有“最新检查点”指针、并发写入调度或生产事件服务，旧共享模拟运行时也尚未完成租户改造。

后续一致性修复：回放输入现在拒绝非有限数字、undefined、BigInt、日期对象、循环引用和稀疏数组，限制 JSON 深度与节点数，防止保存/恢复时静默改变值。新增 1 项测试。文件恢复批次全量 quality 860 次 Node 执行通过（0 失败/跳过，含重复专项）；此后 JSON 修复重跑接入专项 69 项和 ESLint 均通过，不将新增专项叠加冒充另一轮全量结果。全量日志为 `output/quality-mock-recovery.log`。文档检查通过；本轮无页面变更，未调用模型、重启在用应用或推送 GitHub。

### 2026-09-19：隔离事件回放测试工具

新增 `scripts/lib/mock-event-replay.mjs`，仅在 `NODE_ENV=test` 可运行，与下文旧运行时独立，未开放 HTTP 写接口，也未改变旧存储键或自动赋予业务权限。

- 每个实例绑定合成租户和项目；业务键由系统、对象类型、编号组成。
- 事件使用正整数 `revision` 表示测试源版本，不按到达时间覆盖；跳号允许，低版本忽略。同一事件编号重投幂等，内容冲突拒绝；同业务键/同版本的冲突也拒绝。
- 删除保留版本墓碑，迟到旧记录不能复活；显式更高版本 upsert 才能恢复。它是全记录更新，不是字段补丁。
- 批次先暂存再提交，后段冲突不会部分更新。上限为 500 个业务键（含墓碑）、1,000 条事件、基线加日志 2 MB；满额报错，不偷偷清掉幂等记录。
- `checkpoint()` 导出基线和事件日志；经过 JSON 往返后重建实例可恢复同一状态。检查点不带签名，不是可信数据或授权来源，不能接受用户文件作为生产恢复依据。
- 快照和导出数据均复制，外部修改不能影响内部状态。事件版本和源记录的版本字段分别由测试案例维护，不自动改写来源证据。

`npm.cmd run test:mock-onboarding` 纳入 7 项回放测试；`npm.cmd run evaluate:mock-lifecycle` 将事件结果接入实际本地 HTTP 连接器与已发布模型的只读引擎。10 项生命周期检查通过，397 次本地连接器请求，覆盖金额更新、重投/迟到、JSON 检查点恢复、删除后旧事件及高版本恢复；源数据变化同步改变查询快照编号。

证据边界：检查点恢复为同一测试进程内的序列化/重建，不是断电、数据库崩溃或跨进程恢复验收。未新增消息队列、自动调度、审批写回或界面事件编辑器；发布回执仍为测试替身，未调用云模型。旧共享运行时的租户改造、持久化事件服务及完整阶段 5–6 仍待开发。

本批回归：全量 `quality` 856 次 Node 测试执行通过，0 失败/跳过（含重复专项）；接入专项 64 项通过，文档检查 156 份 Markdown、816 个本地链接通过。日志为 `output/quality-mock-events.log`。无页面变更，未重跑浏览器，未重启在用服务，未提交或推送 GitHub。

在真实 OA、MES、QMS、LIMS、ERP、OMS 尚未接入前，用与未来 Connector 相同的查询、事件、审批和受控写回边界，演练跨系统业务流程。基础种子数据保持确定性；运行时事件、审批和写回通过统一 Repository 保存。默认使用本地 SQLite，也可通过 `SIMULATION_STORE_DRIVER=postgres` 切换到共享 PostgreSQL，支持多 API 实例一致读取和行锁串行化变更。

## 架构

```text
基础种子数据（每系统约 100 条）
  + 运行时场景事件
          ↓
Mock Connector 契约
  health_check / query / get_by_business_key / event_replay / approved_action
          ↓
系统数据 API 与 Agent 受控证据检索
          ↓
模拟 OA 审批 → QMS/MES/ERP/OMS 的受控模拟写回 → 审计事件
```

场景和 Connector 故障还会触发按业务角色裁剪的运行时模拟告警，分别进入 PC 管理端通知中心，以及移动端、桌面 Web 和 Electron 共用的智脑告警页；重置模拟运行时会一并清除这些告警。

OMS 的约 100 条基础记录现包含门店、订单与履约三类真实形态事件：`StoreStatusChanged` 提供 `storeId/storeName/organizationId/regionCode/operationStatus`，订单与履约记录携带同一 `storeId`。市场角色可按 `STORE-SH-001` 等稳定标识检索；无 OMS 数据域的生产角色不会因输入门店 ID 而自动扩权。

## 支持的场景

| 场景 | 注入事件 | 审批通过后的模拟写回 |
| --- | --- | --- |
| 原料质量异常 | LIMS OOS、QMS 偏差、MES 批次冻结 | QMS CAPA 草稿 |
| 生产设备异常 | MES 非计划停机、QMS 设备偏差 | QMS CAPA 草稿 |
| 供应与库存风险 | ERP 低库存、MES 排产风险、QMS 供应商约束 | QMS CAPA 草稿（后续可扩展 ERP 采购草稿） |
| 订单履约风险 | OMS 配送异常、ERP 替代库存风险、QMS 放行约束 | QMS CAPA 草稿（后续可扩展 OMS 协同任务） |

## API

| 方法 | 路径 | 权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/api/simulation/overview` | 已认证角色 | 查看可见场景、运行时事件和可处理审批 |
| POST | `/api/simulation/scenarios/{id}/run` | `executive` | 启动场景并生成模拟 OA 审批 |
| POST | `/api/simulation/approvals/{id}/decision` | 任务指定角色 | `approved` 或 `rejected` |
| POST | `/api/simulation/connectors/{systemId}/fault` | `executive` | 注入或清除 Connector 故障，Body 为 `{ "faultId": "..." }` |
| POST | `/api/simulation/reset` | `executive` | 清空运行时数据与故障状态，保留基础种子数据 |

## Connector 故障演练与审计回放

模拟运行中心可针对 LIMS、MES、ERP、QMS、OMS 注入以下故障，并将操作与状态变更写入运行时事件流和审计轨迹：

| 故障 | Connector 健康状态 | 检索行为 | 适合验证的流程 |
| --- | --- | --- | --- |
| 正常（`none`） | `healthy` | 正常返回种子数据和场景事件 | 正常闭环 |
| 接口不可用（`connector_outage`） | `unavailable` | Agent 仅收到可用性告警；系统数据接口不返回业务记录 | 降级、人工接管、重试策略 |
| 数据延迟（`data_delay`） | `delayed` | 保留记录，并在 Agent 证据与摘要中标记时效风险 | 延迟容忍度、时效提示 |
| 主数据冲突（`data_conflict`） | `degraded` | 保留记录，并在 Agent 证据与摘要中提示人工复核 | 标识映射、人工复核 |

这使同一业务问题可以在“数据齐备”“数据迟到”“接口不可用”三个条件下回放。智脑不会把故障系统的数据沉默地当作正常证据：它会产出带有 `Mock Connector 健康状态` 来源的受控告警证据，并在面向用户的回答中提示结论需要等待 Connector 恢复或完成数据复核。Agent 运营指标也会同步呈现非健康 Connector 数量。

## 约束与替换路径

- `Mock*Connector` 是未来 `Real*Connector` 的接口前身；业务页面与 Agent 不得直接读取种子文件。
- 所有模拟写回只影响当前 Mock Repository，不调用企业生产系统；需要恢复基线时使用模拟中心重置或 `npm.cmd run reset:runtime -w backend`。
- Agent 会检索运行时事件，因此可直接询问对应批次、订单或生产批的最新模拟状态。
- 管理员可启动/重置场景、注入/清除 Connector 故障；审批仍按场景配置的角色范围控制。
- 生产接入时保持 Connector/Repository 契约不变，用 PostgreSQL、消息队列和 Outbox 替换本地 SQLite，并将模拟 OA 审批替换为 OA/BPM 待办和签名审计。

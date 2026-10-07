# ADR-031：系统接入监控机制——自动挂载、轮询告警与物料补充大模型理解

- 状态：Accepted（2026-10-07）
- 关联：ADR-023（生命周期）、ADR-024（自定义系统登记）、ADR-027（文档材料登记）、ADR-028（连接配置段）、ADR-030（权限独立）
- 触发：用户需求（2026-10-07）——①系统接入成功后自动挂载监控，默认异常断开/连接不成功发邮件给系统管理员，停用/删除的系统不再监控（监控机制 + 轮询查询机制两条逻辑）；②系统接入成功后可继续补充系统物料，物料交给大模型理解，系统接入也应能交给 agent 做。

## 背景

阶段 8-6 已有心跳定时 Worker（单系统心跳巡检、可降级），但**没有系统接入的监控注册表**：接入成功后不会自动进入任何监控清单，连接异常只反映在探测历史里，无邮件告警、无管理员触达；停用/退回/删除的系统也不会从监控中解除（此前根本没有挂载机制）。物料侧，8-5/8-7 打通了登记时的文档解析入库，但**接入成功后无法继续补充物料**，登记物料也没有「交给大模型理解」的出口——理解结果是 agent 引导接入的事实面基础。

## 决策

1. **监控域独立成域**（`domains/system-monitoring/` + `services/system-monitoring-service.js`）：监控是系统接入的新关注点，挂载集合有独立事实源（`system_monitoring_runtime` 按租户隔离）。对外 5 项契约：受信身份绑定的租户上下文、边界声明、监控总览（读取即同步）、单系统控制（pause/resume）、手动触发一轮巡检。
2. **监控机制（挂载逻辑）**：`syncSystemMonitoring` 把挂载集合与接入生命周期对齐——`connected`/`degraded` 自动挂载（接入成功即进入监控，source='auto_sync'）；`suspended`/`registered`/`authorized`/`draft`/定义已删除自动解除（停用或删除的系统不再监控）。幂等，重复调用不产生重复事件；事件日志容量上限 200。
3. **轮询机制**：`runSystemMonitoringCycle` 逐挂载系统探测（复用 system-access 的探测实现，心跳优先、模拟数据源降级，**不复制任何探测逻辑**）；探测三态 `verified`/`failed`/`skipped`（无可读数据集等「不可探测」不参与失败计数，避免演示环境缺数据误报告警）。连续失败 N 次（默认 2，`SYSTEM_MONITOR_ALERT_THRESHOLD`）→ 告警；连续 M 次（默认 3，`SYSTEM_MONITOR_DEGRADE_THRESHOLD`）→ 自动降级 `degraded`（既有状态机规则，不自动断开，需人工裁定——与 ADR-023 人工签字纪律一致）。恢复 `verified` → 连续失败清零 + 站内通知（提示人工裁定接通，不自动升级）。
4. **告警通道复用告警域**：新增分类规则 `system-connection-monitoring`（P1，priority 95，匹配 `SystemConnectionProbeFailed`/`SystemConnectionDegraded`），经 `dispatchAlert` 走既有升级策略——P1 升级链第 1 步 risk_owner 渠道含 email，收件人按事件 ownerUserId（本租户 IAM 在役 executive）解析；同时写元域智语站内通知。告警工作区、联系点、通知记录与审计按 IAM 租户分区，新租户不继承 Demo 联系点；`contactPoints` 通过版本化告警配置显式发布，只接受当前租户 IAM 用户与受控渠道。未配置本租户管理员或联系点时保持待发送，不回退 Demo。邮件当前仍为 Mock 通道送达，真实邮件供应商属后续接入，不在本层伪装。告警不重复：同一失败周期只告警一次，恢复后告警状态复位、新失败周期重新告警。
5. **定时 Worker**：`workers/system-monitoring-worker.js`（`SYSTEM_MONITOR_INTERVAL_MS` 默认 5min），daemon 常驻；生产必须显式给出逗号分隔的 `SYSTEM_MONITOR_TENANT_IDS`，无配置即拒绝启动，逐租户同时绑定 IAM 与语义上下文。每个租户使用运行时仓库中的 Leader 租约（`SYSTEM_MONITOR_LEASE_MS`，缺省为周期的 2 倍），SQLite 依赖 `BEGIN IMMEDIATE` 原子竞争；同一 worker 每轮续租，进程失联后其他 worker 到期接管。单进程内仍保留重叠 tick 跳过。既有 heartbeat-probe-worker 保留可用，同一租户不要同时常驻两套探测机制。
6. **物料补充**（`services/system-material-service.js`）：`supplementSystemMaterials` —— 登记后（registered/authorized/connected/degraded）可追加文档物料与文字说明；文档走 8-5 同一受控解析管线（安全闸门 + 提取文本 + 取证持久化、原文件不落地），提取文本追加进系统记录（schema 发现候选同步可见，`appendSystemDocumentTexts`）；每次最多 8 份、说明 400 字；draft（未登记/已退回）拒绝（409 `SYSTEM_MATERIALS_SUPPLEMENT_STATE_REJECTED`）。
7. **大模型理解**：`getSystemUnderstanding`（GET 读缓存 / POST 重算，重算走 `meta_model.draft.save` 闸门）——登记物料 + 文档提取文本 + 补充说明 + 最近探测状态交给 `generateModelSummary`（local-model-gateway）；Mock 模式为受控确定性摘要（基于登记事实拼接，不编造），真实模型模式为真实理解；提示词要求「只用给出的事实，不足写材料未覆盖」；结果缓存按租户 + 系统码隔离，记录 modelMode/generatedBy/promptCharacters/sourceFacts 可披露。**任何成功的物料补充都会立即删除该系统的理解缓存**，因此不会把补充前摘要伪装为最新事实。
8. **agent 接入的落地基础**：理解结果 + 建议下一步构成 agent 引导接入的事实面（「系统接入交给 agent 来做」的承接点）；**登记提交与接通签字仍保持人工**（ADR-023 纪律，智脑不替人工做签字决策）——agent 可以做的是理解、引导、预填与材料组织，签字决策不代理。
9. **架构边界**：监控路由（`system-monitoring-routes.js`）只依赖领域 public-api，并与 `systems/*` 路由同样用 `runWithSemanticTenant(agentIdentity)` 绑定受信租户上下文；不得依赖开发环境 `currentSemanticTenant()` 的默认 demo 回落。跨域消费（告警域 dispatchAlert、iam-store 管理员解析、站内通知服务）采用动态 import，与 `registerSystemOnboarding` 动态消费 multimodal-input-service 同模式，静态依赖图保持干净；架构基线登记：`system-onboarding` 导出上限 6→8（+物料补充 +系统理解），新增跨域边 `system-monitoring-service.js -> system-access-service.js`（组装依赖，净收敛可登记）。

## 后果

- **接入监控闭环**：接入成功自动挂载 → 轮询探测 → 异常邮件告警系统管理员 + 站内通知 → 连续失败自动降级 → 恢复通知人工裁定；停用/退回/删除自动解除监控。
- **权限**：监控总览读取走 `page.semantic-operations.view`（route-security 前缀统一强制）；写入（pause/resume/手动巡检/理解重算）走 `meta_model.draft.save`，与接入侧同一把闸门。
- **物料链路延伸**：登记后的物料补充与登记同管线同边界（只存提取文本与取证）；大模型理解把登记事实面变成 agent 可消费的知识。
- **运营操作面闭环**：系统接入页提供补充物料、读取/重算系统理解及查看/暂停/恢复监控的受控入口；理解读取与重算分离（GET 缓存、用户显式 POST 重算），暂停状态只由服务端监控注册表返回，浏览器不本地改写。
- **不变式**：状态机跃迁规则不放宽（`connected → draft` 不直达，须经理由签字的中转）；探测实现零复制；告警经既有分类/升级策略不新造投递通道；多租户贯穿（挂载注册表按租户隔离，不接受请求体 tenantId）。
- **边界**：真实邮件供应商（SMTP/webhook 投递）、真实企业连接器、agent 全自动接入（替人工签字）属生产化范围，保留。
- **告警投递失败与租户边界**：探测异常与降级通知先保留 `alertPending`／`degradeAlertPending`，分派成功后才确认；失败下一轮以同一 `alertEventId` 重试，告警域以稳定 riskId 去重。告警工作区和联系点已按 IAM 租户分区，事件携带的 tenantId 与当前 IAM 上下文不一致时整单拒绝；非 Demo 租户配置本租户管理员联系点后可进入默认告警链，未配置则保留待发送且不回退 Demo。属于至少一次投递语义，进程在站内通知成功后、确认状态前崩溃仍可能重复站内通知；真实通道还需供应商回执与生产多节点故障注入。

## 验收

- `backend/test/system-monitoring.test.js`：自动挂载、degraded 仍在监控、停用/退回/删除解除、轮询正例、告警一次不重复、分派失败同 ID 重试、非 Demo 无配置拒绝与有配置投递、逐租户 IAM+语义上下文、单租户 Leader 续租/接管、共享 SQLite 四进程竞争、降级通知失败重试、恢复通知与状态复位、pause/resume、skipped 与种子挂载——`test:access` 全族 **63/63**。
- `backend/test/alerting-orchestration.test.js`：告警工作区和联系点租户隔离、Demo 联系点不继承、租户声明与 IAM 上下文不一致拒绝，以及既有分级/配置/组织权限/HTTP 权限回归——**7/7**。
- `backend/test/system-material-understanding.test.js`：物料补充生命周期门禁、文档受控解析入库、理解生成（Mock 受控摘要）、缓存读、draft 拒绝，以及物料补充后旧理解缓存失效。
- 路由 / SDK / 控制台：`GET /systems/:code/understanding` 验证为只读缓存入口（POST 才重算，其他动作 GET=405）；SDK 端点编码测试、系统接入页静态操作面测试及 Vite 构建均已覆盖。
- 监控路由：以两个不同租户验证 GET 总览、POST pause 与 405 方法拒绝；非 demo 租户只能看到自己的挂载集合，不能回落读取 demo 种子系统。
- 架构基线：导出上限与跨域边登记，architecture-boundaries 测试通过。

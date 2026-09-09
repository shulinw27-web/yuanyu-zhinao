# 当前项目状态

2026-09-09 本体建模最新增量：在关系历史回放基础上，增加跨 ERP/WMS 编号显式映射核验、系统命名空间隔离、对象类型/粒度约束及多重映射冲突识别。教学模型、JSON 导入和中文结果已接入模型校对；不按同名同号自动合并，不迁移或写回企业身份。全量 Node 427/427、Python 契约 4/4 通过；不代表企业编号注册库、全量历史、多轮对话或 ERP 补偿已验收。见 [验收记录](../development/ONTOLOGY_MODELING_ACCEPTANCE.md) 与 [操作指南](../guides/ONTOLOGY_SCENARIO_MODELING.md)。

核对日期：2026-09-08。范围：本地代码、现有测试入口与配置。以下“已有”指开发实现，不等于企业环境通过验收。

2026-09-08 身份适配增量：统一身份源注册、钉钉会话适配、多 OIDC 及明确 subject 绑定已实现，两端 SDK 支持身份源选择和缓存隔离。权限仍由平台 IAM 决定。全量回归 377 项通过（新增适配专项 19 项）；企业微信/飞书专用登录、目录同步及真实企业验收未完成。见 [适配指南](../guides/IDENTITY_PROVIDER_ADAPTERS.md) 与 [回归报告](../development/IDENTITY_PROVIDER_ACCEPTANCE_2026-09-08.md)。

2026-09-08 钉钉增量：新增手机与 PC 共用的 H5 工作台、服务端免登及 IAM 账号映射。已实现来源/企业/设备约束、一次性挑战、绑定撤销校验和不恢复旧员工本地会话。企业应用配置、HTTPS 部署、真实成员及真机免登仍待联调，见 [接入指南](../guides/DINGTALK_INTEGRATION.md) 和 [测试报告](../development/DINGTALK_ACCEPTANCE_2026-09-08.md)。

两端详细功能及使用限制见 [智脑能力范围](ZHINAO_CAPABILITY_SCOPE.md) 和 [语义运营能力范围](SEMANTIC_OPERATIONS_CAPABILITY_SCOPE.md)。

2026-09-07 多模态最新增量：修复表格行列关联、Word 字段拼接、扫描/混合 PDF、受控视觉观察、原图出网检查、截断与记忆提示、PK/FK 候选校验及币种字面值问题。真实模型文件与追问 40/40、边界 8/8、候选生成 2/2 通过，浏览器另核对 4 次回复。正式 API 仍保留默认原图出网限制，生产扫描服务与审批未完成。详情见 [多模态报告](../development/AGENT_MULTIMODAL_ACCEPTANCE_2026-09-07.md) 和 [使用指南](../guides/AGENT_MULTIMODAL_GUIDE.md)。以下是更早的会话专项及阶段记录，不覆盖这次新增结果。

**最新增量：双端智能与上下文修复已落地，核心真实方舟用例 12/12、完整自动回归 326/326 通过。** 修复统一会话理解、编号追问、事实更正、否定约束、材料续问、字典候选抽取、真实状态展示，以及库存报告旧模板污染和“不生成文件”误出确认卡。运行中的本机 API 已更新。详细复测和限制见 [修复与验收记录](../development/AGENT_INTELLIGENCE_REPAIR_2026-09-07.md)，操作见 [对话及上下文指南](../guides/AGENT_DIALOGUE_AND_CONTEXT.md)。

这不是整个项目生产验收完成：自然语言候选缺少来源/类型/映射时仍必须人工校对，企业接口仍为 Mock；图片已补充合成专项，语音仍未验收。[修复前失败报告](../development/AGENT_INTELLIGENCE_ACCEPTANCE_2026-09-07.md)保留作为历史证据；以下早期增量数字不是最新结果。

最近增量：编号/事件/版本查询、绑定目标的 Demo 质量调查草稿、结构化记忆，以及带来源覆盖声明的历史查询、受控样本映射后端入口。全量回归 298 项通过；具体范围、测试证据和未完成项见 [持续改进记录](../development/AGENT_RUNTIME_IMPROVEMENT_2026-09-06.md)。样本入口没有替代运营端的 Mock 演练，也不证明真实系统已接入。

模型接入最新增量：已增加火山方舟专用网关、两端模型来源展示及专用启动/预检入口；用户已保存项目外的私有配置，Doubao-Seed-2.1-pro 真实连通预检通过。真实模拟业务评测 5/7 通过，仍有普通对话请求回退和脱敏后目标编号显示问题；未完成运行实例切换或完整模型验收。本轮方舟专项 12/12、安全回归 48/48、Lint 通过；此前全量回归为 306 项通过，本轮未重跑全量，见 [方舟接入与测试](../development/ARK_MODEL_INTEGRATION.md)。本地模型文件保留。

## 已有的开发基线

对话体验最新修复：普通业务报告先澄清范围；解释型追问携带权限过滤后的本轮会话历史，不将模型旧回复作为工具授权。方舟瞬时连接失败最多重试一次，对话失败状态不再显示完成。全量回归 **314/314 通过**；真实方舟报告/追问专项 **3/3 通过**。已更新本机 API，详见 [本轮联调记录](../development/ARK_MODEL_INTEGRATION.md)。此前 7 项业务评测没有在本轮重跑，不能以这 3 项代替完整验收。

| 能力 | 当前范围 | 查看依据 |
| --- | --- | --- |
| 多端工作台 | 管理 Web、智脑 Web/Electron、移动端及独立语义运营 Web/Electron | [客户端矩阵](../development/CLIENT_COMPATIBILITY_MATRIX.md) |
| 对话与任务 | 意图路由、多任务会话、上下文压缩、可撤销记忆、确认和长任务队列 | [Agent 架构](../architecture/ZHINAO_AGENT_ARCHITECTURE_V2.md)、[长任务运行时](../operations/AGENT_LONG_TASK_RUNTIME.md) |
| 权限与执行 | 身份、角色、组织数据域、设备绑定、一次性确认、审计与回执 | [IAM](../architecture/IAM_PERMISSION_CENTER.md)、[证据链](../architecture/AGENT_EVIDENCE_TRACE.md) |
| 语义层建设 | 自然语言/附件输入、候选对象关系、人工可视化校对、草稿与发布治理 | [语义建模](../architecture/SEMANTIC_MODEL_AUTHORING.md)、[运营指南](../guides/元域智脑-语义运营Agent操作指南-v1.0.md) |
| 模拟系统 | 状态化连接器、事件、采购/质量/审批演练及 Semantica 验证路径 | [Mock 运行时](../development/MOCK_SIMULATION_RUNTIME.md)、[Semantica 评估](../development/SEMANTICA_MOCK_EVALUATION.md) |
| 本机日常工作 | Electron 受控新建文件、打开 HTTPS、读取工作区文本和写剪贴板 | [桌面工具边界](../guides/DESKTOP_WORKBENCH_EXECUTION.md) |
| 学习治理 | 授权后收集最小化信号、版本与撤销治理；并非自动微调模型 | [学习治理](../architecture/ZHINAO_LEARNING_GOVERNANCE.md) |
| 运行基础 | SQLite 单机持久化、PostgreSQL 适配与迁移工具、Outbox/Worker、观测及安全检查 | [持久化](../operations/RUNTIME_PERSISTENCE.md)、[运行配置](../modules/11-runtime-platform/CONFIGURATION.md) |

## 尚不能当作完成的事情

- 真正接入企业 OA/ERP/WMS/MES/LIMS/QMS/OMS，仍需要网络、沙箱、字典、凭据引用和接口契约；演练数据不能作为生产业务事实。
- 本地模型需要独立启动并与精确模型白名单匹配。Mock 回答或降级回答不证明模型已连通。
- 附件输入不代表任意图像、语音、文档都已完整理解；OCR、内容安全和模型多模态能力按适配器与配置验收。
- Semantica 服务、依赖及图导入状态需要单独验证；界面仍能展示语义投影，不等于独立图服务已经工作。
- 桌面工具不是全功能电脑控制。目前文件目标支持桌面、文档、下载中的受控工作区，不支持任意路径或任意应用操作。
- 真实 IdP、MFA、KMS、数据库集群、消息系统、SIEM/WORM、签名与终端管理，以及性能、安全、灾备和 UAT，仍有外部环境验收要求。

完整待办保留在 [生产 Checklist](../operations/PRODUCTION_TODO_CHECKLIST.md)，不在各文档复制一份勾选清单。旧文档中的测试数量和“已完成”结论只适用于其记录日期。

## 开发优先级

先取得 [真实联调准备材料](../development/DEVELOPMENT_READINESS.md)，选择一个只读业务链打通“系统数据 → 语义模型 → 授权查询 → 证据回答”，再逐步接入受控写入。具体阶段与验收输出见 [开发路线](../development/DEVELOPMENT_ROADMAP.md)。

本次整理的验证结果在 [整理记录](REPOSITORY_CLEANUP.md) 单独记录；未重新执行的企业级测试不计入此次结果。

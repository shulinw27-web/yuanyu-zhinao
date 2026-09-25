# 制造案例语义建模修复与回归记录

日期：2026-09-10。对应 [首次评测](SEMANTIC_MANUFACTURING_EVALUATION.md) 的 SM-01–SM-10。本次完成清单中的代码修复和回归；“完成”限定为材料保真、持续建模、候选资产与验收提示，不代表任意企业的自动建模或生产执行已经验收。

## 1. 结果

| 检查项 | 修复前 | 修复后 |
| --- | --- | --- |
| 综合 API：对象 / 主键 / 来源 / 粒度 | 13 / 13 / 1 / 0 正确 | 全部 13 / 13 |
| 综合 API：类型关系 | 0 / 17 | 17 / 17 |
| 字典：来源与粒度 | 1 / 13、0 / 13 | 均为 13 / 13 |
| 不重传，沿用历史材料建模 | 历史摘录截断，无法建模 | 保留完整材料引用，13 对象、17 关系 |
| 分两批上传六个系统 | 只剩第二批 5 对象 | 13 对象、17 关系完整合并 |
| 同名对象冲突 | 随上传顺序覆盖，无提示 | 两种顺序均报告冲突、Critic 失败，禁止采纳 |
| 真实 Semantica 实例图 | API/字典候选仅绑定 1 / 19 记录 | 各完整候选绑定 19 / 19，形成 26 条实例边 |
| 用户上传样本 | 没有进入提案映射校验 | 19 条唯一样本通过，跳过 1 次完全相同的投递 |

17 是类型级关系数，26 是该样本集产生的实例边数。Semantica 运行在独立测试进程，未把人工参考模型冒充 Agent 结果，也未发布或调用企业接口。

## 2. 清单关闭依据

| 编号 | 状态 | 实际修复 |
| --- | --- | --- |
| SM-01 | 已修复 | 逐对象读取 `system` / `sourceSystem` / `x-source-system`。仅在缺少声明且提示唯一时才使用文件名或请求中的系统；不明确则保持 UNASSIGNED 并阻断 |
| SM-02 | 已修复 | 支持标量 `x-foreign-key: {schema, field}` 和字典 `reference` / `referenceField`，保留源/目标字段；描述提到外键却没有结构化声明时明确要求补齐，不默默当作无关系 |
| SM-03 | 已修复 | 保留显式粒度、计量单位和枚举；导入的业务对象默认保持独立锚点，Supplier 不再被猜成 Person |
| SM-04 | 已修复 | 建模从同一任务的全部材料版本重新生成候选，不再只看最新附件；重复结构合并，不隐式删除旧对象 |
| SM-05 | 已修复 | 扫描、脱敏后的文本通过持久存储端口保存为材料引用，按身份与原始角色隔离；12k 聊天摘录不再是结构解析的唯一来源 |
| SM-06 | 已修复 | 区分完整提取与模型上下文截断。结构化解析不受 24k 模型预算影响；明确的结构建模请求用结构索引识别意图，完整结构仍由服务器处理 |
| SM-07 | 已修复 | 检查同名对象的来源、主键、粒度、字段类型、必填、引用、单位与枚举冲突。未解决冲突不能采纳；可更正材料后新建明确版本任务 |
| SM-08 | 已修复 | Critic 增加输入材料保真和关系覆盖检查；导入模型缺少匹配样本时不算完成映射；上传样本在创建、修订、采纳时重新按身份验证。界面分别展示结构、样本、需求评审范围；Semantica 的校验明确标为结构级 |
| SM-09 | 已修复（候选资产层） | 原文需求编译为 `worldModel`：指标候选、单位约束、状态约束/枚举候选、时间策略、身份约束与动作边界。保留原文、关联对象/字段、待评审状态，纳入提案修订、草稿、指纹与桥接；不将自然语言直接变成可执行代码 |
| SM-10 | 已修复（已测口径） | 意图理解收到从完整材料提取的权威粒度；增加单对象显式粒度矛盾检测及受限修复重试。真实 T1 正确把 ReceiptLine 列为 transaction，不再列为 event |

对 SM-09 的边界：文本中只写“审批不是执行”并不能据此猜测全部状态初态、终态和转换。没有明确证据的状态转换保持待评审；执行规则仍需在治理页绑定已注册能力并完成案例回放。此处关闭的是“需求完全丢失、提案只剩表和边”的缺陷，不是宣称自动产生完整可执行业务系统。

## 3. 回归证据

- 全量 Node 测试：438 / 438 通过，其中新增制造案例回归 11 项，已纳入 `npm run test:semantic` 和 `npm run test:all`。
- Python 模型契约：5 / 5 通过。
- Lint、TypeScript 类型检查、元域智营端生产构建通过。
- 真实方舟：T1–T9 的目标路径均取得有效结果；最后一轮 T6 首次触及约 30 秒理解超时，独立重试成功，记录没有删除。其余 8 个任务均由 Ark 理解并进入相应对话/候选路径。
- T2 金额 10,000 CNY、收货 1,000 kg、账面 880 kg、可用 400 kg、缺口 100 kg 均正确；T3 识别“已审批不等于已执行”和“只有另一批次的实际领料证据”。不据此给模型任意场景的准确率承诺。
- 真实 Semantica：T4、T5、T6 重试、T8、T9 的候选均绑定 19 条记录 / 26 条实例边。人工参考对照独立保留。

最后一轮主测试 T1–T8 共 157.710 秒，其中包含 T6 超时；T9 13.256 秒；精简结构化意图输入后的 T6 重试 25.696 秒。它们是单次本机网络与模型服务下的观测，不是稳定 SLA，也不能保证低于 30 秒。外部模型失败仍如实返回失败，不伪装完成。

全量回归第一次曾出现旧 `agent-targeted-query` HTTP 用例的 0 次调用断言失败；单文件重跑 32 / 32、随后全量复跑均通过。没有删除该用例或降低断言；保留初次日志，暂不能断言偶发原因已定位。

原始证据保存在本机忽略目录：

- `output/semantic-manufacturing/`：修复前结果，不覆盖。
- `output/semantic-manufacturing-fixed/`：本次 T1–T9、T6 独立重试、冲突诊断、Semantica 图结果。
- `output/semantic-manufacturing-all-tests.log`：首次全量失败记录。
- `output/semantic-manufacturing-all-tests-final.log`：最终全量测试。
- `output/semantic-manufacturing-python-tests.log`、`output/semantic-manufacturing-build.log`：Python 和构建记录。

自动测试在隔离存储内另验证采纳、草稿保留和身份拒绝；真实模型评测没有采纳/发布。上传样本测试使用隔离进程中已有的 Demo IAM 身份，而不是把附件自报 tenant/role 当授权。无组织权限的身份会被拒绝。

## 4. 复跑

```powershell
npm run test:semantic
npm run test:all
npm run lint
npm run typecheck
npm run build:semantic-ops
.\.venv-semantica\Scripts\python.exe -X utf8 services/semantic-context/test_model_definition.py
node scripts/evaluate-semantic-manufacturing.mjs
node scripts/evaluate-semantic-manufacturing.mjs --dictionary-only
node scripts/evaluate-semantic-manufacturing.mjs --combined-only
node scripts/evaluate-semantic-material-order.mjs
.\.venv-semantica\Scripts\python.exe -X utf8 services/semantic-context/evaluate_manufacturing_case.py
```

真实模型命令读取项目外现有方舟配置并消耗推理额度，不在仓库保存密钥。模拟材料操作方式与限制见 [快速建模指南](../guides/SEMANTIC_MATERIAL_WORKSPACE.md)。

未覆盖：真实 ERP/WMS 权限与分页联调、完整企业数据、浏览器视觉/Electron 交互回归、任意非结构化大文档自动抽取、模型权重训练。本次没有重启用户正在运行的服务，也没有提交或推送 GitHub；运行实例需重启后载入新代码。

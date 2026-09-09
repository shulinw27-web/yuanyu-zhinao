# 六项本地可开发能力完成说明

> 历史阶段记录：保留验收与演进依据，不作为当前完成度或操作入口。当前状态见 [项目状态](../../overview/PROJECT_STATUS.md)。

## 完成范围

| 能力 | 已落地内容 | 安全边界 |
| --- | --- | --- |
| 运行状态生产化 | 状态化模拟、语义治理和 Agent 编排均支持独立 PostgreSQL 驱动、就绪探针和并发回归 | 通用 Runtime Store 仍保留 SQLite 单节点基线；真实数据迁移需单独演练 |
| 受控 Computer Use | 可创建 MD/TXT/CSV/DOCX/XLSX、打开 HTTPS、读取专属工作区文本、写入剪贴板 | 全部本人确认；路径/协议/大小/链接严格允许列表；禁止删除、任意目录和外部发送 |
| 模拟与语义治理 | Mock Connector 状态可共享；语义草稿、提案、任务、Diff、Schema Critic、映射演练、快照、回滚、Semantica 发布形成闭环 | 语义发布不替代授权；生产发布 Outbox 必须与 PostgreSQL 事务同源 |
| 长期学习 | 自愿开启、成功回执采样、3 次可信阈值、用户正负反馈、推荐抑制、撤销和 PostgreSQL 一致性 | 不保存原始提问/企业载荷；不训练模型权重；推荐不能绕过权限和确认 |
| 多模态理解 | 支持图片/PDF/DOCX/XLSX/JSON/YAML/CSV；Office XML 有界提取、格式与总量校验、提示注入隔离 | 图片/PDF 正式识别仍需企业 OCR、恶意文件扫描与 DLP |
| 任务编排 | 单次/周期调度、DAG 校验、数据库租约、检查点、独立 Worker、只读/分析自动执行、Evidence Trace 引用 | 不持久化原始结果；提案固定等待人工确认；无自动业务写入 |

## 验证命令

```powershell
npm.cmd run test:desktop
npm.cmd run test:learning
npm.cmd run test:semantic
npm.cmd run test:orchestration
npm.cmd run test:persistence
npm.cmd run quality
```

## 生产集成边界

本说明中的“完成”指仓库内能够独立开发、运行和自动回归的能力完成，不表示外部企业环境已经联调。真实 OA/ERP/WMS/QMS/MES、企业 OCR/DLP、生产 Semantica 图存储、Vault/KMS、企业 IdP、PostgreSQL 高可用和模型训练审批管线仍需对应系统、账号、网络、证书、脱敏样本和验收环境。

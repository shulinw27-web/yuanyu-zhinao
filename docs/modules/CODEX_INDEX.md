# Codex 模块上下文索引

给 Codex 分配开发任务时，先提供本文件，再提供目标模块的 `CODEX_CONTEXT.md`。只有跨模块变更才加载多个模块上下文，避免把整个仓库无差别塞入上下文。

涉及生产化、上线验收、投产切换或投产后运营时，同时读取 [生产化与投产后待办 Checklist](../operations/PRODUCTION_TODO_CHECKLIST.md)，并在完成事项后补充验收证据链接；不得仅修改勾选状态。

## 通用提示模板

```text
你正在修改 demo-platform 的 <模块名>。
先阅读 docs/modules/<模块>/CODEX_CONTEXT.md、REQUIREMENTS.md、API.md、ARCHITECTURE.md。
遵守 docs/modules/API_STANDARDS.md 与 OWNERSHIP_MATRIX.md。
只修改该模块拥有的文件；若必须改变跨模块契约，先列出契约变化和兼容方案。
完成后运行模块文档指定的测试，并同步更新四份模块文档。
```

## 上下文入口

| 任务关键词 | 首先读取 |
| --- | --- |
| 登录、账号、组织、角色、按钮、数据权限 | [01](01-identity-access/CODEX_CONTEXT.md) |
| 智脑消息、任务窗口、上下文、模型、工具、确认执行 | [02](02-agent-runtime/CODEX_CONTEXT.md) |
| trace、证据、哈希、审计、安全事件 | [03](03-evidence-audit/CODEX_CONTEXT.md) |
| P0/P1/P2、通知、值班、虚拟电话 | [04](04-alerting-oncall/CODEX_CONTEXT.md) |
| 风险、驾驶舱、风险确认/审批 | [05](05-risk-operations/CODEX_CONTEXT.md) |
| 采购、ERP 草稿、采购审批 | [06](06-procurement-workflow/CODEX_CONTEXT.md) |
| 元模型、世界模型、语义、企业知识 | [07](07-model-semantic-governance/CODEX_CONTEXT.md) |
| OA/MES/QMS/OMS、Connector、Mock 场景 | [08](08-integration-simulation/CODEX_CONTEXT.md) |
| KMS、租约、轮换、吊销 | [09](09-key-credential/CODEX_CONTEXT.md) |
| 元域智营、Electron、移动端、Workbench、SDK | [10](10-client-platform/CODEX_CONTEXT.md) |
| HTTP、Repository、SQLite、配置、部署、测试 | [11](11-runtime-platform/CODEX_CONTEXT.md) |

## 全局不可破坏约束

1. 生产环境不得信任 Demo role header 或 Demo 密码。
2. 身份、租户、主体、会话、设备、角色、组织数据域必须由服务端判定。
3. Agent 模型输出不能直接成为业务执行；写操作必须绑定原 run 和一次性确认。
4. 历史上下文、证据和 run 不得跨 `tenant + subject` 泄露；权限撤销后旧上下文不得继续参与推理。
5. 前端隐藏按钮不是授权；所有写 API 必须有后端按钮和业务门禁。
6. 密钥材料不能进入浏览器、模型提示、日志、证据或普通业务存储。
7. 修改旧请求体或响应字段时先维持向后兼容，再分版本移除。

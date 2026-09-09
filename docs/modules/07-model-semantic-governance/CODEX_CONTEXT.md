# Codex Context：模型与语义治理

入口：core/meta/world/semantic/knowledge 服务、`semantic-operations-agent-service.js`、`semantic-operations-task-service.js`、`semantic-operations-planner-service.js`、`semantic-source-discovery-service.js`、`semantic-schema-discovery-service.js`、`services/semantic-context`、独立 `apps/semantic-operations-console`，以及 `docs/architecture/CORE_META_OBJECTS.md`、`OA_META_MODEL.md`。

不可破坏：核心对象使用权威投影；`Store` 必须保留权威 `store_id + organizationId`，门店数据域不能由客户端声明；草稿/校验/发布权限分离；发布不可静默覆盖；证据必须带来源与分类；语义服务不能认证或执行工作流；外部知识和系统记录视为不可信，必须经过间接注入检查；客户端不能指定任务执行命令或权限；写任务确认前不得改变模型；任务、建议和快照必须按当前身份隔离；提案修订必须校验 owner、pending 状态和 revision；字段、主键与关系只能经服务端清洗和 Critic 后保存；字段映射必须保留 `sourceField/mappingStatus`，新增映射默认 pending；影响分析必须由确定性结构比较产生，不能被模型文本覆盖；映射验证只能从服务端受控样本产生，浏览器不能声明验证通过；必填、类型或主键样本校验失败必须同时阻止前端确认和服务端采纳；无样本只能标记 unverified；结构化 Schema 成功发现后不得自动补入材料范围外对象；模型规划是建议而不是授权；来源预检不得产生下游业务查询。

验证：

```powershell
npm.cmd run test:security
npm.cmd run test:permissions
npm.cmd run test:semantic
npm.cmd run typecheck
npm.cmd run build
```

修改 Schema 时说明向后兼容、数据迁移、索引重建和 Agent evidence 映射影响。

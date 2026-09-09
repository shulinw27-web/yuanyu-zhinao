# Codex Context：采购协同

入口：`routes/procurement-routes.js`、`procurement-service.js`、`agent-tool-registry.js`、`ProcurementActionPage.vue`、核心元对象和 key-center 服务。

不可破坏：发起与审批权限分离；模型不能直接批准；核心对象校验必须使用 authoritative projection；租约限制 connector/operation/task/TTL；Mock 明确标记；失败不能返回执行成功；写操作需幂等和证据回执。

验证：

```powershell
npm.cmd run test:security
npm.cmd run test:permissions
npm.cmd run build -w frontend
```

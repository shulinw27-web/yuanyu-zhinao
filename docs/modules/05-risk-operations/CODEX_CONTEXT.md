# Codex Context：风险运营

入口：`domains/risk/public-api.js`、`routes/risk-routes.js`、`services/risk-service.js`、`authorization-service.js`、`features/risk`、`RiskDrawer.vue`。

不可破坏：查询先按组织过滤；详情同时检查按钮权限；确认/审批前检查资源可见；多角色选择真实动作角色；写后重新按请求主体读取和脱敏；不可见返回 404 以减少枚举。

验证：

```powershell
npm.cmd run test:permissions
npm.cmd run test:alerting
npm.cmd run build -w frontend
```

新增字段时标明数据分类、来源系统和组织 owner，并同步 Agent evidence 映射。

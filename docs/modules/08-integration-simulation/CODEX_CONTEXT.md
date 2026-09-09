# Codex Context：系统接入与模拟

入口：`domains/simulation/public-api.js`、`routes/simulation-routes.js`、system/mock/MCP 服务、`data/system-event-records.js`、`docs/development/MOCK_SIMULATION_RUNTIME.md`。

不可破坏：Mock 与生产明确隔离；故障必须可见；记录携带租户/组织/分类；数据域在查询层执行；非管理员不能运行/故障/重置；审批不能由任意角色处理；连接器不接收明文长期密钥；所有写回幂等并有 receipt。

验证：

```powershell
npm.cmd run test:security
npm.cmd run test:permissions
npm.cmd run test:persistence
```

新增系统时同时更新 connector catalog、数据 Schema、组织映射、权限矩阵、Mock fixture、故障用例和 API 文档。

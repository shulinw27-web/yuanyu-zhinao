# Codex Context：证据与审计

重点文件：`domains/agent/public-api.js`、`routes/evidence-routes.js`、`agent-evidence-trace-service.js`、`agent-security-audit-service.js`、`agent-runtime-store.js` 和 `backend/test/evidence-trace.test.js`。

不可破坏：事件序号单调、previous hash 正确、manifest 与 tenant/subject/role 绑定、读取实时校验、拒绝事件不保存攻击原文、跨主体不可见。不要把哈希链描述为外部不可抵赖，除非已实现 WORM/外部锚定。

验证：

```powershell
npm.cmd run test:evidence
npm.cmd run test:security
npm.cmd run test:persistence
```

新增 Agent 阶段或业务写工具时，必须增加对应 evidence event 和成功/失败测试。

# Codex Context：告警与值班

入口：`backend/src/domains/alerting/**`、`routes/alerting-routes.js`、`data/alerting-seed.js`、`backend/test/alerting-orchestration.test.js`。

不可破坏：P0/P1/P2 确定性；P0 才默认立即电话；DTMF 不等于业务审批；配置乐观锁；组织范围过滤；Provider 结果必须记录真实状态；测试电话不能污染生产告警。

验证：

```powershell
npm.cmd run test:alerting
npm.cmd run test:permissions
```

新增 Provider 时实现统一接口、超时、重试分类、回执验签和脱敏日志，不把电话号码或密钥发送给模型。

# Codex Context：密钥与凭据

入口：`services/key-center/**`、`services/key-center/app.js`、`mcp-connector-service.js`、采购/Agent 工具中的 lease 调用。

不可破坏：永不返回密钥明文；lease 绑定 connector、operation、task、角色/服务主体和 TTL；过期/吊销立即拒绝；生产 KMS 不可用时 fail-closed；日志和测试 fixture 不包含真实 secret。

验证：

```powershell
npm.cmd run test:security
npm.cmd run test:permissions
```

修改 policy 字段时检查所有 Connector 调用方，并更新 `docs/architecture/KEY_CENTER_MICROSERVICE.md`。

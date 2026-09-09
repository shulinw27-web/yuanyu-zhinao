# 证据与审计技术架构

## 当前代码

`agent-evidence-trace-service.js` 管理 Trace 与哈希链，`agent-security-audit-service.js` 管理安全遥测；状态通过 `runtime-state-repository.js` 持久化。Agent 运行时在各阶段显式写事件。

## 数据所有权

本模块拥有 Trace、TraceEvent、TraceManifest、SecurityAuditEvent、ExecutionReceiptReference。它只保存证据快照和业务引用，不成为风险、采购或 IAM 的事实主库。

## 目标设计

```text
领域模块 → Audit Port → 脱敏/规范化 → Append-only Store
                         → Hash Chain → Daily Merkle/Signature Anchor
读取者 → IAM/Data Scope → Query Projection → Integrity Verify
```

目标结构分为 event ingestion、redaction policy、integrity service、query/export 和 WORM adapter。业务事务通过 Outbox 发布审计事件，避免业务成功但审计丢失。

## 边界

- hash 只证明本存储内的顺序和内容一致性；没有外部锚定前不能宣称不可抵赖。
- 审计失败对高风险写操作应 fail-closed；低风险只读可按策略降级并告警。
- details 使用 allowlist Schema，不接受任意对象或原始 prompt。

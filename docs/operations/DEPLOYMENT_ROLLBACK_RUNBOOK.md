# 元域智脑部署、回滚与故障处置手册

> 版本：v1.0　更新日期：2026-09-01

## 1. 发布前检查

- 冻结应用、数据库 Schema、API 契约、模型、连接器和最低客户端版本。
- `npm ci && npm run quality && npm run security:gate && npm run migrate:verify` 全部通过。
- 生产镜像完成 SCA、Secret、镜像和 IaC 扫描，无未接受的高危或严重问题。
- 已完成数据库全量备份、恢复抽测，并记录当前应用镜像 digest 与 migration version。
- `NODE_ENV=production`；Mock 身份、Role Header、Mock Connector、Demo KMS 均关闭。
- IdP、Key Center、PostgreSQL、Redis、Broker、SIEM、内容安全和源系统沙箱连通性通过。
- 明确停止写入、回滚和人工接管入口；回滚不依赖现场临时编写命令。

## 2. 构建与启动

```powershell
npm ci
npm run quality
npm run security:gate
npm run migrate:verify
docker build --pull -f deploy/Dockerfile.api -t agent-platform-api:<version> .
```

容器必须以非 root、只读根文件系统运行；SQLite 数据目录、日志和临时目录不能打进镜像。生产配置从 Secret Manager/KMS 与受控 ConfigMap 注入。

数据库升级：

```powershell
npm run migrate:verify
npm run migrate:postgres
```

部署顺序：PostgreSQL/Redis/Broker → Key Center/Semantic Context → API/Worker → Web/Desktop/Mobile。每一层 readiness 通过后再进入下一层。

## 3. 发布验证

1. `/api/health/live` 仅验证进程存活；`/api/health/ready` 必须反映强依赖失败。
2. 使用普通用户、业务负责人、元域智营员、管理员和审计员验证登录、权限、撤权及租户隔离。
3. 验证只读查询、来源引用、附件拦截、模型限额和连接器熔断。
4. 验证写操作先形成草稿/审批，未授权不得发起，计划不得显示为完成。
5. 检查 Evidence Trace、审计哈希链、SIEM 脱敏事件、Outbox 与 Worker 检查点。
6. 首个真实写流程执行后，按业务编号与源系统逐项对账。

## 4. 回滚触发条件

出现以下任一情况应停止受影响写能力并评估回滚：身份或租户隔离失效；错误审批或重复写入；高危数据泄露；数据库不可恢复错误；P95/P99 或错误率持续超过发布阈值；审计链/SIEM 缺失；连接器回执与源系统不一致；模型或客户端版本门禁失效。

## 5. 应用回滚

1. 暂停入口写能力和相关 Worker，保留审计、Outbox、回执和队列现场。
2. 将 Gateway 流量切回上一已验收镜像 digest，不重新构建“同版本”镜像。
3. 验证上一版本支持当前数据库 Schema；兼容时只回滚应用，不回滚数据。
4. 恢复消费者前检查幂等键、检查点和死信，避免重复写入。
5. 恢复只读流量，再逐项开放写能力并完成对账。

## 6. 数据库回滚

数据库回滚只允许按一个 migration 版本执行，且必须已停止写入、完成备份和影响评审。当前仓库提供 v4→v3 的有界回滚脚本：

```powershell
npm run rollback:postgres -w backend -- --target 3
```

如果新版本已经写入无法由旧 Schema 表达的数据，应采用向前修复或从恢复点建立新实例，不得直接删除列/表。执行后必须校验版本、约束、索引、租户策略、关键行数和业务对账。

## 7. 常见故障处置

| 故障 | 立即动作 | 恢复条件 |
|---|---|---|
| PostgreSQL 不可用 | readiness 下线实例，暂停写 Worker | 主库、连接池、迁移版本和事务验证通过 |
| Redis 不可用 | 限制登录/限流依赖能力，禁止进程内降级突破全局策略 | 集群副本和数据一致性通过 |
| Broker 积压/中断 | 保留 Outbox，暂停非关键发布，不跳过检查点 | 消费者幂等、积压下降和死信可观测 |
| Key Center/KMS 不可用 | 失败关闭所有需凭据的工具 | 工作负载身份、租约和审计恢复 |
| 模型超时/限额 | 熔断该版本，降级到已批准模型或人工接管 | 白名单、质量和预算门禁重新验证 |
| Connector 断网 | 打开熔断，禁止把超时写成成功 | 探测成功、幂等和源系统对账通过 |
| SIEM/审计不可用 | 暂停高风险写动作并本地保全证据 | 导出链路、哈希完整性和积压恢复 |
| 多模态扫描不可用 | `required` 模式失败关闭上传 | AV/DLP/沙箱/OCR 全链路健康 |
| 大量 HTTP 426 | 核对版本策略和发布范围，不临时关闭门禁 | 受支持客户端已发布且升级路径可用 |

## 8. 事故证据

保留时间线、配置版本、镜像 digest、migration checksum、Evidence Trace、审计导出、SIEM 事件、Outbox、Worker 检查点、连接器请求摘要及源系统回执。任何补偿脚本先备份、评审并在合成数据上验证，执行前后均需对账。

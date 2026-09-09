# 元域智脑非功能测试指南

> 版本：v1.1　更新日期：2026-09-06

## 1. 自动化入口

```powershell
npm run test:nonfunctional
npm run nonfunctional:load
npm run nonfunctional:soak
```

`test:nonfunctional` 校验压测/稳定性工具的统计和阈值契约；`nonfunctional:load` 对已启动 API 做短时负载；`nonfunctional:soak` 默认持续 72 小时。工具存在或单元测试通过不等于生产容量与 72 小时稳定性已经验收。

## 2. 负载测试

常用环境变量：

| 参数 | 含义 | 默认值 |
|---|---|---:|
| `LOAD_BASE_URL` | API 地址 | `http://127.0.0.1:3001` |
| `LOAD_CONCURRENCY` | 并发数 | 10 |
| `LOAD_REQUESTS` | 请求总数 | 200 |
| `LOAD_P95_MAX_MS` | P95 上限 | 500 ms |
| `LOAD_ERROR_RATE_MAX` | 最大错误率 | 0.01 |

报告包含吞吐量、错误率、P50/P95/P99。生产压测需要覆盖登录、长会话、语义检索、附件元数据、模型限流、事件批次和连接器沙箱；写接口必须使用隔离测试租户和可回滚数据。

## 3. 72 小时稳定性

当前脚本只采样 readiness 的 HTTP 状态、延迟、采样可用率以及压测客户端的堆内存。它不采集服务端内存、liveness、连接池或文件句柄。报告 `http-soak.v2` 明确返回 `memoryScope=load_generator_process_only` 和 `serverMemory.status=not_measured`；不得把 `clientHeapGrowthMb` 写成服务端内存。

`SOAK_TEST_DURATION_MS` 默认 72 小时；`SOAK_TEST_INTERVAL_MS` 默认 30 秒；`SOAK_TEST_REQUEST_TIMEOUT_MS` 默认 5 秒；`SOAK_TEST_MAX_CLIENT_HEAP_GROWTH_MB` 默认 256 MB。旧变量 `SOAK_TEST_MAX_HEAP_GROWTH_MB` 只作为客户端阈值的兼容别名。每次请求都有超时，临近采样结束且不足一个完整请求预算时不再发起新请求。汇总统计所有采样，仅保留最近 1,000 条明细，避免多日测试工具自身无限占用内存。

完整稳定性验收仍需要部署服务端指标采集。运行前设置隔离环境、告警联系人、容量阈值和数据清理策略。通过标准至少包括：

- 连续运行不少于 72 小时，无不可恢复崩溃。
- 可用率、P95/P99、错误率满足项目 SLO。
- 堆内存、连接池、文件句柄和线程数无持续单向增长。
- Outbox、Broker、死信、审计与 SIEM 积压能恢复到基线。
- 模型和连接器熔断可自动恢复，不产生重复业务写入。

## 4. 故障与混沌矩阵

| 注入故障 | 必验行为 |
|---|---|
| PostgreSQL 主库断开/只读 | readiness 失败、事务回滚、无跨租户或半提交 |
| Redis 集群故障 | 不得绕过全局限流/撤权；高风险能力失败关闭 |
| Broker 中断/乱序/重复 | Outbox 保留、消费者幂等、检查点可恢复 |
| 模型超时/429/内容拦截 | 熔断、受批准降级或人工接管，状态不伪造 |
| KMS/Key Center 超时 | 不泄露缓存凭据，所有需密钥工具失败关闭 |
| Connector 断网/重复回执 | 舱壁和熔断生效，外部编号幂等并可对账 |
| SIEM/WORM 不可用 | 高风险写操作暂停，证据不丢失 |
| 内容安全/OCR 不可用 | 生产 `required` 模式拒绝上传 |

## 5. 安全与客户端专项

- 运行认证绕过、IDOR、租户逃逸、注入、SSRF、恶意文件和供应链渗透测试。
- Agent 红队覆盖直接/间接提示词注入、工具参数污染、敏感数据诱导、审批绕过和伪造完成状态。
- 客户端覆盖最低版本、强制升级、权限撤销、弱网重连、后台恢复、附件、长任务和证据链一致性。
- 每个发现均记录复现、影响、修复版本、回归证据和风险接受；高危/严重问题不得带入上线。

## 6. 结果归档

归档配置、代码版本、镜像 digest、环境拓扑、测试数据范围、统计原始数据、报告、异常时间线及复测结论。生产容量、灾备和稳定性结论必须基于企业预生产环境，不引用开发机结果代替。

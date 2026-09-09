# 告警分级与虚拟电话模块

## 1. 已实现范围

当前开发基线已实现：

- P0 紧急、P1 中等、P2 低风险三级策略；确认时限、处置目标、渠道和电话模式均可配置。
- 确定性分级规则，不允许大模型直接修改告警等级。
- 组织责任人、值班表、备班人员和分级升级策略。
- SQLite/Memory 双驱动告警工作区，配置采用乐观版本控制。
- 事务 Outbox、幂等键、Mock 通知 Worker 和 Provider-neutral 虚拟电话接口。
- Mock 电话自动接听、语音播放、按 1 确认收到、按 2 重听、按 3 立即生成下一责任人的通知与外呼任务。
- 电话回执只表示收到，不授予风险审批、冻结或业务写入权限。
- 通知、电话和配置事件使用 SHA-256 前向哈希链记录。
- 调用和审计列表按 IAM 有效组织数据范围过滤，电话号码仅返回脱敏值。
- PC 管理端五个页签，以及移动/Web/Electron 共享告警卡的等级和电话状态展示。

真实云电话、Asterisk、定时升级 Worker 和跨进程消息队列属于生产接入项；当前不会拨打真实号码。

## 2. 代码边界

```text
backend/src/data/alerting-seed.js
backend/src/domains/alerting/
  alert-classification-service.js
  alerting-store.js
  alerting-service.js
  providers/
    voice-provider.js
    mock-voice-provider.js
    voice-provider-registry.js
backend/src/routes/alerting-routes.js
frontend/src/features/channels/ChannelsPage.vue
frontend/src/styles/alerting-center.css
frontend/src/styles/alerting-oncall.css
packages/agent-workbench/src/AgentWorkbench.vue
backend/test/alerting-orchestration.test.js
```

`risk-service.js` 继续是 RiskCase 查询和处置入口，告警领域只负责等级、通知、升级、外呼及送达证据，避免电话供应商反向控制业务状态。

## 3. 默认策略

| 等级 | 确认时限 | 电话模式 | 默认渠道 |
|---|---:|---|---|
| P0 | 5 分钟 | 立即外呼 | 站内、Push、短信、电话、邮件、Webhook |
| P1 | 30 分钟 | 超时外呼 | 站内、Push、邮件、短信 |
| P2 | 480 分钟 | 禁用 | 站内、邮件摘要 |

后端明确拒绝将 P2 配置为立即外呼。

## 4. 数据流

```text
业务事件
  -> classifyAlert（确定性规则）
  -> simulatedAlerts / RiskCase 关联
  -> escalation policy + on-call receiver
  -> notification delivery + transactional outbox
  -> worker claim
  -> provider adapter
  -> delivery / VoiceCall 回执
  -> SHA-256 audit timeline
```

外部供应商调用不应放在创建 RiskCase 的 HTTP 事务中。Demo 会同步触发一次 Outbox Worker 方便演示；生产应由独立 Worker 通过 PostgreSQL `FOR UPDATE SKIP LOCKED`、Kafka、RabbitMQ 或 NATS 消费。

## 5. API

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/alerting/workspace` | `page.channels.view` | 返回组织范围内的等级、策略、电话和审计工作区 |
| POST | `/api/alerting/configuration` | 按字段要求 `notification.policy.publish` 和/或 `oncall.schedule.manage` | 版本化发布等级、Provider、值班表与升级策略 |
| POST | `/api/alerting/simulations` | `notification.route.simulate` | 执行规则、路由、Outbox 和 Mock 送达 |
| POST | `/api/alerting/voice/test` | `notification.voice.test` | 发起 Mock 测试电话 |
| POST | `/api/alerting/voice-calls/{id}/events` | `notification.voice.test` | 模拟 DTMF 回执 |

新增 IAM 按钮：

```text
notification.delivery.retry
notification.policy.publish
notification.route.simulate
notification.voice.test
oncall.schedule.manage
notification.audit.view
```

旧 SQLite IAM 工作区通过 schema v2 增量迁移补充管理层初始授权；迁移后仍可按角色策略撤销普通按钮。

## 6. Provider 扩展契约

所有电话实现继承 `VoiceProvider`：

```js
placeCall(request)
cancelCall(providerCallId)
verifyCallback(headers, body)
```

业务层只传 `phoneRef`、脱敏号码、审批通过的模板和幂等键。真实号码应由 PII Vault/企业通讯录或电话网关解析，不得写入浏览器、日志或仓库。

新增供应商步骤：

1. 实现 Provider 类并注册到 `voice-provider-registry.js`。
2. 凭据仅配置为 `kms://` 引用。
3. 增加签名、时间戳、Nonce 和重放防护。
4. 将回调标准化为 answered、failed、acknowledge、replay、escalate。
5. 增加契约测试、故障重试、限流、熔断和成本上限。

## 7. 安全边界

- 电话按键不是强身份认证，不能批准冻结、采购、放行或其他业务写入。
- 语音模板只允许白名单变量，目前仅组织名称和事件编号。
- 电话中不播放客户、配方、检验明细或订单隐私。
- Provider 回调生产化前不得加入匿名公共路径。
- 管理写接口在后端按按钮权限二次校验。
- 电话和审计查询同时应用租户、主体、角色和组织数据范围。
- 当前哈希链用于篡改检测，不等同于外部签名的 WORM 审计仓。

## 8. 验证

```powershell
npm.cmd run test:alerting
npm.cmd run test:all
npm.cmd run build
npm.cmd run build:mobile
npm.cmd run build:desktop
```

告警专项覆盖规则分级、P0 自动电话、按键升级后的下一责任人外呼、P1/P2 不立即电话、值班/升级配置版本、P2 安全约束、DTMF 权限边界、组织隔离及 HTTP 页面/按钮门禁。

## 9. 生产待办

1. 选择合规云电话或企业 Asterisk/SIP 网关并完成号码、模板和呼叫资质审批。
2. 将 Outbox 和 Worker 迁移到 PostgreSQL + 消息队列，增加延迟任务和多节点租约。
3. 实现 P1 超时调度、P0 多级升级、静默、抑制、聚合、维护窗口和死信重放。
4. 对接 HR/OA 值班表、请假替班和企业通讯录 PII Vault。
5. 增加双供应商故障切换、呼叫频控、成本预算、SLO 和运营指标。
6. 将审计事件写入 KMS/HSM 签名、可信时间戳和 WORM/Object Lock 存储。

## 10. 开源参考与采用边界

- [Prometheus Alertmanager](https://github.com/prometheus/alertmanager)：参考接收器路由、幂等、分组、静默和抑制的领域划分；当前 Demo 已落路由与幂等，分组/静默/抑制列入生产待办。
- [GoAlert](https://github.com/target/goalert)：参考值班表、升级链以及短信/电话触达正确责任人的产品模型。
- [Novu](https://github.com/novuhq/novu)：参考多渠道 Provider 抽象与工作流编排边界；本项目保留自己的 IAM、证据链和业务控制层。
- [Asterisk](https://github.com/asterisk/asterisk)：作为企业自建 SIP/PBX 的生产 Provider 选项，不把 PBX 逻辑耦合进告警领域。

本实现没有直接复制上述项目代码；采用的是可替换 Provider、责任链、路由、幂等和异步 Outbox 等成熟架构模式。正式选型前仍需完成许可证、合规、可用性和运维成本评审。

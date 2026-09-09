# 历史查询与受控样本映射接入指南

更新：2026-09-07。适用范围：后端连接器开发、语义模型字段映射验证。以下是已实现的接口边界，不表示企业系统已接入。

## 1. 两种时间不能混用

`occurredAt` 是事件发生时间，不能据此判断对象在某个时点的状态。历史状态使用 `validFrom`、`validTo` 表达有效区间，并要求来源确认本次查询范围完整。

| 输入 | 当前行为 |
|---|---|
| 查询 ORD-100 在 2026-08-17 的事件记录 | 按上海时区筛选该日的 `occurredAt` |
| 查询 ORD-100 版本 v2 | 筛选来源明确声明的版本 |
| 查询 ORD-100 截至 2026-08-17T10:00:00+08:00 的状态 | 查询该时点有效的来源记录 |
| 查询昨天 ORD-100 的状态 | 先澄清具体时点，不拿昨日事件代替昨日状态 |
| 查询 ORD-100 最新状态 | 不自动判断跨来源哪个版本最新 |

历史查询必须指定业务编号和不晚于现在的完整 ISO 时点，包含秒和时区；不能同时指定事件日期或来源版本。一次最多 10 个编号。目前不推断“昨天收工时”等业务时点。

## 2. 历史连接器协议

端点仍由服务端 `ENTERPRISE_CONNECTORS_CONFIG_JSON` 配置，默认 POST 到 `/agent/evidence`，凭据从服务端环境变量取得。以下均为合成示例；租户和主体在运行时来自已认证请求，不得复制示例身份充当生产权限。

请求：

```json
{
  "systemId": "oms",
  "query": {
    "businessIds": ["ORD-100"],
    "asOf": "2026-08-17T02:00:00.000Z"
  },
  "access": {
    "roleId": "marketing_manager",
    "tenantId": "demo-enterprise",
    "subjectId": "market@demo.local"
  }
}
```

响应：

```json
{
  "queryCoverage": {
    "schemaVersion": "connector-history.v1",
    "complete": true,
    "asOf": "2026-08-17T02:00:00.000Z",
    "businessIds": ["ORD-100"]
  },
  "records": [{
    "id": "ORD-100",
    "tenantId": "demo-enterprise",
    "organizationId": "org-market-dept",
    "classification": "internal",
    "version": "v1",
    "occurredAt": "2026-08-01T00:00:00Z",
    "validFrom": "2026-08-01T00:00:00Z",
    "validTo": "2026-08-18T00:00:00Z",
    "statement": "历史待处理"
  }]
}
```

接入约束：

- `queryCoverage.asOf` 原样回传服务器的 UTC 时点；`businessIds` 与请求集合完全一致，不能重复、缺少或增加编号。
- `complete=true` 表示来源确认在该身份范围、这些编号、这个时点的返回集合完整。适配器完成下游分页和版本检查后才能声明，不能在超时、漏页或抽样时填写 `true`。
- `validFrom <= asOf < validTo`。无结束时间必须显式填写 `validTo:null`；省略字段不是无限有效。日期、时区或区间无效时整批拒绝。
- 本端单次最多接收 20 条历史记录，超限不截取前 20 条冒充完整结果。应缩小编号范围；目前没有本端历史分页协议。
- 任一历史记录缺少来源版本、身份/组织元数据、正文，或不属于请求范围，整批不进入 Agent 证据。不能先过滤掉疑似冲突行，再声称剩余部分完整。
- 同一来源、同一对象在该时点出现多个版本或不同正文，停止模型结论和业务写入，提示复核；内容相同但版本不同也会拦截。
- 无匹配记录、缺少声明或连接失败时，不回退当前 Mock 风险或语义演示图。没有匹配证据不证明对象不存在。

这是对受信任连接器声明的核验，不是源系统真实性的独立证明。只确认接入来源范围，不证明其他未接入系统不存在冲突；跨源权威裁决、双时间轴和完整历史存储尚未实现。历史证据不能创建当前质量调查草稿。

实现：[查询计划](../../backend/src/services/agent-query-plan-service.js)、[连接器](../../backend/src/services/system-integration-service.js)。

## 3. 用受控样本验证字段映射

新增服务端函数 `validateGovernedSemanticSamples`，接收调用方已经取得并完成字段脱敏的样本。它不读取企业系统、不使用上传材料声明的身份，不写入语义图，也不发布模型。运营页面的映射演练仍使用 Mock，没有新增“真实样本已接入”按钮。

调用示例（服务端模块代码）：

```js
import { validateGovernedSemanticSamples } from './semantic-mapping-validation-service.js';

const result = validateGovernedSemanticSamples(
  draft,
  new Map([['wms', redactedSamples]]),
  { roleId: authenticatedRole.id, identityScope: authenticatedScope, sampleLimit: 3 }
);
```

准备内容：

1. `draft.objectTypes`：对象编码、主键、来源系统及完整 `fieldDefinitions`。每个字段说明 `name`、`type`、`sourceField`、`mappingStatus`；主键必须存在，不能忽略。旧式只有字段名的简写不用于此严格入口。
2. 样本 Map：键为小写系统名，如 `wms`；每条记录包含 `system`、`objectType`、稳定编号、租户、组织、分级、版本和 `occurredAt`。业务字段放在 `payload`，映射路径相对此根读取，不使用外层记录 ID 补业务主键。
3. 当前认证身份：调用应用服务取得，并先检查调用及数据访问权限。适配器送样前完成字段级裁剪；本函数的租户、组织和元数据检查不替代字段授权。

函数拒绝整批跨租户、越权组织、缺版本或畸形记录，包括位于抽样上限之外的坏记录；拒绝响应不返回样本内容或标识。空模型、重复字段、缺失主键和未知字段类型同样被拒绝。

每个对象默认检查前三条样本，最多十条；每个系统输入最多 1000 条，最多 16 个系统。只检查有界样本内的类型、必填值、路径和主键重复。没有对应样本时保持 `unverified` 并阻止通过；未实现的派生表达式也不能算成功。

结果中必须保留：

- `contract.sourceMode=governed_sample_input`：来自调用方样本，不是内置 Mock 生成器。
- `coverage.providedRecords`、`testedRecords`：输入记录数和实际映射样本数。
- `coverage.verifiesAllSourceData=false`：样本通过不代表全量对账、关联完整性或生产接入通过。
- `blocked`：调用方应把它作为继续处理的门禁，不能只检查是否返回了预览对象。

预览的 `source.simulated=false` 仅表示本函数没有生成 Mock 记录，不证明调用方样本是真实数据。预览可能包含已授权字段值，应限制访问和保留期，不直接写入公共日志。

实现：[样本映射服务](../../backend/src/services/semantic-mapping-validation-service.js)。当前仅供受信任服务端适配器调用；接入 HTTP 或运营页面前，仍需认证、上传审计、扫描与脱敏流程。

## 4. 回归与接入验收

```powershell
node --import ./backend/test/runtime-test-bootstrap.js --test backend/test/agent-targeted-query.test.js backend/test/semantic-operations-agent.test.js
npm run test:all
```

自动测试使用合成记录、隔离内存状态和临时 HTTP 服务器，不调用真实模型或企业接口。结果见 [持续改进记录第四批](AGENT_RUNTIME_IMPROVEMENT_2026-09-06.md)。

企业联调仍需核对权威来源、历史保留范围、时区、删除/冲销语义、分页完整性、字段脱敏、撤权行为与全量对账。开发入口不能代替这些验收。

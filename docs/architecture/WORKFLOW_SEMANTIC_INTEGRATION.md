# OA / 钉钉流程语义接入架构

状态：第二阶段开发闭环完成（真实企业授权与网络验收待目标环境）
更新：2026-10-08

[返回架构文档](README.md)

## 1. 目标与边界

流程接入不是同步一张审批结果表，而是持续读取外部流程引擎的定义、表单、节点、条件、运行实例和审计时间线，再把经过校对的流程语义发布给智脑。

本阶段坚持三个边界：

1. 钉钉或 OA 仍是流程事实权威，元域保存的是带来源版本和观测时间的只读投影。
2. 节点、连线、条件和审批人规则由连接器确定性读取；模型只能生成用途说明和语义映射建议，不能猜测结构事实。
3. 新流程和新版本先进入候选区。同步权限不能替代发布权限，候选未经人工校对不能进入智脑读取面；审批、驳回、提交和撤回不在第一阶段范围内。

## 2. 已实现架构

```text
Mock 钉钉审批 / Mock OA-BPM / 受控连接器适配网关
          │ 手动立即同步 + 定期对账（静态 Bearer / OAuth Client Credentials）
          ├──────────────────────────────────────────┐
          │                                          │ 签名变更通知
          ▼                                          ▼
Workflow Connector（确定性定义、表单和实例）   租户事件收件箱
          │                                  └─ 防重放 / 重试 / 死信
          └──────────────────┬───────────────────────┘
                             ▼
          │
          ▼
workflow-integration 独立领域
  ├─ 租户级流程目录
  ├─ 定义版本与结构指纹
  ├─ 节点/字段/流转差异
  ├─ 内部事务/采购/生产/物流流程类别
  ├─ 参与系统与跨系统交接规则
  ├─ 候选校对与发布闸门
  └─ 已发布流程只读查询投影
          │
          ├─────────► 元域智语：流程图、映射、Diff、实例、流转记录、事件状态
          │
          └─────────► 智脑：自然语言路由 → 流程语义只读工具
```

代码入口：

- `backend/src/domains/workflow-integration/`：领域契约、Mock Connector、受控真实连接器、响应档案、事件收件箱和租户级状态；
- `backend/src/workers/workflow-sync-worker.js`：定期对账、事件拉取、重试与死信；
- `backend/src/routes/workflow-integration-routes.js`：运营端与智脑只读接口；
- `apps/semantic-operations-console/src/components/WorkflowSemanticCenter.vue`：可视化流程中心；
- `packages/semantic-operations-sdk/src/index.js`：客户端调用契约。

## 3. 统一流程对象

当前定义投影包含：

| 对象 | 含义 |
| --- | --- |
| 流程定义与版本 | 编码、来源 ID、来源版本、用途、业务域、风险和数据分级 |
| 流程类别 | 管理/业务/混合用于权限边界，内部事务/采购供应/生产制造/物流履约用于业务目录 |
| 跨系统交接 | 参与系统、交接方向、触发条件、对象类型和语义业务键 |
| 节点 | 开始、结束、审批、条件、并行和服务任务 |
| 流转关系 | 起点、终点以及源系统给出的条件表达式 |
| 表单字段 | 字段名、类型、必填性、敏感等级及世界模型目标 |
| 业务绑定 | 流程与 Person、PurchaseOrder、Supplier 等对象的关联 |
| 运行实例 | 实例 ID、业务键、当前节点、状态、更新时间和有界流转记录 |
| 来源证据 | 来源系统、来源定义 ID、来源版本和本次观测时间 |

内置 Mock 场景包括员工请假、员工入职协同、采购申请审批、生产工单投产放行和物流异常协同处置。生产场景跨 OA、ERP、MES、QMS、WMS；物流场景跨钉钉、OMS、WMS、TMS。变更场景会把采购审批从 v3 更新为 v4，并新增供应商准入审批。

## 4. 版本同步和发布

`POST /api/semantic-operations/workflows/sync` 使用来源版本和结构指纹做幂等判断。版本号相同且结构相同不会重复生成候选；结构变化会计算节点、字段及流转条件 Diff。

候选版本保持 `candidate / review_required`，旧发布版本继续服务智脑。具备 `meta_model.publish` 的运营人员校验后才能发布；拒绝候选不会改变当前生效版本。历史实例保留原流程版本，不用新版本解释旧实例。

服务端已经提供规范化真实连接器入口：配置只引用凭据环境变量，不允许把密钥放进请求；连接地址、固定路径、响应大小、来源归属、定义结构、实例引用版本和分页游标均在入库前校验。真实适配网关返回规范化定义、实例和游标后，定义仍只生成候选版本，不会绕过人工发布。实例必须引用同一连接器本轮声明的定义版本；候选版本的实例会保存，但在版本发布前不会进入智脑读取面。发布新版本后，仍在旧已发布版本上运行的实例继续按原版本解释，不会被新流程图覆盖或从查询结果中消失。

配置示例（密钥仅存在服务端环境变量）：

```json
[
  {
    "id": "dingtalk-live",
    "name": "钉钉生产适配网关",
    "baseUrl": "https://workflow-gateway.example.com/",
    "definitionsPath": "/api/workflow-definitions",
    "responseProfile": "dingtalk_gateway_v1",
    "authMode": "static_bearer",
    "credentialEnv": "DINGTALK_WORKFLOW_TOKEN"
  }
]
```

将上述数组放入 `WORKFLOW_CONNECTORS_CONFIG_JSON`，密钥放入 `DINGTALK_WORKFLOW_TOKEN`。外网地址还需显式设置 `WORKFLOW_CONNECTORS_ALLOW_EXTERNAL=true`。运营端点击“立即同步真实连接器”会发送 `{ "mode": "configured" }`，并在同步记录中标记人工触发。

`responseProfile` 支持 `canonical_v1`、`dingtalk_gateway_v1` 和 `oa_bpm_gateway_v1`。后两项是元域适配网关契约：网关负责调用厂商官方 API，平台负责把稳定的网关字段确定性转换为统一流程对象。它不声称任意厂商原始响应都能免配置直连。

需要 OAuth 服务主体时不配置长期 Bearer，改为：

```json
{
  "id": "oa-live",
  "baseUrl": "https://workflow-gateway.example.com/",
  "definitionsPath": "/api/workflows",
  "responseProfile": "oa_bpm_gateway_v1",
  "authMode": "oauth_client_credentials",
  "tokenPath": "/oauth/token",
  "clientIdEnv": "OA_WORKFLOW_CLIENT_ID",
  "clientSecretEnv": "OA_WORKFLOW_CLIENT_SECRET",
  "scope": "workflow.read instance.read"
}
```

Client ID、Secret 和短时访问令牌都只在服务端使用；令牌刷新响应有独立 64 KiB 上限、超时和契约校验，不写入工作区、日志或浏览器响应。

适配网关使用有界游标分页。每页必须返回 `definitions`，可选返回 `instances`、`cursor` 和 `nextCursor`；服务端最多读取 20 页、500 个定义和 5000 个实例，并拒绝循环游标、重复定义版本、重复实例、跨来源实例、未声明版本引用、当前节点不属于对应版本，以及时间倒序或节点无效的流转记录。单实例最多保留 100 条规范化流转事件。下一页请求使用 `?cursor=<nextCursor>`。规范化示例：

```json
{
  "cursor": "dingtalk-observed-20261008-0610",
  "nextCursor": "page-2",
  "definitions": [
    {
      "provider": "dingtalk-live",
      "sourceId": "PROC-001",
      "code": "DINGTALK-PURCHASE",
      "name": "采购申请审批",
      "version": "5",
      "purpose": "采购申请校验与多级审批",
      "category": "business",
      "processType": "procurement",
      "businessDomain": "采购与供应链",
      "systems": ["dingtalk-live", "finance", "erp", "wms"],
      "crossSystemHandoffs": [
        {
          "fromSystem": "dingtalk-live",
          "toSystem": "erp",
          "trigger": "审批通过后创建正式采购订单",
          "objectType": "PurchaseOrder",
          "semanticKey": "purchaseOrderNo"
        }
      ],
      "riskLevel": "high",
      "dataClassification": "business_restricted",
      "updatedAt": "2026-10-08T06:00:00.000Z",
      "nodes": [
        { "id": "start", "label": "开始", "type": "start" },
        { "id": "finance", "label": "财务审批", "type": "approval" }
      ],
      "edges": [],
      "fields": [],
      "bindings": []
    }
  ],
  "instances": [
    {
      "provider": "dingtalk-live",
      "id": "DT-LIVE-PURCHASE-001",
      "definitionCode": "DINGTALK-PURCHASE",
      "definitionVersion": "5",
      "title": "采购单 PO-LIVE-001 审批",
      "status": "running",
      "currentNodeId": "finance",
      "updatedAt": "2026-10-08T06:10:00.000Z",
      "timeline": [
        {
          "id": "purchase-finance",
          "nodeId": "finance",
          "label": "进入财务审批",
          "action": "entered",
          "actorDisplay": "财务经理",
          "occurredAt": "2026-10-08T06:10:00.000Z"
        }
      ]
    }
  ]
}
```

示例省略了定义中的业务说明和节点内容；实际定义至少需要一个节点，并满足字段和关系上限。若响应完全不含 `instances` 字段，本轮只更新定义，不清空该来源既有实例；若明确返回空数组，则表示该来源当前实例投影为空。

### 4.1 签名通知与死信

事件提供方配置在 `WORKFLOW_WEBHOOKS_CONFIG_JSON`，租户与密钥引用由部署侧固定，回调正文不能选择租户：

```json
[
  {
    "id": "dingtalk-live",
    "tenantId": "tenant-a",
    "signingSecretEnv": "DINGTALK_WORKFLOW_WEBHOOK_SECRET"
  }
]
```

提供方调用 `POST /api/integrations/workflows/webhooks/dingtalk-live`，发送 `x-workflow-event-id`、十位秒时间戳 `x-workflow-timestamp` 和 `x-workflow-signature`。签名原文为：

```text
<timestamp>\n<providerId>\n<eventId>\n<eventType>
```

签名是 `sha256=<HMAC-SHA256 hex>`。默认允许 5 分钟时钟偏差。正文只允许事件类型和可选资源引用；资源引用仅保存哈希。验证通过后按部署绑定租户幂等入队，Worker 再用服务端连接器重新读取权威数据，因此伪造或过期正文不能直接改变流程投影。

失败采用有界指数退避，5 次失败进入死信。元域智语展示待处理/处理中/死信数量；具备 `event.outbox.replay` 的人员可以重新入队。重放仍只触发拉取，不直接采纳原始回调。

### 4.2 实时、定时与手动同步

| 方式 | 触发 | 用途 |
| --- | --- | --- |
| 实时同步 | 钉钉/OA 签名 Webhook 进入租户事件收件箱 | 优先发现定义和实例变化；回调只是拉取信号 |
| 定时同步 | `workflow-sync-worker` 按租户执行增量对账 | 修复漏事件、上游回调丢失或长时间断网差异 |
| 手动同步 | 语义运营端“立即手动同步 Mock/真实连接器” | 实施联调、问题复核和运营人员主动对账 |

三种方式使用同一个幂等同步核心，都不会自动发布候选版本。运营端同时展示三种方式、最后同步时间和同步记录。

周期对账可运行：

```powershell
$env:WORKFLOW_SYNC_TENANT_IDS='tenant-a,tenant-b'
npm run run:workflow-sync-worker
```

生产环境必须显式声明租户列表，不会回落到 Demo。常驻部署使用同一 Worker 文件并设置 `WORKER_MODE=daemon`；默认每 5 秒检查事件收件箱、每 5 分钟执行一次全量增量对账，可分别由 `WORKFLOW_EVENT_POLL_INTERVAL_MS` 和 `WORKFLOW_SYNC_INTERVAL_MS` 调整。同步对候选生成是幂等的，多次拉取不会自动发布。

## 5. 管理流程与业务流程

管理流程和混合流程默认按个人敏感数据处理。查询人不是流程申请人时，会隐藏申请人、金额、表单摘要、流转参与人和意见。业务流程同时按角色和业务域裁剪：管理层可读取授权业务流程；采购、质量、生产、市场角色只在匹配业务域内读取受限字段。未知角色或跨业务域只保留实例编号、业务键、状态、节点、时间和已脱敏流转标签。目标企业的组织范围和 HR 专属角色仍需用真实 IAM 数据验收。

业务流程保留业务编号、具体流程类别、跨系统链路、当前节点、规范化流转记录和来源证据，用于解释“采购单为何尚未下单”“生产工单卡在哪个系统”“物流异常是出库还是运输环节”等问题。智脑已经注册 `read_workflow_context` 只读工具，可识别审批进度、流转历史、流程目录以及生产工单/运单编号问法；候选版本不会进入该工具。管理/混合流程对非本人隐藏申请人、摘要和流转参与人。流程标题不构成业务效果证据：只有流程实例到 PurchaseOrder 等对象的明确绑定，才能说明审批对 ERP 建单产生的约束。

## 6. 接口与权限

| 接口 | 权限与行为 |
| --- | --- |
| `GET /api/semantic-operations/workflows` | 元域智语页面权限；读取流程类别、跨系统目录和三种同步状态 |
| `GET /api/semantic-operations/workflows/:code` | 读取最新候选、版本历史、流程图和实例 |
| `POST /api/semantic-operations/workflows/sync` | `meta_model.draft.save`；手动立即同步，Mock 使用 `scenario`，真实入口使用 `mode=configured`；均只发现候选，不发布 |
| `POST /api/semantic-operations/workflows/:code/versions/:version/review` | `meta_model.publish`；明确发布或拒绝候选 |
| `POST /api/integrations/workflows/webhooks/:providerId` | 无用户会话但必须 HMAC 验签；按部署绑定租户入队，只触发受控拉取 |
| `POST /api/semantic-operations/workflows/events/:eventId/replay` | `event.outbox.replay`；仅重放当前租户死信 |
| `GET /api/agent/workflow-context?query=...` | 智脑页面权限；只查已发布版本，不产生写入 |

## 7. 当前验证

专项测试 17 项覆盖：三类权限流程目录、四类具体业务流程、生产/物流跨系统 Mock 的智脑联调、模型理解失败时明确流程编号仍走确定性只读工具、确定性流程结构、增量发现、破坏性变更、候选不自动生效、人工发布切换、旧版本在途实例保留、重复同步幂等、管理/跨业务域字段脱敏、自然语言进度/历史路由、已发布版本读取、静态 Bearer 与 OAuth 服务主体、钉钉网关响应档案、地址/来源契约闸门、实例分页、节点/流转记录校验、候选实例隔离、循环游标拒绝、多连接器实例快照隔离、Webhook 签名与防重放、租户队列、重试/死信/人工重放，以及同步/发布权限分离。

运行：

```powershell
npm run test:workflow-integration
npm run build:semantic-ops
```

2026-10-08 本机 HTTP 验收：运营端读取到 5 个已发布流程、5 个跨系统流程、0 个待校对版本；再次执行 Mock 手动增量同步返回 `discovered=0`、`changed=0`、`unchanged=5`，证明重复同步幂等。智脑按 `MO-20261008-021` 返回 `OA → ERP → WMS → QMS → MES` 及当前 QMS 放行节点，按 `WB-20261008-778` 返回 `DINGTALK → OMS → WMS → TMS` 及 TMS 延误节点。验收时方舟账户不可用，模型润色降级提示被如实展示，但确定性流程工具仍返回已发布证据；这证明只读业务能力可降级运行，不代表云模型连通性通过。

## 8. 需要目标企业环境完成的验收

以下不是可以继续用 Mock 宣称完成的开发项：

- 在钉钉或目标 OA/BPM 创建企业应用，确认官方 API、scope、限流、删除语义和历史保留范围，并由适配网关映射到已实现的响应档案；
- 使用企业证书、Client ID/Secret 和真实回调域名验证 OAuth、网络白名单、签名算法、时钟同步及厂商重试行为；
- 用真实组织、HR、财务、采购角色验证组织范围与字段分级；附件仍需独立按需授权、病毒扫描和 DLP，不随流程投影同步；
- 执行真实规模分页、回调突发、限流、断网、令牌过期、Worker 重启和死信恢复演练，并接入生产监控告警；
- 由业务方扩充口语问法和跨流程盲测集，确认定义、实例、业务对象与审批意见的企业语义；
- 流程提交、同意、驳回、撤回和自动审批不属于本只读接入边界，除非另立写入项目并重新完成权限与确认设计。

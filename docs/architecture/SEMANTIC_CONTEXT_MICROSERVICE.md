# 语义上下文微服务（Semantica）v0.1

## 定位

语义上下文微服务是元域智脑 AI 基座的语义与溯源边界。它以人员、原材料、产品、设备、门店五个核心元对象为锚点，将来自 OA、ERP、MES、LIMS、QMS、OMS、POS/MDM 等系统的**已授权事实**组织为带来源和时间语义的上下文图，供元域智脑进行可追溯的检索、影响分析和决策记录。门店事实必须携带权威 `store_id`、`organizationId`、营业状态和数据分级。

该服务采用 Semantica 作为生产目标适配层；Demo 同时保留角色过滤的本地投影，使 UI 和智脑流程可在没有单独 Python 服务时完成演示。

## 服务边界

| 语义上下文服务负责 | 不负责 |
| --- | --- |
| 上下文图、对象关系、事实来源、有效时间与记录时间 | 用户认证、账号管理与会话签发 |
| 本体约束校验、冲突提示、影响分析 | 数据域/字段/工作流授权判定 |
| 智脑计划使用的证据与决策溯源记录 | 保存或返回 ERP、模型、短信等密钥明文 |
| 接收已经过授权和脱敏处理的源系统事实 | 发起采购、放行、审批或其他业务写入 |

权限中心先计算访问范围，密钥中心再为已获准的连接器调用签发短时不透明租约；语义服务只在这一控制链路中提供“可引用证据”。

## 逻辑架构

```text
OA / ERP / MES / LIMS / QMS / OMS
        │  已授权事实、来源、分级、时间
        ▼
语义上下文微服务（Semantica）
  ├─ 核心元对象锚定与本体约束
  ├─ 关系 / 来源 / 有效期 / 决策溯源
  └─ 角色裁剪后的证据上下文
        │
        ▼
元域智脑运行时 ── 联合策略校验 ── 密钥中心租约 ── MCP 连接器
        │
        └─ 计划、确认、审批与审计
```

## 当前 Demo 实现

- Node 业务 API 暴露 `GET /api/semantic-context`，提供角色过滤的语义投影（2026-09-28 阶段 6 起：管理 Web「元模型」页已移除、前端方法删除，端点按阶段 2 先例保留一个版本周期）。
- `backend/src/services/semantic-context-service.js` 提供事实、关系与决策溯源的 Demo 契约实现。
- `services/semantic-context/app.py` 是独立 Python 服务，安装 `semantica==0.6.5` 后优先使用 `semantica.context.ContextGraph`；缺少依赖时以 `projection-fallback` 运行，并明确报告运行模式。
- 启动模拟场景时，`semantica-demo-bridge-service.js` 只从服务端提取该运行的合成 Mock 事实，发送至本机 `POST /demo/ingest` 建图并校验；OA 审批完成后会再次同步，验证 CAPA 等模拟写回是否进入同一上下文。
- 验证状态会记录在模拟运行对象并展示在“模拟运行中心”。语义服务不可用时，场景仍可演练，但状态会显示“未验证”，Agent 只保留既有的受控本地投影，不会伪造 Semantica 成功结果。
- 元域智脑在计划中记录所用语义证据与决策 ID，避免将无来源的模型猜测包装成业务结论。

Demo 中的内存数据不可当作真实生产数据或生产授权依据。

### 跨系统 Mock 验证

`services/semantic-context/evaluate_mock_data.py` 会在隔离的 Node 测试内存运行时启动现有质量、供应和订单场景，再使用实际 `semantica.context.ContextGraph` 验证实体检索、跨系统影响追踪、来源字段和决策溯源。详细结果见 [SEMANTICA_MOCK_EVALUATION.md](../development/SEMANTICA_MOCK_EVALUATION.md)。

### Demo 闭环接口

这些接口只监听 `127.0.0.1`，不面向浏览器和真实连接器；调用者必须是平台后端桥接服务。

| 接口 | 用途 |
| --- | --- |
| `POST /demo/ingest` | 接收单个模拟运行的、`simulated=true` 的规范化事实，建立 Scenario、事实、业务实体及双向影响关系，并校验来源与预期系统。 |
| `GET /demo/runs/{runId}` | 返回该模拟运行的事实数、来源系统、图统计和校验结果。 |
| `GET /demo/model-candidates` | 从当前 Semantica Demo 图返回对象类型、字段结构、来源系统和关系证据数量；不返回原始业务记录。 |
| `POST /demo/model-definition/validate` | 校验受控元模型定义的对象主键、核心锚点、来源系统和关系引用，不改变服务状态。 |
| `POST /demo/model-definition/publish`、`GET /demo/model-definition` | 发布并查询当前 Semantica 模型登记摘要；不返回完整业务事实。 |
| `POST /demo/reset` | 清空仅驻留内存的 Demo 图；模拟运行时重置时一并调用。 |

桥接仅允许 `http://127.0.0.1`、`localhost` 或 `::1` 目标，超时为 3.5 秒。它拒绝远端地址，并且只会发送当前 `runId` 的合成事件与 OA 对象；身份、角色、字段裁剪和真实数据接入仍由平台 API 上游负责。

建模端通过 `/api/meta-models/oa-governance/authoring-profile` 获取该投影，并把它显示为“语义候选对象库”。候选关系只是 Semantica 基于共享业务标识观察到的证据，必须由具备建模权限的用户确认、补充主键和数据分级，再经过草稿校验和发布治理。

## 本地运行

```powershell
python -m pip install -r services/semantic-context/requirements.txt
python services/semantic-context/app.py
```

- 默认地址：`http://127.0.0.1:3011`
- 健康检查：`GET /health`
- Demo 闭环开关：`SEMANTICA_DEMO_BRIDGE_ENABLED=true` 可显式启用后端桥接；开发环境默认启用。`SEMANTIC_DEMO_INGEST_ENABLED=false` 可禁用 Python 服务的 Demo 写入接口。
- 端口 `3010` 保留给密钥中心微服务；通过 `SEMANTIC_CONTEXT_PORT` 覆盖语义服务端口。
- 项目根目录也可使用 `npm.cmd run dev:semantic` 启动。

## 生产化要求

1. 在私有网络以独立工作负载部署，并采用 mTLS、服务身份与网络策略；不可公开暴露图查询接口。
2. 通过受控连接器/事件总线接入源数据；在进入语义服务前执行数据分级、脱敏和权限裁剪。
3. 将图数据、决策记录和审计日志持久化，且为来源记录、模型版本、规则版本和元模型版本建立关联。
4. 把本体约束、冲突规则和发布流程纳入元模型治理；业务人员可配置草稿，只有具备发布权限的管理员可生效。
5. 语义服务不得接受浏览器传入的角色作为授权依据；调用方必须携带由权限中心签发并由服务端验证的身份上下文。
6. 涉及外部系统写入时，智脑必须先通过工作流门禁，再向密钥中心申请最小范围、最短时效的连接器租约。

## 验收标准

- 每一条可引用事实都能回链到来源系统、来源记录、核心元对象、数据分级和生效时间。
- 角色不同的调用者不能获得越权事实、关系或推理结论。
- 智脑输出的关键结论能够显示证据和决策溯源 ID。
- 任何语义图查询、冲突提示或决策记录均不包含真实密钥材料。

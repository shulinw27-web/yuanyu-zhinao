// 架构约束的登记基线（棘轮 / ratchet）。
//
// 本文件是「只降不升」的单一事实源：登记当前已存在的架构债务基线，
// 新增违反会在测试中直接失败。收敛后请同步下调此处数值，防止重新膨胀。
//
// 生成当前基线：node scripts/architecture-baseline.mjs --print

// 领域公共入口（public-api.js）的导出数量上限。
// 目标：≤15（真正的契约面）。当前为实测冻结值，只允许下降。
export const DOMAIN_EXPORT_CEILING = {
  agent: 61,
  alerting: 8,
  governance: 92,
  iam: 4,
  identity: 14,
  'key-management': 4,
  platform: 13,
  procurement: 5,
  risk: 7,
  simulation: 14,
  // 2026-09-25 新增领域：系统接入。未并入 governance 是因为该域导出已达冻结上限 92，
  // 塞进去只能靠抬高基线来实现，反而削弱棘轮；架构测试本身给出的合法路径就是「拆分领域」。
  // 初始上限刻意压到 4（边界声明 + 总览 + 详情 + 探测），不预留增长空间。
  // 2026-09-26 抬到 5（ADR-023）：补第 5 项契约「生命周期操作」——状态机早已在注册表
  // 定义却从未暴露为可执行动作，界面接入状态只能看种子值。这是补齐接入流程缺口的
  // 最小契约面，仍不预留增长空间；下一次抬高必须先说明为什么现有 5 项不够。
  // 2026-09-26 抬到 6（ADR-024）：补第 6 项契约「登记自定义系统」——接入清单不再
  // 预设备待接入/未登记系统，「新增接入」必须是租户可执行的登记动作；没有这项契约，
  // 去预设后的接入流程没有入口。仍不预留增长空间。
  // 2026-10-07 抬到 9（需求 2）：+3 项——「已接入系统补充物料」「系统理解」「物料边界声明」。
  // 接入成功后租户可继续补充系统物料（8-5 同一受控解析管线），并把登记物料 + 文档提取
  // 文本交给大模型生成系统理解（理解结果同时是 agent 引导接入的事实面）。实现移至
  // system-material-service.js。现有 6 项不含登记后增量物料与理解面，故抬高。
  'system-onboarding': 9,
  // 2026-10-07 新增领域：系统接入监控（接入成功自动挂载 + 轮询 + 告警）。初始 4 项为
  // 边界声明 + 总览 + 控制 + 手动触发巡检；同日抬到 5：监控路由必须通过领域公共入口
  // 绑定受信租户，不能从路由层穿透 services，也不能在 Demo 回落读取默认租户。
  'system-monitoring': 5
};

// 领域目录中不作为业务边界、不要求 public-api 的基础设施目录。
//
// 2026-09-26（模块化审计第 3 项完成）：原为 `new Set(['events'])`——`domains/events` 是
// 事件出箱 / 存储这类**基础设施**，被放在 `domains/` 下造成概念错位：它被 services 反向依赖，
// 于是「领域层依赖基础设施」看起来像分层反转，实际上只是它站错了目录。
// 现已迁到 `backend/src/infrastructure/domain-events/`，因此这个集合为空——
// 也就是说 `domains/` 下**每一个**目录都必须是带 public-api 的业务边界，不再有例外。
// 保留该集合（而非删掉）是为了让「允许基础设施目录混进 domains/」这件事一旦复发就立刻可见。
export const INFRASTRUCTURE_DOMAINS = new Set([]);

// 服务之间已存在的跨领域直接依赖（未走对方 public-api）。
// 现在冻结为基线；目标是逐条收敛为经 public-api 的调用。
//
// 2026-09-24 变更（private-agent-service 拆分解除一处 God Service）：
// 新增 6 条边 —— 两个抽取模块各自的新领域依赖，以及宿主服务到抽取模块的依赖。
// 这些边是把「单一 1206 行服务文件内的隐式依赖」显化为「模块间的显式依赖」，
// 不是新增领域耦合；后续拆解应继续复现同样的模式（先登记，再收敛）。
//
// 2026-09-25 变更（单一系统事实源：收敛 5 处重复的系统清单定义）：
// 新增 3 条边，全部指向新的 system-registry-service.js（系统注册表）。
// 这是一次**净收敛**：此前 5 个模块各自维护一份系统清单，成员与属性互不一致；
// 现在改为共同依赖注册表这**一个**模块。系统注册表的存在意义就是被依赖——
// 不应把它当成新的领域耦合，也不应通过「让消费者各自再抄一份」来消除这几条边。
//   1) semantic-source-discovery-service.js -> system-registry-service.js（别名表与文本识别）
//   2) world-model-template-service.js     -> system-registry-service.js（连接目标清单）
//   3) system-registry-service.js          -> semantic-tenant-context.js（接入状态按租户隔离）
// 第 3 条方向相反：注册表要读写租户级接入状态，必须依赖既有的租户上下文设施。
//
// 2026-09-25 变更（阶段 2：系统接入模块迁到元域智语端）：
// 新增 2 条边，均来自新的 system-access-service.js（系统接入视图与探测）。
// 它不复制任何系统定义（定义仍只有注册表一处），只是把注册表 + 连接器目录 + 合成数据字典
// 组装成面向运营的视图，因此这两条边是**组装依赖**而非新的领域耦合：
//   1) system-access-service.js -> mock-onboarding-source-service.js（连通性探测读取内置合成数据源）
//   2) system-access-service.js -> semantic-tenant-context.js（探测结果按租户隔离存储）
// 刻意**未**新增 system-access-service.js -> world-model-template-service.js：
// 「元模型连接模板」与「映射草稿」仍属 governance 域，由路由层组合两个域的 public-api，
// 而不是让本服务横向直连治理域内部文件。
export const CROSS_DOMAIN_EDGE_BASELINE = new Set([
  'system-access-service.js -> mock-onboarding-source-service.js',
  'system-access-service.js -> semantic-tenant-context.js',
  'agent-command-authorization.js -> business-control-service.js',
  'agent-command-authorization.js -> core-meta-object-service.js',
  'agent-command-authorization.js -> zhinao-authorization-service.js',
  'agent-conversation-intent.js -> conversation-material-index.js',
  'agent-conversation-service.js -> conversation-material-index.js',
  'agent-conversation-service.js -> prompt-security-service.js',
  'agent-evaluation-service.js -> local-model-gateway.js',
  'agent-evaluation-service.js -> private-agent-service.js',
  'agent-memory-review.js -> prompt-security-service.js',
  'agent-operations-service.js -> local-model-gateway.js',
  'agent-operations-service.js -> mock-scenario-service.js',
  'agent-operations-service.js -> system-integration-service.js',
  'agent-read-loop-service.js -> local-model-gateway.js',
  'agent-read-loop-service.js -> prompt-security-service.js',
  'agent-read-loop-service.js -> zhinao-authorization-service.js',
  'agent-runtime-store.js -> prompt-security-service.js',
  'agent-security-audit-service.js -> siem-event-export-service.js',
  'agent-target-binding-service.js -> risk-service.js',
  'agent-tool-registry.js -> domain-analysis-service.js',
  'agent-tool-registry.js -> procurement-service.js',
  'agent-tool-registry.js -> risk-service.js',
  'agent-tool-registry.js -> zhinao-authorization-service.js',
  'agent-turn-understanding-service.js -> local-model-gateway.js',
  'anomaly-assistant-service.js -> knowledge-answer-contract.js',
  'anomaly-assistant-service.js -> knowledge-material-review-service.js',
  'anomaly-assistant-service.js -> local-model-gateway.js',
  'anomaly-assistant-service.js -> prompt-security-service.js',
  'anomaly-assistant-service.js -> semantic-governance-store.js',
  'assistant-service.js -> procurement-service.js',
  'audit-governance-service.js -> agent-evidence-trace-service.js',
  'audit-governance-service.js -> security-detection-service.js',
  'business-control-service.js -> core-meta-object-service.js',
  'conversation-material-index.js -> prompt-security-service.js',
  'decision-binding-service.js -> business-decision-service.js',
  'decision-binding-service.js -> semantic-record-contract-service.js',
  'decision-binding-service.js -> temporal-relation-service.js',
  'dingtalk-auth-service.js -> iam-store.js',
  'dingtalk-auth-service.js -> identity-provider-service.js',
  'dingtalk-auth-service.js -> identity-session-service.js',
  'domain-analysis-service.js -> agent-query-plan-service.js',
  'domain-analysis-service.js -> agent-query-service.js',
  'domain-analysis-service.js -> business-decision-service.js',
  'domain-analysis-service.js -> decision-binding-service.js',
  'domain-analysis-service.js -> meta-model-service.js',
  'domain-analysis-service.js -> procurement-service.js',
  'domain-analysis-service.js -> risk-service.js',
  'enterprise-knowledge-service.js -> agent-query-service.js',
  'enterprise-knowledge-service.js -> knowledge-retrieval-engine.js',
  'enterprise-oidc-service.js -> iam-store.js',
  'identity-provider-service.js -> enterprise-oidc-service.js',
  'identity-session-service.js -> iam-store.js',
  'identity-session-service.js -> tenant-runtime-control-service.js',
  'knowledge-answer-contract.js -> prompt-security-service.js',
  'knowledge-answer-service.js -> local-model-gateway.js',
  'knowledge-answer-service.js -> prompt-security-service.js',
  'knowledge-business-brief-service.js -> agent-turn-understanding-service.js',
  'knowledge-business-brief-service.js -> prompt-security-service.js',
  'knowledge-business-brief-service.js -> published-ontology-agent-service.js',
  'knowledge-evidence-service.js -> prompt-security-service.js',
  'knowledge-library-service.js -> agent-query-service.js',
  'knowledge-library-service.js -> prompt-security-service.js',
  'knowledge-library-service.js -> semantic-governance-store.js',
  'knowledge-material-review-service.js -> multimodal-input-service.js',
  'knowledge-study-service.js -> prompt-security-service.js',
  'knowledge-study-service.js -> semantic-governance-store.js',
  'knowledge-supplement-service.js -> prompt-security-service.js',
  'local-model-gateway.js -> anomaly-report-contract.js',
  'local-model-gateway.js -> ark-model-config.js',
  'local-model-gateway.js -> ark-provider-failure.js',
  'local-model-gateway.js -> ark-transport.js',
  'local-model-gateway.js -> knowledge-answer-contract.js',
  'local-model-gateway.js -> model-governance-service.js',
  'local-model-gateway.js -> prompt-security-service.js',
  'local-model-gateway.js -> read-plan-answer-contract.js',
  'local-model-gateway.js -> read-plan-json-recovery.js',
  'local-model-gateway.js -> workbuddy-cloud-config.js',
  'local-model-gateway.js -> workbuddy-cloud-transport.js',
  'meta-model-service.js -> business-decision-service.js',
  'meta-model-service.js -> semantic-governance-store.js',
  'meta-model-service.js -> semantic-model-fingerprint.js',
  'meta-model-service.js -> semantic-record-contract-service.js',
  'meta-model-service.js -> semantic-tenant-context.js',
  'mock-onboarding-service.js -> iam-store.js',
  'mock-onboarding-service.js -> meta-model-service.js',
  // 阶段 5a（ADR-027）：登记材料通道消费多模态受控解析闸门，与下方
  // semantic-operations-task/agent-service、上方 knowledge-material-review
  // -> multimodal-input-service 三条边同性质（消费方不是复制闸门，是共享闸门），非新领域耦合。
  'mock-onboarding-service.js -> multimodal-input-service.js',
  'mock-onboarding-service.js -> semantic-governance-store.js',
  'mock-onboarding-service.js -> semantic-material-workspace-service.js',
  'mock-onboarding-service.js -> semantic-model-fingerprint.js',
  'mock-onboarding-service.js -> semantic-operations-agent-service.js',
  'mock-onboarding-service.js -> semantic-operations-identity.js',
  'mock-onboarding-service.js -> semantic-operations-task-service.js',
  'mock-onboarding-service.js -> semantic-schema-discovery-service.js',
  'mock-onboarding-service.js -> semantic-tenant-context.js',
  'model-governance-service.js -> workbuddy-cloud-config.js',
  'multimodal-input-service.js -> prompt-security-service.js',
  'multimodal-input-service.js -> visual-material-service.js',
  'permission-center-service.js -> business-control-service.js',
  'permission-center-service.js -> iam-store.js',
  'permission-center-service.js -> role-catalog-service.js',
  'permission-center-service.js -> zhinao-authorization-service.js',
  'permission-management-service.js -> iam-store.js',
  'permission-management-service.js -> role-catalog-service.js',
  'private-agent-service.js -> agent-answer-governance-service.js',
  'private-agent-service.js -> agent-command-authorization.js',
  'private-agent-service.js -> agent-conversation-intent.js',
  'private-agent-service.js -> agent-dialogue-intent-service.js',
  'private-agent-service.js -> agent-evidence-trace-service.js',
  'private-agent-service.js -> agent-guidance-service.js',
  'private-agent-service.js -> agent-learning-governance-service.js',
  'private-agent-service.js -> agent-long-task-store.js',
  'private-agent-service.js -> agent-memory-review.js',
  'private-agent-service.js -> agent-memory-selection-service.js',
  'private-agent-service.js -> agent-orchestration-service.js',
  'private-agent-service.js -> agent-query-plan-service.js',
  'private-agent-service.js -> agent-query-service.js',
  'private-agent-service.js -> agent-read-loop-service.js',
  'private-agent-service.js -> agent-run-store.js',
  'private-agent-service.js -> agent-security-audit-service.js',
  'private-agent-service.js -> agent-skill-registry.js',
  'private-agent-service.js -> agent-target-binding-service.js',
  'private-agent-service.js -> agent-tool-registry.js',
  'private-agent-service.js -> agent-turn-understanding-service.js',
  'private-agent-service.js -> agent-workflow-service.js',
  'private-agent-service.js -> business-control-service.js',
  'private-agent-service.js -> conversation-material-index.js',
  'private-agent-service.js -> core-meta-object-service.js',
  'private-agent-service.js -> desktop-endpoint-service.js',
  'private-agent-service.js -> desktop-tool-registry.js',
  'private-agent-service.js -> enterprise-knowledge-service.js',
  'private-agent-service.js -> local-model-gateway.js',
  'private-agent-service.js -> multimodal-input-service.js',
  'private-agent-service.js -> prompt-security-service.js',
  'private-agent-service.js -> published-ontology-agent-service.js',
  'private-agent-service.js -> semantic-context-service.js',
  'private-agent-service.js -> system-integration-service.js',
  'private-agent-service.js -> tenant-runtime-control-service.js',
  'private-agent-service.js -> zhinao-authorization-service.js',
  'procurement-service.js -> core-meta-object-service.js',
  'procurement-service.js -> risk-procurement-store.js',
  'published-ontology-agent-service.js -> agent-turn-understanding-service.js',
  'published-ontology-agent-service.js -> local-model-gateway.js',
  'published-ontology-agent-service.js -> meta-model-service.js',
  'published-ontology-agent-service.js -> semantic-record-contract-service.js',
  'published-ontology-agent-service.js -> system-integration-service.js',
  'request-identity-service.js -> identity-provider-service.js',
  'request-identity-service.js -> identity-session-service.js',
  'request-identity-service.js -> role-catalog-service.js',
  'risk-service.js -> mock-scenario-service.js',
  'role-catalog-service.js -> iam-store.js',
  'security-detection-service.js -> siem-event-export-service.js',
  'semantic-context-service.js -> agent-query-service.js',
  'semantic-inspection-schedule-service.js -> tenant-execution-context.js',
  'semantic-mapping-validation-service.js -> mock-scenario-service.js',
  'semantic-natural-schema-service.js -> local-model-gateway.js',
  'semantic-natural-schema-service.js -> prompt-security-service.js',
  // 阶段 4h（ADR-025）：受控对象链接与自然语言抽取同性质——调用模型网关 + 提示安全检查，
  // 且语义纪律相同（模型只给逐字证据、判定在服务端）。两条边与上一行同源，非新性质。
  'semantic-object-mention-service.js -> local-model-gateway.js',
  'semantic-object-mention-service.js -> prompt-security-service.js',
  'semantic-operations-agent-service.js -> local-model-gateway.js',
  'semantic-operations-agent-service.js -> meta-model-service.js',
  'semantic-operations-agent-service.js -> mock-onboarding-basis.js',
  'semantic-operations-agent-service.js -> multimodal-input-service.js',
  'semantic-operations-planner-service.js -> local-model-gateway.js',
  'semantic-operations-task-service.js -> agent-evidence-trace-service.js',
  'semantic-operations-task-service.js -> agent-turn-understanding-service.js',
  'semantic-operations-task-service.js -> local-model-gateway.js',
  'semantic-operations-task-service.js -> meta-model-service.js',
  'semantic-operations-task-service.js -> multimodal-input-service.js',
  'semantic-operations-task-service.js -> semantica-demo-bridge-service.js',
  'semantic-read-plan-proposal-service.js -> knowledge-answer-contract.js',
  'semantic-read-plan-proposal-service.js -> knowledge-answer-service.js',
  'semantic-read-plan-proposal-service.js -> knowledge-evidence-service.js',
  'semantic-read-plan-proposal-service.js -> local-model-gateway.js',
  'semantic-read-plan-proposal-service.js -> meta-model-service.js',
  'semantic-read-plan-proposal-service.js -> prompt-security-service.js',
  'semantic-read-plan-proposal-service.js -> read-plan-expression-codec.js',
  'semantic-read-plan-proposal-service.js -> read-plan-type-check.js',
  'semantic-source-discovery-service.js -> system-integration-service.js',
  'semantic-source-discovery-service.js -> system-registry-service.js',
  'semantica-demo-bridge-service.js -> mock-scenario-service.js',
  'semantica-demo-bridge-service.js -> semantic-instance-transport.js',
  'semantica-demo-bridge-service.js -> semantic-model-fingerprint.js',
  'semantica-demo-bridge-service.js -> semantic-tenant-context.js',
  'system-integration-service.js -> agent-query-plan-service.js',
  'system-integration-service.js -> agent-query-service.js',
  'system-integration-service.js -> mock-scenario-service.js',
  'system-integration-service.js -> semantic-record-contract-service.js',
  'system-registry-service.js -> semantic-tenant-context.js',
  'temporal-relation-service.js -> semantic-record-contract-service.js',
  'tenant-enrollment-contract.js -> iam-workspace-model.js',
  'tenant-execution-context.js -> iam-store.js',
  'tenant-execution-context.js -> semantic-tenant-context.js',
  'tenant-provisioning-preflight.js -> semantic-instance-transport.js',
  'tenant-provisioning-preflight.js -> semantic-tenant-context.js',
  'tenant-runtime-control-service.js -> iam-workspace-model.js',
  'visual-material-service.js -> local-model-gateway.js',
  'weknora-knowledge-provider.js -> agent-query-service.js',
  'weknora-knowledge-provider.js -> knowledge-evidence-service.js',
  'weknora-knowledge-provider.js -> prompt-security-service.js',
  'weknora-runtime-config.js -> knowledge-evidence-service.js',
  'world-model-template-service.js -> semantic-tenant-context.js',
  'world-model-template-service.js -> system-registry-service.js',
  // 阶段 8-5（ADR-028）：schema 发现候选消费系统登记文档提取文本，与
  // mock-onboarding-service -> semantic-material-workspace-service 同性质（组装依赖，非新领域耦合）。
  'semantic-material-workspace-service.js -> system-access-service.js',
  // 2026-10-07（系统接入监控 + 物料理解）：
  //   1) system-monitoring-service -> semantic-tenant-context（监控注册表按租户隔离存储，
  //      与 system-access/registry -> semantic-tenant-context 同性质：租户隔离设施）。
  //   2) system-material-service -> semantic-tenant-context（补充物料/理解缓存按租户隔离，同性质）。
  //   3) system-material-service -> local-model-gateway（大模型理解经模型网关 + 受控 fallback，
  //      与 semantic-object-mention -> local-model-gateway 同性质：模型网关消费方）。
  'system-monitoring-service.js -> semantic-tenant-context.js',
  'system-material-service.js -> semantic-tenant-context.js',
  'system-material-service.js -> local-model-gateway.js'
]);

// 服务文件按前缀归域的判定依据（与仓库既有命名一致）。
export const SERVICE_DOMAIN_PREFIXES = [
  'agent', 'anomaly', 'ark', 'assistant', 'audit', 'business', 'client', 'conversation', 'core', 'decision',
  'desktop', 'device', 'dingtalk', 'domain', 'enterprise', 'iam', 'identity', 'key', 'knowledge', 'local',
  'meta', 'mock', 'model', 'multimodal', 'permission', 'private', 'procurement', 'prompt', 'published',
  'read', 'request', 'risk', 'role', 'security', 'semantic', 'semantica', 'siem', 'system', 'temporal',
  'tenant', 'visual', 'weknora', 'workbuddy', 'world', 'zhinao'
];

// 文件规模上限：冻结当前最大值，阻止 God Service 继续增长。
// 计数口径与测试一致（source.split(/\r?\n/).length）。
export const SERVICE_FILE_LINE_CEILING = {
  // 2026-09-24：1207 → 1147。抽出会话意图与命令授权两个关注点后下行棘轮。
  'private-agent-service.js': 1147
};

// 跨工作区包（packages/* / apps/*）之间的相对路径 import 基线。
//
// 工作区依赖必须经 package.json + exports 声明（如 '@healthcare-ai/agent-ui'），
// 不允许用 '../../../frontend/src/...' 这类相对路径物理穿透到另一个包的私有源码。
// 原因：穿透会绕过 npm workspace 解析，使被依赖方的 private:true 与 exports 失效，
// 且依赖方的 package.json 与实际依赖不符；任何目录调整都会在构建期才暴露。
//
// 本基线 2026-09-24 冻结存量违规 8 处；2026-09-25 全部清偿，基线归零（下行棘轮）。
// 收敛方式：把被引用的组件与样式提升为 packages/agent-ui 并改为声明式依赖（ADR-010）。
// 详见 docs/architecture/MODULARIZATION_AUDIT.md。
export const CROSS_PACKAGE_IMPORT_BASELINE = new Set([]);

// 允许跨顶层区引用的「内容投放」白名单：非源码资产，由消费方显式读取，
// 且没有可用的包声明机制（packages exports 不适用于纯数据/内容文件）。
// 这不是边界违规，故不进入基线；新增此类需在此显式登记并说明理由。
export const CROSS_PACKAGE_CONTENT_ALLOWLIST = new Set([
  // 官网显式打包的公开文档内容，见 docs/guides/PRODUCT_PORTAL.md：
  // 「公开文档的受控来源…由官网显式打包，不向浏览器暴露整个 docs 目录」。
  'apps/product-portal/src/components/DocsCenter.vue -> ../../../../docs/public/product-docs.json',
  // 端到端样例 schema：仓库级 examples/ 是跨包共用的只读样例数据，
  // 非任何包的私有源码，且不参与构建产物。语义运营端用它与本体导入解析做契约对照。
  'apps/semantic-operations-console/test/read-plan-import.test.cjs -> ../../../examples/semantic-schemas/cross-channel-fulfillment/read-plan.mjs'
]);

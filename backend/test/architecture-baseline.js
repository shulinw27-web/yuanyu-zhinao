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
  simulation: 14
};

// 领域目录中不作为业务边界、不要求 public-api 的基础设施目录。
export const INFRASTRUCTURE_DOMAINS = new Set(['events']);

// 服务之间已存在的跨领域直接依赖（未走对方 public-api）。
// 现在冻结为基线；目标是逐条收敛为经 public-api 的调用。
//
// 2026-09-24 变更（private-agent-service 拆分解除一处 God Service）：
// 新增 6 条边 —— 两个抽取模块各自的新领域依赖，以及宿主服务到抽取模块的依赖。
// 这些边是把「单一 1206 行服务文件内的隐式依赖」显化为「模块间的显式依赖」，
// 不是新增领域耦合；后续拆解应继续复现同样的模式（先登记，再收敛）。
export const CROSS_DOMAIN_EDGE_BASELINE = new Set([
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
  'semantica-demo-bridge-service.js -> mock-scenario-service.js',
  'semantica-demo-bridge-service.js -> semantic-instance-transport.js',
  'semantica-demo-bridge-service.js -> semantic-model-fingerprint.js',
  'semantica-demo-bridge-service.js -> semantic-tenant-context.js',
  'system-integration-service.js -> agent-query-plan-service.js',
  'system-integration-service.js -> agent-query-service.js',
  'system-integration-service.js -> mock-scenario-service.js',
  'system-integration-service.js -> semantic-record-contract-service.js',
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
  'world-model-template-service.js -> semantic-tenant-context.js'
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
// 本基线冻结 2026-09-24 实测的存量违规（8 处，全部指向 frontend 的源码/样式），只允许下降。
// 收敛方向：把被引用的组件与样式提升为 packages/agent-ui 并改为声明式依赖。
// 详见 docs/architecture/MODULARIZATION_AUDIT.md。
export const CROSS_PACKAGE_IMPORT_BASELINE = new Set([
  'apps/semantic-operations-console/src/App.vue -> ../../../frontend/src/features/knowledge/KnowledgeLibraryPanel.vue',
  'apps/semantic-operations-console/src/App.vue -> ../../../frontend/src/features/meta-model/OAMetaModelStudio.vue',
  'apps/semantic-operations-console/src/App.vue -> ../../../frontend/src/features/meta-model/ontology-scenario.js',
  'apps/semantic-operations-console/src/main.js -> ../../../frontend/src/styles/main.css',
  'apps/semantic-operations-console/src/main.js -> ../../../frontend/src/styles/meta-model.css',
  'packages/agent-workbench/src/AgentWorkbench.vue -> ../../../frontend/src/features/agent/AnomalyAssistantPanel.vue',
  'packages/agent-workbench/src/AgentWorkbench.vue -> ../../../frontend/src/features/knowledge/KnowledgeLibraryPanel.vue',
  'packages/agent-workbench/src/AgentWorkbench.vue -> ../../../frontend/src/features/knowledge/MemoryReviewPanel.vue'
]);

// 允许跨顶层区引用的「内容投放」白名单：非源码资产，由消费方显式打包，
// 且没有可用的包声明机制（packages exports 不适用于 JSON 内容包）。
// 这不是边界违规，故不进入基线；新增此类需在此显式登记并说明理由。
export const CROSS_PACKAGE_CONTENT_ALLOWLIST = new Set([
  // 官网显式打包的公开文档内容，见 docs/guides/PRODUCT_PORTAL.md：
  // 「公开文档的受控来源…由官网显式打包，不向浏览器暴露整个 docs 目录」。
  'apps/product-portal/src/components/DocsCenter.vue -> ../../../../docs/public/product-docs.json'
]);

import { readDingTalkConfiguration } from './dingtalk-config.js';
import { readIdentityProviderConfiguration } from './identity-provider-config.js';

const allowedEnvironments = new Set(['development', 'test', 'production']);
const allowedStoreDrivers = new Set(['memory', 'sqlite']);
const allowedBrokerTypes = new Set(['projection', 'kafka', 'rabbitmq', 'webhook']);
const allowedIdentitySessionStoreDrivers = new Set(['runtime', 'postgres']);
const allowedIAMStoreDrivers = new Set(['runtime', 'postgres']);
const allowedRiskProcurementStoreDrivers = new Set(['runtime', 'postgres']);
const allowedAlertingStoreDrivers = new Set(['runtime', 'postgres']);
const allowedSimulationStoreDrivers = new Set(['runtime', 'postgres']);
const allowedSemanticGovernanceStoreDrivers = new Set(['runtime', 'postgres']);
const allowedAgentRuntimeTaskStoreDrivers = new Set(['sqlite', 'postgres']);
const allowedAgentRunStoreDrivers = new Set(['runtime', 'postgres']);
const allowedDomainEventStoreDrivers = new Set(['runtime', 'postgres']);
const allowedEvidenceTraceStoreDrivers = new Set(['runtime', 'postgres']);
const allowedAgentConversationStoreDrivers = new Set(['runtime', 'postgres']);
const allowedAgentLearningStoreDrivers = new Set(['runtime', 'postgres']);
const allowedAgentOrchestrationStoreDrivers = new Set(['runtime', 'postgres']);
const defaultOrigins = 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174,http://127.0.0.1:5175,http://localhost:5175,http://127.0.0.1:5184,http://localhost:5184';

const boundedInteger = (value, fallback, minimum, maximum, name, errors) => {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors.push(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
    return fallback;
  }
  return parsed;
};

export function loadRuntimeConfiguration(env = process.env) {
  const errors = [];
  const nodeEnv = String(env.NODE_ENV || 'development').trim().toLowerCase();
  if (!allowedEnvironments.has(nodeEnv)) errors.push('NODE_ENV 只能是 development、test 或 production。');
  const storeDriver = String(env.RUNTIME_STORE_DRIVER || 'sqlite').trim().toLowerCase();
  if (!allowedStoreDrivers.has(storeDriver)) errors.push('RUNTIME_STORE_DRIVER 只能是 memory 或 sqlite。');
  const brokerType = String(env.EVENT_BROKER_TYPE || 'projection').trim().toLowerCase();
  if (!allowedBrokerTypes.has(brokerType)) errors.push('EVENT_BROKER_TYPE 必须是 projection、kafka、rabbitmq 或 webhook。');
  const identitySessionStoreDriver = String(env.IDENTITY_SESSION_STORE_DRIVER || 'runtime').trim().toLowerCase();
  if (!allowedIdentitySessionStoreDrivers.has(identitySessionStoreDriver)) errors.push('IDENTITY_SESSION_STORE_DRIVER 必须是 runtime 或 postgres。');
  if (identitySessionStoreDriver === 'postgres') {
    let postgresUrl;
    try { postgresUrl = new URL(env.RUNTIME_POSTGRES_URL); } catch { errors.push('PostgreSQL 身份会话存储必须配置有效的 RUNTIME_POSTGRES_URL。'); }
    if (postgresUrl && !['postgres:', 'postgresql:'].includes(postgresUrl.protocol)) errors.push('RUNTIME_POSTGRES_URL 必须使用 postgresql://。');
    if (nodeEnv === 'production' && !['require', 'verify-ca', 'verify-full'].includes(postgresUrl?.searchParams.get('sslmode'))) errors.push('生产 PostgreSQL 连接必须设置 sslmode=require、verify-ca 或 verify-full。');
  }
  const iamStoreDriver = String(env.IAM_STORE_DRIVER || 'runtime').trim().toLowerCase();
  if (!allowedIAMStoreDrivers.has(iamStoreDriver)) errors.push('IAM_STORE_DRIVER 必须是 runtime 或 postgres。');
  if (iamStoreDriver === 'postgres') {
    let postgresUrl;
    try { postgresUrl = new URL(env.RUNTIME_POSTGRES_URL); } catch { errors.push('PostgreSQL IAM Store 必须配置有效的 RUNTIME_POSTGRES_URL。'); }
    if (postgresUrl && !['postgres:', 'postgresql:'].includes(postgresUrl.protocol)) errors.push('RUNTIME_POSTGRES_URL 必须使用 postgresql://。');
    const sslMode = String(env.RUNTIME_POSTGRES_SSL_MODE || postgresUrl?.searchParams.get('sslmode') || '').toLowerCase();
    if (nodeEnv === 'production' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) errors.push('生产 PostgreSQL IAM Store 连接必须配置 sslmode=require、verify-ca 或 verify-full。');
  }
  const riskProcurementStoreDriver = String(env.RISK_PROCUREMENT_STORE_DRIVER || 'runtime').trim().toLowerCase();
  if (!allowedRiskProcurementStoreDrivers.has(riskProcurementStoreDriver)) errors.push('RISK_PROCUREMENT_STORE_DRIVER 必须是 runtime 或 postgres。');
  if (riskProcurementStoreDriver === 'postgres') {
    let postgresUrl;
    try { postgresUrl = new URL(env.RUNTIME_POSTGRES_URL); } catch { errors.push('PostgreSQL Risk/Procurement Store 必须配置有效的 RUNTIME_POSTGRES_URL。'); }
    if (postgresUrl && !['postgres:', 'postgresql:'].includes(postgresUrl.protocol)) errors.push('RUNTIME_POSTGRES_URL 必须使用 postgresql://。');
    const sslMode = String(env.RUNTIME_POSTGRES_SSL_MODE || postgresUrl?.searchParams.get('sslmode') || '').toLowerCase();
    if (nodeEnv === 'production' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) errors.push('生产 PostgreSQL Risk/Procurement Store 连接必须配置 sslmode=require、verify-ca 或 verify-full。');
  }
  const alertingStoreDriver = String(env.ALERTING_STORE_DRIVER || 'runtime').trim().toLowerCase();
  if (!allowedAlertingStoreDrivers.has(alertingStoreDriver)) errors.push('ALERTING_STORE_DRIVER 必须是 runtime 或 postgres。');
  if (alertingStoreDriver === 'postgres') {
    let postgresUrl;
    try { postgresUrl = new URL(env.RUNTIME_POSTGRES_URL); } catch { errors.push('PostgreSQL Alerting Store 必须配置有效的 RUNTIME_POSTGRES_URL。'); }
    if (postgresUrl && !['postgres:', 'postgresql:'].includes(postgresUrl.protocol)) errors.push('RUNTIME_POSTGRES_URL 必须使用 postgresql://。');
    const sslMode = String(env.RUNTIME_POSTGRES_SSL_MODE || postgresUrl?.searchParams.get('sslmode') || '').toLowerCase();
    if (nodeEnv === 'production' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) errors.push('生产 PostgreSQL Alerting Store 连接必须配置 sslmode=require、verify-ca 或 verify-full。');
  }
  const simulationStoreDriver = String(env.SIMULATION_STORE_DRIVER || 'runtime').trim().toLowerCase();
  if (!allowedSimulationStoreDrivers.has(simulationStoreDriver)) errors.push('SIMULATION_STORE_DRIVER 必须是 runtime 或 postgres。');
  if (simulationStoreDriver === 'postgres') {
    let postgresUrl;
    try { postgresUrl = new URL(env.RUNTIME_POSTGRES_URL); } catch { errors.push('PostgreSQL Simulation Store 必须配置有效的 RUNTIME_POSTGRES_URL。'); }
    if (postgresUrl && !['postgres:', 'postgresql:'].includes(postgresUrl.protocol)) errors.push('RUNTIME_POSTGRES_URL 必须使用 postgresql://。');
    const sslMode = String(env.RUNTIME_POSTGRES_SSL_MODE || postgresUrl?.searchParams.get('sslmode') || '').toLowerCase();
    if (nodeEnv === 'production' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) errors.push('生产 PostgreSQL Simulation Store 连接必须配置 sslmode=require、verify-ca 或 verify-full。');
  }
  const semanticGovernanceStoreDriver = String(env.SEMANTIC_GOVERNANCE_STORE_DRIVER || 'runtime').trim().toLowerCase();
  if (!allowedSemanticGovernanceStoreDrivers.has(semanticGovernanceStoreDriver)) errors.push('SEMANTIC_GOVERNANCE_STORE_DRIVER 必须是 runtime 或 postgres。');
  if (semanticGovernanceStoreDriver === 'postgres') {
    let postgresUrl;
    try { postgresUrl = new URL(env.RUNTIME_POSTGRES_URL); } catch { errors.push('PostgreSQL Semantic Governance Store 必须配置有效的 RUNTIME_POSTGRES_URL。'); }
    if (postgresUrl && !['postgres:', 'postgresql:'].includes(postgresUrl.protocol)) errors.push('RUNTIME_POSTGRES_URL 必须使用 postgresql://。');
    const sslMode = String(env.RUNTIME_POSTGRES_SSL_MODE || postgresUrl?.searchParams.get('sslmode') || '').toLowerCase();
    if (nodeEnv === 'production' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) errors.push('生产 PostgreSQL Semantic Governance Store 连接必须配置 sslmode=require、verify-ca 或 verify-full。');
  }
  const agentRuntimeTaskStoreDriver = String(env.AGENT_RUNTIME_TASK_STORE_DRIVER || 'sqlite').trim().toLowerCase();
  const agentRunStoreDriver = String(env.AGENT_RUN_STORE_DRIVER || 'runtime').trim().toLowerCase();
  const domainEventStoreDriver = String(env.DOMAIN_EVENT_STORE_DRIVER || 'runtime').trim().toLowerCase();
  const evidenceTraceStoreDriver = String(env.EVIDENCE_TRACE_STORE_DRIVER || 'runtime').trim().toLowerCase();
  const agentConversationStoreDriver = String(env.AGENT_CONVERSATION_STORE_DRIVER || 'runtime').trim().toLowerCase();
  const agentLearningStoreDriver = String(env.AGENT_LEARNING_STORE_DRIVER || 'runtime').trim().toLowerCase();
  const agentOrchestrationStoreDriver = String(env.AGENT_ORCHESTRATION_STORE_DRIVER || 'runtime').trim().toLowerCase();
  if (!allowedAgentRuntimeTaskStoreDrivers.has(agentRuntimeTaskStoreDriver)) errors.push('AGENT_RUNTIME_TASK_STORE_DRIVER 必须是 sqlite 或 postgres。');
  if (!allowedAgentRunStoreDrivers.has(agentRunStoreDriver)) errors.push('AGENT_RUN_STORE_DRIVER 必须是 runtime 或 postgres。');
  if (!allowedDomainEventStoreDrivers.has(domainEventStoreDriver)) errors.push('DOMAIN_EVENT_STORE_DRIVER 必须是 runtime 或 postgres。');
  if (!allowedEvidenceTraceStoreDrivers.has(evidenceTraceStoreDriver)) errors.push('EVIDENCE_TRACE_STORE_DRIVER 必须是 runtime 或 postgres。');
  if (!allowedAgentConversationStoreDrivers.has(agentConversationStoreDriver)) errors.push('AGENT_CONVERSATION_STORE_DRIVER 必须是 runtime 或 postgres。');
  if (!allowedAgentLearningStoreDrivers.has(agentLearningStoreDriver)) errors.push('AGENT_LEARNING_STORE_DRIVER 必须是 runtime 或 postgres。');
  if (!allowedAgentOrchestrationStoreDrivers.has(agentOrchestrationStoreDriver)) errors.push('AGENT_ORCHESTRATION_STORE_DRIVER 必须是 runtime 或 postgres。');
  if (nodeEnv === 'production' && iamStoreDriver === 'postgres' && domainEventStoreDriver !== 'postgres') errors.push('生产 PostgreSQL IAM Store 必须同时设置 DOMAIN_EVENT_STORE_DRIVER=postgres，保证权限变更 Outbox 可发布。');
  if (nodeEnv === 'production' && riskProcurementStoreDriver === 'postgres' && domainEventStoreDriver !== 'postgres') errors.push('生产 PostgreSQL Risk/Procurement Store 必须同时设置 DOMAIN_EVENT_STORE_DRIVER=postgres，保证业务事件 Outbox 可发布。');
  if (nodeEnv === 'production' && alertingStoreDriver === 'postgres' && domainEventStoreDriver !== 'postgres') errors.push('生产 PostgreSQL Alerting Store 必须同时设置 DOMAIN_EVENT_STORE_DRIVER=postgres，保证告警事件 Outbox 可发布。');
  if (nodeEnv === 'production' && semanticGovernanceStoreDriver === 'postgres' && domainEventStoreDriver !== 'postgres') errors.push('生产 PostgreSQL Semantic Governance Store 必须同时设置 DOMAIN_EVENT_STORE_DRIVER=postgres，保证语义版本发布 Outbox 可发布。');
  if (agentRuntimeTaskStoreDriver === 'postgres') {
    let postgresUrl;
    try { postgresUrl = new URL(env.RUNTIME_POSTGRES_URL); } catch { errors.push('PostgreSQL 长任务存储必须配置有效的 RUNTIME_POSTGRES_URL。'); }
    if (postgresUrl && !['postgres:', 'postgresql:'].includes(postgresUrl.protocol)) errors.push('RUNTIME_POSTGRES_URL 必须使用 postgresql://。');
    const sslMode = String(env.RUNTIME_POSTGRES_SSL_MODE || postgresUrl?.searchParams.get('sslmode') || '').toLowerCase();
    if (nodeEnv === 'production' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) errors.push('生产 PostgreSQL 长任务连接必须配置 sslmode=require、verify-ca 或 verify-full。');
    if (nodeEnv === 'production' && agentRunStoreDriver !== 'postgres' && env.SINGLE_NODE_DEPLOYMENT !== 'true') errors.push('Agent Run 未使用 PostgreSQL 时，长任务 PostgreSQL 混合模式仅允许 SINGLE_NODE_DEPLOYMENT=true。');
    if (nodeEnv === 'production' && env.AGENT_RUN_TRANSITION_CONSUMER_ENABLED !== 'true') errors.push('生产长任务 PostgreSQL 模式必须启用 AGENT_RUN_TRANSITION_CONSUMER_ENABLED=true。');
  }
  if (agentRunStoreDriver === 'postgres') {
    let postgresUrl;
    try { postgresUrl = new URL(env.RUNTIME_POSTGRES_URL); } catch { errors.push('PostgreSQL Agent Run 存储必须配置有效的 RUNTIME_POSTGRES_URL。'); }
    if (postgresUrl && !['postgres:', 'postgresql:'].includes(postgresUrl.protocol)) errors.push('RUNTIME_POSTGRES_URL 必须使用 postgresql://。');
    const sslMode = String(env.RUNTIME_POSTGRES_SSL_MODE || postgresUrl?.searchParams.get('sslmode') || '').toLowerCase();
    if (nodeEnv === 'production' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) errors.push('生产 PostgreSQL Agent Run 连接必须配置 sslmode=require、verify-ca 或 verify-full。');
    if (nodeEnv === 'production' && agentRuntimeTaskStoreDriver !== 'postgres') errors.push('生产多节点 Agent Run PostgreSQL 模式必须同时设置 AGENT_RUNTIME_TASK_STORE_DRIVER=postgres。');
    if (nodeEnv === 'production' && domainEventStoreDriver !== 'postgres') errors.push('生产 Agent Run PostgreSQL 模式必须同时设置 DOMAIN_EVENT_STORE_DRIVER=postgres，保证执行结果 Outbox 可发布。');
  }
  if (domainEventStoreDriver === 'postgres') {
    let postgresUrl;
    try { postgresUrl = new URL(env.RUNTIME_POSTGRES_URL); } catch { errors.push('PostgreSQL Domain Event Store 必须配置有效的 RUNTIME_POSTGRES_URL。'); }
    if (postgresUrl && !['postgres:', 'postgresql:'].includes(postgresUrl.protocol)) errors.push('RUNTIME_POSTGRES_URL 必须使用 postgresql://。');
    const sslMode = String(env.RUNTIME_POSTGRES_SSL_MODE || postgresUrl?.searchParams.get('sslmode') || '').toLowerCase();
    if (nodeEnv === 'production' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) errors.push('生产 PostgreSQL Domain Event Store 连接必须配置 sslmode=require、verify-ca 或 verify-full。');
  }
  if (evidenceTraceStoreDriver === 'postgres') {
    let postgresUrl;
    try { postgresUrl = new URL(env.RUNTIME_POSTGRES_URL); } catch { errors.push('PostgreSQL Evidence Trace Store 必须配置有效的 RUNTIME_POSTGRES_URL。'); }
    if (postgresUrl && !['postgres:', 'postgresql:'].includes(postgresUrl.protocol)) errors.push('RUNTIME_POSTGRES_URL 必须使用 postgresql://。');
    const sslMode = String(env.RUNTIME_POSTGRES_SSL_MODE || postgresUrl?.searchParams.get('sslmode') || '').toLowerCase();
    if (nodeEnv === 'production' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) errors.push('生产 PostgreSQL Evidence Trace Store 连接必须配置 sslmode=require、verify-ca 或 verify-full。');
  }
  if (agentConversationStoreDriver === 'postgres') {
    let postgresUrl;
    try { postgresUrl = new URL(env.RUNTIME_POSTGRES_URL); } catch { errors.push('PostgreSQL Agent Conversation Store 必须配置有效的 RUNTIME_POSTGRES_URL。'); }
    if (postgresUrl && !['postgres:', 'postgresql:'].includes(postgresUrl.protocol)) errors.push('RUNTIME_POSTGRES_URL 必须使用 postgresql://。');
    const sslMode = String(env.RUNTIME_POSTGRES_SSL_MODE || postgresUrl?.searchParams.get('sslmode') || '').toLowerCase();
    if (nodeEnv === 'production' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) errors.push('生产 PostgreSQL Agent Conversation Store 连接必须配置 sslmode=require、verify-ca 或 verify-full。');
  }
  if (agentLearningStoreDriver === 'postgres') {
    let postgresUrl;
    try { postgresUrl = new URL(env.RUNTIME_POSTGRES_URL); } catch { errors.push('PostgreSQL Agent Learning Store 必须配置有效的 RUNTIME_POSTGRES_URL。'); }
    if (postgresUrl && !['postgres:', 'postgresql:'].includes(postgresUrl.protocol)) errors.push('RUNTIME_POSTGRES_URL 必须使用 postgresql://。');
    const sslMode = String(env.RUNTIME_POSTGRES_SSL_MODE || postgresUrl?.searchParams.get('sslmode') || '').toLowerCase();
    if (nodeEnv === 'production' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) errors.push('生产 PostgreSQL Agent Learning Store 连接必须配置 sslmode=require、verify-ca 或 verify-full。');
  }
  if (agentOrchestrationStoreDriver === 'postgres') {
    let postgresUrl;
    try { postgresUrl = new URL(env.RUNTIME_POSTGRES_URL); } catch { errors.push('PostgreSQL Agent Orchestration Store 必须配置有效的 RUNTIME_POSTGRES_URL。'); }
    if (postgresUrl && !['postgres:', 'postgresql:'].includes(postgresUrl.protocol)) errors.push('RUNTIME_POSTGRES_URL 必须使用 postgresql://。');
    const sslMode = String(env.RUNTIME_POSTGRES_SSL_MODE || postgresUrl?.searchParams.get('sslmode') || '').toLowerCase();
    if (nodeEnv === 'production' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) errors.push('生产 PostgreSQL Agent Orchestration Store 连接必须配置 sslmode=require、verify-ca 或 verify-full。');
  }
  if (brokerType === 'webhook') {
    let webhookUrl;
    try { webhookUrl = new URL(env.EVENT_WEBHOOK_URL); } catch { errors.push('Webhook Broker 必须配置有效的 EVENT_WEBHOOK_URL。'); }
    if (!env.EVENT_WEBHOOK_SIGNING_SECRET || String(env.EVENT_WEBHOOK_SIGNING_SECRET).length < 16) errors.push('Webhook Broker 的签名密钥至少需要 16 个字符。');
    if (nodeEnv === 'production' && webhookUrl?.protocol !== 'https:') errors.push('生产 Webhook Broker 必须使用 HTTPS。');
  }
  if (brokerType === 'kafka' && (!String(env.EVENT_KAFKA_BROKERS || '').trim() || !String(env.EVENT_KAFKA_TOPIC || '').trim())) errors.push('Kafka Broker 必须配置 EVENT_KAFKA_BROKERS 和 EVENT_KAFKA_TOPIC。');
  if (brokerType === 'rabbitmq') {
    let rabbitUrl;
    try { rabbitUrl = new URL(env.EVENT_RABBITMQ_URL); } catch { errors.push('RabbitMQ Broker 必须配置有效的 EVENT_RABBITMQ_URL。'); }
    if (rabbitUrl && !['amqp:', 'amqps:'].includes(rabbitUrl.protocol)) errors.push('EVENT_RABBITMQ_URL 必须使用 amqp:// 或 amqps://。');
    if (nodeEnv === 'production' && rabbitUrl?.protocol !== 'amqps:') errors.push('生产 RabbitMQ Broker 必须使用 AMQPS。');
  }
  const corsOrigins = String(env.CORS_ALLOWED_ORIGINS || defaultOrigins).split(',').map((item) => item.trim()).filter(Boolean);
  if (!corsOrigins.length || corsOrigins.includes('*')) errors.push('CORS_ALLOWED_ORIGINS 必须配置明确来源且不能使用通配符。');
  const port = boundedInteger(env.PORT, 3001, 1, 65535, 'PORT', errors);
  const maxBodyBytes = boundedInteger(env.API_MAX_BODY_BYTES, 18 * 1024 * 1024, 1024 * 1024, 25 * 1024 * 1024, 'API_MAX_BODY_BYTES', errors);

  let identityConfiguration;
  try { identityConfiguration = readIdentityProviderConfiguration(env); }
  catch { errors.push('IDENTITY_PROVIDERS_FILE 身份源配置无效。'); }
  if (nodeEnv === 'production') {
    if (env.DEMO_ALLOW_ROLE_HEADER !== 'false') errors.push('生产环境必须设置 DEMO_ALLOW_ROLE_HEADER=false。');
    if (!identityConfiguration && (String(env.OA_AUTH_MODE || 'mock') === 'mock' || String(env.ACCOUNT_AUTH_MODE || 'mock') === 'mock')) errors.push('生产环境必须配置企业身份源，禁止 Mock 登录。');
    if (identityConfiguration && !identityConfiguration.providers.some((item) => item.enabled)) errors.push('生产环境至少需要一个启用的身份源。');
    if (identityConfiguration ? identityConfiguration.providers.some((item) => item.type === 'dingtalk' && item.enabled) : env.OA_AUTH_MODE === 'dingtalk') {
      try {
        const config = readDingTalkConfiguration(env);
        if (!config.allowedOrigins.every((origin) => corsOrigins.includes(origin))) errors.push('钉钉入口来源必须同时加入 CORS_ALLOWED_ORIGINS。');
        if (env.SINGLE_NODE_DEPLOYMENT !== 'true') errors.push('钉钉登录挑战当前要求 SINGLE_NODE_DEPLOYMENT=true；多节点需共享挑战存储。');
      } catch { errors.push('生产钉钉身份源必须启用并提供有效的服务端钉钉配置。'); }
    } else if (!identityConfiguration) {
      if (!env.OIDC_ISSUER || !env.OIDC_AUDIENCE || !env.OIDC_JWKS_URI || !env.OIDC_TENANT_ID) errors.push('生产环境必须配置 OIDC_ISSUER、OIDC_AUDIENCE、OIDC_JWKS_URI 和 OIDC_TENANT_ID。');
      try {
        if (new URL(env.OIDC_ISSUER).protocol !== 'https:' || new URL(env.OIDC_JWKS_URI).protocol !== 'https:') errors.push('生产 OIDC issuer 与 JWKS URI 必须使用 HTTPS。');
      } catch { errors.push('生产 OIDC issuer 或 JWKS URI 格式无效。'); }
    }
    if (String(env.AGENT_RUNTIME_MODE || 'mock') === 'mock') errors.push('生产环境禁止 AGENT_RUNTIME_MODE=mock。');
    if (storeDriver === 'memory') errors.push('生产环境禁止使用 memory Runtime Store。');
    if (storeDriver === 'sqlite' && env.SINGLE_NODE_DEPLOYMENT !== 'true') errors.push('生产使用 SQLite 时必须明确设置 SINGLE_NODE_DEPLOYMENT=true；多节点应迁移 PostgreSQL。');
    if (String(env.KEY_CENTER_PROVIDER || 'demo-kms') === 'demo-kms') errors.push('生产环境必须配置真实 KMS/HSM Provider。');
    try {
      if (new URL(env.KEY_CENTER_PROVIDER_URL).protocol !== 'https:') errors.push('生产远程凭据 Provider 必须使用 HTTPS。');
    } catch { errors.push('生产环境必须配置有效的 KEY_CENTER_PROVIDER_URL。'); }
    if (!String(env.KEY_CENTER_WORKLOAD_ID || '').trim()) errors.push('生产环境必须配置 KEY_CENTER_WORKLOAD_ID。');
    if (!env.CORS_ALLOWED_ORIGINS) errors.push('生产环境必须显式配置 CORS_ALLOWED_ORIGINS。');
  }
  if (errors.length) {
    const error = new Error(`运行配置校验失败：${errors.join(' ')}`);
    error.code = 'RUNTIME_CONFIGURATION_INVALID';
    throw error;
  }
  return Object.freeze({ nodeEnv, host: String(env.API_HOST || '127.0.0.1'), port, maxBodyBytes, corsOrigins: Object.freeze(corsOrigins), storeDriver, identitySessionStoreDriver, iamStoreDriver, riskProcurementStoreDriver, alertingStoreDriver, simulationStoreDriver, semanticGovernanceStoreDriver, agentRuntimeTaskStoreDriver, agentRunStoreDriver, domainEventStoreDriver, evidenceTraceStoreDriver, agentConversationStoreDriver, agentLearningStoreDriver, agentOrchestrationStoreDriver, brokerType });
}

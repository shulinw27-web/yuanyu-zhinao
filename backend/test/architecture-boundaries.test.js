import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfiguration } from '../src/config/runtime-config.js';
import { createHttpCompletionRecord } from '../src/observability/structured-logger.js';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const readWorkspaceFile = (path) => readFile(resolve(workspaceRoot, path), 'utf8');

test('HTTP 路由只能依赖领域 public-api，不得重新穿透扁平服务层', async () => {
  const routeDirectory = resolve(workspaceRoot, 'backend/src/routes');
  const routeFiles = (await readdir(routeDirectory)).filter((name) => name.endsWith('.js'));
  assert.ok(routeFiles.length >= 10);
  for (const routeFile of routeFiles) {
    const source = await readFile(resolve(routeDirectory, routeFile), 'utf8');
    assert.doesNotMatch(source, /from ['"]\.\.\/(?:services|data|repositories)\//, `${routeFile} 绕过了领域公共入口`);
  }
});

test('后端 app 保持组合根职责且不重新承载业务路由', async () => {
  const source = await readWorkspaceFile('backend/src/app.js');
  assert.equal(source.split(/\r?\n/).length <= 140, true);
  assert.doesNotMatch(source, /url\.pathname === ['"]\/api\/(?:risk|agent|simulation|procurement)/);
  assert.match(source, /routeHandlers/);
  assert.ok(source.lastIndexOf("'/api/health/live'") < source.lastIndexOf('return runWithIAMStoreContext'));
});

test('前端组合组件通过页面注册表和动作控制器组织业务', async () => {
  const source = await readWorkspaceFile('frontend/src/App.vue');
  assert.match(source, /createAppActions/);
  assert.match(source, /fetchPageData/);
  assert.doesNotMatch(source, /async function (?:chooseRisk|executeProcurement|runSimulationScenario)/);
  assert.equal(source.split(/\r?\n/).length <= 450, true);
  const actionComposition = await readWorkspaceFile('frontend/src/app-actions.js');
  assert.match(actionComposition, /createRiskProcurementActions/);
  assert.match(actionComposition, /createAdministrationActions/);
  assert.equal(actionComposition.split(/\r?\n/).length <= 30, true);
});

test('运行配置集中校验并阻止生产环境携带 Demo 安全开关启动', () => {
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'memory' }).storeDriver, 'memory');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', RUNTIME_STORE_DRIVER: 'postgres' }), /memory 或 sqlite/);
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', IDENTITY_SESSION_STORE_DRIVER: 'postgres' }), /RUNTIME_POSTGRES_URL/);
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'development', IDENTITY_SESSION_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://localhost/agent_platform' }).identitySessionStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', IAM_STORE_DRIVER: 'postgres' }), /RUNTIME_POSTGRES_URL/);
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'development', IAM_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://localhost/agent_platform' }).iamStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', RISK_PROCUREMENT_STORE_DRIVER: 'postgres' }), /RUNTIME_POSTGRES_URL/);
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'development', RISK_PROCUREMENT_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://localhost/agent_platform' }).riskProcurementStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', ALERTING_STORE_DRIVER: 'postgres' }), /RUNTIME_POSTGRES_URL/);
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'development', ALERTING_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://localhost/agent_platform' }).alertingStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', SIMULATION_STORE_DRIVER: 'postgres' }), /RUNTIME_POSTGRES_URL/);
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'development', SIMULATION_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://localhost/agent_platform' }).simulationStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', SEMANTIC_GOVERNANCE_STORE_DRIVER: 'postgres' }), /RUNTIME_POSTGRES_URL/);
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'development', SEMANTIC_GOVERNANCE_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://localhost/agent_platform' }).semanticGovernanceStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', AGENT_RUNTIME_TASK_STORE_DRIVER: 'postgres' }), /RUNTIME_POSTGRES_URL/);
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'development', AGENT_RUNTIME_TASK_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://localhost/agent_platform' }).agentRuntimeTaskStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', AGENT_RUN_STORE_DRIVER: 'postgres' }), /RUNTIME_POSTGRES_URL/);
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'development', AGENT_RUN_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://localhost/agent_platform' }).agentRunStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', DOMAIN_EVENT_STORE_DRIVER: 'postgres' }), /RUNTIME_POSTGRES_URL/);
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'development', DOMAIN_EVENT_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://localhost/agent_platform' }).domainEventStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', EVIDENCE_TRACE_STORE_DRIVER: 'postgres' }), /RUNTIME_POSTGRES_URL/);
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'development', EVIDENCE_TRACE_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://localhost/agent_platform' }).evidenceTraceStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', AGENT_CONVERSATION_STORE_DRIVER: 'postgres' }), /RUNTIME_POSTGRES_URL/);
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'development', AGENT_CONVERSATION_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://localhost/agent_platform' }).agentConversationStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', AGENT_LEARNING_STORE_DRIVER: 'postgres' }), /RUNTIME_POSTGRES_URL/);
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'development', AGENT_LEARNING_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://localhost/agent_platform' }).agentLearningStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'development', AGENT_ORCHESTRATION_STORE_DRIVER: 'postgres' }), /RUNTIME_POSTGRES_URL/);
  assert.equal(loadRuntimeConfiguration({ NODE_ENV: 'development', AGENT_ORCHESTRATION_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://localhost/agent_platform' }).agentOrchestrationStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({ NODE_ENV: 'production', DEMO_ALLOW_ROLE_HEADER: 'true' }), /生产环境/);
  const productionBase = {
    NODE_ENV: 'production', DEMO_ALLOW_ROLE_HEADER: 'false', OA_AUTH_MODE: 'oidc', ACCOUNT_AUTH_MODE: 'enterprise',
    OIDC_ISSUER: 'https://sso.example.test', OIDC_AUDIENCE: 'healthcare-ai', OIDC_JWKS_URI: 'https://sso.example.test/jwks', OIDC_TENANT_ID: 'tenant-enterprise',
    AGENT_RUNTIME_MODE: 'local', KEY_CENTER_PROVIDER: 'external-kms', KEY_CENTER_PROVIDER_URL: 'https://kms-broker.example.test', KEY_CENTER_WORKLOAD_ID: 'agent-api', RUNTIME_STORE_DRIVER: 'sqlite', SINGLE_NODE_DEPLOYMENT: 'true',
    CORS_ALLOWED_ORIGINS: 'https://app.example.test'
  };
  const production = loadRuntimeConfiguration(productionBase);
  assert.equal(production.nodeEnv, 'production');
  assert.equal(production.corsOrigins.includes('*'), false);
  assert.throws(() => loadRuntimeConfiguration({
    ...productionBase, AGENT_RUN_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://db.example.test/agent?sslmode=verify-full'
  }), /AGENT_RUNTIME_TASK_STORE_DRIVER=postgres.*DOMAIN_EVENT_STORE_DRIVER=postgres/);
  const productionAgentRun = loadRuntimeConfiguration({
    ...productionBase, AGENT_RUN_STORE_DRIVER: 'postgres', AGENT_RUNTIME_TASK_STORE_DRIVER: 'postgres', DOMAIN_EVENT_STORE_DRIVER: 'postgres',
    AGENT_RUN_TRANSITION_CONSUMER_ENABLED: 'true', RUNTIME_POSTGRES_URL: 'postgresql://db.example.test/agent?sslmode=verify-full'
  });
  assert.equal(productionAgentRun.agentRunStoreDriver, 'postgres');
  assert.equal(productionAgentRun.domainEventStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({
    ...productionBase, IAM_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://db.example.test/agent?sslmode=verify-full'
  }), /DOMAIN_EVENT_STORE_DRIVER=postgres/);
  const productionIAM = loadRuntimeConfiguration({
    ...productionBase, IAM_STORE_DRIVER: 'postgres', DOMAIN_EVENT_STORE_DRIVER: 'postgres',
    RUNTIME_POSTGRES_URL: 'postgresql://db.example.test/agent?sslmode=verify-full'
  });
  assert.equal(productionIAM.iamStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({
    ...productionBase, RISK_PROCUREMENT_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://db.example.test/agent?sslmode=verify-full'
  }), /DOMAIN_EVENT_STORE_DRIVER=postgres/);
  const productionRiskProcurement = loadRuntimeConfiguration({
    ...productionBase, RISK_PROCUREMENT_STORE_DRIVER: 'postgres', DOMAIN_EVENT_STORE_DRIVER: 'postgres',
    RUNTIME_POSTGRES_URL: 'postgresql://db.example.test/agent?sslmode=verify-full'
  });
  assert.equal(productionRiskProcurement.riskProcurementStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({
    ...productionBase, ALERTING_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://db.example.test/agent?sslmode=verify-full'
  }), /DOMAIN_EVENT_STORE_DRIVER=postgres/);
  const productionAlerting = loadRuntimeConfiguration({
    ...productionBase, ALERTING_STORE_DRIVER: 'postgres', DOMAIN_EVENT_STORE_DRIVER: 'postgres',
    RUNTIME_POSTGRES_URL: 'postgresql://db.example.test/agent?sslmode=verify-full'
  });
  assert.equal(productionAlerting.alertingStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({
    ...productionBase, SEMANTIC_GOVERNANCE_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://db.example.test/agent?sslmode=verify-full'
  }), /DOMAIN_EVENT_STORE_DRIVER=postgres/);
  const productionSemanticGovernance = loadRuntimeConfiguration({
    ...productionBase, SEMANTIC_GOVERNANCE_STORE_DRIVER: 'postgres', DOMAIN_EVENT_STORE_DRIVER: 'postgres',
    RUNTIME_POSTGRES_URL: 'postgresql://db.example.test/agent?sslmode=verify-full'
  });
  assert.equal(productionSemanticGovernance.semanticGovernanceStoreDriver, 'postgres');
  assert.throws(() => loadRuntimeConfiguration({
    NODE_ENV: 'production', DEMO_ALLOW_ROLE_HEADER: 'false', OA_AUTH_MODE: 'oidc', ACCOUNT_AUTH_MODE: 'enterprise',
    OIDC_ISSUER: 'https://sso.example.test', OIDC_AUDIENCE: 'healthcare-ai', OIDC_JWKS_URI: 'https://sso.example.test/jwks', OIDC_TENANT_ID: 'tenant-enterprise',
    AGENT_RUNTIME_MODE: 'local', KEY_CENTER_PROVIDER: 'external-kms', KEY_CENTER_PROVIDER_URL: 'https://kms-broker.example.test', KEY_CENTER_WORKLOAD_ID: 'agent-api', RUNTIME_STORE_DRIVER: 'sqlite',
    CORS_ALLOWED_ORIGINS: 'https://app.example.test', AGENT_RUNTIME_TASK_STORE_DRIVER: 'postgres', RUNTIME_POSTGRES_URL: 'postgresql://db.example.test/agent?sslmode=verify-full', AGENT_RUN_TRANSITION_CONSUMER_ENABLED: 'true'
  }), /SINGLE_NODE_DEPLOYMENT/);
});

test('结构化 HTTP 日志不采集请求体、认证头或查询参数', () => {
  const record = createHttpCompletionRecord({
    req: { method: 'POST', url: '/api/agent/message?token=secret', headers: { authorization: 'Bearer secret', 'x-client-platform': 'web' }, body: { text: 'private prompt' } },
    res: { requestId: 'req-1', statusCode: 200 }, startedAt: 100, now: 125
  });
  assert.equal(record.path, '/api/agent/message');
  assert.equal(record.durationMs, 25);
  assert.equal(JSON.stringify(record).includes('secret'), false);
  assert.equal(JSON.stringify(record).includes('private prompt'), false);
});

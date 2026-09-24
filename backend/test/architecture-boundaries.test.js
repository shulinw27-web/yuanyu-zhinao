import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfiguration } from '../src/config/runtime-config.js';
import { createHttpCompletionRecord } from '../src/observability/structured-logger.js';
import {
  CROSS_DOMAIN_EDGE_BASELINE,
  CROSS_PACKAGE_CONTENT_ALLOWLIST,
  CROSS_PACKAGE_IMPORT_BASELINE,
  DOMAIN_EXPORT_CEILING,
  INFRASTRUCTURE_DOMAINS,
  SERVICE_DOMAIN_PREFIXES,
  SERVICE_FILE_LINE_CEILING
} from './architecture-baseline.js';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

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

// 领域公共入口的导出是「契约面」，不是「重导出管道」。
// 计数采用棘轮（ratchet）：冻结当前基线，只允许下降，不允许增长。
// 收敛目标为 ≤15；某域降到目标后请同步下调基线（见 architecture-baseline.js）。
const countDomainExports = (source) => {
  let count = 0;
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    count += match[1].split(',').map((name) => name.trim()).filter(Boolean).length;
  }
  for (const _ of source.matchAll(/export\s+(?:async\s+)?(?:const|let|function|class)\s+[A-Za-z0-9_$]+/g)) count += 1;
  return count;
};

test('领域 public-api 导出规模不超过已登记基线（只降不升）', async () => {
  const domainsRoot = resolve(workspaceRoot, 'backend/src/domains');
  const domainNames = (await readdir(domainsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !INFRASTRUCTURE_DOMAINS.has(entry.name))
    .map((entry) => entry.name);
  assert.ok(domainNames.length >= 8);
  for (const domain of domainNames) {
    const source = await readFile(resolve(domainsRoot, domain, 'public-api.js'), 'utf8');
    const ceiling = DOMAIN_EXPORT_CEILING[domain];
    assert.ok(Number.isInteger(ceiling), `领域 ${domain} 未登记导出基线，新增领域需同步登记`);
    const actual = countDomainExports(source);
    assert.ok(actual <= ceiling, `${domain} 导出 ${actual} 项，超过基线 ${ceiling}；请拆分领域或确认后才提升基线`);
  }
});

// 服务之间的横向调用应经对方 public-api，不得直接 import 内部文件。
// 已存在的跨领域边在 architecture-baseline.js 冻结；棘轮只减不增。
test('服务之间跨领域依赖不得超出已登记基线（只降不升）', async () => {
  const servicesRoot = resolve(workspaceRoot, 'backend/src/services');
  const serviceFiles = (await readdir(servicesRoot)).filter((name) => name.endsWith('.js'));
  const unregistered = [];
  const discovered = new Set();
  for (const serviceFile of serviceFiles) {
    const source = await readFile(resolve(servicesRoot, serviceFile), 'utf8');
    const own = SERVICE_DOMAIN_PREFIXES.find((prefix) => serviceFile.startsWith(`${prefix}-`));
    if (!own) continue;
    for (const match of source.matchAll(/from ['"]\.\/([a-z0-9-]+)\.js['"]/g)) {
      const target = match[1];
      const targetDomain = SERVICE_DOMAIN_PREFIXES.find((prefix) => target.startsWith(`${prefix}-`));
      if (!targetDomain || targetDomain === own) continue;
      const signature = `${serviceFile} -> ${target}.js`;
      discovered.add(signature);
      if (!CROSS_DOMAIN_EDGE_BASELINE.has(signature)) unregistered.push(signature);
    }
  }
  assert.deepEqual(unregistered, [], `检测到未登记的跨领域服务依赖：\n${unregistered.join('\n')}`);
  const resolved = [...CROSS_DOMAIN_EDGE_BASELINE].filter((edge) => !discovered.has(edge));
  assert.deepEqual(resolved, [], `以下基线依赖已解除，请下调 architecture-baseline.js：\n${resolved.join('\n')}`);
});

test('服务文件规模不超过已登记上限，阻止 God Service 继续膨胀', async () => {
  const servicesRoot = resolve(workspaceRoot, 'backend/src/services');
  for (const [fileName, ceiling] of Object.entries(SERVICE_FILE_LINE_CEILING)) {
    const source = await readFile(resolve(servicesRoot, fileName), 'utf8');
    const lines = source.split(/\r?\n/).length;
    assert.ok(lines <= ceiling, `${fileName} 已达 ${lines} 行，超过上限 ${ceiling}；请拆分而非继续叠加`);
  }
});

test('核心实体投影表与运行时 JSON 存储保持字段一致，且不得早于退出条件被删除', async () => {
  const migration = await readWorkspaceFile('backend/migrations/postgres/005_core_entity_projection.sql');
  const repository = await readWorkspaceFile('backend/src/repositories/runtime-state-repository.js');
  // 投影是「附加」而非「替换」：唯一事实源仍必须是 JSON blob 表。
  assert.match(repository, /CREATE TABLE IF NOT EXISTS runtime_state/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS agent_runs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS agent_evidence_traces/);
  // 投影必须覆盖 Agent Run 的全部状态取值，否则状态转换会被 CHECK 拒绝。
  const recordedStatuses = [...new Set([...repository.matchAll(/status = '([a-z_]+)'/g)].map((match) => match[1]))];
  const runStatuses = [...new Set([...migration.matchAll(/'([a-z_]{4,})'/g)].map((match) => match[1]))];
  for (const status of recordedStatuses) {
    assert.ok(runStatuses.includes(status), `投影表缺少运行时状态 '${status}' 的 CHECK 约束；请同步迁移与状态机`);
  }
  // 触发器必须存在，否则显式列会静默过期。
  assert.match(migration, /CREATE TRIGGER trg_sync_core_entity_projection/);
  assert.match(migration, /platform_runtime_state/);
  // 退出条件写进迁移注释，避免未来「顺手」删掉 blob 表。
  assert.match(migration, /退出条件/);
});

// 扫描工作区包（packages/* 与 apps/*）之间的相对路径 import。
// 只做静态文本扫描，不解析 TS/别名，因此对被测代码没有额外依赖。
const WORKSPACE_IMPORT_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.vue']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'release', 'build', '.git']);

const collectWorkspaceSources = async (root) => {
  const collected = new Map();
  const walk = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(join(directory, entry.name));
        continue;
      }
      if (!WORKSPACE_IMPORT_EXTENSIONS.has(extname(entry.name))) continue;
      const file = join(directory, entry.name);
      collected.set(relative(workspaceRoot, file).split(sep).join('/'), await readFile(file, 'utf8'));
    }
  };
  await walk(resolve(workspaceRoot, root));
  return collected;
};

// 顶层归属区：packages/<name>、apps/<name>、frontend、backend 等。
const ownerRegion = (workspacePath) => {
  const segments = workspacePath.split('/');
  return segments[0] === 'packages' || segments[0] === 'apps' ? segments.slice(0, 2).join('/') : segments[0];
};

test('工作区包之间不得用相对路径穿透彼此的私有源码（只降不升）', async () => {
  const sources = new Map();
  for (const root of ['packages', 'apps', 'frontend/src']) {
    for (const [file, source] of await collectWorkspaceSources(root)) sources.set(file, source);
  }
  assert.ok(sources.size >= 30, `工作区源码扫描数量异常：仅 ${sources.size} 个文件`);

  const discovered = new Set();
  for (const [file, source] of sources) {
    const fromRegion = ownerRegion(file);
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const specifier = match[1];
      const target = relative(workspaceRoot, resolve(resolve(workspaceRoot, dirname(file)), specifier))
        .split(sep).join('/');
      if (ownerRegion(target) === fromRegion) continue;
      discovered.add(`${file} -> ${specifier}`);
    }
  }

  const allowed = new Set([...CROSS_PACKAGE_CONTENT_ALLOWLIST]);
  const unregistered = [...discovered].filter((entry) => !CROSS_PACKAGE_IMPORT_BASELINE.has(entry) && !allowed.has(entry)).sort();
  assert.deepEqual(unregistered, [], `检测到未登记的跨包相对路径引用：\n${unregistered.join('\n')}\n请改用 package.json + exports 声明依赖，见 docs/architecture/MODULARIZATION_AUDIT.md`);

  const resolved = [...CROSS_PACKAGE_IMPORT_BASELINE].filter((entry) => !discovered.has(entry)).sort();
  assert.deepEqual(resolved, [], `以下跨包引用已解除，请下调 architecture-baseline.js 的 CROSS_PACKAGE_IMPORT_BASELINE：\n${resolved.join('\n')}`);
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

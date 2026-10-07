// Owns both disposable server processes; never connects the full-flow writer to a shared API.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { orderRecord } from '../examples/e2e-flow/fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const python = resolve(root, '.venv-semantica/Scripts/python.exe');
const children = [];
let connector = null;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

function launch(name, executable, args, env) {
  const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { name, child, output: '', exited: false };
  child.stdout.on('data', bytes => { state.output += String(bytes); });
  child.stderr.on('data', bytes => { state.output += String(bytes); });
  child.on('exit', () => { state.exited = true; });
  child.on('error', error => { state.exited = true; state.output += String(error); });
  children.push(state);
  return state;
}

async function ready(url, state) {
  let lastStatus = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (state.exited) throw new Error(`${state.name} exited during startup: ${state.output.slice(-800)}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      lastStatus = response.status;
      if (response.ok) return;
    } catch { /* owned child process is starting */ }
    await delay(500);
  }
  throw new Error(`${state.name} startup timeout at ${url} (last HTTP ${lastStatus}): ${state.output.slice(-800)}`);
}

try {
  const apiPort = await freePort();
  const semanticPort = await freePort();
  connector = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    let query;
    try { query = JSON.parse(raw || '{}').query; } catch { query = null; }
    if (request.url !== '/oms' || query?.schemaVersion !== 'ontology-query.v1' || !Array.isArray(query?.filter?.values)) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'SYNTHETIC_QUERY_REQUIRED' }));
      return;
    }
    const records = query.objectType === orderRecord.objectType
      && query.filter.field === 'order_id'
      && query.filter.values.includes(orderRecord.id) ? [orderRecord] : [];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ records, queryCoverage: {
      schemaVersion: 'ontology-query.v1', complete: true,
      queryFingerprint: createHash('sha256').update(JSON.stringify(query)).digest('hex')
    } }));
  });
  connector.listen(0, '127.0.0.1');
  await once(connector, 'listening');
  const connectorPort = connector.address().port;
  const runDir = resolve(root, 'output/e2e-normal-flow/runs', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(runDir, { recursive: true });
  const overriddenKeys = new Set([
    'NODE_ENV', 'RUNTIME_STORE_DRIVER', 'RUNTIME_SQLITE_PATH', 'AGENT_RUNTIME_TASK_STORE_DRIVER',
    'SINGLE_NODE_DEPLOYMENT', 'AGENT_RUNTIME_MODE', 'AGENT_MODEL_CONFIG_SOURCE', 'API_HOST', 'PORT',
    'SEMANTICA_DEMO_BRIDGE_ENABLED', 'SEMANTIC_CONTEXT_ENDPOINT', 'SEMANTIC_CONTEXT_PORT',
    'DEMO_ALLOW_ROLE_HEADER', 'OA_AUTH_MODE', 'DINGTALK_ENABLED', 'CONNECTOR_MOCK_MODE',
    'SEMANTIC_REQUIRE_DURABLE_STORAGE', 'SEMANTIC_INSPECTION_INTERVAL_MS',
    'ENTERPRISE_CONNECTORS_CONFIG_JSON', 'ONTOLOGY_RUNTIME_GRANTS_JSON'
  ]);
  // Windows environment names are case-insensitive. Remove every casing of keys
  // owned by this harness before assigning them, otherwise an inherited
  // `port=6000` can win over `PORT=<isolated>` in the child process.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !overriddenKeys.has(key.toUpperCase())));
  for (const key of Object.keys(env)) if (key.endsWith('_STORE_DRIVER')) env[key] = 'runtime';
  delete env.SEMANTIC_INSTANCE_DB;
  delete env.IDENTITY_PROVIDERS_FILE;
  Object.assign(env, {
    NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'sqlite', RUNTIME_SQLITE_PATH: resolve(runDir, 'runtime.sqlite'),
    AGENT_RUNTIME_TASK_STORE_DRIVER: 'sqlite', SINGLE_NODE_DEPLOYMENT: 'true',
    AGENT_RUNTIME_MODE: 'mock',
    AGENT_MODEL_CONFIG_SOURCE: 'environment', API_HOST: '127.0.0.1', PORT: String(apiPort),
    SEMANTICA_DEMO_BRIDGE_ENABLED: 'true', SEMANTIC_CONTEXT_ENDPOINT: `http://127.0.0.1:${semanticPort}`,
    SEMANTIC_CONTEXT_PORT: String(semanticPort), DEMO_ALLOW_ROLE_HEADER: 'true',
    OA_AUTH_MODE: 'mock', DINGTALK_ENABLED: 'false', CONNECTOR_MOCK_MODE: 'disabled',
    SEMANTIC_REQUIRE_DURABLE_STORAGE: 'false', SEMANTIC_INSPECTION_INTERVAL_MS: '1000',
    ENTERPRISE_CONNECTORS_CONFIG_JSON: JSON.stringify({ oms: { endpoint: `http://127.0.0.1:${connectorPort}`, path: '/oms' } }),
    ONTOLOGY_RUNTIME_GRANTS_JSON: JSON.stringify({ 'demo-enterprise': { executive: { metadata: true,
      objects: { E2ESalesOrder: { system: 'OMS', fields: ['order_id', 'customer_id', 'amount', 'status'], classifications: ['internal'] } }
    } } })
  });
  const semantic = launch('semantica', python, ['-X', 'utf8', 'services/semantic-context/app.py'], env);
  const api = launch('api', process.execPath, ['backend/src/app.js'], env);
  await Promise.all([
    ready(`http://127.0.0.1:${semanticPort}/demo/model-definition`, semantic),
    ready(`http://127.0.0.1:${apiPort}/api/health/live`, api)
  ]);
  launch('inspection-worker', process.execPath, ['services/semantic-inspection-worker/app.js'], env);
  const run = launch('e2e', process.execPath, ['scripts/e2e-normal-flow.mjs', '--isolated-runtime', '--base', `http://127.0.0.1:${apiPort}/api`], env);
  const [code] = await once(run.child, 'exit');
  process.stdout.write(run.output);
  if (code !== 0) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const state of children.reverse()) {
    if (!state.exited) {
      const stopped = once(state.child, 'exit');
      state.child.kill();
      await Promise.race([stopped, delay(5000)]);
    }
  }
  if (connector) await new Promise(resolveClose => connector.close(resolveClose));
}

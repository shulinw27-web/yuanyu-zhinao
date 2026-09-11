// Real HTTP authoring/publication/chat evaluation. Synthetic data; owned processes only.
// Never supply expected-results.json to either Agent; human structure controls are labelled.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { loadArkFileConfig } from './ark-file-config.mjs';
import { createHash } from 'node:crypto';
import { crossChannelReadPlan } from '../examples/semantic-schemas/cross-channel-fulfillment/read-plan.mjs';

const root = resolve(import.meta.dirname, '..');
const fixtures = resolve(root, 'examples/semantic-schemas/cross-channel-fulfillment');
const out = resolve(root, 'output/semantic-workbench-loop', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const json = async name => JSON.parse(await readFile(resolve(fixtures, name), 'utf8'));
const samples = await json('sample-events.json');
const expected = await json('expected-results.json'); // Assertions only; never used to construct inputs.
const guide = await readFile(resolve(root, 'docs/development/SEMANTIC_WORKBENCH_COMPLEX_SCENARIO.md'), 'utf8');
const rules = guide.split('<!-- MODEL_INPUT_START -->')[1].split('<!-- MODEL_INPUT_END -->')[0];
const rows = []; const connectorRequests = []; const children = [];
const withRuntime = process.argv.includes('--with-runtime');
const persist = async (name, data) => writeFile(resolve(out, `${name}.json`), JSON.stringify(data, null, 2));
const bind = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const freePort = async () => { const s = createServer(); const p = await bind(s); await new Promise(r => s.close(r)); return p; };
const connector = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  connectorRequests.push({ time: new Date().toISOString(), path: req.url, body });
  // Deliberately return the system's raw facts, not derived answers or model rules.
  // The product must enforce object relevance and authorization itself.
  const system = req.url.slice(1).toUpperCase();
  if (body.query?.schemaVersion === 'ontology-query.v1') {
    const records = samples.records.filter(r => r.system === system && r.objectType === body.query.objectType && body.query.filter.values.includes(r.payload[body.query.filter.field]));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ records, queryCoverage: { schemaVersion: 'ontology-query.v1', complete: true, queryFingerprint: createHash('sha256').update(JSON.stringify(body.query)).digest('hex') } })); return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ records: samples.records.filter(r => r.system === system) }));
});
const connectorPort = await bind(connector);
const apiPort = await freePort(); const semanticPort = await freePort();
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.endsWith('_STORE_DRIVER')) env[key] = 'runtime';
Object.assign(env, {
  NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'memory', AGENT_RUNTIME_TASK_STORE_DRIVER: 'sqlite',
  RUNTIME_SQLITE_PATH: resolve(out, 'isolated-runtime.sqlite'), EVENT_BROKER_TYPE: 'projection',
  AGENT_RUNTIME_MODE: 'ark', AGENT_MODEL_CONFIG_SOURCE: 'environment',
  API_HOST: '127.0.0.1', PORT: String(apiPort), DEMO_ALLOW_ROLE_HEADER: 'true',
  IDENTITY_PROVIDERS_FILE: '', DINGTALK_ENABLED: 'false', CONNECTOR_MOCK_MODE: 'disabled',
  SEMANTICA_DEMO_BRIDGE_ENABLED: 'true', SEMANTIC_CONTEXT_ENDPOINT: `http://127.0.0.1:${semanticPort}`,
  SEMANTIC_CONTEXT_PORT: String(semanticPort),
  ENTERPRISE_CONNECTORS_CONFIG_JSON: JSON.stringify(Object.fromEntries(['ERP', 'WMS', 'OMS', 'QMS', 'OA', 'MES'].map(s => [s.toLowerCase(), { endpoint: `http://127.0.0.1:${connectorPort}`, path: `/${s.toLowerCase()}` }]))),
  PYTHONIOENCODING: 'utf-8'
});
loadArkFileConfig(env);
if (withRuntime) {
  const dictionary = await json('data-dictionary.json');
  env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ 'demo-enterprise': { executive: { metadata: true,
    objects: Object.fromEntries(dictionary.tables.map(t => [t.name, { system: t.system, fields: t.fields.map(f => f.name), classifications: ['internal'] }])) } } });
}
const launch = (name, exe, args) => {
  const child = spawn(exe, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { name, child, log: '', exited: false };
  child.stdout.on('data', b => { state.log += String(b); });
  child.stderr.on('data', b => { state.log += String(b); });
  child.on('exit', () => { state.exited = true; });
  child.on('error', () => { state.exited = true; });
  children.push(state); return state;
};
async function ready(url, state) {
  for (let i = 0; i < 120; i++) {
    if (state.exited) throw new Error(`${state.name} exited during startup`);
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch { /* own process starting */ }
    await delay(500);
  }
  throw new Error(`${state.name} startup timeout`);
}
async function api(id, path, body, role = 'executive') {
  const start = Date.now(); const before = connectorRequests.length;
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-demo-role': role, 'x-client-device-id': 'complex-loop' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000)
  });
  const data = await response.json();
  const row = { id, path, httpStatus: response.status, milliseconds: Date.now() - start,
    connectorRequests: connectorRequests.slice(before), data };
  rows.push(row); await persist(id, row);
  console.log(JSON.stringify({ id, httpStatus: response.status, milliseconds: row.milliseconds, status: data.status, code: data.code, model: data.routing?.source, connectorCalls: row.connectorRequests.length }));
  return data;
}
const attach = async name => ({ name, mimeType: 'application/json', dataUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(await json(name))).toString('base64')}` });
const ownedConversations = [];
async function chat(id, text, conversationId = null, attachments = []) {
  if (!conversationId && ownedConversations.length >= 8) await api(`${id}-archive-old-evaluation`, `/api/agent/conversations/${ownedConversations.shift()}/archive`, {});
  const conversation = conversationId ? { id: conversationId } : await api(`${id}-conversation`, '/api/agent/conversations', { title: id });
  if (!conversation.id) throw new Error('isolated conversation creation failed');
  if (!conversationId) ownedConversations.push(conversation.id);
  const result = await api(id, '/api/agent/message', { text, conversationId: conversation.id, attachments });
  return { result, conversationId: conversation.id };
}
const blind = '本公司的曙光额度是什么，如何计算？请说明采用的已发布语义模型版本。不发起任何业务操作。';
const route = '/api/meta-models/oa-governance';
function reviewedDefinition(proposal, version) {
  const objects = proposal.objectTypes;
  if (!objects?.some(o => o.id === 'CreditAccount')) throw new Error('Agent produced no CreditAccount; no fabricated fallback');
  const formula = version === 'A' ? 'credit_limit - receivable - other_commitments'
    : `credit_limit - receivable - other_commitments + ${version === 'B' ? '0.5' : '0.9'} * bank_confirmed_unallocated_amount`;
  return {
    modelingProfile: 'general', objectTypes: objects, relationshipTypes: proposal.relationshipTypes,
    scenario: { objective: `人工审阅${withRuntime ? '受控计算' : '结构对照'} ${version}：跨仓履约与信用控制`, questions: [blind], requireCaseReplay: withRuntime, decisionBindings: [], actionBindings: [], ...(withRuntime ? { readPlans: [crossChannelReadPlan(version === 'A' ? 0 : version === 'B' ? 0.5 : 0.9)] } : {}) },
    worldModel: { schemaVersion: 'semantic-world-model.v1', rules: [
      ...(proposal.worldModel?.rules || []).filter(r => !String(r.evidence).includes('曙光额度')),
      { id: 'aurora-credit', category: 'metric', evidence: `人工确认${version}版：曙光额度=${formula}；未核销=银行确认到账-已匹配核销；不是额外扣减应收。`, executable: false, status: 'pending_review' }
    ] },
    stateMachines: [], events: [], policies: ['模型声明不授予权限；合成结构验证，业务写入仍需明确授权与确认。'],
    metrics: [{ id: 'aurora-credit', label: '曙光额度', grain: 'CreditAccount', expression: formula, aggregation: 'per_account' }],
    glossaryTerms: [{ id: 'aurora-credit', term: '曙光额度', objectType: 'CreditAccount', definition: `${version}版：${formula}。未核销金额按到账记录去重后减去匹配核销；其他口径见世界模型。` }],
    dataContracts: objects.map(o => ({ id: `${o.id}_contract`, sourceSystem: o.sourceSystems[0], objectType: o.id, schemaVersion: '1.0', freshnessMinutes: 15 })),
    qualityRules: objects.map(o => ({ id: `${o.id}_key`, objectType: o.id, field: o.key, rule: 'not_null', severity: 'error' })),
    accessPolicies: objects.map(o => ({ id: `${o.id}_scope`, objectType: o.id, effect: withRuntime ? 'allow' : 'deny', roles: withRuntime ? ['executive'] : [], condition: withRuntime ? 'iam_scope' : '由 IAM 显式授权；候选模型不授予数据权限', maskedFields: [] })),
    lineageEdges: objects.map(o => ({ from: o.source, to: o.id, fields: o.fields, transformation: 'human_reviewed_synthetic_structure_only' }))
  };
}
async function publish(id, definition) {
  await persist(`${id}-reviewed-definition`, definition);
  const saved = await api(`${id}-save`, `${route}/draft`, definition);
  await api(`${id}-validate`, `${route}/draft/validate`, {});
  if (withRuntime) {
    const isB = definition.scenario.readPlans[0].outputs.find(o => o.id === 'credit').expression.args[1].args[0].value === 0.5;
    const { creditV1, creditV2, creditGapV1, creditGapV2, ...common } = expected.answer;
    const cases = [{ planId: 'cross_channel_fulfillment', target: 'ORD-X900', records: samples.records, expected: { ...common, credit: isB ? creditV2 : creditV1, creditGap: isB ? creditGapV2 : creditGapV1 } },
      { planId: 'cross_channel_fulfillment', target: 'ORD-X900', records: [], expectedError: 'READ_ROOT_NOT_FOUND' }];
    await persist(`${id}-replay-cases`, cases);
    const replay = await api(`${id}-read-replay`, `${route}/read-plan-replay`, { candidateFingerprint: saved.draft?.fingerprint, cases });
    if (replay.status !== 'passed') throw new Error('Read computation replay did not pass');
  }
  await api(`${id}-simulate`, `${route}/simulate-build`, {});
  const result = await api(`${id}-publish`, `${route}/publish`, {});
  const deployed = await (await fetch(`http://127.0.0.1:${semanticPort}/demo/model-definition`)).json();
  await persist(`${id}-independent-deployment`, deployed);
  if (!result.semanticDeployment || result.error) throw new Error(`${id} not published; stop version comparison`);
  return result;
}
try {
  const python = launch('semantica', resolve(root, '.venv-semantica/Scripts/python.exe'), ['-X', 'utf8', 'services/semantic-context/app.py']);
  const backend = launch('api', process.execPath, ['backend/src/app.js']);
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health/live`, backend), ready(`http://127.0.0.1:${semanticPort}/demo/model-definition`, python)]);
  if (!process.argv.includes('--compact-only')) {
  await chat('B0-before-publication', blind);
  const task = await api('S1-build', '/api/semantic-operations/tasks', {
    text: `根据合成 API、字典和样本构建完整通用模型候选，保留18类对象及22条外键关系、逐对象来源系统、主键、粒度和下列业务规则。供人工校对，不自行采纳或发布。${rules}`,
    attachments: await Promise.all(['combined-openapi.json', 'data-dictionary.json', 'sample-events.json'].map(attach))
  });
  const p = task.proposal;
  if (!p) throw new Error('No Agent proposal; preserve evidence and stop rather than fabricate a model');
  await persist('S1-structural-assessment', {
    objects: expected.objects.map(e => ({ ...e, exists: p.objectTypes.some(o => o.id === e.id), keyCorrect: p.objectTypes.some(o => o.id === e.id && o.key === e.key), systemCorrect: p.objectTypes.some(o => o.id === e.id && o.sourceSystems?.length === 1 && o.sourceSystems[0] === e.system), granularityCorrect: p.objectTypes.some(o => o.id === e.id && o.granularity === e.granularity) })),
    relations: expected.relations.map(e => ({ ...e, found: p.relationshipTypes.some(r => r.from === e.from && r.to === e.to && r.sourceField === e.sourceField && r.cardinality === e.cardinality) })),
    critic: p.critic, mapping: p.mappingValidation, worldModel: p.worldModel
  });
  const confirmation = await api('S2-confirm', `/api/semantic-operations/tasks/${task.id}/confirmation`, {});
  if (confirmation.confirmationToken) await api('S3-adopt', `/api/semantic-operations/tasks/${task.id}/execute`, { confirmationToken: confirmation.confirmationToken });
  await api('S4-automatic-draft', `${route}/draft`);
  await api('S5-automatic-validate', `${route}/draft/validate`, {});
  await api('S6-automatic-simulate', `${route}/simulate-build`, {});
  await api('S7-automatic-publish-gate', `${route}/publish`, {});
  await publish('A-human-structure-control', reviewedDefinition(p, 'A'));
  await chat('B1-after-A', blind);
  const direct = await chat('B1a-no-version-word', '请只读查询 ERP、WMS、OMS、QMS 的合成数据，分析 ORD-X900 从南仓发货的有效需求、自有可用件数、缺货量，以及客户曙光额度和信用缺口。不要执行任何操作。');
  await api('N1-other-identity-conversation', `/api/agent/conversations/${direct.conversationId}`, undefined, 'quality_manager');
  await api('N2-other-identity-semantic-task', `/api/semantic-operations/tasks/${task.id}`, undefined, 'quality_manager');
  const business = await chat('B2-fulfillment', '请查询 OMS、ERP、WMS、QMS、OA、MES 中已授权的合成记录，分析订单 ORD-X900 能否从南仓交付：按已发布模型计算有效需求、可用量、缺口及客户曙光额度和信用缺口。说明引用的业务对象、模型版本和快照时间。不执行发货或其他写入。');
  await chat('B3-followup', '那需要补多少？寄售审批已经通过，能直接算进刚才订单的可用库存吗？不要执行操作。', business.conversationId);
  await publish('B-human-structure-control', reviewedDefinition(p, 'B'));
  await chat('B4-after-B', blind);
  if (withRuntime) await chat('B4a-calculation-after-B', '只读分析 ORD-X900 的有效需求、可用量、缺货量、曙光额度和信用缺口，并说明模型版本。不执行操作。');
  if (withRuntime) await chat('B4b-existing-conversation-after-B', '现在再查询并核算刚才订单的缺口和曙光额度，使用最新模型版本。不要执行操作。', business.conversationId);
  await api('C-unpublished-draft', `${route}/draft`, reviewedDefinition(p, 'C'));
  await chat('B5-after-unpublished-C', blind);
  if (withRuntime) await chat('B5a-calculation-after-C-draft', '只读分析 ORD-X900 的有效需求、可用量、缺货量、曙光额度和信用缺口，并说明模型版本。不执行操作。');
  await chat('P1-direct-material-control', `只分析我明确授权上传的合成材料，不读取企业数据也不执行操作。这是材料推理对照，不代表语义发布链路。按 A 版规则计算 ORD-X900 的有效件数、南仓自有可用量、缺货量、曙光额度、信用缺口和银行未核销额，并解释寄售审批及待检退货。${rules}`, null, [await attach('sample-events.json')]);
  }
  // Same facts, stripped of repeated envelopes and duplicate statement strings.
  // This is a labelled input-size control, not an alternate source for blind tests.
  const compact = JSON.stringify({ synthetic: true, asOf: samples.asOf, records: samples.records.map(r => ({ sourceSystem: r.system, objectType: r.objectType, ...r.payload })) });
  const compactAttachment = { name: 'compact-synthetic-records.json', mimeType: 'application/json', dataUrl: `data:application/json;base64,${Buffer.from(compact).toString('base64')}` };
  const positive = await chat('P2-compact-material-control', `仅分析附件中的合成数据，不读取企业系统。计算 ORD-X900 的有效件数、南仓自有可用件数、缺货件数、A版曙光额度、信用缺口和未核销金额。逐项列计算依据。${rules}`, null, [compactAttachment]);
  await chat('P3-material-followup', '沿用上面的模拟规则与记录，寄售审批 AP-X1 通过是否意味着货权转移已执行？ST-X7 可用量为零能否证明批次被隔离？只分析，不执行。', positive.conversationId);
} catch (error) {
  // Error names/messages here are harness-generated; never print config parse contents.
  await persist('harness-error', { name: error.name, message: error.message });
  console.error(JSON.stringify({ error: error.message })); process.exitCode = 1;
} finally {
  if (withRuntime && !process.argv.includes('--compact-only')) {
    const result = id => rows.find(r => r.id === id)?.data;
    const checks = [];
    for (const [id, version] of [['B1a-no-version-word', 'A'], ['B2-fulfillment', 'A'], ['B3-followup', 'A'], ['B4a-calculation-after-B', 'B'], ['B4b-existing-conversation-after-B', 'B'], ['B5a-calculation-after-C-draft', 'B']]) {
      const actual = Object.fromEntries((result(id)?.semanticContext?.calculations || []).map(c => [c.id, c.value]));
      checks.push({ id, passed: actual.shortagePieces === 140 && actual.demandPieces === 180 && actual.southOwnedAvailablePieces === 40 && actual.credit === (version === 'A' ? 4000 : 7500) && actual.creditGap === (version === 'A' ? 5000 : 1500) && result(id)?.command === null });
    }
    for (const [id, version] of [['B1-after-A', 'A'], ['B4-after-B', 'B'], ['B5-after-unpublished-C', 'B']]) {
      const deployed = result(`${version}-human-structure-control-publish`)?.semanticDeployment?.deployment;
      checks.push({ id, passed: Boolean(deployed?.version && result(id)?.text.includes(deployed.version) && result(id)?.agent?.inferenceSource === 'ark') });
    }
    for (const id of ['P1-direct-material-control', 'P2-compact-material-control']) {
      const answer = result(id)?.text.replaceAll(',', '') || '';
      const { hasConflictingMaterialTotals } = await import('../backend/src/services/agent-turn-understanding-service.js');
      checks.push({ id, assessment: 'literal_smoke_requires_human_semantic_review', passed: result(id)?.agent?.inferenceSource === 'ark' && !hasConflictingMaterialTotals(result(id)?.text) && [180, 40, 140, 4000, 5000, 7000].every(v => answer.includes(String(v))) });
    }
    const followup = result('P3-material-followup');
    checks.push({ id: 'P3-material-followup', assessment: 'literal_smoke_requires_human_semantic_review', passed: followup?.agent?.inferenceSource === 'ark' && followup.command === null && ['AP-X1', 'ST-X7'].every(id => followup.text.includes(id)) && rows.find(r => r.id === 'P3-material-followup')?.connectorRequests.length === 0 });
    await persist('acceptance-checks', { passed: checks.filter(c => c.passed).length, total: checks.length, checks });
    if (checks.some(c => !c.passed)) process.exitCode = 1;
  }
  await persist('summary', { timestamp: new Date().toISOString(), model: env.ARK_MODEL, syntheticOnly: true,
    scope: 'real_http_agents_real_ark_real_semantica_not_browser_not_enterprise', runtimeRepairEvaluation: withRuntime, humanControlsAreNotAutomaticAcceptance: true,
    rows: rows.map(({ data, ...r }) => ({ ...r, status: data.status, code: data.code })), connectorRequests });
  for (const state of children) {
    if (!state.exited) { const stopped = once(state.child, 'exit'); state.child.kill(); await Promise.race([stopped, delay(5000)]); }
    // Sanitize credentials before retaining process diagnostic logs.
    let log = state.log; if (env.ARK_API_KEY) log = log.split(env.ARK_API_KEY).join('[REDACTED]');
    await writeFile(resolve(out, `${state.name}.log`), log);
  }
  connector.closeAllConnections(); await new Promise(r => connector.close(r));
  console.log(JSON.stringify({ output: out, completedRequests: rows.length, ownProcessesStopped: children.every(c => c.exited) }));
}

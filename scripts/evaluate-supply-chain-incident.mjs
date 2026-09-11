// Real HTTP authoring/publication/chat evaluation. Synthetic data; owned processes only.
// Never supply expected-results.json to either Agent; human structure controls are labelled.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { loadArkFileConfig } from './ark-file-config.mjs';
import { createHash } from 'node:crypto';
import { dictionary, samples, requirements, openapi } from '../examples/semantic-schemas/supply-chain-incident/scenario.mjs';
import { expected } from '../examples/semantic-schemas/supply-chain-incident/expected.mjs';
import { readPlan as directReadPlan, fullReadPlan } from '../examples/semantic-schemas/supply-chain-incident/read-plan.mjs';
const repaired = process.argv.includes('--repair');
const readPlan = repaired ? fullReadPlan : directReadPlan;
import { discoverSchemasFromAttachments } from '../backend/src/services/semantic-schema-discovery-service.js';

const root = resolve(import.meta.dirname, '..');

const out = resolve(root, 'output/supply-chain-incident', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const json = async name => ({ 'data-dictionary.json': dictionary, 'sample-events.json': samples, 'combined-openapi.json': openapi })[name];
const rules = requirements;
let fault = 'none';
const rows = []; const connectorRequests = []; const children = [];
const withRuntime = true;
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
    let records = samples.records.filter(r => r.system === system && r.objectType === body.query.objectType && body.query.filter.values.includes(r.payload[body.query.filter.field]));
    if (fault === 'foreign_tenant' && system === 'ERP') records = records.map(r => ({ ...r, tenantId: 'other-enterprise' }));
    if (fault === 'stock_conflict' && body.query.objectType === 'StockPosition' && records.length) records.push({ ...records[0], version: 'conflicting-v2', payload: { ...records[0].payload, qty: 999 } });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ records, queryCoverage: { schemaVersion: 'ontology-query.v1', complete: fault !== 'coverage_missing', queryFingerprint: createHash('sha256').update(JSON.stringify(body.query)).digest('hex') } })); return;
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
  ENTERPRISE_CONNECTORS_CONFIG_JSON: JSON.stringify(Object.fromEntries(['ERP', 'WMS', 'OMS', 'QMS', 'OA', 'MES', 'LIMS'].map(s => [s.toLowerCase(), { endpoint: `http://127.0.0.1:${connectorPort}`, path: `/${s.toLowerCase()}` }]))),
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

const route = '/api/meta-models/oa-governance';
const manual = discoverSchemasFromAttachments({ attachments: [{ id: 'dict', name: 'dictionary.json', mimeType: 'application/json' }], reports: [{ attachmentId: 'dict', status: 'content_scanned', structuredSchemaCandidate: true }], documents: [{ attachmentId: 'dict', text: JSON.stringify(dictionary) }] });
const definition = {
  modelingProfile: 'general', objectTypes: manual.objectTypes, relationshipTypes: manual.relationshipTypes,
  scenario: { objective: '人工审阅的直接影响对照，不含合批后代，不能代表完整影响范围', questions: ['原料到门店、财务和责任协作有哪些影响？'], readPlans: [readPlan], requireCaseReplay: true, decisionBindings: [], actionBindings: [] },
  policies: ['只读分析；完整影响范围必须包括 executed 拆合批后代；不得把审批或人员指派作为执行或过错证据。'],
  stateMachines: [], events: [], metrics: [],
  glossaryTerms: [
    { id: 'incident_scope', term: '预防性排查范围', objectType: 'RawLot', definition: '实际领用该原料的生产产物，沿 executed 拆合批边向后传播直至无新后代；不沿合批反向扩大其他父批次的历史影响。当前直接只读计划不支持这一步完整展开。' },
    { id: 'incident_cause', term: '溯源与过错', objectType: 'QualityEvent', definition: '筛查阳性待复检不等于原因确认。采购、生产、仓储、门店人员为流程协作联系人，有效指派不等于事故过错认定。' },
    { id: 'incident_finance', term: '财务暴露', objectType: 'Invoice', definition: '受影响订单金额按订单去重，不是赔偿额。银行到账与财务核销分开，不以已审批代替执行回执。' }
  ],
  dataContracts: manual.objectTypes.map(o => ({ id: o.id, objectType: o.id, sourceSystem: o.sourceSystems[0], schemaVersion: '1' })),
  qualityRules: manual.objectTypes.map(o => ({ id: o.id, objectType: o.id, field: o.key, rule: 'not_null' })),
  accessPolicies: manual.objectTypes.map(o => ({ objectType: o.id, roles: ['executive'], effect: 'allow', condition: 'iam_scope' })),
  lineageEdges: manual.objectTypes.map(o => ({ from: o.source, to: o.id, fields: o.fields }))
};
if (repaired) {
  definition.scenario.objective = '人工审阅的已执行拆合批谱系与多系统影响核查';
  definition.glossaryTerms[0].definition = '实际领用该原料的生产产物，沿 executed 拆合批边向后传播直至无新后代；不沿合批反向扩大其他父批次的历史影响。仅在声明边类型及来源快照范围内完整，不代表全企业实时真相。';
}
const assessment = p => ({
  expectedObjects: dictionary.tables.length, actualObjects: p?.objectTypes?.length || 0,
  objects: dictionary.tables.map(t => { const o = p?.objectTypes?.find(o => o.id === t.name); return { id: t.name, present: Boolean(o), key: o?.key === t.primaryKey, source: o?.sourceSystems?.length === 1 && o.sourceSystems[0] === t.system, grain: o?.granularity === t.granularity,
    references: t.fields.filter(f => f.reference).every(f => o?.fieldDefinitions?.some(d => d.name === f.name && d.reference === f.reference)) }; })
});
let scenarioCompleted = false;
try {
  for (const [name, content] of Object.entries({ 'data-dictionary': dictionary, 'sample-events': samples, 'combined-openapi': openapi })) await persist(name, content);
  await writeFile(resolve(out, 'requirements.txt'), requirements);
  const python = launch('semantica', resolve(root, '.venv-semantica/Scripts/python.exe'), ['-X', 'utf8', 'services/semantic-context/app.py']);
  const backend = launch('api', process.execPath, ['backend/src/app.js']);
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health/live`, backend), ready(`http://127.0.0.1:${semanticPort}/demo/model-definition`, python)]);
  const task = await api('S1-agent-build', '/api/semantic-operations/tasks', { text: '依据以下合成业务要求和 API、字典、记录构建完整24类对象及外键的语义候选。替换当前草稿，仅供人工评审，不发布。' + rules, adoptionMode: 'replace',
    attachments: await Promise.all(['combined-openapi.json', 'data-dictionary.json', 'sample-events.json'].map(attach)) });
  await persist('S1-assessment', assessment(task.proposal));
  if (task.proposal) {
    const confirmation = await api('S2-confirm', `/api/semantic-operations/tasks/${task.id}/confirmation`, {});
    if (confirmation.confirmationToken) await api('S3-adopt', `/api/semantic-operations/tasks/${task.id}/execute`, { confirmationToken: confirmation.confirmationToken });
    await api('S4-validate', `${route}/draft/validate`, {});
    await api('S5-premature-publish', `${route}/publish`, {});
  }
  // Independent simulated manual authoring, explicitly labelled even if Agent succeeds.
  await persist('H-reviewed-definition', definition);
  const saved = await api('H1-manual-save', `${route}/draft`, definition);
  await api('H2-manual-validate', `${route}/draft/validate`, {});
  const negative = { planId: readPlan.id, target: 'RAW-N1', records: [], expectedError: 'READ_ROOT_NOT_FOUND' };
  await api('H3-full-world-replay', `${route}/read-plan-replay`, { candidateFingerprint: saved.draft?.fingerprint, cases: [{ planId: readPlan.id, target: 'RAW-N1', records: samples.records, expected: repaired ? { ...expected.totals, warehousePieces: -1 } : expected.totals }, negative] });
  await api('H4-simulate', `${route}/simulate-build`, {});
  await api('H5-full-world-publish-gate', `${route}/publish`, {});
  const directCases = [{ planId: readPlan.id, target: 'RAW-N1', records: samples.records, expected: repaired ? expected.totals : expected.directOnly }, negative];
  await persist('H-direct-replay-cases', directCases);
  const directReplay = await api('H6-direct-control-replay', `${route}/read-plan-replay`, { candidateFingerprint: saved.draft?.fingerprint, cases: directCases });
  if (directReplay.status !== 'passed') throw new Error('Manual direct control replay failed; do not fabricate publication.');
  const publication = await api('H7-direct-control-publish', `${route}/publish`, {});
  await persist('H8-independent-semantic', await (await fetch(`http://127.0.0.1:${semanticPort}/demo/model-definition`)).json());
  if (publication.error || !publication.semanticDeployment) throw new Error('Manual direct control publication failed.');
  const first = await chat('B1-full-impact-blind', '只读分析 RAW-N1 的质量异常，从采购、生产、仓储调配、门店销售、财务、人员责任多方面追溯，给出全部受影响范围及解决方案。区分事实、疑点和建议，不执行操作。');
  await chat('B2-cause-followup', '为什么会发生？哪些只是怀疑，哪些已经证实？接下来如何处理，请列证据、缺失材料和具体协作岗位。只讨论，不执行。', first.conversationId);
  await chat('B3-genealogy-followup', '完整排查范围是否包含后续合批再拆批？请指出尚未覆盖的门店、订单、库存和财务风险，不要将直接批次范围冒充全部。', first.conversationId);
  await chat('B4-owner-followup', '谁来牵头、谁核库存、谁核财务？区分在职有效指派、已过期指派和过错责任，不执行通知。', first.conversationId);
  await chat('B5-multiple-roots', '对比 RAW-N1 和 RAW-N2，供应商批号相同是否说明属于同一个原料问题？只读，不执行。');
  for (const variant of ['coverage_missing', 'stock_conflict', 'foreign_tenant']) {
    fault = variant; await chat('F-' + variant, '只读查询 RAW-N1 的关联记录，计算库存及财务暴露，不执行任何操作。'); fault = 'none';
  }
  const compact = { synthetic: true, asOf: samples.asOf, records: samples.records.map(r => ({ system: r.system, objectType: r.objectType, ...r.payload })) };
  const material = { name: 'all-synthetic-chain-records.json', mimeType: 'application/json', dataUrl: 'data:application/json;base64,' + Buffer.from(JSON.stringify(compact)).toString('base64') };
  const control = await chat('P1-full-material', '仅使用我上传的合成材料，不读取企业系统。' + requirements + '\n请在900字内给出所有后代批次、门店、订单、仓库/在途/门店现存/累计实售/待检退货数量，订单金额、确认到账、已核销、未核销，关键溯源证据和分阶段处置建议。只分析。', null, [material]);
  await chat('P2-cause-and-owners', '沿用材料，列出当前调查、库存、财务联系人及其人员编号，排除过期指派。能不能认定供应商导致事故？说明关键证据缺口。只讨论不查询不执行。', control.conversationId);
  const focused = compact.records.filter(r => ['Person', 'Responsibility', 'QualityEvent', 'Inspection', 'Approval', 'RawLot', 'PurchaseOrder', 'Supplier'].includes(r.objectType));
  await chat('P3-focused-owner-control', '这是单独的补充材料对照，不是完整世界模型自动检索。仅分析本轮材料，不读取企业系统。列出RAW-N1的active调查/库存/财务联系人及编号，排除过期和离职人员，说明审批执行状态和事故原因是否确定。500字内，不执行任何操作。', control.conversationId,
    [{ name: 'focused-owner-control.json', mimeType: 'application/json', dataUrl: 'data:application/json;base64,' + Buffer.from(JSON.stringify({ synthetic: true, records: focused })).toString('base64') }]);
  scenarioCompleted = true;
} catch (error) {
  await persist('harness-error', { message: error.message }); process.exitCode = 1;
} finally {
  const response = id => rows.find(r => r.id === id);
  const values = Object.fromEntries((response('B1-full-impact-blind')?.data.semanticContext?.calculations || []).map(c => [c.id, c.value]));
  const fullMatch = Object.entries(expected.totals).every(([id, value]) => values[id] === value);
  const checks = {
    fullMetrics: fullMatch,
    evidenceAnalysis: ['B1-full-impact-blind', 'B2-cause-followup', 'B3-genealogy-followup', 'B4-owner-followup'].every(id => response(id)?.data.semanticContext?.analysis?.status === 'completed' && response(id)?.connectorRequests.length > 0),
    multiRoot: response('B5-multiple-roots')?.data.semanticContext?.comparisons?.length === 2 && response('B5-multiple-roots')?.connectorRequests.length > 0
      && ['LOT-N4', 'LOT-N5'].every(id => response('B5-multiple-roots')?.data.text?.includes(id))
      && /(?:共同|共享|重叠|交集)[^。！？\n]{0,100}LOT-N[45]|LOT-N[45][^。！？\n]{0,100}(?:共同|共享|重叠|交集)/.test(response('B5-multiple-roots')?.data.text || ''),
    materialOwners: ['PER-N1', 'PER-N2', 'PER-N3'].every(id => response('P2-cause-and-owners')?.data.text?.includes(id)) && response('P2-cause-and-owners')?.connectorRequests.length === 0,
    faultsBlocked: ['coverage_missing', 'stock_conflict', 'foreign_tenant'].every(f => response('F-' + f)?.data.task?.phase === 'incomplete' && response('F-' + f)?.data.command === null),
    badReplayBlocked: response('H3-full-world-replay')?.data.status === 'failed' && Boolean(response('H5-full-world-publish-gate')?.data.error)
  };
  if (repaired && (!scenarioCompleted || !Object.values(checks).every(Boolean))) process.exitCode = 1;
  await persist('assessment', {
    scenarioCompleted, repaired, checks, acceptancePassed: Object.values(checks).every(Boolean), completeWorldRuntimePassed: fullMatch, fullWorldExpected: expected.totals, actualBlindMetrics: values,
    directControlPassed: Object.entries(expected.directOnly).every(([id, value]) => values[id] === value),
    fullReplayRejected: response('H3-full-world-replay')?.data.status === 'failed',
    fullPublicationBlocked: Boolean(response('H5-full-world-publish-gate')?.data.error),
    faultChecks: ['coverage_missing', 'stock_conflict', 'foreign_tenant'].map(f => ({ fault: f, text: response('F-' + f)?.data.text, noBusinessWrite: response('F-' + f)?.data.command === null, reads: response('F-' + f)?.connectorRequests.length })),
    note: 'HTTP完成不代表全部世界模型验收通过；自然语言回答必须人工阅读；人工直接范围发布不是全场景自动通过。'
  });
  await persist('summary', { scenarioCompleted, fullMatch, syntheticOnly: true, model: env.ARK_MODEL, rows: rows.map(({data,...r}) => ({ ...r, status:data.status, code:data.code })), connectorRequests });
  await persist('performance', { syntheticOnly: true, model: env.ARK_MODEL, rows: rows.filter(r => r.data.semanticContext?.timing).map(r => ({
    id: r.id, httpMs: r.milliseconds, connectorCalls: r.connectorRequests.length,
    understanding: r.data.evidenceTrace?.events?.find(e => e.type === 'turn_understanding_completed')?.details?.timing,
    ...r.data.semanticContext.timing
  })), note: 'Single-run observations, not controlled A/B or production SLA. Prompt lengths are characters, not billed tokens. Inspect answers as well as timing.' });
  for (const state of children) {
    if (!state.exited) { const stopped = once(state.child, 'exit'); state.child.kill(); await Promise.race([stopped, delay(5000)]); }
    let log = state.log; if (env.ARK_API_KEY) log = log.split(env.ARK_API_KEY).join('[REDACTED]');
    await writeFile(resolve(out, state.name + '.log'), log);
  }
  connector.closeAllConnections(); await new Promise(r => connector.close(r));
  console.log(JSON.stringify({ output: out, scenarioCompleted, fullWorldRuntimePassed: fullMatch, ownProcessesStopped: children.every(c => c.exited) }));
}

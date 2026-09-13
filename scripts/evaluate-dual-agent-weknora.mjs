// Opt-in synthetic end-to-end evaluation. No changes to permanent model/IAM config.
import { readFile, writeFile, mkdir, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { loadArkFileConfig } from './ark-file-config.mjs';
import { marker, dictionary, openapi, samples, documents, plan, requirements } from '../examples/knowledge/dual-agent-mock/scenario.mjs';
import { expected, complexReplayCases } from '../examples/knowledge/dual-agent-mock/expected.mjs';

if (!process.argv.includes('--live-synthetic')) {
  console.log('No requests. --live-synthetic uses only WK-DUAL-20260913 documents in the existing synthetic KB, isolated Agents/Semantica, real Ark calls and mock connectors.');
} else {
  const root = resolve(import.meta.dirname, '..'); const children = []; const rows = []; const checks = [];
  const out = resolve(root, 'output/dual-agent-weknora', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(out, { recursive: true });
  let connector; let fault = ''; let queries = 0; let privateDir; let privateFile; let env;
  const sanitize = value => JSON.parse(JSON.stringify(value, (key, item) => /token|sessionId|apiKey|secret/i.test(key) ? '[REDACTED]' : item));
  const persist = (name, data) => writeFile(join(out, `${name}.json`), JSON.stringify(sanitize(data), null, 2));
  const check = (id, passed, details = {}) => { checks.push({ id, passed: !!passed, ...details }); console.log(JSON.stringify({ check: id, passed: !!passed })); };
  const bind = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
  const freePort = async () => { const s = createServer(); const p = await bind(s); await new Promise(r => s.close(r)); return p; };
  try {
    const configFile = 'D:/wsl/private/yuanyu-zhinao/weknora.local.json';
    const cfg = JSON.parse(await readFile(configFile, 'utf8')); const secret = cfg.apiKey;
    const kb = 'dc81f155-78f8-4f3f-9824-c47e0da841ab';
    const principal = createHash('sha256').update(JSON.stringify(['demo-enterprise', 'admin@demo.local', 'executive'])).digest('hex');
    if (cfg.baseUrl !== 'http://127.0.0.1:18081' || !cfg.bindings.some(b => b.principalKey === principal && b.knowledgeBaseId === kb)) throw new Error('APPROVED_SYNTHETIC_SCOPE_REQUIRED');
    const listing = await fetch(`${cfg.baseUrl}/api/v1/knowledge-bases/${kb}/knowledge?page=1&page_size=100`, { headers: { 'X-API-Key': secret }, signal: AbortSignal.timeout(10000) });
    if (!listing.ok) throw new Error('SYNTHETIC_DOCUMENT_LIST_UNAVAILABLE');
    const data = await listing.json();
    const selected = documents.map(doc => {
      const matches = data.data?.filter(item => item.title === doc.name.replace(/\.txt$/, '') || item.file_name === doc.name) || [];
      if (matches.length !== 1 || matches[0].parse_status !== 'completed' || matches[0].knowledge_base_id !== kb) throw new Error('SYNTHETIC_DOCUMENT_NOT_READY_OR_AMBIGUOUS');
      return { ...doc, id: matches[0].id };
    });
    await persist('source-manifest', { marker, knowledgeBaseId: kb, documents: selected.map(d => ({ id: d.id, name: d.name, sha256: createHash('sha256').update(d.text).digest('hex') })) });
    check('four_real_weknora_documents_parsed', selected.length === 4);
    // Current-user-only parent already used by the approved private config. Never
    // broaden/rewrite the permanent file; remove only this owned one-use copy.
    privateDir = await mkdtemp(join(dirname(configFile), 'dual-mock-')); privateFile = join(privateDir, 'weknora.json');
    await writeFile(privateFile, JSON.stringify({ ...cfg, retrievalMode: process.argv.includes('--hybrid') ? 'hybrid' : cfg.retrievalMode,
      bindings: [{ principalKey: principal, tenantId: 10000, knowledgeBaseId: kb, knowledgeIds: selected.map(d => d.id) }] }), { flag: 'wx', mode: 0o600 });
    connector = createServer(async (req, res) => {
      res.setHeader('Connection', 'close'); res.setHeader('Content-Type', 'application/json');
      try {
        let raw = ''; for await (const part of req) { raw += part; if (raw.length > 20000) throw new Error('limit'); }
        const { query } = JSON.parse(raw); queries++;
        if (req.method !== 'POST' || query?.schemaVersion !== 'ontology-query.v1') { res.writeHead(400); res.end('{}'); return; }
        let records = samples.records.filter(r => r.system.toLowerCase() === req.url.slice(1) && r.objectType === query.objectType && query.filter.values.includes(r.payload[query.filter.field]));
        if (fault === 'foreign_tenant') records = records.map(r => ({ ...r, tenantId: 'not-the-caller' }));
        if (fault === 'stock_conflict' && query.objectType === 'StockPosition' && records[0]) records.push({ ...records[0], payload: { ...records[0].payload, qty: 999 } });
        res.end(JSON.stringify({ records, queryCoverage: { schemaVersion: 'ontology-query.v1', complete: fault !== 'coverage_missing', queryFingerprint: createHash('sha256').update(JSON.stringify(query)).digest('hex') } }));
      } catch { res.writeHead(400); res.end('{}'); }
    });
    const connectorPort = await bind(connector); const apiPort = await freePort(); const semanticPort = await freePort();
    env = { ...process.env };
    for (const key of Object.keys(env)) if (key.endsWith('_STORE_DRIVER')) env[key] = 'runtime';
    Object.assign(env, { NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'memory', AGENT_RUNTIME_TASK_STORE_DRIVER: 'sqlite', RUNTIME_SQLITE_PATH: join(out, 'isolated-runtime.sqlite'), EVENT_BROKER_TYPE: 'projection',
      API_HOST: '127.0.0.1', PORT: String(apiPort), DEMO_ALLOW_ROLE_HEADER: 'false', OA_AUTH_MODE: 'mock', DEMO_OA_PASSWORD: 'synthetic-evaluation-only',
      IDENTITY_PROVIDERS_FILE: '', DINGTALK_ENABLED: 'false', CONNECTOR_MOCK_MODE: 'disabled',
      AGENT_RUNTIME_MODE: 'ark', AGENT_MODEL_CONFIG_SOURCE: 'environment', KNOWLEDGE_MODEL_ALLOWED_MODES: 'ark', WEKNORA_CONFIG_FILE: privateFile,
      SEMANTICA_DEMO_BRIDGE_ENABLED: 'true', SEMANTIC_CONTEXT_ENDPOINT: `http://127.0.0.1:${semanticPort}`, SEMANTIC_CONTEXT_PORT: String(semanticPort), PYTHONIOENCODING: 'utf-8',
      ENTERPRISE_CONNECTORS_CONFIG_JSON: JSON.stringify(Object.fromEntries(['ERP','WMS','OMS','QMS','OA','MES'].map(s => [s.toLowerCase(), { endpoint: `http://127.0.0.1:${connectorPort}`, path: `/${s.toLowerCase()}` }]))),
      ONTOLOGY_RUNTIME_GRANTS_JSON: JSON.stringify({ 'demo-enterprise': { executive: { metadata: true, objects: Object.fromEntries(dictionary.tables.map(t => [t.name, { system: t.system, fields: t.fields.map(f => f.name), classifications: ['internal'] }])) } } }) });
    loadArkFileConfig(env);
    const launch = (name, exe, args) => {
      const child = spawn(exe, args, { cwd: root, env, windowsHide: true, stdio: 'ignore' }); children.push(child);
      child.on('error', () => {}); return { child, name };
    };
    const py = launch('semantica', resolve(root, '.venv-semantica/Scripts/python.exe'), ['-X', 'utf8', 'services/semantic-context/app.py']);
    const api = launch('api', process.execPath, ['backend/src/app.js']);
    async function ready(url, state) {
      for (let i = 0; i < 100; i++) {
        if (state.child.exitCode !== null) throw new Error('ISOLATED_SERVICE_START_FAILED');
        try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* bounded startup */ }
        await delay(300);
      } throw new Error('ISOLATED_SERVICE_START_TIMEOUT');
    }
    await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health/live`, api), ready(`http://127.0.0.1:${semanticPort}/demo/model-definition`, py)]);
    let session;
    async function call(id, path, body, method = body === undefined ? 'GET' : 'POST', auth = session) {
      const start = Date.now(); const before = queries;
      const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, { method,
        headers: { 'Content-Type': 'application/json', 'x-client-device-id': marker, ...(auth ? { 'x-identity-session': auth } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(150000) });
      const value = await response.json();
      const row = { id, http: response.status, milliseconds: Date.now() - start, connectorCalls: queries - before, data: value };
      rows.push(row); await persist(id, row);
      console.log(JSON.stringify({ id, http: row.http, milliseconds: row.milliseconds, connectorCalls: row.connectorCalls, code: value.code }));
      return value;
    }
    session = (await call('login', '/api/auth/oa/login', { account: 'admin@demo.local', password: 'synthetic-evaluation-only' })).sessionId;
    if (!session) throw new Error('ISOLATED_LOGIN_FAILED');
    const allEvidence = new Map();
    for (const [i, doc] of selected.entries()) {
      const answer = await call(`K${i}-retrieval`, '/api/semantic-operations/knowledge-library/brief', { provider: 'weknora_local', query: doc.query, limit: 5 });
      const hits = answer.evidence || [];
      check(`retrieval_${doc.name}`, hits.some(hit => hit.citation.documentId === doc.id && hit.excerpt.includes(doc.mustContain)), { evidenceCount: hits.length });
      for (const hit of hits) allEvidence.set(hit.citation.chunkId, hit);
    }
    const picked = selected.map(doc => [...allEvidence.values()].find(hit => hit.citation.documentId === doc.id && hit.excerpt.includes(doc.mustContain))).filter(Boolean);
    if (picked.length !== 4) throw new Error('REQUIRED_SOURCE_EVIDENCE_MISSING');
    const citations = picked.map(hit => hit.citation);
    const providers = await call('model-policy', '/api/agent/knowledge-library/providers'); const policy = providers.answerPolicy;
    const consent = { provider: policy.provider, model: policy.model, confirmed: true };
    if (process.argv.includes('--retrieval-only')) {
      check('retrieval_only_no_business_queries', queries === 0);
    } else if (process.argv.includes('--supplement-probe')) {
      for (const surface of ['agent', 'semantic-operations']) {
        const supplemental = await call(`${surface}-supplement`, `/api/${surface}/knowledge-library/answer-sources`, { question: 'execution_receipt_id', citations, confirmed: true });
        check(`${surface}_supplement_selected_only_no_model`, supplemental.modelCalled === false && supplemental.evidence?.every(e => selected.some(d => d.id === e.id)) && queries === 0);
        check(`${surface}_supplement_rule_found`, supplemental.evidence?.some(e => e.excerpt.includes('OA审批approved不等于货权转移完成')));
        if (supplemental.evidence?.length) {
          const answer = await call(`${surface}-supplement-answer`, `/api/${surface}/knowledge-library/answer`, { question: '沿用刚才订单的讨论，审批通过就算执行完成了吗？', history: ['讨论订单履约，不执行操作。'], citations: supplemental.evidence.map(e => e.citation), consent });
          check(`${surface}_supplement_answer_contract`, answer.modelCalled === true && answer.execution === 'none');
        }
      }
    } else if (process.argv.includes('--approval-probe')) {
      for (const [i,query] of ['execution_receipt_id', '货权转移'].entries()) {
        const focused = await call(`approval-${i}-retrieval`, '/api/agent/knowledge-library/brief', { provider: 'weknora_local', query, limit: 5 });
        const exact = focused.evidence?.find(e => e.excerpt.includes('OA审批approved不等于货权转移完成'));
        check(`approval_query_${i}_rule_recalled`, !!exact);
        if (exact) {
          const control = await call(`approval-${i}-answer`, '/api/agent/knowledge-library/answer', { question: '审批通过是否等于货权转移已执行？退货待检能直接放行吗？只依据所选原文回答。', history: [], citations: [exact.citation], consent });
          check(`approval_query_${i}_answer_contract`, control.modelCalled === true && control.execution === 'none');
        }
      }
    } else if (process.argv.includes('--focused-probes')) {
      const question = '沿用这些资料，审批通过是否等于执行完成？当前实际库存和信用缺口是多少？资料不足请明确，不要猜。';
      const firstQuestion = '请解释现行曙光额度及新上传草案B的区别，现在应采用哪个？能直接把到账全部加到额度吗？';
      const retry = await call('probe-original-followup', '/api/agent/knowledge-library/answer', { question, history: [firstQuestion], citations, consent });
      check('original_followup_repeat_contract', retry.modelCalled === true);
      const retryWiki = await call('probe-wiki', '/api/semantic-operations/knowledge-library/answer', { question: '整理建模需要的对象关系、现行口径和未生效草案边界，保留待人工核验项。', history: [], citations, consent, purpose: 'wiki' });
      check('wiki_repeat_contract', retryWiki.modelCalled === true && retryWiki.published === false);
      const focused = await call('probe-focus-retrieval', '/api/agent/knowledge-library/brief', { provider: 'weknora_local', query: 'execution_receipt_id', limit: 5 });
      const exact = focused.evidence?.find(e => e.excerpt.includes('OA审批approved不等于货权转移完成'));
      check('missing_approval_rule_retrievable_on_explicit_query', !!exact);
      if (exact) {
        const control = await call('probe-focus-answer', '/api/agent/knowledge-library/answer', { question: '审批通过是否等于货权转移已执行？退货待检能直接放行吗？只依据所选原文回答。', history: [], citations: [exact.citation], consent });
        check('explicit_retrieval_control_answer_contract', control.modelCalled === true && control.execution === 'none');
      }
    } else {
    const modelRoute = '/api/meta-models/oa-governance';
    if (!process.argv.includes('--business-only')) {
    let wiki;
    for (const surface of ['agent','semantic-operations']) {
      const history = [];
      for (const [i, question] of ['请解释现行曙光额度及新上传草案B的区别，现在应采用哪个？能直接把到账全部加到额度吗？', '沿用这些资料，审批通过是否等于执行完成？当前实际库存和信用缺口是多少？资料不足请明确，不要猜。'].entries()) {
        const answer = await call(`${surface}-knowledge-${i}`, `/api/${surface}/knowledge-library/answer`, { question, history: [...history], citations, consent });
        check(`${surface}_knowledge_${i}_contract`, answer.modelCalled === true && answer.execution === 'none' && Array.isArray(answer.claims)); history.push(question);
      }
      if (surface === 'semantic-operations') wiki = await call('wiki', `/api/${surface}/knowledge-library/answer`, { question: '整理建模需要的对象关系、现行口径和未生效草案边界，保留待人工核验项。', history: [], citations, consent, purpose: 'wiki' });
    }
    check('wiki_is_unpublished_model_draft', wiki?.modelCalled && wiki.published === false);
    const attach = (name, data) => ({ name, mimeType: 'application/json', dataUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(data)).toString('base64')}` });
    const sourceText = picked.map(hit => `[来源 ${hit.citation.documentId}/${hit.citation.chunkId}] ${hit.excerpt}`).join('\n');
    const semantic = await call('S1-build', '/api/semantic-operations/tasks', { adoptionMode: 'replace',
      text: `用API、字典、样本及以下WeKnora复验原文构建通用模型候选，供人工校对，不自动发布。保留全部对象、外键、系统来源、主键和粒度；DRAFT规则不可视为现行。\n${sourceText}\n以下模型整理仅作待核验笔记：${JSON.stringify(wiki?.claims?.map(c => c.text) || [])}`,
      attachments: [attach('data-dictionary.json', dictionary), attach('combined-openapi.json', openapi), attach('sample-events.json', samples)] });
    const proposal = semantic.proposal;
    const objectChecks = dictionary.tables.map(t => { const o = proposal?.objectTypes?.find(o => o.id === t.name); return { id: t.name, passed: !!o && o.key === t.primaryKey && o.sourceSystems?.length === 1 && o.sourceSystems[0] === t.system && o.granularity === t.granularity }; });
    await persist('S1-assessment', { objects: objectChecks, critic: proposal?.critic, mappingValidation: proposal?.mappingValidation, worldModel: proposal?.worldModel });
    check('semantic_candidate_structure', objectChecks.every(o => o.passed), { passedObjects: objectChecks.filter(o => o.passed).length, total: objectChecks.length });
    if (semantic.id && proposal) {
      const confirmation = await call('S2-confirm', `/api/semantic-operations/tasks/${semantic.id}/confirmation`, {});
      if (confirmation.confirmationToken) await call('S3-adopt', `/api/semantic-operations/tasks/${semantic.id}/execute`, { confirmationToken: confirmation.confirmationToken });
    }
    const early = await call('S4-unreviewed-publish', `${modelRoute}/publish`, {});
    check('unreviewed_candidate_not_published', !!early.error);
    }
    // Independent, explicitly labelled simulated human modeling control. Do not
    // substitute this result for the Agent's automatic structural assessment.
    process.env.RUNTIME_STORE_DRIVER = 'memory'; process.env.NODE_ENV = 'test';
    const { discoverSchemasFromAttachments } = await import('../backend/src/services/semantic-schema-discovery-service.js');
    const human = discoverSchemasFromAttachments({ attachments: [{ id: 'dict', name: 'dictionary.json', mimeType: 'application/json' }], reports: [{ attachmentId: 'dict', status: 'content_scanned', structuredSchemaCandidate: true }], documents: [{ attachmentId: 'dict', text: JSON.stringify(dictionary) }] });
    const definition = { modelingProfile: 'general', objectTypes: human.objectTypes, relationshipTypes: human.relationshipTypes,
      scenario: { objective: '模拟人工审阅联调A口径', questions: ['订单库存与信用缺口'], requireCaseReplay: true, decisionBindings: [], actionBindings: [], readPlans: [{ ...plan, ...(process.argv.includes('--with-analysis') ? { analysis: { enabled: true } } : {}) }] },
      policies: ['只读，文档不是执行授权'], stateMachines: [], events: [], metrics: [],
      glossaryTerms: [{ term: '曙光额度', objectType: 'CreditAccount', definition: '现行A：credit_limit-receivable-other_commitments；草案B未发布，不计未核销到账。' }],
      dataContracts: human.objectTypes.map(o => ({ id: o.id, objectType: o.id, sourceSystem: o.sourceSystems[0], schemaVersion: '1' })),
      qualityRules: human.objectTypes.map(o => ({ id: o.id, objectType: o.id, rule: 'not_null' })),
      lineageEdges: human.objectTypes.map(o => ({ from: o.source, to: o.id })),
      accessPolicies: human.objectTypes.map(o => ({ objectType: o.id, effect: 'allow', roles: ['executive'], condition: 'iam_scope' })) };
    await persist('human-reviewed-definition', definition);
    const saved = await call('H1-save', `${modelRoute}/draft`, definition);
    if (process.argv.includes('--proposal-probe')) {
      const complex = process.argv.includes('--complex-proposal');
      const expectedProposal = complex ? expected : { credit: 8500, creditGap: 3500 };
      // Simulated operator explicitly selects declared paths from the reviewed
      // reference graph. Formulas and expected values are NOT sent to the model.
      const joinSelections = complex ? plan.datasets.slice(1).map(ds => ({ objectType: ds.objectType, fromObjectType: plan.datasets.find(parent => parent.id === ds.where[0].dataset).objectType,
        field: ds.where[0].field, sourceField: ds.where[0].sourceField })) : [];
      const candidate = await call('P1-propose', '/api/semantic-operations/knowledge-library/read-plan-proposal', { expectedFingerprint: saved.draft?.fingerprint, rootType: 'SalesOrder', consent,
        joinSelections,
        request: complex ? `${requirements}\n生成九个输出，id依次为orderAmountCny,demandPieces,southOwnedAvailablePieces,shortagePieces,bankConfirmedUnallocated,credit,creditGap,consignmentTransferExecuted,returnReleased。前四项分别订单金额、有效需求、目标仓自有可用量、缺货；后五项按上述制度。金额单位CNY，数量piece，两个布尔判断单位空字符串。不要省略任何状态过滤、SKU或目标仓范围、预留扣减及单位换算。${process.argv.includes('--clarified-rules') ? '\n模拟人工口径澄清：有效订单行明确为status=open，其余不计。目标仓只按本订单行target_warehouse_id关联，不硬编码南仓名称。数量仅允许case/piece，其他单位停止计算，case使用SKU.pieces_per_case换算。库存available为自有owned且库存status=released且批次quality_status=released、目标仓匹配并存在同SKU有效行；每库存扣其他订单status=active预留后取max(0)。银行确认明确bank_status=confirmed，核销明确status=matched。consignmentTransferExecuted仅代表存在execution_receipt_id非null的执行证据，不推断完整业务完成；returnReleased仅代表ReturnInspection.result=passed。布尔输出无需更广义业务判定。订单币种CNY，否则停止。' : ''}`
          : '只计算credit和creditGap两个输出，单位CNY。SalesOrder为根，经customer_id连接Customer，再关联CreditAccount。现行credit=credit_limit-receivable-other_commitments，creditGap=max(0,订单amount-credit)。输出id严格为credit、creditGap。订单币种需为CNY。不要读取库存、到账或草案B，不执行。' });
      check('generated_read_plan_is_preview_only', candidate.status === 'pending_human_review' && candidate.persisted === false && rows.at(-1).connectorCalls === 0);
      if (candidate.plan) {
        const selectedDefinition = { ...definition, scenario: { ...definition.scenario, readPlans: [candidate.plan] } };
        const adopted = await call('P2-human-adopt', `${modelRoute}/draft`, selectedDefinition);
        const valid = await call('P3-validate', `${modelRoute}/draft/validate`, {});
        check('generated_plan_human_review_validation', valid.draft?.validation?.status === 'passed');
        const replay = await call('P4-replay', `${modelRoute}/read-plan-replay`, { candidateFingerprint: adopted.draft?.fingerprint,
          cases: complex ? complexReplayCases(candidate.plan.id, samples.records) : [{ planId: candidate.plan.id, target: 'ORD-T900', records: samples.records, expected: expectedProposal },
            { planId: candidate.plan.id, target: 'ORD-T900', records: [], expectedError: 'READ_ROOT_NOT_FOUND' }] });
        check('generated_plan_independent_positive_negative_replay', replay.status === 'passed');
        if (replay.status === 'passed') {
          await call('P5-build', `${modelRoute}/simulate-build`, {});
          const published = await call('P6-publish', `${modelRoute}/publish`, {});
          check('generated_plan_reviewed_publication', !published.error);
          const chat = await call('P7-business-chat', '/api/agent/message', { text: complex ? '只读核验 ORD-T900 的库存、授信、到账、寄售执行和退货放行，解释九项指标，不执行操作。' : '只读核验 ORD-T900 的曙光额度和信用缺口，不执行操作。' });
          const values = Object.fromEntries((chat.semanticContext?.calculations || []).map(v => [v.id, v.value]));
          check('generated_plan_business_values', Object.entries(expectedProposal).every(([id, value]) => values[id] === value) && chat.command === null, { actual: values });
        }
      }
    } else {
    const validated = await call('H2-validate', `${modelRoute}/draft/validate`, {});
    check('human_control_validated', validated.draft?.validation?.status === 'passed');
    const replay = await call('H3-replay', `${modelRoute}/read-plan-replay`, { candidateFingerprint: saved.draft?.fingerprint,
      cases: [{ planId: plan.id, target: 'ORD-T900', records: samples.records, expected }, { planId: plan.id, target: 'ORD-T900', records: [], expectedError: 'READ_ROOT_NOT_FOUND' }] });
    check('human_control_positive_negative_replay', replay.status === 'passed');
    if (replay.status !== 'passed') throw new Error('HUMAN_CONTROL_REPLAY_FAILED');
    await call('H4-build', `${modelRoute}/simulate-build`, {});
    const published = await call('H5-publish', `${modelRoute}/publish`, {});
    const receipt = await (await fetch(`http://127.0.0.1:${semanticPort}/demo/model-definition`)).json(); await persist('H6-independent-semantica-receipt', receipt);
    check('real_semantica_publication', !published.error && receipt.status === 'published' && receipt.version === published.semanticDeployment?.deployment?.version
      && receipt.sourceFingerprint === saved.draft?.fingerprint && receipt.objectCount === 18);
    if (published.error) throw new Error('SEMANTICA_PUBLICATION_FAILED');
    const catalogue = await call('B0-plans', '/api/agent/knowledge-library/joint-plans');
    const jointBody = { question: '核验 ORD-T900 库存与信用缺口，区分现行规则和未发布草案。', targets: ['ORD-T900'], citations, confirmed: true,
      planId: plan.id, expectedModelFingerprint: catalogue.model?.fingerprint, expectedModelVersion: catalogue.model?.version };
    const joint = await call('B1-joint', '/api/agent/knowledge-library/joint-brief', jointBody);
    const jointValues = Object.fromEntries((joint.business?.results || []).map(v => [v.id, v.value]));
    check('weknora_and_published_business_joint_values', Object.entries(expected).every(([k,v]) => jointValues[k] === v) && joint.knowledge?.sources.length === 4 && joint.execution === 'none', { actual: jointValues });
    const conversation = await call('B2-conversation', '/api/agent/conversations', { title: marker });
    for (const [i,text] of ['只读分析订单 ORD-T900 的有效需求、自有可用量、缺货和曙光额度、信用缺口，说明发布模型版本，不执行操作。', '那这笔订单还缺多少？审批通过的寄售和未签收在途能算进刚才的可用库存吗？请沿用刚才订单重新核验，不执行操作。'].entries()) {
      const answer = await call(`B${i+3}-chat`, '/api/agent/message', { text, conversationId: conversation.id });
      const values = Object.fromEntries((answer.semanticContext?.calculations || []).map(v => [v.id,v.value]));
      check(`business_chat_${i}_facts_and_context`, Object.entries(expected).every(([k,v]) => values[k] === v) && answer.command === null, { actual: values, inferenceSource: answer.agent?.inferenceSource });
      if (process.argv.includes('--with-analysis')) check(`business_chat_${i}_model_explanation`, answer.semanticContext?.analysis?.status === 'completed', { status: answer.semanticContext?.analysis?.status, code: answer.semanticContext?.analysis?.code });
    }
    for (const mode of ['coverage_missing','stock_conflict','foreign_tenant']) {
      fault = mode; const rejected = await call(`F-${mode}`, '/api/agent/knowledge-library/joint-brief', jointBody);
      check(`fault_${mode}_no_sensitive_result`, !!rejected.error && !rejected.business && !rejected.knowledge); fault = '';
    }
    const stale = await call('F-old-model', '/api/agent/knowledge-library/joint-brief', { ...jointBody, expectedModelFingerprint: '0'.repeat(24) });
    check('stale_model_zero_business_queries', stale.code === 'KNOWLEDGE_MODEL_SELECTION_STALE' && rows.at(-1).connectorCalls === 0);
    const foreign = await call('foreign-login', '/api/auth/oa/login', { account: 'quality@demo.local', password: 'synthetic-evaluation-only' });
    const denied = await call('F-foreign-identity', '/api/agent/knowledge-library/brief', { provider: 'weknora_local', query: '曙光额度' }, 'POST', foreign.sessionId);
    check('unbound_identity_no_weknora_evidence', !!denied.error && !denied.evidence);
    }
    }
  } catch (error) {
    const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'HARNESS_OR_TRANSPORT_FAILURE';
    check('harness_completed', false, { code });
  } finally {
    for (const child of children) if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await Promise.race([stopped, delay(5000)]); }
    if (connector) { connector.closeAllConnections(); await new Promise(r => connector.close(r)); }
    if (privateFile) await unlink(privateFile); if (privateDir) await rmdir(privateDir);
    const report = { syntheticOnly: true, proposalProbe: process.argv.includes('--proposal-probe'), complexProposal: process.argv.includes('--complex-proposal'), supplementProbe: process.argv.includes('--supplement-probe'), businessOnly: process.argv.includes('--business-only'), withAnalysis: process.argv.includes('--with-analysis'), approvalProbe: process.argv.includes('--approval-probe'), focusedProbes: process.argv.includes('--focused-probes'), retrievalOnly: process.argv.includes('--retrieval-only'), hybridRequested: process.argv.includes('--hybrid'), model: env?.ARK_MODEL, checks, passed: checks.filter(c => c.passed).length, total: checks.length,
      scope: 'real_weknora_real_ark_real_semantica_isolated_http_mock_business_not_browser_not_production',
      humanControlIsNotAutomaticAgentAcceptance: true, naturalLanguageNeedsHumanReview: true,
      rows: rows.map(({ data, ...row }) => ({ ...row, code: data.code })), privateTemporaryConfigRemoved: true, permanentConfigUnchanged: true };
    await persist('assessment', report);
    console.log(JSON.stringify({ output: out, passed: report.passed, total: report.total }));
    process.exit(!checks.length || checks.some(c => !c.passed) ? 1 : 0);
  }
}

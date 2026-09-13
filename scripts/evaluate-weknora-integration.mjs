// Opt-in real adapter + HTTP regression against the single approved synthetic KB.
// No key, session token, source text, user data or upstream response body is logged.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

if (!process.argv.includes('--live-synthetic')) {
  console.log('No requests made. Use --live-synthetic for approved local synthetic data; --hybrid requests embeddings; --answer sends selected synthetic excerpts to the configured Ark model.');
} else {
  const rows = []; let child; let answerRequests = 0;
  const answers = process.argv.includes('--answer');
  const check = (id, passed, extra = {}) => { rows.push({ id, passed: !!passed, ...extra }); };
  const file = process.env.WEKNORA_CONFIG_FILE || 'D:/wsl/private/yuanyu-zhinao/weknora.local.json';
  const principal = createHash('sha256').update(JSON.stringify(['demo-enterprise', 'admin@demo.local', 'executive'])).digest('hex');
  const kb = 'dc81f155-78f8-4f3f-9824-c47e0da841ab'; const doc = 'beaab191-c7b4-43dd-9586-b1e6ecbf8e80';
  try {
    const raw = await readFile(file, 'utf8');
    if (Buffer.byteLength(raw) > 65536) throw new Error('config');
    const config = JSON.parse(raw);
    const binding = config.bindings?.find(value => value.principalKey === principal);
    if (config.baseUrl !== 'http://127.0.0.1:18081' || binding?.knowledgeBaseId !== kb
      || binding?.tenantId !== 10000 || binding.knowledgeIds?.length !== 1 || binding.knowledgeIds[0] !== doc) throw new Error('scope');
    const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    child = spawn(process.execPath, [answers ? 'scripts/ark-runtime.mjs' : 'backend/src/app.js'], { windowsHide: true, stdio: 'ignore',
      env: { ...process.env, WEKNORA_CONFIG_FILE: file, NODE_ENV: 'development', RUNTIME_STORE_DRIVER: 'memory',
        DEMO_ALLOW_ROLE_HEADER: 'false', OA_AUTH_MODE: 'mock', DEMO_OA_PASSWORD: 'synthetic-evaluation-only',
        IDENTITY_PROVIDERS_FILE: '', API_HOST: '127.0.0.1', PORT: String(port), AGENT_RUNTIME_MODE: answers ? 'ark' : 'mock', KNOWLEDGE_MODEL_ALLOWED_MODES: answers ? 'ark' : '' } });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15000;
    while (true) {
      try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* bounded startup */ }
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('startup');
      await delay(150);
    }
    const device = 'weknora-synthetic-http-evaluation';
    async function call(path, session, payload, extraHeaders = {}) {
      const start = performance.now();
      const response = await fetch(`${base}${path}`, { method: payload === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'x-client-device-id': device,
          ...(session ? { 'x-identity-session': session } : {}), ...extraHeaders },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(60000) });
      return { status: response.status, data: await response.json(), elapsedMs: Math.round(performance.now() - start) };
    }
    const login = await call('/api/auth/oa/login', null, { account: 'admin@demo.local', password: 'synthetic-evaluation-only' });
    if (login.status !== 200 || !login.data.sessionId) throw new Error('login');
    const session = login.data.sessionId;
    const catalogue = await call('/api/agent/knowledge-library/joint-plans', session);
    check('business_plan_catalogue_without_published_model', catalogue.status === 200 && catalogue.data.available === false
      && catalogue.data.businessRead === false && catalogue.data.plans?.length === 0);
    const semanticCatalogue = await call('/api/semantic-operations/knowledge-library/joint-plans', session);
    check('semantic_has_no_business_plan_catalogue', semanticCatalogue.status === 404);
    const anonymousCatalogue = await call('/api/agent/knowledge-library/joint-plans', null);
    check('anonymous_plan_catalogue_denied', anonymousCatalogue.status === 401);
    for (const surface of ['agent', 'semantic-operations']) {
      const route = `/api/${surface}/knowledge-library`;
      const providers = await call(`${route}/providers`, session);
      check(`${surface}:configured_identity`, providers.status === 200 && providers.data.principalKey === principal && providers.data.providers?.some(item => item.provider === 'weknora_local' && item.configured));
      const result = await call(`${route}/brief`, session, { provider: 'weknora_local', query: '原料异常', limit: 3 });
      const evidence = result.data.evidence || [];
      check(`${surface}:real_retrieval`, result.status === 200 && evidence.length > 0 && evidence.every(item => item.citation.documentId === doc),
        { http: result.status, error: result.data.code || null, evidenceCount: evidence.length, elapsedMs: result.elapsedMs });
      if (evidence[0]) {
        const read = await call(`${route}/citation`, session, evidence[0].citation);
        check(`${surface}:citation_reread`, read.status === 200 && read.data.excerpt === evidence[0].excerpt);
        const tamper = await call(`${route}/citation`, session, { ...evidence[0].citation, documentId: 'outside-approved-document' });
        check(`${surface}:foreign_document_denied`, tamper.status === 404 && !tamper.data.excerpt);
        if (answers) {
          const policy = providers.data.answerPolicy;
          const history = [];
          for (const question of ['发生原料异常后多久登记，多久列出影响清单？', '那谁负责升级，可以直接解除冻结吗？', '实际影响多少订单，损失多少钱？']) {
            answerRequests++;
            const answer = await call(`${route}/answer`, session, { question, history: [...history], citations: evidence.map(item => item.citation),
              consent: { provider: policy.provider, model: policy.model, confirmed: true } });
            const valid = answer.status === 200 && answer.data.modelCalled === true && answer.data.model?.provider === 'ark'
              && answer.data.execution === 'none' && answer.data.published === false;
            check(`${surface}:answer_round_${history.length + 1}`, valid, { http: answer.status, error: answer.data.code || null,
              elapsedMs: answer.elapsedMs, syntheticExplanation: answer.data.claims?.map(item => item.text), unknowns: answer.data.unknowns });
            history.push(question);
          }
        }
      }
    }
    const foreign = await call('/api/auth/oa/login', null, { account: 'quality@demo.local', password: 'synthetic-evaluation-only' });
    if (!foreign.data.sessionId) throw new Error('foreign-login');
    const denied = await call('/api/agent/knowledge-library/brief', foreign.data.sessionId,
      { provider: 'weknora_local', query: '原料异常' }, { 'x-demo-role': 'executive' });
    check('unbound_authenticated_subject_denied_despite_role_header', denied.status === 403 && !denied.data.evidence);
    const anonymous = await call('/api/agent/knowledge-library/providers', null);
    check('anonymous_denied', anonymous.status === 401);
    if (process.argv.includes('--hybrid')) {
      const { createWeKnoraKnowledgeProvider } = await import('../backend/src/services/weknora-knowledge-provider.js');
      const { buildKnowledgeBrief } = await import('../backend/src/services/knowledge-evidence-service.js');
      const context = { identityScope: { tenantId: 'demo-enterprise', subjectId: 'admin@demo.local' }, roleId: 'executive' };
      const provider = createWeKnoraKnowledgeProvider({ context, apiKey: config.apiKey, baseUrl: config.baseUrl, retrievalMode: 'hybrid', timeoutMs: 10000,
        resolveScope: async () => (await readFile(file, 'utf8')) === raw ? binding : null });
      const started = performance.now();
      const answer = await buildKnowledgeBrief({ provider, query: '原料异常', limit: 3, canRead: () => true });
      check('real_hybrid_adapter', answer.status === 'evidence_ready' && answer.evidence.every(item => item.citation.documentId === doc),
        { error: answer.code || null, evidenceCount: answer.evidence?.length || 0, elapsedMs: Math.round(performance.now() - started), embedding: answer.diagnostics?.embedding });
    }
  } catch { check('setup_or_transport_failure', false); }
  finally { if (child && child.exitCode === null) child.kill(); }
  console.log(JSON.stringify({ scope: 'real_local_weknora_synthetic_kb_project_http_not_production_iam',
    answerRequests, upstreamWrites: 0, passed: rows.filter(row => row.passed).length, total: rows.length, rows }, null, 2));
  if (!rows.length || rows.some(row => !row.passed)) process.exitCode = 1;
}

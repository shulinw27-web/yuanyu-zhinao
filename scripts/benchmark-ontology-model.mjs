// Bounded, sequential AB/BA microbenchmark. Synthetic fixtures only; no servers,
// enterprise reads, user conversations or credentials written to the workspace.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadArkFileConfig } from './ark-file-config.mjs';
import { ARK_DEFAULT_BASE_URL, getArkRequestOptions } from '../backend/src/services/ark-model-config.js';
import { bufferDiagnosticStream } from './ark-stream-diagnostic.mjs';
import { dictionary, samples } from '../examples/semantic-schemas/supply-chain-incident/scenario.mjs';
import { fullReadPlan } from '../examples/semantic-schemas/supply-chain-incident/read-plan.mjs';
import { checkEvidenceRegression } from './ontology-evidence-regression-checks.mjs';
import { createOntologyClaimContext, validateOntologyClaims, renderOntologyClaims } from '../backend/src/services/ontology-analysis-claims.js';
const evidenceRegression = process.argv.includes('--evidence-regression');

Object.assign(process.env, { NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'memory', AGENT_RUNTIME_MODE: 'ark', AGENT_MODEL_CONFIG_SOURCE: 'environment', AGENT_EXTERNAL_DATA_MODE: 'full' });
loadArkFileConfig();
process.env.ARK_BASE_URL ||= ARK_DEFAULT_BASE_URL;
if (!process.env.ARK_API_KEY || !process.env.ARK_MODEL) throw new Error('BENCHMARK_ARK_NOT_CONFIGURED');
const { generateModelSummary } = await import('../backend/src/services/local-model-gateway.js');
const { discoverSchemasFromAttachments } = await import('../backend/src/services/semantic-schema-discovery-service.js');
const { executeOntologyReadPlan } = await import('../backend/src/services/ontology-read-plan-service.js');
const { buildOntologyAnalysisPrompt, encodeOntologyAnalysisEvidence, ontologyAnalysisComparisons } = await import('../backend/src/services/ontology-analysis-evidence.js');
const discovered = discoverSchemasFromAttachments({ attachments: [{ id: 'd', name: 'dictionary.json', mimeType: 'application/json' }], reports: [{ attachmentId: 'd', status: 'content_scanned', structuredSchemaCandidate: true }], documents: [{ attachmentId: 'd', text: JSON.stringify(dictionary) }] });
process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ 'demo-enterprise': { executive: { metadata: true, objects: Object.fromEntries(dictionary.tables.map(t => [t.name, { system: t.system, fields: t.fields.map(f => f.name), classifications: ['internal'] }])) } } });
const draft = { ...discovered, scenario: { readPlans: [fullReadPlan], requireCaseReplay: true }, accessPolicies: dictionary.tables.map(t => ({ objectType: t.name, effect: 'allow', roles: ['executive'], condition: 'iam_scope' })) };
const scope = { tenantId: 'demo-enterprise', subjectId: 'demo:executive:performance', source: 'demo_header' };
const comparisons = [];
for (const target of ['RAW-N1', 'RAW-N2']) comparisons.push({ target, ...await executeOntologyReadPlan({ draft, plan: fullReadPlan, target, roleId: 'executive', scope,
  retrieve: async (type, query) => samples.records.filter(r => r.objectType === type.id && query.filter.values.includes(r.payload[query.filter.field])) }) });
const cases = [
  { id: 'cause', input: '为什么会发生？哪些只是怀疑，哪些已经证实？接下来如何处理，请列证据、缺失材料和具体协作岗位。只讨论，不执行。', comparisons: comparisons.slice(0, 1) },
  { id: 'multi-root', input: '对比 RAW-N1 和 RAW-N2，供应商批号相同是否说明属于同一个原料问题？只读，不执行。', comparisons }
];
if (evidenceRegression) {
  const financeQuestion = '请核对 RAW-N1 的财务证据：分别列出每笔已到账记录和核销记录的编号、状态、金额及关联关系，再说明仍缺什么证据。没有提供的记录不要补造，不要将整体差额当成单笔金额，只读不执行。';
  cases.splice(1, 1, { id: 'finance', input: financeQuestion, comparisons: comparisons.slice(0, 1) });
  const absent = await executeOntologyReadPlan({ draft, plan: fullReadPlan, target: 'RAW-N1', roleId: 'executive', scope,
    retrieve: async (type, query) => samples.records.filter(r => r.objectType !== 'Allocation' && r.objectType === type.id && query.filter.values.includes(r.payload[query.filter.field])) });
  cases.push({ id: 'no-allocation', input: financeQuestion, comparisons: [{ target: 'RAW-N1', ...absent }] });
}
const selectedCase = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
if (selectedCase) {
  if (!cases.some(c => c.id === selectedCase)) throw new Error('BENCHMARK_UNKNOWN_CASE');
  cases.splice(0, cases.length, ...cases.filter(c => c.id === selectedCase));
}
const plannedCalls = cases.length * (evidenceRegression ? 4 : 6);
const out = resolve('output/ontology-model-ab', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const rows = []; const nativeFetch = globalThis.fetch;
let activeStream = null;
globalThis.fetch = async (url, options) => {
  // Restrict the diagnostic transport adapter to the configured Ark endpoint.
  if (!activeStream || String(url) !== `${process.env.ARK_BASE_URL.replace(/\/$/, '')}/chat/completions`) return nativeFetch(url, options);
  const startedAt = performance.now(); const measurement = { firstContentMs: null };
  activeStream.push(measurement);
  const response = await nativeFetch(url, { ...options, body: JSON.stringify({ ...JSON.parse(options.body), stream: true, stream_options: { include_usage: true } }) });
  measurement.responseHeadersMs = Math.round(performance.now() - startedAt); measurement.httpStatus = response.status;
  return bufferDiagnosticStream(response, measurement, startedAt, options.signal);
};
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
try {
  // Default: eight buffered ABBA + four SSE. Evidence regression: three
  // questions x two encodings x two transports, not a latency ABBA study.
  for (const mode of ['buffered', 'stream-diagnostic']) for (const item of cases) {
    const records = [...new Map(item.comparisons.flatMap(c => c.records).map(r => [`${r.system}:${r.objectType}:${r.id}`, r])).values()];
    const encoded = encodeOntologyAnalysisEvidence(records);
    const definition = JSON.stringify({ authority: 'synthetic_benchmark_schema_not_permissions', readPlans: [{ id: fullReadPlan.id, rootType: 'RawLot', outputs: fullReadPlan.outputs.map(({ id, label, unit }) => ({ id, label, unit })) }],
      glossaryTerms: [{ term: '预防性排查范围', definition: '实际领用产物沿 executed 拆合批边向后传播至无新后代；不反向扩大其他父批历史。' }, { term: '溯源与过错', definition: '筛查阳性待复检不等于定因，联系人不是过错认定。' }, { term: '财务暴露', definition: '订单金额不是赔付额；到账与核销分开，审批不等于执行。' }] });
    const coverage = { status: 'complete_for_declared_graph', globalEnterpriseCoverage: false, roots: item.comparisons.map(c => ({ target: c.target, ...c.coverage })) };
    const order = mode === 'buffered' && !evidenceRegression ? ['records', 'table', 'table', 'records'] : item.id === 'cause' ? ['records', 'table'] : ['table', 'records'];
    for (const variant of order) {
      const claimContext = createOntologyClaimContext(records, item.comparisons, fullReadPlan);
      const prompt = buildOntologyAnalysisPrompt({ input: item.input, definition, coverage, comparisons: ontologyAnalysisComparisons(item.comparisons, fullReadPlan), facts: variant === 'records' ? encoded.original : encoded.text, records, claimContext });
      activeStream = mode === 'stream-diagnostic' ? [] : null;
      const result = await generateModelSummary({ prompt, fallback: '', safetyIdentifier: 'ontology-executive', timeoutMs: 60000, answerContract: 'ontology_claims' });
      const checkedClaims = result.source === 'ark' ? validateOntologyClaims(result.text, claimContext) : null;
      const evidenceValidation = checkedClaims ? { passed: checkedClaims.passed, signals: checkedClaims.signals, code: checkedClaims.code } : null;
      const rendered = checkedClaims?.passed ? renderOntologyClaims(checkedClaims, claimContext) : null;
      const answer = rendered?.text || null;
      const evidenceChecks = evidenceRegression ? checkEvidenceRegression(answer, item.id) : null;
      const quality = evidenceRegression ? evidenceChecks.passed : answer && (item.id === 'cause' ? ['LAB-N1', 'QE-N1', 'PER-N1', 'PER-N2', 'PER-N3'].every(id => answer.includes(id)) && /未确认|尚未|不能|未证实/.test(answer)
        : ['SUP-N1', 'SUP-N2', 'LOT-N4', 'LOT-N5', 'LOT-N9'].every(id => answer.includes(id)) && /(?:共同|共享|重叠)[^。！？\n]{0,100}LOT-N[45]|LOT-N[45][^。！？\n]{0,100}(?:共同|共享|重叠)/.test(answer));
      const row = { sequence: rows.length + 1, case: item.id, mode, variant, promptCharacters: prompt.length, evidenceCharacters: variant === 'records' ? encoded.original.length : encoded.text.length,
        factsFingerprint: createHash('sha256').update(encoded.original).digest('hex'), source: result.source, timing: result.modelTiming, stream: activeStream,
        answerCharacters: answer?.length || 0, qualityChecksPassed: Boolean(quality && evidenceValidation?.passed), evidenceChecks, evidenceValidation, verification: rendered?.verification,
        syntheticProposal: result.source === 'ark' ? result.text : null, answer };
      rows.push(row); await writeFile(resolve(out, `${String(row.sequence).padStart(2, '0')}-${item.id}-${mode}-${variant}.json`), JSON.stringify(row, null, 2));
      console.log(JSON.stringify({ sequence: row.sequence, case: item.id, mode, variant, totalMs: row.timing.totalMs, source: result.source, quality: row.qualityChecksPassed, tokens: row.timing.usage, stream: activeStream }));
      if (result.source === 'circuit_breaker' || rows.slice(-3).length === 3 && rows.slice(-3).every(r => r.source !== 'ark')) throw new Error('BENCHMARK_REPEATED_FAILURE');
    }
  }
} catch (error) {
  const code = /^BENCHMARK_[A-Z_]+$/.test(error.message) ? error.message : 'BENCHMARK_FAILED_DETAILS_WITHHELD';
  await writeFile(resolve(out, 'failure.json'), JSON.stringify({ code })); process.exitCode = 1;
} finally {
  globalThis.fetch = nativeFetch;
  if (rows.length !== plannedCalls || rows.some(r => !r.qualityChecksPassed)) process.exitCode = 1;
  const groups = [];
  for (const mode of ['buffered', 'stream-diagnostic']) for (const item of cases) for (const variant of ['records', 'table']) {
    const selected = rows.filter(r => r.case === item.id && r.mode === mode && r.variant === variant);
    groups.push({ mode, case: item.id, variant, attempts: selected.length, successes: selected.filter(r => r.source === 'ark').length, qualityPasses: selected.filter(r => r.qualityChecksPassed).length,
      meanTotalMs: mean(selected.map(r => r.timing.totalMs)), meanPromptTokens: mean(selected.map(r => r.timing.usage?.prompt_tokens).filter(Number.isFinite)),
      meanCompletionTokens: mean(selected.map(r => r.timing.usage?.completion_tokens).filter(Number.isFinite)) });
  }
  await writeFile(resolve(out, 'summary.json'), JSON.stringify({ profile: evidenceRegression ? 'evidence-regression' : 'latency-abba', model: process.env.ARK_MODEL, settings: { temperature: 0.2, timeoutMs: 60000, ...getArkRequestOptions() }, syntheticOnly: true, enterpriseReads: 0, plannedCalls, completedCalls: rows.length, allPassed: rows.length === plannedCalls && rows.every(r => r.qualityChecksPassed), groups,
    notes: ['Isolated analysis microbenchmark, not publication/intent/desktop acceptance.', 'allPassed covers basic automated assertions only; manual semantic review is required.', evidenceRegression ? 'Evidence regression uses three questions and two encodings/transports, not latency ABBA or P95.' : 'ABBA is a small sequential sample; not P95 or proof of no cache/queue effects.', 'Buffered responseHeadersMs is NOT time to first token.', 'Diagnostic SSE firstContentMs includes JSON envelope prefix; not user-visible first answer. Stream output remains buffered until gateway safety validation.'] }, null, 2));
  console.log(JSON.stringify({ output: out, completedCalls: rows.length }));
}

import { getPublishedOntologyModel } from './meta-model-service.js';
import { executeOntologyReadPlan, getOntologyRuntimeGrant, requireOntologyObjectAccess } from './ontology-read-plan-service.js';
import { retrieveOntologyConnectorRecords } from './system-integration-service.js';
import { inspectModelPromptSafety, generateModelSummary } from './local-model-gateway.js';
import { admitSemanticRecord } from './semantic-record-contract-service.js';
import { modelFailureDiagnostics, prohibitsAction } from './agent-turn-understanding-service.js';
import { encodeOntologyAnalysisEvidence, buildOntologyAnalysisPrompt, ontologyAnalysisComparisons } from './ontology-analysis-evidence.js';
import { createOntologyClaimContext, validateOntologyClaims, renderOntologyClaims } from './ontology-analysis-claims.js';

// Current explicit factual follow-ups can require a fresh read even when the
// model proposes dialogue. Never promote failed understanding or write intent.
export function shouldRefreshPublishedRead({ input, turn, hasTaskRoot, materialOnly = false }) {
  // This is only a conservative correction to a successful dialogue intent.
  // A keyword alone ("联系人", "谁来") is not a request for source data.
  const terminology = /什么意思|什么含义|含义是什么|怎么理解|术语|这个词|解释.{0,8}(?:意思|含义)/.test(input);
  const factualFollowUp = /谁(?:来)?(?:牵头|负责|核(?:查|对)?(?:库存|财务))|联系人.{0,6}(?:是谁|有哪些|名单|编号)|(?:列出|核对|查询|查看).{0,12}(?:联系人|在职|有效指派|过期指派|实际影响)|哪些.{0,8}(?:证实|怀疑)|原因.{0,8}证据/.test(input);
  return Boolean(hasTaskRoot && !materialOnly && turn?.source !== 'understanding_failed' && turn?.intent === 'dialogue' && !turn.needsClarification
    && !prohibitsAction(input, 'read_business') && !/只(?:用|根据|分析).{0,8}(?:附件|材料)|沿用材料|解释.{0,8}(?:意思|含义|术语)/.test(input)
    && !terminology && factualFollowUp);
}

export async function getPublishedAgentOntology(roleId, scope) {
  const grant = getOntologyRuntimeGrant(scope, roleId);
  if (!grant?.metadata) return null;
  const published = await getPublishedOntologyModel();
  if (!published || published.tenantId !== scope.tenantId) return null;
  const draft = published.draft;
  const metadata = {
    modelVersion: published.version, modelFingerprint: published.fingerprint,
    authority: 'published_schema_not_business_facts_or_permissions',
    glossaryTerms: draft.glossaryTerms, metrics: (draft.metrics || []).map(m => ({ id: m.id, label: m.label, grain: m.grain, expression: m.expression })),
    readPlans: (draft.scenario?.readPlans || []).map(p => ({ id: p.id, label: p.label, rootType: p.datasets[0].objectType, outputs: p.outputs.map(o => ({ id: o.id, label: o.label, unit: o.unit })) }))
  };
  const prompt = JSON.stringify(metadata);
  if (prompt.length > 24000 || !inspectModelPromptSafety(prompt).safe) return null;
  return { published, metadata, prompt };
}

export async function runPublishedOntologyRead({ ontology, roleId, scope, target, input = '' }) {
  const plans = ontology.published.draft.scenario?.readPlans || [];
  const targets = [...new Set(Array.isArray(target) ? target : [target])];
  if (plans.length !== 1 || !targets.length || targets.length > 3 || targets.some(t => typeof t !== 'string' || !t || t.length > 100)) return { status: 'needs_input', code: 'ONTOLOGY_PLAN_SELECTION_REQUIRED', text: '请选择一个明确的只读方案和最多三个根对象编号；本次未读取数据。' };
  const readStartedAt = Date.now();
  try {
    const comparisons = [];
    for (const id of targets) comparisons.push({ target: id, ...await executeOntologyReadPlan({ draft: ontology.published.draft, plan: plans[0], target: id, roleId, scope,
      retrieve: (type, query) => retrieveOntologyConnectorRecords(type, query, roleId, scope) }) });
    const combined = new Map();
    for (const record of comparisons.flatMap(r => r.records)) {
      const key = `${record.system}:${record.objectType}:${record.id}`;
      if (combined.has(key) && JSON.stringify(combined.get(key)) !== JSON.stringify(record)) throw new Error('READ_RECORD_CONFLICT');
      combined.set(key, record);
    }
    const records = [...combined.values()];
    const queries = comparisons.flatMap(c => c.queries);
    const results = comparisons.length === 1 ? comparisons[0].results : [];
    const timing = { sourceReadMs: Date.now() - readStartedAt, analysisMs: 0 };
    const fullRequested = /全部|完整|全链|全范围/.test(input);
    const coverage = { status: comparisons.every(c => c.coverage.status === 'complete_for_declared_graph') ? 'complete_for_declared_graph' : 'declared_plan_only', globalEnterpriseCoverage: false,
      roots: comparisons.map(c => ({ target: c.target, ...c.coverage })) };
    const partial = fullRequested && coverage.status !== 'complete_for_declared_graph';
    const dates = [...new Set(records.map(r => r.occurredAt))];
    const factual = comparisons.map(c => `${c.target}：\n${c.results.map(r => `${r.label}：${typeof r.value === 'boolean' ? r.value ? '是' : '否' : r.value}${r.unit ? ` ${r.unit}` : ''}`).join('\n')}`).join('\n\n');
    let analysis = { status: 'not_requested', source: null }; let answer = factual;
    if (plans[0].analysis?.enabled) {
      const encoded = encodeOntologyAnalysisEvidence(records);
      // Keep the original budget and safety surface. Encoding must not let a
      // formerly blocked payload bypass the gateway's prompt security checks.
      const useEncoded = inspectModelPromptSafety(encoded.original).safe;
      const facts = useEncoded ? encoded.text : encoded.original;
      if (encoded.original.length > 38000) analysis = { status: 'incomplete', source: null, code: 'ANALYSIS_EVIDENCE_BUDGET' };
      else {
        const claimContext = createOntologyClaimContext(records, comparisons, plans[0]);
        const focusedPrompt = buildOntologyAnalysisPrompt({ input, definition: ontology.prompt, coverage, comparisons: ontologyAnalysisComparisons(comparisons, plans[0]), facts, records, claimContext });
        timing.analysisPromptCharacters = focusedPrompt.length;
        timing.evidenceOriginalCharacters = encoded.original.length;
        timing.evidenceSentCharacters = facts.length;
        timing.evidenceFormat = useEncoded ? encoded.format : 'records';
        const analysisStartedAt = Date.now();
        const generated = await generateModelSummary({ prompt: focusedPrompt, fallback: '', safetyIdentifier: `ontology-${roleId}`, timeoutMs: 60000, answerContract: 'ontology_claims' });
        timing.model = generated.modelTiming;
        const succeeded = ['ark', 'local', 'openai', 'deepseek', 'compatible'].includes(generated.source);
        timing.analysisProposalCharacters = succeeded ? generated.text.length : 0;
        timing.analysisAnswerCharacters = 0;
        analysis = { status: succeeded ? 'completed' : 'incomplete', source: generated.source, diagnostics: modelFailureDiagnostics(generated) };
        if (succeeded) {
          const evidenceValidation = validateOntologyClaims(generated.text, claimContext);
          analysis.evidenceValidation = { passed: evidenceValidation.passed, signals: evidenceValidation.signals };
          if (evidenceValidation.passed) {
            const rendered = renderOntologyClaims(evidenceValidation, claimContext);
            answer = rendered.text; analysis.verification = rendered.verification; analysis.citations = rendered.citations;
            timing.analysisAnswerCharacters = rendered.text.length;
          } else analysis = { ...analysis, status: 'incomplete', code: evidenceValidation.code, diagnostics: { stage: 'evidence_validation', signals: evidenceValidation.signals, rawModelOutputStored: false } };
        }
        timing.analysisMs = Date.now() - analysisStartedAt;
      }
    }
    // Recheck AFTER model latency too: no revoked data or stale model answers.
    for (const r of records) {
      const { grant } = requireOntologyObjectAccess(ontology.published.draft, r.objectType, roleId, scope);
      if (!grant.classifications.includes(r.classification) || !admitSemanticRecord(r, roleId, scope, true)) throw new Error('READ_RECORD_SCOPE');
    }
    const current = await getPublishedAgentOntology(roleId, scope);
    if (current?.published.version !== ontology.published.version || current?.published.fingerprint !== ontology.published.fingerprint) throw new Error('ONTOLOGY_VERSION_CHANGED');
    const status = partial || analysis.status === 'incomplete' ? 'partial' : 'completed';
    return { status, code: status === 'partial' ? 'ONTOLOGY_READ_PARTIAL' : 'ONTOLOGY_READ_COMPLETED', results, queries, records, coverage, analysis, timing,
      comparisons: comparisons.map(c => ({ target: c.target, results: c.results, coverage: c.coverage })), metadata: ontology.metadata,
      text: `${partial ? '当前只完成声明计划的局部读取，不能代表完整影响范围。\n' : ''}${analysis.status === 'incomplete' ? '计算已完成，但解释未通过校验或预算限制，尚未完成分析。\n' : ''}${answer}\n\n依据：已发布模型 ${ontology.published.version}（${ontology.published.fingerprint}）；${records.length} 条授权来源记录、${queries.length} 个关联查询步骤。\n记录时间：${dates.join('、')}。这是来源快照计算，不作实时履约承诺；本次未执行任何业务写入。` };
  } catch (error) {
    const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'ONTOLOGY_SOURCE_UNAVAILABLE';
    return { status: 'incomplete', code, metadata: ontology.metadata,
      text: `本轮模型关联核验未完成（${code}）。请检查发布模型的对象授权、关联字段和连接器完整性；没有用缺失记录当作零，也没有执行业务操作。` };
  }
}

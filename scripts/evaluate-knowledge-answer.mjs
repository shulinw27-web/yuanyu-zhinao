// Explicit live switch: four paid model calls, synthetic fixture only, memory store.
import { readFile } from 'node:fs/promises';
import { loadArkFileConfig } from './ark-file-config.mjs';
if (!process.argv.includes('--live-synthetic')) {
  console.log('Use --live-synthetic for four real Ark calls using only the repository synthetic policy. No enterprise data or persistent state.');
  process.exit(0);
}
process.env.NODE_ENV = 'test'; process.env.RUNTIME_STORE_DRIVER = 'memory';
process.env.AGENT_RUNTIME_MODE = process.env.AGENT_RUNTIME_MODE || 'ark'; process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
process.env.KNOWLEDGE_MODEL_ALLOWED_MODES = process.env.KNOWLEDGE_MODEL_ALLOWED_MODES || 'ark';
if (process.env.AGENT_RUNTIME_MODE === 'ark') { try { loadArkFileConfig(); } catch { console.error('ARK_CONFIG_UNAVAILABLE: contents withheld'); process.exit(2); } }
const { saveLibraryDocument } = await import('../backend/src/services/knowledge-library-service.js');
const { createLocalKnowledgeProvider, buildKnowledgeBrief } = await import('../backend/src/services/knowledge-evidence-service.js');
const { answerKnowledgeQuestion, knowledgeAnswerPolicy } = await import('../backend/src/services/knowledge-answer-service.js');
const { generateLocalSummary } = await import('../backend/src/services/local-model-gateway.js');
const context = { identityScope: { tenantId: 'synthetic-evaluation', subjectId: 'knowledge-evaluator' }, roleId: 'executive' };
const text = await readFile(new URL('../examples/knowledge/synthetic-supply-chain-policy.txt', import.meta.url), 'utf8');
await saveLibraryDocument({ ...context, id: 'synthetic-policy', body: { expectedRevision: 0, title: '合成供应链制度', source: 'repository synthetic fixture', sourceVersion: 'v1', kind: 'policy', text } });
const provider = createLocalKnowledgeProvider(context);
const brief = await buildKnowledgeBrief({ provider, query: '采购质量异常', canRead: () => true });
if (!brief.evidence?.length) { console.error('SYNTHETIC_EVIDENCE_NOT_FOUND'); process.exit(2); }
const model = knowledgeAnswerPolicy(); const history = []; let failures = 0;
for (const [id, question, purpose] of [
  ['timing', '原料质量异常的登记、影响清单和升级要求分别是什么？', 'answer'],
  ['followup', '那谁能解除冻结？你可以直接替我解除吗？', 'answer'],
  ['unknown-facts', '这次实际影响了多少订单，损失了多少钱？资料没写就直接说不能确定，不要估算。', 'answer'],
  ['wiki', '原料质量异常协作规则与建模关注点', 'wiki']
]) {
  const start = performance.now();
  const result = await answerKnowledgeQuestion({ body: { question, history: [...history], purpose,
    citations: brief.evidence.map(item => item.citation), consent: { confirmed: true, provider: model.provider, model: model.model } },
    resolveProvider: () => provider, canRead: () => true, safetyIdentifier: 'knowledge-synthetic-evaluation',
    generate: async input => {
      const output = await generateLocalSummary(input);
      // Opt-in diagnostics for this hardcoded synthetic fixture only, never credentials.
      if (process.argv.includes('--diagnose-synthetic')) console.log(JSON.stringify({ case: id, syntheticProposal: output.text, source: output.source }));
      return output;
    } });
  if (result.error) failures++;
  console.log(JSON.stringify({ case: id, elapsedMs: Math.round(performance.now() - start), contractPassed: !result.error,
    error: result.code || null, claims: result.claims, unknowns: result.unknowns, model: result.model,
    verification: result.verification, scope: 'synthetic_nonblind_quote_contract_not_accuracy_certification' }));
  history.push(question);
  if (process.argv.includes('--first-only')) break;
}
process.exitCode = failures ? 1 : 0;

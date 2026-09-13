import { buildKnowledgeBrief, knowledgeDigest, knowledgeFailure, validKnowledgeQuery } from './knowledge-evidence-service.js';
import { prepareKnowledgeStudy } from './knowledge-study-service.js';
import { assessPromptContent } from './prompt-security-service.js';

// One explicit, bounded search per provider, only in documents already selected.
// Preview first; this endpoint never invokes a model or grants cloud consent.
export async function supplementKnowledgeSources({ body, resolveProvider, canRead }) {
  if (!body || Array.isArray(body) || Object.keys(body).some(key => !['question', 'citations', 'confirmed'].includes(key))
    || body.confirmed !== true || !validKnowledgeQuery(body.question, 5)
    || !assessPromptContent(body.question, { source: 'knowledge_supplement', maxCharacters: 4000 }).safe) return knowledgeFailure('KNOWLEDGE_SUPPLEMENT_INPUT_INVALID');
  const read = citations => prepareKnowledgeStudy({ body: { title: '本轮补查资料', citations }, resolveProvider, canRead });
  const before = await read(body.citations); if (before.error) return before;
  const providers = [...new Set(before.sources.map(s => s.provider))];
  if (providers.some(id => !['weknora_local', 'local_private_library'].includes(id))) return knowledgeFailure('KNOWLEDGE_ACCESS_DENIED', 403);
  const evidence = []; let searches = 0;
  for (const id of providers) {
    const documentIds = [...new Set(before.sources.filter(s => s.provider === id).map(s => s.id))];
    const result = await buildKnowledgeBrief({ provider: await resolveProvider(id), query: body.question, limit: 5, documentIds, canRead });
    if (result.error) return result;
    evidence.push(...result.evidence); searches++;
  }
  const after = await read(body.citations); if (after.error) return after;
  if (knowledgeDigest(before.sources) !== knowledgeDigest(after.sources)) return knowledgeFailure('KNOWLEDGE_EVIDENCE_CHANGED', 409);
  const selected = evidence.slice(0, 5);
  if (!selected.length) return { evidence: [], modelCalled: false, execution: 'none', searches, consentRequired: true, scope: 'selected_documents_only' };
  const verified = await read(selected.map(s => s.citation)); if (verified.error) return verified;
  if (knowledgeDigest(selected) !== knowledgeDigest(verified.sources)) return knowledgeFailure('KNOWLEDGE_EVIDENCE_CHANGED', 409);
  return { evidence: verified.sources, modelCalled: false, execution: 'none', searches, consentRequired: true,
    scope: 'selected_documents_only', selection: 'preview_replaces_current_excerpts_after_user_review' };
}

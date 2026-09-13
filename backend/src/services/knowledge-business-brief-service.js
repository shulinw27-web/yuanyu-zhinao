import { knowledgeDigest, knowledgeFailure, validKnowledgeId, validKnowledgeIdentity, validKnowledgeQuery } from './knowledge-evidence-service.js';
import { prepareKnowledgeStudy } from './knowledge-study-service.js';
import { getPublishedAgentOntology, runPublishedOntologyRead, validatePublishedReadEvidence } from './published-ontology-agent-service.js';
import { assessPromptContent } from './prompt-security-service.js';
import { prohibitsAction } from './agent-turn-understanding-service.js';

// Explicit read-only composition. Keep policy excerpts separate from business facts;
// this endpoint neither calls a model nor infers execution authorization from a document.
export async function buildKnowledgeBusinessBrief({ context, body, resolveProvider, canRead,
  getOntology = getPublishedAgentOntology, readBusiness = runPublishedOntologyRead, revalidateBusiness = validatePublishedReadEvidence }) {
  if (!validKnowledgeIdentity(context) || typeof canRead !== 'function') return knowledgeFailure('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!body || Array.isArray(body) || Object.keys(body).some(key => !['question', 'targets', 'citations', 'confirmed'].includes(key))
    || body.confirmed !== true || !validKnowledgeQuery(body.question, 5) || !Array.isArray(body.targets)
    || body.targets.length < 1 || body.targets.length > 3 || !body.targets.every(validKnowledgeId)
    || new Set(body.targets).size !== body.targets.length || prohibitsAction(body.question, 'read_business')
    || !assessPromptContent(body.question, { source: 'joint_read_question', maxCharacters: 4000 }).safe) return knowledgeFailure('KNOWLEDGE_JOINT_INPUT_INVALID');
  try {
    if (!await canRead()) return knowledgeFailure('KNOWLEDGE_ACCESS_DENIED', 403);
    const knowledge = () => prepareKnowledgeStudy({ body: { title: '联合核验依据', citations: body.citations }, resolveProvider, canRead });
    const before = await knowledge(); if (before.error) return before;
    const ontology = await getOntology(context.roleId, context.identityScope);
    if (!ontology) return knowledgeFailure('KNOWLEDGE_PUBLISHED_MODEL_REQUIRED', 409);
    const execute = () => readBusiness({ ontology, roleId: context.roleId, scope: context.identityScope,
      target: body.targets, input: body.question, allowModelAnalysis: false });
    const first = await execute();
    const ready = result => ['completed', 'partial'].includes(result?.status) && Array.isArray(result.records)
      && result.analysis?.status === 'not_requested';
    if (!ready(first)) return knowledgeFailure('KNOWLEDGE_BUSINESS_READ_INCOMPLETE', 409);
    const after = await knowledge(); if (after.error) return after;
    if (knowledgeDigest(before.sources) !== knowledgeDigest(after.sources)) return knowledgeFailure('KNOWLEDGE_EVIDENCE_CHANGED', 409);
    // Re-read the bounded declared graph, not just its IAM flags, after other I/O.
    // Changed business records must not be returned as if part of a stable snapshot.
    if (!await canRead()) return knowledgeFailure('KNOWLEDGE_ACCESS_DENIED', 403);
    const second = await execute();
    const facts = result => ({ records: result.records, results: result.results, comparisons: result.comparisons, coverage: result.coverage });
    if (!ready(second) || knowledgeDigest(facts(first)) !== knowledgeDigest(facts(second))) return knowledgeFailure('KNOWLEDGE_BUSINESS_EVIDENCE_CHANGED', 409);
    const finalSources = await knowledge(); if (finalSources.error) return finalSources;
    const current = await getOntology(context.roleId, context.identityScope);
    if (!await canRead() || !current) return knowledgeFailure('KNOWLEDGE_ACCESS_DENIED', 403);
    if (current.published.fingerprint !== ontology.published.fingerprint || current.published.version !== ontology.published.version
      || knowledgeDigest(after.sources) !== knowledgeDigest(finalSources.sources)) return knowledgeFailure('KNOWLEDGE_EVIDENCE_CHANGED', 409);
    if (!await revalidateBusiness({ ontology, roleId: context.roleId, scope: context.identityScope, records: second.records }) || !await canRead()) return knowledgeFailure('KNOWLEDGE_ACCESS_DENIED', 403);
    return { mode: 'knowledge_business_readonly_comparison', execution: 'none', modelCalled: false, published: false, persisted: false,
      status: second.status, knowledge: { sources: finalSources.sources, sourceReview: finalSources.sourceReview,
        authority: 'reference_not_business_facts_or_permissions' },
      business: { results: second.results, comparisons: second.comparisons, coverage: second.coverage, metadata: second.metadata,
        recordCount: second.records.length, text: second.text,
        provenance: second.records.map(record => ({ id: record.id, objectType: record.objectType, system: record.system, occurredAt: record.occurredAt })) },
      boundaries: ['仅核验所选来源与声明读取图，不代表全企业覆盖。', '制度不决定实际数量、金额或处置授权。', '未判断制度适用性或因果关系，未执行处置。'],
      verification: 'repeated_source_and_business_snapshot_checks_not_atomic_cross_system_transaction' };
  } catch { return knowledgeFailure('KNOWLEDGE_JOINT_UNAVAILABLE', 503); }
}

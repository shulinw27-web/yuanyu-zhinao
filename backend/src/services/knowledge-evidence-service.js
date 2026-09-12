import { createHash } from 'node:crypto';
import { readLibraryDocument, searchLibraryDocuments } from './knowledge-library-service.js';
import { assessPromptContent } from './prompt-security-service.js';

export const knowledgeDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const knowledgeFailure = (code, status = 400) => ({ error: code, code, status });
export const validKnowledgeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
export const validKnowledgeQuery = (query, limit) => typeof query === 'string' && query.trim().length > 0 && query.length <= 4000
  && Number.isInteger(limit) && limit >= 1 && limit <= 5;
export const validKnowledgeIdentity = context => [context?.identityScope?.tenantId, context?.identityScope?.subjectId, context?.roleId]
  .every(value => typeof value === 'string' && value.trim() && value.length <= 160)
  && context.identityScope.subjectId !== 'anonymous'
  && (context.identityScope.source !== 'demo_header' || Boolean(context.identityScope.deviceId));

export function createLocalKnowledgeProvider(context) {
  // A provider is bound to a server-resolved principal, not a client-selected role.
  const scope = structuredClone(context);
  const id = 'local_private_library';
  return {
    id,
    status: () => ({ provider: id, mode: 'lexical_bm25', configured: true, embedding: 'not_configured', rerank: 'not_configured' }),
    async search({ query, limit = 5 }) {
      const found = await searchLibraryDocuments({ ...scope, query, limit });
      if (found.error) return found;
      return { ...found, results: found.results.map(item => ({ ...item, provider: id,
        citation: { ...item.citation, provider: id, contentHash: item.contentHash } })) };
    },
    async read(citation) {
      if (!citation || Array.isArray(citation) || Object.keys(citation).some(key => !['provider', 'documentId', 'revision', 'chunkId', 'start', 'end', 'location', 'contentHash'].includes(key))
        || citation.provider !== id || !validKnowledgeId(citation.documentId)
        || !Number.isInteger(citation.revision) || citation.revision < 1
        || typeof citation.chunkId !== 'string' || !Number.isInteger(citation.start) || !Number.isInteger(citation.end)
        || !/^[a-f0-9]{64}$/.test(citation.contentHash || '')) return knowledgeFailure('KNOWLEDGE_CITATION_INVALID');
      const document = await readLibraryDocument({ ...scope, id: citation.documentId, revision: citation.revision });
      if (document.error) return document;
      const chunk = document.chunks.find(item => item.id === citation.chunkId);
      if (!chunk || document.contentHash !== citation.contentHash || chunk.start !== citation.start || chunk.end !== citation.end
        || chunk.location !== citation.location) return knowledgeFailure('KNOWLEDGE_CITATION_STALE', 409);
      return { provider: id, id: document.id, title: document.title, source: document.source, sourceVersion: document.sourceVersion,
        revision: document.revision, contentHash: document.contentHash, kind: document.kind, excerpt: chunk.text,
        citation: { provider: id, documentId: document.id, revision: document.revision, contentHash: document.contentHash,
          chunkId: chunk.id, start: chunk.start, end: chunk.end, location: chunk.location },
        evidenceType: 'document_reference_not_live_business_fact' };
    }
  };
}

const safeEvidence = item => item && typeof item.excerpt === 'string' && item.excerpt.length > 0 && item.excerpt.length <= 12000
  && typeof item.title === 'string' && item.title.length <= 200 && typeof item.source === 'string' && item.source.length <= 500
  && item.evidenceType === 'document_reference_not_live_business_fact'
  && item.citation?.provider === item.provider
  && assessPromptContent([item.title, item.source, item.excerpt].join('\n'), { source: 'knowledge_evidence', maxCharacters: 14000 }).safe;

// No cache, model call, tools or side effects. The caller supplies a live page/identity guard.
// This is an extractive briefing, NOT a generated business answer or a publication.
export async function buildKnowledgeBrief({ provider, query, limit = 5, canRead }) {
  if (!validKnowledgeQuery(query, limit)) return knowledgeFailure('KNOWLEDGE_QUERY_INVALID');
  try {
    if (typeof canRead !== 'function' || !await canRead()) return knowledgeFailure('KNOWLEDGE_ACCESS_DENIED', 403);
    const result = await provider.search({ query, limit });
    if (result.error) return result;
    if (!Array.isArray(result.results) || result.results.length > limit) return knowledgeFailure('KNOWLEDGE_PROVIDER_RESPONSE_INVALID', 502);
    const evidence = [];
    for (const candidate of result.results) {
      if (!await canRead()) return knowledgeFailure('KNOWLEDGE_ACCESS_DENIED', 403);
      const fresh = await provider.read(candidate.citation);
      if (fresh.error) return knowledgeFailure('KNOWLEDGE_EVIDENCE_CHANGED', 409);
      // Search text and metadata cannot override the authoritative source read.
      if (!safeEvidence(fresh)) return knowledgeFailure('KNOWLEDGE_CONTENT_REJECTED');
      evidence.push(fresh);
      if (evidence.reduce((total, item) => total + item.excerpt.length, 0) > 16000) return knowledgeFailure('KNOWLEDGE_EVIDENCE_BUDGET_EXCEEDED', 413);
    }
    // Before delivery, recheck every cited source. Drop the entire response on change,
    // rather than return an answer whose vanished citation no longer supports it.
    for (const item of evidence) {
      const fresh = await provider.read(item.citation);
      if (fresh.error || knowledgeDigest(fresh) !== knowledgeDigest(item)) return knowledgeFailure('KNOWLEDGE_EVIDENCE_CHANGED', 409);
    }
    if (!await canRead()) return knowledgeFailure('KNOWLEDGE_ACCESS_DENIED', 403);
    return { schemaVersion: 'knowledge-brief.v1', status: evidence.length ? 'evidence_ready' : 'no_evidence',
      mode: 'extractive_no_llm', provider: provider.id, evidence,
      message: evidence.length ? '以下是当前可访问资料的原文摘录；不是实时业务事实，也未执行任何业务操作。' : '当前可访问资料中没有找到依据。',
      execution: 'none', modelCalled: false, published: false,
      diagnostics: { evidenceCount: evidence.length, sourceChecks: evidence.length * 2, embedding: 'not_used', rerank: 'not_used' } };
  } catch { return knowledgeFailure('KNOWLEDGE_PROVIDER_UNAVAILABLE', 503); }
}

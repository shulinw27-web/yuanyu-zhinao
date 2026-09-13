import { knowledgeDigest, knowledgeFailure, validKnowledgeId, validKnowledgeIdentity, validKnowledgeQuery } from './knowledge-evidence-service.js';
import { assessPromptContent } from './prompt-security-service.js';
import { extractQueryBusinessIds, matchingQueryBusinessIds } from './agent-query-service.js';

const providerId = 'weknora_local';
const reject = (code, status = 502) => { throw Object.assign(new Error(code), { code, status }); };
const handled = error => knowledgeFailure(typeof error?.code === 'string' && error.code.startsWith('KNOWLEDGE_') ? error.code : 'KNOWLEDGE_PROVIDER_UNAVAILABLE', error?.status || 503);
export const knowledgePrincipalKey = context => validKnowledgeIdentity(context)
  ? knowledgeDigest([context.identityScope.tenantId, context.identityScope.subjectId, context.roleId]) : null;

// Server-only factory. Not registered from request bodies/environment automatically.
// v0.8.0 read adapter: explicit document allowlist, opt-in hybrid, no uploads.
export function createWeKnoraKnowledgeProvider({ context, baseUrl = 'http://127.0.0.1:18081', apiKey, resolveScope, timeoutMs = 2000, retrievalMode = 'keyword_only' } = {}) {
  const scope = structuredClone(context);
  const principalKey = knowledgePrincipalKey(scope);
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('KNOWLEDGE_LOCAL_ENDPOINT_INVALID');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10000) throw new Error('KNOWLEDGE_TIMEOUT_INVALID');
  if (!['keyword_only', 'hybrid'].includes(retrievalMode)) throw new Error('KNOWLEDGE_RETRIEVAL_MODE_INVALID');
  const configured = typeof apiKey === 'string' && apiKey.length > 0 && !/[\r\n]/.test(apiKey) && typeof resolveScope === 'function';
  async function binding() {
    if (!configured) reject('KNOWLEDGE_PROVIDER_NOT_CONFIGURED', 503);
    if (!principalKey) reject('KNOWLEDGE_IDENTITY_REQUIRED', 403);
    const value = await resolveScope(structuredClone(scope));
    if (!value || value.principalKey !== principalKey || !Number.isSafeInteger(value.tenantId) || value.tenantId < 1
      || !validKnowledgeId(value.knowledgeBaseId) || !Array.isArray(value.knowledgeIds) || !value.knowledgeIds.length
      || value.knowledgeIds.length > 32 || !value.knowledgeIds.every(validKnowledgeId)) reject('KNOWLEDGE_ACCESS_DENIED', 403);
    return structuredClone(value);
  }
  async function request(path, body) {
    const response = await fetch(`${origin.origin}/api/v1${path}`, { method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      await response.body?.cancel();
      reject(response.status === 401 || response.status === 403 ? 'KNOWLEDGE_UPSTREAM_ACCESS_DENIED'
        : response.status === 404 ? 'KNOWLEDGE_DOCUMENT_NOT_FOUND' : 'KNOWLEDGE_UPSTREAM_FAILURE',
      response.status === 401 || response.status === 403 ? 403 : response.status === 404 ? 404 : 503);
    }
    let size = 0; const buffers = [];
    for await (const part of response.body) {
      size += part.length;
      if (size > 256 * 1024) reject('KNOWLEDGE_RESPONSE_TOO_LARGE', 502);
      buffers.push(part);
    }
    let json;
    try { json = JSON.parse(Buffer.concat(buffers).toString('utf8')); }
    catch { reject('KNOWLEDGE_PROVIDER_RESPONSE_INVALID'); }
    if (json?.success !== true || json.data === undefined) reject('KNOWLEDGE_PROVIDER_RESPONSE_INVALID');
    return json.data;
  }
  function inScope(value, grant) {
    return value && value.tenant_id === grant.tenantId && value.knowledge_base_id === grant.knowledgeBaseId;
  }
  async function load(documentId, chunkId) {
    const grant = await binding();
    if (!validKnowledgeId(documentId) || !validKnowledgeId(chunkId) || !grant.knowledgeIds.includes(documentId)) reject('KNOWLEDGE_DOCUMENT_NOT_FOUND', 404);
    const document = await request(`/knowledge/${documentId}`);
    if (!inScope(document, grant) || document.id !== documentId || document.deleted_at
      || document.enable_status !== 'enabled' || document.parse_status !== 'completed') reject('KNOWLEDGE_DOCUMENT_NOT_FOUND', 404);
    const chunk = await request(`/chunks/by-id/${chunkId}`);
    if (!inScope(chunk, grant) || chunk.id !== chunkId || chunk.knowledge_id !== documentId
      || chunk.deleted_at || chunk.is_enabled !== true || ![0, 2].includes(chunk.status)) reject('KNOWLEDGE_DOCUMENT_NOT_FOUND', 404);
    // v0.8.0's repository treats Default(0) and Indexed(2) as available;
    // Stored(1) is pending. Generated summaries are not authoritative source text.
    if (chunk.chunk_type !== 'text') reject('KNOWLEDGE_CHUNK_TYPE_UNSUPPORTED', 422);
    if (typeof chunk.content !== 'string' || !chunk.content.trim() || chunk.content.length > 12000
      || typeof document.title !== 'string' || !document.title.trim() || document.title.length > 200
      || !Number.isFinite(Date.parse(document.updated_at)) || !Number.isFinite(Date.parse(chunk.updated_at))) reject('KNOWLEDGE_PROVIDER_RESPONSE_INVALID');
    if (!assessPromptContent(`${document.title}\n${chunk.content}`, { source: 'weknora_document', maxCharacters: 14000 }).safe) reject('KNOWLEDGE_CONTENT_REJECTED', 400);
    const freshGrant = await binding();
    if (knowledgeDigest(grant) !== knowledgeDigest(freshGrant)) reject('KNOWLEDGE_ACCESS_DENIED', 403);
    const revision = knowledgeDigest([document.id, document.updated_at, document.title, chunk.id, chunk.updated_at, chunk.content]);
    return { provider: providerId, id: documentId, title: document.title, source: 'WeKnora 授权知识资料',
      sourceVersion: document.updated_at, revision, contentHash: knowledgeDigest(chunk.content), kind: 'reference', excerpt: chunk.content,
      citation: { provider: providerId, knowledgeBaseId: grant.knowledgeBaseId, documentId, chunkId, revision, location: 'provider_chunk_not_pdf_coordinates' },
      evidenceType: 'document_reference_not_live_business_fact' };
  }
  return {
    id: providerId,
    status: () => ({ provider: providerId, configured, mode: retrievalMode, embedding: retrievalMode === 'hybrid' ? 'provider_managed' : 'disabled', rerank: 'disabled', readiness: 'not_live_verified' }),
    async search({ query, limit = 5 }) {
      if (!validKnowledgeQuery(query, limit)) return knowledgeFailure('KNOWLEDGE_QUERY_INVALID');
      try {
        const grant = await binding();
        const candidates = await request(`/knowledge-bases/${grant.knowledgeBaseId}/hybrid-search`, {
          query_text: query, match_count: limit, knowledge_ids: grant.knowledgeIds,
          disable_vector_match: retrievalMode !== 'hybrid', disable_keywords_match: false, skip_context_enrichment: true
        });
        if (!Array.isArray(candidates) || candidates.length > limit) reject('KNOWLEDGE_PROVIDER_RESPONSE_INVALID');
        const results = []; const seen = new Set(); const businessIds = extractQueryBusinessIds(query);
        for (const candidate of candidates) {
          // Never trust returned snippets, URLs or a provider's claim of authority.
          if (!validKnowledgeId(candidate?.id) || !grant.knowledgeIds.includes(candidate?.knowledge_id)) reject('KNOWLEDGE_PROVIDER_SCOPE_MISMATCH', 403);
          if (seen.has(candidate.id)) continue;
          seen.add(candidate.id);
          let evidence;
          try { evidence = await load(candidate.knowledge_id, candidate.id); }
          catch (error) {
            if (error.code === 'KNOWLEDGE_CHUNK_TYPE_UNSUPPORTED') continue;
            throw error;
          }
          if (businessIds.length && matchingQueryBusinessIds({ id: evidence.id, text: evidence.excerpt }, businessIds).length !== businessIds.length) continue;
          results.push(evidence);
        }
        if (knowledgeDigest(grant) !== knowledgeDigest(await binding())) reject('KNOWLEDGE_ACCESS_DENIED', 403);
        return { mode: `weknora_${retrievalMode}`, results, noEvidence: !results.length,
          retrieval: { embedding: retrievalMode === 'hybrid' ? 'provider_requested_not_attested' : 'not_used', rerank: 'not_used' } };
      } catch (error) { return handled(error); }
    },
    async read(citation) {
      if (!citation || citation.provider !== providerId || !validKnowledgeId(citation.knowledgeBaseId)
        || !/^[a-f0-9]{64}$/.test(citation.revision || '') || citation.location !== 'provider_chunk_not_pdf_coordinates') return knowledgeFailure('KNOWLEDGE_CITATION_INVALID');
      try {
        const grant = await binding();
        if (citation.knowledgeBaseId !== grant.knowledgeBaseId) reject('KNOWLEDGE_DOCUMENT_NOT_FOUND', 404);
        const fresh = await load(citation.documentId, citation.chunkId);
        if (fresh.revision !== citation.revision || fresh.citation.knowledgeBaseId !== citation.knowledgeBaseId) reject('KNOWLEDGE_CITATION_STALE', 409);
        return fresh;
      } catch (error) { return handled(error); }
    }
  };
}

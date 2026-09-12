import { createHash } from 'node:crypto';
import { readSemanticGovernanceState, mutateSemanticGovernanceWithEvent } from './semantic-governance-store.js';
import { assessPromptContent } from './prompt-security-service.js';
import { previewKnowledgeChunks, rankKnowledgeChunks } from './knowledge-retrieval-engine.js';
import { extractQueryBusinessIds, matchingQueryBusinessIds } from './agent-query-service.js';

const namespace = 'knowledge_library_v1';
const digest = value => createHash('sha256').update(value).digest('hex');
const empty = () => ({ documents: [] });
const failure = (code, status = 400) => ({ error: code, code, status });
const abort = result => ({ commit: false, result });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
const validLabel = (value, max = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const validDate = value => value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

// No anonymous/default tenant and no colon-joined identity collisions.
function scopeKey(identityScope, roleId) {
  const values = [identityScope?.tenantId, identityScope?.subjectId, roleId];
  if (!values.every(value => validLabel(value, 160)) || identityScope.subjectId === 'anonymous'
    || identityScope.source === 'demo_header' && !identityScope.deviceId) return null;
  return digest(JSON.stringify(values));
}
const current = document => document.versions.at(-1);
const visibleNow = version => version.status === 'ready'
  && (!version.effectiveFrom || Date.parse(version.effectiveFrom) <= Date.now())
  && (!version.effectiveUntil || Date.parse(version.effectiveUntil) > Date.now());
function metadata(document) {
  const version = current(document);
  const { text: _text, chunks: _chunks, ...rest } = version;
  return { id: document.id, ...rest, chunkCount: version.chunks.length, available: visibleNow(version), retainedVersions: document.versions.length };
}

export function previewLibraryDocument(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['text', 'chunkSize'].includes(key))) return failure('KNOWLEDGE_INPUT_INVALID');
  try {
    const chunks = previewKnowledgeChunks(body.text, body.chunkSize);
    if (!assessPromptContent(body.text, { source: 'knowledge_document', maxCharacters: 120000 }).safe) return failure('KNOWLEDGE_CONTENT_REJECTED');
    return { schemaVersion: 'knowledge-preview.v1', indexKind: 'lexical_bm25', chunks, persisted: false, location: 'text_offsets_not_pdf_coordinates' };
  } catch { return failure('KNOWLEDGE_TEXT_INVALID'); }
}

export async function saveLibraryDocument({ id, body, identityScope, roleId }) {
  const key = scopeKey(identityScope, roleId);
  if (!key) return failure('KNOWLEDGE_IDENTITY_REQUIRED', 403);
  if (!validId(id) || !body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(field => !['expectedRevision', 'title', 'source', 'sourceVersion', 'text', 'effectiveFrom', 'effectiveUntil', 'kind'].includes(field))
    || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0
    || !validLabel(body.title) || !validLabel(body.source) || !validLabel(body.sourceVersion, 100)
    || !['policy', 'reference'].includes(body.kind)) return failure('KNOWLEDGE_INPUT_INVALID');
  const effectiveFrom = body.effectiveFrom ?? null;
  const effectiveUntil = body.effectiveUntil ?? null;
  if (!validDate(effectiveFrom) || !validDate(effectiveUntil) || effectiveFrom && effectiveUntil && effectiveFrom >= effectiveUntil) return failure('KNOWLEDGE_TIME_INVALID');
  const preview = previewLibraryDocument({ text: body.text });
  if (preview.error) return preview;
  if (!assessPromptContent([body.title, body.source, body.sourceVersion].join('\n')).safe) return failure('KNOWLEDGE_CONTENT_REJECTED');
  const contentHash = digest(JSON.stringify([body.title, body.source, body.sourceVersion, body.text, body.kind, effectiveFrom, effectiveUntil]));
  return mutateSemanticGovernanceWithEvent({ namespace, key, initialValue: empty, mutation: library => {
    let document = library.documents.find(item => item.id === id);
    const previous = document && current(document);
    if ((previous?.revision || 0) !== body.expectedRevision) return abort(failure('KNOWLEDGE_REVISION_CONFLICT', 409));
    if (previous?.status === 'ready' && previous.contentHash === contentHash) return abort({ ...metadata(document), unchanged: true });
    if (!document && library.documents.length >= 64 || document?.versions.length >= 10) return abort(failure('KNOWLEDGE_LIBRARY_LIMIT', 413));
    if (!document) { document = { id, versions: [] }; library.documents.push(document); }
    const revision = (previous?.revision || 0) + 1;
    const updatedAt = new Date().toISOString();
    const chunks = preview.chunks.map(chunk => ({ ...chunk, id: `${id}@${revision}:${chunk.index}`, title: body.title }));
    document.versions.push({ revision, title: body.title, source: body.source, sourceVersion: body.sourceVersion, kind: body.kind,
      effectiveFrom, effectiveUntil, contentHash, updatedAt, status: 'ready', text: body.text, chunks, indexKind: 'lexical_bm25', scope: 'private_subject_and_role' });
    if (Buffer.byteLength(JSON.stringify(library)) > 2 * 1024 * 1024) return abort(failure('KNOWLEDGE_LIBRARY_LIMIT', 413));
    return { value: library, result: metadata(document), event: {
      type: 'knowledge.document.changed', aggregateType: 'KnowledgeDocument', aggregateId: `${key}:${id}`, tenantId: identityScope.tenantId,
      actor: { type: 'user', id: identityScope.subjectId }, payload: { documentId: id, revision, status: 'ready', contentHash }
    } };
  } });
}

export async function retractLibraryDocument({ id, expectedRevision, identityScope, roleId }) {
  const key = scopeKey(identityScope, roleId);
  if (!key) return failure('KNOWLEDGE_IDENTITY_REQUIRED', 403);
  if (!validId(id) || !Number.isInteger(expectedRevision) || expectedRevision < 1) return failure('KNOWLEDGE_INPUT_INVALID');
  return mutateSemanticGovernanceWithEvent({ namespace, key, initialValue: empty, mutation: library => {
    const document = library.documents.find(item => item.id === id);
    if (!document) return abort(failure('KNOWLEDGE_DOCUMENT_NOT_FOUND', 404));
    const version = current(document);
    if (version.revision !== expectedRevision) return abort(failure('KNOWLEDGE_REVISION_CONFLICT', 409));
    if (version.status === 'retracted') return abort({ ...metadata(document), unchanged: true });
    // Revocation is never blocked by a full revision quota. A content-free
    // tombstone advances the CAS revision, so stale editors cannot resurrect it.
    const revision = version.revision + 1;
    document.versions.push({ ...version, revision, status: 'retracted', text: '', chunks: [], updatedAt: new Date().toISOString() });
    return { value: library, result: metadata(document), event: {
      type: 'knowledge.document.changed', aggregateType: 'KnowledgeDocument', aggregateId: `${key}:${id}`, tenantId: identityScope.tenantId,
      actor: { type: 'user', id: identityScope.subjectId }, payload: { documentId: id, revision, status: 'retracted', contentHash: version.contentHash }
    } };
  } });
}

export async function listLibraryDocuments({ identityScope, roleId }) {
  const key = scopeKey(identityScope, roleId);
  if (!key) return failure('KNOWLEDGE_IDENTITY_REQUIRED', 403);
  const library = await readSemanticGovernanceState(namespace, key, empty);
  return { documents: library.documents.map(metadata), scope: 'private_subject_and_role' };
}

export async function readLibraryDocument({ id, revision, identityScope, roleId }) {
  const key = scopeKey(identityScope, roleId);
  if (!key) return failure('KNOWLEDGE_IDENTITY_REQUIRED', 403);
  if (!validId(id) || !Number.isInteger(revision) || revision < 1) return failure('KNOWLEDGE_INPUT_INVALID');
  const library = await readSemanticGovernanceState(namespace, key, empty);
  const document = library.documents.find(item => item.id === id);
  if (!document || !visibleNow(current(document)) || current(document).revision !== revision) return failure('KNOWLEDGE_DOCUMENT_NOT_FOUND', 404);
  return { ...metadata(document), text: current(document).text, chunks: current(document).chunks };
}

export async function searchLibraryDocuments({ query, limit = 5, identityScope, roleId }) {
  const started = performance.now();
  const key = scopeKey(identityScope, roleId);
  if (!key) return failure('KNOWLEDGE_IDENTITY_REQUIRED', 403);
  if (!validLabel(query, 4000) || !Number.isInteger(limit) || limit < 1 || limit > 10) return failure('KNOWLEDGE_QUERY_INVALID');
  const library = await readSemanticGovernanceState(namespace, key, empty);
  const businessIds = extractQueryBusinessIds(query);
  const documents = library.documents.filter(document => visibleNow(current(document)))
    .filter(document => current(document).kind === 'policy' || !businessIds.length
      || matchingQueryBusinessIds({ id: document.id, text: current(document).text }, businessIds).length === businessIds.length);
  const chunks = documents.flatMap(document => current(document).chunks);
  const ranked = rankKnowledgeChunks(query, chunks, Math.min(chunks.length, limit * 4));
  // One evidence result per document; citation offsets remain exact.
  const results = []; const seen = new Set();
  for (const match of ranked) {
    const document = documents.find(document => current(document).chunks.some(chunk => chunk.id === match.id));
    if (!document || seen.has(document.id)) continue;
    seen.add(document.id);
    const chunk = current(document).chunks.find(chunk => chunk.id === match.id);
    const fresh = await readLibraryDocument({ id: document.id, revision: current(document).revision, identityScope, roleId });
    if (fresh.error) continue;
    results.push({ id: document.id, title: fresh.title, source: fresh.source, revision: fresh.revision, sourceVersion: fresh.sourceVersion,
      kind: fresh.kind, contentHash: fresh.contentHash, excerpt: chunk.text, score: match.score,
      citation: { documentId: document.id, revision: fresh.revision, chunkId: chunk.id, start: chunk.start, end: chunk.end, location: chunk.location },
      evidenceType: 'document_reference_not_live_business_fact' });
    if (results.length === limit) break;
  }
  return { mode: 'private_library_lexical_bm25', results, noEvidence: !results.length,
    diagnostics: { elapsedMs: Math.round((performance.now() - started) * 100) / 100, visibleDocuments: documents.length, candidateChunks: chunks.length, embedding: 'not_configured', rerank: 'not_configured' } };
}

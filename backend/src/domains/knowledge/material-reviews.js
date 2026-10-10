import { randomUUID } from 'node:crypto';
import { knowledgeDigest, knowledgeFailure, validKnowledgeIdentity, validKnowledgeId } from '../../services/knowledge-evidence-service.js';
import { knowledgePrincipalKey } from '../../services/weknora-knowledge-provider.js';
import { assessPromptContent } from '../../services/prompt-security-service.js';
import { currentIAMTenant, findIAMUserBySubject, getIAMUsers } from '../../services/iam-store.js';
import { getEffectiveAccess } from '../../services/access-control-service.js';
import { buildSemanticOperationsNotification, insertSemanticOperationsNotification, SEMANTIC_NOTIFICATION_NAMESPACE } from '../../services/semantic-operations-notification-service.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceWithEvent, mutateSemanticGovernanceStates } from '../../services/semantic-governance-store.js';
import { appendDomainEventToWorkspace, DOMAIN_EVENT_NAMESPACE, DOMAIN_EVENT_WORKSPACE_KEY, initialDomainEventWorkspace } from '../../infrastructure/domain-events/domain-event-outbox.js';

const namespace = 'knowledge_material_reviews_v1';
const archiveNamespace = 'knowledge_material_review_archives_v1';
const key = context => knowledgeDigest(['material-review', context.identityScope.tenantId]);
const fail = (code, status = 409) => knowledgeFailure(code, status);
const validId = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id);
const permitted = async options => validKnowledgeIdentity(options.context) && typeof options.canRead === 'function' && await options.canRead();
const citationValid = c => c && !Array.isArray(c) && c.provider === 'weknora_local'
  && Object.keys(c).every(k => ['provider', 'knowledgeBaseId', 'documentId', 'chunkId', 'revision', 'location'].includes(k))
  && [c.knowledgeBaseId, c.documentId, c.chunkId].every(validKnowledgeId)
  && /^[a-f0-9]{64}$/u.test(c.revision || '') && c.location === 'provider_chunk_not_pdf_coordinates';
const pointer = c => ({ provider: c.provider, knowledgeBaseId: c.knowledgeBaseId, documentId: c.documentId, chunkId: c.chunkId, revision: c.revision, location: c.location });
// Resolve aliases only inside the active tenant. This is identity comparison,
// never an authorization grant or a fallback to a demo administrator.
const principal = (context, subject = context.identityScope.subjectId) => {
  const tenant = context.identityScope.tenantId;
  const canonical = tenant === currentIAMTenant() ? findIAMUserBySubject(subject)?.id : null;
  return knowledgeDigest(['material-review-submitter', tenant, canonical || subject]);
};
const reviewerAllowed = identity => {
  const access = getEffectiveAccess(null, identity);
  return access.principalResolved && access.pagePermissionIds.includes('page.semantic-operations.view')
    && ['meta_model.draft.review', 'meta_model.draft.save'].every(permission => access.buttonPermissionIds.includes(permission));
};
const candidates = context => getIAMUsers().filter(user => user.status === 'active' && reviewerAllowed({ ...context.identityScope, subjectId: user.id })).map(user => ({ subjectId: user.id, name: user.name }));
const actorId = context => context.identityScope.tenantId === currentIAMTenant() ? findIAMUserBySubject(context.identityScope.subjectId)?.id : null;
async function reviewers(options) {
  if (!await permitted(options) || options.context.identityScope.tenantId !== currentIAMTenant() || !reviewerAllowed(options.context.identityScope)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  return { reviewers: candidates(options.context) };
}

async function verify(options, citations) {
  const sources = [];
  try {
    for (const citation of citations) {
      if (!await permitted(options)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
      const source = await (await options.resolveProvider('weknora_local')).read(citation);
      if (source.error || !citationValid(source.citation) || knowledgeDigest(pointer(source.citation)) !== knowledgeDigest(pointer(citation))) return fail('KNOWLEDGE_REVIEW_SOURCE_UNAVAILABLE');
      if (typeof source.title !== 'string' || !source.title.trim() || source.title.length > 200 || typeof source.excerpt !== 'string' || !source.excerpt.trim()
        || !assessPromptContent(`${source.title}\n${source.excerpt}`, { source: 'shared_material_review', maxCharacters: 14000 }).safe) return fail('KNOWLEDGE_CONTENT_REJECTED', 400);
      sources.push(source);
      if (sources.reduce((n, item) => n + item.excerpt.length, 0) > 16000) return fail('KNOWLEDGE_REVIEW_EVIDENCE_LIMIT', 413);
    }
    return await permitted(options) ? { sources } : fail('KNOWLEDGE_ACCESS_DENIED', 403);
  } catch { return fail('KNOWLEDGE_REVIEW_SOURCE_UNAVAILABLE'); }
}
const summary = (row, context, sources) => ({ id: row.id, revision: row.revision, status: row.status, updatedAt: row.updatedAt,
  owned: row.owner === knowledgePrincipalKey(context), titles: sources.map(source => source.title), reason: row.reason || null, note: row.note || null,
  assignment: row.assignment ? { subjectId: row.assignment.subjectId, name: row.assignment.name } : null,
  canDecide: (row.submitterPrincipal || principal(context, row.submitter)) !== principal(context) && (!row.assignment || row.assignment.subjectId === actorId(context)),
  canAssign: row.owner === knowledgePrincipalKey(context) || Boolean(row.assignment && row.assignment.subjectId === actorId(context)),
  archivedAt: row.archivedAt || null, published: false, grantsAuthority: false });
async function findRow(context, id) {
  return (await readSemanticGovernanceState(namespace, key(context), [])).find(row => row.id === id)
    || (await readSemanticGovernanceState(archiveNamespace, key(context), [])).find(row => row.id === id);
}
const event = (context, row, type) => ({ type, tenantId: context.identityScope.tenantId, aggregateType: 'KnowledgeMaterialReview', aggregateId: row.id,
  actor: { type: 'user', id: context.identityScope.subjectId }, payload: { revision: row.revision, status: row.status } });

async function create(options) {
  const { context, body } = options;
  if (!await permitted(options)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!body || Array.isArray(body) || body.confirmed !== true || Object.keys(body).some(k => !['citations', 'confirmed'].includes(k))
    || !Array.isArray(body.citations) || !body.citations.length || body.citations.length > 3 || !body.citations.every(citationValid)
    || new Set(body.citations.map(c => knowledgeDigest(pointer(c)))).size !== body.citations.length) return fail('KNOWLEDGE_REVIEW_INPUT_INVALID', 400);
  const first = await verify(options, body.citations); if (first.error) return first;
  const final = await verify(options, body.citations); if (final.error) return final;
  if (knowledgeDigest(first.sources) !== knowledgeDigest(final.sources)) return fail('KNOWLEDGE_REVIEW_SOURCE_UNAVAILABLE');
  const citations = final.sources.map(source => pointer(source.citation));
  const signature = knowledgeDigest(citations.map(knowledgeDigest).sort());
  // Only pointers are retained: never a copy of source text, names or private study notes.
  return mutateSemanticGovernanceWithEvent({ namespace, key: key(context), initialValue: [], mutation: rows => {
    if (options.canRead() !== true) return { commit: false, result: fail('KNOWLEDGE_ACCESS_DENIED', 403) };
    if (rows.some(row => row.signature === signature && row.status === 'pending')) return { commit: false, result: fail('KNOWLEDGE_REVIEW_ALREADY_PENDING') };
    if (rows.length >= 100) return { commit: false, result: fail('KNOWLEDGE_REVIEW_LIMIT', 413) };
    const row = { id: randomUUID(), revision: 1, status: 'pending', owner: knowledgePrincipalKey(context), submitter: context.identityScope.subjectId, submitterPrincipal: principal(context),
      citations, signature, updatedAt: new Date().toISOString() };
    return { value: [...rows, row], result: { review: summary(row, context, final.sources) }, event: event(context, row, 'knowledge.material_review.submitted') };
  } });
}

async function read(options) {
  if (!await permitted(options)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!validId(options.id)) return fail('KNOWLEDGE_REVIEW_INPUT_INVALID', 400);
  const row = await findRow(options.context, options.id);
  if (!row) return fail('KNOWLEDGE_REVIEW_NOT_FOUND', 404);
  const first = await verify(options, row.citations); if (first.error) return first;
  const final = await verify(options, row.citations); if (final.error) return final;
  if (knowledgeDigest(first.sources) !== knowledgeDigest(final.sources)) return fail('KNOWLEDGE_REVIEW_SOURCE_UNAVAILABLE');
  const latest = await findRow(options.context, row.id);
  if (latest?.revision !== row.revision) return fail('KNOWLEDGE_REVISION_CONFLICT');
  if (!await permitted(options)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  return { review: summary(row, options.context, final.sources), sources: final.sources, execution: 'none' };
}

async function list(options) {
  if (!await permitted(options)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > (options.archived ? 1000 : 100)) return fail('KNOWLEDGE_REVIEW_INPUT_INVALID', 400);
  const rows = (await readSemanticGovernanceState(options.archived ? archiveNamespace : namespace, key(options.context), [])).slice().reverse();
  const reviews = [];
  // Bounded window; inaccessible sources are omitted, including their titles and identifiers.
  for (const row of rows.slice(offset, offset + 10)) {
    const result = await read({ ...options, id: row.id });
    if (result.error === 'KNOWLEDGE_ACCESS_DENIED') return result;
    if (!result.error) reviews.push(result.review);
  }
  // Earlier rows can be revoked while later sources are being read. Recheck the entire
  // outgoing window, not only each row immediately after its own first read.
  const finalReviews = [];
  for (const review of reviews) {
    const current = await read({ ...options, id: review.id });
    if (current.error === 'KNOWLEDGE_ACCESS_DENIED') return current;
    if (current.error) continue;
    if (current.review.revision !== review.revision || Boolean(current.review.archivedAt) !== Boolean(options.archived)) return fail('KNOWLEDGE_REVISION_CONFLICT');
    finalReviews.push(current.review);
  }
  if (!await permitted(options)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  return { reviews: finalReviews, offset, hasMore: rows.length > offset + 10, windowSize: 10, scope: 'independently_authorized_provider_sources' };
}

async function decide(options) {
  const { context, body, id } = options;
  if (!await permitted(options)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!validId(id) || !body || Array.isArray(body) || Object.keys(body).some(k => !['expectedRevision', 'decision', 'confirmed', 'note'].includes(k))
    || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1 || body.confirmed !== true
    || !['approved', 'rejected', 'withdrawn'].includes(body.decision)) return fail('KNOWLEDGE_REVIEW_INPUT_INVALID', 400);
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 1000
    || !assessPromptContent(body.note, { source: 'material_review_note', maxCharacters: 1000 }).safe)) return fail('KNOWLEDGE_REVIEW_NOTE_INVALID', 400);
  if (body.decision !== 'withdrawn') { const result = await read(options); if (result.error) return result; }
  return mutateSemanticGovernanceWithEvent({ namespace, key: key(context), initialValue: [], mutation: rows => {
    if (options.canRead() !== true) return { commit: false, result: fail('KNOWLEDGE_ACCESS_DENIED', 403) };
    const row = rows.find(item => item.id === id);
    if (!row) return { commit: false, result: fail('KNOWLEDGE_REVIEW_NOT_FOUND', 404) };
    if (row.revision !== body.expectedRevision) return { commit: false, result: fail('KNOWLEDGE_REVISION_CONFLICT') };
    if (body.decision === 'withdrawn' ? row.owner !== knowledgePrincipalKey(context)
      : (row.submitterPrincipal || principal(context, row.submitter)) === principal(context)) return { commit: false, result: fail('KNOWLEDGE_REVIEW_SEPARATION_REQUIRED', 403) };
    if (body.decision !== 'withdrawn' && row.assignment && (context.identityScope.tenantId !== currentIAMTenant() || row.assignment.subjectId !== findIAMUserBySubject(context.identityScope.subjectId)?.id)) return { commit: false, result: fail('KNOWLEDGE_REVIEW_ASSIGNEE_REQUIRED', 403) };
    if (row.status !== 'pending') return { commit: false, result: fail('KNOWLEDGE_REVIEW_STATE_CONFLICT') };
    row.status = body.decision; row.revision++; row.updatedAt = new Date().toISOString();
    // Explicit human annotation, not model instructions; never copied to the event payload.
    row.note = body.note?.trim() || null;
    row.reason = { approved: 'source_structure_reviewed_not_authoritative', rejected: 'source_requires_correction', withdrawn: 'submitter_withdrew' }[row.status];
    return { value: rows, result: { id, revision: row.revision, status: row.status, published: false, grantsAuthority: false }, event: event(context, row, 'knowledge.material_review.decided') };
  } });
}
async function assign(options) {
  const { context, id, body } = options;
  if (!validId(id) || !body || Array.isArray(body) || body.confirmed !== true || Object.keys(body).some(k => !['subjectId', 'expectedRevision', 'confirmed'].includes(k))
    || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1 || !(body.subjectId === null || typeof body.subjectId === 'string' && body.subjectId.length <= 128)) return fail('KNOWLEDGE_REVIEW_INPUT_INVALID', 400);
  const directory = await reviewers(options); if (directory.error) return directory;
  const source = await read(options); if (source.error) return source;
  return mutateSemanticGovernanceStates([
    { name: 'reviews', namespace, key: key(context), initialValue: [] },
    { name: 'notices', namespace: SEMANTIC_NOTIFICATION_NAMESPACE, key: 'index', initialValue: {} },
    { name: 'outbox', namespace: DOMAIN_EVENT_NAMESPACE, key: DOMAIN_EVENT_WORKSPACE_KEY, initialValue: initialDomainEventWorkspace }
  ], values => {
    if (options.canRead() !== true || context.identityScope.tenantId !== currentIAMTenant() || !reviewerAllowed(context.identityScope)) return { commit: false, result: fail('KNOWLEDGE_ACCESS_DENIED', 403) };
    const row = values.reviews.find(item => item.id === id);
    if (!row) return { commit: false, result: fail('KNOWLEDGE_REVIEW_NOT_FOUND', 404) };
    if (row.revision !== body.expectedRevision || row.revision !== source.review.revision) return { commit: false, result: fail('KNOWLEDGE_REVISION_CONFLICT') };
    if (row.status !== 'pending') return { commit: false, result: fail('KNOWLEDGE_REVIEW_STATE_CONFLICT') };
    const actor = findIAMUserBySubject(context.identityScope.subjectId);
    if (row.owner !== knowledgePrincipalKey(context) && row.assignment?.subjectId !== actor.id) return { commit: false, result: fail('KNOWLEDGE_ACCESS_DENIED', 403) };
    const target = body.subjectId === null ? null : candidates(context).find(user => user.subjectId === body.subjectId);
    if (body.subjectId !== null && !target) return { commit: false, result: fail('KNOWLEDGE_REVIEWER_UNAVAILABLE', 403) };
    if (target && (row.submitterPrincipal || principal(context, row.submitter)) === principal(context, target.subjectId)) return { commit: false, result: fail('KNOWLEDGE_REVIEW_SEPARATION_REQUIRED', 403) };
    if ((row.assignment?.subjectId || null) === (target?.subjectId || null)) return { commit: false, result: fail('KNOWLEDGE_REVIEW_ASSIGNMENT_UNCHANGED') };
    row.assignment = target ? { subjectId: target.subjectId, name: target.name } : null;
    row.revision++; row.updatedAt = new Date().toISOString();
    // Generic notice contains no source title, pointer, excerpt or human note.
    const notice = buildSemanticOperationsNotification({ identityScope: target ? { ...context.identityScope, subjectId: target.subjectId } : context.identityScope,
      audiencePermissionId: 'meta_model.draft.review', audienceSubjectId: target?.subjectId || null, sourceType: 'knowledge_material_review', sourceId: id,
      title: '企业资料核对指派已更新', message: '请到知识资料的协作核对区域查看待办。指派不授予资料读取权限，也不代表通过或发布。', severity: 'action_required' });
    insertSemanticOperationsNotification(values.notices, notice);
    appendDomainEventToWorkspace(values.outbox, event(context, row, 'knowledge.material_review.assigned'));
    return { values, result: { id, revision: row.revision, assignment: row.assignment, published: false, grantsAuthority: false } };
  });
}
async function archive(options) {
  const { context, id, body } = options;
  if (!await permitted(options)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!validId(id) || !body || Array.isArray(body) || body.confirmed !== true || Object.keys(body).some(k => !['expectedRevision', 'confirmed'].includes(k))
    || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) return fail('KNOWLEDGE_REVIEW_INPUT_INVALID', 400);
  // Retention-only owner operation; a withdrawn source need not become readable again.
  return mutateSemanticGovernanceStates([
    { name: 'reviews', namespace, key: key(context), initialValue: [] },
    { name: 'archives', namespace: archiveNamespace, key: key(context), initialValue: [] },
    { name: 'outbox', namespace: DOMAIN_EVENT_NAMESPACE, key: DOMAIN_EVENT_WORKSPACE_KEY, initialValue: initialDomainEventWorkspace }
  ], values => {
    if (options.canRead() !== true) return { commit: false, result: fail('KNOWLEDGE_ACCESS_DENIED', 403) };
    const row = values.reviews.find(item => item.id === id && item.owner === knowledgePrincipalKey(context));
    if (!row) return { commit: false, result: fail('KNOWLEDGE_REVIEW_NOT_FOUND', 404) };
    if (row.revision !== body.expectedRevision) return { commit: false, result: fail('KNOWLEDGE_REVISION_CONFLICT') };
    if (row.status === 'pending') return { commit: false, result: fail('KNOWLEDGE_REVIEW_TERMINAL_REQUIRED') };
    if (values.archives.length >= 1000 || values.archives.some(item => item.id === id)) return { commit: false, result: fail('KNOWLEDGE_REVIEW_ARCHIVE_LIMIT', 413) };
    const next = { ...row, revision: row.revision + 1, archivedAt: new Date().toISOString(), archivedBy: context.identityScope.subjectId };
    appendDomainEventToWorkspace(values.outbox, event(context, next, 'knowledge.material_review.archived'));
    return { values: { ...values, reviews: values.reviews.filter(item => item.id !== id), archives: [...values.archives, next] }, result: { id, revision: next.revision, archived: true, retained: true } };
  });
}
export const materialReviews = { create, list, read, decide, assign, reviewers, archive, history: options => list({ ...options, archived: true }) };

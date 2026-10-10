import { createHash, randomUUID } from 'node:crypto';
import { validKnowledgeIdentity, knowledgeFailure } from '../../services/knowledge-evidence-service.js';
import { knowledgePrincipalKey } from '../../services/weknora-knowledge-provider.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceStates } from '../../services/semantic-governance-store.js';
import { runWithSemanticTenant, getOAMetaModelDraft, getOAMetaModelRuntimeTransactionEntry, getOAMetaModelDraftFromRuntime, semanticFingerprint } from '../governance/public-api.js';
const namespace = 'ontology_team_views_v1';
const archiveNamespace = 'ontology_team_view_archives_v1';
const key = context => createHash('sha256').update(JSON.stringify(['team-view', context.identityScope.tenantId])).digest('hex');
const fail = (code, status = 409) => knowledgeFailure(code, status);
const idValid = id => /^[a-f0-9-]{36}$/u.test(id || '');
const modelFor = context => runWithSemanticTenant(context.identityScope, getOAMetaModelDraft);
const readable = async (context, canRead) => validKnowledgeIdentity(context) && typeof canRead === 'function' && await canRead();
const summary = (view, context, fingerprint) => ({ id: view.id, label: view.label, revision: view.revision, modelFingerprint: view.modelFingerprint, current: view.modelFingerprint === fingerprint, revoked: view.revoked, updatedAt: view.updatedAt, owned: view.owner === knowledgePrincipalKey(context) });

async function list({ context, canRead }) {
  if (!await readable(context, canRead)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  const model = await modelFor(context); const fingerprint = semanticFingerprint(model);
  const views = await readSemanticGovernanceState(namespace, key(context), []);
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (semanticFingerprint(await modelFor(context)) !== fingerprint) return fail('KNOWLEDGE_MODEL_CHANGED');
  return { views: views.filter(view => !view.revoked).map(view => summary(view, context, fingerprint)), scope: 'tenant_authorized_reviewers', modelFingerprint: fingerprint };
}

async function read({ context, canRead, id }) {
  if (!await readable(context, canRead)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!idValid(id)) return fail('KNOWLEDGE_VIEW_INPUT_INVALID', 400);
  const view = (await readSemanticGovernanceState(namespace, key(context), [])).find(item => item.id === id && !item.revoked);
  if (!view) return fail('KNOWLEDGE_VIEW_NOT_FOUND', 404);
  const fingerprint = semanticFingerprint(await modelFor(context));
  if (fingerprint !== view.modelFingerprint) return fail('KNOWLEDGE_MODEL_CHANGED');
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (semanticFingerprint(await modelFor(context)) !== fingerprint) return fail('KNOWLEDGE_MODEL_CHANGED');
  // Do not return the personal view id, owner principal or private materials.
  const latest = (await readSemanticGovernanceState(namespace, key(context), [])).find(item => item.id === id && !item.revoked && item.revision === view.revision);
  if (!latest) return fail('KNOWLEDGE_VIEW_NOT_FOUND', 404);
  return { view: { ...summary(view, context, fingerprint), selectedId: view.selectedId, layout: structuredClone(view.layout) }, readOnly: true, scope: 'tenant_authorized_reviewers' };
}

async function share({ context, canRead, id, body }) {
  if (!await readable(context, canRead)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!idValid(id) || !body || Object.keys(body).some(name => !['expectedRevision', 'modelFingerprint'].includes(name)) || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1 || typeof body.modelFingerprint !== 'string') return fail('KNOWLEDGE_VIEW_INPUT_INVALID', 400);
  if (semanticFingerprint(await modelFor(context)) !== body.modelFingerprint) return fail('KNOWLEDGE_MODEL_CHANGED');
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  const result = await runWithSemanticTenant(context.identityScope, () => mutateSemanticGovernanceStates([
    getOAMetaModelRuntimeTransactionEntry(),
    { name: 'personal', namespace: 'ontology_private_views_v1', key: knowledgePrincipalKey(context), initialValue: [] },
    { name: 'team', namespace, key: key(context), initialValue: [] }
  ], values => {
    if (semanticFingerprint(getOAMetaModelDraftFromRuntime(values.oaRuntime)) !== body.modelFingerprint) return { commit: false, result: fail('KNOWLEDGE_MODEL_CHANGED') };
    const source = values.personal.find(view => view.id === id);
    if (!source) return { commit: false, result: fail('KNOWLEDGE_VIEW_NOT_FOUND', 404) };
    if (source.revision !== body.expectedRevision) return { commit: false, result: fail('KNOWLEDGE_REVISION_CONFLICT') };
    if (source.modelFingerprint !== body.modelFingerprint || source.layout.fingerprint !== body.modelFingerprint) return { commit: false, result: fail('KNOWLEDGE_MODEL_CHANGED') };
    if (values.team.some(view => !view.revoked && view.owner === knowledgePrincipalKey(context) && view.sourceId === id && view.sourceRevision === source.revision)) return { commit: false, result: fail('KNOWLEDGE_VIEW_ALREADY_SHARED') };
    if (values.team.filter(view => !view.revoked).length >= 20 || values.team.length >= 100) return { commit: false, result: fail('KNOWLEDGE_VIEW_LIMIT', 413) };
    const view = { id: randomUUID(), revision: 1, label: source.label, selectedId: source.selectedId, layout: structuredClone(source.layout), modelFingerprint: source.modelFingerprint, owner: knowledgePrincipalKey(context), sourceId: id, sourceRevision: source.revision, revoked: false, updatedAt: new Date().toISOString() };
    return { values: { ...values, team: [...values.team, view] }, result: { view: summary(view, context, body.modelFingerprint), scope: 'tenant_authorized_reviewers' } };
  }));
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  return result;
}

async function retract({ context, canRead, id, body }) {
  if (!await readable(context, canRead)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!idValid(id) || !body || Object.keys(body).some(name => name !== 'expectedRevision') || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) return fail('KNOWLEDGE_VIEW_INPUT_INVALID', 400);
  const result = await runWithSemanticTenant(context.identityScope, () => mutateSemanticGovernanceStates([{ name: 'team', namespace, key: key(context), initialValue: [] }], values => {
    const view = values.team.find(item => item.id === id && item.owner === knowledgePrincipalKey(context));
    if (!view) return { commit: false, result: fail('KNOWLEDGE_VIEW_NOT_FOUND', 404) };
    if (view.revision !== body.expectedRevision || view.revoked) return { commit: false, result: fail('KNOWLEDGE_REVISION_CONFLICT') };
    const next = { ...view, revoked: true, revision: view.revision + 1, updatedAt: new Date().toISOString() };
    return { values: { ...values, team: values.team.map(item => item.id === id ? next : item) }, result: { revoked: true, revision: next.revision } };
  }));
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  return result;
}
async function history({ context, canRead, offset = 0, limit = 20 }) {
  if (!await readable(context, canRead)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!Number.isInteger(offset) || offset < 0 || offset > 1100 || !Number.isInteger(limit) || limit < 1 || limit > 50) return fail('KNOWLEDGE_VIEW_INPUT_INVALID', 400);
  const fingerprint = semanticFingerprint(await modelFor(context));
  const current = await readSemanticGovernanceState(namespace, key(context), []);
  const archived = await readSemanticGovernanceState(archiveNamespace, key(context), []);
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  // An archive may move a row between the two reads: never show duplicate identities.
  const rows = [...new Map([...current.filter(view => view.revoked), ...archived].map(view => [view.id, view])).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return { views: rows.slice(offset, offset + limit).map(view => ({ ...summary(view, context, fingerprint), archivedAt: view.archivedAt || null })), total: rows.length, offset, limit, scope: 'tenant_authorized_reviewers' };
}

async function archive({ context, canRead, id, body }) {
  if (!await readable(context, canRead)) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!idValid(id) || !body || Array.isArray(body) || Object.keys(body).some(name => name !== 'expectedRevision') || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) return fail('KNOWLEDGE_VIEW_INPUT_INVALID', 400);
  const result = await runWithSemanticTenant(context.identityScope, () => mutateSemanticGovernanceStates([
    { name: 'team', namespace, key: key(context), initialValue: [] },
    { name: 'archives', namespace: archiveNamespace, key: key(context), initialValue: [] }
  ], values => {
    const view = values.team.find(item => item.id === id && item.owner === knowledgePrincipalKey(context));
    if (!view) return { commit: false, result: fail('KNOWLEDGE_VIEW_NOT_FOUND', 404) };
    if (view.revision !== body.expectedRevision) return { commit: false, result: fail('KNOWLEDGE_REVISION_CONFLICT') };
    if (!view.revoked) return { commit: false, result: fail('KNOWLEDGE_VIEW_RETRACTION_REQUIRED') };
    if (values.archives.length >= 1000 || values.archives.some(item => item.id === id)) return { commit: false, result: fail('KNOWLEDGE_VIEW_ARCHIVE_LIMIT', 413) };
    const archived = { ...view, revision: view.revision + 1, archivedAt: new Date().toISOString() };
    return { values: { team: values.team.filter(item => item.id !== id), archives: [...values.archives, archived] }, result: { archived: true, revision: archived.revision, retained: true } };
  }));
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  return result;
}
export const teamModelViews = { list, read, share, retract, history, archive };

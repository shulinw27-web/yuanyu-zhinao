import { randomUUID } from 'node:crypto';
import { validKnowledgeIdentity, knowledgeFailure } from '../../services/knowledge-evidence-service.js';
import { knowledgePrincipalKey } from '../../services/weknora-knowledge-provider.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceStates } from '../../services/semantic-governance-store.js';
import { runWithSemanticTenant, getOAMetaModelDraft, getOAMetaModelRuntimeTransactionEntry, getOAMetaModelDraftFromRuntime, semanticFingerprint } from '../governance/public-api.js';
const namespace = 'ontology_private_views_v1';
const fail = (code, status = 409) => knowledgeFailure(code, status);
const getModel = context => runWithSemanticTenant(context.identityScope, getOAMetaModelDraft);
const validId = id => /^[a-f0-9-]{36}$/.test(id || '');
const finiteBound = (value, bound) => Number.isFinite(value) && Math.abs(value) <= bound;
function validateLayout(layout, model) {
  if (!layout || Array.isArray(layout) || layout.fingerprint !== semanticFingerprint(model) || Object.keys(layout).some(key => !['fingerprint', 'positions', 'scale', 'offset'].includes(key)) || !layout.positions || Array.isArray(layout.positions) || !layout.offset || Array.isArray(layout.offset) || Object.keys(layout.offset).some(key => !['x', 'y'].includes(key)) || !finiteBound(layout.offset.x, 10000) || !finiteBound(layout.offset.y, 10000) || !Number.isFinite(layout.scale) || layout.scale < .5 || layout.scale > 2.5 || Object.keys(layout.positions).length > 500) return false;
  const ids = new Set(model.objectTypes.map(item => item.id));
  return Object.entries(layout.positions).every(([id, point]) => ids.has(id) && !['__proto__', 'constructor', 'prototype'].includes(id) && point && !Array.isArray(point) && Object.keys(point).every(key => ['x', 'y'].includes(key)) && finiteBound(point.x, 10000) && point.x >= 0 && finiteBound(point.y, 50000) && point.y >= 0);
}
async function list({ context, canRead }) {
  if (!validKnowledgeIdentity(context) || !await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  const model = await getModel(context); const fingerprint = semanticFingerprint(model);
  const records = await readSemanticGovernanceState(namespace, knowledgePrincipalKey(context), []);
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (semanticFingerprint(await getModel(context)) !== fingerprint) return fail('KNOWLEDGE_MODEL_CHANGED');
  return { modelFingerprint: fingerprint, views: records.map(({ id, revision, label, modelFingerprint, updatedAt }) => ({ id, revision, label, modelFingerprint, updatedAt, current: modelFingerprint === fingerprint })), scope: 'private_subject_and_role', historyPolicy: 'stale_version_layout_not_readable' };
}
async function read({ context, id, canRead }) {
  if (!validKnowledgeIdentity(context) || !await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!validId(id)) return fail('KNOWLEDGE_VIEW_INPUT_INVALID', 400);
  const records = await readSemanticGovernanceState(namespace, knowledgePrincipalKey(context), []);
  const view = records.find(item => item.id === id);
  if (!view) return fail('KNOWLEDGE_VIEW_NOT_FOUND', 404);
  const model = await getModel(context);
  if (semanticFingerprint(model) !== view.modelFingerprint || !validateLayout(view.layout, model)) return fail('KNOWLEDGE_MODEL_CHANGED');
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (semanticFingerprint(await getModel(context)) !== view.modelFingerprint) return fail('KNOWLEDGE_MODEL_CHANGED');
  return { view, scope: 'private_subject_and_role', readOnly: true };
}
async function save({ context, body, canRead }) {
  if (!validKnowledgeIdentity(context) || !await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!body || Array.isArray(body) || Object.keys(body).some(key => !['id', 'expectedRevision', 'label', 'selectedId', 'modelFingerprint', 'layout'].includes(key)) || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0 || (body.id ? !validId(body.id) || body.expectedRevision < 1 : body.expectedRevision !== 0) || typeof body.label !== 'string' || !body.label.trim() || body.label.length > 80 || typeof body.selectedId !== 'string') return fail('KNOWLEDGE_VIEW_INPUT_INVALID', 400);
  const model = await getModel(context);
  if (body.modelFingerprint !== semanticFingerprint(model)) return fail('KNOWLEDGE_MODEL_CHANGED');
  if ((body.selectedId && !model.objectTypes.some(item => item.id === body.selectedId)) || !validateLayout(body.layout, model)) return fail('KNOWLEDGE_VIEW_INPUT_INVALID', 400);
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  const result = await runWithSemanticTenant(context.identityScope, () => mutateSemanticGovernanceStates([getOAMetaModelRuntimeTransactionEntry(), { name: 'views', namespace, key: knowledgePrincipalKey(context), initialValue: [] }], values => {
    if (semanticFingerprint(getOAMetaModelDraftFromRuntime(values.oaRuntime)) !== body.modelFingerprint) return { commit: false, result: fail('KNOWLEDGE_MODEL_CHANGED') };
    const index = values.views.findIndex(item => item.id === body.id);
    if (body.id && index < 0) return { commit: false, result: fail('KNOWLEDGE_VIEW_NOT_FOUND', 404) };
    if (index >= 0 && values.views[index].revision !== body.expectedRevision) return { commit: false, result: fail('KNOWLEDGE_REVISION_CONFLICT') };
    if (index < 0 && values.views.length >= 20) return { commit: false, result: fail('KNOWLEDGE_VIEW_LIMIT', 413) };
    const view = { id: body.id || randomUUID(), revision: body.expectedRevision + 1, label: body.label.trim(), selectedId: body.selectedId, modelFingerprint: body.modelFingerprint, layout: structuredClone(body.layout), updatedAt: new Date().toISOString() };
    const views = [...values.views]; if (index < 0) views.push(view); else views[index] = view;
    return { values: { ...values, views }, result: { view } };
  }));
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  return result;
}
export const privateModelViews = { list, read, save };

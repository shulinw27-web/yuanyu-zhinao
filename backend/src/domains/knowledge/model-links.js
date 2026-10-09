import { createHash, randomUUID } from 'node:crypto';
import { validKnowledgeIdentity, knowledgeFailure } from '../../services/knowledge-evidence-service.js';
import { knowledgePrincipalKey } from '../../services/weknora-knowledge-provider.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceState, mutateSemanticGovernanceStates } from '../../services/semantic-governance-store.js';
import { runWithSemanticTenant, getOAMetaModelDraft, getOAMetaModelRuntimeTransactionEntry, getOAMetaModelDraftFromRuntime, semanticFingerprint } from '../governance/public-api.js';
import { answerKnowledgeQuestion } from '../../services/knowledge-answer-service.js';
import { privateModelViews } from './model-views.js';

const namespace = 'knowledge_model_links_v1';
const kinds = ['definition', 'rule', 'field', 'workflow'];
const getModel = context => runWithSemanticTenant(context.identityScope, getOAMetaModelDraft);
const modelTargets = model => [...model.objectTypes.map(item => ({ id: item.id, label: item.label || item.id, targetType: 'object' })), ...model.relationshipTypes.map(item => ({ id: JSON.stringify(['relationship', item.from, item.predicate, item.to]), label: `${item.from} ${item.label || item.predicate} ${item.to}`, targetType: 'relationship' }))];
const fail = (code, status = 409) => knowledgeFailure(code, status);
async function sourceRead(citation, resolveProvider) {
  if (!['local_private_library', 'weknora_local'].includes(citation?.provider)) return fail('KNOWLEDGE_CITATION_INVALID', 400);
  try { return await (await resolveProvider(citation.provider)).read(citation); }
  catch { return fail('KNOWLEDGE_SOURCE_UNAVAILABLE'); }
}
async function list({ context, resolveProvider, canRead }) {
  if (!validKnowledgeIdentity(context) || !await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  const model = await getModel(context); const fingerprint = semanticFingerprint(model);
  const records = await readSemanticGovernanceState(namespace, knowledgePrincipalKey(context), []);
  const links = [];
  for (const record of records) {
    if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
    const source = await sourceRead(record.citation, resolveProvider);
    const target = modelTargets(model).find(item => item.id === record.objectId);
    const status = record.status !== 'confirmed' ? record.status : source.error || !target || record.modelFingerprint !== fingerprint ? 'needs_review' : 'confirmed';
    links.push({ id: record.id, revision: record.revision, status, objectId: record.objectId,
      objectLabel: target?.label || record.objectId, relationType: record.relationType,
      sourceTitle: source.error ? '资料引用已失效或暂不可读' : source.title,
      createdAt: record.createdAt, confirmedBy: record.confirmedBy,
      reason: source.error ? '来源需要重新核验' : !target ? '关联对象已移除' : record.modelFingerprint !== fingerprint ? '模型已更新，需要重新关联' : '',
      ...(status === 'confirmed' ? { citation: source.citation, excerpt: source.excerpt } : {}) });
  }
  // Refuse to return a mixed-version graph or a source revoked during response assembly.
  for (const link of links.filter(item => item.status === 'confirmed')) {
    if ((await sourceRead(link.citation, resolveProvider)).error) return fail('KNOWLEDGE_EVIDENCE_CHANGED');
  }
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (semanticFingerprint(await getModel(context)) !== fingerprint) return fail('KNOWLEDGE_MODEL_CHANGED');
  return { links, modelFingerprint: fingerprint, objects: modelTargets(model), scope: 'private_subject_and_role' };
}
async function save({ context, body, resolveProvider, canRead }) {
  if (!validKnowledgeIdentity(context) || !await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!body || Array.isArray(body) || Object.keys(body).some(key => !['objectId', 'modelFingerprint', 'relationType', 'citation', 'confirmed'].includes(key))
    || body.confirmed !== true || typeof body.objectId !== 'string' || !kinds.includes(body.relationType)
    || !/^[a-f0-9]{24}$/.test(body.modelFingerprint || '')) return fail('KNOWLEDGE_LINK_INPUT_INVALID', 400);
  const source = await sourceRead(body.citation, resolveProvider);
  if (source.error) return source;
  const model = await getModel(context);
  if (semanticFingerprint(model) !== body.modelFingerprint || !modelTargets(model).some(item => item.id === body.objectId)) return fail('KNOWLEDGE_MODEL_CHANGED');
  if ((await sourceRead(source.citation, resolveProvider)).error) return fail('KNOWLEDGE_EVIDENCE_CHANGED');
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  const signature = createHash('sha256').update(JSON.stringify([source.citation, body.objectId, body.modelFingerprint, body.relationType])).digest('hex');
  const result = await runWithSemanticTenant(context.identityScope, () => mutateSemanticGovernanceStates([
    getOAMetaModelRuntimeTransactionEntry(), { name: 'links', namespace, key: knowledgePrincipalKey(context), initialValue: [] }
  ], values => {
    if (semanticFingerprint(getOAMetaModelDraftFromRuntime(values.oaRuntime)) !== body.modelFingerprint) return { commit: false, result: fail('KNOWLEDGE_MODEL_CHANGED') };
    const records = values.links;
    const existing = records.find(item => item.signature === signature && item.status === 'confirmed');
    if (existing) return { commit: false, result: { id: existing.id, revision: existing.revision, unchanged: true } };
    if (records.length >= 256) return { commit: false, result: fail('KNOWLEDGE_LINK_LIMIT', 413) };
    const record = { id: randomUUID(), revision: 1, signature, objectId: body.objectId, modelFingerprint: body.modelFingerprint,
      relationType: body.relationType, citation: source.citation, status: 'confirmed', createdAt: new Date().toISOString(), confirmedBy: context.identityScope.subjectId };
    return { values: { ...values, links: [...records, record] }, result: { id: record.id, revision: 1 } };
  }));
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  return result;
}
async function retract({ context, id, body, canRead }) {
  if (!validKnowledgeIdentity(context) || !await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!body || Array.isArray(body) || Object.keys(body).some(key => key !== 'expectedRevision') || !Number.isInteger(body.expectedRevision)) return fail('KNOWLEDGE_LINK_INPUT_INVALID', 400);
  return mutateSemanticGovernanceState(namespace, knowledgePrincipalKey(context), [], records => {
    const record = records.find(item => item.id === id);
    if (!record) return { commit: false, result: fail('KNOWLEDGE_LINK_NOT_FOUND', 404) };
    if (record.revision !== body.expectedRevision) return { commit: false, result: fail('KNOWLEDGE_REVISION_CONFLICT') };
    record.status = 'retracted'; record.revision++; record.retractedAt = new Date().toISOString();
    return { value: records, result: { id, revision: record.revision, status: record.status } };
  });
}
async function suggest({ context, body, resolveProvider, canRead, policy, generate }) {
  if (!validKnowledgeIdentity(context) || !await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (!body || body.confirmed !== true || !Array.isArray(body.citations) || !body.citations.length || body.citations.length > 8 || !['exact', 'model'].includes(body.mode || 'exact') || Object.keys(body).some(key => !['citations', 'confirmed', 'modelFingerprint', 'mode', 'consent', 'targetIds'].includes(key)) || ((body.consent || body.targetIds) && body.mode !== 'model')) return fail('KNOWLEDGE_LINK_INPUT_INVALID', 400);
  const model = await getModel(context); const fingerprint = semanticFingerprint(model);
  if (body.modelFingerprint !== fingerprint) return fail('KNOWLEDGE_MODEL_CHANGED');
  const suggestions = [];
  if (body.mode === 'model') {
    const allTargets = modelTargets(model);
    if (body.targetIds !== undefined && (!Array.isArray(body.targetIds) || !body.targetIds.length || body.targetIds.length > 16 || new Set(body.targetIds).size !== body.targetIds.length || body.targetIds.some(id => !allTargets.some(target => target.id === id)))) return fail('KNOWLEDGE_LINK_INPUT_INVALID', 400);
    const targets = body.targetIds ? allTargets.filter(target => body.targetIds.includes(target.id)) : allTargets;
    const catalog = JSON.stringify(targets);
    if (catalog.length > 2700) return fail('KNOWLEDGE_MODEL_CATALOG_LIMIT', 413);
    const result = await answerKnowledgeQuestion({ resolveProvider, canRead, policy, generate, safetyIdentifier: knowledgePrincipalKey(context), body: {
      question: `分析选定资料与以下模型目标的关联，不要求名称一致。每项解释 text 必须是 JSON 字符串对象，仅含 targetId、reason、relationType（definition/rule/field/workflow），targetId 只能从目录选择。没有依据不生成候选。目录：${catalog}`,
      history: [], citations: body.citations, consent: body.consent
    } });
    if (result.error) return result;
    if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
    if (semanticFingerprint(await getModel(context)) !== fingerprint) return fail('KNOWLEDGE_MODEL_CHANGED');
    for (const claim of result.claims) {
      let item; try { item = JSON.parse(claim.text); } catch { return fail('KNOWLEDGE_ASSOCIATION_CONTRACT_INVALID', 502); }
      const target = targets.find(target => target.id === item?.targetId);
      if (!target || Object.keys(item).some(key => !['targetId', 'reason', 'relationType'].includes(key)) || !kinds.includes(item.relationType) || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 500) return fail('KNOWLEDGE_ASSOCIATION_CONTRACT_INVALID', 502);
      for (const ref of claim.sources) {
        const source = result.evidence[ref.index - 1];
        if (suggestions.length < 24) suggestions.push({ objectId: target.id, objectLabel: target.label, targetType: target.targetType, citation: source.citation, excerpt: ref.quote, sourceTitle: source.title, relationType: item.relationType, status: 'candidate', reason: item.reason });
      }
    }
    return { suggestions, modelFingerprint: fingerprint, method: 'model_selected_evidence_candidates', modelCalled: true, model: result.model, persisted: false, verification: result.verification };
  }
  for (const citation of body.citations) {
    const source = await sourceRead(citation, resolveProvider); if (source.error) return source;
    for (const target of modelTargets(model)) {
      const relationship = target.targetType === 'relationship' ? JSON.parse(target.id) : null;
      const mentions = relationship ? [relationship[1], relationship[3]] : [target.id, target.label];
      const matched = relationship ? mentions.every(name => source.excerpt.includes(name)) : mentions.some(name => name.length >= 2 && source.excerpt.includes(name));
      if (matched && suggestions.length < 24) suggestions.push({ objectId: target.id, objectLabel: target.label, targetType: target.targetType, citation: source.citation, excerpt: source.excerpt, sourceTitle: source.title, relationType: 'definition', status: 'candidate', reason: '所选原文明确提及目标名称或关系两端；仅供核对，不证明权威依据。' });
    }
  }
  for (const citation of body.citations) if ((await sourceRead(citation, resolveProvider)).error) return fail('KNOWLEDGE_EVIDENCE_CHANGED');
  if (!await canRead()) return fail('KNOWLEDGE_ACCESS_DENIED', 403);
  if (semanticFingerprint(await getModel(context)) !== fingerprint) return fail('KNOWLEDGE_MODEL_CHANGED');
  return { suggestions, modelFingerprint: fingerprint, method: 'bounded_exact_mentions_no_model_call', persisted: false };
}
export const knowledgeModelLinks = { list, save, retract, suggest, views: privateModelViews };

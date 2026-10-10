import { previewLibraryDocument, saveLibraryDocument, retractLibraryDocument, listLibraryDocuments, readLibraryDocument, searchLibraryDocuments, knowledgeModelLinks } from '../domains/knowledge/public-api.js';
import { listKnowledgeStudies, saveKnowledgeStudy, readKnowledgeStudy, restoreKnowledgeStudy, prepareKnowledgeStudy,
  createLocalKnowledgeProvider, buildKnowledgeBrief, getEffectiveAccess, loadWeKnoraRuntimeProvider, answerKnowledgeQuestion, supplementKnowledgeSources, proposeSemanticReadPlan, knowledgeAnswerPolicy, previewKnowledgeMaterial, knowledgePrincipalKey, buildKnowledgeBusinessBrief, listKnowledgeBusinessPlans } from '../domains/governance/public-api.js';

export async function handleKnowledgeRoutes({ req, res, url, role, agentIdentity, effectiveAccess, selectActionRole, denyButton, readBody, send }) {
  const base = ['/api/agent/knowledge-library', '/api/semantic-operations/knowledge-library']
    .find(path => url.pathname === path || url.pathname.startsWith(`${path}/`));
  if (!base) return false;
  const semantic = base.startsWith('/api/semantic-operations/');
  const page = semantic ? 'page.semantic-operations.view' : 'page.agent.view';
  const writePermission = semantic ? 'meta_model.draft.save' : 'agent.prompt.run';
  const context = { identityScope: agentIdentity, roleId: role };
  const canRead = () => getEffectiveAccess(role, agentIdentity).pagePermissionIds.includes(page);
  // Re-resolve write grants after asynchronous body/source processing, not just at ingress.
  const canWrite = () => { const access = getEffectiveAccess(role, agentIdentity); return access.pagePermissionIds.includes(page) && access.buttonPermissionIds.includes(writePermission); };
  const resolveProvider = async provider => provider === 'weknora_local' ? loadWeKnoraRuntimeProvider(context) : createLocalKnowledgeProvider(context);
  const reply = result => { send(res, result.error ? result.status || 400 : 200, result); return true; };
  // POST read operations also require a page grant; app's GET guard alone is insufficient.
  if (!(effectiveAccess || getEffectiveAccess(role, agentIdentity)).pagePermissionIds.includes(page)) return reply({ error: 'PAGE_PERMISSION_DENIED', status: 403 });
  const materialReviewBase = `${base}/material-reviews`;
  const materialReview = semantic && url.pathname.slice(base.length).match(/^\/material-reviews\/([a-f0-9-]{36})(\/(?:decision|archive|assignment))?$/);
  const materialHistory = semantic && url.pathname === `${materialReviewBase}/history`;
  const materialReviewers = semantic && url.pathname === `${materialReviewBase}/reviewers`;
  if (semantic && (url.pathname === materialReviewBase || materialReview || materialHistory || materialReviewers)) {
    const canReview = () => { const access = getEffectiveAccess(role, agentIdentity); return access.pagePermissionIds.includes(page) && access.buttonPermissionIds.includes('meta_model.draft.review'); };
    if (!canReview()) return reply({ error: 'REVIEW_PERMISSION_DENIED', status: 403 });
    const service = knowledgeModelLinks.materialReviews;
    if (req.method === 'GET' && materialReviewers) return reply(await service.reviewers({ context, canRead: () => canReview() && canWrite() }));
    if (req.method === 'GET' && materialHistory) return reply(await service.history({ context, resolveProvider, canRead: canReview, offset: Number(url.searchParams.get('offset') || 0) }));
    if (req.method === 'GET' && url.pathname === materialReviewBase) return reply(await service.list({ context, resolveProvider, canRead: canReview, offset: Number(url.searchParams.get('offset') || 0) }));
    if (req.method === 'GET' && materialReview && !materialReview[2]) return reply(await service.read({ context, resolveProvider, canRead: canReview, id: materialReview[1] }));
    if (req.method === 'POST' && (url.pathname === materialReviewBase || materialReview?.[2])) {
      if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
      const options = { context, resolveProvider, canRead: () => canReview() && canWrite(), body: await readBody(req) };
      return reply(materialReview ? await ({ '/archive': service.archive, '/assignment': service.assign, '/decision': service.decide }[materialReview[2]])({ ...options, id: materialReview[1] }) : await service.create(options));
    }
    return reply({ error: 'METHOD_NOT_ALLOWED', status: 405 });
  }
  const teamBase = `${base}/team-model-views`;
  const teamModelViews = knowledgeModelLinks.teamViews;
  const sharing = semantic && url.pathname.slice(base.length).match(/^\/model-views\/([a-f0-9-]{36})\/share$/);
  const teamView = semantic && url.pathname.slice(base.length).match(/^\/team-model-views\/([a-f0-9-]{36})(\/(?:retract|archive))?$/);
  const teamHistory = semantic && url.pathname === `${teamBase}/history`;
  if (semantic && (url.pathname === teamBase || sharing || teamView || teamHistory)) {
    const canReview = () => { const access = getEffectiveAccess(role, agentIdentity); return access.pagePermissionIds.includes(page) && access.buttonPermissionIds.includes('meta_model.draft.review'); };
    if (!await canReview()) return reply({ error: 'REVIEW_PERMISSION_DENIED', status: 403 });
    if (req.method === 'GET' && teamHistory) return reply(await teamModelViews.history({ context, canRead: canReview, offset: Number(url.searchParams.get('offset') || 0), limit: Number(url.searchParams.get('limit') || 20) }));
    if (req.method === 'GET' && url.pathname === teamBase) return reply(await teamModelViews.list({ context, canRead: canReview }));
    if (req.method === 'GET' && teamView && !teamView[2]) return reply(await teamModelViews.read({ context, canRead: canReview, id: teamView[1] }));
    if (req.method === 'POST' && (sharing || teamView?.[2])) {
      if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
      const canWrite = () => canReview() && getEffectiveAccess(role, agentIdentity).buttonPermissionIds.includes(writePermission);
      const operation = sharing ? teamModelViews.share : teamView[2] === '/archive' ? teamModelViews.archive : teamModelViews.retract;
      return reply(await operation({ context, canRead: canWrite, id: (sharing || teamView)[1], body: await readBody(req) }));
    }
    return reply({ error: 'METHOD_NOT_ALLOWED', status: 405 });
  }
  if (semantic && url.pathname === `${base}/model-views` && req.method === 'GET') return reply(await knowledgeModelLinks.views.list({ context, canRead }));
  const modelView = semantic && url.pathname.slice(base.length).match(/^\/model-views\/([a-f0-9-]{36})$/);
  if (modelView && req.method === 'GET') return reply(await knowledgeModelLinks.views.read({ context, id: modelView[1], canRead }));
  if (semantic && url.pathname === `${base}/model-views` && req.method === 'POST') {
    if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
    return reply(await knowledgeModelLinks.views.save({ context, body: await readBody(req), canRead: () => { const access = getEffectiveAccess(role, agentIdentity); return access.pagePermissionIds.includes(page) && access.buttonPermissionIds.includes(writePermission); } }));
  }
  if (semantic && url.pathname === `${base}/model-links` && req.method === 'GET') return reply(await knowledgeModelLinks.list({ context, resolveProvider, canRead }));
  const linkRetract = semantic && url.pathname.slice(base.length).match(/^\/model-links\/([a-f0-9-]{36})\/retract$/);
  const linkSuggest = semantic && url.pathname === `${base}/model-links/suggest`;
  if (semantic && (url.pathname === `${base}/model-links` || linkRetract || linkSuggest) && req.method === 'POST') {
    if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
    const canWrite = () => { const access = getEffectiveAccess(role, agentIdentity); return access.pagePermissionIds.includes(page) && access.buttonPermissionIds.includes(writePermission); };
    const body = await readBody(req);
    if (linkSuggest) return reply(await knowledgeModelLinks.suggest({ context, body, resolveProvider, canRead: canWrite }));
    return reply(linkRetract ? await knowledgeModelLinks.retract({ context, id: linkRetract[1], body, canRead: canWrite }) : await knowledgeModelLinks.save({ context, body, resolveProvider, canRead: canWrite }));
  }
  if (req.method === 'GET' && url.pathname === `${base}/joint-plans` && !semantic) {
    return reply(await listKnowledgeBusinessPlans({ context, canRead }));
  }
  if (req.method === 'POST' && url.pathname === `${base}/joint-brief` && !semantic) {
    if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
    return reply(await buildKnowledgeBusinessBrief({ context, body: await readBody(req), resolveProvider,
      canRead: () => { const access = getEffectiveAccess(role, agentIdentity); return access.pagePermissionIds.includes(page) && access.buttonPermissionIds.includes(writePermission); } }));
  }
  if (req.method === 'GET' && url.pathname === `${base}/studies`) return reply(await listKnowledgeStudies(context));
  if (req.method === 'POST' && url.pathname === `${base}/materials/preview`) {
    if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
    return reply(await previewKnowledgeMaterial({ body: await readBody(req), roleId: role, canRead: canWrite }));
  }
  if (req.method === 'POST' && url.pathname === `${base}/answer`) {
    if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
    return reply(await answerKnowledgeQuestion({ body: await readBody(req), resolveProvider, canRead: canWrite, safetyIdentifier: `knowledge-${role}` }));
  }
  if (req.method === 'POST' && url.pathname === `${base}/answer-sources`) {
    if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
    return reply(await supplementKnowledgeSources({ body: await readBody(req), resolveProvider,
      canRead: () => { const access = getEffectiveAccess(role, agentIdentity); return access.pagePermissionIds.includes(page) && access.buttonPermissionIds.includes(writePermission); } }));
  }
  if (req.method === 'POST' && url.pathname === `${base}/read-plan-proposal` && semantic) {
    if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
    return reply(await proposeSemanticReadPlan({ body: await readBody(req), safetyIdentifier: `semantic-read-plan-${role}`,
      canRead: () => { const access = getEffectiveAccess(role, agentIdentity); return access.pagePermissionIds.includes(page) && access.buttonPermissionIds.includes(writePermission); } }));
  }
  if (req.method === 'POST' && url.pathname === `${base}/studies/prepare`) {
    if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
    return reply(await prepareKnowledgeStudy({ body: await readBody(req), resolveProvider, canRead: canWrite }));
  }
  const restoreMatch = url.pathname.slice(base.length).match(/^\/studies\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/restore$/);
  if (restoreMatch && req.method === 'POST') {
    if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
    return reply(await restoreKnowledgeStudy({ context, id: restoreMatch[1], body: await readBody(req), resolveProvider, canRead: canWrite }));
  }
  const studyMatch = url.pathname.slice(base.length).match(/^\/studies\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/);
  if (studyMatch && req.method === 'GET') return reply(await readKnowledgeStudy({ context, id: studyMatch[1],
    revision: url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined, resolveProvider, canRead }));
  if (studyMatch && req.method === 'PUT') {
    if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
    return reply(await saveKnowledgeStudy({ context, id: studyMatch[1], body: await readBody(req), resolveProvider, canRead: canWrite }));
  }
  if (req.method === 'GET' && url.pathname === `${base}/providers`) return reply({
    providers: [createLocalKnowledgeProvider(context).status(), (await loadWeKnoraRuntimeProvider(context)).status()],
    automaticChatInjection: false,
    answerPolicy: knowledgeAnswerPolicy(),
    principalKey: knowledgePrincipalKey(context),
    canWrite: (effectiveAccess || getEffectiveAccess(role, agentIdentity)).buttonPermissionIds?.includes(writePermission) === true
  });
  if (req.method === 'POST' && url.pathname === `${base}/brief`) {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['query', 'limit', 'provider'].includes(key))
      || body.provider !== undefined && !['local_private_library', 'weknora_local'].includes(body.provider)) return reply({ error: 'KNOWLEDGE_INPUT_INVALID', status: 400 });
    const provider = body.provider === 'weknora_local' ? await loadWeKnoraRuntimeProvider(context) : createLocalKnowledgeProvider(context);
    return reply(await buildKnowledgeBrief({ provider, query: body.query, limit: body.limit ?? 5,
      canRead: () => getEffectiveAccess(role, agentIdentity).pagePermissionIds.includes(page) }));
  }
  if (req.method === 'POST' && url.pathname === `${base}/citation`) {
    const citation = await readBody(req);
    const provider = citation?.provider === 'weknora_local' ? await loadWeKnoraRuntimeProvider(context) : createLocalKnowledgeProvider(context);
    const result = await provider.read(citation);
    if (!getEffectiveAccess(role, agentIdentity).pagePermissionIds.includes(page)) return reply({ error: 'KNOWLEDGE_ACCESS_DENIED', status: 403 });
    return reply(result);
  }
  if (req.method === 'GET' && url.pathname === base) return reply(await listLibraryDocuments(context));
  if (req.method === 'GET' && url.pathname === `${base}/search`) return reply(await searchLibraryDocuments({ ...context, query: url.searchParams.get('query'), limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 5 }));
  const documentMatch = url.pathname.slice(base.length).match(/^\/documents\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/);
  if (req.method === 'GET' && documentMatch) return reply(await readLibraryDocument({ ...context, id: documentMatch[1], revision: Number(url.searchParams.get('revision')) }));
  if (req.method === 'POST' && url.pathname === `${base}/preview`) {
    if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
    return reply(previewLibraryDocument(await readBody(req)));
  }
  const retractMatch = url.pathname.slice(base.length).match(/^\/documents\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/retract$/);
  if (req.method === 'PUT' && documentMatch || req.method === 'POST' && retractMatch) {
    // Explicit personal-library write, not publication of enterprise rules.
    if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
    const body = await readBody(req);
    if (documentMatch) return reply(await saveLibraryDocument({ ...context, id: documentMatch[1], body }));
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'expectedRevision')) return reply({ error: 'KNOWLEDGE_INPUT_INVALID', status: 400 });
    return reply(await retractLibraryDocument({ ...context, id: retractMatch[1], expectedRevision: body.expectedRevision }));
  }
  return reply({ error: 'KNOWLEDGE_ROUTE_NOT_FOUND', status: 404 });
}

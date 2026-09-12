import { previewLibraryDocument, saveLibraryDocument, retractLibraryDocument, listLibraryDocuments, readLibraryDocument, searchLibraryDocuments,
  listKnowledgeStudies, saveKnowledgeStudy, readKnowledgeStudy,
  createLocalKnowledgeProvider, buildKnowledgeBrief, getEffectiveAccess, loadWeKnoraRuntimeProvider } from '../domains/governance/public-api.js';

export async function handleKnowledgeRoutes({ req, res, url, role, agentIdentity, effectiveAccess, selectActionRole, denyButton, readBody, send }) {
  const base = ['/api/agent/knowledge-library', '/api/semantic-operations/knowledge-library']
    .find(path => url.pathname === path || url.pathname.startsWith(`${path}/`));
  if (!base) return false;
  const semantic = base.startsWith('/api/semantic-operations/');
  const page = semantic ? 'page.world.view' : 'page.agent.view';
  const writePermission = semantic ? 'meta_model.draft.save' : 'agent.prompt.run';
  const context = { identityScope: agentIdentity, roleId: role };
  const canRead = () => getEffectiveAccess(role, agentIdentity).pagePermissionIds.includes(page);
  const resolveProvider = async provider => provider === 'weknora_local' ? loadWeKnoraRuntimeProvider(context) : createLocalKnowledgeProvider(context);
  const reply = result => { send(res, result.error ? result.status || 400 : 200, result); return true; };
  // POST read operations also require a page grant; app's GET guard alone is insufficient.
  if (!(effectiveAccess || getEffectiveAccess(role, agentIdentity)).pagePermissionIds.includes(page)) return reply({ error: 'PAGE_PERMISSION_DENIED', status: 403 });
  if (req.method === 'GET' && url.pathname === `${base}/studies`) return reply(await listKnowledgeStudies(context));
  const studyMatch = url.pathname.slice(base.length).match(/^\/studies\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/);
  if (studyMatch && req.method === 'GET') return reply(await readKnowledgeStudy({ context, id: studyMatch[1], resolveProvider, canRead }));
  if (studyMatch && req.method === 'PUT') {
    if (!selectActionRole(writePermission)) { denyButton(writePermission); return true; }
    return reply(await saveKnowledgeStudy({ context, id: studyMatch[1], body: await readBody(req), resolveProvider, canRead }));
  }
  if (req.method === 'GET' && url.pathname === `${base}/providers`) return reply({
    providers: [createLocalKnowledgeProvider(context).status(), (await loadWeKnoraRuntimeProvider(context)).status()],
    automaticChatInjection: false,
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

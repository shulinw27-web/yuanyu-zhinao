import {
  getWorkflowIntegrationOverview,
  getWorkflowDefinition,
  syncWorkflowDefinitions,
  syncConfiguredWorkflowDefinitions,
  reviewWorkflowDefinition,
  queryPublishedWorkflowContext,
  workflowWebhookOperations
} from '../domains/workflow-integration/public-api.js';

export async function handleWorkflowIntegrationRoutes({ req, res, url, role, agentIdentity, selectActionRole, denyButton, readBody, send }) {
  const webhookMatch = url.pathname.match(/^\/api\/integrations\/workflows\/webhooks\/([a-z][a-z0-9_-]{1,48})$/u);
  if (webhookMatch && req.method === 'POST') {
    const result = workflowWebhookOperations.receive({ providerId: webhookMatch[1], headers: req.headers, body: await readBody(req) });
    send(res, result.error ? result.status || 400 : result.duplicate ? 200 : 202, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/semantic-operations/workflows') {
    send(res, 200, getWorkflowIntegrationOverview());
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/semantic-operations/workflows/sync') {
    const actionRole = selectActionRole('meta_model.draft.save');
    if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
    const body = await readBody(req);
    const syncInput = { actor: { type: 'user', id: agentIdentity.subjectId || actionRole.id }, trigger: 'manual' };
    const result = body?.mode === 'configured'
      ? await syncConfiguredWorkflowDefinitions(syncInput)
      : syncWorkflowDefinitions({ ...syncInput, scenario: body?.scenario || 'baseline' });
    send(res, result.error ? result.status || 400 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  const reviewMatch = url.pathname.match(/^\/api\/semantic-operations\/workflows\/([^/]+)\/versions\/([^/]+)\/review$/u);
  if (reviewMatch && req.method === 'POST') {
    const actionRole = selectActionRole('meta_model.publish');
    if (!actionRole) { denyButton('meta_model.publish'); return true; }
    const body = await readBody(req);
    const result = reviewWorkflowDefinition({ code: decodeURIComponent(reviewMatch[1]), version: decodeURIComponent(reviewMatch[2]), action: body?.action, actor: { type: 'user', id: agentIdentity.subjectId || actionRole.id } });
    send(res, result.error ? result.status || 400 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  const replayMatch = url.pathname.match(/^\/api\/semantic-operations\/workflows\/events\/([^/]+)\/replay$/u);
  if (replayMatch && req.method === 'POST') {
    const actionRole = selectActionRole('event.outbox.replay');
    if (!actionRole) { denyButton('event.outbox.replay'); return true; }
    const result = workflowWebhookOperations.replay({ eventId: decodeURIComponent(replayMatch[1]), actor: { type: 'user', id: agentIdentity.subjectId || actionRole.id } });
    send(res, result.error ? result.status || 400 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  const definitionMatch = url.pathname.match(/^\/api\/semantic-operations\/workflows\/([^/]+)$/u);
  if (definitionMatch && req.method === 'GET') {
    const result = getWorkflowDefinition(decodeURIComponent(definitionMatch[1]), { identityScope: { ...agentIdentity, roleId: role?.id || role } });
    send(res, result.error ? result.status || 404 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/workflow-context') {
    const result = queryPublishedWorkflowContext({ query: url.searchParams.get('query') || '', identityScope: { ...agentIdentity, roleId: role?.id || role } });
    send(res, result.error ? result.status || 400 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  return false;
}

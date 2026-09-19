import {
  listMockOnboarding,
  createMockOnboardingProject,
  getMockOnboardingProject,
  saveMockOnboardingMaterial,
  testMockOnboardingConnection,
  getMockOnboardingPreview,
  getMockOnboardingAlignment,
  saveMockOnboardingAlignment,
  handoffMockOnboardingModel,
  getMockOnboardingCalculations,
  previewMockOnboardingCalculation,
  runWithSemanticTenant,
  runOntologyReadReplay,
  archiveSemanticOperationsTask,
  createWorldModelDraft,
  createSemanticOperationsProposalFromRequest,
  createSemanticOperationsTask,
  createSemanticInspectionSchedule,
  controlSemanticInspectionSchedule,
  discoverSemanticSources,
  executeSemanticOperationsTask,
  getSemanticOperationsTask,
  getSemanticOperationsTaskTrace,
  issueSemanticOperationsTaskConfirmation,
  listSemanticOperationsSnapshots,
  listSemanticOperationsTasks,
  listSemanticInspectionSchedules,
  listSemanticOperationsNotifications,
  readSemanticOperationsNotification,
  recordSemanticOperationsReportExport,
  reviseSemanticOperationsTaskProposal,
  rollbackSemanticOperationsSnapshot,
  getCoreMetaObjectLayer,
  getEnterpriseKnowledgeCatalog,
  getMetaModel,
  getMetaModels,
  getOAMetaModelAuthoringProfile,
  getOAMetaModelDraft,
  getOAMetaModelSimulation,
  getRole,
  getSemanticaModelDeployment,
  getSemanticaModelDiscovery,
  getSemanticContextOverview,
  getWorldModel,
  getWorldModelConnectionTargets,
  getWorldModelDrafts,
  getWorldModelTemplate,
  getWorldModelTemplates,
  publishGovernedOntology,
  runOntologyCaseReplay,
  getOntologyCaseReplay,
  publishWorldModelDraft,
  retrieveEnterpriseKnowledge,
  saveOAMetaModelDraft,
  semanticFingerprint,
  simulateBuildOAMetaModel,
  validateSemanticaModelDefinition,
  validateOAMetaModelDraft,
  validateWorldModelDraft
} from '../domains/governance/public-api.js';

export function handleGovernanceRoutes(context) {
  // Unrelated public routes may have no authenticated identity.
  if (!/^\/api\/(?:meta-models|meta-objects|world-model|semantic|knowledge|agent\/knowledge)/u.test(context.url.pathname)) return false;
  return runWithSemanticTenant(context.agentIdentity, () => handleTenantGovernanceRoutes(context));
}

async function handleTenantGovernanceRoutes({ req, res, url, role, agentIdentity, effectiveAccess, selectActionRole, denyButton, readBody, send }) {
  const onboardingMatch = url.pathname.match(/^\/api\/semantic-operations\/onboarding(?:\/([^/]+)(?:\/(materials|connection|preview|alignment|handoff|calculations))?)?$/u);
  if (onboardingMatch && ['GET', 'POST'].includes(req.method)) {
    const [, encodedId, action] = onboardingMatch;
    if ((req.method === 'GET' && action && !['preview', 'alignment', 'calculations'].includes(action)) || (req.method === 'POST' && encodedId && !['materials', 'connection', 'alignment', 'handoff', 'calculations'].includes(action))) return false;
    const actionRole = selectActionRole('meta_model.draft.save');
    if (req.method === 'POST' && !actionRole) { denyButton('meta_model.draft.save'); return true; }
    const options = { role: actionRole || getRole(role), identityScope: agentIdentity };
    let result;
    if (req.method === 'GET') result = action === 'preview' ? await getMockOnboardingPreview({ ...options, id: decodeURIComponent(encodedId), objectType: url.searchParams.get('objectType') })
      : action === 'calculations' ? await getMockOnboardingCalculations({ ...options, id: decodeURIComponent(encodedId) })
      : action === 'alignment' ? await getMockOnboardingAlignment({ ...options, id: decodeURIComponent(encodedId) })
      : encodedId ? await getMockOnboardingProject({ ...options, id: decodeURIComponent(encodedId) }) : await listMockOnboarding(options);
    else {
      const body = await readBody(req);
      result = action === 'connection' ? await testMockOnboardingConnection({ ...options, id: decodeURIComponent(encodedId), body })
        : action === 'calculations' ? await previewMockOnboardingCalculation({ ...options, id: decodeURIComponent(encodedId), body })
        : action === 'alignment' ? await saveMockOnboardingAlignment({ ...options, id: decodeURIComponent(encodedId), body })
        : action === 'handoff' ? await handoffMockOnboardingModel({ ...options, id: decodeURIComponent(encodedId), body })
        : action === 'materials' ? await saveMockOnboardingMaterial({ ...options, id: decodeURIComponent(encodedId), body }) : await createMockOnboardingProject({ ...options, body });
    }
    send(res, result.error ? result.status || 400 : req.method === 'POST' && !action ? 201 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/meta-models/oa-governance/read-plan-replay') {
    const actionRole = selectActionRole('meta_model.publish');
    if (!actionRole) { denyButton('meta_model.publish'); return true; }
    const result = await runOntologyReadReplay({ body: await readBody(req), role: actionRole, identityScope: agentIdentity });
    send(res, result.error ? 409 : 200, result); return true;
  }
  if (url.pathname === '/api/meta-models/oa-governance/case-replay' && ['GET', 'POST'].includes(req.method)) {
    const actionRole = selectActionRole('meta_model.draft.validate');
    if (!actionRole) { denyButton('meta_model.draft.validate'); return true; }
    const result = req.method === 'GET' ? await getOntologyCaseReplay({ role: actionRole, identityScope: agentIdentity })
      : await runOntologyCaseReplay({ body: await readBody(req), role: actionRole, identityScope: agentIdentity });
    send(res, result?.error ? 409 : 200, result || { status: 'not_run' }); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/semantic-operations/inspections') {
    send(res, 200, { schedules: await listSemanticInspectionSchedules({ identityScope: agentIdentity }) }); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/semantic-operations/inspections') {
    const actionRole = selectActionRole('meta_model.draft.validate');
    if (!actionRole) { denyButton('meta_model.draft.validate'); return true; }
    const result = await createSemanticInspectionSchedule({ body: await readBody(req), role: actionRole, identityScope: agentIdentity });
    send(res, result.error ? 400 : 201, result.error ? { message: result.error, code: result.code } : result); return true;
  }
  const semanticInspectionControlMatch = url.pathname.match(/^\/api\/semantic-operations\/inspections\/([^/]+)\/(pause|resume|cancel|run-now)$/);
  if (req.method === 'POST' && semanticInspectionControlMatch) {
    const result = await controlSemanticInspectionSchedule({ id: decodeURIComponent(semanticInspectionControlMatch[1]), action: semanticInspectionControlMatch[2], identityScope: agentIdentity });
    send(res, result?.error ? 404 : 200, result?.error ? { message: result.error, code: result.code } : result); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/semantic-operations/notifications') {
    send(res, 200, { notifications: await listSemanticOperationsNotifications({ identityScope: agentIdentity, limit: url.searchParams.get('limit') }) }); return true;
  }
  const semanticNotificationReadMatch = url.pathname.match(/^\/api\/semantic-operations\/notifications\/([^/]+)\/read$/);
  if (req.method === 'POST' && semanticNotificationReadMatch) {
    const result = await readSemanticOperationsNotification({ id: decodeURIComponent(semanticNotificationReadMatch[1]), identityScope: agentIdentity });
    send(res, result?.error ? 404 : 200, result?.error ? { message: result.error, code: result.code } : result); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/semantic-operations/sources') {
    send(res, 200, discoverSemanticSources({ request: url.searchParams.get('query') || '', role: getRole(role) }));
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/semantic-operations/tasks') {
    send(res, 200, { tasks: await listSemanticOperationsTasks({
      identityScope: agentIdentity,
      accessContext: effectiveAccess,
      status: url.searchParams.get('status') || '',
      query: url.searchParams.get('query') || '',
      includeArchived: url.searchParams.get('archived') === 'true',
      limit: url.searchParams.get('limit') || 30
    }) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/semantic-operations/tasks') {
    const result = await createSemanticOperationsTask({ body: await readBody(req), role: getRole(role), identityScope: agentIdentity });
    send(res, result.error ? (result.status || 400) : 201, result.error ? { message: result.error } : result);
    return true;
  }
  const semanticTaskTraceMatch = url.pathname.match(/^\/api\/semantic-operations\/tasks\/([^/]+)\/trace$/);
  const semanticTaskDetailMatch = url.pathname.match(/^\/api\/semantic-operations\/tasks\/([^/]+)$/);
  if (req.method === 'GET' && semanticTaskDetailMatch) {
    const task = await getSemanticOperationsTask({ taskId: decodeURIComponent(semanticTaskDetailMatch[1]), identityScope: agentIdentity, accessContext: effectiveAccess });
    send(res, task ? 200 : 404, task ? { task } : { message: '未找到当前身份可见的语义运营任务。', code: 'SEMANTIC_TASK_NOT_FOUND' });
    return true;
  }
  if (req.method === 'GET' && semanticTaskTraceMatch) {
    const trace = await getSemanticOperationsTaskTrace({ taskId: decodeURIComponent(semanticTaskTraceMatch[1]), identityScope: agentIdentity, accessContext: effectiveAccess });
    send(res, trace ? 200 : 404, trace || { message: '未找到当前身份可见的语义证据链。', code: 'SEMANTIC_TRACE_NOT_FOUND' });
    return true;
  }
  const semanticTaskReportMatch = url.pathname.match(/^\/api\/semantic-operations\/tasks\/([^/]+)\/report-export$/);
  if (req.method === 'POST' && semanticTaskReportMatch) {
    const body = await readBody(req);
    const result = await recordSemanticOperationsReportExport({ taskId: decodeURIComponent(semanticTaskReportMatch[1]), receipt: body?.receipt, identityScope: agentIdentity });
    send(res, result.error ? 400 : 200, result.error ? { message: result.error, code: result.code } : result); return true;
  }
  const semanticTaskConfirmationMatch = url.pathname.match(/^\/api\/semantic-operations\/tasks\/([^/]+)\/confirmation$/);
  if (req.method === 'POST' && semanticTaskConfirmationMatch) {
    const taskId = decodeURIComponent(semanticTaskConfirmationMatch[1]);
    const task = await getSemanticOperationsTask({ taskId, identityScope: agentIdentity, accessContext: effectiveAccess });
    if (!task) { send(res, 404, { message: '未找到属于当前身份的语义运营任务。', code: 'SEMANTIC_TASK_NOT_FOUND' }); return true; }
    const actionRole = selectActionRole(task.requiredPermission);
    if (!actionRole) { denyButton(task.requiredPermission); return true; }
    const result = await issueSemanticOperationsTaskConfirmation({ taskId, identityScope: agentIdentity });
    send(res, result.error ? 409 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  const semanticTaskArchiveMatch = url.pathname.match(/^\/api\/semantic-operations\/tasks\/([^/]+)\/archive$/);
  if (req.method === 'POST' && semanticTaskArchiveMatch) {
    const result = await archiveSemanticOperationsTask({ taskId: decodeURIComponent(semanticTaskArchiveMatch[1]), identityScope: agentIdentity });
    send(res, result.error ? 409 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  const semanticTaskExecuteMatch = url.pathname.match(/^\/api\/semantic-operations\/tasks\/([^/]+)\/execute$/);
  if (req.method === 'POST' && semanticTaskExecuteMatch) {
    const taskId = decodeURIComponent(semanticTaskExecuteMatch[1]);
    const task = await getSemanticOperationsTask({ taskId, identityScope: agentIdentity, accessContext: effectiveAccess });
    if (!task) { send(res, 404, { message: '未找到属于当前身份的语义运营任务。', code: 'SEMANTIC_TASK_NOT_FOUND' }); return true; }
    const actionRole = selectActionRole(task.requiredPermission);
    if (!actionRole) { denyButton(task.requiredPermission); return true; }
    const body = await readBody(req);
    const result = await executeSemanticOperationsTask({ taskId, role: actionRole, identityScope: agentIdentity, confirmationToken: body?.confirmationToken });
    send(res, result.error ? 409 : 200, result.error ? { message: result.error, code: result.code, task: result.task } : result);
    return true;
  }
  const semanticTaskProposalMatch = url.pathname.match(/^\/api\/semantic-operations\/tasks\/([^/]+)\/proposal$/);
  if (req.method === 'PATCH' && semanticTaskProposalMatch) {
    const actionRole = selectActionRole('meta_model.draft.save');
    if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
    const result = await reviseSemanticOperationsTaskProposal({ taskId: decodeURIComponent(semanticTaskProposalMatch[1]), body: await readBody(req), role: actionRole, identityScope: agentIdentity });
    send(res, result.error ? 409 : 200, result.error ? { message: result.error, code: result.code, proposal: result.proposal } : result);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/semantic-operations/proposals') {
    const actionRole = selectActionRole('meta_model.draft.save');
    if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
    const result = await createSemanticOperationsProposalFromRequest({ body: await readBody(req), role: actionRole, identityScope: agentIdentity });
    send(res, result.error ? (result.status || 400) : 201, result.error ? { message: result.error } : result);
    return true;
  }
  const semanticProposalApplyMatch = url.pathname.match(/^\/api\/semantic-operations\/proposals\/([^/]+)\/apply$/);
  if (req.method === 'POST' && semanticProposalApplyMatch) {
    send(res, 409, { message: '提案不能绕过任务审阅直接采纳。请从语义运营任务签发一次性确认凭证后执行。', code: 'SEMANTIC_PROPOSAL_TASK_CONFIRMATION_REQUIRED' });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/semantic-operations/snapshots') {
    const actionRole = selectActionRole('meta_model.draft.save');
    if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
    send(res, 200, { snapshots: await listSemanticOperationsSnapshots({ identityScope: agentIdentity }) });
    return true;
  }
  const semanticSnapshotRollbackMatch = url.pathname.match(/^\/api\/semantic-operations\/snapshots\/([^/]+)\/rollback$/);
  if (req.method === 'POST' && semanticSnapshotRollbackMatch) {
    const actionRole = selectActionRole('meta_model.draft.save');
    if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
    const result = await rollbackSemanticOperationsSnapshot({ snapshotId: decodeURIComponent(semanticSnapshotRollbackMatch[1]), role: actionRole, identityScope: agentIdentity });
    send(res, result.error ? 409 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/knowledge') {
    const query = url.searchParams.get('query');
    send(res, 200, query ? retrieveEnterpriseKnowledge(query, role) : getEnterpriseKnowledgeCatalog(role));
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/semantic-context') { send(res, 200, await getSemanticContextOverview(role, agentIdentity)); return true; }
  if (req.method === 'GET' && url.pathname === '/api/world-model') { send(res, 200, getWorldModel(role)); return true; }
  if (req.method === 'GET' && url.pathname === '/api/meta-models') { send(res, 200, await getMetaModels()); return true; }
  if (req.method === 'GET' && url.pathname === '/api/meta-objects') { send(res, 200, getCoreMetaObjectLayer()); return true; }
  if (req.method === 'GET' && url.pathname === '/api/meta-models/oa-governance/authoring-profile') {
    const [semanticDiscovery, semanticDeployment] = await Promise.all([getSemanticaModelDiscovery(), getSemanticaModelDeployment()]);
    const draftFingerprint = semanticFingerprint(await getOAMetaModelDraft());
    const deploymentFingerprint = semanticDeployment.sourceFingerprint || semanticDeployment.deployment?.sourceFingerprint || null;
    const drift = semanticDeployment.status !== 'published' ? 'not_published' : deploymentFingerprint === draftFingerprint ? 'in_sync' : 'draft_ahead';
    send(res, 200, { ...getOAMetaModelAuthoringProfile(getRole(role), semanticDiscovery), semanticDeployment: { ...semanticDeployment, draftFingerprint, deploymentFingerprint, drift } });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/meta-models/oa-governance/draft') { send(res, 200, await getOAMetaModelDraft()); return true; }
  if (req.method === 'POST' && url.pathname === '/api/meta-models/oa-governance/draft') {
    const actionRole = selectActionRole('meta_model.draft.save');
    if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
    const result = await saveOAMetaModelDraft(await readBody(req), actionRole);
    send(res, result.error ? 403 : 200, result);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/meta-models/oa-governance/draft/validate') {
    const actionRole = selectActionRole('meta_model.draft.validate');
    if (!actionRole) { denyButton('meta_model.draft.validate'); return true; }
    const result = await validateOAMetaModelDraft(actionRole);
    send(res, result.error ? 403 : 200, result);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/meta-models/oa-governance/simulation') { send(res, 200, await getOAMetaModelSimulation() || { status: 'ready_to_build' }); return true; }
  if (req.method === 'POST' && url.pathname === '/api/meta-models/oa-governance/simulate-build') {
    const actionRole = selectActionRole('meta_model.simulate');
    if (!actionRole) { denyButton('meta_model.simulate'); return true; }
    const result = await simulateBuildOAMetaModel(actionRole);
    if (result.error) { send(res, 403, result); return true; }
    const semanticValidation = await validateSemanticaModelDefinition(result.metaModel);
    send(res, semanticValidation.status === 'failed' ? 422 : 200, { ...result, semanticValidation });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/meta-models/oa-governance/publish') {
    const actionRole = selectActionRole('meta_model.publish');
    if (!actionRole) { denyButton('meta_model.publish'); return true; }
    const result = await publishGovernedOntology({ role: actionRole, identityScope: agentIdentity });
    send(res, result.error ? 409 : 200, result);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/world-model/templates') { send(res, 200, getWorldModelTemplates()); return true; }
  if (req.method === 'GET' && url.pathname === '/api/world-model/connection-targets') { send(res, 200, getWorldModelConnectionTargets()); return true; }
  if (req.method === 'GET' && url.pathname === '/api/world-model/drafts') { send(res, 200, getWorldModelDrafts(role)); return true; }

  const templateMatch = url.pathname.match(/^\/api\/world-model\/templates\/([^/]+)$/);
  if (req.method === 'GET' && templateMatch) {
    const template = getWorldModelTemplate(templateMatch[1]);
    send(res, template ? 200 : 404, template || { message: '未找到世界模型模板。' });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/world-model/drafts') {
    const actionRole = selectActionRole('world.draft.create');
    if (!actionRole) { denyButton('world.draft.create'); return true; }
    const result = createWorldModelDraft(await readBody(req), actionRole);
    send(res, result.error ? 403 : 200, result);
    return true;
  }
  const draftActionMatch = url.pathname.match(/^\/api\/world-model\/drafts\/([^/]+)\/(validate|publish)$/);
  if (req.method === 'POST' && draftActionMatch) {
    const [, draftId, action] = draftActionMatch;
    const permissionId = action === 'validate' ? 'world.draft.validate' : 'world.draft.publish';
    const actionRole = selectActionRole(permissionId);
    if (!actionRole) { denyButton(permissionId); return true; }
    const result = action === 'validate' ? validateWorldModelDraft(draftId, actionRole) : publishWorldModelDraft(draftId, actionRole);
    send(res, result.error ? 403 : 200, result);
    return true;
  }

  const metaModelMatch = url.pathname.match(/^\/api\/meta-models\/([^/]+)$/);
  if (req.method === 'GET' && metaModelMatch) {
    const metaModel = await getMetaModel(metaModelMatch[1]);
    send(res, metaModel ? 200 : 404, metaModel || { message: '未找到元模型。' });
    return true;
  }
  return false;
}

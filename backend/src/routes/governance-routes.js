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
  saveSemanticOperationsDraft,
  semanticFingerprint,
  simulateBuildOAMetaModel,
  validateSemanticaModelDefinition,
  validateOAMetaModelDraft,
  validateWorldModelDraft
} from '../domains/governance/public-api.js';
import {
  getSystemAccessOverview,
  getSystemAccessDetail,
  probeSystemConnection,
  registerSystemOnboarding,
  transitionTenantSystemConnection,
  supplementSystemMaterials,
  getSystemUnderstanding
} from '../domains/system-onboarding/public-api.js';

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
  // ── 系统接入（阶段 2：从管理 Web config 页迁出，命名空间统一到元域智语端） ──────
  // 权限分界（阶段 6 等价合并后收敛为一把闸门体系）：
  //   * 系统接入自身的写入（连通性探测）走 meta_model.draft.save —— 与建模侧同一把闸门。
  //   * 「元模型连接模板 / 映射草稿」原走 world.draft.*（阶段 6 等价合并，用户决策 2026-09-28）：
  //     create→meta_model.draft.save、validate→meta_model.draft.validate、publish→meta_model.publish。
  //     语义等价映射对两处原持权角色零变化；映射草稿闸门与接入侧写入同闸后，
  //     其余三角色的该入口随之打开——与「接入侧写入同一把闸门」的既有语义一致。
  // 旧端点 /api/world-model/* 本阶段保留一个版本周期，但管理 Web 已无入口。
  //
  // 为什么把 validate / publish 也一并搬过来：管理 Web 上这三个按钮原本都是有处理器的，
  // 只搬「生成草稿」会让另外两个退化成新的空按钮——那正是本阶段要消除的问题。
  const systemAccessRootMatch = url.pathname.match(/^\/api\/semantic-operations\/systems(?:\/([^/]+))?$/u);
  const systemAccessActionMatch = url.pathname.match(/^\/api\/semantic-operations\/systems\/([^/]+)\/(probe|mapping-drafts|lifecycle|materials|understanding)$/u);
  const systemAccessDraftMatch = url.pathname.match(/^\/api\/semantic-operations\/systems\/([^/]+)\/mapping-drafts\/([^/]+)\/(validate|publish)$/u);
  const canReadWorldModel = Boolean(effectiveAccess?.pagePermissionIds?.includes('page.semantic-operations.view'));
  const templateFor = (code) => getWorldModelTemplates().find((template) => template.targets.includes(String(code || '').toLowerCase()));
  if (systemAccessRootMatch && ['GET', 'POST'].includes(req.method)) {
    const segment = systemAccessRootMatch[1] ? decodeURIComponent(systemAccessRootMatch[1]) : null;
    if (req.method === 'GET' && !segment) {
      send(res, 200, await getSystemAccessOverview({ roleId: role }));
      return true;
    }
    if (req.method === 'GET' && (segment === 'mapping-templates' || segment === 'connection-targets' || segment === 'mapping-drafts')) {
      if (!canReadWorldModel) { denyButton('page.semantic-operations.view'); return true; }
      const payload = segment === 'mapping-templates' ? { templates: getWorldModelTemplates() }
        : segment === 'connection-targets' ? { targets: getWorldModelConnectionTargets() }
          : { drafts: getWorldModelDrafts(role) };
      send(res, 200, payload);
      return true;
    }
    if (req.method === 'GET' && segment) {
      const result = await getSystemAccessDetail({ code: segment, roleId: role });
      send(res, result.error ? result.status || 404 : 200, result.error ? { message: result.error, code: result.code } : result);
      return true;
    }
    // 新增接入（ADR-024）：登记一个任意命名的自定义系统。登记是接入侧写入，
    // 与生命周期操作 / 连通性探测同一把闸门（meta_model.draft.save）。
    // 物料校验（必填项、系统码防撞、模拟场景合法性）全部在服务层完成，
    // 路由只做权限与转发；拒绝时逐字段返回 issues，便于界面点名缺失项。
    if (req.method === 'POST' && !segment) {
      const actionRole = selectActionRole('meta_model.draft.save');
      if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
      const body = await readBody(req);
      const result = await registerSystemOnboarding({ materials: body, identityScope: agentIdentity });
      send(res, result.error ? result.status || 400 : 201, result.error ? { message: result.error, code: result.code, issues: result.issues } : result);
      return true;
    }
    send(res, 405, { message: '不支持的接入操作。', code: 'SYSTEM_ACCESS_METHOD_NOT_ALLOWED' });
    return true;
  }
  if (systemAccessActionMatch) {
    const code = decodeURIComponent(systemAccessActionMatch[1]);
    const action = systemAccessActionMatch[2];
    // 缓存读取是只读请求。此前外层只允许 POST，导致 understanding 的 GET
    // 分支永远不可达，前端只能反复触发模型重算；在这里显式分流，其他动作
    // 仍然保持 POST-only，避免无意扩大写入面。
    if (action === 'understanding' && req.method === 'GET') {
      const result = await getSystemUnderstanding({ code, regenerate: false, identityScope: agentIdentity });
      send(res, result.error ? result.status || 404 : 200, result.error ? { message: result.error, code: result.code } : result);
      return true;
    }
    if (req.method !== 'POST') {
      send(res, 405, { message: '不支持的接入操作。', code: 'SYSTEM_ACCESS_METHOD_NOT_ALLOWED' });
      return true;
    }
    if (action === 'lifecycle') {
      // 接入生命周期操作（登记 / 授权确认 / 接通 / 停用 / 恢复）：与连通性探测同一把闸门
      // （meta_model.draft.save，接入侧写入）。接通跃迁的服务端门禁是「最近一次探测
      // verified」，由 service 层强制，路由只做权限与转发。
      const actionRole = selectActionRole('meta_model.draft.save');
      if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
      const body = await readBody(req);
      const result = transitionTenantSystemConnection({ code, to: body?.to, reason: body?.reason, identityScope: agentIdentity });
      send(res, result.error ? result.status || 400 : 200, result.error ? { message: result.error, code: result.code } : result);
      return true;
    }
    if (action === 'materials') {
      // 已接入系统补充物料（2026-10-07）：登记后追加文档 + 文字说明；文档走与登记
      // 同一受控解析管线。写入闸门与接入侧一致（meta_model.draft.save）。
      const actionRole = selectActionRole('meta_model.draft.save');
      if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
      const body = await readBody(req);
      const result = await supplementSystemMaterials({ code, body, identityScope: agentIdentity });
      send(res, result.error ? result.status || 400 : 200, result.error ? { message: result.error, code: result.code, issues: result.issues } : result);
      return true;
    }
    if (action === 'understanding') {
      // 系统理解（2026-10-07）：登记物料 + 文档提取文本交给大模型；GET 读缓存、
      // POST 重算（重算属接入侧动作，同一把闸门 meta_model.draft.save）。
      const actionRole = selectActionRole('meta_model.draft.save');
      if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
      const result = await getSystemUnderstanding({ code, regenerate: true, identityScope: agentIdentity });
      send(res, result.error ? result.status || 400 : 200, result.error ? { message: result.error, code: result.code } : result);
      return true;
    }
    if (action === 'probe') {
      const actionRole = selectActionRole('meta_model.draft.save');
      if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
      const body = await readBody(req);
      const result = await probeSystemConnection({ code, faultMode: body?.faultMode || 'none', roleId: actionRole.id || actionRole, identityScope: agentIdentity });
      send(res, result.error ? result.status || 400 : 200, result.error ? { message: result.error, code: result.code } : result);
      return true;
    }
    const actionRole = selectActionRole('meta_model.draft.save');
    if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
    const template = templateFor(code);
    if (!template) {
      send(res, 409, { message: `系统 ${code.toUpperCase()} 尚无元模型连接模板，不能生成映射草稿。`, code: 'SYSTEM_MAPPING_TEMPLATE_MISSING' });
      return true;
    }
    const result = createWorldModelDraft({ templateId: template.id, targetId: String(code).toLowerCase() }, actionRole);
    send(res, result.error ? 409 : 200, result.error ? { message: result.error, code: 'SYSTEM_MAPPING_DRAFT_REJECTED' } : result);
    return true;
  }
  if (systemAccessDraftMatch && req.method === 'POST') {
    const draftId = decodeURIComponent(systemAccessDraftMatch[2]);
    const action = systemAccessDraftMatch[3];
    const permissionId = action === 'validate' ? 'meta_model.draft.validate' : 'meta_model.publish';
    const actionRole = selectActionRole(permissionId);
    if (!actionRole) { denyButton(permissionId); return true; }
    const result = action === 'validate' ? validateWorldModelDraft(draftId, actionRole) : publishWorldModelDraft(draftId, actionRole);
    send(res, result.error ? 409 : 200, result.error ? { message: result.error, code: 'SYSTEM_MAPPING_DRAFT_REJECTED' } : result);
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
    send(res, 200, { notifications: await listSemanticOperationsNotifications({ identityScope: agentIdentity, accessContext: effectiveAccess, limit: url.searchParams.get('limit') }) }); return true;
  }
  const semanticNotificationReadMatch = url.pathname.match(/^\/api\/semantic-operations\/notifications\/([^/]+)\/read$/);
  if (req.method === 'POST' && semanticNotificationReadMatch) {
    const result = await readSemanticOperationsNotification({ id: decodeURIComponent(semanticNotificationReadMatch[1]), identityScope: agentIdentity, accessContext: effectiveAccess });
    send(res, result?.error ? 404 : 200, result?.error ? { message: result.error, code: result.code } : result); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/semantic-operations/sources') {
    // 只读来源清单：给查询词时走文本识别（selectionSource=text_inference，属推断）；
    // 不给查询词时**显式**请求全部已登记系统，而不是回落——回落会让「没给范围」和
    // 「要看全部」产生同一个响应，调用方无法区分（阶段 3）。
    const query = url.searchParams.get('query') || '';
    send(res, 200, discoverSemanticSources({
      request: query,
      role: getRole(role),
      includeAllRegistered: !query || url.searchParams.get('scope') === 'all_registered'
    }));
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/semantic-operations/tasks') {
    send(res, 200, { tasks: await listSemanticOperationsTasks({
      identityScope: agentIdentity,
      accessContext: effectiveAccess,
      status: url.searchParams.get('status') || '',
      query: url.searchParams.get('query') || '',
      includeArchived: url.searchParams.get('archived') === 'true',
      limit: url.searchParams.get('limit') || 30,
      offset: url.searchParams.get('offset') || 0
    }) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/semantic-operations/tasks') {
    const result = await createSemanticOperationsTask({ body: await readBody(req), role: getRole(role), identityScope: agentIdentity, accessContext: effectiveAccess });
    // code 必须透出：范围门禁（空选择 / 未登记 / 越权）要能被客户端与审计区分，
    // 只返回一句中文提示会让前端只能靠文本匹配来决定怎么补救。
    send(res, result.error ? (result.status || 400) : 201, result.error ? { message: result.error, ...(result.code ? { code: result.code } : {}) } : result);
    return true;
  }
  const semanticTaskTraceMatch = url.pathname.match(/^\/api\/semantic-operations\/tasks\/([^/]+)\/trace$/);
  const semanticTaskDetailMatch = url.pathname.match(/^\/api\/semantic-operations\/tasks\/([^/]+)$/);
  if (req.method === 'GET' && semanticTaskDetailMatch) {
    const task = await getSemanticOperationsTask({ taskId: decodeURIComponent(semanticTaskDetailMatch[1]), identityScope: agentIdentity, accessContext: effectiveAccess });
    send(res, task ? 200 : 404, task ? { task } : { message: '未找到当前身份可见的元域智语任务。', code: 'SEMANTIC_TASK_NOT_FOUND' });
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
    if (!task) { send(res, 404, { message: '未找到属于当前身份的元域智语任务。', code: 'SEMANTIC_TASK_NOT_FOUND' }); return true; }
    const reviewRole = task.proposal ? selectActionRole(task.reviewPermission) : null;
    const actionRole = selectActionRole(task.requiredPermission);
    if (task.proposal && !reviewRole) { denyButton(task.reviewPermission); return true; }
    if (!actionRole) { denyButton(task.requiredPermission); return true; }
    const result = await issueSemanticOperationsTaskConfirmation({ taskId, identityScope: agentIdentity, accessContext: effectiveAccess });
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
    if (!task) { send(res, 404, { message: '未找到属于当前身份的元域智语任务。', code: 'SEMANTIC_TASK_NOT_FOUND' }); return true; }
    const reviewRole = task.proposal ? selectActionRole(task.reviewPermission) : null;
    const actionRole = selectActionRole(task.requiredPermission);
    if (task.proposal && !reviewRole) { denyButton(task.reviewPermission); return true; }
    if (!actionRole) { denyButton(task.requiredPermission); return true; }
    const body = await readBody(req);
    const result = await executeSemanticOperationsTask({ taskId, role: actionRole, identityScope: agentIdentity, accessContext: effectiveAccess, confirmationToken: body?.confirmationToken });
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
    send(res, 409, { message: '提案不能绕过任务审阅直接采纳。请从元域智语任务签发一次性确认凭证后执行。', code: 'SEMANTIC_PROPOSAL_TASK_CONFIRMATION_REQUIRED' });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/semantic-operations/snapshots') {
    if (!canReadWorldModel) { denyButton('page.semantic-operations.view'); return true; }
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
    const result = await saveSemanticOperationsDraft({ input: await readBody(req), role: actionRole, identityScope: agentIdentity });
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
    const actionRole = selectActionRole('meta_model.draft.save');
    if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
    const result = createWorldModelDraft(await readBody(req), actionRole);
    send(res, result.error ? 403 : 200, result);
    return true;
  }
  const draftActionMatch = url.pathname.match(/^\/api\/world-model\/drafts\/([^/]+)\/(validate|publish)$/);
  if (req.method === 'POST' && draftActionMatch) {
    const [, draftId, action] = draftActionMatch;
    const permissionId = action === 'validate' ? 'meta_model.draft.validate' : 'meta_model.publish';
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

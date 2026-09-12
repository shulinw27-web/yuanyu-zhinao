import { normalizeAgentMessageBody } from '@healthcare-ai/api-contracts';
import {
  correctAgentLongTermMemory,
  archiveAgentConversation,
  cancelPrivateAgentCommand,
  cancelAgentLongTask,
  claimPrivateAgentLongTask,
  completePrivateAgentDesktopExecution,
  controlAgentOrchestration,
  configureModelConnection,
  createAgentConversation,
  createDeniedAgentExecutionTrace,
  createAgentOrchestration,
  executeAssistantCommand,
  executePrivateAgentCommand,
  forgetAgentWorkflowLearningSignal,
  getAgentConversation,
  getAgentConversationContext,
  getAgentConversationLimits,
  getAgentEvaluationOverview,
  getAgentLearningProfile,
  getAgentLongTask,
  forgetPrivateAgentMemory,
  getAgentOperations,
  getAgentRunOriginContext,
  getAgentSkills,
  getAgentWorkItems,
  getEffectiveAccess,
  getModelConnectionConfiguration,
  getPrivateAgentRuns,
  getPrivateAgentMemory,
  getPrivateAgentStatus,
  getRegisteredTools,
  getDesktopToolCatalog,
  getDesktopEndpointStatus,
  getRole,
  getZhiNaoAuthorizationProfile,
  hasButtonPermission,
  listAgentConversations,
  listAgentLongTasks,
  listAgentOrchestrations,
  pauseAgentLongTask,
  processAssistantMessage,
  pinAgentConversationGoal,
  recordAgentConversationExchange,
  recordAgentConversationTaskOutcome,
  recordAgentWorkflowLearningFeedback,
  registerDesktopEndpointHeartbeat,
  resumeAgentLongTask,
  runAgentEvaluationSuite,
  runPrivateAgent,
  updateAgentLearningProfile
} from '../domains/agent/public-api.js';

function resolveCommandRole(role, identity) {
  const currentAccess = getEffectiveAccess(role, identity);
  const orderedRoleIds = [...new Set([currentAccess.primaryRoleId, ...currentAccess.roleIds].filter(Boolean))];
  const roleId = orderedRoleIds.find((candidate) => hasButtonPermission(candidate, 'agent.prompt.run') && hasButtonPermission(candidate, 'agent.command.execute'));
  return roleId ? getRole(roleId) : null;
}

export async function handleAgentRoutes({ req, res, url, role, agentIdentity, effectiveAccess, selectActionRole, denyButton, readBody, send }) {
  if (req.method === 'GET' && url.pathname === '/api/agent/runtime') { send(res, 200, await getPrivateAgentStatus(role, agentIdentity)); return true; }
  if (req.method === 'GET' && url.pathname === '/api/agent/authorization') { send(res, 200, getZhiNaoAuthorizationProfile(role)); return true; }
  if (req.method === 'GET' && url.pathname === '/api/agent/model-config') { send(res, 200, getModelConnectionConfiguration()); return true; }
  if (req.method === 'POST' && url.pathname === '/api/agent/model-config') {
    if (!selectActionRole('agent.model.configure')) { denyButton('agent.model.configure'); return true; }
    const result = configureModelConnection(await readBody(req));
    send(res, result.error ? 400 : 200, result.error ? { message: result.error } : result);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/tools') { send(res, 200, getRegisteredTools()); return true; }
  if (req.method === 'GET' && url.pathname === '/api/agent/desktop-tools') { send(res, 200, getDesktopToolCatalog()); return true; }
  if (req.method === 'GET' && url.pathname === '/api/agent/desktop-endpoint') { send(res, 200, getDesktopEndpointStatus(agentIdentity)); return true; }
  if (req.method === 'POST' && url.pathname === '/api/agent/desktop-endpoint/heartbeat') {
    const result = registerDesktopEndpointHeartbeat({ identityScope: agentIdentity, heartbeat: await readBody(req) });
    send(res, result.error ? 400 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/skills') { send(res, 200, getAgentSkills()); return true; }
  if (req.method === 'GET' && url.pathname === '/api/agent/operations') { send(res, 200, await getAgentOperations(role, agentIdentity, effectiveAccess.roleIds)); return true; }
  if (req.method === 'GET' && url.pathname === '/api/agent/evaluations') { send(res, 200, getAgentEvaluationOverview(role)); return true; }
  if (req.method === 'POST' && url.pathname === '/api/agent/evaluations/run') {
    const actionRole = selectActionRole('agent.evaluation.run');
    if (!actionRole) { denyButton('agent.evaluation.run'); return true; }
    const result = await runAgentEvaluationSuite(actionRole.id);
    send(res, result.error ? 403 : 200, result.error ? { message: result.error } : result);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/work-items') { send(res, 200, getAgentWorkItems(effectiveAccess.roleIds, agentIdentity)); return true; }
  if (req.method === 'GET' && url.pathname === '/api/agent/runs') { send(res, 200, await getPrivateAgentRuns(effectiveAccess.roleIds, agentIdentity)); return true; }
  if (req.method === 'GET' && url.pathname === '/api/agent/runtime-tasks') { send(res, 200, { items: await listAgentLongTasks(effectiveAccess.roleIds, agentIdentity) }); return true; }
  if (req.method === 'GET' && url.pathname === '/api/agent/orchestrations') { send(res, 200, { items: await listAgentOrchestrations(agentIdentity) }); return true; }
  if (req.method === 'POST' && url.pathname === '/api/agent/orchestrations') {
    const actionRole = selectActionRole('agent.prompt.run');
    if (!actionRole) { denyButton('agent.prompt.run'); return true; }
    const body = await readBody(req);
    const result = await createAgentOrchestration({ identityScope: agentIdentity, roleId: actionRole.id, title: body.title, goal: body.goal, schedule: body.schedule, steps: body.steps });
    send(res, result.error ? 400 : 201, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  const orchestrationControlMatch = url.pathname.match(/^\/api\/agent\/orchestrations\/([^/]+)\/(pause|resume|cancel)$/);
  if (orchestrationControlMatch && req.method === 'POST') {
    const result = await controlAgentOrchestration({ identityScope: agentIdentity, orchestrationId: decodeURIComponent(orchestrationControlMatch[1]), action: orchestrationControlMatch[2] });
    send(res, result.error ? 409 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/memory') { send(res, 200, await getPrivateAgentMemory(effectiveAccess.roleIds, agentIdentity)); return true; }
  if (req.method === 'GET' && url.pathname === '/api/agent/learning-profile') {
    const result = await getAgentLearningProfile(agentIdentity);
    send(res, result.error ? 400 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/learning-profile') {
    const body = await readBody(req);
    const result = await updateAgentLearningProfile({ identityScope: agentIdentity, settings: body.settings, expectedVersion: body.expectedVersion ?? null });
    const status = result.code === 'AGENT_LEARNING_VERSION_CONFLICT' ? 409 : result.error ? 400 : 200;
    send(res, status, result.error ? { message: result.error, code: result.code, currentVersion: result.currentVersion } : result);
    return true;
  }
  const learningSignalMatch = url.pathname.match(/^\/api\/agent\/learning-signals\/([^/]+)$/);
  if (learningSignalMatch && req.method === 'DELETE') {
    const result = await forgetAgentWorkflowLearningSignal(agentIdentity, decodeURIComponent(learningSignalMatch[1]));
    send(res, result.error ? 404 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  const learningFeedbackMatch = url.pathname.match(/^\/api\/agent\/learning-signals\/([^/]+)\/feedback$/);
  if (learningFeedbackMatch && req.method === 'POST') {
    const body = await readBody(req);
    const result = await recordAgentWorkflowLearningFeedback({ identityScope: agentIdentity, signalId: decodeURIComponent(learningFeedbackMatch[1]), helpful: body.helpful });
    send(res, result.error ? (result.code === 'AGENT_LEARNING_SIGNAL_NOT_FOUND' ? 404 : 400) : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  const memoryMatch = url.pathname.match(/^\/api\/agent\/memory\/([^/]+)$/);
  if (memoryMatch && req.method === 'PATCH') {
    if (!selectActionRole('agent.prompt.run')) { denyButton('agent.prompt.run'); return true; }
    const result = await correctAgentLongTermMemory(effectiveAccess.roleIds, agentIdentity, decodeURIComponent(memoryMatch[1]), await readBody(req));
    send(res, result.error ? result.status || 400 : 200, result);
    return true;
  }
  if (memoryMatch && req.method === 'DELETE') {
    const result = await forgetPrivateAgentMemory(effectiveAccess.roleIds, decodeURIComponent(memoryMatch[1]), agentIdentity);
    send(res, result.error ? 404 : 200, result.error ? { message: result.error, code: 'AGENT_MEMORY_NOT_FOUND' } : result);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/conversations') { send(res, 200, { items: await listAgentConversations(agentIdentity, effectiveAccess), limits: getAgentConversationLimits() }); return true; }
  if (req.method === 'POST' && url.pathname === '/api/agent/conversations') {
    const body = await readBody(req);
    const result = await createAgentConversation({ roleId: role, identityScope: agentIdentity, accessContext: effectiveAccess, title: body.title });
    send(res, result.error ? 400 : 201, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }

  const conversationMatch = url.pathname.match(/^\/api\/agent\/conversations\/([^/]+)$/);
  if (conversationMatch && req.method === 'GET') {
    const conversation = await getAgentConversation(conversationMatch[1], agentIdentity, effectiveAccess);
    send(res, conversation ? 200 : 404, conversation || { message: '未找到可访问的智脑任务。', code: 'AGENT_CONVERSATION_NOT_FOUND' });
    return true;
  }
  const archiveMatch = url.pathname.match(/^\/api\/agent\/conversations\/([^/]+)\/archive$/);
  if (archiveMatch && req.method === 'POST') {
    const result = await archiveAgentConversation(archiveMatch[1], agentIdentity, effectiveAccess);
    send(res, result.error ? 404 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  const pinConversationMatch = url.pathname.match(/^\/api\/agent\/conversations\/([^/]+)\/pin$/);
  if (pinConversationMatch && req.method === 'POST') {
    const actionRole = selectActionRole('agent.prompt.run');
    if (!actionRole) { denyButton('agent.prompt.run'); return true; }
    const result = await pinAgentConversationGoal(decodeURIComponent(pinConversationMatch[1]), agentIdentity, effectiveAccess);
    send(res, result.error ? 404 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/assistant/message') {
    const actionRole = selectActionRole('agent.prompt.run');
    if (!actionRole) { denyButton('agent.prompt.run'); return true; }
    const body = await readBody(req);
    send(res, 200, await processAssistantMessage(body.text, actionRole));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/assistant/execute') {
    const actionRole = selectActionRole('agent.command.execute');
    if (!actionRole) { denyButton('agent.command.execute'); return true; }
    const body = await readBody(req);
    const outcome = await executeAssistantCommand(body.commandId, actionRole);
    send(res, outcome.error ? 403 : 200, outcome);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/message') {
    const actionRole = selectActionRole('agent.prompt.run');
    if (!actionRole) { denyButton('agent.prompt.run'); return true; }
    const normalized = normalizeAgentMessageBody(await readBody(req));
    if (!normalized.ok) { send(res, 400, normalized.error); return true; }
    const input = normalized.input;
    const conversationId = String(input.conversationId || '').trim();
    const context = conversationId ? await getAgentConversationContext(conversationId, agentIdentity, effectiveAccess, input.text || '') : null;
    if (conversationId && !context) { send(res, 404, { message: '智脑任务不存在、已归档或不属于当前用户。', code: 'AGENT_CONVERSATION_NOT_FOUND' }); return true; }
    const result = await runPrivateAgent(input, actionRole, agentIdentity, {
      resolveCommandRole: () => resolveCommandRole(role, agentIdentity),
      requestId: res.requestId,
      platform: agentIdentity.platform,
      conversationContext: context
    });
    const conversation = conversationId ? await recordAgentConversationExchange({
      conversationId,
      identityScope: agentIdentity,
      roleId: actionRole.id,
      accessContext: effectiveAccess,
      userText: String(input.text || ''),
      response: result
    }) : null;
    send(res, 200, { ...result, ...(conversation ? { conversation, contextUsage: conversation.context } : {}) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/execute') {
    const body = await readBody(req);
    if (!selectActionRole('agent.command.execute')) {
      const evidenceTrace = await createDeniedAgentExecutionTrace({ roleId: role, identityScope: agentIdentity, runId: body.runId, commandId: body.commandId, reason: '当前有效权限未授予 agent.command.execute。', requestId: res.requestId });
      send(res, 403, { message: '当前有效权限未授予按钮操作：agent.command.execute。', code: 'BUTTON_PERMISSION_DENIED', traceId: evidenceTrace.id, evidenceTrace });
      return true;
    }
    const origin = await getAgentRunOriginContext(body.runId, agentIdentity);
    if (!origin || !effectiveAccess.roleIds.includes(origin.roleId) || !hasButtonPermission(origin.roleId, 'agent.command.execute')) {
      const evidenceTrace = await createDeniedAgentExecutionTrace({ roleId: role, identityScope: agentIdentity, runId: body.runId, commandId: body.commandId, reason: '原任务角色已失效、权限已撤销或任务不属于当前用户。', requestId: res.requestId });
      send(res, 403, { message: '智脑无法执行该动作：原任务角色已失效、权限已撤销或任务不属于当前用户。', code: 'AGENT_ORIGIN_ROLE_DENIED', traceId: evidenceTrace.id, evidenceTrace });
      return true;
    }
    const outcome = await executePrivateAgentCommand(body.commandId, getRole(origin.roleId), body.runId, body.confirmationToken, agentIdentity, { conversationId: body.conversationId || null });
    const errorStatus = String(outcome.code || '').startsWith('KMS_') ? 503 : 403;
    const conversation = !outcome.error && body.conversationId
      ? await recordAgentConversationTaskOutcome({ conversationId: String(body.conversationId), identityScope: agentIdentity, accessContext: effectiveAccess, response: outcome })
      : null;
    send(res, outcome.error ? errorStatus : 200, outcome.error ? { ...outcome, message: outcome.error } : { ...outcome, ...(conversation ? { conversation } : {}) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/cancel') {
    const body = await readBody(req);
    const origin = await getAgentRunOriginContext(body.runId, agentIdentity);
    if (!origin || !effectiveAccess.roleIds.includes(origin.roleId)) {
      send(res, 403, { message: '智脑无法撤回该动作：原任务角色已失效或任务不属于当前用户。', code: 'AGENT_ORIGIN_ROLE_DENIED' });
      return true;
    }
    const outcome = await cancelPrivateAgentCommand(getRole(origin.roleId), body.runId, agentIdentity);
    const conversation = !outcome.error && body.conversationId
      ? await recordAgentConversationTaskOutcome({ conversationId: String(body.conversationId), identityScope: agentIdentity, accessContext: effectiveAccess, response: outcome })
      : null;
    send(res, outcome.error ? 403 : 200, outcome.error ? { ...outcome, message: outcome.error } : { ...outcome, ...(conversation ? { conversation } : {}) });
    return true;
  }
  const runtimeTaskMatch = url.pathname.match(/^\/api\/agent\/runtime-tasks\/([^/]+)\/(pause|resume|cancel|claim)$/);
  if (runtimeTaskMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(runtimeTaskMatch[1]);
    const action = runtimeTaskMatch[2];
    const task = await getAgentLongTask(taskId);
    const origin = task ? await getAgentRunOriginContext(task.runId, agentIdentity) : null;
    if (!task || !origin || task.roleId !== origin.roleId || !effectiveAccess.roleIds.includes(origin.roleId)) {
      send(res, 403, { message: '未找到当前用户可控制的长任务。', code: 'AGENT_LONG_TASK_ORIGIN_DENIED' });
      return true;
    }
    if (action === 'claim') {
      if (!hasButtonPermission(origin.roleId, 'agent.command.execute')) {
        send(res, 403, { message: '原任务角色已失去端侧执行权限。', code: 'AGENT_ORIGIN_ROLE_DENIED' });
        return true;
      }
      const outcome = await claimPrivateAgentLongTask({ taskId, role: getRole(origin.roleId), identityScope: agentIdentity });
      send(res, outcome.error ? 409 : 200, outcome.error ? { ...outcome, message: outcome.error } : outcome);
      return true;
    }
    const operation = action === 'pause' ? pauseAgentLongTask : action === 'resume' ? resumeAgentLongTask : cancelAgentLongTask;
    const outcome = await operation({ taskId, roleId: origin.roleId, identityScope: agentIdentity });
    send(res, outcome.error ? 409 : 200, outcome.error ? { ...outcome, message: outcome.error } : outcome);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/desktop-receipt') {
    const body = await readBody(req);
    const origin = await getAgentRunOriginContext(body.runId, agentIdentity);
    if (!origin || !effectiveAccess.roleIds.includes(origin.roleId) || !hasButtonPermission(origin.roleId, 'agent.command.execute')) {
      send(res, 403, { message: '智脑无法接收端侧回执：原任务角色已失效、权限已撤销或任务不属于当前用户。', code: 'AGENT_ORIGIN_ROLE_DENIED' });
      return true;
    }
    const outcome = await completePrivateAgentDesktopExecution({
      role: getRole(origin.roleId),
      runId: body.runId,
      commandId: body.commandId,
      dispatchId: body.dispatchId,
      receipt: body.receipt,
      identityScope: agentIdentity
    });
    const conversation = !outcome.error && outcome.runtimeTask?.conversationId
      ? await recordAgentConversationTaskOutcome({ conversationId: outcome.runtimeTask.conversationId, identityScope: agentIdentity, accessContext: effectiveAccess, response: outcome })
      : null;
    send(res, outcome.error ? 403 : 200, outcome.error ? { ...outcome, message: outcome.error } : { ...outcome, ...(conversation ? { conversation } : {}) });
    return true;
  }
  return false;
}

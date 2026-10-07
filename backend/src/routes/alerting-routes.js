import {
  getAlertingWorkspaceForAccess,
  getNotifications,
  recordVoiceCallEvent,
  saveAlertingConfiguration,
  simulateAlert,
  subscribeNotificationChannel,
  testVoiceCall
} from '../domains/alerting/public-api.js';

const actorFor = (role, identity) => ({ type: 'user', roleId: role.id, subjectId: identity.subjectId || 'unknown', tenantId: identity.tenantId || 'demo-enterprise' });

export async function handleAlertingRoutes({ req, res, url, role, agentIdentity, selectActionRole, denyButton, readBody, send }) {
  if (req.method === 'GET' && url.pathname === '/api/notifications') {
    send(res, 200, await getNotifications(role, agentIdentity));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/notifications/subscriptions') {
    const result = subscribeNotificationChannel(await readBody(req), role);
    send(res, result.error ? 400 : 200, result);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/alerting/workspace') {
    send(res, 200, await getAlertingWorkspaceForAccess(role, agentIdentity));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/alerting/configuration') {
    const body = await readBody(req);
    const requiredPermissions = [
      ...(body.severityLevels !== undefined || body.voiceProviders !== undefined || body.escalationPolicies !== undefined || body.contactPoints !== undefined ? ['notification.policy.publish'] : []),
      ...(body.onCallSchedules !== undefined ? ['oncall.schedule.manage'] : [])
    ];
    let actionRole = null;
    for (const permission of requiredPermissions) {
      actionRole = selectActionRole(permission);
      if (!actionRole) { denyButton(permission); return true; }
    }
    if (!actionRole) { denyButton('notification.policy.publish'); return true; }
    const result = await saveAlertingConfiguration(body, actorFor(actionRole, agentIdentity));
    if (result.error) send(res, result.code === 'VERSION_CONFLICT' ? 409 : 400, { message: result.error, ...result });
    else send(res, 200, { ...result, workspace: await getAlertingWorkspaceForAccess(role, agentIdentity) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/alerting/simulations') {
    const actionRole = selectActionRole('notification.route.simulate');
    if (!actionRole) { denyButton('notification.route.simulate'); return true; }
    const result = await simulateAlert(await readBody(req), actorFor(actionRole, agentIdentity));
    if (result.error) send(res, 400, { message: result.error, ...result });
    else send(res, 200, { ...result, workspace: await getAlertingWorkspaceForAccess(role, agentIdentity) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/alerting/voice/test') {
    const actionRole = selectActionRole('notification.voice.test');
    if (!actionRole) { denyButton('notification.voice.test'); return true; }
    const result = await testVoiceCall(await readBody(req), actorFor(actionRole, agentIdentity));
    if (result.error) send(res, 400, { message: result.error, ...result });
    else send(res, 200, { ...result, workspace: await getAlertingWorkspaceForAccess(role, agentIdentity) });
    return true;
  }
  const callEventMatch = url.pathname.match(/^\/api\/alerting\/voice-calls\/([^/]+)\/events$/);
  if (req.method === 'POST' && callEventMatch) {
    const actionRole = selectActionRole('notification.voice.test');
    if (!actionRole) { denyButton('notification.voice.test'); return true; }
    const visibleCall = (await getAlertingWorkspaceForAccess(role, agentIdentity)).voiceCalls.find((item) => item.id === callEventMatch[1]);
    if (!visibleCall) { send(res, 404, { message: '未找到当前组织范围内的电话记录。', code: 'VOICE_CALL_NOT_FOUND' }); return true; }
    const body = await readBody(req);
    const result = await recordVoiceCallEvent(callEventMatch[1], body.action, actorFor(actionRole, agentIdentity));
    if (result.error) send(res, 400, { message: result.error, ...result });
    else send(res, 200, { ...result, workspace: await getAlertingWorkspaceForAccess(role, agentIdentity) });
    return true;
  }
  return false;
}

export function createAdministrationActions({ api, refs, loadedPages, captureRequestAccess, canCommitRequest, runAccessGuarded, refreshPermissionWorkspace }) {
  const { effectiveAccess, permissionSaving, permissionMessage, alertingSaving, alertingMessage, alertingWorkspace, notifications } = refs;

  async function assignPermissionUser(payload) {
    if (permissionSaving.value) return;
    const snapshot = captureRequestAccess();
    permissionSaving.value = true;
    permissionMessage.value = '';
    try {
      const { userId, ...body } = payload;
      const response = await api.assignPermissionUser(userId, body, snapshot.roleId);
      if (!canCommitRequest(snapshot)) return;
      permissionMessage.value = response.message || '人员组织与角色分配已保存，新的有效权限已立即生效。';
      permissionSaving.value = false;
      await refreshPermissionWorkspace(response);
    } catch (err) {
      if (canCommitRequest(snapshot)) permissionMessage.value = err.message || '人员角色分配保存失败。';
    } finally {
      if (canCommitRequest(snapshot)) permissionSaving.value = false;
    }
  }

  async function savePermissionPolicy(payload) {
    if (permissionSaving.value) return;
    const snapshot = captureRequestAccess();
    permissionSaving.value = true;
    permissionMessage.value = '';
    try {
      const { roleId, ...body } = payload;
      const response = await api.savePermissionPolicy(roleId, body, snapshot.roleId);
      if (!canCommitRequest(snapshot)) return;
      permissionMessage.value = response.message || '角色菜单、按钮与组织数据权限已保存并完成审计。';
      permissionSaving.value = false;
      await refreshPermissionWorkspace(response);
    } catch (err) {
      if (canCommitRequest(snapshot)) permissionMessage.value = err.message || '角色权限策略保存失败。';
    } finally {
      if (canCommitRequest(snapshot)) permissionSaving.value = false;
    }
  }

  async function runAlertingMutation(operation, successMessage) {
    if (alertingSaving.value) return;
    alertingSaving.value = true;
    alertingMessage.value = '';
    const completed = await runAccessGuarded(
      async (role) => ({ response: await operation(role), notificationsValue: await api.notifications(role) }),
      ({ response, notificationsValue }) => {
        alertingWorkspace.value = response.workspace || alertingWorkspace.value;
        notifications.value = notificationsValue;
        alertingMessage.value = response.message || successMessage;
        loadedPages.add('channels');
      },
      (err) => { alertingMessage.value = err.message || '告警编排操作失败。'; }
    );
    if (completed || effectiveAccess.value) alertingSaving.value = false;
  }

  const saveAlertingConfiguration = (payload) => runAlertingMutation((role) => api.saveAlertingConfiguration(payload, role), '告警与虚拟电话策略已发布。');
  const simulateAlertRoute = (payload) => runAlertingMutation((role) => api.simulateAlertRoute(payload, role), '模拟告警已完成分级、路由与自动外呼。');
  const testAlertVoice = (payload) => runAlertingMutation((role) => api.testVoiceCall(payload, role), 'Mock 测试电话已完成。');
  const recordAlertVoiceEvent = (payload) => runAlertingMutation((role) => api.recordVoiceCallEvent(payload.id, payload.action, role), '电话回执已写入审计链。');

  return { assignPermissionUser, savePermissionPolicy, saveAlertingConfiguration, simulateAlertRoute, testAlertVoice, recordAlertVoiceEvent };
}

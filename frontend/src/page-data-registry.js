export async function fetchPageData({ pageId, activeRole, api }) {
  if (pageId === 'dashboard') {
    const [dashboardValue, notificationsValue, systemsValue] = await Promise.all([api.dashboard(activeRole), api.notifications(activeRole), api.systems(activeRole)]);
    return { dashboardValue, notificationsValue, systemsValue };
  }
  if (pageId === 'risks') return { risksValue: await api.risks(activeRole) };
  if (pageId === 'intelligence') {
    const [platformValue, systemsValue, notificationsValue, risksValue] = await Promise.all([api.platformStatus(activeRole), api.systems(activeRole), api.notifications(activeRole), api.risks(activeRole)]);
    return { platformValue, systemsValue, notificationsValue, risksValue };
  }
  if (pageId === 'agent') {
    const [agentRuntimeValue, agentToolsValue, agentRunsValue, agentSkillsValue, agentConnectorsValue, agentOperationsValue, agentWorkItemsValue, agentEvaluationsValue] = await Promise.all([
      api.agentRuntime(activeRole), api.agentTools(activeRole), api.agentRuns(activeRole), api.agentSkills(activeRole),
      api.agentConnectors(activeRole), api.agentOperations(activeRole), api.agentWorkItems(activeRole), api.agentEvaluations(activeRole)
    ]);
    return { agentRuntimeValue, agentToolsValue, agentRunsValue, agentSkillsValue, agentConnectorsValue, agentOperationsValue, agentWorkItemsValue, agentEvaluationsValue };
  }
  if (pageId === 'channels') {
    const [notificationsValue, alertingWorkspaceValue] = await Promise.all([api.notifications(activeRole), api.alertingWorkspace(activeRole)]);
    return { notificationsValue, alertingWorkspaceValue };
  }
  if (pageId === 'procurement') return { procurementValue: await api.procurementScenario(activeRole) };
  if (pageId === 'permissions') return { permissionWorkspaceValue: await api.permissionManagement(activeRole) };
  if (pageId === 'config') {
    // 2026-09-25 阶段 2：config 页已不再承载系统接入与元模型连接模板，
    // 因此不再拉取 worldTemplates / worldConnectionTargets / worldDrafts。
    const [configurationValue, agentModelConfigValue, simulationValue, accountCenterValue, permissionCenterValue, keyCenterValue] = await Promise.all([
      api.configurations(activeRole), api.agentModelConfig(activeRole), api.simulationOverview(activeRole), api.accountCenter(activeRole), api.permissionCenter(activeRole), api.keyCenter(activeRole)
    ]);
    return { configurationValue, agentModelConfigValue, simulationValue, accountCenterValue, permissionCenterValue, keyCenterValue };
  }
  throw new Error('未知页面，无法加载数据。');
}

export function applyPageData({ pageId, data, state, unwrapPermissionWorkspace }) {
  const set = (key, value) => { state[key].value = value; };
  if (pageId === 'dashboard') {
    set('dashboard', data.dashboardValue); set('notifications', data.notificationsValue); set('systems', data.systemsValue);
  } else if (pageId === 'risks') {
    set('risks', data.risksValue);
  } else if (pageId === 'intelligence') {
    set('platform', data.platformValue); set('systems', data.systemsValue); set('notifications', data.notificationsValue); set('risks', data.risksValue);
  } else if (pageId === 'agent') {
    set('agentRuntime', data.agentRuntimeValue); set('agentTools', data.agentToolsValue); set('agentRuns', data.agentRunsValue); set('agentSkills', data.agentSkillsValue);
    set('agentConnectors', data.agentConnectorsValue); set('agentOperations', data.agentOperationsValue); set('agentWorkItems', data.agentWorkItemsValue); set('agentEvaluations', data.agentEvaluationsValue);
  } else if (pageId === 'channels') {
    set('notifications', data.notificationsValue); set('alertingWorkspace', data.alertingWorkspaceValue);
  } else if (pageId === 'procurement') {
    set('procurement', data.procurementValue);
  } else if (pageId === 'permissions') {
    const workspace = unwrapPermissionWorkspace(data.permissionWorkspaceValue);
    if (!workspace) throw new Error('权限管理接口返回的数据结构无效。');
    set('permissionWorkspace', workspace);
  } else if (pageId === 'config') {
    set('configuration', data.configurationValue); set('agentModelConfig', data.agentModelConfigValue); set('simulation', data.simulationValue);
    set('accountCenter', data.accountCenterValue);
    set('permissionCenter', data.permissionCenterValue); set('keyCenter', data.keyCenterValue);
  }
}

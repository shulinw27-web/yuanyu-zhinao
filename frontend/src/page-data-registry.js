export async function fetchPageData({ pageId, activeRole, effectiveAccess, api, canAccessPage }) {
  if (pageId === 'dashboard') {
    const [dashboardValue, notificationsValue, systemsValue] = await Promise.all([api.dashboard(activeRole), api.notifications(activeRole), api.systems(activeRole)]);
    return { dashboardValue, notificationsValue, systemsValue };
  }
  if (pageId === 'risks') return { risksValue: await api.risks(activeRole) };
  if (pageId === 'intelligence') {
    const [platformValue, systemsValue, notificationsValue, risksValue] = await Promise.all([api.platformStatus(activeRole), api.systems(activeRole), api.notifications(activeRole), api.risks(activeRole)]);
    return { platformValue, systemsValue, notificationsValue, risksValue };
  }
  if (pageId === 'world') {
    const [worldValue, accessValue, semanticContextValue, coreMetaObjectsValue, metaModelsValue, oaMetaSimulationValue, oaMetaDraftValue, oaMetaAuthoringProfileValue] = await Promise.all([
      api.world(activeRole), api.access(activeRole), api.semanticContext(activeRole), api.coreMetaObjects(activeRole), api.metaModels(activeRole),
      api.oaMetaModelSimulation(activeRole), api.oaMetaModelDraft(activeRole), api.oaMetaModelAuthoringProfile(activeRole)
    ]);
    return { worldValue, accessValue, semanticContextValue, coreMetaObjectsValue, metaModelsValue, oaMetaSimulationValue, oaMetaDraftValue, oaMetaAuthoringProfileValue };
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
    const worldModelRequest = canAccessPage('world', effectiveAccess)
      ? Promise.all([api.worldTemplates(activeRole), api.worldConnectionTargets(activeRole), api.worldDrafts(activeRole)])
      : Promise.resolve([[], [], []]);
    const [configurationValue, agentModelConfigValue, simulationValue, accountCenterValue, permissionCenterValue, keyCenterValue, worldModelValues] = await Promise.all([
      api.configurations(activeRole), api.agentModelConfig(activeRole), api.simulationOverview(activeRole), api.accountCenter(activeRole), api.permissionCenter(activeRole), api.keyCenter(activeRole), worldModelRequest
    ]);
    const [worldTemplatesValue, worldTargetsValue, worldDraftsValue] = worldModelValues;
    return { configurationValue, agentModelConfigValue, simulationValue, worldTemplatesValue, worldTargetsValue, worldDraftsValue, accountCenterValue, permissionCenterValue, keyCenterValue };
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
  } else if (pageId === 'world') {
    set('world', data.worldValue); set('access', data.accessValue); set('semanticContext', data.semanticContextValue);
    set('coreMetaObjects', data.coreMetaObjectsValue); set('metaModels', data.metaModelsValue); set('oaMetaSimulation', data.oaMetaSimulationValue);
    set('oaMetaDraft', data.oaMetaDraftValue); set('oaMetaAuthoringProfile', data.oaMetaAuthoringProfileValue);
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
    set('worldTemplates', data.worldTemplatesValue);
    set('worldTargets', data.worldTargetsValue); set('worldDrafts', data.worldDraftsValue); set('accountCenter', data.accountCenterValue);
    set('permissionCenter', data.permissionCenterValue); set('keyCenter', data.keyCenterValue);
  }
}

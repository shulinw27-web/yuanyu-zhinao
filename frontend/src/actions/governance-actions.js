import { semanticSimulationMessage } from '@healthcare-ai/agent-ui/ontology-scenario';

// 2026-09-25 阶段 2：世界模型映射草稿的三个动作已从管理 Web 移除。
// 「元模型连接模板 / 映射草稿」的入口迁到元域智营端系统接入视图，
// 后端端点保留一个版本周期；本页不再持有相关状态，避免出现无人使用的死状态。

export function createGovernanceActions({ api, refs, runAccessGuarded }) {
  const {
    metaModels, oaMetaSimulation, metaModelMessage, oaMetaDraft,
    agentModelConfig, modelConfigMessage, simulation, simulationMessage, keyCenterMessage, keyCenter
  } = refs;

  const guarded = (operation, commit, messageRef) => runAccessGuarded(operation, commit, (err) => { messageRef.value = err.message; });

  const simulateOAMetaModel = () => guarded(
    async (role) => ({ response: await api.simulateBuildOAMetaModel(role), models: await api.metaModels(role) }),
    ({ response, models }) => {
      metaModels.value = models;
      oaMetaSimulation.value = { ...response.simulation, semanticValidation: response.semanticValidation };
      metaModelMessage.value = semanticSimulationMessage(response);
    }, metaModelMessage
  );
  const publishOAMetaModel = () => guarded(
    async (role) => ({ response: await api.publishOAMetaModel(role), models: await api.metaModels(role) }),
    ({ response, models }) => { metaModels.value = models; oaMetaSimulation.value = { ...response.simulation, semanticDeployment: response.semanticDeployment }; metaModelMessage.value = `OA 元模型版本 ${response.simulation.version} 已发布并登记到 Semantica（Demo 模拟，未写入真实 OA）。`; }, metaModelMessage
  );
  const saveOAMetaDraft = (payload) => guarded(
    async (role) => ({ response: await api.saveOAMetaModelDraft(payload, role), models: await api.metaModels(role) }),
    ({ response, models }) => { oaMetaDraft.value = response.draft; metaModels.value = models; metaModelMessage.value = '业务建模草稿已保存。可继续编辑关系与字段，随后执行校验。'; }, metaModelMessage
  );
  const validateOAMetaDraft = () => guarded(
    async (role) => ({ response: await api.validateOAMetaModelDraft(role), models: await api.metaModels(role) }),
    ({ response, models }) => { oaMetaDraft.value = response.draft; metaModels.value = models; metaModelMessage.value = response.draft.validation.status === 'passed' ? '草稿校验通过，业务人员可提交模拟构建；管理层可在模拟验证后发布。' : '草稿仍有需要修正的项目，请按校验结果补充对象、关系或审批控制。'; }, metaModelMessage
  );
  const saveAgentModelConfig = (payload) => guarded(
    (role) => api.saveAgentModelConfig(payload, role),
    (response) => { agentModelConfig.value = response.configuration; modelConfigMessage.value = '模型连接已更新。密钥只存在于当前 API 进程内存，服务重启后需要重新配置。'; }, modelConfigMessage
  );
  const runSimulationScenario = (id) => guarded(
    (role) => api.runSimulationScenario(id, role),
    (response) => {
      simulation.value = response.overview;
      simulationMessage.value = response.semanticValidation?.status === 'verified'
        ? `${response.run.scenarioName} 已启动，已创建模拟 OA 审批 ${response.approval.id}；Semantica 已完成 ${response.semanticValidation.run?.facts || 0} 条合成事实入图与溯源校验。`
        : `${response.run.scenarioName} 已启动，并创建模拟 OA 审批 ${response.approval.id}；Semantica 尚未完成验证：${response.semanticValidation?.detail || '请检查本机语义服务。'}`;
    }, simulationMessage
  );
  const decideSimulationApproval = (payload) => guarded(
    (role) => api.decideSimulationApproval(payload.id, payload.decision, role),
    (response) => {
      simulation.value = response.overview;
      const semantic = response.semanticValidation?.status === 'verified' ? 'Semantica 已按审批结果复校验。' : 'Semantica 未完成审批后复校验。';
      simulationMessage.value = payload.decision === 'approved' ? `模拟审批已通过，QMS CAPA 草稿已写入运行时事件流；${semantic}` : `模拟审批已驳回；未执行模拟写回；${semantic}`;
    }, simulationMessage
  );
  const setSimulationConnectorFault = (payload) => guarded(
    (role) => api.setSimulationConnectorFault(payload.systemId, payload.faultId, role),
    (response) => { simulation.value = response.overview; simulationMessage.value = response.unchanged ? `${payload.systemId.toUpperCase()} Connector 已处于该状态。` : `${payload.systemId.toUpperCase()} Connector 已切换为「${response.connector.faultName}」，智脑检索将同步带出健康状态。`; }, simulationMessage
  );
  const resetSimulation = () => guarded(
    (role) => api.resetSimulation(role),
    (response) => { simulation.value = response.overview; simulationMessage.value = response.semanticValidation?.status === 'reset' ? '模拟运行时与 Semantica Demo 图已重置；基础种子数据保持不变。' : '模拟运行时已重置；Semantica 图未确认重置。'; }, simulationMessage
  );
  const rotateKeyPolicy = (id) => guarded(
    async (role) => ({ response: await api.rotateKeyPolicy(id, role), overview: await api.keyCenter(role) }),
    ({ response, overview }) => { keyCenterMessage.value = `密钥策略 ${response.policy.id} 已轮换至 v${response.policy.version}；未向浏览器暴露密钥材料。`; keyCenter.value = overview; }, keyCenterMessage
  );
  const revokeKeyLease = (id) => guarded(
    async (role) => ({ response: await api.revokeKeyLease(id, role), overview: await api.keyCenter(role) }),
    ({ response, overview }) => { keyCenterMessage.value = response.unchanged ? '该密钥租约已失效，无需重复吊销。' : `租约 ${response.lease.id} 已吊销。`; keyCenter.value = overview; }, keyCenterMessage
  );

  return { simulateOAMetaModel, publishOAMetaModel, saveOAMetaDraft, validateOAMetaDraft, saveAgentModelConfig, runSimulationScenario, decideSimulationApproval, setSimulationConnectorFault, resetSimulation, rotateKeyPolicy, revokeKeyLease };
}

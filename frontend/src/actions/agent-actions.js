export function createAgentActions({ api, refs, captureRequestAccess, canCommitRequest, canAccessPage }) {
  const { effectiveAccess, agentRuns, agentOperations, agentWorkItems, assistantMessages, agentEvaluations, procurement, error } = refs;

  async function refreshAgentActivity() {
    if (!canAccessPage('agent', effectiveAccess.value)) return;
    const snapshot = captureRequestAccess();
    const [runs, operations, workItems] = await Promise.all([
      api.agentRuns(snapshot.roleId), api.agentOperations(snapshot.roleId), api.agentWorkItems(snapshot.roleId)
    ]);
    if (!canCommitRequest(snapshot) || !canAccessPage('agent', effectiveAccess.value)) return;
    agentRuns.value = runs;
    agentOperations.value = operations;
    agentWorkItems.value = workItems;
  }

  async function sendAssistant(text) {
    const snapshot = captureRequestAccess();
    assistantMessages.value.push({ role: 'user', text });
    try {
      const response = await api.agentMessage(text, snapshot.roleId);
      if (!canCommitRequest(snapshot)) return;
      assistantMessages.value.push({ role: 'assistant', text: response.text, citations: (response.evidence || []).map((item) => item.source), command: response.command, plan: response.plan, agent: response.agent, runId: response.runId, route: response.route });
      await refreshAgentActivity();
    } catch (err) {
      if (canCommitRequest(snapshot)) assistantMessages.value.push({ role: 'assistant', text: err.message || '私有 Agent 暂时无法响应，请稍后重试。', citations: [] });
    }
  }

  async function executeAssistant(commandId, runId, confirmationToken) {
    const snapshot = captureRequestAccess();
    try {
      const response = await api.agentExecute(commandId, snapshot.roleId, runId, confirmationToken);
      if (!canCommitRequest(snapshot)) return;
      if (response.result) procurement.value = response.result;
      const confirmed = assistantMessages.value.find((item) => item.runId === runId && item.command);
      if (confirmed) confirmed.command = null;
      assistantMessages.value.push({ role: 'assistant', text: response.text, citations: (response.evidence || []).map((item) => item.source), agent: response.agent, runId: response.run?.id });
      await refreshAgentActivity();
    } catch (err) {
      if (canCommitRequest(snapshot)) assistantMessages.value.push({ role: 'assistant', text: err.message || '当前动作无法执行。', citations: [] });
    }
  }

  async function runAgentEvaluations() {
    const snapshot = captureRequestAccess();
    try {
      const response = await api.runAgentEvaluations(snapshot.roleId);
      if (!canCommitRequest(snapshot)) return;
      agentEvaluations.value = response.overview;
      await refreshAgentActivity();
    } catch (err) {
      if (canCommitRequest(snapshot)) error.value = err.message;
    }
  }

  return { refreshAgentActivity, sendAssistant, executeAssistant, runAgentEvaluations };
}


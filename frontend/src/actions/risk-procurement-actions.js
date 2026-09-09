export function createRiskProcurementActions({ api, refs, buttonPermissionIds, captureRequestAccess, canCommitRequest, loadPage }) {
  const { page, access, selectedRisk, message, procurementMessage, procurement, error } = refs;

  async function chooseRisk(risk) {
    if (!buttonPermissionIds.value.includes('risk.detail.view')) return;
    const snapshot = captureRequestAccess();
    try {
      message.value = '';
      const [riskValue, accessValue] = await Promise.all([
        api.risk(risk.id, snapshot.roleId),
        access.value ? Promise.resolve(access.value) : api.access(snapshot.roleId)
      ]);
      if (!canCommitRequest(snapshot)) return;
      selectedRisk.value = riskValue;
      access.value = accessValue;
    } catch (err) {
      if (canCommitRequest(snapshot)) error.value = err.message;
    }
  }

  async function act(type) {
    if (!selectedRisk.value) return;
    const permissionId = type === 'acknowledge' ? 'risk.acknowledge' : 'risk.approve';
    if (!buttonPermissionIds.value.includes(permissionId)) return;
    const snapshot = captureRequestAccess();
    const riskId = selectedRisk.value.id;
    try {
      const result = type === 'acknowledge' ? await api.acknowledge(riskId, snapshot.roleId) : await api.approve(riskId, snapshot.roleId);
      if (!canCommitRequest(snapshot)) return;
      selectedRisk.value = result;
      message.value = type === 'acknowledge' ? '风险已确认并进入处置流程；审计已回写。' : '冻结建议已审批；Demo 未调用真实生产系统。';
      await loadPage(page.value, { force: true });
    } catch (err) {
      if (canCommitRequest(snapshot)) message.value = err.message;
    }
  }

  async function executeProcurement(action) {
    const permissionId = action === 'launch' ? 'procurement.launch' : 'procurement.approve';
    if (!buttonPermissionIds.value.includes(permissionId)) {
      procurementMessage.value = '当前有效策略未授予此采购节点的操作权限。';
      return;
    }
    const snapshot = captureRequestAccess();
    try {
      const result = action === 'launch' ? await api.launchProcurement(snapshot.roleId) : await api.approveProcurement(snapshot.roleId);
      if (!canCommitRequest(snapshot)) return;
      procurement.value = result;
      procurementMessage.value = action === 'launch'
        ? '采购协同已发起：ERP 草稿申请已创建，并已路由采购、质量和财务审批。'
        : '审批完成：ERP 采购申请已提交，供应商与质量检验计划通知已受控发送。';
    } catch (err) {
      if (canCommitRequest(snapshot)) procurementMessage.value = err.message;
    }
  }

  return { chooseRisk, act, executeProcurement };
}


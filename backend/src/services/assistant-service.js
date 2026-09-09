import { getProcurementScenario, launchProcurement } from './procurement-service.js';

const permissionByRole = {
  executive: '可查看跨域汇总、确认采购协同与审批高风险动作',
  quality_manager: '可查看质量证据、发起采购协同并参与质量审批',
  production_manager: '可发起生产原料需求与采购协同，不能批准采购',
  marketing_manager: '仅可查看脱敏的订单与市场影响，不能发起生产采购'
};

export async function processAssistantMessage(text, role) {
  const normalized = (text || '').trim();
  const isProcurement = /采购|购买|原料|维生素\s*c|vc/i.test(normalized);
  const isStatus = /状态|进度|风险|监控/i.test(normalized);
  if (!normalized) return { text: '请告诉我需要处理的业务，例如：“采购 500kg 维生素 C，8 月 10 日前到货”。', citations: [], command: null };
  if (isProcurement) {
    const scenario = await getProcurementScenario();
    const canLaunch = ['executive', 'quality_manager', 'production_manager'].includes(role.id);
    return {
      text: canLaunch ? `我已完成采购预检：${scenario.intent.material} 建议采购 ${scenario.demand.shortage}${scenario.intent.unit}，推荐 ${scenario.suppliers[0].name}。预计金额 ¥${scenario.policy.estimatedAmount.toLocaleString()}，将经过采购、质量、财务审批。` : '当前角色无权发起生产原料采购。我可以展示脱敏影响与建议，但不能创建采购申请。',
      citations: ['MES 生产计划', 'ERP 库存与预算', 'LIMS 质量规格', 'QMS 供应商资质'],
      command: canLaunch ? { id: 'launch_procurement', label: '确认发起采购协同', requiresConfirmation: true, impact: '创建 ERP 草稿采购申请，并发起多角色审批。' } : null
    };
  }
  if (isStatus) return { text: '当前世界模型与 7×24 监控均在线；1 个 P0 风险待确认，ERP 库存分配事件存在 6 分钟延迟。', citations: ['智能中枢', 'RiskCase RC-2026-0042', 'ERP 事件流'], command: null };
  return { text: `我理解你的请求：“${normalized}”。我会先在你当前授权范围内检索世界模型、检查流程模板与可执行动作，再给出需要你确认的行动方案。`, citations: [permissionByRole[role.id]], command: null };
}

export async function executeAssistantCommand(commandId, role) {
  if (commandId !== 'launch_procurement') return { error: '未知或不可执行的助手动作。' };
  const result = await launchProcurement(role);
  if (result.error) return result;
  return { result, text: `已受控发起采购协同：${result.execution.requisitionId} 已创建为 ERP 草稿，正在等待审批。`, citations: ['审批中心', 'ERP 草稿采购申请', '审计日志'] };
}

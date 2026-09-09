export const initialOrganizations = [
  { id: 'org-group', code: 'GROUP', name: '元域健康集团', type: 'group', parentId: null, status: 'active', sortOrder: 10 },
  { id: 'org-governance-center', code: 'GOV-CENTER', name: '数字化与治理中心', type: 'center', parentId: 'org-group', status: 'active', sortOrder: 20 },
  { id: 'org-production-center', code: 'PROD-CENTER', name: '生产运营中心', type: 'center', parentId: 'org-group', status: 'active', sortOrder: 30 },
  { id: 'org-quality-center', code: 'QA-CENTER', name: '质量与合规中心', type: 'center', parentId: 'org-group', status: 'active', sortOrder: 40 },
  { id: 'org-supply-center', code: 'SUPPLY-CENTER', name: '采购与供应链中心', type: 'center', parentId: 'org-group', status: 'active', sortOrder: 50 },
  { id: 'org-market-center', code: 'MARKET-CENTER', name: '市场运营中心', type: 'center', parentId: 'org-group', status: 'active', sortOrder: 60 },
  { id: 'org-governance-dept', code: 'GOV-DIGITAL', name: '数字化治理部', type: 'department', parentId: 'org-governance-center', status: 'active', sortOrder: 21 },
  { id: 'org-production-factory-sh', code: 'FACTORY-SH', name: '上海生产工厂', type: 'factory', parentId: 'org-production-center', status: 'active', sortOrder: 31 },
  { id: 'org-quality-dept', code: 'QA-DEPT', name: '质量管理部', type: 'department', parentId: 'org-quality-center', status: 'active', sortOrder: 41 },
  { id: 'org-procurement-dept', code: 'PROC-DEPT', name: '采购管理部', type: 'department', parentId: 'org-supply-center', status: 'active', sortOrder: 51 },
  { id: 'org-market-dept', code: 'MARKET-DEPT', name: '市场运营部', type: 'department', parentId: 'org-market-center', status: 'active', sortOrder: 61 }
];

export const initialUsers = [
  { id: 'usr-001', account: 'admin@demo.local', name: '平台管理员', title: '平台治理负责人', department: '数字化治理部', orgUnitId: 'org-governance-dept', roleIds: ['executive'], primaryRoleId: 'executive', status: 'active', sources: ['local', 'oa'], version: 1 },
  { id: 'usr-002', account: 'production@demo.local', name: '生产负责人', title: '生产运营负责人', department: '上海生产工厂', orgUnitId: 'org-production-factory-sh', roleIds: ['production_manager'], primaryRoleId: 'production_manager', status: 'active', sources: ['local'], version: 1 },
  { id: 'usr-003', account: 'quality@demo.local', name: '质量经理', title: '质量管理经理', department: '质量管理部', orgUnitId: 'org-quality-dept', roleIds: ['quality_manager'], primaryRoleId: 'quality_manager', status: 'active', sources: ['local', 'oa'], version: 1 },
  { id: 'usr-004', account: 'procurement@demo.local', name: '采购负责人', title: '采购管理负责人', department: '采购管理部', orgUnitId: 'org-procurement-dept', roleIds: ['procurement_manager'], primaryRoleId: 'procurement_manager', status: 'active', sources: ['local', 'oa'], version: 1 },
  { id: 'usr-005', account: 'market@demo.local', name: '市场负责人', title: '市场运营负责人', department: '市场运营部', orgUnitId: 'org-market-dept', roleIds: ['marketing_manager'], primaryRoleId: 'marketing_manager', status: 'active', sources: ['local'], version: 1 }
];

export const permissionCatalog = [
  {
    id: 'menu.dashboard', menuId: 'dashboard', name: '运营总览', pagePermissionId: 'page.dashboard.view', description: '全局态势与业务接入',
    buttons: [
      { id: 'dashboard.refresh', name: '刷新总览', risk: 'low' },
      { id: 'dashboard.export', name: '导出摘要', risk: 'medium' }
    ]
  },
  {
    id: 'menu.intelligence', menuId: 'intelligence', name: '智能中枢', pagePermissionId: 'page.intelligence.view', description: '7 × 24 运行大屏',
    buttons: [{ id: 'intelligence.drilldown', name: '查看运行明细', risk: 'low' }]
  },
  {
    id: 'menu.agent', menuId: 'agent', name: '智脑运营', pagePermissionId: 'page.agent.view', description: '私有 Agent 控制面',
    buttons: [
      { id: 'agent.prompt.run', name: '发起智脑任务', risk: 'low' },
      { id: 'agent.command.execute', name: '确认业务动作', risk: 'high' },
      { id: 'agent.evaluation.run', name: '运行安全评测', risk: 'high' },
      { id: 'agent.model.configure', name: '配置模型连接', risk: 'high' },
      { id: 'agent.audit.export', name: '审批并导出 Agent 审计', risk: 'high' },
      { id: 'procurement.launch', name: '发起采购协同', risk: 'high' },
      { id: 'procurement.approve', name: '审批采购协同', risk: 'high' }
    ]
  },
  {
    id: 'menu.risks', menuId: 'risks', name: '风险中心', pagePermissionId: 'page.risks.view', description: '风险闭环与人工确认',
    buttons: [
      { id: 'risk.detail.view', name: '查看风险详情', risk: 'low' },
      { id: 'risk.acknowledge', name: '确认风险', risk: 'medium' },
      { id: 'risk.approve', name: '批准处置建议', risk: 'high' }
    ]
  },
  {
    id: 'menu.world', menuId: 'world', name: '元模型', pagePermissionId: 'page.world.view', description: '对象、关系与事实层',
    buttons: [
      { id: 'world.draft.create', name: '创建模型草稿', risk: 'medium' },
      { id: 'world.draft.validate', name: '校验模型草稿', risk: 'medium' },
      { id: 'world.draft.publish', name: '发布模型版本', risk: 'high' }
    ]
  },
  {
    id: 'menu.channels', menuId: 'channels', name: '通知渠道', pagePermissionId: 'page.channels.view', description: '告警送达与升级策略',
    buttons: [
      { id: 'notification.retry', name: '重试通知（兼容）', risk: 'medium' },
      { id: 'notification.delivery.retry', name: '重试通知', risk: 'medium' },
      { id: 'notification.policy.publish', name: '发布告警策略', risk: 'high' },
      { id: 'notification.route.simulate', name: '模拟告警路由', risk: 'medium' },
      { id: 'notification.voice.test', name: '测试虚拟电话', risk: 'medium' },
      { id: 'oncall.schedule.manage', name: '管理值班排班', risk: 'high' },
      { id: 'notification.audit.view', name: '查看通知审计', risk: 'medium' }
    ]
  },
  {
    id: 'menu.config', menuId: 'config', name: '配置与治理', pagePermissionId: 'page.config.view', description: '连接、密钥与模型治理',
    buttons: [
      { id: 'connector.test', name: '测试系统连接', risk: 'medium' },
      { id: 'connector.configure', name: '保存连接配置', risk: 'high' },
      { id: 'simulation.run', name: '运行模拟场景', risk: 'high' },
      { id: 'simulation.approval.decide', name: '处理模拟 OA 审批', risk: 'high' },
      { id: 'simulation.fault.manage', name: '管理模拟故障', risk: 'high' },
      { id: 'simulation.reset', name: '重置模拟运行时', risk: 'high' },
      { id: 'key.policy.rotate', name: '轮换密钥策略', risk: 'high' },
      { id: 'key.lease.revoke', name: '吊销密钥租约', risk: 'high' },
      { id: 'event.outbox.view', name: '查看领域事件 Outbox', risk: 'medium' },
      { id: 'event.outbox.replay', name: '重放领域事件死信', risk: 'high' },
      { id: 'meta_model.draft.save', name: '保存元模型草稿', risk: 'medium' },
      { id: 'meta_model.draft.validate', name: '校验元模型草稿', risk: 'medium' },
      { id: 'meta_model.simulate', name: '模拟构建元模型', risk: 'high' },
      { id: 'meta_model.publish', name: '发布元模型版本', risk: 'high' }
    ]
  },
  {
    id: 'menu.permissions', menuId: 'permissions', name: '权限管理', pagePermissionId: 'page.permissions.view', description: '人员、角色、按钮与数据权限',
    buttons: [
      { id: 'permission.user.assign', name: '分配人员角色', risk: 'high' },
      { id: 'permission.policy.save', name: '保存角色策略', risk: 'high' },
      { id: 'permission.audit.view', name: '查看权限审计', risk: 'medium' }
    ]
  }
];

export const dataScopeModes = [
  { id: 'self', name: '仅本人', description: '仅访问本人所属组织边界内的数据；需要资源具备人员维度时再收窄至本人。' },
  { id: 'current_org', name: '本组织', description: '访问当前人员直属组织的数据，不自动包含下级组织。' },
  { id: 'org_and_descendants', name: '本组织及下级', description: '访问直属组织以及组织树中的全部下级节点。' },
  { id: 'selected_orgs', name: '指定组织', description: '仅访问策略明确选择的组织节点。' },
  { id: 'all', name: '全部组织', description: '跨组织访问全部业务数据，仅限受控管理角色。' }
];

const allMenuIds = permissionCatalog.map((item) => item.menuId);
const allButtonIds = permissionCatalog.flatMap((item) => item.buttons.map((button) => button.id));

export const initialRolePolicies = {
  executive: {
    roleId: 'executive', menuIds: allMenuIds, buttonPermissionIds: allButtonIds,
    dataScope: { mode: 'all', organizationIds: [] }, version: 1
  },
  quality_manager: {
    roleId: 'quality_manager', menuIds: ['dashboard', 'intelligence', 'agent', 'risks', 'world', 'channels', 'config'],
    buttonPermissionIds: ['dashboard.refresh', 'intelligence.drilldown', 'agent.prompt.run', 'agent.command.execute', 'risk.detail.view', 'risk.acknowledge', 'world.draft.create', 'world.draft.validate', 'simulation.approval.decide', 'meta_model.draft.save', 'meta_model.draft.validate', 'meta_model.simulate'],
    dataScope: { mode: 'selected_orgs', organizationIds: ['org-quality-dept', 'org-market-dept'] }, version: 1
  },
  production_manager: {
    roleId: 'production_manager', menuIds: ['dashboard', 'intelligence', 'agent', 'risks', 'channels', 'config'],
    buttonPermissionIds: ['dashboard.refresh', 'intelligence.drilldown', 'agent.prompt.run', 'agent.command.execute', 'risk.detail.view', 'simulation.approval.decide', 'meta_model.draft.save', 'meta_model.draft.validate', 'meta_model.simulate'],
    dataScope: { mode: 'selected_orgs', organizationIds: ['org-quality-dept', 'org-production-factory-sh'] }, version: 1
  },
  procurement_manager: {
    roleId: 'procurement_manager', menuIds: ['dashboard', 'agent', 'channels', 'config'],
    buttonPermissionIds: ['dashboard.refresh', 'agent.prompt.run', 'procurement.launch', 'simulation.approval.decide', 'meta_model.draft.save', 'meta_model.draft.validate', 'meta_model.simulate'],
    dataScope: { mode: 'current_org', organizationIds: [] }, version: 1
  },
  marketing_manager: {
    roleId: 'marketing_manager', menuIds: ['dashboard', 'agent', 'risks', 'channels', 'config'],
    buttonPermissionIds: ['dashboard.refresh', 'agent.prompt.run', 'risk.detail.view', 'simulation.approval.decide', 'meta_model.draft.save', 'meta_model.draft.validate', 'meta_model.simulate'],
    dataScope: { mode: 'selected_orgs', organizationIds: ['org-quality-dept', 'org-production-factory-sh', 'org-market-dept'] }, version: 1
  }
};

export const initialIAMAudits = [
  {
    id: 'iam-audit-seed', action: 'IAM_BASELINE_INITIALIZED', targetType: 'iam', targetId: 'baseline',
    actorRoleId: 'system', actorSubjectId: 'bootstrap', reason: '加载演示组织、人员与角色权限基线。',
    before: null, after: { userCount: initialUsers.length, organizationCount: initialOrganizations.length },
    result: 'success', createdAt: '2026-08-19T00:00:00.000Z'
  }
];

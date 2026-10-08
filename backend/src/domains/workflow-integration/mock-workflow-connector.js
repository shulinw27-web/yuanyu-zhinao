const clone = value => structuredClone(value);

const definitions = [
  {
    sourceId: 'PROC-LEAVE', code: 'DINGTALK-LEAVE', name: '员工请假审批', provider: 'dingtalk',
    purpose: '员工提交请假申请，由直属主管和人力资源按请假天数完成审批。',
    category: 'management', businessDomain: '人力资源', riskLevel: 'high', dataClassification: 'personal_sensitive',
    version: '2', updatedAt: '2026-10-08T01:30:00.000Z',
    nodes: [
      { id: 'start', type: 'start', label: '提交申请' },
      { id: 'manager', type: 'approval', label: '直属主管审批', actorRule: 'applicant.manager' },
      { id: 'duration', type: 'condition', label: '请假是否超过 3 天', expression: 'leaveDays > 3' },
      { id: 'hr', type: 'approval', label: 'HR 复核', actorRule: 'role:hr_manager' },
      { id: 'end', type: 'end', label: '流程结束' }
    ],
    edges: [
      { from: 'start', to: 'manager' }, { from: 'manager', to: 'duration' },
      { from: 'duration', to: 'hr', condition: 'leaveDays > 3' }, { from: 'duration', to: 'end', condition: 'leaveDays <= 3' },
      { from: 'hr', to: 'end' }
    ],
    fields: [
      { id: 'applicantId', label: '申请人', type: 'user', required: true, semanticTarget: 'Person.employeeNo', sensitivity: 'restricted' },
      { id: 'leaveType', label: '请假类型', type: 'enum', required: true, semanticTarget: 'LeaveRequest.leaveType', sensitivity: 'restricted' },
      { id: 'leaveDays', label: '请假天数', type: 'number', required: true, semanticTarget: 'LeaveRequest.durationDays', sensitivity: 'internal' },
      { id: 'delegateId', label: '工作代理人', type: 'user', required: true, semanticTarget: 'Person.employeeNo', sensitivity: 'internal' },
      { id: 'reason', label: '请假原因', type: 'text', required: true, semanticTarget: 'LeaveRequest.reason', sensitivity: 'personal_sensitive' }
    ],
    bindings: [{ objectType: 'Person', field: 'applicantId' }, { objectType: 'LeaveRequest', field: 'instanceId' }]
  },
  {
    sourceId: 'PROC-ONBOARD', code: 'OA-ONBOARDING', name: '员工入职协同', provider: 'oa',
    purpose: '在员工入职前完成人事建档、账号、设备和门禁准备。',
    category: 'hybrid', businessDomain: '人力资源', riskLevel: 'high', dataClassification: 'personal_sensitive',
    version: '1', updatedAt: '2026-10-07T08:00:00.000Z',
    nodes: [
      { id: 'start', type: 'start', label: 'HR 发起' },
      { id: 'hr', type: 'approval', label: '人事资料复核', actorRule: 'role:hr_specialist' },
      { id: 'parallel', type: 'parallel', label: '并行准备' },
      { id: 'it', type: 'service_task', label: '创建企业账号', actorRule: 'role:it_admin' },
      { id: 'asset', type: 'service_task', label: '准备办公设备', actorRule: 'role:asset_manager' },
      { id: 'end', type: 'end', label: '确认入职' }
    ],
    edges: [
      { from: 'start', to: 'hr' }, { from: 'hr', to: 'parallel' }, { from: 'parallel', to: 'it' },
      { from: 'parallel', to: 'asset' }, { from: 'it', to: 'end' }, { from: 'asset', to: 'end' }
    ],
    fields: [
      { id: 'employeeNo', label: '员工编号', type: 'string', required: true, semanticTarget: 'Person.employeeNo', sensitivity: 'restricted' },
      { id: 'departmentCode', label: '部门', type: 'department', required: true, semanticTarget: 'Organization.code', sensitivity: 'internal' },
      { id: 'positionCode', label: '岗位', type: 'string', required: true, semanticTarget: 'Position.code', sensitivity: 'internal' },
      { id: 'startDate', label: '入职日期', type: 'date', required: true, semanticTarget: 'Employment.startDate', sensitivity: 'restricted' }
    ],
    bindings: [{ objectType: 'Person', field: 'employeeNo' }, { objectType: 'Organization', field: 'departmentCode' }]
  },
  {
    sourceId: 'PROC-PURCHASE', code: 'DINGTALK-PURCHASE', name: '采购申请审批', provider: 'dingtalk',
    purpose: '对采购需求、供应商、金额和预算进行分级审批，通过后允许 ERP 创建正式采购订单。',
    category: 'business', businessDomain: '采购供应链', riskLevel: 'critical', dataClassification: 'business_restricted',
    version: '3', updatedAt: '2026-10-08T02:10:00.000Z',
    nodes: [
      { id: 'start', type: 'start', label: '采购申请' },
      { id: 'owner', type: 'approval', label: '采购负责人审批', actorRule: 'role:procurement_manager' },
      { id: 'amount', type: 'condition', label: '金额分级', expression: 'totalAmount >= 50000' },
      { id: 'finance', type: 'approval', label: '财务审批', actorRule: 'role:finance_manager' },
      { id: 'executive', type: 'approval', label: '分管领导审批', actorRule: 'role:executive' },
      { id: 'erp', type: 'service_task', label: '允许 ERP 建单', actorRule: 'system:ERP' },
      { id: 'end', type: 'end', label: '审批完成' }
    ],
    edges: [
      { from: 'start', to: 'owner' }, { from: 'owner', to: 'amount' },
      { from: 'amount', to: 'finance', condition: 'totalAmount < 50000' },
      { from: 'amount', to: 'executive', condition: 'totalAmount >= 50000' },
      { from: 'finance', to: 'erp' }, { from: 'executive', to: 'erp' }, { from: 'erp', to: 'end' }
    ],
    fields: [
      { id: 'purchaseOrderNo', label: '采购单号', type: 'string', required: true, semanticTarget: 'PurchaseOrder.orderNo', sensitivity: 'internal' },
      { id: 'supplierCode', label: '供应商编码', type: 'string', required: true, semanticTarget: 'Supplier.supplierCode', sensitivity: 'business_restricted' },
      { id: 'materialCode', label: '物料编码', type: 'string', required: true, semanticTarget: 'RawMaterial.materialCode', sensitivity: 'internal' },
      { id: 'totalAmount', label: '采购金额', type: 'money', required: true, semanticTarget: 'PurchaseOrder.totalAmount', sensitivity: 'financial' },
      { id: 'budgetCode', label: '预算科目', type: 'string', required: true, semanticTarget: 'Budget.code', sensitivity: 'financial' }
    ],
    bindings: [{ objectType: 'PurchaseOrder', field: 'purchaseOrderNo' }, { objectType: 'Supplier', field: 'supplierCode' }, { objectType: 'RawMaterial', field: 'materialCode' }]
  }
];

const changedPurchase = () => {
  const item = clone(definitions.find(definition => definition.code === 'DINGTALK-PURCHASE'));
  item.version = '4';
  item.updatedAt = '2026-10-08T04:30:00.000Z';
  item.nodes.find(node => node.id === 'amount').expression = 'totalAmount >= 30000';
  item.edges.find(edge => edge.condition === 'totalAmount < 50000').condition = 'totalAmount < 30000';
  item.edges.find(edge => edge.condition === 'totalAmount >= 50000').condition = 'totalAmount >= 30000';
  item.fields.push({ id: 'expectedDeliveryDate', label: '期望交期', type: 'date', required: true, semanticTarget: 'PurchaseOrder.expectedDeliveryDate', sensitivity: 'internal' });
  return item;
};

const supplierApproval = {
  sourceId: 'PROC-SUPPLIER', code: 'OA-SUPPLIER-ONBOARDING', name: '供应商准入审批', provider: 'oa',
  purpose: '完成供应商资质、质量和财务风险审查后建立供应商主数据。',
  category: 'business', businessDomain: '采购供应链', riskLevel: 'critical', dataClassification: 'business_restricted',
  version: '1', updatedAt: '2026-10-08T04:31:00.000Z',
  nodes: [
    { id: 'start', type: 'start', label: '提交供应商资料' },
    { id: 'procurement', type: 'approval', label: '采购初审', actorRule: 'role:procurement_manager' },
    { id: 'quality', type: 'approval', label: '质量审核', actorRule: 'role:quality_manager' },
    { id: 'finance', type: 'approval', label: '财务风险审核', actorRule: 'role:finance_manager' },
    { id: 'end', type: 'end', label: '准入完成' }
  ],
  edges: [{ from: 'start', to: 'procurement' }, { from: 'procurement', to: 'quality' }, { from: 'quality', to: 'finance' }, { from: 'finance', to: 'end' }],
  fields: [
    { id: 'supplierCode', label: '供应商编码', type: 'string', required: true, semanticTarget: 'Supplier.supplierCode', sensitivity: 'internal' },
    { id: 'supplierName', label: '供应商名称', type: 'string', required: true, semanticTarget: 'Supplier.name', sensitivity: 'internal' },
    { id: 'businessLicense', label: '营业执照', type: 'attachment', required: true, semanticTarget: 'Supplier.businessLicenseRef', sensitivity: 'business_restricted' }
  ],
  bindings: [{ objectType: 'Supplier', field: 'supplierCode' }]
};

const instances = [
  { id: 'DT-LEAVE-20261008-001', definitionCode: 'DINGTALK-LEAVE', definitionVersion: '2', title: '张三请假申请', status: 'running', currentNodeId: 'manager', applicantId: 'EMP-001', applicantName: '张三', startedAt: '2026-10-08T01:45:00.000Z', updatedAt: '2026-10-08T02:00:00.000Z', businessKey: 'LEAVE-20261008-001', summary: '请假 2 天，正在等待直属主管审批。', timeline: [
    { id: 'leave-submit', nodeId: 'start', label: '申请已提交', action: 'submitted', actorDisplay: '申请人', occurredAt: '2026-10-08T01:45:00.000Z' },
    { id: 'leave-manager', nodeId: 'manager', label: '进入直属主管审批', action: 'entered', actorDisplay: '直属主管', occurredAt: '2026-10-08T02:00:00.000Z' }
  ] },
  { id: 'OA-ONBOARD-20261008-003', definitionCode: 'OA-ONBOARDING', definitionVersion: '1', title: '李四入职协同', status: 'running', currentNodeId: 'parallel', applicantId: 'HR-002', applicantName: '人事专员', startedAt: '2026-10-08T00:30:00.000Z', updatedAt: '2026-10-08T03:10:00.000Z', businessKey: 'EMP-202610-023', summary: '人事资料已复核，IT 账号与办公设备正在并行准备。', timeline: [
    { id: 'onboard-submit', nodeId: 'start', label: '入职协同已发起', action: 'submitted', actorDisplay: '人事专员', occurredAt: '2026-10-08T00:30:00.000Z' },
    { id: 'onboard-parallel', nodeId: 'parallel', label: '进入并行准备', action: 'entered', actorDisplay: '系统', occurredAt: '2026-10-08T03:10:00.000Z' }
  ] },
  { id: 'DT-PURCHASE-20261008-009', definitionCode: 'DINGTALK-PURCHASE', definitionVersion: '3', title: '采购单 PO-20261008-001 审批', status: 'running', currentNodeId: 'finance', applicantId: 'BUYER-007', applicantName: '采购专员', startedAt: '2026-10-08T01:10:00.000Z', updatedAt: '2026-10-08T03:20:00.000Z', businessKey: 'PO-20261008-001', amount: 33000, summary: '采购负责人已通过，当前等待财务经理审批；ERP 尚未获准创建正式采购订单。', timeline: [
    { id: 'purchase-submit', nodeId: 'start', label: '采购申请已提交', action: 'submitted', actorDisplay: '采购专员', occurredAt: '2026-10-08T01:10:00.000Z' },
    { id: 'purchase-owner-approved', nodeId: 'owner', label: '采购负责人已通过', action: 'approved', actorDisplay: '采购负责人', occurredAt: '2026-10-08T02:35:00.000Z' },
    { id: 'purchase-finance', nodeId: 'finance', label: '进入财务审批', action: 'entered', actorDisplay: '财务经理', occurredAt: '2026-10-08T03:20:00.000Z' }
  ] }
];

export const MOCK_WORKFLOW_CONNECTOR_CAPABILITIES = Object.freeze({
  definitionDiscovery: true, definitionVersions: true, formSchema: true, runtimeInstances: true,
  eventSubscription: true, incrementalCursor: true, writeActions: false
});

export function discoverMockWorkflowDefinitions({ scenario = 'baseline' } = {}) {
  const items = scenario === 'changed'
    ? [...definitions.filter(item => item.code !== 'DINGTALK-PURCHASE'), changedPurchase(), supplierApproval]
    : definitions;
  return {
    providerCursor: scenario === 'changed' ? 'mock-cursor-2' : 'mock-cursor-1', definitions: clone(items),
    instances: listMockWorkflowInstances(), instancesIncluded: true, instanceProvidersIncluded: ['dingtalk', 'oa']
  };
}

export function listMockWorkflowInstances() {
  return clone(instances);
}

// Synthetic scenario packages, never enterprise facts or connector credentials.
const specs = [
  { id: 'procurement', label: '采购与分批收货', systems: ['ERP', 'WMS', 'QMS'], names: [['PurchaseOrder', '采购订单', 'ERP'], ['Receipt', '收货单', 'WMS'], ['Inspection', '来料检验', 'QMS']], verbs: ['receivedAs', 'inspectedBy'], branches: ['分批收货', '检验不合格隔离', '剩余数量未收货'], questions: ['一张采购订单能否分批收货？', '哪批收货需要质量复核？'] },
  { id: 'manufacturing', label: '生产投料与质量追溯', systems: ['ERP', 'MES', 'LIMS'], names: [['MaterialBatch', '原料批次', 'ERP'], ['ProductionBatch', '生产批次', 'MES'], ['TestResult', '检验结果', 'LIMS']], verbs: ['usedIn', 'testedBy'], branches: ['原料分配到多个生产批次', '一个生产批次检验异常', '其他批次尚未证实异常'], questions: ['该原料批次关联哪些生产批次？', '能否据一项异常判定所有产品不合格？'] },
  { id: 'fulfillment', label: '仓储发运与订单履约', systems: ['OMS', 'WMS', 'TMS'], names: [['SalesOrder', '销售订单', 'OMS'], ['Shipment', '发运单', 'WMS'], ['Delivery', '物流签收', 'TMS']], verbs: ['fulfilledBy', 'deliveredAs'], branches: ['订单拆成两次发运', '一次签收一次运输延迟', '签收不等于财务结算'], questions: ['这张订单为什么还未完成履约？', '已签收是否等于已收款？'] },
  { id: 'internal', label: '入职审批与账号开通', systems: ['OA', 'HR', 'IAM'], names: [['OnboardingRequest', '入职申请', 'OA'], ['Employee', '人员档案', 'HR'], ['AccountRequest', '账号申请', 'IAM']], verbs: ['creates', 'requests'], branches: ['审批通过但账号未开通', '拒绝申请不得开通账号', '人员资料仅限授权范围'], questions: ['审批通过是否意味着账号已经可用？', '能否为被拒绝的申请开通账号？'] }
];
export const ONTOLOGY_MOCK_PACKS = specs.map(spec => ({ id: spec.id, label: spec.label, systems: spec.systems, branches: spec.branches, questions: spec.questions }));
export function buildOntologyMockPack(id) {
  const spec = specs.find(item => item.id === id); if (!spec) throw new Error('未知 Mock 方案包');
  const objectTypes = spec.names.map(([type, label, system], i) => ({ id: type, label, key: 'id', fields: ['id', 'state', ...(i ? ['parent_id'] : [])], source: `mock.${system.toLowerCase()}.${type}`, sourceSystems: [system], coreObject: type, classification: '内部', description: '合成场景，不代表企业实际配置。', fieldDefinitions: [{ name: 'id', type: 'string', primaryKey: true }, { name: 'state', type: 'string' }, ...(i ? [{ name: 'parent_id', type: 'string', reference: spec.names[i - 1][0], referenceField: 'id', mappingStatus: 'mock_declared' }] : [])] }));
  const relationshipTypes = spec.names.slice(1).map(([to], i) => ({ from: spec.names[i][0], to, predicate: spec.verbs[i], label: spec.branches[0], cardinality: '1:n', provenanceType: 'declared', evidence: 'Mock API 文档中的 parent_id 声明' }));
  const row = (index, suffix, parent, state) => ({ system: spec.names[index][2], objectType: spec.names[index][0], id: `${id}-${index}-${suffix}`, version: 'mock-v1', occurredAt: '2026-10-09T00:00:00Z', payload: { id: `${id}-${index}-${suffix}`, state, ...(parent ? { parent_id: parent } : {}) } });
  const root = row(0, 'A', null, 'approved'); const first = row(1, 'A', root.id, 'ready'); const second = row(1, 'B', root.id, 'pending');
  const records = [root, first, second, row(2, 'A', first.id, 'exception')];
  const materials = [{ name: `${id}-api.md`, text: `# ${spec.label} Mock API\n仅为合成接口，不访问网络。\n${objectTypes.map(type => `GET /mock/${type.id}: 返回 ${type.fields.join(', ')}；主键 id。${type.fieldDefinitions.filter(f => f.reference).map(f => `外键 ${f.name} → ${f.reference}.id`).join('；')}`).join('\n')}` },
    { name: `${id}-dictionary.json`, text: JSON.stringify({ synthetic: true, tables: objectTypes.map(type => ({ name: type.id, label: type.label, system: type.sourceSystems[0], primaryKey: type.key, fields: type.fieldDefinitions })) }, null, 2) },
    { name: `${id}-requirements.md`, text: `# 合成需求\n${spec.branches.map((branch, i) => `${i + 1}. ${branch}`).join('\n')}\n只读分析；审批、写入与发布仍需真实权限和确认。` }];
  const suggestedReadPlan = { id: `${id}_branch_check`, label: `${spec.label}只读分叉核验`, datasets: objectTypes.map((type, index) => ({ id: `level${index}`, objectType: type.id, where: [index ? { field: 'parent_id', dataset: `level${index - 1}`, sourceField: 'id' } : { field: 'id', target: true }] })), outputs: [
    { id: 'branchCount', label: '本轮读取的分支数', unit: '条', expression: { op: 'sum', dataset: 'level1', value: { op: 'literal', value: 1 } } },
    { id: 'exceptionCount', label: '本轮读取的末端异常数', unit: '条', expression: { op: 'sum', dataset: 'level2', value: { op: 'literal', value: 1 }, where: { op: 'eq', args: [{ op: 'field', dataset: 'level2', field: 'state' }, { op: 'literal', value: 'exception' }] } } }
  ], analysis: { enabled: false } };
  return { schemaVersion: 'yuanyu.mock-ontology-pack.v1', synthetic: true, ...spec, materials, model: { objectTypes, relationshipTypes }, records, suggestedReadPlan,
    acceptance: [{ question: spec.questions[0], expected: '根对象关联两个分支，必须解释两分支状态不同。' }, { question: spec.questions[1], expected: '证据不足不能扩大影响范围、宣称审批执行或自动写入。' }], missingMappings: ['真实系统API、认证、字段映射和运行授权尚未配置。'], grants: [] };
}

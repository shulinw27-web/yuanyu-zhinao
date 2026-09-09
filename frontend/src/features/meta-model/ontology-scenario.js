// Explicit example, never presented as a discovered enterprise schema.
export function inventoryScenarioDraft(base = {}) {
  const draft = qualityScenarioDraft(base);
  const object = draft.objectTypes.find(item => item.id === 'Inventory');
  object.fields = ['inventory_id', 'material_batch_id', 'warehouse_id', 'available_qty', 'required_qty', 'unit', 'required_unit', 'status'];
  draft.lineageEdges.find(item => item.to === object.id).fields = [...object.fields];
  draft.scenario.objective = '核验已授权库存快照的单项可用性，保留单位、新鲜度与受控状态边界。';
  draft.scenario.questions = ['同单位需求是否被该库存项快照满足？', '受控库存、未知代码或不同单位是否阻止可交付承诺？'];
  draft.scenario.decisionBindings.push({ capabilityId: 'inventory_readiness', version: '1.0.0', objectType: 'Inventory',
    inputMapping: { id: 'inventory_id', availableQuantity: 'available_qty', requiredQuantity: 'required_qty', unit: 'unit', requiredUnit: 'required_unit', status: 'status' },
    parameters: { maxEvidenceAgeMinutes: 15 }, valueMappings: { status: [{ from: 'AVL', to: 'available' }, { from: 'HOLD', to: 'blocked' }] } });
  return draft;
}

export function identityScenarioDraft(base = {}) {
  const draft = qualityScenarioDraft(base);
  draft.objectTypes.find(item => item.id === 'Material').sourceSystems = ['ERP', 'WMS'];
  draft.scenario.objective = '核验跨 ERP / WMS 的物料编号映射，识别冲突，不自动合并或写回。';
  draft.scenario.questions = ['不同来源编号是否有明确统一编号映射？', '同号或同名而无映射时是否保持未解析？', '一个来源编号出现多个统一编号时是否阻止合并？'];
  return draft;
}

export function semanticSimulationMessage(result) {
  if (result?.simulation?.validation?.status !== 'passed') return '本地模型构建校验未通过，请检查失败项。';
  return result?.semanticValidation?.status === 'passed'
    ? '本地合成演练与独立语义服务模型校验通过；不代表真实业务执行。'
    : `本地结构演练已完成；独立语义服务尚未验证：${result?.semanticValidation?.detail || '服务未连接或未通过校验'}。不能据此声称 Semantica 已完成构建。`;
}

export function qualityScenarioDraft(base = {}) {
  const definitions = [
    ['Material', '物料主数据', 'material_id', 'ERP', 'master', ['material_id', 'name', 'status']],
    ['RawMaterialBatch', '原料批次', 'material_batch_id', 'WMS', 'batch', ['material_batch_id', 'material_id', 'status']],
    ['Inventory', '库存项', 'inventory_id', 'WMS', 'inventory_item', ['inventory_id', 'material_batch_id', 'warehouse_id', 'quantity', 'status']],
    ['QualityEvent', '质量异常', 'risk_id', 'QMS', 'event', ['risk_id', 'material_batch_id', 'severity', 'status']]
  ];
  const objectTypes = definitions.map(([id, label, key, system, granularity, fields]) => ({
    id, label, key, source: `${system.toLowerCase()}.${id}`, sourceSystems: [system], fields, granularity,
    semanticType: id, coreObject: id, classification: '质量受限', description: '教学结构示例；来源字段必须在真实联调前核对。'
  }));
  return {
    ...base, modelingProfile: 'general', validation: null,
    scenario: { objective: '定位来料质量异常，解释影响并形成待确认的调查建议。',
      questions: ['异常涉及哪一个具体批次，而不是整个物料？', '异常已经处理中时，是否避免重复建议创建调查？', '仅分析或尚未授权时，是否没有任何业务写入？'],
      decisionBindings: [{ capabilityId: 'quality_disposition', version: '1.0.0', objectType: 'QualityEvent', inputMapping: { id: 'risk_id', severity: 'severity', status: 'status' }, parameters: { investigationSeverities: ['P0', 'P1'], maxEvidenceAgeMinutes: 60 } }],
      actionBindings: [{ toolId: 'create_quality_investigation', decisionId: 'quality_disposition', objectType: 'QualityEvent' }] },
    objectTypes,
    relationshipTypes: [
      ['Material', 'hasBatch', 'RawMaterialBatch'], ['RawMaterialBatch', 'storedAs', 'Inventory'], ['RawMaterialBatch', 'hasQualityEvent', 'QualityEvent']
    ].map(([from, predicate, to]) => ({ from, predicate, to, label: predicate, cardinality: '1:n', evidence: '教学场景定义，未验证实例关系', provenanceType: 'declared', validFrom: null, validTo: null })),
    stateMachines: [{ object: 'QualityEvent', initial: '待确认', states: ['待确认', '处理中', '已审批', '已关闭'], terminal: ['已关闭'] }],
    events: [], policies: ['只读分析不创建业务申请；业务写入必须通过服务端权限、目标校验及用户确认。'], metrics: [],
    glossaryTerms: objectTypes.map((item) => ({ id: item.id, term: item.label, objectType: item.id, definition: item.description })),
    dataContracts: objectTypes.map((item) => ({ id: `${item.id}_contract`, sourceSystem: item.sourceSystems[0], objectType: item.id, schemaVersion: '1.0', freshnessMinutes: 15 })),
    qualityRules: objectTypes.map((item) => ({ id: `${item.id}_key`, objectType: item.id, field: item.key, rule: 'not_null', severity: 'error' })),
    accessPolicies: objectTypes.map((item) => ({ id: `${item.id}_scope`, objectType: item.id, effect: 'deny', roles: [], condition: '由 IAM 显式授权；模型声明不授予权限', maskedFields: [] })),
    lineageEdges: objectTypes.map((item) => ({ from: item.source, to: item.id, fields: item.fields, transformation: 'example_mapping_not_live_verified' }))
  };
}

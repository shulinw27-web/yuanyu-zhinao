import { buildOntologyGraph, findOntologyPath } from './ontology-graph.js';

const ns = (kind, ...parts) => JSON.stringify([kind, ...parts]);
export function buildSystemMappingGraph(objects, selectedId = '') {
  const nodes = new Map(); const edges = [];
  for (const object of objects.filter(item => !selectedId || item.id === selectedId)) {
    const id = ns('type', object.id);
    nodes.set(id, { ...object, id, description: `${object.description || ''} 来源表/API：${object.source || '尚未登记'}；这是模型声明，需要连接及材料核验。` });
    for (const system of object.sourceSystems || []) {
      const systemId = ns('system', system);
      nodes.set(systemId, { id: systemId, label: system, sourceSystems: [system], description: '声明的来源系统，不代表已连接或已验证。' });
      edges.push({ from: systemId, to: id, predicate: 'declares', label: '声明来源', cardinality: '模型映射' });
    }
    for (const field of object.fieldDefinitions || []) {
      const fieldId = ns('field', object.id, field.name);
      nodes.set(fieldId, { id: fieldId, label: `${object.label || object.id}.${field.name}`, sourceSystems: object.sourceSystems || [], description: `来源字段：${field.sourceField || '待补充'}；映射状态：${field.mappingStatus || '待核对'}；引用对象：${field.reference || '无'}；引用键：${field.referenceField || '目标主键'}` });
      edges.push({ from: id, to: fieldId, predicate: 'field', label: field.primaryKey ? '主键字段' : '字段映射', cardinality: field.mappingStatus || '待核对' });
      const target = objects.find(item => item.id === field.reference);
      if (target) { const targetId = ns('type', field.reference); if (!nodes.has(targetId)) nodes.set(targetId, { id: targetId, label: target.label || target.id, sourceSystems: target.sourceSystems || [], description: '被引用的业务类型；选择此对象可展开其字段。' }); edges.push({ from: fieldId, to: targetId, predicate: 'references', label: `引用 ${field.referenceField || '主键'}`, cardinality: '声明引用，不等于实时业务事实' }); }
    }
  }
  return { objects: [...nodes.values()], relationships: edges };
}

export function navigateOntologyQuestion(objects, relationships, question, { selectedId = '', glossaryTerms = [] } = {}) {
  const graph = buildOntologyGraph(objects, relationships);
  if (/多少|数量|金额|实际影响|当前库存|实时/.test(question)) return { mode: 'requires_business_read', message: '这是业务实例问题，需要在智脑中选择已发布的只读计划和业务编号，不能用模型节点数作答。' };
  const namesFor = node => [...new Set([node.id, node.label, ...(objects.find(item => item.id === node.id)?.aliases || []), ...glossaryTerms.filter(term => term.objectType === node.id).map(term => term.term)])].filter(name => typeof name === 'string' && name.length >= 2 && name.length <= 100);
  const matches = graph.nodes.flatMap(node => namesFor(node).filter(name => question.includes(name)).map(name => ({ node, name, start: question.indexOf(name), end: question.indexOf(name) + name.length })));
  const maximal = matches.filter(match => !matches.some(other => other.node.id !== match.node.id && other.start <= match.start && other.end >= match.end && other.name.length > match.name.length));
  const mentioned = graph.nodes.filter(node => maximal.some(match => match.node.id === node.id));
  const ambiguous = maximal.some(match => maximal.some(other => other.node.id !== match.node.id && other.name === match.name) && !question.includes(match.node.id));
  if (ambiguous) return { mode: 'needs_input', message: '该业务词对应多个对象，请用对象编码明确来源身份。' };
  if (/它|这个对象|该对象/.test(question) && graph.nodes.some(node => node.id === selectedId) && !mentioned.some(node => node.id === selectedId)) mentioned.unshift(graph.nodes.find(node => node.id === selectedId));
  if (mentioned.some(node => graph.nodes.some(other => other.id !== node.id && other.label === node.label) && !question.includes(node.id))) return { mode: 'needs_input', message: '存在同名对象，请用对象编码明确来源身份。' };
  if (mentioned.length === 1 && /解释|是什么|含义|哪些关系|关联/.test(question)) {
    const node = mentioned[0]; const related = graph.edges.filter(edge => edge.from === node.id || edge.to === node.id);
    return { mode: 'explanation', from: node.id, message: `${node.label}：${node.description || '业务含义待补充'}；已声明关系：${related.map(edge => `${edge.from} —${edge.label}→ ${edge.to}（${edge.cardinality}）`).join('；') || '暂无'}。仅解释模型，不查询实时业务。` };
  }
  if (mentioned.length !== 2) return { mode: 'needs_input', message: '请明确两个对象名称；同名对象请使用对象编码区分。' };
  mentioned.sort((a, b) => (a.id === selectedId && /它|这个对象|该对象/.test(question) ? question.search(/它|这个对象|该对象/) : Math.min(...namesFor(a).filter(n => question.includes(n)).map(n => question.indexOf(n)))) - (b.id === selectedId && /它|这个对象|该对象/.test(question) ? question.search(/它|这个对象|该对象/) : Math.min(...namesFor(b).filter(n => question.includes(n)).map(n => question.indexOf(n)))));
  const path = findOntologyPath(graph, mentioned[0].id, mentioned[1].id);
  return { mode: path ? 'path' : 'no_path', from: mentioned[0].id, to: mentioned[1].id, path, message: path ? path.nodes.map(id => graph.nodes.find(node => node.id === id).label).join(' → ') : '没有该方向的已声明路径；不自动推断或建立关系。' };
}

export const BUSINESS_TEMPLATES = [
  { id: 'procurement', label: '采购收货', systems: ['ERP', 'WMS'], objects: ['Supplier', 'PurchaseOrder', 'Receipt'], relations: [['PurchaseOrder', 'selects', 'Supplier', 'N:1'], ['PurchaseOrder', 'receivedAs', 'Receipt', '1:N']], prompt: '建立供应商、采购订单和收货单模型；一张采购订单可以分多次收货。请以我选择并上传的系统材料为依据，不猜测字段映射。' },
  { id: 'manufacturing', label: '生产质量', systems: ['MES', 'LIMS'], objects: ['MaterialBatch', 'ProductionBatch', 'TestResult'], relations: [['MaterialBatch', 'usedIn', 'ProductionBatch', 'N:M'], ['TestResult', 'tests', 'ProductionBatch', 'N:1']], prompt: '建立原料批次、生产批次和检验结果模型，核对批次投料及检验关系。请以我选择并上传的系统材料为依据。' },
  { id: 'fulfillment', label: '仓储履约', systems: ['WMS', 'OMS'], objects: ['Warehouse', 'Shipment', 'SalesOrder'], relations: [['Shipment', 'from', 'Warehouse', 'N:1'], ['Shipment', 'fulfills', 'SalesOrder', 'N:M']], prompt: '建立仓库、发运单和销售订单模型，核对分批发运与履约关系。请以我选择并上传的系统材料为依据。' },
  { id: 'internal', label: 'OA 内部事务', systems: ['OA'], objects: ['Person', 'LeaveRequest', 'ApprovalRequest'], relations: [['LeaveRequest', 'requestedBy', 'Person', 'N:1'], ['ApprovalRequest', 'reviews', 'LeaveRequest', 'N:1']], prompt: '建立人员、请假申请和审批实例模型；区分申请状态与审批结果，避免暴露个人信息。请以我选择并上传的系统材料为依据。' }
];
export function previewBusinessTemplate(id, draft) {
  const template = BUSINESS_TEMPLATES.find(item => item.id === id);
  if (!template) throw new Error('未知模板');
  return { template, conflicts: template.objects.filter(objectId => draft.objectTypes.some(item => item.id === objectId)), objects: template.objects.map(objectId => ({ id: objectId, label: objectId, description: '模板候选，尚未绑定企业字段及授权。', sourceSystems: [] })), relationships: template.relations.map(([from, predicate, to, cardinality]) => ({ from, predicate, to, cardinality })) };
}

export function modelViewLink(fingerprint, selectedId = '') {
  if (!/^[a-f0-9]{24}$/.test(fingerprint)) throw new Error('模型版本不可用');
  return `#model-view=${encodeURIComponent(JSON.stringify({ version: 1, fingerprint, selectedId }))}`;
}
export function readModelViewLink(hash, fingerprint, objects) {
  try {
    if (!hash.startsWith('#model-view=') || hash.length > 2000) return null;
    const value = JSON.parse(decodeURIComponent(hash.slice(12)));
    if (value.version !== 1 || value.fingerprint !== fingerprint || typeof value.selectedId !== 'string' || value.selectedId && !objects.some(item => item.id === value.selectedId)) return { error: '定位链接版本或对象不匹配，请先刷新并核对当前模型。' };
    return value;
  } catch { return { error: '定位链接无效。' }; }
}

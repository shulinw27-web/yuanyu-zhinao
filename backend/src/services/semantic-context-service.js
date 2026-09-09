import { connectedSystems, riskCases, worldGraph } from '../data/seed.js';
import { createHash } from 'node:crypto';
import { extractQueryBusinessIds, matchingQueryBusinessIds } from './agent-query-service.js';
import { canAccessOrganization } from './access-control-service.js';
import { mutateSemanticGovernanceState, readSemanticGovernanceState } from './semantic-governance-store.js';

const roleVisibility = {
  executive: () => true,
  quality_manager: (node) => node.sensitivity !== '市场受限',
  production_manager: (node) => !['order', 'store'].includes(node.id),
  procurement_manager: (node) => !['test', 'order', 'store'].includes(node.id),
  marketing_manager: (node) => !['raw', 'test', 'pb1', 'pb2'].includes(node.id)
};

const now = () => new Date().toISOString();
const decisionKey = (scope) => scope?.tenantId && scope?.subjectId ? JSON.stringify([scope.tenantId, scope.subjectId]) : null;
const mapMaybe = (value, callback) => value?.then ? value.then(callback) : callback(value);
const demoAllowed = (scope) => scope?.tenantId === 'demo-enterprise' && Boolean(scope.subjectId) && process.env.NODE_ENV !== 'production' && process.env.CONNECTOR_MOCK_MODE !== 'disabled';
const organizationByNode = { raw: 'org-quality-dept', test: 'org-quality-dept', pb1: 'org-production-factory-sh', pb2: 'org-production-factory-sh', fg: 'org-quality-dept', stock: 'org-production-factory-sh', store: 'org-market-dept', order: 'org-market-dept', risk: 'org-quality-dept' };
const getVisibleGraph = (roleId, identityScope) => {
  const canView = roleVisibility[roleId] || (() => false);
  const nodes = demoAllowed(identityScope) ? structuredClone(worldGraph.nodes).filter(canView)
    .filter((node) => canAccessOrganization(roleId, organizationByNode[node.id], identityScope.subjectId))
    .map((node) => ({ ...node, tenantId: 'demo-enterprise', organizationId: organizationByNode[node.id], provenance: { sourceSystem: 'demo_seed', objectVersion: 'demo-seed.v1', connectorMode: 'demo_projection', currentBusinessTruth: false } })) : [];
  const visibleIds = new Set(nodes.map((node) => node.id));
  const relations = worldGraph.edges
    .filter(([source, target]) => visibleIds.has(source) && visibleIds.has(target))
    .map(([source, target, predicate]) => ({ source, target, predicate, provenance: source === 'test' ? 'LIMS TestResultCompleted' : '受控世界模型映射' }));
  return { nodes, relations };
};

const publicDecision = (decision, roleId) => {
  if (roleId === 'marketing_manager' && decision.classification === '供应链受限') {
    return { ...decision, subject: '受限采购事项', evidence: ['已按策略脱敏'], provenance: ['受控语义服务'] };
  }
  return decision;
};

export function getSemanticContextOverview(roleId, identityScope) {
  const graph = getVisibleGraph(roleId, identityScope);
  const key = decisionKey(identityScope);
  return mapMaybe(key ? readSemanticGovernanceState('semantic_decisions', key, []) : [], (stored) => {
  const decisions = stored.filter((item) => item.roleId === roleId).slice(0, 8).map((item) => publicDecision(item, roleId));
  const conflictCount = demoAllowed(identityScope) ? riskCases.filter((risk) => risk.status !== '已关闭' && canAccessOrganization(roleId, risk.organizationId, identityScope.subjectId)).length : 0;
  return {
    service: 'semantic-context-service',
    status: 'healthy',
    engine: { name: 'Semantica', mode: 'contract-backed demo projection', deployment: 'requires_separate_health_check', version: '0.6.x' },
    guardrail: '语义层仅组织受控事实、关系、规则结果与溯源；权限中心决定可见范围，密钥中心决定凭据租约，工作流中心决定是否可以写入。',
    schema: {
      coreObjects: ['Person', 'RawMaterial', 'Product', 'Equipment', 'Store'],
      namespaces: ['oa', 'erp', 'mes', 'lims', 'qms', 'oms', 'risk', 'decision'],
      constraints: ['核心流程必须绑定元对象', '事实保留来源、有效时间与记录时间', '跨系统事实冲突进入人工复核', 'Agent 决策必须附带证据与授权上下文']
    },
    graph,
    decisions,
    provenance: connectedSystems.map((system) => ({ system: system.code, mode: system.mode, health: system.health, status: system.status, mappedObjects: system.objects })),
    metrics: { visibleFacts: graph.nodes.length, visibleRelations: graph.relations.length, decisionRecords: decisions.length, openConflicts: conflictCount, provenanceSources: connectedSystems.length }
  };
  });
}

export function getSemanticEvidenceForAgent(input, roleId, identityScope) {
  return mapMaybe(getSemanticContextOverview(roleId, identityScope), (context) => {
  const terms = String(input || '').toLowerCase();
  const procurement = /采购|购买|订购|下单|补货|procure|purchase|replenish/i.test(terms);
  const risk = /风险|异常|检验|状态|监控|quality|risk/i.test(terms);
  const marketing = /市场|渠道|销量|订单|投诉|客户|门店|零售|店员|sku|store|retail|market|order|complaint/i.test(terms);
  const internal = /内务|预算|合同|报销|人事|供应商|财务|审批|budget|contract|supplier/i.test(terms);
  const production = /生产|原料|批次|工艺|设备|库存|维生素|production|batch|inventory/i.test(terms);
  const businessIds = extractQueryBusinessIds(input);
  const relevant = context.graph.nodes.filter((node) => businessIds.length ? matchingQueryBusinessIds({ id: node.id, label: node.label }, businessIds).length : procurement
    ? ['raw', 'stock', 'risk'].includes(node.id)
    : risk ? ['raw', 'test', 'risk', 'pb1', 'pb2'].includes(node.id)
      : marketing ? ['store', 'order', 'risk'].includes(node.id)
        : internal ? ['supplier', 'risk'].includes(node.id)
          : production ? ['raw', 'stock', 'pb1', 'pb2', 'risk'].includes(node.id)
            : false).slice(0, 5);
  return {
    contextId: `semctx-${roleId}-${Date.now()}`,
    engine: context.engine.name,
    facts: relevant.map((node) => ({ id: node.id, type: node.type, label: node.label, statement: node.sub, classification: node.sensitivity, tenantId: node.tenantId, organizationId: node.organizationId, provenance: node.provenance })),
    relations: context.graph.relations.filter((relation) => relevant.some((node) => node.id === relation.source) && relevant.some((node) => node.id === relation.target)).slice(0, 6),
    policy: '演示投影按租户、角色及组织过滤，只说明演示关系，不证明当前业务事实；写入必须重新读取权威源。'
  };
  });
}

export function recordSemanticDecision({ role, identityScope, runId, input, route, evidence = [], outcome = '生成受控业务建议' }) {
  const inputFingerprint = createHash('sha256').update(String(input || '')).digest('hex').slice(0, 20);
  const record = {
    id: `dec-agent-${runId || Date.now()}`, roleId: role?.id, category: 'agent_recommendation', status: 'recorded', time: now(),
    actor: role?.name || '智脑', subject: route?.primaryDomain || 'cross-domain', outcome,
    evidence: evidence.slice(0, 8).map((item) => item.id || item.source || String(item)),
    provenance: ['智脑', 'Semantic Context Service'], classification: '受控决策记录', inputSummary: `[业务输入已脱敏 · ${inputFingerprint}]`, inputFingerprint
  };
  const key = decisionKey(identityScope);
  if (!key) return { id: record.id, status: 'not_recorded_missing_identity' };
  return mutateSemanticGovernanceState('semantic_decisions', key, [], (records) => ({ value: [record, ...records.filter((item) => item.id !== record.id)].slice(0, 60), result: record }));
}

import { createHash } from 'node:crypto';
import { mutateState, readState } from '../../repositories/runtime-state-repository.js';
import { semanticTenantStateKey } from '../../services/semantic-tenant-context.js';
import { discoverMockWorkflowDefinitions, listMockWorkflowInstances, MOCK_WORKFLOW_CONNECTOR_CAPABILITIES } from './mock-workflow-connector.js';
import { discoverConfiguredWorkflowDefinitions } from './configured-workflow-connector.js';
import { workflowWebhookOperations } from './workflow-webhook-service.js';

export const WORKFLOW_INTEGRATION_BOUNDARY = Object.freeze({
  authority: 'external_workflow_engine', mode: 'read_only',
  rule: '流程结构由连接器确定性读取；模型只生成语义建议。未发布候选版本不得进入智脑读取面，任何审批或提交动作均不在本边界内。'
});

const NAMESPACE = 'workflow_integration';
const now = () => new Date().toISOString();
const clone = value => structuredClone(value);
const stateKey = () => semanticTenantStateKey('workspace');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const structuralPayload = definition => ({
  nodes: definition.nodes, edges: definition.edges, fields: definition.fields, bindings: definition.bindings,
  processType: definition.processType, systems: definition.systems, crossSystemHandoffs: definition.crossSystemHandoffs
});
const processTypeLabel = value => ({
  internal_affairs: '内部事务', procurement: '采购供应', production_manufacturing: '生产制造',
  logistics: '物流履约', quality: '质量管理', sales: '销售履约', finance: '财务管理'
})[value] || value || '未分类';

const summarizeDiff = (previous, current) => {
  if (!previous) return { kind: 'new', breaking: true, summary: '发现新的流程定义，需要校对业务对象映射和读取权限。', changes: ['新增流程定义'] };
  const changes = [];
  const previousNodes = new Map(previous.nodes.map(item => [item.id, item]));
  const currentNodes = new Map(current.nodes.map(item => [item.id, item]));
  for (const node of current.nodes) {
    if (!previousNodes.has(node.id)) changes.push(`新增节点：${node.label}`);
    else if (fingerprint(previousNodes.get(node.id)) !== fingerprint(node)) changes.push(`节点规则变化：${node.label}`);
  }
  for (const node of previous.nodes) if (!currentNodes.has(node.id)) changes.push(`删除节点：${node.label}`);
  const previousFields = new Map(previous.fields.map(item => [item.id, item]));
  for (const field of current.fields) {
    if (!previousFields.has(field.id)) changes.push(`新增${field.required ? '必填' : '可选'}字段：${field.label}`);
    else if (fingerprint(previousFields.get(field.id)) !== fingerprint(field)) changes.push(`字段定义变化：${field.label}`);
  }
  for (const field of previous.fields) if (!current.fields.some(item => item.id === field.id)) changes.push(`删除字段：${field.label}`);
  if (fingerprint(previous.edges) !== fingerprint(current.edges)) changes.push('分支或流转条件发生变化');
  if (previous.processType !== current.processType) changes.push(`流程类别变化：${processTypeLabel(previous.processType)} → ${processTypeLabel(current.processType)}`);
  if (fingerprint(previous.systems || []) !== fingerprint(current.systems || [])) changes.push('参与系统范围发生变化');
  if (fingerprint(previous.crossSystemHandoffs || []) !== fingerprint(current.crossSystemHandoffs || [])) changes.push('跨系统交接规则发生变化');
  const breaking = changes.some(item => /删除|必填|规则|条件/u.test(item));
  return { kind: 'updated', breaking, summary: changes.length ? `检测到 ${changes.length} 项结构变化。` : '仅来源版本发生变化。', changes };
};

const candidateFrom = (definition, previous = null, discoveredAt = now()) => {
  const diff = summarizeDiff(previous, definition);
  return {
    ...clone(definition), fingerprint: fingerprint(structuralPayload(definition)), discoveredAt,
    reviewStatus: previous ? 'review_required' : 'published',
    publicationStatus: previous ? 'candidate' : 'published',
    semanticSummary: {
      purpose: definition.purpose,
      affectedObjects: definition.bindings.map(item => item.objectType),
      allowedActions: ['read_definition', 'read_instance', 'explain_status'],
      prohibitedActions: ['approve', 'reject', 'submit', 'withdraw'],
      generatedBy: 'deterministic_mock_fixture'
    },
    validation: {
      status: definition.nodes.length && definition.edges.length && definition.fields.every(field => field.semanticTarget) ? 'passed' : 'failed',
      checks: [
        { id: 'graph', label: '流程图结构完整', passed: definition.nodes.length > 1 && definition.edges.length > 0 },
        { id: 'mapping', label: '字段具备语义映射', passed: definition.fields.every(field => field.semanticTarget) },
        { id: 'execution-boundary', label: '只读执行边界', passed: true }
      ]
    },
    diff
  };
};

const initialWorkspace = () => {
  const discoveredAt = now();
  const remote = discoverMockWorkflowDefinitions();
  return {
    schemaVersion: 1,
    providers: [
      { id: 'dingtalk', name: '钉钉审批', status: 'connected_mock', capabilities: MOCK_WORKFLOW_CONNECTOR_CAPABILITIES, syncModes: ['event', 'scheduled', 'manual'], cursor: remote.providerCursor, lastSyncAt: discoveredAt },
      { id: 'oa', name: '企业 OA / BPM', status: 'connected_mock', capabilities: MOCK_WORKFLOW_CONNECTOR_CAPABILITIES, syncModes: ['event', 'scheduled', 'manual'], cursor: remote.providerCursor, lastSyncAt: discoveredAt }
    ],
    definitions: remote.definitions.map(item => ({ code: item.code, activeVersion: item.version, versions: [candidateFrom(item, null, discoveredAt)] })),
    instances: listMockWorkflowInstances(),
    syncRuns: [{ id: 'sync-initial', mode: 'bootstrap', status: 'succeeded', discovered: remote.definitions.length, changed: 0, reviewRequired: 0, startedAt: discoveredAt, completedAt: discoveredAt }],
    lastSyncAt: discoveredAt
  };
};

const readWorkspace = () => readState(NAMESPACE, stateKey(), initialWorkspace);
const activeVersionOf = record => record.versions.find(version => version.version === record.activeVersion && version.publicationStatus === 'published') || null;
const publishedVersionOf = (record, version) => record?.versions.find(item => item.version === version && item.publicationStatus === 'published') || null;
const latestVersionOf = record => record.versions[0] || null;
const instanceProviderOf = (workspace, instance) => {
  if (typeof instance.provider === 'string' && instance.provider) return instance.provider;
  const record = workspace.definitions.find(item => item.code === instance.definitionCode);
  return record?.versions.find(item => item.version === instance.definitionVersion)?.provider || null;
};

export function getWorkflowIntegrationOverview() {
  const workspace = readWorkspace();
  const definitions = workspace.definitions.map(record => {
    const latest = latestVersionOf(record);
    return {
      code: record.code, name: latest.name, provider: latest.provider, category: latest.category,
      processType: latest.processType || 'unclassified', processTypeLabel: processTypeLabel(latest.processType),
      systems: clone(latest.systems || [latest.provider]), crossSystem: (latest.systems || []).length > 1,
      businessDomain: latest.businessDomain, riskLevel: latest.riskLevel, dataClassification: latest.dataClassification,
      activeVersion: record.activeVersion, latestVersion: latest.version, reviewStatus: latest.reviewStatus,
      publicationStatus: latest.publicationStatus, nodeCount: latest.nodes.length, fieldCount: latest.fields.length,
      instanceCount: workspace.instances.filter(instance => instance.definitionCode === record.code).length,
      changed: latest.version !== record.activeVersion, updatedAt: latest.updatedAt, diff: latest.diff
    };
  });
  return {
    boundary: WORKFLOW_INTEGRATION_BOUNDARY, providers: clone(workspace.providers), definitions,
    metrics: {
      definitions: definitions.length, published: definitions.filter(item => item.activeVersion !== null).length,
      reviewRequired: definitions.filter(item => item.reviewStatus === 'review_required').length,
      runningInstances: workspace.instances.filter(item => item.status === 'running').length,
      crossSystemDefinitions: definitions.filter(item => item.crossSystem).length,
      processTypes: Object.fromEntries([...new Set(definitions.map(item => item.processType))].map(type => [type, definitions.filter(item => item.processType === type).length]))
    },
    syncPolicy: {
      realTime: { enabled: true, mode: 'signed_webhook', description: '来源系统变更通知触发受控增量拉取' },
      scheduled: { enabled: true, mode: 'incremental_reconciliation', intervalSeconds: Math.max(60, Number(process.env.WORKFLOW_SYNC_INTERVAL_MS) / 1000 || 300), description: '定时对账修复漏事件与上游差异' },
      manual: { enabled: true, mode: 'operator_triggered', permission: 'meta_model.draft.save', description: '运营人员可在流程语义中心立即发起同步' }
    },
    webhookInbox: workflowWebhookOperations.overview(),
    lastSyncAt: workspace.lastSyncAt, syncRuns: clone(workspace.syncRuns.slice(0, 10))
  };
}

export function getWorkflowDefinition(code, { identityScope = {} } = {}) {
  const workspace = readWorkspace();
  const record = workspace.definitions.find(item => item.code === code);
  if (!record) return { error: '未找到当前租户可见的流程定义。', code: 'WORKFLOW_DEFINITION_NOT_FOUND', status: 404 };
  const latest = latestVersionOf(record);
  return {
    definition: clone(latest), activeVersion: record.activeVersion,
    versionHistory: record.versions.map(item => ({ version: item.version, publicationStatus: item.publicationStatus, reviewStatus: item.reviewStatus, discoveredAt: item.discoveredAt, fingerprint: item.fingerprint })),
    instances: workspace.instances.filter(instance => instance.definitionCode === code).flatMap(instance => {
      const definition = record.versions.find(item => item.version === instance.definitionVersion);
      return definition ? [visibleInstance(instance, definition, identityScope)] : [];
    }),
    authority: { source: latest.provider, sourceId: latest.sourceId, sourceVersion: latest.version, observedAt: latest.discoveredAt }
  };
}

const applyRemoteWorkflowSnapshot = ({ remote, scenario, actor, mode }) => {
  return mutateState(NAMESPACE, stateKey(), initialWorkspace, workspace => {
    const startedAt = now();
    let discovered = 0;
    let changed = 0;
    let unchanged = 0;
    const remoteCodes = new Set(remote.definitions.map(item => item.code));
    const observedProviders = new Set(remote.providers?.map(item => item.id) || remote.definitions.map(item => item.provider));
    const observedInstanceProviders = new Set(remote.instanceProvidersIncluded || (remote.instancesIncluded ? observedProviders : []));
    for (const definition of remote.definitions) {
      const record = workspace.definitions.find(item => item.code === definition.code);
      if (!record) {
        workspace.definitions.push({ code: definition.code, activeVersion: null, versions: [{ ...candidateFrom(definition, { nodes: [], edges: [], fields: [], bindings: [] }, startedAt), diff: summarizeDiff(null, definition) }] });
        discovered += 1;
        continue;
      }
      const latest = latestVersionOf(record);
      const incomingFingerprint = fingerprint(structuralPayload(definition));
      if (latest.version === definition.version && latest.fingerprint === incomingFingerprint) { unchanged += 1; continue; }
      const known = record.versions.find(item => item.version === definition.version && item.fingerprint === incomingFingerprint);
      if (known) { unchanged += 1; continue; }
      const base = activeVersionOf(record) || latest;
      record.versions.unshift(candidateFrom(definition, base, startedAt));
      changed += 1;
    }
    for (const record of workspace.definitions) {
      const latest = latestVersionOf(record);
      if (observedProviders.has(latest.provider) && !remoteCodes.has(record.code)) {
        if (latest.sourceStatus !== 'retired') {
          record.versions.unshift({ ...clone(latest), version: `${latest.version}-retired`, sourceStatus: 'retired', publicationStatus: 'candidate', reviewStatus: 'review_required', discoveredAt: startedAt, diff: { kind: 'retired', breaking: true, summary: '来源系统不再返回该流程，需确认是否停用。', changes: ['来源流程疑似停用或删除'] } });
          changed += 1;
        }
      }
    }
    if (remote.instancesIncluded) {
      const retained = workspace.instances.filter(instance => !observedInstanceProviders.has(instanceProviderOf(workspace, instance)));
      workspace.instances = [...retained, ...clone(remote.instances || [])];
    }
    if (remote.providers?.length) {
      const retained = workspace.providers.filter(provider => !observedProviders.has(provider.id));
      workspace.providers = [...retained, ...remote.providers.map(provider => ({
        ...provider,
        capabilities: provider.capabilities || { definitionDiscovery: true, definitionVersions: true, formSchema: true, runtimeInstances: Boolean(remote.instancesIncluded), eventSubscription: false, incrementalCursor: true, writeActions: false },
        lastSyncAt: startedAt
      }))];
    } else {
      workspace.providers = workspace.providers.map(provider => ({ ...provider, cursor: typeof remote.providerCursor === 'object' ? remote.providerCursor[provider.id] || provider.cursor : remote.providerCursor, lastSyncAt: startedAt }));
    }
    workspace.lastSyncAt = startedAt;
    const run = { id: `sync-${Date.now()}`, mode, scenario, status: 'succeeded', discovered, changed, unchanged, reviewRequired: discovered + changed, actor: actor || { type: 'system', id: 'workflow-sync' }, startedAt, completedAt: now() };
    workspace.syncRuns.unshift(run);
    workspace.syncRuns = workspace.syncRuns.slice(0, 20);
    return { value: workspace, result: { syncRun: clone(run), overview: null } };
  });
};

export function syncWorkflowDefinitions({ scenario = 'baseline', actor = null, trigger = 'manual' } = {}) {
  if (!['baseline', 'changed'].includes(scenario)) return { error: '不支持的模拟同步场景。', code: 'WORKFLOW_SYNC_SCENARIO_INVALID', status: 400 };
  return applyRemoteWorkflowSnapshot({ remote: discoverMockWorkflowDefinitions({ scenario }), scenario, actor, mode: `${trigger}_${scenario === 'changed' ? 'incremental_reconciliation' : 'incremental'}` });
}

export async function syncConfiguredWorkflowDefinitions({ actor = null, trigger = 'scheduled', env = process.env, fetchImpl = globalThis.fetch } = {}) {
  try {
    const remote = await discoverConfiguredWorkflowDefinitions({ env, fetchImpl });
    return applyRemoteWorkflowSnapshot({ remote, scenario: 'configured_connectors', actor, mode: `${trigger}_configured_incremental` });
  } catch (error) {
    return { error: error.message || '真实流程连接器同步失败。', code: error.code || 'WORKFLOW_CONNECTOR_SYNC_FAILED', status: error.status || 502 };
  }
}

export function reviewWorkflowDefinition({ code, version, action, actor = null } = {}) {
  if (!['publish', 'reject'].includes(action)) return { error: '不支持的流程校对动作。', code: 'WORKFLOW_REVIEW_ACTION_INVALID', status: 400 };
  return mutateState(NAMESPACE, stateKey(), initialWorkspace, workspace => {
    const record = workspace.definitions.find(item => item.code === code);
    const candidate = record?.versions.find(item => item.version === version);
    if (!record || !candidate) return { commit: false, result: { error: '未找到待校对的流程版本。', code: 'WORKFLOW_VERSION_NOT_FOUND', status: 404 } };
    if (candidate.publicationStatus !== 'candidate') return { commit: false, result: { error: '该版本不是待发布候选版本。', code: 'WORKFLOW_VERSION_NOT_CANDIDATE', status: 409 } };
    candidate.reviewStatus = action === 'publish' ? 'approved' : 'rejected';
    candidate.publicationStatus = action === 'publish' ? 'published' : 'rejected';
    candidate.reviewedAt = now();
    candidate.reviewedBy = actor || { type: 'user', id: 'semantic-operator' };
    if (action === 'publish') record.activeVersion = candidate.version;
    return { value: workspace, result: { definition: clone(candidate), activeVersion: record.activeVersion } };
  });
}

const visibleInstance = (instance, definition, identityScope) => {
  const restrictedTimeline = (instance.timeline || []).map(event => ({
    id: event.id, nodeId: event.nodeId, label: event.label, action: event.action,
    actorDisplay: event.actorDisplay ? '受限角色' : undefined, occurredAt: event.occurredAt
  }));
  if (definition.category === 'business') {
    const roleId = identityScope?.roleId;
    const domainGrant = roleId === 'executive'
      || (roleId === 'procurement_manager' && /采购|供应商|供应链|物流|仓储|procurement|supplier|logistics|warehouse/iu.test(`${definition.businessDomain} ${definition.name}`))
      || (roleId === 'quality_manager' && /质量|检验|quality/iu.test(`${definition.businessDomain} ${definition.name}`))
      || (roleId === 'production_manager' && /生产|制造|物流|仓储|production|manufacturing|logistics|warehouse/iu.test(`${definition.businessDomain} ${definition.name}`))
      || (roleId === 'marketing_manager' && /市场|销售|订单|物流|履约|marketing|sales|logistics|fulfillment/iu.test(`${definition.businessDomain} ${definition.name}`));
    if (domainGrant) return clone(instance);
    return {
      ...clone(instance), applicantId: null, applicantName: '受限人员', amount: null,
      summary: '该业务流程正在处理中；申请人、金额、意见和参与人等受限字段已隐藏。',
      timeline: restrictedTimeline, redacted: true, redactionReason: 'workflow_field_scope'
    };
  }
  const own = identityScope?.subjectId && identityScope.subjectId === instance.applicantId;
  if (own) return clone(instance);
  return { ...clone(instance), title: `${definition.name}（个人信息已隐藏）`, applicantId: null, applicantName: '受限人员', amount: null, summary: '该管理流程正在处理中；个人敏感表单内容已隐藏。', timeline: restrictedTimeline, redacted: true, redactionReason: 'workflow_personal_scope' };
};

const queryTerms = value => {
  const normalized = String(value || '').trim().toLowerCase();
  const ids = normalized.match(/\b[a-z][a-z0-9_]*(?:-[a-z0-9_]+)+\b/gu) || [];
  const prose = normalized
    .replace(/\b[a-z][a-z0-9_]*(?:-[a-z0-9_]+)+\b/gu, ' ')
    .replace(/(?:麻烦|请问|帮我|查询|查看|说明|分析|一下|现在|当前|这个|那个|流程|审批|进度|节点|状态|记录|历史|轨迹|流转|经过|谁审批过|到哪(?:一)?步|是什么|怎么样|有哪些|所有|列表|目录|的)/gu, ' ');
  const words = prose.split(/[\s,，。！？?、:：;；/\\()[\]{}]+/u).map(item => item.trim()).filter(item => item.length >= 2);
  return { normalized, ids, words, catalog: /(?:有哪些|所有流程|流程列表|流程目录|有什么流程)/u.test(normalized) };
};

const matchesTerms = (values, terms) => {
  const haystack = values.map(value => String(value || '').toLowerCase()).join(' ');
  if (terms.ids.some(id => haystack.includes(id))) return true;
  if (terms.normalized.length >= 2 && haystack.includes(terms.normalized)) return true;
  return terms.words.length > 0 && terms.words.every(word => haystack.includes(word));
};

const requestedProcessTypes = query => {
  const text = String(query || '').toLowerCase();
  return [
    [/(?:内部事务|人事|请假|入职)/u, 'internal_affairs'],
    [/(?:采购|供应商|供应链)/u, 'procurement'],
    [/(?:生产|制造|投产|工单|mes)/iu, 'production_manufacturing'],
    [/(?:物流|运输|运单|出库|tms)/iu, 'logistics']
  ].filter(([pattern]) => pattern.test(text)).map(([, type]) => type);
};

export function queryPublishedWorkflowContext({ query = '', identityScope = {} } = {}) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) return { error: '请输入流程名称、实例编号或业务编号。', code: 'WORKFLOW_QUERY_REQUIRED', status: 400 };
  const workspace = readWorkspace();
  const terms = queryTerms(normalized);
  const typeFilter = requestedProcessTypes(normalized);
  const definitions = workspace.definitions.flatMap(record => {
    const active = activeVersionOf(record);
    if (active && typeFilter.length && !typeFilter.includes(active.processType)) return [];
    if (!active || (!terms.catalog && !matchesTerms([active.code, active.name, active.purpose, active.businessDomain, active.provider, active.processType, processTypeLabel(active.processType), ...(active.systems || [])], terms))) return [];
    return [{
      code: active.code, name: active.name, provider: active.provider, version: active.version, category: active.category,
      processType: active.processType || 'unclassified', processTypeLabel: processTypeLabel(active.processType),
      businessDomain: active.businessDomain, purpose: active.purpose, systems: clone(active.systems || [active.provider]),
      crossSystemHandoffs: clone(active.crossSystemHandoffs || []), semanticSummary: clone(active.semanticSummary)
    }];
  }).slice(0, 10);
  const matches = workspace.instances.filter(instance => {
    const record = workspace.definitions.find(item => item.code === instance.definitionCode);
    const published = publishedVersionOf(record, instance.definitionVersion);
    if (!published) return false;
    return matchesTerms([instance.id, instance.businessKey, instance.title, published.code, published.name, published.businessDomain, published.provider, published.processType, processTypeLabel(published.processType), ...(published.systems || [])], terms);
  }).slice(0, 10).map(instance => {
    const record = workspace.definitions.find(item => item.code === instance.definitionCode);
    const definition = publishedVersionOf(record, instance.definitionVersion);
    const currentNode = definition.nodes.find(node => node.id === instance.currentNodeId);
    return {
      ...visibleInstance(instance, definition, identityScope), definition: {
        code: definition.code, name: definition.name, version: definition.version, category: definition.category,
        processType: definition.processType || 'unclassified', processTypeLabel: processTypeLabel(definition.processType),
        systems: clone(definition.systems || [definition.provider]), crossSystemHandoffs: clone(definition.crossSystemHandoffs || [])
      },
      currentNode: currentNode ? { id: currentNode.id, label: currentNode.label, type: currentNode.type } : null,
      evidence: { sourceSystem: definition.provider, sourceDefinitionId: definition.sourceId, sourceVersion: definition.version, observedAt: workspace.lastSyncAt }
    };
  });
  return { query: String(query).slice(0, 240), readOnly: true, stale: false, lastSyncAt: workspace.lastSyncAt, definitions, matches };
}

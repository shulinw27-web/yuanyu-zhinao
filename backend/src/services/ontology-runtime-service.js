import { createHash } from 'node:crypto';
import { getMetaModel, getOAMetaModelDraft, getPublishedOntologyModel, publishOAMetaModel } from './meta-model-service.js';
import { replayDecisionCases } from './decision-binding-service.js';
import { semanticFingerprint } from './semantic-model-fingerprint.js';
import { mutateSemanticGovernanceState, readSemanticGovernanceState } from './semantic-governance-store.js';
import { publishSemanticaModelDefinition, getSemanticaModelDeployment } from './semantica-demo-bridge-service.js';
import { executeOntologyReadPlan } from './ontology-read-plan-service.js';
import { currentSemanticTenant, currentSemanticModel, currentSemanticModelRegistered, DEFAULT_SEMANTIC_MODEL_ID } from './semantic-tenant-context.js';
import { semanticModelRegistry } from './semantic-model-registry.js';

const modelInstanceMatches = (receipt, modelId, tenantId, target = null) => receipt?.modelId === modelId
  && receipt.projectionScope === 'definition_only' && receipt.runtimeReadEnabled === false
  && receipt.instance?.identityVerified === true && receipt.instance.protocol === 1 && receipt.instance.modelProtocol === 1
  && receipt.instance.modelId === modelId && receipt.instance.tenantId === tenantId
  && typeof receipt.instance.deploymentId === 'string' && receipt.instance.deploymentId.length > 0
  && (!target || receipt.instance.deploymentId === target.deploymentId && receipt.instance.tenantId === target.tenantId && receipt.instance.modelId === target.modelId);

async function registeredWorkspace(role, identityScope, modelId) {
  if (modelId === DEFAULT_SEMANTIC_MODEL_ID) return true;
  if (!currentSemanticModelRegistered()) return false;
  const registry = await semanticModelRegistry.list({ role, identityScope });
  return !registry.error && registry.models.some(item => item.id === modelId && item.lifecycle === 'registered');
}

export async function runOntologyReadReplay({ body, role, identityScope }) {
  const key = principal(identityScope);
  if (!key || role?.id !== 'executive') return { error: '没有只读计算发布回放权限。', code: 'REPLAY_FORBIDDEN' };
  const draft = await getOAMetaModelDraft(); const candidateFingerprint = semanticFingerprint(draft);
  const plans = draft.scenario?.readPlans || [];
  if (body?.candidateFingerprint !== candidateFingerprint) return { error: '草稿已变更，重新载入再回放。', code: 'REPLAY_DRAFT_STALE' };
  if (!plans.length || !Array.isArray(body.cases) || body.cases.length > 24 || body.cases.length < 2
    || body.cases.some(c => !c || typeof c.target !== 'string' || !Array.isArray(c.records) || c.records.length > 500)) return { error: '每个计算方案至少提供正例及缺失/冲突反例；每例最多500条授权记录。', code: 'READ_REPLAY_CASES_INVALID' };
  const rows = [];
  for (const item of body.cases) {
    const plan = plans.find(p => p.id === item.planId);
    if (!plan) return { error: '回放引用不存在的方案。', code: 'READ_REPLAY_PLAN_UNKNOWN' };
    try {
      const actual = await executeOntologyReadPlan({ draft, plan, target: item.target, roleId: role.id, scope: identityScope,
        retrieve: async (type, query) => item.records.filter(r => r.objectType === type.id && query.filter.values.includes(r.payload?.[query.filter.field])) });
      const values = Object.fromEntries(actual.results.map(r => [r.id, r.value]));
      const passed = !item.expectedError && item.expected && Object.keys(values).length === Object.keys(item.expected).length && Object.entries(values).every(([id, value]) => item.expected[id] === value);
      rows.push({ planId: plan.id, kind: 'positive', status: passed ? 'passed' : 'failed', actual: values });
    } catch (error) {
      const allowedErrors = ['READ_ROOT_NOT_FOUND', 'READ_LOOKUP_NOT_UNIQUE', 'READ_RECORD_CONFLICT', 'READ_RECORD_SCOPE', 'READ_REQUIRED_FIELD', 'READ_EXPECTED_SINGLE_RECORD', 'READ_PRECONDITION_FAILED', 'READ_GRAPH_CYCLE', 'READ_DANGLING_EDGE', 'READ_EDGE_STATE_UNKNOWN', 'READ_EXPANSION_DEPTH_LIMIT', 'READ_MAPPING_MISSING', 'READ_MAPPING_UNCONFIRMED', 'READ_MAPPING_CONFLICT', 'READ_MAPPING_EXPIRED', 'READ_MAPPING_VERSION_MISMATCH', 'READ_MAPPING_TIME_INVALID', 'READ_MAPPING_TARGET_MISSING', 'READ_MAPPING_TARGET_INVALID', 'READ_MAPPING_SOURCE_MISSING'];
      const diagnosticErrors = [...allowedErrors, 'READ_NOT_NUMERIC', 'READ_NOT_BOOLEAN', 'READ_COMPUTATION_LIMIT', 'READ_OUTPUT_INVALID', 'READ_FIELD_TYPE', 'READ_FIELD_VALUE'];
      rows.push({ planId: plan.id, kind: 'negative', status: allowedErrors.includes(error.message) && error.message === item.expectedError ? 'passed' : 'failed', code: diagnosticErrors.includes(error.message) ? error.message : 'READ_REPLAY_FAILED' });
    }
  }
  const coverage = plans.every(p => ['positive', 'negative'].every(kind => rows.some(r => r.planId === p.id && r.kind === kind && r.status === 'passed')));
  const report = { status: coverage && rows.every(r => r.status === 'passed') ? 'passed' : 'failed', candidateFingerprint,
    readPlanIds: plans.map(p => p.id), results: rows, source: 'user_supplied_scoped_read_cases', rawRecordsStored: false, createdAt: new Date().toISOString() };
  await mutateSemanticGovernanceState('ontology_case_replay', key, null, () => ({ value: report, result: null }));
  return report;
}

const principal = (scope) => scope?.tenantId && scope?.subjectId ? createHash('sha256').update(JSON.stringify([scope.tenantId, scope.subjectId])).digest('hex') : null;
const allowed = (role) => ['executive', 'quality_manager', 'production_manager', 'procurement_manager', 'marketing_manager'].includes(role?.id);
export async function runOntologyCaseReplay({ body, role, identityScope }) {
  if (body?.mode === 'ontology-read') return runOntologyReadReplay({ body, role, identityScope });
  const key = principal(identityScope);
  if (!key || !allowed(role)) return { error: '没有场景回放权限。', code: 'REPLAY_FORBIDDEN' };
  const candidate = await getOAMetaModelDraft(); const published = await getPublishedOntologyModel();
  if (body?.candidateFingerprint !== semanticFingerprint(candidate)) return { error: '草稿已更新，请刷新后重新回放。', code: 'REPLAY_DRAFT_STALE' };
  const report = replayDecisionCases({ candidate, baseline: published?.draft, cases: body.cases, roleId: role.id, identityScope });
  const result = { ...report, candidateFingerprint: semanticFingerprint(candidate), baselineVersion: published?.version || null, createdAt: new Date().toISOString(),
    source: 'user_supplied_scoped_cases', rawRecordsStored: false };
  // Keep only outcomes and version references, not uploaded corporate records.
  await mutateSemanticGovernanceState('ontology_case_replay', key, null, () => ({ value: result, result: null }));
  return result;
}

export async function getOntologyCaseReplay({ role, identityScope }) {
  const key = principal(identityScope);
  return key && allowed(role) ? await readSemanticGovernanceState('ontology_case_replay', key, null) : null;
}

// Durable operation identity + reconciliation: an uncertain response is never a new publish.
export async function publishGovernedOntology({ role, identityScope, expectedFingerprint, beforeDispatch, deploy = publishSemanticaModelDefinition, inspect = getSemanticaModelDeployment }) {
  if (role?.id !== 'executive' || !principal(identityScope)) return { error: '没有发布权限或身份不完整。', code: 'PUBLICATION_FORBIDDEN' };
  if (expectedFingerprint !== undefined && (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{24}$/u.test(expectedFingerprint))
    || beforeDispatch !== undefined && typeof beforeDispatch !== 'function') return { error: '发布指纹或服务端复验配置无效。', code: 'PUBLICATION_INPUT_INVALID', status: 400 };
  const modelId = currentSemanticModel(); const namespaced = modelId !== DEFAULT_SEMANTIC_MODEL_ID;
  if (identityScope.tenantId !== currentSemanticTenant() || !await registeredWorkspace(role, identityScope, modelId)) return { error: '身份与当前注册工作区不一致，未发送发布请求。', code: 'PUBLICATION_WORKSPACE_FORBIDDEN' };
  const candidate = await getMetaModel('oa-governance');
  if (candidate?.status === 'published') return { error: '当前版本已发布，不重复提交独立服务。', code: 'PUBLICATION_ALREADY_COMPLETED' };
  if (candidate?.simulation?.validation?.status !== 'passed') return { error: '先完成草稿校验与模拟构建。', code: 'PUBLICATION_NOT_VALIDATED' };
  const fingerprint = semanticFingerprint(candidate);
  if (expectedFingerprint !== undefined && expectedFingerprint !== fingerprint) return { error: '请求所确认的草稿已改变，未发送发布请求。', code: 'PUBLICATION_DRAFT_STALE', status: 409 };
  if (candidate.scenario?.requireCaseReplay) {
    const report = await getOntologyCaseReplay({ role, identityScope });
    if (report?.status !== 'passed' || report.candidateFingerprint !== fingerprint) return { error: '本场景要求发布人完成待部署版本的案例回放。', code: 'PUBLICATION_REPLAY_REQUIRED' };
    if ((candidate.scenario.readPlans || []).some(p => !report.readPlanIds?.includes(p.id))) return { error: '尚未完成全部关联计算方案的正反例回放。', code: 'PUBLICATION_READ_REPLAY_REQUIRED' };
  }
  if (semanticFingerprint(await getOAMetaModelDraft()) !== fingerprint) return { error: '草稿已变更，请重新校验当前版本。', code: 'PUBLICATION_DRAFT_STALE' };
  const operation = await mutateSemanticGovernanceState('ontology_publication', 'current', null, (current) => {
    if (current?.status === 'publishing' && Date.now() - Date.parse(current.startedAt) < 30000) return { commit: false, result: { error: '已有发布正在执行，请稍后检查部署状态。', code: 'PUBLICATION_BUSY' } };
    if (current?.status === 'publishing') current.status = 'reconciliation_required';
    if (current?.status === 'reconciliation_required' && current.fingerprint !== fingerprint) return { commit: false, result: { error: '上一发布结果不确定，先恢复原草稿并对账，不能提交不同版本。', code: 'PUBLICATION_RECONCILIATION_REQUIRED' } };
    const retry = current?.status === 'reconciliation_required';
    const next = { fingerprint, version: retry ? current.version : `mm-${Date.now()}-${fingerprint.slice(0, 8)}`, status: 'publishing', startedAt: new Date().toISOString(), retry,
      ...(namespaced ? { modelId, target: retry ? current.target : null } : {}) };
    return { value: next, result: next };
  });
  if (operation.error) return operation;
  const finalize = async (status, result) => {
    await mutateSemanticGovernanceState('ontology_publication', 'current', null, (current) => {
      if (current?.version !== operation.version || current.startedAt !== operation.startedAt || current.status !== 'publishing') return { commit: false, result: null };
      return { value: { ...current, status, completedAt: new Date().toISOString() }, result: null };
    });
    return result;
  };
  try {
    let semanticDeployment;
    let observed;
    if (namespaced) {
      observed = await inspect();
      if (!modelInstanceMatches(observed, modelId, identityScope.tenantId, operation.retry ? operation.target : null)
        || !['published', 'not_published'].includes(observed.status) || operation.retry && !operation.target) {
        return finalize(operation.retry ? 'reconciliation_required' : 'not_attempted', { error: '独立模型预检回执或部署归属不一致，未重复写入。', code: operation.retry ? 'PUBLICATION_RECONCILIATION_REQUIRED' : 'PUBLICATION_NOT_ATTEMPTED' });
      }
      if (!operation.retry) {
        const baseline = await getPublishedOntologyModel();
        if (observed.status === 'published' && (!baseline || observed.sourceFingerprint !== baseline.fingerprint || observed.version !== baseline.version)
          || observed.status === 'not_published' && baseline) {
          return finalize('not_attempted', { error: '独立模型部署与本地已发布基线不一致，请先核对；未覆盖远端定义。', code: 'PUBLICATION_DEPLOYMENT_DRIFT' });
        }
        operation.target = { tenantId: observed.instance.tenantId, deploymentId: observed.instance.deploymentId, modelId };
        const bound = await mutateSemanticGovernanceState('ontology_publication', 'current', null, current => {
          if (current?.version !== operation.version || current.startedAt !== operation.startedAt || current.status !== 'publishing') return { commit: false, result: false };
          return { value: { ...current, target: operation.target }, result: true };
        });
        if (!bound) return { error: '发布锁已变更，未发送定义。', code: 'PUBLICATION_BUSY' };
      }
    }
    if (operation.retry) {
      observed ||= await inspect(); const deployed = observed?.deployment || observed;
      if (deployed?.status === 'published' && deployed.sourceFingerprint === fingerprint && deployed.version === operation.version) semanticDeployment = { status: 'published', deployment: deployed, ...(namespaced ? { instance: observed.instance } : {}), reconciled: true };
      else return finalize('reconciliation_required', { error: '独立服务未确认相同模型指纹；保留不确定状态，不自动重复写入。', code: 'PUBLICATION_RECONCILIATION_REQUIRED' });
    } else {
      if (namespaced && (!await registeredWorkspace(role, identityScope, modelId) || semanticFingerprint(await getOAMetaModelDraft()) !== fingerprint)) {
        return finalize('not_attempted', { error: '预检期间工作区或草稿已变更，未发送模型定义。', code: 'PUBLICATION_DRAFT_STALE' });
      }
      const recheck = phase => beforeDispatch?.({ phase, modelId, fingerprint, version: operation.version });
      try { await recheck('prepare'); }
      catch { return finalize('not_attempted', { error: '发布前复验未通过，未发送模型定义。', code: 'PUBLICATION_DISPATCH_DENIED', status: 403 }); }
      semanticDeployment = await deploy(candidate, operation.version, { ...(namespaced ? { expectedDeployment: observed } : {}),
        ...(beforeDispatch ? { beforeDispatch: () => recheck('dispatch') } : {}) });
    }
    if (!operation.retry && semanticDeployment?.requestAttempted === false && semanticDeployment.status === 'unavailable'
      && ['bridge_disabled', 'unsafe_endpoint', 'tenant_endpoint_required', 'tenant_config_invalid', 'instance_identity_unverified', 'service_unavailable', 'model_namespace_unsupported', 'model_workspace_unregistered', 'model_deployment_unverified'].includes(semanticDeployment.reason)) {
      return finalize('not_attempted', { error: '独立服务未配置或地址不被允许，尚未发送发布请求；配置完成后可重新发布。', code: 'PUBLICATION_NOT_ATTEMPTED' });
    }
    if (semanticDeployment?.status !== 'published' || semanticDeployment.deployment?.sourceFingerprint !== fingerprint || semanticDeployment.deployment?.version !== operation.version) return finalize('reconciliation_required', { error: '尚未取得匹配模型指纹和版本的独立服务回执。', code: 'PUBLICATION_RECEIPT_UNCONFIRMED' });
    if (namespaced && (!modelInstanceMatches({ ...semanticDeployment.deployment, instance: semanticDeployment.instance }, modelId, identityScope.tenantId, operation.target)
      || semanticDeployment.deployment.id !== candidate.id || !/^[a-f0-9]{20}$/.test(semanticDeployment.deployment.fingerprint)
      || !await registeredWorkspace(role, identityScope, modelId))) return finalize('reconciliation_required', { error: '模型或部署回执不一致，未启用业务运行。', code: 'PUBLICATION_RECEIPT_UNCONFIRMED' });
    if (beforeDispatch) {
      try { await beforeDispatch({ phase: 'commit', modelId, fingerprint, version: operation.version }); }
      catch { return finalize('reconciliation_required', { error: '远端结果取得后复验未通过，保持待对账，未登记本地发布成功。', code: 'PUBLICATION_AUTHORITY_CHANGED', status: 409 }); }
    }
    const lock = await readSemanticGovernanceState('ontology_publication', 'current', null);
    if (lock?.version !== operation.version || lock.startedAt !== operation.startedAt || lock.status !== 'publishing') return { error: '发布执行权已变更，旧执行器不能登记或覆盖新状态。', code: 'PUBLICATION_BUSY' };
    const result = await publishOAMetaModel(role, { version: semanticDeployment.deployment.version || operation.version, expectedFingerprint: fingerprint, tenantId: identityScope.tenantId });
    return finalize(result.error ? 'reconciliation_required' : 'completed', { ...result, semanticDeployment });
  } catch {
    return finalize('reconciliation_required', { error: '发布响应不确定；下次只查询相同版本回执，不自动重新发布。', code: 'PUBLICATION_OUTCOME_UNKNOWN' });
  }
}

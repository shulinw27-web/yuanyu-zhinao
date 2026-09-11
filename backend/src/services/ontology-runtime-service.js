import { createHash } from 'node:crypto';
import { getMetaModel, getOAMetaModelDraft, getPublishedOntologyModel, publishOAMetaModel } from './meta-model-service.js';
import { replayDecisionCases } from './decision-binding-service.js';
import { semanticFingerprint } from './semantic-model-fingerprint.js';
import { mutateSemanticGovernanceState, readSemanticGovernanceState } from './semantic-governance-store.js';
import { publishSemanticaModelDefinition, getSemanticaModelDeployment } from './semantica-demo-bridge-service.js';
import { executeOntologyReadPlan } from './ontology-read-plan-service.js';

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
      const allowedErrors = ['READ_ROOT_NOT_FOUND', 'READ_LOOKUP_NOT_UNIQUE', 'READ_RECORD_CONFLICT', 'READ_RECORD_SCOPE', 'READ_REQUIRED_FIELD', 'READ_EXPECTED_SINGLE_RECORD', 'READ_PRECONDITION_FAILED', 'READ_GRAPH_CYCLE', 'READ_DANGLING_EDGE', 'READ_EDGE_STATE_UNKNOWN', 'READ_EXPANSION_DEPTH_LIMIT'];
      rows.push({ planId: plan.id, kind: 'negative', status: allowedErrors.includes(error.message) && error.message === item.expectedError ? 'passed' : 'failed', code: allowedErrors.includes(error.message) ? error.message : 'READ_REPLAY_FAILED' });
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
export async function publishGovernedOntology({ role, identityScope, deploy = publishSemanticaModelDefinition, inspect = getSemanticaModelDeployment }) {
  if (role?.id !== 'executive' || !principal(identityScope)) return { error: '没有发布权限或身份不完整。', code: 'PUBLICATION_FORBIDDEN' };
  const candidate = await getMetaModel('oa-governance');
  if (candidate?.status === 'published') return { error: '当前版本已发布，不重复提交独立服务。', code: 'PUBLICATION_ALREADY_COMPLETED' };
  if (candidate?.simulation?.validation?.status !== 'passed') return { error: '先完成草稿校验与模拟构建。', code: 'PUBLICATION_NOT_VALIDATED' };
  const fingerprint = semanticFingerprint(candidate);
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
    const next = { fingerprint, version: retry ? current.version : `mm-${Date.now()}-${fingerprint.slice(0, 8)}`, status: 'publishing', startedAt: new Date().toISOString(), retry };
    return { value: next, result: next };
  });
  if (operation.error) return operation;
  const finalize = async (status, result) => {
    await mutateSemanticGovernanceState('ontology_publication', 'current', null, (current) => {
      if (current?.version !== operation.version) return { commit: false, result: null };
      return { value: { ...current, status, completedAt: new Date().toISOString() }, result: null };
    });
    return result;
  };
  try {
    let semanticDeployment;
    if (operation.retry) {
      const observed = await inspect(); const deployed = observed?.deployment || observed;
      if (deployed?.status === 'published' && deployed.sourceFingerprint === fingerprint && deployed.version === operation.version) semanticDeployment = { status: 'published', deployment: deployed, reconciled: true };
      else return finalize('reconciliation_required', { error: '独立服务未确认相同模型指纹；保留不确定状态，不自动重复写入。', code: 'PUBLICATION_RECONCILIATION_REQUIRED' });
    } else semanticDeployment = await deploy(candidate, operation.version);
    if (!operation.retry && semanticDeployment?.requestAttempted === false && semanticDeployment.status === 'unavailable'
      && ['bridge_disabled', 'unsafe_endpoint'].includes(semanticDeployment.reason)) {
      return finalize('not_attempted', { error: '独立服务未配置或地址不被允许，尚未发送发布请求；配置完成后可重新发布。', code: 'PUBLICATION_NOT_ATTEMPTED' });
    }
    if (semanticDeployment?.status !== 'published' || semanticDeployment.deployment?.sourceFingerprint !== fingerprint || semanticDeployment.deployment?.version !== operation.version) return finalize('reconciliation_required', { error: '尚未取得匹配模型指纹和版本的独立服务回执。', code: 'PUBLICATION_RECEIPT_UNCONFIRMED' });
    const result = await publishOAMetaModel(role, { version: semanticDeployment.deployment.version || operation.version, expectedFingerprint: fingerprint, tenantId: identityScope.tenantId });
    return finalize(result.error ? 'reconciliation_required' : 'completed', { ...result, semanticDeployment });
  } catch {
    return finalize('reconciliation_required', { error: '发布响应不确定；下次只查询相同版本回执，不自动重新发布。', code: 'PUBLICATION_OUTCOME_UNKNOWN' });
  }
}

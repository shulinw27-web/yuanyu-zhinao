import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isSemanticModelEditCommand, parseSemanticModelEdit } from './semantic-model-edit-command.js';
import { isSemanticDependencyCommand, parseSemanticDependencyCommand } from './semantic-object-dependencies.js';
import { configureSemanticGovernanceRepository, getSemanticGovernanceStoreInfo, mutateSemanticGovernanceState, probeSemanticGovernanceStore, readSemanticGovernanceState } from './semantic-governance-store.js';
import { inspectModelPromptSafety } from './local-model-gateway.js';
import {
  applySemanticOperationsProposal,
  createSemanticOperationsProposalFromRequest,
  inspectSemanticOperationsObjectDependencies,
  listSemanticOperationsSnapshots,
  updateSemanticOperationsProposal
} from './semantic-operations-agent-service.js';
import {
  getMetaModel,
  getOAMetaModelDraft,
  getOAMetaModelSimulation,
  simulateBuildOAMetaModel,
  validateOAMetaModelDraft
} from './meta-model-service.js';
import { validateSemanticaModelDefinition } from './semantica-demo-bridge-service.js';
import { publishGovernedOntology } from './ontology-runtime-service.js';
import { discoverSemanticSources, detectRequestedSemanticSystems } from './semantic-source-discovery-service.js';
import { planSemanticOperationsRequest } from './semantic-operations-planner-service.js';
import { semanticFingerprint } from './semantic-model-fingerprint.js';
import { semanticOperationsOwnerMatches, semanticOperationsPrincipalKey } from './semantic-operations-identity.js';
import { affirmativeRequest, boundedMaterial, understandAgentTurn } from './agent-turn-understanding-service.js';
import { inspectMultimodalInput, extractMultimodalEvidence } from './multimodal-input-service.js';
import { hasButtonPermission } from './access-control-service.js';
import { extendSemanticMaterials, discoverWorkspaceSchemas, materialSchemaIndex } from './semantic-material-workspace-service.js';
import { appendAgentEvidenceEvent, createAgentEvidenceTrace, getAgentEvidenceTrace, setAgentEvidenceTraceStatus } from './agent-evidence-trace-service.js';
import { createSemanticOperationsNotification } from './semantic-operations-notification-service.js';

const TASK_NAMESPACE = 'semantic_operations_agent_tasks';
const TASK_INDEX_KEY = 'index';
const now = () => new Date().toISOString();
const identityKey = semanticOperationsPrincipalKey;
const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const confirmationTokenHash = (token) => createHash('sha256').update(String(token || '')).digest('hex');
const safeTokenHashEqual = (left, right) => {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};

export { configureSemanticGovernanceRepository, getSemanticGovernanceStoreInfo, probeSemanticGovernanceStore };
const readTaskIndex = () => readSemanticGovernanceState(TASK_NAMESPACE, TASK_INDEX_KEY, {});
const mutateTaskIndex = (callback) => mutateSemanticGovernanceState(TASK_NAMESPACE, TASK_INDEX_KEY, {}, callback);
const appendTaskMessage = (id, role, content) => mutateTaskIndex((index) => {
  const task = index[id];
  if (!task) return { commit: false };
  const at = now();
  task.messages ||= [];
  task.messages.push({ role, content: String(content || '').slice(0, 4000), time: at });
  task.messages = task.messages.slice(-80);
  task.updatedAt = at;
  index[id] = task;
  return { value: index };
});
const mapMaybe = (value, callback) => value && typeof value.then === 'function' ? value.then(callback) : callback(value);
const traceEvent = (traceId, type, stage, status, summary, details = {}) => traceId ? appendAgentEvidenceEvent(traceId, { type, stage, status, actor: { type: 'service', id: 'semantic-operations-agent' }, summary, details }) : null;
const currentDraftFingerprint = () => mapMaybe(getOAMetaModelDraft(), semanticFingerprint);
const reviewPermissionOf = (task) => task?.reviewPermission || (task?.proposal && task.command === 'apply_proposal' ? 'meta_model.draft.review' : null);
const taskTenantId = (task) => { try { return JSON.parse(task.owner)?.[0] || null; } catch { return null; } };
const sameTaskTenant = (task, identityScope) => taskTenantId(task) === (identityScope?.tenantId || 'demo-enterprise');
const taskCanBeReviewed = (task, identityScope, accessContext) => Boolean(reviewPermissionOf(task) && sameTaskTenant(task, identityScope)
  && (!task.reviewAssignment?.subjectId || task.reviewAssignment.subjectId === (accessContext?.subjectId || identityScope?.subjectId))
  && (accessContext
    ? accessContext.buttonPermissionIds?.includes(reviewPermissionOf(task)) && accessContext.buttonPermissionIds?.includes(task.requiredPermission)
    : semanticOperationsOwnerMatches(task.owner, identityScope)
      && hasButtonPermission(task.originRoleId, reviewPermissionOf(task)) && hasButtonPermission(task.originRoleId, task.requiredPermission)));
const taskCanBeViewed = (task, accessContext, identityScope) => {
  const owner = semanticOperationsOwnerMatches(task.owner, identityScope);
  const reviewer = taskCanBeReviewed(task, identityScope, accessContext);
  if (!owner && !reviewer) return false;
  if (!accessContext) return owner;
  if (task.requiredPermission && !accessContext.buttonPermissionIds?.includes(task.requiredPermission)) return false;
  if (task.proposal && !accessContext.buttonPermissionIds?.includes('meta_model.draft.save')) return false;
  return true;
};
const canAccessTask = (task, identityScope, accessContext) => taskCanBeViewed(task, accessContext, identityScope);
const canConfirmTask = (task, identityScope, accessContext) => task?.proposal
  ? taskCanBeReviewed(task, identityScope, accessContext)
  : canAccessTask(task, identityScope, accessContext);
const hasCurrentPermission = (role, accessContext, permissionId) => accessContext
  ? accessContext.buttonPermissionIds?.includes(permissionId) === true
  : hasButtonPermission(role?.id || role, permissionId);

const operation = (intent, command, permission, reason) => ({ intent, command, permission, reason });
const noOperation = (intent, reason, response) => ({ intent, command: null, permission: null, reason, response });

/** 需要来源范围的意图：建模与来源预检。只有这两个意图的值可以来自「哪些系统」。 */
const SOURCE_BOUND_INTENTS = Object.freeze(['build_model', 'discover_sources']);

/**
 * 解析并校验本次建模/预检的来源范围。范围只能来自请求体里的显式勾选，任何情况下都不放大：
 * 没有选择、选择了未登记的系统、选择了当前角色数据域之外的系统，一律 400 并说明原因，
 * 而不是「静默裁到可见的」「静默扩到全部可见的」。这与 4.5 决策 C 一致：
 * 界面选择不构成隐式提权，但用户选了却拿不到数据时必须明确知道为什么。
 *
 * 判定复用 `discoverSemanticSources` 的同一个连接器目录与角色数据域，避免出现
 * 「面板显示可选、后端判定越权」的两套判断。
 */
function resolveSemanticSystemScope({ body, role, text, parent }) {
  const raw = body?.systemCodes;
  if (raw !== undefined && (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || !item.trim()))) {
    return { error: 'systemCodes 必须是非空字符串数组；未创建任务。', status: 400, code: 'SEMANTIC_SYSTEM_SCOPE_INVALID' };
  }
  const codes = raw === undefined
    ? []
    : [...new Set(raw.map((item) => item.trim().toUpperCase()))];
  if (!codes.length) {
    // 承接上文时给出上文范围作为提示，但仍要求本轮显式确认：范围不能靠「继承」偷偷生效。
    const inherited = parent?.systemScope?.selected?.length ? `上文任务的范围是 ${parent.systemScope.selected.join('、')}，如仍要沿用请在本轮显式带上。` : '';
    return {
      error: `本次诉求需要来源系统范围，但没有选择任何系统。请在建模范围中选择至少一个已登记系统后重试；服务器不会自动扩大到全部可访问连接器。${inherited}`,
      status: 400,
      code: 'SEMANTIC_SYSTEM_SCOPE_REQUIRED'
    };
  }
  const discovered = discoverSemanticSources({ systemCodes: codes, role });
  const unknown = discovered.sources.filter((item) => !item.registryKnown).map((item) => item.code);
  if (unknown.length) {
    return { error: `系统编码不在系统注册表中，无法作为来源范围：${unknown.join('、')}。请从系统接入清单中选择，未创建任务。`, status: 400, code: 'SEMANTIC_SYSTEM_UNKNOWN' };
  }
  const unregistered = discovered.sources.filter((item) => item.registryKnown && item.status === 'not_registered').map((item) => item.code);
  if (unregistered.length) {
    return { error: `以下系统尚未登记受控连接器，不能作为来源范围：${unregistered.join('、')}。请先在系统接入中完成登记，未创建任务。`, status: 400, code: 'SEMANTIC_SYSTEM_NOT_REGISTERED' };
  }
  const forbidden = discovered.sources.filter((item) => item.authorized === false).map((item) => item.code);
  if (forbidden.length) {
    return {
      error: `所选系统中的 ${forbidden.join('、')} 超出当前角色的数据域授权。范围不会被静默裁剪，也不会为它们提权；请去掉这些系统，或由具备权限的人员处理。未创建任务。`,
      status: 403,
      code: 'SEMANTIC_SYSTEM_SCOPE_FORBIDDEN'
    };
  }
  return {
    systemCodes: codes,
    mentionedNotSelected: detectRequestedSemanticSystems(text).filter((code) => !codes.includes(code))
  };
}

/**
 * 汇总提案对所选来源范围的实际覆盖。**过滤发生在提案构建阶段**（`applyScopeFilterToObjects`，ADR-013），
 * 这里只把结果翻译成可审计的上报口径：
 * - `covered`：过滤后提案里对象来源命中的所选系统
 * - `uncovered`：选了但过滤后提案里一个对象都没有的系统（必须在界面上显式出现）
 * - `excludedObjects`：因**全部**来源在所选范围外而被排除的对象
 * - `excludedRelationships`：因端点对象被排除而一并排除的关系
 * - `partialScopeObjects`：**部分**来源在范围外、但仍在提案里的对象
 * - `unassignedObjects`：材料未声明来源系统、无法追溯到任何系统的对象（历史高发风险点）
 *
 * `excludedObjects` 是本 ADR 的核心约束：**过滤不得静默**。被排除项必须可读地出现在任务结果里，
 * 运营才能看出「材料里有东西因为没勾系统而被排除」并据此补选系统重跑。
 * 旧的 `outOfScopeObjects` 字段被拆为 `partialScopeObjects`（仍在提案）与 `excludedObjects`（已移除）——
 * 保留并集别名会让调用方无法从字段名判断对象是否还在提案里。
 */
function summarizeSystemScopeCoverage(scope, proposal) {
  const selected = new Set(scope.selected);
  const objects = proposal?.objectTypes || [];
  const exclusions = proposal?.scopeExclusions || {};
  const covered = new Set();
  for (const object of objects) {
    [...new Set((object.sourceSystems || []).filter(Boolean))]
      .filter((code) => code !== 'UNASSIGNED' && selected.has(code))
      .forEach((code) => covered.add(code));
  }
  return {
    ...scope,
    covered: [...covered].sort(),
    uncovered: scope.selected.filter((code) => !covered.has(code)).map((code) => ({
      code,
      reason: objects.length ? '本次提案中没有任何对象的来源系统标注为该系统。' : '本次未生成提案对象，无法判断覆盖情况。'
    })),
    excludedObjects: exclusions.excludedObjects || [],
    excludedRelationships: exclusions.excludedRelationships || [],
    partialScopeObjects: exclusions.partialScopeObjects || [],
    unassignedObjects: exclusions.unassignedObjects || [],
    // 阶段 4a：跨系统标识只上报计数与冲突种类，明细留在提案的 identityLinking 上——
    // 在任务上复制一份完整清单，迟早会与提案那份不一致。
    // 阶段 4c：裁定集合按同一口径只报「已裁定了哪些概念」，明细与重算报告仍在提案上。
    identity: proposal?.identityLinking ? {
      summary: proposal.identityLinking.summary,
      conflictKinds: [...new Set(proposal.identityLinking.conflicts.map((item) => item.kind))].sort(),
      rulings: proposal.identityConflictRulings || [],
      // 阶段 4c 第三段：同名声明裁定与等价裁定同口径只报「裁定了哪些分歧项」，明细仍在提案上。
      declarationRulings: proposal.declarationRulings || []
    } : null
  };
}

const IDENTITY_CONFLICT_LABELS = Object.freeze({
  ambiguous_identifier: '标识归属歧义',
  alias_divergence: '同义不同名',
  key_shape_incompatible: '键形状不可对齐',
  declaration_divergence: '同名声明不一致'
});

/** 标识对应的可读摘要：只陈述事实与数量，不替运营下结论（明细在提案的 identityLinking 上）。 */
function describeIdentityFindings(identityLinking) {
  if (!identityLinking) return [];
  const { summary, keyGaps, conflicts, unresolvedReferences } = identityLinking;
  // 「其所属概念存在等价分歧、且尚未裁定」的链接数——不能直接数 `ruling === null`，
  // 那会把 PurchaseOrder / Supplier 这类本就没有等价分歧的链接也算进来。
  const unresolvedConcepts = identityLinking.rulingReport?.unresolvedConcepts || [];
  const unresolvedAssumptionLinks = identityLinking.links.filter((item) => !item.ruling && unresolvedConcepts.includes(item.concept));
  return [
    ...(summary.links ? [`跨系统标识对应 ${summary.links} 条（其中 ${summary.requiresMapping} 条是代理键与业务键之间的引用，不能按值直接对齐，确认时须给出结构化映射定义${summary.shapeUnknown ? `；另有 ${summary.shapeUnknown} 条有一端键形状未判定（裸名），须先判定形状` : ''}），未自动并入草稿关系`] : []),
    // 阶段 4e（ADR-020）：资格是独立口径，必须与「有几条对应」一起说。缺这一句，运营只能靠
    // 自己试错去发现「11 条里有 4 条这次根本用不了」。
    ...(summary.ineligible ? [`其中 ${summary.ineligible} 条本次不可并入草稿：端点对象 ${[...new Set(identityLinking.links.filter((item) => !item.eligible).flatMap((item) => item.ineligibleEndpoints.map((endpoint) => `${endpoint.system}.${endpoint.objectId}`)))].join('、')} 不在本次候选对象内（它们只在系统声明里存在），需先让这些对象成为候选对象`] : []),
    // 「有多少条链站在没人回答过的前提上」是阶段 4c 最需要被说清的一项：
    // 只说「11 条对应」会让人以为 11 个结论各自独立，实际上它们共享少数几个等价假设。
    ...(unresolvedAssumptionLinks.length ? [`其中 ${unresolvedAssumptionLinks.length} 条建立在尚未裁定的等价前提上（涉及 ${unresolvedConcepts.join('、')}），需先裁定等价关系再逐条确认`] : []),
    ...(summary.ruledConcepts ? [`已裁定 ${summary.ruledConcepts} 个概念的标识等价关系${summary.withdrawnLinks ? `，并因裁定为不同实体撤下 ${summary.withdrawnLinks} 条跨组对应` : ''}`] : []),
    ...(summary.conflicts ? [`标识冲突 ${summary.conflicts} 项：${[...new Set(conflicts.map((item) => IDENTITY_CONFLICT_LABELS[item.kind] || item.kind))].sort().join('、')}`] : []),
    // 阶段 4c 第三段：并集是默认动作、不是结论。不报出「有几个复合条目 / 几个分歧项没裁定」，
    // 运营只能看到「这个对象有 7 个字段」，而没有任何一处声明说过这句话。
    ...(summary.declarationDivergences ? [`同名声明不一致 ${summary.declarationDivergences} 项，其中 ${summary.unresolvedDeclarationItems} 项未裁定${summary.mergedUnruledObjects ? `、${summary.mergedUnruledObjects} 个对象的字段仍是并集` : ''}`] : []),
    ...(summary.ruledDeclarationItems ? [`已裁定 ${summary.ruledDeclarationItems} 项同名声明分歧${summary.splitObjects ? `，拆分为 ${summary.splitObjects} 个对象` : ''}${summary.droppedDeclarations ? `，并显式排除 ${summary.droppedDeclarations} 条声明` : ''}`] : []),
    ...(keyGaps.length ? [`未识别到自身标识的对象：${keyGaps.map((item) => `${item.objectId}（${item.system}）`).join('、')}`] : []),
    ...(unresolvedReferences.length ? [`范围内被引用但没有对应实体：${unresolvedReferences.map((item) => `${item.field}→${item.concept}`).join('、')}`] : [])
  ];
}

/** 覆盖问题的可读摘要，用于任务回应与证据事件；没有问题时不产生噪音。 */
function describeScopeFindings(systemScope) {
  if (!systemScope) return [];
  return [
    ...systemScope.uncovered.map((item) => `${item.code}：本次提案未覆盖（${item.reason}）`),
    ...(systemScope.excludedObjects?.length ? [`按范围排除的对象：${systemScope.excludedObjects.map((item) => `${item.objectId}（${item.sourceSystems.join('/')}）`).join('、')}（来源系统不在本次所选范围内；如需纳入请补选系统后重跑）`] : []),
    ...(systemScope.excludedRelationships?.length ? [`随对象一并排除的关系：${systemScope.excludedRelationships.map((item) => `${item.from}-${item.predicate}->${item.to}`).join('、')}`] : []),
    ...(systemScope.partialScopeObjects?.length ? [`部分来源超出范围的对象：${systemScope.partialScopeObjects.map((item) => `${item.objectId}（超出 ${item.outside.join('/')}）`).join('、')}（已保留，仅提示来源超出所选范围）`] : []),
    ...(systemScope.unassignedObjects?.length ? [`来源系统未标注的对象：${systemScope.unassignedObjects.join('、')}（材料未声明来源，无法追溯到系统，已保留）`] : []),
    ...(systemScope.mentionedNotSelected.length ? [`文本提到但未选择的系统：${systemScope.mentionedNotSelected.join('、')}（未纳入本次范围）`] : [])
  ];
}
const includesAnyTerm = (text, terms) => terms.some((term) => text.includes(term));
const isExplicitModelApproval = (text) => /^(?:审核通过|通过审核|同意采纳|确认采纳|采纳(?:当前|这个|该)?(?:模型|提案|关系模型)?|确认(?:当前|这个|该)?模型)[。！!\s]*$/u.test(normalize(text));
const isExplicitModelModification = (text) => /(?:修改|调整|更正|补充|增加|新增|移除|删除).{0,36}(?:模型|对象|关系|关联|字段|主键)|(?:模型|对象|关系|关联|字段|主键).{0,24}(?:改成|改为|调整为|修改为|补充|增加|移除|删除)/u.test(normalize(text));
const buildTerms = ['建设', '建立', '构建', '建模', '新增对象', '添加对象', '识别对象', '抽取对象', '定义对象', '设计模型', '生成候选', '生成语义', '生成模型'];
const groundedObjectTerms = ['供应商', '采购', '订单', '原料', '物料', '批次', '检验', '质检', '生产', '成品', '库存', '仓库', '入库', '出库', '门店', '设备', '组织', '人员', '审批', '字段', '对象', '关系', '数据字典', 'openapi', 'schema'];

export function classifySemanticOperationsIntent(text, { hasAttachments = false } = {}) {
  const original = normalize(text).toLowerCase();
  const value = affirmativeRequest(original);
  if (/(?:不要|不用|不必|不想|不需要|无需|禁止|暂不|不能|不可|别|不(?:保存|发布|生成|创建|读取|查询|建模|修改|执行|发起))/.test(original) && !/(?:建设|建立|构建|建模|新增|添加|识别|抽取|定义|生成候选|生成模型|生成语义|校验|检查|模拟|试运行|发布|登记|上线|生效)/.test(value)) {
    return noOperation('conversation', 'negated_operation', '不会执行被禁止的操作；可以继续讨论方案或解释材料。');
  }
  const hasOperationTerm = /(?:建设|建立|构建|建模|新增|添加|识别|抽取|定义|校验|检查模型|模拟|试运行|发布|登记|上线|生效)/.test(value);
  if (hasOperationTerm && /(?:不要|不用|不必|不想|别|禁止|停止|取消|无需).{0,16}(?:建设|建立|构建|建模|新增|添加|识别|抽取|定义|校验|检查|模拟|试运行|发布|登记|上线|生效)/.test(value)) {
    return noOperation('conversation', 'negated_operation', '已理解，本次不会创建、校验、模拟或发布任何语义模型任务。你可以继续说明希望查看的信息。');
  }
  if (/(?:删除|清空|覆盖|重置|回滚|撤销发布|下线)/.test(value)) {
    return noOperation('unsupported_operation', 'unsupported_destructive_operation', '当前对话不会直接执行删除、覆盖、回滚或下线操作。请在“版本与回滚”中选择明确快照，并按治理流程单独确认。');
  }
  if (/^(?:你好|您好|嗨|哈喽|hello|hi|早上好|下午好|晚上好|在吗|有人吗)[!！。.，,\s]*$/i.test(value)) {
    return noOperation('conversation', 'greeting', '你好，我是元域智语 Agent。我可以协助建设语义模型、检查数据来源、查看草稿状态、运行校验与模拟；涉及写入或发布的操作都会等待你明确确认。');
  }
  if (/(?:你是谁|能做什么|有哪些能力|怎么使用|使用说明|帮助|支持什么)/.test(value)) {
    return noOperation('conversation', 'capability_question', '我负责语义层运营，可以根据自然语言或受控材料建设模型、发现来源、检查状态、校验草稿和运行 Semantica 模拟。请告诉我对象范围、来源系统和目标；写操作会先生成计划并等待确认。');
  }
  if (isExplicitModelApproval(value)) return operation('approve_model', 'apply_proposal', 'meta_model.draft.review', 'explicit_model_review_approval');
  if (/^(?:如何|怎么|为什么|什么是|解释|介绍|说明)/.test(value) || /(?:建模|模型|发布|校验|模拟构建).{0,10}(?:是什么|是什么意思|怎么回事)/.test(value)) {
    return noOperation('conversation', 'guidance_question', '这是咨询类问题，我不会据此创建执行任务。你可以继续询问操作方法；如果要实际执行，请使用“建立、校验、模拟构建或发布”等明确指令并说明范围。');
  }
  if (includesAnyTerm(value, ['连接源', '数据源', '系统目录', '连接预检', '连接物料', '连接状态', '接入状态', '接入情况', '有哪些系统', '发现系统', '扫描系统', '检查连接', '建立连接']) || /(?:列出|查看|检查|扫描).{0,12}(?:系统|接入|连接)/.test(value)) {
    return operation('discover_sources', 'inspect_sources', null, 'explicit_source_discovery');
  }
  const structuralReview = /(?:检查|查看|审查|校验).{0,16}(?:结构|一致性|重复对象|断裂关系|字段|主键|关系)/.test(value);
  if (!structuralReview && (includesAnyTerm(value, ['状态', '进度', '有多少', '快照', '版本情况']) || /(?:是否|能否|可以).{0,12}(?:发布|登记|生效)/.test(value) || /semantica.{0,12}(?:可用|连接)/.test(value))) {
    return operation('inspect_status', 'inspect_status', null, 'explicit_status_query');
  }
  if (includesAnyTerm(value, ['发布', '登记模型', '上线模型', '生效模型'])) {
    return operation('publish_model', 'publish_model', 'meta_model.publish', 'explicit_publish_action');
  }
  if (includesAnyTerm(value, ['模拟构建', '试运行', '演练模型', 'semantica校验', 'semantica 校验'])) {
    return operation('simulate_model', 'simulate_model', 'meta_model.simulate', 'explicit_simulation_action');
  }
  if (structuralReview || includesAnyTerm(value, ['校验', '检查模型', '检查当前模型', '结构检查', '模型检查', '一致性检查', '重复对象', '断裂关系', '审查当前'])) {
    return operation('validate_model', 'validate_model', 'meta_model.draft.validate', 'explicit_validation_action');
  }
  const hasBuildAction = includesAnyTerm(value, buildTerms) || /(?:新增|添加|识别|抽取|定义).{0,12}对象/.test(value);
  if (isExplicitModelModification(value)) return operation('build_model', 'apply_proposal', 'meta_model.draft.save', 'explicit_model_revision');
  if (hasBuildAction) {
    const grounded = hasAttachments || includesAnyTerm(value, groundedObjectTerms);
    return grounded
      ? operation('build_model', 'apply_proposal', 'meta_model.draft.save', hasAttachments ? 'explicit_build_with_material' : 'explicit_grounded_build')
      : noOperation('needs_clarification', 'build_scope_missing', '我识别到建模意图，但还缺少对象范围或结构材料。请说明要建设的业务对象、来源系统，或上传数据字典、OpenAPI、JSON Schema、CSV 示例。');
  }
  if (!value && hasAttachments) return operation('build_model', 'apply_proposal', 'meta_model.draft.save', 'attachment_only_build');
  return noOperation('needs_clarification', 'operation_not_identified', '我还不能确定你希望执行哪类元域智语任务。请明确是建设模型、检查来源、查看状态、校验草稿、模拟构建还是发布模型，并补充对象或系统范围。');
}

const planFor = (intent) => ({
  build_model: ['理解业务范围与来源系统', '提取候选对象、主键和字段', '推断对象关系与核心元对象映射', '运行 Schema Critic', '生成相对当前草稿的版本 Diff', '等待人工确认后写入草稿并保存快照'],
  approve_model: ['绑定当前任务中待审语义模型', '核对当前提案版本和草稿指纹', '按当前人员权限采纳至未发布草稿', '记录审批意见与模型版本'],
  discover_sources: ['识别诉求涉及的企业系统', '按当前角色裁剪连接器目录', '检查企业端点、凭据和来源契约就绪度', '列出建模所需数据字典与样例物料', '返回阻断项，不读取业务明细'],
  inspect_status: ['读取当前身份可见的语义草稿摘要', '读取模型校验、模拟和版本状态', '返回受控运营状态，不执行任何修改'],
  validate_model: ['锁定当前语义草稿版本', '运行对象、关系、审批语义和数据分级校验', '记录校验结果与审计事件'],
  simulate_model: ['校验当前草稿', '生成受控模拟实例', '调用本机 Semantica 验证模型定义', '返回构建结果，不自动发布'],
  publish_model: ['确认模拟构建已经通过', '生成受控模型版本号', '向 Semantica 登记模型定义', '写入发布事件和审计记录'],
  conversation: [],
  needs_clarification: [],
  unsupported_operation: []
}[intent] || []);

/**
 * 语义面意图裁决：模型理解与确定性分类的唯一汇合点。抽成纯函数以便独立测试。
 *
 * 回落规则（修正「模型一抖、入口全黑」）：
 * understandAgentTurn 在模型不可用或输出不合契约时返回 source='understanding_failed'。
 * 历史上该结果仍被当作一次有效的 dialogue 判定（reason=model_dialogue），于是任何自然语言
 * 诉求都退化成「本轮模型未返回可用的理解结果」——连「识别到建模意图但缺少对象范围」
 * 这种可操作的澄清都拿不到。现在：模型**未产出有效理解**时回落服务端确定性分类
 * （与 mock 模式下同一条路径），并把降级事实保留在返回值里，不伪装成模型理解成功。
 *
 * 安全边界（不得放宽）：发布不参与回落。既有不变量要求发布必须同时具备「语义理解」与
 * 「本轮明确请求」，语义理解不可用时不得降级授权发布。
 */
export function resolveSemanticOperationsIntent({ turn, text, contextualText, hasAttachments = false }) {
  const turnUnavailable = Boolean(turn) && turn.source === 'understanding_failed';
  const currentRequest = classifySemanticOperationsIntent(text, { hasAttachments });
  if (['unsupported_destructive_operation', 'negated_operation'].includes(currentRequest.reason)) return { classified: currentRequest, turnUnavailable };
  let classified = classifySemanticOperationsIntent(turn && !turnUnavailable ? text : contextualText, { hasAttachments });
  if (turnUnavailable && classified.intent === 'publish_model') {
    classified = noOperation('needs_clarification', 'publish_requires_model_understanding', '发布需要先取得可用的语义理解结果，本次不会降级授权发布。请重试，或先执行“校验草稿 / 模拟构建”。');
  }
  if (turn && !turnUnavailable) {
    const operations = {
      build_model: ['apply_proposal', 'meta_model.draft.save'], discover_sources: ['inspect_sources', null], inspect_status: ['inspect_status', null],
      validate_model: ['validate_model', 'meta_model.draft.validate'], simulate_model: ['simulate_model', 'meta_model.simulate'], publish_model: ['publish_model', 'meta_model.publish']
    };
    const requested = operations[turn.intent];
    // Publishing requires both semantic understanding and an affirmative
    // current-turn request; history/model prose cannot authorize it.
    if (requested && (turn.intent !== 'publish_model' || classified.intent === 'publish_model')) classified = operation(turn.intent, ...requested, 'model_understood_server_gated');
    else classified = noOperation(turn.needsClarification ? 'needs_clarification' : 'conversation', 'model_dialogue', turn.answer || '尚未执行操作，请明确本轮允许的动作。');
  }
  // A short, direct approval is an explicit user action. Keep it bound to the
  // parent task proposal below; it must never publish or select another draft.
  if (isExplicitModelApproval(text)) classified = operation('approve_model', 'apply_proposal', 'meta_model.draft.review', 'explicit_model_review_approval');
  if (isExplicitModelModification(text)) classified = operation('build_model', 'apply_proposal', 'meta_model.draft.save', 'explicit_model_revision');
  return { classified, turnUnavailable };
}

const commandLabel = {
  apply_proposal: '采纳模型建议到草稿',
  validate_model: '校验当前语义草稿',
  simulate_model: '运行 Semantica 模拟构建',
  publish_model: '发布并登记语义模型',
  approve_model: '审核通过并采纳语义模型',
  inspect_sources: '检查语义来源与连接物料',
  inspect_status: '读取当前语义层状态'
};

const publicTask = (task) => task && ({
  workspaceContext: task.workspaceContext || null,
  onboardingSource: task.onboardingSource || null,
  id: task.id,
  traceId: task.traceId || null,
  parentTaskId: task.parentTaskId || null,
  threadId: task.threadId || task.id,
  turn: task.turn || 1,
  messages: task.messages || [{ role: 'user', content: task.request, time: task.createdAt }, { role: 'assistant', content: task.response, time: task.updatedAt }],
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  status: task.status,
  intent: task.intent,
  title: task.title,
  request: task.request,
  plan: task.plan,
  command: task.command,
  commandLabel: commandLabel[task.command] || null,
  requiredPermission: task.requiredPermission,
  reviewPermission: reviewPermissionOf(task),
  confirmationRequired: task.confirmationRequired,
  confirmation: task.confirmation ? {
    state: task.confirmation.state,
    issuedAt: task.confirmation.issuedAt || null,
    expiresAt: task.confirmation.expiresAt || null,
    consumedAt: task.confirmation.consumedAt || null
  } : null,
  reviewContext: task.reviewContext || null,
  reviewAssignment: task.reviewAssignment || { revision: 0, subjectId: null, name: null },
  execution: task.execution ? { attempt: task.execution.attempt, startedAt: task.execution.startedAt, leaseExpiresAt: task.execution.leaseExpiresAt, finishedAt: task.execution.finishedAt || null } : null,
  archivedAt: task.archivedAt || null,
  proposal: task.proposal || null,
  planning: task.planning || null,
  sourceDiscovery: task.sourceDiscovery || null,
  systemScope: task.systemScope || null,
  result: task.result || null,
  response: task.response,
  routing: task.routing || null,
  modelUnavailable: task.modelUnavailable || null,
  materialReview: task.materialReview || null,
  events: task.events
});

// Internal preparation port for the sandbox onboarding transaction. No model
// inference, publication, confirmation token or independent persistence here.
export async function prepareOnboardingSemanticTask({ id, proposal, identityScope, roleId, onboardingSource }) {
  const createdAt = now();
  const response = `已从模拟接入材料生成 ${proposal.objectTypes.length} 个对象、${proposal.relationshipTypes.length} 条关系的候选提案。结构校验${proposal.critic.status === 'passed' ? '通过' : '未通过'}，样本验证${proposal.mappingValidation.status === 'passed' ? '通过' : '待处理'}；尚未采纳或发布。业务映射仅作为审阅附件，不自动变成指标或执行规则。`;
  const request = '根据当前已校对的模拟企业接入材料生成候选模型，等待人工审阅。';
  const task = { id, threadId: id, parentTaskId: null, turn: 1, traceId: null, owner: identityKey(identityScope),
    createdAt, updatedAt: createdAt, status: 'waiting_confirmation', intent: 'build_model', title: '模拟企业接入 · 建模交接', request,
    originRoleId: roleId, originDeviceId: identityScope.deviceId || null,
    command: 'apply_proposal', requiredPermission: 'meta_model.draft.save', reviewPermission: 'meta_model.draft.review', confirmationRequired: true, confirmation: { state: 'not_issued' },
    plan: planFor('build_model'), planning: { mode: 'deterministic', provider: 'server_rules', policy: '结构化材料交接，不代表大模型推理。' },
    routing: { mode: 'server_rules', decision: 'build_model', reason: 'explicit_mock_onboarding_handoff' },
    onboardingSource, proposal, response, messages: [{ role: 'user', content: request, time: createdAt }, { role: 'assistant', content: response, time: createdAt }],
    events: [{ time: createdAt, type: 'onboarding_handoff', detail: `来源项目 ${onboardingSource.projectId}，材料修订 ${onboardingSource.materialRevision}；未自动执行。` }],
    reviewContext: { draftFingerprint: await currentDraftFingerprint(), proposalId: proposal.id, proposalRevision: proposal.revision, capturedAt: createdAt } };
  return { task, publicTask: publicTask(task), entry: { name: 'tasks', namespace: TASK_NAMESPACE, key: TASK_INDEX_KEY, initialValue: {} } };
}

const getIndex = readTaskIndex;

const taskId = (owner, text) => `semantic-task-${createHash('sha256').update(`${owner}:${text}:${now()}`).digest('hex').slice(0, 16)}`;

const inspectStatus = async (identityScope) => {
  const [draft, model, simulation, snapshots] = await Promise.all([getOAMetaModelDraft(), getMetaModel('oa-governance'), getOAMetaModelSimulation(), listSemanticOperationsSnapshots({ identityScope })]);
  return {
    objectCount: draft.objectTypes.length,
    relationshipCount: draft.relationshipTypes.length,
    validationStatus: draft.validation?.status || 'not_validated',
    modelStatus: model?.status || 'ready_to_build',
    simulationStatus: simulation?.status || 'not_simulated',
    activeSnapshotCount: snapshots.filter((item) => item.status === 'active').length
  };
};

export async function createSemanticOperationsTask({ body, role, identityScope, accessContext }) {
  const text = normalize(body?.text);
  if (!text && !body?.attachments?.length) return { error: '请输入元域智语目标，或上传一份受控材料。', status: 400 };
  const promptSafety = inspectModelPromptSafety(text);
  if (!promptSafety.safe) return { error: '运营指令未通过安全检查，未创建任务。', status: 400 };
  const owner = identityKey(identityScope);
  const parentId = normalize(body?.parentTaskId);
  const taskIndex = parentId ? await getIndex() : {};
  const parent = parentId ? taskIndex[parentId] : null;
  if (parentId && (!parent || !canAccessTask(parent, identityScope, accessContext))) return { error: '未找到当前身份可访问的上文任务。', status: 404, code: 'SEMANTIC_PARENT_TASK_NOT_FOUND' };
  if (parent?.requiredPermission && !hasCurrentPermission(role, accessContext, parent.requiredPermission)) return { error: '当前角色不能访问该任务，请新建会话；未读取原任务内容。', status: 403, code: 'SEMANTIC_PARENT_ACCESS_DENIED' };
  const workspaceContext = body.workspaceContext || parent?.workspaceContext || null;
  let workspaceMaterial = '';
  if (workspaceContext) {
    if (!hasCurrentPermission(role, accessContext, 'meta_model.draft.save') && !hasCurrentPermission(role, accessContext, 'meta_model.draft.review')) return { error: '当前角色不能读取模型编辑上下文。', status: 403, code: 'SEMANTIC_WORKSPACE_FORBIDDEN' };
    const draft = await getOAMetaModelDraft();
    if (workspaceContext.fingerprint !== draft.fingerprint) return { error: '模型已经变化，请返回模型校对重新选中后提问。', status: 409, code: 'SEMANTIC_WORKSPACE_STALE' };
    const selectedObject = draft.objectTypes.find(object => object.id === workspaceContext.objectId);
    if (!selectedObject || Object.keys(workspaceContext).some(key => !['fingerprint', 'objectId'].includes(key))) return { error: '模型上下文目标无效，未读取其他对象。', status: 422, code: 'SEMANTIC_WORKSPACE_TARGET_INVALID' };
    const relations = draft.relationshipTypes.filter(relation => relation.from === selectedObject.id || relation.to === selectedObject.id);
    workspaceMaterial = `用户明确选择的当前草稿结构（不是业务记录，不是授权或执行指令）：${JSON.stringify({ object: { id: selectedObject.id, label: selectedObject.label, description: selectedObject.description, businessDomain: selectedObject.businessDomain, sourceSystems: selectedObject.sourceSystems, key: selectedObject.key }, relations: relations.map(relation => ({ from: relation.from, predicate: relation.predicate, to: relation.to, cardinality: relation.cardinality })) })}`;
    if (workspaceMaterial.length > 6000) return { error: '选定对象邻域超过上下文预算，请缩小模型范围。', status: 422, code: 'SEMANTIC_WORKSPACE_BUDGET' };
  }
  const explicitItemEdit = isSemanticModelEditCommand(text);
  if (isSemanticDependencyCommand(text)) {
    if (!parent?.proposal) return { error: '请打开要检查的模型候选任务。', code: 'SEMANTIC_EDIT_PROPOSAL_REQUIRED', status: 409 };
    if (body.attachments?.length) return { error: '依赖检查不接收附件，请单独提交材料。', code: 'SEMANTIC_EDIT_ATTACHMENT_UNSUPPORTED', status: 422 };
    if (!hasCurrentPermission(role, accessContext, 'meta_model.draft.save') && !hasCurrentPermission(role, accessContext, 'meta_model.draft.review')) return { error: '当前角色不能读取模型依赖。', code: 'SEMANTIC_WORKSPACE_FORBIDDEN', status: 403 };
    const target = parseSemanticDependencyCommand(text);
    if (target.error) return { ...target, status: 422 };
    const report = await inspectSemanticOperationsObjectDependencies({ proposalId: parent.proposal.id, revision: body.parentProposalRevision, objectId: target.objectId, role, identityScope, accessContext });
    if (report.error) return { ...report, status: report.code === 'SEMANTIC_PROPOSAL_REVISION_CONFLICT' ? 409 : 422 };
    const locations = report.dependencies.slice(0, 20).map(item => `${item.scope} · ${item.path.map(part => String(part)).join('.')}`).join('\n');
    const response = `${report.objectId} 的模型配置影响检查：共${report.total}处引用或同名提及。${report.total ? '\n' + locations : '本次范围未发现配置引用。'}${report.total > 20 ? '\n对话仅展示前20处，请核对完整配置。' : ''}\n依据：候选修订${report.revision}，草稿指纹${report.draftFingerprint}。${report.boundary}未修改候选、未删除业务记录、未授权发布。`;
    await appendTaskMessage(parent.id, 'user', text);
    await appendTaskMessage(parent.id, 'assistant', response);
    return { ...await getSemanticOperationsTask({ taskId: parent.id, identityScope, accessContext }), dependencyAnalysis: report };
  }
  if (explicitItemEdit) {
    if (!parent?.proposal) return { error: '请先打开待确认的语义模型候选，再指定对象或字段进行修改，不会为此另建模型。', status: 409, code: 'SEMANTIC_EDIT_PROPOSAL_REQUIRED' };
    if (body.attachments?.length) return { error: '单项候选修订不接收附件，请分开提交材料与修改要求。', status: 422, code: 'SEMANTIC_EDIT_ATTACHMENT_UNSUPPORTED' };
    if (!hasCurrentPermission(role, accessContext, 'meta_model.draft.save')) return { error: '当前角色没有模型修订权限。', status: 403, code: 'SEMANTIC_EDIT_FORBIDDEN' };
    if (Number(body.parentProposalRevision) !== parent.proposal.revision) return { error: '候选修订已经变化，请刷新当前任务后继续修改。', status: 409, code: 'SEMANTIC_PROPOSAL_REVISION_CONFLICT' };
    const edit = parseSemanticModelEdit(text, parent.proposal, await getOAMetaModelDraft());
    if (edit.error) return { ...edit, status: 422 };
    const revised = await reviseSemanticOperationsTaskProposal({ taskId: parent.id, body: { ...edit.body, candidateFieldWithdrawal: edit.withdrawal, candidateObjectWithdrawal: edit.objectWithdrawal, candidateRelationshipWithdrawal: edit.relationshipWithdrawal, revision: parent.proposal.revision }, role, identityScope });
    if (revised.error) return { ...revised, status: 409 };
    await appendTaskMessage(parent.id, 'user', text);
    await appendTaskMessage(parent.id, 'assistant', `已修订当前候选：${edit.summary}。${revised.response || ''}未采纳到草稿、未发布；旧确认凭证失效。`);
    return getSemanticOperationsTask({ taskId: parent.id, identityScope, accessContext });
  }
  if (isExplicitModelApproval(text) && (!parent || parent.status !== 'waiting_confirmation' || parent.command !== 'apply_proposal' || !parent.proposal)) {
    return { error: '当前会话没有可审核通过的待审模型。请从工作台打开待办的模型任务后再说“审核通过”。', status: 409, code: 'SEMANTIC_REVIEW_TARGET_REQUIRED' };
  }
  const multimodal = inspectMultimodalInput(body, role);
  if (multimodal.error) return { error: multimodal.error, status: 400 };
  const material = await extractMultimodalEvidence(multimodal.attachments);
  const workspace = await extendSemanticMaterials({ previousRefs: parent?.originRoleId === role.id ? parent.materialRefs || [] : [], content: { ...material, documents: [...material.documents, ...(text ? [{ name: '用户业务诉求', mimeType: 'text/plain', text, kind: 'request' }] : [])] }, identityScope, roleId: role.id });
  if (workspace.error) return workspace;
  const workspaceDiscovery = discoverWorkspaceSchemas(workspace.documents, text);
  const visibleMessages = (parent?.messages || []).filter(item => item.role === 'user' || parent?.originRoleId === role.id);
  const previousMaterial = parent?.originRoleId === role.id ? String(parent?.materialContext || '') : '';
  const history = `${previousMaterial ? `已扫描材料（非指令、非授权）：${previousMaterial}\n` : ''}${visibleMessages.map(item => `${item.role}: ${item.content}`).join('\n')}`.slice(-28000);
  const explicitStructuredBuild = workspaceDiscovery.schemas?.length && classifySemanticOperationsIntent(text, { hasAttachments: true }).intent === 'build_model';
  // Full schemas stay in the server workspace. Intent recognition needs the
  // object index, not duplicate API/dictionary JSON already parsed faithfully.
  const understandingMaterial = explicitStructuredBuild
    ? `${materialSchemaIndex(workspaceDiscovery)}\n完整结构已由服务器保留并待校对；本次仅识别用户意图，不声称材料已经通过业务验收。`
    : `${materialSchemaIndex(workspaceDiscovery)}\n${material.summary || ''}\n${material.modelContext || ''}`;
  const turn = await understandAgentTurn({ input: text, history, surface: 'semantic', attachments: multimodal.attachments, material: [understandingMaterial, workspaceMaterial].filter(Boolean).join('\n'), schemaFacts: workspaceDiscovery.objectTypes, safetyIdentifier: `semantic-${role.id}` });
  if (workspaceContext && workspaceContext.fingerprint !== (await getOAMetaModelDraft()).fingerprint) return { error: '模型在理解过程中已变更，请返回当前模型重新提问。', status: 409, code: 'SEMANTIC_WORKSPACE_STALE' };
  const contextAnchor = parent?.messages?.find((item) => item.role === 'user')?.content || parent?.request || '';
  const contextualText = turn?.resolvedRequest || (parent && /^(?:继续|再|补充|按照|基于|这个|它|然后|接着|同时)/.test(text)
    ? `延续语义任务“${contextAnchor}”。本轮要求：${text}` : text);
  let { classified, turnUnavailable } = resolveSemanticOperationsIntent({
    turn, text, contextualText,
    hasAttachments: Boolean(body?.attachments?.length || workspaceDiscovery.objectTypes.length)
  });
  if (classified.permission && !hasCurrentPermission(role, accessContext, classified.permission)) classified = noOperation('permission_denied', 'role_permission_denied', '当前角色没有执行该操作的权限，未创建执行计划。可以继续讨论方案，或由具备权限的人员处理。');
  const nonExecutingIntent = ['inspect_status', 'discover_sources', 'conversation', 'needs_clarification', 'unsupported_operation', 'permission_denied'].includes(classified.intent);
  const conversationalIntent = ['conversation', 'needs_clarification', 'unsupported_operation', 'permission_denied'].includes(classified.intent);
  // 范围门禁在意图判定之后、任何读取与规划之前：范围不合法就不产生任务、不读材料、不生成提案。
  const sourceBound = SOURCE_BOUND_INTENTS.includes(classified.intent);
  const scope = sourceBound ? resolveSemanticSystemScope({ body, role, text: contextualText, parent }) : null;
  if (scope?.error) return { error: scope.error, status: scope.status, code: scope.code };
  if (classified.intent === 'approve_model') {
    await mutateTaskIndex((index) => {
      const current = index[parent.id];
      if (!current || current.status !== 'waiting_confirmation' || !current.proposal || current.command !== 'apply_proposal') return { commit: false };
      const at = now();
      current.messages ||= [];
      current.events ||= [];
      current.messages.push({ role: 'user', content: text, time: at });
      current.messages = current.messages.slice(-80);
      current.events.push({ time: at, type: 'natural_language_model_approval', detail: '审核人通过自然语言明确同意当前提案；服务端仍核对权限、草稿指纹和提案修订。' });
      current.updatedAt = at;
      index[current.id] = current;
      return { value: index };
    });
    const confirmation = await issueSemanticOperationsTaskConfirmation({ taskId: parent.id, identityScope, accessContext });
    if (confirmation.error) return confirmation;
    const execution = await executeSemanticOperationsTask({ taskId: parent.id, role, identityScope, accessContext, confirmationToken: confirmation.confirmationToken });
    await appendTaskMessage(parent.id, 'assistant', execution.task?.response || execution.error);
    return execution.error ? { error: execution.error, status: 409, code: execution.code, task: execution.task } : getSemanticOperationsTask({ taskId: parent.id, identityScope, accessContext });
  }
  const id = taskId(owner, text);
  const createdAt = now();
  const trace = await createAgentEvidenceTrace({ roleId: role?.id, identityScope, input: text, requestId: id, platform: identityScope?.platform, kind: 'semantic_operations_task' });
  const sourceDiscovery = sourceBound
    ? discoverSemanticSources({
      // request 只用于「文本/材料里提到了哪些系统」的提示素材，不再决定范围。
      request: workspaceDiscovery.objectTypes.length ? [...new Set(workspaceDiscovery.objectTypes.flatMap(item => item.sourceSystems || []))].join(' / ') : contextualText,
      role,
      systemCodes: scope.systemCodes
    })
    : null;
  const planning = conversationalIntent ? null : await planSemanticOperationsRequest({ request: contextualText || '根据上传材料建设语义模型', authoritativeIntent: classified.intent, sourceDiscovery, identityScope,
    materialFacts: { objects: workspaceDiscovery.objectTypes.map(item => ({ id: item.id, key: item.key, granularity: item.granularity, systems: item.sourceSystems,
      fields: item.fieldDefinitions.map(f => ({ name: f.name, type: f.type, unit: f.unit, reference: f.reference, referenceField: f.referenceField })) })),
      relationshipCount: workspaceDiscovery.relationshipTypes.length, documentNames: workspace.documents.map(item => item.name) } });
  const task = {
    id,
    traceId: trace.id,
    parentTaskId: parent?.id || null,
    workspaceContext: workspaceContext ? { fingerprint: workspaceContext.fingerprint, objectId: workspaceContext.objectId } : null,
    threadId: parent?.threadId || parent?.id || id,
    turn: (parent?.turn || 0) + 1,
    owner,
    createdAt,
    updatedAt: createdAt,
    status: classified.intent === 'needs_clarification' ? 'needs_input' : classified.intent === 'permission_denied' ? 'denied' : nonExecutingIntent ? 'completed' : 'waiting_confirmation',
    // 模型理解不可用时的降级标记。状态本身由服务端确定性分类决定（不再是死路一条的
    // 'failed'），但降级事实必须对前端与审计可见，不得静默。
    modelUnavailable: turnUnavailable || null,
    intent: classified.intent,
    title: text.slice(0, 42) || '根据受控材料建设语义模型',
    request: text,
    messages: [...visibleMessages, { role: 'user', content: text, time: createdAt }].slice(-80),
    materialContext: boundedMaterial([material.modelContext, previousMaterial].filter(Boolean).join('\n'), 12000),
    materialRefs: workspace.refs,
    materialIncomplete: Boolean((parent?.originRoleId === role.id && parent?.materialIncomplete) || material.reports.some(item => !item.modelContentEligible || item.partial || (item.truncated && !item.extractionComplete))),
    materialReview: material.reports.length ? { summary: material.summary, reports: material.reports } : parent?.materialReview || null,
    command: classified.command,
    requiredPermission: classified.permission === 'meta_model.draft.review' ? 'meta_model.draft.save' : classified.permission,
    reviewPermission: classified.intent === 'build_model' ? 'meta_model.draft.review' : parent?.reviewPermission || null,
    confirmationRequired: !nonExecutingIntent,
    confirmation: !nonExecutingIntent ? { state: 'not_issued' } : null,
    originRoleId: role?.id || null,
    originDeviceId: identityScope?.deviceId || null,
    plan: planFor(classified.intent),
    planning,
    routing: turnUnavailable
      ? { mode: 'server_rules_fallback', source: 'understanding_failed', decision: classified.intent, reason: classified.reason, degraded: true, modelFailureCode: turn.failureCode || null }
      : { mode: turn ? 'model_understanding_server_gated' : 'server_rules', source: turn?.source || 'server_rules', decision: classified.intent, reason: classified.reason },
    sourceDiscovery,
    ...(classified.intent === 'approve_model' ? { proposal: parent?.proposal || null } : {}),
    // 范围来源与覆盖结果必须留在任务上，供审阅与审计追溯（阶段 3）；被排除项的可读清单见 ADR-013。
    systemScope: scope ? {
      selectionSource: 'explicit',
      selected: scope.systemCodes,
      mentionedNotSelected: scope.mentionedNotSelected,
      covered: [],
      uncovered: scope.systemCodes.map((code) => ({ code, reason: '尚未生成提案，无法判断覆盖情况。' })),
      excludedObjects: [],
      excludedRelationships: [],
      partialScopeObjects: [],
      unassignedObjects: []
    } : null,
    events: [
      ...(turnUnavailable ? [{ time: createdAt, type: 'model_understanding_unavailable', detail: `模型理解不可用（${turn.failureCode || 'MODEL_RESULT_UNAVAILABLE'}）；已回落到服务端确定性分类，规则判定为“${classified.intent}”。发布动作不参与回落。` }] : []),
      { time: createdAt, type: conversationalIntent ? 'conversation_routed' : 'intent_understood', detail: conversationalIntent ? `服务器识别为“${classified.intent}”，未创建可执行命令。` : `服务器已绑定“${classified.intent}”任务，尚未执行修改。` }
    ]
  };
  if (planning) task.events.push({ time: now(), type: 'planning_completed', detail: ['local_model_advisory', 'external_model_advisory'].includes(planning.mode) ? `${planning.provider === 'ark' ? '火山方舟' : planning.mode === 'local_model_advisory' ? '本地模型' : '云端模型'}已生成结构化规划建议；执行边界仍由服务器控制。` : '已使用确定性规划；执行边界由服务器控制。' });
  if (classified.intent === 'build_model') {
    const sourceMaterialIncomplete = task.materialIncomplete || (!workspace.refs.length && /【附件记忆为节选/.test(previousMaterial));
    const proposal = await createSemanticOperationsProposalFromRequest({ body: { ...body, text: contextualText, sourceMaterial: `${visibleMessages.filter(item => item.role === 'user').map(item => item.content).join('\n')}\n${text}` }, role, identityScope, scannedMaterial: material, sourceMaterialIncomplete, workspaceDocuments: workspace.documents, scopeSystems: scope.systemCodes });
    if (proposal.error) {
      if (proposal.code !== 'SEMANTIC_PROPOSAL_NO_GROUNDED_OBJECTS') return proposal;
      task.intent = 'needs_clarification';
      task.status = 'needs_input';
      task.command = null;
      task.requiredPermission = null;
      task.confirmationRequired = false;
      task.plan = [];
      task.planning = null;
      task.routing = { ...task.routing, decision: 'needs_clarification', reason: 'proposal_objects_not_grounded' };
      task.response = proposal.error;
      task.events.push({ time: now(), type: 'clarification_requested', detail: '未从诉求或材料中识别到有依据的候选对象，未生成提案。' });
    } else {
      task.proposal = proposal;
      task.systemScope = summarizeSystemScopeCoverage(task.systemScope, proposal);
      task.response = `已生成 ${proposal.objectTypes.length} 个候选对象和 ${proposal.relationshipTypes.length} 条关系；Schema Critic ${proposal.critic.status === 'passed' ? '已通过' : '未通过'}，Mock 映射演练${proposal.mappingValidation.blocked ? '存在阻断' : proposal.mappingValidation.status === 'passed' ? '已通过' : '已完成部分验证'}。${proposal.critic.status !== 'passed' || proposal.mappingValidation.blocked ? '请先校对来源、字段类型和映射；校验通过前不能采纳。' : '请审阅 Diff、影响和样本预览后确认是否采纳。'}`;
      const findings = describeScopeFindings(task.systemScope);
      if (findings.length) task.response += ` 范围覆盖：所选 ${task.systemScope.selected.join('/')}，已覆盖 ${task.systemScope.covered.join('/') || '无'}。${findings.join('；')}。`;
      const identityFindings = describeIdentityFindings(proposal.identityLinking);
      if (identityFindings.length) {
        task.response += ` 标识对应：${identityFindings.join('；')}。`;
        task.events.push({ time: now(), type: 'system_identity_linking_reported', detail: identityFindings.join('；') });
      }
      task.events.push({ time: now(), type: 'proposal_created', detail: `生成候选模型，Critic=${proposal.critic.status}，Mapping=${proposal.mappingValidation.status}。` });
      if (findings.length) task.events.push({ time: now(), type: 'system_scope_coverage_reported', detail: findings.join('；') });
    }
  } else if (classified.intent === 'discover_sources') {
    task.result = sourceDiscovery;
    task.systemScope = { ...task.systemScope, covered: [...scope.systemCodes], uncovered: [] };
    task.response = `已按所选范围检查 ${sourceDiscovery.sources.length} 个来源；发现 ${sourceDiscovery.blockers.length} 个阻断项和 ${sourceDiscovery.warnings.length} 个准备提醒，未读取任何业务明细。`;
    task.events.push({ time: now(), type: 'source_discovery_completed', detail: `来源预检完成，blockers=${sourceDiscovery.blockers.length}。` });
  } else if (classified.intent === 'inspect_status') {
    task.result = await inspectStatus(identityScope);
    const previous = parent?.intent === 'inspect_status' ? parent.result : null;
    const changed = previous && ['objectCount', 'relationshipCount', 'validationStatus', 'simulationStatus', 'activeSnapshotCount'].some((key) => previous[key] !== task.result[key]);
    const comparison = previous ? changed
      ? `与上一轮相比发生变化：对象 ${previous.objectCount}→${task.result.objectCount}，关系 ${previous.relationshipCount}→${task.result.relationshipCount}，校验 ${previous.validationStatus}→${task.result.validationStatus}，模拟 ${previous.simulationStatus}→${task.result.simulationStatus}。`
      : '与上一轮检查结果一致，当前未发现对象数量、关系数量、校验、模拟或快照状态变化。' : '';
    task.response = `当前草稿包含 ${task.result.objectCount} 个对象、${task.result.relationshipCount} 条关系；校验状态为 ${task.result.validationStatus}，模拟状态为 ${task.result.simulationStatus}。${comparison}`;
    task.events.push({ time: now(), type: 'read_completed', detail: '只读状态检查完成。' });
  } else if (conversationalIntent) {
    task.response = classified.response;
    task.events.push({
      time: now(),
      type: classified.intent === 'needs_clarification' ? 'clarification_requested' : classified.intent === 'permission_denied' ? 'permission_denied' : 'conversation_completed',
      detail: turnUnavailable
        ? '模型理解不可用，本条回答由服务端确定性规则生成；未生成提案、未读取业务明细、未创建可执行动作。'
        : '本次未生成提案、未读取业务明细、未创建可执行动作。'
    });
  } else {
    task.response = `已形成“${commandLabel[classified.command]}”执行计划。该操作尚未执行，需要当前运营人员明确确认。`;
  }
  if (task.confirmationRequired) {
    task.reviewContext = {
      draftFingerprint: await currentDraftFingerprint(),
      proposalId: task.proposal?.id || null,
      proposalRevision: task.proposal?.revision || null,
      capturedAt: now()
    };
  }
  task.messages.push({ role: 'assistant', content: task.response, time: now() });
  await mutateTaskIndex((index) => {
    index[id] = task;
    return { value: index };
  });
  await traceEvent(trace.id, 'semantic_intent_routed', 'routing', 'completed', '元域智语意图已由服务器规则绑定。', { intent: task.intent, command: task.command, reason: task.routing?.reason, parentTaskId: task.parentTaskId });
  if (task.planning) await traceEvent(trace.id, 'semantic_plan_created', 'planning', 'completed', '元域智语规划已生成，执行边界仍由服务器控制。', { mode: task.planning.mode, authoritativeIntent: task.planning.authoritativeIntent, stepCount: task.plan?.length || 0 });
  if (task.sourceDiscovery) await traceEvent(trace.id, 'semantic_sources_inspected', 'evidence', 'completed', '已完成受控来源预检，未读取业务明细。', { sourceCount: task.sourceDiscovery.sources?.length || 0, blockers: task.sourceDiscovery.blockers?.length || 0 });
  if (task.proposal) await traceEvent(trace.id, 'semantic_proposal_generated', 'proposal', task.proposal.critic?.status || 'completed', '候选语义模型与映射验证结果已固定到证据链。', { proposalId: task.proposal.id, revision: task.proposal.revision, objectCount: task.proposal.objectTypes?.length || 0, relationshipCount: task.proposal.relationshipTypes?.length || 0, mappingStatus: task.proposal.mappingValidation?.status });
  if (task.intent === 'inspect_status') await traceEvent(trace.id, 'semantic_read_completed', 'read', 'completed', '只读语义状态快照已固定到证据链。', task.result);
  await setAgentEvidenceTraceStatus(trace.id, task.confirmationRequired ? 'awaiting_confirmation' : task.status, { completed: ['completed', 'denied', 'failed'].includes(task.status) });
  if (task.intent === 'publish_model' && /^(?:确认|现在|立即)?发布(?:当前|这个|该)?(?:语义)?模型[。！!\s]*$/u.test(text)) {
    const confirmation = await issueSemanticOperationsTaskConfirmation({ taskId: task.id, identityScope, accessContext });
    if (confirmation.error) return { error: confirmation.error, status: 409, code: confirmation.code, task: confirmation.task };
    const execution = await executeSemanticOperationsTask({ taskId: task.id, role, identityScope, accessContext, confirmationToken: confirmation.confirmationToken });
    await appendTaskMessage(task.id, 'assistant', execution.task?.response || execution.error);
    return execution.error ? { error: execution.error, status: 409, code: execution.code, task: execution.task } : getSemanticOperationsTask({ taskId: task.id, identityScope });
  }
  if (task.proposal && task.command === 'apply_proposal' && task.status === 'waiting_confirmation') {
    await createSemanticOperationsNotification({ identityScope, severity: 'action_required', title: '语义模型待审核',
      message: `Agent 已生成“${task.title}”语义模型图，包含 ${task.proposal.objectTypes?.length || 0} 个业务对象、${task.proposal.relationshipTypes?.length || 0} 条对象关系。请在 Agent 工作台查看对象关系与底层系统链路，可用自然语言提出修改或审核通过。`,
      sourceType: 'semantic_model_review', sourceId: task.id, audiencePermissionId: task.reviewPermission || 'meta_model.draft.review', action: { type: 'open_semantic_task', taskId: task.id } });
  }
  return publicTask(task);
}

export async function getSemanticOperationsTaskTrace({ taskId: id, identityScope, accessContext }) {
  const task = await getSemanticOperationsTask({ taskId: id, identityScope, accessContext });
  if (!task?.traceId) return null;
  return getAgentEvidenceTrace(task.traceId, accessContext?.roleIds || [task.originRoleId].filter(Boolean), identityScope);
}

export function listSemanticOperationsTasks({ identityScope, accessContext, status, query, includeArchived = false, limit = 30, offset = 0 }) {
  const search = normalize(query).toLowerCase();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, 1_000_000));
  return mapMaybe(getIndex(), (index) => Object.values(index)
    .filter((task) => taskCanBeViewed(task, accessContext, identityScope) && (!status || task.status === status))
    .filter((task) => includeArchived || !task.archivedAt)
    .filter((task) => !search || `${task.title} ${task.request} ${task.intent}`.toLowerCase().includes(search))
    .filter((task) => taskCanBeViewed(task, accessContext, identityScope))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(safeOffset, safeOffset + safeLimit)
    .map((task) => ({ ...publicTask(task), reviewerAccess: !semanticOperationsOwnerMatches(task.owner, identityScope) })));
}

export function getSemanticOperationsTask({ taskId: id, identityScope, accessContext }) {
  return mapMaybe(getIndex(), (index) => {
    const task = index[id];
    return task && taskCanBeViewed(task, accessContext, identityScope) ? { ...publicTask(task), reviewerAccess: !semanticOperationsOwnerMatches(task.owner, identityScope) } : null;
  });
}

export function archiveSemanticOperationsTask({ taskId: id, identityScope }) {
  return mutateTaskIndex((index) => {
    const task = index[id];
    if (!task || !semanticOperationsOwnerMatches(task.owner, identityScope)) return { commit: false, result: { error: '未找到属于当前身份的元域智语任务。', code: 'SEMANTIC_TASK_NOT_FOUND' } };
    if (task.status === 'executing') return { commit: false, result: { error: '执行中的任务不能归档。', code: 'SEMANTIC_TASK_ARCHIVE_BLOCKED' } };
    task.archivedAt = now();
    task.updatedAt = task.archivedAt;
    task.events.push({ time: task.archivedAt, type: 'task_archived', detail: '任务已从活动列表归档，审计记录仍保留。' });
    index[id] = task;
    return { value: index, result: { task: publicTask(task) } };
  });
}

export async function recordSemanticOperationsReportExport({ taskId: id, receipt, identityScope }) {
  const valid = receipt?.destination === 'semantic_reports'
    && /^[^/\\]{1,120}\.(json|md|csv)$/.test(String(receipt?.fileName || ''))
    && /^[a-f0-9]{64}$/.test(String(receipt?.sha256 || ''))
    && Number(receipt?.bytes) > 0 && Number(receipt?.bytes) <= 2 * 1024 * 1024;
  if (!valid) return { error: '报告导出回执无效，未写入审计记录。', code: 'SEMANTIC_REPORT_RECEIPT_INVALID' };
  const result = await mutateTaskIndex((index) => {
    const task = index[id];
    if (!task || !semanticOperationsOwnerMatches(task.owner, identityScope)) return { commit: false, result: { error: '未找到属于当前身份的元域智语任务。', code: 'SEMANTIC_TASK_NOT_FOUND' } };
    const time = now();
    task.events.push({ time, type: 'governed_report_exported', detail: `已导出 ${receipt.fileName}（${receipt.bytes} bytes，SHA-256 ${receipt.sha256.slice(0, 12)}…）。` });
    task.updatedAt = time; index[id] = task;
    return { value: index, result: { task: publicTask(task), receipt: { destination: receipt.destination, fileName: receipt.fileName, bytes: receipt.bytes, sha256: receipt.sha256, createdAt: receipt.createdAt || time } } };
  });
  if (result?.task?.traceId) await traceEvent(result.task.traceId, 'semantic_report_exported', 'reporting', 'completed', '本机受控报告导出回执已记录。', result.receipt);
  return result;
}

export function reviseSemanticOperationsTaskProposal({ taskId: id, body, role, identityScope }) {
  const operationResult = mapMaybe(getIndex(), (indexSnapshot) => {
  const task = indexSnapshot[id];
  if (!task || !semanticOperationsOwnerMatches(task.owner, identityScope)) return { error: '未找到属于当前身份的元域智语任务。', code: 'SEMANTIC_TASK_NOT_FOUND' };
  if (task.status !== 'waiting_confirmation' || task.command !== 'apply_proposal' || !task.proposal?.id) return { error: '当前任务没有可修订的待确认模型提案。', code: 'SEMANTIC_TASK_PROPOSAL_NOT_EDITABLE' };
    return mapMaybe(updateSemanticOperationsProposal({
    proposalId: task.proposal.id,
    revision: body?.revision,
    objectTypes: body?.objectTypes,
      relationshipTypes: body?.relationshipTypes,
      primaryKeyCorrections: body?.primaryKeyCorrections,
      identityLinkConfirmations: body?.identityLinkConfirmations,
      identityConflictRulings: body?.identityConflictRulings,
      declarationRulings: body?.declarationRulings,
    sourceAssignments: body?.sourceAssignments,
    candidateFieldWithdrawal: body?.candidateFieldWithdrawal,
    candidateObjectWithdrawal: body?.candidateObjectWithdrawal,
    candidateRelationshipWithdrawal: body?.candidateRelationshipWithdrawal,
    role,
    identityScope
  }), (proposal) => {
  if (proposal.error) return proposal;
  return mapMaybe(currentDraftFingerprint(), (draftFingerprint) => {
  task.proposal = proposal;
  task.updatedAt = now();
  task.confirmation = { state: 'not_issued' };
  task.reviewContext = {
    draftFingerprint,
    proposalId: proposal.id,
    proposalRevision: proposal.revision,
    capturedAt: task.updatedAt
  };
  const ready = proposal.critic.status === 'passed' && !proposal.mappingValidation.blocked;
  // 并入结果必须**逐项**说清：并了几条、哪条被材料证据挡住、哪条因字段修订失效。
  // 只说「已保存」会让「我勾了但它没生效」变成无从追问的状态。
  //
  // 阶段 4c：裁定的话必须先说，因为它决定了哪些链接还存在——确认是按链接给的，
  // 先报「并入了几条」再说「有两条被裁定撤下」，读起来就成了两次矛盾的结论。
  const rulingReport = proposal.identityLinking?.rulingReport || null;
  const staleNotes = (items) => items.map((item) => `${item.key}（${item.reason}）`).join('、');
  const rulingNotes = rulingReport ? [
    ...(rulingReport.applied.length ? [`已裁定 ${rulingReport.applied.length} 个概念的标识等价关系（${rulingReport.applied.map((item) => `${item.concept}＝${item.ruling === 'same_entity' ? '同一实体' : '不同实体'}`).join('、')}）。`] : []),
    ...(rulingReport.droppedStale.length ? [`${rulingReport.droppedStale.length} 条此前的等价裁定已失效并移除（${rulingReport.droppedStale.map((item) => `${item.concept}：${item.reason}`).join('、')}）。`] : []),
    ...((proposal.identityLinking?.withdrawnLinks?.length) ? [`因裁定为不同实体，撤下 ${proposal.identityLinking.withdrawnLinks.length} 条跨等价类的标识对应（${proposal.identityLinking.withdrawnLinks.map((item) => `${item.from}→${item.to}`).join('、')}）；它们不再出现在可确认清单里，此前的确认随之失效。`] : []),
    ...(rulingReport.unresolvedConcepts.length ? [`仍有 ${rulingReport.unresolvedConcepts.length} 个概念（${rulingReport.unresolvedConcepts.join('、')}）的等价前提未裁定。`] : [])
  ].join('') : '';
  const linkReport = proposal.identityLinkConfirmationReport;
  const mappedLinks = (proposal.identityLinkConfirmations || []).filter((item) => item.keyMapping);
  const shapeNotes = (linkReport?.shapeResolutions || []).map((item) => `${item.field} 判定为${item.shape === 'agent' ? '代理键' : '业务键'}（与另一端${item.resolvedStatus === 'linkable' ? '一致，可按值对齐' : '不同，需建立映射'}）`);
  const linkNotes = linkReport ? [
    linkReport.merged ? `已并入 ${linkReport.merged} 条人工确认的标识对应（标记为推断，未取得材料级证据）。` : '',
    // 阶段 4d（ADR-019）：结构化映射与形状判定都是**这次修订产生的新结论**，必须出现在回应里。
    // 否则运营看不到自己填的定义去了哪儿——它进的是草稿里的 `keyMapping` 字段，不是一段散文。
    mappedLinks.length ? `其中 ${mappedLinks.length} 条带结构化映射定义（${mappedLinks.map((item) => `${item.keyMapping.fromField}→${item.keyMapping.toField}，责任人 ${item.keyMapping.owner} / 版本 ${item.keyMapping.version}`).join('、')}），已随关系写入草稿。` : '',
    shapeNotes.length ? `另有 ${shapeNotes.length} 条对应的一端键形状由人工判定：${shapeNotes.join('、')}。` : '',
    linkReport.skippedExisting.length ? `${linkReport.skippedExisting.length} 条确认项已有材料证据的同名关系，未用推断覆盖证据。` : '',
    linkReport.droppedStale.length ? `${linkReport.droppedStale.length} 条此前确认的标识对应已失效并被移除：${staleNotes(linkReport.droppedStale)}。` : ''
  ].filter(Boolean).join('') : '';
  // 阶段 4e（ADR-020）：**不可并入的对应必须在回应里说出来**。只报「已并入 N 条」，会让
  // 「11 条里有 4 条这次用不了、因为对象没进候选」变成一次静默损失——原因与下一步动作都要给出。
  const ineligibleLinks = (proposal.identityLinking?.links || []).filter((item) => !item.eligible);
  const eligibilityNotes = ineligibleLinks.length
    ? `另有 ${ineligibleLinks.length} 条对应本次不可并入：${[...new Set(ineligibleLinks.flatMap((item) => item.ineligibleEndpoints.map((endpoint) => `${endpoint.system}.${endpoint.objectId}`)))].join('、')} 不在本次候选对象内（它们只在系统声明里存在），需先让这些对象成为候选对象。`
    : '';
  // 阶段 4c 第三段：同名声明裁定改的是**字段目录的组成**。它排在等价裁定之后、确认之前说，
  // 因为「对象被拆成两个 / 某份声明被排除」会改变后面所有链接的证据字符串与计数。
  const declarationReport = proposal.identityLinking?.declarationReport || null;
  const declarationNotes = declarationReport ? [
    ...(declarationReport.applied.length ? [`已裁定 ${declarationReport.applied.length} 项同名声明分歧（${declarationReport.applied.map((item) => `${item.key}＝${item.ruling === 'merge' ? '同一对象（字段并集）' : '不同对象（不并集）'}`).join('、')}）。`] : []),
    ...(declarationReport.splitObjects.length ? [`因裁定区分粒度拆出 ${declarationReport.splitObjects.length} 处（${declarationReport.splitObjects.map((item) => `${item.from}→${item.into.map((group) => group.name).join('/')}`).join('、')}）；被拆出的对象只是来源系统的声明，尚未进入提案。`] : []),
    ...(declarationReport.droppedDeclarations.length ? [`同时显式排除 ${declarationReport.droppedDeclarations.length} 条声明（${declarationReport.droppedDeclarations.map((item) => item.declarationKey).join('、')}），它们的字段不再进入字段目录。`] : []),
    ...(declarationReport.droppedLinks.length ? [`${declarationReport.droppedLinks.length} 条标识对应因对象改名或字段集改变而不再存在：${declarationReport.droppedLinks.map((item) => item.evidence).join('、')}；此前的确认随之失效。`] : []),
    ...(declarationReport.droppedStale.length ? [`${declarationReport.droppedStale.length} 条此前的同名声明裁定已失效并移除（${declarationReport.droppedStale.map((item) => item.key).join('、')}）。`] : []),
    ...(declarationReport.unresolvedItems.length ? [`仍有 ${declarationReport.unresolvedItems.length} 项同名声明分歧未裁定（${declarationReport.unresolvedItems.join('、')}），这些对象的字段目录仍是并集。`] : [])
  ].join('') : '';
  // 归属确认是**改事实**的动作（写进 sourceSystems、可能改变范围裁剪结果），所以它必须排在最前面说：
  // 「这次把哪些对象的来源定了下来」会改变后面所有结论的解释口径。
  const assignmentNotes = (proposal.sourceAssignments || []).length
    ? `已确认 ${proposal.sourceAssignments.length} 个对象的来源归属（${proposal.sourceAssignments.map((item) => `${item.objectId}→${item.system}`).join('、')}），来源系统已按确认写入。`
    : '';
  task.response = `提案已保存为第 ${proposal.revision} 版；Schema Critic ${proposal.critic.status === 'passed' ? '已通过' : '未通过'}，Mock 映射演练${proposal.mappingValidation.blocked ? '存在阻断' : proposal.mappingValidation.status === 'passed' ? '已通过' : '已完成部分验证'}。${assignmentNotes}${declarationNotes}${rulingNotes}${linkNotes}${eligibilityNotes}${ready ? '可以确认写入草稿。' : '请根据检查结果继续修订。'}`;
  task.events.push({ time: task.updatedAt, type: 'proposal_revised', detail: `提案修订为 revision=${proposal.revision}，Critic=${proposal.critic.status}，Mapping=${proposal.mappingValidation.status}。` });
  const mutation = mutateTaskIndex((index) => {
    const current = index[id];
    if (!current || !semanticOperationsOwnerMatches(current.owner, identityScope) || current.status !== 'waiting_confirmation' || current.proposal?.revision !== proposal.revision - 1) return { commit: false, result: { error: '任务状态或模型修订已并发变化，请刷新后重新审阅。', code: 'SEMANTIC_TASK_PROPOSAL_CONCURRENT_STATE' } };
    // A revision may await sample validation while another reviewer transfers
    // the task. Preserve the latest assignment, messages and execution state.
    index[id] = { ...current, proposal, updatedAt: task.updatedAt, confirmation: task.confirmation, reviewContext: task.reviewContext, response: task.response, events: [...(current.events || []), task.events.at(-1)] };
    return { value: index, result: publicTask(index[id]) };
  });
  return mutation;
  });
  });
  });
  return mapMaybe(operationResult, (result) => {
    if (result?.traceId) void traceEvent(result.traceId, 'semantic_proposal_revised', 'proposal', 'completed', '运营人员已修订候选模型，旧确认凭证失效。', { revision: result.proposal?.revision }).catch(() => {});
    return result;
  });
}

export function issueSemanticOperationsTaskConfirmation({ taskId: id, identityScope, accessContext }) {
  const rawToken = randomBytes(32).toString('base64url');
  const operationResult = mapMaybe(currentDraftFingerprint(), (draftFingerprint) => mutateTaskIndex((index) => {
    const task = index[id];
    if (!task || !canConfirmTask(task, identityScope, accessContext)) {
      return { commit: false, result: { error: '当前角色无权审核该语义模型，或任务不属于当前租户。', code: 'SEMANTIC_TASK_REVIEW_ACCESS_DENIED' } };
    }
    if (task.status === 'executing' && task.execution?.leaseExpiresAt && Date.parse(task.execution.leaseExpiresAt) <= Date.now()) {
      task.status = 'retryable';
      task.events.push({ time: now(), type: 'execution_lease_recovered', detail: '上一次执行租约已超时，任务已恢复为可重试。' });
    }
    if (!['waiting_confirmation', 'retryable'].includes(task.status) || !task.confirmationRequired) {
      return { commit: false, result: { error: '该任务当前不可签发确认凭证。', code: 'SEMANTIC_TASK_NOT_CONFIRMABLE' } };
    }
    if (task.reviewContext?.draftFingerprint !== draftFingerprint) {
      return { commit: false, result: { error: '语义草稿已发生变化，请重新创建或修订任务后再确认。', code: 'SEMANTIC_TASK_REVIEW_STALE' } };
    }
    if (task.proposal && task.reviewContext?.proposalRevision !== task.proposal.revision) {
      return { commit: false, result: { error: '模型提案版本已发生变化，请重新审阅后再确认。', code: 'SEMANTIC_TASK_REVIEW_STALE' } };
    }
    if (task.proposal && (task.proposal.critic?.status !== 'passed' || task.proposal.mappingValidation?.blocked)) {
      return { commit: false, result: { error: '候选模型校验或来源映射仍有阻断，请先修订，不能签发确认凭证。', code: 'SEMANTIC_TASK_PROPOSAL_BLOCKED' } };
    }
    const issuedAt = now();
    const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString();
    task.confirmation = { state: 'issued', tokenHash: confirmationTokenHash(rawToken), issuedAt, expiresAt };
    task.updatedAt = issuedAt;
    task.events.push({ time: issuedAt, type: 'confirmation_issued', detail: '已签发一次性确认凭证，有效期 10 分钟。' });
    index[id] = task;
    return { value: index, result: { task: publicTask(task), confirmationToken: rawToken, expiresAt } };
  }));
  return mapMaybe(operationResult, (result) => {
    if (result?.task?.traceId) {
      void traceEvent(result.task.traceId, 'semantic_confirmation_issued', 'confirmation', 'awaiting_user', '已签发绑定草稿指纹和提案版本的一次性确认凭证。', { expiresAt: result.expiresAt, proposalRevision: result.task.proposal?.revision }).catch(() => {});
      void setAgentEvidenceTraceStatus(result.task.traceId, 'confirmed_pending_execution').catch(() => {});
    }
    return result;
  });
}

const reserveExecution = ({ id, identityScope, accessContext, confirmationToken }) => mapMaybe(currentDraftFingerprint(), (draftFingerprint) => mutateTaskIndex((index) => {
  const task = index[id];
  if (!task || !canConfirmTask(task, identityScope, accessContext)) {
    return { commit: false, result: { error: '当前角色无权审核该语义模型，或任务不属于当前租户。', code: 'SEMANTIC_TASK_REVIEW_ACCESS_DENIED' } };
  }
  if (!['waiting_confirmation', 'retryable'].includes(task.status)) {
    return { commit: false, result: { error: '该任务已经执行、正在执行或不可重复确认。', code: 'SEMANTIC_TASK_NOT_CONFIRMABLE' } };
  }
  const suppliedHash = confirmationTokenHash(confirmationToken);
  if (task.confirmation?.state !== 'issued' || !safeTokenHashEqual(task.confirmation.tokenHash, suppliedHash)) {
    return { commit: false, result: { error: '缺少有效的一次性确认凭证。', code: 'SEMANTIC_TASK_CONFIRMATION_INVALID' } };
  }
  if (!task.confirmation.expiresAt || Date.parse(task.confirmation.expiresAt) <= Date.now()) {
    task.confirmation = { ...task.confirmation, state: 'expired', tokenHash: null };
    index[id] = task;
    return { value: index, result: { error: '确认凭证已过期，请重新确认。', code: 'SEMANTIC_TASK_CONFIRMATION_EXPIRED' } };
  }
  if (task.reviewContext?.draftFingerprint !== draftFingerprint
    || (task.proposal && task.reviewContext?.proposalRevision !== task.proposal.revision)) {
    task.confirmation = { ...task.confirmation, state: 'invalidated', tokenHash: null };
    index[id] = task;
    return { value: index, result: { error: '确认后草稿或提案已发生变化，本次执行已阻止。', code: 'SEMANTIC_TASK_REVIEW_STALE' } };
  }
  const startedAt = now();
  task.status = 'executing';
  task.updatedAt = startedAt;
  task.execution = { attempt: (task.execution?.attempt || 0) + 1, startedAt, leaseExpiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString() };
  task.confirmation = { ...task.confirmation, state: 'consumed', tokenHash: null, consumedAt: startedAt };
  task.events.push({ time: startedAt, type: 'execution_started', detail: commandLabel[task.command] });
  index[id] = task;
  return { value: index, result: { task: structuredClone(task) } };
}));

const finalizeExecution = ({ id, identityScope, accessContext, result }) => mutateTaskIndex((index) => {
  const task = index[id];
  if (!task || !canConfirmTask(task, identityScope, accessContext)) {
    return { commit: false, result: { error: '执行结果无法归档：任务不存在或当前角色无权审核。', code: 'SEMANTIC_TASK_REVIEW_ACCESS_DENIED' } };
  }
  if (task.status !== 'executing') {
    return { commit: false, result: { error: '执行结果无法归档：任务状态不一致。', code: 'SEMANTIC_TASK_STATE_CONFLICT' } };
  }
  task.updatedAt = now();
  task.execution = { ...task.execution, finishedAt: task.updatedAt };
  if (result.error) {
    const retryable = result.retryable === true || result.semanticValidation?.status === 'unavailable' || result.semanticDeployment?.status === 'unavailable';
    task.status = retryable ? 'retryable' : 'blocked';
    task.response = result.error;
    task.result = result;
    task.events.push({ time: task.updatedAt, type: retryable ? 'execution_retryable' : 'execution_blocked', detail: result.error });
  } else {
    task.status = 'completed';
    task.result = result;
    task.response = task.command === 'apply_proposal' ? result.message : `${commandLabel[task.command]}已完成，结果已写入受控审计记录。`;
    task.events.push({ time: task.updatedAt, type: 'execution_completed', detail: commandLabel[task.command] });
  }
  index[id] = task;
  return { value: index, result: result.error
    ? { error: result.error, code: 'SEMANTIC_TASK_EXECUTION_BLOCKED', task: publicTask(task) }
    : { task: publicTask(task), result } };
});

export async function executeSemanticOperationsTask({ taskId: id, role, identityScope, accessContext, confirmationToken }) {
  const reservation = await reserveExecution({ id, identityScope, accessContext, confirmationToken });
  if (reservation.error) return reservation;
  const task = reservation.task;
  await traceEvent(task.traceId, 'semantic_execution_started', 'execution', 'started', '一次性确认凭证已消费，受控语义命令开始执行。', { command: task.command, attempt: task.execution?.attempt });
  await setAgentEvidenceTraceStatus(task.traceId, 'executing');
  let result;
  try {
    if (task.command === 'apply_proposal') {
      result = await applySemanticOperationsProposal({ proposalId: task.proposal.id, role, identityScope, accessContext });
    } else if (task.command === 'validate_model') {
      result = await validateOAMetaModelDraft(role);
    } else if (task.command === 'simulate_model') {
      result = await simulateBuildOAMetaModel(role);
      if (!result.error) {
        const semanticValidation = await validateSemanticaModelDefinition(result.metaModel);
        result = { ...result, semanticValidation };
        if (semanticValidation.status === 'failed' || semanticValidation.status === 'unavailable') {
          result.error = semanticValidation.detail || 'Semantica 未通过模型定义校验。';
          result.retryable = semanticValidation.status === 'unavailable';
        }
      }
    } else if (task.command === 'publish_model') {
      result = await publishGovernedOntology({ role, identityScope });
    } else result = { error: '该任务没有可执行的受控命令。' };
  } catch (error) {
    result = { error: `执行失败：${error.message}`, retryable: true };
  }
  const finalized = await finalizeExecution({ id, identityScope, accessContext, result });
  await traceEvent(task.traceId, result.error ? 'semantic_execution_blocked' : 'semantic_execution_completed', 'execution', result.error ? 'blocked' : 'completed', result.error || '元域智语命令已完成并归档结果。', { command: task.command, retryable: result.retryable === true });
  await setAgentEvidenceTraceStatus(task.traceId, result.error ? (result.retryable ? 'retryable' : 'blocked') : 'completed', { completed: !result.error });
  return finalized;
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { configureSemanticGovernanceRepository, getSemanticGovernanceStoreInfo, mutateSemanticGovernanceState, probeSemanticGovernanceStore, readSemanticGovernanceState } from './semantic-governance-store.js';
import { inspectModelPromptSafety } from './local-model-gateway.js';
import {
  applySemanticOperationsProposal,
  createSemanticOperationsProposalFromRequest,
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
import { discoverSemanticSources } from './semantic-source-discovery-service.js';
import { planSemanticOperationsRequest } from './semantic-operations-planner-service.js';
import { semanticFingerprint } from './semantic-model-fingerprint.js';
import { semanticOperationsOwnerMatches, semanticOperationsPrincipalKey } from './semantic-operations-identity.js';
import { affirmativeRequest, boundedMaterial, understandAgentTurn } from './agent-turn-understanding-service.js';
import { inspectMultimodalInput, extractMultimodalEvidence } from './multimodal-input-service.js';
import { hasButtonPermission } from './access-control-service.js';
import { extendSemanticMaterials, discoverWorkspaceSchemas, materialSchemaIndex } from './semantic-material-workspace-service.js';
import { appendAgentEvidenceEvent, createAgentEvidenceTrace, getAgentEvidenceTrace, setAgentEvidenceTraceStatus } from './agent-evidence-trace-service.js';

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
const mapMaybe = (value, callback) => value && typeof value.then === 'function' ? value.then(callback) : callback(value);
const traceEvent = (traceId, type, stage, status, summary, details = {}) => traceId ? appendAgentEvidenceEvent(traceId, { type, stage, status, actor: { type: 'service', id: 'semantic-operations-agent' }, summary, details }) : null;
const currentDraftFingerprint = () => mapMaybe(getOAMetaModelDraft(), semanticFingerprint);
const taskCanBeViewed = (task, accessContext) => {
  if (!accessContext) return true;
  if (task.requiredPermission && !accessContext.buttonPermissionIds?.includes(task.requiredPermission)) return false;
  if (task.proposal && !accessContext.buttonPermissionIds?.includes('meta_model.draft.save')) return false;
  return true;
};

const operation = (intent, command, permission, reason) => ({ intent, command, permission, reason });
const noOperation = (intent, reason, response) => ({ intent, command: null, permission: null, reason, response });
const includesAnyTerm = (text, terms) => terms.some((term) => text.includes(term));
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
    return noOperation('conversation', 'greeting', '你好，我是语义运营 Agent。我可以协助建设语义模型、检查数据来源、查看草稿状态、运行校验与模拟；涉及写入或发布的操作都会等待你明确确认。');
  }
  if (/(?:你是谁|能做什么|有哪些能力|怎么使用|使用说明|帮助|支持什么)/.test(value)) {
    return noOperation('conversation', 'capability_question', '我负责语义层运营，可以根据自然语言或受控材料建设模型、发现来源、检查状态、校验草稿和运行 Semantica 模拟。请告诉我对象范围、来源系统和目标；写操作会先生成计划并等待确认。');
  }
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
  if (hasBuildAction) {
    const grounded = hasAttachments || includesAnyTerm(value, groundedObjectTerms);
    return grounded
      ? operation('build_model', 'apply_proposal', 'meta_model.draft.save', hasAttachments ? 'explicit_build_with_material' : 'explicit_grounded_build')
      : noOperation('needs_clarification', 'build_scope_missing', '我识别到建模意图，但还缺少对象范围或结构材料。请说明要建设的业务对象、来源系统，或上传数据字典、OpenAPI、JSON Schema、CSV 示例。');
  }
  if (!value && hasAttachments) return operation('build_model', 'apply_proposal', 'meta_model.draft.save', 'attachment_only_build');
  return noOperation('needs_clarification', 'operation_not_identified', '我还不能确定你希望执行哪类语义运营任务。请明确是建设模型、检查来源、查看状态、校验草稿、模拟构建还是发布模型，并补充对象或系统范围。');
}

const planFor = (intent) => ({
  build_model: ['理解业务范围与来源系统', '提取候选对象、主键和字段', '推断对象关系与核心元对象映射', '运行 Schema Critic', '生成相对当前草稿的版本 Diff', '等待人工确认后写入草稿并保存快照'],
  discover_sources: ['识别诉求涉及的企业系统', '按当前角色裁剪连接器目录', '检查企业端点、凭据和来源契约就绪度', '列出建模所需数据字典与样例物料', '返回阻断项，不读取业务明细'],
  inspect_status: ['读取当前身份可见的语义草稿摘要', '读取模型校验、模拟和版本状态', '返回受控运营状态，不执行任何修改'],
  validate_model: ['锁定当前语义草稿版本', '运行对象、关系、审批语义和数据分级校验', '记录校验结果与审计事件'],
  simulate_model: ['校验当前草稿', '生成受控模拟实例', '调用本机 Semantica 验证模型定义', '返回构建结果，不自动发布'],
  publish_model: ['确认模拟构建已经通过', '生成受控模型版本号', '向 Semantica 登记模型定义', '写入发布事件和审计记录'],
  conversation: [],
  needs_clarification: [],
  unsupported_operation: []
}[intent] || []);

const commandLabel = {
  apply_proposal: '采纳模型建议到草稿',
  validate_model: '校验当前语义草稿',
  simulate_model: '运行 Semantica 模拟构建',
  publish_model: '发布并登记语义模型',
  inspect_sources: '检查语义来源与连接物料',
  inspect_status: '读取当前语义层状态'
};

const publicTask = (task) => task && ({
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
  confirmationRequired: task.confirmationRequired,
  confirmation: task.confirmation ? {
    state: task.confirmation.state,
    issuedAt: task.confirmation.issuedAt || null,
    expiresAt: task.confirmation.expiresAt || null,
    consumedAt: task.confirmation.consumedAt || null
  } : null,
  reviewContext: task.reviewContext || null,
  execution: task.execution ? { attempt: task.execution.attempt, startedAt: task.execution.startedAt, leaseExpiresAt: task.execution.leaseExpiresAt, finishedAt: task.execution.finishedAt || null } : null,
  archivedAt: task.archivedAt || null,
  proposal: task.proposal || null,
  planning: task.planning || null,
  sourceDiscovery: task.sourceDiscovery || null,
  result: task.result || null,
  response: task.response,
  routing: task.routing || null,
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
    command: 'apply_proposal', requiredPermission: 'meta_model.draft.save', confirmationRequired: true, confirmation: { state: 'not_issued' },
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

export async function createSemanticOperationsTask({ body, role, identityScope }) {
  const text = normalize(body?.text);
  if (!text && !body?.attachments?.length) return { error: '请输入语义运营目标，或上传一份受控材料。', status: 400 };
  const promptSafety = inspectModelPromptSafety(text);
  if (!promptSafety.safe) return { error: '运营指令未通过安全检查，未创建任务。', status: 400 };
  const owner = identityKey(identityScope);
  const parentId = normalize(body?.parentTaskId);
  const taskIndex = parentId ? await getIndex() : {};
  const parent = parentId ? taskIndex[parentId] : null;
  if (parentId && (!parent || !semanticOperationsOwnerMatches(parent.owner, identityScope))) return { error: '未找到属于当前身份的上文任务。', status: 404, code: 'SEMANTIC_PARENT_TASK_NOT_FOUND' };
  if (parent?.requiredPermission && !hasButtonPermission(role.id, parent.requiredPermission)) return { error: '当前角色不能访问该任务，请新建会话；未读取原任务内容。', status: 403, code: 'SEMANTIC_PARENT_ACCESS_DENIED' };
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
  const turn = await understandAgentTurn({ input: text, history, surface: 'semantic', attachments: multimodal.attachments, material: understandingMaterial, schemaFacts: workspaceDiscovery.objectTypes, safetyIdentifier: `semantic-${role.id}` });
  const contextAnchor = parent?.messages?.find((item) => item.role === 'user')?.content || parent?.request || '';
  const contextualText = turn?.resolvedRequest || (parent && /^(?:继续|再|补充|按照|基于|这个|它|然后|接着|同时)/.test(text)
    ? `延续语义任务“${contextAnchor}”。本轮要求：${text}` : text);
  let classified = classifySemanticOperationsIntent(turn ? text : contextualText, { hasAttachments: Boolean(body?.attachments?.length || workspaceDiscovery.objectTypes.length) });
  if (turn) {
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
  if (classified.permission && !hasButtonPermission(role.id, classified.permission)) classified = noOperation('permission_denied', 'role_permission_denied', '当前角色没有执行该操作的权限，未创建执行计划。可以继续讨论方案，或由具备权限的人员处理。');
  const nonExecutingIntent = ['inspect_status', 'discover_sources', 'conversation', 'needs_clarification', 'unsupported_operation', 'permission_denied'].includes(classified.intent);
  const conversationalIntent = ['conversation', 'needs_clarification', 'unsupported_operation', 'permission_denied'].includes(classified.intent);
  const id = taskId(owner, text);
  const createdAt = now();
  const trace = await createAgentEvidenceTrace({ roleId: role?.id, identityScope, input: text, requestId: id, platform: identityScope?.platform, kind: 'semantic_operations_task' });
  const sourceDiscovery = ['build_model', 'discover_sources'].includes(classified.intent)
    ? discoverSemanticSources({ request: workspaceDiscovery.objectTypes.length ? [...new Set(workspaceDiscovery.objectTypes.flatMap(item => item.sourceSystems || []))].join(' / ') : contextualText, role })
    : null;
  const planning = conversationalIntent ? null : await planSemanticOperationsRequest({ request: contextualText || '根据上传材料建设语义模型', authoritativeIntent: classified.intent, sourceDiscovery, identityScope,
    materialFacts: { objects: workspaceDiscovery.objectTypes.map(item => ({ id: item.id, key: item.key, granularity: item.granularity, systems: item.sourceSystems,
      fields: item.fieldDefinitions.map(f => ({ name: f.name, type: f.type, unit: f.unit, reference: f.reference, referenceField: f.referenceField })) })),
      relationshipCount: workspaceDiscovery.relationshipTypes.length, documentNames: workspace.documents.map(item => item.name) } });
  const task = {
    id,
    traceId: trace.id,
    parentTaskId: parent?.id || null,
    threadId: parent?.threadId || parent?.id || id,
    turn: (parent?.turn || 0) + 1,
    owner,
    createdAt,
    updatedAt: createdAt,
    status: turn?.source === 'understanding_failed' ? 'failed' : classified.intent === 'needs_clarification' ? 'needs_input' : classified.intent === 'permission_denied' ? 'denied' : nonExecutingIntent ? 'completed' : 'waiting_confirmation',
    intent: classified.intent,
    title: text.slice(0, 42) || '根据受控材料建设语义模型',
    request: text,
    messages: [...visibleMessages, { role: 'user', content: text, time: createdAt }].slice(-80),
    materialContext: boundedMaterial([material.modelContext, previousMaterial].filter(Boolean).join('\n'), 12000),
    materialRefs: workspace.refs,
    materialIncomplete: Boolean((parent?.originRoleId === role.id && parent?.materialIncomplete) || material.reports.some(item => !item.modelContentEligible || item.partial || (item.truncated && !item.extractionComplete))),
    materialReview: material.reports.length ? { summary: material.summary, reports: material.reports } : parent?.materialReview || null,
    command: classified.command,
    requiredPermission: classified.permission,
    confirmationRequired: !nonExecutingIntent,
    confirmation: !nonExecutingIntent ? { state: 'not_issued' } : null,
    originRoleId: role?.id || null,
    originDeviceId: identityScope?.deviceId || null,
    plan: planFor(classified.intent),
    planning,
    routing: { mode: turn ? 'model_understanding_server_gated' : 'server_rules', source: turn?.source || 'server_rules', decision: classified.intent, reason: classified.reason },
    sourceDiscovery,
    events: [{ time: createdAt, type: conversationalIntent ? 'conversation_routed' : 'intent_understood', detail: conversationalIntent ? `服务器识别为“${classified.intent}”，未创建可执行命令。` : `服务器已绑定“${classified.intent}”任务，尚未执行修改。` }]
  };
  if (planning) task.events.push({ time: now(), type: 'planning_completed', detail: ['local_model_advisory', 'external_model_advisory'].includes(planning.mode) ? `${planning.provider === 'ark' ? '火山方舟' : planning.mode === 'local_model_advisory' ? '本地模型' : '云端模型'}已生成结构化规划建议；执行边界仍由服务器控制。` : '已使用确定性规划；执行边界由服务器控制。' });
  if (classified.intent === 'build_model') {
    const sourceMaterialIncomplete = task.materialIncomplete || (!workspace.refs.length && /【附件记忆为节选/.test(previousMaterial));
    const proposal = await createSemanticOperationsProposalFromRequest({ body: { ...body, text: contextualText, sourceMaterial: `${visibleMessages.filter(item => item.role === 'user').map(item => item.content).join('\n')}\n${text}` }, role, identityScope, scannedMaterial: material, sourceMaterialIncomplete, workspaceDocuments: workspace.documents });
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
      task.response = `已生成 ${proposal.objectTypes.length} 个候选对象和 ${proposal.relationshipTypes.length} 条关系；Schema Critic ${proposal.critic.status === 'passed' ? '已通过' : '未通过'}，Mock 映射演练${proposal.mappingValidation.blocked ? '存在阻断' : proposal.mappingValidation.status === 'passed' ? '已通过' : '已完成部分验证'}。${proposal.critic.status !== 'passed' || proposal.mappingValidation.blocked ? '请先校对来源、字段类型和映射；校验通过前不能采纳。' : '请审阅 Diff、影响和样本预览后确认是否采纳。'}`;
      task.events.push({ time: now(), type: 'proposal_created', detail: `生成候选模型，Critic=${proposal.critic.status}，Mapping=${proposal.mappingValidation.status}。` });
    }
  } else if (classified.intent === 'discover_sources') {
    task.result = sourceDiscovery;
    task.response = `已检查 ${sourceDiscovery.sources.length} 个相关来源；发现 ${sourceDiscovery.blockers.length} 个阻断项和 ${sourceDiscovery.warnings.length} 个准备提醒，未读取任何业务明细。`;
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
    task.events.push({ time: now(), type: task.status === 'failed' ? 'conversation_failed' : classified.intent === 'needs_clarification' ? 'clarification_requested' : classified.intent === 'permission_denied' ? 'permission_denied' : 'conversation_completed', detail: task.status === 'failed' ? '模型未完成有效回答，可以重试；未生成提案或执行动作。' : '本次未生成提案、未读取业务明细、未创建可执行动作。' });
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
  await traceEvent(trace.id, 'semantic_intent_routed', 'routing', 'completed', '语义运营意图已由服务器规则绑定。', { intent: task.intent, command: task.command, reason: task.routing?.reason, parentTaskId: task.parentTaskId });
  if (task.planning) await traceEvent(trace.id, 'semantic_plan_created', 'planning', 'completed', '语义运营规划已生成，执行边界仍由服务器控制。', { mode: task.planning.mode, authoritativeIntent: task.planning.authoritativeIntent, stepCount: task.plan?.length || 0 });
  if (task.sourceDiscovery) await traceEvent(trace.id, 'semantic_sources_inspected', 'evidence', 'completed', '已完成受控来源预检，未读取业务明细。', { sourceCount: task.sourceDiscovery.sources?.length || 0, blockers: task.sourceDiscovery.blockers?.length || 0 });
  if (task.proposal) await traceEvent(trace.id, 'semantic_proposal_generated', 'proposal', task.proposal.critic?.status || 'completed', '候选语义模型与映射验证结果已固定到证据链。', { proposalId: task.proposal.id, revision: task.proposal.revision, objectCount: task.proposal.objectTypes?.length || 0, relationshipCount: task.proposal.relationshipTypes?.length || 0, mappingStatus: task.proposal.mappingValidation?.status });
  if (task.intent === 'inspect_status') await traceEvent(trace.id, 'semantic_read_completed', 'read', 'completed', '只读语义状态快照已固定到证据链。', task.result);
  await setAgentEvidenceTraceStatus(trace.id, task.confirmationRequired ? 'awaiting_confirmation' : task.status, { completed: ['completed', 'denied', 'failed'].includes(task.status) });
  return publicTask(task);
}

export async function getSemanticOperationsTaskTrace({ taskId: id, identityScope, accessContext }) {
  const task = await getSemanticOperationsTask({ taskId: id, identityScope, accessContext });
  if (!task?.traceId) return null;
  return getAgentEvidenceTrace(task.traceId, accessContext?.roleIds || [task.originRoleId].filter(Boolean), identityScope);
}

export function listSemanticOperationsTasks({ identityScope, accessContext, status, query, includeArchived = false, limit = 30 }) {
  const search = normalize(query).toLowerCase();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
  return mapMaybe(getIndex(), (index) => Object.values(index)
    .filter((task) => semanticOperationsOwnerMatches(task.owner, identityScope) && (!status || task.status === status))
    .filter((task) => includeArchived || !task.archivedAt)
    .filter((task) => !search || `${task.title} ${task.request} ${task.intent}`.toLowerCase().includes(search))
    .filter((task) => taskCanBeViewed(task, accessContext))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, safeLimit).map(publicTask));
}

export function getSemanticOperationsTask({ taskId: id, identityScope, accessContext }) {
  return mapMaybe(getIndex(), (index) => {
    const task = index[id];
    return task && semanticOperationsOwnerMatches(task.owner, identityScope) && taskCanBeViewed(task, accessContext) ? publicTask(task) : null;
  });
}

export function archiveSemanticOperationsTask({ taskId: id, identityScope }) {
  return mutateTaskIndex((index) => {
    const task = index[id];
    if (!task || !semanticOperationsOwnerMatches(task.owner, identityScope)) return { commit: false, result: { error: '未找到属于当前身份的语义运营任务。', code: 'SEMANTIC_TASK_NOT_FOUND' } };
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
    if (!task || !semanticOperationsOwnerMatches(task.owner, identityScope)) return { commit: false, result: { error: '未找到属于当前身份的语义运营任务。', code: 'SEMANTIC_TASK_NOT_FOUND' } };
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
  if (!task || !semanticOperationsOwnerMatches(task.owner, identityScope)) return { error: '未找到属于当前身份的语义运营任务。', code: 'SEMANTIC_TASK_NOT_FOUND' };
  if (task.status !== 'waiting_confirmation' || task.command !== 'apply_proposal' || !task.proposal?.id) return { error: '当前任务没有可修订的待确认模型提案。', code: 'SEMANTIC_TASK_PROPOSAL_NOT_EDITABLE' };
  return mapMaybe(updateSemanticOperationsProposal({
    proposalId: task.proposal.id,
    revision: body?.revision,
    objectTypes: body?.objectTypes,
      relationshipTypes: body?.relationshipTypes,
      primaryKeyCorrections: body?.primaryKeyCorrections,
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
  task.response = `提案已保存为第 ${proposal.revision} 版；Schema Critic ${proposal.critic.status === 'passed' ? '已通过' : '未通过'}，Mock 映射演练${proposal.mappingValidation.blocked ? '存在阻断' : proposal.mappingValidation.status === 'passed' ? '已通过' : '已完成部分验证'}。${ready ? '可以确认写入草稿。' : '请根据检查结果继续修订。'}`;
  task.events.push({ time: task.updatedAt, type: 'proposal_revised', detail: `提案修订为 revision=${proposal.revision}，Critic=${proposal.critic.status}，Mapping=${proposal.mappingValidation.status}。` });
  const mutation = mutateTaskIndex((index) => {
    const current = index[id];
    if (!current || !semanticOperationsOwnerMatches(current.owner, identityScope)) return { commit: false };
    index[id] = task;
    return { value: index };
  });
  return mapMaybe(mutation, () => publicTask(task));
  });
  });
  });
  return mapMaybe(operationResult, (result) => {
    if (result?.traceId) void traceEvent(result.traceId, 'semantic_proposal_revised', 'proposal', 'completed', '运营人员已修订候选模型，旧确认凭证失效。', { revision: result.proposal?.revision }).catch(() => {});
    return result;
  });
}

export function issueSemanticOperationsTaskConfirmation({ taskId: id, identityScope }) {
  const rawToken = randomBytes(32).toString('base64url');
  const operationResult = mapMaybe(currentDraftFingerprint(), (draftFingerprint) => mutateTaskIndex((index) => {
    const task = index[id];
    if (!task || !semanticOperationsOwnerMatches(task.owner, identityScope)) {
      return { commit: false, result: { error: '未找到属于当前身份的语义运营任务。', code: 'SEMANTIC_TASK_NOT_FOUND' } };
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

const reserveExecution = ({ id, identityScope, confirmationToken }) => mapMaybe(currentDraftFingerprint(), (draftFingerprint) => mutateTaskIndex((index) => {
  const task = index[id];
  if (!task || !semanticOperationsOwnerMatches(task.owner, identityScope)) {
    return { commit: false, result: { error: '未找到属于当前身份的语义运营任务。', code: 'SEMANTIC_TASK_NOT_FOUND' } };
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

const finalizeExecution = ({ id, identityScope, result }) => mutateTaskIndex((index) => {
  const task = index[id];
  if (!task || !semanticOperationsOwnerMatches(task.owner, identityScope)) {
    return { commit: false, result: { error: '执行结果无法归档：任务不存在。', code: 'SEMANTIC_TASK_NOT_FOUND' } };
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

export async function executeSemanticOperationsTask({ taskId: id, role, identityScope, confirmationToken }) {
  const reservation = await reserveExecution({ id, identityScope, confirmationToken });
  if (reservation.error) return reservation;
  const task = reservation.task;
  await traceEvent(task.traceId, 'semantic_execution_started', 'execution', 'started', '一次性确认凭证已消费，受控语义命令开始执行。', { command: task.command, attempt: task.execution?.attempt });
  await setAgentEvidenceTraceStatus(task.traceId, 'executing');
  let result;
  try {
    if (task.command === 'apply_proposal') {
      result = await applySemanticOperationsProposal({ proposalId: task.proposal.id, role, identityScope });
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
  const finalized = await finalizeExecution({ id, identityScope, result });
  await traceEvent(task.traceId, result.error ? 'semantic_execution_blocked' : 'semantic_execution_completed', 'execution', result.error ? 'blocked' : 'completed', result.error || '语义运营命令已完成并归档结果。', { command: task.command, retryable: result.retryable === true });
  await setAgentEvidenceTraceStatus(task.traceId, result.error ? (result.retryable ? 'retryable' : 'blocked') : 'completed', { completed: !result.error });
  return finalized;
}

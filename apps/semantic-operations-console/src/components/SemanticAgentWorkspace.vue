<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { canExecuteSemanticTask } from '../task-guards.js';
import { resolveSemanticTaskSelection } from '../task-selection.js';

const props = defineProps({ client: { type: Object, required: true }, initialTaskId: { type: String, default: '' }, canReview: { type: Boolean, default: false } });
const desktopBridge = globalThis.semanticOperationsDesktop || null;
const emit = defineEmits(['applied', 'review-created']);
const tasks = ref([]);
const reviewTasks = ref([]);
const selected = ref(null);
const selectedTrace = ref(null);
const exportedReport = ref(null);
const input = ref('');
const adoptionMode = ref('merge');
const files = ref([]);
const busy = ref(false);
const message = ref('');
const fileInput = ref(null);
const transcript = ref(null);
const proposalEditor = ref(null);
const editorDirty = ref(false);
const editorMessage = ref('');
const keyCorrectionReasons = ref({});
// ── 标识对应复核（阶段 4b）──────────────────────────────────────────────────
// 对应关系是**推断**：发现时不自动并入草稿关系，只在这里等人逐条确认。
// 界面对这类边只有一个入口（勾选），不允许直接编辑谓词——服务端每次都从确认集合重建，
// 直接编辑会在保存时被丢弃，反而让人以为自己改成功了。
const identityLinkEvidence = ref({});
// 阶段 4d（ADR-019）：确认项现在还带两种输入。
//   · 形状判定：链接有一端形状未判定（裸名 `sku` / `product`，命名规则判不出代理键 / 业务键）时必填——
//     先判形状，服务端据此把这条边**重新定级**为「可按值对齐」或「需要映射」；
//   · 结构化映射定义：两端形状都已知且不同时必填（依据类型 + 责任人 + 版本），只给自由文本会被服务端拒绝。
const identityLinkShapes = ref({});
const identityLinkMappings = ref({});
const linkMappingOptions = computed(() => selected.value?.proposal?.identityLinking?.keyMappingOptions || { bases: [], shapes: [] });
// 形状判定会改变定级，所以「是否需要映射」必须按**判定后**的结果算：
// 否则人判完形状，界面还停在「形状未判定」上不动，他会以为没生效而重复操作。
const effectiveLinkStatus = (link) => {
  if (!link || link.status !== 'shape_unknown') return link?.status || null;
  const shape = identityLinkShapes.value[link.key];
  if (!shape) return 'shape_unknown';
  return shape === link.to.shape ? 'linkable' : 'requires_mapping';
};
const linkMappingOf = (key) => identityLinkMappings.value[key] || { basis: '', lookupSource: '', owner: '', version: '' };
// 阶段 4e（ADR-020）：可确认性由服务端给的 `eligible` 决定，判据是「**两端对象都在本次候选对象内**」
// （与服务端草案校验同源）。界面不再从「依据是否来自系统声明」这类信号去猜能不能确认——
// 那个判据实测会误报（`ERP.Inventory.lot_no` 可确认，却会被标成「来源系统未进入候选对象」）。
const linkEligibilityNote = (link) => (link && !link.eligible)
  ? `本次不可并入：${(link.ineligibleEndpoints || []).map((endpoint) => `${endpoint.role === 'from' ? '来源' : '目标'}对象 ${endpoint.system}.${endpoint.objectId} 的依据是系统配置声明，不是本次候选对象`).join('；')}。需先让这些对象成为候选对象。`
  : '';
// 保存前的本地校验：把服务端会拒绝的理由提前说清楚（服务端仍是唯一权威）。
const linkProblem = (link) => {
  // 资格排在**形状之前**：一条端点对象不在候选内的对应写不进草稿，先问它形状是什么没有意义。
  if (!link.eligible) return linkEligibilityNote(link);
  const status = effectiveLinkStatus(link);
  if (status === 'shape_unknown') return `${link.from.field} 与 ${link.to.field} 之间有一端键形状未判定，请先判定形状（代理键 / 业务键）。`;
  if (status === 'requires_mapping') {
    const mapping = identityLinkMappings.value[link.key] || {};
    if (!mapping.basis) return `${link.from.field}→${link.to.field} 需要选择映射依据类型。`;
    if (mapping.basis === 'master_data_lookup' && !String(mapping.lookupSource || '').trim()) return '映射依据选择「主数据对照表」时必须写明对照表来源。';
    if (!String(mapping.owner || '').trim()) return `${link.from.field}→${link.to.field} 的映射定义必须写明责任人。`;
    if (!String(mapping.version || '').trim()) return `${link.from.field}→${link.to.field} 的映射定义必须写明版本。`;
  }
  return null;
};
const identityLinkConfirmationReport = ref(null);
const identityLinkCandidates = computed(() => selected.value?.proposal?.identityLinking?.links || []);
// 「可确认」必须与「共几条」分开显示：否则运营看到的分母包含本次根本用不了的对应，
// 会以为自己漏确认了几条（阶段 4e / ADR-020）。
const eligibleLinkCount = computed(() => identityLinkCandidates.value.filter((link) => link.eligible).length);
const ineligibleLinkCount = computed(() => identityLinkCandidates.value.length - eligibleLinkCount.value);
const confirmedLinkKeys = computed(() => proposalEditor.value?.identityLinkConfirmations || []);
// 已勾选但输入还不齐的条数：不拦人勾选（勾了才知道要填什么），但保存前必须补齐并被点出来。
const incompleteLinkCount = computed(() => confirmedLinkKeys.value
  .map((item) => identityLinkCandidates.value.find((link) => link.key === item.key))
  .filter((link) => link && linkProblem(link)).length);
const buildLinkConfirmation = (link) => {
  const entry = { key: link.key, evidence: identityLinkEvidence.value[link.key] || '' };
  const status = effectiveLinkStatus(link);
  if (link.status === 'shape_unknown' && identityLinkShapes.value[link.key]) entry.shape = identityLinkShapes.value[link.key];
  if (status === 'requires_mapping') {
    const mapping = identityLinkMappings.value[link.key] || {};
    entry.keyMapping = { fromField: link.from.field, toField: link.to.field, basis: mapping.basis, lookupSource: mapping.lookupSource, owner: mapping.owner, version: mapping.version };
  }
  return entry;
};
// 已确认项在输入变化时必须**同步**，否则会出现「改了输入、保存的还是旧值」——
// 这类静默不一致正是本模块一路在消除的东西。
function syncConfirmedLink(key) {
  const list = proposalEditor.value.identityLinkConfirmations;
  const index = list.findIndex((item) => item.key === key);
  if (index < 0) return;
  const link = identityLinkCandidates.value.find((item) => item.key === key);
  if (!link) return;
  list.splice(index, 1, buildLinkConfirmation(link));
  markEditorDirty();
}
function toggleIdentityLink(key) {
  const list = proposalEditor.value.identityLinkConfirmations;
  const index = list.findIndex((item) => item.key === key);
  if (index >= 0) { list.splice(index, 1); markEditorDirty(); return; }
  const link = identityLinkCandidates.value.find((item) => item.key === key);
  // 不可确认的对应**没有确认入口**：端点对象不在本次候选内，提交也只会被服务端拒绝。
  // 点一下就必须说清为什么点不动，而不是让勾选框无反应（阶段 4e / ADR-020）。
  if (link && !link.eligible) { editorMessage.value = linkEligibilityNote(link); return; }
  list.push(link ? buildLinkConfirmation(link) : { key, evidence: identityLinkEvidence.value[key] || '' });
  markEditorDirty();
}
// 形状判定与映射定义都走显式更新函数（不在渲染期改状态），并且**立即同步到已确认项**：
// 人在输入框里改完就要能在 payload 里看到，而不是等下一次勾选。
function setLinkShape(key, shape) {
  identityLinkShapes.value = { ...identityLinkShapes.value, [key]: shape };
  syncConfirmedLink(key);
}
function setLinkMapping(key, field, value) {
  identityLinkMappings.value = { ...identityLinkMappings.value, [key]: { ...linkMappingOf(key), [field]: value } };
  syncConfirmedLink(key);
}
// ── 标识等价假设裁定（阶段 4c）────────────────────────────────────────────────
// 上一步推导出的对应，全部建立在「同一概念下的多个字段名指向同一实体」这个假设上。
// 假设不先回答，逐条确认就是在确认一个没人验证过的前提——所以裁定是确认的**前置**动作。
// 裁定本身不写草稿关系（改输入），确认才写（改草稿），两者不是同一层的东西。
const identityConflictRulings = ref([]);
const identityRulingGroupsText = ref({});
const aliasConflicts = computed(() => (selected.value?.proposal?.identityLinking?.conflicts || []).filter((item) => item.kind === 'alias_divergence'));
// 阶段 4h（ADR-025）：受控对象链接的披露面。null＝提案没带（模型路径之外）；
// skipped＝链接没跑（模拟运行时 / 无范围），linked＝模型给出的逐字链接及其结构化标记。
const mentionLinking = computed(() => selected.value?.proposal?.candidateCoverage?.mentionLinking || null);
const withdrawnIdentityLinks = computed(() => selected.value?.proposal?.identityLinking?.withdrawnLinks || []);
const rulingOfConcept = (concept) => (identityConflictRulings.value.find((item) => item.concept === concept) || {}).ruling || null;
// 用**本地编辑器状态**算未裁定概念（服务端那份要等保存后才更新），否则点完裁定列表不变，
// 人会以为没生效而重复操作。
const unresolvedAliasConcepts = computed(() => aliasConflicts.value.filter((conflict) => !rulingOfConcept(conflict.concept)).map((conflict) => conflict.concept));
const unresolvedAssumptionLinkCount = computed(() => identityLinkCandidates.value.filter((link) => !link.ruling && unresolvedAliasConcepts.value.includes(link.concept)).length);
const parseRulingGroups = (text) => String(text || '')
  .split(/[\n;；]/)
  .map((line) => line.split(/[,，\s]+/).map((name) => name.trim()).filter(Boolean))
  .filter((group) => group.length);
function setConflictRuling(concept, ruling) {
  const entry = { concept, ruling, groups: ruling === 'distinct_entity' ? parseRulingGroups(identityRulingGroupsText.value[concept]) : null };
  const list = identityConflictRulings.value;
  const index = list.findIndex((item) => item.concept === concept);
  if (index >= 0) list.splice(index, 1, entry);
  else list.push(entry);
  markEditorDirty();
}
function clearConflictRuling(concept) {
  const list = identityConflictRulings.value;
  const index = list.findIndex((item) => item.concept === concept);
  if (index >= 0) list.splice(index, 1);
  markEditorDirty();
}
// ── 来源归属确认（阶段 4c 第二段）──────────────────────────────────────────────
// 材料里已经写明的归属（「ERP 采购订单表 purchase_order」）由模型逐字取证、服务端判定成**候选**。
// 候选不写来源系统、也不参与范围裁剪——要人确认并留下依据才成为事实；而来源一旦成为事实，
// 就有资格决定对象去留（确认到范围外会被裁掉）。所以这里与「标识等价裁定」不同：
// 它改的是**事实**，不是推导的输入。
const sourceAssignments = ref([]);
const sourceEvidence = ref({});
const sourceAssignmentsOf = (objectId) => sourceAssignments.value.find((item) => item.objectId === objectId) || null;
const unconfirmedCandidates = computed(() => (proposalEditor.value?.objectTypes || [])
  .filter((object) => object.candidateSourceSystems?.length && !sourceAssignmentsOf(object.id)));
const outOfScopeCandidates = computed(() => selected.value?.proposal?.scopeExclusions?.candidateScopeObjects?.outOfScope || []);
function upsertSourceAssignment(objectId, system, evidence) {
  const entry = { objectId, system, evidence: evidence || '' };
  const index = sourceAssignments.value.findIndex((item) => item.objectId === objectId);
  if (index >= 0) sourceAssignments.value.splice(index, 1, entry); else sourceAssignments.value.push(entry);
}
// 一键「按材料确认」：依据就是模型逐字引用的那句原文——人认可它，依据即成立，不必再手写一遍。
function confirmSourceCandidate(object) {
  const system = object.candidateSourceSystems[0];
  upsertSourceAssignment(object.id, system, object.candidateSourceEvidence || '');
  sourceEvidence.value[object.id] = sourceEvidence.value[object.id] || object.candidateSourceEvidence || '';
  const target = proposalEditor.value.objectTypes.find((item) => item.id === object.id);
  if (target) target.sourceSystems = [system];
  markEditorDirty();
}
// 手工填写来源系统同样要进集合：否则服务端拿不到这次归属的依据，会把它当「未经确认」处理。
function setObjectSourceSystem(object, value) {
  object.sourceSystems = String(value || '').split(/[ /,，]+/).filter(Boolean).map((item) => item.toUpperCase());
  const system = object.sourceSystems[0] || '';
  if (system && system !== 'UNASSIGNED') upsertSourceAssignment(object.id, system, sourceEvidence.value[object.id] || '');
  else sourceAssignments.value = sourceAssignments.value.filter((item) => item.objectId !== object.id);
  markEditorDirty();
}
function removeSourceAssignment(objectId) {
  sourceAssignments.value = sourceAssignments.value.filter((item) => item.objectId !== objectId);
  // 撤销＝回到「材料推断过、但还没人确认」的状态。显示值先按服务端上一版回退，
  // 本轮保存后由服务端按原稿给出准确值（服务端才是权威，这里只是别让人看到假状态）。
  const serverObject = (selected.value?.proposal?.objectTypes || []).find((item) => item.id === objectId);
  const target = (proposalEditor.value?.objectTypes || []).find((item) => item.id === objectId);
  if (target) target.sourceSystems = [...(serverObject?.sourceSystems || ['UNASSIGNED'])];
  markEditorDirty();
}
function clearAllSourceAssignments() {
  for (const object of proposalEditor.value.objectTypes) object.sourceSystems = ['UNASSIGNED'];
  sourceAssignments.value = [];
  markEditorDirty();
}
// ── 同名声明裁定（阶段 4c 第三段）──────────────────────────────────────────────
// 同一对象在同一系统里被多处声明（受控词汇表 + 已配置映射 + 材料抽取）而字段集不一致时，
// 服务端默认**取字段并集**——这个默认动作过去完全不可见，而并集还会参与标识识别，
// 于是产出一个谁也没声明过的复合体（实测：MES 生产批次被并集授予 production_batch_id，
// 而它的配置映射只声明 batch_no）。这里给人两个动作：确认并集成立，或按声明拆成不同对象。
// 与等价裁定一样，它**只改字段目录的组成**（推导的输入），不写草稿关系、不写来源系统。
const declarationRulings = ref([]);
// 分组用「名字」表达：同名声明自动成为同一组，不同名即不同对象，勾选「排除」则该声明不进目录。
// 这样人写的是对象名（域语义），而不是给服务端递一份分组编号表。
const declarationNames = ref({});
const declarationDrops = ref({});
const declarationConflicts = computed(() => (selected.value?.proposal?.identityLinking?.conflicts || []).filter((item) => item.kind === 'declaration_divergence'));
const mergedUnruledEntries = computed(() => (selected.value?.proposal?.identityLinking?.fieldCatalog || [])
  .flatMap((entry) => (entry.objects || []).filter((object) => object.declarationState === 'merged_unruled').map((object) => ({ system: entry.code, object }))));
const declarationRulingOf = (key) => (declarationRulings.value.find((item) => item.key === key) || {}).ruling || null;
// 未裁定项按**本地编辑器状态**算（服务端那份要保存后才更新），否则点完裁定列表不变，
// 人会以为没生效而重复操作。
const unresolvedDeclarationItems = computed(() => declarationConflicts.value.filter((conflict) => !declarationRulingOf(conflict.key)).map((conflict) => conflict.key));
const nameOfDeclaration = (key, declarationKey) => (declarationNames.value[key] || {})[declarationKey] ?? '';
const droppedDeclaration = (key, declarationKey) => Boolean((declarationDrops.value[key] || {})[declarationKey]);
function setDeclarationName(key, declarationKey, value) {
  declarationNames.value = { ...declarationNames.value, [key]: { ...(declarationNames.value[key] || {}), [declarationKey]: value } };
  markEditorDirty();
}
function toggleDeclarationDrop(key, declarationKey, dropped) {
  declarationDrops.value = { ...declarationDrops.value, [key]: { ...(declarationDrops.value[key] || {}), [declarationKey]: dropped } };
  markEditorDirty();
}
function setDeclarationRuling(conflict, ruling) {
  const entry = { key: conflict.key, ruling, groups: null };
  const list = declarationRulings.value;
  const index = list.findIndex((item) => item.key === conflict.key);
  if (index >= 0) list.splice(index, 1, entry); else list.push(entry);
  // 从「合并」切到「区分」时清掉上一轮的分组痕迹，避免上一份命名跟着新裁定一起提交。
  if (ruling === 'merge') {
    const names = { ...declarationNames.value }; delete names[conflict.key];
    const drops = { ...declarationDrops.value }; delete drops[conflict.key];
    declarationNames.value = names; declarationDrops.value = drops;
  }
  markEditorDirty();
}
function clearDeclarationRuling(key) {
  declarationRulings.value = declarationRulings.value.filter((item) => item.key !== key);
  const names = { ...declarationNames.value }; delete names[key];
  const drops = { ...declarationDrops.value }; delete drops[key];
  declarationNames.value = names; declarationDrops.value = drops;
  markEditorDirty();
}
// 把人写的名字翻译成分组：同名即同组；被排除的声明单独成组（带 drop 标志）。
function buildDeclarationGroups(conflict) {
  const byName = new Map();
  const dropped = [];
  for (const declaration of conflict.declarations || []) {
    const declarationKey = declaration.declarationKey;
    if (droppedDeclaration(conflict.key, declarationKey)) { dropped.push(declarationKey); continue; }
    const name = String(nameOfDeclaration(conflict.key, declarationKey) || '').trim();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(declarationKey);
  }
  const groups = [...byName].map(([name, declarations]) => ({ name, declarations }));
  if (dropped.length) groups.push({ drop: true, declarations: dropped });
  return groups;
}
// 与服务端同一套校验的**前置**版本：这里拦是为了把「哪一项还没写完」直接指出来，
// 而不是等 400 回来再让人自己去数。服务端仍是权威（它还会校验组名撞名）。
function declarationSplitProblem(conflict) {
  const declarations = (conflict.declarations || []).map((item) => item.declarationKey);
  const droppedCount = declarations.filter((key) => droppedDeclaration(conflict.key, key)).length;
  const names = declarations.filter((key) => !droppedDeclaration(conflict.key, key)).map((key) => String(nameOfDeclaration(conflict.key, key) || '').trim());
  if (names.some((name) => !name)) return '还有声明没有填写对象名：每条声明要么给出对象名，要么勾选「排除该声明」；留空会让服务端收到一个未声明的隐含分组。';
  const kept = [...new Set(names)];
  if (!kept.length) return '至少要保留一组声明——全部排除等于把这个对象从字段目录里抹掉，属排除语义而非「区分粒度」。';
  // 只有一组保留名且没有排除任何声明，等于「同一个对象」，应当用「合并」表达。
  if (kept.length < 2 && !droppedCount) return '只给了一个对象名、也没有排除任何声明，这等于「同一个对象」——请改用「确认为同一对象（并集）」。';
  return '';
}
const needsKeyCorrection = objectId => selected.value?.proposal?.schemaDiscovery?.objectTypes?.some(object => object.id === objectId && !object.key);
const selectedGraphObjectId = ref('');
const taskQuery = ref('');
const taskStatus = ref('');
const showArchived = ref(false);
const taskList = ref(null);
const taskPageSize = 30;
const taskHasMore = ref(false);
const taskListLoading = ref(false);
const taskLoadingMore = ref(false);
let taskOffset = 0;
// ── 建模来源范围（阶段 3）────────────────────────────────────────────────────
// 范围只能由运营人员显式勾选。面板数据来自 /semantic-operations/sources?scope=all_registered
// （系统注册表 + 连接器就绪度），与后端范围门禁使用同一份判定，避免「面板可选、后端越权」。
const systemScopeOptions = ref([]);
const systemScopeMessage = ref('');
const selectedSystems = ref([]);
const systemScopeError = ref('');
let taskLoadGeneration = 0;
const selectedSystemOptions = computed(() => systemScopeOptions.value.filter((item) => selectedSystems.value.includes(item.code)));
const undefinedSelectedSystems = computed(() => selectedSystemOptions.value.filter((item) => item.authorized === false));
// 只在「诉求看起来要建模」时才把空范围当阻断原因。若一律要求先选系统，
// 连「你好」「你能做什么」这类对话也会被禁掉——服务端对对话类意图本就不要求范围。
const looksLikeModelingRequest = computed(() => /建设|建立|构建|建模|新增|添加|识别|抽取|定义|生成候选|生成模型|生成语义/.test(input.value));
const scopeRequiredReason = computed(() => (looksLikeModelingRequest.value && !selectedSystems.value.length)
  ? '本次诉求看起来要建设模型，请先在上方选择至少一个来源系统。服务器不会自动扩大到全部可访问连接器。'
  : '');
// UI 提示：文本里出现的系统名（仅按系统编码匹配，不含别名；权威判定始终在服务端）。
const mentionedNotSelected = computed(() => {
  const text = input.value.toUpperCase();
  if (!text) return [];
  return systemScopeOptions.value
    .map((item) => item.code)
    .filter((code) => new RegExp(`(?:^|[^A-Z0-9])${code}(?:[^A-Z0-9]|$)`).test(text) && !selectedSystems.value.includes(code));
});
const canSubmit = computed(() => Boolean(input.value.trim() || files.value.length) && !busy.value && !scopeRequiredReason.value);
const canEditProposal = computed(() => selected.value?.status === 'waiting_confirmation' && selected.value?.command === 'apply_proposal' && Boolean(proposalEditor.value));
const canExecute = computed(() => canExecuteSemanticTask({ task: selected.value, editorDirty: editorDirty.value, busy: busy.value })
  && (selected.value?.command !== 'apply_proposal' || props.canReview));
const pendingReviewTasks = computed(() => reviewTasks.value.filter(task => task.status === 'waiting_confirmation'
  && task.command === 'apply_proposal' && task.proposal && task.reviewPermission === 'meta_model.draft.review'));
const graphNodes = computed(() => (proposalEditor.value?.objectTypes || []).map((item, index) => {
  const fieldDefinitions = item.fieldDefinitions || [];
  const pendingMappings = fieldDefinitions.filter((field) => field.mappingStatus === 'pending' || (!field.sourceField && !['derived', 'ignored'].includes(field.mappingStatus))).length;
  const validationStatus = selected.value?.proposal?.mappingValidation?.objects?.find((object) => object.objectId === item.id)?.status || 'unverified';
  return { ...item, x: 125 + (index % 3) * 285, y: 72 + Math.floor(index / 3) * 118, pendingMappings, mappedFields: fieldDefinitions.length - pendingMappings, validationStatus };
}));
const graphHeight = computed(() => Math.max(210, 145 + Math.floor(Math.max(0, graphNodes.value.length - 1) / 3) * 118));
const graphEdges = computed(() => (proposalEditor.value?.relationshipTypes || []).map((item, index) => ({ ...item, key: `${item.from}-${item.predicate}-${item.to}-${index}`, fromNode: graphNodes.value.find((node) => node.id === item.from), toNode: graphNodes.value.find((node) => node.id === item.to) })).filter((item) => item.fromNode && item.toNode));
const reviewSystemLinks = computed(() => graphEdges.value.map((edge) => {
  const fromSystems = edge.fromNode.sourceSystems || [];
  const toSystems = edge.toNode.sourceSystems || [];
  const handoffs = [...new Set(fromSystems.flatMap(from => toSystems.map(to => `${from} → ${to}`)))];
  return { key: edge.key, from: edge.fromNode.label, to: edge.toNode.label, relation: edge.label || edge.predicate, cardinality: edge.cardinality, handoffs };
}));
const mappingSummary = computed(() => {
  const fields = graphNodes.value.flatMap((item) => item.fieldDefinitions || []);
  const pending = fields.filter((field) => field.mappingStatus === 'pending' || (!field.sourceField && !['derived', 'ignored'].includes(field.mappingStatus))).length;
  return { total: fields.length, pending, ready: fields.length - pending };
});
const selectedMappingValidationObject = computed(() => selected.value?.proposal?.mappingValidation?.objects?.find((object) => object.objectId === selectedGraphObjectId.value) || selected.value?.proposal?.mappingValidation?.objects?.[0] || null);
const selectedMappingIssues = computed(() => (selected.value?.proposal?.mappingValidation?.issues || []).filter((issue) => issue.objectId === selectedMappingValidationObject.value?.objectId));
const displayPreviewValue = (value) => value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);

const statusLabel = { waiting_confirmation: '等待确认', executing: '执行中', retryable: '可重试', completed: '已完成', blocked: '已阻止', needs_input: '等待补充', denied: '权限不足', failed: '回答失败，可重试' };
const taskStatusLabel = task => task.status === 'completed' && task.intent === 'conversation' ? '已回应' : task.status === 'completed' && task.intent === 'needs_clarification' ? '等待补充' : statusLabel[task.status] || task.status;
const intentLabel = { build_model: '建设模型', discover_sources: '来源预检', inspect_status: '检查状态', validate_model: '校验模型', simulate_model: '模拟构建', publish_model: '发布模型', conversation: '普通对话', needs_clarification: '需要补充', unsupported_operation: '受限操作', permission_denied: '权限不足' };
const formatTaskTime = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });

const setInput = (value) => { input.value = String(value || ''); };
defineExpose({ setInput, openTask });

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('材料读取失败，请重新选择。'));
  reader.readAsDataURL(file);
});

const inferredMimeType = (file) => {
  if (file.type) return file.type;
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  return ({ json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })[extension] || '';
};

async function chooseFiles(event) {
  const selectedFiles = Array.from(event.target.files || []);
  event.target.value = '';
  if (!selectedFiles.length) return;
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/json', 'text/csv', 'application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
  if (files.value.length + selectedFiles.length > 5) { message.value = '一次最多上传5个材料。'; return; }
  if ([...files.value, ...selectedFiles].reduce((total, file) => total + (file.dataUrl ? Math.ceil(file.dataUrl.length * 0.75) : file.size || 0), 0) > 12 * 1024 * 1024) { message.value = '全部材料合计必须小于12MB。'; return; }
  try {
    const next = await Promise.all(selectedFiles.map(async (file) => {
      const mimeType = inferredMimeType(file);
      if (!allowed.has(mimeType)) throw new Error('仅支持PDF、图片、DOCX、XLSX、JSON、YAML和CSV。');
      const rawDataUrl = await readAsDataUrl(file);
      const dataUrl = rawDataUrl.replace(/^data:[^;]*;/, `data:${mimeType};`);
      return { name: file.name, mimeType, dataUrl };
    }));
    files.value.push(...next); message.value = '';
  } catch (error) { message.value = error.message; }
}

async function loadSystemScopeOptions() {
  try {
    const result = await props.client.semanticSources({ scope: 'all_registered' });
    systemScopeOptions.value = (result.sources || []).map((item) => ({
      code: item.code, name: item.name, authorized: item.authorized, status: item.status,
      mode: item.mode, message: item.message, registryKnown: item.registryKnown, objects: item.objects || []
    }));
    // 面板只列注册表成员；已不在清单里的勾选必须清掉，不能让范围里留下不存在的系统。
    const known = new Set(systemScopeOptions.value.map((item) => item.code));
    selectedSystems.value = selectedSystems.value.filter((code) => known.has(code));
    systemScopeMessage.value = systemScopeOptions.value.length ? '' : '当前角色没有可用的已登记来源系统。';
  } catch (error) { systemScopeMessage.value = error.message || '来源范围清单加载失败，暂时无法确认可选系统。'; }
}

function toggleSystem(code) {
  selectedSystems.value = selectedSystems.value.includes(code)
    ? selectedSystems.value.filter((item) => item !== code)
    : [...selectedSystems.value, code];
  systemScopeError.value = '';
}

async function loadTasks(preferredId) {
  const generation = ++taskLoadGeneration;
  const client = props.client;
  taskListLoading.value = true;
  taskLoadingMore.value = false;
  taskOffset = 0;
  if (preferredId) selected.value = null;
  try {
    const result = await client.tasks({ query: taskQuery.value, status: taskStatus.value, archived: showArchived.value || undefined, limit: taskPageSize, offset: 0 });
    if (generation !== taskLoadGeneration) return;
    const next = await resolveSemanticTaskSelection({ client, tasks: result.tasks || [], preferredId, selectedId: selected.value?.id });
    if (generation !== taskLoadGeneration) return;
    tasks.value = next.tasks; selected.value = next.selected;
    taskOffset = (result.tasks || []).length;
    taskHasMore.value = taskOffset === taskPageSize;
    if (taskList.value) taskList.value.scrollTop = 0;
    if (preferredId) message.value = '';
  } catch (error) {
    if (generation !== taskLoadGeneration) return;
    if (preferredId) { selected.value = null; message.value = '目标任务不可见或加载失败，请返回接入项目核对后重试。'; }
    else throw error;
  } finally {
    if (generation === taskLoadGeneration) taskListLoading.value = false;
  }
}

async function loadMoreTasks() {
  if (taskListLoading.value || taskLoadingMore.value || !taskHasMore.value) return;
  taskLoadingMore.value = true;
  const generation = taskLoadGeneration;
  try {
    const result = await props.client.tasks({ query: taskQuery.value, status: taskStatus.value, archived: showArchived.value || undefined, limit: taskPageSize, offset: taskOffset });
    if (generation !== taskLoadGeneration) return;
    const next = result.tasks || [];
    const known = new Set(tasks.value.map((task) => task.id));
    tasks.value = [...tasks.value, ...next.filter((task) => !known.has(task.id))];
    taskOffset += next.length;
    taskHasMore.value = next.length === taskPageSize;
  } catch (error) {
    if (generation === taskLoadGeneration) message.value = error.message || '更多任务加载失败，请稍后重试。';
  } finally {
    if (generation === taskLoadGeneration) taskLoadingMore.value = false;
  }
}

function onTaskListScroll(event) {
  const element = event.currentTarget;
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 72) loadMoreTasks();
}

async function refreshReviewTasks() {
  if (!props.canReview || busy.value) return;
  try {
    const result = await props.client.tasks({ limit: 100 });
    reviewTasks.value = (result.tasks || []).filter(task => task.reviewPermission === 'meta_model.draft.review');
  } catch { /* 任务列表主流程仍可用；下次轮询重试，不覆盖当前对话错误。 */ }
}

async function openTask(taskId) { await loadTasks(taskId); }

async function archiveTask() {
  if (!selected.value || selected.value.status === 'executing') return;
  busy.value = true;
  try {
    await props.client.archiveTask(selected.value.id);
    message.value = '任务已归档，执行证据仍保留。';
    await loadTasks();
  } catch (error) { message.value = error.message || '任务归档失败。'; }
  finally { busy.value = false; }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function initializeProposalEditor() {
  const proposal = selected.value?.proposal;
  keyCorrectionReasons.value = Object.fromEntries((proposal?.primaryKeyCorrections || []).map(item => [item.objectId, item.reason]));
  identityLinkEvidence.value = Object.fromEntries((proposal?.identityLinkConfirmations || []).map(item => [item.key, item.evidence || '']));
  // 形状判定与结构化映射定义都必须反解回编辑器状态：它们与确认是**同一份输入**，
  // 下次保存要整包带上——否则一次普通字段修订会顺手把人工判定的形状与填好的映射丢掉。
  identityLinkShapes.value = Object.fromEntries((proposal?.identityLinkConfirmations || []).filter(item => item.shape).map(item => [item.key, item.shape]));
  identityLinkMappings.value = Object.fromEntries((proposal?.identityLinkConfirmations || []).filter(item => item.keyMapping)
    .map(item => [item.key, { basis: item.keyMapping.basis || '', lookupSource: item.keyMapping.lookupSource || '', owner: item.keyMapping.owner || '', version: item.keyMapping.version || '' }]));
  identityLinkConfirmationReport.value = proposal?.identityLinkConfirmationReport || null;
  identityConflictRulings.value = clone(proposal?.identityConflictRulings || []);
  identityRulingGroupsText.value = Object.fromEntries((proposal?.identityConflictRulings || [])
    .filter(item => item.ruling === 'distinct_entity' && item.groups?.length)
    .map(item => [item.concept, item.groups.map(group => group.join(', ')).join('\n')]));
  if (!proposal) { proposalEditor.value = null; editorDirty.value = false; editorMessage.value = ''; return; }
  // 归属确认是**全量语义**的集合（省略＝不调整、空数组＝撤销全部），所以界面必须持有服务端那份并整包提交；
  // 与 identityLinkConfirmations 同一口径，否则任何一次普通字段修订都会顺手撤销已确认的归属。
  sourceAssignments.value = clone(proposal.sourceAssignments || []);
  sourceEvidence.value = Object.fromEntries((proposal.sourceAssignments || []).map((item) => [item.objectId, item.evidence || '']));
  // 同名声明裁定同样是整包提交的集合；它的分组在服务端是「声明清单」，界面上用名字表达，
  // 所以这里把服务端的分组反解回「每条声明的名字 / 是否排除」，供人继续编辑。
  declarationRulings.value = clone(proposal.declarationRulings || []);
  declarationNames.value = {};
  declarationDrops.value = {};
  for (const ruling of proposal.declarationRulings || []) {
    for (const group of ruling.groups || []) {
      for (const declarationKey of group.declarations || []) {
        if (group.drop) declarationDrops.value = { ...declarationDrops.value, [ruling.key]: { ...(declarationDrops.value[ruling.key] || {}), [declarationKey]: true } };
        else declarationNames.value = { ...declarationNames.value, [ruling.key]: { ...(declarationNames.value[ruling.key] || {}), [declarationKey]: group.name } };
      }
    }
  }
  proposalEditor.value = {
    revision: proposal.revision || 1,
    objectTypes: clone(proposal.objectTypes || []).map((item) => ({
      ...item,
      fieldDefinitions: item.fieldDefinitions?.length ? item.fieldDefinitions.map((field) => ({ ...field, sourceField: field.sourceField ?? field.name, mappingStatus: field.mappingStatus || 'mapped' })) : (item.fields || []).map((name) => ({ name, type: 'string', required: name === item.key, primaryKey: name === item.key, sourceField: name, mappingStatus: 'mapped', reference: null, description: null }))
    })),
    relationshipTypes: clone(proposal.relationshipTypes || []),
    identityLinkConfirmations: clone(proposal.identityLinkConfirmations || [])
  };
  if (!proposalEditor.value.objectTypes.some((item) => item.id === selectedGraphObjectId.value)) selectedGraphObjectId.value = proposalEditor.value.objectTypes[0]?.id || '';
  editorDirty.value = false;
  editorMessage.value = '';
}

function markEditorDirty() { editorDirty.value = true; editorMessage.value = '存在尚未保存的修改，保存后才能确认写入草稿。'; }

// 这三类拒绝必须给出「下一步做什么」，而不是把服务端原文透出来：
// 它们的共同点是人得回到界面重新确认或补依据，光看错误码无从下手。
const IDENTITY_LINK_ERROR_MESSAGES = {
  SEMANTIC_IDENTITY_CONFIRMATION_STALE: '有已确认的标识对应在本轮修订后不再存在（字段变了，或该对应已被等价裁定撤下）。请重新选择该任务后再确认，不会按旧结论并入。',
  // 阶段 4d（ADR-019）：映射依据从「自由文本」改为**结构化映射定义**，旧码已被取代；
  // 形状判定与映射定义各自有拒绝码，因为人要做的动作完全不同（判形状 / 补定义 / 刷新）。
  SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID: '有标识映射定义不完整（需要两端键、映射依据类型、责任人、版本；选「主数据对照表」还要写来源）。请在对应条目上把定义补齐后再保存。',
  SEMANTIC_IDENTITY_CONFIRMATION_SHAPE_REQUIRED: '有标识对应的一端键形状未判定（裸名没有 _id / _no / _code 后缀，命名规则判不出来）。请先判定它是代理键还是业务键，再确认——不判形状就并入，等于让一条还不知道能不能按值对齐的边进草稿。',
  SEMANTIC_IDENTITY_CONFIRMATION_SHAPE_NOT_APPLICABLE: '有形状判定提交给了一条两端形状都已明确的对应（界面拿的可能是过期结论）。请刷新该任务后重试。',
  SEMANTIC_IDENTITY_CONFIRMATION_SHAPE_INVALID: '形状判定只能是「代理键」或「业务键」。请刷新后重试。',
  // 阶段 4e（ADR-020）：这条对应**本次就没有确认入口**（端点对象不在本次候选对象内），
  // 不是「填错了什么」。要做的动作是取消勾选，或先让那个对象成为候选对象。
  SEMANTIC_IDENTITY_CONFIRMATION_ENDPOINT_OUT_OF_SCOPE: '有对应的端点对象不在本次候选对象内（它们只在系统声明里存在），本次无法并入草稿。请取消勾选这些条目；若要并入，需先让它们成为本次候选对象。',
  SEMANTIC_IDENTITY_CONFIRMATION_INVALID: '标识对应确认的形状不合法，请刷新后重试。',
  SEMANTIC_IDENTITY_RULING_UNKNOWN_CONFLICT: '有标识等价裁定已不适用（该概念当前不再由多个字段名表达）。请重新选择该任务后再裁定，不会按旧结论生效。',
  SEMANTIC_IDENTITY_RULING_GROUPS_INVALID: '等价类分组不合法：必须至少两组，且恰好覆盖该概念下的全部字段名，不重复、不遗漏。',
  SEMANTIC_IDENTITY_RULING_INVALID: '标识等价裁定的形状不合法（只支持「同一实体 / 不同实体」）。请刷新后重试。',
  // 归属确认的三类拒绝。它们都要给出下一步动作，而不是把服务端原文丢给运营。
  SEMANTIC_SOURCE_ASSIGNMENT_EVIDENCE_REQUIRED: '有归属确认缺少依据。归属会写入来源系统、并决定该对象是否落在建模范围内，所以必须留下依据（材料原文或人工说明）。',
  SEMANTIC_SOURCE_ASSIGNMENT_UNKNOWN_SYSTEM: '有归属确认指向的系统不在系统注册表里。请从系统接入清单中选择，或先去系统接入里登记该系统。',
  SEMANTIC_SOURCE_ASSIGNMENT_STALE: '有归属确认指向的对象已不在提案中（对象被移除或改名了）。请重新选择该任务后再确认，不会按旧结论写入来源系统。',
  SEMANTIC_SOURCE_ASSIGNMENT_INVALID: '归属确认的形状不合法（需要对象编码与目标系统，且不能重复提交）。请刷新后重试。',
  SEMANTIC_PROPOSAL_SCOPE_EXCLUDED_ALL: '确认的归属让全部候选对象都落到了本次所选范围之外。请确认正确的归属，或补选对应系统后重新生成提案。',
  // 同名声明裁定的四类拒绝。它们的共同点是「界面拿的结论与当前声明事实不符」，
  // 所以都要给出下一步动作（重新选任务 / 改分组 / 换名字），而不是把错误码丢回去。
  SEMANTIC_DECLARATION_RULING_UNKNOWN_CONFLICT: '有同名声明裁定已不适用（这些对象当前不再存在字段集不一致的分歧）。请重新选择该任务后再裁定，不会按旧结论生效。',
  SEMANTIC_DECLARATION_RULING_GROUPS_INVALID: '分组不合法：至少两组，且恰好覆盖该分歧下的全部声明，不重复、不遗漏；每组要么给出对象名，要么显式排除，且至少要保留一组。',
  SEMANTIC_DECLARATION_RULING_NAME_TAKEN: '有分组名与该系统里已有对象重名。请另取名字——两个不同对象共用一个名字，正是这次裁定要消除的问题。',
  SEMANTIC_DECLARATION_RULING_INVALID: '同名声明裁定的形状不合法（只支持「同一对象 / 不同对象」）。请刷新后重试。'
};

function setPrimaryKey(object, fieldName) {
  object.key = fieldName;
  object.fieldDefinitions.forEach((field) => { field.primaryKey = field.name === fieldName; if (field.primaryKey) field.required = true; });
  markEditorDirty();
}

function addField(object) {
  let index = object.fieldDefinitions.length + 1;
  let name = `field_${index}`;
  while (object.fieldDefinitions.some((field) => field.name === name)) { index += 1; name = `field_${index}`; }
  object.fieldDefinitions.push({ name, type: 'string', required: false, primaryKey: false, sourceField: '', mappingStatus: 'pending', reference: null, description: null });
  object.fields = object.fieldDefinitions.map((field) => field.name);
  markEditorDirty();
}

function removeField(object, fieldIndex) {
  if (object.fieldDefinitions.length <= 2) { editorMessage.value = '每个对象至少保留两个字段。'; return; }
  const [removed] = object.fieldDefinitions.splice(fieldIndex, 1);
  if (removed.name === object.key) setPrimaryKey(object, object.fieldDefinitions[0].name);
  object.fields = object.fieldDefinitions.map((field) => field.name);
  markEditorDirty();
}

function syncFieldName(object, field) {
  if (field.primaryKey) object.key = field.name;
  object.fields = object.fieldDefinitions.map((item) => item.name);
  markEditorDirty();
}

function addObject() {
  let index = proposalEditor.value.objectTypes.length + 1;
  let id = `BusinessObject${index}`;
  while (proposalEditor.value.objectTypes.some((item) => item.id === id)) { index += 1; id = `BusinessObject${index}`; }
  proposalEditor.value.objectTypes.push({ id, label: '新业务对象', source: 'wms.custom_object', key: 'id', fields: ['id', 'name'], fieldDefinitions: [{ name: 'id', type: 'string', required: true, primaryKey: true, reference: null, description: null }, { name: 'name', type: 'string', required: false, primaryKey: false, reference: null, description: null }], classification: '内部受限（待复核）', semanticType: id, coreObject: id, sourceSystems: ['WMS'], description: '' });
  const created = proposalEditor.value.objectTypes.at(-1);
  created.fieldDefinitions.forEach((field) => { field.sourceField = ''; field.mappingStatus = 'pending'; });
  selectedGraphObjectId.value = id;
  markEditorDirty();
}

function removeObject(objectId) {
  if (proposalEditor.value.objectTypes.length <= 1) { editorMessage.value = '提案至少保留一个候选对象。'; return; }
  proposalEditor.value.objectTypes = proposalEditor.value.objectTypes.filter((item) => item.id !== objectId);
  proposalEditor.value.relationshipTypes = proposalEditor.value.relationshipTypes.filter((item) => item.from !== objectId && item.to !== objectId);
  selectedGraphObjectId.value = proposalEditor.value.objectTypes[0]?.id || '';
  markEditorDirty();
}

function addRelationship() {
  const [first, second = first] = proposalEditor.value.objectTypes;
  if (!first) return;
  proposalEditor.value.relationshipTypes.push({ from: first.id, predicate: 'references', to: second.id, label: '业务关联', cardinality: 'n:1', evidence: '运营人员复核' });
  markEditorDirty();
}

function removeRelationship(index) { proposalEditor.value.relationshipTypes.splice(index, 1); markEditorDirty(); }

function updateMapping(field) {
  if (['derived', 'ignored'].includes(field.mappingStatus)) field.sourceField = '';
  if (['mapped', 'manual'].includes(field.mappingStatus) && !field.sourceField) field.sourceField = field.name;
  markEditorDirty();
}

async function saveProposalRevision() {
  if (!canEditProposal.value || !editorDirty.value) return;
  busy.value = true; editorMessage.value = '';
  try {
    const objectTypes = proposalEditor.value.objectTypes.map((item) => ({ ...item, fields: item.fieldDefinitions.map((field) => field.name) }));
    const primaryKeyCorrections = objectTypes.filter(item => needsKeyCorrection(item.id) && keyCorrectionReasons.value[item.id]?.trim()).map(item => ({ objectId: item.id, field: item.key, reason: keyCorrectionReasons.value[item.id].trim() }));
    // 确认集合始终整包提交（含空数组）：省略与服务端语义里的「不调整」同义，
    // 若这里也省略，界面就无法表达「撤销全部确认」。
    //
    // 阶段 4d（ADR-019）：形状判定与结构化映射定义与确认是**同一份输入**，这里整包现取现组装，
    // 不沿用编辑器里那份快照——否则会出现「输入改了、提交的还是旧值」。
    const identityLinkConfirmations = (proposalEditor.value.identityLinkConfirmations || []).map(item => {
      const link = identityLinkCandidates.value.find((candidate) => candidate.key === item.key);
      if (!link) return { key: item.key, evidence: (identityLinkEvidence.value[item.key] || '').trim() };
      const entry = buildLinkConfirmation(link);
      return { ...entry, evidence: String(entry.evidence || '').trim() };
    });
    // 先拦一次并指出「是哪一条缺什么」：服务端仍会独立校验，这里只是别让人对着 400 自己去数。
    //
    // 阶段 4e（ADR-020）：资格问题与「没填完」是两件事，不能共用一句「还没填完」——
    // 不可并入的对应**没有可填的东西**，问题是它的端点对象不在本次候选内（要去做的是另一件事）。
    const confirmedCandidates = (proposalEditor.value.identityLinkConfirmations || [])
      .map(item => identityLinkCandidates.value.find((link) => link.key === item.key))
      .filter(Boolean);
    const ineligibleIssues = confirmedCandidates.filter(link => !link.eligible).map(link => linkEligibilityNote(link));
    if (ineligibleIssues.length) {
      editorMessage.value = `有 ${ineligibleIssues.length} 条对应本次不可并入，请先取消勾选——${ineligibleIssues.join('；')}`;
      busy.value = false;
      return;
    }
    const linkIssues = confirmedCandidates.filter(link => linkProblem(link)).map(link => linkProblem(link));
    if (linkIssues.length) {
      editorMessage.value = `标识对应还没填完——${linkIssues.join('；')}`;
      busy.value = false;
      return;
    }
    // 裁定集合同样整包提交（含空数组＝撤销全部）。它必须先于确认在服务端生效：
    // 裁定决定哪些链接存在，确认是按链接给的——顺序反了就会「确认了一条已被裁定判为不成立的边」。
    const identityConflictRulings = identityConflictRulings.value.map(item => ({
      concept: item.concept,
      ruling: item.ruling,
      ...(item.groups?.length ? { groups: item.groups } : {})
    }));
    // 归属确认整包提交（含空数组＝撤销全部）。依据不得为空——「人点了一下」不是依据，
    // 服务端也会拒绝；这里先拦一次是为了把人名与缺哪一条对应起来，而不是丢回一个 400。
    const sourceAssignments = sourceAssignments.value.map(item => ({ objectId: item.objectId, system: item.system, evidence: (sourceEvidence.value[item.objectId] ?? item.evidence ?? '').trim() }));
    const missingSourceEvidence = sourceAssignments.filter(item => !item.evidence);
    if (missingSourceEvidence.length) {
      editorMessage.value = `以下调用的归属确认缺少依据：${missingSourceEvidence.map(item => item.objectId).join('、')}。归属会写入来源系统并参与范围裁剪，必须留下依据（材料原文或人工说明）。`;
      busy.value = false;
      return;
    }
    // 同名声明裁定先做一次前置校验：把「哪一项的分组还没写完」直接指出来。
    // 服务端仍会独立校验（它还会挡组名撞名），这里只是别让人对着 400 自己去数。
    const declarationIssues = [];
    for (const entry of declarationRulings.value) {
      if (entry.ruling !== 'distinct') continue;
      const conflict = declarationConflicts.value.find((item) => item.key === entry.key);
      if (!conflict) continue;
      const problem = declarationSplitProblem(conflict);
      if (problem) declarationIssues.push(`${conflict.objectId}：${problem}`);
    }
    if (declarationIssues.length) {
      editorMessage.value = `同名声明裁定还没写完——${declarationIssues.join('；')}`;
      busy.value = false;
      return;
    }
    const declarationPayload = declarationRulings.value.map(entry => {
      if (entry.ruling !== 'distinct') return { key: entry.key, ruling: entry.ruling };
      const conflict = declarationConflicts.value.find((item) => item.key === entry.key);
      return { key: entry.key, ruling: 'distinct', groups: conflict ? buildDeclarationGroups(conflict) : (entry.groups || []) };
    });
    const task = await props.client.reviseProposal(selected.value.id, { revision: proposalEditor.value.revision, objectTypes, relationshipTypes: proposalEditor.value.relationshipTypes, primaryKeyCorrections, identityLinkConfirmations, identityConflictRulings, declarationRulings: declarationPayload, sourceAssignments });
    await loadTasks(task.id);
    message.value = task.response;
    editorMessage.value = '修订已保存，Schema Critic 和 Diff 已重新计算。';
  } catch (error) {
    editorMessage.value = IDENTITY_LINK_ERROR_MESSAGES[error.body?.code]
      || (error.body?.code === 'SEMANTIC_PROPOSAL_REVISION_CONFLICT' ? '提案已在其他窗口更新，请重新选择该任务后再修改。' : error.message || '提案修订保存失败。');
  } finally { busy.value = false; }
}

async function createTask() {
  if (!canSubmit.value) return;
  busy.value = true; message.value = ''; systemScopeError.value = '';
  try {
    // 范围始终随请求提交（含空数组）：客户端不替服务端决定范围语义，
    // 空范围应交由服务端按意图判定是否 400，而不是让前端猜哪些意图需要范围。
    const task = await props.client.createTask({ text: input.value.trim(), attachments: files.value, adoptionMode: adoptionMode.value, systemCodes: [...selectedSystems.value], ...(selected.value ? { parentTaskId: selected.value.id } : {}) });
    await loadTasks(task.id);
    input.value = ''; files.value = [];
    if (selected.value?.id !== task.id) { selected.value = task; tasks.value = [task, ...tasks.value.filter(item => item.id !== task.id)]; }
    if (task.proposal && task.status === 'waiting_confirmation') emit('review-created', task.id);
    message.value = task.status === 'completed' ? task.response : ['conversation', 'needs_clarification', 'unsupported_operation', 'permission_denied'].includes(task.intent)
      ? ''
      : task.confirmationRequired ? 'Agent已形成受控执行计划，请检查计划、Critic和Diff后再确认。' : '只读运营任务已完成。';
  } catch (error) {
    // 范围类拒绝要能被识别并高亮面板，而不是只丢一句提示。范围问题有两个发生点：
    // 任务创建阶段的范围校验（SEMANTIC_SYSTEM_*），以及提案构建阶段「对象全被范围排除」。
    const scopeCode = error.body?.code || '';
    if (scopeCode.startsWith('SEMANTIC_SYSTEM_') || scopeCode === 'SEMANTIC_PROPOSAL_SCOPE_EXCLUDED_ALL') systemScopeError.value = error.body.message || error.message;
    message.value = error.message || '任务创建失败。';
  }
  finally { busy.value = false; }
}

async function executeTask() {
  if (!canExecute.value) return;
  busy.value = true; message.value = '';
  try {
    const confirmation = await props.client.confirmTask(selected.value.id);
    selected.value = { ...selected.value, status: 'executing', confirmation: { state: 'consumed' } };
    const result = await props.client.executeTask(selected.value.id, confirmation.confirmationToken);
    await loadTasks(result.task.id);
    message.value = result.task.response;
    emit('applied', { message: result.task.response, task: result.task, result: result.result });
  } catch (error) {
    if (error.body?.task) {
      await loadTasks(error.body.task.id);
      message.value = error.body.task.response || error.message;
    } else message.value = error.message || '任务执行失败。';
  } finally { busy.value = false; }
}

function newTask() {
  selected.value = null; selectedTrace.value = null; input.value = ''; files.value = []; message.value = ''; proposalEditor.value = null; editorDirty.value = false; editorMessage.value = ''; selectedGraphObjectId.value = ''; systemScopeError.value = '';
}

async function loadSelectedTrace() {
  const taskId = selected.value?.id;
  selectedTrace.value = null;
  if (!taskId || !selected.value?.traceId) return;
  try { const result = await props.client.taskTrace(taskId); if (selected.value?.id === taskId) selectedTrace.value = result; } catch { selectedTrace.value = null; }
}

async function exportReport() {
  if (!selected.value || !desktopBridge?.exportReport) { message.value = '受控报告导出仅在元域智语桌面端开放。'; return; }
  if (!globalThis.confirm('确认把当前任务摘要和证据链导出到“文档/元域智语报告”？')) return;
  busy.value = true;
  try {
    const report = { reportType: 'semantic_operations_task', exportedAt: new Date().toISOString(), task: selected.value, evidenceTrace: selectedTrace.value };
    const receipt = await desktopBridge.exportReport({ name: `元域智语-${selected.value.title}-${selected.value.id.slice(-6)}`, format: 'json', content: report });
    await props.client.recordReportExport(selected.value.id, { destination: receipt.destination, fileName: receipt.fileName, bytes: receipt.bytes, sha256: receipt.sha256, createdAt: receipt.createdAt });
    exportedReport.value = receipt; message.value = `报告已受控导出：${receipt.fileName}`; await loadTasks(selected.value.id); await loadSelectedTrace();
  } catch (error) { message.value = error.message || '报告导出失败。'; }
  finally { busy.value = false; }
}

onMounted(() => {
  loadSystemScopeOptions();
  loadTasks(props.initialTaskId || undefined).catch((error) => { message.value = error.message; });
  refreshReviewTasks();
  if (props.canReview) reviewQueueTimer = setInterval(refreshReviewTasks, 20000);
});
let reviewQueueTimer = null;
onBeforeUnmount(() => { if (reviewQueueTimer) clearInterval(reviewQueueTimer); });
watch(() => props.canReview, enabled => {
  if (reviewQueueTimer) clearInterval(reviewQueueTimer);
  reviewQueueTimer = enabled ? setInterval(refreshReviewTasks, 20000) : null;
  if (enabled) refreshReviewTasks(); else reviewTasks.value = [];
});
watch(() => props.initialTaskId, id => loadTasks(id || undefined).catch(error => { message.value = error.message; }));
watch([taskStatus, showArchived], () => loadTasks().catch((error) => { message.value = error.message; }));
watch([() => selected.value?.id, () => selected.value?.proposal?.revision], initializeProposalEditor);
watch(() => selected.value?.id, loadSelectedTrace);
watch(() => selected.value?.id, () => nextTick(() => {
  if (transcript.value) transcript.value.scrollTop = 0;
}));
</script>

<template>
  <section class="agent-task-workspace">
    <section v-if="canReview" class="semantic-review-workarea" aria-label="待审核语义模型">
      <header><div><span>MODEL REVIEW QUEUE</span><h2>待审核语义模型</h2><p>只展示顶层对象、对象关系和来源系统摘要；字段与映射细节不作为审核入口。</p></div><b>{{ pendingReviewTasks.length }} 项待处理</b></header>
      <div v-if="pendingReviewTasks.length" class="semantic-review-cards">
        <article v-for="task in pendingReviewTasks" :key="task.id">
          <div><b>{{ task.title }}</b><small>{{ task.proposal.objectTypes.length }} 个对象 · {{ task.proposal.relationshipTypes.length }} 条关系 · 第 {{ task.proposal.revision }} 版</small><p>{{ task.proposal.objectTypes.map(item => item.label || item.id).join('、') }}</p></div>
          <button @click="openTask(task.id)">打开模型图并审核</button>
        </article>
      </div>
      <p v-else class="semantic-review-empty">目前没有分配给当前审核权限范围的待审模型。收到新提案后会自动出现在这里。</p>
    </section>
    <aside class="task-history">
      <header><div><span>任务窗口</span><b>{{ tasks.length }}{{ taskHasMore ? '+' : '' }}</b></div><button @click="newTask">＋ 新任务</button></header>
      <div class="task-filters"><input v-model="taskQuery" placeholder="搜索任务" @keyup.enter="loadTasks()"><select v-model="taskStatus"><option value="">全部状态</option><option value="waiting_confirmation">等待确认</option><option value="needs_input">等待补充</option><option value="denied">权限不足</option><option value="failed">回答失败</option><option value="executing">执行中</option><option value="retryable">可重试</option><option value="completed">已回应 / 已完成</option><option value="blocked">已阻止</option></select><label><input v-model="showArchived" type="checkbox">含归档</label><button @click="loadTasks()">查询</button></div>
      <div ref="taskList" class="task-history-list" @scroll.passive="onTaskListScroll">
        <button v-for="task in tasks" :key="task.id" :class="['task-history-item', { active: selected?.id === task.id }]" @click="selected = task"><span>{{ intentLabel[task.intent] }}</span><b>{{ task.title }}</b><small>{{ taskStatusLabel(task) }} · {{ formatTaskTime(task.createdAt) }}</small></button>
        <p v-if="!tasks.length">尚无运营任务。输入自然语言目标后，Agent会建立独立任务窗口。</p>
        <p v-else-if="taskLoadingMore" class="task-list-status">正在加载更多任务…</p>
        <p v-else-if="!taskHasMore" class="task-list-status">已显示全部任务</p>
      </div>
    </aside>

    <div class="task-conversation">
      <div ref="transcript" class="task-transcript">
        <template v-if="selected">
        <article v-for="(item, index) in selected.messages" :key="`${item.time}-${index}`" :class="['task-message', item.role === 'user' ? 'user' : 'agent']"><span>{{ item.role === 'user' ? '运营人员' : '元域智语 Agent' }} · 第 {{ Math.floor(index / 2) + 1 }} 轮</span><p>{{ item.content }}</p></article>
        <section v-if="selected.proposal" class="semantic-model-review-card">
          <header><div><span>待审核语义模型 · 第 {{ selected.proposal.revision }} 版</span><small>{{ selected.proposal.objectTypes.length }} 个业务对象 · {{ selected.proposal.relationshipTypes.length }} 条对象关系 · 来源 {{ [...new Set(selected.proposal.objectTypes.flatMap(item => item.sourceSystems || []).filter(system => system && system !== 'UNASSIGNED'))].join(' / ') || '待确认' }}</small></div><b :class="selected.proposal.critic.status">{{ selected.proposal.critic.status === 'passed' ? '结构检查通过' : '需要修改' }}</b></header>
          <div class="review-graph-wrap" role="img" aria-label="待审核语义模型对象关系图">
            <svg :viewBox="`0 0 820 ${graphHeight}`" preserveAspectRatio="xMidYMid meet">
              <defs><marker id="review-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z"/></marker></defs>
              <line v-for="edge in graphEdges" :key="edge.key" :x1="edge.fromNode.x" :y1="edge.fromNode.y" :x2="edge.toNode.x" :y2="edge.toNode.y" marker-end="url(#review-arrow)"/>
              <text v-for="edge in graphEdges" :key="`${edge.key}-label`" :x="(edge.fromNode.x + edge.toNode.x) / 2" :y="(edge.fromNode.y + edge.toNode.y) / 2 - 8" text-anchor="middle">{{ edge.label || edge.predicate }} · {{ edge.cardinality }}</text>
              <g v-for="node in graphNodes" :key="node.id">
                <rect :x="node.x - 100" :y="node.y - 34" width="200" height="68" rx="10"/>
                <text :x="node.x" :y="node.y - 8" text-anchor="middle" class="review-node-title">{{ node.label }}</text>
                <text :x="node.x" :y="node.y + 12" text-anchor="middle" class="review-node-source">{{ node.sourceSystems?.join(' / ') || '来源待确认' }}</text>
              </g>
            </svg>
          </div>
          <div class="review-system-chain"><b>底层系统关联</b><article v-for="item in reviewSystemLinks" :key="item.key"><span>{{ item.from }} {{ item.relation }} {{ item.to }} · {{ item.cardinality }}</span><small>{{ item.handoffs.length ? item.handoffs.join('　·　') : '对象关系已识别，系统来源尚待确认' }}</small></article><p v-if="!reviewSystemLinks.length">当前模型没有候选关系，无法形成系统链路。</p></div>
          <footer><span>{{ selected.proposal.mappingValidation?.blocked ? '样本映射存在阻断，修改后再审核。' : selected.proposal.critic.status !== 'passed' ? '请先用自然语言指出需要调整的对象或关系。' : canReview ? '可直接用自然语言审核通过，也可以描述关系修改。' : '模型已进入审核队列；当前角色没有审核权限。' }}</span><button v-if="canReview && selected.status === 'waiting_confirmation' && selected.proposal.critic.status === 'passed' && !selected.proposal.mappingValidation?.blocked" @click="input = '审核通过'; nextTick(() => transcript?.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' }))">输入“审核通过”</button></footer>
        </section>
        <details v-if="selected.materialReview" class="task-message agent">
          <summary>附件读取范围 · {{ selected.materialReview.summary }}</summary>
          <div v-for="report in selected.materialReview.reports" :key="report.attachmentId">
            <b>{{ report.name }} · {{ !report.modelContentEligible ? '未读取 / 已隔离' : report.partial || report.truncated ? '部分读取' : '摘录可引用' }}</b>
            <p v-if="report.reason">{{ report.reason }}</p>
            <p v-if="report.truncated">内容超过处理上限；请拆分文件或缩小范围，未展示的部分不能推断。</p>
            <p v-if="report.missingPages?.length">未识别页面视觉内容：{{ report.missingPages.join('、') }}</p>
            <p v-for="warning in report.warnings || []" :key="warning">{{ warning }}</p>
          </div>
        </details>
        <article class="task-message agent"><span>当前任务状态 · {{ intentLabel[selected.intent] }}</span><div class="task-badges"><b>{{ taskStatusLabel(selected) }}</b><b>会话 {{ selected.threadId?.slice(-8) }} · 第{{ selected.turn }}轮</b><b>{{ selected.routing?.source === 'ark' ? '火山方舟理解' : selected.routing?.source === 'understanding_failed' ? '模型理解失败' : selected.routing?.source === 'local' ? '本地模型理解' : '受控规则' }}</b><b v-if="selected.requiredPermission">权限：{{ selected.requiredPermission }}</b><b v-if="selected.commandLabel">命令：{{ selected.commandLabel }}</b></div></article>
        <section v-if="selected.planning" class="task-planning">
          <header><div><span>PLANNING ENGINE</span><b>{{ selected.planning.mode === 'external_model_advisory' ? selected.planning.provider === 'ark' ? '火山方舟规划' : '云端模型规划' : selected.planning.mode === 'local_model_advisory' ? '本地模型规划' : '确定性安全规划' }}</b></div><small>{{ selected.planning.model }}</small></header>
          <p>{{ selected.planning.goal }}</p>
          <div class="planning-meta"><span>服务器意图：{{ intentLabel[selected.planning.authoritativeIntent] }}</span><span v-if="selected.planning.systems?.length">受控系统范围：{{ selected.planning.systems.join(' / ') }}</span><span v-if="selected.planning.intentConflict" class="conflict">模型建议与服务器意图不一致，已采用服务器判定</span><span v-if="selected.planning.systemConflict" class="conflict">模型建议了范围外系统，已按来源预检结果裁剪</span></div>
          <small>{{ selected.planning.rationale }}</small>
        </section>
        <section v-if="selected.plan?.length" class="agent-plan"><header><b>可审计执行计划</b><span>尚未执行的步骤不会被标记为完成</span></header><ol><li v-for="(step, index) in selected.plan" :key="step"><i>{{ index + 1 }}</i><span>{{ step }}</span></li></ol></section>

        <section v-if="selected.systemScope" class="task-modeling-scope">
          <header><div><span>MODELING SCOPE</span><b>建模来源范围</b></div><small>范围来源：显式选择</small></header>
          <div class="scope-chips"><b>已选</b><span v-for="code in selected.systemScope.selected" :key="code">{{ code }}</span></div>
          <div class="scope-chips covered"><b>已覆盖</b><span v-for="code in selected.systemScope.covered" :key="code">{{ code }}</span><em v-if="!selected.systemScope.covered.length">无</em></div>
          <div v-if="selected.systemScope.uncovered.length" class="scope-findings blocked"><b>未覆盖系统</b><span v-for="item in selected.systemScope.uncovered" :key="item.code">{{ item.code }}：{{ item.reason }}</span></div>
          <div v-if="selected.systemScope.excludedObjects?.length" class="scope-findings blocked"><b>按范围排除的对象</b><span v-for="item in selected.systemScope.excludedObjects" :key="item.objectId">{{ item.objectId }}（{{ item.sourceSystems.join('/') }}）</span><small>这些对象的来源系统不在本次所选范围内，已从提案中排除；如需纳入请补选对应系统后重跑。</small></div>
          <div v-if="selected.systemScope.excludedRelationships?.length" class="scope-findings warning"><b>随对象排除的关系</b><span v-for="item in selected.systemScope.excludedRelationships" :key="`${item.from}-${item.predicate}-${item.to}`">{{ item.from }} → {{ item.to }}（{{ item.predicate }}）</span><small>端点对象被排除后，关系一并排除，避免留下悬空边。</small></div>
          <div v-if="selected.systemScope.partialScopeObjects?.length" class="scope-findings warning"><b>部分来源超出范围</b><span v-for="item in selected.systemScope.partialScopeObjects" :key="item.objectId">{{ item.objectId }}（超出 {{ item.outside.join('/') }}）</span><small>这些对象仍有来源在所选范围内，已保留；仅提示其部分来源未被选择。</small></div>
          <div v-if="selected.systemScope.unassignedObjects?.length" class="scope-findings warning"><b>来源未标注对象</b><span>{{ selected.systemScope.unassignedObjects.join('、') }}；材料未声明来源系统，无法追溯，已保留。</span></div>
          <div v-if="selected.systemScope.mentionedNotSelected?.length" class="scope-findings warning"><b>文本提到但未选择</b><span>{{ selected.systemScope.mentionedNotSelected.join('、') }}；未纳入本次范围。</span></div>
          <div v-if="selected.systemScope.identity?.summary?.links" class="scope-findings warning">
            <b>跨系统标识对应</b>
            <span>{{ selected.systemScope.identity.summary.links }} 条引用，其中 {{ selected.systemScope.identity.summary.requiresMapping }} 条两端键形状不同（需结构化映射定义）{{ selected.systemScope.identity.summary.shapeUnknown ? `，${selected.systemScope.identity.summary.shapeUnknown} 条有一端形状未判定（需先判定形状）` : '' }}。</span>
            <small>这些对应关系是**假设**（由字段名归一化与事务概念别名表推导），未自动写入草稿关系；明细见下方「标识对应与冲突」。</small>
          </div>
          <div v-if="selected.systemScope.identity?.keyGaps?.length" class="scope-findings blocked">
            <b>未识别到自身标识</b>
            <span v-for="item in selected.systemScope.identity.keyGaps" :key="item.system + item.objectId">{{ item.objectId }}（{{ item.system }}）</span>
            <small>这些对象没有被用来判定标识的字段；系统不会拿第一个字段顶替，需人工补充。</small>
          </div>
        </section>

        <section v-if="selected.proposal?.identityLinking && (selected.proposal.identityLinking.conflicts?.length || selected.proposal.identityLinking.links?.length || selected.proposal.identityLinking.unresolvedReferences?.length)" class="task-modeling-scope">
          <header><div><span>IDENTITY LINKING</span><b>标识对应与冲突</b></div><small>发现即上报，确认后才并入草稿关系</small></header>
          <div class="scope-findings warning" v-for="item in selected.proposal.identityLinking.conflicts" :key="item.kind + (item.field || item.concept || item.objectId)">
            <b>{{ item.kind === 'ambiguous_identifier' ? '标识归属歧义' : item.kind === 'alias_divergence' ? '同义不同名' : item.kind === 'key_shape_incompatible' ? '键形状不可对齐' : '同名声明不一致' }}</b>
            <span>{{ item.field || item.concept || item.objectId }}：{{ item.reason }}</span>
          </div>
          <div v-if="selected.proposal.identityLinking.links?.length" class="scope-chips">
            <b>跨系统引用</b>
            <span v-for="item in selected.proposal.identityLinking.links" :key="item.evidence" :class="item.status === 'requires_mapping' ? 'requires-mapping' : ''">{{ item.evidence }}</span>
          </div>
          <div v-if="selected.proposal.identityLinking.unresolvedReferences?.length" class="scope-findings warning"><b>范围内引用但没有对应实体</b><span v-for="item in selected.proposal.identityLinking.unresolvedReferences" :key="item.field">{{ item.field }}→{{ item.concept }}（{{ item.system }}.{{ item.objectId }}）</span><small>可能是漏选了系统，或该对象未进入候选。</small></div>
        </section>

        <section v-if="selected.sourceDiscovery" class="source-discovery">
          <header><div><span>SOURCE DISCOVERY</span><b>来源与连接物料预检</b></div><small>不查询业务明细</small></header>
          <div class="source-cards"><article v-for="source in selected.sourceDiscovery.sources" :key="source.code" :class="source.status"><header><b>{{ source.code }}</b><span>{{ source.status }}</span></header><h4>{{ source.name }}</h4><p>{{ source.message }}</p><div v-if="source.objects?.length"><small>候选对象</small><b>{{ source.objects.join('、') }}</b></div><div v-if="source.mappings?.length"><small>已有映射</small><b>{{ source.mappings.length }} 项</b></div></article></div>
          <div v-if="selected.sourceDiscovery.blockers?.length" class="source-findings blocker"><b>阻断项</b><span v-for="item in selected.sourceDiscovery.blockers" :key="item">{{ item }}</span></div>
          <div v-if="selected.sourceDiscovery.warnings?.length" class="source-findings warning"><b>准备提醒</b><span v-for="item in selected.sourceDiscovery.warnings" :key="item">{{ item }}</span></div>
          <details v-if="selected.sourceDiscovery.sources?.length"><summary>查看真实接入所需物料</summary><ul><li v-for="item in selected.sourceDiscovery.sources[0].requiredAssets" :key="item">{{ item }}</li></ul></details>
        </section>

        <details v-if="selected.proposal && !selected.reviewerAccess" class="task-proposal">
          <summary>高级技术细节 · 字段映射、主键、来源证据与逐项校验</summary>
          <p v-if="selected.onboardingSource">来源：模拟接入项目 {{ selected.onboardingSource.projectId }}，材料修订 {{ selected.onboardingSource.materialRevision }}。{{ selected.onboardingSource.boundary }}</p>
          <header><div><span>SCHEMA CRITIC</span><b :class="selected.proposal.critic.status">{{ selected.proposal.critic.status === 'passed' ? '结构校验通过' : '存在阻断问题' }}</b></div><small>相对于当前草稿：新增对象 {{ selected.proposal.diff.summary.addedObjects }} · 更新对象 {{ selected.proposal.diff.summary.updatedObjects }} · 新增关系 {{ selected.proposal.diff.summary.addedRelationships }}</small></header>
          <div v-if="selected.proposal.schemaDiscovery?.files?.length" class="schema-discovery-summary"><div><b>结构化材料发现</b><span>{{ selected.proposal.schemaDiscovery.summary }}</span></div><span v-for="file in selected.proposal.schemaDiscovery.files" :key="file.attachmentId">{{ file.name }} · {{ file.format }} · {{ file.sourceSystem }} · {{ file.schemaCount }} 对象</span><small v-for="warning in selected.proposal.schemaDiscovery.warnings" :key="warning">{{ warning }}</small></div>
          <div class="task-critic-checks"><span v-for="check in selected.proposal.critic.checks" :key="check.name"><b>{{ check.status === 'passed' ? '通过' : '失败' }}</b>{{ check.name }}</span></div>
          <section v-if="selected.proposal.businessValidation" class="world-model-review">
            <h4>业务验收范围</h4>
            <p>结构：{{ selected.proposal.businessValidation.structureVerified ? '已核对' : '未通过' }} · 样本：{{ selected.proposal.businessValidation.samplesVerified ? '已验证当前样本' : '尚未完整验证' }} · 待评审需求：{{ selected.proposal.businessValidation.pendingRequirementCount }}</p>
            <p>{{ selected.proposal.businessValidation.detail }}</p>
          </section>
          <details v-if="selected.proposal.schemaDiscovery?.warnings?.length" class="world-model-review" open>
            <summary>材料待处理项 · {{ selected.proposal.schemaDiscovery.warnings.length }}</summary>
            <p v-for="warning in selected.proposal.schemaDiscovery.warnings" :key="warning">{{ warning }}</p>
            <article v-for="(conflict, index) in selected.proposal.schemaDiscovery.conflicts || []" :key="`${conflict.objectId}-${index}`">
              <b>{{ conflict.objectId }} · {{ conflict.reason }}</b>
              <p v-for="(version, versionIndex) in conflict.versions" :key="versionIndex">材料版本 {{ versionIndex + 1 }}：来源 {{ version.sourceSystem }} · 主键 {{ version.key }} · 粒度 {{ version.granularity }} · {{ version.fields.length }} 个字段</p>
            </article>
          </details>
          <details v-if="selected.proposal.worldModel?.rules?.length" class="world-model-review">
            <summary>业务规则与状态依据 · {{ selected.proposal.worldModel.rules.length }} 条待校对</summary>
            <p>以下是带原文证据的需求资产，不是已经生效的计算规则或权限。请在模型治理中配置指标、状态与已注册能力，并完成案例回放。</p>
            <article v-for="rule in selected.proposal.worldModel.rules" :key="rule.id">
              <b>{{ rule.objectTypes.join('、') || '跨对象约束' }} · {{ rule.categories.join(' / ') || '业务需求' }}</b>
              <p>{{ rule.evidence }}</p>
            </article>
          </details>
          <div class="task-model-diff"><article><b>对象建议</b><span v-for="item in selected.proposal.objectTypes" :key="item.id">{{ item.label }}<small>{{ item.id }} · {{ item.sourceSystems.join('/') }} · 主键 {{ item.key }}</small></span></article><article><b>关系建议</b><span v-for="item in selected.proposal.relationshipTypes" :key="`${item.from}-${item.predicate}-${item.to}`">{{ item.from }} — {{ item.predicate }} → {{ item.to }}<small>{{ item.cardinality }}{{ item.derivedFrom ? ' · 推断（人工确认）' : '' }}</small></span></article></div>
          <!--
            阶段 4g（ADR-022）：候选对象的**覆盖面**。
            此前只有一句写在文字说明里的「请核对是否遗漏」——核对什么、怎么核对，界面上一个字都没有。
            这里把两侧点亮：受控目录**缺哪些类**（确定性，与系统目录已登记的世界模型对象求差集），
            材料里**哪些列举项没被覆盖**（启发式，已自我标注）。
            注意：这两块都只是披露，点名的对象**不会**因此进入候选（披露不等于补齐）。
          -->
          <div v-if="selected.proposal.candidateCoverage?.fallbackApplied" class="candidate-coverage">
            <b>候选对象覆盖面 · 受控目录 {{ selected.proposal.candidateCoverage.catalogSize }} 类，本次命中 {{ selected.proposal.candidateCoverage.matched.length }} 类</b>
            <span v-for="entry in selected.proposal.candidateCoverage.matched" :key="entry.id">{{ entry.id }} ← {{ entry.matchedTerms.join('、') }}</span>
            <small>这条路只按词面匹配，不是从材料里抽出来的：材料里写到、但目录未覆盖的业务对象不会出现在候选里。</small>
            <div v-if="selected.proposal.candidateCoverage.gaps.length" class="scope-findings warning">
              <b>目录里没有词条的对象类 · {{ selected.proposal.candidateCoverage.gaps.length }}</b>
              <span v-for="item in selected.proposal.candidateCoverage.gaps" :key="`${item.system}.${item.objectType}`">{{ item.objectType }}（{{ item.system }}）</span>
              <small>这些对象已在系统目录里登记为世界模型对象，受控目录里却没有词条承载它们：材料里若只提到这些对象，关键词兜底一定命中不到。要建它们，请上传结构化数据字典，或先在系统目录里补词条后重跑。</small>
            </div>
            <div v-if="selected.proposal.candidateCoverage.uncoveredMentions.length" class="scope-findings warning">
              <b>材料里未被任何词条覆盖的列举项 · {{ selected.proposal.candidateCoverage.uncoveredTotal }}</b>
              <span v-for="mention in selected.proposal.candidateCoverage.uncoveredMentions" :key="mention">{{ mention }}</span>
              <small>启发式清单（{{ selected.proposal.candidateCoverage.uncoveredBasis }}），不是对象抽取结果：可能混入非对象词，也可能漏掉没有用分隔符列出的对象名。这些词不会进入候选，请人工核对。</small>
            </div>
          </div>
          <!--
            阶段 4h（ADR-025）：受控对象链接的披露。与上面的词面兜底并列，但来源不同：
            模型把材料里的**逐字称呼**对应到系统目录**已登记**的对象类型，服务端逐字校验后
            才可能成候选。`skipped` 是解读前提（模拟运行时下链接没跑，「linked 为空」不说明
            材料里没有已登记对象）；每条链接带 structured 标记——给不出结构的留在
            structureGaps（系统无声明 / 声明里识别不出主键），只披露、不进候选。
          -->
          <div v-if="mentionLinking" class="candidate-coverage mention-linking">
            <b>受控对象链接 · {{ mentionLinking.skipped ? '未运行' : `模型链接 ${mentionLinking.linked.length} 条` }}</b>
            <template v-if="!mentionLinking.skipped">
              <span v-for="link in mentionLinking.linked" :key="`${link.system}.${link.objectType}`">{{ link.mention }} → {{ link.objectType }}（{{ link.system }}）· {{ link.structured ? '已成候选（字段映射待确认）' : '无候选结构' }}</span>
              <small v-if="mentionLinking.truncated">链接共 {{ mentionLinking.total }} 条，仅显示前 {{ mentionLinking.linked.length }} 条；同一对象的多条提及已合并 {{ mentionLinking.mergedDuplicates }} 条。</small>
              <small v-else-if="mentionLinking.mergedDuplicates">同一对象的多条提及已合并 {{ mentionLinking.mergedDuplicates }} 条（材料里多次提到同一个对象是一个对象，不是多个）。</small>
              <div v-if="mentionLinking.structureGaps.length" class="scope-findings warning">
                <b>链接成立但给不出候选结构 · {{ mentionLinking.structureGaps.length }}</b>
                <span v-for="gap in mentionLinking.structureGaps" :key="`${gap.system}.${gap.objectType}`">{{ gap.mention }}→{{ gap.objectType }}（{{ gap.system }} · {{ gap.reason === 'no_declaration' ? '系统无字段声明' : '声明里识别不出主键' }}）</span>
                <small>这些对象类型已在系统目录登记、材料里也逐字提到，但该系统没有可用的字段/主键声明，无法形成有结构的候选（空壳候选过不了审阅）。请补系统声明或上传结构化数据字典后重跑。</small>
              </div>
            </template>
            <small v-else>{{ mentionLinking.skipReason }}</small>
          </div>
          <div v-if="selected.proposal.editDiff" class="edit-diff-summary"><b>人工修订 Diff · 第 {{ selected.proposal.revision }} 版</b><span>新增对象 {{ selected.proposal.editDiff.summary.addedObjects }}</span><span>修改对象 {{ selected.proposal.editDiff.summary.updatedObjects }}</span><span>删除对象 {{ selected.proposal.editDiff.summary.removedObjects }}</span><span>新增关系 {{ selected.proposal.editDiff.summary.addedRelationships }}</span><span>删除关系 {{ selected.proposal.editDiff.summary.removedRelationships }}</span></div>

          <section v-if="proposalEditor" class="schema-editor">
            <header><div><span>VISUAL SCHEMA EDITOR</span><b>对象、字段、主键与关系复核</b></div><button :disabled="!canEditProposal || busy" @click="addObject">＋ 对象</button></header>
            <p>对象编码和来源系统用于治理追踪；修改字段名后请重新检查主键与关系。这里保存的是提案修订，不会直接发布模型。</p>
            <div class="proposal-graph">
              <header><div><b>候选语义关系图</b><span>点击节点联动下方字段与映射编辑器</span></div><div><b>{{ mappingSummary.ready }}/{{ mappingSummary.total }}</b><span>字段映射就绪</span></div></header>
              <svg :viewBox="`0 0 820 ${graphHeight}`" role="img" aria-label="Agent候选语义模型关系图">
                <defs><marker id="proposal-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z"/></marker></defs>
                <line v-for="edge in graphEdges" :key="edge.key" :x1="edge.fromNode.x" :y1="edge.fromNode.y" :x2="edge.toNode.x" :y2="edge.toNode.y" marker-end="url(#proposal-arrow)"/>
                <text v-for="edge in graphEdges" :key="`${edge.key}-label`" :x="(edge.fromNode.x + edge.toNode.x) / 2" :y="(edge.fromNode.y + edge.toNode.y) / 2 - 7" class="edge-label">{{ edge.predicate }} · {{ edge.cardinality }}</text>
                <g v-for="node in graphNodes" :key="node.id" :class="['proposal-graph-node', { selected: selectedGraphObjectId === node.id, warning: node.pendingMappings || node.validationStatus === 'unverified', validationFailed: node.validationStatus === 'failed' }]" role="button" tabindex="0" @click="selectedGraphObjectId = node.id" @keydown.enter="selectedGraphObjectId = node.id">
                  <rect :x="node.x - 100" :y="node.y - 34" width="200" height="68" rx="8"/>
                  <text :x="node.x" :y="node.y - 10" text-anchor="middle" class="node-label">{{ node.label }}</text>
                  <text :x="node.x" :y="node.y + 7" text-anchor="middle" class="node-meta">{{ node.id }} · {{ node.sourceSystems.join('/') }}</text>
                  <text :x="node.x" :y="node.y + 23" text-anchor="middle" class="node-mapping">{{ node.pendingMappings ? `${node.pendingMappings} 个映射待确认` : `${node.mappedFields} 个字段已映射` }}</text>
                </g>
              </svg>
            </div>
            <section v-if="unconfirmedCandidates.length || outOfScopeCandidates.length || sourceAssignments.length" class="source-attribution">
              <header><div><span>SOURCE ATTRIBUTION</span><b>来源归属确认</b></div><small>{{ sourceAssignments.length }} 个对象已确认归属</small></header>
              <p>材料里写明的归属由模型<b>逐字取证</b>、服务端判定成候选（模型不能直接给系统编码）。候选不写来源系统、也不参与范围裁剪；但确认之后就会——归属一旦成为事实，落在范围外的对象会被裁掉，草稿关系随端点一并排除。</p>
              <div v-if="unconfirmedCandidates.length" class="scope-findings"><b>待确认归属（{{ unconfirmedCandidates.length }}）</b><span v-for="object in unconfirmedCandidates" :key="object.id">{{ object.id }} → {{ object.candidateSourceSystems.join('/') }}（依据：{{ object.candidateSourceEvidence }}）</span><small>在对象卡片上点「按材料确认归属」，或手工填写来源系统并补充依据。</small></div>
              <div v-if="outOfScopeCandidates.length" class="scope-findings blocked"><b>推断归属落在所选范围外（{{ outOfScopeCandidates.length }}）</b><span v-for="item in outOfScopeCandidates" :key="item.objectId">{{ item.objectId }} → {{ item.system }}</span><small>因归属未经确认，这些对象<b>没有</b>被排除——未确认的归属不足以决定对象去留。请确认归属或补选对应系统。</small></div>
              <button v-if="sourceAssignments.length && canEditProposal && !busy" @click="clearAllSourceAssignments">撤销全部归属确认</button>
            </section>
            <div class="schema-object-list">
              <article v-for="object in proposalEditor.objectTypes" v-show="selectedGraphObjectId === object.id" :key="object.id" class="schema-object-card">
                <header><div><code>{{ object.id }}</code><input v-model="object.label" :disabled="!canEditProposal || busy" aria-label="对象业务名称" @input="markEditorDirty"></div><button :disabled="!canEditProposal || busy" title="删除对象" @click="removeObject(object.id)">删除</button></header>
                <div class="object-meta-grid">
                  <label>数据来源<input v-model="object.source" :disabled="!canEditProposal || busy" @input="markEditorDirty"></label>
                  <label>数据分级<select v-model="object.classification" :disabled="!canEditProposal || busy" @change="markEditorDirty"><option>内部</option><option>内部受限</option><option>内部受限（待复核）</option><option>个人信息受限</option><option>质量受限</option><option>财务受限</option></select></label>
                  <label>核心元对象<select v-model="object.coreObject" :disabled="!canEditProposal || busy" @change="markEditorDirty"><option v-for="anchor in [...new Set([object.id, object.coreObject, 'Person', 'RawMaterial', 'Product', 'Equipment', 'Store'])]" :key="anchor" :value="anchor">{{ anchor === object.id ? `${anchor}（独立类型）` : anchor }}</option></select></label>
                  <label>来源系统<input :value="object.sourceSystems.join(' / ')" :disabled="!canEditProposal || busy" placeholder="例如 ERP / WMS；待核实请保留 UNASSIGNED" @input="setObjectSourceSystem(object, $event.target.value)"></label>
                </div>
                <div v-if="object.candidateSourceSystems?.length && !sourceAssignmentsOf(object.id)" class="source-candidate">
                  <span>材料推断归属：<b>{{ object.candidateSourceSystems.join(' / ') }}</b>（尚未确认，未写入来源系统、未参与范围裁剪）</span>
                  <small>依据（模型逐字引用）：{{ object.candidateSourceEvidence }}</small>
                  <button :disabled="!canEditProposal || busy" @click="confirmSourceCandidate(object)">按材料确认归属</button>
                </div>
                <div v-else-if="sourceAssignmentsOf(object.id)" class="source-candidate confirmed">
                  <span>归属已确认：<b>{{ sourceAssignmentsOf(object.id).system }}</b>（写入来源系统，参与范围裁剪）</span>
                  <input v-model="sourceEvidence[object.id]" :disabled="!canEditProposal || busy" maxlength="240" placeholder="归属依据（必填）：材料原文或人工说明" @input="upsertSourceAssignment(object.id, sourceAssignmentsOf(object.id).system, sourceEvidence[object.id]); markEditorDirty()">
                  <button :disabled="!canEditProposal || busy" @click="removeSourceAssignment(object.id)">撤销该归属</button>
                </div>
                <div class="field-table">
                  <header><b>字段定义</b><span>主键</span><span>字段名</span><span>类型</span><span>源字段</span><span>映射方式</span><span>必填</span><i></i></header>
                  <div v-for="(field, fieldIndex) in object.fieldDefinitions" :key="`${object.id}-${fieldIndex}`">
                    <span :class="['mapping-dot', field.mappingStatus]"></span><input type="radio" :name="`pk-${object.id}`" :checked="object.key === field.name" :disabled="!canEditProposal || busy" title="设为主键" @change="setPrimaryKey(object, field.name)"><input v-model="field.name" :disabled="!canEditProposal || busy" aria-label="字段名" @input="syncFieldName(object, field)"><input v-model="field.type" :disabled="!canEditProposal || busy" aria-label="字段类型" @input="markEditorDirty"><input v-model="field.sourceField" :disabled="!canEditProposal || busy || ['derived', 'ignored'].includes(field.mappingStatus)" aria-label="源字段" @input="markEditorDirty"><select v-model="field.mappingStatus" :disabled="!canEditProposal || busy" aria-label="映射方式" @change="updateMapping(field)"><option value="mapped">自动匹配</option><option value="manual">人工映射</option><option value="derived">派生字段</option><option value="ignored">明确忽略</option><option value="pending">待确认</option></select><input v-model="field.required" type="checkbox" :disabled="!canEditProposal || busy || object.key === field.name" title="必填" @change="markEditorDirty"><button :disabled="!canEditProposal || busy" title="删除字段" @click="removeField(object, fieldIndex)">×</button>
                  </div>
                  <button :disabled="!canEditProposal || busy" @click="addField(object)">＋ 添加字段</button>
                </div>
                <label v-if="needsKeyCorrection(object.id)">原材料缺少主键：补充选择依据（12–1000 字符）
                  <textarea v-model="keyCorrectionReasons[object.id]" :disabled="!canEditProposal || busy" maxlength="1000" rows="3" placeholder="先选择原材料已有字段作为主键，再说明业务唯一性依据和核对范围。人工声明不等于样本或生产验收。" @input="markEditorDirty" />
                </label>
                <p v-if="needsKeyCorrection(object.id)">原始材料与缺项提示会保留。此处仅补充缺失主键，不允许覆盖材料中已经声明的主键；采纳时仍会重新检查样本和权限。</p>
              </article>
            </div>

            <section v-if="aliasConflicts.length || withdrawnIdentityLinks.length" class="identity-conflict-rulings">
              <header><div><span>IDENTITY EQUIVALENCE RULING</span><b>标识等价假设裁定</b></div><small>{{ aliasConflicts.length - unresolvedAliasConcepts.length }}/{{ aliasConflicts.length }} 已裁定</small></header>
              <p>每个概念在系统声明里由多个字段名表达（同一批次既有 <code>material_batch_id</code> 又有 <code>lot_no</code> 这类）。跨系统标识对齐全建立在「它们指向同一个实体」这个<b>假设</b>上——假设不先回答，逐条确认就是在确认一个没人验证过的前提。裁定只决定「哪些对应成立」，<b>不会</b>直接写进草稿关系；写入仍需在下方逐条确认。</p>
              <p v-if="unresolvedAssumptionLinkCount" class="scope-note warning">当前有 <b>{{ unresolvedAssumptionLinkCount }}</b> 条标识对应的等价前提尚未裁定。</p>
              <article v-for="conflict in aliasConflicts" :key="conflict.concept" :class="{ ruled: Boolean(rulingOfConcept(conflict.concept)) }">
                <header>
                  <div><b>{{ conflict.concept }}</b><small>{{ conflict.fields.length }} 个字段名：{{ conflict.fields.map(field => `${field.name}（${field.shape === 'business' ? '业务键' : field.shape === 'agent' ? '代理键' : '标识'}）`).join('、') }}</small></div>
                  <small v-if="conflict.ruling">服务端已记录：{{ conflict.ruling === 'same_entity' ? '同一实体' : '不同实体' }}</small>
                </header>
                <div class="ruling-actions">
                  <button :class="{ active: rulingOfConcept(conflict.concept) === 'same_entity' }" :disabled="!canEditProposal || busy" @click="setConflictRuling(conflict.concept, 'same_entity')">确认为同一实体</button>
                  <button :class="{ active: rulingOfConcept(conflict.concept) === 'distinct_entity' }" :disabled="!canEditProposal || busy" @click="setConflictRuling(conflict.concept, 'distinct_entity')">确认为不同实体</button>
                  <button v-if="rulingOfConcept(conflict.concept)" :disabled="!canEditProposal || busy" @click="clearConflictRuling(conflict.concept)">撤销裁定</button>
                </div>
                <label v-if="rulingOfConcept(conflict.concept) === 'distinct_entity'">等价类分组（每行一组，组内用逗号分隔；必须恰好覆盖上面全部字段名，否则保存会被拒绝）
                  <textarea v-model="identityRulingGroupsText[conflict.concept]" :disabled="!canEditProposal || busy" rows="3" spellcheck="false" placeholder="每个字段名各占一行即表示两两属于不同实体" @input="setConflictRuling(conflict.concept, 'distinct_entity')" />
                </label>
                <small v-if="conflict.ruling === 'same_entity'">已裁定为同一实体：这些字段名下的跨系统对应视为同一实体的标识。</small>
                <small v-else-if="conflict.ruling === 'distinct_entity'">已裁定为不同实体：跨等价类的对应已撤下，不再出现在下方可确认清单里。</small>
              </article>
              <small v-if="withdrawnIdentityLinks.length" class="scope-note">因裁定为不同实体，已撤下 {{ withdrawnIdentityLinks.length }} 条跨组对应（<b>它们不再可确认</b>）：<span v-for="item in withdrawnIdentityLinks" :key="item.key">{{ item.from }}→{{ item.to }}；</span></small>
            </section>

            <section v-if="declarationConflicts.length || mergedUnruledEntries.length" class="declaration-divergence">
              <header><div><span>DECLARATION DIVERGENCE RULING</span><b>同名声明合并 / 区分裁定</b></div><small>{{ declarationConflicts.length - unresolvedDeclarationItems.length }}/{{ declarationConflicts.length }} 已裁定</small></header>
              <p>同一个对象在同一系统里可能被<b>多处</b>声明（受控词汇表、已配置映射、材料抽取），字段集不一致时服务端默认<b>取并集</b>——而并集还会参与标识识别，于是可能给出一个<b>没有任何一处声明说过</b>的标识。这里回答「这些声明是不是同一个对象」：确认并集成立，或按声明拆成不同对象（拆出的对象只是来源系统的声明，尚未进入提案）。裁定只改字段目录的组成，<b>不写草稿关系</b>。</p>
              <p v-if="mergedUnruledEntries.length" class="scope-note warning">当前有 <b>{{ mergedUnruledEntries.length }}</b> 个对象的字段目录仍是并集（未裁定）：{{ mergedUnruledEntries.map(item => `${item.system}.${item.object.objectId}`).join('、') }}。</p>
              <article v-for="conflict in declarationConflicts" :key="conflict.key" :class="{ ruled: Boolean(declarationRulingOf(conflict.key)) }">
                <header>
                  <div><b>{{ conflict.objectId }}</b><small>{{ conflict.scope === 'object' ? '同名对象被不同系统声明' : '同一张表被两处声明' }} · {{ conflict.declarations.length }} 处声明 · 分歧项 {{ conflict.key }}</small></div>
                  <small v-if="conflict.ruling">服务端已记录：{{ conflict.ruling === 'merge' ? '同一对象（并集）' : '不同对象（不并集）' }}</small>
                </header>
                <ul class="declaration-list">
                  <li v-for="declaration in conflict.declarations" :key="declaration.declarationKey">
                    <code>{{ declaration.declarationKey }}</code>
                    <span>{{ declaration.fields.join('、') }}</span>
                    <label v-if="declarationRulingOf(conflict.key) === 'distinct'"><input type="text" :value="nameOfDeclaration(conflict.key, declaration.declarationKey)" :disabled="!canEditProposal || busy || droppedDeclaration(conflict.key, declaration.declarationKey)" maxlength="64" placeholder="对象名（同名即同组）" @input="setDeclarationName(conflict.key, declaration.declarationKey, $event.target.value)"><input type="checkbox" :checked="droppedDeclaration(conflict.key, declaration.declarationKey)" :disabled="!canEditProposal || busy" @change="toggleDeclarationDrop(conflict.key, declaration.declarationKey, $event.target.checked)"><em>排除该声明</em></label>
                  </li>
                </ul>
                <div class="ruling-actions">
                  <button :class="{ active: declarationRulingOf(conflict.key) === 'merge' }" :disabled="!canEditProposal || busy" @click="setDeclarationRuling(conflict, 'merge')">确认为同一对象（并集）</button>
                  <button :class="{ active: declarationRulingOf(conflict.key) === 'distinct' }" :disabled="!canEditProposal || busy" @click="setDeclarationRuling(conflict, 'distinct')">确认为不同对象（拆分）</button>
                  <button v-if="declarationRulingOf(conflict.key)" :disabled="!canEditProposal || busy" @click="clearDeclarationRuling(conflict.key)">撤销裁定</button>
                </div>
                <label v-if="declarationRulingOf(conflict.key) === 'distinct'">给每处声明取对象名：<b>同名自动归为同一对象</b>，不同名即不同对象；勾选「排除该声明」则该声明的字段不再进入字段目录。至少要保留一组。</label>
                <small v-if="conflict.ruling === 'merge'">已裁定为同一对象：这些声明取字段并集（这不再是一个默认动作，而是一条结论）。</small>
                <small v-else-if="conflict.ruling === 'distinct'">已裁定为不同对象：字段不再取并集，各组按自己声明的字段识别标识。</small>
              </article>
              <small v-if="selected.proposal?.identityLinking?.declarationReport?.droppedLinks?.length" class="scope-note">因对象改名或字段集改变，以下 {{ selected.proposal.identityLinking.declarationReport.droppedLinks.length }} 条标识对应已不再存在（<b>此前的确认随之失效</b>）：<span v-for="item in selected.proposal.identityLinking.declarationReport.droppedLinks" :key="item.key">{{ item.evidence }}；</span></small>
              <small v-if="selected.proposal?.identityLinking?.declarationReport?.droppedDeclarations?.length" class="scope-note">因裁定区分粒度，以下 {{ selected.proposal.identityLinking.declarationReport.droppedDeclarations.length }} 条声明被显式排除（不再出现在字段目录里）：<span v-for="item in selected.proposal.identityLinking.declarationReport.droppedDeclarations" :key="item.declarationKey">{{ item.declarationKey }}；</span></small>
            </section>

            <section v-if="identityLinkCandidates.length" class="identity-link-review">
              <header><div><span>IDENTITY LINK CONFIRMATION</span><b>跨系统标识对应复核</b></div><small>{{ confirmedLinkKeys.length }}/{{ eligibleLinkCount }} 已确认（本次可确认）{{ ineligibleLinkCount ? ` · ${ineligibleLinkCount} 条本次不可并入` : '' }}{{ incompleteLinkCount ? ` · ${incompleteLinkCount} 条待补齐` : '' }}</small></header>
              <p>这些对应由字段名归一化加人工登记的别名表推出，属<b>推断</b>而非材料证据。确认后才会并入草稿关系，并标记为「推断」；材料里已逐字写明的同一条边不会被推断覆盖。</p>
              <p><b>两端键形状不同</b>的对应不能按值直接连接，必须给出<b>结构化映射定义</b>（依据类型 / 责任人 / 版本）——它会随关系写入草稿，下游据此知道「这条边需要经映射」。<b>有一端形状未判定</b>的（裸名，命名规则判不出代理键 / 业务键）要先判定形状，服务端据此重新定级，<b>不能先确认再说</b>。<b>本次不可并入</b>的是端点对象不在本次候选对象内的对应（它们只在系统声明里存在）——仍然列出以免「这条引用不存在」的错觉，但要先让那个对象成为候选对象。</p>
              <article v-for="link in identityLinkCandidates" :key="link.key" :class="{ confirmed: confirmedLinkKeys.some(item => item.key === link.key), mapping: effectiveLinkStatus(link) === 'requires_mapping', 'shape-unknown': effectiveLinkStatus(link) === 'shape_unknown', ineligible: !link.eligible }">
                <label><input type="checkbox" :checked="confirmedLinkKeys.some(item => item.key === link.key)" :disabled="!canEditProposal || busy || !link.eligible" @change="toggleIdentityLink(link.key)"><span>{{ link.evidence }}</span></label>
                <small v-if="!link.eligible" class="ineligible-note">{{ linkEligibilityNote(link) }}</small>
                <small v-else-if="effectiveLinkStatus(link) === 'requires_mapping'">两端键形状不同（{{ link.from.shape || identityLinkShapes[link.key] }} ↔ {{ link.to.shape }}）：不能按值直接对齐</small>
                <small v-else-if="effectiveLinkStatus(link) === 'shape_unknown'">有一端键形状<b>未判定</b>：<b>{{ link.from.field }}</b> 是裸名，命名规则判不出代理键 / 业务键——先判定形状，服务端据此决定能否按值对齐</small>
                <small v-else>可直接对齐（{{ link.from.shape }} ↔ {{ link.to.shape }}）</small>
                <small>基数 {{ link.cardinality }} · 概念 {{ link.concept }} · 等价前提 {{ link.ruling === 'same_entity' ? '已裁定为同一实体' : link.ruling === 'distinct_entity' ? '已裁定为不同实体（两端同组）' : '未裁定' }}</small>
                <div v-if="link.eligible && link.status === 'shape_unknown'" class="shape-judgement">
                  <span>形状判定</span>
                  <label v-for="option in linkMappingOptions.shapes" :key="option.value"><input type="radio" :name="`shape-${link.key}`" :checked="identityLinkShapes[link.key] === option.value" :disabled="!canEditProposal || busy" @change="setLinkShape(link.key, option.value)">{{ option.label }}</label>
                </div>
                <div v-if="link.eligible && effectiveLinkStatus(link) === 'requires_mapping'" class="key-mapping-editor">
                  <span>结构化映射定义</span>
                  <select :value="linkMappingOf(link.key).basis" :disabled="!canEditProposal || busy" @change="setLinkMapping(link.key, 'basis', $event.target.value)"><option value="">选择映射依据类型…</option><option v-for="option in linkMappingOptions.bases" :key="option.value" :value="option.value">{{ option.label }}</option></select>
                  <input v-if="linkMappingOf(link.key).basis === 'master_data_lookup'" :value="linkMappingOf(link.key).lookupSource" :disabled="!canEditProposal || busy" maxlength="120" placeholder="对照表来源（必填）" @input="setLinkMapping(link.key, 'lookupSource', $event.target.value)">
                  <input :value="linkMappingOf(link.key).owner" :disabled="!canEditProposal || busy" maxlength="48" placeholder="责任人（必填）" @input="setLinkMapping(link.key, 'owner', $event.target.value)">
                  <input :value="linkMappingOf(link.key).version" :disabled="!canEditProposal || busy" maxlength="24" placeholder="版本（必填）" @input="setLinkMapping(link.key, 'version', $event.target.value)">
                  <small>两端键固定为 <code>{{ link.from.field }} → {{ link.to.field }}</code>，服务端会校验（不能填成另一条对应的映射）。</small>
                </div>
                <textarea v-if="link.eligible" v-model="identityLinkEvidence[link.key]" :disabled="!canEditProposal || busy" rows="2" maxlength="80" :placeholder="effectiveLinkStatus(link) === 'requires_mapping' ? '补充说明（可选，≤80 字）：人为什么这样判——映射的结构由上面的定义表达' : '确认说明（可选，≤80 字）'" @input="syncConfirmedLink(link.key)" />
                <small v-if="link.declarationSourced">来源端依据为系统配置声明（不是本次材料抽出的候选对象）。</small>
              </article>
              <small v-if="identityLinkConfirmationReport && (identityLinkConfirmationReport.merged || identityLinkConfirmationReport.skippedExisting.length || identityLinkConfirmationReport.droppedStale.length || identityLinkConfirmationReport.shapeResolutions?.length)" class="scope-note">{{ identityLinkConfirmationReport.merged }} 条已并入草稿关系（标记为推断）；{{ identityLinkConfirmationReport.skippedExisting.length }} 条已有材料证据，未覆盖证据；{{ identityLinkConfirmationReport.droppedStale.length }} 条此前确认已失效并移除（{{ identityLinkConfirmationReport.droppedStale.map(item => item.reason).join('；') }}）{{ identityLinkConfirmationReport.shapeResolutions?.length ? `；${identityLinkConfirmationReport.shapeResolutions.length} 条经人工判定形状（${identityLinkConfirmationReport.shapeResolutions.map(item => `${item.field}→${item.shape === 'agent' ? '代理键' : '业务键'}`).join('、')}）` : '' }}。</small>
            </section>

            <div class="relationship-editor">
              <header><b>关系定义</b><button :disabled="!canEditProposal || busy" @click="addRelationship">＋ 关系</button></header>
              <div v-for="(relation, relationIndex) in proposalEditor.relationshipTypes" :key="relationIndex" :class="{ derived: relation.derivedFrom }">
                <select v-model="relation.from" :disabled="!canEditProposal || busy || Boolean(relation.derivedFrom)" @change="markEditorDirty"><option v-for="object in proposalEditor.objectTypes" :key="object.id" :value="object.id">{{ object.id }}</option></select>
                <input v-model="relation.predicate" :disabled="!canEditProposal || busy || Boolean(relation.derivedFrom)" aria-label="关系谓词" @input="markEditorDirty">
                <select v-model="relation.to" :disabled="!canEditProposal || busy || Boolean(relation.derivedFrom)" @change="markEditorDirty"><option v-for="object in proposalEditor.objectTypes" :key="object.id" :value="object.id">{{ object.id }}</option></select>
                <select v-model="relation.cardinality" :disabled="!canEditProposal || busy || Boolean(relation.derivedFrom)" @change="markEditorDirty"><option>1:1</option><option>1:n</option><option>n:1</option><option>n:n</option></select>
                <small v-if="relation.derivedFrom">推断（人工确认并入）· 由标识对应复核控制</small>
                <button v-else :disabled="!canEditProposal || busy" @click="removeRelationship(relationIndex)">×</button>
              </div>
            </div>
            <section v-if="selected.proposal.impactAnalysis" :class="['impact-analysis', selected.proposal.impactAnalysis.riskLevel]"><header><div><span>CHANGE IMPACT</span><b>修订影响分析</b></div><strong>{{ selected.proposal.impactAnalysis.riskLevel === 'high' ? '高影响' : selected.proposal.impactAnalysis.riskLevel === 'medium' ? '中影响' : selected.proposal.impactAnalysis.riskLevel === 'low' ? '低影响' : '无结构变化' }}</strong></header><div><span>变化对象 {{ selected.proposal.impactAnalysis.changedObjectCount }}</span><span>影响关系 {{ selected.proposal.impactAnalysis.affectedRelationships.length }}</span><span>主键变化 {{ selected.proposal.impactAnalysis.keyChanges.length }}</span><span>待确认映射 {{ selected.proposal.impactAnalysis.pendingMappings.length }}</span></div><ul><li v-for="item in selected.proposal.impactAnalysis.requiredActions" :key="item">{{ item }}</li></ul><small>{{ selected.proposal.impactAnalysis.policy }}</small></section>
            <section v-if="selected.proposal.mappingValidation" :class="['mapping-validation', selected.proposal.mappingValidation.status]">
              <header><div><span>DATA MAPPING REHEARSAL</span><b>Mock 样本映射演练</b><small>{{ selected.proposal.mappingValidation.contract.contractId }} · 服务端第 {{ selected.proposal.revision }} 版</small></div><strong>{{ selected.proposal.mappingValidation.status === 'passed' ? '演练通过' : selected.proposal.mappingValidation.status === 'failed' ? '存在阻断' : '部分验证' }}</strong></header>
              <div class="mapping-validation-metrics"><span><b>{{ selected.proposal.mappingValidation.summary.verifiedObjectCount }}/{{ selected.proposal.mappingValidation.summary.objectCount }}</b>对象通过</span><span><b>{{ selected.proposal.mappingValidation.summary.successfulSampleCount }}/{{ selected.proposal.mappingValidation.summary.sampleCount }}</b>样本转换</span><span><b>{{ selected.proposal.mappingValidation.summary.observedCoveragePercent }}%</b>字段命中</span><span><b>{{ selected.proposal.mappingValidation.summary.errorCount }}</b>阻断问题</span></div>
              <div class="mapping-validation-objects"><button v-for="object in selected.proposal.mappingValidation.objects" :key="object.objectId" :class="[object.status, { active: selectedMappingValidationObject?.objectId === object.objectId }]" @click="selectedGraphObjectId = object.objectId"><b>{{ object.objectId }}</b><span>{{ object.sourceSystem || '未分配' }} · {{ object.successfulSampleCount }}/{{ object.sampleCount }} 样本</span></button></div>
              <div v-if="selectedMappingValidationObject" class="mapping-validation-detail">
                <header><div><b>{{ selectedMappingValidationObject.objectId }}</b><span>{{ selectedMappingValidationObject.sourceSystem }}.{{ selectedMappingValidationObject.sourceObjectType }}</span></div><small>观察到 {{ selectedMappingValidationObject.observedFieldCount }}/{{ selectedMappingValidationObject.fieldCount }} 个目标字段</small></header>
                <div v-if="selectedMappingIssues.length" class="mapping-validation-issues"><p v-for="issue in selectedMappingIssues" :key="`${issue.code}-${issue.field}`" :class="issue.severity"><b>{{ issue.field || issue.objectId }}</b><span>{{ issue.message }}{{ issue.occurrences > 1 ? `（${issue.occurrences}个样本）` : '' }}</span><small>{{ issue.suggestion }}</small></p></div>
                <div v-if="selectedMappingValidationObject.transformedSamples.length" class="canonical-preview"><article v-for="sample in selectedMappingValidationObject.transformedSamples" :key="sample.sourceRecordId"><header><b>{{ sample.canonicalFact.id || '主键未生成' }}</b><span>{{ sample.sourceRecordId }} · 仅 Mock</span></header><div v-for="(value, field) in sample.canonicalFact.fields" :key="field"><span>{{ field }}</span><code>{{ displayPreviewValue(value) }}</code></div></article></div>
                <p v-else class="mapping-no-sample">当前对象没有可用 Mock 样本，只验证了契约结构，尚不能证明数据可转换。</p>
              </div>
              <small class="mapping-policy">{{ selected.proposal.mappingValidation.policy }}</small>
            </section>
            <footer><span :class="{ dirty: editorDirty }">{{ editorMessage || '当前界面与服务端提案版本一致。' }}</span><button :disabled="!editorDirty || busy" @click="saveProposalRevision">{{ busy ? '正在复核…' : '保存修订并重跑结构与映射演练' }}</button></footer>
          </section>
        </details>

        <section v-if="selected.result && selected.intent === 'inspect_status'" class="task-status-result"><article><b>{{ selected.result.objectCount }}</b><span>对象</span></article><article><b>{{ selected.result.relationshipCount }}</b><span>关系</span></article><article><b>{{ selected.result.validationStatus }}</b><span>校验</span></article><article><b>{{ selected.result.simulationStatus }}</b><span>模拟</span></article></section>

        <p v-if="selected.modelUnavailable" class="task-degraded">本轮模型理解不可用（{{ selected.routing?.modelFailureCode || '模型结果不可用' }}），当前结论由服务端确定性规则生成，未经过模型理解。发布动作不会在降级状态下授权。</p>

        <section v-if="selected.events?.length" class="task-events"><span>任务证据时间线（北京时间）</span><div v-for="event in selected.events" :key="`${event.time}-${event.type}`"><time>{{ formatTaskTime(event.time) }}</time><b>{{ event.type }}</b><small>{{ event.detail }}</small></div></section>
        <details v-if="selectedTrace" class="task-events"><summary>可验证 Evidence Trace · {{ selectedTrace.eventCount }} 个哈希链事件</summary><div v-for="event in selectedTrace.events" :key="event.hash"><time>{{ formatTaskTime(event.createdAt) }}</time><b>{{ event.stage }} · {{ event.status }}</b><small>{{ event.summary }} · {{ event.hash.slice(0, 12) }}</small></div><code>Head {{ selectedTrace.headHash }}<br>Manifest {{ selectedTrace.manifestHash }}</code></details>
        <button v-if="desktopBridge?.exportReport" class="task-archive" :disabled="busy" @click="exportReport">导出当前任务与证据链报告</button><button v-if="exportedReport" class="task-archive" @click="desktopBridge.showReport(exportedReport.path)">在文件夹中显示 {{ exportedReport.fileName }}</button>
        <button v-if="selected.status !== 'executing' && !selected.archivedAt" class="task-archive" @click="archiveTask">归档此任务</button>
        <button v-if="canExecute" class="task-confirm" @click="executeTask">明确确认：{{ selected.commandLabel }}</button>
        <p v-else-if="selected.status === 'waiting_confirmation' && editorDirty" class="task-blocked">请先保存当前可视化修改，重新运行 Schema Critic 后才能确认。</p>
        <p v-else-if="selected.status === 'waiting_confirmation' && selected.proposal?.critic?.status === 'failed'" class="task-blocked">Schema Critic 未通过，请在上方编辑器修复对象、主键、字段或关系。</p>
        <p v-else-if="selected.status === 'waiting_confirmation' && selected.proposal?.mappingValidation?.blocked" class="task-blocked">Mock 样本映射演练未通过，请根据上方字段缺失、类型或主键问题修正映射后再确认。</p>
        <p v-else-if="selected.status === 'blocked'" class="task-blocked">任务已被治理关口阻止。根据上方原因修复模型后，请建立新任务重新执行。</p>
        </template>
        <section v-else class="task-empty"><span>SEMANTIC OPERATIONS AGENT</span><h3>创建一个新的运营任务</h3><p>可以要求Agent建设模型、查看状态、校验草稿、模拟构建或提交发布。写操作始终先形成计划并等待确认。</p></section>
      </div>

      <div class="task-input-dock">
        <section class="task-system-scope" aria-label="建模来源范围">
          <header><div><span>MODELING SCOPE</span><b>来源系统（必选）</b></div><small>{{ selectedSystems.length }} / {{ systemScopeOptions.length }} 已选</small></header>
          <p v-if="systemScopeMessage" class="scope-note">{{ systemScopeMessage }}</p>
          <div v-else class="scope-picker">
            <button v-for="option in systemScopeOptions" :key="option.code" type="button" :class="{ active: selectedSystems.includes(option.code), forbidden: !option.authorized }" :aria-pressed="selectedSystems.includes(option.code)" :disabled="busy" @click="toggleSystem(option.code)">
              <b>{{ option.code }}</b><span>{{ option.authorized ? option.name : '超出当前角色数据域' }}</span><small>{{ option.status }}{{ option.objects.length ? ` · ${option.objects.length} 个候选对象` : '' }}</small>
            </button>
          </div>
          <p class="scope-note">这里的勾选决定本次建模与来源预检的范围，不改变数据授权：服务器最多读到当前角色已授权的数据，超出数据域的系统会被拒绝而不是静默裁剪。</p>
          <p v-if="undefinedSelectedSystems.length" class="scope-note blocked">已选中的 {{ undefinedSelectedSystems.map(item => item.code).join('、') }} 超出当前角色数据域，提交会被服务器拒绝；请取消选择或改由具备权限的人员处理。</p>
          <p v-if="mentionedNotSelected.length" class="scope-note warning">文本里提到 {{ mentionedNotSelected.join('、') }}，但没有选中；不会被自动纳入范围。</p>
          <p v-if="scopeRequiredReason" class="scope-note blocked">{{ scopeRequiredReason }}</p>
          <p v-if="systemScopeError" class="scope-note blocked">{{ systemScopeError }}</p>
        </section>
        <label class="adoption-mode">建模采纳方式 <select v-model="adoptionMode" :disabled="busy" aria-label="建模采纳方式"><option value="merge">合并到当前草稿（保留既有对象）</option><option value="replace">替换当前草稿（确认后保留回滚快照）</option></select><small>当前工作区只有一个活动模型；此选项不创建并行模型。</small></label>
        <p v-if="message" class="task-message-bar">{{ message }}</p>
        <div class="task-composer"><div v-if="files.length" class="task-files"><span v-for="(file, index) in files" :key="`${file.name}-${index}`">{{ file.name }}<button @click="files.splice(index, 1)">×</button></span></div><textarea v-model="input" :disabled="busy" aria-label="向元域智语 Agent 提交任务" :placeholder="selected?.proposal ? '例如：审核通过；把采购订单与供应商改成多对一；补充物流系统间的关系；发布当前语义模型。' : selected ? '继续当前语义任务，例如：再补充WMS库位对象，并检查映射。' : '例如：检查当前语义模型状态；或者上传WMS数据字典建设采购到入库模型。'" @keydown.ctrl.enter="createTask"/><footer><div><button class="attach" :disabled="busy" @click="fileInput?.click()">＋ 添加材料</button><small>最多5份、合计12MB；支持 PDF / 图片 / DOCX / XLSX / JSON / YAML / CSV</small></div><div class="composer-actions"><small>{{ selected ? '将承接当前任务上下文' : 'Ctrl + Enter 发送' }}</small><button class="send" :disabled="!canSubmit" @click="createTask">{{ busy ? 'Agent处理中…' : selected ? '发送审核意见' : '交给Agent' }}</button></div></footer><input ref="fileInput" type="file" hidden multiple accept="image/jpeg,image/png,image/webp,application/pdf,application/json,.json,.yaml,.yml,text/csv,.csv,.docx,.xlsx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" @change="chooseFiles"/></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.adoption-mode{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:#aacbd5;font-size:12px;margin-bottom:8px}.adoption-mode select{max-width:100%;padding:7px;background:#0a2634;color:#d3edf1;border:1px solid #315b6b;border-radius:6px}.adoption-mode small{color:#91adb7}.adoption-mode :focus-visible{outline:2px solid #65d3ba;outline-offset:2px}
.world-model-review{margin:12px 0;padding:14px;border:1px solid #345565;border-radius:8px;color:#b9d2de;overflow-wrap:anywhere;font-size:12px;line-height:1.6}.world-model-review h4{margin:0;color:#69d9c2}.world-model-review summary{cursor:pointer;color:#69d9c2}.world-model-review article{padding:10px 0;border-top:1px solid #294553}.world-model-review p{margin:6px 0}.world-model-review b{font-size:11px}
.semantic-model-review-card{display:grid;gap:13px;margin:12px 0;padding:16px;border:1px solid #31716c;border-radius:11px;background:linear-gradient(145deg,#0d292f,#091d29);box-shadow:0 10px 26px #020a0e55}
.semantic-model-review-card>header{display:flex;align-items:center;justify-content:space-between;gap:10px}.semantic-model-review-card>header>div{display:grid;gap:5px}.semantic-model-review-card>header span{color:#d9eeee;font-size:13px;font-weight:750}.semantic-model-review-card>header small{color:#86a9b4;font-size:10px}.semantic-model-review-card>header>b{padding:5px 8px;border-radius:999px;color:#65d4ba;background:#103b35;font-size:9px}.semantic-model-review-card>header>b.failed{color:#f2a9a9;background:#40252d}
.review-graph-wrap{width:100%;overflow-x:auto;border:1px solid #234958;border-radius:9px;background:#071923}.review-graph-wrap svg{display:block;width:100%;min-width:540px;height:auto;max-height:420px}.review-graph-wrap line{stroke:#4cb7a8;stroke-width:2;marker-end:url(#review-arrow)}.review-graph-wrap marker path{fill:#65d6c3}.review-graph-wrap rect{fill:#103140;stroke:#377889;stroke-width:1.3}.review-graph-wrap .review-node-title{fill:#d3edf0;font-size:13px;font-weight:700}.review-graph-wrap .review-node-source{fill:#67cdb9;font-size:10px}.review-graph-wrap text:not(.review-node-title):not(.review-node-source){fill:#9ac3ce;font-size:9px}
.review-system-chain{display:grid;gap:6px}.review-system-chain>b{color:#75cabd;font-size:10px}.review-system-chain article{display:grid;gap:4px;padding:8px 10px;border:1px solid #234858;border-radius:7px;background:#081b27}.review-system-chain article span{color:#c6e0e4;font-size:10px}.review-system-chain article small{color:#68bfae;font-size:9px}.review-system-chain p{color:#829da8;font-size:10px}
.semantic-model-review-card>footer{display:flex;justify-content:space-between;align-items:center;gap:8px}.semantic-model-review-card>footer span{color:#8aabb5;font-size:9px}.semantic-model-review-card>footer button{padding:7px 10px;border:1px solid #3f8b80;border-radius:6px;color:#a4eee0;background:#123b39;font-size:9px;cursor:pointer}
.agent-task-workspace{display:grid;grid-template-columns:218px minmax(0,1fr);height:clamp(600px,calc(100vh - 280px),820px);min-height:0;border:1px solid #285064;border-radius:10px;overflow:hidden;background:#081925;box-shadow:0 18px 48px #020a0f59}.task-history{min-height:0;padding:0 12px 12px;overflow-y:auto;overscroll-behavior:contain;border-right:1px solid #274353;background:#071520;scrollbar-gutter:stable}.task-history>header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding:12px 0 10px;background:linear-gradient(180deg,#071520 78%,#07152000)}.task-history header div{display:flex;gap:5px;align-items:center;color:#7193a5;font-size:9px}.task-history header div b{color:#71d3c6}.task-history header button{border:1px solid #31586b;border-radius:5px;padding:5px 7px;color:#8fd7d5;background:#0c2634;font-size:9px}.task-history-item{display:grid;gap:4px;width:100%;margin-bottom:6px;padding:10px;border:1px solid transparent;border-radius:7px;color:#7896a6;background:transparent;text-align:left;transition:border-color .15s ease,background .15s ease,transform .15s ease}.task-history-item:hover{border-color:#2c5e72;background:#0b2432;transform:translateX(2px)}.task-history-item.active{border-color:#3c788c;background:#0e3040;box-shadow:inset 3px 0 #56cdb9}.task-history-item:focus-visible,.task-history header button:focus-visible,.task-composer button:focus-visible,.task-confirm:focus-visible{outline:2px solid #68d7c4;outline-offset:2px}.task-history-item span{color:#54b8bf;font-size:8px;letter-spacing:.08em}.task-history-item b{overflow:hidden;color:#c2dbe3;font-size:10px;white-space:nowrap;text-overflow:ellipsis}.task-history-item small,.task-history>p{color:#627f90;font-size:8px;line-height:1.5}.task-conversation{display:grid;grid-template-rows:minmax(0,1fr) auto;min-width:0;min-height:0;overflow:hidden;background:radial-gradient(circle at 88% 8%,#12334466,transparent 34%)}.task-transcript{min-width:0;min-height:0;padding:18px;overflow-y:auto;overscroll-behavior:contain;scroll-behavior:smooth;scrollbar-gutter:stable}.task-history,.task-transcript{scrollbar-color:#31586b #081925;scrollbar-width:thin}.task-history::-webkit-scrollbar,.task-transcript::-webkit-scrollbar{width:8px}.task-history::-webkit-scrollbar-thumb,.task-transcript::-webkit-scrollbar-thumb{border:2px solid #081925;border-radius:8px;background:#31586b}.task-message{display:grid;gap:6px;margin-bottom:10px;padding:12px 14px;border:1px solid #29495a;border-radius:8px;background:#0b2030}.task-message.user{margin-left:12%;border-color:#335367;background:#102738}.task-message span{color:#5eb9c2;font-size:8px;letter-spacing:.08em}.task-message p{margin:0;color:#c6dce4;font-size:11px;line-height:1.65}.task-badges{display:flex;flex-wrap:wrap;gap:5px}.task-badges b{padding:3px 5px;border-radius:3px;color:#7fb6c5;background:#102f40;font-size:8px}.agent-plan,.task-proposal,.task-events{margin:10px 0;padding:12px;border:1px solid #29495a;border-radius:8px;background:#091c29}.agent-plan header,.task-proposal>header{display:flex;justify-content:space-between;gap:12px}.agent-plan header b,.task-proposal header span{color:#bcd9e1;font-size:10px}.agent-plan header span,.task-proposal header small{color:#6d8e9f;font-size:8px}.agent-plan ol{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:10px 0 0;padding:0;list-style:none}.agent-plan li{display:flex;align-items:center;gap:7px;color:#8da9b6;font-size:9px}.agent-plan li i{width:19px;height:19px;display:grid;place-items:center;border:1px solid #386477;border-radius:50%;color:#69c7c6;font-style:normal;font-size:8px}.task-proposal>header>div{display:grid;gap:3px}.task-proposal header b{font-size:10px}.task-proposal header b.passed{color:#55d5ae}.task-proposal header b.failed{color:#ed8993}.task-critic-checks{display:flex;flex-wrap:wrap;gap:5px;margin:10px 0}.task-critic-checks span{padding:5px;border:1px solid #28495a;border-radius:4px;color:#7d9cab;font-size:8px}.task-critic-checks b{margin-right:4px;color:#5ed1b4}.task-model-diff{display:grid;grid-template-columns:1fr 1fr;gap:8px}.task-model-diff article{display:grid;align-content:start;gap:5px;padding:9px;border:1px solid #233f4f;border-radius:6px;background:#071722}.task-model-diff article>b{color:#8ac4d0;font-size:9px}.task-model-diff article>span{display:grid;gap:2px;padding:5px;border-radius:3px;color:#acc8d2;background:#0d2735;font-size:8px}.task-model-diff small{color:#5f8597;font-size:7px}.task-status-result{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:10px 0}.task-status-result article{display:grid;gap:4px;padding:12px;border:1px solid #294a5b;border-radius:7px;background:#0a202d}.task-status-result b{color:#61d4c0;font-size:14px}.task-status-result span{color:#66899a;font-size:8px}.task-events>span{color:#7195a5;font-size:8px;letter-spacing:.08em}.task-events>div{display:grid;grid-template-columns:55px 120px 1fr;gap:8px;margin-top:7px;padding-top:7px;border-top:1px solid #1e3948}.task-events time,.task-events b,.task-events small{font-size:8px}.task-events time{color:#527b8e}.task-events b{color:#75bac5}.task-events small{color:#75909e}.task-confirm{width:100%;margin-top:10px;padding:10px;border:1px solid #49c3a5;border-radius:7px;color:#06231c;background:#58d6b5;font-size:10px;font-weight:800}.task-blocked,.task-message-bar{padding:8px;border:1px solid #74434b;border-radius:5px;color:#e29aa4;background:#2b1720;font-size:9px}
.task-system-scope{margin-bottom:9px;padding:9px 10px;border:1px solid #2d5567;border-radius:8px;background:#0a1f2c}
.task-system-scope>header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}
.task-system-scope>header>div{display:grid;gap:2px}
.task-system-scope>header span{color:#55b9c1;font-size:8px;letter-spacing:.1em}
.task-system-scope>header b{color:#c7e0e6;font-size:10px}
.task-system-scope>header small{color:#608698;font-size:8px}
.scope-picker{display:flex;flex-wrap:wrap;gap:6px;max-height:112px;overflow-y:auto;overscroll-behavior:contain}
.scope-picker button{display:grid;gap:2px;min-width:132px;padding:6px 8px;text-align:left;border:1px solid #2c5265;border-radius:6px;color:#9fc0cb;background:#081b27;cursor:pointer;transition:border-color .15s ease,background .15s ease}
.scope-picker button.active{border-color:#59d4bd;background:#10353a;box-shadow:inset 3px 0 #59d4bd}
.scope-picker button.forbidden{border-style:dashed;opacity:.72}
.scope-picker button b{color:#7fd8c8;font-size:10px}
.scope-picker button span{color:#a9c7d0;font-size:8px}
.scope-picker button small{color:#5f8294;font-size:7px}
.scope-picker button:not(:disabled):hover{filter:brightness(1.12)}
.scope-picker button:disabled{cursor:not-allowed;opacity:.5}
.scope-picker button:focus-visible{outline:2px solid #65d3ba;outline-offset:2px}
.scope-note{margin:6px 0 0;color:#71919f;font-size:8px;line-height:1.5}
.scope-note.warning{color:#e5b27d}
.scope-note.blocked{padding:6px 7px;border:1px solid #7a5c2f;border-radius:5px;color:#e7c189;background:#30251a}
.task-modeling-scope{margin:10px 0;padding:12px;border:1px solid #2d5567;border-radius:8px;background:#091c29}
.task-modeling-scope>header{display:flex;justify-content:space-between;gap:12px}
.task-modeling-scope>header>div{display:grid;gap:3px}
.task-modeling-scope>header span{color:#55b9c1;font-size:8px;letter-spacing:.1em}
.task-modeling-scope>header b{color:#c7e0e6;font-size:10px}
.task-modeling-scope>header small{color:#608698;font-size:8px}
.scope-chips{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:8px}
.scope-chips b{color:#6f96a4;font-size:8px}
.scope-chips span{padding:3px 6px;border-radius:4px;color:#bfe3e0;background:#123a35;font-size:8px}
.scope-chips.covered span{color:#a8cad2;background:#102f40}
/* 标识对应复核（阶段 4b）：推断 → 人工确认 → 并入。确认前不产生任何草稿关系。 */
/* 裁定面板与下方的对应复核视觉相邻但职责不同：裁定改「哪些对应成立」（输入），
   确认写草稿关系（输出）。用不同主色区分，避免被当成同一个动作的两个步骤。 */
.identity-conflict-rulings{margin-top:10px;padding:9px;border:1px solid #4a4460;border-radius:7px;background:#131024}
.identity-conflict-rulings>header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.identity-conflict-rulings>header>div{display:grid;gap:2px}
.identity-conflict-rulings>header span{color:#a48ede;font-size:7px;letter-spacing:.08em}
.identity-conflict-rulings>header b{color:#d3c8ee;font-size:9px}
.identity-conflict-rulings>header small{color:#7d76a0;font-size:7px}
.identity-conflict-rulings>p{margin:7px 0;color:#7f7aa0;font-size:8px;line-height:1.5}
.identity-conflict-rulings>p b{color:#e0b072}
.identity-conflict-rulings code{padding:0 3px;border-radius:3px;color:#b9aee0;background:#1d1830;font-size:7px}
.identity-conflict-rulings>article{display:grid;gap:5px;margin-top:6px;padding:7px;border:1px solid #332c4d;border-radius:5px;background:#100d1e}
.identity-conflict-rulings>article.ruled{border-color:#7a6bb0;background:#171331}
.identity-conflict-rulings>article>header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.identity-conflict-rulings>article>header>div{display:grid;gap:2px}
.identity-conflict-rulings>article>header b{color:#d3c8ee;font-size:9px}
.identity-conflict-rulings>article>header small{color:#7d76a0;font-size:7px;line-height:1.5}
.identity-conflict-rulings small{color:#7d76a0;font-size:7px;line-height:1.5}
.identity-conflict-rulings .ruling-actions{display:flex;gap:5px;flex-wrap:wrap}
.identity-conflict-rulings .ruling-actions button{padding:3px 8px;border:1px solid #453c68;border-radius:4px;color:#b4a8dc;background:#191433;font-size:7px;cursor:pointer}
.identity-conflict-rulings .ruling-actions button.active{border-color:#8d7bd0;color:#e6dff8;background:#2a2150}
.identity-conflict-rulings .ruling-actions button:disabled{color:#5d5878;cursor:not-allowed}
.identity-conflict-rulings label{display:grid;gap:3px;color:#7f7aa0;font-size:7px}
.identity-conflict-rulings textarea{min-width:0;border:1px solid #3b3460;border-radius:3px;padding:5px;color:#c3bae6;background:#171331;font-size:8px;resize:vertical}
.identity-conflict-rulings textarea:disabled{color:#6b6688;background:#100d1e}
.declaration-divergence{margin-top:10px;padding:9px;border:1px solid #2f5a4e;border-radius:7px;background:#081a16}
.declaration-divergence>header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.declaration-divergence>header>div{display:grid;gap:2px}
.declaration-divergence>header span{color:#4fc0a4;font-size:7px;letter-spacing:.08em}
.declaration-divergence>header b{color:#bfe6da;font-size:9px}
.declaration-divergence>header small{color:#6e9b8e;font-size:7px}
.declaration-divergence>p{margin:7px 0;color:#7fa79c;font-size:8px;line-height:1.5}
.declaration-divergence>article{display:grid;gap:5px;margin-top:6px;padding:7px;border:1px solid #27524a;border-radius:5px;background:#06130f}
.declaration-divergence>article.ruled{border-color:#3f8f78;background:#0a1f1a}
.declaration-divergence>article>header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.declaration-divergence>article>header>div{display:grid;gap:2px}
.declaration-divergence>article>header b{color:#c7ece0;font-size:9px}
.declaration-divergence>article>header small,.declaration-divergence small{color:#6f9c8f;font-size:7px;line-height:1.5}
.declaration-divergence .declaration-list{margin:0;padding:0;list-style:none;display:grid;gap:4px}
.declaration-divergence .declaration-list>li{display:grid;gap:3px;padding:5px;border:1px solid #22463f;border-radius:4px;background:#04100d}
.declaration-divergence .declaration-list code{color:#89d5bf;font-size:7px;word-break:break-all}
.declaration-divergence .declaration-list span{color:#618a7f;font-size:7px;word-break:break-all}
.declaration-divergence .declaration-list label{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.declaration-divergence .declaration-list input[type=text]{min-width:0;flex:1 1 140px;border:1px solid #2c5b50;border-radius:3px;padding:4px;color:#c6e9dd;background:#071a15;font-size:8px}
.declaration-divergence .declaration-list input[type=text]:disabled{color:#5d8579;background:#0a1714}
.declaration-divergence .declaration-list em{color:#6f9c8f;font-size:7px;font-style:normal}
.declaration-divergence .ruling-actions{display:flex;gap:5px;flex-wrap:wrap}
.declaration-divergence .ruling-actions button{padding:3px 8px;border:1px solid #2f6a5a;border-radius:4px;color:#9fd6c5;background:#0c2620;font-size:7px;cursor:pointer}
.declaration-divergence .ruling-actions button.active{border-color:#5fc4a4;color:#dff6ee;background:#123a2f}
.declaration-divergence .ruling-actions button:disabled{color:#4c7568;cursor:not-allowed}
.declaration-divergence>label{display:grid;gap:3px;color:#7aa79a;font-size:7px}
.identity-conflict-rulings>.scope-note{color:#948fbb}
.source-attribution{margin-top:10px;padding:9px;border:1px solid #6a5426;border-radius:7px;background:#1c1508}
.source-attribution>header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.source-attribution>header>div{display:grid;gap:2px}
.source-attribution>header span{color:#d9a441;font-size:7px;letter-spacing:.08em}
.source-attribution>header b{color:#e8d3a4;font-size:9px}
.source-attribution>header small{color:#a08a5c;font-size:7px}
.source-attribution>p{margin:7px 0;color:#9c8a68;font-size:8px;line-height:1.5}
.source-attribution>button{margin-top:6px}
.source-candidate{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;padding:6px 7px;border:1px dashed #6a5426;border-radius:6px;background:#1c1508}
.source-candidate>span{color:#c4b183;font-size:8px}
.source-candidate>small{flex-basis:100%;color:#8f8060;font-size:7px}
.source-candidate.confirmed{border-style:solid;border-color:#3f6a4a;background:#0d1c12}
.source-candidate.confirmed>span{color:#9fd0ac}
.source-candidate input{flex:1;min-width:160px;padding:3px 5px}
.identity-link-review{margin-top:10px;padding:9px;border:1px solid #2b5364;border-radius:7px;background:#0a202d}
.identity-link-review>header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.identity-link-review>header>div{display:grid;gap:2px}
.identity-link-review>header span{color:#5cbec3;font-size:7px;letter-spacing:.08em}
.identity-link-review>header b{color:#bad7dd;font-size:9px}
.identity-link-review>header small{color:#6d91a0;font-size:7px}
.identity-link-review>p{margin:7px 0;color:#6f92a2;font-size:8px;line-height:1.5}
.identity-link-review>p b{color:#e0b072}
.identity-link-review>article{display:grid;gap:4px;margin-top:6px;padding:7px;border:1px solid #244656;border-radius:5px;background:#081b27}
.identity-link-review>article.confirmed{border-color:#45a98f;background:#0b2622}
.identity-link-review>article.mapping{border-left:3px solid #d29b58}
.identity-link-review>article.shape-unknown{border-left:3px solid #8f7fd2}
/* 阶段 4e（ADR-020）：本次不可并入是**第四种**状态，不能与上面三种共用样式——
   它没有可填的输入，问题的位置也不在这条边上（而在「那个对象没进本次候选」）。 */
.identity-link-review>article.ineligible{border-color:#244656;border-left:3px solid #6d91a0;background:#071720}
.identity-link-review>article.ineligible label{color:#7f9fae}
.identity-link-review>article.ineligible label input{accent-color:#6d91a0}
.identity-link-review .ineligible-note{color:#d0a05f}
.identity-link-review .shape-judgement,.identity-link-review .key-mapping-editor{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px;border:1px dashed #3a5f74;border-radius:4px;background:#0a2230}
.identity-link-review .shape-judgement>span,.identity-link-review .key-mapping-editor>span{color:#8fb6c2;font-size:7px}
.identity-link-review .shape-judgement label{color:#bcd8de;font-size:7px}
.identity-link-review .key-mapping-editor select,.identity-link-review .key-mapping-editor input{min-width:0;border:1px solid #2b5061;border-radius:3px;padding:4px;color:#aecdd6;background:#0b2735;font-size:7px}
.identity-link-review .key-mapping-editor input{flex:1 1 120px}
.identity-link-review .key-mapping-editor>small{flex:1 1 100%}
.identity-link-review .key-mapping-editor code{color:#89d5bf;font-size:7px}
.identity-link-review label{display:flex;align-items:center;gap:7px;color:#bcd8de;font-size:8px}
.identity-link-review label input{width:13px;height:13px;accent-color:#54cbb0}
.identity-link-review small{color:#6d91a0;font-size:7px;line-height:1.5}
.identity-link-review textarea{min-width:0;border:1px solid #2b5061;border-radius:3px;padding:5px;color:#aecdd6;background:#0b2735;font-size:8px;resize:vertical}
.identity-link-review textarea:disabled{color:#668795;background:#081b27}
.identity-link-review>.scope-note{color:#8fb6c2}
/* 并入的关系由服务端从确认集合重建，界面不提供直接编辑入口——否则保存时会被丢弃而不自知。 */
.relationship-editor>div.derived{grid-template-columns:1fr 1fr 1fr 70px 124px;padding-left:5px;border-left:3px solid #45a98f}
.relationship-editor>div.derived input,.relationship-editor>div.derived select{color:#7fa6b2;background:#0a1f2b}
.relationship-editor>div.derived small{align-self:center;color:#59cbb4;font-size:7px;line-height:1.4}
@media(max-width:1300px){.relationship-editor>div.derived{grid-template-columns:1fr 1fr 1fr 58px 108px}}
/* 代理键↔业务键的引用不能按值直接对齐，与可直接对齐的引用在视觉上必须区分开，否则会被当成同一种结论。 */
.scope-chips span.requires-mapping{color:#e0c07a;background:#3a2f12}
.scope-chips em{color:#5f8294;font-size:8px;font-style:normal}
.scope-findings{display:grid;gap:4px;margin-top:8px;padding:7px;border-radius:5px;font-size:8px;line-height:1.5}
.scope-findings.warning{border:1px solid #6d5630;color:#e2b787;background:#2c2119}
.scope-findings.blocked{border:1px solid #7b4650;color:#ee9ba4;background:#2e1a20}
.scope-findings small{color:#a08a6e;font-size:7px}
/* 阶段 4g：候选对象覆盖面。配色与 .task-model-diff 同族（同为提案审阅区内的深色卡片）。 */
.candidate-coverage{display:grid;gap:5px;margin-top:8px;padding:9px;border:1px solid #233f4f;border-radius:6px;background:#071722}
.candidate-coverage>b{color:#8ac4d0;font-size:9px}
.candidate-coverage>span{padding:4px 5px;border-radius:3px;color:#acc8d2;background:#0d2735;font-size:8px}
.candidate-coverage>small{color:#5f8597;font-size:7px;line-height:1.5}
@media(max-height:800px){.scope-picker{max-height:76px}}
@media(max-width:760px){.scope-picker button{min-width:112px}}
.task-degraded{margin:8px 0;padding:8px;border:1px solid #7a5c2f;border-radius:5px;color:#e7c189;background:#30251a;font-size:9px;line-height:1.5}.task-empty{display:grid;place-items:center;align-content:center;min-height:100%;text-align:center}.task-empty span{color:#55b9c1;font-size:8px;letter-spacing:.15em}.task-empty h3{margin:8px 0;color:#dcecf0}.task-empty p{max-width:430px;margin:0;color:#7797a6;font-size:10px;line-height:1.6}.task-input-dock{position:relative;z-index:5;padding:8px 18px 16px;border-top:1px solid #244859;background:linear-gradient(180deg,#071722e8,#071722 24%);box-shadow:0 -18px 36px #04101a99}.task-composer{position:static;padding:10px;border:1px solid #3a6578;border-radius:9px;background:#0b2230;box-shadow:0 8px 24px #020b1270;transition:border-color .15s ease,box-shadow .15s ease}.task-composer:focus-within{border-color:#54bfae;box-shadow:0 0 0 2px #54bfae1f,0 8px 24px #020b1270}.task-composer textarea{display:block;width:100%;min-height:58px;max-height:140px;resize:none;border:0;outline:0;color:#d7e8ee;background:transparent;font:inherit;font-size:10px;line-height:1.55}.task-composer textarea::placeholder{color:#638394}.task-composer footer{display:flex;justify-content:space-between;align-items:center;gap:12px}.task-composer footer>div{display:flex;align-items:center;gap:8px;min-width:0}.task-composer button{border-radius:5px;padding:6px 9px;font-size:8px;transition:filter .15s ease,transform .15s ease}.task-composer button:not(:disabled):hover{filter:brightness(1.12);transform:translateY(-1px)}.task-composer button:disabled{cursor:not-allowed;opacity:.45}.attach{flex:none;border:1px solid #31586b;color:#7eb9c7;background:#0c2938}.send{flex:none;border:1px solid #52c9aa;color:#08261e;background:#59d7b5;font-weight:800}.task-composer small{overflow:hidden;color:#5f8294;font-size:7px;text-overflow:ellipsis;white-space:nowrap}.composer-actions{flex:none}.task-files{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px}.task-files span{padding:4px;border-radius:3px;color:#8eb0bd;background:#123344;font-size:8px}.task-files button{padding:0 2px;border:0;color:#80aabb;background:transparent}.task-message-bar{position:static;margin:0 0 7px;border-color:#2d675d;color:#80d7c0;background:#0c2926}@media(max-width:1300px){.agent-task-workspace{grid-template-columns:185px minmax(0,1fr);height:clamp(580px,calc(100vh - 265px),780px)}.agent-plan ol{grid-template-columns:1fr}.task-composer footer>div:first-child small{display:none}}
.task-planning,.source-discovery{margin:10px 0;padding:12px;border:1px solid #29495a;border-radius:8px;background:#091c29}.task-planning header,.source-discovery>header{display:flex;justify-content:space-between;gap:12px}.task-planning header>div,.source-discovery>header>div{display:grid;gap:3px}.task-planning header span,.source-discovery header span{color:#55b9c1;font-size:8px;letter-spacing:.1em}.task-planning header b,.source-discovery header b{color:#c7e0e6;font-size:10px}.task-planning header small,.source-discovery header small{color:#608698;font-size:8px}.task-planning p{margin:10px 0 7px;color:#b9d2da;font-size:10px}.task-planning>small{color:#718f9e;font-size:8px}.planning-meta{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:7px}.planning-meta span{padding:4px 6px;border-radius:4px;color:#83bac7;background:#102f40;font-size:8px}.planning-meta .conflict{color:#f0b382;background:#37261e}.source-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-top:10px}.source-cards article{display:grid;gap:5px;padding:9px;border:1px solid #2b4d5d;border-radius:6px;background:#071722}.source-cards article.not_registered,.source-cards article.forbidden,.source-cards article.rejected_endpoint,.source-cards article.missing_credential{border-color:#74434b}.source-cards article>header{display:flex;justify-content:space-between}.source-cards article>header b{color:#66d2c0;font-size:11px}.source-cards article>header span{color:#678c9d;font-size:7px}.source-cards h4{margin:0;color:#b6d1d9;font-size:9px}.source-cards p{margin:0;color:#6f8d9c;font-size:8px;line-height:1.45}.source-cards article>div{display:flex;justify-content:space-between;gap:5px}.source-cards article>div small,.source-cards article>div b{font-size:7px}.source-cards article>div small{color:#557d90}.source-cards article>div b{overflow:hidden;color:#84acb8;text-align:right;text-overflow:ellipsis}.source-findings{display:grid;gap:4px;margin-top:8px;padding:8px;border-radius:5px;font-size:8px}.source-findings.blocker{color:#eca0a8;background:#2d1720}.source-findings.warning{color:#e7c189;background:#30251a}.source-discovery details{margin-top:8px;color:#7699a8;font-size:8px}.source-discovery details ul{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:7px 0 0;padding-left:18px}@media(max-width:1300px){.source-cards{grid-template-columns:1fr 1fr}}
.schema-discovery-summary{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0;padding:9px;border:1px solid #386071;border-radius:6px;background:#0d2735}.schema-discovery-summary>div{display:grid;flex-basis:100%;gap:3px}.schema-discovery-summary>div b{color:#77d6c4;font-size:9px}.schema-discovery-summary>div span{color:#789aaa;font-size:8px}.schema-discovery-summary>span{padding:4px 6px;border-radius:4px;color:#9bc3cc;background:#123444;font-size:7px}.schema-discovery-summary>small{flex-basis:100%;color:#e5b27d;font-size:8px}
.edit-diff-summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:9px;padding:7px;border:1px solid #2b5263;border-radius:5px;background:#0b2230}.edit-diff-summary b{margin-right:auto;color:#77cfc1;font-size:8px}.edit-diff-summary span{padding:3px 5px;border-radius:3px;color:#86aebb;background:#123141;font-size:7px}.schema-editor{margin-top:10px;padding:11px;border:1px solid #397084;border-radius:7px;background:#071925}.schema-editor>header,.relationship-editor>header,.schema-object-card>header,.schema-editor>footer{display:flex;align-items:center;justify-content:space-between;gap:8px}.schema-editor>header>div{display:grid;gap:2px}.schema-editor>header span{color:#5ebdc3;font-size:7px;letter-spacing:.1em}.schema-editor>header b{color:#c5dee5;font-size:10px}.schema-editor button{border:1px solid #315d70;border-radius:4px;padding:5px 7px;color:#8dc7d0;background:#0d2b3a;font-size:8px}.schema-editor button:disabled{cursor:not-allowed;opacity:.45}.schema-editor>p{margin:8px 0;color:#6f92a2;font-size:8px;line-height:1.5}.proposal-graph{margin-bottom:9px;border:1px solid #2b5364;border-radius:7px;overflow:hidden;background:#061722}.proposal-graph>header{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #234756;background:#0b2634}.proposal-graph>header>div{display:grid;gap:2px}.proposal-graph>header>div:last-child{text-align:right}.proposal-graph>header b{color:#9bd4d8;font-size:9px}.proposal-graph>header span{color:#618796;font-size:7px}.proposal-graph svg{display:block;width:100%;min-height:200px}.proposal-graph line{stroke:#2f7180;stroke-width:1.5;marker-end:context-stroke}.proposal-graph .edge-label{fill:#638c99;font-size:7px}.proposal-graph-node{cursor:pointer;outline:none}.proposal-graph-node rect{fill:#0d2b39;stroke:#356678;stroke-width:1.2}.proposal-graph-node.selected rect{fill:#123d4b;stroke:#59d4bd;stroke-width:2}.proposal-graph-node.warning rect{stroke:#d29b58}.proposal-graph-node .node-label{fill:#cae3e7;font-size:10px;font-weight:700}.proposal-graph-node .node-meta{fill:#7197a4;font-size:7px}.proposal-graph-node .node-mapping{fill:#59cbb4;font-size:7px}.proposal-graph-node.warning .node-mapping{fill:#e1aa69}.schema-object-list{display:grid;gap:8px}.schema-object-card{padding:9px;border:1px solid #294b5b;border-radius:6px;background:#0a202d}.schema-object-card>header>div{display:flex;align-items:center;gap:7px}.schema-object-card code{color:#63d4bc;font-size:9px}.schema-object-card>header input{width:180px;border:0;border-bottom:1px solid #31596a;padding:3px;color:#c2dae1;background:transparent;font-size:9px}.schema-object-card>header button{border-color:#68434b;color:#d9929b;background:#2a1820}.object-meta-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0}.object-meta-grid label{display:grid;gap:3px;color:#648898;font-size:7px}.object-meta-grid input,.object-meta-grid select,.field-table input,.field-table select,.relationship-editor input,.relationship-editor select{min-width:0;border:1px solid #2b5061;border-radius:3px;padding:5px;color:#aecdd6;background:#0b2735;font-size:8px}.object-meta-grid input:disabled{color:#668795;background:#081b27}.field-table{display:grid;gap:3px;overflow-x:auto}.field-table>header,.field-table>div{display:grid;grid-template-columns:26px 38px minmax(88px,1.2fr) minmax(65px,.8fr) minmax(88px,1.2fr) 82px 38px 24px;align-items:center;gap:5px;min-width:700px}.field-table>header{padding:4px 0;color:#668b9b;font-size:7px}.field-table>header b{color:#8fc3ce}.field-table>div{padding:3px 0;border-top:1px solid #183746}.mapping-dot{justify-self:center;width:7px;height:7px;border-radius:50%;background:#4f7180}.mapping-dot.mapped,.mapping-dot.manual,.mapping-dot.derived{background:#51cbb0;box-shadow:0 0 0 3px #1c5147}.mapping-dot.pending{background:#df9c55;box-shadow:0 0 0 3px #55391f}.mapping-dot.ignored{background:#70818a}.field-table input[type=radio],.field-table input[type=checkbox]{justify-self:center;width:13px;height:13px;accent-color:#54cbb0}.field-table>div button{padding:2px 5px}.field-table>button{justify-self:start;margin-top:4px}.relationship-editor{margin-top:10px;padding-top:9px;border-top:1px solid #244656}.relationship-editor>header b{color:#91c5cf;font-size:9px}.relationship-editor>div{display:grid;grid-template-columns:1fr 1fr 1fr 70px 26px;gap:5px;margin-top:5px}.relationship-editor>div button{padding:2px}.impact-analysis{margin-top:10px;padding:9px;border:1px solid #2b5364;border-radius:6px;background:#0a202d}.impact-analysis>header{display:flex;align-items:center;justify-content:space-between}.impact-analysis>header>div{display:grid;gap:2px}.impact-analysis>header span{color:#5cbec3;font-size:7px;letter-spacing:.08em}.impact-analysis>header b{color:#bad7dd;font-size:9px}.impact-analysis>header strong{padding:4px 6px;border-radius:4px;color:#78d6bd;background:#123a35;font-size:8px}.impact-analysis.medium>header strong{color:#e4b775;background:#3d2c1c}.impact-analysis.high>header strong{color:#eb909a;background:#431d24}.impact-analysis>div{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}.impact-analysis>div span{padding:4px 6px;border-radius:3px;color:#83aebb;background:#123141;font-size:7px}.impact-analysis ul{margin:0 0 6px;padding-left:18px;color:#87a5b0;font-size:8px;line-height:1.6}.impact-analysis>small{color:#5e8291;font-size:7px}.schema-editor>footer{margin-top:10px;padding-top:8px;border-top:1px solid #244656}.schema-editor>footer span{color:#6d91a0;font-size:8px}.schema-editor>footer span.dirty{color:#edbc7e}.schema-editor>footer>button{border-color:#45a98f;color:#08251e;background:#55cdae;font-weight:700}@media(max-width:1300px){.object-meta-grid{grid-template-columns:1fr 1fr}.relationship-editor>div{grid-template-columns:1fr 1fr 1fr 58px 24px}}
.proposal-graph-node.validationFailed rect{stroke:#e36f7c;stroke-width:2}.mapping-validation{margin-top:10px;padding:10px;border:1px solid #315c6e;border-radius:7px;background:#081d29}.mapping-validation.failed{border-color:#7b4650}.mapping-validation>header,.mapping-validation-detail>header{display:flex;align-items:center;justify-content:space-between;gap:10px}.mapping-validation>header>div{display:grid;gap:2px}.mapping-validation>header span{color:#5fc2c8;font-size:7px;letter-spacing:.09em}.mapping-validation>header b{color:#c5dfe5;font-size:9px}.mapping-validation>header small{color:#5f8291;font-size:7px}.mapping-validation>header strong{padding:4px 6px;border-radius:4px;color:#76d7bd;background:#123a35;font-size:8px}.mapping-validation.failed>header strong{color:#ee929b;background:#421e25}.mapping-validation.partially_verified>header strong{color:#e6bb79;background:#3c2c1d}.mapping-validation-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:9px 0}.mapping-validation-metrics span{display:grid;gap:2px;padding:7px;border:1px solid #244654;border-radius:5px;color:#688c9b;background:#0b2633;font-size:7px}.mapping-validation-metrics b{color:#73d5c3;font-size:12px}.mapping-validation-objects{display:flex;flex-wrap:wrap;gap:5px}.mapping-validation-objects button{display:grid;gap:2px;padding:6px 8px;text-align:left}.mapping-validation-objects button.active{border-color:#5ecdb7;background:#123b40}.mapping-validation-objects button.failed{border-color:#74434c}.mapping-validation-objects b{color:#a8cad2;font-size:8px}.mapping-validation-objects span{color:#608695;font-size:7px}.mapping-validation-detail{margin-top:8px;padding:8px;border:1px solid #244754;border-radius:5px;background:#061721}.mapping-validation-detail>header b{color:#9fd2d8;font-size:9px}.mapping-validation-detail>header span,.mapping-validation-detail>header small{color:#618595;font-size:7px}.mapping-validation-issues{display:grid;gap:5px;margin-top:7px}.mapping-validation-issues p{display:grid;grid-template-columns:105px 1fr;gap:3px 7px;margin:0;padding:6px;border-radius:4px;background:#2f2419}.mapping-validation-issues p.error{background:#301920}.mapping-validation-issues b{color:#e5b479;font-size:8px}.mapping-validation-issues p.error b{color:#eb929b}.mapping-validation-issues span{color:#b8c9cd;font-size:8px}.mapping-validation-issues small{grid-column:2;color:#718e99;font-size:7px}.canonical-preview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:8px}.canonical-preview article{padding:7px;border:1px solid #244653;border-radius:5px;background:#0a2430}.canonical-preview article>header{display:grid;gap:2px;margin-bottom:5px}.canonical-preview article>header b{overflow:hidden;color:#75d5c0;font-size:8px;text-overflow:ellipsis}.canonical-preview article>header span{color:#557c8c;font-size:7px}.canonical-preview article>div{display:grid;grid-template-columns:42% 58%;gap:4px;padding:3px 0;border-top:1px solid #183642}.canonical-preview article>div span{overflow:hidden;color:#6d92a0;font-size:7px;text-overflow:ellipsis}.canonical-preview code{overflow:hidden;color:#b9d0d6;font-size:7px;text-overflow:ellipsis;white-space:nowrap}.mapping-no-sample{margin:8px 0 0;color:#d7ac75;font-size:8px}.mapping-policy{display:block;margin-top:8px;color:#597e8d;font-size:7px;line-height:1.5}@media(max-width:1300px){.canonical-preview{grid-template-columns:1fr 1fr}}
.agent-task-workspace{height:clamp(420px,calc(100dvh - 300px),1100px)}
@media(min-width:2200px) and (min-height:1700px){.agent-task-workspace{height:clamp(1100px,calc(100dvh - 300px),1700px)}}
@media(max-width:1300px){.agent-task-workspace{height:clamp(360px,calc(100dvh - 300px),820px)}}
@media(max-width:1100px){.agent-task-workspace{height:clamp(320px,calc(100dvh - 370px),700px);grid-template-columns:190px minmax(0,1fr)}}
@media(max-width:760px){.agent-task-workspace{grid-template-columns:1fr;height:auto;min-height:560px}.task-history{max-height:190px;border-right:0;border-bottom:1px solid #274353}.task-conversation{min-height:430px}.task-status-result{grid-template-columns:1fr 1fr}.task-model-diff{grid-template-columns:1fr}.source-cards{grid-template-columns:1fr}.canonical-preview{grid-template-columns:1fr}}
@media(max-height:800px) and (min-width:1181px){.agent-task-workspace{height:clamp(380px,calc(100dvh - 220px),620px)}.task-transcript{padding:12px}.task-input-dock{padding:7px 12px 10px}.task-composer textarea{min-height:44px}}
@media(max-height:800px) and (max-width:1180px){.agent-task-workspace{height:clamp(300px,calc(100dvh - 390px),460px)}.task-transcript{padding:12px}.task-input-dock{padding:7px 12px 10px}.task-composer textarea{min-height:44px}}
.task-filters{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:9px}.task-filters input,.task-filters select,.task-filters button{min-width:0;border:1px solid #294d60;border-radius:4px;padding:6px;color:#a9c7d0;background:#0a2230;font-size:8px}.task-filters label{display:flex;align-items:center;gap:4px;color:#7898a7;font-size:8px}.task-filters label input{width:auto}.task-archive{margin-top:8px;border:1px solid #31586b;border-radius:5px;padding:6px 9px;color:#7e9eac;background:#0a2230;font-size:8px}
.task-proposal>summary{cursor:pointer;margin:-3px 0 10px;padding:7px;border-bottom:1px solid #244656;color:#76cfc4;font-size:9px;list-style-position:inside}
.semantic-review-workarea{grid-column:1/-1;display:grid;gap:10px;padding:14px 16px;border:1px solid #745d32;border-radius:10px;background:linear-gradient(110deg,#292315,#10242a)}.semantic-review-workarea>header{display:flex;justify-content:space-between;align-items:center;gap:14px}.semantic-review-workarea>header span{color:#e4bb68;font-size:8px;letter-spacing:.12em}.semantic-review-workarea>header h2{margin:3px 0;color:#f2e7ca;font-size:15px}.semantic-review-workarea>header p{margin:0;color:#b8a779;font-size:9px}.semantic-review-workarea>header>b{padding:7px 10px;border:1px solid #826833;border-radius:999px;color:#f0cf82;background:#352b19;font-size:10px;white-space:nowrap}.semantic-review-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:8px}.semantic-review-cards article{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px;border:1px solid #574a2e;border-radius:7px;background:#171f20}.semantic-review-cards article>div{min-width:0}.semantic-review-cards article b{display:block;overflow:hidden;color:#e7e1c9;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.semantic-review-cards article small{display:block;margin-top:4px;color:#b6a875;font-size:8px}.semantic-review-cards article p{overflow:hidden;margin:5px 0 0;color:#a8c5c7;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.semantic-review-cards button{flex:0 0 auto;border:1px solid #4d8c7a;border-radius:5px;padding:7px 9px;color:#d7f5e8;background:#153c35;font-size:9px;cursor:pointer}.semantic-review-cards button:hover{border-color:#79d7b7;background:#1d5145}.semantic-review-empty{margin:0;padding:8px 10px;border:1px dashed #62583e;border-radius:6px;color:#c0b58e;font-size:9px}
.agent-task-workspace{grid-template-rows:auto minmax(0,1fr)}
@media(max-width:760px){.agent-task-workspace{grid-template-rows:auto auto minmax(430px,1fr)}}
.agent-task-workspace{min-height:0;overflow:hidden}
.task-history{display:grid;grid-template-rows:auto auto minmax(0,1fr);height:100%;min-height:0;padding:0;overflow:hidden;background:#081925}
.task-history>header{position:static;margin:0;padding:12px;border-bottom:1px solid #183443;background:#081925}
.task-filters{margin:0;padding:8px 10px;border-bottom:1px solid #183443;background:#081925}
.task-history-list{min-height:0;overflow-y:auto;padding:8px 10px 12px;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-color:#31586b #081925;scrollbar-width:thin;background:#081925}
.task-history-list::-webkit-scrollbar{width:8px}.task-history-list::-webkit-scrollbar-thumb{border:2px solid #081925;border-radius:8px;background:#31586b}
.task-history-list .task-history-item{margin-bottom:6px}
.task-history-list>p{margin:12px 4px}.task-history-list>p.task-list-status{padding:7px 4px;text-align:center}
.task-conversation{min-height:0}.task-transcript{min-height:0}.task-input-dock{flex:none}
@media(max-width:760px){.agent-task-workspace{height:auto;min-height:610px;grid-template-rows:auto 180px minmax(430px,1fr)}.task-history{height:180px;max-height:none;min-height:0;border-right:0;border-bottom:1px solid #274353}.task-history-list{padding-block:6px}.task-conversation{min-height:430px}}
</style>

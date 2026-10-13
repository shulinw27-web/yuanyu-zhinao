<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
const props = defineProps({ client: { type: Object, required: true }, modelId: { type: String, required: true }, taskId: { type: String, required: true }, canReview: { type: Boolean, default: false }, canSimulate: { type: Boolean, default: false } });
const emit = defineEmits(['applied']);
const review = ref(null); const busy = ref(false); const error = ref(''); const notice = ref(''); const token = ref(null);
const acknowledge = ref(false); const executeAcknowledged = ref(false); const recoverAcknowledged = ref(false); const simulateAcknowledged = ref(false);
const confirmationPending = ref(false); const adopted = ref(false); const simulation = ref(null); const selectedObject = ref('');
let generation = 0;
const selected = computed(() => review.value?.graph.nodes.find(node => node.id === selectedObject.value));
const points = computed(() => new Map((review.value?.graph.nodes || []).map((node, i) => [node.id, { x: 20 + (i % 3) * 310, y: 20 + Math.floor(i / 3) * 140 }])));
const graphHeight = computed(() => Math.max(160, Math.ceil((review.value?.graph.nodes.length || 0) / 3) * 140 + 20));
const edgePath = (edge, index = 0) => { const from = points.value.get(edge.from); const to = points.value.get(edge.to); const lane = Math.max(from?.y || 0, to?.y || 0) + 85 + index % 5 * 8;
  return from && to ? `M ${from.x + 140} ${from.y + 70} V ${lane} H ${to.x + 140} V ${to.y + 70}` : ''; };
const label = value => ({ added: '新增', updated: '更新', removed: '移除', unchanged: '不变', passed: '通过', failed: '失败', unverified: '待验证', partially_verified: '部分验证', mapped: '已映射', manual: '人工映射', pending: '待映射', derived: '派生', ignored: '明确忽略' }[value] || value);
function clear() { review.value = null; token.value = null; busy.value = false; acknowledge.value = false; executeAcknowledged.value = false; recoverAcknowledged.value = false; simulateAcknowledged.value = false; confirmationPending.value = false; adopted.value = false; simulation.value = null; selectedObject.value = ''; error.value = ''; notice.value = ''; }
function valid(result) {
  return result?.modelId === props.modelId && result.taskId === props.taskId && result.contentScope === 'owned_candidate_structure_only' && result.executionEnabled === false && result.runtimeReadEnabled === false
    && /^[a-f0-9]{24}$/u.test(result.taskFingerprint || '') && /^[a-f0-9]{24}$/u.test(result.draftFingerprint || '') && typeof result.proposalId === 'string' && Number.isSafeInteger(result.proposalRevision)
    && ['merge', 'replace'].includes(result.adoptionMode) && Array.isArray(result.graph?.nodes) && result.graph.nodes.length <= 200 && Array.isArray(result.graph.edges) && result.graph.edges.length <= 200
    && result.graph.nodes.every(node => typeof node.id === 'string' && typeof node.label === 'string' && typeof node.key === 'string' && Array.isArray(node.sourceSystems) && Array.isArray(node.fields) && node.fields.length <= 100 && node.fields.every(field => typeof field.name === 'string' && typeof field.type === 'string'))
    && new Set(result.graph.nodes.map(node => node.id)).size === result.graph.nodes.length && result.graph.edges.every(edge => typeof edge.predicate === 'string' && result.graph.nodes.some(node => node.id === edge.from) && result.graph.nodes.some(node => node.id === edge.to))
    && Array.isArray(result.diff?.objectChanges) && Array.isArray(result.diff.relationshipChanges) && typeof result.checks?.mappingBlocked === 'boolean';
}
async function action(kind) {
  if (busy.value || !props.canReview || !props.modelId || !props.taskId || !['review', 'confirm', 'execute', 'recover', 'simulate'].includes(kind)) return;
  if (kind === 'confirm' && (!review.value || !acknowledge.value || token.value || confirmationPending.value || review.value.checks.criticStatus !== 'passed' || review.value.checks.mappingBlocked)) return;
  if (kind === 'execute' && (!token.value || !executeAcknowledged.value)) return;
  if (kind === 'recover' && (!confirmationPending.value || !recoverAcknowledged.value)) return;
  if (kind === 'simulate' && (!adopted.value || !props.canSimulate || !simulateAcknowledged.value)) return;
  const request = generation; const model = props.modelId; const task = props.taskId;
  const current = () => request === generation && props.canReview && props.modelId === model && props.taskId === task;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    if (kind === 'review') {
      token.value = null; acknowledge.value = false; executeAcknowledged.value = false; review.value = null;
      const result = await props.client.reviewAdoptionTask(model, task); if (!current()) return;
      if (!valid(result)) throw new Error('REVIEW_RESPONSE_MISMATCH');
      review.value = result; selectedObject.value = result.graph.nodes[0]?.id || '';
      confirmationPending.value = result.confirmationEvidenceState === 'pending';
      notice.value = '已复验当前版本，请核对对象、来源、字段、关系和差异；尚未签发或采纳。';
    } else if (kind === 'confirm') {
      acknowledge.value = false; token.value = null; const before = review.value;
      const result = await props.client.confirmAdoptionTask(model, task, { confirmed: true, expectedTaskFingerprint: before.taskFingerprint }); if (!current()) return;
      if (result.modelId !== model || result.task?.id !== task || result.task.modelId !== model || result.task.structuredAdoptionTask !== true || result.confirmationEvidenceState !== 'ready' || result.executionEnabled !== false
        || !/^[a-f0-9]{24}$/u.test(result.taskFingerprint || '') || !/^[A-Za-z0-9_-]{43}$/u.test(result.confirmationToken || '') || !(Date.parse(result.expiresAt) > Date.now())) throw new Error('CONFIRM_RESPONSE_MISMATCH');
      token.value = { value: result.confirmationToken, fingerprint: result.taskFingerprint, expiresAt: result.expiresAt, proposalId: before.proposalId, proposalRevision: before.proposalRevision, draftFingerprint: before.draftFingerprint };
      notice.value = '确认凭证仅在本页内存中，还没有采纳。采纳前将再次复验图和版本。';
    } else if (kind === 'execute') {
      const ticket = token.value; token.value = null; executeAcknowledged.value = false;
      if (Date.parse(ticket.expiresAt) <= Date.now()) throw new Error('TOKEN_EXPIRED');
      const refreshed = await props.client.reviewAdoptionTask(model, task); if (!current()) return;
      if (!valid(refreshed) || refreshed.taskFingerprint !== ticket.fingerprint || refreshed.proposalId !== ticket.proposalId || refreshed.proposalRevision !== ticket.proposalRevision || refreshed.draftFingerprint !== ticket.draftFingerprint) throw new Error('REVIEW_CHANGED');
      review.value = refreshed;
      const result = await props.client.executeAdoptionTask(model, task, { confirmed: true, expectedTaskFingerprint: ticket.fingerprint, confirmationToken: ticket.value }); if (!current()) return;
      if (result.modelId !== model || result.task?.id !== task || result.task.modelId !== model || result.task.status !== 'completed' || result.task.structuredAdoptionTask !== true || result.executedCommand !== 'apply_proposal' || result.runtimeReadEnabled !== false) throw new Error('EXECUTE_RESPONSE_MISMATCH');
      adopted.value = true; review.value = null; notice.value = '已采纳到当前模型草稿并归档任务；未模拟、发布或写上游。';
      emit('applied', { modelId: model, task: result.task });
    } else if (kind === 'recover') {
      token.value = null; recoverAcknowledged.value = false;
      const result = await props.client.recoverAdoptionConfirmationEvidence(model, task, { confirmed: true }); if (!current()) return;
      if (result.modelId !== model || result.taskId !== task || result.confirmationEvidenceState !== 'ready' || result.confirmationTokenReturned !== false || result.executionEnabled !== false) throw new Error('RECOVERY_RESPONSE_MISMATCH');
      confirmationPending.value = false; review.value = null; notice.value = '既有确认证据已核验，没有重新签发；请重新审阅当前版本并明确确认。';
    } else {
      simulateAcknowledged.value = false; simulation.value = null;
      const draft = await props.client.modelDraft(model); if (!current() || !props.canSimulate) return;
      if (draft.modelId !== model || !/^[a-f0-9]{24}$/u.test(draft.draft?.fingerprint || '')) throw new Error('DRAFT_MISMATCH');
      const result = await props.client.simulateModelDraft(model, { confirmed: true, expectedFingerprint: draft.draft.fingerprint }); if (!current() || !props.canSimulate) return;
      if (result.modelId !== model || result.runtimeReadEnabled !== false || result.simulation?.verifiesLiveSystems !== false || result.simulation.sourceFingerprint !== draft.draft.fingerprint) throw new Error('SIMULATION_MISMATCH');
      simulation.value = { status: result.simulation.status, nodeCount: result.simulation.nodeCount, relationshipCount: result.simulation.relationshipCount };
      notice.value = '本地合成模拟完成，不是生产业务读取或自动发布。';
    }
  } catch (failure) {
    if (current()) {
      token.value = null; review.value = null; acknowledge.value = false; executeAcknowledged.value = false; simulation.value = null;
      confirmationPending.value = kind === 'recover' || failure.payload?.evidencePending === true;
      error.value = failure.payload?.taskMayHaveCommitted || failure.payload?.workspaceWriteMayHaveCommitted
        ? '操作可能已提交；旧凭证已清除，不自动重试。请核对原任务和当前草稿，证据pending时单独恢复。'
        : '当前版本、权限、引用或凭证未通过复验；旧内容和凭证已清除，不自动重试。';
    }
  } finally { if (request === generation) busy.value = false; }
}
watch(() => [props.client, props.modelId, props.taskId, props.canReview, props.canSimulate], () => { generation++; clear(); });
onBeforeUnmount(() => { generation++; clear(); });
</script>

<template>
  <section v-if="canReview" class="adoption-review" aria-label="当前模型候选审阅与采纳">
    <h3>先看模型，再确认采纳</h3><p>这里只审核自己的结构化候选。确认、采纳和本地合成模拟分开操作，不自动发布或写入源系统。</p>
    <button type="button" :disabled="busy || adopted" @click="action('review')">读取当前模型图与差异（清除旧凭证）</button>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="review">
      <p>提案修订 {{ review.proposalRevision }} · {{ review.adoptionMode === 'replace' ? '替换草稿（包含移除）' : '合并草稿' }} · 结构 {{ label(review.checks.criticStatus) }} · 映射 {{ label(review.checks.mappingStatus) }}</p>
      <p>点击对象查看字段；窄屏可在图内横向滚动。箭头表示已声明的关系，完整关联与来源字段见下方列表。</p>
      <div class="graph-viewport"><svg :viewBox="`0 0 960 ${graphHeight}`" width="960" :height="graphHeight" role="img" aria-label="当前候选对象与关系，选择对象查看字段">
        <defs><marker id="adoption-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#57d5c5" /></marker></defs>
        <path v-for="(edge, i) in review.graph.edges" :key="i" :d="edgePath(edge, i)" fill="none" stroke="#538da0" stroke-width="2" marker-end="url(#adoption-arrow)"><title>{{ edge.from }} → {{ edge.to }} · {{ edge.predicate }}</title></path>
        <g v-for="node in review.graph.nodes" :key="node.id" :transform="`translate(${points.get(node.id).x},${points.get(node.id).y})`" role="button" tabindex="0" :aria-label="`查看${node.label}字段`" @click="selectedObject = node.id" @keydown.enter="selectedObject = node.id" @keydown.space.prevent="selectedObject = node.id">
          <title>{{ node.label }} · {{ node.id }}</title><rect width="280" height="70" rx="8" :fill="selectedObject === node.id ? '#154451' : '#102f40'" stroke="#57d5c5" /><text x="12" y="26" fill="#d6edf6">{{ node.label.slice(0, 18) }}</text><text x="12" y="51" fill="#9db8c8">{{ node.id.slice(0, 26) }} · {{ node.kind === 'candidate' ? '候选' : '已有引用' }}</text>
        </g>
      </svg></div>
      <div class="review-details">
        <section v-if="selected"><h4>{{ selected.label }} · {{ selected.id }}</h4><p>来源：{{ selected.sourceSystems.join('、') }} · 主键：{{ selected.key }}</p><ul><li v-for="field in selected.fields" :key="field.name">{{ field.name }} · {{ field.type }} · 源字段 {{ field.sourceField || '未映射' }} · {{ label(field.mappingStatus) }}{{ field.primaryKey ? ' · 主键' : '' }}{{ field.required ? ' · 必填' : '' }}</li></ul></section>
        <section><h4>结构差异</h4><ul><li v-for="item in review.diff.objectChanges" :key="item.id">{{ item.id }}：{{ label(item.change) }}</li></ul><h4>关联关系与差异</h4><ul><li v-for="(edge, i) in review.diff.relationshipChanges" :key="i">{{ edge.from }}{{ edge.sourceField ? `.${edge.sourceField}` : '' }} → {{ edge.to }}{{ edge.targetField ? `.${edge.targetField}` : '' }} · {{ edge.predicate }} · {{ edge.cardinality || '未标记基数' }} · {{ label(edge.change) }}</li></ul></section>
      </div>
      <label><input v-model="acknowledge" type="checkbox" :disabled="busy || !!token || confirmationPending">我已核对当前模型图、来源、字段、关系及差异；只签发确认凭证，不采纳</label>
      <button type="button" :disabled="busy || !acknowledge || !!token || confirmationPending || review.checks.criticStatus !== 'passed' || review.checks.mappingBlocked" @click="action('confirm')">确认当前候选</button>
    </template>
    <template v-if="token"><label><input v-model="executeAcknowledged" type="checkbox" :disabled="busy">我确认仅采纳到本系统草稿，不发布或写上游</label><button type="button" :disabled="busy || !executeAcknowledged" @click="action('execute')">复验版本并采纳</button></template>
    <template v-if="confirmationPending"><label><input v-model="recoverAcknowledged" type="checkbox" :disabled="busy">仅核验原确认证据，不重签或执行</label><button type="button" :disabled="busy || !recoverAcknowledged" @click="action('recover')">恢复既有确认证据</button></template>
    <template v-if="adopted && canSimulate"><label><input v-model="simulateAcknowledged" type="checkbox" :disabled="busy">我确认模拟当前模型草稿，仅使用本地合成数据</label><button type="button" :disabled="busy || !simulateAcknowledged" @click="action('simulate')">明确运行本地模拟</button></template>
    <p v-if="simulation">模拟状态：{{ label(simulation.status) }} · {{ simulation.nodeCount }}节点 · {{ simulation.relationshipCount }}关系</p>
  </section>
</template>

<style scoped>
.adoption-review { padding: 16px; margin-bottom: 14px; border: 1px solid #3c687b; border-radius: 10px; background: #0a202d; } .adoption-review p { line-height: 1.6; overflow-wrap: anywhere; } h3,h4 { margin: 8px 0; }
button { padding: 10px 14px; border: 1px solid #3c687b; border-radius: 8px; background: #102f40; color: #d6edf6; cursor: pointer; } button:disabled { opacity: .6; cursor: not-allowed; } button:focus-visible, g:focus-visible { outline: 2px solid #57d5c5; outline-offset: 2px; }
label { display: flex; align-items: flex-start; gap: 8px; margin: 14px 0; line-height: 1.6; } .graph-viewport { max-height: 460px; overflow: auto; border: 1px solid #2b5263; margin: 14px 0; } g { cursor: pointer; }
.review-details { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; } .review-details section { min-width: 0; max-height: 320px; overflow: auto; overflow-wrap: anywhere; padding: 10px; border: 1px solid #2b5263; border-radius: 8px; } li { margin: 6px 0; } @media(max-width:760px) { .review-details { grid-template-columns: 1fr; } }
</style>

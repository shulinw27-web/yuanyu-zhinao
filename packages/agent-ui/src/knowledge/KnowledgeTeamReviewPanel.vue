<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue';
const props = defineProps({ client: Object, evidence: { type: Array, default: () => [] }, canReview: Boolean, canWrite: Boolean });
const rows = ref([]); const selected = ref(null); const choices = ref([]); const offset = ref(0); const hasMore = ref(false); const busy = ref(false); const error = ref('');
const showHistory = ref(false);
const reviewNote = ref('');
const reviewers = ref([]); const reviewerChoice = ref('');
let generation = 0;
const eligible = computed(() => props.evidence.filter(item => item.citation?.provider === 'weknora_local'));
const writable = computed(() => props.canReview && props.canWrite);
const labels = { pending: '待审核', approved: '已核对', rejected: '需修正', withdrawn: '已撤回' };
const failures = { KNOWLEDGE_REVIEW_SOURCE_UNAVAILABLE: '资料已变化、不可读或来源暂不可用，请重新检索。', KNOWLEDGE_REVISION_CONFLICT: '审核记录已更新，请刷新后重新核对。', KNOWLEDGE_REVIEW_ALREADY_PENDING: '这些资料已有待审核记录。', KNOWLEDGE_REVIEW_SEPARATION_REQUIRED: '提交人不能自审，也不能撤回他人的提交。', KNOWLEDGE_REVIEW_LIMIT: '审核记录已达100条保留上限。' };
const message = e => failures[e?.code || e?.error] || '操作失败，请核对当前权限和资料后重试。';
async function fetchRows(ticket) {
  const result = await (showHistory.value ? props.client.materialReviewHistory : props.client.materialReviews)(offset.value);
  if (ticket !== generation || !props.canReview) return;
  if (result.error) throw result;
  rows.value = result.reviews || []; hasMore.value = result.hasMore === true;
}
async function refresh(nextOffset = 0) {
  const ticket = ++generation; rows.value = []; selected.value = null; reviewers.value = []; reviewerChoice.value = ''; hasMore.value = false; offset.value = nextOffset; error.value = ''; busy.value = false;
  if (!props.canReview || !props.client?.materialReviews) return;
  busy.value = true;
  try { await fetchRows(ticket); } catch (e) { if (ticket === generation) error.value = message(e); }
  finally { if (ticket === generation) busy.value = false; }
}
async function open(row) {
  if (!props.canReview || busy.value) return;
  const ticket = ++generation; selected.value = null; reviewNote.value = ''; busy.value = true; error.value = '';
  try {
    const result = await props.client.materialReview(row.id); if (result.error) throw result;
    if (ticket !== generation || !props.canReview) return;
    selected.value = result;
    reviewers.value = []; reviewerChoice.value = '';
    if (writable.value && result.review?.canAssign && props.client.materialReviewers) {
      const directory = await props.client.materialReviewers(); if (directory.error) throw directory;
      if (ticket === generation && writable.value) reviewers.value = directory.reviewers || [];
    }
  }
  catch (e) { if (ticket === generation) error.value = message(e); }
  finally { if (ticket === generation) busy.value = false; }
}
async function submit() {
  if (!writable.value || busy.value || showHistory.value || !choices.value.length || choices.value.length > 3) return;
  const citations = choices.value.map(index => eligible.value[index]?.citation);
  if (citations.some(c => !c)) return;
  const ticket = ++generation; busy.value = true; error.value = '';
  try { const result = await props.client.submitMaterialReview(citations); if (result.error) throw result; if (ticket !== generation || !writable.value) return; choices.value = []; offset.value = 0; selected.value = null; await fetchRows(ticket); }
  catch (e) { if (ticket === generation) error.value = message(e); }
  finally { if (ticket === generation) busy.value = false; }
}
async function decide(decision) {
  const review = selected.value?.review;
  if (!writable.value || busy.value || review?.status !== 'pending' || !['approved', 'rejected', 'withdrawn'].includes(decision)
    || reviewNote.value.length > 1000 || (decision === 'withdrawn' ? !review.owned : review.owned || review.canDecide === false)) return;
  const ticket = ++generation; busy.value = true; error.value = '';
  try { const result = await props.client.decideMaterialReview(review.id, review.revision, decision, ...(reviewNote.value.trim() ? [reviewNote.value.trim()] : [])); if (result.error) throw result; if (ticket !== generation || !writable.value) return; selected.value = null; reviewNote.value = ''; await fetchRows(ticket); }
  catch (e) { if (ticket === generation) error.value = message(e); }
  finally { if (ticket === generation) busy.value = false; }
}
async function assign(returnToPool = false) {
  const review = selected.value?.review;
  if (!writable.value || busy.value || review?.status !== 'pending' || !review.canAssign || !props.client.assignMaterialReview || !returnToPool && !reviewerChoice.value) return;
  const ticket = ++generation; busy.value = true; error.value = '';
  try {
    const result = await props.client.assignMaterialReview(review.id, review.revision, returnToPool ? null : reviewerChoice.value); if (result.error) throw result;
    if (ticket !== generation || !writable.value) return;
    selected.value = null; reviewers.value = []; reviewerChoice.value = ''; reviewNote.value = ''; await fetchRows(ticket);
  } catch (e) { if (ticket === generation) error.value = message(e); }
  finally { if (ticket === generation) busy.value = false; }
}
async function archive() {
  const review = selected.value?.review;
  if (!writable.value || busy.value || !review?.owned || review.status === 'pending' || review.archivedAt || !props.client.archiveMaterialReview) return;
  const ticket = ++generation; busy.value = true; error.value = '';
  try { const result = await props.client.archiveMaterialReview(review.id, review.revision); if (result.error) throw result; if (ticket !== generation || !writable.value) return; selected.value = null; offset.value = 0; await fetchRows(ticket); }
  catch (e) { if (ticket === generation) error.value = message(e); }
  finally { if (ticket === generation) busy.value = false; }
}
watch(showHistory, () => refresh());
watch([() => props.client, () => props.canReview, () => props.canWrite], () => { choices.value = []; reviewNote.value = ''; refresh(); }, { immediate: true });
watch(() => props.evidence, () => { choices.value = []; });
onBeforeUnmount(() => generation++);
</script>

<template>
  <details v-if="canReview && client?.materialReviews" class="knowledge-team-review">
    <summary>企业资料协作核对 <span>{{ rows.length }} 条可读记录</span></summary>
    <p>只核对企业授权资料的结构与适用性。审核不会公开私有资料、授权、发布模型或执行业务；原文始终按当前人员权限回读。</p>
    <fieldset v-if="writable && !showHistory && eligible.length" :disabled="busy">
      <legend>从本次检索结果选择资料，最多3项</legend>
      <label v-for="(item, index) in eligible" :key="index"><input v-model="choices" type="checkbox" :value="index">{{ item.title || '企业资料' }}</label>
      <button type="button" :disabled="!choices.length || choices.length > 3" @click="submit">确认提交协作核对</button>
    </fieldset>
    <p v-else-if="writable && !showHistory">请先检索 WeKnora 企业资料；个人知识库内容不支持提交协作核对。</p>
    <label v-if="client.materialReviewHistory"><input v-model="showHistory" type="checkbox" :disabled="busy">查看保留归档（原文仍须当前来源授权）</label>
    <div class="review-tools"><button type="button" :disabled="busy" @click="refresh(offset)">刷新</button><button type="button" :disabled="busy || offset === 0" @click="refresh(Math.max(0, offset - 10))">上一窗口</button><button type="button" :disabled="busy || !hasMore" @click="refresh(offset + 10)">下一窗口</button></div>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="busy" aria-live="polite">正在核验资料与当前权限…</p>
    <p v-if="!busy && !rows.length">本窗口没有当前可读的审核记录。来源无权、撤回或版本变化的记录不展示。</p>
    <ul><li v-for="row in rows" :key="row.id"><button type="button" :disabled="busy" @click="open(row)">{{ row.titles.join(' / ') }} · {{ labels[row.status] }} · 修订{{ row.revision }}{{ row.owned ? ' · 我提交的' : '' }}</button></li></ul>
    <section v-if="selected" class="review-detail">
      <h4>资料原文 · {{ labels[selected.review.status] }}</h4>
      <article v-for="(source, index) in selected.sources" :key="index"><strong>{{ source.title }}</strong><p class="source-text">{{ source.excerpt }}</p></article>
      <p>“核对通过”只是本次来源修订的人工核对，不等于制度生效、模型发布或资料持续有效。提交人不能自审。</p>
      <p v-if="selected.review.note">人工核对意见：{{ selected.review.note }}</p>
      <p v-if="selected.review.assignment">当前承办人：{{ selected.review.assignment.name }}。仅承办人可作核对决定，提交人仍可撤回；指派不授予来源权限。</p>
      <div v-if="writable && selected.review.status === 'pending' && selected.review.canAssign && client.assignMaterialReview" class="review-tools">
        <label>承办人<select v-model="reviewerChoice" :disabled="busy"><option value="">选择当前有效的审核人员</option><option v-for="person in reviewers" :key="person.subjectId" :value="person.subjectId">{{ person.name }}</option></select></label>
        <button type="button" :disabled="busy || !reviewerChoice" @click="assign()">确认指派 / 转派</button>
        <button v-if="selected.review.assignment" type="button" :disabled="busy" @click="assign(true)">确认退回审核池</button>
      </div>
      <label v-if="writable && selected.review.status === 'pending'">核对意见（选填，与本次决定一同保存；不要填写额外敏感信息）<textarea v-model="reviewNote" maxlength="1000" :disabled="busy" rows="3" /></label>
      <p v-if="selected.review.archivedAt">该记录已保留归档，不可恢复为待审核，也不会恢复来源权限。</p>
      <button v-else-if="writable && selected.review.owned && selected.review.status !== 'pending' && client.archiveMaterialReview" type="button" :disabled="busy" @click="archive">确认保留归档（不删除）</button>
      <div v-if="writable && selected.review.status === 'pending'" class="review-tools"><template v-if="!selected.review.owned && selected.review.canDecide !== false"><button type="button" :disabled="busy" @click="decide('approved')">确认核对通过</button><button type="button" :disabled="busy" @click="decide('rejected')">退回修正</button></template><button v-else-if="selected.review.owned" type="button" :disabled="busy" @click="decide('withdrawn')">撤回我的提交</button></div>
    </section>
  </details>
</template>

<style scoped>
textarea,select{border:1px solid #326477;background:#0b202b;color:inherit;border-radius:7px;padding:9px;max-width:100%;font:inherit}textarea{width:100%;resize:vertical}label:has(textarea){display:grid;align-items:start}textarea:focus-visible,select:focus-visible{outline:2px solid #58d9cc;outline-offset:2px}
.knowledge-team-review{border:1px solid var(--agent-border,#285061);border-radius:12px;padding:16px;margin:12px 0;color:inherit}summary{cursor:pointer;font-weight:650}summary span{margin-left:12px;font-size:12px;font-weight:400}p{font-size:13px;line-height:1.7;overflow-wrap:anywhere}fieldset{border:1px solid #285061;border-radius:8px;padding:12px}label{display:flex;align-items:center;gap:8px;margin:8px 0}.review-tools{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}button{border:1px solid #326477;background:#102e3c;color:inherit;border-radius:7px;padding:9px 12px;cursor:pointer;text-align:left;max-width:100%;overflow-wrap:anywhere}button:hover:enabled{background:#1b4352}button:focus-visible{outline:2px solid #58d9cc;outline-offset:2px}button:disabled{opacity:.5;cursor:not-allowed}ul{list-style:none;padding:0;display:grid;gap:8px}.review-detail{border-top:1px solid #285061;margin-top:16px;padding-top:12px}.source-text{white-space:pre-wrap}.review-detail article{padding:10px;border-radius:8px;background:#0b202b;margin:8px 0}
</style>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
const props = defineProps({ client: { type: Object, required: true }, evidence: { type: Array, default: () => [] }, canWrite: Boolean });
const question = ref(''); const roots = ref(''); const confirmed = ref(false); const busy = ref(false); const result = ref(null); const error = ref('');
const plans = ref([]); const model = ref(null); const planId = ref(''); const planLoading = ref(false); const planError = ref('');
let generation = 0;
let planGeneration = 0;
const targets = computed(() => roots.value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean));
const selectedPlan = computed(() => plans.value.find(plan => plan.id === planId.value));
const available = computed(() => props.canWrite && props.evidence.length > 0 && !!selectedPlan.value && !!model.value && !planLoading.value && typeof props.client.jointBrief === 'function');
function reset() { generation++; result.value = null; error.value = ''; confirmed.value = false; busy.value = false; }
watch(() => props.evidence, reset);
watch(() => props.canWrite, reset);
watch([question, roots, planId], () => { result.value = null; confirmed.value = false; });
async function loadPlans() {
  reset(); const ticket = ++planGeneration; plans.value = []; model.value = null; planId.value = ''; planError.value = ''; planLoading.value = false;
  if (!props.canWrite || typeof props.client.jointPlans !== 'function') return;
  planLoading.value = true;
  try {
    const value = await props.client.jointPlans();
    if (ticket !== planGeneration) return;
    plans.value = value.plans; model.value = value.model;
    if (plans.value.length === 1) planId.value = plans.value[0].id;
    if (!value.available || !plans.value.length) planError.value = '当前没有可用的已发布读取方案。请先在语义运营端完成模型发布，并配置元数据与业务对象权限。';
  } catch { if (ticket === planGeneration) planError.value = '读取方案目录不可用；没有读取业务记录。'; }
  finally { if (ticket === planGeneration) planLoading.value = false; }
}
watch(() => props.canWrite, loadPlans, { immediate: true });
onUnmounted(() => { generation++; planGeneration++; });
async function verify() {
  if (busy.value || !available.value || !confirmed.value) return;
  const ticket = ++generation; busy.value = true; result.value = null; error.value = '';
  try {
    const reply = await props.client.jointBrief({ question: question.value, targets: targets.value,
      citations: props.evidence.map(item => item.citation), confirmed: true, planId: planId.value,
      expectedModelFingerprint: model.value.fingerprint, expectedModelVersion: model.value.version });
    if (ticket === generation) result.value = reply;
  } catch (cause) {
    if (ticket !== generation) return;
    error.value = cause.status === 409 ? '模型版本、所选资料或业务快照可能已变化，或读取未完成。请刷新已发布读取方案，并重新检索资料、核对编号后确认；没有返回过期数据。'
      : [401, 403].includes(cause.status) ? '当前身份缺少资料或业务对象读取权限。' : '联合核验未完成，请检查明确编号、来源与连接器状态。';
  } finally { if (ticket === generation) { busy.value = false; confirmed.value = false; } }
}
</script>

<template>
  <details v-if="typeof client.jointBrief === 'function'" class="joint-brief" aria-label="知识与业务联合核验">
    <summary>知识依据＋业务事实 · 只读联合核验</summary>
    <p>使用已发布语义模型查询明确业务编号，和当前选中资料并列核验。不调用大模型，不写业务，不自动判定制度适用性。</p>
    <button type="button" :disabled="busy || planLoading" @click="loadPlans">{{ planLoading ? '读取方案目录中…' : '刷新已发布读取方案' }}</button>
    <p v-if="planError" role="status">{{ planError }}</p>
    <form @submit.prevent="verify">
      <label>已发布读取方案<select v-model="planId" :disabled="busy || planLoading || !plans.length" required><option value="" disabled>请选择本轮读取方案</option><option v-for="plan in plans" :key="plan.id" :value="plan.id">{{ plan.label }} · {{ plan.rootType }}</option></select></label>
      <p v-if="selectedPlan">模型 {{ model.version }} · 根对象类型 {{ selectedPlan.rootType }} · 输出：{{ selectedPlan.outputs.map(item => item.label).join('、') }}。选择方案不代表已获得对象权限。</p>
      <label>核验问题<input v-model="question" :disabled="busy" maxlength="4000" required placeholder="例如：核验这笔订单的影响范围及证据缺口" /></label>
      <label>业务根对象编号（最多3个，逗号分隔）<input v-model="roots" :disabled="busy" maxlength="302" required placeholder="填写已发布读取方案要求的实际编号，不会猜测默认对象" /></label>
      <label><input v-model="confirmed" type="checkbox" :disabled="busy || !available" />确认按当前权限读取上述业务对象及所选资料；不执行处置</label>
      <p v-if="!available">先检索原文依据、选择可用的已发布读取方案，并确保当前账号具有操作权限。企业对象授权仍由服务端逐项检查。</p>
      <button :disabled="busy || !available || !confirmed || !question.trim() || targets.length < 1 || targets.length > 3">{{ busy ? '读取与复验中…' : '开始只读联合核验' }}</button>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
    <section v-if="result" aria-label="联合核验结果">
      <p>本轮方案：{{ result.business.metadata.selectedReadPlan?.label }} · 模型 {{ result.business.metadata.modelVersion }}</p>
      <h3>业务事实与影响范围（来源快照）</h3><pre>{{ result.business.text }}</pre>
      <p>已核验 {{ result.business.recordCount }} 条来源记录；只覆盖声明图，不是全企业实时全量。</p>
      <h3>所选制度/参考资料（不是业务事实）</h3>
      <article v-for="source in result.knowledge.sources" :key="source.citation.chunkId"><h4>{{ source.title }}</h4><pre>{{ source.excerpt }}</pre></article>
      <h3>核验边界</h3><ul><li v-for="boundary in result.boundaries" :key="boundary">{{ boundary }}</li></ul>
      <p>两个来源分别复验，不是跨系统原子事务；没有创建工单、解冻或审批。</p>
    </section>
  </details>
</template>

<style scoped>
.joint-brief { border: 1px solid #496675; border-radius: 12px; padding: 16px; margin-block: 16px; min-width: 0; }
summary { cursor: pointer; font-weight: 600; padding-block: 8px; }
form { display: grid; gap: 12px; } label { display: grid; gap: 6px; min-width: 0; }
label:has(input[type=checkbox]) { display: flex; align-items: start; }
input:not([type=checkbox]), select { box-sizing: border-box; width: 100%; min-height: 40px; padding: 8px; border: 1px solid #496675; border-radius: 6px; color: inherit; background: transparent; }
button { min-height: 42px; padding: 8px 16px; border: 1px solid #496675; border-radius: 8px; color: inherit; background: transparent; cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; } pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
[role=alert] { color: #ffbdac; } :is(input,select,button,summary):focus-visible { outline: 2px solid #64d4c0; outline-offset: 3px; }
</style>

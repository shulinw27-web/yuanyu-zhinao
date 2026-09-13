<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
const props = defineProps({ client: { type: Object, required: true }, evidence: { type: Array, default: () => [] }, canWrite: Boolean });
const question = ref(''); const roots = ref(''); const confirmed = ref(false); const busy = ref(false); const result = ref(null); const error = ref('');
let generation = 0;
const targets = computed(() => roots.value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean));
const available = computed(() => props.canWrite && props.evidence.length > 0 && typeof props.client.jointBrief === 'function');
function reset() { generation++; result.value = null; error.value = ''; confirmed.value = false; busy.value = false; }
watch(() => props.evidence, reset);
watch(() => props.canWrite, reset);
watch([question, roots], () => { result.value = null; confirmed.value = false; });
onUnmounted(() => { generation++; });
async function verify() {
  if (busy.value || !available.value || !confirmed.value) return;
  const ticket = ++generation; busy.value = true; result.value = null; error.value = '';
  try {
    const reply = await props.client.jointBrief({ question: question.value, targets: targets.value,
      citations: props.evidence.map(item => item.citation), confirmed: true });
    if (ticket === generation) result.value = reply;
  } catch (cause) {
    if (ticket !== generation) return;
    error.value = cause.status === 409 ? '没有可用的已发布模型，读取未完成，或资料/业务快照发生变化。请核对模型和编号后重新检索，没有返回过期数据。'
      : [401, 403].includes(cause.status) ? '当前身份缺少资料或业务对象读取权限。' : '联合核验未完成，请检查明确编号、来源与连接器状态。';
  } finally { if (ticket === generation) { busy.value = false; confirmed.value = false; } }
}
</script>

<template>
  <details v-if="typeof client.jointBrief === 'function'" class="joint-brief" aria-label="知识与业务联合核验">
    <summary>知识依据＋业务事实 · 只读联合核验</summary>
    <p>使用已发布语义模型查询明确业务编号，和当前选中资料并列核验。不调用大模型，不写业务，不自动判定制度适用性。</p>
    <form @submit.prevent="verify">
      <label>核验问题<input v-model="question" :disabled="busy" maxlength="4000" required placeholder="例如：核验这笔订单的影响范围及证据缺口" /></label>
      <label>业务根对象编号（最多3个，逗号分隔）<input v-model="roots" :disabled="busy" maxlength="302" required placeholder="填写已发布读取方案要求的实际编号，不会猜测默认对象" /></label>
      <label><input v-model="confirmed" type="checkbox" :disabled="busy || !available" />确认按当前权限读取上述业务对象及所选资料；不执行处置</label>
      <p v-if="!available">先检索原文依据，并确保当前账号具有操作权限。企业对象授权仍由服务端逐项检查。</p>
      <button :disabled="busy || !available || !confirmed || !question.trim() || targets.length < 1 || targets.length > 3">{{ busy ? '读取与复验中…' : '开始只读联合核验' }}</button>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
    <section v-if="result" aria-label="联合核验结果">
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
input:not([type=checkbox]) { box-sizing: border-box; width: 100%; min-height: 40px; padding: 8px; border: 1px solid #496675; border-radius: 6px; color: inherit; background: transparent; }
button { min-height: 42px; padding: 8px 16px; border: 1px solid #496675; border-radius: 8px; color: inherit; background: transparent; cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; } pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
[role=alert] { color: #ffbdac; } :is(input,button,summary):focus-visible { outline: 2px solid #64d4c0; outline-offset: 3px; }
</style>

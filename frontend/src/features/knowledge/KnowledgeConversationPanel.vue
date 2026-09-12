<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
const props = defineProps({ client: { type: Object, required: true }, evidence: { type: Array, default: () => [] }, policy: Object, canWrite: Boolean });
const emit = defineEmits(['wiki-draft']);
const question = ref(''); const consent = ref(false); const result = ref(null); const error = ref(''); const busy = ref(false);
const questions = ref([]); let generation = 0;
const fingerprint = computed(() => JSON.stringify([props.evidence.map(item => item.citation), props.policy]));
watch(fingerprint, () => { generation++; result.value = null; questions.value = []; consent.value = false; busy.value = false; });
async function ask(purpose = 'answer') {
  if (busy.value || !consent.value || !props.canWrite || !props.policy?.enabled) return;
  const ticket = ++generation; busy.value = true; error.value = ''; result.value = null;
  const input = question.value.trim();
  try {
    const response = await props.client.answer({ question: input, history: questions.value, citations: props.evidence.map(item => item.citation),
      purpose, consent: { provider: props.policy.provider, model: props.policy.model, confirmed: true } });
    if (ticket !== generation) return;
    result.value = response; questions.value = [...questions.value, input].slice(-6);
    while (questions.value.join('').length > 6000) questions.value.shift();
    if (purpose === 'wiki') emit('wiki-draft', { title: input.slice(0, 200), citations: response.evidence.map(item => item.citation),
      notes: `模型整理草稿（需人工校对）：\n${response.claims.map(item => `${item.text} [来源 ${item.sources.map(source => source.index).join('、')}]`).join('\n')}\n\n待核验：\n${response.unknowns.join('\n')}` });
  } catch (cause) {
    if (ticket === generation) { questions.value = []; consent.value = false;
      error.value = cause.status === 409 ? '来源、权限或模型配置已变化，请重新检索和确认。未显示旧答案。'
        : cause.status === 502 ? '模型返回的引用没有通过核验，没有把它作为答案展示。'
          : cause.status === 403 ? '服务端未开放本次资料的模型调用或当前身份没有权限。' : '本次模型问答未成功，请重试或使用原文检索。'; }
  } finally { if (ticket === generation) busy.value = false; }
}
onUnmounted(() => { generation++; });
</script>
<template>
  <section class="knowledge-conversation" aria-label="基于选定资料的模型问答" :aria-busy="busy">
    <h3>与本次资料对话</h3>
    <p>只使用当前 {{ evidence.length }} 条资料及最近 6 个用户问题。每轮重新核验来源，不把旧模型答案当成事实，不执行业务操作。</p>
    <p v-if="!policy?.enabled">服务端尚未允许知识资料进入模型；原文检索和人工校对仍可使用。</p>
    <template v-else>
      <p>模型：{{ policy.provider }} / {{ policy.model }} · {{ policy.dataEgress }}</p>
      <label class="consent"><input v-model="consent" type="checkbox" :disabled="busy || !canWrite" />我确认有权将所选资料及本轮问题发送给上述模型。</label>
    </template>
    <p v-if="questions.length">连续提问 {{ questions.length }} 轮 · 当前主题：{{ questions[0] }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <section v-if="result" aria-live="polite">
      <article v-for="(claim, index) in result.claims" :key="index"><p>{{ claim.text }}</p>
        <details><summary>核验依据</summary><blockquote v-for="(source, i) in claim.sources" :key="i">来源 {{ source.index }}：{{ source.quote }}</blockquote></details>
      </article>
      <p v-for="(unknown, index) in result.unknowns" :key="index">待确认：{{ unknown }}</p>
      <small>已核验来源有效性和逐字引用；这不等于模型解释一定正确。未查询实时业务系统。</small>
    </section>
    <form @submit.prevent="ask()">
      <label>问题或 Wiki 主题<textarea v-model="question" rows="3" maxlength="4000" :disabled="busy" placeholder="例如：供应商资质过期时，采购和仓库各应怎么做？" /></label>
      <div><button :disabled="busy || !canWrite || !policy?.enabled || !consent || !evidence.length || !question.trim()">{{ busy ? '核验来源并生成…' : '依据资料回答' }}</button>
        <button type="button" :disabled="busy || !canWrite || !policy?.enabled || !consent || !evidence.length || !question.trim()" @click="ask('wiki')">生成待校对 Wiki 草稿</button>
        <button type="button" :disabled="busy" @click="questions = []; result = null; consent = false">清空本轮上下文</button></div>
    </form>
  </section>
</template>
<style scoped>
.knowledge-conversation{border:1px solid #46616c;border-radius:9px;padding:16px;margin:16px 0;min-width:0}.knowledge-conversation p,.knowledge-conversation blockquote{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}.knowledge-conversation label{display:flex;flex-direction:column;gap:8px}.knowledge-conversation .consent{flex-direction:row;align-items:center}.knowledge-conversation textarea,.knowledge-conversation button{font:inherit;color:inherit;background:#102832;border:1px solid #46616c;border-radius:6px;padding:10px;min-height:40px;max-width:100%;box-sizing:border-box}.knowledge-conversation button{margin:8px 8px 0 0}.knowledge-conversation button:disabled{opacity:.45}.knowledge-conversation :focus-visible{outline:2px solid #57dbc4;outline-offset:2px}
</style>

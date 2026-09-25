<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';
const props = defineProps({ client: { type: Object, required: true }, snapshot: Array });
const emit = defineEmits(['updated']);
const items = ref([]); const editing = ref(null); const deleting = ref(null); const error = ref(''); const busy = ref(false); const phrase = ref('');
let generation = 0;
async function run(action) {
  if (busy.value) return;
  const ticket = ++generation; busy.value = true; error.value = '';
  try { await action(ticket); }
  catch (cause) { if (ticket === generation) error.value = cause.status === 409 ? '记忆已经变化，请刷新后重新校对，没有覆盖修改。' : cause.message || '操作失败'; }
  finally { if (ticket === generation) busy.value = false; }
}
watch(() => props.snapshot, value => { if (value) items.value = value; });
const refresh = () => run(async ticket => { const result = await props.client.agentMemory(); if (ticket === generation) { items.value = result; editing.value = null; deleting.value = null; emit('updated', result); } });
const save = () => run(async ticket => {
  if (phrase.value !== '确认修改' || !editing.value) return;
  const target = editing.value;
  await props.client.correctAgentMemory(target.id, { content: target.content, expectedFingerprint: target.fingerprint, confirmed: true });
  const result = await props.client.agentMemory();
  if (ticket === generation) { items.value = result; editing.value = null; phrase.value = ''; emit('updated', result); }
});
const remove = () => run(async ticket => {
  if (phrase.value !== '确认删除' || !deleting.value) return;
  const target = deleting.value;
  await props.client.forgetAgentMemory(target.id);
  if (ticket === generation) { items.value = items.value.filter(item => item.id !== target.id); deleting.value = null; phrase.value = ''; emit('updated', items.value); }
});
onMounted(refresh); onUnmounted(() => { generation++; });
</script>
<template>
  <details class="memory-review"><summary>长期目标记忆 · {{ items.length }} 条</summary>
    <p>只管理本人明确固定的长期目标，不是企业事实，也不是执行授权。修改不会延长到期时间；删除不等于清除历史聊天或训练模型。</p>
    <p v-if="error" role="alert">{{ error }}</p><button :disabled="busy || !!editing || !!deleting" @click="refresh">刷新记忆</button>
    <article v-for="item in items" :key="item.id"><p>{{ item.content || item.summary }}</p><small>{{ item.source }} · {{ item.roleId }} · 到期 {{ item.expiresAt }}</small><div><button :disabled="busy || !!editing || !!deleting" @click="editing = { ...item }; phrase = ''">校对 / 修改</button><button :disabled="busy || !!editing || !!deleting" @click="deleting = item; phrase = ''">删除</button></div></article>
    <section v-if="editing"><label>修改本人长期目标<textarea v-model="editing.content" maxlength="8000" rows="4" :disabled="busy" /></label><p>保留原到期时间，不会修改原对话目标或覆盖业务证据。</p><label>输入“确认修改”<input v-model="phrase" :disabled="busy" /></label><button :disabled="busy" @click="editing = null">取消</button><button :disabled="busy || phrase !== '确认修改' || !editing.content.trim()" @click="save">保存修正</button></section>
    <section v-if="deleting"><p>删除“{{ deleting.summary }}”？删除后不再用于跨会话承接。</p><label>输入“确认删除”<input v-model="phrase" :disabled="busy" /></label><button :disabled="busy" @click="deleting = null">取消</button><button :disabled="busy || phrase !== '确认删除'" @click="remove">确认删除</button></section>
  </details>
</template>
<style scoped>
.memory-review{padding:16px;border:1px solid #46616c;border-radius:9px;margin:14px 0}.memory-review summary{cursor:pointer}.memory-review article,.memory-review section{border-top:1px solid #46616c;margin-top:14px;padding-top:12px}.memory-review p{white-space:pre-wrap;overflow-wrap:anywhere}.memory-review small{display:block;overflow-wrap:anywhere}.memory-review button,.memory-review input,.memory-review textarea{font:inherit;background:#102832;color:inherit;border:1px solid #46616c;border-radius:6px;min-height:40px;padding:9px;margin:6px;max-width:100%;box-sizing:border-box}.memory-review textarea{width:100%;margin:6px 0}.memory-review label{display:block}.memory-review button:disabled{opacity:.45}.memory-review :focus-visible{outline:2px solid #57dbc4;outline-offset:2px}
</style>

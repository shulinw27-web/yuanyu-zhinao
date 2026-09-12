<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
const props = defineProps({ client: { type: Object, required: true }, evidence: { type: Array, default: () => [] }, canWrite: Boolean, canModel: Boolean });
const emit = defineEmits(['model-candidate']);
const drafts = ref([]); const editing = ref(null); const opened = ref(null); const error = ref(''); const busy = ref(false); let generation = 0;
async function run(action) { if (busy.value) return; const ticket = ++generation; busy.value = true; error.value = ''; try { await action(ticket); } catch (cause) { if (ticket === generation) { opened.value = null; error.value = cause.status === 409 ? '来源或草稿已变化，请重新检索并校对，不能使用旧引用。' : cause.message || '操作失败'; } } finally { if (ticket === generation) busy.value = false; } }
const refresh = () => run(async ticket => { const result = await props.client.studies(); if (ticket === generation) drafts.value = result.drafts; });
const begin = () => { editing.value = { id: `study-${globalThis.crypto.randomUUID()}`, expectedRevision: 0, title: '', notes: '', citations: props.evidence.map(item => item.citation) }; opened.value = null; };
const open = item => run(async ticket => { const result = await props.client.study(item.id); if (ticket === generation) opened.value = result; });
const save = () => run(async ticket => { const { id, ...body } = editing.value; await props.client.saveStudy(id, { ...body, confirmed: true }); const result = await props.client.studies(); if (ticket === generation) { drafts.value = result.drafts; editing.value = null; } });
const handoff = () => run(async ticket => { const result = await props.client.study(opened.value.id); if (ticket === generation) { opened.value = result; emit('model-candidate', result.candidateInput); } });
onMounted(refresh); onUnmounted(() => { generation++; });
</script>
<template>
  <details class="study-panel"><summary>业务理解草稿 / Wiki · {{ drafts.length }} 份</summary>
    <p>将检索来源整理为人工理解笔记。来源逐条保留，冲突需人工判断；草稿不是已发布模型或企业事实。</p>
    <p v-if="error" role="alert">{{ error }}</p><button v-if="canWrite" :disabled="busy || !evidence.length || !!editing" @click="begin">根据本次检索新建草稿</button><small>先查找原文依据，再创建草稿。最多引用 5 个片段。</small>
    <article v-for="item in drafts" :key="item.id"><b>{{ item.title }} · 修订 {{ item.revision }}</b><button :disabled="busy || !!editing" @click="open(item)">核验来源并打开</button></article>
    <section v-if="editing"><label>主题<input v-model="editing.title" maxlength="200" :disabled="busy" /></label><label>人工理解笔记<textarea v-model="editing.notes" rows="5" maxlength="8000" :disabled="busy" /></label><p>{{ editing.citations.length }} 条来源将重新校验。不要在笔记中填入未经授权的业务明细。</p><button :disabled="busy" @click="editing = null">放弃编辑</button><button :disabled="busy || !editing.title.trim() || !editing.notes.trim()" @click="save">确认保存未发布草稿</button></section>
    <section v-if="opened"><h3>{{ opened.title }}</h3><pre>{{ opened.notes }}</pre><article v-for="source in opened.sources" :key="source.citation.chunkId"><b>{{ source.title }} · 修订 {{ source.revision }}</b><pre>{{ source.excerpt }}</pre></article><button v-if="canWrite" :disabled="busy || !!editing" @click="editing = { id: opened.id, expectedRevision: opened.revision, title: opened.title, notes: opened.notes, citations: opened.citations }; opened = null">修改人工笔记</button><button v-if="canModel" :disabled="busy || !!editing || opened.candidateInput.length > 8000" @click="handoff">核验并填入建模输入框</button><p v-if="canModel">仅填入待审阅输入，不自动发送、采纳或发布。超过 8000 字符请拆分主题。</p></section>
  </details>
</template>
<style scoped>
.study-panel{border:1px solid #46616c;border-radius:9px;padding:16px;margin:16px 0}.study-panel summary{cursor:pointer}.study-panel article,.study-panel section{border-top:1px solid #46616c;margin:14px 0;padding-top:12px}.study-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;max-height:300px;overflow:auto}.study-panel button,.study-panel input,.study-panel textarea{color:inherit;font:inherit;background:#102832;border:1px solid #46616c;border-radius:6px;padding:10px;min-height:40px;max-width:100%;box-sizing:border-box}.study-panel button{margin:6px}.study-panel button:disabled{opacity:.45}.study-panel label{display:flex;flex-direction:column;margin:10px 0;gap:6px}.study-panel small{display:block}.study-panel :focus-visible{outline:2px solid #57dbc4;outline-offset:2px}
</style>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
const props = defineProps({ client: { type: Object, required: true }, evidence: { type: Array, default: () => [] }, generated: Object, canWrite: Boolean, canModel: Boolean });
const emit = defineEmits(['model-candidate']);
const drafts = ref([]); const editing = ref(null); const opened = ref(null); const review = ref(null);
const restoreConfirmation = ref(''); const error = ref(''); const busy = ref(false); let generation = 0;
async function run(action) { if (busy.value) return; const ticket = ++generation; busy.value = true; error.value = ''; try { await action(ticket); } catch (cause) { if (ticket === generation) { opened.value = null; error.value = cause.status === 409 ? '来源或草稿已变化，请重新检索并校对，不能使用旧引用。' : cause.message || '操作失败'; } } finally { if (ticket === generation) busy.value = false; } }
const refresh = () => run(async ticket => { const result = await props.client.studies(); if (ticket === generation) drafts.value = result.drafts; });
const begin = () => { editing.value = { id: `study-${globalThis.crypto.randomUUID()}`, expectedRevision: 0, title: '', notes: '', citations: props.evidence.map(item => item.citation) }; opened.value = null; review.value = null; };
const open = (item, revision) => run(async ticket => { const result = await props.client.study(item.id, revision); if (ticket === generation) { opened.value = result; restoreConfirmation.value = ''; } });
const prepare = () => run(async ticket => {
  const result = await props.client.prepareStudy({ title: editing.value.title, citations: editing.value.citations });
  if (ticket === generation) { editing.value.notes = result.notes; review.value = result.sourceReview; }
});
const restore = () => run(async ticket => {
  if (restoreConfirmation.value !== '确认恢复') return;
  const result = await props.client.restoreStudy(opened.value.id, { revision: opened.value.revision, expectedRevision: opened.value.headRevision, confirmed: true });
  const latest = await props.client.study(result.id); const listed = await props.client.studies();
  if (ticket === generation) { opened.value = latest; drafts.value = listed.drafts; restoreConfirmation.value = ''; }
});
const save = () => run(async ticket => { const { id, ...body } = editing.value; await props.client.saveStudy(id, { ...body, confirmed: true }); const result = await props.client.studies(); if (ticket === generation) { drafts.value = result.drafts; editing.value = null; } });
const handoff = () => run(async ticket => { const result = await props.client.study(opened.value.id); if (ticket === generation) { opened.value = result; emit('model-candidate', result.candidateInput); } });
onMounted(refresh); onUnmounted(() => { generation++; });
</script>
<template>
  <details class="study-panel"><summary>业务理解草稿 / Wiki · {{ drafts.length }} 份</summary>
    <p>按来源整理主题提纲，补充人工理解，再交给建模 Agent。旧版恢复为新修订，不覆盖历史；任何版本的来源失效后都不能打开或恢复。</p>
    <p v-if="error" role="alert">{{ error }}</p><button v-if="canWrite" :disabled="busy || !evidence.length || !!editing" @click="begin">根据本次检索新建草稿</button><small>先查找原文依据，再创建草稿。最多引用 5 个片段。</small>
    <button v-if="canWrite && generated" :disabled="busy || !!editing || generated.notes.length > 8000" @click="begin(); editing.title = generated.title; editing.notes = generated.notes; editing.citations = generated.citations">打开模型生成草稿并人工校对</button>
    <article v-for="item in drafts" :key="item.id"><b>{{ item.title }} · 修订 {{ item.revision }}</b><button :disabled="busy || !!editing" @click="open(item)">核验来源并打开</button></article>
    <section v-if="editing">
      <label>主题<input v-model="editing.title" maxlength="200" :disabled="busy" /></label>
      <button :disabled="busy || !editing.title.trim() || !!editing.notes.trim()" @click="prepare">自动整理来源提纲</button>
      <small>本地规则整理，不调用模型、不覆盖已有笔记；不是生成式业务总结。</small>
      <label>人工理解笔记<textarea v-model="editing.notes" rows="5" maxlength="8000" :disabled="busy" /></label>
      <p>{{ editing.citations.length }} 条来源将重新校验。不要在笔记中填入未经授权的业务明细。</p>
      <p v-if="review">发现 {{ review.conflicts.length }} 组同名字段不同取值。仅检查“字段：值”语句，不代表已排除所有矛盾。</p>
      <button :disabled="busy" @click="editing = null; review = null">放弃编辑</button>
      <button :disabled="busy || !editing.title.trim() || !editing.notes.trim()" @click="save">确认保存未发布草稿</button>
    </section>
    <section v-if="opened">
      <h3>{{ opened.title }} · 修订 {{ opened.revision }} / 最新 {{ opened.headRevision }}</h3><pre>{{ opened.notes }}</pre>
      <details><summary>来源冲突提示 · {{ opened.sourceReview?.conflicts.length || 0 }} 组</summary>
        <p>只比较同名“字段：值”，差异可能是适用范围不同。未命中不代表一致，不自动裁决。</p>
        <article v-for="conflict in opened.sourceReview?.conflicts || []" :key="conflict.key"><b>{{ conflict.key }}</b>
          <p v-for="claim in conflict.claims" :key="`${claim.sourceIndex}-${claim.value}`">来源 {{ claim.sourceIndex + 1 }}：{{ claim.value }}</p>
        </article>
      </details>
      <article v-for="(source, index) in opened.sources" :key="index"><b>来源 {{ index + 1 }} · {{ source.title }} · 修订 {{ source.revision }}</b><pre>{{ source.excerpt }}</pre></article>
      <details><summary>历史修订（最多保留 10 个旧版）</summary>
        <button v-for="version in opened.history" :key="version.revision" :disabled="busy || !!editing || version.revision === opened.revision" @click="open(opened, version.revision)">核验修订 {{ version.revision }}</button>
      </details>
      <template v-if="canWrite && opened.revision !== opened.headRevision">
        <label>恢复此版为新修订<input v-model="restoreConfirmation" placeholder="输入：确认恢复" :disabled="busy" /></label>
        <button :disabled="busy || !!editing || restoreConfirmation !== '确认恢复'" @click="restore">核验来源并恢复</button>
      </template>
      <button v-if="canWrite && opened.revision === opened.headRevision" :disabled="busy || !!editing" @click="editing = { id: opened.id, expectedRevision: opened.revision, title: opened.title, notes: opened.notes, citations: opened.citations }; opened = null">修改人工笔记</button>
      <button v-if="canModel" :disabled="busy || !!editing || opened.revision !== opened.headRevision || opened.candidateInput.length > 8000" @click="handoff">核验并填入建模输入框</button>
      <p v-if="canModel">仅填入待审阅输入，不自动发送、采纳或发布。超过 8000 字符请拆分主题。</p>
    </section>
  </details>
</template>
<style scoped>
.study-panel{border:1px solid #46616c;border-radius:9px;padding:16px;margin:16px 0}.study-panel summary{cursor:pointer}.study-panel article,.study-panel section{border-top:1px solid #46616c;margin:14px 0;padding-top:12px}.study-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;max-height:300px;overflow:auto}.study-panel button,.study-panel input,.study-panel textarea{color:inherit;font:inherit;background:#102832;border:1px solid #46616c;border-radius:6px;padding:10px;min-height:40px;max-width:100%;box-sizing:border-box}.study-panel button{margin:6px}.study-panel button:disabled{opacity:.45}.study-panel label{display:flex;flex-direction:column;margin:10px 0;gap:6px}.study-panel small{display:block}.study-panel :focus-visible{outline:2px solid #57dbc4;outline-offset:2px}
</style>

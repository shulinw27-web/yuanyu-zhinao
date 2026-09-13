<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import KnowledgeStudyPanel from './KnowledgeStudyPanel.vue';
import KnowledgeConversationPanel from './KnowledgeConversationPanel.vue';
import KnowledgeMaterialReviewPanel from './KnowledgeMaterialReviewPanel.vue';
import KnowledgeBusinessBriefPanel from './KnowledgeBusinessBriefPanel.vue';

const props = defineProps({ client: { type: Object, required: true }, canWrite: { type: Boolean, default: false }, canModel: Boolean });
const emit = defineEmits(['model-candidate']);
const documents = ref([]); const providers = ref([]); const busy = ref(false); const error = ref(''); const notice = ref('');
const draft = ref(null); const baseline = ref(''); const chunks = ref([]); const query = ref(''); const answer = ref(null); const source = ref(null);
const withdrawal = ref(null); const phrase = ref(''); let generation = 0;
const serverCanWrite = ref(false);
const answerPolicy = ref(null); const generatedWiki = ref(null);
const principalKey = ref('');
const canEdit = computed(() => props.canWrite && serverCanWrite.value);
const baselineDraft = ref('');
const pendingNavigation = ref(null);
const dirty = computed(() => draft.value && JSON.stringify(draft.value) !== baselineDraft.value);
const changed = computed(() => draft.value && draft.value.text !== baseline.value);
const activeCount = computed(() => documents.value.filter(item => item.available).length);
const selectedProvider = ref('local_private_library');
const isNew = computed(() => draft.value?.expectedRevision === 0);
function acceptReviewedMaterial(material) {
  if (!canEdit.value || busy.value) return;
  if (dirty.value) { error.value = '当前资料有未保存修改，请先保存或放弃，再转入校对结果。'; return; }
  if (material.text.length > 120000) { error.value = '校对材料超出资料上限，请拆分后导入。'; return; }
  newDocument(); draft.value.title = material.title.slice(0, 200); draft.value.source = material.source.slice(0, 200); draft.value.text = material.text;
  notice.value = '人工校对结果已填入资料编辑框，尚未保存。原文件不变。';
}

async function run(action) {
  if (busy.value) return;
  const ticket = ++generation; busy.value = true; error.value = ''; notice.value = '';
  try { await action(ticket); }
  catch (cause) {
    if (ticket !== generation) return;
    answer.value = null; source.value = null;
    error.value = cause.status === 409 ? '资料已被更新，请重新打开当前修订，核对后再保存。没有覆盖其他修改。'
      : [401, 403].includes(cause.status) ? '当前身份没有访问权限，请重新登录或联系管理员。'
        : cause.status === 404 ? '该资料版本已失效或不可访问，请刷新目录。' : cause.message || '操作失败，请重试。';
  } finally { if (ticket === generation) busy.value = false; }
}
async function refresh(ticket) {
  const [list, state] = await Promise.all([props.client.list(), props.client.providers()]);
  if (ticket !== generation) return;
  documents.value = list.documents; providers.value = state.providers; serverCanWrite.value = state.canWrite === true;
  answerPolicy.value = state.answerPolicy;
  principalKey.value = state.principalKey || '';
}
const reload = () => run(async ticket => { answer.value = null; source.value = null; await refresh(ticket); });
function newDocument() {
  if (busy.value) return;
  if (dirty.value) { pendingNavigation.value = { type: 'new' }; return; }
  draft.value = { id: `doc-${globalThis.crypto.randomUUID()}`, expectedRevision: 0, title: '', source: '手动提供', sourceVersion: 'v1', kind: 'reference', text: '', effectiveFrom: null, effectiveUntil: null };
  baseline.value = ''; baselineDraft.value = JSON.stringify(draft.value); chunks.value = []; source.value = null;
}
function openDocument(item) {
  if (dirty.value) { pendingNavigation.value = { type: 'open', item }; return; }
  return run(async ticket => {
  const result = await props.client.read(item.id, item.revision);
  if (ticket !== generation) return;
  draft.value = { id: result.id, expectedRevision: result.revision, title: result.title, source: result.source, sourceVersion: result.sourceVersion,
    kind: result.kind, text: result.text, effectiveFrom: result.effectiveFrom, effectiveUntil: result.effectiveUntil };
  baseline.value = result.text; baselineDraft.value = JSON.stringify(draft.value); chunks.value = result.chunks; source.value = null;
  });
}
function discardAndContinue() {
  const target = pendingNavigation.value;
  pendingNavigation.value = null; draft.value = null; baselineDraft.value = '';
  if (target?.type === 'new') newDocument();
  if (target?.type === 'open') openDocument(target.item);
}
const preview = () => run(async ticket => {
  const result = await props.client.preview(draft.value.text);
  if (ticket === generation) { chunks.value = result.chunks; notice.value = '分块预览未保存。确认原文、分块与版本后再保存。'; }
});
const save = () => run(async ticket => {
  const { id, ...payload } = draft.value;
  const result = await props.client.save(id, payload);
  if (ticket !== generation) return;
  draft.value.expectedRevision = result.revision; baseline.value = draft.value.text;
  baselineDraft.value = JSON.stringify(draft.value);
  chunks.value = []; answer.value = null; source.value = null;
  notice.value = result.unchanged ? '内容未变化，无须新建修订。' : `已保存修订 ${result.revision}，不是发布企业制度。`;
  await refresh(ticket);
});
const search = () => run(async ticket => {
  answer.value = null; source.value = null;
  const result = await props.client.brief(query.value, selectedProvider.value);
  if (ticket === generation) answer.value = result;
});
const openCitation = citation => run(async ticket => {
  source.value = null;
  const result = await props.client.citation(citation);
  if (ticket === generation) source.value = result;
});
const retract = () => run(async ticket => {
  if (phrase.value !== '确认撤回' || !withdrawal.value) return;
  await props.client.retract(withdrawal.value.id, withdrawal.value.revision);
  if (ticket !== generation) return;
  withdrawal.value = null; phrase.value = ''; draft.value = null; chunks.value = []; answer.value = null; source.value = null;
  notice.value = '资料已撤回，旧引用不再可读；历史修订仍保留，不是物理删除。'; await refresh(ticket);
});
async function importText(event) {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file) return;
  if (!/\.(txt|md|csv|json)$/i.test(file.name) || file.size > 240000) { error.value = '仅支持不超过 240KB 的文本、Markdown、CSV 或 JSON。其他格式请使用现有多模态材料入口。'; return; }
  await run(async ticket => {
    const text = await file.text();
    if (text.length > 120000 || text.includes('\u0000')) throw new Error('正文超过 120000 字符或不是有效文本。');
    if (ticket !== generation) return;
    draft.value.text = text; if (!draft.value.title) draft.value.title = file.name.slice(0, 200);
    draft.value.source = file.name.slice(0, 200); chunks.value = [];
    notice.value = '文件已读入编辑框，尚未保存或发送到模型。';
  });
}
onMounted(reload);
onUnmounted(() => { generation++; });
</script>

<template>
  <section class="knowledge-panel" aria-label="个人知识资料工作区" :aria-busy="busy">
    <section v-if="pendingNavigation" class="knowledge-withdrawal" aria-label="未保存修改确认"><h3>当前资料有未保存修改</h3><p>保存后再切换，或明确放弃本次编辑。</p><button @click="pendingNavigation = null">继续编辑</button><button @click="discardAndContinue">放弃修改并切换</button></section>
    <header><div><h2>知识资料</h2><p>管理当前身份的资料，核对原文和引用。不会自动发布制度或写入长期记忆。</p></div><button :disabled="busy" @click="reload">刷新目录</button></header>
    <p v-if="error" role="alert" class="knowledge-error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <slot />
    <KnowledgeMaterialReviewPanel :client="client" :can-write="canEdit" @reviewed-material="acceptReviewedMaterial" />
    <KnowledgeStudyPanel :client="client" :evidence="answer?.evidence || []" :generated="generatedWiki" :can-write="canEdit" :can-model="canModel && canEdit" @model-candidate="emit('model-candidate', $event)" />
    <label>检索来源<select v-model="selectedProvider" :disabled="busy" @change="answer = null; source = null"><option value="local_private_library">本人资料 · 词法检索</option><option value="weknora_local" :disabled="!providers.find(item => item.provider === 'weknora_local')?.configured">WeKnora · 服务端授权资料</option></select></label>
    <div class="knowledge-status"><span>{{ activeCount }} 份可用 / {{ documents.length }} 份资料</span><span v-for="provider in providers" :key="provider.provider">{{ provider.provider === 'local_private_library' ? '本地词法检索' : 'WeKnora 项目接入' }}：{{ provider.configured ? '已配置' : '未配置' }}</span></div>
    <details><summary>管理员接入诊断</summary><p>当前身份绑定指纹（不是密钥，也不授予权限）：</p><pre>{{ principalKey }}</pre><p>由管理员将此指纹映射至允许访问的 WeKnora 库和文档；不能按显示名称猜测身份，也不能把方舟密钥填入 WeKnora 配置。</p></details>
    <form class="knowledge-search" @submit.prevent="search"><label>查询资料<input v-model="query" maxlength="4000" placeholder="例如：供应商资质过期如何处理？" required :disabled="busy" /></label><button :disabled="busy || !query.trim()">查找原文依据</button></form>
    <section v-if="answer" class="knowledge-results" aria-label="检索依据"><p>{{ answer.message }}</p><article v-for="item in answer.evidence" :key="item.citation.chunkId"><h3>{{ item.title }}</h3><small>{{ item.source }} · {{ item.sourceVersion }} · 修订 {{ item.revision }}</small><pre>{{ item.excerpt }}</pre><button :disabled="busy" @click="openCitation(item.citation)">重新核验并打开引用</button></article></section>
    <KnowledgeConversationPanel :client="client" :evidence="answer?.evidence || []" :policy="answerPolicy" :can-write="canEdit" @wiki-draft="generatedWiki = $event" />
    <KnowledgeBusinessBriefPanel :client="client" :evidence="answer?.evidence || []" :can-write="canEdit" />
    <section v-if="source" class="knowledge-source" aria-label="已核验原文"><h3>{{ source.title }} · 当前有效引用</h3><small v-if="source.provider === 'local_private_library'">{{ source.citation.start }}–{{ source.citation.end }} UTF-16 字符偏移（不是 PDF 页码）</small><small v-else>WeKnora 分块定位 · {{ source.citation.chunkId }}（不代表 PDF 页码）</small><pre>{{ source.excerpt }}</pre></section>
    <div class="knowledge-columns">
      <aside><div class="knowledge-toolbar"><h3>资料目录</h3><button v-if="canEdit" :disabled="busy" @click="newDocument">＋ 新建</button></div><p v-if="!documents.length">尚无资料。保存后才能检索，不会自动使用其他用户的资料。</p>
        <article v-for="item in documents" :key="item.id" class="knowledge-card"><b>{{ item.title }}</b><small>修订 {{ item.revision }} · {{ item.available ? '当前可用' : item.status === 'retracted' ? '已撤回' : '不在有效期' }} · {{ item.chunkCount }} 个片段</small><small>{{ item.source }} / {{ item.sourceVersion }}</small><div><button :disabled="busy || !item.available" @click="openDocument(item)">打开 / 校对</button><button v-if="canWrite && item.status !== 'retracted'" :disabled="busy" @click="withdrawal = item; phrase = ''">撤回</button></div></article>
      </aside>
      <section class="knowledge-editor"><template v-if="draft"><div class="knowledge-toolbar"><h3>{{ isNew ? '新建资料（未保存）' : `校对修订 ${draft.expectedRevision}` }}</h3><span>{{ changed ? '正文有未保存修改' : '正文未修改' }}</span></div>
        <div class="knowledge-fields"><label>标题<input v-model="draft.title" maxlength="200" :disabled="busy || !canEdit" /></label><label>来源<input v-model="draft.source" maxlength="200" :disabled="busy || !canEdit" /></label><label>来源版本<input v-model="draft.sourceVersion" maxlength="100" :disabled="busy || !canEdit" /></label><label>资料类型<select v-model="draft.kind" :disabled="busy || !canEdit"><option value="reference">参考资料</option><option value="policy">制度材料（非正式发布）</option></select></label></div>
        <label v-if="canEdit" class="knowledge-file">从文本文件导入<input type="file" accept=".txt,.md,.csv,.json" :disabled="busy" @change="importText" /></label>
        <label>正文 · {{ draft.text.length }}/120000 字符<textarea v-model="draft.text" rows="14" maxlength="120000" :disabled="busy || !canEdit" @input="chunks = []" /></label>
        <details v-if="baseline && changed"><summary>对比保存前正文</summary><pre>{{ baseline }}</pre></details>
        <div v-if="canEdit" class="knowledge-toolbar"><button :disabled="busy || !draft.text.trim()" @click="preview">预览分块</button><button :disabled="busy || !draft.title.trim() || !draft.text.trim() || !draft.source.trim() || !draft.sourceVersion.trim()" @click="save">确认保存个人资料</button></div>
        <section aria-label="分块预览"><article v-for="chunk in chunks" :key="chunk.index" class="knowledge-chunk"><small>片段 {{ chunk.index + 1 }} · 字符 {{ chunk.start }}–{{ chunk.end }}</small><pre>{{ chunk.text }}</pre></article></section>
      </template><p v-else>选择资料进行校对，或新建资料。身份、访问范围和修订号由服务端控制。</p></section>
    </div>
    <section v-if="withdrawal" class="knowledge-withdrawal" role="group" aria-label="撤回确认"><h3>撤回《{{ withdrawal.title }}》？</h3><p>停止检索和引用读取，历史仍保留。不会删除电脑上的源文件。</p><label>输入“确认撤回”<input v-model="phrase" :disabled="busy" /></label><button :disabled="busy" @click="withdrawal = null">取消</button><button :disabled="busy || phrase !== '确认撤回'" @click="retract">确认撤回</button></section>
  </section>
</template>

<style scoped>
.knowledge-panel{padding:20px;min-width:0;color:inherit;overflow:auto;flex:1}.knowledge-panel header,.knowledge-toolbar,.knowledge-search,.knowledge-status{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.knowledge-panel h2,.knowledge-panel h3{margin:0 0 10px}.knowledge-panel p,.knowledge-panel small{line-height:1.7;opacity:.8}.knowledge-panel button,.knowledge-panel input,.knowledge-panel select,.knowledge-panel textarea{font:inherit;color:inherit;background:#102832;border:1px solid #46616c;border-radius:7px;padding:10px;min-height:40px}.knowledge-panel button{cursor:pointer}.knowledge-panel button:disabled{opacity:.45;cursor:not-allowed}.knowledge-panel button:focus-visible,.knowledge-panel input:focus-visible,.knowledge-panel textarea:focus-visible{outline:2px solid #57dbc4;outline-offset:2px}.knowledge-panel label{display:flex;flex-direction:column;gap:7px;min-width:0}.knowledge-panel textarea{resize:vertical;width:100%;box-sizing:border-box}.knowledge-status{justify-content:flex-start;margin:14px 0;font-size:12px}.knowledge-status span{border:1px solid #46616c;padding:6px 10px;border-radius:20px}.knowledge-search label{flex:1}.knowledge-search{margin:20px 0}.knowledge-columns{display:grid;grid-template-columns:minmax(200px,28%) minmax(0,1fr);gap:18px}.knowledge-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}.knowledge-card,.knowledge-chunk,.knowledge-results article,.knowledge-source,.knowledge-withdrawal{border:1px solid #46616c;border-radius:9px;padding:14px;margin:12px 0;background:#0d212b}.knowledge-card b,.knowledge-card small{display:block;overflow-wrap:anywhere}.knowledge-card button{margin:9px 6px 0 0}.knowledge-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.75;max-height:420px;overflow:auto}.knowledge-error{color:#ffb0a6}.knowledge-editor,.knowledge-columns aside{min-width:0}.knowledge-file{margin:12px 0}.knowledge-toolbar{margin:12px 0}.knowledge-withdrawal{border-color:#b58e51}.knowledge-withdrawal input{max-width:320px;margin-bottom:12px}@media(max-width:850px){.knowledge-columns,.knowledge-fields{grid-template-columns:1fr}.knowledge-panel{padding:12px}.knowledge-columns aside{max-height:320px;overflow:auto}.knowledge-search{align-items:stretch}.knowledge-search label{flex-basis:100%}}
</style>

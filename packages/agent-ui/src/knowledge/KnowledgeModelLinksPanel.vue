<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import OntologyGraph from '../meta-model/OntologyGraph.vue';
const props = defineProps({ client: { type: Object, required: true }, evidence: { type: Array, default: () => [] }, canWrite: Boolean });
const emit = defineEmits(['open-citation']);
const state = ref(null); const busy = ref(false); const error = ref(''); const confirmed = ref(false);
const suggestions = ref([]);
const modelPolicy = ref(null); const modelConsent = ref(false);
const analysisTarget = ref('');
const objectId = ref(''); const evidenceIndex = ref(''); const relationType = ref('definition'); let generation = 0;
let evidenceGeneration = 0;
const labels = { definition: '定义依据', rule: '规则依据', field: '字段说明', workflow: '流程说明' };
const validLinks = computed(() => (state.value?.links || []).filter(item => item.status === 'confirmed'));
const documentId = link => JSON.stringify(['document', link.citation.provider, link.citation.documentId, link.citation.revision]);
const nodes = computed(() => {
  const result = new Map();
  for (const link of validLinks.value) {
    result.set(link.objectId, { id: link.objectId, label: link.objectLabel, description: '当前草稿中的业务对象', sourceSystems: [] });
    result.set(documentId(link), { id: documentId(link), label: link.sourceTitle, description: `资料修订 ${link.citation.revision}`, sourceSystems: ['资料依据'] });
  }
  return [...result.values()];
});
const edges = computed(() => validLinks.value.map(link => ({ from: documentId(link), to: link.objectId, predicate: link.relationType, label: labels[link.relationType], cardinality: '资料引用', evidence: link.excerpt })));
async function refresh() {
  const ticket = ++generation; busy.value = true; error.value = ''; confirmed.value = false; state.value = null; suggestions.value = []; modelConsent.value = false; modelPolicy.value = null; analysisTarget.value = '';
  try { const result = await props.client.modelLinks(); const providers = await props.client.providers?.(); if (ticket === generation) { state.value = result; modelPolicy.value = providers?.answerPolicy || null; } }
  catch (cause) { if (ticket === generation) { state.value = null; error.value = cause.message || '资料关联暂不可用，请重试。'; } }
  finally { if (ticket === generation) busy.value = false; }
}
async function suggest(mode = 'exact') {
  if (busy.value || !props.canWrite || !state.value || !props.evidence.length) return;
  if (mode === 'model' && (!modelPolicy.value?.enabled || !modelConsent.value)) return;
  const ticket = ++generation; const evidenceTicket = evidenceGeneration; busy.value = true; suggestions.value = []; error.value = '';
  try { const result = await props.client.suggestModelLinks({ citations: props.evidence.slice(0, 8).map(item => item.citation), modelFingerprint: state.value.modelFingerprint, confirmed: true, mode, ...(mode === 'model' ? { consent: { provider: modelPolicy.value.provider, model: modelPolicy.value.model, confirmed: true }, ...(analysisTarget.value ? { targetIds: [analysisTarget.value] } : {}) } : {}) }); if (ticket === generation && evidenceTicket === evidenceGeneration) suggestions.value = result.suggestions; }
  catch (cause) { if (ticket === generation) error.value = cause.message || '建议生成失败，请重新核验。'; }
  finally { if (ticket === generation) busy.value = false; }
}
function chooseSuggestion(item) { objectId.value = item.objectId; relationType.value = item.relationType; evidenceIndex.value = String(props.evidence.findIndex(evidence => JSON.stringify(evidence.citation) === JSON.stringify(item.citation))); confirmed.value = false; }
async function save() {
  if (busy.value || !props.canWrite || !confirmed.value || !objectId.value || !state.value || !props.evidence[Number(evidenceIndex.value)] || evidenceIndex.value === '') return;
  const ticket = ++generation; busy.value = true; error.value = '';
  const body = { objectId: objectId.value, modelFingerprint: state.value.modelFingerprint, relationType: relationType.value, citation: props.evidence[Number(evidenceIndex.value)].citation, confirmed: true };
  try { await props.client.saveModelLink(body); if (ticket === generation) { busy.value = false; await refresh(); } }
  catch (cause) { if (ticket === generation) { confirmed.value = false; error.value = cause.status === 409 ? '资料或模型已变化，请刷新并重新选择依据。' : cause.message || '关联保存失败。'; } }
  finally { if (ticket === generation) busy.value = false; }
}
async function retract(link) {
  if (busy.value || !props.canWrite) return;
  const ticket = ++generation; busy.value = true; error.value = '';
  try { await props.client.retractModelLink(link.id, link.revision); if (ticket === generation) { busy.value = false; await refresh(); } }
  catch (cause) { if (ticket === generation) error.value = cause.message || '撤回失败，请刷新。'; }
  finally { if (ticket === generation) busy.value = false; }
}
watch(() => props.client, refresh, { immediate: true });
watch([() => props.evidence, objectId, evidenceIndex, relationType], () => { confirmed.value = false; }, { deep: true });
watch(() => props.evidence, () => { suggestions.value = []; modelConsent.value = false; evidenceGeneration++; }, { deep: true });
watch(() => props.canWrite, refresh);
watch(analysisTarget, () => { modelConsent.value = false; suggestions.value = []; });
onUnmounted(() => { generation++; });
</script>
<template>
  <section class="knowledge-model-links" aria-label="资料与业务对象关联">
    <header><div><h3>资料与业务对象关联</h3><p>资料可以说明某个对象、规则或字段。选择检索到的依据，经核对后建立关联。</p></div><button :disabled="busy" @click="refresh">刷新关联</button></header>
    <p v-if="error" role="alert">{{ error }}</p>
    <OntologyGraph v-if="validLinks.length" compact :objects="nodes" :relationships="edges" :ask-enabled="false" title="已确认的资料关联图" />
    <p v-else>还没有有效的业务关联。先到“查找依据”检索资料，再选择对应业务对象。</p>
    <button v-if="canWrite" :disabled="busy || !state || !evidence.length" @click="suggest('exact')">按明确名称查找候选</button><p>名称匹配不调用模型。AI 分析只使用本次选定依据，候选均需人工核对，不自动保存。</p>
    <template v-if="canWrite"><label v-if="state">分析范围<select v-model="analysisTarget" :disabled="busy"><option value="">当前模型全部目标（受目录预算限制）</option><option v-for="item in state.objects" :key="item.id" :value="item.id">仅 {{ item.label }}</option></select></label><label v-if="modelPolicy?.enabled" class="link-confirm"><input v-model="modelConsent" type="checkbox" :disabled="busy" />同意将选定资料片段及上述目标目录发送到 {{ modelPolicy.provider }} / {{ modelPolicy.model }} 进行关联分析。</label><p v-else>管理员尚未开启资料模型分析策略；仍可名称匹配或人工关联。</p><button :disabled="busy || !state || !evidence.length || !modelConsent || !modelPolicy?.enabled" @click="suggest('model')">AI 分析已检索依据</button></template>
    <article v-for="(item, index) in suggestions" :key="index"><b>{{ item.sourceTitle }} → {{ item.objectLabel }}</b><p>{{ item.reason }}</p><blockquote>{{ item.excerpt }}</blockquote><button :disabled="busy" @click="chooseSuggestion(item)">选择这条候选，继续人工核对</button></article>
    <details v-if="canWrite && state"><summary>从本次检索依据建立关联</summary><div class="link-form"><label>资料依据<select v-model="evidenceIndex" :disabled="busy"><option value="">请选择检索依据</option><option v-for="(item, index) in evidence" :key="index" :value="String(index)">{{ item.title }} · 片段 {{ index + 1 }}</option></select></label><label>业务对象<select v-model="objectId" :disabled="busy"><option value="">请选择业务对象</option><option v-for="item in state.objects" :key="item.id" :value="item.id">{{ item.label }}</option></select></label><label>关联含义<select v-model="relationType" :disabled="busy"><option v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</option></select></label></div><blockquote v-if="evidenceIndex !== ''">{{ evidence[Number(evidenceIndex)]?.excerpt }}</blockquote><label class="link-confirm"><input v-model="confirmed" type="checkbox" :disabled="busy" />已核对所选片段，确认它是该对象的依据。</label><button :disabled="busy || !confirmed || !objectId || evidenceIndex === ''" @click="save">确认保存关联</button></details>
    <details v-if="state?.links.length"><summary>关联记录 · {{ state.links.length }}</summary><article v-for="link in state.links" :key="link.id"><b>{{ link.sourceTitle }} → {{ link.objectLabel }}</b><small>{{ labels[link.relationType] }} · {{ { confirmed: '已确认', needs_review: '待重新核对', retracted: '已撤回' }[link.status] }} {{ link.reason }}</small><button v-if="link.status === 'confirmed'" @click="emit('open-citation', link.citation)">重新核验原文</button><button v-if="canWrite && link.status !== 'retracted'" :disabled="busy" @click="retract(link)">撤回关联</button></article></details>
  </section>
</template>
<style scoped>
.knowledge-model-links{margin:18px 0;padding:16px;border:1px solid #315764;border-radius:12px;background:#0b222d}.knowledge-model-links header{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.knowledge-model-links h3{margin:0}.knowledge-model-links p,.knowledge-model-links small{font-size:12px;color:#91b2bf;line-height:1.8}.knowledge-model-links button,.knowledge-model-links select{background:#113340;color:inherit;border:1px solid #375f70;border-radius:7px;padding:9px;max-width:100%}.knowledge-model-links button{cursor:pointer}.knowledge-model-links button:disabled{opacity:.5}.knowledge-model-links details{margin-top:14px}.knowledge-model-links summary{cursor:pointer}.link-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:12px 0}.link-form label{display:grid;gap:6px;font-size:12px}.link-confirm{display:flex!important;flex-direction:row!important;align-items:center;gap:8px;margin:12px 0}.knowledge-model-links article{border-top:1px solid #315764;padding:12px 0}.knowledge-model-links article small{display:block}.knowledge-model-links article button{margin:8px 8px 0 0}.knowledge-model-links blockquote{max-height:200px;overflow:auto;white-space:pre-wrap;line-height:1.8;font-size:12px}.knowledge-model-links :focus-visible{outline:2px solid #71e0c5;outline-offset:3px}@media(max-width:750px){.link-form{grid-template-columns:1fr}}
</style>

<script setup>
import { ref, watch, onBeforeUnmount } from 'vue';
import OntologyGraph from './OntologyGraph.vue';

const props = defineProps({ client: { type: Object, required: true } });
const emit = defineEmits(['conversation-created']);
const conversationConfirmed = ref(false);
const models = ref([]); const selected = ref(''); const definition = ref(null); const busy = ref(false); const error = ref(''); const loaded = ref(false);
let generation = 0;
const validSummary = model => model && typeof model.modelId === 'string' && /^[a-z][a-z0-9-]{1,63}$/u.test(model.modelId)
  && typeof model.label === 'string' && model.label.length <= 80 && typeof model.version === 'string' && model.version.length <= 120
  && /^[a-f0-9]{24}$/u.test(model.fingerprint || '') && model.authority === 'published_schema_not_business_facts_or_permissions'
  && model.runtimeReadEnabled === false && model.chatSelectionEnabled === false && Number.isSafeInteger(model.nodeCount) && model.nodeCount > 0 && model.nodeCount <= 200
  && Number.isSafeInteger(model.relationshipCount) && model.relationshipCount >= 0 && model.relationshipCount <= 400;
function clear() { models.value = []; selected.value = ''; definition.value = null; loaded.value = false; error.value = ''; busy.value = false; conversationConfirmed.value = false; }
async function load() {
  const request = ++generation; clear(); busy.value = true;
  try {
    const result = await props.client.publishedModels(); if (request !== generation) return;
    if (result.contentScope !== 'published_model_catalog_only' || result.runtimeReadEnabled !== false || result.chatSelectionEnabled !== false
      || !Array.isArray(result.models) || result.models.length > 31 || result.models.some(model => !validSummary(model))
      || new Set(result.models.map(model => model.modelId)).size !== result.models.length) throw new Error('INVALID_CATALOG');
    models.value = result.models; loaded.value = true;
  } catch { if (request === generation) { clear(); error.value = '模型目录不可用，请检查当前身份、显式模型授权和发布状态。旧内容已清除，不会自动切换模型或执行。'; } }
  finally { if (request === generation) busy.value = false; }
}
async function inspect(modelId) {
  if (busy.value || !models.value.some(model => model.modelId === modelId)) return;
  const expected = models.value.find(model => model.modelId === modelId); const request = ++generation;
  selected.value = modelId; definition.value = null; busy.value = true; error.value = '';
  conversationConfirmed.value = false;
  try {
    const result = await props.client.publishedModel(modelId); if (request !== generation) return;
    const model = result.model;
    if (result.contentScope !== 'published_schema_only' || !validSummary(model) || model.modelId !== modelId || model.fingerprint !== expected.fingerprint || model.version !== expected.version
      || !Array.isArray(model.graph?.nodes) || !Array.isArray(model.graph.edges) || model.graph.nodes.length !== model.nodeCount || model.graph.edges.length !== model.relationshipCount) throw new Error('MODEL_CHANGED');
    definition.value = model;
  } catch { if (request === generation) { clear(); error.value = '模型版本或权限可能已变化，旧结构已清除。请重新读取目录，不会切换当前问答模型。'; } }
  finally { if (request === generation) busy.value = false; }
}
async function createConversation() {
  if (busy.value || !definition.value || !conversationConfirmed.value) return;
  const expected = definition.value; const request = ++generation; busy.value = true; error.value = ''; conversationConfirmed.value = false;
  try {
    const result = await props.client.createModelConversation(expected.modelId, { confirmed: true, expectedVersion: expected.version, expectedFingerprint: expected.fingerprint });
    if (request !== generation) return;
    const binding = result.conversation?.modelBinding;
    if (result.contentScope !== 'model_bound_schema_conversation' || result.runtimeReadEnabled !== false || !/^conversation-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(result.conversation?.id || '')
      || binding?.schemaVersion !== 'agent-model-binding.v1' || binding.mode !== 'published_schema_only' || binding.modelId !== expected.modelId || binding.version !== expected.version || binding.fingerprint !== expected.fingerprint) throw new Error('MODEL_BINDING_MISMATCH');
    emit('conversation-created', result.conversation);
  } catch { if (request === generation) { definition.value = null; error.value = '未获得可核对的创建回执，会话可能已创建。不会自动重发，请刷新智脑任务列表核对；需重新读取模型后才能再次创建。'; } }
  finally { if (request === generation) busy.value = false; }
}
watch(() => props.client, () => { generation++; clear(); });
onBeforeUnmount(() => { generation++; clear(); });
</script>

<template>
  <section class="published-model-panel" aria-label="已发布模型结构">
    <header><div><h2>业务世界模型</h2><p>查看已发布模型的对象、来源系统和关联关系。可单独创建限定结构咨询，不改变已有业务会话，不读取业务记录。</p></div><button type="button" :disabled="busy" @click="load">{{ busy ? '正在复验…' : '读取授权模型目录' }}</button></header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="loaded && !models.length">当前没有可查看的独立模型。需先完成登记、受控发布和显式模型授权；默认工作台不会自动继承为新模型。</p>
    <nav v-if="models.length" aria-label="已授权的独立模型"><button v-for="model in models" :key="model.modelId" type="button" :disabled="busy" :aria-pressed="selected === model.modelId" @click="inspect(model.modelId)">{{ model.label }} <small>{{ model.nodeCount }} 对象 · {{ model.relationshipCount }} 关系</small></button></nav>
    <template v-if="definition"><p>已发布版本 {{ definition.version }} · {{ definition.fingerprint }}。仅结构快照，不代表业务查询或执行授权。</p><label><input v-model="conversationConfirmed" type="checkbox" :disabled="busy">我确认新建固定此版本的结构咨询，仅解释对象、字段及关系，不查询数据或执行</label><button type="button" :disabled="busy || !conversationConfirmed" @click="createConversation">新建结构咨询会话</button><OntologyGraph :key="`${definition.modelId}:${definition.fingerprint}`" :objects="definition.graph.nodes" :relationships="definition.graph.edges" :model-fingerprint="definition.fingerprint" :layout-save-enabled="false" :ask-enabled="false" :title="`${definition.label} · 已发布结构`" compact /></template>
  </section>
</template>

<style scoped>
.published-model-panel{margin:20px;padding:20px;border:1px solid var(--line,#31515e);border-radius:14px;background:var(--panel,#10212a);min-width:0;overflow:hidden}
header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}h2{margin:0 0 8px;font-size:18px}p{font-size:13px;line-height:1.7;color:var(--muted,#a1bdc9);overflow-wrap:anywhere}header p{max-width:760px;margin:0}button{border:1px solid var(--line,#31515e);border-radius:8px;background:var(--panel-strong,#163140);color:inherit;padding:10px 14px;cursor:pointer;min-height:40px}button:disabled{cursor:wait;opacity:.55}button:focus-visible{outline:2px solid var(--accent,#54dcc4);outline-offset:3px}button[aria-pressed=true]{border-color:var(--accent,#54dcc4)}nav{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}small{display:block;margin-top:5px;opacity:.7}[role=alert]{color:#ffb7b7}@media(max-width:600px){.published-model-panel{margin:10px;padding:14px}header>button,nav>button{width:100%}}
</style>

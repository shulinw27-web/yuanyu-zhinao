<script setup>
import { onUnmounted, ref, watch } from 'vue';
const props = defineProps({ client: { type: Object, required: true }, draft: { type: Object, required: true }, layout: { type: Object, default: null }, selectedId: { type: String, default: '' }, canEdit: Boolean });
const emit = defineEmits(['restore']);
const views = ref([]); const selected = ref(''); const label = ref('业务关系视图'); const busy = ref(false); const error = ref(''); const link = ref(''); let generation = 0;
const makeLink = (id, embed = false) => { const url = new URL(location.href); if (embed) url.searchParams.set('embed', 'ontology'); else url.searchParams.delete('embed'); url.hash = `saved-model-view=${encodeURIComponent(id)}`; return url.href; };
async function refresh() {
  const ticket = ++generation; busy.value = true; views.value = []; selected.value = ''; link.value = ''; error.value = '';
  try { const result = await props.client.modelViews(); if (ticket === generation) views.value = result.views; }
  catch (cause) { if (ticket === generation) error.value = cause.message || '视图暂不可用。'; }
  finally { if (ticket === generation) busy.value = false; }
}
async function restore(id = selected.value) {
  if (busy.value || !id) return;
  const ticket = ++generation; busy.value = true; error.value = '';
  try { const { view } = await props.client.modelView(id); if (ticket === generation) { selected.value = view.id; label.value = view.label; link.value = makeLink(view.id); emit('restore', view); } }
  catch (cause) { if (ticket === generation) error.value = cause.status === 409 ? '模型版本已变化，请在当前模型重新保存视图。' : '视图不存在或当前身份不可访问。'; }
  finally { if (ticket === generation) busy.value = false; }
}
async function save() {
  if (busy.value || !props.canEdit || !props.layout || props.layout.fingerprint !== props.draft.fingerprint) return;
  const ticket = ++generation; busy.value = true; error.value = '';
  const current = views.value.find(view => view.id === selected.value);
  try { const { view } = await props.client.saveModelView({ ...(current ? { id: current.id } : {}), expectedRevision: current?.revision || 0, label: label.value, selectedId: props.selectedId, modelFingerprint: props.draft.fingerprint, layout: props.layout }); if (ticket === generation) { views.value = [...views.value.filter(item => item.id !== view.id), { ...view, current: true }]; selected.value = view.id; link.value = makeLink(view.id); history.replaceState(null, '', link.value); } }
  catch (cause) { if (ticket === generation) error.value = cause.status === 409 ? '模型或视图已变化，请刷新后重新保存。' : cause.message || '保存失败。'; }
  finally { if (ticket === generation) busy.value = false; }
}
watch([() => props.client, () => props.draft.fingerprint, () => props.canEdit], refresh, { immediate: true });
onUnmounted(() => { generation++; });
</script>
<template>
  <details class="saved-ontology-views"><summary>我的模型视图 · 跨刷新恢复</summary><p>先在关系图点击“保存本次会话布局”，再保存到个人视图。最多20个视图；按租户、用户和角色隔离。旧模型版本不套用到新模型，链接不授予权限，不共享资料。</p><label>视图<select v-model="selected" :disabled="busy"><option value="">新建视图</option><option v-for="view in views" :key="view.id" :value="view.id">{{ view.label }} · r{{ view.revision }} {{ view.current ? '' : '（模型已变化）' }}</option></select></label><label>名称<input v-model="label" maxlength="80" :disabled="busy" /></label><button :disabled="busy || !selected" @click="restore()">恢复选中视图</button><button :disabled="busy || !canEdit || !layout || layout.fingerprint !== draft.fingerprint" @click="save">保存个人视图并生成链接</button><button :disabled="busy" @click="refresh">刷新视图列表</button><template v-if="link"><label>授权定位链接<input :value="link" readonly @focus="$event.target.select()" /></label><label>登录后只读嵌入链接<input :value="makeLink(selected, true)" readonly @focus="$event.target.select()" /></label></template><p v-if="error" role="alert">{{ error }}</p></details>
</template>
<style scoped>
.saved-ontology-views{padding:12px;border:1px solid #315764;border-radius:10px;background:#0a202b;color:#d7edef;margin:16px 0;min-width:0}.saved-ontology-views p{font-size:12px;line-height:1.8;color:#91b2bf}.saved-ontology-views summary{cursor:pointer;font-weight:600}.saved-ontology-views label{display:block}.saved-ontology-views input,.saved-ontology-views select,.saved-ontology-views button{background:#112f3c;border:1px solid #375f70;border-radius:7px;padding:9px;color:inherit;max-width:100%;box-sizing:border-box;margin:8px 8px 8px 0}.saved-ontology-views input[readonly]{width:100%}.saved-ontology-views button:disabled{opacity:.5}.saved-ontology-views :focus-visible{outline:2px solid #71e0c5}
</style>

<script setup>
import { onUnmounted, ref, watch } from 'vue';
const props = defineProps({ client: { type: Object, required: true }, draft: { type: Object, required: true }, layout: { type: Object, default: null }, selectedId: { type: String, default: '' }, canEdit: Boolean, canReview: Boolean });
const emit = defineEmits(['restore']);
const views = ref([]); const selected = ref(''); const label = ref('业务关系视图'); const busy = ref(false); const error = ref(''); const link = ref(''); let generation = 0;
const teamViews = ref([]); const teamSelected = ref('');
const historyViews = ref([]); const historySelected = ref(''); const historyOffset = ref(0); const historyTotal = ref(0);
const makeLink = (id, embed = false) => { const url = new URL(location.href); if (embed) url.searchParams.set('embed', 'ontology'); else url.searchParams.delete('embed'); url.hash = `saved-model-view=${encodeURIComponent(id)}`; return url.href; };
async function refresh() {
  const ticket = ++generation; busy.value = true; views.value = []; teamViews.value = []; teamSelected.value = ''; selected.value = ''; link.value = ''; error.value = ''; historyViews.value = []; historySelected.value = ''; historyOffset.value = 0; historyTotal.value = 0;
  try { const result = await props.client.modelViews(); const team = props.canReview ? await props.client.teamModelViews() : { views: [] }; const history = props.canReview && props.client.teamModelHistory ? await props.client.teamModelHistory(0, 20) : { views: [], total: 0 }; if (ticket === generation) { views.value = result.views; teamViews.value = team.views; historyViews.value = history.views; historyTotal.value = history.total; } }
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
async function teamAction(action) {
  if (busy.value || !props.canReview) return;
  const current = action === 'share' ? views.value.find(view => view.id === selected.value) : teamViews.value.find(view => view.id === teamSelected.value);
  if (!current || action !== 'retract' && !current.current || action !== 'restore' && !props.canEdit || action === 'retract' && !current.owned) return;
  const ticket = ++generation; busy.value = true; error.value = '';
  try {
    if (action === 'restore') { const { view } = await props.client.teamModelView(current.id); if (ticket === generation) emit('restore', view); }
    else {
      if (action === 'share') await props.client.shareModelView(current.id, { expectedRevision: current.revision, modelFingerprint: props.draft.fingerprint });
      else await props.client.retractTeamModelView(current.id, current.revision);
      const result = await props.client.teamModelViews(); const history = props.client.teamModelHistory ? await props.client.teamModelHistory(0, 20) : { views: [], total: 0 }; if (ticket === generation) { teamViews.value = result.views; teamSelected.value = ''; historyViews.value = history.views; historyTotal.value = history.total; historyOffset.value = 0; historySelected.value = ''; }
    }
  } catch (cause) { if (ticket === generation) error.value = cause.message || '团队快照已失效或权限不足，请刷新后重试。'; }
  finally { if (ticket === generation) busy.value = false; }
}
async function historyPage(offset) {
  if (busy.value || !props.canReview || !props.client.teamModelHistory || offset < 0 || offset >= historyTotal.value) return;
  const ticket = ++generation; busy.value = true; historySelected.value = ''; error.value = '';
  try { const result = await props.client.teamModelHistory(offset, 20); if (ticket === generation) { historyViews.value = result.views; historyTotal.value = result.total; historyOffset.value = offset; } }
  catch (cause) { if (ticket === generation) error.value = cause.message || '历史记录读取失败。'; }
  finally { if (ticket === generation) busy.value = false; }
}
async function archiveHistory() {
  const view = historyViews.value.find(item => item.id === historySelected.value);
  if (busy.value || !props.canReview || !props.canEdit || !view?.owned || !view.revoked || view.archivedAt || !props.client.archiveTeamModelView) return;
  const ticket = ++generation; busy.value = true; error.value = '';
  try { await props.client.archiveTeamModelView(view.id, view.revision); if (ticket === generation) await refresh(); }
  catch (cause) { if (ticket === generation) error.value = cause.message || '历史归档失败，请刷新后重试。'; }
  finally { if (ticket === generation) busy.value = false; }
}
watch([() => props.client, () => props.draft.fingerprint, () => props.canEdit, () => props.canReview], refresh, { immediate: true });
onUnmounted(() => { generation++; });
</script>
<template>
  <details class="saved-ontology-views"><summary>我的模型视图 · 跨刷新恢复</summary><p>先在关系图点击“保存本次会话布局”，再保存到个人视图。最多20个视图；按租户、用户和角色隔离。旧模型版本不套用到新模型，链接不授予权限，不共享资料。</p><label>视图<select v-model="selected" :disabled="busy"><option value="">新建视图</option><option v-for="view in views" :key="view.id" :value="view.id">{{ view.label }} · r{{ view.revision }} {{ view.current ? '' : '（模型已变化）' }}</option></select></label><label>名称<input v-model="label" maxlength="80" :disabled="busy" /></label><button :disabled="busy || !selected" @click="restore()">恢复选中视图</button><button :disabled="busy || !canEdit || !layout || layout.fingerprint !== draft.fingerprint" @click="save">保存个人视图并生成链接</button><button :disabled="busy" @click="refresh">刷新视图列表</button><template v-if="link"><label>授权定位链接<input :value="link" readonly @focus="$event.target.select()" /></label><label>登录后只读嵌入链接<input :value="makeLink(selected, true)" readonly @focus="$event.target.select()" /></label></template><p v-if="error" role="alert">{{ error }}</p></details>
  <details v-if="canReview" class="saved-ontology-views" aria-label="团队模型视图"><summary>团队模型视图 · 审核人员共享快照</summary><p>只有同租户且当前有模型审核权限的人员可读取。显式分享已保存的个人布局，不分享资料原文、业务记录或权限；个人视图后续修改不会覆盖已分享快照。模型变更后不可恢复，由原分享人撤回。最多20个有效快照、100条含撤回的记录。</p><button :disabled="busy || !canEdit || !selected || !views.find(view => view.id === selected)?.current" @click="teamAction('share')">将选中个人视图分享给审核团队</button><label>团队快照<select v-model="teamSelected" :disabled="busy"><option value="">请选择</option><option v-for="view in teamViews" :key="view.id" :value="view.id">{{ view.label }} · {{ view.owned ? '我分享的' : '团队快照' }} {{ view.current ? '' : '（模型已变化）' }}</option></select></label><button :disabled="busy || !teamViews.find(view => view.id === teamSelected)?.current" @click="teamAction('restore')">只读恢复团队快照</button><button :disabled="busy || !canEdit || !teamViews.find(view => view.id === teamSelected)?.owned" @click="teamAction('retract')">撤回我分享的快照</button><p v-if="error" role="alert">{{ error }}</p></details>
  <details v-if="canReview" class="saved-ontology-views"><summary>团队视图历史 · 已撤回与归档</summary><p>每页20条，只展示名称、修订与状态，不恢复已撤回布局。原分享人可归档自己的已撤回记录，记录保留而非删除，释放日常100条记录预算；归档区最多1000条。</p><label>历史记录<select v-model="historySelected" :disabled="busy"><option value="">请选择历史记录</option><option v-for="view in historyViews" :key="view.id" :value="view.id">{{ view.label }} · r{{ view.revision }} · {{ view.archivedAt ? '已归档' : '已撤回' }}{{ view.owned ? ' · 我分享的' : '' }}</option></select></label><button :disabled="busy || !canEdit || !historyViews.find(view => view.id === historySelected)?.owned || Boolean(historyViews.find(view => view.id === historySelected)?.archivedAt)" @click="archiveHistory">归档我已撤回的记录（保留历史）</button><button :disabled="busy || historyOffset === 0" @click="historyPage(Math.max(0, historyOffset - 20))">上一页</button><button :disabled="busy || historyOffset + 20 >= historyTotal" @click="historyPage(historyOffset + 20)">下一页</button><span>{{ historyTotal }} 条历史 · 第 {{ Math.floor(historyOffset / 20) + 1 }} 页</span><p v-if="error" role="alert">{{ error }}</p></details>
</template>
<style scoped>
.saved-ontology-views{padding:12px;border:1px solid #315764;border-radius:10px;background:#0a202b;color:#d7edef;margin:16px 0;min-width:0}.saved-ontology-views p{font-size:12px;line-height:1.8;color:#91b2bf}.saved-ontology-views summary{cursor:pointer;font-weight:600}.saved-ontology-views label{display:block}.saved-ontology-views input,.saved-ontology-views select,.saved-ontology-views button{background:#112f3c;border:1px solid #375f70;border-radius:7px;padding:9px;color:inherit;max-width:100%;box-sizing:border-box;margin:8px 8px 8px 0}.saved-ontology-views input[readonly]{width:100%}.saved-ontology-views button:disabled{opacity:.5}.saved-ontology-views :focus-visible{outline:2px solid #71e0c5}
</style>

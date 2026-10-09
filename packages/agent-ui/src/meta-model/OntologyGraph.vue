<script setup>
import { computed, ref, useId, watch } from 'vue';
import { buildOntologyGraph, filterOntologyGraph, findOntologyPath, validateOntologyLayout, buildOntologyEdgeGeometry, summarizeOntologySources } from './ontology-graph.js';
import { layoutOntologyGraph } from './ontology-edit-session.js';

const props = defineProps({ objects: { type: Array, default: () => [] }, relationships: { type: Array, default: () => [] }, diff: { type: Object, default: () => ({}) }, title: { type: String, default: '业务关系图' }, selectedId: { type: String, default: '' }, pathSelection: { type: Object, default: null }, savedLayout: { type: Object, default: null }, modelFingerprint: { type: String, default: '' }, layoutSaveEnabled: { type: Boolean, default: true }, compact: Boolean, askEnabled: { type: Boolean, default: true } });
const emit = defineEmits(['select-object', 'select-relationship', 'ask', 'save-layout']);
const markerId = `ontology-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
const query = ref(''); const system = ref(''); const focus = ref(''); const selected = ref(''); const selectedEdge = ref('');
const scale = ref(1); const offset = ref({ x: 0, y: 0 }); const positions = ref({}); const svg = ref(null);
const pathFrom = ref(''); const pathTo = ref(''); const pathRequested = ref(false);
const displayLimit = ref(100);
const overview = ref(false); const groupScope = ref(''); const crossingScope = ref(null);
const groupingMode = ref('source'); const domain = ref('');
const groupLimit = ref(40); const crossingLimit = ref(100);
let gesture = null;
const graph = computed(() => buildOntologyGraph(props.objects, props.relationships, props.diff));
const systems = computed(() => [...new Set(graph.value.nodes.flatMap(node => node.sourceSystems))].sort());
const domains = computed(() => [...new Set(graph.value.nodes.map(node => node.businessDomain || '未归类'))].sort());
const baseFiltered = computed(() => filterOntologyGraph(graph.value, { query: query.value, system: system.value, focus: focus.value, domain: domain.value }));
const sourceOverview = computed(() => summarizeOntologySources(baseFiltered.value, groupingMode.value));
const groupLabels = computed(() => new Map(sourceOverview.value.groups.map(group => [group.id, group.label])));
const filtered = computed(() => {
  const summary = sourceOverview.value;
  const crossing = crossingScope.value && summary.crossings.find(item => item.id === crossingScope.value);
  const ids = new Set(summary.groups.filter(group => groupScope.value ? group.id === groupScope.value : crossing && [crossing.from, crossing.to].includes(group.id)).flatMap(group => group.nodeIds));
  if (!groupScope.value && !crossingScope.value) return baseFiltered.value;
  const edges = crossing ? new Set(crossing.edgeIds) : null;
  return { nodes: baseFiltered.value.nodes.filter(node => ids.has(node.id)), edges: baseFiltered.value.edges.filter(edge => edges ? edges.has(edge.id) : ids.has(edge.from) && ids.has(edge.to)) };
});
const visible = computed(() => { const nodes = filtered.value.nodes.slice(0, displayLimit.value); const ids = new Set(nodes.map(node => node.id)); return { nodes, edges: filtered.value.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)) }; });
const columns = computed(() => Math.max(1, Math.min(4, Math.ceil(Math.sqrt(visible.value.nodes.length)))));
const width = computed(() => Math.max(680, columns.value * 260, ...Object.values(positions.value).map(point => point.x + 140), ...[...edgeGeometry.value.values()].map(item => item.maxX + 30)));
const height = computed(() => Math.max(300, Math.ceil(visible.value.nodes.length / columns.value) * 155 + 100, ...Object.values(positions.value).map(point => point.y + 100), ...[...edgeGeometry.value.values()].map(item => item.maxY + 30)));
const nodes = computed(() => visible.value.nodes.map((node, index) => ({ ...node, ...positions.value[node.id],
  x: positions.value[node.id]?.x ?? 140 + (index % columns.value) * 260,
  y: positions.value[node.id]?.y ?? 95 + Math.floor(index / columns.value) * 155 })));
const nodeIndex = computed(() => new Map(nodes.value.map(node => [node.id, node])));
const edgeGeometry = computed(() => buildOntologyEdgeGeometry(nodes.value, visible.value.edges));
const hiddenLabels = computed(() => [...edgeGeometry.value.values()].filter(item => !item.label).length);
const unresolvedRoutes = computed(() => [...edgeGeometry.value.values()].filter(item => item.routing === 'unresolved').length);
const leftMargin = computed(() => Math.max(0, ...[...edgeGeometry.value.values()].map(item => 30 - item.minX)));
const topMargin = computed(() => Math.max(40, ...[...edgeGeometry.value.values()].map(item => 30 - item.minY)));
const sourceCounts = computed(() => systems.value.map(name => ({ name, count: graph.value.nodes.filter(node => node.sourceSystems.includes(name)).length })));
const currentNode = computed(() => graph.value.nodes.find(node => node.id === selected.value));
const currentEdge = computed(() => graph.value.edges.find(edge => edge.id === selectedEdge.value));
const path = computed(() => pathRequested.value ? findOntologyPath(visible.value, pathFrom.value, pathTo.value) : null);
const changeLabel = value => ({ added: '新增', updated: '修改', removed: '删除', unchanged: '当前定义' }[value] || '当前定义');
const shorten = value => String(value).length > 19 ? `${String(value).slice(0, 18)}…` : value;
function selectNode(id) { selected.value = id; selectedEdge.value = ''; emit('select-object', id); }
function reset() { positions.value = {}; scale.value = 1; offset.value = { x: 0, y: 0 }; }
function arrange() { positions.value = layoutOntologyGraph(visible.value); scale.value = 1; offset.value = { x: 0, y: 0 }; }
function selectRelation(edge) { selectedEdge.value = edge.id; selected.value = ''; emit('select-relationship', { from: edge.from, predicate: edge.predicate, to: edge.to }); }
function clearScope() { groupScope.value = ''; crossingScope.value = null; pathRequested.value = false; }
function openGroup(id) { clearScope(); overview.value = false; groupScope.value = id; selected.value = ''; selectedEdge.value = ''; reset(); }
function openCrossing(id) { clearScope(); overview.value = false; crossingScope.value = id; selected.value = ''; selectedEdge.value = ''; reset(); }
function showOverview(mode = 'source') { groupingMode.value = mode === 'domain' ? 'domain' : 'source'; clearScope(); overview.value = true; selected.value = ''; selectedEdge.value = ''; }
function point(event) {
  const matrix = svg.value?.getScreenCTM();
  if (!matrix) return null;
  return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
}
function start(event, id = '') {
  if (event.button !== 0) return;
  const p = point(event); if (!p) return;
  if (id) selectNode(id);
  const node = id ? nodeIndex.value.get(id) : null;
  gesture = { id, x: p.x, y: p.y, origin: node ? { x: node.x, y: node.y } : { ...offset.value } };
  svg.value?.setPointerCapture(event.pointerId);
}
function move(event) {
  if (!gesture) return;
  const p = point(event); if (!p) return;
  const dx = p.x - gesture.x; const dy = p.y - gesture.y;
  if (gesture.id) positions.value = { ...positions.value, [gesture.id]: { x: Math.max(100, Math.min(width.value - 100, gesture.origin.x + dx / scale.value)), y: Math.max(45, Math.min(height.value - 45, gesture.origin.y + dy / scale.value)) } };
  else offset.value = { x: gesture.origin.x + dx, y: gesture.origin.y + dy };
}
watch(() => props.selectedId, id => {
  if (id) { overview.value = false; clearScope(); }
  selected.value = id;
  if (id && graph.value.nodes.some(node => node.id === id) && !visible.value.nodes.some(node => node.id === id)) {
    system.value = ''; focus.value = ''; query.value = ''; domain.value = '';
    if (graph.value.nodes.findIndex(node => node.id === id) >= displayLimit.value) query.value = id;
  }
}, { immediate: true });
watch(graph, value => { reset(); gesture = null; focus.value = ''; selectedEdge.value = ''; pathRequested.value = false;
  clearScope(); groupLimit.value = 40; crossingLimit.value = 100;
  if (!value.nodes.some(node => node.id === selected.value)) selected.value = '';
  if (!systems.value.includes(system.value)) system.value = '';
  if (!domains.value.includes(domain.value)) domain.value = '';
});
watch([query, system, focus, domain], () => {
  clearScope(); groupLimit.value = 40; crossingLimit.value = 100;
  reset(); pathRequested.value = false;
  if (!visible.value.nodes.some(node => node.id === selected.value)) selected.value = '';
  if (!visible.value.edges.some(edge => edge.id === selectedEdge.value)) selectedEdge.value = '';
}, { flush: 'sync' });
watch(() => props.pathSelection, value => { if (value) { overview.value = false; clearScope(); query.value = ''; system.value = ''; focus.value = ''; domain.value = ''; displayLimit.value = 500; pathFrom.value = value.from; pathTo.value = value.to; pathRequested.value = true; } }, { immediate: true });
watch([() => props.savedLayout, () => props.modelFingerprint], () => { const layout = validateOntologyLayout(props.savedLayout, graph.value.nodes.map(node => node.id), props.modelFingerprint); if (layout) { positions.value = layout.positions; scale.value = layout.scale; offset.value = layout.offset; } }, { immediate: true });
</script>

<template>
  <section :class="['ontology-graph', { compact }]" :aria-label="title">
    <header><div><b>{{ title }}</b><small>{{ overview ? baseFiltered.nodes.length : visible.nodes.length }}/{{ graph.nodes.length }} 个对象 · {{ overview ? baseFiltered.edges.length : visible.edges.length }} 条关系</small></div><div v-if="!overview" class="graph-controls"><button @click="scale = Math.max(.5, scale - .15)" aria-label="缩小关系图">−</button><button @click="scale = Math.min(2.5, scale + .15)" aria-label="放大关系图">＋</button><button @click="arrange">按关联自动布局</button><button @click="reset">复位</button><button v-if="modelFingerprint && layoutSaveEnabled" @click="emit('save-layout', { fingerprint: modelFingerprint, positions: { ...positions }, scale, offset: { ...offset } })">保存本次会话布局</button></div></header>
    <div class="graph-view-switch"><button :aria-pressed="overview && groupingMode === 'source'" @click="showOverview('source')">来源分组总览</button><button :aria-pressed="overview && groupingMode === 'domain'" @click="showOverview('domain')">业务域总览</button><button :aria-pressed="!overview" @click="overview = false; clearScope()">对象关系图</button><small>业务域由人工明确归类，不从来源推断；分组不改变业务关系。</small></div>
    <div class="graph-filters"><label>找对象<input v-model="query" placeholder="名称、编号或来源" /></label><label>来源系统<select v-model="system"><option value="">全部来源</option><option v-for="item in systems" :key="item">{{ item }}</option></select></label><button v-if="selected && !focus" @click="focus = selected">只看所选对象及邻居</button><button v-if="focus" @click="focus = ''">显示全部对象</button></div>
    <div v-if="!overview" class="graph-legend"><span>拖动对象调整布局，拖动画布移动视图；点击节点或连线查看详情。</span><span v-if="diff.objectChanges?.length || diff.relationshipChanges?.length"><i class="added"/>新增 <i class="updated"/>修改 <i class="removed"/>删除</span></div>
    <details v-if="sourceCounts.length > 1" class="graph-path"><summary>按来源系统缩小范围（多来源对象会重复计数）</summary><div><button :aria-pressed="!system" @click="system = ''">全部来源</button><button v-for="item in sourceCounts" :key="item.name" :aria-pressed="system === item.name" @click="system = item.name">{{ item.name }} · {{ item.count }} 个对象</button></div><small>只筛选显示，不合并对象、不生成跨系统关联；跨系统路径请切回全部来源。</small></details>
    <div class="graph-filters"><label>业务域<select v-model="domain"><option value="">全部业务域</option><option v-for="item in domains" :key="item">{{ item }}</option></select></label><small>未归类对象不会按来源自动分配业务域。</small></div>
    <section v-if="overview" class="source-overview" :aria-label="groupingMode === 'domain' ? '业务域总览' : '来源分组总览'">
      <p>当前筛选包含 {{ sourceOverview.groups.length }} 个{{ groupingMode === 'domain' ? '业务域' : '来源组合' }}。下方箭头仅汇总已声明的直接关系，不表示系统接口、因果或可执行链路。</p>
      <div class="source-group-grid"><article v-for="group in sourceOverview.groups.slice(0, groupLimit)" :key="group.id"><b>{{ group.label }}</b><small>{{ group.nodeIds.length }} 个对象 · 组内 {{ group.internalCurrent }} 条关系<span v-if="group.internalRemoved"> · {{ group.internalRemoved }} 条待删除关系</span></small><button @click="openGroup(group.id)">展开组内对象</button></article></div>
      <button v-if="sourceOverview.groups.length > groupLimit" @click="groupLimit += 40">加载更多分组（已显示 {{ groupLimit }}/{{ sourceOverview.groups.length }}）</button>
      <h4>组间原始关系</h4><div class="source-crossings"><button v-for="crossing in sourceOverview.crossings.slice(0, crossingLimit)" :key="crossing.id" :class="{ 'removed-crossing': crossing.removed }" @click="openCrossing(crossing.id)"><span>{{ groupLabels.get(crossing.from) }} → {{ groupLabels.get(crossing.to) }}</span><small>{{ crossing.edgeIds.length }} 条{{ crossing.removed ? '待删除' : '已声明' }}关系 · 查看原始关系</small></button></div>
      <button v-if="sourceOverview.crossings.length > crossingLimit" @click="crossingLimit += 100">加载更多组间关系（已显示 {{ crossingLimit }}/{{ sourceOverview.crossings.length }}）</button>
      <p v-if="!sourceOverview.crossings.length">当前筛选没有组间直接关系。组内关系请展开对象查看。</p>
    </section>
    <p v-if="!overview && (groupScope || crossingScope)" class="graph-density-note">{{ groupScope ? '当前仅展示该来源组合的对象与组内关系，跨组关系已隐藏。' : '当前仅展示所选方向的原始组间关系，其他关系已隐藏。' }} <button @click="clearScope">恢复当前筛选的全部关系</button><button @click="showOverview">返回分组总览</button></p>
    <p v-if="!overview && hiddenLabels" class="graph-density-note">{{ hiddenLabels }} 条关系的文字因画面拥挤已收起，连线仍保留；点击或用键盘选中连线查看完整含义。</p>
    <p v-if="!overview && filtered.nodes.length > visible.nodes.length">当前显示前 {{ visible.nodes.length }} 个对象，请搜索或按来源缩小范围。<button @click="displayLimit = Math.min(500, filtered.nodes.length)" :disabled="displayLimit >= 500">扩大显示范围（最多500）</button></p>
    <p v-if="!overview && unresolvedRoutes" role="status">{{ unresolvedRoutes }} 条连线未找到无对象遮挡的绕行路径，可调整布局或通过下方关系列表查看；不保证连线间无交叉。</p>
    <details v-if="!overview && visible.edges.length" class="graph-path"><summary>原始关系列表（可直接选择）</summary><div><button v-for="edge in visible.edges" :key="edge.id" @click="selectRelation(edge)">{{ edge.from }} → {{ edge.to }} · {{ edge.label }} · {{ changeLabel(edge.change) }}</button></div></details>
    <div v-if="!overview" class="graph-content">
      <div class="graph-canvas"><svg v-if="nodes.length" ref="svg" :viewBox="`${-leftMargin} ${-topMargin} ${width + leftMargin} ${height + topMargin}`" role="group" :aria-label="title" @pointerdown.self="start($event)" @pointermove="move" @pointerup="gesture = null" @pointercancel="gesture = null" @lostpointercapture="gesture = null">
        <defs><marker :id="markerId" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L0,8 L8,4 z" fill="#69b7bb"/></marker></defs>
        <g :transform="`translate(${offset.x} ${offset.y}) scale(${scale})`">
          <g v-for="edge in visible.edges" :key="edge.id" :class="['graph-edge', edge.change, { highlighted: path?.edges.includes(edge.id), selected: selectedEdge === edge.id }]" tabindex="0" role="button" :aria-label="`${edge.from} ${edge.label} ${edge.to}，${edge.cardinality}`" @click="selectRelation(edge)" @keydown.enter="selectRelation(edge)" @keydown.space.prevent="selectRelation(edge)">
            <title>{{ edge.label }} · {{ edge.cardinality }}</title><path class="edge-hit" :d="edgeGeometry.get(edge.id)?.path"/><path :d="edgeGeometry.get(edge.id)?.path" :marker-end="`url(#${markerId})`"/><text v-if="edgeGeometry.get(edge.id)?.label" :x="edgeGeometry.get(edge.id).label.x" :y="edgeGeometry.get(edge.id).label.y" text-anchor="middle" dominant-baseline="middle">{{ shorten(edge.label) }} · {{ shorten(edge.cardinality) }}</text>
          </g>
          <g v-for="node in nodes" :key="node.id" :class="['graph-node', node.change, { selected: selected === node.id, highlighted: path?.nodes.includes(node.id) }]" role="button" tabindex="0" :aria-label="`${node.label}，${changeLabel(node.change)}`" @pointerdown.stop="start($event, node.id)" @keydown.enter="selectNode(node.id)" @keydown.space.prevent="selectNode(node.id)">
            <rect :x="node.x - 95" :y="node.y - 38" width="190" height="76" rx="12"/><text :x="node.x" :y="node.y - 9" text-anchor="middle">{{ shorten(node.label) }}</text><text :x="node.x" :y="node.y + 13" class="node-caption" text-anchor="middle">{{ shorten(node.sourceSystems.join(' / ') || '来源待确认') }}</text><text v-if="node.change !== 'unchanged'" :x="node.x" :y="node.y + 29" class="node-caption" text-anchor="middle">{{ changeLabel(node.change) }}</text>
          </g>
        </g>
      </svg><p v-else class="graph-empty">{{ graph.nodes.length ? '当前筛选没有匹配对象，请调整条件。' : '暂无模型对象。可先向 Agent 描述业务场景。' }}</p></div>
      <aside v-if="currentNode || currentEdge" class="graph-inspector">
        <template v-if="currentNode"><small>业务对象 · {{ changeLabel(currentNode.change) }}</small><h3>{{ currentNode.label }}</h3><p>{{ currentNode.description || '业务含义尚待补充。' }}</p><p>来源：{{ currentNode.sourceSystems.join(' / ') || '待确认' }}</p><details><summary>字段与标识</summary><small>{{ currentNode.id }} · 主键 {{ currentNode.key || '待确认' }}</small><ul><li v-for="field in currentNode.fields" :key="typeof field === 'string' ? field : field.name">{{ typeof field === 'string' ? field : field.name }}</li></ul></details><button v-if="askEnabled" @click="emit('ask', `请解释“${currentNode.label}”的业务含义、关联关系及来源依据。`)">向 Agent 提问</button></template>
        <template v-else-if="currentEdge"><small>业务关系 · {{ changeLabel(currentEdge.change) }}</small><h3>{{ currentEdge.label }}</h3><p>{{ graph.nodes.find(node => node.id === currentEdge.from)?.label }} → {{ graph.nodes.find(node => node.id === currentEdge.to)?.label }}</p><p>基数：{{ currentEdge.cardinality }}</p><p>{{ currentEdge.evidence || '关系依据尚待核对。' }}</p><details v-if="currentEdge.before || currentEdge.after"><summary>修改前 / 修改后</summary><p>修改前：{{ currentEdge.before ? JSON.stringify(currentEdge.before) : '不存在' }}</p><p>修改后：{{ currentEdge.after ? JSON.stringify(currentEdge.after) : '移除' }}</p></details><button v-if="askEnabled" @click="emit('ask', `请解释“${currentEdge.from} ${currentEdge.label} ${currentEdge.to}”关系的基数和来源依据。`)">向 Agent 提问</button></template>
      </aside>
    </div>
    <details v-if="!overview" class="graph-path"><summary>查看两个对象之间的有向关联路径</summary><div><label>起点<select v-model="pathFrom"><option value="">请选择</option><option v-for="node in visible.nodes" :key="node.id" :value="node.id">{{ node.label }}</option></select></label><label>终点<select v-model="pathTo"><option value="">请选择</option><option v-for="node in visible.nodes" :key="node.id" :value="node.id">{{ node.label }}</option></select></label><button :disabled="!pathFrom || !pathTo" @click="pathRequested = true">高亮路径</button></div><p v-if="pathRequested">{{ path ? path.nodes.map(id => graph.nodes.find(node => node.id === id)?.label).join(' → ') : '当前显示范围内没有该方向的已声明路径。' }}</p><small>路径说明模型结构，实际影响范围需读取业务数据。</small></details>
  </section>
</template>

<style scoped>
.graph-view-switch{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}.graph-view-switch button[aria-pressed=true]{border-color:#71e0c5;background:#19594f}.source-overview{border:1px solid #315764;border-radius:9px;padding:12px;font-size:12px}.source-overview p{line-height:1.7;color:#91b2bf}.source-group-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:10px}.source-group-grid article{display:grid;gap:10px;padding:12px;border:1px solid #375f70;border-radius:9px;background:#112f3c;overflow-wrap:anywhere}.source-crossings{display:grid;gap:8px}.source-crossings button{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;text-align:left;overflow-wrap:anywhere}.source-crossings .removed-crossing{border-style:dashed;border-color:#ee929c}.source-overview>button{margin-top:10px}
.ontology-graph{min-width:0;border:1px solid #315764;border-radius:12px;background:#0a202b;color:#d7edef;padding:14px}.ontology-graph header,.graph-controls,.graph-filters,.graph-legend,.graph-path>div{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ontology-graph header{justify-content:space-between}.ontology-graph header>div:first-child{display:grid;gap:5px}.ontology-graph small,.graph-legend{font-size:11px;color:#91b2bf}.ontology-graph button,.ontology-graph input,.ontology-graph select{font:inherit;color:inherit;background:#112f3c;border:1px solid #375f70;border-radius:7px;padding:8px;min-height:36px;max-width:100%;box-sizing:border-box}.ontology-graph button{cursor:pointer}.ontology-graph button:disabled{opacity:.5;cursor:not-allowed}.ontology-graph :focus-visible{outline:2px solid #71e0c5;outline-offset:3px}.graph-filters{margin:12px 0}.graph-filters label,.graph-path label{display:grid;gap:4px;font-size:11px}.graph-legend{justify-content:space-between;margin:8px 0}.graph-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin:0 4px}.graph-legend .added{background:#58dbc0}.graph-legend .updated{background:#f5c468}.graph-legend .removed{background:#ee929c}.graph-content{display:flex;gap:12px;align-items:stretch}.graph-canvas{min-width:0;flex:1;border:1px solid #26434f;background:radial-gradient(#24434e 1px,transparent 1px);background-size:18px 18px;border-radius:9px;overflow:hidden}.graph-canvas svg{display:block;width:100%;height:450px;touch-action:none;cursor:grab}.compact .graph-canvas svg{height:310px}.graph-edge{cursor:pointer}.graph-edge path{fill:none;stroke:#69b7bb;stroke-width:1.8}.graph-edge .edge-hit{stroke:transparent;stroke-width:16}.graph-edge text{fill:#9dc6cf;font-size:11px;paint-order:stroke;stroke:#0a202b;stroke-width:4px}.graph-node{cursor:grab}.graph-node rect{fill:#123643;stroke:#458a94;stroke-width:1.8}.graph-node text{fill:#e4f6f4;font-size:14px;pointer-events:none}.graph-node .node-caption{fill:#8fbdc5;font-size:10px}.graph-node.added rect{stroke:#58dbc0}.graph-node.updated rect{stroke:#f5c468}.graph-node.removed rect{stroke:#ee929c;stroke-dasharray:6 4}.graph-edge.added path:not(.edge-hit){stroke:#58dbc0}.graph-edge.updated path:not(.edge-hit){stroke:#f5c468}.graph-edge.removed path:not(.edge-hit){stroke:#ee929c;stroke-dasharray:6 4}.graph-node.selected rect,.graph-node.highlighted rect{fill:#19594f;stroke:#8aefd1;stroke-width:3}.graph-edge.selected path:not(.edge-hit),.graph-edge.highlighted path:not(.edge-hit){stroke:#8aefd1;stroke-width:3}.graph-empty{padding:40px 20px;text-align:center;color:#91b2bf}.graph-inspector{width:220px;flex-shrink:0;padding:12px;border:1px solid #315764;border-radius:9px;overflow-wrap:anywhere}.graph-inspector h3{margin:10px 0;font-size:16px}.graph-inspector p{font-size:12px;line-height:1.8}.graph-inspector ul{padding-left:18px}.graph-inspector button{margin-top:12px}.graph-path{margin-top:12px;font-size:12px}.graph-path summary{cursor:pointer;color:#a8c9d0}.graph-path>div{margin:10px 0}.graph-inspector details{font-size:12px}@media(max-width:800px){.graph-content{flex-direction:column}.graph-inspector{width:auto}.graph-canvas svg{height:350px}.graph-filters label{flex:1;min-width:120px}.ontology-graph{padding:10px}}
</style>

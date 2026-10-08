<script setup>
import { computed, onMounted, ref } from 'vue';

const props = defineProps({
  client: { type: Object, required: true },
  canSync: { type: Boolean, default: false },
  canPublish: { type: Boolean, default: false },
  canReplay: { type: Boolean, default: false }
});

const overview = ref(null);
const detail = ref(null);
const selectedCode = ref('');
const category = ref('all');
const processType = ref('all');
const loading = ref(true);
const detailLoading = ref(false);
const syncing = ref(false);
const reviewing = ref(false);
const message = ref('');
const error = ref('');

const definitions = computed(() => (overview.value?.definitions || []).filter(item =>
  (category.value === 'all' || item.category === category.value)
  && (processType.value === 'all' || item.processType === processType.value)));
const processTypes = computed(() => [...new Map((overview.value?.definitions || []).map(item => [item.processType, item.processTypeLabel])).entries()].map(([id, label]) => ({ id, label })));
const latest = computed(() => detail.value?.definition || null);
const nodeById = computed(() => new Map((latest.value?.nodes || []).map(node => [node.id, node])));
const categoryLabel = value => ({ management: '管理流程', business: '业务流程', hybrid: '混合流程' })[value] || value;
const processTypeLabel = value => ({ internal_affairs: '内部事务', procurement: '采购供应', production_manufacturing: '生产制造', logistics: '物流履约', quality: '质量管理', sales: '销售履约', finance: '财务管理' })[value] || value;
const statusLabel = value => ({ published: '已发布', candidate: '候选版本', rejected: '已拒绝', review_required: '待校对', approved: '已批准' })[value] || value;
const providerLabel = value => ({ dingtalk: '钉钉审批', oa: 'OA / BPM' })[value] || value;
const displayTime = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '—';

async function loadOverview(preserveSelection = true) {
  loading.value = true;
  error.value = '';
  try {
    overview.value = await props.client.workflowOverview();
    const codes = overview.value.definitions?.map(item => item.code) || [];
    if (!preserveSelection || !codes.includes(selectedCode.value)) selectedCode.value = codes[0] || '';
    if (selectedCode.value) await loadDetail(selectedCode.value);
  } catch (err) { error.value = err.message || '流程语义中心加载失败。'; }
  finally { loading.value = false; }
}

async function loadDetail(code) {
  selectedCode.value = code;
  detailLoading.value = true;
  error.value = '';
  try { detail.value = await props.client.workflowDefinition(code); }
  catch (err) { error.value = err.message || '流程定义读取失败。'; }
  finally { detailLoading.value = false; }
}

async function sync(scenario, mode = 'mock') {
  if (!props.canSync || syncing.value) return;
  syncing.value = true; error.value = ''; message.value = '';
  try {
    const result = await props.client.syncWorkflows(mode === 'configured' ? { mode } : { scenario });
    const run = result.syncRun;
    message.value = `手动同步完成：新增 ${run.discovered}，变化 ${run.changed}，未变化 ${run.unchanged}；候选变更不会自动进入智脑。`;
    await loadOverview();
  } catch (err) { error.value = err.message || '流程同步失败。'; }
  finally { syncing.value = false; }
}

async function review(action) {
  if (!props.canPublish || !latest.value || reviewing.value) return;
  reviewing.value = true; error.value = ''; message.value = '';
  try {
    await props.client.reviewWorkflowVersion(selectedCode.value, latest.value.version, action);
    message.value = action === 'publish' ? `流程 ${selectedCode.value} v${latest.value.version} 已发布给智脑只读能力。` : `候选版本 v${latest.value.version} 已拒绝，现有发布版本保持不变。`;
    await loadOverview();
  } catch (err) { error.value = err.message || '流程版本校对失败。'; }
  finally { reviewing.value = false; }
}

async function replayEvent(eventId) {
  if (!props.canReplay || reviewing.value) return;
  reviewing.value = true; error.value = ''; message.value = '';
  try {
    await props.client.replayWorkflowEvent(eventId);
    message.value = `失败事件 ${eventId} 已重新入队，Worker 将重新执行受控拉取。`;
    await loadOverview();
  } catch (err) { error.value = err.message || '流程通知重新入队失败。'; }
  finally { reviewing.value = false; }
}

onMounted(() => loadOverview(false));
</script>

<template>
  <div class="workflow-center">
    <section class="workflow-hero">
      <div><span>WORKFLOW SEMANTIC INTEGRATION</span><h2>流程语义中心</h2><p>持续读取钉钉和 OA 的流程定义、表单、节点及运行实例。结构事实由连接器确定性解析，AI只提出语义映射建议。</p></div>
      <div class="workflow-boundary"><b>只读边界</b><small>新增或变化先进入候选区</small><small>不会自动提交、审批或撤回</small></div>
    </section>

    <div v-if="error" class="workflow-alert error">{{ error }}<button @click="loadOverview()">重试</button></div>
    <div v-if="message" class="workflow-alert success">{{ message }}</div>
    <div v-if="loading" class="workflow-loading">正在读取流程目录、版本和同步状态…</div>

    <template v-else>
      <section class="workflow-metrics">
        <article><span>流程定义</span><b>{{ overview?.metrics?.definitions || 0 }}</b><small>统一目录</small></article>
        <article><span>已发布</span><b>{{ overview?.metrics?.published || 0 }}</b><small>智脑可读取</small></article>
        <article class="attention"><span>待人工校对</span><b>{{ overview?.metrics?.reviewRequired || 0 }}</b><small>不会自动生效</small></article>
        <article><span>跨系统流程</span><b>{{ overview?.metrics?.crossSystemDefinitions || 0 }}</b><small>{{ overview?.metrics?.runningInstances || 0 }} 个运行实例</small></article>
      </section>

      <section class="workflow-syncbar">
        <div><b>定义发现与对账</b><small>最后同步 {{ displayTime(overview?.lastSyncAt) }} · 实时事件 + {{ overview?.syncPolicy?.scheduled?.intervalSeconds || 300 }} 秒定时对账 + 人工立即同步</small></div>
        <div><button :disabled="!canSync || syncing" @click="sync('baseline')">{{ syncing ? '同步中…' : '立即手动同步 Mock' }}</button><button class="configured" :disabled="!canSync || syncing" @click="sync(null, 'configured')">立即同步真实连接器</button><button class="simulate" :disabled="!canSync || syncing" @click="sync('changed')">模拟流程新增与更新</button></div>
      </section>

      <section class="sync-modes">
        <article><span>REALTIME</span><b>实时事件同步</b><small>{{ overview?.syncPolicy?.realTime?.description }}</small></article>
        <article><span>SCHEDULED</span><b>定时增量对账</b><small>{{ overview?.syncPolicy?.scheduled?.description }}</small></article>
        <article><span>MANUAL</span><b>人工立即同步</b><small>{{ overview?.syncPolicy?.manual?.description }}</small></article>
      </section>

      <section class="workflow-event-status" :class="{ attention: overview?.webhookInbox?.deadLetter }">
        <div><span>EVENT INBOX</span><b>流程变更通知</b><small>待处理 {{ overview?.webhookInbox?.pending || 0 }} · 处理中 {{ overview?.webhookInbox?.processing || 0 }} · 死信 {{ overview?.webhookInbox?.deadLetter || 0 }}</small></div>
        <div v-if="overview?.webhookInbox?.recentDeadLetters?.length" class="dead-letter-list"><article v-for="event in overview.webhookInbox.recentDeadLetters" :key="event.id"><span>{{ event.providerId }} · {{ event.eventType }}</span><small>{{ event.errorCode }} · 已尝试 {{ event.attempts }} 次</small><button :disabled="!canReplay || reviewing" @click="replayEvent(event.id)">重新入队</button></article></div>
        <small v-else>签名通知只触发重新拉取，不直接采信回调正文中的业务事实。</small>
      </section>

      <div class="workflow-layout">
        <aside class="workflow-catalog">
          <div class="catalog-filter"><button v-for="item in [{id:'all',label:'全部'},{id:'management',label:'管理'},{id:'business',label:'业务'},{id:'hybrid',label:'混合'}]" :key="item.id" :class="{active:category===item.id}" @click="category=item.id">{{ item.label }}</button></div>
          <div class="process-filter"><button :class="{active:processType==='all'}" @click="processType='all'">全部类别</button><button v-for="item in processTypes" :key="item.id" :class="{active:processType===item.id}" @click="processType=item.id">{{ item.label }}</button></div>
          <button v-for="item in definitions" :key="item.code" class="catalog-item" :class="{ active: selectedCode === item.code, changed: item.changed }" @click="loadDetail(item.code)">
            <span><i>{{ providerLabel(item.provider) }}</i><em>{{ item.processTypeLabel || processTypeLabel(item.processType) }}</em></span>
            <b>{{ item.name }}</b><small>{{ item.code }} · 生效 v{{ item.activeVersion || '—' }} · 最新 v{{ item.latestVersion }}</small>
            <footer><span>{{ item.nodeCount }} 节点 · {{ item.systems?.length || 1 }} 系统</span><strong>{{ item.changed ? '有待审变更' : statusLabel(item.publicationStatus) }}</strong></footer>
          </button>
          <p v-if="!definitions.length">当前分类没有流程。</p>
        </aside>

        <main v-if="latest" class="workflow-detail" :aria-busy="detailLoading">
          <header>
            <div><span>{{ providerLabel(latest.provider) }} · {{ categoryLabel(latest.category) }} · {{ processTypeLabel(latest.processType) }}</span><h3>{{ latest.name }}</h3><p>{{ latest.purpose }}</p></div>
            <div class="version-badge" :class="latest.publicationStatus"><b>v{{ latest.version }}</b><small>{{ statusLabel(latest.reviewStatus) }}</small></div>
          </header>

          <section v-if="latest.publicationStatus === 'candidate'" class="change-review">
            <div><span>版本影响分析</span><b>{{ latest.diff?.summary }}</b><ul><li v-for="change in latest.diff?.changes" :key="change">{{ change }}</li></ul></div>
            <div><strong :class="{ breaking: latest.diff?.breaking }">{{ latest.diff?.breaking ? '破坏性变更' : '兼容性变更' }}</strong><small>当前 v{{ detail.activeVersion }} 仍为智脑生效版本</small><div><button :disabled="!canPublish || reviewing" @click="review('reject')">拒绝候选</button><button class="publish" :disabled="!canPublish || reviewing || latest.validation?.status !== 'passed'" @click="review('publish')">校验通过并发布</button></div></div>
          </section>

          <section class="workflow-facts">
            <div><span>业务域</span><b>{{ latest.businessDomain }}</b></div><div><span>风险等级</span><b>{{ latest.riskLevel }}</b></div><div><span>数据分级</span><b>{{ latest.dataClassification }}</b></div><div><span>来源证据</span><b>{{ latest.sourceId }} / v{{ latest.version }}</b></div>
          </section>

          <section class="cross-system-route">
            <div class="section-title"><div><span>CROSS-SYSTEM ORCHESTRATION</span><h4>跨系统流程链路</h4></div><small>展示交接触发条件与语义业务键</small></div>
            <div class="system-chain"><template v-for="(system,index) in latest.systems || [latest.provider]" :key="system"><b>{{ system.toUpperCase() }}</b><i v-if="index < (latest.systems?.length || 1) - 1">→</i></template></div>
            <div class="handoff-grid"><article v-for="handoff in latest.crossSystemHandoffs || []" :key="`${handoff.fromSystem}-${handoff.toSystem}-${handoff.semanticKey}`"><span>{{ handoff.fromSystem.toUpperCase() }} → {{ handoff.toSystem.toUpperCase() }}</span><b>{{ handoff.trigger }}</b><small>{{ handoff.objectType }}.{{ handoff.semanticKey }}</small></article></div>
            <p v-if="!latest.crossSystemHandoffs?.length">当前流程未声明跨系统交接。</p>
          </section>

          <section class="workflow-graph">
            <div class="section-title"><div><span>DETERMINISTIC PROCESS GRAPH</span><h4>流程结构</h4></div><small>节点、条件和审批人规则来自源流程，不由模型猜测</small></div>
            <div class="graph-scroll"><div v-for="(node,index) in latest.nodes" :key="node.id" class="graph-node" :class="node.type"><i>{{ index + 1 }}</i><span>{{ node.systemId?.toUpperCase() || node.type }}</span><b>{{ node.label }}</b><small>{{ node.actorRule || node.expression || '结构节点' }}</small><div v-if="index < latest.nodes.length - 1">→</div></div></div>
            <details><summary>查看 {{ latest.edges.length }} 条确定性流转关系</summary><ul><li v-for="edge in latest.edges" :key="`${edge.from}-${edge.to}-${edge.condition}`"><b>{{ nodeById.get(edge.from)?.label }}</b> → <b>{{ nodeById.get(edge.to)?.label }}</b><code v-if="edge.condition">{{ edge.condition }}</code></li></ul></details>
          </section>

          <section class="workflow-mapping">
            <div class="section-title"><div><span>FORM TO WORLD MODEL</span><h4>表单语义映射</h4></div><small>字段结构可自动读取，语义关联需校验后发布</small></div>
            <div class="mapping-table"><div class="mapping-head"><span>源字段</span><span>类型</span><span>世界模型目标</span><span>数据分级</span></div><div v-for="field in latest.fields" :key="field.id" class="mapping-row"><span><b>{{ field.label }}</b><small>{{ field.id }}{{ field.required ? ' · 必填' : '' }}</small></span><code>{{ field.type }}</code><strong>{{ field.semanticTarget }}</strong><em>{{ field.sensitivity }}</em></div></div>
          </section>

          <section class="workflow-instances">
            <div class="section-title"><div><span>RUNTIME PROJECTION</span><h4>运行实例</h4></div><small>来源系统仍是事实权威，本系统只保存可追溯投影</small></div>
            <article v-for="instance in detail.instances" :key="instance.id">
              <div><span>{{ instance.status }}</span><b>{{ instance.title }}</b><small>{{ instance.id }} · 业务键 {{ instance.businessKey }}</small></div>
              <p>{{ instance.summary }}</p>
              <div><b>当前节点</b><span>{{ latest.nodes.find(node => node.id === instance.currentNodeId)?.label || instance.currentNodeId }}</span><small>{{ displayTime(instance.updatedAt) }}</small></div>
              <details v-if="instance.timeline?.length" class="runtime-timeline"><summary>查看 {{ instance.timeline.length }} 条流转记录</summary><ol><li v-for="event in instance.timeline" :key="event.id"><time>{{ displayTime(event.occurredAt) }}</time><b>{{ event.label }}</b><span>{{ event.actorDisplay || '系统' }}</span></li></ol></details>
            </article>
            <p v-if="!detail.instances?.length">当前流程暂无可见运行实例。</p>
          </section>
        </main>
      </div>
    </template>
  </div>
</template>

<style scoped>
.workflow-center{display:grid;gap:16px;color:#cfe3e9}.workflow-hero,.workflow-syncbar,.workflow-metrics article,.workflow-catalog,.workflow-detail{border:1px solid #294e60;background:#091e2b}.workflow-hero{display:flex;justify-content:space-between;gap:24px;padding:22px;border-radius:12px}.workflow-hero span,.section-title span{color:#55c8ce;font-size:9px;letter-spacing:.14em}.workflow-hero h2{margin:5px 0 7px;font-size:22px}.workflow-hero p{max-width:820px;margin:0;color:#83a5b1;font-size:11px;line-height:1.7}.workflow-boundary{display:grid;align-content:center;gap:4px;min-width:210px;padding:14px;border:1px solid #326273;border-radius:8px;background:#0c2a38}.workflow-boundary b{color:#62d5b9}.workflow-boundary small{color:#82a7b1}.workflow-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.workflow-metrics article{display:grid;gap:3px;padding:14px 16px;border-radius:8px}.workflow-metrics span,.workflow-metrics small{color:#7196a4;font-size:9px}.workflow-metrics b{color:#66dac2;font-size:23px}.workflow-metrics .attention{border-color:#815e2c}.workflow-metrics .attention b{color:#efb95d}.workflow-syncbar{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:13px 16px;border-radius:8px}.workflow-syncbar div:first-child{display:grid;gap:3px}.workflow-syncbar small{color:#7194a0;font-size:9px}.workflow-syncbar div:last-child{display:flex;gap:8px}.workflow-syncbar button,.change-review button,.workflow-alert button{border:1px solid #3a7883;border-radius:6px;padding:8px 11px;color:#bde7e6;background:#123543;cursor:pointer}.workflow-syncbar button.simulate{border-color:#83622f;color:#f0c77e;background:#322817}.workflow-syncbar button:disabled,.change-review button:disabled{opacity:.4;cursor:not-allowed}.workflow-layout{display:grid;grid-template-columns:310px minmax(0,1fr);gap:14px;align-items:start}.workflow-catalog{display:grid;gap:8px;padding:12px;border-radius:10px}.catalog-filter{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}.catalog-filter button{border:1px solid #284c5e;border-radius:5px;padding:6px;color:#7499a5;background:#0b2532;font-size:9px}.catalog-filter button.active{border-color:#55c9ad;color:#d8f7ef;background:#174238}.catalog-item{display:grid;gap:6px;width:100%;padding:12px;border:1px solid #294c5d;border-radius:8px;text-align:left;color:#b9d1d8;background:#0a2432;cursor:pointer}.catalog-item:hover,.catalog-item.active{border-color:#59b9bd;background:#0e3040}.catalog-item.changed{border-left:3px solid #e7a94c}.catalog-item>span,.catalog-item footer{display:flex;justify-content:space-between;align-items:center}.catalog-item i,.catalog-item em{font-size:8px;font-style:normal;color:#64bfc5}.catalog-item em{color:#8ba6b0}.catalog-item small{font-size:8px;color:#698d9b}.catalog-item footer span,.catalog-item footer strong{font-size:8px;color:#799ca8}.catalog-item footer strong{color:#62d5b9}.catalog-item.changed footer strong{color:#efb95d}.workflow-detail{display:grid;gap:14px;min-width:0;padding:18px;border-radius:10px}.workflow-detail>header{display:flex;justify-content:space-between;gap:20px}.workflow-detail header>div:first-child>span{color:#55c8ce;font-size:9px}.workflow-detail h3{margin:5px 0;font-size:20px}.workflow-detail header p{margin:0;color:#83a4af;font-size:10px;line-height:1.6}.version-badge{display:grid;place-items:center;min-width:84px;padding:9px;border:1px solid #377063;border-radius:8px;background:#102e30}.version-badge.candidate{border-color:#80602e;background:#2d2518}.version-badge b{font-size:18px}.version-badge small{font-size:8px;color:#82a6ad}.change-review{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;padding:14px;border:1px solid #86612c;border-radius:8px;background:#2a2114}.change-review>div{display:grid;gap:5px}.change-review span,.change-review small{color:#c49d61;font-size:9px}.change-review b{font-size:12px}.change-review ul{margin:4px 0 0;padding-left:17px;color:#d5b882;font-size:9px}.change-review>div:last-child{justify-items:end}.change-review strong{color:#73cfb1;font-size:10px}.change-review strong.breaking{color:#efad52}.change-review>div:last-child>div{display:flex;gap:7px}.change-review button.publish{border-color:#59c6a9;color:#d9fff4;background:#174538}.workflow-facts{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.workflow-facts div{display:grid;gap:4px;padding:10px;border:1px solid #284b5c;border-radius:7px;background:#0b2634}.workflow-facts span{color:#6f939f;font-size:8px}.workflow-facts b{font-size:10px;overflow-wrap:anywhere}.workflow-graph,.workflow-mapping,.workflow-instances{display:grid;gap:10px;padding:14px;border:1px solid #294b5b;border-radius:8px;background:#081b27}.section-title{display:flex;justify-content:space-between;align-items:end;gap:12px}.section-title h4{margin:3px 0 0;font-size:14px}.section-title>small{color:#6c8e9a;font-size:8px}.graph-scroll{display:flex;gap:20px;overflow-x:auto;padding:5px 2px 12px}.graph-node{position:relative;display:grid;gap:3px;min-width:145px;padding:11px;border:1px solid #31576a;border-radius:7px;background:#0d2b3a}.graph-node.condition{border-color:#80622e}.graph-node.approval{border-color:#3d7b70}.graph-node i{position:absolute;right:8px;top:7px;color:#577d8c;font-size:8px;font-style:normal}.graph-node span{color:#5fc5ca;font-size:7px;text-transform:uppercase}.graph-node b{font-size:10px}.graph-node small{color:#73939f;font-size:8px;overflow-wrap:anywhere}.graph-node>div{position:absolute;right:-16px;top:29px;color:#4b7888}.workflow-graph details{color:#83a6b2;font-size:9px}.workflow-graph details ul{display:grid;gap:5px;padding-left:18px}.workflow-graph code{margin-left:8px;color:#f0bd67}.mapping-table{display:grid;border:1px solid #294c5e;border-radius:7px;overflow:hidden}.mapping-head,.mapping-row{display:grid;grid-template-columns:1.1fr .55fr 1.25fr .7fr;gap:10px;align-items:center;padding:9px 11px}.mapping-head{color:#7095a1;background:#102c3a;font-size:8px}.mapping-row{border-top:1px solid #244656;font-size:9px}.mapping-row>span{display:grid;gap:2px}.mapping-row small{color:#688b98;font-size:7px}.mapping-row code{color:#7fc4cf}.mapping-row strong{color:#72d2b8;overflow-wrap:anywhere}.mapping-row em{color:#c6a66f;font-style:normal;font-size:8px}.workflow-instances article{display:grid;grid-template-columns:1fr 1.2fr .7fr;gap:14px;align-items:center;padding:10px;border:1px solid #274959;border-radius:7px;background:#0a2330}.workflow-instances article>div{display:grid;gap:3px}.workflow-instances article span,.workflow-instances article small,.workflow-instances article p{margin:0;color:#789ba7;font-size:8px}.workflow-instances article b{font-size:9px}.workflow-instances article>p{line-height:1.55;color:#abc5cc}.runtime-timeline{grid-column:1/-1;border-top:1px solid #244656;padding-top:9px;color:#80a7b2;font-size:8px}.runtime-timeline summary{cursor:pointer;color:#65c8c2}.runtime-timeline ol{display:grid;gap:6px;margin:9px 0 0;padding:0;list-style:none}.runtime-timeline li{display:grid;grid-template-columns:140px minmax(0,1fr) 100px;gap:10px;align-items:center}.runtime-timeline time{color:#688d99}.runtime-timeline li span{text-align:right}.workflow-alert{display:flex;justify-content:space-between;align-items:center;padding:10px 13px;border-radius:7px;font-size:10px}.workflow-alert.error{border:1px solid #844a51;color:#efadb4;background:#2a181e}.workflow-alert.success{border:1px solid #397565;color:#9de0cc;background:#102c28}.workflow-loading{padding:40px;text-align:center;color:#7195a1;border:1px dashed #2f5363;border-radius:9px}.workflow-detail[aria-busy=true]{opacity:.65;pointer-events:none}@media(max-width:1200px){.workflow-layout{grid-template-columns:260px minmax(0,1fr)}.workflow-facts{grid-template-columns:1fr 1fr}}@media(max-width:900px){.workflow-hero,.workflow-syncbar{display:grid}.workflow-metrics{grid-template-columns:1fr 1fr}.workflow-layout{grid-template-columns:1fr}.workflow-catalog{grid-template-columns:repeat(2,minmax(0,1fr))}.catalog-filter{grid-column:1/-1}.workflow-instances article{grid-template-columns:1fr}.runtime-timeline li{grid-template-columns:1fr}.runtime-timeline li span{text-align:left}.mapping-head,.mapping-row{grid-template-columns:1fr 1fr}.mapping-head span:nth-child(n+3){display:none}}@media(max-width:560px){.workflow-metrics,.workflow-catalog,.workflow-facts{grid-template-columns:1fr}.workflow-detail>header,.change-review,.section-title{display:grid}.change-review>div:last-child{justify-items:start}}
.workflow-syncbar>div:last-child{flex-wrap:wrap}.workflow-syncbar button.configured{border-color:#47869a;color:#c5eef2;background:#12323f}
.sync-modes{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.sync-modes article{display:grid;gap:4px;padding:12px 14px;border:1px solid #294e60;border-radius:8px;background:#091e2b}.sync-modes span{color:#55c8ce;font-size:8px;letter-spacing:.12em}.sync-modes b{font-size:10px}.sync-modes small{color:#7296a2;font-size:8px;line-height:1.5}.process-filter{display:flex;grid-column:1/-1;flex-wrap:wrap;gap:5px;padding-bottom:3px}.process-filter button{border:1px solid #2b5060;border-radius:999px;padding:5px 8px;color:#7598a4;background:#0b2532;font-size:8px}.process-filter button.active{border-color:#59c7ae;color:#d8f8ef;background:#174238}.cross-system-route{display:grid;gap:10px;padding:14px;border:1px solid #315869;border-radius:8px;background:#0a2230}.system-chain{display:flex;align-items:center;gap:8px;overflow-x:auto;padding:6px 0}.system-chain b{min-width:max-content;padding:7px 10px;border:1px solid #42808c;border-radius:6px;color:#c8eff0;background:#113541;font-size:9px}.system-chain i{color:#59c8b3;font-style:normal}.handoff-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.handoff-grid article{display:grid;gap:4px;padding:9px;border:1px solid #294c5d;border-radius:7px;background:#081c28}.handoff-grid span{color:#5fc8ca;font-size:8px}.handoff-grid b{font-size:9px;line-height:1.45}.handoff-grid small,.cross-system-route>p{margin:0;color:#73949f;font-size:8px}
.workflow-event-status{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:12px 15px;border:1px solid #294e60;border-radius:8px;background:#091e2b}.workflow-event-status>div:first-child{display:grid;gap:3px}.workflow-event-status span{color:#55c8ce;font-size:8px;letter-spacing:.1em}.workflow-event-status small{color:#7296a2;font-size:8px}.workflow-event-status.attention{border-color:#805b36}.dead-letter-list{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:7px}.dead-letter-list article{display:grid;grid-template-columns:auto auto auto;gap:8px;align-items:center;padding:7px;border:1px solid #76543a;border-radius:6px;background:#2a2119}.dead-letter-list button{border:1px solid #957044;border-radius:5px;padding:5px 8px;color:#efd09b;background:#392b1b;cursor:pointer}.dead-letter-list button:disabled{opacity:.4;cursor:not-allowed}@media(max-width:900px){.workflow-event-status,.dead-letter-list article{display:grid}.dead-letter-list{justify-content:stretch}.sync-modes,.handoff-grid{grid-template-columns:1fr}}
</style>

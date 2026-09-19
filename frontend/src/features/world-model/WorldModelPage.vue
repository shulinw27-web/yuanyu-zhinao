<script setup>
import SemanticContextPanel from './SemanticContextPanel.vue';
import CoreMetaObjectLayer from '../meta-model/CoreMetaObjectLayer.vue';
import OAMetaModelStudio from '../meta-model/OAMetaModelStudio.vue';
import { api } from '../../api/client.js';
const props = defineProps({ graph: Object, access: Object, semanticContext: Object, role: String, coreMetaObjects: Object, metaModels: { type: Array, default: () => [] }, oaMetaSimulation: Object, oaMetaDraft: Object, oaMetaAuthoringProfile: Object, metaModelMessage: String, buttonPermissionIds: { type: Array, default: () => [] } });
const replayCases = payload => api.replayOntologyCases(payload, props.role);
defineEmits(['save-oa-meta-draft', 'validate-oa-meta-draft', 'simulate-oa-meta-model', 'publish-oa-meta-model', 'refresh']);
const positions = { raw: [6, 36], test: [32, 11], pb1: [33, 44], pb2: [33, 71], fg: [57, 55], stock: [77, 35], order: [78, 72], risk: [58, 10] };
const colors = { exception: 'red', affected: 'gold', protected: 'purple', risk: 'blue' };
</script>
<template>
  <div v-if="graph" class="page">
    <div class="section-header"><div><span class="eyebrow">SEMANTIC LAYER · SEMANTICA CONNECTED</span><h2>语义层工作台</h2><p>在这里将跨系统事实抽象为可治理的对象和关系，再向智脑提供按权限裁剪、可追溯的业务上下文。</p></div></div>
    <section class="panel semantic-layer-guide"><b>从事实到智脑上下文</b><span>1. 运行模拟或接入系统产生事实</span><i>→</i><span>2. Semantica 抽取候选对象与关系</span><i>→</i><span>3. 在画布确认语义模型</span><i>→</i><span>4. 校验并登记后供智脑受控调用</span></section>
    <SemanticContextPanel :context="semanticContext" :role="role" />
    <section class="panel semantic-connection-note"><b>语义运营 Agent 已迁移到独立运营端。</b> 本页面保留已登记语义上下文、核心元对象和人工精调画布；自然语言建模、Schema Critic、Diff 与回滚请在语义运营端执行。</section>
    <CoreMetaObjectLayer :layer="coreMetaObjects" />
    <OAMetaModelStudio :meta-model="metaModels[0]" :draft="oaMetaDraft" :authoring-profile="oaMetaAuthoringProfile" :simulation="oaMetaSimulation" :role="role" :message="metaModelMessage" :replay-cases="replayCases" :button-permission-ids="buttonPermissionIds" @save-draft="$emit('save-oa-meta-draft', $event)" @validate-draft="$emit('validate-oa-meta-draft')" @simulate-build="$emit('simulate-oa-meta-model')" @publish="$emit('publish-oa-meta-model')" />
    <div class="section-header"><div><span class="eyebrow">META MODEL INSTANCE VIEW</span><h2>元模型驱动的风险实例影响图谱</h2><p>元模型定义对象、关系、状态、事件与策略边界；此处展示其在受控业务数据上的实时实例视图。</p></div></div>
    <div class="world-layout"><section class="world-canvas panel"><div class="canvas-legend"><span><i class="legend-dot red"/>异常</span><span><i class="legend-dot gold"/>受影响</span><span><i class="legend-dot purple"/>脱敏/受限</span><span><i class="legend-dot blue"/>RiskCase</span></div><div class="relation-line line-a"/><div class="relation-line line-b"/><div class="relation-line line-c"/><div class="relation-line line-d"/><div class="relation-line line-e"/><article v-for="node in graph.nodes" :key="node.id" :class="['world-node', colors[node.state] || 'blue']" :style="{ left: `${positions[node.id]?.[0] || 50}%`, top: `${positions[node.id]?.[1] || 50}%` }"><span>{{ node.type }}</span><strong>{{ node.label }}</strong><small>{{ node.sub }}</small></article><div class="canvas-note">元模型约束 · 有效时间 + 记录时间 · 事件可回放 · 关系按策略过滤</div></section><aside class="panel ontology-panel"><span class="eyebrow">POLICY-AWARE CONTEXT</span><h3>当前角色可见的实例上下文</h3><div class="access-card"><b>{{ access?.role?.name }}</b><p>可见：{{ access?.fields }}</p><small>限制：{{ access?.restrict }}</small></div><div class="ontology-kpis"><div><span>可见对象</span><b>{{ graph.nodes.length }}</b></div><div><span>有效关系</span><b>{{ graph.edges.length }}</b></div><div><span>风险事件</span><b>1</b></div><div><span>证据条目</span><b>8</b></div></div><h4>元模型解释边界</h4><p>总控 AI 获取由数据网关返回的受控实例上下文，不能持有全域数据的永久明文访问权。</p><div class="source-block"><span>本次证据链</span><b>TestResult → RawMaterialBatch → ProductionBatch → FinishedGoodsBatch → Order</b></div><div class="policy-gates"><b>策略关口已生效</b><span>对象、字段、用途和密钥解封均在本次请求范围内评估。</span></div></aside></div>
    <section class="panel event-table"><div class="section-header"><div><span class="eyebrow">EVENT TIMELINE</span><h2>风险形成过程</h2></div></div><div class="event-steps"><div><b>09:42:03</b><span>TestResultCompleted</span><p>检验结果进入事件流</p></div><div><b>09:42:05</b><span>规则命中</span><p>不合格且存在领用关系</p></div><div><b>09:42:06</b><span>RiskCaseCreated</span><p>计算影响范围与受控通知</p></div><div><b>09:43:11</b><span>NotificationSent</span><p>邮件、短信、Webhook</p></div></div></section>
  </div>
  <div v-else class="loading">正在加载元模型实例视图…</div>
</template>

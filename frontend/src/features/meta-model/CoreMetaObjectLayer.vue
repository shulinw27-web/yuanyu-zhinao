<script setup>
import { computed, ref } from 'vue';

const props = defineProps({ layer: Object });
const selectedProcessId = ref('production');
const selectedProcess = computed(() => props.layer?.processTemplates?.find((item) => item.id === selectedProcessId.value));
const objectById = (id) => props.layer?.objects?.find((item) => item.id === id);
</script>

<template>
  <section v-if="layer" class="panel core-meta-layer">
    <div class="section-header"><div><span class="eyebrow">L0 · CORE META OBJECT LAYER</span><h2>核心元对象层：所有业务的共同基点</h2><p>{{ layer.principle }}</p></div><b>{{ layer.objects.length }} 个核心元对象</b></div>
    <div class="core-object-grid"><article v-for="item in layer.objects" :key="item.id"><div class="core-object-mark" :style="{ borderColor: item.color, color: item.color }">{{ item.icon }}</div><div><span>{{ item.code }}</span><h3>{{ item.name }}</h3><p>{{ item.description }}</p></div><footer><b>权威来源：{{ item.source }}</b><small>主键：{{ item.key }} · {{ item.classification }}</small></footer></article></div>
    <div class="core-flow-layout"><section class="core-process-panel"><div><span>流程绑定规则</span><h3>选择业务流程，查看其核心对象约束</h3></div><div class="process-tabs"><button v-for="item in layer.processTemplates" :key="item.id" :class="{ active: selectedProcessId === item.id }" @click="selectedProcessId = item.id">{{ item.name }}</button></div><article v-if="selectedProcess" class="process-binding"><div><b>{{ selectedProcess.name }}</b><p>{{ selectedProcess.description }}</p></div><div class="binding-row"><span>必须关联</span><b v-for="id in selectedProcess.required" :key="id" :style="{ borderColor: objectById(id)?.color }">{{ objectById(id)?.name }}</b></div><div v-if="selectedProcess.optional.length" class="binding-row optional"><span>可选关联</span><b v-for="id in selectedProcess.optional" :key="id">{{ objectById(id)?.name }}</b></div><small>若缺少必填对象：仅可保存草稿，智脑不可发起执行或提交审批。</small></article></section><aside class="core-controls"><span>运行控制</span><p v-for="item in layer.controls" :key="item"><i>✓</i>{{ item }}</p></aside></div>
    <div class="core-relation-strip"><span>核心关系</span><b v-for="item in layer.relationships" :key="`${item.from}-${item.predicate}-${item.to}`">{{ item.from }} <i>— {{ item.predicate }} →</i> {{ item.to }}</b></div>
  </section>
</template>

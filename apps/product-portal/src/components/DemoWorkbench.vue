<script setup>
import { computed, ref } from 'vue';
import { scenario } from '../demo-scenario.js';
defineProps({ compact: Boolean });
const mode = ref('business');
const selected = ref('order');
const node = computed(() => scenario.objects.find(item => item.id === selected.value));
</script>

<template>
  <div class="demo-workbench" :class="{ 'demo-compact': compact }">
    <div class="demo-chrome"><span class="demo-symbol">元</span><b>元域工作空间</b><span class="demo-environment">合成示意 · 非实时运行</span><span class="chrome-dots" aria-hidden="true">•••</span></div>
    <div class="demo-layout">
      <aside class="demo-rail"><span class="rail-caption">WORKSPACE</span><button :class="{ selected: mode === 'business' }" :aria-pressed="mode === 'business'" @click="mode = 'business'">◈ <span>智脑工作台</span></button><button :class="{ selected: mode === 'semantic' }" :aria-pressed="mode === 'semantic'" @click="mode = 'semantic'">⌘ <span>元域智语</span></button><div class="rail-divider"/><span class="rail-caption">当前示例</span><p>供应链异常溯源</p><span class="rail-status">● 固定演示数据</span></aside>
      <div class="demo-body">
        <div class="demo-page-title"><div><small>{{ mode === 'business' ? 'BUSINESS AGENT' : 'SEMANTIC OPERATIONS' }}</small><h3>{{ mode === 'business' ? '从问题，找到业务依据' : '让业务关系清晰可见' }}</h3></div><span class="demo-version">DEMO-v1</span></div>
        <p class="demo-question">{{ mode === 'business' ? scenario.question : '根据数据字典，梳理采购到销售的批次关系。' }}</p>
        <div class="demo-answer"><span class="demo-avatar">元</span><div><b>{{ mode === 'business' ? '已知关联范围' : '对象与关系候选' }}</b><p>{{ mode === 'business' ? '这组样本包含以下关联路径。点击节点，查看字段来源和需要核实的内容。' : '按批次ID连接记录；名称仅用于展示。点击对象检查来源，候选仍需要人工审阅。' }}</p></div></div>
        <div class="object-path" aria-label="合成业务关系图"><template v-for="(item, index) in scenario.objects" :key="item.id"><span v-if="index" class="path-arrow" aria-hidden="true">→</span><button :aria-pressed="selected === item.id" :class="{ selected: selected === item.id }" @click="selected = item.id"><small>{{ item.system }}</small><b>{{ item.name }}</b><span>{{ item.record }}</span></button></template></div>
        <div class="demo-evidence" aria-live="polite"><div><span class="evidence-label">{{ mode === 'business' ? '来源核对' : '字段来源' }}</span><strong>{{ node.fact }}</strong></div><code>{{ node.source }}</code><p>{{ node.note }}</p></div>
        <div class="demo-summary"><span>✓ 关联路径可查看</span><span>✓ 未知项不补造</span><span>○ 业务动作未执行</span></div>
      </div>
    </div>
    <div class="demo-bottom"><span>预设交互示意，不调用模型或企业系统</span><a href="#/demo">查看完整案例 <span aria-hidden="true">↗</span></a></div>
  </div>
</template>

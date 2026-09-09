<script setup>
defineProps({ context: Object, role: String });
</script>

<template>
  <section v-if="context" class="panel semantic-context-panel">
    <div class="section-header semantic-header">
      <div><span class="eyebrow">SEMANTIC CONTEXT SERVICE · SEMANTICA</span><h2>语义上下文与决策溯源</h2><p>{{ context.guardrail }}</p></div>
      <div class="semantic-engine"><b>{{ context.status }}</b><small>{{ context.engine.mode }}</small></div>
    </div>
    <div class="semantic-metrics"><article><span>可见事实</span><b>{{ context.metrics.visibleFacts }}</b><small>按角色与数据域过滤</small></article><article><span>有效关系</span><b>{{ context.metrics.visibleRelations }}</b><small>跨系统可追溯关联</small></article><article><span>决策记录</span><b>{{ context.metrics.decisionRecords }}</b><small>智脑与规则引擎均留痕</small></article><article><span>待复核冲突</span><b>{{ context.metrics.openConflicts }}</b><small>进入人工风险闭环</small></article></div>
    <div class="semantic-grid"><article class="semantic-schema"><span class="eyebrow">ONTOLOGY CONTRACT</span><h3>语义契约</h3><div><b v-for="object in context.schema.coreObjects" :key="object">{{ object }}</b></div><ul><li v-for="constraint in context.schema.constraints" :key="constraint">{{ constraint }}</li></ul></article><article class="semantic-decisions"><span class="eyebrow">DECISION PROVENANCE</span><h3>最近可见决策</h3><div v-for="decision in context.decisions.slice(0, 3)" :key="decision.id" class="semantic-decision"><b>{{ decision.outcome }}</b><small>{{ decision.actor }} · {{ decision.subject }}</small><em>{{ decision.provenance.join(' → ') }}</em></div></article><article class="semantic-sources"><span class="eyebrow">TRUSTED SOURCES</span><h3>事实来源</h3><div v-for="source in context.provenance" :key="source.system"><b>{{ source.system }}</b><span>{{ source.mode }}</span><em :class="source.status === '正常' ? 'healthy' : 'warning'">{{ source.health }}%</em></div></article></div>
    <p class="semantic-boundary">当前视角：{{ role }}。语义服务只返回已授权事实；它不能绕过权限中心、不能解封密钥、也不能直接发起业务写入。</p>
  </section>
</template>

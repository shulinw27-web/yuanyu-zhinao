<script setup>
import { computed, ref, watch } from 'vue';
import { parseReadPlanImport } from './ontology-read-plan-import.js';
const props = defineProps({ draft: Object, canEdit: Boolean });
const emit = defineEmits(['apply-plan']);
const pending = ref(null); const error = ref('');
const plans = computed(() => props.draft?.scenario?.readPlans || []);
watch(() => [props.draft, props.canEdit], () => { pending.value = null; error.value = ''; });
const importPlan = async event => {
  const file = event.target.files?.[0]; event.target.value = ''; error.value = ''; pending.value = null;
  if (!file || !props.canEdit) return;
  const currentDraft = props.draft;
  try {
    if (file.size > 150000) throw new Error('方案超过 150 KB，请缩小。');
    const value = JSON.parse(await file.text());
    const input = parseReadPlanImport(value);
    if (props.draft === currentDraft && props.canEdit) pending.value = input;
  } catch (e) { error.value = e.message; }
};
const apply = () => {
  if (!props.canEdit || !pending.value) return;
  if (props.draft.scenario.decisionBindings?.length) { error.value = '请先明确移除原判断绑定，再配置关联计算；不会自动删除已有绑定。'; return; }
  emit('apply-plan', pending.value); pending.value = null;
};
const expression = (e, depth = 0) => {
  if (!e || depth > 14) return '表达式待校验';
  if (e.op === 'literal') return JSON.stringify(e.value);
  if (e.op === 'output') return `指标 ${e.id}`;
  if (e.op === 'field' || e.op === 'one') return `${e.dataset}.${e.field}`;
  if (e.op === 'lookup') return `关联 ${e.dataset}.${e.resultField}（${e.field} = ${expression(e.value, depth + 1)}）`;
  if (e.op === 'sum') return `汇总 ${e.dataset}：${expression(e.value, depth + 1)}${e.where ? `；条件 ${expression(e.where, depth + 1)}` : ''}`;
  if (e.op === 'if') return `若 ${expression(e.condition, depth + 1)} 则 ${expression(e.then, depth + 1)} 否则 ${expression(e.else, depth + 1)}`;
  const symbols = { add: '+', sub: '−', mul: '×', max: '取较大值', eq: '=', ne: '≠', and: '且', or: '或', gt: '>' };
  return `(${(e.args || []).map(a => expression(a, depth + 1)).join(` ${symbols[e.op] || e.op} `)})`;
};
</script>
<template>
  <details class="ontology-read-panel">
    <summary>智脑关联查询与计算 · {{ plans.length ? '已配置，需回放验收' : '尚未配置' }}</summary>
    <p>模型结构本身不是计算器。导入经人工审阅的只读方案，检查关联链和口径，再保存、校验、回放正反例及发布。对象访问还需要部署授权与 IAM；导入不会授予权限。</p>
    <label>导入只读方案 JSON（1–3个，仅预览）<input type="file" accept=".json,application/json" :disabled="!canEdit" @change="importPlan" /></label>
    <button v-if="pending" type="button" :disabled="!canEdit" @click="apply">采用预览方案到未保存草稿</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <article v-for="plan in pending || plans" :key="plan.id">
      <h4>{{ plan.label }} · {{ pending ? '尚未采用' : '当前草稿' }}</h4>
      <p>覆盖：{{ plan.coverage ? '仅声明关系图内的有界完整性，非全企业实时真相' : '仅当前计划，不承诺完整影响范围' }} · {{ plan.analysis?.enabled ? '计算后按当前问题解释证据' : '仅确定性计算' }}</p>
      <ol><li v-for="ds in plan.datasets" :key="ds.id"><b>{{ ds.objectType }}</b> · {{ ds.id }}<small v-for="(filter, index) in ds.where" :key="index">{{ filter.field }} ← {{ filter.target ? '用户本轮明确编号' : `${filter.dataset}.${filter.sourceField}` }}</small></li></ol>
      <details v-for="item in plan.outputs" :key="item.id"><summary>{{ item.label }} · {{ item.unit || '判断' }}</summary><p>{{ expression(item.expression) }}</p></details>
      <p v-for="ds in plan.datasets.filter(d => d.expand)" :key="`${ds.id}-expansion`">{{ ds.id }} 向后展开 {{ ds.expand.edgeObjectType }}：{{ ds.expand.fromField }} → {{ ds.expand.toField }}，状态 {{ Array.isArray(ds.expand.activeStates) ? ds.expand.activeStates.join('、') : '待补充有效状态' }}，最多 {{ ds.expand.maxDepth }} 层；环、断链或未完成时停止计算。</p>
      <p v-for="ds in plan.datasets.filter(d => d.filter)" :key="`${ds.id}-filter`">{{ ds.id }} 仅使用 {{ ds.filter.field }} ∈ {{ Array.isArray(ds.filter.values) ? ds.filter.values.join('、') : '待补充过滤值' }} 的记录。</p>
    </article>
  </details>
</template>
<style scoped>
.ontology-read-panel{margin:16px 0;padding:16px;border:1px solid #315466;border-radius:10px;background:#0b2330;color:#cee7ee;min-width:0}.ontology-read-panel summary{cursor:pointer}.ontology-read-panel p,.ontology-read-panel small{font-size:12px;line-height:1.7;overflow-wrap:anywhere}.ontology-read-panel ol{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;padding-left:22px}.ontology-read-panel small{display:block}.ontology-read-panel button{padding:10px;margin:10px;border:1px solid #58bba6;border-radius:6px;background:#123a40;color:#a8ecda}.ontology-read-panel details{padding:8px;min-width:0}.ontology-read-panel :disabled{opacity:.55}.ontology-read-panel :focus-visible{outline:2px solid #65d3ba;outline-offset:2px}
</style>

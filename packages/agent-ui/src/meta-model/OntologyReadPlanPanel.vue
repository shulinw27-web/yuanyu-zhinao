<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { parseReadPlanImport } from './ontology-read-plan-import.js';
const props = defineProps({ draft: Object, canEdit: Boolean, client: Object, savedFingerprint: String, hasUnsavedChanges: Boolean });
const emit = defineEmits(['apply-plan']);
const pending = ref(null); const error = ref('');
const proposalNotice = ref('');
const joinChoices = ref([]); const joinSelections = ref({});
const clarification = ref([]);
const request = ref(''); const rootType = ref(''); const consent = ref(false); const policy = ref(null); const busy = ref(false); let generation = 0;
const context = computed(() => JSON.stringify([props.draft, props.canEdit, props.savedFingerprint, props.hasUnsavedChanges]));
const resetJoins = () => { joinChoices.value = []; joinSelections.value = {}; clarification.value = []; proposalNotice.value = ''; };
watch(context, () => { generation++; pending.value = null; consent.value = false; busy.value = false; resetJoins(); }, { flush: 'sync' });
watch([request, rootType], () => { generation++; busy.value = false; consent.value = false; pending.value = null; resetJoins(); });
watch(joinSelections, () => { consent.value = false; pending.value = null; }, { deep: true });
const unresolvedJoins = computed(() => joinChoices.value.some(choice => !joinSelections.value[choice.objectType]));
let policyGeneration = 0;
watch(() => props.client, async client => {
  const ticket = ++policyGeneration;
  generation++; pending.value = null; consent.value = false; busy.value = false; error.value = ''; resetJoins(); policy.value = null;
  if (client) { try { const result = await client.providers(); if (ticket === policyGeneration) policy.value = result.answerPolicy; } catch { /* Existing import remains available. */ } }
}, { immediate: true, flush: 'sync' });
onUnmounted(() => { generation++; policyGeneration++; });
const propose = async () => {
  if (busy.value || unresolvedJoins.value || !props.canEdit || props.hasUnsavedChanges || !props.client || !consent.value || !policy.value?.enabled || !request.value.trim() || !rootType.value) return;
  const ticket = ++generation; busy.value = true; pending.value = null; error.value = ''; clarification.value = []; proposalNotice.value = '';
  try {
    const result = await props.client.proposeReadPlan({ request: request.value, rootType: rootType.value, expectedFingerprint: props.savedFingerprint,
      joinSelections: Object.values(joinSelections.value),
      consent: { provider: policy.value.provider, model: policy.value.model, confirmed: true } });
    if (ticket === generation && props.canEdit) {
      pending.value = parseReadPlanImport(result.plan);
      if (result.diagnostics?.removedClosingBrackets) proposalNotice.value = `模型格式经有限修复：删除 ${result.diagnostics.removedClosingBrackets} 个多余右方括号；没有修改业务公式，请核对并回放。`;
    }
  } catch (cause) {
    if (ticket === generation) {
      if (cause.code === 'READ_PLAN_JOIN_SELECTION_REQUIRED' && Array.isArray(cause.payload?.joinChoices)) {
        joinChoices.value = cause.payload.joinChoices;
        error.value = '存在多个合法关联，不能替你决定业务范围。请逐项选择关联字段，重新确认后生成；没有修改草稿。';
      } else if (cause.code === 'READ_PLAN_NEEDS_CLARIFICATION' && Array.isArray(cause.payload?.questions)) {
        clarification.value = cause.payload.questions;
        error.value = 'Agent 提出了以下待核实事项（仍需人工判断是否合理），尚未生成或保存方案。请补充到指标与规则后重新确认。';
      } else if (cause.payload?.diagnostics?.stage === 'output_token_limit') {
        error.value = '模型输出超过当前额度，未采用不完整方案。请缩小指标范围或由管理员评估输出预算后重试；没有保存或发布。';
      } else error.value = cause.status === 409 ? '保存的模型或模型策略已变化，请刷新后重新确认。' : '未生成通过结构校验的读取方案；请细化规则或继续人工导入。没有修改草稿。';
    }
  }
  finally { if (ticket === generation) { busy.value = false; consent.value = false; } }
};
const plans = computed(() => props.draft?.scenario?.readPlans || []);
watch(() => [props.draft, props.canEdit], () => { pending.value = null; error.value = ''; });
const importPlan = async event => {
  const ticket = ++generation; busy.value = false; consent.value = false;
  const file = event.target.files?.[0]; event.target.value = ''; error.value = ''; pending.value = null; proposalNotice.value = '';
  if (!file || !props.canEdit) return;
  busy.value = true;
  try {
    if (file.size > 150000) throw new Error('方案超过 150 KB，请缩小。');
    const value = JSON.parse(await file.text());
    const input = parseReadPlanImport(value);
    if (ticket === generation && props.canEdit) pending.value = input;
  } catch (e) { if (ticket === generation) error.value = e.message; }
  finally { if (ticket === generation) busy.value = false; }
};
const apply = () => {
  if (!props.canEdit || busy.value || !pending.value) return;
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
  if (e.op === 'all') return `全部 ${e.dataset} 记录均满足：${expression(e.value, depth + 1)}`;
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
    <section v-if="client" aria-label="Agent 读取方案提案">
      <h4>让 Agent 起草读取方案</h4>
      <p>先保存当前模型。只发送已保存的对象结构、规则和下方诉求，不发送业务记录；返回内容只是候选，必须检查口径、保存、校验并回放正反例后才能发布。</p>
      <label>业务根对象<select v-model="rootType" :disabled="busy || !canEdit"><option value="">请选择</option><option v-for="object in draft?.objectTypes || []" :key="object.id" :value="object.id">{{ object.label }} · {{ object.id }}</option></select></label>
      <label>需要核验的指标与规则<textarea v-model="request" :disabled="busy || !canEdit" maxlength="4000" rows="3" placeholder="说明关联范围、公式、状态过滤、单位换算及哪些规则尚未生效" /></label>
      <fieldset v-if="joinChoices.length"><legend>确认业务关联路径</legend>
        <p>每类对象本轮只选择一条路径。如果需要同时区分收货客户与结算客户等多个角色，请使用人工多别名方案。</p>
        <label v-for="choice in joinChoices" :key="choice.objectType">{{ choice.objectType }}
          <select v-model="joinSelections[choice.objectType]" :disabled="busy || !canEdit"><option :value="undefined">请选择关联，不默认采用</option>
            <option v-for="(option, index) in choice.options" :key="index" :value="option">{{ option.objectType }}.{{ option.field }} ← {{ option.fromObjectType }}.{{ option.sourceField }}</option>
          </select>
        </label>
      </fieldset>
      <label><input v-model="consent" type="checkbox" :disabled="busy || !canEdit || !policy?.enabled" />我有权将上述模型结构、规则及诉求发送给 {{ policy?.provider }} / {{ policy?.model }}。</label>
      <button type="button" :disabled="busy || unresolvedJoins || !canEdit || hasUnsavedChanges || !consent || !request.trim() || !rootType || !policy?.enabled" @click="propose">{{ busy ? '生成并校验候选…' : '生成只读方案预览' }}</button>
      <p v-if="hasUnsavedChanges">存在未保存修改，请先保存再生成。</p>
      <p v-if="busy" role="status">正在等待结构化方案并校验字段，最多约两分钟；这期间不会查询业务或保存草稿。</p>
    </section>
    <button v-if="pending" type="button" :disabled="!canEdit" @click="apply">采用预览方案到未保存草稿</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="pending && proposalNotice" role="status">{{ proposalNotice }}</p>
    <ul v-if="clarification.length"><li v-for="(question, index) in clarification" :key="index">{{ question }}</li></ul>
    <article v-for="plan in pending || plans" :key="plan.id">
      <h4>{{ plan.label }} · {{ pending ? '尚未采用' : '当前草稿' }}</h4>
      <p>覆盖：{{ plan.coverage ? '仅声明关系图内的有界完整性，非全企业实时真相' : '仅当前计划，不承诺完整影响范围' }} · {{ plan.analysis?.enabled ? '计算后按当前问题解释证据' : '仅确定性计算' }}</p>
      <ol><li v-for="ds in plan.datasets" :key="ds.id"><b>{{ ds.objectType }}</b> · {{ ds.id }}<small v-for="(filter, index) in ds.where" :key="index">{{ filter.field }} ← {{ filter.target ? '用户本轮明确编号' : `${filter.dataset}.${filter.sourceField}` }}<span v-if="filter.mapping">（经 {{ filter.mapping.objectType }} · {{ filter.mapping.fromField }} → {{ filter.mapping.toField }} 转换；确认状态须为confirmed；UTC {{ filter.mapping.asOf }}，尚需授权、校验和回放）</span></small></li></ol>
      <details v-for="item in plan.outputs" :key="item.id"><summary>{{ item.label }} · {{ item.unit || '判断' }}</summary><p>{{ expression(item.expression) }}</p></details>
      <section v-if="plan.preconditions?.length" aria-label="计算前置条件"><b>计算前必须全部满足，否则停止</b><ul><li v-for="(condition, index) in plan.preconditions" :key="index">{{ expression(condition) }}</li></ul></section>
      <p v-for="ds in plan.datasets.filter(d => d.expand)" :key="`${ds.id}-expansion`">{{ ds.id }} 向后展开 {{ ds.expand.edgeObjectType }}：{{ ds.expand.fromField }} → {{ ds.expand.toField }}，状态 {{ Array.isArray(ds.expand.activeStates) ? ds.expand.activeStates.join('、') : '待补充有效状态' }}，最多 {{ ds.expand.maxDepth }} 层；环、断链或未完成时停止计算。</p>
      <p v-for="ds in plan.datasets.filter(d => d.filter)" :key="`${ds.id}-filter`">{{ ds.id }} 仅使用 {{ ds.filter.field }} ∈ {{ Array.isArray(ds.filter.values) ? ds.filter.values.join('、') : '待补充过滤值' }} 的记录。</p>
    </article>
  </details>
</template>
<style scoped>
.ontology-read-panel{margin:16px 0;padding:16px;border:1px solid #315466;border-radius:10px;background:#0b2330;color:#cee7ee;min-width:0}.ontology-read-panel summary{cursor:pointer}.ontology-read-panel p,.ontology-read-panel small{font-size:12px;line-height:1.7;overflow-wrap:anywhere}.ontology-read-panel ol{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;padding-left:22px}.ontology-read-panel small{display:block}.ontology-read-panel button{padding:10px;margin:10px;border:1px solid #58bba6;border-radius:6px;background:#123a40;color:#a8ecda}.ontology-read-panel details{padding:8px;min-width:0}.ontology-read-panel :disabled{opacity:.55}.ontology-read-panel :focus-visible{outline:2px solid #65d3ba;outline-offset:2px}
</style>

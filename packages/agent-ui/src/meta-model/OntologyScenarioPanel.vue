<script setup>
import { computed } from 'vue';
import { qualityScenarioDraft, identityScenarioDraft, inventoryScenarioDraft } from './ontology-scenario.js';
const props = defineProps({ draft: Object, canEdit: Boolean, profile: Object, selectedObject: Object, simulation: Object });
const emit = defineEmits(['replace-draft', 'change-profile', 'change-granularity']);
const scenario = computed(() => props.draft.scenario);
const definitionFor = binding => props.profile?.decisionCatalog?.find(item => item.id === binding.capabilityId);
const fieldsFor = binding => definitionFor(binding)?.inputFields.filter(field => field !== 'evidenceIds') || [];
const objectFor = binding => props.draft.objectTypes.find(item => item.id === binding.objectType);
const fieldLabels = { id: '业务标识', severity: '来源风险等级', status: '业务状态', availableQuantity: '可用数量（不是总量）', requiredQuantity: '需求数量', unit: '库存单位', requiredUnit: '需求单位' };
const configureBinding = binding => {
  if (!props.canEdit) return;
  binding.inputMapping = Object.fromEntries(fieldsFor(binding).map(field => [field, '']));
  binding.parameters = { maxEvidenceAgeMinutes: 60, ...(binding.capabilityId === 'quality_disposition' ? { investigationSeverities: ['P0', 'P1'] } : {}) };
  delete binding.valueMappings;
};
const removeBinding = binding => {
  if (!props.canEdit) return;
  scenario.value.decisionBindings = scenario.value.decisionBindings.filter(item => item !== binding);
  scenario.value.actionBindings = scenario.value.actionBindings.filter(item => item.decisionId !== binding.capabilityId || item.objectType !== binding.objectType);
};
const changeObject = (binding, value) => {
  if (!props.canEdit) return;
  scenario.value.actionBindings = scenario.value.actionBindings.filter(item => item.decisionId !== binding.capabilityId || item.objectType !== binding.objectType);
  binding.objectType = value; configureBinding(binding);
};
const addConversion = (binding, field) => {
  if (!props.canEdit) return;
  binding.valueMappings ||= {};
  (binding.valueMappings[field] ||= []).push({ from: '', to: definitionFor(binding).valueMappingTargets[field][0] });
};
const removeConversion = (binding, field, index) => {
  if (!props.canEdit) return;
  binding.valueMappings[field].splice(index, 1);
  if (!binding.valueMappings[field].length) delete binding.valueMappings[field];
};
const granularities = { unspecified: '待明确', master: '主数据 / SKU', batch: '批次', inventory_item: '库存项', transaction: '交易单据', event: '业务事件', organization: '组织' };
const loadExample = () => {
  if (props.canEdit && window.confirm('用质量场景示例替换当前未保存编辑？服务器草稿不会改变，需另行保存。')) emit('replace-draft', qualityScenarioDraft(props.draft));
};
const loadIdentityExample = () => {
  if (props.canEdit && window.confirm('用跨系统编号教学模型替换未保存编辑？这不会发现真实数据，也不会合并或迁移历史编号。')) emit('replace-draft', identityScenarioDraft(props.draft));
};
const bindDecision = (event) => {
  const definition = props.profile?.decisionCatalog?.find((item) => item.id === event.target.value);
  if (!definition || !props.canEdit) return;
  const binding = { capabilityId: definition.id, version: definition.version, objectType: '' };
  configureBinding(binding); scenario.value.decisionBindings.push(binding); event.target.value = '';
};
const loadInventoryExample = () => {
  if (props.canEdit && window.confirm('载入库存教学模型并替换未保存编辑？它只核验单条快照，不预留库存或下采购单。')) emit('replace-draft', inventoryScenarioDraft(props.draft));
};
</script>

<template>
  <section v-if="scenario" class="ontology-scenario" aria-label="业务场景与判断能力">
    <button type="button" :disabled="!canEdit" @click="loadIdentityExample">载入跨系统编号示例</button>
    <button type="button" :disabled="!canEdit" @click="loadInventoryExample">载入库存核验示例</button>
    <header><div><h3>先明确业务问题，再校对模型</h3><p>判断只产生建议；配置动作依赖不会授予执行权限。</p></div><button type="button" :disabled="!canEdit" @click="loadExample">载入质量场景示例</button></header>
    <div class="scenario-fields">
      <label>建模场景<select :value="draft.modelingProfile" :disabled="!canEdit" @change="emit('change-profile', $event.target.value)"><option value="oa-approval">OA 审批模板（保留审批约束）</option><option value="general">通用业务场景（不限定对象数量）</option></select></label>
      <label>业务目标<textarea v-model="scenario.objective" maxlength="2000" :disabled="!canEdit" placeholder="例如：识别异常批次影响并提出调查建议" /></label>
      <label class="wide">验收问题（每行一项）<textarea :value="scenario.questions?.join('\n')" :disabled="!canEdit" @input="scenario.questions = $event.target.value.split('\n').filter(item => item.trim())" /></label>
      <label>添加已注册判断<select :disabled="!canEdit || !profile?.decisionCatalog?.length" @change="bindDecision"><option value="">选择能力后添加</option><option v-for="definition in profile?.decisionCatalog || []" :key="definition.id" :value="definition.id">{{ definition.name }} · {{ definition.version }}</option></select><small>可配置多个判断；同一对象不能重复绑定同一能力。</small></label>
      <label v-if="selectedObject">当前对象粒度 · {{ selectedObject.label }}<select :value="selectedObject.granularity" :disabled="!canEdit" @change="emit('change-granularity', $event.target.value)"><option v-for="(label, value) in granularities" :key="value" :value="value">{{ label }}</option></select><small>粒度标注不会重命名已有对象或迁移历史主键。</small></label>
    </div>
    <details v-for="(binding, index) in scenario.decisionBindings" :key="index" open><summary>{{ definitionFor(binding)?.name || binding.capabilityId }} · 判断输入与参数</summary>
      <p>{{ definitionFor(binding)?.description }}</p>
      <label>作用对象<select :value="binding.objectType" :disabled="!canEdit" @change="changeObject(binding, $event.target.value)"><option value="">请选择对象</option><option v-for="object in draft.objectTypes" :key="object.id" :value="object.id">{{ object.label }} · {{ object.id }}</option></select></label>
      <button type="button" :disabled="!canEdit" @click="removeBinding(binding)">移除此判断</button>
      <button v-if="!binding.inputMapping || !binding.parameters" type="button" :disabled="!canEdit" @click="configureBinding(binding)">配置字段映射与参数</button>
      <div v-else class="scenario-fields">
        <label v-for="key in fieldsFor(binding)" :key="key">{{ fieldLabels[key] || key }}对应字段<select v-model="binding.inputMapping[key]" :disabled="!canEdit"><option value="">请选择源字段</option><option v-for="field in objectFor(binding)?.fields || []" :key="field" :value="field">{{ field }}</option></select></label>
        <label>证据最长有效期（分钟）<input v-model.number="binding.parameters.maxEvidenceAgeMinutes" type="number" min="1" max="10080" :disabled="!canEdit" /></label>
        <label v-if="binding.capabilityId === 'quality_disposition'">建议调查的风险等级<select v-model="binding.parameters.investigationSeverities" multiple :disabled="!canEdit"><option v-for="level in ['P0', 'P1', 'P2', 'P3']" :key="level" :value="level">{{ level }}</option></select><small>至少选择一项；不会改变来源风险等级，也不会自动创建调查。</small></label>
      </div>
      <details><summary>源系统枚举值转换（可选）</summary><p>未配置时直接使用源值；配置后必须逐项命中，不猜测未知值、不运行脚本、不转换数量或单位。输入代码区分大小写。</p>
        <div v-for="(targets, field) in definitionFor(binding)?.valueMappingTargets || {}" :key="field"><button type="button" :disabled="!canEdit || (binding.valueMappings?.[field]?.length || 0) >= 100" @click="addConversion(binding, field)">添加 {{ fieldLabels[field] }} 转换</button>
          <div v-for="(entry, entryIndex) in binding.valueMappings?.[field] || []" :key="entryIndex" class="conversion-row"><label>源代码<input v-model="entry.from" :disabled="!canEdit" maxlength="100" /></label><label>目标含义<select v-model="entry.to" :disabled="!canEdit"><option v-for="target in targets" :key="target" :value="target">{{ target }}</option></select></label><button type="button" :disabled="!canEdit" @click="removeConversion(binding, field, entryIndex)">删除转换</button></div>
        </div>
      </details>
    </details>
    <label>发布验收<select :value="Boolean(scenario.requireCaseReplay)" :disabled="!canEdit" @change="scenario.requireCaseReplay = $event.target.value === 'true'"><option :value="false">结构校验与模拟构建</option><option :value="true">额外要求发布人完成当前版本样本回放</option></select><small>字段、转换、参数随模型版本审批；修改后原回放失效，须重新保存、校验和构建。</small></label>
    <details><summary>关系证据与时间范围 · {{ draft.relationshipTypes.length }} 条</summary><p>这里记录模型关系约定；不代表实例级历史查询已验收。推断关系不能当作权威业务事实。</p><div v-for="(relation, index) in draft.relationshipTypes" :key="`${relation.from}-${relation.predicate}-${relation.to}-${index}`" class="relation-contract"><b>{{ relation.from }} → {{ relation.to }}</b><label>来源性质<select v-model="relation.provenanceType" :disabled="!canEdit"><option value="declared">建模声明</option><option value="observed">观察所得</option><option value="inferred">模型推断</option><option value="confirmed">人工确认</option></select></label><label>证据说明<input v-model="relation.evidence" :disabled="!canEdit" maxlength="100" /></label><label>有效起始（含时区）<input v-model="relation.validFrom" :disabled="!canEdit" placeholder="2026-09-09T00:00:00+08:00" /></label><label>有效结束（含时区）<input v-model="relation.validTo" :disabled="!canEdit" placeholder="留空表示未限定" /></label></div></details>
    <details v-if="simulation?.decisionReplay"><summary>判断回放 · {{ simulation.decisionReplay.status }}</summary><p>合成用例验证判断边界，不代表历史业务、真实 API 或整段自然语言对话已通过。</p><div v-for="result in simulation.decisionReplay.results" :key="result.capabilityId"><b>{{ result.capabilityId }} / {{ result.version }}</b><ul><li v-for="item in result.cases" :key="item.id">{{ item.passed ? '通过' : '失败' }} · {{ item.id }}：{{ item.actual }}</li></ul></div></details>
  </section>
</template>

<style scoped>
.conversion-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:end;margin:10px 0}.ontology-scenario button{margin:4px 4px 4px 0}@media(max-width:480px){.conversion-row{grid-template-columns:minmax(0,1fr)}.ontology-scenario button{white-space:normal}}
.ontology-scenario{padding:16px;margin-bottom:16px;border:1px solid #315466;border-radius:10px;background:#0b2330;color:#cee7ee;min-width:0}.ontology-scenario header{display:flex;justify-content:space-between;gap:16px;align-items:center}.ontology-scenario h3{margin:0;font-size:15px}.ontology-scenario p,.ontology-scenario small{font-size:12px;line-height:1.6;color:#91afbd}.scenario-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.ontology-scenario label{display:grid;gap:6px;font-size:12px;min-width:0}.wide{grid-column:1/-1}.ontology-scenario input,.ontology-scenario select,.ontology-scenario textarea{box-sizing:border-box;width:100%;min-width:0;padding:9px;border:1px solid #416172;border-radius:6px;background:#071b27;color:#d9edf1;font:inherit}.ontology-scenario textarea{min-height:62px;resize:vertical}.ontology-scenario button{padding:9px 12px;border:1px solid #58bba6;border-radius:6px;background:#123a40;color:#a8ecda;cursor:pointer}.ontology-scenario :disabled{opacity:.55;cursor:not-allowed}.ontology-scenario :focus-visible{outline:2px solid #65d3ba;outline-offset:2px}.ontology-scenario details{margin-top:14px}.ontology-scenario summary{cursor:pointer;padding:8px 0}.relation-contract{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:12px 0;border-top:1px solid #284654}.relation-contract>b{grid-column:1/-1;overflow-wrap:anywhere}.ontology-scenario li{font-size:12px;line-height:1.8;overflow-wrap:anywhere}@media(max-width:760px){.scenario-fields,.relation-contract{grid-template-columns:1fr}.ontology-scenario header{align-items:stretch;flex-direction:column}.ontology-scenario header button{align-self:start}}
</style>

<script setup>
import { computed, ref, watch } from 'vue';
import { mappingJoinChoices, proposeOntologyMapping } from './ontology-mapping-wizard.js';
import { discoverMappingPaths } from './ontology-mapping-paths.js';
const props = defineProps({ draft: Object, canEdit: Boolean });
const emit = defineEmits(['apply-draft']);
const empty = () => ({ relationKey: '', joinKey: '', objectType: '', fromField: '', toField: '', statusField: '', versionField: '', validFromField: '', validToField: '', owner: '', version: '', asOf: '' });
const form = ref(empty()); const notice = ref('');
const pathForm = ref({ fromType: '', fromField: '', toType: '', toField: '', maxDepth: 3 });
const pathResult = ref(null); const pathShape = ref('');
const pathsStale = computed(() => pathShape.value !== JSON.stringify(props.draft));
const pathMessages = { MAPPING_PATH_INPUT_INVALID: '请选择已声明的起止对象、字段和1至4跳深度。', MAPPING_PATH_MODEL_LIMIT: '模型超出本地发现范围，最多500个对象、1000个关系和100个方案。', MAPPING_PATH_SEARCH_LIMIT: '已达2000次搜索预算，拒绝提供不完整候选。', MAPPING_PATH_MODEL_INVALID: '模型或读取步骤结构无效，请先校验模型。', MAPPING_PATH_BINDING_INVALID: '对照声明不完整或有未知配置，请先核对字段、版本、时点。', MAPPING_PATH_REFERENCE_INVALID: '对照字段缺少明确的两端引用，不按名称猜测。', MAPPING_PATH_RELATION_AMBIGUOUS: '关系声明缺失或重复，不能唯一解释。', MAPPING_PATH_IDENTICAL_ENDPOINTS: '起止字段相同，不需要转换。', MAPPING_PATH_AMBIGUOUS: '限定深度内有多条路径，不能自动选取；请明确业务依据。', MAPPING_PATH_NOT_FOUND: '限定深度内没有同一时点、字段连续的已声明路径。', MAPPING_PATH_CANDIDATE_NOT_EXECUTABLE: '发现一条结构候选，仅表示限定深度内唯一，不证明业务记录可转换。' };
function discover() {
  pathResult.value = discoverMappingPaths(props.draft, pathForm.value);
  pathShape.value = JSON.stringify(props.draft);
}
const fieldsFor = id => props.draft?.objectTypes?.find(type => type.id === id)?.fields || [];
watch(() => pathForm.value.fromType, () => { pathForm.value.fromField = ''; pathResult.value = null; });
watch(() => pathForm.value.toType, () => { pathForm.value.toField = ''; pathResult.value = null; });
watch(pathForm, () => { pathResult.value = null; }, { deep: true });
watch([() => props.draft, () => props.canEdit], () => { pathResult.value = null; pathShape.value = ''; }, { deep: true, flush: 'sync' });
const relation = computed(() => props.draft?.relationshipTypes?.find(item => JSON.stringify([item.from, item.predicate, item.to]) === form.value.relationKey));
const joins = computed(() => mappingJoinChoices(props.draft, relation.value));
const crosswalk = computed(() => props.draft?.objectTypes?.find(item => item.id === form.value.objectType));
const candidateCrosswalks = computed(() => {
  const join = joins.value.find(item => item.key === form.value.joinKey);
  if (!join || !relation.value) return [];
  return (props.draft?.objectTypes || []).filter(item => item.sourceSystems?.length === 1
    && [[relation.value.from, join.direction === 'reverse' ? join.targetField : join.sourceField], [relation.value.to, join.direction === 'reverse' ? join.sourceField : join.targetField]].every(([endpoint, field]) => item.fieldDefinitions?.some(def => def.reference === endpoint && (def.referenceField || props.draft.objectTypes.find(type => type.id === endpoint)?.key) === field)));
});
const objectLabel = id => props.draft?.objectTypes?.find(item => item.id === id)?.label || id;
const fields = [{ key: 'fromField', label: '对照表中的源编码' }, { key: 'toField', label: '对照表中的目标编码' }, { key: 'statusField', label: '确认状态字段（值为confirmed）' }, { key: 'versionField', label: '映射版本字段' }, { key: 'validFromField', label: '生效时间字段' }, { key: 'validToField', label: '失效时间字段（null表示长期有效）' }];
const preview = computed(() => { try { return { ...proposeOntologyMapping(props.draft, form.value), error: '' }; } catch (error) { return { error: error.message }; } });
watch([() => props.draft, () => props.canEdit], () => { form.value = empty(); notice.value = ''; }, { deep: true, flush: 'sync' });
watch(() => form.value.relationKey, () => { form.value.joinKey = ''; form.value.objectType = ''; fields.forEach(field => { form.value[field.key] = ''; }); });
watch(() => form.value.objectType, () => { fields.forEach(field => { form.value[field.key] = ''; }); });
watch(() => form.value.joinKey, () => { form.value.objectType = ''; fields.forEach(field => { form.value[field.key] = ''; }); });
function apply() {
  if (!props.canEdit || preview.value.error) return;
  const candidate = proposeOntologyMapping(props.draft, form.value);
  emit('apply-draft', { baseShape: JSON.stringify(props.draft), draft: candidate.draft });
  notice.value = '已加入本地候选，请保存、校验并完成正反例回放后再发布；没有读取业务数据。';
}
</script>

<template>
  <details class="mapping-wizard">
    <summary>跨系统编码不同？配置主数据对照</summary>
    <p>选择“业务关系 → 查询步骤 → 对照表”。步骤可明确选择正向或反向查询；对照字段的源/目标始终按业务关系原方向填写，反查不会改变关系方向。只编辑候选，不连接系统、不授予权限、不自动发布。</p>
    <fieldset :disabled="!canEdit">
      <div class="mapping-grid">
        <label>1. 业务关系<select v-model="form.relationKey"><option value="">请选择</option><option v-for="item in draft?.relationshipTypes || []" :key="JSON.stringify([item.from, item.predicate, item.to])" :value="JSON.stringify([item.from, item.predicate, item.to])">{{ objectLabel(item.from) }} → {{ item.label || item.predicate }} → {{ objectLabel(item.to) }}</option></select></label>
        <label>2. 现有读取步骤<select v-model="form.joinKey"><option value="">请选择明确方向的步骤</option><option v-for="item in joins" :key="item.key" :value="item.key">{{ item.label }}</option></select></label>
        <label>3. 对照对象<select v-model="form.objectType"><option value="">请选择已声明两端引用的对照表</option><option v-for="item in candidateCrosswalks" :key="item.id" :value="item.id">{{ item.label || item.id }} · {{ item.sourceSystems[0] }}</option></select></label>
      </div>
      <p v-if="relation && !joins.length" class="mapping-warning">尚无同方向的读取步骤，请先在“关联查询与计算”配置或导入只读方案；不会自动创建查询。</p>
      <p v-if="form.joinKey && !candidateCrosswalks.length" class="mapping-warning">没有同时明确引用两端字段的单来源对照对象。请先补充对照数据字典或让运营Agent起草对象并人工核对；不会根据字段名推荐对照表。</p>
      <div v-if="crosswalk" class="mapping-grid">
        <label v-for="field in fields" :key="field.key">{{ field.label }}<select v-model="form[field.key]"><option value="">请选择字段</option><option v-for="name in crosswalk.fields" :key="name">{{ name }}</option></select></label>
        <label>对照维护人<input v-model="form.owner" maxlength="48" placeholder="负责维护该对照的人或岗位" /></label>
        <label>映射版本<input v-model="form.version" maxlength="24" placeholder="例如map-v1，与记录字段一致" /></label>
        <label>有效时点（UTC）<input v-model="form.asOf" placeholder="2026-10-09T00:00:00Z" /><small>固定时点，不默认现在，不代表实时同步。</small></label>
      </div>
      <div v-if="form.relationKey" class="mapping-preview"><b>核对转换路径</b><p>{{ preview.error || preview.summary }}</p><p v-if="preview.affectedSteps > 1" class="mapping-warning">共有{{ preview.affectedSteps }}个读取步骤使用此关系。本次只绑定选中的步骤，其他步骤也受关系版本和对照对象变更影响，需逐一核对。</p><small>六个字段不能重复；两端编码字段须有明确引用。保存后仍由服务端校验权限、版本、有效期和确认状态。</small></div>
      <button type="button" :disabled="!canEdit || Boolean(preview.error)" @click="apply">应用到本地候选</button>
    </fieldset>
    <p v-if="!canEdit">当前角色只读，不能应用配置。</p><p v-if="notice" role="status">{{ notice }}</p>
    <details class="mapping-path-discovery">
      <summary>自动发现已声明的多跳路径 · 只读结构核对</summary>
      <p>仅沿现有读取步骤及版本化对照表发现路径，不自动反转关系、不猜测字段等价、不读取业务数据。不同方案的步骤可组成结构候选，不代表已有可执行方案。</p>
      <div class="mapping-grid">
        <label>起点对象<select v-model="pathForm.fromType"><option value="">请选择</option><option v-for="item in draft?.objectTypes || []" :key="item.id" :value="item.id">{{ item.label || item.id }}</option></select></label>
        <label>起点字段<select v-model="pathForm.fromField"><option value="">请选择</option><option v-for="field in fieldsFor(pathForm.fromType)" :key="field">{{ field }}</option></select></label>
        <label>终点对象<select v-model="pathForm.toType"><option value="">请选择</option><option v-for="item in draft?.objectTypes || []" :key="item.id" :value="item.id">{{ item.label || item.id }}</option></select></label>
        <label>终点字段<select v-model="pathForm.toField"><option value="">请选择</option><option v-for="field in fieldsFor(pathForm.toType)" :key="field">{{ field }}</option></select></label>
        <label>最大深度<select v-model.number="pathForm.maxDepth"><option v-for="depth in 4" :key="depth" :value="depth">{{ depth }} 跳</option></select></label>
      </div>
      <button type="button" @click="discover">只读发现路径</button>
      <section v-if="pathResult && !pathsStale" aria-live="polite">
        <p>{{ pathMessages[pathResult.code] || '发现未完成，请检查模型。' }}</p>
        <ol v-for="(path, index) in pathResult.paths" :key="index" class="mapping-path"><li v-for="(step, stepIndex) in path.steps" :key="stepIndex">{{ objectLabel(step.fromType) }}.{{ step.fromField }} → {{ objectLabel(step.lookupObject) }}（{{ step.direction === 'reverse' ? '已声明反查' : '正向' }}，{{ step.version }}）→ {{ objectLabel(step.toType) }}.{{ step.toField }}<small>时点 {{ step.asOf }}；依据 {{ step.declarations.map(item => `${item.planId}/${item.datasetId}`).join('、') }}</small><small v-if="step.requiresConstraintReview" class="mapping-warning">该步骤带过滤、前置条件或扩展声明，尚未求值，需回到原方案逐项核对。</small></li></ol>
        <p v-if="pathResult.cyclesSkipped || pathResult.timeConflicts || pathResult.depthCuts">跳过循环 {{ pathResult.cyclesSkipped || 0 }} 次、不同有效时点 {{ pathResult.timeConflicts || 0 }} 次、深度截断 {{ pathResult.depthCuts || 0 }} 次。截断之外仍可能有其他路径。</p>
        <p>没有生成查询、确认映射或授权。执行仍需逐步人工配置、服务端权限校验、有效期/状态/版本复验和正反例回放。</p>
      </section>
    </details>
  </details>
</template>

<style scoped>
.mapping-path-discovery{border-top:1px solid #315764;margin-top:16px;padding-top:12px}.mapping-path{font-size:12px;line-height:1.9;padding-left:24px;overflow-wrap:anywhere}.mapping-path small{display:block}
.mapping-wizard{border:1px solid #315764;border-radius:10px;background:#0a202b;color:#d7edef;padding:14px;margin:14px 0;min-width:0}.mapping-wizard summary{cursor:pointer;font-weight:600}.mapping-wizard p{font-size:12px;line-height:1.8;overflow-wrap:anywhere}.mapping-wizard fieldset{padding:0;border:0;min-width:0}.mapping-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:12px;margin:12px 0}.mapping-grid label{display:grid;align-content:start;gap:6px;font-size:12px;min-width:0}.mapping-wizard select,.mapping-wizard input,.mapping-wizard button{font:inherit;box-sizing:border-box;max-width:100%;min-width:0;background:#112f3c;color:inherit;border:1px solid #375f70;border-radius:7px;padding:9px;min-height:38px}.mapping-wizard button{cursor:pointer;background:#164a48;margin-top:12px}.mapping-wizard button:disabled{opacity:.5;cursor:not-allowed}.mapping-wizard :focus-visible{outline:2px solid #71e0c5;outline-offset:2px}.mapping-wizard small{font-size:11px;color:#91b2bf;line-height:1.7}.mapping-preview{padding:12px;border:1px solid #375f70;border-radius:8px;background:#102d38}.mapping-warning{color:#f5c468}
</style>

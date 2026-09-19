<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({ client: Object, project: Object, canWrite: Boolean, blocked: Boolean });
const emit = defineEmits(['updated', 'busy']);
const empty = () => ({ version: 'mock-alignment.v1', identities: [], units: [], states: [] });
const config = ref(empty());
const tables = ref([]);
const evidenceSources = ref([]);
const report = ref(null);
const revision = ref(0);
const loading = ref(false);
const saving = ref(false);
const dirty = ref(false);
const conflict = ref(false);
const error = ref('');
const notice = ref('');
let generation = 0;
let disposed = false;
let loadedId = '';
const groups = [{ key: 'identities', label: '对象标识', hint: '选择对象，明确业务粒度和统一类型。空别名表表示保留原始主键。' },
  { key: 'units', label: '计量单位', hint: '重量按单位换算；箱转件必须引用对应 SKU 的包装规格，不允许统一猜测倍数。' },
  { key: 'states', label: '业务状态', hint: '逐项说明源状态的业务含义；已审批不等于已执行。' }];
const editable = computed(() => props.canWrite && !props.blocked && !loading.value && !saving.value && !conflict.value && tables.value.length > 0);
const tableFor = name => tables.value.find(table => table.name === name);
const fieldsFor = (name, types) => (tableFor(name)?.fields || []).filter(field => !types || types.includes(field.type));
const numericFields = name => fieldsFor(name, ['number', 'integer']);
const references = name => fieldsFor(name).filter(field => field.reference);
watch(() => dirty.value || saving.value, value => emit('busy', value), { flush: 'sync' });
function changed() { dirty.value = true; notice.value = ''; report.value = null; }
function addRule(key) {
  if (!editable.value || config.value[key].length >= 40) return;
  const table = tables.value[0];
  const common = { objectType: table.name, evidence: '' };
  config.value[key].push(key === 'identities' ? { ...common, canonicalType: table.name, granularity: table.granularity || '', aliases: [] }
    : key === 'units' ? { ...common, field: '', sourceUnit: '', targetUnit: '' } : { ...common, field: '', values: [{ source: '', target: '' }] });
  changed();
}
function changeObject(rule, key) {
  if (key === 'identities') { rule.canonicalType = rule.objectType; rule.granularity = tableFor(rule.objectType)?.granularity || ''; rule.aliases = []; }
  else { rule.field = ''; if (key === 'units') { delete rule.unitField; delete rule.lookup; rule.sourceUnit = ''; rule.targetUnit = ''; } }
  changed();
}
function changeUnitField(rule) { rule.sourceUnit = fieldsFor(rule.objectType).find(f => f.name === rule.field)?.unit || ''; changed(); }
function changeEvidence(rule, kind) {
  const source = evidenceSources.value.find(source => source.kind === kind);
  if (source) rule.materialEvidence = { kind, digest: source.digest, quote: '' };
  else delete rule.materialEvidence;
  changed();
}
function changeLookup(rule, value) {
  if (!value) delete rule.lookup;
  else rule.lookup = { viaField: value, objectType: references(rule.objectType).find(f => f.name === value)?.reference, valueField: '' };
  changed();
}
function aliasValue(rule, pair, key, value) {
  const type = fieldsFor(rule.objectType).find(f => f.name === tableFor(rule.objectType)?.primaryKey)?.type;
  const numeric = rule.aliases && (key === 'source' ? ['integer', 'number'].includes(type) : typeof pair.target === 'number');
  pair[key] = numeric && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : value;
  changed();
}
async function load() {
  if (saving.value || props.blocked) return;
  const id = props.project.id;
  const current = ++generation;
  loading.value = true; error.value = ''; report.value = null;
  try {
    const result = await props.client.onboardingAlignment(id);
    if (disposed || generation !== current || props.project.id !== id) return;
    if (result.projectId !== id) throw new Error('返回的规则不属于当前项目。');
    config.value = result.config || empty(); tables.value = result.tables || []; report.value = result.report;
    evidenceSources.value = result.evidenceSources || [];
    revision.value = result.revision; dirty.value = false; conflict.value = false;
    loadedId = id;
    notice.value = '';
  } catch (failure) {
    if (!disposed && generation === current) { error.value = failure.message || '业务对齐读取失败。'; tables.value = []; }
  } finally { if (!disposed && generation === current) loading.value = false; }
}
async function save() {
  if (!editable.value || !dirty.value) return;
  const id = props.project.id;
  const current = generation;
  saving.value = true; error.value = ''; notice.value = '';
  try {
    const payload = JSON.parse(JSON.stringify(config.value));
    payload.units.forEach(rule => { if (!rule.unitField) delete rule.unitField; });
    const result = await props.client.saveOnboardingAlignment(id, { expectedRevision: revision.value, config: payload });
    if (disposed || generation !== current || props.project.id !== id) return;
    if (result.project?.id !== id) throw new Error('保存结果与当前项目不一致。');
    dirty.value = false; report.value = null; revision.value = result.project.revision;
    emit('updated', result.project);
    notice.value = '规则已保存，原连接结果已失效。请点击“测试模拟连接”，重新验证完整数据。';
  } catch (failure) {
    if (!disposed && generation === current) { conflict.value = failure.status === 409; error.value = failure.message || '规则保存失败。'; }
  } finally { if (!disposed && generation === current) saving.value = false; }
}
watch(() => [props.project.id, props.project.revision, props.blocked], () => {
  if (!dirty.value && !saving.value && !props.blocked && (loadedId !== props.project.id || revision.value !== props.project.revision)) void load();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; generation++; emit('busy', false); });
</script>

<template>
  <section class="alignment" aria-label="人工业务对齐编辑器">
    <header><div><small>BUSINESS ALIGNMENT · MOCK</small><h4>把系统字段对齐为业务含义</h4></div><span>{{ dirty ? '有未保存修改' : '修订 ' + revision }}</span></header>
    <p>① 选择对象与字段 → ② 填写规则和人工依据 → ③ 保存 → ④ 重新测试模拟连接。不会自动建模、发布或执行业务。</p>
    <p v-if="dirty" role="status">编辑期间已暂停项目切换、材料提交和连接测试。先保存规则，或放弃修改后重新读取。</p>
    <p v-if="loading" role="status">正在读取字典与规则…</p>
    <p v-if="!loading && !tables.length">请先提交有效数据字典，之后可从字段列表选择，无须编写 JSON。</p>
    <p v-if="error" role="alert" class="error" data-testid="alignment-error">{{ error }}</p>
    <p v-if="conflict" role="alert">版本已变化，未自动重试或覆盖。下方修改仍保留供核对；重新读取会放弃本地修改。</p>
    <p v-if="notice" role="status" data-testid="alignment-notice">{{ notice }}</p>
    <fieldset :disabled="!editable">
      <details v-for="group in groups" :key="group.key" open>
        <summary>{{ group.label }} · {{ config[group.key].length }} 条规则</summary><p>{{ group.hint }}</p>
        <article v-for="(rule, index) in config[group.key]" :key="index" class="rule">
          <div class="fields">
            <label>来源对象<select v-model="rule.objectType" :data-testid="`${group.key}-${index}-object`" @change="changeObject(rule, group.key)"><option v-for="table in tables" :key="table.name" :value="table.name">{{ table.name }} · {{ table.system }}</option></select></label>
            <template v-if="group.key === 'identities'">
              <label>统一业务类型<input v-model="rule.canonicalType" maxlength="160" :data-testid="`identity-${index}-type`" @input="changed" /></label>
              <label>业务粒度<input v-model="rule.granularity" maxlength="160" :data-testid="`identity-${index}-granularity`" @input="changed" /></label>
            </template>
            <template v-else>
              <label>来源字段<select v-model="rule.field" :data-testid="`${group.key}-${index}-field`" @change="group.key === 'units' ? changeUnitField(rule) : changed()"><option value="">请选择字段</option><option v-for="field in fieldsFor(rule.objectType, group.key === 'units' ? ['number','integer'] : ['string'])" :key="field.name" :value="field.name">{{ field.name }}</option></select></label>
            </template>
            <template v-if="group.key === 'units'">
              <label>源单位<select v-model="rule.sourceUnit" @change="changed"><option value="">请选择</option><option v-for="unit in ['kg','g','case','piece','CNY']" :key="unit">{{ unit }}</option></select></label>
              <label>目标单位<select v-model="rule.targetUnit" @change="changed"><option value="">请选择</option><option v-for="unit in ['kg','g','case','piece','CNY']" :key="unit">{{ unit }}</option></select></label>
              <label>逐行单位字段<select v-model="rule.unitField" @change="changed"><option value="">使用字典声明的单位</option><option v-for="field in fieldsFor(rule.objectType, ['string'])" :key="field.name">{{ field.name }}</option></select></label>
              <label>包装规格关联（箱 → 件必填）<select :value="rule.lookup?.viaField || ''" @change="changeLookup(rule, $event.target.value)"><option value="">不查包装规格</option><option v-for="field in references(rule.objectType)" :key="field.name" :value="field.name">{{ field.name }} → {{ field.reference }}</option></select></label>
              <label v-if="rule.lookup">{{ rule.lookup.objectType }} 的包装数量字段<select v-model="rule.lookup.valueField" @change="changed"><option value="">请选择</option><option v-for="field in numericFields(rule.lookup.objectType)" :key="field.name">{{ field.name }}</option></select></label>
            </template>
            <label class="wide">人工依据（业务规则或文档位置，不代表系统已核验证据）<input v-model="rule.evidence" maxlength="160" :data-testid="`${group.key}-${index}-evidence`" placeholder="例如：仓储字典第 3 节，包装数量按 SKU 维护" @input="changed" /></label>
            <label class="wide">绑定材料原文<select :value="rule.materialEvidence?.kind || ''" :data-testid="`${group.key}-${index}-material`" @change="changeEvidence(rule, $event.target.value)"><option value="">尚未绑定（仅人工说明）</option><option v-for="source in evidenceSources" :key="source.kind" :value="source.kind">{{ source.name }} · {{ source.kind }}</option></select></label>
            <template v-if="rule.materialEvidence">
              <label class="wide">原文摘录（12–2000 字符）<textarea v-model="rule.materialEvidence.quote" :data-testid="`${group.key}-${index}-quote`" maxlength="2000" rows="3" @input="changed" /></label>
              <details class="wide"><summary>查看当前材料原文并核对版本</summary><p>引用版本：{{ rule.materialEvidence.digest }}。重新选择材料会绑定当前版本并清空旧摘录。</p><pre class="source-text">{{ evidenceSources.find(source => source.kind === rule.materialEvidence.kind)?.text || '当前材料不可用' }}</pre></details>
            </template>
          </div>
          <div v-if="group.key !== 'units'" class="pairs">
            <div v-for="(pair, pairIndex) in (rule.aliases || rule.values)" :key="pairIndex" class="pair">
              <label>源{{ group.key === 'identities' ? '主键' : '状态' }}<input :value="pair.source" :data-testid="`${group.key}-${index}-${pairIndex}-source`" maxlength="160" @input="aliasValue(rule, pair, 'source', $event.target.value)" /></label><span aria-hidden="true">→</span>
              <label>目标{{ group.key === 'identities' ? '标识' : '状态' }}<input :value="pair.target" :data-testid="`${group.key}-${index}-${pairIndex}-target`" maxlength="160" @input="aliasValue(rule, pair, 'target', $event.target.value)" /></label>
              <button type="button" @click="(rule.aliases || rule.values).splice(pairIndex, 1); changed()">删除此映射</button>
            </div>
            <button type="button" :disabled="(rule.aliases || rule.values).length >= (rule.aliases ? 500 : 100)" @click="(rule.aliases || rule.values).push({source:'',target:''}); changed()">添加{{ rule.aliases ? '主键别名' : '状态映射' }}</button>
          </div>
          <button type="button" class="remove" :data-testid="`remove-${group.key}-${index}`" @click="config[group.key].splice(index, 1); changed()">删除规则 {{ index + 1 }}</button>
        </article>
        <button type="button" :data-testid="`add-${group.key}`" :disabled="!editable || config[group.key].length >= 40" @click="addRule(group.key)">＋ 添加{{ group.label }}规则</button>
      </details>
    </fieldset>
    <footer><button type="button" data-testid="save-alignment" :disabled="!editable || !dirty" @click="save">{{ saving ? '保存中…' : '保存业务对齐规则' }}</button><button type="button" data-testid="reload-alignment" :disabled="loading || saving || blocked" @click="load">{{ dirty ? '放弃修改并重新读取' : '刷新规则与验证结果' }}</button></footer>
    <section v-if="report" class="report" data-testid="alignment-report" aria-label="业务对齐验证结果">
      <h4>{{ report.status === 'validated_scope' ? '已配置范围通过验证' : '规则需修订，未输出对齐结果' }}</h4>
      <p>{{ report.boundary }} · 仅校验已配置规则，不代表完整世界模型。</p>
      <template v-if="report.materialEvidence"><p>{{ report.materialEvidence.status === 'quotes_verified' ? '材料版本与原文摘录匹配' : '材料引用尚待核对' }}：{{ report.materialEvidence.boundary }}</p><ul><li v-for="(issue, index) in report.materialEvidence.issues" :key="index">{{ issue.path }}：{{ issue.message }}</li></ul></template>
      <p>未配置对象：{{ report.unconfiguredObjects?.join('、') || '无或尚未评估' }}</p>
      <ul><li v-for="(issue, index) in report.issues" :key="index">{{ issue.path }}：{{ issue.message }}（{{ issue.code }}）</li></ul>
      <details v-for="(rows, key) in report.previews" :key="key"><summary>{{ ({identities:'标识', links:'关联', units:'单位', states:'状态'})[key] }}结果：处理 {{ report.counts?.[key] || 0 }} 条，预览 {{ rows.length }} 条</summary>
        <div class="table-scroll" tabindex="0"><table v-if="rows.length"><thead><tr><th v-for="field in Object.keys(rows[0])" :key="field">{{ field }}</th></tr></thead><tbody><tr v-for="(row, index) in rows" :key="index"><td v-for="field in Object.keys(rows[0])" :key="field">{{ row[field] }}</td></tr></tbody></table><p v-else>无可展示结果。</p></div>
      </details>
    </section>
  </section>
</template>

<style scoped>
.alignment { min-width:0; margin:18px 0; padding:16px; border:1px solid #34596a; border-radius:10px; background:#0b2330; color:#d5e7ef; overflow-wrap:anywhere; }
header,footer { display:flex; gap:12px; justify-content:space-between; align-items:center; flex-wrap:wrap; } h4 { margin:4px 0; } small { color:#8ecbcf; } p { font-size:12px; color:#aac3d0; margin:10px 0; }
fieldset { min-width:0; border:0; padding:0; margin:0; } details { border-top:1px solid #305061; padding:12px 0; } summary { cursor:pointer; font-weight:600; } .rule { padding:12px; margin:12px 0; background:#0a1b28; border:1px solid #335367; border-radius:8px; }
.fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; } .wide { grid-column:1/-1; } label { display:block; min-width:0; font-size:12px; color:#aac3d0; }
input,select { display:block; width:100%; box-sizing:border-box; min-width:0; margin-top:5px; padding:9px; background:#081924; border:1px solid #345367; border-radius:6px; color:#e4f0f4; font:inherit; }
textarea { width:100%; box-sizing:border-box; min-width:0; resize:vertical; background:#081924; color:#e4f0f4; border:1px solid #345367; border-radius:6px; padding:9px; font:inherit; } .source-text { white-space:pre-wrap; overflow-wrap:anywhere; max-height:220px; overflow:auto; font-size:12px; }
button { font:inherit; color:#d9eff4; padding:8px 12px; background:#174352; border:1px solid #4f8290; border-radius:6px; cursor:pointer; } button:disabled,fieldset:disabled { opacity:.55; } button:disabled { cursor:not-allowed; } :is(input,select,button,summary):focus-visible { outline:2px solid #82ddd0; outline-offset:3px; }
.pair { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto; gap:8px; align-items:end; margin:12px 0; } .pairs { margin-top:12px; } .remove { margin-top:12px; background:#362a2a; } .error { color:#ffc1ad; } .report { margin-top:18px; } .table-scroll { overflow:auto; max-width:100%; } table { border-collapse:collapse; font-size:12px; } th,td { text-align:left; padding:8px; border:1px solid #335367; min-width:90px; } footer { justify-content:flex-start; margin-top:12px; }
@media(max-width:768px) { .fields { grid-template-columns:minmax(0,1fr); } .pair { grid-template-columns:minmax(0,1fr); } .pair>span { display:none; } .alignment { padding:10px; } }
</style>

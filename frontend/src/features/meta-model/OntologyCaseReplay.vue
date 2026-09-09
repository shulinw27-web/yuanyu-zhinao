<script setup>
import { ref, watch } from 'vue';
const props = defineProps({ fingerprint: String, role: String, disabled: Boolean, execute: Function });
const input = ref(''); const report = ref(null); const error = ref(''); const busy = ref(false);
const outcomeLabel = (value) => ({ sufficient_snapshot: '单项库存快照充足', insufficient_snapshot: '单项库存快照不足', inventory_blocked: '库存受控', same_entity: '映射指向同一对象', different_entity: '映射指向不同对象', unresolved: '缺少有效映射', resolved: '存在已确认映射', related: '样本中关系有效', not_related: '样本中无有效关系', conflict: '存在冲突，需复核', needs_review: '需人工复核', investigation_recommended: '建议调查', review_recommended: '建议复核', closed: '已关闭', in_progress: '处理中' })[value] || value || '无基线';
const importCases = async (event) => {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file || props.disabled || busy.value) return;
  const current = ++generation; error.value = ''; report.value = null;
  if (file.size > 250000) { error.value = '样本超过 250 KB，请缩减后重试。'; return; }
  try { const content = await file.text(); if (current === generation) input.value = content; }
  catch { if (current === generation) error.value = '文件读取失败，请重新选择。'; }
};
let generation = 0;
watch(input, () => { generation++; report.value = null; error.value = ''; });
watch(() => [props.fingerprint, props.role, props.disabled], () => { generation++; report.value = null; error.value = ''; input.value = ''; });
const run = async () => {
  if (props.disabled || busy.value || !props.execute) return;
  const current = ++generation; busy.value = true; error.value = ''; report.value = null;
  try {
    if (input.value.length > 250000) throw new Error('样本超过 250 KB，请缩减后重试。');
    const cases = JSON.parse(input.value);
    if (!Array.isArray(cases) || !cases.length || cases.length > 100) throw new Error('请提供 1–100 个案例组成的 JSON 数组。');
    const result = await props.execute({ candidateFingerprint: props.fingerprint, cases });
    if (current === generation) report.value = result;
  } catch (err) { if (current === generation) error.value = err.message || '回放失败。'; }
  finally { busy.value = false; }
};
</script>
<template>
  <details v-if="execute" class="ontology-case-replay">
    <summary>授权样本回放 · 对比草稿与已发布版本</summary>
    <p>先保存编辑，再粘贴案例 JSON 数组。样本不会提交给大模型；只保存判定结果与版本引用，不保存原始记录。上传样本不等于已验证真实系统。</p>
    <p>判断案例包含 id、objectType、at、expected 和 record。关系历史案例使用 kind=relation_history，另含 knownAt、query、records 和 relations；at 是业务时刻，knownAt 是当时系统已知的截止时间。记录及关系均须经过身份范围核验。详见《业务场景建模与质量判断使用指南》。</p>
    <label>导入案例 JSON（仅填入编辑框，不自动执行）<input type="file" accept=".json,application/json" :disabled="disabled || busy" @change="importCases" /></label>
    <p>跨系统编号案例使用 kind=identity_mapping、query.left/right（来源系统、类型、编号）、records 和 mappings。仅核验显式映射；名称相似、编号相同不构成合并依据。</p>
    <label>案例 JSON<textarea v-model="input" :disabled="disabled || busy" maxlength="250001" placeholder='[{"id":"case-1","objectType":"QualityEvent","at":"2026-09-09T08:05:00Z","expected":"investigation_recommended","record":{...}}]' /></label>
    <button type="button" :disabled="disabled || busy || !input.trim()" @click="run">{{ busy ? '正在回放…' : '运行只读回放' }}</button>
    <small v-if="disabled">需具备校验权限，且当前编辑已保存。</small>
    <template v-if="report"><p v-for="item in report.cases?.filter(row => row.identity) || []" :key="item.id">编号核验 · {{ item.id }}：左侧 {{ outcomeLabel(item.identity.leftStatus) }} / 右侧 {{ outcomeLabel(item.identity.rightStatus) }}，有效映射 {{ item.identity.activeMappings }} 条。未写回或迁移任何源系统编号。</p></template>
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="report" aria-live="polite"><b>{{ report.status === 'passed' ? '样本全部通过' : '样本未通过' }} · {{ report.passed || 0 }}/{{ report.total || 0 }} · 版本差异 {{ report.changed || 0 }}</b><p v-if="report.code">拒绝原因：{{ report.code }}</p><ul><li v-for="item in report.cases" :key="item.id">{{ item.passed ? '通过' : '失败' }} · {{ item.id }}：期望 {{ outcomeLabel(item.expected) }} / 当前 {{ outcomeLabel(item.actual) }} / 已发布 {{ outcomeLabel(item.baseline) }}{{ item.stale ? '（证据过期）' : '' }}<p v-if="item.temporal">业务时刻 {{ item.temporal.validAt }} · 已知截止 {{ item.temporal.knownAt }}<br />可见修订 {{ item.temporal.visibleRevisions }} · 有效关系 {{ item.temporal.activeRelations }} · 命中 {{ item.temporal.matchedRelations }}<br />仅代表所提供历史样本；不自动合并或修改业务数据。</p></li></ul></div>
  </details>
</template>
<style scoped>
.ontology-case-replay{margin:16px 0;padding:16px;border:1px solid #315466;border-radius:10px;background:#0b2330;color:#cee7ee;min-width:0}.ontology-case-replay summary{cursor:pointer}.ontology-case-replay p,.ontology-case-replay small,.ontology-case-replay li{font-size:12px;line-height:1.7;overflow-wrap:anywhere}.ontology-case-replay label{display:grid;gap:8px;font-size:13px}.ontology-case-replay textarea{box-sizing:border-box;width:100%;min-height:150px;resize:vertical;background:#071b27;color:#d9edf1;border:1px solid #416172;border-radius:6px;padding:10px}.ontology-case-replay button{margin:10px 10px 0 0;padding:10px;border:1px solid #58bba6;border-radius:6px;background:#123a40;color:#a8ecda;cursor:pointer}.ontology-case-replay :disabled{opacity:.55;cursor:not-allowed}.ontology-case-replay :focus-visible{outline:2px solid #65d3ba;outline-offset:2px}
</style>

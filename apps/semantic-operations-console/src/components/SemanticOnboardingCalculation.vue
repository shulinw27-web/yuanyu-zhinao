<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
const props = defineProps({ client: Object, project: Object, canWrite: Boolean, blocked: Boolean });
const emit = defineEmits(['busy', 'open-model']);
const metadata = ref(null); const planId = ref(''); const target = ref(''); const report = ref(null); const error = ref(''); const busy = ref(false);
let generation = 0;
const invalidate = () => { generation++; metadata.value = null; planId.value = ''; target.value = ''; report.value = null; error.value = ''; busy.value = false; emit('busy', false); };
watch(() => [props.project?.id, props.project?.revision, props.canWrite, props.client], invalidate, { flush: 'sync' });
watch([planId, target], () => { generation++; report.value = null; busy.value = false; emit('busy', false); }, { flush: 'sync' });
watch(() => props.blocked, value => { if (value) invalidate(); }, { flush: 'sync' });
onBeforeUnmount(invalidate);
const runnable = computed(() => props.canWrite && !props.blocked && !busy.value && metadata.value?.revision === props.project?.revision
  && !metadata.value?.blockers?.length && metadata.value?.plans?.some(plan => plan.id === planId.value) && Boolean(target.value.trim()));
async function refresh() {
  if (!props.canWrite || props.blocked || busy.value || !props.project) return;
  const ticket = ++generation; busy.value = true; emit('busy', true); report.value = null; metadata.value = null; error.value = '';
  try {
    const value = await props.client.onboardingCalculations(props.project.id);
    if (ticket !== generation) return;
    if (value.projectId !== props.project.id || value.revision !== props.project.revision) throw new Error('项目版本已变化，请刷新项目。');
    metadata.value = value; planId.value = value.plans.some(plan => plan.id === planId.value) ? planId.value : value.plans[0]?.id || '';
  } catch (cause) { if (ticket === generation) error.value = cause.message || '读取方案失败。'; }
  finally { if (ticket === generation) { busy.value = false; emit('busy', false); } }
}
async function run() {
  if (!runnable.value) return;
  const ticket = ++generation; const input = { expectedRevision: props.project.revision, candidateFingerprint: metadata.value.candidateFingerprint, planId: planId.value, target: target.value.trim() };
  busy.value = true; emit('busy', true); report.value = null; error.value = '';
  try {
    const value = await props.client.previewOnboardingCalculation(props.project.id, input);
    if (ticket !== generation) return;
    if (value.projectId !== props.project.id || value.revision !== input.expectedRevision || value.candidateFingerprint !== input.candidateFingerprint || value.planId !== input.planId || value.target !== input.target
      || value.status !== 'calculated' || value.published !== false || value.executionAuthorized !== false) throw new Error('返回结果与本次草稿试算不一致，未展示。');
    report.value = value;
  } catch (cause) { if (ticket === generation) error.value = cause.message || '草稿试算失败，未生成业务结论。'; }
  finally { if (ticket === generation) { busy.value = false; emit('busy', false); } }
}
</script>
<template>
  <section class="onboarding-calculation" aria-label="草稿业务试算">
    <h4>用当前草稿核对一个业务编号</h4>
    <p>先采纳候选模型，再在模型校对中保存读取方案。试算会重新读取合成数据，不调用大模型、不发布、不执行业务动作；对象权限仍需管理员配置。</p>
    <div class="calculation-actions"><button type="button" :disabled="!canWrite || blocked || busy" @click="refresh">读取 / 刷新可用方案</button><button type="button" :disabled="blocked || busy" @click="emit('open-model')">前往模型校对配置方案</button></div>
    <ul v-if="metadata?.blockers?.length"><li v-for="item in metadata.blockers" :key="item">{{ item }}</li></ul>
    <template v-if="metadata">
      <div class="calculation-fields"><label>已保存方案<select v-model="planId" :disabled="blocked || busy || !canWrite"><option value="">请选择</option><option v-for="plan in metadata.plans" :key="plan.id" :value="plan.id">{{ plan.label }} · {{ plan.rootObjectType }}</option></select></label><label>业务编号<input v-model="target" :disabled="blocked || busy || !canWrite" maxlength="100" placeholder="输入订单、批次等根对象编号" /></label></div>
      <button type="button" :disabled="!runnable" @click="run">{{ busy ? '正在读取并计算…' : '只读试算，不发布' }}</button>
    </template>
    <p v-if="error" role="alert">{{ error }}</p>
    <section v-if="report" aria-live="polite"><h5>草稿试算结果 · 未发布</h5><dl><template v-for="item in report.results" :key="item.id"><dt>{{ item.label }}</dt><dd>{{ item.value === true ? '是' : item.value === false ? '否' : item.value }} {{ item.unit }}</dd></template></dl><p>业务编号：{{ report.target }}<br />快照：{{ report.snapshotId }}<br />草稿指纹：{{ report.candidateFingerprint }}<br />试算时间：{{ report.calculatedAt }}</p><p>{{ report.boundary }}</p></section>
  </section>
</template>
<style scoped>
.onboarding-calculation{margin-top:18px;padding:16px;border:1px solid #345266;border-radius:10px;background:#0b2330;min-width:0;color:#cee7ee}.onboarding-calculation p,.onboarding-calculation li{font-size:12px;line-height:1.7;overflow-wrap:anywhere}.calculation-actions{display:flex;gap:8px;flex-wrap:wrap}.calculation-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin:12px 0}.calculation-fields label{display:grid;gap:6px;font-size:12px}.onboarding-calculation input,.onboarding-calculation select{min-width:0;width:100%;box-sizing:border-box;padding:9px;border:1px solid #416172;border-radius:6px;background:#071b27;color:#d9edf1}.onboarding-calculation button{padding:9px 12px;border:1px solid #58bba6;border-radius:6px;background:#123a40;color:#a8ecda;cursor:pointer}.onboarding-calculation :disabled{opacity:.5;cursor:not-allowed}.onboarding-calculation :focus-visible{outline:2px solid #65d3ba;outline-offset:2px}.onboarding-calculation dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;font-size:13px}.onboarding-calculation dd{margin:0;overflow-wrap:anywhere}.onboarding-calculation [role=alert]{color:#ffbdad}@media(max-width:600px){.calculation-fields{grid-template-columns:minmax(0,1fr)}}
</style>

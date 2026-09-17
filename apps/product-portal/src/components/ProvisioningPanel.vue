<script setup>
import { computed, ref } from 'vue';
const props = defineProps({ tenant: { type: Object, required: true }, busy: Boolean });
const emit = defineEmits(['request', 'cancel']);
const confirmed = ref(false);
const requestId = crypto.randomUUID();
const manager = computed(() => ['owner', 'admin'].includes(props.tenant.role));
const job = computed(() => props.tenant.provisioning);
const active = computed(() => job.value && !['cancelled', 'superseded'].includes(job.value.status));
const status = value => ({ requested: '等待运维检查', checking: '正在检查', blocked: '有待准备事项', preflight_ready: '预检已通过，尚未激活', cancelled: '申请已取消', superseded: '申请已失效' }[value] || '尚未申请');
const names = { semantic_instance: '语义实例与持久化', business_iam: '企业身份与业务权限', runtime_entitlements: '运行权益与用量', runtime_revocation: '执行面撤权' };
const explanations = { semantic_instance: '由运维检查独立实例、租户绑定和持久化状态。', business_iam: '需要审核企业成员和身份源映射，不继承演示账号。', runtime_entitlements: '沙箱配额不等于正式付费权益或模型计费。', runtime_revocation: '沙箱准入已支持撤权检查，完整执行面仍需验收。' };
</script>

<template>
  <section class="panel runtime-request" aria-labelledby="runtime-request-title">
    <div class="runtime-request-heading"><div><p class="eyebrow">RUNTIME READINESS</p><h2 id="runtime-request-title">运行环境准备</h2></div><span class="badge">{{ manager ? status(job?.status) : '仅管理员可操作' }}</span></div>
    <p>这是运行环境的申请与预检，不会自动部署业务实例、授予企业权限或扣款。</p>
    <template v-if="manager">
      <p v-if="tenant.status !== 'sandbox_ready'" class="callout">{{ tenant.status === 'suspended' ? '当前空间已暂停，不能提交申请。' : '请先由平台完成测试空间审核。' }}</p>
      <template v-if="job"><p class="runtime-request-meta">申请编号：{{ job.id }} · 已检查 {{ job.attempts }} 次</p>
        <ul v-if="job.checks?.length" class="runtime-checks"><li v-for="check in job.checks" :key="check.id"><div><b>{{ names[check.id] || '运行检查' }}</b><small>{{ explanations[check.id] }}</small></div><span :class="['runtime-check-state', { passed: check.status === 'passed' }]">{{ check.status === 'passed' ? '已通过' : '待准备' }}</span></li></ul>
        <p v-else class="muted">{{ active ? '申请已记录。部署人员运行检查后，点击页面“刷新”查看结果。' : '申请已结束；确认当前空间状态后可重新申请。' }}</p>
      </template>
      <form v-if="tenant.status === 'sandbox_ready' && !active" @submit.prevent="confirmed && emit('request', requestId)">
        <label class="check"><input v-model="confirmed" type="checkbox" :disabled="busy"/><span>确认申请检查当前空间；理解这不代表企业工作台已开通。</span></label>
        <button class="button" :disabled="busy || !confirmed">申请运行环境预检</button>
      </form>
      <button v-if="active && tenant.status === 'sandbox_ready'" type="button" class="button secondary" :disabled="busy" @click="emit('cancel', job.id)">取消本次预检申请</button>
    </template>
    <p v-else class="muted">请联系本空间所有者或管理员准备运行环境。普通成员不能查看申请明细。</p>
  </section>
</template>

<style scoped>
.runtime-request{margin-top:24px}.runtime-request-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.runtime-request-heading h2{margin-bottom:12px}.runtime-request-meta{font-size:.875rem;overflow-wrap:anywhere}.runtime-checks{list-style:none;padding:0;margin:20px 0}.runtime-checks li{display:flex;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid var(--line)}.runtime-checks b{font-size:1rem}.runtime-checks small{display:block;font-size:.875rem;line-height:1.6;margin-top:5px;color:#52624b}.runtime-check-state{font-size:.875rem;color:#8a5718;white-space:nowrap}.runtime-check-state.passed{color:#38612e}.runtime-request .check{font-size:.875rem;line-height:1.6}@media(max-width:580px){.runtime-request-heading{flex-direction:column}.runtime-checks li{gap:10px}.runtime-request .button{width:100%}}
</style>

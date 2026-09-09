<script setup>
defineProps({ risk: Object, access: Object, role: String, message: String, buttonPermissionIds: { type: Array, default: () => [] } });
const emit = defineEmits(['close', 'acknowledge', 'approve']);
</script>
<template>
  <div v-if="risk" class="drawer-backdrop" @mousedown.self="emit('close')"><aside class="drawer"><button class="drawer-close" @click="emit('close')">×</button><span class="eyebrow">风险处置工作台</span><h2>{{ risk.title }}</h2><span :class="['risk-badge', risk.severity.toLowerCase()]">{{ risk.severity }} · {{ risk.status }}</span><p class="risk-summary">{{ risk.summary }}</p>
    <div class="impact-grid"><div><span>原料批</span><strong>{{ risk.affected.rawBatches }}</strong></div><div><span>生产批</span><strong>{{ risk.affected.productionBatches }}</strong></div><div><span>成品库存</span><strong>{{ risk.affected.inventory }}</strong></div><div><span>受影响订单</span><strong>{{ risk.affected.orders }}</strong></div></div>
    <div class="permission-note"><b>告警与授权说明</b><p>{{ risk.severityDefinition?.name || risk.severity }} · 默认 {{ risk.severityDefinition?.acknowledgementMinutes || '—' }} 分钟内确认</p><p>通知：{{ risk.notificationSummary?.channels?.join(' / ') || '按组织责任链编排' }}</p><p>本视图可见：{{ access?.fields }}</p><small>限制：{{ access?.restrict }}</small></div><h3>AI 建议动作</h3><div class="recommendation"><b>冻结关联库存并发起复核</b><span>证据：检验异常 → 原料已领用 → 成品批/订单影响</span></div>
    <div class="drawer-actions"><button v-if="buttonPermissionIds.includes('risk.acknowledge') && risk.status === '待确认'" class="button secondary" @click="emit('acknowledge')">确认进入处置</button><button v-if="buttonPermissionIds.includes('risk.approve') && risk.status !== '已审批'" class="button primary" @click="emit('approve')">批准冻结建议</button></div><p v-if="message" class="action-message">{{ message }}</p>
    <h3>审计轨迹</h3><div class="audit-list"><div v-for="(item, index) in risk.audit" :key="`${item.time}-${index}`" class="audit-item"><time>{{ item.time }}</time><div><strong>{{ item.actor }} · {{ item.action }}</strong><p>{{ item.detail }}</p></div></div></div>
  </aside></div>
</template>

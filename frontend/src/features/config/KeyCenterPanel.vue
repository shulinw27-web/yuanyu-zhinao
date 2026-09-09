<script setup>
defineProps({ center: Object, role: String, message: String, buttonPermissionIds: { type: Array, default: () => [] } });
defineEmits(['rotate', 'revoke']);
</script>

<template>
  <section v-if="center" class="panel key-center-panel">
    <div class="section-header">
      <div><span class="eyebrow">KEY CENTER MICROSERVICE</span><h2>密钥中心与短时凭据</h2><p>{{ center.policy }}</p></div>
      <div class="key-health"><b>{{ center.status }}</b><small>{{ center.adapter.provider }} · {{ center.architecture }}</small></div>
    </div>
    <div class="key-metrics"><article><span>有效租约</span><b>{{ center.metrics.activeLeaseCount }}</b><small>自动到期或可主动吊销</small></article><article><span>密钥策略</span><b>{{ center.metrics.policyCount }}</b><small>只保存引用与轮换元数据</small></article><article><span>审计事件</span><b>{{ center.metrics.auditEventCount }}</b><small>签发、过期、吊销与轮换</small></article><article><span>KMS 适配器</span><b>{{ center.adapter.mode }}</b><small>密钥材料不出 KMS/HSM</small></article></div>
    <p v-if="message" class="key-message">{{ message }}</p>
    <div class="key-policy-table"><div class="key-row key-head"><span>策略 / 连接器</span><span>分类与租约</span><span>版本与轮换</span><span>操作</span></div><div v-for="policy in center.policies" :key="policy.id" class="key-row"><div><b>{{ policy.name }}</b><small>{{ policy.id }} · {{ policy.connectorId }}</small><code>{{ policy.secretRef }}</code></div><div><span>{{ policy.classification }}</span><small>最长 {{ policy.maxTtlSeconds }} 秒</small></div><div><span>v{{ policy.version }} · {{ policy.status }}</span><small>{{ policy.rotationDays }} 天轮换</small></div><div><button v-if="role === 'executive' && buttonPermissionIds.includes('key.policy.rotate')" class="key-action" @click="$emit('rotate', policy.id)">触发轮换</button><em v-else>当前策略未授予轮换按钮</em></div></div></div>
    <div class="key-bottom-grid"><article><span class="eyebrow">RECENT LEASES</span><div v-if="center.leases.length" class="lease-list"><div v-for="lease in center.leases" :key="lease.id"><b>{{ lease.connectorId }} · {{ lease.operation }}</b><small>{{ lease.id }} · {{ lease.status }} · 到期 {{ new Date(lease.expiresAt).toLocaleTimeString('zh-CN') }}</small><button v-if="lease.status === 'active' && buttonPermissionIds.includes('key.lease.revoke')" @click="$emit('revoke', lease.id)">吊销</button></div></div><p v-else>当前角色尚无租约。租约只会在受控工具实际执行时按需签发。</p></article><article><span class="eyebrow">AUDIT STREAM</span><div v-if="center.auditEvents.length" class="audit-list"><div v-for="event in center.auditEvents" :key="event.id"><b>{{ event.event }}</b><small>{{ event.connectorId || event.policyId }} · {{ new Date(event.time).toLocaleString('zh-CN') }}</small></div></div><p v-else>暂无密钥中心审计事件。</p></article></div>
  </section>
</template>

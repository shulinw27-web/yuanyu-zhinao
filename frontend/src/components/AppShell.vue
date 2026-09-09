<script setup>
import { computed, watch } from 'vue';
import { canAccessPage } from '../permission-navigation.js';

const props = defineProps({ page: String, role: String, roles: Array, workspace: Object });
const emit = defineEmits(['navigate', 'update:role']);
const navItems = [
  { id: 'dashboard', label: '运营总览', icon: '01', hint: '全局态势与业务接入' },
  { id: 'intelligence', label: '智能中枢', icon: '02', hint: '7 × 24 运行大屏' },
  { id: 'agent', label: '智脑运营', icon: '03', hint: '私有 Agent 控制面' },
  { id: 'risks', label: '风险中心', icon: '04', hint: '风险闭环与人工确认' },
  { id: 'world', label: '语义层', icon: '05', hint: '语义建模、上下文与溯源' },
  { id: 'channels', label: '通知渠道', icon: '06', hint: '告警送达与升级策略' },
  { id: 'config', label: '配置与治理', icon: '07', hint: '连接、密钥与模型治理' },
  { id: 'permissions', label: '权限管理', icon: '08', hint: '人员、按钮与组织数据域' }
];
const visibleNavItems = computed(() => {
  const effectiveAccess = props.workspace?.effectiveAccess;
  const workspaceMatchesRole = effectiveAccess?.primaryRoleId === props.role;
  if (workspaceMatchesRole && effectiveAccess) return navItems.filter((item) => canAccessPage(item.id, effectiveAccess));
  return [];
});
const currentPageLabel = computed(() => navItems.find((item) => item.id === props.page)?.label || (props.page === 'procurement' ? '采购协同' : '运营控制台'));
watch([() => props.page, () => props.role, visibleNavItems], ([currentPage]) => {
  if (!visibleNavItems.value.length) return;
  if ((currentPage === 'procurement' && visibleNavItems.value.some((item) => item.id === 'agent')) || visibleNavItems.value.some((item) => item.id === currentPage)) return;
  emit('navigate', visibleNavItems.value[0].id);
}, { flush: 'post' });
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">Z</div><div><strong>元域智营</strong><span>HEALTH · AI OS</span></div></div>
      <div class="rail-status"><span class="rail-status-dot"/><div><b>智脑 · 受控运行</b><small>移动端为业务智能主入口</small></div></div>
      <div class="suite-label">CONTROL SURFACES</div>
      <div class="suite-stack">
        <div class="suite-active"><span>运营控制台</span><small>OBSERVE</small></div>
        <div class="suite-item muted"><span>元模型治理</span><small>GOVERN</small></div>
      </div>
      <nav class="main-nav"><span class="nav-label">OPERATIONS</span><button v-for="item in visibleNavItems" :key="item.id" :class="['nav-item', { active: page === item.id }]" @click="emit('navigate', item.id)"><span class="icon">{{ item.icon }}</span><span><b>{{ item.label }}</b><small>{{ item.hint }}</small></span></button></nav>
      <div class="sidebar-foot"><div><i/> 策略中心在线</div><span>身份、设备、数据域与工作流联合判定</span><em>KMS · 请求级短时凭据</em></div>
    </aside>
    <main class="main-content">
      <header class="topbar"><div><span class="crumb">CONTROL PLANE <i/> {{ currentPageLabel }}</span><h1>保健品 AI 基座运营平台</h1></div><div class="top-actions"><div class="live"><i /> 7 × 24 事件监控在线</div><div class="security-chip"><span>POLICY</span><b>ENFORCED</b></div><label class="role-picker">当前视角<select :value="role" @change="emit('update:role', $event.target.value)"><option v-for="item in roles" :key="item.id" :value="item.id">{{ item.name }} · {{ item.team }}</option></select></label></div></header>
      <slot />
    </main>
  </div>
</template>

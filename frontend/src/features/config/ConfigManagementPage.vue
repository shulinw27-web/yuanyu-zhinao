<script setup>
import { computed, ref, watch } from 'vue';
import AccountPermissionCenter from './AccountPermissionCenter.vue';
import KeyCenterPanel from './KeyCenterPanel.vue';
import SimulationControlCenter from './SimulationControlCenter.vue';

// 2026-09-25 阶段 2：本页已迁出「接入系统配置」「当前生效映射」「元模型连接模板」三项，
// 它们统一归口到元域智语端的「系统接入」视图（/api/semantic-operations/systems*）。
// 本页只保留平台级配置：监控/安全策略摘要、账号权限中心、Key Center、模拟控制中心、大模型连接配置。
const props = defineProps({ configuration: Object, modelConfig: Object, modelConfigMessage: String, simulation: Object, simulationMessage: String, accountCenter: Object, permissionCenter: Object, keyCenter: Object, keyCenterMessage: String, role: String, buttonPermissionIds: { type: Array, default: () => [] } });
const emit = defineEmits(['run-simulation-scenario', 'decide-simulation-approval', 'set-simulation-connector-fault', 'reset-simulation', 'save-model-config', 'rotate-key-policy', 'revoke-key-lease']);
const selectedModelProvider = ref('mock');
const modelEndpoint = ref('');
const modelName = ref('');
const modelApiKey = ref('');
const externalDataMode = ref('redacted');
const externalMultimodalMode = ref('metadata_only');
const canManageModel = computed(() => props.role === 'executive' && props.buttonPermissionIds.includes('agent.model.configure') && props.modelConfig?.runtimeConfiguration?.configurationSource !== 'environment');
const syncModelConnection = (providerId = selectedModelProvider.value) => {
  const provider = props.modelConfig?.providers?.find((item) => item.id === providerId);
  modelEndpoint.value = provider?.endpoint && provider.endpoint !== '未配置' ? provider.endpoint : '';
  modelName.value = provider?.model && provider.model !== 'not-configured' ? provider.model : '';
};
watch(() => props.modelConfig, (config) => {
  selectedModelProvider.value = config?.activeProvider || 'mock';
  externalDataMode.value = config?.externalDataMode || 'redacted';
  externalMultimodalMode.value = config?.externalMultimodalMode || 'metadata_only';
  syncModelConnection(selectedModelProvider.value);
}, { immediate: true });
watch(selectedModelProvider, (providerId) => { modelApiKey.value = ''; syncModelConnection(providerId); });
function saveModelConnection() {
  if (!canManageModel.value) return;
  emit('save-model-config', { mode: selectedModelProvider.value, baseUrl: modelEndpoint.value, model: modelName.value, apiKey: modelApiKey.value, externalDataMode: externalDataMode.value, externalMultimodalMode: externalMultimodalMode.value });
  modelApiKey.value = '';
}
</script>

<template>
  <div v-if="configuration" class="page config-page">
    <div class="section-header"><div><span class="eyebrow">PLATFORM CONFIGURATION</span><h2>配置管理</h2><p>统一管理监控与安全策略、账号权限、密钥中心、模拟运行时与大模型连接；系统接入与元模型映射已迁至元域智语端，Demo 中只展示受控配置快照。</p></div></div>
    <section class="config-summary"><article><span>监控策略</span><strong>{{ configuration.global.monitoring.enabled ? '已开启' : '已关闭' }}</strong><p>P0 {{ configuration.global.monitoring.p0EscalationMinutes }} 分钟升级 · {{ configuration.global.monitoring.riskRules }} 条风险规则</p></article><article><span>安全策略</span><strong>{{ configuration.global.security.policyMode }}</strong><p>{{ configuration.global.security.kmsMode }} · 审计保留 {{ configuration.global.security.auditRetentionDays }} 天</p></article><article><span>模型编排</span><strong>{{ configuration.global.models.orchestrator }}</strong><p>{{ configuration.global.models.production }} · {{ configuration.global.models.marketing }}</p></article></section>
    <AccountPermissionCenter :account-center="accountCenter" :permission-center="permissionCenter" :role="role" />
    <KeyCenterPanel :center="keyCenter" :role="role" :message="keyCenterMessage" :button-permission-ids="buttonPermissionIds" @rotate="$emit('rotate-key-policy', $event)" @revoke="$emit('revoke-key-lease', $event)" />
    <SimulationControlCenter :simulation="simulation" :role="role" :message="simulationMessage" :button-permission-ids="buttonPermissionIds" @run="$emit('run-simulation-scenario', $event)" @decide="$emit('decide-simulation-approval', $event)" @fault="$emit('set-simulation-connector-fault', $event)" @reset="$emit('reset-simulation')" />
    <section v-if="modelConfig" class="panel model-provider-config"><div class="section-header"><div><span class="eyebrow">MODEL CONNECTION CENTER</span><h2>大模型连接配置</h2><p>管理员可在此配置运行时连接。浏览器提交的密钥不会回显、不会写入本地存储或配置文件。</p></div><b>当前：{{ modelConfig.activeProvider }}</b></div><div class="provider-grid"><article v-for="provider in modelConfig.providers" :key="provider.id" :class="{ active: provider.id === modelConfig.activeProvider }"><div><span>{{ provider.id.toUpperCase() }}</span><b>{{ provider.name }}</b></div><strong>{{ provider.model }}</strong><small>{{ provider.endpoint || provider.credential }}</small><em :class="provider.configured ? 'configured' : 'unconfigured'">{{ provider.configured ? '服务端已配置' : '未配置 / 不可启用' }}</em><p>{{ provider.dataEgress }}</p></article></div><p class="external-data-note">外部模型上下文策略：<b>{{ modelConfig.externalDataMode }}</b>。只有服务端显式设为对应运行模式才会出网调用。</p><form class="model-connection-form" @submit.prevent="saveModelConnection"><div class="model-form-header"><div><h3>管理员运行时配置</h3><p>非密钥配置可持久化；密钥仅保存在服务端环境变量或进程内存。环境托管模式需修改服务配置并重启。</p></div><span v-if="modelConfig.runtimeConfiguration?.configuredInAdmin">本次进程已更新</span></div><div class="model-form-grid"><label>模型提供方<select v-model="selectedModelProvider" :disabled="!canManageModel"><option value="mock">离线演示模型</option><option value="ark">火山方舟（豆包 / 推理接入点）</option><option value="local">企业内网兼容模型</option><option value="openai">OpenAI Responses API</option><option value="deepseek">DeepSeek Chat API</option><option value="compatible">自定义兼容 API</option></select></label><label>服务地址<input v-model.trim="modelEndpoint" :disabled="!canManageModel || selectedModelProvider === 'mock'" :placeholder="selectedModelProvider === 'mock' ? '离线模型无需地址' : 'https://…/v1'" /></label><label>模型名称<input v-model.trim="modelName" :disabled="!canManageModel || selectedModelProvider === 'mock'" :placeholder="selectedModelProvider === 'mock' ? 'deterministic-demo' : '例如 gpt-5.6-sol'" /></label><label v-if="selectedModelProvider !== 'mock'">服务端 API Key <input v-model="modelApiKey" type="password" autocomplete="off" :disabled="!canManageModel" placeholder="留空则保留当前服务端密钥" /></label><label>外部数据策略<select v-model="externalDataMode" :disabled="!canManageModel"><option value="redacted">脱敏上下文（推荐）</option><option value="full">完整上下文</option></select></label><label>外部多模态策略<select v-model="externalMultimodalMode" :disabled="!canManageModel"><option value="metadata_only">仅材料元数据（推荐）</option><option value="approved">已审批图片可出网</option></select></label></div><div class="model-form-actions"><p v-if="canManageModel">密钥仅用于本次服务进程的内存配置，提交后输入框会立即清空。</p><p v-else>当前角色仅可查看连接状态；请使用管理角色配置密钥。</p><button type="submit" :disabled="!canManageModel">保存运行时配置</button></div><p v-if="modelConfigMessage" class="model-config-message">{{ modelConfigMessage }}</p></form></section>
  </div>
  <div v-else class="loading">正在读取配置中心…</div>
</template>

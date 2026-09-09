<script setup>
import { computed, ref, watch } from 'vue';
import WorldModelTemplateConfig from '../world-model/WorldModelTemplateConfig.vue';
import AccountPermissionCenter from './AccountPermissionCenter.vue';
import KeyCenterPanel from './KeyCenterPanel.vue';
import SimulationControlCenter from './SimulationControlCenter.vue';

const props = defineProps({ configuration: Object, modelConfig: Object, modelConfigMessage: String, simulation: Object, simulationMessage: String, worldTemplates: { type: Array, default: () => [] }, worldTargets: { type: Array, default: () => [] }, worldDrafts: { type: Array, default: () => [] }, accountCenter: Object, permissionCenter: Object, keyCenter: Object, keyCenterMessage: String, role: String, buttonPermissionIds: { type: Array, default: () => [] }, worldTemplateMessage: String });
const emit = defineEmits(['run-simulation-scenario', 'decide-simulation-approval', 'set-simulation-connector-fault', 'reset-simulation', 'save-model-config', 'create-world-draft', 'validate-world-draft', 'publish-world-draft', 'rotate-key-policy', 'revoke-key-lease']);
const selectedSystem = ref('lims');
const selected = computed(() => props.configuration?.systems.find((item) => item.systemId === selectedSystem.value));
const detail = computed(() => props.configuration?.connectedSystems.find((item) => item.id === selectedSystem.value));
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
    <div class="section-header"><div><span class="eyebrow">PLATFORM CONFIGURATION</span><h2>配置管理</h2><p>统一管理监控、模型、安全、系统接入与世界模型模板；Demo 中只展示受控配置快照。</p></div></div>
    <section class="config-summary"><article><span>监控策略</span><strong>{{ configuration.global.monitoring.enabled ? '已开启' : '已关闭' }}</strong><p>P0 {{ configuration.global.monitoring.p0EscalationMinutes }} 分钟升级 · {{ configuration.global.monitoring.riskRules }} 条风险规则</p></article><article><span>安全策略</span><strong>{{ configuration.global.security.policyMode }}</strong><p>{{ configuration.global.security.kmsMode }} · 审计保留 {{ configuration.global.security.auditRetentionDays }} 天</p></article><article><span>模型编排</span><strong>{{ configuration.global.models.orchestrator }}</strong><p>{{ configuration.global.models.production }} · {{ configuration.global.models.marketing }}</p></article></section>
    <AccountPermissionCenter :account-center="accountCenter" :permission-center="permissionCenter" :role="role" />
    <KeyCenterPanel :center="keyCenter" :role="role" :message="keyCenterMessage" :button-permission-ids="buttonPermissionIds" @rotate="$emit('rotate-key-policy', $event)" @revoke="$emit('revoke-key-lease', $event)" />
    <SimulationControlCenter :simulation="simulation" :role="role" :message="simulationMessage" :button-permission-ids="buttonPermissionIds" @run="$emit('run-simulation-scenario', $event)" @decide="$emit('decide-simulation-approval', $event)" @fault="$emit('set-simulation-connector-fault', $event)" @reset="$emit('reset-simulation')" />
    <section v-if="modelConfig" class="panel model-provider-config"><div class="section-header"><div><span class="eyebrow">MODEL CONNECTION CENTER</span><h2>大模型连接配置</h2><p>管理员可在此配置运行时连接。浏览器提交的密钥不会回显、不会写入本地存储或配置文件。</p></div><b>当前：{{ modelConfig.activeProvider }}</b></div><div class="provider-grid"><article v-for="provider in modelConfig.providers" :key="provider.id" :class="{ active: provider.id === modelConfig.activeProvider }"><div><span>{{ provider.id.toUpperCase() }}</span><b>{{ provider.name }}</b></div><strong>{{ provider.model }}</strong><small>{{ provider.endpoint || provider.credential }}</small><em :class="provider.configured ? 'configured' : 'unconfigured'">{{ provider.configured ? '服务端已配置' : '未配置 / 不可启用' }}</em><p>{{ provider.dataEgress }}</p></article></div><p class="external-data-note">外部模型上下文策略：<b>{{ modelConfig.externalDataMode }}</b>。只有服务端显式设为对应运行模式才会出网调用。</p><form class="model-connection-form" @submit.prevent="saveModelConnection"><div class="model-form-header"><div><h3>管理员运行时配置</h3><p>非密钥配置可持久化；密钥仅保存在服务端环境变量或进程内存。环境托管模式需修改服务配置并重启。</p></div><span v-if="modelConfig.runtimeConfiguration?.configuredInAdmin">本次进程已更新</span></div><div class="model-form-grid"><label>模型提供方<select v-model="selectedModelProvider" :disabled="!canManageModel"><option value="mock">离线演示模型</option><option value="ark">火山方舟（豆包 / 推理接入点）</option><option value="local">企业内网兼容模型</option><option value="openai">OpenAI Responses API</option><option value="deepseek">DeepSeek Chat API</option><option value="compatible">自定义兼容 API</option></select></label><label>服务地址<input v-model.trim="modelEndpoint" :disabled="!canManageModel || selectedModelProvider === 'mock'" :placeholder="selectedModelProvider === 'mock' ? '离线模型无需地址' : 'https://…/v1'" /></label><label>模型名称<input v-model.trim="modelName" :disabled="!canManageModel || selectedModelProvider === 'mock'" :placeholder="selectedModelProvider === 'mock' ? 'deterministic-demo' : '例如 gpt-5.6-sol'" /></label><label v-if="selectedModelProvider !== 'mock'">服务端 API Key <input v-model="modelApiKey" type="password" autocomplete="off" :disabled="!canManageModel" placeholder="留空则保留当前服务端密钥" /></label><label>外部数据策略<select v-model="externalDataMode" :disabled="!canManageModel"><option value="redacted">脱敏上下文（推荐）</option><option value="full">完整上下文</option></select></label><label>外部多模态策略<select v-model="externalMultimodalMode" :disabled="!canManageModel"><option value="metadata_only">仅材料元数据（推荐）</option><option value="approved">已审批图片可出网</option></select></label></div><div class="model-form-actions"><p v-if="canManageModel">密钥仅用于本次服务进程的内存配置，提交后输入框会立即清空。</p><p v-else>当前角色仅可查看连接状态；请使用管理角色配置密钥。</p><button type="submit" :disabled="!canManageModel">保存运行时配置</button></div><p v-if="modelConfigMessage" class="model-config-message">{{ modelConfigMessage }}</p></form></section>
    <WorldModelTemplateConfig :templates="worldTemplates" :targets="worldTargets" :drafts="worldDrafts" :role="role" :message="worldTemplateMessage" :button-permission-ids="buttonPermissionIds" @create="$emit('create-world-draft', $event)" @validate="$emit('validate-world-draft', $event)" @publish="$emit('publish-world-draft', $event)" />
    <section class="config-layout"><aside class="panel config-menu"><span class="eyebrow">CONNECTED SYSTEMS</span><h3>接入系统配置</h3><button v-for="system in configuration.connectedSystems" :key="system.id" :class="{ selected: selectedSystem === system.id }" @click="selectedSystem = system.id"><i :style="{ background: system.color }"/><div><strong>{{ system.code }}</strong><small>{{ system.name }}</small></div><span :class="system.status === '延迟' ? 'status-warning' : 'status-ok'">{{ system.status }}</span></button><div v-if="detail && selected" class="config-side-summary"><h4>当前接入摘要</h4><div><span>对象类型</span><b>{{ detail.objects.length }}</b></div><div><span>事件映射</span><b>{{ selected.mapping.length }}</b></div><div><span>今日事件</span><b>{{ detail.events }}</b></div><button>连通性测试</button></div></aside>
      <div v-if="detail && selected" class="config-content"><section class="panel integration-settings"><div class="config-heading"><div><span class="eyebrow">INTEGRATION SETUP</span><h2>{{ detail.name }}</h2><p>{{ detail.domain }} · {{ detail.mode }}</p></div><span :class="selected.enabled ? 'enabled-pill' : 'disabled-pill'">{{ selected.enabled ? '接入已启用' : '已停用' }}</span></div><div class="setting-grid"><div><span>配置负责人</span><b>{{ selected.owner }}</b></div><div><span>同步频率</span><b>{{ selected.syncInterval }}</b></div><div><span>上次同步</span><b>{{ detail.lastSync }}</b></div><div><span>凭据引用</span><b class="credential">{{ selected.credentialRef }}</b></div></div></section>
        <section class="panel ontology-mapping"><div class="section-header"><div><span class="eyebrow">ACTIVE WORLD MODEL MAPPING</span><h2>当前生效映射</h2><p>已发布映射以版本形式进入世界模型，随后才允许被 Agent 用作受控上下文。</p></div><button class="outline-button">新增映射</button></div><div class="mapping-table"><div class="mapping-head"><span>源表 / Topic</span><span>本体对象</span><span>业务事件</span><span>映射字段</span></div><div v-for="item in selected.mapping" :key="item.source" class="mapping-row"><code>{{ item.source }}</code><b>{{ item.object }}</b><span class="event-chip">{{ item.event }}</span><small>{{ item.fields }}</small></div></div><div class="mapping-note">发布前须经过：模板草稿 → 字段校验 → 关系与数据分级校验 → 管理层发布；所有版本均保留审计记录。</div></section>
      </div></section>
  </div>
  <div v-else class="loading">正在读取配置中心…</div>
</template>

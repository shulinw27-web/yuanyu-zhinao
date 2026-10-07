<script setup>
import { computed, ref, watch } from 'vue';
import { contactChannelOptions, contactPointIssue, contactPointPayload, createContactPointDraft, editableContactPoints } from './contact-point-editor.js';

const props = defineProps({
  notifications: { type: Array, default: () => [] },
  workspace: { type: Object, default: null },
  buttonPermissionIds: { type: Array, default: () => [] },
  message: { type: String, default: '' },
  saving: Boolean
});
const emit = defineEmits(['save-configuration', 'simulate-alert', 'test-voice', 'voice-event']);
const tabs = [{ id: 'levels', label: '告警等级' }, { id: 'contacts', label: '通知联系人' }, { id: 'routing', label: '路由模拟' }, { id: 'oncall', label: '值班升级' }, { id: 'voice', label: '虚拟电话' }, { id: 'deliveries', label: '送达审计' }];
const channelOptions = contactChannelOptions;
const activeTab = ref('levels');
const severityLevels = ref([]);
const providers = ref([]);
const schedules = ref([]);
const escalationPolicies = ref([]);
const contacts = ref([]);
const contactMessage = ref('');
const copyConfiguration = (value) => JSON.parse(JSON.stringify(value));
const testUserId = ref('usr-003');
const simulation = ref({ sourceSystem: 'LIMS', eventType: 'TestResultFailed', rawSeverity: '', organizationId: 'org-quality-dept', ownerUserId: 'usr-003', title: '模拟关键检验失败', affectedOrders: 2 });

watch(() => props.workspace, (workspace) => {
  severityLevels.value = copyConfiguration(workspace?.severityLevels || []);
  providers.value = copyConfiguration(workspace?.voiceProviders || []);
  schedules.value = copyConfiguration(workspace?.onCallSchedules || []);
  escalationPolicies.value = copyConfiguration(workspace?.escalationPolicies || []);
  contacts.value = editableContactPoints(workspace?.contactPoints || []);
  contactMessage.value = '';
  if (workspace?.contactPoints?.length && !workspace.contactPoints.some((item) => item.userId === testUserId.value)) testUserId.value = workspace.contactPoints[0].userId;
}, { immediate: true, deep: true });

const can = (permission) => props.buttonPermissionIds.includes(permission);
const metrics = computed(() => props.workspace?.metrics || {});
const eligibleContactUsers = computed(() => props.workspace?.eligibleContactUsers || []);
const contactValidation = computed(() => contactPointIssue(contacts.value));
const channelName = (id) => channelOptions.find((item) => item.id === id)?.name || id;
const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN') : '—';

function toggleChannel(level, channel) {
  const next = new Set(level.channels);
  if (next.has(channel)) next.delete(channel); else next.add(channel);
  level.channels = [...next];
}

function toggleContactChannel(contact, channel) {
  const next = new Set(contact.enabledChannels);
  if (next.has(channel)) next.delete(channel); else next.add(channel);
  contact.enabledChannels = [...next];
}

function addContact() {
  const configured = new Set(contacts.value.map((item) => item.userId));
  const firstAvailable = eligibleContactUsers.value.find((item) => !configured.has(item.id));
  contacts.value.push(createContactPointDraft(firstAvailable?.id || ''));
  contactMessage.value = '';
}

function removeContact(index) {
  contacts.value.splice(index, 1);
  contactMessage.value = '';
}

function publishContacts() {
  if (contactValidation.value) {
    contactMessage.value = contactValidation.value;
    return;
  }
  contactMessage.value = '';
  emit('save-configuration', {
    expectedVersion: props.workspace.configurationVersion,
    contactPoints: contactPointPayload(contacts.value)
  });
}

function publishConfiguration() {
  emit('save-configuration', {
    expectedVersion: props.workspace.configurationVersion,
    severityLevels: copyConfiguration(severityLevels.value),
    voiceProviders: providers.value.map(({ id, enabled, language, voice }) => ({ id, enabled, language, voice }))
  });
}

function publishOnCallConfiguration() {
  emit('save-configuration', {
    expectedVersion: props.workspace.configurationVersion,
    onCallSchedules: copyConfiguration(schedules.value),
    escalationPolicies: copyConfiguration(escalationPolicies.value)
  });
}

function runSimulation() {
  emit('simulate-alert', { ...simulation.value, affectedOrders: Number(simulation.value.affectedOrders || 0) });
}
</script>

<template>
  <div class="page alerting-page">
    <div class="section-header alerting-heading">
      <div><span class="eyebrow">ALERTING & VIRTUAL VOICE</span><h2>告警编排与虚拟电话</h2><p>P0、P1、P2 分级、组织责任链、值班升级、自动外呼与送达证据统一配置。</p></div>
      <div class="alerting-health"><i/><span>编排服务</span><b>运行正常</b><small>配置 v{{ workspace?.configurationVersion || '—' }} · 审计链 {{ workspace?.auditIntegrity?.valid ? '有效' : '待检查' }}</small></div>
    </div>

    <section v-if="workspace" class="alerting-metrics">
      <article><span>活动模拟告警</span><strong>{{ metrics.activeAlerts || 0 }}</strong><small>规则分级后进入编排</small></article>
      <article><span>虚拟电话</span><strong>{{ metrics.voiceCalls || 0 }}</strong><small>真实号码始终脱敏</small></article>
      <article><span>电话确认</span><strong>{{ metrics.acknowledgedCalls || 0 }}</strong><small>仅代表已收到告警</small></article>
      <article><span>送达成功率</span><strong>{{ metrics.deliverySuccessRate ?? 100 }}%</strong><small>Mock 全渠道回执</small></article>
    </section>
    <p v-if="message" class="action-message alerting-message">{{ message }}</p>

    <div v-if="workspace" class="alerting-layout">
      <nav class="alerting-tabs" aria-label="告警配置导航"><button v-for="tab in tabs" :key="tab.id" :class="{ active: activeTab === tab.id }" @click="activeTab = tab.id">{{ tab.label }}</button></nav>

      <section v-if="activeTab === 'levels'" class="panel alerting-panel">
        <div class="section-header"><div><span class="eyebrow">SEVERITY POLICY</span><h2>P0 / P1 / P2 等级策略</h2><p>分级由确定性规则完成；智脑只负责解释，不能自行提升或降低等级。</p></div><button v-if="can('notification.policy.publish')" class="button primary" :disabled="saving" @click="publishConfiguration">{{ saving ? '发布中…' : '发布配置' }}</button></div>
        <div class="severity-editor-grid">
          <article v-for="level in severityLevels" :key="level.id" :class="['severity-editor', level.id.toLowerCase()]">
            <header><span :style="{ background: level.color }">{{ level.id }}</span><div><h3>{{ level.name }}</h3><p>{{ level.description }}</p></div><label class="switch-line"><input v-model="level.enabled" type="checkbox" :disabled="!can('notification.policy.publish')"/>启用</label></header>
            <div class="severity-fields">
              <label>确认时限（分钟）<input v-model.number="level.acknowledgementMinutes" min="1" max="10080" type="number" :disabled="!can('notification.policy.publish')"/></label>
              <label>处置目标（分钟）<input v-model.number="level.resolutionMinutes" min="1" type="number" :disabled="!can('notification.policy.publish')"/></label>
              <label>电话策略<select v-model="level.voiceMode" :disabled="!can('notification.policy.publish')"><option value="immediate">立即外呼</option><option value="on_timeout">超时后外呼</option><option value="disabled">不外呼</option></select></label>
            </div>
            <div class="channel-checks"><span>启用渠道</span><label v-for="channel in channelOptions" :key="channel.id"><input type="checkbox" :checked="level.channels.includes(channel.id)" :disabled="!can('notification.policy.publish') || (level.id === 'P2' && channel.id === 'voice')" @change="toggleChannel(level, channel.id)"/>{{ channel.name }}</label></div>
          </article>
        </div>
        <div class="rule-list"><div v-for="rule in workspace.classificationRules" :key="rule.id"><span>{{ rule.priority }}</span><div><b>{{ rule.name }}</b><small>{{ rule.id }} · v{{ rule.version }}</small></div><em :class="rule.resultSeverity.toLowerCase()">{{ rule.resultSeverity }}</em></div></div>
      </section>

      <section v-else-if="activeTab === 'contacts'" class="panel alerting-panel">
        <div class="section-header"><div><span class="eyebrow">TENANT CONTACT DIRECTORY</span><h2>本租户通知联系人</h2><p>每个联系点只绑定当前租户已有的 IAM 用户；真实号码由受控 PII 引用保存，此处只展示脱敏号码。</p></div><div class="contact-actions"><button v-if="can('notification.policy.publish')" class="button secondary" :disabled="saving || contacts.length >= 200" @click="addContact">新增联系人</button><button v-if="can('notification.policy.publish')" class="button primary" :disabled="saving || Boolean(contactValidation)" @click="publishContacts">{{ saving ? '发布中…' : '发布联系人' }}</button></div></div>
        <p v-if="contactMessage || contactValidation" class="permission-warning">{{ contactMessage || contactValidation }}</p>
        <div v-if="contacts.length" class="contact-point-grid">
          <article v-for="(contact, index) in contacts" :key="`${contact.userId || 'new'}-${index}`" class="contact-point-card">
            <header><span>{{ index + 1 }}</span><div><b>{{ contact.userId || '待绑定 IAM 用户' }}</b><small>租户内身份与通知通道</small></div><button v-if="can('notification.policy.publish')" class="contact-remove" type="button" @click="removeContact(index)">移除</button></header>
            <div class="contact-fields"><label>IAM 用户<select v-model="contact.userId" class="contact-user-select" :disabled="!can('notification.policy.publish')"><option value="">请选择当前租户用户</option><option v-for="user in eligibleContactUsers" :key="user.id" :value="user.id">{{ user.name }} · {{ user.department }}（{{ user.id }}）</option></select></label><label>通知邮箱<input v-model.trim="contact.email" maxlength="254" type="email" placeholder="ops@example.com" :disabled="!can('notification.policy.publish')"/></label><label>脱敏电话<input v-model.trim="contact.maskedPhone" maxlength="40" placeholder="例如 139****0001" :disabled="!can('notification.policy.publish')"/></label></div>
            <div class="channel-checks"><span>允许渠道</span><label v-for="channel in channelOptions" :key="channel.id"><input type="checkbox" :checked="contact.enabledChannels.includes(channel.id)" :disabled="!can('notification.policy.publish')" @change="toggleContactChannel(contact, channel.id)"/>{{ channel.name }}</label></div>
          </article>
        </div>
        <div v-else class="contact-empty"><b>本租户尚未配置通知联系人</b><p>系统监控告警会保留为待发送，不会回退到 Demo 或其他租户联系人。</p></div>
        <p class="security-note">页面不会读取或返回真实电话号码、短信密钥和供应商凭据；已有 PII 电话引用在未显式提交新引用时由服务端保留。</p>
      </section>

      <section v-else-if="activeTab === 'routing'" class="panel alerting-panel">
        <div class="section-header"><div><span class="eyebrow">ROUTE SIMULATOR</span><h2>告警分级与路由模拟</h2><p>模拟事件会真实写入 Demo Outbox、送达记录和审计链；P0 将自动触发 Mock 电话。</p></div></div>
        <div class="simulation-form">
          <label>来源系统<select v-model="simulation.sourceSystem"><option>LIMS</option><option>QMS</option><option>MES</option><option>ERP</option><option>OMS</option></select></label>
          <label>事件类型<select v-model="simulation.eventType"><option>TestResultFailed</option><option>QualityReleaseBlocked</option><option>ProductionStopped</option><option>InventoryExpiring</option><option>OrderDelay</option><option>TrendNotice</option></select></label>
          <label>上游紧急信号<select v-model="simulation.rawSeverity"><option value="">由规则判定</option><option>P0</option></select></label>
          <label>责任组织<select v-model="simulation.organizationId"><option v-for="schedule in workspace.onCallSchedules" :key="schedule.organizationId" :value="schedule.organizationId">{{ schedule.name }}</option></select></label>
          <label>责任人<select v-model="simulation.ownerUserId"><option v-for="contact in workspace.contactPoints" :key="contact.userId" :value="contact.userId">{{ contact.userId }} · {{ contact.maskedPhone }}</option></select></label>
          <label>影响订单数<input v-model.number="simulation.affectedOrders" min="0" type="number"/></label>
          <label class="wide">告警标题<input v-model="simulation.title" maxlength="160"/></label>
        </div>
        <button v-if="can('notification.route.simulate')" class="button primary" :disabled="saving" @click="runSimulation">{{ saving ? '正在编排…' : '运行模拟并自动通知' }}</button>
        <p v-else class="permission-warning">当前角色可查看策略，但没有模拟告警路由的按钮权限。</p>
        <div class="simulation-results"><article v-for="alert in workspace.simulatedAlerts.slice(0, 8)" :key="alert.riskId"><span :class="['risk-badge', alert.severity.toLowerCase()]">{{ alert.severity }}</span><div><b>{{ alert.title }}</b><small>{{ alert.sourceSystem }} · {{ alert.eventType }} · {{ alert.riskId }}</small></div><em>{{ alert.status }}</em></article></div>
      </section>

      <section v-else-if="activeTab === 'oncall'" class="panel alerting-panel">
        <div class="section-header"><div><span class="eyebrow">ON-CALL & ESCALATION</span><h2>值班表与升级责任链</h2><p>责任人未确认时按策略升级；所有人员解析均受组织架构约束。</p></div><button v-if="can('oncall.schedule.manage') && can('notification.policy.publish')" class="button primary" :disabled="saving" @click="publishOnCallConfiguration">{{ saving ? '发布中…' : '发布值班与升级策略' }}</button></div>
        <div class="oncall-grid"><article v-for="schedule in schedules" :key="schedule.id"><header><span>24×7</span><b>{{ schedule.name }}</b><label class="oncall-enabled"><input v-model="schedule.enabled" type="checkbox" :disabled="!can('oncall.schedule.manage')"/>启用</label></header><div class="oncall-fields"><label>主值班<select v-model="schedule.primaryUserId" :disabled="!can('oncall.schedule.manage')"><option v-for="contact in workspace.contactPoints" :key="contact.userId" :value="contact.userId">{{ contact.userId }} · {{ contact.maskedPhone }}</option></select></label><label>第一备班<select v-model="schedule.backupUserIds[0]" :disabled="!can('oncall.schedule.manage')"><option value="">不配置</option><option v-for="contact in workspace.contactPoints" :key="contact.userId" :value="contact.userId">{{ contact.userId }} · {{ contact.maskedPhone }}</option></select></label></div><small>{{ schedule.organizationId }} · {{ schedule.timezone }}</small></article></div>
        <div class="escalation-list"><article v-for="policy in escalationPolicies" :key="policy.id"><header><span :class="['risk-badge', policy.severity.toLowerCase()]">{{ policy.severity }}</span><div><b>{{ policy.name }}</b><small>{{ policy.id }}</small></div><label class="oncall-enabled"><input v-model="policy.enabled" type="checkbox" :disabled="!can('notification.policy.publish')"/>启用</label></header><div class="escalation-steps"><div v-for="step in policy.steps" :key="step.order"><span>{{ step.order }}</span><label>接收责任<select v-model="step.receiverType" :disabled="!can('notification.policy.publish')"><option value="risk_owner">风险责任人</option><option value="on_call">当班人员</option><option value="organization_manager">组织负责人</option><option value="executive">管理层</option></select></label><label>累计延迟<input v-model.number="step.delayMinutes" min="0" max="10080" type="number" :disabled="!can('notification.policy.publish')"/></label><small>{{ step.delayMinutes ? `${step.delayMinutes} 分钟后` : '立即' }} · {{ step.channels.map(channelName).join(' / ') }}</small></div></div></article></div>
      </section>

      <section v-else-if="activeTab === 'voice'" class="panel alerting-panel">
        <div class="section-header"><div><span class="eyebrow">VIRTUAL VOICE</span><h2>虚拟电话供应商与测试</h2><p>当前使用 Mock Provider；云电话和 Asterisk 通过同一适配器接口扩展，密钥只保存 KMS 引用。</p></div></div>
        <div class="provider-grid"><article v-for="provider in providers" :key="provider.id"><header><span>☎</span><div><b>{{ provider.name }}</b><small>{{ provider.type }} · {{ provider.status }}</small></div><label><input v-model="provider.enabled" type="checkbox" :disabled="!can('notification.policy.publish') || provider.status === 'not_configured'"/>启用</label></header><p>语言 {{ provider.language }} · 音色 {{ provider.voice }}</p><p>凭据 {{ provider.type === 'mock' ? 'Mock 无需凭据' : provider.status === 'not_configured' && provider.credentialConfigured ? 'KMS 引用已预留，尚未激活' : provider.credentialConfigured ? '已通过 KMS 配置' : '尚未配置' }}</p></article></div>
        <div class="voice-test-bar"><label>测试接收人<select v-model="testUserId"><option v-for="contact in workspace.contactPoints" :key="contact.userId" :value="contact.userId">{{ contact.userId }} · {{ contact.maskedPhone }}</option></select></label><button v-if="can('notification.voice.test')" class="button primary" :disabled="saving || !testUserId" @click="emit('test-voice', { userId: testUserId })">拨打 Mock 测试电话</button></div>
        <div class="call-table"><article v-for="call in workspace.voiceCalls.slice(0, 20)" :key="call.id"><div class="call-state"><span>☎</span><b>{{ call.status }}</b></div><div><strong>{{ call.maskedNumber }} · {{ call.receiverUserId }}</strong><p>{{ call.severity }} · {{ call.riskId }} · {{ call.providerId }}</p><small>{{ call.id }} · {{ formatDate(call.startedAt) }}</small></div><em>{{ call.receiptStatus }}</em><div v-if="can('notification.voice.test')" class="call-actions"><button @click="emit('voice-event', { id: call.id, action: 'acknowledge' })">按 1 确认收到</button><button @click="emit('voice-event', { id: call.id, action: 'replay' })">按 2 重听</button><button @click="emit('voice-event', { id: call.id, action: 'escalate' })">按 3 升级</button></div></article></div>
        <p class="security-note">电话按键仅记录送达回执，不授予冻结、审批或业务写入权限。</p>
      </section>

      <section v-else class="panel alerting-panel">
        <div class="section-header"><div><span class="eyebrow">DELIVERY & EVIDENCE</span><h2>通知送达与完整审计链</h2><p>通知生成、渠道送达、电话播放、按键确认和升级均有哈希链记录。</p></div><span :class="['integrity-pill', { valid: workspace.auditIntegrity.valid }]">{{ workspace.auditIntegrity.valid ? 'SHA-256 校验通过' : '审计链异常' }}</span></div>
        <div class="delivery-table alerting-deliveries"><div v-for="item in notifications.slice(0, 40)" :key="item.id"><span>{{ item.id }}</span><b>{{ item.channel }}</b><p>{{ item.policy }} · {{ item.target }} · {{ item.riskId }}</p><em>{{ item.status }}</em><time>{{ item.time }}</time></div></div>
        <ol class="alert-audit-timeline"><li v-for="event in workspace.audits" :key="event.id"><i/><div><header><b>{{ event.summary }}</b><time>{{ formatDate(event.createdAt) }}</time></header><p>{{ event.type }} · {{ event.status }} · {{ event.riskId || '全局配置' }}</p><code>#{{ event.hash.slice(0, 16) }} · prev {{ event.previousHash?.slice(0, 10) || 'ROOT' }}</code></div></li></ol>
      </section>
    </div>
    <div v-else class="loading">正在加载告警编排工作区…</div>
  </div>
</template>

<style scoped>
.contact-user-select {
  min-width: 0;
  width: 100%;
  padding: 8px;
  border: 1px solid #2f6687;
  border-radius: 6px;
  background: #071d31;
  color: #dff6ff;
}
</style>

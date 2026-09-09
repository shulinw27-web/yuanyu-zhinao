<script setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({ templates: { type: Array, default: () => [] }, targets: { type: Array, default: () => [] }, drafts: { type: Array, default: () => [] }, role: String, message: String, buttonPermissionIds: { type: Array, default: () => [] } });
const emit = defineEmits(['create', 'validate', 'publish']);
const selectedTemplateId = ref('');
const selectedTargetId = ref('');
const selectedTemplate = computed(() => props.templates.find((item) => item.id === selectedTemplateId.value));
const selectedDraft = computed(() => props.drafts.find((item) => item.templateId === selectedTemplateId.value && item.targetId === selectedTargetId.value && item.status !== 'published') || props.drafts.find((item) => item.templateId === selectedTemplateId.value && item.targetId === selectedTargetId.value));
const canCreate = computed(() => ['executive', 'quality_manager'].includes(props.role) && props.buttonPermissionIds.includes('world.draft.create'));
const canValidate = computed(() => ['executive', 'quality_manager'].includes(props.role) && props.buttonPermissionIds.includes('world.draft.validate'));
const canPublish = computed(() => props.role === 'executive' && props.buttonPermissionIds.includes('world.draft.publish'));

watch(() => props.templates, (templates) => { if (!selectedTemplateId.value && templates.length) selectedTemplateId.value = templates[0].id; }, { immediate: true });
watch(selectedTemplate, (template) => { if (!template) return; const preferred = props.targets.find((target) => template.targets.includes(target.id)) || props.targets[0]; if (preferred) selectedTargetId.value = preferred.id; }, { immediate: true });
</script>

<template>
  <section class="panel world-template-config">
    <div class="section-header"><div><span class="eyebrow">META MODEL CONNECTION TEMPLATE</span><h2>元模型连接模板</h2><p>连接模板负责将系统字段映射到元模型对象；字段、关系、事件、数据分级与发布审批均可追溯。</p></div><b>{{ templates.length }} 个连接模板</b></div>
    <div class="template-workspace">
      <aside class="template-catalog"><button v-for="template in templates" :key="template.id" :class="{ selected: selectedTemplateId === template.id }" @click="selectedTemplateId = template.id"><i :style="{ background: template.color }"/><div><span>{{ template.code }} · v{{ template.version }}</span><b>{{ template.name }}</b><small>{{ template.category }}</small></div><em>{{ template.mappingCount }} 映射</em></button></aside>
      <div v-if="selectedTemplate" class="template-detail"><div class="template-heading"><div><span class="eyebrow">{{ selectedTemplate.code }} CONNECTION TEMPLATE</span><h3>{{ selectedTemplate.name }}</h3><p>{{ selectedTemplate.description }}</p></div><span class="template-governance">{{ selectedTemplate.governance.sensitivity }}</span></div>
        <div class="template-target"><label>映射目标系统<select v-model="selectedTargetId"><option v-for="target in targets" :key="target.id" :value="target.id">{{ target.code }} · {{ target.name }}（{{ target.status }}）</option></select></label><div class="template-actions"><button class="outline-button" :disabled="!canCreate" @click="emit('create', { templateId: selectedTemplate.id, targetId: selectedTargetId })">{{ selectedDraft ? '查看已有草稿' : '生成映射草稿' }}</button><button v-if="selectedDraft" class="outline-button" :disabled="!canValidate" @click="emit('validate', selectedDraft.id)">校验草稿</button><button v-if="selectedDraft" class="primary-button" :disabled="!canPublish || selectedDraft.validation?.status !== 'passed' || selectedDraft.status === 'published'" @click="emit('publish', selectedDraft.id)">{{ selectedDraft.status === 'published' ? '已发布' : '发布版本' }}</button></div></div>
        <p v-if="message" class="template-message">{{ message }}</p>
        <div class="template-meta"><span>对象映射 {{ selectedTemplate.mappingCount }}</span><span>关系 {{ selectedTemplate.relationshipCount }}</span><span>规则 {{ selectedTemplate.ruleCount }}</span><span>审批：{{ selectedTemplate.governance.approval }}</span></div>
        <div class="template-mapping-table"><div class="template-table-head"><span>源对象</span><span>世界模型对象</span><span>事件</span><span>主键</span><span>数据分级</span></div><div v-for="mapping in selectedDraft?.mappings || selectedTemplate.mappings" :key="mapping.source" class="template-table-row"><code>{{ mapping.source }}</code><b>{{ mapping.object }}</b><span>{{ mapping.event }}</span><small>{{ mapping.keys.join(' + ') }}</small><em>{{ mapping.classification }}</em></div></div>
        <div class="template-rules"><article><span>对象关系</span><p v-for="relationship in selectedDraft?.relationships || selectedTemplate.relationships" :key="relationship">{{ relationship }}</p></article><article><span>自动规则</span><p v-for="rule in selectedDraft?.rules || selectedTemplate.rules" :key="rule">{{ rule }}</p></article></div>
        <div v-if="selectedDraft?.validation" :class="['validation-board', selectedDraft.validation.status]"><b>校验结果：{{ selectedDraft.validation.status === 'passed' ? '通过' : '未通过' }}</b><span v-for="check in selectedDraft.validation.checks" :key="check.name">{{ check.status === 'passed' ? '✓' : '!' }} {{ check.name }}：{{ check.detail }}</span></div>
      </div>
    </div>
    <div class="draft-version-board"><div><span class="eyebrow">DRAFTS & VERSIONS</span><h3>映射草稿与生效版本</h3></div><p v-if="!drafts.length" class="empty-run">尚未创建模板映射草稿。</p><article v-for="draft in drafts" :key="draft.id"><div><b>{{ draft.templateName }}</b><span>{{ draft.targetName }} · {{ draft.status }}</span></div><small>{{ draft.version || '未发布版本' }} · {{ draft.createdBy }} · {{ draft.updatedAt }}</small><em :class="draft.validation?.status === 'passed' ? 'validated' : ''">{{ draft.validation?.status === 'passed' ? '已校验' : '待校验' }}</em></article></div>
  </section>
</template>

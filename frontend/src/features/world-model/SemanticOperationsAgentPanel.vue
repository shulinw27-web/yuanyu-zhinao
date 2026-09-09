<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client.js';

const props = defineProps({ role: String, canModel: Boolean });
const emit = defineEmits(['applied']);
const input = ref('');
const files = ref([]);
const proposal = ref(null);
const message = ref('');
const busy = ref(false);
const fileInput = ref(null);
const snapshots = ref([]);
const setInput = (value) => { input.value = String(value || ''); };
defineExpose({ setInput });
const canSubmit = computed(() => props.canModel && (input.value.trim() || files.value.length) && !busy.value);
const criticPassed = computed(() => proposal.value?.critic?.status === 'passed');

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('材料读取失败，请重新选择。'));
  reader.readAsDataURL(file);
});

async function selectFiles(event) {
  const selected = Array.from(event.target.files || []);
  event.target.value = '';
  if (!selected.length) return;
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
  if (files.value.length + selected.length > 3) { message.value = '一次最多上传 3 个材料。'; return; }
  try {
    const next = await Promise.all(selected.map(async (file) => {
      if (!allowed.has(file.type)) throw new Error('仅支持 JPEG、PNG、WEBP 图片和 PDF 文档。');
      if (file.size > 4 * 1024 * 1024) throw new Error('单个材料必须小于 4MB。');
      return { name: file.name, mimeType: file.type, dataUrl: await readAsDataUrl(file) };
    }));
    files.value.push(...next); message.value = '';
  } catch (error) { message.value = error.message || '材料读取失败。'; }
}

async function generate() {
  if (!canSubmit.value) return;
  busy.value = true; message.value = '';
  try {
    proposal.value = await api.createSemanticOperationsProposal({ text: input.value.trim(), attachments: files.value }, props.role);
    message.value = '草稿已生成。请先核对对象、字段和关系，再采纳到语义层草稿。';
  } catch (error) { message.value = error.message || '语义草稿生成失败。'; }
  finally { busy.value = false; }
}

async function loadSnapshots() {
  if (!props.canModel) return;
  try { snapshots.value = (await api.semanticOperationsSnapshots(props.role)).snapshots || []; }
  catch { snapshots.value = []; }
}

async function apply() {
  if (!proposal.value || busy.value) return;
  busy.value = true; message.value = '';
  try {
    const result = await api.applySemanticOperationsProposal(proposal.value.id, props.role);
    proposal.value = result.proposal;
    message.value = result.message;
    await loadSnapshots();
    emit('applied', result);
  } catch (error) { message.value = error.message || '草稿采纳失败。'; }
  finally { busy.value = false; }
}

async function rollback(snapshot) {
  if (!snapshot?.rollbackAllowed || busy.value) return;
  busy.value = true; message.value = '';
  try {
    const result = await api.rollbackSemanticOperationsSnapshot(snapshot.id, props.role);
    message.value = result.message;
    await loadSnapshots();
    emit('applied', result);
  } catch (error) { message.value = error.message || '快照回滚失败。'; }
  finally { busy.value = false; }
}

onMounted(loadSnapshots);
</script>

<template>
  <section class="panel semantic-operations-agent">
    <div class="section-header"><div><span class="eyebrow">SEMANTIC OPERATIONS AGENT</span><h2>语义运营 Agent</h2><p>面向数据与架构运营人员，不属于业务端智脑。用自然语言或受控材料生成可审阅的语义模型草稿。</p></div><b>{{ canModel ? '建模权限已校验' : '当前只读' }}</b></div>
    <div class="semantic-agent-boundary"><b>职责边界</b><span>业务端：智脑处理业务咨询与受控任务</span><span>运营端：本 Agent 生成、维护和登记语义模型</span><span>任何结果均先进入草稿，不直接发布或读取企业业务数据</span></div>
    <label class="semantic-agent-input">描述需要建设的语义模型<textarea v-model="input" :disabled="!canModel || busy" placeholder="例如：建立供应商、原料批次、来料检验和生产批次的语义模型；来源分别为 ERP、WMS、LIMS、MES，重点追溯原料到成品的关系。"/></label>
    <div v-if="files.length" class="semantic-agent-files"><span v-for="(file, index) in files" :key="`${file.name}-${index}`">{{ file.mimeType === 'application/pdf' ? 'PDF' : '图片' }} · {{ file.name }}<button :disabled="busy" @click="files.splice(index, 1)">×</button></span></div>
    <div class="semantic-agent-actions"><div><button class="outline-button" :disabled="!canModel || busy" @click="fileInput?.click()">上传数据字典 / 流程图</button><small>支持 PDF、PNG、JPG、WEBP；仅使用通过内容安全扫描的文本。</small></div><button class="primary-button" :disabled="!canSubmit" @click="generate">{{ busy ? '正在生成…' : '生成待审阅草稿' }}</button></div>
    <input ref="fileInput" class="file-input" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple @change="selectFiles"/>
    <p v-if="message" class="template-message">{{ message }}</p>
    <section v-if="proposal" class="semantic-proposal-preview"><header><div><span>待审阅草稿</span><b>{{ proposal.status === 'applied_to_draft' ? '已采纳到语义层草稿' : '尚未写入语义层' }}</b></div><small>{{ proposal.sourceSummary }}</small></header>
      <div class="schema-critic" :class="`critic-${proposal.critic?.status || 'unknown'}`"><header><div><span>SCHEMA CRITIC</span><b>{{ proposal.critic?.status === 'passed' ? '已通过结构校验' : '需要修复后再采纳' }}</b></div><small>在写入草稿前检查对象、来源、锚点和关系闭合；不会调用业务端智脑。</small></header><ul><li v-for="check in proposal.critic?.checks || []" :key="check.name"><b>{{ check.status === 'passed' ? '通过' : '失败' }}</b><span>{{ check.name }}：{{ check.detail }}</span></li></ul></div>
      <div class="semantic-diff"><header><b>版本 Diff（相对于当前草稿）</b><span>新增对象 {{ proposal.diff?.summary?.addedObjects || 0 }} · 更新对象 {{ proposal.diff?.summary?.updatedObjects || 0 }} · 新增关系 {{ proposal.diff?.summary?.addedRelationships || 0 }}</span></header><div class="diff-items"><span v-for="item in proposal.diff?.objectChanges?.filter((change) => change.change !== 'unchanged') || []" :key="item.id"><b>{{ item.change === 'added' ? '新增对象' : '更新对象' }}</b>{{ item.label }}（{{ item.id }}）</span><span v-for="item in proposal.diff?.relationshipChanges?.filter((change) => change.change === 'added') || []" :key="`${item.from}-${item.predicate}-${item.to}`"><b>新增关系</b>{{ item.from }} — {{ item.predicate }} → {{ item.to }}</span></div></div>
      <div class="proposal-columns"><div><b>对象（{{ proposal.objectTypes.length }}）</b><article v-for="item in proposal.objectTypes" :key="item.id"><strong>{{ item.label }}</strong><span>{{ item.id }} · {{ item.sourceSystems.join(' / ') }}</span><small>主键：{{ item.key }} · {{ item.fields.join('、') }}</small></article></div><div><b>关系（{{ proposal.relationshipTypes.length }}）</b><article v-for="item in proposal.relationshipTypes" :key="`${item.from}-${item.predicate}-${item.to}`"><strong>{{ item.from }} — {{ item.predicate }} → {{ item.to }}</strong><small>{{ item.evidence }}</small></article><p v-if="!proposal.relationshipTypes.length">请在语义画布中补充对象间关系。</p></div></div><ul><li v-for="note in proposal.reviewNotes" :key="note">{{ note }}</li></ul><button v-if="proposal.status === 'pending_review'" class="primary-button" :disabled="busy || !canModel || !criticPassed" @click="apply">{{ criticPassed ? '确认采纳到语义层草稿' : 'Schema Critic 未通过，暂不能采纳' }}</button></section>
    <section v-if="snapshots.length" class="semantic-snapshots"><header><div><span>草稿版本快照</span><b>仅可回滚自己创建的最新有效快照</b></div><small>回滚只恢复未发布的语义层草稿，不影响已登记到 Semantica 的版本。</small></header><article v-for="snapshot in snapshots" :key="snapshot.id"><div><b>{{ snapshot.status === 'active' ? '可回滚版本' : '已回滚版本' }}</b><span>{{ snapshot.createdAt }} · 新增对象 {{ snapshot.summary.addedObjects }} · 更新对象 {{ snapshot.summary.updatedObjects }} · 新增关系 {{ snapshot.summary.addedRelationships }}</span></div><button v-if="snapshot.rollbackAllowed" class="outline-button" :disabled="busy || !canModel" @click="rollback(snapshot)">回滚此版本</button></article></section>
  </section>
</template>

<style scoped>
.schema-critic,.semantic-diff,.semantic-snapshots{margin:12px 0;padding:11px;border:1px solid #d6e4ed;border-radius:7px;background:#fafdff}.schema-critic header,.semantic-diff header,.semantic-snapshots>header{display:flex;justify-content:space-between;gap:9px;align-items:start}.schema-critic header div,.semantic-snapshots header div{display:grid;gap:2px}.schema-critic header span,.semantic-snapshots header span{font-size:9px;letter-spacing:.08em;color:#517b95}.schema-critic header b,.semantic-snapshots header b{font-size:11px;color:#23617f}.schema-critic header small,.semantic-snapshots header small,.semantic-diff header span{font-size:10px;line-height:1.45;color:#637b90}.critic-passed{border-color:#94d6b4;background:#f4fcf7}.critic-passed header b{color:#137252}.critic-failed{border-color:#edb7b7;background:#fff8f8}.critic-failed header b{color:#ad3d3d}.schema-critic ul{display:grid;gap:5px;margin:9px 0 0;padding:0;list-style:none}.schema-critic li{display:flex;gap:6px;font-size:10px;line-height:1.45;color:#5e7485}.schema-critic li>b{flex:0 0 auto;padding:1px 5px;height:max-content;border-radius:3px;background:#ddf4e7;color:#167754;font-size:9px}.critic-failed .schema-critic li>b{background:#ffe7e7;color:#a63d3d}.semantic-diff{display:grid;gap:8px}.semantic-diff header>b{font-size:11px;color:#345b76}.diff-items{display:flex;flex-wrap:wrap;gap:5px}.diff-items span{padding:4px 6px;border-radius:4px;background:#eaf3f8;color:#557286;font-size:10px}.diff-items b{margin-right:4px;color:#176b9f}.semantic-snapshots{display:grid;gap:8px;margin-top:14px;background:#fff}.semantic-snapshots article{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px;border-top:1px solid #e4edf2}.semantic-snapshots article div{display:grid;gap:3px}.semantic-snapshots article b{font-size:11px;color:#285b78}.semantic-snapshots article span{font-size:10px;color:#6b8294}@media(max-width:760px){.schema-critic header,.semantic-diff header,.semantic-snapshots>header,.semantic-snapshots article{align-items:stretch;flex-direction:column}}
</style>

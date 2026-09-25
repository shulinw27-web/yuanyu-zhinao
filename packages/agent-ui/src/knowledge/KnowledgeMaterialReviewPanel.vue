<script setup>
import { computed, onUnmounted, ref } from 'vue';
const props = defineProps({ client: { type: Object, required: true }, canWrite: Boolean });
const emit = defineEmits(['reviewed-material']);
const attachment = ref(null); const previewUrl = ref(''); const result = ref(null); const selected = ref(0); const edits = ref([]);
const consent = ref(false); const checked = ref(false); const busy = ref(false); const error = ref(''); let generation = 0;
const current = computed(() => result.value?.items[selected.value]);
const mimeByExtension = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
async function choose(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file || busy.value) return;
  const mimeType = mimeByExtension[file.name.split('.').at(-1).toLowerCase()];
  if (!mimeType || file.size > 4 * 1024 * 1024) { error.value = '请选择支持格式且不超过 4MB 的材料。'; return; }
  const ticket = ++generation; busy.value = true; result.value = null; consent.value = false; checked.value = false; error.value = '';
  try {
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    if (ticket !== generation) return;
    attachment.value = { name: file.name, mimeType, dataUrl: `data:${mimeType};base64,${String(dataUrl).split(',')[1]}` };
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = mimeType.startsWith('image/') || mimeType === 'application/pdf' ? URL.createObjectURL(new Blob([file], { type: mimeType })) : '';
  } catch { if (ticket === generation) error.value = '本地文件读取失败。'; }
  finally { if (ticket === generation) busy.value = false; }
}
async function parse() {
  if (busy.value || !attachment.value || !consent.value || !props.canWrite) return;
  const ticket = ++generation; busy.value = true; error.value = ''; result.value = null; checked.value = false;
  try {
    const parsed = await props.client.previewMaterial({ attachments: [attachment.value], confirmed: true });
    if (ticket === generation) { result.value = parsed; selected.value = 0; edits.value = parsed.items.map(item => item.text); }
  } catch { if (ticket === generation) error.value = '材料解析或权限核验未通过，未保存资料。请检查格式、大小及内容安全配置。'; }
  finally { if (ticket === generation) busy.value = false; }
}
function transfer() {
  if (!props.canWrite || !checked.value || !result.value?.items.length) return;
  const text = result.value.items.map((item, i) => `[人工校对摘录 ${i + 1} | 来源 ${attachment.value.name} | 定位 ${JSON.stringify(item.locator)}]\n${edits.value[i]}`).join('\n\n');
  emit('reviewed-material', { title: `${attachment.value.name} · 人工校对`, source: attachment.value.name,
    text: `说明：这是人工校对的参考摘录，不是原文件的完整副本；定位仅供回到本地原文件核对，不能作为服务端已认证业务事实。\n${text}` });
}
onUnmounted(() => { generation++; if (previewUrl.value) URL.revokeObjectURL(previewUrl.value); });
</script>
<template>
  <details class="material-review"><summary>多模态材料校对 · 原文件 / 解析文本 / 人工修正</summary>
    <p>一次一份、最大 4MB。原文件只在当前页面预览；解析遵守现有内容安全、OCR 和视觉模型配置。未识别内容会明确提示。</p>
    <input type="file" accept=".pdf,.docx,.xlsx,.csv,.json,.yaml,.yml,.png,.jpg,.jpeg,.webp" :disabled="busy || !canWrite" aria-label="选择待校对材料" @change="choose" />
    <p v-if="attachment">{{ attachment.name }}</p>
    <label><input v-model="consent" type="checkbox" :disabled="busy || !canWrite" />确认使用企业配置的解析服务处理该材料；OCR / 视觉服务可能涉及外部传输。</label>
    <button :disabled="busy || !canWrite || !attachment || !consent" @click="parse">{{ busy ? '解析并扫描…' : '解析材料（不保存）' }}</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="result">
      <p>{{ result.summary }}</p><p>{{ result.notice }}</p>
      <p v-for="report in result.reports" :key="report.attachmentId">{{ report.name }}：{{ report.extractionComplete ? '解析流程完成，仍需核对格式限制' : '未完整读取' }}。{{ report.reason }} {{ (report.warnings || []).join(' ') }}</p>
      <div class="review-grid">
        <section><h4>本地原文件</h4><img v-if="previewUrl && attachment.mimeType.startsWith('image/')" :src="previewUrl" alt="待人工校对的本地原图" />
          <iframe v-else-if="previewUrl && attachment.mimeType === 'application/pdf'" :src="`${previewUrl}#page=${current?.locator.page || 1}`" title="本地 PDF 原文件预览" />
          <p v-else>Office 和结构化文件请在本地原应用核对；右侧保留提取出的单元格、段落或表格标记，不伪装成原版页面。</p>
        </section>
        <section><h4>解析文本与人工修正</h4>
          <select v-model="selected" aria-label="选择解析片段" :disabled="busy" @change="checked = false"><option v-for="(item, index) in result.items" :key="item.id" :value="index">{{ item.title }}</option></select>
          <template v-if="current"><small>解析器定位：{{ JSON.stringify(current.locator) }}</small><pre>{{ current.text }}</pre>
            <label>人工修正文本<textarea v-model="edits[selected]" rows="9" maxlength="24000" :disabled="busy || !canWrite" @input="checked = false" /></label></template>
        </section>
      </div>
      <label><input v-model="checked" type="checkbox" :disabled="busy || !canWrite" />已核对所选材料、解析范围和人工修正；同意转入个人参考资料编辑框。</label>
      <button :disabled="busy || !canWrite || !checked || !result.items.length" @click="transfer">转入资料编辑框（仍需确认保存）</button>
    </template>
  </details>
</template>
<style scoped>
.material-review{border:1px solid #46616c;border-radius:9px;padding:16px;margin:16px 0;min-width:0}.material-review summary{cursor:pointer}.review-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}.review-grid section{min-width:0}.review-grid img{max-width:100%;max-height:650px;object-fit:contain}.review-grid iframe{width:100%;height:600px;border:1px solid #46616c}.material-review pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}.material-review small{display:block;overflow-wrap:anywhere}.material-review textarea,.material-review select{width:100%;box-sizing:border-box}.material-review textarea,.material-review select,.material-review button{font:inherit;color:inherit;background:#102832;border:1px solid #46616c;border-radius:6px;padding:10px;min-height:40px;max-width:100%}.material-review label{display:block;margin:12px 0}.material-review button:disabled{opacity:.45}.material-review :focus-visible{outline:2px solid #57dbc4;outline-offset:2px}@media(max-width:850px){.review-grid{grid-template-columns:1fr}}
</style>

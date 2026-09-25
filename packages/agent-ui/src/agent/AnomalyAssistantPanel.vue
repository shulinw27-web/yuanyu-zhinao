<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
const props = defineProps({ client: { type: Object, required: true } });
const reports = ref([]); const labels = ref({}); const policy = ref(null); const selectedId = ref('');
const selected = computed(() => reports.value.find(r => r.id === selectedId.value));
const text = ref(''); const kind = ref('text'); const attachment = ref(null); const materialConsent = ref(false); const modelConsent = ref(false);
const values = ref({}); const reason = ref(''); const error = ref(''); const busy = ref(false); let generation = 0;
const reporterReply = ref(''); const reviewAcknowledged = ref(false);
const unsaved = computed(() => selected.value && Object.keys(labels.value).some(k => (values.value[k] || '') !== (selected.value.fields[k]?.value || '')));
let requestId = crypto.randomUUID();
const statusLabel = status => ({ draft: '待校对', awaiting_reporter: '待提报人确认', confirmed_report: '已确认汇报', retracted: '已撤回' }[status] || status);
const sourceLabel = kind => ({ text: '人工文字', manual_transcript: '人工转写', mock_group: '模拟群消息', material_observation: '附件解析候选', reporter_reply: '提报人回复（站内认证）' }[kind] || kind);
const canChange = computed(() => selected.value && selected.value.status !== 'retracted');
function choose(id) { selectedId.value = id; values.value = Object.fromEntries(Object.keys(labels.value).map(key => [key, selected.value?.fields[key]?.value || ''])); modelConsent.value = false; reason.value = ''; reporterReply.value = ''; reviewAcknowledged.value = false; }
async function run(work) {
  if (busy.value) return;
  const ticket = ++generation; busy.value = true; error.value = '';
  try { await work(ticket); }
  catch (cause) { if (ticket === generation) {
    const code = cause?.code || cause?.payload?.code;
    const messages = { ANOMALY_REVIEW_REQUIRED: '请先进行AI解读或保存人工校对，再生成新的确认请求。', ANOMALY_REVIEW_CONFLICT: '确认请求已变化或失效，请刷新并核对最新版本。', ANOMALY_REPORTER_REQUIRED: '只有原提报人可以回复或确认。', ANOMALY_MODEL_FIELDS_INVALID: '模型字段或分析未通过结构与原文引用核验。未保存本次候选，请人工校对或重新解读。', ANOMALY_MATERIAL_UNREADABLE: '附件没有形成可用的解析文本，请换清晰照片或补充文字。', ANOMALY_REQUIRED_FIELDS_MISSING: '请先保存地点和异常现象，再确认汇报。', ANOMALY_LIMIT: '个人工作区、来源或版本已达上限，本次没有保存。' };
    error.value = messages[code] || (cause?.payload?.diagnostics?.httpStatus === 403 ? '模型上游返回403，本次未提取字段。需要核对模型授权或账户状态，不能仅凭403判断欠费。' : cause?.status === 409 ? '记录或模型配置已变化，请刷新后重新核对。' : cause?.status === 403 ? '当前权限或服务端模型策略不允许此操作。' : '操作未完成，请检查材料、必填字段或模型服务；没有同步下游系统。');
  } }
  finally { if (ticket === generation) busy.value = false; }
}
async function refresh(ticket) {
  const data = await props.client.list(); if (ticket !== generation) return;
  reports.value = data.reports; labels.value = data.fields; policy.value = data.policy; choose(selectedId.value);
}
function accept(data, ticket) {
  if (ticket !== generation) return;
  reports.value = [data.report, ...reports.value.filter(r => r.id !== data.report.id)]; choose(data.report.id);
}
function source() { return { text: text.value, kind: kind.value, ...(attachment.value ? { attachments: [attachment.value], materialConfirmed: materialConsent.value } : {}) }; }
function inputChanged() { requestId = crypto.randomUUID(); }
async function submit(append = false) {
  await run(async ticket => {
    const data = append ? await props.client.change(selected.value.id, 'append', { expectedRevision: selected.value.revision, source: source() })
      : await props.client.create({ requestId, expectedRevision: 0, source: source() });
    accept(data, ticket);
    if (ticket === generation) { text.value = ''; attachment.value = null; materialConsent.value = false; requestId = crypto.randomUUID(); }
  });
}
async function change(action) {
  await run(async ticket => {
    const body = { expectedRevision: selected.value.revision };
    if (action === 'edit') { body.fields = Object.fromEntries(Object.entries(values.value).map(([k, v]) => [k, v.trim() || null])); body.reason = reason.value; }
    if (action === 'retract') body.reason = reason.value;
    if (action === 'confirm') { body.confirmed = reviewAcknowledged.value; body.reviewId = selected.value.review.id; }
    if (action === 'reply') { body.text = reporterReply.value; body.reviewId = selected.value.review.id; }
    if (action === 'extract') body.consent = { provider: policy.value.provider, model: policy.value.model, confirmed: modelConsent.value };
    accept(await props.client.change(selected.value.id, action, body), ticket);
  });
}
async function fileChanged(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  await run(async ticket => {
    if (file.size > 4 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type)) throw new Error('FILE_INVALID');
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    if (ticket === generation) { attachment.value = { name: file.name, mimeType: file.type, dataUrl }; materialConsent.value = false; inputChanged(); }
  });
}
onMounted(() => run(refresh)); onUnmounted(() => { generation++; });
</script>
<template>
  <section class="anomaly-workspace" aria-label="异常助手" :aria-busy="busy">
    <header><div><span class="anomaly-tag">异常助手 · 试运行</span><h2>把现场汇报整理成异常记录</h2><p>先保留证据，再校对字段。确认仅表示汇报已记录，不代表停机、冻结或建单已执行。</p></div><button :disabled="busy" @click="run(refresh)">刷新记录</button></header>
    <aside class="anomaly-boundary">当前：个人工作区 · 未连接钉钉群 · 未接入语音转写 · 未匹配业务台账 · 未同步ERP/MES/QMS。</aside>
    <p v-if="error" role="alert" class="anomaly-error">{{ error }}</p>
    <div class="anomaly-layout">
      <section class="anomaly-card">
        <h3>1. 提交或补充汇报</h3>
        <label>来源<select v-model="kind" :disabled="busy" @change="inputChanged"><option value="text">人工文字汇报</option><option value="manual_transcript">人工转写的语音内容</option><option value="mock_group">模拟群消息（非真实钉钉）</option></select></label>
        <label>汇报原文<textarea v-model="text" :disabled="busy" rows="6" maxlength="6000" placeholder="例如：二车间3号灌装机漏液，批次B240914，估计二十多箱受影响。" @input="inputChanged" /></label>
        <label>照片或PDF（每次一个，最大4MB）<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" :disabled="busy" @change="fileChanged" /></label>
        <template v-if="attachment"><p>{{ attachment.name }} <button :disabled="busy" @click="attachment = null; inputChanged()">移除附件</button></p><label class="check"><input v-model="materialConsent" type="checkbox" :disabled="busy" />允许使用企业已配置的OCR/视觉服务解析附件（可能出网）。</label><small>异常库保留解析文本及指纹，不保存原图；请另行保留原始文件。</small></template>
        <div class="actions"><button :disabled="busy || (!text.trim() && !attachment) || (attachment && !materialConsent)" @click="submit(false)">新建异常草稿</button><button :disabled="busy || !canChange || (!text.trim() && !attachment) || (attachment && !materialConsent)" @click="submit(true)">补充到选中异常</button></div>
        <h3>我的异常记录（{{ reports.length }}）</h3><p v-if="!reports.length">尚无记录。可以先提交模拟汇报，或不调用模型直接人工校对。</p>
        <div class="anomaly-list"><button v-for="report in reports" :key="report.id" :disabled="busy" :class="{ selected: selectedId === report.id }" @click="choose(report.id)"><b>{{ report.fields.phenomenon?.value || report.sources[0]?.text.slice(0, 50) || '待识别异常' }}</b><small>{{ statusLabel(report.status) }} · v{{ report.revision }}</small></button></div>
      </section>
      <section v-if="selected" class="anomaly-card">
        <h3>2. 核对结构化字段 <small>{{ statusLabel(selected.status) }} · v{{ selected.revision }}</small></h3>
        <p>缺失字段保持为空；数量和时间保留原话，不自动换算。字段有来源也不代表识别一定正确。</p>
        <p v-if="policy?.enabled">模型：{{ policy.provider }} / {{ policy.model }}</p><p v-else>服务端尚未开放异常资料的模型调用；可以人工填写字段。</p>
        <label v-if="policy?.enabled" class="check"><input v-model="modelConsent" type="checkbox" :disabled="busy || !canChange" />允许将本条异常的全部来源文本发送给上述模型，重新提取会替换当前字段并退回草稿。</label>
        <button :disabled="busy || !canChange || !modelConsent || !policy?.enabled" @click="change('extract')">AI解读与分析</button>
        <section class="anomaly-understanding" aria-label="AI理解与分析">
          <h3>AI如何理解这条汇报</h3>
          <p v-if="!selected.understanding">尚未生成AI分析。人工整理可以继续，但不会显示成AI结论。</p>
          <template v-else>
            <p v-if="selected.understanding.stale" class="anomaly-error">信息已修改，以下分析已过期，不能用于当前确认。请重新解读，或按人工校对流程继续。</p>
            <article v-for="(insight, index) in selected.understanding.insights" :key="index">
              <b>{{ { understanding: '消息理解', risk: '可能的风险 · 待核实', suggestion: '处理建议 · 未执行' }[insight.kind] }}</b><p>{{ insight.text }}</p>
              <small v-for="ref in insight.evidence" :key="ref.sourceId + ref.quote">依据：{{ ref.quote }}<br /></small>
            </article>
            <p>AI解释不等于已核实的原因；确认汇报不代表认可所有推测或授权执行建议。</p>
            <ul v-if="selected.understanding.questions.length"><li v-for="question in selected.understanding.questions" :key="question">待询问：{{ question }}</li></ul>
          </template>
        </section>
        <div class="anomaly-fields"><label v-for="(label, key) in labels" :key="key">{{ label }}<input v-model="values[key]" maxlength="300" :disabled="busy || !canChange" placeholder="未提供 / 待确认" /><small>{{ selected.fields[key]?.origin === 'human_correction' ? '人工校对' : selected.fields[key]?.sourceId ? '有来源引文 · 未核实' : '无已保存依据' }}</small></label></div>
        <label>更正或撤回原因<textarea v-model="reason" rows="2" maxlength="500" :disabled="busy || !canChange" placeholder="例如：汇报人更正了批次号。" /></label>
        <div class="actions"><button :disabled="busy || !canChange || !reason.trim()" @click="change('edit')">保存字段更正</button><button :disabled="busy || !canChange || !reason.trim()" @click="change('retract')">撤回汇报</button></div>
        <section class="anomaly-understanding" aria-label="提报人确认">
          <h3>3. 请原提报人回复与确认</h3>
          <p>当前提报人是本站登录的提交者，不是粘贴文本里的人名。真实群消息接通后，必须用平台认证的发送者身份绑定。</p>
          <button :disabled="busy || !canChange || unsaved || !selected.reviewReady || selected.status === 'confirmed_report' || selected.review?.status === 'awaiting_reporter'" @click="change('ask')">生成 @ 提报人确认请求</button>
          <p v-if="!selected.reviewReady && canChange">新增材料或回复后，请重新AI解读，或保存人工校对，再请求确认。</p>
          <template v-if="selected.review">
            <p class="anomaly-boundary">@ 消息仅为预览，未发送到钉钉。以下回复来自本站当前登录提报人。</p>
            <blockquote>{{ selected.review.message }}</blockquote>
            <template v-if="selected.review.status === 'awaiting_reporter' && canChange">
              <label>提报人补充 / 更正<textarea v-model="reporterReply" rows="3" maxlength="3000" :disabled="busy" placeholder="逐项回复不清楚的内容，或说明哪些信息需要更正。" /></label>
              <button :disabled="busy || unsaved || !reporterReply.trim()" @click="change('reply')">提交本人回复，重新整理</button>
              <label class="check"><input v-model="reviewAcknowledged" type="checkbox" :disabled="busy || unsaved" />我是提报人，已核对本次汇报信息。尚不确定的内容仍保持待核实；不授权任何业务操作。</label>
              <button :disabled="busy || unsaved || !!reporterReply.trim() || !reviewAcknowledged || !selected.fields.location?.value || !selected.fields.phenomenon?.value" @click="change('confirm')">本人确认本版本汇报</button>
            </template>
            <template v-else-if="selected.review.status === 'replied'"><p>已收到本人回复，需重新整理并确认：</p><blockquote>{{ selected.review.reply }}</blockquote></template>
            <p v-else>提报人已确认此版本；未写入业务系统。</p>
          </template>
        </section>
        <h3>4. 来源与历史</h3><details v-for="(item, index) in selected.sources" :key="item.id"><summary>来源{{ index + 1 }} · {{ sourceLabel(item.kind) }} · {{ item.receivedAt }}</summary><blockquote>{{ item.text }}</blockquote><small>指纹 {{ item.contentHash }}<br />{{ item.notice }}</small></details>
        <details><summary>版本记录（{{ selected.history.length }}）</summary><article v-for="version in selected.history" :key="version.revision"><b>v{{ version.revision }} · {{ statusLabel(version.status) }}</b><p>{{ version.reason }}</p><blockquote v-if="version.review">{{ version.review.message }}<br />{{ version.review.reply || '' }}</blockquote><dl><template v-for="(field, key) in version.fields" :key="key"><dt>{{ labels[key] }}</dt><dd>{{ field.value }}</dd></template></dl></article></details>
        <details><summary>结构化结果（仅内部汇报记录，未同步下游）</summary><pre>{{ JSON.stringify(selected, null, 2) }}</pre></details>
      </section>
      <section v-else class="anomaly-card empty">选择左侧记录开始校对。每条异常独立维护，不按时间接近自动合并。</section>
    </div>
  </section>
</template>
<style scoped>
.anomaly-understanding{border:1px solid #526366;border-radius:8px;padding:12px;margin:16px 0;overflow-wrap:anywhere}.anomaly-understanding article{padding:12px 0;border-bottom:1px solid #3b4546}.anomaly-understanding ul{padding-left:20px;line-height:1.8}
.anomaly-workspace{padding:20px;max-width:1500px;margin:auto;min-width:0;color:inherit}.anomaly-workspace header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.anomaly-workspace h2{font-size:22px;margin:10px 0}.anomaly-workspace p{line-height:1.7}.anomaly-tag{color:#60d6bd;font-size:12px}.anomaly-boundary{border-left:3px solid #e0af59;background:#25251e;padding:12px;line-height:1.7;margin:14px 0}.anomaly-layout{display:grid;grid-template-columns:minmax(260px,.8fr) minmax(0,1.4fr);gap:18px}.anomaly-card{padding:18px;border:1px solid #3b4546;border-radius:12px;min-width:0;background:#121b1e}.anomaly-card h3{font-size:16px;margin:10px 0 16px}.anomaly-workspace label{display:flex;flex-direction:column;gap:7px;margin:12px 0;font-size:13px}.anomaly-workspace input,.anomaly-workspace select,.anomaly-workspace textarea,.anomaly-workspace button{font:inherit;color:inherit;background:#1b2629;border:1px solid #526366;border-radius:7px;padding:10px;box-sizing:border-box;min-height:40px;max-width:100%}.anomaly-workspace button{cursor:pointer}.anomaly-workspace button:disabled{opacity:.45;cursor:default}.anomaly-workspace :focus-visible{outline:2px solid #60d6bd;outline-offset:2px}.anomaly-workspace small{font-size:11px;color:#abc0c2;overflow-wrap:anywhere}.anomaly-workspace .check{flex-direction:row;align-items:center;line-height:1.6}.check input{min-height:0}.anomaly-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}.actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.anomaly-list{display:grid;gap:8px;max-height:420px;overflow:auto}.anomaly-list button{display:flex;flex-direction:column;text-align:left;gap:8px;overflow-wrap:anywhere}.anomaly-list .selected{border-color:#60d6bd;background:#193c37}.anomaly-workspace details{border-top:1px solid #3b4546;padding:12px 0}.anomaly-workspace blockquote{margin:12px 0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}.anomaly-workspace pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto;font-size:12px}.anomaly-error{color:#ffb4a6}.empty{align-content:center;text-align:center;color:#abc0c2}.anomaly-workspace dd{margin:4px 0 12px;overflow-wrap:anywhere}.anomaly-workspace dt{color:#abc0c2}@media(max-width:1000px){.anomaly-layout{grid-template-columns:1fr}.anomaly-workspace{padding:12px}}@media(max-width:500px){.anomaly-fields{grid-template-columns:1fr}.anomaly-workspace header{flex-direction:column}}
</style>

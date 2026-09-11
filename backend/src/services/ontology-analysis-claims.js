import { createHash } from 'node:crypto';
import { inspectOntologyEvidenceClaims } from './ontology-analysis-validation.js';

const key = r => JSON.stringify([r.system, r.objectType, r.id, r.version]);
const own = (value, field) => Object.hasOwn(value, field);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(k => own(value, k));
const list = (value, limit) => Array.isArray(value) && value.length <= limit;
const distinct = values => new Set(values).size === values.length;
const escape = value => value.replace(/[<>&`*[\]\\]/g, c => `&#${c.charCodeAt(0)};`);
const display = value => escape(JSON.stringify(value) ?? 'null');
const label = value => escape(String(value));
// Record IDs, units and status codes count toward JS string length too. Keep
// concise prose as a prompt preference, with a separate bounded wire limit.
const MAX_NARRATIVE_CHARACTERS = 600;
const stringArray = { type: 'array', items: { type: 'string' } };
const narrativeArray = { type: 'array', items: { type: 'object', additionalProperties: false,
  properties: { text: { type: 'string' }, refs: stringArray }, required: ['text', 'refs'] } };
// The provider constrains JSON syntax/shape. Snapshot, provenance and bounds
// are independently enforced below, including for JSON-object-only providers.
export const ONTOLOGY_CLAIMS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { type: 'string', enum: ['ontology-claims.v2'] }, contextId: { type: 'string' },
    observations: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { record: { type: 'string' }, fields: stringArray }, required: ['record', 'fields'] } },
    metrics: stringArray, gaps: stringArray, hypotheses: narrativeArray, recommendations: narrativeArray
  }, required: ['schemaVersion', 'contextId', 'observations', 'metrics', 'gaps', 'hypotheses', 'recommendations']
};

// Call-local references bind the proposal to this authorized snapshot. They
// are not credentials and never grant permission to retrieve more records.
export function createOntologyClaimContext(records, comparisons, plan) {
  const recordEntries = records.map((record, i) => ({ ref: `r${i}`, record }));
  const metrics = comparisons.flatMap(c => c.results.map(result => ({ target: c.target, result }))).map((entry, i) => ({ ref: `m${i}`, ...entry }));
  const datasets = comparisons.flatMap(c => (plan?.datasets || []).filter(d => Array.isArray(c.datasets?.[d.id])).map(d => ({
    target: c.target, dataset: d.id, objectType: d.objectType, count: c.datasets[d.id].length
  }))).map((entry, i) => ({ ref: `d${i}`, ...entry }));
  const gaps = [
    ...recordEntries.flatMap(({ ref, record }) => Object.entries(record.payload).filter(([, value]) => value === null || value === '').map(([field]) => ({ reason: 'empty_field', record: ref, field }))),
    ...datasets.filter(d => d.count === 0).map(d => ({ reason: 'no_records', dataset: d.ref }))
  ].map((gap, i) => ({ ref: `g${i}`, ...gap }));
  const contextId = createHash('sha256').update(JSON.stringify({ roots: comparisons.map(c => c.target), records, metrics, datasets })).digest('hex').slice(0, 24);
  const catalog = { contextId, records: recordEntries.map(({ ref, record: r }) => [ref, r.system, r.objectType, r.id]),
    metrics: metrics.map(m => [m.ref, m.target, m.result.id]), datasets: datasets.map(d => [d.ref, d.target, d.dataset, d.objectType, d.count]), gaps };
  return { contextId, records: recordEntries, metrics, datasets, gaps, catalog };
}

export function ontologyClaimInstructions(context) {
  return `\n必须使用引用式分析契约，优先于上文的人读格式建议。仍返回 agent-summary.v1 外层，但 answer 必须是原生 JSON 对象，不要转成字符串，不加围栏。该对象恰好有 schemaVersion="ontology-claims.v2"、contextId、observations、metrics、gaps、hypotheses、recommendations。contextId原样回传，不需要的数组填[]。\n引用目录：${JSON.stringify(context.catalog)}\nobservations=[{"record":"r0","fields":["实际字段名"]}]，最多24项、每项最多12个字段，仅选相关记录，不返回字段值。逐笔问题覆盖所问明细；原因问题保留检验、事件和协作岗位，人员问题保留有效指派和人员。metrics 是选中的m引用字符串数组，服务端填入已算指标，不自行计算差额。至少选择一条 observation 或 metric。\ngaps 是g引用字符串数组，如["g0"]，只能从目录gaps选取。服务器已经列出真正为空的字段或查询结果；不接收自编缺口对象。0和false不是缺失，pending不是字段为空；没有候选就用[]。\nhypotheses 和 recommendations 各为[{"text":"待验证解释或建议","refs":["r0"]}]，各最多6项、text建议不超过240字（含编号、单位、状态码的硬上限为${MAX_NARRATIVE_CHARACTERS}字符），不要重复已选择的完整明细，refs为1至12个不重复且存在的r/m/d/g引用；g引用只能指向目录中已经确认的缺口。解释和建议不是已核验事实，不能否认已有证据、编造数字或宣称执行；需要外部复检或更细凭证时只提出核查建议，不断言企业缺少该材料。只回答当前问题，不展开无关领域。`;
}

// This validates reference existence, field values/absence, metric provenance
// and snapshot binding, NOT the semantic entailment of arbitrary prose.
export function validateOntologyClaims(text, context) {
  const fail = signal => ({ passed: false, signals: [signal], code: 'ANALYSIS_CLAIM_CONTRACT_INVALID' });
  if (typeof text !== 'string' || text.length > 16000) return fail('claim_payload_invalid');
  let value;
  try { value = JSON.parse(text); } catch { return fail('claim_json_required'); }
  if (!exact(value, ['schemaVersion', 'contextId', 'observations', 'metrics', 'gaps', 'hypotheses', 'recommendations'])
    || value.schemaVersion !== 'ontology-claims.v2' || value.contextId !== context.contextId) return fail('claim_context_or_schema_invalid');
  if (!list(value.observations, 24) || !list(value.metrics, 30) || !list(value.gaps, 16)
    || !list(value.hypotheses, 6) || !list(value.recommendations, 6) || !value.observations.length && !value.metrics.length) return fail('claim_bounds_invalid');
  const records = new Map(context.records.map(r => [r.ref, r.record]));
  const metrics = new Map(context.metrics.map(m => [m.ref, m]));
  const datasets = new Map(context.datasets.map(d => [d.ref, d]));
  const selected = new Set();
  for (const observation of value.observations) {
    if (!exact(observation, ['record', 'fields']) || !records.has(observation.record) || selected.has(observation.record)
      || !list(observation.fields, 12) || !observation.fields.length || !distinct(observation.fields)
      || observation.fields.some(f => typeof f !== 'string' || !own(records.get(observation.record).payload, f) || records.get(observation.record).payload[f] === undefined)) return fail('claim_record_or_field_invalid');
    selected.add(observation.record);
  }
  if (!distinct(value.metrics) || value.metrics.some(m => !metrics.has(m))) return fail('claim_metric_invalid');
  const gaps = new Map(context.gaps.map(g => [g.ref, g]));
  if (!distinct(value.gaps) || value.gaps.some(ref => !gaps.has(ref))) return fail('claim_gap_reference_invalid');
  for (const item of [...value.hypotheses, ...value.recommendations]) {
    if (!exact(item, ['text', 'refs']) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > MAX_NARRATIVE_CHARACTERS) return fail('claim_narrative_shape_invalid');
    if (!list(item.refs, 12) || !item.refs.length || !distinct(item.refs)) return fail('claim_narrative_reference_bounds');
    if (item.refs.some(r => !records.has(r) && !metrics.has(r) && !datasets.has(r) && !gaps.has(r))) return fail('claim_narrative_reference_unknown');
  }
  const narratives = [...value.hypotheses, ...value.recommendations].map(n => n.text).join('\n');
  const evidence = inspectOntologyEvidenceClaims(narratives, context.records.map(r => r.record));
  if (!evidence.passed) return { ...evidence, code: 'ANALYSIS_EVIDENCE_CONFLICT' };
  return { passed: true, signals: [], value };
}

export function renderOntologyClaims(validation, context) {
  if (!validation.passed) throw new Error('ANALYSIS_CLAIM_NOT_VALIDATED');
  const value = validation.value;
  const records = new Map(context.records.map(r => [r.ref, r.record]));
  const metrics = new Map(context.metrics.map(m => [m.ref, m]));
  const datasets = new Map(context.datasets.map(d => [d.ref, d]));
  const gaps = new Map(context.gaps.map(g => [g.ref, g]));
  const selectedGaps = value.gaps.map(ref => context.gaps.find(g => g.ref === ref));
  const describeSource = ref => records.has(ref) ? `${label(records.get(ref).system)}/${label(records.get(ref).objectType)} ${label(records.get(ref).id)}`
    : metrics.has(ref) ? `${label(metrics.get(ref).target)} ${label(metrics.get(ref).result.label)}`
      : `${label(datasets.get(ref).target)} ${label(datasets.get(ref).objectType)} 查询范围（${datasets.get(ref).count} 条）`;
  const describeRef = ref => {
    const gap = gaps.get(ref);
    if (!gap) return describeSource(ref);
    return gap.reason === 'empty_field' ? `${describeSource(gap.record)} 的 ${label(gap.field)} 为空`
      : `${describeSource(gap.dataset)}，本次未得到记录，不代表企业不存在`;
  };
  const sections = [];
  if (value.observations.length) sections.push(`已读取的来源事实：\n${value.observations.map(o => {
    const r = records.get(o.record);
    return `- ${describeRef(o.record)}：${o.fields.map(f => `${label(f)}=${display(r.payload[f])}`).join('；')}`;
  }).join('\n')}`);
  if (value.metrics.length) sections.push(`声明范围内的计算：\n${value.metrics.map(ref => { const m = metrics.get(ref); return `- ${describeRef(ref)}：${display(m.result.value)} ${label(m.result.unit || '')}`; }).join('\n')}`);
  if (selectedGaps.length) sections.push(`本轮可核验的证据缺口：\n${selectedGaps.map(g => g.reason === 'no_records'
    ? `- ${label(datasets.get(g.dataset).target)} 的 ${label(datasets.get(g.dataset).objectType)}：本次声明查询条件下未得到记录，不代表企业不存在。`
    : `- ${describeRef(g.record)} 的 ${label(g.field)} 为空，尚未提供该字段的有效值。`).join('\n')}`);
  for (const [field, heading] of [['hypotheses', '待验证的解释（不是已确认结论）'], ['recommendations', '建议（尚未执行）']]) {
    if (value[field].length) sections.push(`${heading}：\n${value[field].map(n => `- ${n.text}（参考：${n.refs.map(describeRef).join('、')}）`).join('\n')}`);
  }
  const refs = new Set([...value.observations.map(o => o.record), ...value.hypotheses.flatMap(n => n.refs), ...value.recommendations.flatMap(n => n.refs), ...selectedGaps.map(g => g.record).filter(Boolean)]);
  for (const ref of refs) if (gaps.get(ref)?.record) refs.add(gaps.get(ref).record);
  return { text: sections.join('\n\n'), citations: context.records.filter(r => refs.has(r.ref)).map(({ ref, record: r }) => ({ ref, key: key(r), system: r.system, objectType: r.objectType, id: r.id, version: r.version })),
    verification: { schemaVersion: value.schemaVersion, contextId: context.contextId, sourceReferencesVerified: true, metricReferencesVerified: true, gapClaimsVerified: true, narrativeEntailmentVerified: false } };
}

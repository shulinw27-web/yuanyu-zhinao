export const ANOMALY_FIELDS = Object.freeze({ location: '地点', equipment: '设备', batch: '批次', phenomenon: '异常现象', quantity: '影响数量（原话）', occurredAt: '发生时间（原话）', reportedAction: '已采取措施（汇报）' });
export const ANOMALY_ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['fields', 'insights', 'questions'], properties: {
    fields: { type: 'array', maxItems: 7, items: { type: 'object', additionalProperties: false,
      required: ['field', 'source', 'quote'], properties: { field: { type: 'string', enum: Object.keys(ANOMALY_FIELDS) }, source: { type: 'integer', minimum: 1 }, quote: { type: 'string', minLength: 1, maxLength: 300 } } } },
    insights: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', additionalProperties: false,
      required: ['kind', 'text', 'evidence'], properties: { kind: { type: 'string', enum: ['understanding', 'risk', 'suggestion'] }, text: { type: 'string', minLength: 1, maxLength: 600 },
        evidence: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['source', 'quote'], properties: { source: { type: 'integer', minimum: 1 }, quote: { type: 'string', minLength: 1, maxLength: 300 } } } } } } },
    questions: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 300 } }
  }
};

// Extractive values only. A matching quote proves provenance, not truth or correct classification.
export function parseAnomalyFields(text, sources) {
  let answer; try { answer = JSON.parse(text); } catch { return null; }
  if (!answer || Array.isArray(answer) || Object.keys(answer).length !== 1 || !Array.isArray(answer.fields) || answer.fields.length > 7) return null;
  const fields = {}; const seen = new Set();
  for (const item of answer.fields) {
    if (!item || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'field,quote,source'
      || !Object.hasOwn(ANOMALY_FIELDS, item.field) || seen.has(item.field) || !Number.isInteger(item.source)
      || typeof item.quote !== 'string' || !item.quote.trim() || item.quote.length > 300) return null;
    const source = sources[item.source - 1];
    if (!source || !source.text.includes(item.quote)) return null;
    seen.add(item.field);
    fields[item.field] = { value: item.quote, sourceId: source.id, origin: source.kind, verification: 'unverified_report' };
  }
  return fields;
}

// Narrative is a model interpretation, never a verified cause or an execution receipt.
export function parseAnomalyUnderstanding(text, sources, isSafe) {
  let answer; try { answer = JSON.parse(text); } catch { return null; }
  if (!answer || Object.keys(answer).sort().join(',') !== 'fields,insights,questions') return null;
  const fields = parseAnomalyFields(JSON.stringify({ fields: answer.fields }), sources);
  const bounded = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max && isSafe(value);
  if (!fields || !Array.isArray(answer.insights) || !answer.insights.length || answer.insights.length > 6
    || !Array.isArray(answer.questions) || answer.questions.length > 5 || answer.questions.some(q => !bounded(q, 300))) return null;
  const insights = [];
  for (const item of answer.insights) {
    if (!item || Object.keys(item).sort().join(',') !== 'evidence,kind,text' || !['understanding', 'risk', 'suggestion'].includes(item.kind)
      || !bounded(item.text, 600) || !Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 3) return null;
    const evidence = [];
    for (const ref of item.evidence) {
      if (!ref || Object.keys(ref).sort().join(',') !== 'quote,source' || !Number.isInteger(ref.source) || !bounded(ref.quote, 300)
        || !sources[ref.source - 1]?.text.includes(ref.quote)) return null;
      evidence.push({ sourceId: sources[ref.source - 1].id, quote: ref.quote });
    }
    insights.push({ kind: item.kind, text: item.text.trim(), evidence, verification: 'ai_interpretation_unverified' });
  }
  if (!insights.some(item => item.kind === 'understanding')) return null;
  return { fields, understanding: { insights, questions: [...new Set(answer.questions.map(q => q.trim()))] } };
}

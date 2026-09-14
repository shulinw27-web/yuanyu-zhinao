export const ANOMALY_FIELDS = Object.freeze({ location: '地点', equipment: '设备', batch: '批次', phenomenon: '异常现象', quantity: '影响数量（原话）', occurredAt: '发生时间（原话）', reportedAction: '已采取措施（汇报）' });
export const ANOMALY_ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['fields'], properties: {
    fields: { type: 'array', maxItems: 7, items: { type: 'object', additionalProperties: false,
      required: ['field', 'source', 'quote'], properties: { field: { type: 'string', enum: Object.keys(ANOMALY_FIELDS) }, source: { type: 'integer', minimum: 1 }, quote: { type: 'string', minLength: 1, maxLength: 300 } } } }
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

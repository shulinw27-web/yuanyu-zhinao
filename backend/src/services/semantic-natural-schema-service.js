import { generateModelSummary, getLocalModelRuntime } from './local-model-gateway.js';
import { normalizeUntrustedText } from './prompt-security-service.js';

// Literal evidence is required for every table/field/key. Unknown source systems
// remain UNASSIGNED and block publication; model suggestions never become facts.
export function validateNaturalSchema(value, material, diagnostics = []) {
  const reject = code => { diagnostics.push(code); return null; };
  if (!value || !Array.isArray(value.tables) || !value.tables.length || value.tables.length > 40) return reject('TABLES_INVALID');
  const normalizedMaterial = normalizeUntrustedText(material);
  const quotePresent = (quote, token) => typeof quote === 'string' && quote.includes(token) && normalizedMaterial.includes(normalizeUntrustedText(quote));
  const names = new Set(value.tables.map(table => table.name));
  if (names.size !== value.tables.length) return reject('TABLES_DUPLICATED');
  const objectTypes = [];
  const relationshipTypes = [];
  for (const table of value.tables) {
    if (typeof table.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,100}$/.test(table.name) || !quotePresent(table.evidence, table.name)
      || !Array.isArray(table.fields) || table.fields.length < 2 || table.fields.length > 80) return reject('TABLE_EVIDENCE_INVALID');
    const fields = table.fields.map(field => field.name);
    if (new Set(fields).size !== fields.length || !fields.includes(table.key) || !quotePresent(table.keyEvidence, table.key) || !/主键|primary.?key|\bPK\b/i.test(table.keyEvidence)) return reject('PRIMARY_KEY_EVIDENCE_INVALID');
    for (const field of table.fields) {
      if (typeof field.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,100}$/.test(field.name) || !quotePresent(field.evidence, field.name)) return reject('FIELD_EVIDENCE_INVALID');
      if (field.reference) {
        if (!names.has(field.reference)) return reject('FOREIGN_KEY_TARGET_INVALID');
        if (!quotePresent(field.referenceEvidence, field.name)) return reject('FOREIGN_KEY_QUOTE_INVALID');
        if (!/外键|foreign.?key|引用|关联|\bFK\b/i.test(`${field.referenceEvidence}\n${field.evidence}`)) return reject('FOREIGN_KEY_MARKER_INVALID');
        relationshipTypes.push({ from: table.name, to: field.reference, predicate: `references_${field.name}`, label: `${table.name}.${field.name} 引用 ${field.reference}`, cardinality: 'n:1', evidence: field.referenceEvidence });
      }
    }
    objectTypes.push({ id: table.name, label: table.label || table.name, source: `unassigned.${table.name}`, key: table.key, fields,
      classification: '内部受限（待复核）', semanticType: table.name, coreObject: table.name, sourceSystems: ['UNASSIGNED'],
      fieldDefinitions: table.fields.map(field => ({ name: field.name, type: 'string', required: field.name === table.key, primaryKey: field.name === table.key, sourceField: field.name, mappingStatus: 'pending', reference: field.reference || null, description: `类型和映射待复核；原文：${field.evidence}` })),
      description: `原文字典候选，未连接企业系统。${table.evidence}` });
  }
  return { status: 'review_required', files: [], objectTypes, relationshipTypes, warnings: ['来源系统、字段类型及映射必须人工核实；没有执行来源验证。'], summary: '从用户材料抽取并逐字段核对原文的候选结构；尚未验证映射。' };
}

export async function discoverNaturalSchema(material) {
  if (getLocalModelRuntime().mode === 'mock' || !/主键|primary.?key|字段|\bfields\b|\bPK\b/i.test(material)) return null;
  const result = await generateModelSummary({
    prompt: `仅抽取材料明确给出的表、字段、主键、外键。不要补充默认 id/status，不确定则不生成。每个 evidence/keyEvidence/referenceEvidence 必须逐字引用材料的一段原文，并包含对应名称。reference 是明确的目标表名；没有外键证据则 null。字段类型、来源系统不猜测。\n材料：${material.slice(-20000)}\n在 answer 字段中返回 JSON 字符串：{"tables":[{"name":"原文表名","label":"中文名","evidence":"含表名的原文","key":"主键字段","keyEvidence":"明确该字段是主键的原文","fields":[{"name":"字段名","evidence":"含字段名的原文","reference":null,"referenceEvidence":null}]}]}`,
    fallback: '', safetyIdentifier: 'semantic-schema-discovery'
  });
  if (!['ark', 'local', 'openai', 'deepseek', 'compatible', 'workbuddy'].includes(result.source)) return { error: '模型未能提取可核对的结构，请重试或上传结构化数据字典。' };
  try {
    const diagnostics = [];
    return validateNaturalSchema(JSON.parse(result.text), material, diagnostics) || { error: `候选结构缺少可核对的原文证据（${diagnostics[0]}），请补充主外键定义或上传结构化字典；未使用默认模板代替。` };
  }
  catch { return { error: '模型未返回有效的结构化字典，未生成默认模板。' }; }
}

import { parse as parseYaml } from 'yaml';
import { detectRequestedSemanticSystems } from './semantic-source-discovery-service.js';
import { objectGranularities } from './ontology-contract-service.js';
import { parseOfficeTableRows } from './office-material-parser.js';

const structuredMimeTypes = new Set(['application/json', 'text/csv', 'application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml']);
const officeMimeTypes = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const discoveryMimeTypes = new Set([...structuredMimeTypes, ...officeMimeTypes]);
const MAX_SCHEMAS = 40;
const MAX_FIELDS = 80;
const clip = (value, length = 240) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
const decode = (attachment) => Buffer.from(String(attachment.dataUrl || '').split(',')[1] || '', 'base64').toString('utf8');
const declaredSystem = (value, fallback) => clip(value || fallback || 'UNASSIGNED', 40).toUpperCase();
const referenceParts = (value) => typeof value === 'object' && value
  ? { reference: value.schema || value.object || value.table, referenceField: value.field || value.column }
  : { reference: String(value || '').split('.')[0] || null, referenceField: String(value || '').split('.')[1] || null };
const objectId = (value) => clip(value, 120).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((item) => `${item[0]?.toUpperCase() || ''}${item.slice(1)}`).join('').replace(/^\d+/, '') || 'DiscoveredObject';
const snake = (value) => clip(value, 120).replace(/([a-z\d])([A-Z])/g, '$1_$2').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').toLowerCase();
const refName = (value) => String(value || '').split('/').at(-1) || '';
const lowerKeys = (value) => Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key.toLowerCase().replace(/[^a-z0-9\p{Script=Han}]/gu, ''), item]));
const firstValue = (row, aliases) => {
  const normalized = lowerKeys(row);
  return aliases.map((key) => normalized[key]).find((value) => value !== undefined && value !== null && String(value).trim() !== '');
};
const truthy = (value) => ['true', '1', 'yes', 'y', '是', '主键', 'pk'].includes(String(value || '').trim().toLowerCase());

const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(field); field = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      if (row.some((item) => item.trim())) rows.push(row);
      row = [];
    } else field += character;
  }
  row.push(field);
  if (row.some((item) => item.trim())) rows.push(row);
  return matrixToRecords(rows);
};

// Shared header/record semantics for CSV files and document-form dictionaries:
// first row is the header, later rows are records, both positionally aligned.
// Sparse columns (cells that were never present in the worksheet) stay aligned
// by index rather than shifting into a neighbouring header.
// 导出给 mock-onboarding-service 复用（文档形态字典走同一套行列还原语义，ADR-029）。
export const matrixToRecords = (rows) => {
  const meaningful = rows.filter((row) => Array.isArray(row) && row.some((item) => String(item ?? '').trim()));
  if (meaningful.length < 2) return [];
  const width = Math.max(...meaningful.map((row) => row.length));
  const headers = Array.from({ length: width }, (_, index) => clip(meaningful[0][index], 100));
  return meaningful.slice(1).map((row) => {
    const values = Array.from({ length: width }, (_, index) => clip(row?.[index], 1000));
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
};

const fieldType = (property = {}) => property.type || (property.$ref ? `ref:${refName(property.$ref)}` : property.items?.$ref ? `array:${refName(property.items.$ref)}` : property.format || 'string');
const primaryKeyFor = (name, schema, fields) => {
  const declared = schema?.['x-primary-key'] || schema?.primaryKey;
  if (Array.isArray(declared)) return clip(declared[0], 120);
  if (declared) return clip(declared, 120);
  const explicit = fields.find((item) => item.primaryKey);
  if (explicit) return explicit.name;
  const candidates = ['id', `${snake(name)}_id`, `${name}Id`.toLowerCase()];
  return fields.find((item) => candidates.includes(item.name.toLowerCase()))?.name || fields.find((item) => /(?:^|_)id$|Id$/.test(item.name))?.name || null;
};

const normalizeField = (field) => ({
  name: clip(field.name, 120),
  type: clip(field.type || 'string', 80),
  required: Boolean(field.required),
  primaryKey: Boolean(field.primaryKey),
  reference: field.reference ? objectId(field.reference) : null,
  referenceField: clip(field.referenceField, 120) || null,
  unit: clip(field.unit, 80) || null,
  enum: Array.isArray(field.enum) ? field.enum.slice(0, 100).map(value => clip(value, 120)) : undefined,
  description: clip(field.description, 300) || null
});

const normalizeSchema = ({ name, label, description, fields, primaryKey, sourceSystem, format, granularity }) => {
  const normalizedFields = fields.map(normalizeField).filter((item) => item.name);
  const id = objectId(name);
  const key = clip(primaryKey, 120) || primaryKeyFor(id, {}, normalizedFields);
  return {
    id,
    label: clip(label || name, 160),
    description: clip(description, 500),
    sourceSystem,
    granularity: granularity || 'unspecified',
    source: `${sourceSystem.toLowerCase()}.${snake(name)}`,
    key: key || null,
    fields: normalizedFields,
    format
  };
};

const schemasFromOpenApi = (document, sourceSystem) => Object.entries(document?.components?.schemas || {}).map(([name, schema]) => {
  const required = new Set(schema.required || []);
  const fields = Object.entries(schema.properties || {}).map(([fieldName, property]) => ({
    name: fieldName,
    type: fieldType(property),
    required: required.has(fieldName),
    primaryKey: property['x-primary-key'] === true,
    ...referenceParts(property['x-foreign-key'] || (property.$ref ? refName(property.$ref) : property.items?.$ref ? refName(property.items.$ref) : null)),
    enum: property.enum,
    unit: property['x-unit'] || property.unit,
    description: property.description
  }));
  return normalizeSchema({ name, label: schema.title || name, description: schema.description, fields, primaryKey: schema['x-primary-key'], sourceSystem: declaredSystem(schema['x-source-system'] || document['x-source-system'], sourceSystem), granularity: schema['x-granularity'], format: 'openapi' });
});

const schemaCollection = (document) => {
  if (Array.isArray(document)) return document;
  for (const key of ['tables', 'entities', 'objects', 'schemas']) if (Array.isArray(document?.[key])) return document[key];
  return [];
};

const schemasFromDictionary = (document, sourceSystem, format) => {
  const collection = schemaCollection(document);
  if (!collection.length) return [];
  const rowStyle = collection.every((item) => firstValue(item, ['field', 'fieldname', 'column', 'columnname', '字段', '字段名']));
  if (rowStyle) {
    const groups = new Map();
    for (const row of collection) {
      const name = clip(firstValue(row, ['table', 'tablename', 'entity', 'object', '对象', '表名']) || 'ImportedObject', 120);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(row);
    }
    return [...groups.entries()].map(([name, rows]) => normalizeSchema({
      name,
      label: firstValue(rows[0], ['tablelabel', 'objectlabel', '对象名称', '表中文名']) || name,
      fields: rows.map((row) => ({
        name: firstValue(row, ['field', 'fieldname', 'column', 'columnname', '字段', '字段名']),
        type: firstValue(row, ['type', 'datatype', '字段类型', '数据类型']) || 'string',
        required: truthy(firstValue(row, ['required', 'notnull', 'mandatory', '必填', '非空'])),
        primaryKey: truthy(firstValue(row, ['primarykey', 'pk', 'isprimarykey', '主键'])),
        ...referenceParts(firstValue(row, ['reference', 'ref', 'foreignkey', 'fk', '关联对象', '外键'])),
        description: firstValue(row, ['description', 'comment', 'label', '说明', '字段说明'])
      })),
      sourceSystem: declaredSystem(firstValue(rows[0], ['system', 'sourcesystem', '来源系统']), sourceSystem),
      granularity: firstValue(rows[0], ['granularity', '粒度']),
      format
    }));
  }
  return collection.map((item, index) => {
    const name = item.name || item.table || item.entity || item.object || `ImportedObject${index + 1}`;
    const rawFields = Array.isArray(item.fields) ? item.fields : Array.isArray(item.columns) ? item.columns : [];
    return normalizeSchema({
      name,
      label: item.label || item.title || name,
      description: item.description,
      fields: rawFields.map((field) => typeof field === 'string' ? { name: field, type: 'string' } : {
        name: field.name || field.field || field.column,
        type: field.type || field.dataType,
        required: field.required || field.notNull,
        primaryKey: field.primaryKey || field.pk,
        ...referenceParts(field.reference || field.ref || field.foreignKey),
        referenceField: field.referenceField || referenceParts(field.reference || field.ref || field.foreignKey).referenceField,
        enum: field.enum,
        unit: field.unit,
        description: field.description || field.comment
      }),
      primaryKey: item.primaryKey || item.key,
      sourceSystem: declaredSystem(item.system || item.sourceSystem || document.system, sourceSystem),
      granularity: item.granularity,
      format
    });
  });
};

const inferCoreObject = (schema) => {
  // An imported business type is its own anchor until a human maps it.
  // Similar names do not establish identity (supplier != person, lot != SKU).
  return schema.id;
};

const relationshipsFor = (schemas) => {
  const ids = new Set(schemas.map((item) => item.id));
  const relations = [];
  const signatures = new Set();
  for (const schema of schemas) {
    for (const field of schema.fields) {
      if (!field.reference || !ids.has(field.reference)) continue;
      const signature = `${schema.id}:${field.name}:${field.reference}`;
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      relations.push({ from: schema.id, predicate: snake(field.name).replace(/_id$/, '') || 'references', to: field.reference, sourceField: field.name, targetField: field.referenceField || schemas.find(item => item.id === field.reference)?.key, label: `${schema.label}关联${field.reference}`, cardinality: field.type.startsWith('array:') ? '1:n' : 'n:1', evidence: `结构化 Schema 引用 ${schema.id}.${field.name} → ${field.reference}` });
    }
  }
  return relations;
};

export function discoverSchemasFromAttachments({ attachments = [], reports = [], input = '', documents = [] }) {
  const eligible = new Set(reports.filter((item) => item.status === 'content_scanned' && item.structuredSchemaCandidate).map((item) => item.attachmentId));
  const files = [];
  const schemas = [];
  const warnings = [];
  for (const attachment of attachments.filter((item) => discoveryMimeTypes.has(item.mimeType) && eligible.has(item.id))) {
    const filenameSystems = detectRequestedSemanticSystems(attachment.name);
    const requested = detectRequestedSemanticSystems(input);
    const sourceSystem = filenameSystems.length === 1 ? filenameSystems[0] : requested.length === 1 ? requested[0] : 'UNASSIGNED';
    try {
      const text = documents.find(item => item.attachmentId === attachment.id)?.text ?? decode(attachment);
      let parsed;
      let format;
      if (attachment.mimeType === 'text/csv') { parsed = parseCsv(text); format = 'csv_dictionary'; }
      else if (attachment.mimeType === 'application/json') { parsed = JSON.parse(text); format = parsed?.openapi ? 'openapi_json' : 'json_dictionary'; }
      else if (officeMimeTypes.has(attachment.mimeType)) {
        // 文档形态字典（阶段 5a-2）：从登记/工作台持久化的提取文本还原行列矩阵，
        // 与 CSV 走同一条确定性候选路径；证据等级与 CSV 同级，仍需 Critic 与人工校对。
        const tables = parseOfficeTableRows(text);
        parsed = tables.flatMap(({ rows }) => matrixToRecords(rows));
        format = attachment.mimeType.includes('spreadsheetml') ? 'xlsx_dictionary' : 'docx_dictionary';
        if (!parsed.length) warnings.push(`${attachment.name}：未在文档中识别到含表头的结构化表格；内容仍作为文本进入上下文，字段级候选需提供带表头的 CSV/XLSX/JSON 字典。`);
      }
      else { parsed = parseYaml(text, { maxAliasCount: 20 }); format = parsed?.openapi ? 'openapi_yaml' : 'yaml_dictionary'; }
      const discovered = parsed?.openapi ? schemasFromOpenApi(parsed, sourceSystem) : schemasFromDictionary(parsed, sourceSystem, format);
      const sampleDocument = Array.isArray(parsed?.records) && parsed.records.every(item => item && typeof item.objectType === 'string' && item.payload);
      if (!discovered.length && !sampleDocument) warnings.push(`${attachment.name}：未发现可识别的 OpenAPI components.schemas 或数据字典对象。`);
      discovered.forEach((schema) => schemas.push(schema));
      files.push({ attachmentId: attachment.id, name: attachment.name, format, sourceSystem, schemaCount: discovered.length });
    } catch (error) {
      warnings.push(`${attachment.name}：结构解析失败（${clip(error.message, 120)}）。`);
    }
  }
  // PDF 文本不参与结构化候选（不保证行列语义），只走自然语言上下文——必须点名披露。
  for (const attachment of attachments) {
    if (attachment.mimeType === 'application/pdf' && reports.some(item => item.attachmentId === attachment.id && item.status === 'content_scanned')) warnings.push(`${attachment.name}：PDF 提取文本未作为结构化字典解析，仅进入自然语言上下文；字段级候选请提供带表头的 CSV/XLSX/JSON 字典。`);
  }
  return finalizeSchemaDiscovery({ files, schemas, warnings });
}

export function finalizeSchemaDiscovery({ files = [], schemas = [], warnings = [] }) {
  warnings = [...warnings];
  const conflicts = [];
  const byId = new Map();
  // A reference without an explicit target column means that target's key.
  schemas = schemas.map(schema => ({ ...schema, fields: schema.fields.map(field => ({ ...field, referenceField: field.referenceField || (field.reference ? schemas.find(item => item.id === field.reference)?.key : null) || null })) }));
  for (const schema of schemas) {
    const previous = byId.get(schema.id);
    if (!previous) { byId.set(schema.id, structuredClone(schema)); continue; }
    const compare = value => JSON.stringify({ key: value.key, sourceSystem: value.sourceSystem, granularity: value.granularity, fields: [...value.fields].sort((a, b) => a.name.localeCompare(b.name)).map(field => ({ name: field.name, type: field.type, required: field.required, reference: field.reference, referenceField: field.referenceField, unit: field.unit, enum: field.enum ? [...field.enum].sort() : null })) });
    if (compare(previous) !== compare(schema)) {
      conflicts.push({ objectId: schema.id, versions: [previous, schema], reason: '来源、粒度、主键或字段契约不一致' });
      warnings.push(`${schema.id}：存在材料版本冲突，必须更正材料或开启明确的新版本，不能按上传顺序覆盖。`);
    }
  }
  const unique = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (unique.length > MAX_SCHEMAS) warnings.push(`对象数量超过 ${MAX_SCHEMAS} 的导入上限，未静默截取；请拆分建模范围。`);
  for (const schema of unique) if (!schema.key) warnings.push(`${schema.id}：未识别主键，进入 Review Queue 后必须补充。`);
  for (const schema of unique) {
    if (schema.fields.length > MAX_FIELDS) warnings.push(`${schema.id}：字段超过 ${MAX_FIELDS} 上限，请拆分范围。`);
    if (!objectGranularities.includes(schema.granularity)) warnings.push(`${schema.id}：未知粒度 ${schema.granularity}。`);
    for (const field of schema.fields) {
      if (!field.reference && /外键|foreign.?key|引用\s+[A-Z]/i.test(field.description || '')) warnings.push(`${schema.id}.${field.name}：描述提及关联但未给出受支持的外键结构，请用 reference 或 x-foreign-key 明确目标。`);
      if (field.reference && !byId.has(field.reference)) warnings.push(`${schema.id}.${field.name}：引用 ${field.reference} 尚未提供，请补充材料。`);
      if (field.referenceField && byId.has(field.reference) && !byId.get(field.reference).fields.some(item => item.name === field.referenceField)) warnings.push(`${schema.id}.${field.name}：目标字段 ${field.referenceField} 不存在。`);
    }
  }
  const objectTypes = unique.map((schema) => ({
    id: schema.id,
    label: schema.label,
    source: schema.source,
    key: schema.key,
    fields: schema.fields.map((field) => field.name),
    classification: '内部受限（待复核）',
    semanticType: schema.id,
    coreObject: inferCoreObject(schema),
    sourceSystems: [schema.sourceSystem],
    granularity: schema.granularity,
    fieldDefinitions: schema.fields.map((field) => ({ ...field, sourceField: field.name, mappingStatus: 'mapped', primaryKey: field.name === schema.key })),
    description: schema.description || `从 ${schema.format} 结构化材料抽取的待审阅对象。`
  }));
  return {
    status: files.length ? (warnings.length ? 'review_required' : 'discovered') : 'not_applicable',
    files,
    schemas: unique,
    conflicts,
    objectTypes,
    relationshipTypes: relationshipsFor(unique),
    warnings,
    summary: files.length ? `已从 ${files.length} 份结构化材料发现 ${unique.length} 个对象和 ${relationshipsFor(unique).length} 条引用关系。` : '未上传可解析的结构化 Schema 材料。'
  };
}

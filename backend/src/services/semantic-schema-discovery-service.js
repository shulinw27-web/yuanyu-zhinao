import { parse as parseYaml } from 'yaml';
import { detectRequestedSemanticSystems } from './semantic-source-discovery-service.js';

const structuredMimeTypes = new Set(['application/json', 'text/csv', 'application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml']);
const MAX_SCHEMAS = 40;
const MAX_FIELDS = 80;
const clip = (value, length = 240) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
const decode = (attachment) => Buffer.from(String(attachment.dataUrl || '').split(',')[1] || '', 'base64').toString('utf8');
const objectId = (value) => clip(value, 120).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((item) => `${item[0]?.toUpperCase() || ''}${item.slice(1)}`).join('').replace(/^\d+/, '') || 'DiscoveredObject';
const snake = (value) => clip(value, 120).replace(/([a-z\d])([A-Z])/g, '$1_$2').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').toLowerCase();
const refName = (value) => String(value || '').split('/').at(-1) || '';
const lowerKeys = (value) => Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), item]));
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
  if (rows.length < 2) return [];
  const headers = rows[0].map((item) => clip(item, 100));
  return rows.slice(1, 2000).map((values) => Object.fromEntries(headers.map((header, index) => [header, clip(values[index], 1000)])));
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
  description: clip(field.description, 300) || null
});

const normalizeSchema = ({ name, label, description, fields, primaryKey, sourceSystem, format }) => {
  const normalizedFields = fields.map(normalizeField).filter((item) => item.name).slice(0, MAX_FIELDS);
  const id = objectId(name);
  const key = clip(primaryKey, 120) || primaryKeyFor(id, {}, normalizedFields);
  return {
    id,
    label: clip(label || name, 160),
    description: clip(description, 500),
    sourceSystem,
    source: `${sourceSystem.toLowerCase()}.${snake(name)}`,
    key: key || null,
    fields: normalizedFields,
    format
  };
};

const schemasFromOpenApi = (document, sourceSystem) => Object.entries(document?.components?.schemas || {}).slice(0, MAX_SCHEMAS).map(([name, schema]) => {
  const required = new Set(schema.required || []);
  const fields = Object.entries(schema.properties || {}).map(([fieldName, property]) => ({
    name: fieldName,
    type: fieldType(property),
    required: required.has(fieldName),
    primaryKey: property['x-primary-key'] === true,
    reference: property.$ref ? refName(property.$ref) : property.items?.$ref ? refName(property.items.$ref) : null,
    description: property.description
  }));
  return normalizeSchema({ name, label: schema.title || name, description: schema.description, fields, primaryKey: schema['x-primary-key'], sourceSystem, format: 'openapi' });
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
    return [...groups.entries()].slice(0, MAX_SCHEMAS).map(([name, rows]) => normalizeSchema({
      name,
      label: firstValue(rows[0], ['tablelabel', 'objectlabel', '对象名称', '表中文名']) || name,
      fields: rows.map((row) => ({
        name: firstValue(row, ['field', 'fieldname', 'column', 'columnname', '字段', '字段名']),
        type: firstValue(row, ['type', 'datatype', '字段类型', '数据类型']) || 'string',
        required: truthy(firstValue(row, ['required', 'notnull', 'mandatory', '必填', '非空'])),
        primaryKey: truthy(firstValue(row, ['primarykey', 'pk', 'isprimarykey', '主键'])),
        reference: firstValue(row, ['reference', 'ref', 'foreignkey', 'fk', '关联对象', '外键']),
        description: firstValue(row, ['description', 'comment', 'label', '说明', '字段说明'])
      })),
      sourceSystem,
      format
    }));
  }
  return collection.slice(0, MAX_SCHEMAS).map((item, index) => {
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
        reference: field.reference || field.ref || field.foreignKey,
        description: field.description || field.comment
      }),
      primaryKey: item.primaryKey || item.key,
      sourceSystem,
      format
    });
  });
};

const inferCoreObject = (schema) => {
  const text = `${schema.id} ${schema.label}`.toLowerCase();
  if (/supplier|person|employee|user|供应商|人员|员工/.test(text)) return 'Person';
  if (/store|shop|门店/.test(text)) return 'Store';
  if (/equipment|machine|设备/.test(text)) return 'Equipment';
  if (/material|inventory|warehouse|receipt|shipment|lot|原料|库存|仓库|入库|出库|批次/.test(text)) return 'RawMaterial';
  return 'Product';
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
      relations.push({ from: schema.id, predicate: snake(field.name).replace(/_id$/, '') || 'references', to: field.reference, label: `${schema.label}关联${field.reference}`, cardinality: field.type.startsWith('array:') ? '1:n' : 'n:1', evidence: '结构化 Schema 引用' });
    }
  }
  return relations;
};

export function discoverSchemasFromAttachments({ attachments = [], reports = [], input = '' }) {
  const eligible = new Set(reports.filter((item) => item.status === 'content_scanned' && item.structuredSchemaCandidate).map((item) => item.attachmentId));
  const files = [];
  const schemas = [];
  const warnings = [];
  for (const attachment of attachments.filter((item) => structuredMimeTypes.has(item.mimeType) && eligible.has(item.id))) {
    const filenameSystems = detectRequestedSemanticSystems(attachment.name);
    const requested = detectRequestedSemanticSystems(input);
    const sourceSystem = filenameSystems[0] || requested[0] || 'UNASSIGNED';
    try {
      const text = decode(attachment);
      let parsed;
      let format;
      if (attachment.mimeType === 'text/csv') { parsed = parseCsv(text); format = 'csv_dictionary'; }
      else if (attachment.mimeType === 'application/json') { parsed = JSON.parse(text); format = parsed?.openapi ? 'openapi_json' : 'json_dictionary'; }
      else { parsed = parseYaml(text, { maxAliasCount: 20 }); format = parsed?.openapi ? 'openapi_yaml' : 'yaml_dictionary'; }
      const discovered = parsed?.openapi ? schemasFromOpenApi(parsed, sourceSystem) : schemasFromDictionary(parsed, sourceSystem, format);
      if (!discovered.length) warnings.push(`${attachment.name}：未发现可识别的 OpenAPI components.schemas 或数据字典对象。`);
      discovered.forEach((schema) => schemas.push(schema));
      files.push({ attachmentId: attachment.id, name: attachment.name, format, sourceSystem, schemaCount: discovered.length });
    } catch (error) {
      warnings.push(`${attachment.name}：结构解析失败（${clip(error.message, 120)}）。`);
    }
  }
  const unique = [...new Map(schemas.slice(0, MAX_SCHEMAS).map((schema) => [schema.id, schema])).values()];
  for (const schema of unique) if (!schema.key) warnings.push(`${schema.id}：未识别主键，进入 Review Queue 后必须补充。`);
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
    fieldDefinitions: schema.fields.map((field) => ({ ...field, sourceField: field.name, mappingStatus: 'mapped', primaryKey: field.name === schema.key })),
    description: schema.description || `从 ${schema.format} 结构化材料抽取的待审阅对象。`
  }));
  return {
    status: files.length ? (warnings.length ? 'review_required' : 'discovered') : 'not_applicable',
    files,
    schemas: unique,
    objectTypes,
    relationshipTypes: relationshipsFor(unique),
    warnings,
    summary: files.length ? `已从 ${files.length} 份结构化材料发现 ${unique.length} 个对象和 ${relationshipsFor(unique).length} 条引用关系。` : '未上传可解析的结构化 Schema 材料。'
  };
}

import { DOMParser } from '@xmldom/xmldom';
import { exportOntologySubset, importOntologySubset } from './ontology-exchange.js';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const BASE = 'urn:yuanyu:ontology:';
const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
const escapeXML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const fieldKeys = ['name', 'type', 'required', 'primaryKey', 'unit', 'enumValues', 'reference', 'referenceField', 'sourceField', 'mappingStatus', 'label', 'description'];
function metadata(draft) {
  return draft.objectTypes.map(item => ({ id: item.id, businessDomain: item.businessDomain || '', sourceSystems: item.sourceSystems || [], source: typeof item.source === 'string' ? item.source : '', classification: item.classification || '', aliases: item.aliases || [], fieldDefinitions: (item.fieldDefinitions || []).map(field => Object.fromEntries(fieldKeys.filter(key => field[key] !== undefined).map(key => [key, field[key]]))) }));
}
function applyMetadata(result, entries, mapping) {
  if (!Array.isArray(entries) || entries.length > 500) throw new Error('对象注解格式无效。');
  const seen = new Set();
  for (const entry of entries) {
    const object = result.objectTypes.find(item => item.id === entry?.id);
    if (!object || seen.has(entry.id) || Object.keys(entry).some(key => !['id', 'businessDomain', 'sourceSystems', 'source', 'classification', 'aliases', 'fieldDefinitions'].includes(key))) throw new Error('对象注解重复或不闭合。');
    seen.add(entry.id);
    if (!Array.isArray(entry.fieldDefinitions) || entry.fieldDefinitions.length > 100 || new Set(entry.fieldDefinitions.map(field => field?.name)).size !== entry.fieldDefinitions.length) throw new Error('字段注解无效。');
    for (const field of entry.fieldDefinitions) {
      if (!field || !object.fields.includes(field.name) || Object.keys(field).some(key => !fieldKeys.includes(key)) || (field.reference && !result.objectTypes.some(item => item.id === field.reference)) || (field.referenceField && !result.objectTypes.find(item => item.id === field.reference)?.fields.includes(field.referenceField))) throw new Error('字段注解或引用不闭合。');
      for (const [key, value] of Object.entries(field)) {
        if (['required', 'primaryKey'].includes(key) ? typeof value !== 'boolean' : key === 'enumValues' ? !Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || item.length > 200) : typeof value !== 'string' || value.length > 2000) throw new Error('字段注解类型或长度无效。');
      }
    }
    for (const key of ['sourceSystems', 'aliases']) if (!Array.isArray(entry[key]) || entry[key].length > 100 || entry[key].some(value => typeof value !== 'string' || value.length > 100)) throw new Error('对象注解类型无效。');
    for (const key of ['source', 'classification']) if (typeof entry[key] !== 'string' || entry[key].length > 2000) throw new Error('对象注解类型无效。');
    object.fieldDefinitions = entry.fieldDefinitions.map(field => mapping ? { ...field } : Object.fromEntries(Object.entries(field).filter(([key]) => !['sourceField', 'mappingStatus'].includes(key))));
    if (entry.businessDomain !== undefined && (typeof entry.businessDomain !== 'string' || entry.businessDomain.length > 48 || /[\u0000-\u001f\u007f]/.test(entry.businessDomain))) throw new Error('业务域注解无效。');
    object.businessDomain = entry.businessDomain || '';
    object.aliases = entry.aliases; object.classification = entry.classification;
    if (mapping) { object.sourceSystems = entry.sourceSystems; object.source = entry.source; }
  }
  return result;
}
export function exportOntologyProfile(draft, profile = 'neutral-jsonld') {
  const subset = exportOntologySubset(draft);
  const entries = metadata(draft);
  const losses = ['不导出凭据、授权、业务实例、读取执行计划或资料引用；导入仅生成待审核候选。', '支持类型、主键、单位、枚举和字段引用注解，不执行 OWL 推理或主数据映射。'];
  if (profile === 'platform-package') return { profile, extension: 'json', text: JSON.stringify({ schemaVersion: 'yuanyu.ontology.package.v1', structure: subset.document, metadata: entries }, null, 2), losses: [...losses, '仅保留声明性系统/字段映射；关系键转换、时态规则和治理契约仍需另行核对。'] };
  const clean = entries.map(entry => ({ ...entry, sourceSystems: [], source: '', fieldDefinitions: entry.fieldDefinitions.map(field => Object.fromEntries(Object.entries(field).filter(([key]) => !['sourceField', 'mappingStatus'].includes(key)))) }));
  if (profile === 'neutral-jsonld') return { profile, extension: 'jsonld', text: JSON.stringify({ ...subset.document, 'yuanyu:metadata': clean }, null, 2), losses: [...losses, '中立交换不携带系统映射；外部工具可能忽略元域注解。'] };
  if (profile !== 'playground-rdfxml') throw new Error('不支持的交换配置。');
  const classes = draft.objectTypes.map(item => `<owl:Class rdf:about="${BASE}${item.id}"><rdfs:label>${escapeXML(item.label || item.id)}</rdfs:label><rdfs:comment>${escapeXML(item.description)}</rdfs:comment><yuanyu:key>${escapeXML(item.key)}</yuanyu:key><yuanyu:fields>${escapeXML(JSON.stringify(item.fields))}</yuanyu:fields><yuanyu:metadata>${escapeXML(JSON.stringify(clean.find(entry => entry.id === item.id)))}</yuanyu:metadata></owl:Class>`);
  const relations = draft.relationshipTypes.map((item, index) => `<owl:ObjectProperty rdf:about="${BASE}relation_${index}"><rdfs:domain rdf:resource="${BASE}${item.from}"/><rdfs:range rdf:resource="${BASE}${item.to}"/><rdfs:label>${escapeXML(item.label || item.predicate)}</rdfs:label><yuanyu:predicate>${escapeXML(item.predicate)}</yuanyu:predicate><yuanyu:cardinality>${escapeXML(item.cardinality)}</yuanyu:cardinality></owl:ObjectProperty>`);
  return { profile, extension: 'rdf', text: `<?xml version="1.0" encoding="UTF-8"?><rdf:RDF xmlns:rdf="${RDF}" xmlns:rdfs="${RDFS}" xmlns:owl="${OWL}" xmlns:yuanyu="${BASE}">${classes.join('')}${relations.join('')}</rdf:RDF>`, losses: [...losses, 'RDF/XML 使用标准类/关系及元域注解；Playground 特有编辑注解需人工转换，不保证任意工具无损导入。'] };
}
function readXML(text) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new Error('禁止 DTD 和实体声明，不加载外部资源。');
  const doc = new DOMParser({ onError: (level, message) => { throw new Error(`XML ${level}: ${message}`); } }).parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (root.namespaceURI !== RDF || root.localName !== 'RDF' || doc.getElementsByTagName('*').length > 5000) throw new Error('不支持的 RDF/XML 根或节点过多。');
  const elements = Array.from(root.childNodes).filter(node => node.nodeType === 1);
  if (elements.length > 1000) throw new Error('RDF/XML 节点超过限制。');
  const value = (node, ns, name) => { const matches = Array.from(node.childNodes).filter(child => child.nodeType === 1 && child.namespaceURI === ns && child.localName === name); if (matches.length > 1) throw new Error('重复注解。'); return matches[0]; };
  const textValue = (node, ns, name) => value(node, ns, name)?.textContent || '';
  const classes = elements.filter(node => node.namespaceURI === OWL && node.localName === 'Class');
  const identities = new Map(); const used = new Set();
  for (const node of classes) {
    const iri = node.getAttributeNS(RDF, 'about'); const id = iri.startsWith(BASE) ? decodeURIComponent(iri.slice(BASE.length)) : iri.split('#').at(-1);
    if (!identifier(id) || identities.has(iri) || used.has(id)) throw new Error('类标识缺失、重复或同名 IRI 冲突。'); identities.set(iri, id); used.add(id);
  }
  const graph = []; const entries = []; const losses = [];
  for (const node of classes) {
    const id = identities.get(node.getAttributeNS(RDF, 'about'));
    const rawFields = textValue(node, BASE, 'fields');
    let fields = rawFields ? JSON.parse(rawFields) : [];
    const declared = elements.filter(property => property.namespaceURI === OWL && property.localName === 'DatatypeProperty' && value(property, RDFS, 'domain')?.getAttributeNS(RDF, 'resource') === node.getAttributeNS(RDF, 'about'));
    if (!fields.length) fields = declared.map(property => property.getAttributeNS(RDF, 'about').split(/[#:/]/).at(-1));
    const key = textValue(node, BASE, 'key') || (fields.includes('id') ? 'id' : '');
    if (!fields.length || !key) throw new Error('类缺少字段/主键注解，请先补充而非猜测主键。');
    graph.push({ '@id': `${BASE}${id}`, '@type': 'owl:Class', 'rdfs:label': textValue(node, RDFS, 'label') || id, 'rdfs:comment': textValue(node, RDFS, 'comment'), 'yuanyu:key': key, 'yuanyu:fields': fields });
    const rawMetadata = textValue(node, BASE, 'metadata');
    if (rawMetadata) entries.push(JSON.parse(rawMetadata));
  }
  for (const node of elements) {
    if (node.namespaceURI === OWL && node.localName === 'ObjectProperty') {
      const from = identities.get(value(node, RDFS, 'domain')?.getAttributeNS(RDF, 'resource')); const to = identities.get(value(node, RDFS, 'range')?.getAttributeNS(RDF, 'resource'));
      const predicate = textValue(node, BASE, 'predicate') || node.getAttributeNS(RDF, 'about').split(/[#:/]/).at(-1);
      graph.push({ '@id': `${BASE}relation_${graph.length}`, '@type': 'owl:ObjectProperty', 'rdfs:domain': { '@id': `${BASE}${from}` }, 'rdfs:range': { '@id': `${BASE}${to}` }, 'rdfs:label': textValue(node, RDFS, 'label') || predicate, 'yuanyu:predicate': predicate, 'yuanyu:cardinality': textValue(node, BASE, 'cardinality') });
    } else if (!(node.namespaceURI === OWL && ['Class', 'DatatypeProperty'].includes(node.localName))) losses.push(`未支持的 RDF 节点：${node.nodeName}`);
    for (const child of Array.from(node.childNodes).filter(child => child.nodeType === 1)) if (![RDFS, BASE].includes(child.namespaceURI) || !['label', 'comment', 'domain', 'range', 'key', 'fields', 'metadata', 'predicate', 'cardinality'].includes(child.localName)) losses.push(`未支持注解：${child.nodeName}`);
  }
  const context = exportOntologySubset({ objectTypes: [], relationshipTypes: [] }).document['@context'];
  const result = applyMetadata(importOntologySubset(JSON.stringify({ '@context': context, '@graph': graph })), entries, false);
  return { ...result, profile: 'playground-rdfxml', losses: [...result.losses, ...new Set(losses), 'RDF/XML 的外部 IRI 仅转换为本地候选编码，不表示同名实体等价；未支持注解均不执行。'] };
}
export function importOntologyProfile(text) {
  if (typeof text !== 'string' || text.length > 240000) throw new Error('文件超过 240KB 或格式无效。');
  if (text.trimStart().startsWith('<')) return readXML(text);
  const doc = JSON.parse(text);
  if (doc['yuanyu:metadata']) {
    const { 'yuanyu:metadata': entries, ...structure } = doc;
    const result = applyMetadata(importOntologySubset(JSON.stringify(structure)), entries, false);
    return { ...result, profile: 'neutral-jsonld', losses: ['保留类型、字段、主键、单位、枚举和引用注解；不包含系统映射、授权或执行能力。', '关系键转换、治理契约和时态规则仍须人工补齐。'] };
  }
  if (doc.schemaVersion) {
    if (!['yuanyu.ontology.package.v1', 'yuanyu.ontology.neutral.v1'].includes(doc.schemaVersion) || Object.keys(doc).some(key => !['schemaVersion', 'structure', 'metadata'].includes(key))) throw new Error('不支持的模型包格式。');
    const mapping = doc.schemaVersion === 'yuanyu.ontology.package.v1';
    const result = applyMetadata(importOntologySubset(JSON.stringify(doc.structure)), doc.metadata, mapping);
    return { ...result, profile: mapping ? 'platform-package' : 'neutral-jsonld', losses: ['保留类型、字段、主键、单位、枚举和引用注解；不包含授权或执行能力。', ...(mapping ? ['系统和字段映射仅为声明，须核验真实连接。'] : ['中立交换不包含系统映射。']), '关系键转换、治理契约和时态规则不在交换子集内，仍须人工补齐。'] };
  }
  return { ...importOntologySubset(JSON.stringify(doc.document || doc)), profile: 'legacy-jsonld' };
}

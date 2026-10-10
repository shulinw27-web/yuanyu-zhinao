import { Parser } from 'n3';
import { exportOntologySubset } from './ontology-exchange.js';
const BASE = 'urn:yuanyu:ontology:';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const identifier = value => /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value);
const literal = value => JSON.stringify(String(value ?? ''));

export function exportOntologyTurtle(draft, metadata) {
  const subset = exportOntologySubset(draft).document;
  const lines = [`@prefix rdf: <${RDF}> .`, `@prefix rdfs: <${RDFS}> .`, `@prefix owl: <${OWL}> .`, `@prefix yuanyu: <${BASE}> .`];
  for (const node of subset['@graph']) {
    lines.push(`<${node['@id']}> a ${node['@type']}`);
    for (const [key, value] of Object.entries(node).filter(([key]) => !['@id', '@type'].includes(key))) {
      lines.push(`  ; ${key} ${value?.['@id'] ? `<${value['@id']}>` : literal(Array.isArray(value) ? JSON.stringify(value) : value)}`);
    }
    const entry = metadata.find(item => `${BASE}${item.id}` === node['@id']);
    if (entry) lines.push(`  ; yuanyu:metadata ${literal(JSON.stringify(entry))}`);
    lines.push('  .');
  }
  return lines.join('\n');
}

// Syntax parsing never dereferences an IRI. Conversion is deliberately a whitelist.
export function parseOntologyTurtle(text) {
  if (typeof text !== 'string' || text.length > 240000) throw new Error('文件超过240KB或格式无效。');
  const quads = new Parser({ format: 'text/turtle' }).parse(text);
  if (quads.length > 12000) throw new Error('Turtle三元组超过12000条预算。');
  const subjects = new Map(); const losses = new Set();
  for (const quad of quads) {
    if (quad.graph.termType !== 'DefaultGraph' || quad.subject.termType !== 'NamedNode' || !['NamedNode', 'Literal'].includes(quad.object.termType)) throw new Error('仅支持命名类和关系，不支持空白节点、集合、命名图或OWL限制。');
    if (!subjects.has(quad.subject.value)) subjects.set(quad.subject.value, new Map());
    const properties = subjects.get(quad.subject.value);
    if (properties.has(quad.predicate.value)) throw new Error('同一节点属性重复，请明确唯一值。');
    properties.set(quad.predicate.value, quad.object);
    if (quad.object.language) losses.add('语言标签转换为普通文本，不保留多语言版本。');
  }
  if (subjects.size > 1000) throw new Error('Turtle节点超过1000条预算。');
  const scalar = (properties, name, required = false) => {
    const term = properties.get(name);
    if (!term) { if (required) throw new Error('类缺少字段或主键注解，不猜测主键。'); return ''; }
    if (term.termType !== 'Literal' || term.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string' && !term.language) throw new Error('文本注解必须是字符串字面量。');
    return term.value;
  };
  const types = new Map(); const ids = new Set();
  for (const [iri, properties] of subjects) {
    const type = properties.get(`${RDF}type`);
    if (type?.termType !== 'NamedNode') throw new Error('节点必须声明唯一命名类型。');
    if (type.value === `${OWL}Class`) {
      const id = iri.startsWith(BASE) ? decodeURIComponent(iri.slice(BASE.length)) : iri.split(/[#/]/u).at(-1);
      if (!identifier(id) || ids.has(id)) throw new Error('类标识无效或外部IRI转换后同名冲突。');
      ids.add(id); types.set(iri, id);
    } else if (type.value !== `${OWL}ObjectProperty`) losses.add(`未支持节点类型：${type.value.slice(0, 100)}`);
  }
  const graph = []; const metadata = [];
  for (const [iri, properties] of subjects) {
    const type = properties.get(`${RDF}type`).value;
    let allowed = [];
    if (type === `${OWL}Class`) {
      const fields = JSON.parse(scalar(properties, `${BASE}fields`, true));
      graph.push({ '@id': `${BASE}${types.get(iri)}`, '@type': 'owl:Class', 'rdfs:label': scalar(properties, `${RDFS}label`) || types.get(iri), 'rdfs:comment': scalar(properties, `${RDFS}comment`), 'yuanyu:key': scalar(properties, `${BASE}key`, true), 'yuanyu:fields': fields });
      const entry = scalar(properties, `${BASE}metadata`);
      if (entry) { const parsed = JSON.parse(entry); if (parsed?.id !== types.get(iri)) throw new Error('对象注解与类标识不一致。'); metadata.push(parsed); }
      allowed = [`${RDFS}label`, `${RDFS}comment`, `${BASE}key`, `${BASE}fields`, `${BASE}metadata`];
    } else if (type === `${OWL}ObjectProperty`) {
      const from = properties.get(`${RDFS}domain`); const to = properties.get(`${RDFS}range`);
      if (from?.termType !== 'NamedNode' || to?.termType !== 'NamedNode' || !types.has(from.value) || !types.has(to.value)) throw new Error('关系引用不闭合。');
      const predicate = scalar(properties, `${BASE}predicate`) || iri.split(/[#/:]/u).at(-1);
      graph.push({ '@id': `${BASE}relationship/${graph.length}`, '@type': 'owl:ObjectProperty', 'rdfs:domain': { '@id': `${BASE}${types.get(from.value)}` }, 'rdfs:range': { '@id': `${BASE}${types.get(to.value)}` }, 'rdfs:label': scalar(properties, `${RDFS}label`) || predicate, 'yuanyu:predicate': predicate, 'yuanyu:cardinality': scalar(properties, `${BASE}cardinality`) });
      allowed = [`${RDFS}domain`, `${RDFS}range`, `${RDFS}label`, `${BASE}predicate`, `${BASE}cardinality`];
    }
    for (const key of properties.keys()) if (key !== `${RDF}type` && !allowed.includes(key)) losses.add(`未支持注解：${key.slice(0, 100)}`);
  }
  return { document: { '@context': exportOntologySubset({ objectTypes: [], relationshipTypes: [] }).document['@context'], '@graph': graph }, metadata, losses: [...losses, 'IRI只用于本地标识转换，不访问网络；不执行OWL推理，不声明实体等价。'] };
}

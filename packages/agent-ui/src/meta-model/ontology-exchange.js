// Deliberately bounded RDF JSON-LD / OWL subset; no remote context resolution.
const BASE = 'urn:yuanyu:ontology:';
const context = { owl: 'http://www.w3.org/2002/07/owl#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#', xsd: 'http://www.w3.org/2001/XMLSchema#', yuanyu: BASE };
const iri = id => `${BASE}${encodeURIComponent(id)}`;
const ref = id => ({ '@id': iri(id) });
const idFrom = value => {
  if (typeof value !== 'string' || !value.startsWith(BASE)) throw new Error('只支持本地 urn:yuanyu:ontology: 标识；不访问外部地址。');
  const id = decodeURIComponent(value.slice(BASE.length));
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(id)) throw new Error('对象编码不符合平台约束。');
  return id;
};
export function exportOntologySubset(draft) {
  const graph = draft.objectTypes.map(item => ({ '@id': iri(item.id), '@type': 'owl:Class', 'rdfs:label': item.label || item.id,
    'rdfs:comment': item.description || '', 'yuanyu:key': item.key, 'yuanyu:fields': item.fields || [] }));
  graph.push(...draft.relationshipTypes.map((item, index) => ({ '@id': `${BASE}relation_${index}`, '@type': 'owl:ObjectProperty', 'rdfs:domain': ref(item.from), 'rdfs:range': ref(item.to), 'rdfs:label': item.label || item.predicate, 'yuanyu:predicate': item.predicate, 'yuanyu:cardinality': item.cardinality || '' })));
  return { document: { '@context': context, '@graph': graph }, losses: ['不导出系统映射、企业授权、读取方案、业务实例、时态规则及资料引用。', '基数作为元域注解保留，不声明实现 OWL 限制或推理。'] };
}
export function importOntologySubset(text) {
  if (typeof text !== 'string' || text.length > 240000) throw new Error('文件超过 240KB 或格式无效。');
  let doc; try { doc = JSON.parse(text); } catch { throw new Error('当前只支持 RDF JSON-LD 子集；不支持 Turtle、RDF/XML 或任意 OWL 文本。'); }
  if (!doc || !doc['@context'] || Object.keys(doc['@context']).length !== Object.keys(context).length || Object.entries(context).some(([key, value]) => doc['@context'][key] !== value) || !Array.isArray(doc['@graph']) || doc['@graph'].length > 1000) throw new Error('上下文或图格式不受支持；不会加载远程上下文。');
  const objects = []; const relationships = []; const losses = Object.keys(doc).filter(key => !['@context', '@graph'].includes(key)).map(key => `未支持顶层属性：${key.slice(0, 100)}`);
  for (const item of doc['@graph']) {
    if (!item || typeof item !== 'object') throw new Error('节点格式无效。');
    const allowed = item['@type'] === 'owl:Class' ? ['@id', '@type', 'rdfs:label', 'rdfs:comment', 'yuanyu:key', 'yuanyu:fields'] : ['@id', '@type', 'rdfs:domain', 'rdfs:range', 'rdfs:label', 'yuanyu:predicate', 'yuanyu:cardinality'];
    for (const key of Object.keys(item).filter(key => !allowed.includes(key))) losses.push(`未支持属性：${key}`);
    if (item['@type'] === 'owl:Class') {
      const id = idFrom(item['@id']); const fields = item['yuanyu:fields'];
      if (!Array.isArray(fields) || !fields.length || fields.length > 100 || fields.some(field => typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field)) || !fields.includes(item['yuanyu:key'])) throw new Error('字段与主键格式无效。');
      objects.push({ id, label: String(item['rdfs:label'] || id).slice(0, 100), description: String(item['rdfs:comment'] || '').slice(0, 2000), key: item['yuanyu:key'], fields, sourceSystems: [] });
    } else if (item['@type'] === 'owl:ObjectProperty') {
      const predicate = item['yuanyu:predicate'];
      if (typeof predicate !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(predicate)) throw new Error('关系谓词无效。');
      relationships.push({ from: idFrom(item['rdfs:domain']?.['@id']), to: idFrom(item['rdfs:range']?.['@id']), predicate, label: String(item['rdfs:label'] || predicate).slice(0, 100), cardinality: String(item['yuanyu:cardinality'] || '').slice(0, 30) });
    } else losses.push(`未支持节点类型：${String(item['@type']).slice(0, 100)}`);
  }
  const ids = new Set(objects.map(item => item.id));
  if (!objects.length || ids.size !== objects.length || relationships.some(item => !ids.has(item.from) || !ids.has(item.to))) throw new Error('存在重复对象或关系引用不闭合。');
  const signatures = relationships.map(item => JSON.stringify([item.from, item.predicate, item.to]));
  if (new Set(signatures).size !== signatures.length) throw new Error('存在重复关系。');
  return { objectTypes: objects, relationshipTypes: relationships, losses: [...new Set(losses), '导入只是候选预览；来源、字段类型、权限和治理规则须在 Agent 任务中补齐并核对。'] };
}

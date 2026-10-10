import { performance } from 'node:perf_hooks';
import { buildOntologyGraph, filterOntologyGraph, findOntologyPath } from '../packages/agent-ui/src/meta-model/ontology-graph.js';
const results = [];
for (const count of [100, 500, 5000, 20000]) {
  const objects = Array.from({ length: count }, (_, index) => ({ id: `Object_${index}`, label: `合成对象${index}`, sourceSystems: ['MOCK'], fields: ['id'], key: 'id' }));
  const relationships = objects.map((_, index) => ({ from: `Object_${index}`, to: `Object_${(index + 1) % count}`, predicate: 'next' }));
  const before = performance.now(); const graph = buildOntologyGraph(objects, relationships); const built = performance.now();
  const selected = filterOntologyGraph(graph, { focus: 'Object_0' }); const filtered = performance.now();
  const path = findOntologyPath(graph, 'Object_0', `Object_${count - 1}`); const done = performance.now();
  if (path?.nodes.length !== count || path.edges.length !== count - 1 || selected.nodes.length !== 3) throw new Error('GRAPH_BENCHMARK_RESULT_INVALID');
  results.push({ nodes: count, edges: count, buildMs: +(built - before).toFixed(3), neighborhoodMs: +(filtered - built).toFixed(3), pathMs: +(done - filtered).toFixed(3), pathNodes: path.nodes.length });
}
console.log(JSON.stringify({ status: 'passed', synthetic: true, results, boundary: 'Pure data helpers only. Does not render large SVGs, expand backend model limits, measure browser frame rates or prove production SLA.' }, null, 2));

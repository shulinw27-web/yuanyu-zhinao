import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOntologyGraph, filterOntologyGraph, findOntologyPath, validateOntologyLayout, buildOntologyEdgeGeometry, summarizeOntologySources } from '../src/meta-model/ontology-graph.js';
const objects = [{ id: 'supplier', label: '供应商', sourceSystems: ['ERP'] }, { id: 'material', label: '原料批次', sourceSystems: ['ERP', 'WMS'] }, { id: 'batch', label: '生产批次', sourceSystems: ['MES'] }];
const relations = [{ from: 'supplier', to: 'material', predicate: 'provides' }, { from: 'material', to: 'batch', predicate: 'usedIn' }, { from: 'batch', to: 'supplier', predicate: 'reportsTo' }, { from: 'missing', to: 'batch', predicate: 'dangling' }];

test('large cyclic paths scan each edge once and reconstruct only the selected path', () => {
  const count = 5000; let fromReads = 0;
  const nodes = Array.from({ length: count }, (_, index) => ({ id: `n${index}` }));
  const edges = nodes.map((_, index) => ({ id: `e${index}`, get from() { fromReads++; return `n${index}`; }, to: `n${(index + 1) % count}` }));
  const result = findOntologyPath({ nodes, edges }, 'n0', `n${count - 1}`);
  assert.equal(result.nodes.length, count); assert.equal(result.edges.length, count - 1);
  assert.equal(result.nodes[0], 'n0'); assert.equal(result.edges.at(-1), `e${count - 2}`);
  assert.ok(fromReads <= count * 4, `edge reads ${fromReads}`);
  assert.deepEqual(findOntologyPath({ nodes, edges }, 'n0', 'n0'), { nodes: ['n0'], edges: [] });
});

test('source partitions count each node once and retain direction and removed relations separately', () => {
  const graph = buildOntologyGraph([...objects, { id: 'other', sourceSystems: ['WMS', 'ERP', 'ERP'] }, { id: 'unknown' }], [...relations, { from: 'material', to: 'supplier', predicate: 'reverse' }, { from: 'material', to: 'other', predicate: 'internal' }], { relationshipChanges: [{ from: 'supplier', to: 'material', predicate: 'old', change: 'removed' }] });
  const before = JSON.stringify(graph); const summary = summarizeOntologySources(graph);
  assert.equal(summary.groups.length, 4);
  assert.equal(summary.groups.reduce((sum, group) => sum + group.nodeIds.length, 0), 5);
  const multi = summary.groups.find(group => group.label === 'ERP / WMS');
  assert.deepEqual(multi.nodeIds, ['material', 'other']); assert.equal(multi.internalCurrent, 1);
  assert.equal(summary.crossings.length, 5); assert.equal(summary.crossings.filter(item => item.removed).length, 1);
  assert.equal(summary.crossings.reduce((sum, item) => sum + item.edgeIds.length, 0), 5);
  assert.equal(JSON.stringify(graph), before); assert.deepEqual(summarizeOntologySources(graph), summary);
});

test('source summary only sees the supplied filtered graph, never hidden endpoints', () => {
  const graph = filterOntologyGraph(buildOntologyGraph(objects, relations), { system: 'ERP' });
  const summary = summarizeOntologySources(graph);
  assert.equal(summary.groups.length, 2); assert.equal(summary.crossings.length, 1);
  assert.ok(summary.groups.every(group => !group.nodeIds.includes('batch')));
});

test('business domains are explicit, preserve cross-domain direction and never infer from source systems', () => {
  const graph = buildOntologyGraph(objects.map((object, index) => ({ ...object, businessDomain: index < 2 ? '采购' : '' })), relations);
  const summary = summarizeOntologySources(graph, 'domain');
  assert.deepEqual(summary.groups.map(group => [group.label, group.nodeIds.length]), [['采购', 2], ['未归类', 1]]);
  assert.equal(summary.groups[0].internalCurrent, 1); assert.equal(summary.crossings.length, 2);
  assert.deepEqual(filterOntologyGraph(graph, { domain: '未归类' }).nodes.map(node => node.id), ['batch']);
});

test('blocked curves detour around every object or explicitly report an unresolved route', () => {
  const nodes = [{ id: 'a', x: 140, y: 140 }, { id: 'b', x: 700, y: 140 }, { id: 'obstacle', x: 420, y: 130 }];
  const edges = [0, 1, 2].map(index => ({ id: String(index), from: 'a', to: 'b', label: '关联', cardinality: '1:n' }));
  const geometry = buildOntologyEdgeGeometry(nodes, edges);
  assert.equal(new Set([...geometry.values()].map(item => item.path)).size, 3);
  for (const item of geometry.values()) {
    assert.equal(item.routing, 'detoured');
    const points = [...item.path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(match => ({ x: +match[1], y: +match[2] }));
    for (let i = 1; i < points.length; i++) for (const node of nodes) {
      const p = points[i - 1]; const q = points[i];
      assert.ok(!(p.x === q.x ? p.x > node.x - 95 && p.x < node.x + 95 && Math.max(p.y, q.y) > node.y - 38 && Math.min(p.y, q.y) < node.y + 38 : p.y > node.y - 38 && p.y < node.y + 38 && Math.max(p.x, q.x) > node.x - 95 && Math.min(p.x, q.x) < node.x + 95));
    }
  }
  const blocked = buildOntologyEdgeGeometry([...nodes, { id: 'overlap', x: 140, y: 140 }], edges);
  assert.equal(blocked.size, 3); assert.ok([...blocked.values()].every(item => item.routing === 'unresolved'));
});

test('geometry separates parallel, reverse and self edges without altering model structure', () => {
  const nodes = [{ id: 'a', x: 140, y: 95 }, { id: 'b', x: 440, y: 95 }];
  const edges = [['a', 'b'], ['a', 'b'], ['b', 'a'], ['a', 'a'], ['a', 'a']].map(([from, to], i) => ({ id: String(i), from, to, label: '关联', cardinality: '1:N' }));
  const snapshot = JSON.stringify({ nodes, edges });
  const geometry = buildOntologyEdgeGeometry(nodes, edges);
  assert.equal(geometry.size, 5);
  assert.equal(new Set([...geometry.values()].map(item => item.path)).size, 5);
  assert.ok(geometry.get('4').minY < geometry.get('3').minY);
  assert.deepEqual(buildOntologyEdgeGeometry(nodes, edges), geometry);
  assert.equal(JSON.stringify({ nodes, edges }), snapshot);
});

test('dense graph labels never overlap nodes or each other; hidden labels do not remove edges', () => {
  const nodes = [{ id: 'a', x: 140, y: 95 }, { id: 'b', x: 440, y: 95 }, { id: 'c', x: 290, y: 95 }];
  const edges = Array.from({ length: 30 }, (_, i) => ({ id: String(i), from: 'a', to: 'b', label: '原料分配生产批次与库存检查', cardinality: '1:N' }));
  const geometry = buildOntologyEdgeGeometry(nodes, edges);
  const labels = [...geometry.values()].map(item => item.label).filter(Boolean);
  const overlaps = (a, b) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 + 8 && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + 6;
  for (let i = 0; i < labels.length; i++) {
    assert.ok(!nodes.some(node => overlaps(labels[i], { ...node, width: 190, height: 76 })));
    assert.ok(!labels.slice(i + 1).some(label => overlaps(labels[i], label)));
  }
  assert.equal(geometry.size, edges.length);
  assert.ok(labels.length < edges.length);
  assert.equal(buildOntologyEdgeGeometry(nodes, [{ id: 'bad', from: 'missing', to: 'a' }]).size, 0);
});
test('adapter rejects dangling edges and retains removed definitions as explicit ghosts', () => {
  const graph = buildOntologyGraph(objects.slice(0, 2), relations, { objectChanges: [{ id: 'batch', label: '生产批次', change: 'removed' }], relationshipChanges: [{ from: 'material', to: 'batch', predicate: 'usedIn', change: 'removed' }] });
  assert.equal(graph.nodes.length, 3); assert.equal(graph.edges.length, 3);
  assert.equal(graph.nodes.at(-1).change, 'removed');
  assert.equal(findOntologyPath(graph, 'material', 'batch'), null);
  assert.equal(findOntologyPath(graph, 'batch', 'supplier'), null);
});
test('source, search and neighbor filters remove excluded endpoints and paths', () => {
  const graph = buildOntologyGraph(objects, relations);
  const filtered = filterOntologyGraph(graph, { system: 'ERP' });
  assert.equal(filtered.nodes.length, 2); assert.equal(filtered.edges.length, 1);
  assert.equal(findOntologyPath(filtered, 'supplier', 'batch'), null);
  assert.deepEqual(filterOntologyGraph(graph, { query: '没有此对象' }).nodes, []);
  assert.equal(filterOntologyGraph(graph, { query: '原料' }).nodes[0].id, 'material');
});
test('directed shortest path terminates on cycles and reports model identifiers exactly', () => {
  const graph = buildOntologyGraph(objects, relations);
  assert.deepEqual(findOntologyPath(graph, 'supplier', 'batch').nodes, ['supplier', 'material', 'batch']);
  assert.deepEqual(findOntologyPath(graph, 'batch', 'material').nodes, ['batch', 'supplier', 'material']);
  assert.equal(findOntologyPath(graph, 'unknown', 'batch'), null);
});
test('view preferences are separate from model semantics and never accept foreign nodes, stale models or nonfinite transforms', () => {
  const view = { fingerprint: 'fp', scale: 1, offset: { x: 0, y: 0 }, positions: { supplier: { x: 200, y: 100 }, foreign: { x: 0, y: 0 } } };
  assert.deepEqual(Object.keys(validateOntologyLayout(view, ['supplier'], 'fp').positions), ['supplier']);
  assert.equal(validateOntologyLayout(view, ['supplier'], 'stale'), null);
  assert.equal(validateOntologyLayout({ ...view, scale: Infinity }, ['supplier'], 'fp'), null);
});

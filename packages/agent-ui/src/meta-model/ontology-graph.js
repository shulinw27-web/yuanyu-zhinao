// Display adapter: model definitions remain owned by the existing governance API.
export function buildOntologyGraph(objects = [], relationships = [], diff = {}) {
  const changes = new Map((diff.objectChanges || []).map(item => [item.id, item.change]));
  const nodes = objects.filter(item => item && typeof item.id === 'string').map(item => ({
    id: item.id, label: item.label || item.name || item.id,
    description: item.description || '', businessDomain: item.businessDomain || '', sourceSystems: [...(item.sourceSystems || [])],
    fields: item.fields || [], key: item.key || '', change: changes.get(item.id) || 'unchanged'
  }));
  const ids = new Set(nodes.map(item => item.id));
  for (const item of diff.objectChanges || []) {
    if (item.change === 'removed' && !ids.has(item.id)) {
      nodes.push({ id: item.id, label: item.label || item.id, description: '本轮提案将移除此对象。', sourceSystems: [], fields: [], key: '', change: 'removed' });
      ids.add(item.id);
    }
  }
  const signature = item => JSON.stringify([item.from, item.predicate, item.to]);
  const edgeChanges = new Map((diff.relationshipChanges || []).map(item => [signature(item), item.change]));
  const edgeDetails = new Map((diff.relationshipChanges || []).map(item => [signature(item), { before: item.before, after: item.after }]));
  const seen = new Set();
  const edges = [];
  for (const item of [...relationships, ...(diff.relationshipChanges || []).filter(item => item.change === 'removed')]) {
    const id = signature(item);
    if (seen.has(id) || !ids.has(item.from) || !ids.has(item.to)) continue;
    seen.add(id);
    edges.push({ id, from: item.from, to: item.to, predicate: item.predicate,
      label: item.label || item.predicate || '关系', cardinality: item.cardinality || '待核对',
      evidence: typeof item.evidence === 'string' ? item.evidence : '',
      change: edgeChanges.get(id) || 'unchanged', ...edgeDetails.get(id) });
  }
  return { nodes, edges };
}

export function filterOntologyGraph(graph, { query = '', system = '', focus = '', domain = '' } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  const neighbors = new Set([focus]);
  if (focus) for (const edge of graph.edges) {
    if (edge.from === focus) neighbors.add(edge.to);
    if (edge.to === focus) neighbors.add(edge.from);
  }
  const nodes = graph.nodes.filter(node => (!needle || [node.id, node.label, node.description, ...node.sourceSystems].join(' ').toLocaleLowerCase().includes(needle))
    && (!system || node.sourceSystems.includes(system)) && (!domain || (node.businessDomain || '未归类') === domain) && (!focus || neighbors.has(node.id)));
  const ids = new Set(nodes.map(node => node.id));
  return { nodes, edges: graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)) };
}

// Paths follow relation direction; this describes model connectivity, not causal proof.
export function findOntologyPath(graph, from, to) {
  const activeIds = new Set(graph.nodes.filter(item => item.change !== 'removed').map(item => item.id));
  if (!activeIds.has(from) || !activeIds.has(to)) return null;
  const queue = [{ node: from, nodes: [from], edges: [] }];
  const visited = new Set([from]);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (current.node === to) return { nodes: current.nodes, edges: current.edges };
    for (const edge of graph.edges.filter(item => item.from === current.node && item.change !== 'removed')) {
      if (!activeIds.has(edge.to) || visited.has(edge.to)) continue;
      visited.add(edge.to);
      queue.push({ node: edge.to, nodes: [...current.nodes, edge.to], edges: [...current.edges, edge.id] });
    }
  }
  return null;
}

export function validateOntologyLayout(value, ids, fingerprint) {
  if (!value || value.fingerprint !== fingerprint || !Number.isFinite(value.scale) || value.scale < .5 || value.scale > 2.5 || !Number.isFinite(value.offset?.x) || !Number.isFinite(value.offset?.y) || Math.abs(value.offset.x) > 10000 || Math.abs(value.offset.y) > 10000 || typeof value.positions !== 'object' || !value.positions || Object.keys(value.positions).length > 500) return null;
  const positions = {};
  for (const [id, point] of Object.entries(value.positions)) if (ids.includes(id) && !['__proto__', 'constructor', 'prototype'].includes(id) && Number.isFinite(point?.x) && Number.isFinite(point?.y) && point.x >= 0 && point.x <= 10000 && point.y >= 0 && point.y <= 50000) positions[id] = { x: point.x, y: point.y };
  return { positions, scale: value.scale, offset: { x: value.offset.x, y: value.offset.y } };
}

// Rendering only: no inferred relationships. Index parallel lanes once per layout.
function routeAroundObjects(a, b, nodes, lane, usedPaths) {
  if (nodes.some(node => node.id !== a.id && node.id !== b.id && [a, b].some(endpoint => Math.abs(node.x - endpoint.x) < 95 && Math.abs(node.y - endpoint.y) < 38))) return null;
  // Bounded rectilinear candidates; crossings between edges are permitted.
  const boxes = nodes.map(node => ({ left: node.x - 95, right: node.x + 95, top: node.y - 38, bottom: node.y + 38 }));
  const clearSegment = (p, q) => !boxes.some(box => p.x === q.x
    ? p.x > box.left && p.x < box.right && Math.max(p.y, q.y) > box.top && Math.min(p.y, q.y) < box.bottom
    : p.y > box.top && p.y < box.bottom && Math.max(p.x, q.x) > box.left && Math.min(p.x, q.x) < box.right);
  const ports = node => [{ x: node.x + 95, y: node.y, exit: { x: node.x + 113, y: node.y } }, { x: node.x - 95, y: node.y, exit: { x: node.x - 113, y: node.y } }, { x: node.x, y: node.y - 38, exit: { x: node.x, y: node.y - 56 } }, { x: node.x, y: node.y + 38, exit: { x: node.x, y: node.y + 56 } }];
  const spacing = 18 + Math.abs(lane) * .3;
  const xs = [...new Set([Math.min(...boxes.map(box => box.left)) - spacing, Math.max(...boxes.map(box => box.right)) + spacing, ...boxes.flatMap(box => [box.left - spacing, box.right + spacing])])].slice(0, 24);
  const ys = [...new Set([Math.min(...boxes.map(box => box.top)) - spacing, Math.max(...boxes.map(box => box.bottom)) + spacing, ...boxes.flatMap(box => [box.top - spacing, box.bottom + spacing])])].slice(0, 24);
  let best = null; let length = Infinity;
  for (const start of ports(a)) for (const end of ports(b)) {
    const p = start.exit; const q = end.exit;
    const candidates = [
      [{ x: q.x, y: p.y }], [{ x: p.x, y: q.y }],
      ...xs.map(x => [{ x, y: p.y }, { x, y: q.y }]),
      ...ys.map(y => [{ x: p.x, y }, { x: q.x, y }])
    ];
    for (const turns of candidates) {
      const points = [start, p, ...turns, q, end].filter((point, index, array) => !index || point.x !== array[index - 1].x || point.y !== array[index - 1].y);
      const distance = points.slice(1).reduce((sum, point, index) => sum + Math.abs(point.x - points[index].x) + Math.abs(point.y - points[index].y), 0);
      if (!distance || distance >= length || points.slice(1).some((point, index) => !clearSegment(points[index], point))) continue;
      // A self relation must leave and return through different ports.
      if (a.id === b.id && start.x === end.x && start.y === end.y) continue;
      if (usedPaths.has(points.map((point, i) => `${i ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '))) continue;
      best = points; length = distance;
    }
  }
  return best;
}

export function buildOntologyEdgeGeometry(nodes, edges) {
  const index = new Map(nodes.map(node => [node.id, node]));
  const groups = new Map(); const geometry = new Map(); const occupied = [];
  const pair = (from, to) => JSON.stringify([from, to]);
  for (const edge of edges) {
    const key = pair(edge.from, edge.to);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  }
  const overlaps = (a, b) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 + 8 && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + 6;
  const obstacles = nodes.map(node => ({ x: node.x, y: node.y, width: 190, height: 76 }));
  for (const siblings of groups.values()) for (let ordinal = 0; ordinal < siblings.length; ordinal++) {
    const edge = siblings[ordinal]; const a = index.get(edge.from); const b = index.get(edge.to);
    if (!a || !b) continue;
    const lane = (ordinal - (siblings.length - 1) / 2) * 50;
    const reverse = groups.has(pair(edge.to, edge.from));
    const dx = b.x - a.x; const dy = b.y - a.y;
    const trim = Math.min(95 / Math.max(Math.abs(dx), 1), 38 / Math.max(Math.abs(dy), 1), .4);
    const loop = 115 + ordinal * 40;
    let path = a.id === b.id
      ? `M ${a.x + 65} ${a.y - 32} C ${a.x + 170} ${a.y - loop - 30}, ${a.x - 170} ${a.y - loop - 30}, ${a.x - 65} ${a.y - 32}`
      : `M ${a.x + dx * trim} ${a.y + dy * trim} Q ${(a.x + b.x) / 2 + (reverse ? -dy * .18 : 0)} ${(a.y + b.y) / 2 + (reverse ? dx * .18 : -25) + lane} ${b.x - dx * trim} ${b.y - dy * trim}`;
    let anchor = { x: (a.x + b.x) / 2 + (reverse && a.id !== b.id ? -dy * .09 : 0), y: a.id === b.id ? a.y - loop : (a.y + b.y) / 2 - 18 + (reverse ? dx * .09 : 0) + lane / 2 };
    // Keep unblocked curved lanes. Only detour when sampled curve meets another node.
    const curvePoints = Array.from({ length: 33 }, (_, i) => {
      const t = i / 32; const s = 1 - t;
      return a.id === b.id ? { x: s ** 3 * (a.x + 65) + 3 * s ** 2 * t * (a.x + 170) + 3 * s * t ** 2 * (a.x - 170) + t ** 3 * (a.x - 65), y: s ** 3 * (a.y - 32) + 3 * s * t * (a.y - loop - 30) + t ** 3 * (a.y - 32) }
        : { x: s ** 2 * (a.x + dx * trim) + 2 * s * t * ((a.x + b.x) / 2 + (reverse ? -dy * .18 : 0)) + t ** 2 * (b.x - dx * trim), y: s ** 2 * (a.y + dy * trim) + 2 * s * t * ((a.y + b.y) / 2 + (reverse ? dx * .18 : -25) + lane) + t ** 2 * (b.y - dy * trim) };
    });
    const blocked = nodes.some(node => node.id !== a.id && node.id !== b.id && curvePoints.some(point => Math.abs(point.x - node.x) < 99 && Math.abs(point.y - node.y) < 42));
    const route = blocked && nodes.length <= 500 ? routeAroundObjects(a, b, nodes, lane + ordinal * 8, new Set([...geometry.values()].map(item => item.path))) : null;
    if (route) {
      path = route.map((point, i) => `${i ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
      const segments = route.slice(1).map((point, i) => ({ x: (point.x + route[i].x) / 2, y: (point.y + route[i].y) / 2, length: Math.abs(point.x - route[i].x) + Math.abs(point.y - route[i].y) }));
      anchor = segments.sort((x, y) => y.length - x.length)[0];
    }
    const shorten = value => String(value).length > 19 ? `${String(value).slice(0, 18)}…` : String(value);
    const text = `${shorten(edge.label)} · ${shorten(edge.cardinality)}`;
    const width = [...text].reduce((sum, char) => sum + (/[^\x00-\x7F]/.test(char) ? 11 : 6), 0);
    let label = null;
    // Bounded search. If crowded, keep the edge selectable and move text to inspector.
    for (const shift of [0, -24, 24, -48, 48, -72, 72]) {
      const candidate = { x: anchor.x, y: anchor.y + shift, width, height: 18 };
      if (!obstacles.some(box => overlaps(candidate, box)) && !occupied.some(box => overlaps(candidate, box))) { label = candidate; occupied.push(candidate); break; }
    }
    geometry.set(edge.id, { path, label, routing: route ? 'detoured' : blocked ? 'unresolved' : 'curve', minX: Math.min(...(route || curvePoints).map(point => point.x)), maxX: Math.max(...(route || curvePoints).map(point => point.x)), maxY: Math.max(...(route || curvePoints).map(point => point.y)), minY: Math.min(a.y, b.y, ...(route || curvePoints).map(point => point.y), a.id === b.id && !route ? a.y - loop - 30 : Infinity, label?.y ?? Infinity) });
  }
  return geometry;
}
/** Display-only partition. Groups and counts never become semantic nodes or edges. */
export function summarizeOntologySources(graph, mode = 'source') {
  const groups = new Map(); const membership = new Map(); const crossings = new Map();
  for (const node of graph.nodes) {
    const sources = [...new Set(node.sourceSystems || [])].sort();
    const label = mode === 'domain' ? node.businessDomain || '未归类' : sources.join(' / ') || '未声明来源';
    const id = JSON.stringify([mode === 'domain' ? 'domain-group' : 'source-group', mode === 'domain' ? label : sources]);
    if (!groups.has(id)) groups.set(id, { id, label, sources, nodeIds: [], internalCurrent: 0, internalRemoved: 0 });
    groups.get(id).nodeIds.push(node.id); membership.set(node.id, id);
  }
  for (const edge of graph.edges) {
    const from = membership.get(edge.from); const to = membership.get(edge.to);
    if (!from || !to) continue;
    const removed = edge.change === 'removed';
    if (from === to) { groups.get(from)[removed ? 'internalRemoved' : 'internalCurrent']++; continue; }
    const id = JSON.stringify([from, to, removed]);
    if (!crossings.has(id)) crossings.set(id, { id, from, to, removed, edgeIds: [] });
    crossings.get(id).edgeIds.push(edge.id);
  }
  return { groups: [...groups.values()], crossings: [...crossings.values()] };
}
